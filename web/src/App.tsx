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
import {averageDescriptors, matchDescriptor} from './lib/matching';
import {RECOGNITION, FLAGS} from './lib/config';
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
import {useCamera} from './ui/useCamera';
import {useFaceLoop} from './ui/useFaceLoop';
import CameraStage from './ui/CameraStage';
import StatStrip from './ui/StatStrip';
import InspectionPanel from './ui/InspectionPanel';

type Mode = 'idle' | 'enrolling' | 'verifying';
type ModelState = 'loading' | 'ready' | 'error';
interface Verdict {
  ok: boolean;
  label: string;
  detail?: string;
}

const CAPTURE_THROTTLE_MS = 350;

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
    setMode('enrolling');
    addLog(`Enrolling "${id}"`);
  }, [userId, addLog]);

  const startVerify = useCallback(() => {
    if (getEnrollments().length === 0) {
      addLog('No enrolled users — enroll a subject first');
      return;
    }
    setResult(null);
    const challenge = new LivenessChallenge();
    challenge.start(performance.now());
    livenessRef.current = challenge;
    setLiveness(challenge.snapshot(performance.now()));
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
      setMode('idle');
      setResult({ok: true, label: 'Enrolled', detail: id});
      addLog(`Enrolled "${id}" · ${RECOGNITION.enrollSamples} samples averaged`);
      refreshData();
    },
    [addLog, refreshData],
  );

  const finishVerify = useCallback(
    async (video: HTMLVideoElement) => {
      const probe = await computeDescriptor(video);
      if (!probe) {
        setResult({ok: false, label: 'No face', detail: 'capture again'});
        setMode('idle');
        return;
      }
      let best: {id: string; distance: number} | null = null;
      for (const e of getEnrollments()) {
        const m = matchDescriptor(probe, Float32Array.from(e.descriptor));
        if (!best || m.distance < best.distance) {
          best = {id: e.userId, distance: m.distance};
        }
      }
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
        const record: AttendanceRecord = {
          userId: best.id,
          timestamp: Date.now(),
          livenessPassed: true,
          matchDistance: Number(best.distance.toFixed(4)),
          deviceId: getDeviceId(),
          synced: false,
          inspection,
        };
        enqueueRecord(record);
        setResult({
          ok: true,
          label: 'Match',
          detail: `${best.id} · distance ${best.distance.toFixed(3)}`,
        });
        addLog(
          `Match "${best.id}" · dist ${best.distance.toFixed(3)} · ${
            inspection.drowsy ? 'DROWSY' : 'alert'
          } · queued`,
        );
      } else {
        setResult({
          ok: false,
          label: 'No match',
          detail: best ? `closest ${best.distance.toFixed(3)}` : undefined,
        });
        addLog('No matching enrollment');
      }
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
        setResult({ok: false, label: 'Liveness failed', detail: 'retry'});
        addLog('Liveness challenge failed · spoof rejected');
        setMode('idle');
        livenessRef.current = null;
        setLiveness(null);
      }
    }
  }, [videoRef, latest, mode, userId, finishEnroll, finishVerify, addLog]);

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

      <StatStrip detectMs={metrics.detectMs} fps={metrics.fps} />

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
              <span className="verdict__tag">{result.label}</span>
              {result.detail && (
                <span className="verdict__detail">{result.detail}</span>
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
