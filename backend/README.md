# DatalakeFaceAuth Sync Backend

Express backend deployable on AWS or Render. It is not in the authentication
path: devices or browsers authenticate faces locally, then sync verified
attendance records here when online.

## Endpoints

- `GET /health`
- `POST /api/sync` with `{ "records": [...] }`
- `GET /api/records`
- `GET /admin?key=ADMIN_PASSCODE`

`/api/sync` and `/api/records` use `x-api-key` when `API_KEY` is set. If
`API_KEY` is unset, auth is disabled for quick demos.

## Local Run

```bash
npm install
cp .env.example .env
npm run build
npm start
```

Without `DATABASE_URL`, the service uses an in-memory store. Set `DATABASE_URL`
to a managed Postgres connection string on AWS or Render for durable storage.

## Render

Create a Render Web Service with Root Directory set to `backend`.

- Build command: `npm ci && npm run build`
- Start command: `npm start`
- Environment variables:
  - `API_KEY`: shared secret expected from the web frontend
  - `ADMIN_PASSCODE`: query key for `/admin`
  - `CORS_ORIGIN`: Vercel frontend origin, for example `https://your-app.vercel.app`
  - `DATABASE_URL`: optional Postgres URL

## AWS

The same service can run behind API Gateway/Lambda, ECS/Fargate, or Elastic
Beanstalk. Keep `API_KEY`, `ADMIN_PASSCODE`, `CORS_ORIGIN`, and `DATABASE_URL`
as environment variables, then point the native `SYNC.url` to
`https://YOUR-SYNC-ENDPOINT/api/sync`.
