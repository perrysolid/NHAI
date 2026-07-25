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
import {createLocationProvider} from '../location/locationProvider';
import type {GeofenceResult, LocationFix} from '../location/types';
import type {RecordLocation} from '../auth/offlineStore';
import {evaluateFace} from '../camera/qualityGates';
import {autoFireReady} from '../camera/autoCapture';
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
import {TfliteFaceEngine, preprocessRgb, type FaceEngine} from '../face/engine';
import {computeComposite, confidenceFromCosine} from '../face/scoring';
import {syncPending} from '../sync/syncClient';
import GuidanceOverlay from './GuidanceOverlay';

type Page = 'home' | 'enroll_id' | 'camera';
type Mode = 'enroll' | 'verify';
type EngineState = 'loading' | 'ready' | 'error';

const LOGO = require('../../assets/branding/datalake-face-auth-logo.png');

// Bump alongside android versionName so a screenshot reveals the running build.
const APP_VERSION = 'v1.8 · build 9';

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
      return `At ${geo.siteName ?? 'site'}`;
    case 'outside':
      return `${geo.distanceM} m outside ${geo.siteName ?? 'site'}`;
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
  const [engineState, setEngineState] = useState<EngineState>('loading');
  const [engineError, setEngineError] = useState('');
  const [samples, setSamples] = useState(0);
  const [enrolled, setEnrolled] = useState(0);
  const [pending, setPending] = useState(0);
  const [verdict, setVerdict] = useState<Verdict | null>(null);
  const [liveness, setLiveness] = useState<LivenessSnapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const [syncing, setSyncing] = useState(false);

  const store = useMemo<OfflineAuthStore>(() => createEncryptedAuthStore(), []);
  const locationProvider = useMemo(() => createLocationProvider(), []);
  const latestFixRef = useRef<LocationFix | null>(null);
  const engineRef = useRef<FaceEngine | null>(null);
  const latestFaceRef = useRef<Face | null>(null);
  const latestBrightnessRef = useRef(0);
  const latestMediumRef = useRef<MediumFrame | null>(null);
  const latestRgbLenRef = useRef(0);
  const enrollSamplesRef = useRef<Float32Array[]>([]);
  const challengeRef = useRef<ActiveLivenessChallenge | null>(null);
  // Mirrors for stable closures used by the autonomous capture loop.
  const busyRef = useRef(false);
  const gateReadyRef = useRef(false);
  const lastAutoRef = useRef(0);
  // Re-armed only after the face leaves the ring, so auto-verify fires once per
  // presentation instead of looping.
  const verifyArmedRef = useRef(true);

  useEffect(() => {
    busyRef.current = busy;
  }, [busy]);
  useEffect(() => {
    gateReadyRef.current = gate.ready;
  }, [gate.ready]);

  const refreshCounts = useCallback(() => {
    setEnrolled(store.listEnrollments().length);
    setPending(store.getPendingQueue().length);
  }, [store]);

  useEffect(() => {
    refreshCounts();
  }, [refreshCounts]);

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
          if (!cancelled && fix) {
            latestFixRef.current = fix;
          }
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
  }, [page, locationProvider]);

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
          setGate(gateResult);
          latestFaceRef.current = faces.length === 1 ? faces[0] : null;
          latestBrightnessRef.current = brightness;
          latestRgbLenRef.current = rgbLen;
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
    setMode('enroll');
    setPage('enroll_id');
    setVerdict(null);
    setSamples(0);
    enrollSamplesRef.current = [];
  }, []);

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
  }, [store]);

  const goHome = useCallback(() => {
    challengeRef.current = null;
    setLiveness(null);
    setPage('home');
  }, []);

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

  const onCaptureEnroll = useCallback(async () => {
    const id = userId.trim();
    if (!id) {
      setVerdict({ok: false, title: 'Enter inspector ID', detail: 'Required'});
      return;
    }
    setBusy(true);
    try {
      const embedding = await captureEmbedding();
      enrollSamplesRef.current.push(embedding);
      const count = enrollSamplesRef.current.length;
      setSamples(count);
      if (count >= THRESHOLDS.enrollSamples) {
        store.saveEnrollment(id, enrollSamplesRef.current);
        enrollSamplesRef.current = [];
        setSamples(0);
        refreshCounts();
        setMode('verify');
        setLiveness(null);
        setVerdict({
          ok: true,
          title: 'Enrollment saved offline',
          detail: `${id} is ready for verification`,
        });
      } else {
        setVerdict({
          ok: true,
          title: `Sample ${count}/${THRESHOLDS.enrollSamples}`,
          detail: 'Hold steady and capture the next sample',
        });
      }
    } catch (e) {
      setVerdict({
        ok: false,
        title: 'Capture blocked',
        detail: e instanceof Error ? e.message : 'Try again',
      });
    } finally {
      setBusy(false);
    }
  }, [captureEmbedding, refreshCounts, store, userId]);

  // Autonomous enrollment: while on the enroll camera, capture steady samples
  // automatically as soon as the face is centered in the ring — no tapping. The
  // quality gate (gateReadyRef) is the "face in the center" trigger.
  useEffect(() => {
    if (page !== 'camera' || mode !== 'enroll' || engineState !== 'ready') {
      return;
    }
    const id = setInterval(() => {
      const now = Date.now();
      if (
        !autoFireReady({
          now,
          lastAt: lastAutoRef.current,
          cooldownMs: CAMERA.autoCaptureCooldownMs,
          blocked: busyRef.current,
          gateReady: gateReadyRef.current,
        })
      ) {
        return;
      }
      lastAutoRef.current = now;
      onCaptureEnroll().catch(() => undefined);
    }, CAMERA.autoLoopIntervalMs);
    return () => clearInterval(id);
  }, [page, mode, engineState, onCaptureEnroll]);

  const startVerify = useCallback(() => {
    if (store.listEnrollments().length === 0) {
      setVerdict({
        ok: false,
        title: 'No enrollments yet',
        detail: 'Enroll at least one inspector first',
      });
      return;
    }
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
      // Active motion challenge is the hard requirement; the passive MiniFASNet
      // score is advisory unless REQUIRE_PASSIVE_LIVENESS is on (see config).
      const livePassed = FLAGS.REQUIRE_PASSIVE_LIVENESS
        ? dual.passed
        : dual.activePassed;
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

      // On-device geofence: is the worker physically at the assigned site? This
      // reads the cached GPS fix (no wait) and never touches the identity
      // decision — it's an independent presence signal on the record.
      const fix = latestFixRef.current;
      const geo = evaluateGeofence(fix, SITES, {
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
        setVerdict({
          ok: false,
          title: 'Liveness blocked',
          detail: `Passive score ${(passiveScore * 100).toFixed(0)}%`,
          score: composite.overall,
          latencyMs,
        });
        return;
      }
      if (!verify.ok || !verify.userId) {
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
      setVerdict({
        ok: true,
        title: composite.lowTrust ? 'Matched · review' : 'Matched offline',
        detail: `${verify.userId} · score ${composite.overall}/100${
          location ? ` · ${geofenceReasonText(geo)}` : ''
        }`,
        score: composite.overall,
        latencyMs,
      });
    },
    [refreshCounts, store, userId],
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
        !verifyArmedRef.current
      ) {
        return;
      }
      verifyArmedRef.current = false;
      startVerify();
    }, CAMERA.autoLoopIntervalMs);
    return () => clearInterval(id);
  }, [page, mode, engineState, startVerify]);

  useEffect(() => {
    if (mode !== 'verify' || !liveness || liveness.status !== 'running') {
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
          speak(LIVENESS_TEXT[snap.challenges[snap.index]]);
        } else if (snap.status === 'failed') {
          speak(LIVENESS_TEXT.failed);
        }
      }
      if (snap.status === 'passed') {
        setBusy(true);
        runVerify('passed')
          .catch((e: unknown) => {
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
        setVerdict({
          ok: false,
          title: 'Liveness failed',
          detail: 'Presentation attack blocked and queued',
        });
        challengeRef.current = null;
      }
    }, CAMERA.challengeTickMs);
    return () => clearInterval(id);
  }, [liveness, mode, refreshCounts, runVerify, store, userId, voice]);

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
      if (outcome.ok) {
        setVerdict({
          ok: true,
          title: outcome.mocked
            ? 'Synced (mock) · queue purged'
            : 'Synced to server · queue purged',
          detail: `${outcome.purged} record${
            outcome.purged === 1 ? '' : 's'
          } uploaded${outcome.mocked ? ' — MOCK_MODE, no network' : ''}`,
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
  }, [refreshCounts, store]);

  const onClearLocal = useCallback(() => {
    store.clearAll();
    enrollSamplesRef.current = [];
    setSamples(0);
    refreshCounts();
    setVerdict({
      ok: true,
      title: 'Local demo reset',
      detail: 'Enrollments and queue cleared on this device',
    });
  }, [refreshCounts, store]);

  if (page === 'home') {
    return (
      <HomePage
        enrolled={enrolled}
        pending={pending}
        verdict={verdict}
        syncing={syncing}
        onEnroll={openEnrollSetup}
        onVerify={openVerifyCamera}
        onSync={onSync}
        onReset={onClearLocal}
      />
    );
  }

  if (page === 'enroll_id') {
    return (
      <EnrollIdPage
        userId={userId}
        verdict={verdict}
        onChangeUserId={setUserId}
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

  const actionDisabled = busy || engineState !== 'ready';
  const actionLabel =
    mode === 'enroll'
      ? `Capture sample ${samples + 1}/${THRESHOLDS.enrollSamples}`
      : busy
      ? 'Verifying...'
      : liveness?.status === 'running'
      ? liveness.guidance
      : 'Start liveness + verify';

  return (
    <View style={styles.container}>
      <View style={styles.cameraPane}>
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
        <GuidanceOverlay gate={gate} />
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
        <View style={styles.cameraBottom}>
          <Text style={styles.guidanceText}>
            {liveness?.guidance || gate.guidance}
          </Text>
          {liveness?.status === 'running' && (
            <Text style={styles.timerText}>
              {Math.ceil(liveness.msLeft / 1000)}s
            </Text>
          )}
        </View>
        <View style={styles.cameraActionBar}>
          <TouchableOpacity
            disabled={actionDisabled || liveness?.status === 'running'}
            style={[
              styles.cameraActionButton,
              (actionDisabled || liveness?.status === 'running') &&
                styles.disabledButton,
            ]}
            onPress={mode === 'enroll' ? onCaptureEnroll : startVerify}>
            <Text style={styles.cameraActionText}>{actionLabel}</Text>
          </TouchableOpacity>
          <Text style={styles.cameraActionHint}>
            {engineState === 'ready'
              ? gate.ready
                ? mode === 'enroll'
                  ? 'Face detected — capturing automatically. Hold steady.'
                  : 'Face detected — follow the liveness prompts.'
                : gate.guidance
              : engineState === 'loading'
              ? 'Loading offline models...'
              : engineError}
          </Text>
        </View>
      </View>

      <View style={styles.panel}>
        <View style={styles.headerRow}>
          <View>
            <Text style={styles.kicker}>DATALAKE 3.0 FIELD AUTH</Text>
            <Text style={styles.panelTitle}>
              {mode === 'enroll' ? 'Enroll Face' : 'Verify Face'}
            </Text>
          </View>
          <View style={styles.toggleRow}>
            <TouchableOpacity style={styles.smallToggle} onPress={toggleLang}>
              <Text style={styles.smallToggleText}>
                {lang === 'hi' ? 'हिन्दी' : 'ENG'}
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.smallToggle, voice && styles.toggleOn]}
              onPress={() => setVoice(v => !v)}>
              <Text style={styles.smallToggleText}>
                {voice ? 'Voice' : 'Mute'}
              </Text>
            </TouchableOpacity>
          </View>
        </View>

        <View style={styles.statsRow}>
          <Metric label="Templates" value={String(enrolled)} />
          <Metric label="Local records" value={String(pending)} />
          <Metric
            label="Model"
            value={
              engineState === 'ready'
                ? `${ACTIVE_RECOGNITION}`
                : engineState === 'loading'
                ? 'loading'
                : 'error'
            }
          />
        </View>

        {engineState === 'error' && (
          <Text style={styles.errorText}>{engineError}</Text>
        )}

        {mode === 'enroll' && (
          <View style={styles.card}>
            <Text style={styles.cardTitle}>Capture local face template</Text>
            <Text style={styles.idLine}>{userId.trim()}</Text>
            <Text style={styles.helperText}>
              Center your face in the ring — it turns green and all{' '}
              {THRESHOLDS.enrollSamples} samples are captured automatically and
              stored on this phone. No tapping needed (manual button below is a
              fallback).
            </Text>
            <TouchableOpacity
              disabled={busy || engineState !== 'ready'}
              style={[
                styles.primaryButton,
                (busy || engineState !== 'ready') && styles.disabledButton,
              ]}
              onPress={onCaptureEnroll}>
              <Text style={styles.primaryButtonText}>
                Capture sample {samples + 1}/{THRESHOLDS.enrollSamples}
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.secondaryButton}
              onPress={openEnrollSetup}>
              <Text style={styles.secondaryButtonText}>
                Change inspector ID
              </Text>
            </TouchableOpacity>
          </View>
        )}

        {mode === 'verify' && (
          <View style={styles.card}>
            <Text style={styles.cardTitle}>Run local verification</Text>
            <Text style={styles.helperText}>
              Center your face in the ring — the randomized blink / smile /
              head-turn liveness challenge starts automatically, then MiniFASNet
              passive anti-spoof + MobileFaceNet matching run on-device.
              Liveness is always required, so a photo or replay can't pass.
            </Text>
            <TouchableOpacity
              disabled={busy || engineState !== 'ready'}
              style={[
                styles.primaryButton,
                (busy || engineState !== 'ready') && styles.disabledButton,
              ]}
              onPress={startVerify}>
              <Text style={styles.primaryButtonText}>
                {busy ? 'Verifying...' : 'Start liveness + verify'}
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.secondaryButton}
              onPress={openEnrollSetup}>
              <Text style={styles.secondaryButtonText}>
                Enroll another inspector
              </Text>
            </TouchableOpacity>
          </View>
        )}

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
      </View>
    </View>
  );
}

function HomePage({
  enrolled,
  pending,
  verdict,
  syncing,
  onEnroll,
  onVerify,
  onSync,
  onReset,
}: {
  enrolled: number;
  pending: number;
  verdict: Verdict | null;
  syncing: boolean;
  onEnroll: () => void;
  onVerify: () => void;
  onSync: () => void;
  onReset: () => void;
}): React.JSX.Element {
  return (
    <View style={[styles.container, styles.home]}>
      <Image source={LOGO} style={styles.homeLogo} />
      <Text style={styles.kicker}>DATALAKE 3.0 FIELD AUTH</Text>
      <Text style={styles.homeTitle}>Face Auth</Text>
      <Text style={styles.homeSubtitle}>
        Choose a local action. Enroll creates the face template on this phone;
        verify checks against saved templates.
      </Text>

      <View style={styles.homeActions}>
        <TouchableOpacity style={styles.primaryButton} onPress={onVerify}>
          <Text style={styles.primaryButtonText}>Verify</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.secondaryButton} onPress={onEnroll}>
          <Text style={styles.secondaryButtonText}>Enroll</Text>
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

      {(enrolled > 0 || pending > 0) && (
        <TouchableOpacity onPress={onReset} style={styles.dangerButton}>
          <Text style={styles.dangerButtonText}>Reset local demo data</Text>
        </TouchableOpacity>
      )}

      <Text style={styles.versionTag}>{APP_VERSION}</Text>
    </View>
  );
}

function EnrollIdPage({
  userId,
  verdict,
  onChangeUserId,
  onGenerate,
  onContinue,
  onBack,
}: {
  userId: string;
  verdict: Verdict | null;
  onChangeUserId: (id: string) => void;
  onGenerate: () => void;
  onContinue: () => void;
  onBack: () => void;
}): React.JSX.Element {
  return (
    <View style={[styles.container, styles.setupPage]}>
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
    </View>
  );
}

function Centered({children}: {children: React.ReactNode}): React.JSX.Element {
  return <View style={[styles.container, styles.centered]}>{children}</View>;
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
    paddingHorizontal: 16,
    paddingTop: 14,
    paddingBottom: 10,
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
  cameraBottom: {
    position: 'absolute',
    left: 16,
    right: 16,
    bottom: 112,
    minHeight: 46,
    backgroundColor: 'rgba(7,9,11,0.74)',
    borderColor: '#25323b',
    borderWidth: 1,
    paddingHorizontal: 14,
    paddingVertical: 10,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  guidanceText: {color: '#dbe4e8', fontSize: 15, fontWeight: '700', flex: 1},
  timerText: {color: '#38e0a5', fontSize: 16, fontWeight: '900'},
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
  cameraActionHint: {
    color: '#8b97a5',
    fontSize: 12,
    lineHeight: 17,
    marginTop: 8,
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
  statsRow: {flexDirection: 'row', gap: 8, marginTop: 12},
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
  setupButtons: {marginTop: 4},
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
