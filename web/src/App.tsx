/**
 * Datalake Face Auth — web console (Vercel frontend).
 *
 * In-browser facial authentication: enroll -> liveness challenge -> recognition,
 * then sync the verified attendance record to the backend and purge the local
 * queue. All face inference runs client-side (@vladmandic/face-api); no image
 * ever leaves the device — only the verified record is sent on sync.
 */
import {useCallback, useEffect, useRef, useState} from 'react';
import './App.css';

import {loadModels} from './face/loader';
import {computeDescriptor} from './face/pipeline';
import {LivenessChallenge, type LivenessSnapshot} from './face/liveness';
import {
  averageDescriptors,
  matchDescriptor,
  confidenceFromDistance,
} from './lib/matching';
import {RECOGNITION, FLAGS} from './lib/config';
import {computeComposite, type ScoreComponent} from './lib/scoring';
import {installNetMonitor, netMonitor} from './lib/netMonitor';
import {
  enqueueRecord,
  getDeviceId,
  getEnrollments,
  getQueue,
  saveEnrollment,
  type AttendanceRecord,
  type Enrollment,
  type InspectionMetrics,
} from './lib/storage';
import {syncPending} from './lib/syncClient';
import {
  speak,
  setSpeechEnabled,
  isSpeechSupported,
  primeSpeech,
} from './lib/speech';
import {setLang, getLang, pick, UI_TEXT, type Lang} from './lib/i18n';
import {useCamera} from './ui/useCamera';
import {useFaceLoop} from './ui/useFaceLoop';
import CameraStage from './ui/CameraStage';
import StatStrip from './ui/StatStrip';
import InspectionPanel from './ui/InspectionPanel';
import ScoreBreakdown from './ui/ScoreBreakdown';

type Mode = 'idle' | 'enrolling' | 'verifying';
type ModelState = 'loading' | 'ready' | 'error';
interface LatencyBudget {
  recognizeMs: number;
  matchMs: number;
  totalMs: number;
}
interface Verdict {
  ok: boolean;
  label: string;
  detail?: string;
  confidence?: number;
  latency?: LatencyBudget;
  score?: number;
  components?: ScoreComponent[];
}

const CAPTURE_THROTTLE_MS = 350;

installNetMonitor();

export default function App() {
  const [modelState, setModelState] = useState<ModelState>('loading');
  const [mode, setMode] = useState<Mode>('idle');
  const [userId, setUserId] = useState('');
  const [prompt, setPrompt] = useState('Initializing models');
  const [enrollCount, setEnrollCount] = useState(0);
  const [liveness, setLiveness] = useState<LivenessSnapshot | null>(null);
  const [result, setResult] = useState<Verdict | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const [enrollments, setEnrollments] = useState<Enrollment[]>(getEnrollments);
  const [queue, setQueue] = useState<AttendanceRecord[]>(getQueue);
  const [mockSync, setMockSync] = useState<boolean>(FLAGS.MOCK_SYNC);
  const [online, setOnline] = useState<boolean>(navigator.onLine);
  const [voice, setVoice] = useState<boolean>(isSpeechSupported());
  const [lang, setLangState] = useState<Lang>(getLang());
  const [authCalls, setAuthCalls] = useState(0);
  const [spoofBlocked, setSpoofBlocked] = useState(0);

  const {videoRef, status: camStatus, start} = useCamera();
  const enabled = modelState === 'ready' && camStatus === 'ready';
  const {frame, latest, metrics} = useFaceLoop(videoRef, enabled);

  const enrollBufRef = useRef<Float32Array[]>([]);
  const livenessRef = useRef<LivenessChallenge | null>(null);
  const busyRef = useRef(false);
  const lastCaptureRef = useRef(0);

  const addLog = useCallback((m: string) => {
    const ts = new Date().toLocaleTimeString('en-GB', {hour12: false});
    setLog(l => [`${ts}  ${m}`, ...l].slice(0, 40));
  }, []);

  const refreshData = useCallback(() => {
    setEnrollments(getEnrollments());
    setQueue(getQueue());
  }, []);

  useEffect(() => {
    setSpeechEnabled(voice);
  }, [voice]);

  // Toggling voice runs inside a click gesture, so it can unlock + confirm audio.
  const toggleVoice = useCallback(() => {
    const next = !voice;
    setVoice(next);
    setSpeechEnabled(next);
    if (next) {
      primeSpeech();
      speak(pick(UI_TEXT.voiceOn));
    }
  }, [voice]);

  const toggleLang = useCallback(() => {
    const next: Lang = lang === 'hi' ? 'en' : 'hi';
    setLang(next);
    setLangState(next);
    if (voice) {
      primeSpeech();
      speak(pick(UI_TEXT.voiceOn));
    }
  }, [lang, voice]);

  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    loadModels()
      .then(() => {
        if (cancelled) {
          return;
        }
        setModelState('ready');
        setPrompt('Position your face within the frame');
        addLog('Models loaded · sensor pipeline ready');
        void start();
      })
      .catch((e: unknown) => {
        setModelState('error');
        setPrompt('Failed to load models');
        addLog(`Model load error: ${e instanceof Error ? e.message : e}`);
      });
    return () => {
      cancelled = true;
    };
  }, [addLog, start]);

  const startEnroll = useCallback(() => {
    const id = userId.trim();
    if (!id) {
      addLog('Enrollment requires a user ID');
      return;
    }
    enrollBufRef.current = [];
    setEnrollCount(0);
    setResult(null);
    primeSpeech();
    netMonitor.beginAuth();
    setMode('enrolling');
    addLog(`Enrolling "${id}"`);
  }, [userId, addLog]);

  const startVerify = useCallback(() => {
    if (getEnrollments().length === 0) {
      addLog('No enrolled users — enroll a subject first');
      return;
    }
    setResult(null);
    primeSpeech();
    const challenge = new LivenessChallenge();
    challenge.start(performance.now());
    livenessRef.current = challenge;
    setLiveness(challenge.snapshot(performance.now()));
    netMonitor.beginAuth();
    setMode('verifying');
    addLog('Verification started · awaiting liveness challenge');
  }, [addLog]);

  const finishEnroll = useCallback(
    (id: string) => {
      const avg = averageDescriptors(enrollBufRef.current);
      saveEnrollment({
        userId: id,
        descriptor: Array.from(avg),
        createdAt: Date.now(),
        samples: enrollBufRef.current.length,
      });
      enrollBufRef.current = [];
      netMonitor.endAuth();
      setAuthCalls(netMonitor.authCalls);
      setMode('idle');
      setResult({ok: true, label: 'Enrolled', detail: id});
      speak(pick(UI_TEXT.enrolled));
      addLog(`Enrolled "${id}" · ${RECOGNITION.enrollSamples} samples averaged`);
      refreshData();
    },
    [addLog, refreshData],
  );

  const finishVerify = useCallback(
    async (video: HTMLVideoElement) => {
      // Robustness: sample a few frames and keep the BEST (min-distance) match.
      // This smooths out single-frame noise from glasses, motion and lighting,
      // which matters for real-world / Indian-face captures. Still well under 1s.
      const tRec0 = performance.now();
      const probes: Float32Array[] = [];
      for (let i = 0; i < 3; i++) {
        const d = await computeDescriptor(video);
        if (d) {
          probes.push(d);
        }
      }
      const recognizeMs = performance.now() - tRec0;
      if (probes.length === 0) {
        netMonitor.endAuth();
        setAuthCalls(netMonitor.authCalls);
        setResult({ok: false, label: 'No face', detail: 'capture again'});
        setMode('idle');
        return;
      }
      const tMatch0 = performance.now();
      let best: {id: string; distance: number} | null = null;
      for (const e of getEnrollments()) {
        const tmpl = Float32Array.from(e.descriptor);
        for (const probe of probes) {
          const m = matchDescriptor(probe, tmpl);
          if (!best || m.distance < best.distance) {
            best = {id: e.userId, distance: m.distance};
          }
        }
      }
      const matchMs = performance.now() - tMatch0;
      const latency: LatencyBudget = {
        recognizeMs: Math.round(recognizeMs),
        matchMs: Math.round(matchMs),
        totalMs: Math.round(recognizeMs + matchMs),
      };
      const matched = best && best.distance < RECOGNITION.matchDistance;
      if (matched && best) {
        const fs = latest.current;
        const att = fs?.attention;
        const prim = fs?.observation.primary;
        const round = (n: number, d = 3) => Number(n.toFixed(d));
        const inspection: InspectionMetrics = {
          ear: round(att?.ear ?? 0),
          perclos: round(att?.perclos ?? 0),
          blinkRate: round(att?.blinkRate ?? 0, 1),
          drowsy: att?.drowsy ?? false,
          lookingAway: att?.lookingAway ?? false,
          yawDeg: round(prim?.yawDeg ?? 0, 1),
          pitchDeg: round(prim?.pitchDeg ?? 0, 1),
          brightness: round(fs?.brightness ?? 0, 0),
        };
        const confidence = confidenceFromDistance(best.distance);
        const composite = computeComposite({
          recognitionConfidence: confidence,
          livenessPassed: true,
          drowsy: inspection.drowsy,
          lookingAway: inspection.lookingAway,
          ear: inspection.ear,
          yawDeg: inspection.yawDeg,
          pitchDeg: inspection.pitchDeg,
          brightness: inspection.brightness,
        });
        const record: AttendanceRecord = {
          userId: best.id,
          timestamp: Date.now(),
          livenessPassed: true,
          matchDistance: Number(best.distance.toFixed(4)),
          deviceId: getDeviceId(),
          synced: false,
          confidence: Number(confidence.toFixed(4)),
          score: composite.overall,
          latencyMs: latency.totalMs,
          inspection,
        };
        enqueueRecord(record);
        setResult({
          ok: true,
          label: composite.lowTrust ? 'Match (low trust)' : 'Match',
          detail: `${best.id} · ${(confidence * 100).toFixed(1)}% recognition`,
          confidence,
          latency,
          score: composite.overall,
          components: composite.components,
        });
        speak(pick(UI_TEXT.verified));
        addLog(
          `Match "${best.id}" · dist ${best.distance.toFixed(3)} · ${
            inspection.drowsy ? 'DROWSY' : 'alert'
          } · queued`,
        );
      } else {
        const conf = best ? confidenceFromDistance(best.distance) : 0;
        setResult({
          ok: false,
          label: 'No match',
          detail: best ? `${(conf * 100).toFixed(1)}% confidence` : undefined,
          confidence: conf,
          latency,
        });
        speak(pick(UI_TEXT.noMatch));
        addLog('No matching enrollment');
      }
      netMonitor.endAuth();
      setAuthCalls(netMonitor.authCalls);
      setMode('idle');
      refreshData();
    },
    [addLog, refreshData, latest],
  );

  const step = useCallback(async () => {
    const video = videoRef.current;
    const fs = latest.current;
    if (!video || !fs) {
      return;
    }
    const now = performance.now();

    if (mode === 'enrolling') {
      if (!fs.gate.ready) {
        setPrompt(fs.gate.guidance);
        return;
      }
      if (
        busyRef.current ||
        now - lastCaptureRef.current < CAPTURE_THROTTLE_MS
      ) {
        return;
      }
      busyRef.current = true;
      try {
        const desc = await computeDescriptor(video);
        if (desc) {
          enrollBufRef.current.push(desc);
          lastCaptureRef.current = now;
          const n = enrollBufRef.current.length;
          setEnrollCount(n);
          setPrompt(`Capturing sample ${n} of ${RECOGNITION.enrollSamples}`);
          if (n >= RECOGNITION.enrollSamples) {
            finishEnroll(userId.trim());
          }
        }
      } finally {
        busyRef.current = false;
      }
      return;
    }

    if (mode === 'verifying') {
      const challenge = livenessRef.current;
      if (!challenge) {
        return;
      }
      const snap = challenge.update(fs.observation.primary, now);
      setLiveness(snap);
      setPrompt(snap.prompt);
      if (snap.status === 'running') {
        speak(snap.prompt);
      }
      if (snap.status === 'passed' && !busyRef.current) {
        busyRef.current = true;
        try {
          await finishVerify(video);
        } finally {
          busyRef.current = false;
          livenessRef.current = null;
          setLiveness(null);
        }
      } else if (snap.status === 'failed') {
        // A failed live challenge = a rejected non-live presentation. Record it
        // so the dashboard can report presentation attacks blocked.
        const fsf = latest.current;
        enqueueRecord({
          userId: userId.trim() || 'unidentified',
          timestamp: Date.now(),
          livenessPassed: false,
          matchDistance: 1,
          deviceId: getDeviceId(),
          synced: false,
          inspection: fsf
            ? {
                ear: Number((fsf.attention.ear ?? 0).toFixed(3)),
                perclos: Number((fsf.attention.perclos ?? 0).toFixed(3)),
                blinkRate: Number((fsf.attention.blinkRate ?? 0).toFixed(1)),
                drowsy: fsf.attention.drowsy,
                lookingAway: fsf.attention.lookingAway,
                yawDeg: Number((fsf.observation.primary?.yawDeg ?? 0).toFixed(1)),
                pitchDeg: Number(
                  (fsf.observation.primary?.pitchDeg ?? 0).toFixed(1),
                ),
                brightness: Math.round(fsf.brightness),
              }
            : undefined,
        });
        setSpoofBlocked(n => n + 1);
        netMonitor.endAuth();
        setAuthCalls(netMonitor.authCalls);
        setResult({ok: false, label: 'Liveness failed', detail: 'retry'});
        speak(snap.prompt);
        addLog('Liveness challenge failed · presentation attack blocked');
        setMode('idle');
        livenessRef.current = null;
        setLiveness(null);
        refreshData();
      }
    }
  }, [
    videoRef,
    latest,
    mode,
    userId,
    finishEnroll,
    finishVerify,
    addLog,
    refreshData,
  ]);

  useEffect(() => {
    if (mode === 'idle') {
      return;
    }
    const id = window.setInterval(() => {
      void step();
    }, 150);
    return () => window.clearInterval(id);
  }, [mode, step]);

  const onSync = useCallback(async () => {
    const out = await syncPending({mock: mockSync});
    if (out.ok) {
      addLog(
        out.accepted === 0
          ? 'Sync: nothing pending'
          : `Sync: ${out.accepted} record(s) accepted${
              out.mocked ? ' (simulated)' : ''
            } · local queue purged`,
      );
    } else {
      addLog(`Sync failed: ${out.error}`);
    }
    refreshData();
  }, [mockSync, addLog, refreshData]);

  const busy = mode !== 'idle';
  const ready =
    mode === 'idle'
      ? !!frame?.gate.ready
      : mode === 'verifying'
        ? liveness?.status === 'passed'
        : true;
  const displayPrompt = mode === 'idle' && frame ? frame.gate.guidance : prompt;

  let status: string;
  if (modelState === 'loading') {
    status = 'init';
  } else if (modelState === 'error') {
    status = 'fault';
  } else if (camStatus !== 'ready') {
    status = 'camera';
  } else if (mode !== 'idle') {
    status = mode;
  } else {
    status = ready ? 'locked' : 'standby';
  }

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand__mark" aria-hidden>
            <span />
            <span />
            <span />
          </span>
          <div>
            <div className="brand__name">Datalake Face Auth</div>
            <div className="brand__sub">Offline biometric authentication</div>
          </div>
        </div>
        <div className="sysmeta">
          <button
            className="voicebtn voicebtn--on"
            onClick={toggleLang}
            data-testid="lang"
            title="Switch language">
            {lang === 'hi' ? 'हिन्दी' : 'English'}
          </button>
          {isSpeechSupported() && (
            <button
              className={`voicebtn ${voice ? 'voicebtn--on' : ''}`}
              onClick={toggleVoice}
              data-testid="voice"
              title="Toggle voice prompts">
              Voice {voice ? 'on' : 'off'}
            </button>
          )}
          <span className={`netchip ${online ? 'netchip--on' : 'netchip--off'}`}>
            <span className="netchip__dot" />
            Network {online ? 'online' : 'offline'}
          </span>
          <span className="sysmeta__id">NHAI · Datalake 3.0</span>
        </div>
      </header>

      <div className="mission">
        <span className="mission__eyebrow">Mission</span>
        <p className="mission__text">
          Secure offline facial recognition and liveness detection to
          authenticate field personnel on standard mid-range mobile devices in
          zero-network zones — lightweight, on-device, and privacy-preserving.
        </p>
      </div>

      <StatStrip
        detectMs={metrics.detectMs}
        fps={metrics.fps}
        authCalls={authCalls}
      />

      <main className="layout">
        <section className="left">
          <CameraStage
            videoRef={videoRef}
            ready={ready}
            prompt={displayPrompt}
            progress={mode === 'verifying' ? liveness?.progress : undefined}
            status={status}
            active={enabled}
          />

          {result && (
            <div
              className={`verdict ${result.ok ? 'verdict--ok' : 'verdict--bad'}`}
              data-testid="result">
              <div className="verdict__row">
                <span className="verdict__tag">{result.label}</span>
                {result.detail && (
                  <span className="verdict__detail">{result.detail}</span>
                )}
              </div>
              {result.latency && (
                <div className="latency" data-testid="latency">
                  <span className="latency__total">
                    {result.latency.totalMs} ms
                  </span>
                  <span className="latency__break">
                    recognize {result.latency.recognizeMs} ms · match{' '}
                    {result.latency.matchMs} ms
                  </span>
                  <span className="latency__badge">&lt; 1 s on-device</span>
                </div>
              )}
              {typeof result.score === 'number' && result.components && (
                <ScoreBreakdown
                  overall={result.score}
                  components={result.components}
                />
              )}
            </div>
          )}

          <div className="controls">
            <input
              className="input"
              placeholder="Subject ID — e.g. inspector_01"
              value={userId}
              onChange={e => setUserId(e.target.value)}
              disabled={busy}
              data-testid="userid"
            />
            <button
              className="btn"
              onClick={startEnroll}
              disabled={busy || modelState !== 'ready'}
              data-testid="enroll">
              Enroll
              {mode === 'enrolling'
                ? ` · ${enrollCount}/${RECOGNITION.enrollSamples}`
                : ''}
            </button>
            <button
              className="btn btn--primary"
              onClick={startVerify}
              disabled={busy || modelState !== 'ready'}
              data-testid="verify">
              Verify
            </button>
          </div>

          <div className="session">
            <span className="session__label">
              Presentation attacks blocked (session)
            </span>
            <span
              className={`session__num ${spoofBlocked > 0 ? 'session__num--alert' : ''}`}
              data-testid="spoof-count">
              {spoofBlocked}
            </span>
          </div>
        </section>

        <aside className="right">
          <InspectionPanel frame={frame} />

          <Panel title="Pending queue" count={queue.length}>
            <div className="syncrow">
              <label className="check">
                <input
                  type="checkbox"
                  checked={mockSync}
                  onChange={e => setMockSync(e.target.checked)}
                />
                Simulate sync
              </label>
              <button
                className="btn btn--sm btn--primary"
                onClick={onSync}
                data-testid="sync">
                Sync &amp; purge
              </button>
            </div>
            {queue.length === 0 ? (
              <p className="muted">Queue empty — all records synced</p>
            ) : (
              <ul className="list">
                {queue.map((r, i) => (
                  <li key={i}>
                    <span className="list__id">{r.userId}</span>
                    <span className="list__meta">
                      dist {r.matchDistance} ·{' '}
                      {new Date(r.timestamp).toLocaleTimeString('en-GB', {
                        hour12: false,
                      })}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Panel>

          <Panel title="Enrolled subjects" count={enrollments.length}>
            {enrollments.length === 0 ? (
              <p className="muted">No subjects enrolled</p>
            ) : (
              <ul className="list">
                {enrollments.map(e => (
                  <li key={e.userId}>
                    <span className="list__id">{e.userId}</span>
                    <span className="list__meta">{e.samples} samples</span>
                  </li>
                ))}
              </ul>
            )}
          </Panel>

          <Panel title="Activity log">
            <ul className="loglist" data-testid="log">
              {log.length === 0 ? (
                <li className="muted">awaiting events</li>
              ) : (
                log.map((l, i) => <li key={i}>{l}</li>)
              )}
            </ul>
          </Panel>
        </aside>
      </main>

      <footer className="footer">
        <span>On-device inference · no image leaves the browser</span>
        <span>Open-source · @vladmandic/face-api · MIT</span>
      </footer>
    </div>
  );
}

function Panel({
  title,
  count,
  children,
}: {
  title: string;
  count?: number;
  children: React.ReactNode;
}) {
  return (
    <div className="panel">
      <div className="panel__title">
        <span>{title}</span>
        {typeof count === 'number' && (
          <span className="panel__count">{count}</span>
        )}
      </div>
      <div className="panel__body">{children}</div>
    </div>
  );
}
