# DatalakeFaceAuth Web Demo

Vercel-ready browser demo for the NHAI Datalake 3.0 offline face-auth flow.

Face detection, liveness, enrollment, and matching run in the browser with
`@vladmandic/face-api`. The app stores descriptors and the pending attendance
queue in `localStorage` for demo purposes; it only sends verified attendance
records to the sync backend.

## Local Run

```bash
npm install
npm run dev
```

Set these only when testing real backend sync:

```bash
cp .env.example .env
# VITE_SYNC_URL=http://localhost:4000
# VITE_SYNC_KEY=the same value as backend API_KEY
```

The UI starts in mock-sync mode so the sync -> purge lifecycle works even before
the Render backend is deployed. Uncheck `mock sync` to send records to
`VITE_SYNC_URL`.

## Verification

```bash
npm run build
npm run test:e2e
```

Playwright uses Chromium's fake camera. It verifies production model loading,
camera startup, input guards, and local sync-purge behavior.

## Vercel

Create a Vercel project with Root Directory set to `web`.

- Build command: `npm run build`
- Output directory: `dist`
- Environment variables:
  - `VITE_SYNC_URL`: deployed Render backend URL
  - `VITE_SYNC_KEY`: same shared secret as backend `API_KEY`
