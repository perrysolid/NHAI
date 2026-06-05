# AWS Deployment — Sync Backend

The problem statement calls for sync to an **AWS server** once connectivity
returns. The backend in `backend/` is a standard stateful Express service, so it
runs unchanged on any AWS container/host. Nothing in the device auth path depends
on it — it only receives verified attendance records and purges happen client-side
after a 200.

The frontend (Vercel) targets whichever URL you pick via `VITE_SYNC_URL`; the
device sends `x-api-key: <API_KEY>`.

---

## Option A — AWS App Runner (recommended, simplest)

Source-based deploy using the committed `backend/apprunner.yaml` — no container
registry, no servers to manage, scales to zero-ish on low traffic.

1. AWS Console → **App Runner** → **Create service**.
2. Source: **Source code repository** → connect GitHub → this repo.
3. **Source directory:** `backend`. Deployment trigger: automatic.
4. Build settings: **Use a configuration file** (it reads `apprunner.yaml`).
5. Port: **4000** (already declared in `apprunner.yaml`).
6. Add runtime environment variables:
   ```
   API_KEY=<shared secret>          # mirror into frontend VITE_SYNC_KEY
   ADMIN_PASSCODE=<dashboard passcode>
   CORS_ORIGIN=https://<your-vercel-app>.vercel.app
   DATABASE_URL=<optional RDS Postgres URL>   # omit → in-memory store
   ```
7. Health check path: `/health`. Create & deploy.
8. Copy the App Runner URL (e.g. `https://xxxx.us-east-1.awsapprunner.com`) into
   Vercel's `VITE_SYNC_URL`.

## Option B — Elastic Beanstalk (Docker) or ECS/Fargate / EC2

Use the committed `backend/Dockerfile` (multi-stage, prod-only runtime image).

- **Elastic Beanstalk:** create a Docker platform environment, deploy the
  `backend/` folder (EB builds the Dockerfile). Set the same env vars above. EB
  injects `PORT`; the app honors it.
- **ECS/Fargate / App Runner (image):** build & push to ECR:
  ```bash
  cd backend
  docker build -t datalake-face-sync .
  # aws ecr create-repository --repository-name datalake-face-sync
  # docker tag + docker push to your ECR URI, then point the service at it
  ```
  Container listens on `PORT` (default 4000); map it and set env vars.
- **EC2:** `docker run -p 80:4000 --env-file .env datalake-face-sync` behind a
  load balancer / nginx.

## Persistence (RDS)

Set `DATABASE_URL` to an **Amazon RDS for PostgreSQL** connection string. The
backend auto-creates the `attendance` table on boot and dedupes on
`(userId, timestamp, deviceId)`. Without `DATABASE_URL` it uses an in-memory
store (fine for a short demo; data resets on restart).

> SSL: the Postgres client enables `ssl: { rejectUnauthorized: false }` for
> non-localhost hosts, which works with RDS default certs.

## Verify after deploy

```bash
curl https://<your-aws-url>/health
curl -X POST https://<your-aws-url>/api/sync \
  -H 'Content-Type: application/json' -H 'x-api-key: <API_KEY>' \
  -d '{"records":[{"userId":"inspector_01","timestamp":1780655230110,"livenessPassed":true,"matchDistance":0.31,"deviceId":"rn-01"}]}'
curl -H 'x-api-key: <API_KEY>' https://<your-aws-url>/api/records
# dashboard: https://<your-aws-url>/admin?key=<ADMIN_PASSCODE>
```
