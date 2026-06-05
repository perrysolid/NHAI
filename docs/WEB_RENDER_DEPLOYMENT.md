# Web Demo Deployment

The deployable demo is split intentionally:

- `web/` on Vercel: camera UI, browser-side model loading, liveness, enrollment,
  matching, local queue, and sync trigger.
- `backend/` on Render: sync target, record store, and simple admin dashboard.

Face images and descriptors are not uploaded during auth. The backend receives
only verified attendance records after sync.

## 1. Deploy Backend On Render

**Fastest:** use the included `render.yaml` Blueprint — in Render, choose
**New → Blueprint** and point it at this repo. It provisions the web service,
auto-generates `API_KEY` + `ADMIN_PASSCODE`, and only asks you to set
`CORS_ORIGIN`. (Uncomment the database block in `render.yaml` for a persistent
Postgres.)

**Or manually:** create a Render Web Service from this repository.

- Root Directory: `backend`
- Build Command: `npm ci && npm run build`
- Start Command: `npm start`
- Health Check Path: `/health`

Set environment variables:

```text
API_KEY=<shared secret>
ADMIN_PASSCODE=<dashboard passcode>
CORS_ORIGIN=https://<your-vercel-app>.vercel.app
DATABASE_URL=<optional postgres connection string>
```

If `DATABASE_URL` is empty, the backend runs with an in-memory store. That is
fine for a short demo, but records reset when the service restarts.

## 2. Deploy Frontend On Vercel

Create a Vercel project from this repository.

- Root Directory: `web`
- Framework Preset: Vite
- Build Command: `npm run build`
- Output Directory: `dist`

Set environment variables:

```text
VITE_SYNC_URL=https://<your-render-service>.onrender.com
VITE_SYNC_KEY=<same value as API_KEY>
```

The UI starts with `mock sync` enabled so a demo can show queue purge before the
backend is connected. Uncheck it to send real sync requests to Render.

## 3. Local Verification

```bash
cd backend
npm install
npm run build
npm start
```

```bash
cd web
npm install
npm run build
npm run test:e2e
```

Manual backend smoke test:

```bash
curl http://localhost:4000/health
curl -X POST http://localhost:4000/api/sync \
  -H 'Content-Type: application/json' \
  -H 'x-api-key: CHANGE_ME' \
  -d '{"records":[{"userId":"inspector_01","timestamp":1780655230110,"livenessPassed":true,"matchDistance":0.31,"deviceId":"web-test"}]}'
curl -H 'x-api-key: CHANGE_ME' http://localhost:4000/api/records
```
