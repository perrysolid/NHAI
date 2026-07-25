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
import {createSitesStore, sanitizeSite, ROLES} from './sites.js';
import {renderDashboard} from './dashboard.js';

const app = express();
const store = createStore();
const sitesStore = createSitesStore();

// Tolerate trailing slashes and a comma-separated list of allowed origins, so a
// stray "https://app.vercel.app/" in CORS_ORIGIN doesn't silently block the SPA.
const stripSlash = (s: string) => s.trim().replace(/\/+$/, '');
const allowedOrigins = stripSlash(process.env.CORS_ORIGIN ?? '*')
  .split(',')
  .map(stripSlash)
  .filter(Boolean);
const corsOrigin =
  allowedOrigins.includes('*') || allowedOrigins.length === 0
    ? '*'
    : (
        origin: string | undefined,
        cb: (err: Error | null, allow?: boolean) => void,
      ) => {
        // Non-browser callers (no Origin header) and matching origins are allowed.
        cb(null, !origin || allowedOrigins.includes(stripSlash(origin)));
      };
app.use(
  cors({
    origin: corsOrigin,
    methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'x-api-key'],
  }),
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
    const acceptedRecords = await store.add(records);
    res.json({
      ok: true,
      accepted: acceptedRecords.length,
      received: records.length,
      acceptedRecords,
    });
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

// ── Admin login ──
// Simple username/password check against env, returning the API key the
// dashboard then sends as x-api-key on admin calls. (Supabase-backed admin
// accounts can replace this later without changing the client contract.)
app.post('/api/admin/login', (req, res) => {
  const username = String(req.body?.username ?? '');
  const password = String(req.body?.password ?? '');
  const U = process.env.ADMIN_USER;
  const P = process.env.ADMIN_PASSWORD;
  if (!U || !P) {
    res.status(500).json({
      ok: false,
      error: 'admin login not configured — set ADMIN_USER and ADMIN_PASSWORD',
    });
    return;
  }
  if (username === U && password === P) {
    res.json({ok: true, token: process.env.API_KEY ?? ''});
  } else {
    res.status(401).json({ok: false, error: 'invalid username or password'});
  }
});

// ── Geofence sites (admin provisioning + device pull) ──
// The role list feeds the admin form's dropdown.
app.get('/api/roles', (_req, res) => {
  res.json({ok: true, roles: ROLES});
});

// Admin: list every provisioned site.
app.get('/api/sites', apiKeyGuard, async (_req, res) => {
  try {
    res.json({ok: true, sites: await sitesStore.list()});
  } catch (e) {
    res.status(500).json({ok: false, error: e instanceof Error ? e.message : 'db error'});
  }
});

// Admin: create or update a site (assign a circular zone to an inspector).
app.post('/api/sites', apiKeyGuard, async (req, res) => {
  const site = sanitizeSite(req.body);
  if (!site) {
    res.status(400).json({
      ok: false,
      error: 'invalid site: need name, assignedUserId and a circle shape {center:{lat,lon}, radiusM>0}',
    });
    return;
  }
  try {
    res.json({ok: true, site: await sitesStore.upsert(site)});
  } catch (e) {
    res.status(500).json({ok: false, error: e instanceof Error ? e.message : 'db error'});
  }
});

// Admin: delete a site.
app.delete('/api/sites/:id', apiKeyGuard, async (req, res) => {
  try {
    res.json({ok: true, deleted: await sitesStore.remove(req.params.id)});
  } catch (e) {
    res.status(500).json({ok: false, error: e instanceof Error ? e.message : 'db error'});
  }
});

// Device: pull the site(s) assigned to this inspector, to cache offline.
app.get('/api/sites/for/:userId', apiKeyGuard, async (req, res) => {
  try {
    res.json({ok: true, sites: await sitesStore.forUser(req.params.userId)});
  } catch (e) {
    res.status(500).json({ok: false, error: e instanceof Error ? e.message : 'db error'});
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
Promise.all([store.init(), sitesStore.init()])
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
