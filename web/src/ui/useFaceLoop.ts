/**
 * useFaceLoop — runs the detection pipeline on the live <video> at a throttled
 * rate, exposing the latest observation + quality gate + brightness. The latest
 * value is also kept in a ref so flow logic (enroll/verify) can read it without
 * waiting on React state.
 */
import {useEffect, useRef, useState} from 'react';
import {observe, type Observation} from '../face/pipeline';
import {sampleBrightness} from '../face/brightness';
import {evaluate, type GateResult} from '../face/gates';

export interface FrameState {
  observation: Observation;
  gate: GateResult;
  brightness: number;
}

export function useFaceLoop(
  videoRef: React.RefObject<HTMLVideoElement | null>,
  enabled: boolean,
  intervalMs = 120,
) {
  const [frame, setFrame] = useState<FrameState | null>(null);
  const latest = useRef<FrameState | null>(null);

  useEffect(() => {
    if (!enabled) {
      return;
    }
    let stopped = false;
    let lastTs = 0;
    let rafId = 0;
    const scratch = document.createElement('canvas');

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
          const observation = await observe(video);
          const brightness = sampleBrightness(video, scratch);
          const gate = evaluate(observation, video.videoWidth, brightness);
          const fs: FrameState = {observation, gate, brightness};
          latest.current = fs;
          setFrame(fs);
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

  return {frame, latest};
}
