/**
 * Datalake Face Auth sync backend (AWS / Render compatible).
 *
 * Receives attendance records the device already verified OFFLINE and stores
 * them. It never performs face recognition. Endpoints:
 *   GET  /                  -> service status page
 *   GET  /health            -> liveness probe
 *   POST /api/sync          -> {records:[...]} (x-api-key) -> {ok, accepted}
 *   GET  /api/records       -> recent records (x-api-key)
 *   GET  /admin?key=...      -> operations console (ADMIN_PASSCODE gated)
 */
import express from 'express';
import cors from 'cors';
import {apiKeyGuard} from './auth.js';
import {createStore, sanitizeMany} from './store.js';
import {renderDashboard} from './dashboard.js';

const app = express();
const store = createStore();

app.use(
  cors({origin: process.env.CORS_ORIGIN ?? '*', methods: ['GET', 'POST']}),
);
app.use(express.json({limit: '1mb'}));

// Structured request log line per response.
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const ms = Date.now() - start;
    // eslint-disable-next-line no-console
    console.log(
      `[req] ${req.method} ${req.path} -> ${res.statusCode} ${ms}ms`,
    );
  });
  next();
});

app.get('/', (_req, res) => {
  res.set('content-type', 'text/html').send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Datalake Face Auth — Sync Service</title>
<style>
  body{margin:0;background:#07090b;color:#dbe4e8;font-family:system-ui,sans-serif;
    display:flex;min-height:100vh;align-items:center;justify-content:center}
  .card{border:1px solid #1a242c;border-radius:12px;padding:28px 32px;max-width:460px}
  h1{font-size:17px;margin:0 0 4px} .s{color:#76858d;font-size:13px;margin-bottom:18px}
  .dot{display:inline-block;width:8px;height:8px;border-radius:50%;background:#38e0a5;
    box-shadow:0 0 8px #38e0a5;margin-right:8px}
  code{font-family:ui-monospace,monospace;color:#38e0a5}
  ul{list-style:none;padding:0;margin:0;font-size:13px;line-height:2}
  a{color:#dbe4e8}
</style></head><body>
  <div class="card">
    <h1><span class="dot"></span>Datalake Face Auth — Sync Service</h1>
    <div class="s">Operational. Store: ${store.kind}.</div>
    <ul>
      <li><code>GET  /health</code> — liveness probe</li>
      <li><code>POST /api/sync</code> — submit verified records (x-api-key)</li>
      <li><code>GET  /api/records</code> — recent records (x-api-key)</li>
      <li><code>GET  /admin?key=…</code> — <a href="/admin">operations console</a></li>
    </ul>
  </div>
</body></html>`);
});

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
  try {
    const records = await store.list(500);
    res.set('content-type', 'text/html').send(
      renderDashboard(records, store.kind),
    );
  } catch (e) {
    res
      .status(500)
      .send(`dashboard error: ${e instanceof Error ? e.message : 'unknown'}`);
  }
});

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
