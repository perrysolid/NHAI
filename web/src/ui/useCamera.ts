/**
 * useCamera — getUserMedia front camera, attached to a <video> ref.
 *
 * Works with Playwright's fake camera (Chromium flags
 * --use-fake-device-for-media-stream --use-fake-ui-for-media-stream).
 */
import {useCallback, useEffect, useRef, useState} from 'react';

export type CameraStatus = 'idle' | 'requesting' | 'ready' | 'denied' | 'error';

export function useCamera() {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [status, setStatus] = useState<CameraStatus>('idle');
  const [error, setError] = useState<string | null>(null);

  const start = useCallback(async () => {
    if (streamRef.current) {
      return;
    }
    setStatus('requesting');
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {facingMode: 'user', width: {ideal: 640}, height: {ideal: 480}},
        audio: false,
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play().catch(() => undefined);
      }
      setStatus('ready');
    } catch (e) {
      const name = e instanceof DOMException ? e.name : '';
      setStatus(name === 'NotAllowedError' ? 'denied' : 'error');
      setError(e instanceof Error ? e.message : 'camera error');
    }
  }, []);

  const stop = useCallback(() => {
    streamRef.current?.getTracks().forEach(t => t.stop());
    streamRef.current = null;
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
    setStatus('idle');
  }, []);

  useEffect(() => () => stop(), [stop]);

  return {videoRef, status, error, start, stop};
}
