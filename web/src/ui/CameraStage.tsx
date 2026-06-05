/**
 * CameraStage — the live video with a readiness ring and a prompt banner.
 * Presentational only; all decisions come from the parent.
 */
import type {RefObject} from 'react';

export interface CameraStageProps {
  videoRef: RefObject<HTMLVideoElement | null>;
  ready: boolean;
  prompt: string;
  /** optional liveness progress 0..1 to draw a ring sweep. */
  progress?: number;
  badge?: string;
}

export default function CameraStage({
  videoRef,
  ready,
  prompt,
  progress,
  badge,
}: CameraStageProps) {
  return (
    <div className="stage">
      <video
        ref={videoRef}
        className="video"
        playsInline
        muted
        autoPlay
        data-testid="camera-video"
      />
      <div className="ring-wrap" aria-hidden>
        <div className={`ring ${ready ? 'ring--ready' : ''}`} />
      </div>
      {typeof progress === 'number' && progress > 0 && (
        <div className="progress" data-testid="liveness-progress">
          <div className="progress__bar" style={{width: `${progress * 100}%`}} />
        </div>
      )}
      {badge && <div className="badge">{badge}</div>}
      <div
        className={`prompt ${ready ? 'prompt--ready' : ''}`}
        data-testid="prompt">
        {prompt}
      </div>
    </div>
  );
}
