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
import {RECOGNITION, FLAGS, SYNC} from './lib/config';
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
type Page = 'live' | 'operations' | 'deployment' | 'aws';
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

const ROUTES: Record<Page, string> = {
  live: '/',
  operations: '/operations',
  deployment: '/deployment',
  aws: '/aws',
};

function pageFromPath(pathname: string): Page {
  if (pathname.startsWith('/aws')) {
    return 'aws';
  }
  if (pathname.startsWith('/operations')) {
    return 'operations';
  }
  if (pathname.startsWith('/deployment')) {
    return 'deployment';
  }
  return 'live';
}

installNetMonitor();

export default function App() {
  const [page, setPage] = useState<Page>(() => pageFromPath(window.location.pathname));
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

  const {videoRef, status: camStatus, start, stop} = useCamera();
  const enabled = page === 'live' && modelState === 'ready' && camStatus === 'ready';
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

  const navigate = useCallback((next: Page) => {
    const path = ROUTES[next];
    if (next !== 'live') {
      setMode('idle');
    }
    setPage(next);
    window.history.pushState({page: next}, '', path);
  }, []);

  useEffect(() => {
    const onPop = () => {
      const next = pageFromPath(window.location.pathname);
      if (next !== 'live') {
        setMode('idle');
      }
      setPage(next);
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
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
      })
      .catch((e: unknown) => {
        setModelState('error');
        setPrompt('Failed to load models');
        addLog(`Model load error: ${e instanceof Error ? e.message : e}`);
      });
    return () => {
      cancelled = true;
    };
  }, [addLog]);

  useEffect(() => {
    if (page === 'live' && modelState === 'ready' && camStatus === 'idle') {
      void start();
    }
    if (page !== 'live' && camStatus === 'ready') {
      stop();
    }
  }, [camStatus, modelState, page, start, stop]);

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
      // Keep the browser-demo auth compute path below the 1s target. Enrollment
      // still averages multiple samples, so one live descriptor is enough here.
      const tRec0 = performance.now();
      const probes: Float32Array[] = [];
      for (let i = 0; i < RECOGNITION.verifyProbes; i++) {
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
          <nav className="pagenav" aria-label="Demo pages">
            <button
              className={`pagenav__item ${page === 'live' ? 'pagenav__item--active' : ''}`}
              onClick={() => navigate('live')}
              data-testid="nav-live">
              Live auth
            </button>
            <button
              className={`pagenav__item ${page === 'operations' ? 'pagenav__item--active' : ''}`}
              onClick={() => navigate('operations')}
              data-testid="nav-operations">
              Operations
            </button>
            <button
              className={`pagenav__item ${page === 'deployment' ? 'pagenav__item--active' : ''}`}
              onClick={() => navigate('deployment')}
              data-testid="nav-deployment">
              Deployment
            </button>
            <button
              className={`pagenav__item ${page === 'aws' ? 'pagenav__item--active' : ''}`}
              onClick={() => navigate('aws')}
              data-testid="nav-aws">
              AWS
            </button>
          </nav>
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

      {page === 'live' && (
        <LiveAuthPage
          videoRef={videoRef}
          ready={ready}
          prompt={displayPrompt}
          progress={mode === 'verifying' ? liveness?.progress : undefined}
          status={status}
          active={enabled}
          result={result}
          userId={userId}
          setUserId={setUserId}
          busy={busy}
          modelState={modelState}
          mode={mode}
          enrollCount={enrollCount}
          startEnroll={startEnroll}
          startVerify={startVerify}
          spoofBlocked={spoofBlocked}
          frame={frame}
          queue={queue}
          enrollments={enrollments}
          mockSync={mockSync}
          setMockSync={setMockSync}
          onSync={onSync}
          log={log}
        />
      )}

      {page === 'operations' && (
        <OperationsPage
          queue={queue}
          enrollments={enrollments}
          spoofBlocked={spoofBlocked}
          authCalls={authCalls}
          online={online}
          mockSync={mockSync}
          setMockSync={setMockSync}
          onSync={onSync}
        />
      )}

      {page === 'deployment' && (
        <DeploymentPage
          online={online}
          modelState={modelState}
          mockSync={mockSync}
        />
      )}

      {page === 'aws' && <AwsPage />}

      <footer className="footer">
        <span>On-device inference · no image leaves the browser</span>
        <span>Open-source · @vladmandic/face-api · MIT</span>
      </footer>
    </div>
  );
}

function LiveAuthPage({
  videoRef,
  ready,
  prompt,
  progress,
  status,
  active,
  result,
  userId,
  setUserId,
  busy,
  modelState,
  mode,
  enrollCount,
  startEnroll,
  startVerify,
  spoofBlocked,
  frame,
  queue,
  enrollments,
  mockSync,
  setMockSync,
  onSync,
  log,
}: {
  videoRef: React.RefObject<HTMLVideoElement | null>;
  ready: boolean;
  prompt: string;
  progress?: number;
  status: string;
  active: boolean;
  result: Verdict | null;
  userId: string;
  setUserId: (value: string) => void;
  busy: boolean;
  modelState: ModelState;
  mode: Mode;
  enrollCount: number;
  startEnroll: () => void;
  startVerify: () => void;
  spoofBlocked: number;
  frame: React.ComponentProps<typeof InspectionPanel>['frame'];
  queue: AttendanceRecord[];
  enrollments: Enrollment[];
  mockSync: boolean;
  setMockSync: (value: boolean) => void;
  onSync: () => void;
  log: string[];
}) {
  return (
    <main className="layout">
      <section className="left">
        <CameraStage
          videoRef={videoRef}
          ready={ready}
          prompt={prompt}
          progress={progress}
          status={status}
          active={active}
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
        <QueuePanel
          queue={queue}
          mockSync={mockSync}
          setMockSync={setMockSync}
          onSync={onSync}
        />
        <EnrollmentPanel enrollments={enrollments} />
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
  );
}

function OperationsPage({
  queue,
  enrollments,
  spoofBlocked,
  authCalls,
  online,
  mockSync,
  setMockSync,
  onSync,
}: {
  queue: AttendanceRecord[];
  enrollments: Enrollment[];
  spoofBlocked: number;
  authCalls: number;
  online: boolean;
  mockSync: boolean;
  setMockSync: (value: boolean) => void;
  onSync: () => void;
}) {
  const successful = queue.filter(r => r.livenessPassed).length;
  const rejected = queue.filter(r => !r.livenessPassed).length + spoofBlocked;
  return (
    <main className="page page--ops">
      <section className="demohero">
        <div>
          <p className="demohero__eyebrow">Vercel demo page</p>
          <h1>Field authentication command view</h1>
          <p>
            A reviewer can inspect the offline queue, enrolled subjects, liveness
            outcomes, and sync posture without entering the camera flow.
          </p>
        </div>
        <div className="signalmap" aria-hidden>
          <span className="signalmap__road" />
          <span className="signalmap__node signalmap__node--a" />
          <span className="signalmap__node signalmap__node--b" />
          <span className="signalmap__node signalmap__node--c" />
          <span className="signalmap__pulse" />
        </div>
      </section>

      <section className="demo-metrics" aria-label="Operations metrics">
        <DemoMetric label="Pending records" value={queue.length.toString()} tone={queue.length > 0 ? 'warn' : 'signal'} />
        <DemoMetric label="Enrolled subjects" value={enrollments.length.toString()} />
        <DemoMetric label="Accepted captures" value={successful.toString()} tone="signal" />
        <DemoMetric label="Spoofs rejected" value={rejected.toString()} tone={rejected > 0 ? 'bad' : 'default'} />
        <DemoMetric label="Auth network calls" value={authCalls.toString()} tone={authCalls === 0 ? 'signal' : 'warn'} />
        <DemoMetric label="Network" value={online ? 'Online' : 'Offline'} tone={online ? 'signal' : 'warn'} />
      </section>

      <section className="pagegrid">
        <Panel title="Demo runbook">
          <ol className="runbook">
            <li>Open Live auth and enroll a reviewer as <span>inspector_01</span>.</li>
            <li>Verify once to create a signed attendance record in local queue.</li>
            <li>Return here to show the pending queue and offline-first behavior.</li>
            <li>Sync with simulation on, or disable simulation for the Render backend.</li>
          </ol>
        </Panel>
        <QueuePanel
          queue={queue}
          mockSync={mockSync}
          setMockSync={setMockSync}
          onSync={onSync}
        />
        <EnrollmentPanel enrollments={enrollments} />
        <Panel title="Reviewer talking points">
          <ul className="talking">
            <li>Face templates and inference stay in the browser.</li>
            <li>Liveness challenge blocks static photo presentation attacks.</li>
            <li>Records queue locally and sync only signed attendance metadata.</li>
            <li>Vercel serves the static camera app; Render accepts sync payloads.</li>
          </ul>
        </Panel>
      </section>
    </main>
  );
}

function DeploymentPage({
  online,
  modelState,
  mockSync,
}: {
  online: boolean;
  modelState: ModelState;
  mockSync: boolean;
}) {
  const syncConfigured = SYNC.url !== 'http://localhost:4000';
  const keyConfigured = SYNC.apiKey !== 'CHANGE_ME';
  return (
    <main className="page">
      <section className="demohero demohero--deploy">
        <div>
          <p className="demohero__eyebrow">Deployment page</p>
          <h1>Vercel frontend with Render sync target</h1>
          <p>
            This page makes the demo topology visible on a public deployment,
            including build settings, environment checks, and the sync contract.
          </p>
        </div>
        <div className="deployflow" aria-label="Deployment flow">
          <div className="deployflow__box">Browser</div>
          <div className="deployflow__line" />
          <div className="deployflow__box deployflow__box--signal">Vercel</div>
          <div className="deployflow__line" />
          <div className="deployflow__box">Render API</div>
        </div>
      </section>

      <section className="pagegrid pagegrid--three">
        <Panel title="Vercel project">
          <dl className="kv">
            <div><dt>Root directory</dt><dd>web</dd></div>
            <div><dt>Framework</dt><dd>Vite</dd></div>
            <div><dt>Build command</dt><dd>npm run build</dd></div>
            <div><dt>Output</dt><dd>dist</dd></div>
          </dl>
        </Panel>
        <Panel title="Runtime checks">
          <StatusRow label="Face models" value={modelState} ok={modelState === 'ready'} />
          <StatusRow label="Network" value={online ? 'online' : 'offline'} ok={online} />
          <StatusRow label="Sync mode" value={mockSync ? 'simulated' : 'backend'} ok={!mockSync} warn={mockSync} />
          <StatusRow label="Sync URL" value={syncConfigured ? 'configured' : 'local default'} ok={syncConfigured} warn={!syncConfigured} />
          <StatusRow label="API key" value={keyConfigured ? 'configured' : 'placeholder'} ok={keyConfigured} warn={!keyConfigured} />
        </Panel>
        <Panel title="Environment">
          <dl className="kv">
            <div><dt>VITE_SYNC_URL</dt><dd>{syncConfigured ? SYNC.url : 'not set'}</dd></div>
            <div><dt>VITE_SYNC_KEY</dt><dd>{keyConfigured ? 'set at build' : 'CHANGE_ME'}</dd></div>
            <div><dt>Vercel routes</dt><dd>/, /operations, /deployment, /aws</dd></div>
          </dl>
        </Panel>
      </section>

      <section className="pagegrid">
        <Panel title="Sync payload">
          <pre className="codeblock">{`POST ${SYNC.url}/api/sync
x-api-key: <VITE_SYNC_KEY>

{
  "records": [{
    "userId": "inspector_01",
    "timestamp": 1780655230110,
    "livenessPassed": true,
    "matchDistance": 0.31,
    "deviceId": "web-demo"
  }]
}`}</pre>
        </Panel>
        <Panel title="Deployment checklist">
          <ul className="talking">
            <li>Set Vercel root directory to <span>web</span>.</li>
            <li>Deploy Render service from <span>backend</span>.</li>
            <li>Set Render <span>CORS_ORIGIN</span> to the Vercel URL.</li>
            <li>Set matching <span>VITE_SYNC_KEY</span> and backend <span>API_KEY</span>.</li>
            <li>Turn off simulated sync during the final connected demo.</li>
          </ul>
        </Panel>
      </section>
    </main>
  );
}

function AwsPage() {
  return (
    <main className="page">
      <section className="demohero demohero--aws">
        <div>
          <p className="demohero__eyebrow">AWS route</p>
          <h1>AWS sync backend and key placement</h1>
          <p>
            The problem statement asks for cloud sync after the offline
            authentication decision. This route shows exactly where the AWS
            endpoint, API key, admin passcode, CORS origin, and optional RDS
            database are configured.
          </p>
        </div>
        <div className="awsflow" aria-label="AWS deployment options">
          <div className="awsflow__tier">Vercel web</div>
          <div className="awsflow__arrow" />
          <div className="awsflow__tier awsflow__tier--signal">AWS App Runner</div>
          <div className="awsflow__arrow" />
          <div className="awsflow__tier">RDS Postgres</div>
        </div>
      </section>

      <section className="pagegrid pagegrid--three">
        <Panel title="AWS backend">
          <dl className="kv">
            <div><dt>Service</dt><dd>backend/ on App Runner</dd></div>
            <div><dt>Config file</dt><dd>backend/apprunner.yaml</dd></div>
            <div><dt>Health route</dt><dd>GET /health</dd></div>
            <div><dt>Dashboard</dt><dd>GET /admin?key=ADMIN_PASSCODE</dd></div>
          </dl>
        </Panel>
        <Panel title="AWS env vars">
          <dl className="kv">
            <div><dt>API_KEY</dt><dd>Shared secret for x-api-key</dd></div>
            <div><dt>ADMIN_PASSCODE</dt><dd>Protects the admin dashboard</dd></div>
            <div><dt>CORS_ORIGIN</dt><dd>https://your-vercel-app.vercel.app</dd></div>
            <div><dt>DATABASE_URL</dt><dd>Optional RDS Postgres URL</dd></div>
          </dl>
        </Panel>
        <Panel title="Client keys">
          <dl className="kv">
            <div><dt>Vercel</dt><dd>VITE_SYNC_URL + VITE_SYNC_KEY</dd></div>
            <div><dt>Native app</dt><dd>app/src/config.ts SYNC.url + apiKey</dd></div>
            <div><dt>Current target</dt><dd>{SYNC.url}</dd></div>
            <div><dt>Current key</dt><dd>{SYNC.apiKey === 'CHANGE_ME' ? 'placeholder' : 'configured'}</dd></div>
          </dl>
        </Panel>
      </section>

      <section className="pagegrid">
        <Panel title="Required routes">
          <ul className="routes">
            <li><span>POST /api/sync</span><b>Receives verified attendance records with x-api-key</b></li>
            <li><span>GET /api/records</span><b>Returns recent synced records with x-api-key</b></li>
            <li><span>GET /health</span><b>AWS health check and uptime probe</b></li>
            <li><span>GET /admin?key=...</span><b>Operations dashboard protected by ADMIN_PASSCODE</b></li>
          </ul>
        </Panel>
        <Panel title="AWS setup order">
          <ol className="runbook">
            <li>Create AWS App Runner service from <span>backend/</span>.</li>
            <li>Set <span>API_KEY</span>, <span>ADMIN_PASSCODE</span>, and <span>CORS_ORIGIN</span>.</li>
            <li>Add <span>DATABASE_URL</span> only if persistent RDS storage is needed.</li>
            <li>Put the App Runner URL in Vercel <span>VITE_SYNC_URL</span>.</li>
            <li>Put the same backend <span>API_KEY</span> in Vercel <span>VITE_SYNC_KEY</span>.</li>
            <li>For native builds, update <span>app/src/config.ts</span> with the same URL and key.</li>
          </ol>
        </Panel>
      </section>
    </main>
  );
}

function QueuePanel({
  queue,
  mockSync,
  setMockSync,
  onSync,
}: {
  queue: AttendanceRecord[];
  mockSync: boolean;
  setMockSync: (value: boolean) => void;
  onSync: () => void;
}) {
  return (
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
                {r.livenessPassed ? 'live' : 'blocked'} · dist {r.matchDistance} ·{' '}
                {new Date(r.timestamp).toLocaleTimeString('en-GB', {
                  hour12: false,
                })}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

function EnrollmentPanel({enrollments}: {enrollments: Enrollment[]}) {
  return (
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
  );
}

function DemoMetric({
  label,
  value,
  tone = 'default',
}: {
  label: string;
  value: string;
  tone?: 'default' | 'signal' | 'warn' | 'bad';
}) {
  return (
    <div className={`demo-metric demo-metric--${tone}`}>
      <span className="demo-metric__label">{label}</span>
      <span className="demo-metric__value">{value}</span>
    </div>
  );
}

function StatusRow({
  label,
  value,
  ok,
  warn,
}: {
  label: string;
  value: string;
  ok: boolean;
  warn?: boolean;
}) {
  const tone = ok ? 'signal' : warn ? 'warn' : 'bad';
  return (
    <div className="statusrow">
      <span>{label}</span>
      <span className={`statetag statetag--${tone}`}>{value}</span>
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
