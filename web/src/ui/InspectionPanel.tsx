/**
 * InspectionPanel — live per-frame telemetry: drowsiness (PERCLOS, blink rate,
 * micro-sleep), eye openness (EAR), head pose, and lighting. Highlights the key
 * states (drowsy, looking away, poor light) the operator should notice.
 */
import type {FrameState} from './useFaceLoop';
import {DROWSINESS, GATES} from '../lib/config';

function Gauge({
  label,
  value,
  display,
  fraction,
  tone = 'default',
}: {
  label: string;
  value: string;
  display?: string;
  fraction: number;
  tone?: 'default' | 'signal' | 'warn' | 'bad';
}) {
  void value;
  const pct = Math.max(0, Math.min(1, fraction)) * 100;
  return (
    <div className="gauge">
      <div className="gauge__head">
        <span className="gauge__label">{label}</span>
        <span className={`gauge__val gauge__val--${tone}`}>{display}</span>
      </div>
      <div className="gauge__track">
        <div className={`gauge__fill gauge__fill--${tone}`} style={{width: `${pct}%`}} />
      </div>
    </div>
  );
}

export default function InspectionPanel({frame}: {frame: FrameState | null}) {
  const a = frame?.attention;
  const p = frame?.observation.primary;
  const present = !!p;

  let stateLabel = 'No subject';
  let stateTone: 'default' | 'signal' | 'warn' | 'bad' = 'default';
  if (present && a) {
    if (a.drowsy) {
      stateLabel = 'Drowsy';
      stateTone = 'bad';
    } else if (a.lookingAway) {
      stateLabel = 'Looking away';
      stateTone = 'warn';
    } else {
      stateLabel = 'Alert';
      stateTone = 'signal';
    }
  }

  const ear = a?.ear ?? 0;
  const perclos = a?.perclos ?? 0;
  const blink = a?.blinkRate ?? 0;
  const yaw = p?.yawDeg ?? 0;
  const brightness = frame?.brightness ?? 0;

  return (
    <div className="panel">
      <div className="panel__title">
        <span>Frame inspection</span>
        <span className={`statetag statetag--${stateTone}`}>{stateLabel}</span>
      </div>
      <div className="panel__body inspect">
        <Gauge
          label="Eye openness (EAR)"
          value={`${ear}`}
          display={present ? ear.toFixed(2) : '—'}
          fraction={ear / 0.4}
          tone={ear < DROWSINESS.earClosed ? 'bad' : 'signal'}
        />
        <Gauge
          label="PERCLOS (eyes closed)"
          value={`${perclos}`}
          display={present ? `${Math.round(perclos * 100)}%` : '—'}
          fraction={perclos}
          tone={perclos >= DROWSINESS.perclosDrowsy ? 'bad' : 'default'}
        />
        <Gauge
          label="Blink rate"
          value={`${blink}`}
          display={present ? `${blink.toFixed(0)} bpm` : '—'}
          fraction={blink / 40}
          tone={blink >= DROWSINESS.highBlinkRate ? 'warn' : 'default'}
        />
        <Gauge
          label="Head yaw"
          value={`${yaw}`}
          display={present ? `${yaw.toFixed(0)}°` : '—'}
          fraction={Math.abs(yaw) / 60}
          tone={Math.abs(yaw) >= DROWSINESS.lookAwayYawDeg ? 'warn' : 'default'}
        />
        <Gauge
          label="Illumination"
          value={`${brightness}`}
          display={present ? `${Math.round(brightness)}` : '—'}
          fraction={brightness / 255}
          tone={
            brightness < GATES.minBrightness || brightness > GATES.maxBrightness
              ? 'warn'
              : 'signal'
          }
        />
      </div>
    </div>
  );
}
