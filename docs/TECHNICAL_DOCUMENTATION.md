# Technical Documentation — Datalake Face Auth

## Table of Contents

1. [System Overview](#1-system-overview)
2. [Repository Layout](#2-repository-layout)
3. [Mobile App (app/)](#3-mobile-app-app)
   - 3.1 Architecture
   - 3.2 Face Pipeline
   - 3.3 Active Liveness
   - 3.4 Passive Anti-Spoof
   - 3.5 Recognition
   - 3.6 Composite Scoring
   - 3.7 On-Device Geofencing
   - 3.8 Drowsiness & Attention Monitoring
   - 3.9 Offline Queue & Sync
   - 3.10 Escalation Lockout
   - 3.11 Configuration (config.ts)
   - 3.13 Bilingual TTS
   - 3.14 Testing
4. [Backend (backend/)](#4-backend-backend)
   - 4.1 Architecture
   - 4.2 API Reference
   - 4.3 Store Layer
   - 4.4 Auth & Admin
   - 4.5 Sites Provisioning
   - 4.6 Enrollment Registry
   - 4.7 SSR Dashboard
   - 4.8 Database Sharding
   - 4.9 Deployment
5. [Web Admin (web/)](#5-web-admin-web)
   - 5.1 Architecture
   - 5.2 Face Pipeline
   - 5.3 Admin Panels
6. [Security Framework](#6-security-framework)
   - 6.1 On-Device Anti-Spoof
   - 6.2 Escalation Lockout
   - 6.3 Backend Integrity Guard
   - 6.4 Rate Limiting
   - 6.5 API Authentication
   - 6.6 Encrypted Storage
7. [Datalake Integration](#7-datalake-integration)
   - 7.1 Data Flow
   - 7.2 Record Schema
   - 7.3 Analytics & KPIs
8. [Deployment](#8-deployment)
   - 8.1 Backend (Render / AWS)
   - 8.2 Web (Vercel)
   - 8.3 APK Build
9. [Fine-Tuning Pipeline](#9-fine-tuning-pipeline)
10. [Development Guide](#10-development-guide)
    - 10.1 Local Setup
    - 10.2 Adding a New Action
    - 10.3 Model Swaps

---

## 1. System Overview

Datalake Face Auth is an **offline-first face authentication system** for NHAI field
inspectors. It runs entirely on-device using bundled TFLite models, syncs
attendance records to the cloud when connectivity is available, and provides an
admin dashboard for operations monitoring.

**Key design decisions:**

- **100% offline auth** — face enrollment and verification happen on-device with
  no network required. The cloud never sees raw video, images, or embeddings.
- **Dual anti-spoofing** — passive (MiniFASNet screen/print detection) + active
  (randomized blink/smile/turn challenge) layered defence.
- **Offline-first sync** — attendance records queued in encrypted MMKV storage,
  pushed to backend when connectivity returns, purged only on server
  acknowledgement.
- **On-device geofencing** — GPS-based presence verification against cached
  admin-provisioned site data, fully offline.
- **Composite scoring** — weighted 0–100 trust score across recognition,
  liveness, alertness, pose, and illumination.
- **Bilingual** — Hindi/English UI and voice prompts for field use.

---

## 2. Repository Layout

| Path | Role | Stack |
|------|------|-------|
| `app/` | Primary deliverable — offline React Native app | RN 0.74, vision-camera, react-native-fast-tflite, ML Kit, MMKV |
| `web/` | Browser mirror with admin panels | Vite + React 19, @vladmandic/face-api |
| `backend/` | Sync target + admin API | Node + Express, PostgreSQL / Supabase |
| `finetune/` | EdgeFace-S fine-tuning for Indian face dataset | Python, ONNX, TFLite |
| `docs/` | Documentation, methodology, deployment guides | Markdown |

---

## 3. Mobile App (app/)

### 3.1 Architecture

```
Camera Feed
    │
    ▼
Face Detection (ML Kit)
    │
    ▼
Quality Gates (single face, pose, lighting)
    │
    ├── Enrollment Mode
    │   Walk through ALL 4 poses (fixed order)
    │   Capture embedding per pose → average → save locally
    │
    └── Verify Mode
        Randomised active challenge (2 of 4 actions)
        Passive MiniFASNet + Active challenge → Dual liveness
        Recognition (EdgeFace / MobileFaceNet)
        Geofence check (GPS vs cached site data)
        Composite score (0–100)
        Queue attendance record
            │
            ▼ (when network available)
        Sync POST → Backend guard → Purge on ack
```

**Key files:**

| File | Role |
|------|------|
| `src/screens/CameraScreen.tsx` | Main UI: enrollment, verification, settings, sync |
| `src/screens/GuidanceOverlay.tsx` | Alignment ring + instruction banner |
| `src/camera/qualityGates.ts` | Pre-verification quality checks |
| `src/camera/faceCrop.ts` | Face-centered crop with bilinear resampling |
| `src/camera/faceAlign.ts` | ArcFace 5-point similarity alignment |
| `src/face/engine.ts` | TFLite model loading + inference |
| `src/face/liveness.ts` | Active liveness challenge engine |
| `src/face/livenessActions.ts` | Action definitions (blink, smile, turn) |
| `src/face/attention.ts` | Drowsiness/inattention monitor |
| `src/face/math.ts` | L2 normalization, cosine similarity, embedding averaging |
| `src/face/scoring.ts` | Composite authentication score |
| `src/face/modelAssets.ts` | TFLite asset path mapping |
| `src/auth/offlineStore.ts` | Enrollment + attendance queue + lockout |
| `src/auth/mmkvStore.ts` | Encrypted MMKV-backed store |
| `src/sync/syncClient.ts` | Offline→online sync client |
| `src/sync/enrollmentClient.ts` | Best-effort enrollment push |
| `src/location/geofence.ts` | Haversine distance, point-in-polygon |
| `src/location/locationProvider.ts` | Native GPS abstraction |
| `src/location/provisioning.ts` | Admin site provisioning via API |
| `src/config.ts` | Single source of truth for all thresholds |

### 3.2 Face Pipeline

Three sub-systems run from each camera frame via `useFrameProcessor`:

1. **ML Kit Face Detection** — detects faces, returns bounding box + landmarks +
   probabilities (eye-open, smiling, yaw/pitch/roll).
2. **Quality Gates** — `evaluateFace()` checks: single face present, minimum
   face size (ratio ≥ 0.09), yaw/pitch within ±45°, brightness 25–252.
3. **Recognition + Liveness** — triggered when quality gates pass, runs:
   - `cropFace()` extracts face region from the downscaled medium buffer
   - `engine.embedFace()` + `engine.scoreLive()` run in parallel via
     `Promise.all` (recognition embedding + passive liveness score)

**Crop pipeline:**

- Medium buffer: 256px longest-edge downscale of the camera frame
- `cropFace()` uses the detector bounding box, expands by model-specific
  `cropExpansion` (1.25× for recognition, 2.7× for liveness), bilinear-resamples
  to model input size (112×112 or 80×80)
- `preprocessRgb()` applies per-channel normalization: `(pixel/255 - mean) / std`
- Supports BGR channel swap (required by MiniFASNet)
- Supports `float32` and `uint8` model dtypes

**Face alignment:**

`alignFace()` applies an ArcFace-style 5-point similarity transform using
least-squares. Maps detected landmarks to the canonical InsightFace template
(`ARCFACE_TEMPLATE_112`). Edge-clamped bilinear sampling handles out-of-bounds
pixels. Alignment is critical — without it genuine and impostor cosine
distributions overlap and no threshold cleanly separates them.

### 3.3 Active Liveness

**File: `src/face/liveness.ts` + `src/face/livenessActions.ts`**

A randomized challenge engine that defeats static photos and video replays:

- On each verify, selects a random **2-of-4** actions from the pool:
  `blink`, `smile`, `turnLeft`, `turnRight`
- Actions are presented one at a time in random order
- Each action has a dedicated satisfaction function:

| Action | Detection Method |
|--------|-----------------|
| **Blink** | 3-phase state machine: await_open → await_close → await_reopen. Requires the eye-open signal to span ≥ `livenessMotionRange` (0.2). A held photo stays flat and fails. |
| **Smile** | Threshold on ML Kit `smilingProbability` ≥ 0.5 |
| **Turn Left** | Baseline yaw at start + signed delta ≥ 12° in the correct direction |
| **Turn Right** | Same as turnLeft, opposite direction |

- Whole challenge must complete within `activeChallengeTimeoutMs` (30s)
- `evaluateDualLiveness()` combines passive + active: BOTH must pass for a
  trusted verification

### 3.4 Passive Anti-Spoof

**File: `src/face/engine.ts` → `scoreLive()`**

- Model: MiniFASNetV2-SE, 80×80×3 BGR input, 3-class softmax, live class index 1
- Runs on-device TFLite inference alongside recognition
- Score represents probability that the face is a live person (vs screen/print)
- **Currently advisory** — `FLAGS.REQUIRE_PASSIVE_LIVENESS = false` because the
  bundled model false-rejects real faces on this hardware. Only the active
  challenge is enforced.
- Screen-replay detection (`PASSIVE_SCREEN_BLOCK`) also disabled for the same
  reason. When enabled, rejects only when score is confidently below
  `livenessPassiveFloor` (0.3).

### 3.5 Recognition

**File: `src/face/engine.ts` → `embedFace()`**

One bundled recognition model, selected by `ACTIVE_RECOGNITION` in config.ts:

| Model | Input | Output | Params | Size | Status |
|-------|-------|--------|--------|------|--------|
| EdgeFace-S | 112×112×3 | 512-d embedding | 1.77M | 14.2 MB (float32) | **active, bundled** |
| MobileFaceNet | 112×112×3 | 192-d embedding | ~1M | — | spec placeholder, asset not bundled |

`RECOGNITION_ASSETS` in `face/modelAssets.ts` maps only `edgeface_s`; selecting
`mobilefacenet` throws at load. EdgeFace-S ships as float32, not INT8 — the switch
was deliberate, for match accuracy.

- Output is L2-normalized to unit length
- Matching via cosine similarity against stored enrollment templates
- Threshold: `recognitionCosine ≥ 0.65`

### 3.6 Composite Scoring

**File: `src/face/scoring.ts`**

Every signal is normalized to a 0–1 sub-score multiplied by a transparent weight:

| Component | Weight | Sub-score derivation |
|-----------|--------|---------------------|
| Recognition | 45% | Logistic sigmoid of cosine similarity (steepness=12) |
| Liveness | 25% | 1.0 if passed, 0.0 if failed |
| Alertness | 10% | EAR / (earClosed × 1.5); 0.4× multiplier if drowsy, 0.7× if looking away |
| Pose | 10% | Closeness to frontal: 1 − (|yaw| / maxYaw × 1.5) averaged with pitch |
| Illumination | 10% | Brightness near midpoint of range |

Overall = sum(component contribution). Scores below 70 are flagged `lowTrust`.

### 3.7 On-Device Geofencing

**Files: `src/location/geofence.ts`, `src/location/locationProvider.ts`**

- At verification time, device checks its GPS fix against cached site data
- **Circle sites**: haversine distance vs configured radius
- **Polygon sites**: ray-casting point-in-polygon test
- **Rejects**: mocked GPS (`isFromMockProvider`), low-accuracy reads (>50m),
  missing fix
- Result stamped on attendance record: `lat`, `lon`, `accuracyM`, `mocked`,
  `geofencePassed`, `siteId`, `distanceM`
- `GEOFENCE.enforce` flag controls whether geofence failure blocks verification
  (currently `false` — logged but not blocking)

### 3.8 Drowsiness & Attention Monitoring

**File: `src/face/attention.ts`**

Pure, deterministic rolling-window monitor using ML Kit eye landmarks:

| Metric | Method |
|--------|--------|
| EAR (Eye Aspect Ratio) | (leftEyeOpenProb + rightEyeOpenProb) / 2 |
| PERCLOS | Fraction of window (15s) with eyes closed |
| Blink rate | Blinks per minute within window |
| Sustained closure | Longest continuous eye closure |
| Look-away | Absolute yaw > 26° |

Feeds into the Alertness component of the composite authentication score.

### 3.9 Offline Queue & Sync

**File: `src/sync/syncClient.ts`**

1. Attendance records queued in encrypted MMKV storage (`OfflineAuthStore`)
2. On app start + whenever NetInfo reports connectivity, `syncPending()` runs:
   - Reads pending queue (capped at `SYNC.batchSize` = 50)
   - POSTs JSON payload to `SYNC.url` with `x-api-key` header
   - `toSyncPayload()` maps `AttendanceRecord[]` → `SyncRecord[]`:
     - Derives `matchDistance = 1 - matchScore`
     - Derives `livenessPassed` from field (if present) or threshold check
     - Includes optional confidence, score, latencyMs, and location fields
   - Backend returns `{acceptedRecords: [...]}`
   - Device **purges only acknowledged records** — no data loss
   - Unacknowledged records remain in queue and retry on next sync

**Enrollment push** (`sync/enrollmentClient.ts`): best-effort POST to
`/api/enroll`. Never blocks local enrollment on failure.

### 3.10 Escalation Lockout

**File: `src/auth/offlineStore.ts` → `recordLivenessAttempt()`**

- Tracks consecutive liveness failures within a 5-minute sliding window
- **5 failures** → lockout activates
- Escalating durations: 1m → 2m → 4m → 8m (2× each cycle)
- Lockout checked in `startVerify()` — shows countdown verdict
- Auto-loop in CameraScreen also skips verify while locked out
- Successful verification resets the counter
- Persisted via the key-value store (survives app restarts)

### 3.11 Configuration (config.ts)

All model specs, thresholds, and feature flags live in a single file:

```
FLAGS           — feature toggles (mock mode, passive liveness, screen block)
RECOGNITION     — model selection + hyperparameters
LIVENESS_MODEL  — MiniFASNet input spec
THRESHOLDS      — cosine cutoff, liveness thresholds, quality gates
LIVENESS_LOCKOUT — lockout parameters
DROWSINESS      — EAR, PERCLOS, blink rate cutoffs
SCORING         — weight distribution, review threshold
CAMERA          — FPS, buffer sizes, timing constants
SYNC            — URL + API key (from secrets.ts)
GEOFENCE        — accuracy, radius, enforcement flags
SITES           — default locations (admin-provisioned preferred)
```

### 3.12 Bilingual TTS

**File: `src/speech/tts.ts`**

- Uses `react-native-tts` for offline text-to-speech
- Bilingual prompts: Hindi primary, English fallback
- 2s dedup cooldown prevents overlapping speech
- Default language: Hindi (`hi-IN`)

### 3.13 Testing

76 unit tests across 14 suites:

| Suite | Tests | What it covers |
|-------|-------|----------------|
| `offlineStore.test.ts` | Store operations, lockout, queue management |
| `syncClient.test.ts` | Payload mapping, sync flow, purge logic |
| `liveness.test.ts` | Challenge state machine, timeout, satisfaction |
| `livenessActions.test.ts` | Blink state machine, turn detection, smile |
| `engine.test.ts` | Preprocessing, model shape validation, embedding |
| `math.test.ts` | Cosine similarity, L2 norm, embedding averaging |
| `scoring.test.ts` | Composite score, component breakdown |
| `attention.test.ts` | EAR, PERCLOS, blink rate, drowsiness detection |
| `geofence.test.ts` | Haversine, point-in-polygon, evaluateGeofence |
| `faceCrop.test.ts` | Crop dimensions, rotation, resampling |
| `qualityGates.test.ts` | Gate status for various conditions |
| `CameraScreen.test.tsx` | Integration: auto-enroll, auto-verify |
| `benchmark.test.ts` | Latency measurement |
| `lighting.test.ts` | Torch decision, contrast stretch |

---

## 4. Backend (backend/)

### 4.1 Architecture

```
POST /api/sync  ──►  apiKeyGuard  ──►  store.guard()  ──►  store.add()
                       │                   │
                       │                   ├── Score sanity [0,1]/[0,100]
                       │                   ├── Monotonic timestamp check
                       │                   ├── Cross-device timeline check
                       │                   └── Rate limit (30/min/deviceId)
                       │
                       └── If missing API_KEY → pass-through (demo mode)
```

### 4.2 API Reference

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/` | None | Service status page |
| `GET` | `/health` | None | Liveness probe → `{ok: true, store: "..."}` |
| `POST` | `/api/sync` | `x-api-key` | Accept attendance records, return ack |
| `GET` | `/api/records` | Admin | List recent attendance records |
| `POST` | `/api/admin/login` | None | Username/password → ephemeral bearer token |
| `POST` | `/api/enroll` | `x-api-key` | Register an inspector (embedding + metadata) |
| `GET` | `/api/enrollments` | Admin | List all enrollments (no embedding) |
| `GET` | `/api/enrollments/for/:userId` | `x-api-key` | Get single enrollment (with embedding) |
| `DELETE` | `/api/enrollments/:userId` | Admin | Remove enrollment |
| `GET` | `/api/roles` | Admin | List valid Datalake roles |
| `GET` | `/api/sites` | Admin | List geofence sites |
| `POST` | `/api/sites` | Admin | Create/update a geofence site |
| `DELETE` | `/api/sites/:id` | Admin | Remove a geofence site |
| `GET` | `/api/sites/for/:userId` | `x-api-key` | Get sites assigned to an inspector |
| `GET` | `/admin` | `ADMIN_PASSCODE` | Server-rendered operations console |

### 4.3 Store Layer

Three storage backends selected at startup via factory pattern:

| Backend | Selector | Features |
|---------|----------|----------|
| **SupabaseStore** | `SUPABASE_URL` + `SUPABASE_SERVICE_KEY` set | Upsert with `onConflict`, guard via individual queries |
| **PostgresStore** | `DATABASE_URL` set | Raw SQL, ON CONFLICT DO NOTHING, auto-migration |
| **MemoryStore** | Neither set | In-memory Map + Set, survives restarts only within process |

**Integrity guard (`guard()` method):**

- **Score sanity**: rejects scores outside [0,1] or [0,100], negative latency
- **Monotonic timestamps**: per (userId, deviceId) — rejects if a newer record
  already exists (prevents replay of old records)
- **Cross-device timeline**: if another device has already recorded a timestamp
  after this record's timestamp, reject (injection detection)
- **Rate limit**: max 30 records per minute per deviceId (rolling window)

**Attendance record schema (Postgres):**

```sql
CREATE TABLE attendance (
  user_id         TEXT NOT NULL,
  ts              BIGINT NOT NULL,
  device_id       TEXT NOT NULL,
  liveness_passed BOOLEAN NOT NULL,
  match_distance  DOUBLE PRECISION NOT NULL,
  confidence      DOUBLE PRECISION,
  score           DOUBLE PRECISION,
  latency_ms      INTEGER,
  metrics         JSONB,
  location        JSONB,
  PRIMARY KEY (user_id, ts, device_id)
);
```

### 4.4 Auth & Admin

**File: `src/auth.ts`**

Two independent authentication mechanisms:

1. **`apiKeyGuard`** — checks `x-api-key` header against `API_KEY` env var.
   Used by device-facing endpoints (sync, enroll, device-pull). Disabled when
   `API_KEY` is unset (demo mode).

2. **`adminGuard`** — checks `x-api-key` against an in-memory set of admin
   session tokens. Tokens are generated via `POST /api/admin/login` with
   `ADMIN_USER`/`ADMIN_PASSWORD` credentials. The admin token is separate from
   the device API key so the key baked into the app binary does not grant admin
   access (`generateAdminToken()` creates a 64-char hex token).

### 4.5 Sites Provisioning

**File: `src/sites.ts`**

Geofence site store with the same three-backend pattern. Sites define:

```typescript
interface Site {
  id: string;
  name: string;
  assignedUserId: string;
  role: 'authority-engineer' | 'contractor' | 'piu' | 'regional-officer' | 'consultant';
  shape: { kind: 'circle'; center: { lat: number; lon: number }; radiusM: number };
  updatedAt: number;
}
```

Devices fetch their assigned sites via `GET /api/sites/for/:userId` and cache
them locally in MMKV for offline geofencing.

### 4.6 Enrollment Registry

**File: `src/enrollments.ts`**

Stores inspector enrollment data. Enrollment records contain:

```typescript
interface Enrollment {
  userId: string;
  name: string;
  role: string;
  embedding: number[];      // float array
  deviceId: string;
  samples: number;
  enrolledAt: number;
}
```

Devices push enrollments via `POST /api/enroll` (best-effort, never blocks
local enrollment). The admin views a summary list (omitting embedding vectors)
via `GET /api/enrollments`. Devices pull full enrollments (including embedding)
via `GET /api/enrollments/for/:userId` for offline verification.

### 4.7 SSR Dashboard

**File: `src/dashboard.ts`**

Server-side rendered HTML operations console (`GET /admin?key=...`). No client
framework. Dark theme with IBM Plex Mono/Sans fonts. Displays:

- **KPI cards**: Total events, subjects, avg auth score, liveness pass rate,
  attacks blocked, avg match distance, drowsy events, look-away events
- **Sparkline bar charts**: match distance + authentication score trends
- **Inspection ledger table**: per-row color coding (red for attacks/drowsy,
  amber for warnings). Columns include subject, time, liveness, score, distance,
  EAR, PERCLOS, blink rate, yaw/lighting, site/GPS, inspection flags, device ID
- Auto-refresh every 15 seconds

### 4.8 Database Sharding

**File: `src/migrate-partitions.sql`**

PostgreSQL migration for horizontal scaling:

- Partitions `attendance` by `HASH (user_id)` into 8 partitions (p0–p7)
- Each partition has its own primary key constraint
- Backfills data from the non-partitioned table
- Enables parallel query execution across partitions for large-scale deployments

### 4.9 Deployment

- **Render**: One-click via `render.yaml`. Build: `npm ci && npm run build`,
  Start: `npm start`. Environment: `API_KEY`, `ADMIN_PASSCODE`, `CORS_ORIGIN`,
  `DATABASE_URL`.
- **AWS**: Dockerfile + apprunner.yaml for App Runner. Same environment vars.
  Also deployable to ECS/Fargate, Elastic Beanstalk, or EC2.

---

## 5. Web Admin (web/)

### 5.1 Architecture

Vite + React 19 browser mirror of the native app, plus admin panels. Uses
`@vladmandic/face-api` (TensorFlow.js-based) for face detection, 128-d
descriptors, and expression analysis in the browser.

**Key files:**

| File | Role |
|------|------|
| `src/lib/config.ts` | Mirrors native config.ts for the browser |
| `src/lib/scoring.ts` | Composite scoring (same weights as native) |
| `src/lib/syncClient.ts` | Browser sync client to backend |
| `src/face/liveness.ts` | Active liveness (browser implementation) |
| `src/face/pipeline.ts` | Face pipeline orchestration |
| `src/ui/CameraStage.tsx` | Camera preview + overlay |
| `src/ui/useCamera.ts` | Webcam hook |
| `src/ui/AdminLogin.tsx` | Admin authentication |
| `src/ui/AttendanceAdmin.tsx` | Attendance records management |
| `src/ui/InspectorsAdmin.tsx` | Inspector enrollment management |
| `src/ui/GeofencingAdmin.tsx` | Geofence site CRUD |
| `src/ui/InspectionPanel.tsx` | Sync queue + operations view |
| `src/ui/ScoreBreakdown.tsx` | Authentication score component chart |
| `src/ui/StatStrip.tsx` | Live stats bar |
| `src/ui/AdminShell.tsx` | Admin layout shell |

### 5.2 Face Pipeline

- Face detection + 128-d descriptor extraction + expression analysis via
  `@vladmandic/face-api` (TensorFlow.js backend)
- Active liveness: blink (eye-open tracking), smile (expression score), head
  turn (yaw tracking) — same semantics as native
- Recognition: Euclidean distance on 128-d descriptors (threshold 0.5)
- Quality gates: min face ratio 0.18, yaw/pitch ±30°, brightness 55–235
- Composite scoring: identical weights and logic to native (`scoring.ts`)

### 5.3 Admin Panels

- **AttendanceAdmin**: view and search synced attendance records, filter by
  date/device/status
- **InspectorsAdmin**: view, register, edit, and delete inspector enrollments
- **GeofencingAdmin**: CRUD for geofence sites (circle shape with center +
  radius). Supports assigning inspectors to sites.
- **InspectionPanel**: monitor sync queue, posture, and device health
- **ScoreBreakdown**: visual breakdown of composite score components

---

## 6. Security Framework

### 6.1 On-Device Anti-Spoof

Three-layer defence:

1. **Active liveness challenge** — random subset of blink/smile/turn, one at a
   time, random order. A pre-recorded video cannot match an unanticipated
   sequence. Static photos fail the blink motion-range gate.
2. **Passive MiniFASNet** — texture analysis detects screen/print replay. BGR
   channel-order input (model trained on BGR data). Screen-replay detection
   (`PASSIVE_SCREEN_BLOCK`) available but currently disabled pending calibration.
3. **Quality gates** — single-face requirement, pose limits, brightness range.
   Prevents trivial bypasses (profile view, too dark/bright).

### 6.2 Escalation Lockout

- 5 consecutive liveness failures within 5 minutes → lockout
- Lockout duration escalates: 1m → 2m → 4m → 8m (2× each occurrence)
- Persisted in MMKV — survives app restarts
- Checked at verify-start: shows countdown verdict while locked out
- Successful verify resets the counter
- The auto-verify loop respects lockout (no repeated verdict flashing)

### 6.3 Backend Integrity Guard

The `guard()` method in `store.ts` validates every incoming sync payload:

- **Score sanity**: all numerical fields within expected ranges
- **Monotonic timestamps**: per (userId, deviceId) pair — prevents replay of
  old records that could overwrite newer ones
- **Cross-device timeline detection**: if device A sends a record with
  `timestamp=100` but device B has already recorded `timestamp=110` for the
  same user, the record from device A is rejected (injection attack detection)
- **Rate limit**: 30 records per minute per deviceId — prevents bulk injection
- Rejected records are returned as `rejected` in the sync response — the device
  does NOT purge them, so retry safety is maintained

### 6.4 Rate Limiting

- **On-device**: escalation lockout (5 failures → exponential backoff)
- **Backend**: 30 records/minute per deviceId in `store.guard()`
- Both are independent: the backend rate limit catches cases where the device
  lockout has been bypassed or tampered with

### 6.5 API Authentication

- **Device API key** (`x-api-key` env var): shared secret baked into the app
  binary via `secrets.ts`. Authenticates device→backend calls.
- **Admin session token**: ephemeral 64-char hex token, generated on login via
  `POST /api/admin/login` with `ADMIN_USER`/`ADMIN_PASSWORD`. Independent of
  the device API key — compromise of the baked-in key does not grant admin
  access.
- **Admin passcode** (`ADMIN_PASSCODE` env var): query-parameter auth for the
  SSR dashboard (`/admin?key=...`)
- All guards are **disabled when env vars are unset** — quick demo deploys work
  without auth.

### 6.6 Encrypted Storage

- On-device enrollment + queue storage uses `react-native-mmkv` with encryption
- Encryption key derived from device keychain
- Face embeddings are stored, never full images
- Attendance queue is encrypted at rest

---

## 7. Datalake Integration

### 7.1 Data Flow

```
Device (offline queue)
    │
    ├── [Network returns] POST /api/sync
    │       │
    │       ▼
    │   Backend guard() → validate → store
    │       │
    │       ▼
    │   Returns { acceptedRecords: [...] }
    │       │
    │       ▼
    │   Device purges only acknowledged records
    │
    ├── [Best-effort] POST /api/enroll
    │       │
    │       ▼
    │   Backend adds to enrollment registry
    │
    └── [On mount / foreground] GET /api/sites/for/:userId
            │
            ▼
        Cache sites locally for offline geofencing
```

### 7.2 Record Schema

Each attendance record contains:

| Field | Type | Description |
|-------|------|-------------|
| `userId` | string | Inspector identifier |
| `timestamp` | number | Epoch ms of verification |
| `deviceId` | string | Unique device identifier (`rn-` + random) |
| `livenessPassed` | boolean | Whether the liveness challenge passed |
| `matchScore` | number | Cosine similarity of face match |
| `matchDistance` | number | `1 - matchScore` (for backend) |
| `confidence` | number (opt) | Recognition confidence (logistic sigmoid) |
| `score` | number (opt) | Composite authentication score (0–100) |
| `latencyMs` | number (opt) | End-to-end verification latency |
| `lat` | number (opt) | GPS latitude |
| `lon` | number (opt) | GPS longitude |
| `accuracyM` | number (opt) | GPS accuracy in meters |
| `mocked` | boolean (opt) | Whether GPS was mocked/spoofed |
| `geofencePassed` | boolean (opt) | Whether the location passed geofence check |
| `siteId` | string (opt) | Nearest matched site identifier |
| `distanceM` | number (opt) | Distance to nearest site in meters |

### 7.3 Analytics & KPIs

The backend SSR dashboard computes:

- **Total events**: number of synced attendance records
- **Unique subjects**: distinct userIds seen
- **Avg auth score**: mean composite score across all records
- **Liveness pass rate**: fraction of records with `livenessPassed = true`
- **Attacks blocked**: count of records with `livenessPassed = false`
- **Avg match distance**: mean of `1 - matchScore`
- **Drowsy events**: count of records with `inspection.drowsy = true`
- **Look-away events**: count of records with `inspection.lookingAway = true`
- **Match distance sparkline**: bar chart of recent match distances
- **Auth score sparkline**: bar chart of recent authentication scores

---

## 8. Deployment

### 8.1 Backend (Render / AWS)

**Render** — one-click via `render.yaml`:

```yaml
# render.yaml — root of repo
services:
  - type: web
    name: datalake-face-sync
    env: node
    rootDir: backend
    buildCommand: npm ci && npm run build
    startCommand: npm start
    envVars:
      - key: API_KEY
        sync: false
      - key: ADMIN_PASSCODE
        sync: false
      - key: CORS_ORIGIN
        value: https://your-app.vercel.app
      - key: DATABASE_URL
        sync: false
```

**AWS** — Docker multi-stage build (`backend/Dockerfile`):

```
FROM node:20-alpine AS build
# npm ci + tsc
FROM node:20-alpine AS runtime
# npm ci --omit=dev + dist/ only
HEALTHCHECK --interval=30s --timeout=3s CMD fetch('/health')
```

Also supports App Runner via `backend/apprunner.yaml`.

### 8.2 Web (Vercel)

- Framework: Vite + React
- Deploy via `vercel --prod` or GitHub integration
- Environment: `VITE_SYNC_URL`, `VITE_SYNC_KEY`
- Demo routes: `/` (auth), `/operations` (queue/sync), `/deployment` (status),
  `/aws` (setup guide)

### 8.3 APK Build

```bash
cd app/android
./gradlew assembleRelease
# Outputs: app/android/app/build/outputs/apk/release/
#   app-universal-release.apk  (70 MB)
#   app-arm64-v8a-release.apk  (51 MB)
#   app-armeabi-v7a-release.apk (41 MB)
```

---

## 9. Fine-Tuning Pipeline

Located in `finetune/`. Fine-tunes EdgeFace-S on the Indian Face Dataset (9,708
identities, 27k+ images extracted from Wikidata/Wikimedia Commons).

**Architecture:**
- Backbone: EdgeFace-S (`edgeface_s_gamma_05`, 3.65M params, 512-d output)
- Loss: ArcFace (s=32, m=0.5)
- Schedule: 5 epochs head-only warmup → 25 epochs full fine-tune
- Optimizer: AdamW, backbone lr 1e-4, head lr 1e-3, cosine decay
- Input: 112×112×3 float32, mean/std 0.5
- Export: ONNX opset13 → TFLite (fp16 verified, fp32 fallback)

**Dataset coverage:** 36 states & UTs across India, real portrait photos of
public figures.

**Benchmark:** 85.71% verification accuracy on held-out identities (42 genuine +
42 impostor pairs, ROC-AUC 0.88).

---

## 10. Development Guide

### 10.1 Local Setup

```bash
# Mobile app
cd app
npm install
npx react-native run-android   # JDK 17 + emulator/device
# or
cd ios && pod install && cd .. && npx react-native run-ios

# Backend
cd backend
npm install
cp .env.example .env           # fill in secrets
npm run build && npm start

# Web admin
cd web
npm install
cp .env.example .env           # fill in VITE_SYNC_URL / VITE_SYNC_KEY
npm run dev
```

### 10.2 Adding a New Liveness Action

1. Add the action name to `LIVENESS_ACTION_KINDS` in `livenessActions.ts`
2. Add detection logic in `isActionSatisfied()`
3. Add to `ActionState` interface if state tracking needed
4. Add bilingual prompt text in `i18n.ts` (`LIVENESS_TEXT`)
5. The action is automatically available for enrollment (fixed order) and
   verification (randomized) — no other code changes needed

### 10.3 Swapping a Recognition Model

One-line change in `config.ts`:

```typescript
export const ACTIVE_RECOGNITION: RecognitionModelId = 'edgeface_s';
// swap to: 'mobilefacenet'
```

Then update:
1. Add the model spec to `RECOGNITION_MODELS` (input size, embedding length,
   normalization, crop expansion)
2. Place the TFLite file in `app/assets/models/`
3. Add the require path in `face/modelAssets.ts`
4. The rest of the pipeline adapts automatically

---

## Appendix: Key Metrics

| Metric | Value |
|--------|-------|
| Model size (combined) | 19.9 MB (EdgeFace-S 14.2 + MiniFASNetV2 5.7) |
| Recognition latency | < 1s on mid-range device |
| Face detection | ML Kit (native), TensorFlow.js (web) |
| Active challenge time | per-action deadline 4s blink/smile, 5s turns; 30s whole-attempt backstop |
| Offline queue | Encrypted MMKV |
| Sync batch size | 50 records |
| Rate limit | 30/min per device (backend) |
| Lockout threshold | 5 consecutive failures |
| Lockout escalation | 1m → 2m → 4m → 8m |
| Geofence accuracy | 50m max, 150m pin radius |
| Database sharding | 8 partitions by HASH(user_id) |
| Test coverage | 76 unit tests + Playwright E2E |

---

## Appendix: File Index

### App (app/src/)

| File | Lines | Purpose |
|------|-------|---------|
| `CameraScreen.tsx` | 2678 | Main UI: enrollment, verify, settings, sync |
| `GuidanceOverlay.tsx` | 124 | Alignment ring + instruction overlay |
| `config.ts` | 318 | Central configuration |
| `offlineStore.ts` | 307 | Store + enrollment + queue + lockout |
| `engine.ts` | 277 | TFLite inference abstraction |
| `geofence.ts` | 206 | Offline geospatial math |
| `faceAlign.ts` | 162 | 5-point similarity alignment |
| `syncClient.ts` | 137 | Offline→online sync |
| `liveness.ts` | 130 | Active challenge engine |
| `livenessActions.ts` | 104 | Action definitions + satisfaction |
| `attention.ts` | 118 | Drowsiness/inattention monitor |
| `scoring.ts` | 111 | Composite authentication score |
| `faceCrop.ts` | 115 | Face crop with bilinear resampling |
| `locationProvider.ts` | 82 | Native GPS abstraction |
| `i18n.ts` | 49 | Bilingual dictionary |
| `types.ts` (camera) | 73 | Face, gate, landmark types |
| `types.ts` (location) | 74 | GPS, site, geofence types |
| `math.ts` | 71 | L2 norm, cosine, embedding ops |
| `qualityGates.ts` | 64 | Pre-verify quality checks |
| `provisioning.ts` | 74 | Admin site provisioning API |
| `liveness.test.ts` | — | Challenge state machine tests |
| `livenessActions.test.ts` | — | Action satisfaction tests |
| `scoring.test.ts` | — | Composite score tests |

### Backend (backend/src/)

| File | Lines | Purpose |
|------|-------|---------|
| `store.ts` | 563 | Attendance store (3 backends) + guard |
| `index.ts` | 301 | Express app + route definitions |
| `dashboard.ts` | 286 | SSR operations console |
| `sites.ts` | 271 | Geofence site store (3 backends) |
| `enrollments.ts` | 242 | Enrollment registry (3 backends) |
| `auth.ts` | 71 | API key + admin token guards |

### Web (web/src/)

| File | Lines | Purpose |
|------|-------|---------|
| `App.tsx` | — | Root component |
| `config.ts` | 108 | Browser config (mirrors native) |
| `scoring.ts` | 91 | Composite scoring (mirrors native) |
| `CameraStage.tsx` | — | Camera preview component |
| `AttendanceAdmin.tsx` | — | Attendance records admin panel |
| `InspectorsAdmin.tsx` | — | Inspector enrollment panel |
| `GeofencingAdmin.tsx` | — | Geofence site admin panel |
