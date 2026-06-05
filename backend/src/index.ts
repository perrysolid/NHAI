/**
 * DatalakeFaceAuth sync backend (AWS/Render-compatible).
 *
 * Receives attendance records the device already verified OFFLINE and stores
 * them. It never does face recognition. Endpoints:
 *   GET  /health            → liveness probe
 *   POST /api/sync          → {records:[...]} (x-api-key) → {ok, accepted}
 *   GET  /api/records       → recent records (x-api-key)
 *   GET  /admin?key=...      → HTML dashboard (ADMIN_PASSCODE-gated)
 */
import express from 'express';
import cors from 'cors';
import {apiKeyGuard} from './auth.js';
import {createStore, sanitizeMany} from './store.js';

const app = express();
const store = createStore();

app.use(
  cors({origin: process.env.CORS_ORIGIN ?? '*', methods: ['GET', 'POST']}),
);
app.use(express.json({limit: '1mb'}));

app.get('/health', (_req, res) => {
  res.json({ok: true, store: store.kind});
});

app.post('/api/sync', apiKeyGuard, async (req, res) => {
  const records = sanitizeMany(req.body?.records);
  if (records.length === 0) {
    res.status(400).json({ok: false, error: 'no valid records'});
    return;
  }
  try {
    const accepted = await store.add(records);
    res.json({ok: true, accepted, received: records.length});
  } catch (e) {
    res
      .status(500)
      .json({ok: false, error: e instanceof Error ? e.message : 'db error'});
  }
});

app.get('/api/records', apiKeyGuard, async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 200, 1000);
  const since = Number(req.query.since) || 0;
  try {
    res.json({ok: true, records: await store.list(limit, since)});
  } catch (e) {
    res
      .status(500)
      .json({ok: false, error: e instanceof Error ? e.message : 'db error'});
  }
});

app.get('/admin', async (req, res) => {
  const passcode = process.env.ADMIN_PASSCODE;
  if (passcode && req.query.key !== passcode) {
    res.status(401).send('Unauthorized — append ?key=YOUR_PASSCODE');
    return;
  }
  const records = await store.list(500);
  const rows = records
    .map(
      r => `<tr>
        <td>${escapeHtml(r.userId)}</td>
        <td>${new Date(r.timestamp).toLocaleString()}</td>
        <td>${r.livenessPassed ? '✓' : '✗'}</td>
        <td>${r.matchDistance.toFixed(3)}</td>
        <td>${escapeHtml(r.deviceId)}</td>
      </tr>`,
    )
    .join('');
  res.set('content-type', 'text/html').send(`<!doctype html>
<html><head><meta charset="utf-8"><title>DatalakeFaceAuth — Admin</title>
<style>
  body{font:14px system-ui;background:#0b0f15;color:#e6edf3;margin:0;padding:24px}
  h1{font-size:18px}
  .meta{color:#8b97a5;margin-bottom:16px}
  table{border-collapse:collapse;width:100%;max-width:900px}
  th,td{text-align:left;padding:8px 10px;border-bottom:1px solid #1f2a37}
  th{color:#8b97a5;font-weight:600}
  tr:hover td{background:#131a24}
</style></head><body>
  <h1>Attendance records</h1>
  <div class="meta">${records.length} record(s) · store: ${store.kind}</div>
  <table>
    <thead><tr><th>User</th><th>Time</th><th>Live</th><th>Dist</th><th>Device</th></tr></thead>
    <tbody>${rows || '<tr><td colspan="5">no records yet</td></tr>'}</tbody>
  </table>
</body></html>`);
});

function escapeHtml(s: string): string {
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

const port = Number(process.env.PORT) || 4000;
store
  .init()
  .then(() => {
    app.listen(port, () => {
      // eslint-disable-next-line no-console
      console.log(
        `[sync] listening on :${port} (store: ${store.kind})${
          process.env.API_KEY ? '' : ' — WARNING: API_KEY unset, auth disabled'
        }`,
      );
    });
  })
  .catch(e => {
    // eslint-disable-next-line no-console
    console.error('[sync] failed to init store:', e);
    process.exit(1);
  });
