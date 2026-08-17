<div align="center">

<img src="docs/assets/banner.svg" alt="Datalake Face Auth — secure offline facial recognition and liveness detection" width="920" />

<br/><br/>

![React Native](https://img.shields.io/badge/React_Native-0.74-20232a?style=for-the-badge&logo=react)
![Android](https://img.shields.io/badge/Android_8.0+-3ddc84?style=for-the-badge&logo=android&logoColor=white)
![iOS](https://img.shields.io/badge/iOS_15.5+-000000?style=for-the-badge&logo=apple)
![Offline](https://img.shields.io/badge/Auth-100%25_offline-38e0a5?style=for-the-badge)
![Models](https://img.shields.io/badge/Models-19.9_MB-38e0a5?style=for-the-badge)

### &nbsp;[▶ Live demo](https://nhai-three.vercel.app)&nbsp; · &nbsp;[⬇ Download APK](https://github.com/perrysolid/NHAI/raw/main/docs/deliverables/DatalakeFaceAuth-android-universal-release.apk)&nbsp; · &nbsp;[Demo video](https://drive.google.com/drive/folders/14rTxUjJ_Wrdt349yWkksgE51m87zO97d?usp=sharing)&nbsp;

<sub>NHAI Innovation Hackathon 7.0 · Datalake 3.0 &nbsp;|&nbsp; MIT / Apache-2.0 &nbsp;|&nbsp; [package notes](docs/deliverables/README.md)</sub>

</div>

---

> **Note for judges.** The mandatory, spec-compliant deliverable is the **React Native app** in [`app/`](app) — it runs face detection, a randomized liveness challenge, and recognition **fully on-device** with bundled TFLite models. The **Vercel browser app** mirrors the same pipeline for instant demonstration (no install).

## Judges flow (NHAI Hackathon 7.0)

1. **Install** the offline APK on any Android 8+ phone — [download](https://github.com/perrysolid/NHAI/raw/main/docs/deliverables/DatalakeFaceAuth-android-universal-release.apk) (`adb install -r ...universal-release.apk`).
2. **Enroll** — tap *Enroll*, enter or generate an inspector ID, then just **center your face in the ring**. It turns **green** the moment your face is centered and all 3 samples **auto-capture** — no buttons to press — saving the template **on the phone**.
3. **Verify** — tap *Verify* and **center your face**; verification **starts automatically** (no tap). Complete the random liveness prompts (**blink / smile / turn**, random order). Match returns in **< 1s**, with an authentication score — all on-device.

> **Fully hands-free.** Capture and verification trigger automatically once your face is centred (the ring turns green) — you never tap a capture/verify button. The on-screen *Capture* / *Start verify* buttons remain only as a manual fallback.
4. **Spoof test** — hold up a **photo or a video on another phone**: liveness is **rejected** (it can't complete the live random sequence).
5. **Offline proof** — turn on **airplane mode** and repeat steps 2–3: enrolment and verification still work; nothing leaves the device.
6. **No install?** Open the [browser demo](https://nhai-three.vercel.app) to try the same pipeline instantly. *(Demonstration only; the APK is the deliverable.)*

## The problem

> *"How can we accurately and securely authenticate field personnel using facial recognition and liveness detection on standard mid-range mobile devices without any active internet connection, while ensuring the AI model remains lightweight and seamlessly integrates with a React Native application on both Android and iOS devices?"*

## Architecture

```mermaid
flowchart LR
  subgraph DEVICE["DEVICE — fully offline, on-device"]
    CAM[Camera] --> DET[Face detection - ML Kit]
    DET --> GATE[Quality gates<br/>one face / pose / lighting]
    GATE --> LIVE[Liveness<br/>passive MiniFASNet + randomized blink/smile/head-turn]
    LIVE --> REC[Recognition<br/>EdgeFace / MobileFaceNet TFLite]
    REC --> SCORE[Composite Authentication Score]
    SCORE --> Q[(Encrypted local queue)]
    ATT[Drowsiness / attention monitor] -.-> SCORE
  end
  Q -->|only when network returns| API[POST api/sync]
  subgraph CLOUD["AWS / Render — never in the auth path"]
    API --> DB[(Postgres / memory)]
    API --> PURGE[Device purges local queue]
  end
```

The cloud side is **only** an offline→online sync target for the sync-and-purge step. No recognition ever happens server-side; the device decides authentication entirely offline, then syncs the verified record and purges locally.

## Authentication pipeline

```mermaid
flowchart TD
  A[Position face] --> B{Quality gates pass?}
  B -- no --> A
  B -- yes --> C[Randomized liveness<br/>blink + smile + head-turn, random order]
  C -- fail/timeout --> X[Presentation attack blocked<br/>record + counter]
  C -- pass --> D[Compute 512-d embedding]
  D --> E[Cosine match vs enrolled template]
  E --> F[Composite Authentication Score 0-100]
  F --> G{Match and score sufficient?}
  G -- yes --> H[Queue attendance + inspection metrics]
  G -- no --> I[No match]
  H --> J[Sync to AWS/Render then purge]
```

## Composite Authentication Score

Instead of a single distance number, every signal is normalized to a sub-score, multiplied by a transparent weight, and summed into one **Authentication Score (0–100)**:

```mermaid
pie showData
  title Score weighting
  "Recognition" : 45
  "Liveness" : 25
  "Alertness" : 10
  "Pose" : 10
  "Lighting" : 10
```

Weights live in `config.ts` (`SCORING`) and are identical on native and web (`app/src/face/scoring.ts`, `web/src/lib/scoring.ts`). Scores below 70 are flagged **low-trust** for review.

## Requirement compliance

| # | Requirement | Status | Where |
|---|-------------|--------|-------|
| 1 | React Native, Android **and** iOS | Met (Android release APK builds; iOS project included) | [`app/`](app) |
| 2 | Lightweight model ~20 MB | **19.9 MB** TFLite (EdgeFace-S 14.2 float32 + MiniFASNetV2 5.7) | [`app/assets/models`](app/assets/models) |
| 3 | < 1 s recognize + liveness | On-device latency budget shown per verify; benchmark hooks | `benchmark/`, web stat strip |
| 4 | Android 8.0+, no GPU, 3 GB RAM | `minSdk 26`, CPU TFLite delegate, ABI-split APKs | `android/` |
| 5 | > 95% accuracy, Indian demographics, outdoor light | Compact ArcFace baseline; quality gates bound pose, face size and exposure, and illumination feeds the composite score. IndicFairFace fine-tune documented as the next step | [`docs/NHAI_HACKATHON_ALIGNMENT.md`](docs/NHAI_HACKATHON_ALIGNMENT.md) |
| 6 | Open-source only, source shared | All deps MIT / Apache-2.0; full source in repo | this repo |
| D1 | Working cross-platform prototype | React Native app | [`app/`](app) |
| D1a | Offline liveness (blink/smile/turn) | Passive MiniFASNet + active challenge | `app/src/face/liveness.ts` |
| D1b | Sync & purge after network returns | Queue → POST → purge on ack (AWS/Render) | `app/src/sync`, [`backend/`](backend) |
| D2 | Documentation + benchmarks | Full `docs/` set incl. architecture & methodology | [`docs/`](docs) |

> **Honest validation boundary:** `>95%` accuracy and `<1s` latency are backed by the chosen model architectures and on-device latency instrumentation; final numbers should be measured on a target mid-range device with a representative Indian-demographic set. iOS floor is **15.5** (required by the on-device ML Kit face detector), noted against the spec's iOS 12+. See [`docs/NHAI_HACKATHON_ALIGNMENT.md`](docs/NHAI_HACKATHON_ALIGNMENT.md).

## Bonus features (beyond the brief)

- **On-device geofencing (at-site presence)** — face proves *who* and *live*; a geofenced GPS fix proves *where*. At verify the device checks its location against the assigned site (circle or chainage polygon), rejects **mock/fake-GPS** fixes (`isFromMockProvider`) and low-accuracy reads, and stamps `lat/lon/accuracy/geofencePassed/siteId` onto the record. Fully offline (GPS is satellite-based); the backend re-checks server-side. See `app/src/location/`.
- **Composite Authentication Score** — weighted, transparent 0–100 trust score across all signals.
- **On-device drowsiness & attention monitoring** — EAR, PERCLOS, blink rate, micro-sleep, head look-away (no extra model). See [`docs/MONITORING_AND_DASHBOARD.md`](docs/MONITORING_AND_DASHBOARD.md).
- **Bilingual voice prompts (English + हिन्दी)** — offline Web Speech API on web; static bilingual prompts on native. No translation API, no network.
- **Verifiable offline proof** — a live "Auth network: 0 calls" counter shows zero network requests during authentication.
- **On-device latency budget** — recognize + match milliseconds shown per verification, proving the `<1 s` target.
- **Presentation-attack counter** — blocked liveness attempts counted on-device.
- **Operations-ready sync records** — verified records include score, latency, liveness, and inspection metrics for downstream analytics.

## Repository layout

| Path | Role | Stack |
|------|------|-------|
| [`app/`](app) | **Primary deliverable** — offline RN app (Android + iOS) | React Native 0.74, vision-camera, react-native-fast-tflite, ML Kit, MMKV |
| [`web/`](web) | Optional browser mirror retained for development comparison | Vite + React, @vladmandic/face-api, Web Speech API |
| [`backend/`](backend) | Offline→online sync-and-purge target (AWS / Render) | Node + Express, optional Postgres |
| [`docs/`](docs) | Plan, integration guide, methodology, deployment, alignment | — |

## Judge mobile package

Android release APKs are included in [`docs/deliverables/`](docs/deliverables). Judges can use the single universal APK directly:

**Direct APK link:** https://github.com/perrysolid/NHAI/raw/main/docs/deliverables/DatalakeFaceAuth-android-universal-release.apk

| Platform | File | Use |
|----------|------|-----|
| Android universal | [`DatalakeFaceAuth-android-universal-release.apk`](docs/deliverables/DatalakeFaceAuth-android-universal-release.apk) | One APK for judge phones: arm64-v8a + armeabi-v7a |

```bash
adb install -r docs/deliverables/DatalakeFaceAuth-android-universal-release.apk
```

iOS does **not** use APK files. The iOS equivalent is a signed `.ipa` or TestFlight build. The project is included at [`app/ios/DatalakeFaceAuth.xcodeproj`](app/ios/DatalakeFaceAuth.xcodeproj); archive/export requires an Apple Developer Team, signing certificate, and provisioning profile.

## Models (on-device, < 20 MB)

| Model | Role | Size | License |
|-------|------|------|---------|
| **EdgeFace-S (TFLite, float32)** | recognition — 112×112 → 512-d ArcFace embedding | 14.2 MB | open-source |
| **MiniFASNetV2 (TFLite)** | passive anti-spoof — 80×80 BGR, 3-class | 5.7 MB | Apache-2.0 |
| Motion-parallax structure check | 3D liveness from landmark geometry — no model file | 0 MB | this project |

Bundled total is **19.9 MB**, inside the 20 MB brief. A float16 or INT8 re-quantisation of
EdgeFace-S is the documented headroom lever; note that templates are not portable across
model changes, so a swap forces re-enrollment.

ML Kit provides on-device face detection + landmarks (blink/smile/head-pose) for the active liveness challenge and the attention monitor.

## Run it locally

<details>
<summary><b>React Native app (Android / iOS)</b></summary>

```bash
cd app
npm install
# Android (needs JDK 17 + emulator/device; project pins JDK 17 via gradle.properties):
npx react-native run-android
# iOS (macOS + Xcode + CocoaPods):
cd ios && pod install && cd .. && npx react-native run-ios
```
Models go in `app/assets/models/` (see its README for download + netron-verify steps).
</details>

<details>
<summary><b>Backend service (optional development only)</b></summary>

```bash
cd backend && npm install && npm run build && npm start
```
</details>

## Deploy

- **Backend → Render:** one-click via [`render.yaml`](render.yaml).
- **Backend → AWS:** App Runner / Elastic Beanstalk / ECS / EC2 via [`backend/Dockerfile`](backend/Dockerfile) + [`backend/apprunner.yaml`](backend/apprunner.yaml). See [`docs/AWS_DEPLOYMENT.md`](docs/AWS_DEPLOYMENT.md).
- Full steps: [`docs/WEB_RENDER_DEPLOYMENT.md`](docs/WEB_RENDER_DEPLOYMENT.md).

## Demo Routes And Keys

The public Vercel demo is a single-page app with direct routes enabled in
[`web/vercel.json`](web/vercel.json), so these URLs can be shared with judges:

| Route | Purpose |
|-------|---------|
| `/` | Live browser authentication demo: enroll, liveness, verify, queue, sync |
| `/operations` | Demo operations view: pending queue, enrollments, sync posture |
| `/deployment` | Vercel + backend deployment settings and runtime checks |
| `/aws` | AWS-specific setup: App Runner/RDS routes, secrets, client key placement |

Backend routes are the same on AWS or Render:

| Backend route | Auth | Purpose |
|---------------|------|---------|
| `GET /health` | none | AWS/Render health check |
| `POST /api/sync` | `x-api-key` when `API_KEY` is set | Receive verified attendance records |
| `GET /api/records` | `x-api-key` when `API_KEY` is set | Return recent synced records |

Where to add keys and cloud URLs:

| Target | File or environment | Values |
|--------|---------------------|--------|
| Vercel frontend | Vercel project env vars | `VITE_SYNC_URL=https://<aws-or-render-backend>` and `VITE_SYNC_KEY=<same as API_KEY>` |
| AWS backend | App Runner / ECS / EB env vars | `API_KEY`, `CORS_ORIGIN=https://<vercel-app>.vercel.app`, optional `DATABASE_URL` |
| Render backend | Render env vars | same as AWS backend |
| Native app | [`app/src/config.ts`](app/src/config.ts) | `SYNC.url=https://<backend>/api/sync`, `SYNC.apiKey=<same as API_KEY>` |
| Browser defaults | [`web/src/lib/config.ts`](web/src/lib/config.ts) | local fallback only; production values should come from Vercel env vars |

## Verification status

| Package | Type-check | Lint | Tests | Build |
|---------|-----------|------|-------|-------|
| `app/` (native) | clean | clean | 28 unit tests pass | Android release APK builds (70 MB universal / 51 MB arm64 / 41 MB armv7) |
| `web/` | clean | clean | 4 Playwright E2E pass | Vite production build |
| `backend/` | clean | — | endpoint smoke (sync/records/dedupe) | `tsc` build |

## Documentation

- [Implementation plan](docs/IMPLEMENTATION_PLAN.md)
- [Datalake 3.0 integration guide](docs/DATALAKE_INTEGRATION_GUIDE.md)
- [Drowsiness & attention monitoring](docs/MONITORING_AND_DASHBOARD.md)
- [NHAI hackathon alignment + honest gaps](docs/NHAI_HACKATHON_ALIGNMENT.md)
- [AWS deployment](docs/AWS_DEPLOYMENT.md) · [Web + Render deployment](docs/WEB_RENDER_DEPLOYMENT.md)
- [Test report](docs/TEST_REPORT.md)

## Privacy & security

Authentication is fully offline; **no image or video ever leaves the device**. Only face *embeddings* (not images) are stored, in encrypted MMKV on native. After a successful verification, only the scalar attendance record + inspection summary is synced, then the local queue is purged.

## License & open-source credits

All third-party components are open-source with no additional licensing required:
React Native, react-native-vision-camera, react-native-fast-tflite, ML Kit face detection, MMKV (MIT); MobileFaceNet / MiniFASNet (open-source / Apache-2.0); @vladmandic/face-api (MIT); Express, Vite, React (MIT).
