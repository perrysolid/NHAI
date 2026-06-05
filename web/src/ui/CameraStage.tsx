/**
 * CameraStage — biometric capture viewport with a HUD reticle.
 *
 * Corner brackets frame the subject, a scan line sweeps while the sensor is
 * active, and status reads out in monospace. Green denotes capture-ready / lock.
 * Presentational only; the parent supplies state.
 */
import type {RefObject} from 'react';

export interface CameraStageProps {
  videoRef: RefObject<HTMLVideoElement | null>;
  ready: boolean;
  prompt: string;
  /** liveness progress 0..1 -> drives the top sweep bar. */
  progress?: number;
  /** short state label shown top-right (e.g. ready / verifying). */
  status: string;
  active: boolean;
}

export default function CameraStage({
  videoRef,
  ready,
  prompt,
  progress,
  status,
  active,
}: CameraStageProps) {
  return (
    <div className={`stage ${ready ? 'stage--lock' : ''}`}>
      <video
        ref={videoRef}
        className="video"
        playsInline
        muted
        autoPlay
        data-testid="camera-video"
      />

      <div className="hud" aria-hidden>
        <span className="corner corner--tl" />
        <span className="corner corner--tr" />
        <span className="corner corner--bl" />
        <span className="corner corner--br" />
        <div className="reticle" />
        {active && <div className="scanline" />}
      </div>

      <div className="hud-top">
        <div className="sysind">
          <span className="led" />
          <span>SENSOR LIVE</span>
        </div>
        <div className="statechip" data-testid="state">
          {status.toUpperCase()}
        </div>
      </div>

      {typeof progress === 'number' && progress > 0 && (
        <div className="livebar" data-testid="liveness-progress">
          <div className="livebar__fill" style={{width: `${progress * 100}%`}} />
        </div>
      )}

      <div
        className={`readout ${ready ? 'readout--lock' : ''}`}
        data-testid="prompt">
        <span className="readout__caret">›</span>
        {prompt}
      </div>
    </div>
  );
}
