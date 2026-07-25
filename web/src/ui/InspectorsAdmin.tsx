/**
 * InspectorsAdmin — the "everyone enrolled" registry. Enrollment happens ONLINE
 * from the phone (embedding + details posted to the backend); this lists them so
 * an admin can see, filter, and revoke inspectors. Templates never leave the
 * backend here — the list carries only the embedding length, not the vector.
 */
import {useCallback, useEffect, useMemo, useState} from 'react';
import {SYNC} from '../lib/config';
import {getToken} from '../lib/adminAuth';

interface Enrollment {
  userId: string;
  name: string;
  role: string;
  deviceId: string;
  samples: number;
  enrolledAt: number;
  embeddingLength: number;
}

const ROLE_LABELS: Record<string, string> = {
  'authority-engineer': 'Authority Engineer',
  contractor: 'Contractor',
  piu: 'PIU team',
  'regional-officer': 'Regional Officer',
  consultant: 'Consultant',
};

export default function InspectorsAdmin(): React.JSX.Element {
  const [rows, setRows] = useState<Enrollment[]>([]);
  const [status, setStatus] = useState('Loading enrolled inspectors…');
  const [roleFilter, setRoleFilter] = useState('all');

  const load = useCallback(async () => {
    try {
      const r = await fetch(`${SYNC.url}/api/enrollments`, {
        headers: {'x-api-key': getToken() || SYNC.apiKey},
      });
      const d = await r.json();
      if (d.ok) {
        setRows(d.enrollments);
        setStatus(d.enrollments.length ? '' : 'No inspectors enrolled yet.');
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

  const remove = useCallback(
    async (userId: string) => {
      if (!confirm(`Revoke enrollment for ${userId}? This cannot be undone.`)) {
        return;
      }
      try {
        await fetch(`${SYNC.url}/api/enrollments/${encodeURIComponent(userId)}`, {
          method: 'DELETE',
          headers: {'x-api-key': getToken() || SYNC.apiKey},
        });
        load();
      } catch {
        setStatus('Delete failed.');
      }
    },
    [load],
  );

  const byRole = useMemo(() => {
    const m: Record<string, number> = {};
    for (const r of rows) {
      m[r.role] = (m[r.role] ?? 0) + 1;
    }
    return m;
  }, [rows]);

  const filtered = roleFilter === 'all' ? rows : rows.filter(r => r.role === roleFilter);

  return (
    <div className="page">
      <div className="page__head">
        <div>
          <div className="page__kicker">DATALAKE 3.0 · INSPECTOR REGISTRY</div>
          <h1 className="page__title">Enrolled inspectors</h1>
          <p className="page__sub">
            Every inspector enrolled from the field app. Templates are stored
            centrally so any device can verify them offline; the vectors never
            appear here — only their length.
          </p>
        </div>
        <button className="btn btn--ghost" onClick={load}>
          Refresh
        </button>
      </div>

      <div className="kpis">
        <div className="kpi">
          <div className="kpi__label">Total enrolled</div>
          <div className="kpi__value kpi__value--signal">{rows.length}</div>
        </div>
        {Object.keys(ROLE_LABELS).map(role => (
          <div className="kpi" key={role}>
            <div className="kpi__label">{ROLE_LABELS[role]}</div>
            <div className="kpi__value">{byRole[role] ?? 0}</div>
          </div>
        ))}
      </div>

      <div className="card">
        <div className="card__head">
          <span className="card__title">Roster ({filtered.length})</span>
          <select
            className="select"
            style={{width: 'auto'}}
            value={roleFilter}
            onChange={e => setRoleFilter(e.target.value)}>
            <option value="all">All roles</option>
            {Object.keys(ROLE_LABELS).map(r => (
              <option key={r} value={r}>
                {ROLE_LABELS[r]}
              </option>
            ))}
          </select>
        </div>
        {filtered.length === 0 ? (
          <div className="empty">{status || 'No inspectors for this filter.'}</div>
        ) : (
          <div style={{overflowX: 'auto'}}>
            <table className="atable">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Inspector ID</th>
                  <th>Role</th>
                  <th>Samples</th>
                  <th>Template</th>
                  <th>Enrolled</th>
                  <th>Device</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {filtered.map(e => (
                  <tr key={e.userId}>
                    <td>{e.name}</td>
                    <td className="mono">{e.userId}</td>
                    <td>{ROLE_LABELS[e.role] ?? e.role}</td>
                    <td className="mono dim">{e.samples}</td>
                    <td className="mono dim">{e.embeddingLength}-d</td>
                    <td className="mono dim">{new Date(e.enrolledAt).toLocaleString()}</td>
                    <td className="mono dim">{e.deviceId}</td>
                    <td>
                      <button className="btn btn--danger" onClick={() => remove(e.userId)}>
                        Revoke
                      </button>
                    </td>
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
