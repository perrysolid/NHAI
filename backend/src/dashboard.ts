/**
 * dashboard — server-rendered operations console for synced attendance events.
 *
 * Surfaces KPIs and highlights the records an operator must inspect: drowsiness
 * (PERCLOS / micro-sleep), inattention (look-away), poor capture quality
 * (lighting), and weak matches. Plain SSR HTML, no client framework, no emoji.
 */
import type {AttendanceRecord, InspectionMetrics} from './store.js';

const MATCH_THRESHOLD = 0.5;

function esc(s: string): string {
  return s.replace(
    /[&<>"']/g,
    c =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
      })[c] ?? c,
  );
}

function pct(n: number): string {
  return `${Math.round(n * 100)}%`;
}

interface RowFlags {
  drowsy: boolean;
  away: boolean;
  poorLight: boolean;
  weakMatch: boolean;
}

function flagsFor(r: AttendanceRecord): RowFlags {
  const m = r.inspection;
  return {
    drowsy: !!m?.drowsy,
    away: !!m?.lookingAway,
    poorLight: !!m && (m.brightness < 55 || m.brightness > 235),
    weakMatch: r.matchDistance >= MATCH_THRESHOLD * 0.9,
  };
}

function kpiCard(label: string, value: string, tone = 'default'): string {
  return `<div class="kpi">
    <div class="kpi__label">${esc(label)}</div>
    <div class="kpi__value kpi__value--${tone}">${esc(value)}</div>
  </div>`;
}

function inspectionCells(m: InspectionMetrics | undefined): string {
  if (!m) {
    return `<td class="dim">—</td><td class="dim">—</td><td class="dim">—</td><td class="dim">—</td>`;
  }
  const earTone = m.ear < 0.21 ? 'bad' : '';
  const perclosTone = m.perclos >= 0.2 ? 'bad' : '';
  const yawTone = Math.abs(m.yawDeg) >= 26 ? 'warn' : '';
  const lightTone = m.brightness < 55 || m.brightness > 235 ? 'warn' : '';
  return (
    `<td class="${earTone}">${m.ear.toFixed(2)}</td>` +
    `<td class="${perclosTone}">${pct(m.perclos)}</td>` +
    `<td>${m.blinkRate.toFixed(0)} bpm</td>` +
    `<td class="${yawTone || lightTone}">${m.yawDeg.toFixed(0)}&deg; / ${Math.round(
      m.brightness,
    )}</td>`
  );
}

function flagChips(f: RowFlags): string {
  const chips: string[] = [];
  if (f.drowsy) chips.push('<span class="chip chip--bad">Drowsy</span>');
  if (f.away) chips.push('<span class="chip chip--warn">Look-away</span>');
  if (f.poorLight) chips.push('<span class="chip chip--warn">Lighting</span>');
  if (f.weakMatch) chips.push('<span class="chip chip--warn">Weak match</span>');
  if (chips.length === 0) chips.push('<span class="chip chip--ok">Clear</span>');
  return chips.join(' ');
}

function sparkbars(records: AttendanceRecord[]): string {
  const recent = records.slice(0, 40).reverse();
  if (recent.length === 0) {
    return '<div class="dim">no data</div>';
  }
  const max = Math.max(MATCH_THRESHOLD, ...recent.map(r => r.matchDistance));
  const bars = recent
    .map(r => {
      const h = Math.max(4, (r.matchDistance / max) * 100);
      const tone = flagsFor(r).drowsy
        ? 'bar--bad'
        : r.matchDistance >= MATCH_THRESHOLD * 0.9
          ? 'bar--warn'
          : 'bar--ok';
      return `<span class="bar ${tone}" style="height:${h}%" title="${esc(
        r.userId,
      )} · ${r.matchDistance.toFixed(3)}"></span>`;
    })
    .join('');
  return `<div class="spark">${bars}</div>
    <div class="spark__axis"><span>recent events</span><span>match distance (lower = stronger)</span></div>`;
}

export function renderDashboard(
  records: AttendanceRecord[],
  storeKind: string,
): string {
  const total = records.length;
  const subjects = new Set(records.map(r => r.userId)).size;
  const livenessPass = records.filter(r => r.livenessPassed).length;
  const livenessRate = total ? livenessPass / total : 0;
  const withMetrics = records.filter(r => r.inspection);
  const drowsy = withMetrics.filter(r => r.inspection?.drowsy).length;
  const away = withMetrics.filter(r => r.inspection?.lookingAway).length;
  const avgDist = total
    ? records.reduce((s, r) => s + r.matchDistance, 0) / total
    : 0;
  const last = total ? new Date(records[0].timestamp).toLocaleString() : '—';

  const rows = records
    .map(r => {
      const f = flagsFor(r);
      const rowTone = f.drowsy
        ? 'row--bad'
        : f.away || f.poorLight || f.weakMatch
          ? 'row--warn'
          : '';
      return `<tr class="${rowTone}">
        <td class="mono">${esc(r.userId)}</td>
        <td class="mono dim">${new Date(r.timestamp).toLocaleString()}</td>
        <td>${r.livenessPassed ? '<span class="chip chip--ok">pass</span>' : '<span class="chip chip--bad">fail</span>'}</td>
        <td class="mono">${r.matchDistance.toFixed(3)}</td>
        ${inspectionCells(r.inspection)}
        <td>${flagChips(f)}</td>
        <td class="mono dim">${esc(r.deviceId)}</td>
      </tr>`;
    })
    .join('');

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta http-equiv="refresh" content="15" />
<title>Datalake Face Auth — Operations Console</title>
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans:wght@400;500;600;700&display=swap" rel="stylesheet" />
<style>
  :root{--bg:#07090b;--surface:#0d1216;--surface2:#0a0d10;--line:#1a242c;--line2:#25323b;--text:#dbe4e8;--dim:#76858d;--faint:#46535b;--signal:#38e0a5;--amber:#f2b347;--red:#ff6b6b;--sans:'IBM Plex Sans',system-ui,sans-serif;--mono:'IBM Plex Mono',monospace;}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--text);font-family:var(--sans);
    background-image:linear-gradient(rgba(90,120,140,.05) 1px,transparent 1px),linear-gradient(90deg,rgba(90,120,140,.05) 1px,transparent 1px);background-size:38px 38px;}
  .wrap{max-width:1180px;margin:0 auto;padding:24px 28px}
  header{display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid var(--line);padding-bottom:16px}
  .title{font-size:18px;font-weight:600}
  .sub{font-family:var(--mono);font-size:11px;text-transform:uppercase;letter-spacing:.16em;color:var(--dim);margin-top:3px}
  .meta{font-family:var(--mono);font-size:11px;color:var(--dim);text-align:right;line-height:1.7}
  .kpis{display:grid;grid-template-columns:repeat(6,1fr);gap:1px;background:var(--line);border:1px solid var(--line);border-radius:8px;overflow:hidden;margin:20px 0}
  .kpi{background:var(--surface);padding:14px 16px}
  .kpi__label{font-family:var(--mono);font-size:10px;text-transform:uppercase;letter-spacing:.14em;color:var(--faint);margin-bottom:8px}
  .kpi__value{font-family:var(--mono);font-size:20px;font-weight:500}
  .kpi__value--signal{color:var(--signal)} .kpi__value--warn{color:var(--amber)} .kpi__value--bad{color:var(--red)}
  .card{background:var(--surface);border:1px solid var(--line);border-radius:10px;margin-bottom:20px}
  .card__h{font-family:var(--mono);font-size:11px;text-transform:uppercase;letter-spacing:.14em;color:var(--dim);padding:11px 16px;border-bottom:1px solid var(--line);background:var(--surface2)}
  .card__b{padding:16px}
  .spark{display:flex;align-items:flex-end;gap:3px;height:90px}
  .bar{flex:1;min-width:3px;border-radius:2px 2px 0 0;background:var(--dim)}
  .bar--ok{background:var(--signal)} .bar--warn{background:var(--amber)} .bar--bad{background:var(--red)}
  .spark__axis{display:flex;justify-content:space-between;font-family:var(--mono);font-size:10px;color:var(--faint);margin-top:8px}
  table{width:100%;border-collapse:collapse;font-size:13px}
  th{font-family:var(--mono);font-size:10px;text-transform:uppercase;letter-spacing:.1em;color:var(--faint);text-align:left;padding:10px 12px;border-bottom:1px solid var(--line)}
  td{padding:10px 12px;border-bottom:1px solid var(--line)}
  tr:hover td{background:var(--surface2)}
  .mono{font-family:var(--mono)} .dim{color:var(--dim)}
  td.bad{color:var(--red)} td.warn{color:var(--amber)}
  .row--bad td{background:rgba(255,107,107,.07)} .row--warn td{background:rgba(242,179,71,.06)}
  .chip{font-family:var(--mono);font-size:10px;text-transform:uppercase;letter-spacing:.08em;padding:2px 7px;border-radius:4px;border:1px solid var(--line2);color:var(--dim)}
  .chip--ok{color:var(--signal);border-color:rgba(56,224,165,.4);background:rgba(56,224,165,.1)}
  .chip--warn{color:var(--amber);border-color:rgba(242,179,71,.4);background:rgba(242,179,71,.1)}
  .chip--bad{color:var(--red);border-color:rgba(255,107,107,.45);background:rgba(255,107,107,.12)}
  .empty{padding:40px;text-align:center;color:var(--faint);font-family:var(--mono)}
  @media(max-width:820px){.kpis{grid-template-columns:repeat(3,1fr)} .tablewrap{overflow-x:auto}}
</style></head>
<body><div class="wrap">
  <header>
    <div>
      <div class="title">Datalake Face Auth — Operations Console</div>
      <div class="sub">Offline biometric attendance · synced records</div>
    </div>
    <div class="meta">Store: ${esc(storeKind)}<br/>Last event: ${esc(last)}<br/>Auto-refresh 15s</div>
  </header>

  <div class="kpis">
    ${kpiCard('Total events', String(total))}
    ${kpiCard('Subjects', String(subjects))}
    ${kpiCard('Liveness pass', pct(livenessRate), livenessRate >= 0.99 ? 'signal' : 'warn')}
    ${kpiCard('Avg match dist', avgDist.toFixed(3))}
    ${kpiCard('Drowsy events', String(drowsy), drowsy > 0 ? 'bad' : 'signal')}
    ${kpiCard('Look-away events', String(away), away > 0 ? 'warn' : 'signal')}
  </div>

  <div class="card">
    <div class="card__h">Match distance — recent events</div>
    <div class="card__b">${sparkbars(records)}</div>
  </div>

  <div class="card">
    <div class="card__h">Inspection ledger — flagged rows highlighted</div>
    <div class="tablewrap">
    ${
      total === 0
        ? '<div class="empty">No records yet. Verify a subject in the app and sync.</div>'
        : `<table>
      <thead><tr>
        <th>Subject</th><th>Time</th><th>Liveness</th><th>Distance</th>
        <th>EAR</th><th>PERCLOS</th><th>Blink</th><th>Yaw / Light</th>
        <th>Inspection</th><th>Device</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>`
    }
    </div>
  </div>
</div></body></html>`;
}
