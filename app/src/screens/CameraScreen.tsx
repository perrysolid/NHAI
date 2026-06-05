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
  Linking,
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

import {
  ACTIVE_RECOGNITION,
  CAMERA,
  LIVENESS_MODEL,
  RECOGNITION_MODELS,
  THRESHOLDS,
} from '../config';
import {evaluateFace} from '../camera/qualityGates';
import {meanLuma} from '../camera/frameUtils';
import type {Face, FaceBounds, GateResult} from '../camera/types';
import {OfflineAuthStore} from '../auth/offlineStore';
import {createEncryptedAuthStore} from '../auth/mmkvStore';
import {syncPending} from '../sync/syncClient';
import {pick, GATE_TEXT, getLang, setLang, type Lang} from '../i18n';
import {speak, setSpeechEnabled} from '../speech/tts';
import {
  ActiveLivenessChallenge,
  evaluateDualLiveness,
  type LivenessSnapshot,
} from '../face/liveness';
import {TfliteFaceEngine, preprocessRgb, type FaceEngine} from '../face/engine';
import {computeComposite, confidenceFromCosine} from '../face/scoring';
import GuidanceOverlay from './GuidanceOverlay';

type Mode = 'enroll' | 'verify' | 'records';
type EngineState = 'loading' | 'ready' | 'error';

interface LatestTensors {
  recognition: Uint8Array;
  liveness: Uint8Array;
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

function clamp(n: number, min: number, max: number): number {
  'worklet';
  return Math.max(min, Math.min(max, n));
}

function expandedSquare(
  bounds: FaceBounds,
  frameWidth: number,
  frameHeight: number,
  expansion: number,
): FaceBounds {
  'worklet';
  const size = Math.max(bounds.width, bounds.height) * expansion;
  const cx = bounds.x + bounds.width / 2;
  const cy = bounds.y + bounds.height / 2;
  const x = clamp(cx - size / 2, 0, Math.max(0, frameWidth - size));
  const y = clamp(cy - size / 2, 0, Math.max(0, frameHeight - size));
  const maxSize = Math.min(size, frameWidth - x, frameHeight - y);
  return {
    x: Math.round(x),
    y: Math.round(y),
    width: Math.round(maxSize),
    height: Math.round(maxSize),
  };
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString('en-IN', {hour12: false});
}

export default function CameraScreen(): React.JSX.Element {
  const {hasPermission, requestPermission} = useCameraPermission();
  const device = useCameraDevice('front');
  const [gate, setGate] = useState<GateResult>(INITIAL_GATE);
  const [voice, setVoice] = useState(true);
  const [lang, setLangState] = useState<Lang>(getLang());
  const [mode, setMode] = useState<Mode>('enroll');
  const [userId, setUserId] = useState('inspector_01');
  const [engineState, setEngineState] = useState<EngineState>('loading');
  const [engineError, setEngineError] = useState('');
  const [samples, setSamples] = useState(0);
  const [enrolled, setEnrolled] = useState(0);
  const [pending, setPending] = useState(0);
  const [verdict, setVerdict] = useState<Verdict | null>(null);
  const [liveness, setLiveness] = useState<LivenessSnapshot | null>(null);
  const [busy, setBusy] = useState(false);

  const store = useMemo<OfflineAuthStore>(() => createEncryptedAuthStore(), []);
  const engineRef = useRef<FaceEngine | null>(null);
  const latestFaceRef = useRef<Face | null>(null);
  const latestBrightnessRef = useRef(0);
  const latestTensorsRef = useRef<LatestTensors | null>(null);
  const enrollSamplesRef = useRef<Float32Array[]>([]);
  const challengeRef = useRef<ActiveLivenessChallenge | null>(null);

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

  useEffect(() => {
    if (voice && gate.guidance) {
      speak(gate.guidance);
    }
  }, [voice, gate.guidance]);

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

  useEffect(() => {
    if (!hasPermission) {
      requestPermission();
    }
  }, [hasPermission, requestPermission]);

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
          recognitionRgb?: Uint8Array,
          livenessRgb?: Uint8Array,
        ) => {
          const gateResult = evaluateFace({faces, frameWidth, brightness});
          setGate(gateResult);
          latestFaceRef.current = faces.length === 1 ? faces[0] : null;
          latestBrightnessRef.current = brightness;
          if (recognitionRgb && livenessRgb) {
            latestTensorsRef.current = {
              recognition: new Uint8Array(recognitionRgb),
              liveness: new Uint8Array(livenessRgb),
            };
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
        const faces = detectFaces(frame) as Face[];
        const small = resize(frame, {
          scale: {width: 16, height: 16},
          pixelFormat: 'rgb',
          dataType: 'uint8',
        });
        const brightness = meanLuma(small as Uint8Array);

        let recognitionRgb: Uint8Array | undefined;
        let livenessRgb: Uint8Array | undefined;
        if (faces.length === 1) {
          const b = faces[0].bounds;
          const recogCrop = expandedSquare(b, frame.width, frame.height, 1.35);
          const liveCrop = expandedSquare(
            b,
            frame.width,
            frame.height,
            LIVENESS_MODEL.bboxExpansion,
          );
          recognitionRgb = resize(frame, {
            scale: {
              width: RECOGNITION_MODELS[ACTIVE_RECOGNITION].inputSize,
              height: RECOGNITION_MODELS[ACTIVE_RECOGNITION].inputSize,
            },
            crop: recogCrop,
            pixelFormat: 'rgb',
            dataType: 'uint8',
          }) as Uint8Array;
          livenessRgb = resize(frame, {
            scale: {
              width: LIVENESS_MODEL.inputSize,
              height: LIVENESS_MODEL.inputSize,
            },
            crop: liveCrop,
            pixelFormat: 'rgb',
            dataType: 'uint8',
          }) as Uint8Array;
        }
        onSignals(faces, frame.width, brightness, recognitionRgb, livenessRgb);
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

  const captureEmbedding = useCallback(async (): Promise<Float32Array> => {
    const engine = engineRef.current;
    const tensors = latestTensorsRef.current;
    if (!engine || engineState !== 'ready') {
      throw new Error('Models are still loading');
    }
    if (!gate.ready || !tensors) {
      throw new Error(gate.guidance || 'Center your face');
    }
    const spec = RECOGNITION_MODELS[ACTIVE_RECOGNITION];
    return engine.embedFace(preprocessRgb(tensors.recognition, spec));
  }, [engineState, gate]);

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
        setVerdict({
          ok: true,
          title: 'Enrollment saved offline',
          detail: `${id} · ${THRESHOLDS.enrollSamples} samples averaged`,
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
    setMode('verify');
  }, [store]);

  const runVerify = useCallback(async () => {
    const engine = engineRef.current;
    const tensors = latestTensorsRef.current;
    const face = latestFaceRef.current;
    if (!engine || !tensors || !face) {
      throw new Error('Face frame unavailable');
    }
    const t0 = Date.now();
    const recognitionSpec = RECOGNITION_MODELS[ACTIVE_RECOGNITION];
    const [probe, passiveScore] = await Promise.all([
      engine.embedFace(preprocessRgb(tensors.recognition, recognitionSpec)),
      engine.scoreLive(preprocessRgb(tensors.liveness, LIVENESS_MODEL)),
    ]);
    const verify = store.verify(probe);
    const live = evaluateDualLiveness({
      passiveScore,
      activeStatus: 'passed',
    });
    const confidence = confidenceFromCosine(Math.max(0, verify.matchScore));
    const composite = computeComposite({
      recognitionConfidence: confidence,
      livenessPassed: live.passed,
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
    if (!live.passed) {
      store.queueAttendance({
        userId: userId.trim() || 'unidentified',
        livenessScore: passiveScore,
        matchScore: verify.matchScore,
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
    store.queueAttendance({
      userId: verify.userId,
      livenessScore: passiveScore,
      matchScore: verify.matchScore,
    });
    refreshCounts();
    setVerdict({
      ok: true,
      title: composite.lowTrust ? 'Matched · review' : 'Matched offline',
      detail: `${verify.userId} · score ${composite.overall}/100`,
      score: composite.overall,
      latencyMs,
    });
  }, [refreshCounts, store, userId]);

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
      if (voice && snap.guidance) {
        speak(snap.guidance);
      }
      if (snap.status === 'passed') {
        setBusy(true);
        runVerify()
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
    }, 160);
    return () => clearInterval(id);
  }, [liveness, mode, refreshCounts, runVerify, store, userId, voice]);

  const onSync = useCallback(async () => {
    setBusy(true);
    try {
      const out = await syncPending(store);
      refreshCounts();
      setVerdict({
        ok: out.ok,
        title: out.ok ? 'Sync complete' : 'Sync failed',
        detail: out.ok
          ? `${out.purged} queued record(s) purged locally${
              out.mocked ? ' · simulated backend' : ''
            }`
          : out.error ?? 'Network unavailable',
      });
    } finally {
      setBusy(false);
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

  if (!hasPermission) {
    return (
      <Centered>
        <Text style={styles.title}>Camera permission needed</Text>
        <Text style={styles.subtitle}>
          Identity is verified fully on-device. Images never leave the phone.
        </Text>
        <TouchableOpacity style={styles.primaryButton} onPress={onRequest}>
          <Text style={styles.primaryButtonText}>Allow camera</Text>
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

  const queue = store.getPendingQueue();

  return (
    <View style={styles.container}>
      <View style={styles.cameraPane}>
        <Camera
          style={StyleSheet.absoluteFill}
          device={device}
          isActive={true}
          frameProcessor={frameProcessor}
        />
        <GuidanceOverlay gate={gate} />
        <View style={styles.cameraTop}>
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
          <StatusPill label="AUTH NETWORK 0" tone="good" />
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
      </View>

      <View style={styles.panel}>
        <View style={styles.headerRow}>
          <View>
            <Text style={styles.kicker}>DATALAKE 3.0 FIELD AUTH</Text>
            <Text style={styles.panelTitle}>Offline Face Auth</Text>
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

        <View style={styles.tabs}>
          {(['enroll', 'verify', 'records'] as Mode[]).map(item => (
            <TouchableOpacity
              key={item}
              style={[styles.tab, mode === item && styles.tabActive]}
              onPress={() => setMode(item)}>
              <Text
                style={[styles.tabText, mode === item && styles.tabTextActive]}>
                {item.toUpperCase()}
              </Text>
            </TouchableOpacity>
          ))}
        </View>

        <View style={styles.statsRow}>
          <Metric label="Enrolled" value={String(enrolled)} />
          <Metric label="Queue" value={String(pending)} />
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
            <Text style={styles.cardTitle}>Enroll inspector offline</Text>
            <TextInput
              value={userId}
              onChangeText={setUserId}
              placeholder="Inspector ID"
              placeholderTextColor="#6b7780"
              autoCapitalize="none"
              style={styles.input}
            />
            <Text style={styles.helperText}>
              Capture {THRESHOLDS.enrollSamples} steady face samples. Only the
              embedding is stored in encrypted MMKV.
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
          </View>
        )}

        {mode === 'verify' && (
          <View style={styles.card}>
            <Text style={styles.cardTitle}>Verify attendance offline</Text>
            <Text style={styles.helperText}>
              The phone runs active liveness, MiniFASNet passive anti-spoof and
              MobileFaceNet matching locally before queueing attendance.
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
          </View>
        )}

        {mode === 'records' && (
          <View style={styles.card}>
            <View style={styles.cardHeaderRow}>
              <Text style={styles.cardTitle}>Offline queue</Text>
              <TouchableOpacity onPress={onSync} style={styles.linkButton}>
                <Text style={styles.linkButtonText}>Sync + purge</Text>
              </TouchableOpacity>
            </View>
            <ScrollView style={styles.queueList}>
              {queue.length === 0 ? (
                <Text style={styles.helperText}>
                  Queue empty. Verified records purge after sync
                  acknowledgement.
                </Text>
              ) : (
                queue.map(record => (
                  <View
                    key={`${record.userId}-${record.timestamp}`}
                    style={styles.queueItem}>
                    <Text style={styles.queueUser}>{record.userId}</Text>
                    <Text style={styles.queueMeta}>
                      {formatTime(record.timestamp)} · live{' '}
                      {(record.livenessScore * 100).toFixed(0)}% · match{' '}
                      {(record.matchScore * 100).toFixed(0)}%
                    </Text>
                  </View>
                ))
              )}
            </ScrollView>
            <TouchableOpacity
              onPress={onClearLocal}
              style={styles.dangerButton}>
              <Text style={styles.dangerButtonText}>Reset local demo data</Text>
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
  },
  cameraBottom: {
    position: 'absolute',
    left: 16,
    right: 16,
    bottom: 18,
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
  tabs: {flexDirection: 'row', gap: 8, marginTop: 14},
  tab: {
    flex: 1,
    borderColor: '#25323b',
    borderWidth: 1,
    paddingVertical: 10,
    alignItems: 'center',
  },
  tabActive: {backgroundColor: '#111a21', borderColor: '#38e0a5'},
  tabText: {color: '#8b97a5', fontSize: 12, fontWeight: '800'},
  tabTextActive: {color: '#38e0a5'},
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
  linkButton: {paddingHorizontal: 8, paddingVertical: 6},
  linkButtonText: {color: '#38e0a5', fontWeight: '800', fontSize: 12},
  dangerButton: {
    marginTop: 10,
    borderColor: '#ff6b6b',
    borderWidth: 1,
    paddingVertical: 10,
    alignItems: 'center',
  },
  dangerButtonText: {color: '#ff6b6b', fontWeight: '800'},
  queueList: {maxHeight: 145, marginTop: 8},
  queueItem: {
    borderTopColor: '#25323b',
    borderTopWidth: 1,
    paddingVertical: 8,
  },
  queueUser: {color: '#dbe4e8', fontSize: 14, fontWeight: '800'},
  queueMeta: {color: '#8b97a5', fontSize: 12, marginTop: 3},
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
