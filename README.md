# DatalakeFaceAuth — Offline On-Device Face Auth for NHAI Datalake 3.0

On-device, **100% offline** face recognition + liveness for React Native,
Android, and iOS. The same offline auth pipeline works across the mobile app
surface, with recognition + liveness running entirely on the device. The browser
demo deploys to Vercel, while an AWS/Render-compatible backend is used **only**
as the offline→online sync target and admin dashboard — never in the auth path.

```
        ┌──────────────────── DEVICE (offline, scored) ────────────────────┐
        │ Camera → Face detect (ML Kit) → Liveness (MiniFASNet + active) →  │
        │ Recognition (MobileFaceNet now; EdgeFace-S target) → local queue  │
        └─────────────────────────────┬────────────────────────────────────┘
                                       │  (only when network returns)
                                       ▼
        ┌────────────── AWS/RENDER (online, not in auth path) ─────────────┐
        │ POST /api/sync → validate → Postgres → 200 OK → device PURGES     │
        │ /admin dashboard (optional Gemini summary + Groq NL query)        │
        └──────────────────────────────────────────────────────────────────┘
```

## Layout

| Path        | Track | What |
|-------------|-------|------|
| `app/`      | A     | React Native CLI app (the scored, offline core) |
| `web/`      | B     | Vercel browser demo: client-side face auth + sync/purge flow |
| `backend/`  | B     | AWS/Render-compatible sync target + admin dashboard |
| `docs/`     | —     | Implementation plan & notes |

## Models
- **MobileFaceNet** — bundled compact runnable recognition model
- **MiniFASNetV2-SE** — passive anti-spoof, paired with an active blink/smile/turn challenge
- **EdgeFace-S** — final compact recognition target, 99.73% LFW @ 1.77M params after TFLite INT8 conversion

See `app/assets/models/README.md` for download + netron-verify steps.

## Build status (phase-gated)
- [x] **Phase 1** — scaffold; front-camera preview runs before any ML
- [x] **Phase 2** — face detection + quality gates (one face, ±30° pose, brightness, live guidance)
- [x] **Phase 3 web demo** — Vercel-ready browser face auth + AWS/Render-compatible sync backend
- [x] **Phase 3 native** — FaceEngine interface, model manifest, deterministic mock fallback
- [x] **Phase 4** — dual liveness logic (passive score + active blink/smile/turn)
- [x] **Phase 5** — enroll + verify + encrypted MMKV-backed store
- [x] **Phase 6** — sync & purge client for AWS/Render-compatible backend
- [x] **Phase 7** — lighting robustness + benchmark helpers
- [x] **Phase 8** — README + Datalake 3.0 integration guide

## Run the app (Phase 1)
```bash
cd app
npm install
# Android (needs JDK 17 + an emulator/device):
npx react-native run-android
```
> **Toolchain note:** RN 0.74 requires **JDK 17** (this machine currently has 11).
> The iOS project is included and shares the same offline JS/auth service
> pipeline; install CocoaPods before producing the local iOS build.

Full plan: [`docs/IMPLEMENTATION_PLAN.md`](docs/IMPLEMENTATION_PLAN.md).
Integration guide:
[`docs/DATALAKE_INTEGRATION_GUIDE.md`](docs/DATALAKE_INTEGRATION_GUIDE.md).
Submission alignment:
[`docs/NHAI_HACKATHON_ALIGNMENT.md`](docs/NHAI_HACKATHON_ALIGNMENT.md).
Test report: [`docs/TEST_REPORT.md`](docs/TEST_REPORT.md).

## Run the web demo + sync backend
```bash
# terminal 1
cd backend
npm install
npm run build
npm start

# terminal 2
cd web
npm install
npm run dev
```

The browser demo keeps face inference local in the browser and only syncs verified
attendance records. Deployment steps are in
[`docs/WEB_RENDER_DEPLOYMENT.md`](docs/WEB_RENDER_DEPLOYMENT.md).

> Native model note: the app now bundles MobileFaceNet + MiniFASNet `.tflite`
> assets and a `react-native-fast-tflite` engine. Combined model assets are about
> 10.7 MB. FaceNet-512 was removed because it is runnable but about 45 MB; swap
> `ACTIVE_RECOGNITION` to `edgeface_s` after converting EdgeFace-S to TFLite
> INT8 for the final compact build.
