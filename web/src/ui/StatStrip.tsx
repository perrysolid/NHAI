/**
 * StatStrip — instrument readout of the running system's characteristics.
 * Values that can be measured (latency, throughput) are live; the rest describe
 * the deployed browser pipeline. Monospace, no decoration that isn't data.
 */
import {RECOGNITION} from '../lib/config';

export interface StatStripProps {
  detectMs: number;
  fps: number;
  /** network requests made during the auth flow — proves offline operation. */
  authCalls: number;
}

/** Browser model footprint actually served from /models (face-api). */
const MODEL_FOOTPRINT_MB = 7.0;

function Metric({
  label,
  value,
  unit,
  tone = 'default',
}: {
  label: string;
  value: string;
  unit?: string;
  tone?: 'default' | 'signal' | 'warn';
}) {
  return (
    <div className="metric">
      <div className="metric__label">{label}</div>
      <div className={`metric__value metric__value--${tone}`}>
        {value}
        {unit && <span className="metric__unit">{unit}</span>}
      </div>
    </div>
  );
}

export default function StatStrip({detectMs, fps, authCalls}: StatStripProps) {
  const latency = detectMs > 0 ? Math.round(detectMs).toString() : '—';
  const rate = fps > 0 ? fps.toFixed(0) : '—';
  return (
    <div className="statstrip">
      <Metric label="Execution" value="On-device" tone="signal" />
      <Metric label="Latency" value={latency} unit="ms" />
      <Metric label="Throughput" value={rate} unit="fps" />
      <Metric
        label="Model footprint"
        value={MODEL_FOOTPRINT_MB.toFixed(1)}
        unit="MB"
      />
      <Metric
        label="Match threshold"
        value={RECOGNITION.matchDistance.toFixed(2)}
      />
      <Metric
        label="Auth network"
        value={authCalls.toString()}
        unit="calls"
        tone={authCalls === 0 ? 'signal' : 'warn'}
      />
    </div>
  );
}
