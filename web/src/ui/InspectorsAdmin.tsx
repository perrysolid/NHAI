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

  const authHeaders = {'x-api-key': getToken() || SYNC.apiKey};

  const load = useCallback(async () => {
    try {
      const r = await fetch(`${SYNC.url}/api/enrollments`, {headers: authHeaders});
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
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
          headers: authHeaders,
        });
        load();
      } catch {
        setStatus('Delete failed.');
      }
      // eslint-disable-next-line react-hooks/exhaustive-deps
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
    <div style={S.wrap}>
      <div style={S.header}>
        <div>
          <div style={S.kicker}>DATALAKE 3.0 · INSPECTOR REGISTRY</div>
          <h2 style={S.title}>Enrolled inspectors</h2>
        </div>
        <button style={S.ghostBtn} onClick={load}>
          Refresh
        </button>
      </div>

      <div style={S.kpis}>
        <Kpi label="Total enrolled" value={String(rows.length)} />
        {Object.keys(ROLE_LABELS).map(role => (
          <Kpi key={role} label={ROLE_LABELS[role]} value={String(byRole[role] ?? 0)} />
        ))}
      </div>

      <div style={S.card}>
        <div style={S.cardHead}>
          <span style={S.kicker}>ROSTER ({filtered.length})</span>
          <select
            style={S.select}
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
          <div style={S.empty}>{status || 'No inspectors for this filter.'}</div>
        ) : (
          <table style={S.table}>
            <thead>
              <tr>
                <th style={S.th}>Name</th>
                <th style={S.th}>Inspector ID</th>
                <th style={S.th}>Role</th>
                <th style={S.th}>Samples</th>
                <th style={S.th}>Template</th>
                <th style={S.th}>Enrolled</th>
                <th style={S.th}>Device</th>
                <th style={S.th}></th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(e => (
                <tr key={e.userId}>
                  <td style={S.td}>{e.name}</td>
                  <td style={S.tdMono}>{e.userId}</td>
                  <td style={S.td}>{ROLE_LABELS[e.role] ?? e.role}</td>
                  <td style={S.tdMono}>{e.samples}</td>
                  <td style={S.tdMono}>{e.embeddingLength}-d</td>
                  <td style={S.tdMono}>{new Date(e.enrolledAt).toLocaleString()}</td>
                  <td style={S.tdMono}>{e.deviceId}</td>
                  <td style={S.td}>
                    <button style={S.delBtn} onClick={() => remove(e.userId)}>
                      Revoke
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function Kpi({label, value}: {label: string; value: string}): React.JSX.Element {
  return (
    <div style={S.kpi}>
      <div style={S.kpiValue}>{value}</div>
      <div style={S.kpiLabel}>{label}</div>
    </div>
  );
}

const S: Record<string, React.CSSProperties> = {
  wrap: {padding: '20px 22px', color: '#dbe4e8'},
  header: {display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', marginBottom: 16},
  kicker: {color: '#38e0a5', fontSize: 10, fontWeight: 800, letterSpacing: 1.6},
  title: {margin: '4px 0 0', fontSize: 22, fontWeight: 900},
  kpis: {display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: 10, marginBottom: 16},
  kpi: {background: '#0d1216', border: '1px solid #25323b', borderRadius: 8, padding: '12px 14px'},
  kpiValue: {color: '#38e0a5', fontSize: 22, fontWeight: 900, fontFamily: 'ui-monospace, monospace'},
  kpiLabel: {color: '#8b97a5', fontSize: 10, marginTop: 4},
  card: {background: '#0d1216', border: '1px solid #25323b', borderRadius: 10, padding: 14},
  cardHead: {display: 'flex', justifyContent: 'space-between', alignItems: 'center'},
  select: {
    background: '#111a21',
    border: '1px solid #25323b',
    color: '#dbe4e8',
    padding: '6px 10px',
    borderRadius: 6,
    fontSize: 13,
  },
  empty: {color: '#46535b', fontFamily: 'ui-monospace, monospace', padding: '20px 0'},
  table: {width: '100%', borderCollapse: 'collapse', marginTop: 12, fontSize: 13},
  th: {
    textAlign: 'left',
    color: '#46535b',
    fontSize: 10,
    textTransform: 'uppercase',
    letterSpacing: 1,
    padding: '8px 10px',
    borderBottom: '1px solid #1a242c',
  },
  td: {padding: '10px', borderBottom: '1px solid #1a242c'},
  tdMono: {padding: '10px', borderBottom: '1px solid #1a242c', fontFamily: 'ui-monospace, monospace', color: '#8b97a5'},
  delBtn: {
    background: 'none',
    border: '1px solid #ff6b6b',
    color: '#ff6b6b',
    borderRadius: 5,
    padding: '4px 9px',
    cursor: 'pointer',
    fontSize: 12,
  },
  ghostBtn: {
    background: 'transparent',
    color: '#38e0a5',
    border: '1px solid #38e0a5',
    borderRadius: 6,
    padding: '8px 12px',
    cursor: 'pointer',
    fontWeight: 700,
  },
};
