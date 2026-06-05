/**
 * DatalakeFaceAuth — web demo (Vercel frontend).
 *
 * In-browser face authentication: enroll → liveness challenge → recognition,
 * then sync attendance to the Render backend and purge the local queue. All
 * face inference runs client-side (@vladmandic/face-api); nothing is uploaded
 * except the verified attendance record on sync.
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
} from './lib/storage';
import {syncPending} from './lib/syncClient';
import {useCamera} from './ui/useCamera';
import {useFaceLoop} from './ui/useFaceLoop';
import CameraStage from './ui/CameraStage';

type Mode = 'idle' | 'enrolling' | 'verifying';
type ModelState = 'loading' | 'ready' | 'error';

const CAPTURE_THROTTLE_MS = 350;

export default function App() {
  const [modelState, setModelState] = useState<ModelState>('loading');
  const [mode, setMode] = useState<Mode>('idle');
  const [userId, setUserId] = useState('');
  const [prompt, setPrompt] = useState('Loading models…');
  const [enrollCount, setEnrollCount] = useState(0);
  const [liveness, setLiveness] = useState<LivenessSnapshot | null>(null);
  const [result, setResult] = useState<{ok: boolean; text: string} | null>(
    null,
  );
  const [log, setLog] = useState<string[]>([]);
  const [enrollments, setEnrollments] =
    useState<Enrollment[]>(getEnrollments);
  const [queue, setQueue] = useState<AttendanceRecord[]>(getQueue);
  const [mockSync, setMockSync] = useState<boolean>(FLAGS.MOCK_SYNC);

  const {videoRef, status: camStatus, start} = useCamera();
  const enabled = modelState === 'ready' && camStatus === 'ready';
  const {frame, latest} = useFaceLoop(videoRef, enabled);

  // Flow refs hold capture-only state that should not trigger re-renders.
  const enrollBufRef = useRef<Float32Array[]>([]);
  const livenessRef = useRef<LivenessChallenge | null>(null);
  const busyRef = useRef(false);
  const lastCaptureRef = useRef(0);

  const addLog = useCallback((m: string) => {
    setLog(l => [`${new Date().toLocaleTimeString()}  ${m}`, ...l].slice(0, 30));
  }, []);

  const refreshData = useCallback(() => {
    setEnrollments(getEnrollments());
    setQueue(getQueue());
  }, []);

  // Load models + start camera once.
  useEffect(() => {
    let cancelled = false;
    loadModels()
      .then(() => {
        if (cancelled) {
          return;
        }
        setModelState('ready');
        setPrompt('Position your face');
        addLog('Models loaded');
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
      addLog('Enter a user ID to enroll');
      return;
    }
    enrollBufRef.current = [];
    setEnrollCount(0);
    setResult(null);
    setMode('enrolling');
    addLog(`Enrolling "${id}"…`);
  }, [userId, addLog]);

  const startVerify = useCallback(() => {
    if (getEnrollments().length === 0) {
      addLog('No enrolled users yet — enroll first');
      return;
    }
    setResult(null);
    const challenge = new LivenessChallenge();
    challenge.start(performance.now());
    livenessRef.current = challenge;
    setLiveness(challenge.snapshot(performance.now()));
    setMode('verifying');
    addLog('Verifying — complete the liveness challenge');
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
      setResult({ok: true, text: `Enrolled "${id}"`});
      addLog(`Enrolled "${id}" (${RECOGNITION.enrollSamples} samples)`);
      refreshData();
    },
    [addLog, refreshData],
  );

  const finishVerify = useCallback(
    async (video: HTMLVideoElement) => {
      const probe = await computeDescriptor(video);
      if (!probe) {
        setResult({ok: false, text: 'No face at capture — try again'});
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
        const record: AttendanceRecord = {
          userId: best.id,
          timestamp: Date.now(),
          livenessPassed: true,
          matchDistance: Number(best.distance.toFixed(4)),
          deviceId: getDeviceId(),
          synced: false,
        };
        enqueueRecord(record);
        setResult({
          ok: true,
          text: `✓ ${best.id} verified (distance ${best.distance.toFixed(3)})`,
        });
        addLog(`Verified "${best.id}" — queued attendance`);
      } else {
        setResult({
          ok: false,
          text: `✗ No match${best ? ` (closest ${best.distance.toFixed(3)})` : ''}`,
        });
        addLog('No matching enrollment');
      }
      setMode('idle');
      refreshData();
    },
    [addLog, refreshData],
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
          setPrompt(`Capturing ${n}/${RECOGNITION.enrollSamples}`);
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
        setResult({ok: false, text: 'Liveness failed — try again'});
        addLog('Liveness failed');
        setMode('idle');
        livenessRef.current = null;
        setLiveness(null);
      }
    }
  }, [videoRef, latest, mode, userId, finishEnroll, finishVerify, addLog]);

  // Drive enroll/verify off a steady tick reading the freshest frame.
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
          ? 'Nothing to sync'
          : `Synced ${out.accepted} record(s)${
              out.mocked ? ' (mock)' : ''
            } → purged`,
      );
    } else {
      addLog(`Sync failed: ${out.error}`);
    }
    refreshData();
  }, [mockSync, addLog, refreshData]);

  const busy = mode !== 'idle';
  const ringReady =
    mode === 'idle'
      ? !!frame?.gate.ready
      : mode === 'verifying'
      ? liveness?.status === 'passed'
      : true;
  const displayPrompt = mode === 'idle' && frame ? frame.gate.guidance : prompt;

  let badge = 'ready';
  if (modelState === 'loading') {
    badge = 'loading models…';
  } else if (modelState === 'error') {
    badge = 'model error';
  } else if (camStatus !== 'ready') {
    badge = 'starting camera…';
  } else if (mode !== 'idle') {
    badge = mode;
  }

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="dot" /> DatalakeFaceAuth
          <span className="tag">offline-first · on-device</span>
        </div>
        <a
          className="adminlink"
          href="https://github.com/perrysolid/NHAI"
          target="_blank"
          rel="noreferrer">
          NHAI Datalake 3.0
        </a>
      </header>

      <main className="layout">
        <section className="left">
          <CameraStage
            videoRef={videoRef}
            ready={ringReady}
            prompt={displayPrompt}
            progress={mode === 'verifying' ? liveness?.progress : undefined}
            badge={badge}
          />

          {result && (
            <div
              className={`result ${result.ok ? 'ok' : 'bad'}`}
              data-testid="result">
              {result.text}
            </div>
          )}

          <div className="controls">
            <input
              className="input"
              placeholder="user id (e.g. inspector_01)"
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
              Enroll{' '}
              {mode === 'enrolling'
                ? `(${enrollCount}/${RECOGNITION.enrollSamples})`
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
          <Panel title={`Pending queue (${queue.length})`}>
            <div className="syncrow">
              <label className="check">
                <input
                  type="checkbox"
                  checked={mockSync}
                  onChange={e => setMockSync(e.target.checked)}
                />
                mock sync
              </label>
              <button
                className="btn btn--sm"
                onClick={onSync}
                data-testid="sync">
                Sync &amp; purge
              </button>
            </div>
            {queue.length === 0 ? (
              <p className="muted">empty — all synced</p>
            ) : (
              <ul className="list">
                {queue.map((r, i) => (
                  <li key={i}>
                    <b>{r.userId}</b> · d{r.matchDistance} ·{' '}
                    {new Date(r.timestamp).toLocaleTimeString()}
                  </li>
                ))}
              </ul>
            )}
          </Panel>

          <Panel title={`Enrolled (${enrollments.length})`}>
            {enrollments.length === 0 ? (
              <p className="muted">no users enrolled</p>
            ) : (
              <ul className="list">
                {enrollments.map(e => (
                  <li key={e.userId}>
                    <b>{e.userId}</b> · {e.samples} samples
                  </li>
                ))}
              </ul>
            )}
          </Panel>

          <Panel title="Activity">
            <ul className="loglist" data-testid="log">
              {log.map((l, i) => (
                <li key={i}>{l}</li>
              ))}
            </ul>
          </Panel>
        </aside>
      </main>
    </div>
  );
}

function Panel({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="panel">
      <div className="panel__title">{title}</div>
      <div className="panel__body">{children}</div>
    </div>
  );
}
