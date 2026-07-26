/**
 * Judge-ready offline auth surface.
 *
 * The camera frame processor stays offline: ML Kit face signals drive quality
 * gates and active liveness, while resized face crops are handed to JS for the
 * bundled TFLite recognition + passive liveness models.
 */
import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {
  ActivityIndicator,
  Image,
  Linking,
  Modal,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import {
  Camera,
  runAtTargetFps,
  useCameraDevice,
  useCameraPermission,
  useFrameProcessor,
} from 'react-native-vision-camera';
import {
  useFaceDetector,
  type FaceDetectionOptions,
} from 'react-native-vision-camera-face-detector';
import {useResizePlugin} from 'vision-camera-resize-plugin';
import {Worklets} from 'react-native-worklets-core';
import NetInfo from '@react-native-community/netinfo';

import {
  ACTIVE_RECOGNITION,
  CAMERA,
  FLAGS,
  GEOFENCE,
  LIVENESS_MODEL,
  RECOGNITION_MODELS,
  SITES,
  SYNC,
  THRESHOLDS,
} from '../config';
import {evaluateGeofence} from '../location/geofence';
import {fetchAssignedSites, baseUrlFromSyncUrl} from '../location/provisioning';
import {createLocationProvider} from '../location/locationProvider';
import type {GeofenceResult, LocationFix} from '../location/types';
import type {RecordLocation} from '../auth/offlineStore';
import {evaluateFace} from '../camera/qualityGates';
import {meanLuma} from '../camera/frameUtils';
import {cropFace, scaleBox} from '../camera/faceCrop';
import type {Face, FaceBounds, GateResult} from '../camera/types';
import {OfflineAuthStore} from '../auth/offlineStore';
import {createEncryptedAuthStore} from '../auth/mmkvStore';
import {
  pick,
  GATE_TEXT,
  LIVENESS_TEXT,
  getLang,
  setLang,
  type Lang,
} from '../i18n';
import {speak, setSpeechEnabled} from '../speech/tts';
import {
  ActiveLivenessChallenge,
  evaluateDualLiveness,
  type LivenessSnapshot,
  type LivenessStatus,
} from '../face/liveness';
import {
  LIVENESS_ACTIONS,
  ACTION_LABEL,
  freshActionState,
  isActionSatisfied,
  type ActionState,
  type LivenessActionKind,
} from '../face/livenessActions';
import {TfliteFaceEngine, preprocessRgb, type FaceEngine} from '../face/engine';
import {computeComposite, confidenceFromCosine} from '../face/scoring';
import {syncPending} from '../sync/syncClient';
import {pushEnrollment} from '../sync/enrollmentClient';
import {averageEmbeddings} from '../face/math';
import GuidanceOverlay from './GuidanceOverlay';

type Page = 'home' | 'enroll_id' | 'camera';
type Mode = 'enroll' | 'verify';
type EngineState = 'loading' | 'ready' | 'error';

/**
 * Guided, FIXED-order enrollment over the shared liveness action pool
 * (face/livenessActions.ts: blink, smile, turnLeft, turnRight). One embedding
 * sample is captured per action once its gesture is confirmed, so the stored
 * template covers a spread of expressions/angles instead of several
 * near-identical neutral frames grabbed in quick succession. Fixed order
 * (unlike the verify challenge, which randomizes) because this is teaching
 * the system what the person looks like, not testing for liveness under
 * adversarial conditions. Enrollment and verify share the SAME detection
 * logic (isActionSatisfied) — nothing here is duplicated.
 */
function enrollStepGuidance(step: LivenessActionKind | 'done'): string {
  return pick(LIVENESS_TEXT[step]);
}

/** Datalake field roles, chosen at enrollment and synced to the backend. */
const ENROLL_ROLES: {id: string; label: string}[] = [
  {id: 'authority-engineer', label: 'Authority Engineer'},
  {id: 'contractor', label: 'Contractor'},
  {id: 'piu', label: 'PIU team'},
  {id: 'regional-officer', label: 'Regional Officer'},
  {id: 'consultant', label: 'Consultant'},
];

const LOGO = require('../../assets/branding/datalake-face-auth-logo.png');

// Bump alongside android versionName so a screenshot reveals the running build.
const APP_VERSION = 'v2.8 · build 19';

/**
 * One downscaled full-frame RGB buffer plus the face box already scaled into its
 * coordinate space. The recognition and liveness crops are cut from this in JS
 * (camera/faceCrop.ts) at capture time, so the models see an aligned face.
 */
interface MediumFrame {
  rgb: Uint8Array;
  width: number;
  height: number;
  box: FaceBounds;
}

interface Verdict {
  ok: boolean;
  title: string;
  detail: string;
  score?: number;
  latencyMs?: number;
}

const INITIAL_GATE: GateResult = {
  status: 'no_face',
  guidance: pick(GATE_TEXT.no_face),
  ready: false,
};

function createInspectorId(): string {
  return `inspector_${Date.now().toString(36).slice(-6)}`;
}

/** Short human summary of a geofence outcome for the verdict line. */
function geofenceReasonText(geo: GeofenceResult): string {
  switch (geo.reason) {
    case 'inside':
      return `At ${geo.siteName ?? 'assigned site'}`;
    case 'outside':
      return 'Not in assigned zone';
    case 'poor_accuracy':
      return 'GPS accuracy too low';
    case 'mocked':
      return 'Mock / fake GPS detected';
    case 'no_fix':
      return 'No GPS fix';
    case 'no_sites':
      return 'No site configured';
    default:
      return 'Location unknown';
  }
}

export default function CameraScreen(): React.JSX.Element {
  const {hasPermission, requestPermission} = useCameraPermission();
  const device = useCameraDevice('front');
  const [gate, setGate] = useState<GateResult>(INITIAL_GATE);
  const [voice, setVoice] = useState(true);
  const [lang, setLangState] = useState<Lang>(getLang());
  const [page, setPage] = useState<Page>('home');
  const [mode, setMode] = useState<Mode>('enroll');
  const [userId, setUserId] = useState('');
  const [role, setRole] = useState('authority-engineer');
  const [engineState, setEngineState] = useState<EngineState>('loading');
  const [engineError, setEngineError] = useState('');
  // Which guided step (LIVENESS_ACTIONS index) enrollment is currently on/has
  // reached — drives both the capture decision and the progress UI.
  const [enrollStepIndex, setEnrollStepIndex] = useState(0);
  const [enrolled, setEnrolled] = useState(0);
  const [pending, setPending] = useState(0);
  const [identity, setIdentity] = useState<{
    userId: string;
    role?: string;
  } | null>(null);
  const [profileOpen, setProfileOpen] = useState(false);
  const [isOnline, setIsOnline] = useState(true);
  const [geoStatus, setGeoStatus] = useState<{
    reason: string;
    siteName?: string;
    inside: boolean;
  } | null>(null);
  const [verdict, setVerdict] = useState<Verdict | null>(null);
  const [liveness, setLiveness] = useState<LivenessSnapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const [syncing, setSyncing] = useState(false);
  // Prevent auto-sync on startup from firing more than once (e.g. if
  // a re-render re-runs the mount effect). Stays false until the first
  // successful or failed auto-sync attempt completes.
  const autoSyncedRef = useRef(false);
  // True for the brief confirmation window between the final step saving and
  // returning Home — without it, all 4 poses can complete in a few seconds
  // and the screen would flash and vanish with no visible "saved" moment.
  const [enrollComplete, setEnrollComplete] = useState(false);
  // Big check/cross shown over the camera the instant a verify attempt
  // resolves (matched, no match, liveness failed, off-site) — held for
  // CAMERA.verifyResultHoldMs so the outcome is impossible to miss without
  // needing to scroll down to the verdict card below the camera.
  const [verifyResultTone, setVerifyResultTone] = useState<
    'success' | 'failure' | null
  >(null);

  const store = useMemo<OfflineAuthStore>(() => createEncryptedAuthStore(), []);
  const locationProvider = useMemo(() => createLocationProvider(), []);
  const latestFixRef = useRef<LocationFix | null>(null);
  const engineRef = useRef<FaceEngine | null>(null);
  const latestFaceRef = useRef<Face | null>(null);
  const latestBrightnessRef = useRef(0);
  const latestMediumRef = useRef<MediumFrame | null>(null);
  const latestRgbLenRef = useRef(0);
  const enrollSamplesRef = useRef<Float32Array[]>([]);
  // Blink-phase / turn-baseline tracking for whichever enroll action is
  // active; reset (freshActionState()) every time enrollStepIndex advances.
  const enrollGestureRef = useRef<ActionState>(freshActionState());
  // Always holds the latest onCaptureEnrollStep closure so onSignals (a
  // stable, empty-deps callback) can invoke the current version without being
  // recreated itself — same mirroring pattern as the other *Ref values below.
  const onCaptureEnrollStepRef = useRef<() => Promise<void>>(async () => {});
  const challengeRef = useRef<ActiveLivenessChallenge | null>(null);
  // Mirrors for stable closures used by the autonomous capture loop.
  const busyRef = useRef(false);
  const gateReadyRef = useRef(false);
  const modeRef = useRef<Mode>('enroll');
  const enrollStepIndexRef = useRef(0);
  const engineStateRef = useRef<EngineState>('loading');
  // Re-armed only after the face leaves the ring, so auto-verify fires once per
  // presentation instead of looping.
  const verifyArmedRef = useRef(true);
  // True while the big check/cross result is on screen. Blocks the
  // auto-trigger below from starting a NEW attempt during that window — the
  // last challenge action is often 'turn', so the face can drift off-center
  // and re-center again within a second or two after a result appears, which
  // would otherwise re-arm and immediately fire a fresh verify, wiping the
  // result out before it could be read.
  const verifyResultActiveRef = useRef(false);
  const enrollCompleteTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const verifyResultTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );

  useEffect(() => {
    busyRef.current = busy;
  }, [busy]);
  useEffect(() => {
    gateReadyRef.current = gate.ready;
  }, [gate.ready]);
  useEffect(() => {
    modeRef.current = mode;
  }, [mode]);
  useEffect(() => {
    enrollStepIndexRef.current = enrollStepIndex;
  }, [enrollStepIndex]);
  useEffect(() => {
    engineStateRef.current = engineState;
  }, [engineState]);
  useEffect(() => {
    verifyResultActiveRef.current = verifyResultTone !== null;
  }, [verifyResultTone]);

  const refreshCounts = useCallback(() => {
    setEnrolled(store.listEnrollments().length);
    setPending(store.getPendingQueue().length);
    const latest = store.latestEnrollment();
    setIdentity(latest ? {userId: latest.userId, role: latest.role} : null);
  }, [store]);

  useEffect(() => {
    refreshCounts();
  }, [refreshCounts]);

  // Auto-sync pending records leftover from a previous session (e.g.
  // yesterday's attendance that the user verified offline). Fires once
  // on mount when the queue is non-empty and the device has connectivity.
  useEffect(() => {
    if (autoSyncedRef.current) {
      return;
    }
    const q = store.getPendingQueue();
    if (q.length === 0) {
      return;
    }
    // Check actual connectivity rather than the initial isOnline(true) default,
    // which may not reflect the real state until NetInfo fires.
    NetInfo.fetch().then(state => {
      if (autoSyncedRef.current) {
        return;
      }
      if (state.isConnected) {
        autoSyncedRef.current = true;
        onSync();
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Track connectivity so enrollment (an online-only action) can be gated
  // synchronously without awaiting a fetch in the button handler.
  useEffect(() => {
    const unsub = NetInfo.addEventListener(state => {
      setIsOnline(state.isConnected !== false);
    });
    return () => unsub();
  }, []);

  useEffect(() => {
    setSpeechEnabled(voice);
  }, [voice]);

  // Keep a fresh GPS fix cached while on the camera so verify reads it instantly
  // (no wait, no inflated latency). Fully offline — GPS needs no network.
  useEffect(() => {
    if (page !== 'camera') {
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | null = null;
    const refresh = () => {
      locationProvider
        .getFix({
          timeoutMs: GEOFENCE.fixTimeoutMs,
          maxAgeMs: GEOFENCE.maxFixAgeMs,
        })
        .then(fix => {
          if (cancelled) {
            return;
          }
          if (fix) {
            latestFixRef.current = fix;
          }
          // Live geofence readout — only when a real zone has been provisioned.
          const provisioned = store.getSites();
          if (provisioned.length === 0) {
            setGeoStatus(null);
            return;
          }
          if (!fix) {
            setGeoStatus({reason: 'no_fix', inside: false});
            return;
          }
          const geo = evaluateGeofence(fix, provisioned, {
            maxAccuracyM: GEOFENCE.maxAccuracyM,
            rejectMocked: GEOFENCE.rejectMocked,
          });
          setGeoStatus({
            reason: geo.reason,
            siteName: geo.siteName,
            inside: geo.insideSite,
          });
        })
        .catch(() => undefined);
    };
    locationProvider.requestPermission().then(granted => {
      if (cancelled || !granted) {
        return;
      }
      refresh();
      timer = setInterval(refresh, GEOFENCE.maxFixAgeMs);
    });
    return () => {
      cancelled = true;
      if (timer) {
        clearInterval(timer);
      }
    };
  }, [page, locationProvider, store]);

  useEffect(() => {
    if (page === 'camera' && voice && gate.status) {
      speak(GATE_TEXT[gate.status]);
    }
  }, [page, voice, gate.status]);

  useEffect(() => {
    let cancelled = false;
    const engine = new TfliteFaceEngine();
    engine
      .load()
      .then(() => {
        if (cancelled) {
          return;
        }
        engineRef.current = engine;
        setEngineState('ready');
      })
      .catch((e: unknown) => {
        if (cancelled) {
          return;
        }
        setEngineState('error');
        setEngineError(e instanceof Error ? e.message : 'model load failed');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const toggleLang = useCallback(() => {
    const next: Lang = lang === 'hi' ? 'en' : 'hi';
    setLang(next);
    setLangState(next);
  }, [lang]);

  const faceOptions = useMemo<FaceDetectionOptions>(
    () => ({
      performanceMode: 'fast',
      landmarkMode: 'none',
      contourMode: 'none',
      classificationMode: 'all',
      trackingEnabled: true,
    }),
    [],
  );

  const {detectFaces} = useFaceDetector(faceOptions);
  const {resize} = useResizePlugin();

  const onSignals = useMemo(
    () =>
      Worklets.createRunOnJS(
        (
          faces: Face[],
          frameWidth: number,
          brightness: number,
          rgbLen: number,
          mediumRgb?: number[],
          mediumWidth?: number,
          mediumHeight?: number,
        ) => {
          const gateResult = evaluateFace({faces, frameWidth, brightness});
          setGate(prev =>
            prev.status === gateResult.status && prev.ready === gateResult.ready
              ? prev
              : gateResult,
          );
          latestFaceRef.current = faces.length === 1 ? faces[0] : null;
          latestBrightnessRef.current = brightness;
          latestRgbLenRef.current = rgbLen;
          // Trigger enroll capture HERE, the instant an action's pose is
          // confirmed, instead of polling a flag from a separate interval.
          // isActionSatisfied's blink/turn checks are transient — they can
          // read true on one frame and false on the next as the tracked value
          // oscillates around the threshold — so a slower poll can easily
          // always sample the false frames and never the true one. Reacting
          // immediately here (same cadence as every other per-frame signal)
          // never misses the moment.
          if (
            modeRef.current === 'enroll' &&
            engineStateRef.current === 'ready' &&
            !busyRef.current &&
            latestFaceRef.current &&
            enrollStepIndexRef.current < LIVENESS_ACTIONS.length
          ) {
            const step = LIVENESS_ACTIONS[enrollStepIndexRef.current];
            const ready = isActionSatisfied(
              step,
              latestFaceRef.current,
              enrollGestureRef.current,
            );
            if (ready) {
              // Claim synchronously so the next onSignals call (which can
              // arrive before React processes setBusy(true)) can't re-fire.
              busyRef.current = true;
              onCaptureEnrollStepRef.current().catch(() => undefined);
            }
          }
          if (
            mediumRgb &&
            mediumWidth &&
            mediumHeight &&
            faces.length === 1 &&
            frameWidth > 0
          ) {
            // The medium buffer is a uniform downscale of the frame, so the same
            // scale maps the face box (frame coords) into buffer coords.
            const scale = mediumWidth / frameWidth;
            latestMediumRef.current = {
              rgb: new Uint8Array(mediumRgb),
              width: mediumWidth,
              height: mediumHeight,
              box: scaleBox(faces[0].bounds, scale),
            };
          } else if (faces.length !== 1) {
            latestMediumRef.current = null;
          }
        },
      ),
    [],
  );

  const frameProcessor = useFrameProcessor(
    frame => {
      'worklet';
      runAtTargetFps(CAMERA.targetFps, () => {
        'worklet';
        // Detection drives gates + liveness. Wrapped so a transient failure
        // never freezes the pipeline.
        let faces: Face[] = [];
        try {
          faces = detectFaces(frame) as Face[];
        } catch {
          faces = [];
        }

        let brightness = 0;
        try {
          const small = resize(frame, {
            scale: {width: 16, height: 16},
            pixelFormat: 'rgb',
            dataType: 'uint8',
          });
          brightness = meanLuma(small as Uint8Array);
        } catch {
          brightness = 0;
        }

        // Downscale the WHOLE frame once (no crop), preserving the full field of
        // view, and hand that single RGB buffer to JS. JS crops the aligned face
        // from it (camera/faceCrop.ts). We deliberately never pass the plugin's
        // `crop` option: on Android it is applied in the rotated sensor buffer,
        // so a crop from frame/face coords lands out of bounds and the plugin
        // returns an EMPTY buffer ("got 0"). A plain full-frame downscale is the
        // code path that is reliable on real devices.
        const longEdge = Math.max(frame.width, frame.height);
        const s = longEdge > 0 ? CAMERA.mediumLongEdge / longEdge : 1;
        const mw = Math.max(1, Math.round(frame.width * s));
        const mh = Math.max(1, Math.round(frame.height * s));
        const mediumPixels = mw * mh;

        let mediumRgb: number[] | undefined;
        let mediumWidth: number | undefined;
        let mediumHeight: number | undefined;
        let rgbLen = 0; // diagnostic: raw resize length seen in the worklet

        // Only build the medium buffer when exactly one face is present (capture
        // needs one face box to crop against).
        if (faces.length === 1) {
          try {
            const med = resize(frame, {
              scale: {width: mw, height: mh},
              pixelFormat: 'rgb',
              dataType: 'uint8',
            }) as Uint8Array;
            rgbLen = med ? med.length : 0;
            if (
              med &&
              med.length >= mediumPixels * 3 &&
              med.length % mediumPixels === 0
            ) {
              // Materialize to plain number[] IN THE WORKLET. worklets-core
              // serializes plain arrays across the JS boundary reliably, whereas
              // a (Shared/Uint8)Array arrives EMPTY on the JS thread — the
              // observed rgb>0 but tns=0 failure on real devices.
              const arr: number[] = new Array(med.length);
              for (let k = 0; k < med.length; k++) {
                arr[k] = med[k];
              }
              mediumRgb = arr;
              mediumWidth = mw;
              mediumHeight = mh;
            }
          } catch {
            mediumRgb = undefined;
          }
        }
        onSignals(
          faces,
          frame.width,
          brightness,
          rgbLen,
          mediumRgb,
          mediumWidth,
          mediumHeight,
        );
      });
    },
    [detectFaces, resize, onSignals],
  );

  const onRequest = useCallback(() => {
    requestPermission().then(granted => {
      if (!granted) {
        Linking.openSettings();
      }
    });
  }, [requestPermission]);

  const openEnrollSetup = useCallback(() => {
    // Enrollment is an ONLINE event — the template + details must reach the
    // central backend. Verification stays fully offline. Block enroll when there
    // is no connectivity so a template isn't stranded on-device.
    if (!isOnline) {
      setVerdict({
        ok: false,
        title: 'Internet required to enrol',
        detail:
          'Connect to a network to register a new inspector. Verification still works offline.',
      });
      return;
    }
    setMode('enroll');
    setPage('enroll_id');
    setVerdict(null);
    setEnrollStepIndex(0);
    setEnrollComplete(false);
    enrollSamplesRef.current = [];
    enrollGestureRef.current = freshActionState();
  }, [isOnline]);

  const openEnrollCamera = useCallback(() => {
    const id = userId.trim();
    if (!id) {
      setVerdict({
        ok: false,
        title: 'Inspector ID required',
        detail: 'Enter an ID or generate one on this phone.',
      });
      return;
    }
    setMode('enroll');
    setPage('camera');
    setVerdict(null);
  }, [userId]);

  const openVerifyCamera = useCallback(() => {
    if (store.listEnrollments().length === 0) {
      setVerdict({
        ok: false,
        title: 'Enroll first',
        detail: 'Create a local face template before verification.',
      });
      setMode('enroll');
      setPage('enroll_id');
      return;
    }
    setMode('verify');
    setPage('camera');
    setLiveness(null);
    setVerdict(null);
    setVerifyResultTone(null);
  }, [store]);

  // Shows the big check/cross over the camera. A failure auto-clears after
  // CAMERA.verifyResultHoldMs so scanning can resume; a match PINS instead —
  // it must not silently restart the hands-free loop on its own. The operator
  // explicitly chooses "Return home" or "Begin new verification" (rendered
  // below) to move on.
  const showVerifyResult = useCallback((tone: 'success' | 'failure') => {
    if (verifyResultTimerRef.current) {
      clearTimeout(verifyResultTimerRef.current);
      verifyResultTimerRef.current = null;
    }
    setVerifyResultTone(tone);
    if (tone === 'failure') {
      verifyResultTimerRef.current = setTimeout(() => {
        verifyResultTimerRef.current = null;
        setVerifyResultTone(null);
      }, CAMERA.verifyResultHoldMs);
    }
  }, []);

  const goHome = useCallback(() => {
    if (enrollCompleteTimerRef.current) {
      clearTimeout(enrollCompleteTimerRef.current);
      enrollCompleteTimerRef.current = null;
    }
    if (verifyResultTimerRef.current) {
      clearTimeout(verifyResultTimerRef.current);
      verifyResultTimerRef.current = null;
    }
    setVerifyResultTone(null);
    challengeRef.current = null;
    setLiveness(null);
    setPage('home');
  }, []);

  useEffect(
    () => () => {
      if (enrollCompleteTimerRef.current) {
        clearTimeout(enrollCompleteTimerRef.current);
      }
      if (verifyResultTimerRef.current) {
        clearTimeout(verifyResultTimerRef.current);
      }
    },
    [],
  );

  const captureEmbedding = useCallback(async (): Promise<Float32Array> => {
    const engine = engineRef.current;
    const medium = latestMediumRef.current;
    if (!engine || engineState !== 'ready') {
      throw new Error('Models are still loading');
    }
    // Capture needs a detected face and a valid frame buffer — not the strict
    // quality gate (which is advisory). Keeps enrollment/verification unblocked.
    if (!latestFaceRef.current) {
      throw new Error(pick(GATE_TEXT.no_face));
    }
    if (!medium) {
      // Diagnostic: rgb=0 means the resize plugin returned an empty buffer on
      // this device; rgb>0 means a transfer/storage issue.
      throw new Error(
        `Hold steady for a moment (rgb=${latestRgbLenRef.current})`,
      );
    }
    const spec = RECOGNITION_MODELS[ACTIVE_RECOGNITION];
    const crop = cropFace({
      rgb: medium.rgb,
      width: medium.width,
      height: medium.height,
      box: medium.box,
      expansion: spec.cropExpansion,
      targetSize: spec.inputSize,
    });
    return engine.embedFace(preprocessRgb(crop, spec));
  }, [engineState]);

  // Captures the CURRENT enroll step's sample, then advances to the next pose
  // (or finishes enrollment on the last one). Called only once the step's
  // gesture has actually been confirmed by isActionSatisfied — see the
  // per-frame trigger in onSignals above.
  const onCaptureEnrollStep = useCallback(async () => {
    const id = userId.trim();
    if (!id) {
      setVerdict({ok: false, title: 'Enter inspector ID', detail: 'Required'});
      return;
    }
    const step = LIVENESS_ACTIONS[enrollStepIndex];
    setBusy(true);
    try {
      const embedding = await captureEmbedding();
      enrollSamplesRef.current.push(embedding);
      const nextIndex = enrollStepIndex + 1;
      enrollGestureRef.current = freshActionState();
      if (nextIndex >= LIVENESS_ACTIONS.length) {
        const samples = [...enrollSamplesRef.current];
        store.saveEnrollment(id, samples, undefined, role);
        enrollSamplesRef.current = [];
        // Best-effort ONLINE enrollment: push the averaged template + details to
        // the central backend so the admin registry sees this inspector. The
        // template is already saved locally, so offline verification still works
        // even if this push fails (no network).
        try {
          pushEnrollment({
            baseUrl: baseUrlFromSyncUrl(SYNC.url),
            apiKey: SYNC.apiKey,
            userId: id,
            role,
            embedding: averageEmbeddings(samples),
            deviceId: store.getDeviceId(),
            samples: samples.length,
          }).catch(() => undefined);
        } catch {
          /* averaging guard — never block local enrollment */
        }
        setEnrollStepIndex(nextIndex);
        refreshCounts();
        setVerdict({
          ok: true,
          title: 'Enrollment saved',
          detail: `${id} is ready for verification`,
        });
        // Enrollment's only job is to capture and save — it must not silently
        // hand off into verification on the same screen. Hold here with a
        // visible "saved" confirmation before returning Home instead of
        // navigating away instantly (which read as the screen "flashing and
        // closing").
        setEnrollComplete(true);
        enrollCompleteTimerRef.current = setTimeout(() => {
          enrollCompleteTimerRef.current = null;
          goHome();
        }, CAMERA.enrollCompleteDelayMs);
      } else {
        setEnrollStepIndex(nextIndex);
        setVerdict({
          ok: true,
          title: `Step ${nextIndex}/${LIVENESS_ACTIONS.length} captured`,
          detail: `Next: ${enrollStepGuidance(LIVENESS_ACTIONS[nextIndex])}`,
        });
      }
    } catch (e) {
      setVerdict({
        ok: false,
        title: `Capture blocked (${step})`,
        detail: e instanceof Error ? e.message : 'Try again',
      });
    } finally {
      setBusy(false);
    }
  }, [
    captureEmbedding,
    enrollStepIndex,
    goHome,
    refreshCounts,
    role,
    store,
    userId,
  ]);

  // Autonomous enrollment capture is triggered directly from onSignals (every
  // processed frame) the instant a step's pose is confirmed — see the
  // isActionSatisfied call there. This just keeps the ref onSignals calls
  // pointing at the current closure.
  useEffect(() => {
    onCaptureEnrollStepRef.current = onCaptureEnrollStep;
  }, [onCaptureEnrollStep]);

  const startVerify = useCallback(() => {
    if (store.listEnrollments().length === 0) {
      setVerdict({
        ok: false,
        title: 'No enrollments yet',
        detail: 'Enroll at least one inspector first',
      });
      return;
    }
    if (verifyResultTimerRef.current) {
      clearTimeout(verifyResultTimerRef.current);
      verifyResultTimerRef.current = null;
    }
    setVerifyResultTone(null);
    const challenge = new ActiveLivenessChallenge();
    challengeRef.current = challenge;
    setLiveness(challenge.start(Date.now()));
    setVerdict(null);
  }, [store]);

  const runVerify = useCallback(
    async (activeStatus: LivenessStatus) => {
      const engine = engineRef.current;
      const medium = latestMediumRef.current;
      const face = latestFaceRef.current;
      if (!engine || !medium || !face) {
        throw new Error('Face frame unavailable');
      }
      const t0 = Date.now();
      const recognitionSpec = RECOGNITION_MODELS[ACTIVE_RECOGNITION];
      const recognitionCrop = cropFace({
        rgb: medium.rgb,
        width: medium.width,
        height: medium.height,
        box: medium.box,
        expansion: recognitionSpec.cropExpansion,
        targetSize: recognitionSpec.inputSize,
      });
      const livenessCrop = cropFace({
        rgb: medium.rgb,
        width: medium.width,
        height: medium.height,
        box: medium.box,
        expansion: LIVENESS_MODEL.bboxExpansion,
        targetSize: LIVENESS_MODEL.inputSize,
      });
      const [probe, passiveScore] = await Promise.all([
        engine.embedFace(preprocessRgb(recognitionCrop, recognitionSpec)),
        engine.scoreLive(preprocessRgb(livenessCrop, LIVENESS_MODEL)),
      ]);
      const verify = store.verify(probe);
      const dual = evaluateDualLiveness({passiveScore, activeStatus});
      // Screen/print-replay defence: a confidently-low passive score means the
      // camera is looking at a screen or print, not a live face — this is what
      // stops a video played on a second phone.
      const screenReplay =
        FLAGS.PASSIVE_SCREEN_BLOCK &&
        passiveScore < THRESHOLDS.livenessPassiveFloor;
      // Active motion challenge is the hard requirement; passive is advisory
      // unless REQUIRE_PASSIVE_LIVENESS is on. A screen-replay always blocks.
      const livePassed =
        (FLAGS.REQUIRE_PASSIVE_LIVENESS ? dual.passed : dual.activePassed) &&
        !screenReplay;
      const confidence = confidenceFromCosine(Math.max(0, verify.matchScore));
      const composite = computeComposite({
        recognitionConfidence: confidence,
        livenessPassed: livePassed,
        drowsy: false,
        lookingAway: Math.abs(face.yawAngle) > THRESHOLDS.maxYawDeg,
        ear:
          ((face.leftEyeOpenProbability ?? 1) +
            (face.rightEyeOpenProbability ?? 1)) /
          2,
        yawDeg: face.yawAngle,
        pitchDeg: face.pitchAngle,
        brightness: latestBrightnessRef.current,
      });
      const latencyMs = Date.now() - t0;

      // On-device geofence: is the worker physically at the assigned site? Uses
      // the cached GPS fix, but if none is cached yet (cold GPS / permission just
      // granted), fetch one now so the verify record always carries coordinates.
      // Never touches the identity decision — an independent presence signal.
      let fix = latestFixRef.current;
      if (!fix) {
        fix = await locationProvider.getFix({
          timeoutMs: GEOFENCE.fixTimeoutMs,
          maxAgeMs: GEOFENCE.maxFixAgeMs,
        });
        if (fix) {
          latestFixRef.current = fix;
        }
      }
      // Prefer admin-provisioned sites cached on the device; fall back to the
      // static config.SITES only when nothing has been provisioned yet.
      const cachedSites = store.getSites();
      const activeSites = cachedSites.length > 0 ? cachedSites : SITES;
      const geo = evaluateGeofence(fix, activeSites, {
        maxAccuracyM: GEOFENCE.maxAccuracyM,
        rejectMocked: GEOFENCE.rejectMocked,
      });
      const location: RecordLocation | undefined = fix
        ? {
            lat: fix.lat,
            lon: fix.lon,
            accuracyM: fix.accuracyM,
            mocked: fix.mocked,
            geofencePassed: geo.passed,
            siteId: geo.siteId,
            distanceM: geo.distanceM,
          }
        : undefined;

      if (!livePassed) {
        store.queueAttendance({
          userId: userId.trim() || 'unidentified',
          livenessScore: passiveScore,
          matchScore: verify.matchScore,
          location,
        });
        refreshCounts();
        showVerifyResult('failure');
        setVerdict({
          ok: false,
          title: screenReplay ? 'Screen / replay blocked' : 'Liveness blocked',
          detail: screenReplay
            ? `Not a live face — passive anti-spoof ${(
                passiveScore * 100
              ).toFixed(0)}%`
            : `Passive score ${(passiveScore * 100).toFixed(0)}%`,
          score: composite.overall,
          latencyMs,
        });
        return;
      }
      if (!verify.ok || !verify.userId) {
        showVerifyResult('failure');
        setVerdict({
          ok: false,
          title: 'No match',
          detail: `Best score ${(Math.max(0, verify.matchScore) * 100).toFixed(
            0,
          )}%`,
          score: composite.overall,
          latencyMs,
        });
        return;
      }
      // Presence gate — independent of identity. Only blocks when enforcement is
      // on (GEOFENCE.enforce) and the fix is off-site, mocked, or too coarse.
      if (GEOFENCE.enforce && !geo.passed) {
        store.queueAttendance({
          userId: verify.userId,
          livenessScore: Math.max(passiveScore, THRESHOLDS.livenessPassive),
          matchScore: verify.matchScore,
          location,
        });
        refreshCounts();
        showVerifyResult('failure');
        setVerdict({
          ok: false,
          title: 'Off-site or spoofed GPS',
          detail: `${verify.userId} · ${geofenceReasonText(geo)}`,
          score: composite.overall,
          latencyMs,
        });
        return;
      }
      store.queueAttendance({
        userId: verify.userId,
        livenessScore: Math.max(passiveScore, THRESHOLDS.livenessPassive),
        matchScore: verify.matchScore,
        location,
      });
      refreshCounts();
      showVerifyResult('success');
      setVerdict({
        ok: true,
        title: composite.lowTrust ? 'Matched · review' : 'Matched offline',
        detail: `${verify.userId} · match ${(verify.matchScore * 100).toFixed(
          0,
        )}% · score ${composite.overall}/100${
          location ? ` · ${geofenceReasonText(geo)}` : ''
        }`,
        score: composite.overall,
        latencyMs,
      });
    },
    [locationProvider, refreshCounts, showVerifyResult, store, userId],
  );

  // Autonomous verification — hands-free to START, but liveness is mandatory.
  // As soon as the face is centered the randomized blink/smile/turn challenge
  // begins automatically; the challenge loop below runs recognition + passive
  // anti-spoof only after it passes. This closes the spoof hole where a photo
  // held to the camera could match with no liveness check. Fires once per
  // presentation: it re-arms only after the face leaves the ring.
  useEffect(() => {
    if (page !== 'camera' || mode !== 'verify' || engineState !== 'ready') {
      return;
    }
    const id = setInterval(() => {
      if (!gateReadyRef.current) {
        verifyArmedRef.current = true; // face left → arm for next presentation
        return;
      }
      if (
        busyRef.current ||
        challengeRef.current !== null ||
        verifyResultActiveRef.current ||
        !verifyArmedRef.current
      ) {
        return;
      }
      verifyArmedRef.current = false;
      startVerify();
    }, CAMERA.autoLoopIntervalMs);
    return () => clearInterval(id);
  }, [page, mode, engineState, startVerify]);

  const livenessStatus = liveness?.status;

  // Runs the active-liveness challenge tick loop. Deliberately keyed off the
  // STATUS string, not the `liveness` snapshot object itself: every tick below
  // calls setLiveness(snap) with a brand-new object, so depending on the whole
  // object here would tear down and recreate this interval on every single
  // tick (~every 160ms) for the whole challenge duration — needless churn, and
  // under fake timers in tests it could alias with the mocked camera's own
  // interval and starve the challenge of ever seeing a state change. Keying off
  // `status` means the interval is set up once when the challenge starts and
  // torn down once when it ends.
  useEffect(() => {
    if (mode !== 'verify' || livenessStatus !== 'running') {
      return;
    }
    const id = setInterval(() => {
      const challenge = challengeRef.current;
      if (!challenge) {
        return;
      }
      const snap = challenge.update(latestFaceRef.current, Date.now());
      setLiveness(snap);
      if (voice) {
        if (snap.status === 'running') {
          speak(LIVENESS_TEXT[snap.actions[snap.index]]);
        } else if (snap.status === 'failed') {
          speak(LIVENESS_TEXT.failed);
        }
      }
      if (snap.status === 'passed') {
        setBusy(true);
        runVerify('passed')
          .catch((e: unknown) => {
            showVerifyResult('failure');
            setVerdict({
              ok: false,
              title: 'Verify failed',
              detail: e instanceof Error ? e.message : 'Try again',
            });
          })
          .finally(() => {
            setBusy(false);
            challengeRef.current = null;
          });
      }
      if (snap.status === 'failed') {
        store.queueAttendance({
          userId: userId.trim() || 'unidentified',
          livenessScore: 0,
          matchScore: 0,
        });
        refreshCounts();
        showVerifyResult('failure');
        setVerdict({
          ok: false,
          title: 'Liveness failed',
          detail: 'Presentation attack blocked and queued',
        });
        challengeRef.current = null;
      }
    }, CAMERA.challengeTickMs);
    return () => clearInterval(id);
  }, [
    livenessStatus,
    mode,
    refreshCounts,
    runVerify,
    showVerifyResult,
    store,
    userId,
    voice,
  ]);

  // Offline → online sync. Pushes the local queue to the AWS/Render backend and
  // purges only the records the server acknowledges. In MOCK_MODE it simulates a
  // 200 so the queue-purge lifecycle is demoable before a backend is reachable.
  const onSync = useCallback(async () => {
    setSyncing(true);
    try {
      const outcome = await syncPending(store, {
        mock: FLAGS.MOCK_MODE,
        url: SYNC.url,
        apiKey: SYNC.apiKey,
      });
      refreshCounts();
      // Best-effort: pull this inspector's admin-assigned geofence zone(s) and
      // cache them locally for offline use. Independent of the (maybe mocked)
      // sync above; if the backend is unreachable we keep any cached sites.
      let sitesNote = '';
      const inspectorId = userId.trim();
      if (inspectorId) {
        try {
          const sites = await fetchAssignedSites({
            baseUrl: baseUrlFromSyncUrl(SYNC.url),
            apiKey: SYNC.apiKey,
            userId: inspectorId,
          });
          store.saveSites(sites);
          sitesNote = sites.length
            ? ` · ${sites.length} geofence zone${
                sites.length === 1 ? '' : 's'
              } provisioned`
            : '';
        } catch {
          /* offline / backend down — retain previously cached sites */
        }
      }
      if (outcome.ok) {
        setVerdict({
          ok: true,
          title: outcome.mocked
            ? 'Synced (mock) · queue purged'
            : 'Synced to server · queue purged',
          detail: `${outcome.purged} record${
            outcome.purged === 1 ? '' : 's'
          } uploaded${
            outcome.mocked ? ' — MOCK_MODE, no network' : ''
          }${sitesNote}`,
        });
      } else {
        setVerdict({
          ok: false,
          title: 'Sync failed',
          detail: outcome.error ?? 'Could not reach the sync server',
        });
      }
    } finally {
      setSyncing(false);
    }
  }, [refreshCounts, store, userId]);

  const onClearLocal = useCallback(() => {
    store.clearAll();
    enrollSamplesRef.current = [];
    setEnrollStepIndex(0);
    refreshCounts();
    setVerdict({
      ok: true,
      title: 'Local demo reset',
      detail: 'Enrollments and queue cleared on this device',
    });
  }, [refreshCounts, store]);

  if (page === 'home') {
    return (
      <>
        <HomePage
          identity={identity}
          enrolled={enrolled}
          pending={pending}
          verdict={verdict}
          syncing={syncing}
          onEnroll={openEnrollSetup}
          onVerify={openVerifyCamera}
          onSync={onSync}
          onOpenProfile={() => setProfileOpen(true)}
        />
        <ProfilePanel
          visible={profileOpen}
          identity={identity}
          voice={voice}
          lang={lang}
          pending={pending}
          online={isOnline}
          onToggleVoice={() => setVoice(v => !v)}
          onToggleLang={toggleLang}
          onReset={onClearLocal}
          onClose={() => setProfileOpen(false)}
        />
      </>
    );
  }

  if (page === 'enroll_id') {
    return (
      <EnrollIdPage
        userId={userId}
        role={role}
        verdict={verdict}
        onChangeUserId={setUserId}
        onChangeRole={setRole}
        onGenerate={() => {
          setUserId(createInspectorId());
          setVerdict(null);
        }}
        onContinue={openEnrollCamera}
        onBack={goHome}
      />
    );
  }

  if (!hasPermission) {
    return (
      <Centered>
        <Image source={LOGO} style={styles.permissionLogo} />
        <Text style={styles.title}>Camera permission needed</Text>
        <Text style={styles.subtitle}>
          Camera access is required for local enrollment and verification.
        </Text>
        <TouchableOpacity style={styles.primaryButton} onPress={onRequest}>
          <Text style={styles.primaryButtonText}>Allow camera</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.secondaryButton} onPress={goHome}>
          <Text style={styles.secondaryButtonText}>Back</Text>
        </TouchableOpacity>
      </Centered>
    );
  }

  if (device == null) {
    return (
      <Centered>
        <ActivityIndicator color="#38e0a5" />
        <Text style={styles.subtitle}>No front camera found.</Text>
      </Centered>
    );
  }

  const cameraTop = (
    <View style={styles.cameraTop}>
      <TouchableOpacity style={styles.backPill} onPress={goHome}>
        <Text style={styles.backPillText}>BACK</Text>
      </TouchableOpacity>
      <StatusPill
        label={
          engineState === 'ready'
            ? 'MODELS READY'
            : engineState === 'loading'
            ? 'LOADING MODELS'
            : 'MODEL ERROR'
        }
        tone={engineState === 'ready' ? 'good' : 'warn'}
      />
    </View>
  );
  const cameraFeed = (
    <Camera
      style={StyleSheet.absoluteFill}
      device={device}
      isActive={true}
      // Force a CPU-readable frame format. Without this, some devices hand
      // the resize plugin a private/native GPU buffer it can't read, so it
      // returns an empty buffer -> "Expected 37632 RGB bytes, got 0".
      pixelFormat="yuv"
      frameProcessor={frameProcessor}
    />
  );
  const langVoiceToggles = (
    <View style={styles.toggleRow}>
      <TouchableOpacity style={styles.smallToggle} onPress={toggleLang}>
        <Text style={styles.smallToggleText}>
          {lang === 'hi' ? 'हिन्दी' : 'ENG'}
        </Text>
      </TouchableOpacity>
      <TouchableOpacity
        style={[styles.smallToggle, voice && styles.toggleOn]}
        onPress={() => setVoice(v => !v)}>
        <Text style={styles.smallToggleText}>{voice ? 'Voice' : 'Mute'}</Text>
      </TouchableOpacity>
    </View>
  );

  // Enroll and verify are two dedicated screens sharing only the pieces above.
  // Previously they were one screen gated by `mode`, and completing
  // enrollment silently swapped its content into the verify UI — this is the
  // "chaotic" jump the enroll flow must not do anymore.
  if (mode === 'enroll') {
    const enrollBusy = busy || engineState !== 'ready' || enrollComplete;
    const currentStep = enrollComplete ? null : LIVENESS_ACTIONS[enrollStepIndex];
    const stepPrompt = enrollStepGuidance(currentStep ?? 'done');
    const overlayText = enrollComplete
      ? stepPrompt
      : gate.ready
      ? stepPrompt
      : gate.guidance;
    return (
      <View style={styles.container}>
        <View style={styles.cameraPane}>
          {cameraFeed}
          <GuidanceOverlay
            ready={gate.ready}
            text={overlayText}
            resultTone={enrollComplete ? 'success' : undefined}
          />
          {cameraTop}
          <View style={styles.cameraActionBar}>
            <TouchableOpacity
              disabled={enrollBusy}
              style={[
                styles.cameraActionButton,
                enrollBusy && styles.disabledButton,
              ]}
              onPress={onCaptureEnrollStep}>
              <Text style={styles.cameraActionText}>
                {enrollComplete
                  ? 'Saved — returning home...'
                  : `Capture: ${ACTION_LABEL[currentStep!]}`}
              </Text>
            </TouchableOpacity>
          </View>
        </View>

        <ScrollView
          style={styles.panel}
          contentContainerStyle={styles.panelContent}>
          <View style={styles.headerRow}>
            <View>
              <Text style={styles.kicker}>DATALAKE 3.0 FIELD AUTH</Text>
              <Text style={styles.panelTitle}>Enroll Face</Text>
            </View>
            {langVoiceToggles}
          </View>

          {engineState === 'error' && (
            <Text style={styles.errorText}>{engineError}</Text>
          )}

          <View style={styles.card}>
            <Text style={styles.idLine}>{userId.trim()}</Text>
            <Text style={styles.progressText}>
              {enrollComplete
                ? `All ${LIVENESS_ACTIONS.length} poses captured — saved`
                : `Step ${enrollStepIndex + 1}/${
                    LIVENESS_ACTIONS.length
                  } — follow each prompt, captures automatically`}
            </Text>
            <View style={styles.stepList}>
              {LIVENESS_ACTIONS.map((step, i) => {
                const isDone = enrollComplete || i < enrollStepIndex;
                const isCurrent = !enrollComplete && i === enrollStepIndex;
                return (
                  <View key={step} style={styles.stepRow}>
                    <View
                      style={[
                        styles.stepMarker,
                        isDone && styles.stepMarkerDone,
                        isCurrent && styles.stepMarkerCurrent,
                      ]}>
                      <Text
                        style={[
                          styles.stepMarkerText,
                          isDone && styles.stepMarkerTextDone,
                        ]}>
                        {isDone ? '✓' : i + 1}
                      </Text>
                    </View>
                    <Text
                      style={[
                        styles.stepLabel,
                        isCurrent && styles.stepLabelCurrent,
                      ]}>
                      {ACTION_LABEL[step]}
                    </Text>
                  </View>
                );
              })}
            </View>
          </View>

          {verdict && (
            <View style={[styles.verdict, verdict.ok && styles.verdictOk]}>
              <Text style={styles.verdictTitle}>{verdict.title}</Text>
              <Text style={styles.verdictDetail}>{verdict.detail}</Text>
            </View>
          )}
        </ScrollView>
      </View>
    );
  }

  // mode === 'verify'
  const verifyBusy = busy || engineState !== 'ready';
  const verifyRunning = liveness?.status === 'running';
  const showingResult = verifyResultTone !== null;
  const overlayText = showingResult
    ? verdict?.title ??
      (verifyResultTone === 'success' ? 'Matched' : 'Not verified')
    : liveness?.guidance || gate.guidance;
  const verifyLabel = showingResult
    ? verifyResultTone === 'success'
      ? 'Matched'
      : 'Not verified'
    : busy
    ? 'Verifying...'
    : verifyRunning
    ? liveness!.guidance
    : 'Start liveness + verify';
  return (
    <View style={styles.container}>
      <View style={styles.cameraPane}>
        {cameraFeed}
        <GuidanceOverlay
          ready={gate.ready}
          text={overlayText}
          subtitle={
            verifyRunning ? `${Math.ceil(liveness!.msLeft / 1000)}s` : undefined
          }
          resultTone={verifyResultTone ?? undefined}
        />
        {cameraTop}
        {geoStatus && <GeoBadge status={geoStatus} />}
        <View style={styles.cameraActionBar}>
          {verifyResultTone === 'success' ? (
            <View style={styles.resultActionsRow}>
              <TouchableOpacity
                style={[
                  styles.resultActionButton,
                  styles.resultActionSecondary,
                ]}
                onPress={goHome}>
                <Text style={styles.resultActionSecondaryText}>
                  Return to Home
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.resultActionButton, styles.resultActionPrimary]}
                onPress={startVerify}>
                <Text style={styles.resultActionPrimaryText}>
                  Begin new verification
                </Text>
              </TouchableOpacity>
            </View>
          ) : (
            <TouchableOpacity
              disabled={verifyBusy || verifyRunning || showingResult}
              style={[
                styles.cameraActionButton,
                (verifyBusy || verifyRunning || showingResult) &&
                  styles.disabledButton,
              ]}
              onPress={startVerify}>
              <Text style={styles.cameraActionText}>{verifyLabel}</Text>
            </TouchableOpacity>
          )}
        </View>
      </View>

      <ScrollView
        style={styles.panel}
        contentContainerStyle={styles.panelContent}>
        <View style={styles.headerRow}>
          <View>
            <Text style={styles.kicker}>DATALAKE 3.0 FIELD AUTH</Text>
            <Text style={styles.panelTitle}>Verify Face</Text>
          </View>
          {langVoiceToggles}
        </View>

        {engineState === 'error' && (
          <Text style={styles.errorText}>{engineError}</Text>
        )}

        <View style={styles.card}>
          <Text style={styles.cardTitle}>Run local verification</Text>
          <Text style={styles.helperText}>
            Center your face in the ring — you'll be asked to blink, smile and
            turn your head, in a random order, then matching runs against the
            templates saved on this phone.
          </Text>
          <TouchableOpacity
            style={styles.secondaryButton}
            onPress={openEnrollSetup}>
            <Text style={styles.secondaryButtonText}>
              Enroll another inspector
            </Text>
          </TouchableOpacity>
        </View>

        {verdict && (
          <View style={[styles.verdict, verdict.ok && styles.verdictOk]}>
            <Text style={styles.verdictTitle}>{verdict.title}</Text>
            <Text style={styles.verdictDetail}>
              {verdict.detail}
              {typeof verdict.latencyMs === 'number'
                ? ` · ${verdict.latencyMs} ms`
                : ''}
            </Text>
          </View>
        )}
      </ScrollView>
    </View>
  );
}

function roleLabel(role?: string): string {
  return (
    ENROLL_ROLES.find(r => r.id === role)?.label ??
    (role ? role : 'Field inspector')
  );
}

function initialsFor(id: string): string {
  return (
    id
      .replace(/[^a-zA-Z0-9]/g, '')
      .slice(0, 2)
      .toUpperCase() || 'NH'
  );
}

function HomePage({
  identity,
  enrolled,
  pending,
  verdict,
  syncing,
  onEnroll,
  onVerify,
  onSync,
  onOpenProfile,
}: {
  identity: {userId: string; role?: string} | null;
  enrolled: number;
  pending: number;
  verdict: Verdict | null;
  syncing: boolean;
  onEnroll: () => void;
  onVerify: () => void;
  onSync: () => void;
  onOpenProfile: () => void;
}): React.JSX.Element {
  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.home}>
      <View style={styles.homeTopBar}>
        <Text style={styles.kicker}>DATALAKE 3.0 FIELD AUTH</Text>
        <TouchableOpacity
          style={styles.profileButton}
          onPress={onOpenProfile}
          accessibilityLabel="Profile and settings">
          <Text style={styles.profileButtonText}>
            {identity ? initialsFor(identity.userId) : '⚙'}
          </Text>
        </TouchableOpacity>
      </View>

      <Image source={LOGO} style={styles.homeLogo} />

      {identity ? (
        <>
          <Text style={styles.welcomeKicker}>WELCOME BACK</Text>
          <Text style={styles.homeTitle}>{identity.userId}</Text>
          <View style={styles.rolePill}>
            <Text style={styles.rolePillText}>{roleLabel(identity.role)}</Text>
          </View>
          <Text style={styles.homeSubtitle}>
            You're enrolled on this device. Verify works fully offline; sync
            attendance when you're back online.
          </Text>
        </>
      ) : (
        <>
          <Text style={styles.homeTitle}>Face Auth</Text>
          <Text style={styles.homeSubtitle}>
            Enroll (needs internet) to register on this device — then verify
            fully offline in the field.
          </Text>
        </>
      )}

      <View style={styles.homeActions}>
        <TouchableOpacity style={styles.primaryButton} onPress={onVerify}>
          <Text style={styles.primaryButtonText}>Verify</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.secondaryButton} onPress={onEnroll}>
          <Text style={styles.secondaryButtonText}>
            {identity ? 'Enroll another inspector' : 'Enroll'}
          </Text>
        </TouchableOpacity>
      </View>

      <View style={styles.homeStats}>
        <Metric label="Templates" value={String(enrolled)} />
        <Metric label="Local records" value={String(pending)} />
      </View>

      {pending > 0 && (
        <TouchableOpacity
          style={[styles.primaryButton, syncing && styles.disabledButton]}
          onPress={onSync}
          disabled={syncing}>
          <Text style={styles.primaryButtonText}>
            {syncing
              ? 'Syncing…'
              : `Sync ${pending} record${pending === 1 ? '' : 's'} & purge`}
          </Text>
        </TouchableOpacity>
      )}

      {verdict && (
        <View style={[styles.verdict, verdict.ok && styles.verdictOk]}>
          <Text style={styles.verdictTitle}>{verdict.title}</Text>
          <Text style={styles.verdictDetail}>{verdict.detail}</Text>
        </View>
      )}

      <Text style={styles.versionTag}>{APP_VERSION}</Text>
    </ScrollView>
  );
}

function ProfilePanel({
  visible,
  identity,
  voice,
  lang,
  pending,
  online,
  onToggleVoice,
  onToggleLang,
  onReset,
  onClose,
}: {
  visible: boolean;
  identity: {userId: string; role?: string} | null;
  voice: boolean;
  lang: Lang;
  pending: number;
  online: boolean;
  onToggleVoice: () => void;
  onToggleLang: () => void;
  onReset: () => void;
  onClose: () => void;
}): React.JSX.Element {
  return (
    <Modal
      visible={visible}
      animationType="slide"
      transparent
      onRequestClose={onClose}>
      <View style={styles.sheetBackdrop}>
        <View style={styles.sheet}>
          <View style={styles.sheetHandle} />
          <View style={styles.sheetHeader}>
            <View style={styles.profileAvatar}>
              <Text style={styles.profileAvatarText}>
                {identity ? initialsFor(identity.userId) : 'NH'}
              </Text>
            </View>
            <View style={{flex: 1}}>
              <Text style={styles.sheetName}>
                {identity ? identity.userId : 'Not enrolled'}
              </Text>
              <Text style={styles.sheetRole}>
                {identity ? roleLabel(identity.role) : 'Enrol to register'}
              </Text>
            </View>
            <TouchableOpacity style={styles.sheetClose} onPress={onClose}>
              <Text style={styles.sheetCloseText}>Done</Text>
            </TouchableOpacity>
          </View>

          <Text style={styles.sheetSection}>SETTINGS</Text>
          <SettingRow
            label="Connection"
            value={online ? 'Online' : 'Offline'}
            active={online}
          />
          <SettingRow
            label="Voice prompts"
            value={voice ? 'On' : 'Off'}
            active={voice}
            onPress={onToggleVoice}
          />
          <SettingRow
            label="Language"
            value={lang === 'hi' ? 'हिन्दी' : 'English'}
            active
            onPress={onToggleLang}
          />
          <SettingRow label="Pending records" value={String(pending)} />
          <SettingRow label="App version" value={APP_VERSION} />

          <Text style={styles.sheetSection}>DEVICE</Text>
          <TouchableOpacity style={styles.dangerButton} onPress={onReset}>
            <Text style={styles.dangerButtonText}>
              Reset device (clear enrolments & records)
            </Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

function SettingRow({
  label,
  value,
  active,
  onPress,
}: {
  label: string;
  value: string;
  active?: boolean;
  onPress?: () => void;
}): React.JSX.Element {
  return (
    <TouchableOpacity
      style={styles.settingRow}
      onPress={onPress}
      disabled={!onPress}
      activeOpacity={onPress ? 0.6 : 1}>
      <Text style={styles.settingLabel}>{label}</Text>
      <Text style={[styles.settingValue, active && styles.settingValueActive]}>
        {value}
      </Text>
    </TouchableOpacity>
  );
}

function EnrollIdPage({
  userId,
  role,
  verdict,
  onChangeUserId,
  onChangeRole,
  onGenerate,
  onContinue,
  onBack,
}: {
  userId: string;
  role: string;
  verdict: Verdict | null;
  onChangeUserId: (id: string) => void;
  onChangeRole: (role: string) => void;
  onGenerate: () => void;
  onContinue: () => void;
  onBack: () => void;
}): React.JSX.Element {
  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.setupPage}>
      <TouchableOpacity style={styles.backPill} onPress={onBack}>
        <Text style={styles.backPillText}>BACK</Text>
      </TouchableOpacity>
      <Image source={LOGO} style={styles.setupLogo} />
      <Text style={styles.kicker}>ENROLLMENT</Text>
      <Text style={styles.homeTitle}>Inspector ID</Text>
      <Text style={styles.homeSubtitle}>
        Enter an ID from the field register, or generate one locally before face
        capture.
      </Text>

      <View style={styles.card}>
        <Text style={styles.cardTitle}>ID for this enrollment</Text>
        <TextInput
          value={userId}
          onChangeText={onChangeUserId}
          placeholder="Inspector ID"
          placeholderTextColor="#6b7780"
          autoCapitalize="none"
          style={styles.input}
        />
        <Text style={[styles.cardTitle, {marginTop: 16}]}>Role</Text>
        <View style={styles.roleRow}>
          {ENROLL_ROLES.map(r => {
            const active = r.id === role;
            return (
              <TouchableOpacity
                key={r.id}
                style={[styles.roleChip, active && styles.roleChipActive]}
                onPress={() => onChangeRole(r.id)}>
                <Text
                  style={[
                    styles.roleChipText,
                    active && styles.roleChipTextActive,
                  ]}>
                  {r.label}
                </Text>
              </TouchableOpacity>
            );
          })}
        </View>
        <View style={styles.setupButtons}>
          <TouchableOpacity style={styles.secondaryButton} onPress={onGenerate}>
            <Text style={styles.secondaryButtonText}>Generate ID</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.primaryButton} onPress={onContinue}>
            <Text style={styles.primaryButtonText}>Continue to camera</Text>
          </TouchableOpacity>
        </View>
      </View>

      {verdict && (
        <View style={[styles.verdict, verdict.ok && styles.verdictOk]}>
          <Text style={styles.verdictTitle}>{verdict.title}</Text>
          <Text style={styles.verdictDetail}>{verdict.detail}</Text>
        </View>
      )}
    </ScrollView>
  );
}

function Centered({children}: {children: React.ReactNode}): React.JSX.Element {
  return <View style={[styles.container, styles.centered]}>{children}</View>;
}

/** Live "distance to assigned site" readout on the verify camera screen. */
function GeoBadge({
  status,
}: {
  status: {
    reason: string;
    siteName?: string;
    inside: boolean;
  };
}): React.JSX.Element {
  let color = '#8b97a5';
  let text = 'Locating…';
  switch (status.reason) {
    case 'inside':
      color = '#38e0a5';
      text = `At ${status.siteName ?? 'assigned site'}`;
      break;
    case 'outside':
      color = '#f2b347';
      text = 'Not in assigned zone';
      break;
    case 'mocked':
      color = '#ff6b6b';
      text = 'Mock / fake GPS detected';
      break;
    case 'poor_accuracy':
      text = 'Improving GPS accuracy…';
      break;
    case 'no_fix':
      text = 'Locating…';
      break;
  }
  return (
    <View style={styles.geoBadge}>
      <View style={[styles.geoDot, {backgroundColor: color}]} />
      <Text style={[styles.geoBadgeText, {color}]}>{text}</Text>
    </View>
  );
}

function StatusPill({
  label,
  tone,
}: {
  label: string;
  tone: 'good' | 'warn';
}): React.JSX.Element {
  return (
    <View style={[styles.statusPill, tone === 'good' && styles.statusGood]}>
      <Text style={styles.statusText}>{label}</Text>
    </View>
  );
}

function Metric({
  label,
  value,
}: {
  label: string;
  value: string;
}): React.JSX.Element {
  return (
    <View style={styles.metric}>
      <Text style={styles.metricValue}>{value}</Text>
      <Text style={styles.metricLabel}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {flex: 1, backgroundColor: '#07090b'},
  centered: {alignItems: 'center', justifyContent: 'center', padding: 24},
  home: {
    justifyContent: 'center',
    paddingHorizontal: 22,
    paddingVertical: 24,
  },
  setupPage: {
    paddingHorizontal: 22,
    paddingVertical: 24,
  },
  homeLogo: {
    width: 168,
    height: 168,
    alignSelf: 'center',
    marginBottom: 22,
    borderRadius: 28,
  },
  setupLogo: {
    width: 116,
    height: 116,
    alignSelf: 'center',
    marginTop: 36,
    marginBottom: 22,
    borderRadius: 22,
  },
  permissionLogo: {
    width: 132,
    height: 132,
    borderRadius: 24,
    marginBottom: 22,
  },
  homeTitle: {
    color: '#dbe4e8',
    fontSize: 34,
    fontWeight: '900',
    marginTop: 6,
  },
  homeSubtitle: {
    color: '#8b97a5',
    fontSize: 15,
    lineHeight: 22,
    marginTop: 10,
  },
  homeActions: {marginTop: 22, gap: 10},
  homeStats: {flexDirection: 'row', gap: 8, marginTop: 16},
  cameraPane: {flex: 1.05, minHeight: 300, backgroundColor: '#000'},
  panel: {
    flex: 1,
    backgroundColor: '#0d1216',
    borderTopColor: '#25323b',
    borderTopWidth: 1,
  },
  panelContent: {
    paddingHorizontal: 16,
    paddingTop: 14,
    paddingBottom: 24,
  },
  title: {color: '#dbe4e8', fontSize: 22, fontWeight: '800', marginBottom: 8},
  subtitle: {
    color: '#8b97a5',
    fontSize: 14,
    textAlign: 'center',
    marginTop: 8,
    lineHeight: 20,
  },
  cameraTop: {
    position: 'absolute',
    top: 14,
    left: 14,
    right: 14,
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: 8,
  },
  geoBadge: {
    position: 'absolute',
    top: 56,
    alignSelf: 'center',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: 'rgba(7,9,11,0.82)',
    borderColor: '#25323b',
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 13,
    paddingVertical: 7,
  },
  geoDot: {width: 8, height: 8, borderRadius: 4},
  geoBadgeText: {fontSize: 12.5, fontWeight: '800'},
  cameraActionBar: {
    position: 'absolute',
    left: 16,
    right: 16,
    bottom: 16,
    backgroundColor: 'rgba(7,9,11,0.86)',
    borderColor: '#25323b',
    borderWidth: 1,
    padding: 10,
  },
  cameraActionButton: {
    backgroundColor: '#38e0a5',
    minHeight: 48,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  cameraActionText: {
    color: '#07100d',
    fontSize: 15,
    fontWeight: '900',
    textAlign: 'center',
  },
  resultActionsRow: {flexDirection: 'row', gap: 8},
  resultActionButton: {
    flex: 1,
    minHeight: 48,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 10,
    paddingVertical: 12,
  },
  resultActionPrimary: {backgroundColor: '#38e0a5'},
  resultActionSecondary: {
    borderColor: '#38e0a5',
    borderWidth: 1,
  },
  resultActionPrimaryText: {
    color: '#07100d',
    fontSize: 13,
    fontWeight: '900',
    textAlign: 'center',
  },
  resultActionSecondaryText: {
    color: '#38e0a5',
    fontSize: 13,
    fontWeight: '900',
    textAlign: 'center',
  },
  statusPill: {
    backgroundColor: 'rgba(242,179,71,0.16)',
    borderColor: '#f2b347',
    borderWidth: 1,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  statusGood: {
    backgroundColor: 'rgba(56,224,165,0.12)',
    borderColor: '#38e0a5',
  },
  statusText: {color: '#dbe4e8', fontSize: 10, fontWeight: '800'},
  backPill: {
    borderColor: '#25323b',
    borderWidth: 1,
    backgroundColor: 'rgba(7,9,11,0.76)',
    paddingHorizontal: 11,
    paddingVertical: 7,
    alignSelf: 'flex-start',
  },
  backPillText: {color: '#dbe4e8', fontSize: 11, fontWeight: '900'},
  headerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    gap: 12,
  },
  kicker: {
    color: '#38e0a5',
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 1.6,
  },
  panelTitle: {color: '#dbe4e8', fontSize: 24, fontWeight: '900', marginTop: 4},
  toggleRow: {flexDirection: 'row', gap: 8},
  smallToggle: {
    borderColor: '#25323b',
    borderWidth: 1,
    paddingHorizontal: 10,
    paddingVertical: 7,
  },
  toggleOn: {borderColor: '#38e0a5'},
  smallToggleText: {color: '#dbe4e8', fontSize: 12, fontWeight: '700'},
  metric: {
    flex: 1,
    backgroundColor: '#111a21',
    borderColor: '#25323b',
    borderWidth: 1,
    padding: 10,
  },
  metricValue: {color: '#38e0a5', fontSize: 18, fontWeight: '900'},
  metricLabel: {color: '#8b97a5', fontSize: 10, marginTop: 4},
  card: {
    marginTop: 12,
    backgroundColor: '#111a21',
    borderColor: '#25323b',
    borderWidth: 1,
    padding: 14,
  },
  cardHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  cardTitle: {color: '#dbe4e8', fontSize: 16, fontWeight: '900'},
  idLine: {
    color: '#38e0a5',
    fontSize: 15,
    fontWeight: '900',
    marginTop: 8,
  },
  progressText: {
    color: '#8b97a5',
    fontSize: 12,
    fontWeight: '700',
    marginTop: 4,
  },
  stepList: {marginTop: 14, gap: 10},
  stepRow: {flexDirection: 'row', alignItems: 'center', gap: 10},
  stepMarker: {
    width: 24,
    height: 24,
    borderRadius: 12,
    borderColor: '#25323b',
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stepMarkerDone: {backgroundColor: '#38e0a5', borderColor: '#38e0a5'},
  stepMarkerCurrent: {borderColor: '#38e0a5', borderWidth: 2},
  stepMarkerText: {color: '#dbe4e8', fontSize: 12, fontWeight: '900'},
  stepMarkerTextDone: {color: '#07100d'},
  stepLabel: {color: '#8b97a5', fontSize: 14, fontWeight: '600'},
  stepLabelCurrent: {color: '#dbe4e8', fontWeight: '900'},
  input: {
    marginTop: 12,
    borderColor: '#25323b',
    borderWidth: 1,
    color: '#dbe4e8',
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
  },
  helperText: {color: '#8b97a5', fontSize: 13, lineHeight: 18, marginTop: 10},
  primaryButton: {
    marginTop: 14,
    backgroundColor: '#38e0a5',
    paddingHorizontal: 18,
    paddingVertical: 13,
    alignItems: 'center',
  },
  disabledButton: {opacity: 0.45},
  primaryButtonText: {color: '#07100d', fontWeight: '900', fontSize: 14},
  secondaryButton: {
    marginTop: 10,
    borderColor: '#38e0a5',
    borderWidth: 1,
    paddingHorizontal: 18,
    paddingVertical: 13,
    alignItems: 'center',
  },
  secondaryButtonText: {color: '#38e0a5', fontWeight: '900', fontSize: 14},
  setupButtons: {marginTop: 14},
  roleRow: {flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 10},
  roleChip: {
    borderColor: '#25323b',
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  roleChipActive: {
    borderColor: '#38e0a5',
    backgroundColor: 'rgba(56,224,165,0.12)',
  },
  roleChipText: {color: '#8b97a5', fontSize: 13, fontWeight: '700'},
  roleChipTextActive: {color: '#38e0a5'},
  dangerButton: {
    marginTop: 10,
    borderColor: '#ff6b6b',
    borderWidth: 1,
    paddingVertical: 10,
    alignItems: 'center',
  },
  dangerButtonText: {color: '#ff6b6b', fontWeight: '800'},
  versionTag: {
    color: '#4a5560',
    fontSize: 11,
    fontWeight: '700',
    textAlign: 'center',
    marginTop: 16,
  },
  homeTopBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    width: '100%',
    marginBottom: 6,
  },
  profileButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: '#25323b',
    backgroundColor: '#111a21',
    alignItems: 'center',
    justifyContent: 'center',
  },
  profileButtonText: {color: '#38e0a5', fontSize: 14, fontWeight: '900'},
  welcomeKicker: {
    color: '#38e0a5',
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 2,
    marginTop: 6,
  },
  rolePill: {
    alignSelf: 'flex-start',
    marginTop: 8,
    borderColor: '#25323b',
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 5,
    backgroundColor: 'rgba(56,224,165,0.1)',
  },
  rolePillText: {color: '#38e0a5', fontSize: 12, fontWeight: '800'},
  sheetBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.55)',
    justifyContent: 'flex-end',
  },
  sheet: {
    backgroundColor: '#0d1216',
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    borderTopColor: '#25323b',
    borderTopWidth: 1,
    padding: 20,
    paddingBottom: 34,
  },
  sheetHandle: {
    alignSelf: 'center',
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: '#25323b',
    marginBottom: 16,
  },
  sheetHeader: {flexDirection: 'row', alignItems: 'center', gap: 12},
  profileAvatar: {
    width: 46,
    height: 46,
    borderRadius: 23,
    backgroundColor: 'rgba(56,224,165,0.14)',
    borderColor: '#38e0a5',
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  profileAvatarText: {color: '#38e0a5', fontSize: 16, fontWeight: '900'},
  sheetName: {color: '#dbe4e8', fontSize: 17, fontWeight: '900'},
  sheetRole: {color: '#8b97a5', fontSize: 13, marginTop: 2},
  sheetClose: {
    borderColor: '#25323b',
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 7,
  },
  sheetCloseText: {color: '#38e0a5', fontWeight: '800', fontSize: 13},
  sheetSection: {
    color: '#46535b',
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 1.4,
    marginTop: 20,
    marginBottom: 6,
  },
  settingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 13,
    borderBottomColor: '#1a242c',
    borderBottomWidth: 1,
  },
  settingLabel: {color: '#dbe4e8', fontSize: 15},
  settingValue: {color: '#8b97a5', fontSize: 14, fontWeight: '700'},
  settingValueActive: {color: '#38e0a5'},
  verdict: {
    marginTop: 12,
    borderColor: '#ff6b6b',
    borderWidth: 1,
    backgroundColor: 'rgba(255,107,107,0.08)',
    padding: 12,
  },
  verdictOk: {
    borderColor: '#38e0a5',
    backgroundColor: 'rgba(56,224,165,0.08)',
  },
  verdictTitle: {color: '#dbe4e8', fontSize: 15, fontWeight: '900'},
  verdictDetail: {color: '#8b97a5', fontSize: 12, marginTop: 4},
  errorText: {color: '#ff6b6b', fontSize: 12, marginTop: 8},
});
