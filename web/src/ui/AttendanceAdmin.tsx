/**
 * AttendanceAdmin — verified attendance records synced from field devices
 * (sync-and-purge lands here). Mirrors Datalake's role-KPI + ledger view: who
 * was verified, where (geofence), how strong, and any drowsy/spoof flags.
 */
import {useCallback, useEffect, useMemo, useState} from 'react';
import {SYNC} from '../lib/config';
import {getToken} from '../lib/adminAuth';

interface RecordLocation {
  lat: number;
  lon: number;
  accuracyM: number;
  mocked: boolean;
  geofencePassed: boolean;
  siteId?: string;
  distanceM: number;
}
interface Rec {
  userId: string;
  timestamp: number;
  deviceId: string;
  livenessPassed: boolean;
  matchDistance: number;
  score?: number;
  location?: RecordLocation;
  inspection?: {drowsy?: boolean; lookingAway?: boolean};
}

export default function AttendanceAdmin(): React.JSX.Element {
  const [rows, setRows] = useState<Rec[]>([]);
  const [status, setStatus] = useState('Loading attendance records…');

  const load = useCallback(async () => {
    try {
      const r = await fetch(`${SYNC.url}/api/records?limit=500`, {
        headers: {'x-api-key': getToken()},
      });
      const d = await r.json();
      if (d.ok) {
        setRows(d.records);
        setStatus(d.records.length ? '' : 'No attendance synced yet.');
      } else {
        setStatus(d.error ?? 'Failed to load.');
      }
    } catch {
      setStatus('Could not reach the backend.');
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- state is set after the async fetch, not synchronously
    load();
  }, [load]);

  const kpis = useMemo(() => {
    const total = rows.length;
    const subjects = new Set(rows.map(r => r.userId)).size;
    const livePass = rows.filter(r => r.livenessPassed).length;
    const onSite = rows.filter(r => r.location?.geofencePassed).length;
    const mock = rows.filter(r => r.location?.mocked).length;
    const drowsy = rows.filter(r => r.inspection?.drowsy).length;
    return {total, subjects, livePass, onSite, mock, drowsy};
  }, [rows]);

  const pct = (n: number, d: number) => (d ? `${Math.round((n / d) * 100)}%` : '—');

  const siteChip = (l?: RecordLocation) => {
    if (!l) return <span className="chip">—</span>;
    if (l.mocked) return <span className="chip chip--bad">Mock GPS</span>;
    if (l.geofencePassed) return <span className="chip chip--ok">On-site</span>;
    return <span className="chip chip--warn">Off-site {Math.round(l.distanceM)}m</span>;
  };

  return (
    <div className="page">
      <div className="page__head">
        <div>
          <div className="page__kicker">DATALAKE 3.0 · FIELD ATTENDANCE</div>
          <h1 className="page__title">Verified attendance ledger</h1>
          <p className="page__sub">
            Records synced from field devices after offline verification. Nothing
            here drives the auth decision — it's the audit trail.
          </p>
        </div>
        <button className="btn btn--ghost" onClick={load}>
          Refresh
        </button>
      </div>

      <div className="kpis">
        <Kpi label="Total events" value={String(kpis.total)} />
        <Kpi label="Inspectors" value={String(kpis.subjects)} />
        <Kpi
          label="Liveness pass"
          value={pct(kpis.livePass, kpis.total)}
          tone={kpis.total && kpis.livePass === kpis.total ? 'signal' : 'amber'}
        />
        <Kpi label="On-site" value={String(kpis.onSite)} tone="signal" />
        <Kpi label="Mock-GPS flags" value={String(kpis.mock)} tone={kpis.mock ? 'red' : undefined} />
        <Kpi label="Drowsy flags" value={String(kpis.drowsy)} tone={kpis.drowsy ? 'red' : undefined} />
      </div>

      <div className="card">
        <div className="card__head">
          <span className="card__title">Ledger ({rows.length})</span>
        </div>
        {rows.length === 0 ? (
          <div className="empty">{status}</div>
        ) : (
          <div style={{overflowX: 'auto'}}>
            <table className="atable">
              <thead>
                <tr>
                  <th>Inspector</th>
                  <th>Time</th>
                  <th>Liveness</th>
                  <th>Score</th>
                  <th>Match dist</th>
                  <th>Site / GPS</th>
                  <th>Device</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={`${r.userId}-${r.timestamp}-${i}`}>
                    <td className="mono">{r.userId}</td>
                    <td className="mono dim">{new Date(r.timestamp).toLocaleString()}</td>
                    <td>
                      {r.livenessPassed ? (
                        <span className="chip chip--ok">pass</span>
                      ) : (
                        <span className="chip chip--bad">blocked</span>
                      )}
                    </td>
                    <td className="mono">{typeof r.score === 'number' ? r.score : '—'}</td>
                    <td className="mono dim">{r.matchDistance.toFixed(3)}</td>
                    <td>{siteChip(r.location)}</td>
                    <td className="mono dim">{r.deviceId}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

function Kpi({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: 'signal' | 'amber' | 'red';
}): React.JSX.Element {
  return (
    <div className="kpi">
      <div className="kpi__label">{label}</div>
      <div className={`kpi__value ${tone ? `kpi__value--${tone}` : ''}`}>{value}</div>
    </div>
  );
}
