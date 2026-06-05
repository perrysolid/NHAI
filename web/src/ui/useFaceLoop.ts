/**
 * useFaceLoop — runs the detection pipeline on the live <video> at a throttled
 * rate, exposing the latest observation + quality gate + brightness + a smoothed
 * inference-latency metric. The latest value is also kept in a ref so flow logic
 * (enroll/verify) can read it without waiting on React state.
 */
import {useEffect, useRef, useState} from 'react';
import {observe, type Observation} from '../face/pipeline';
import {sampleBrightness} from '../face/brightness';
import {evaluate, type GateResult} from '../face/gates';
import {AttentionMonitor, type AttentionSnapshot} from '../face/attention';

export interface FrameState {
  observation: Observation;
  gate: GateResult;
  brightness: number;
  /** wall-clock ms for the detection+landmark+expression pass on this frame. */
  detectMs: number;
  /** drowsiness / inattention metrics over a rolling window. */
  attention: AttentionSnapshot;
}

export interface LoopMetrics {
  /** exponentially-smoothed per-frame inference latency, ms. */
  detectMs: number;
  /** measured frames per second of the pipeline loop. */
  fps: number;
}

export function useFaceLoop(
  videoRef: React.RefObject<HTMLVideoElement | null>,
  enabled: boolean,
  intervalMs = 120,
) {
  const [frame, setFrame] = useState<FrameState | null>(null);
  const [metrics, setMetrics] = useState<LoopMetrics>({detectMs: 0, fps: 0});
  const latest = useRef<FrameState | null>(null);

  useEffect(() => {
    if (!enabled) {
      return;
    }
    let stopped = false;
    let lastTs = 0;
    let rafId = 0;
    let emaMs = 0;
    let emaFps = 0;
    let prevFrameTs = 0;
    const scratch = document.createElement('canvas');
    const attention = new AttentionMonitor();
    const alpha = 0.2; // smoothing factor

    const tick = async (ts: number) => {
      if (stopped) {
        return;
      }
      const video = videoRef.current;
      if (
        ts - lastTs >= intervalMs &&
        video &&
        video.readyState >= 2 &&
        video.videoWidth > 0
      ) {
        lastTs = ts;
        try {
          const t0 = performance.now();
          const observation = await observe(video);
          const detectMs = performance.now() - t0;
          const brightness = sampleBrightness(video, scratch);
          const gate = evaluate(observation, video.videoWidth, brightness);
          const p = observation.primary;
          const att = attention.update(
            {
              ear: p?.ear ?? 0,
              yawDeg: p?.yawDeg ?? 0,
              present: observation.faceCount > 0 && !!p,
            },
            ts,
          );
          const fs: FrameState = {
            observation,
            gate,
            brightness,
            detectMs,
            attention: att,
          };
          latest.current = fs;
          setFrame(fs);

          emaMs = emaMs ? emaMs + alpha * (detectMs - emaMs) : detectMs;
          if (prevFrameTs) {
            const inst = 1000 / Math.max(1, t0 - prevFrameTs);
            emaFps = emaFps ? emaFps + alpha * (inst - emaFps) : inst;
          }
          prevFrameTs = t0;
          setMetrics({detectMs: emaMs, fps: emaFps});
        } catch {
          // transient detection error; skip this frame
        }
      }
      if (!stopped) {
        rafId = requestAnimationFrame(tick);
      }
    };
    rafId = requestAnimationFrame(tick);
    return () => {
      stopped = true;
      cancelAnimationFrame(rafId);
    };
  }, [enabled, videoRef, intervalMs]);

  return {frame, latest, metrics};
}
