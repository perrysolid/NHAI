# DatalakeFaceAuth — Offline On-Device Face Auth for NHAI Datalake 3.0

On-device, **100% offline** face recognition + liveness (React Native, Android &
iOS). Recognition + liveness run entirely on the device. The browser demo deploys
to Vercel, while a Render backend is used **only** as the offline→online sync
target and admin dashboard — never in the auth path.

```
        ┌──────────────────── DEVICE (offline, scored) ────────────────────┐
        │ Camera → Face detect (ML Kit) → Liveness (MiniFASNet + active) →  │
        │ Recognition (EdgeFace) → cosine match → encrypted local queue     │
        └─────────────────────────────┬────────────────────────────────────┘
                                       │  (only when network returns)
                                       ▼
        ┌──────────────────── RENDER (online, not in auth path) ───────────┐
        │ POST /api/sync → validate → Postgres → 200 OK → device PURGES     │
        │ /admin dashboard (optional Gemini summary + Groq NL query)        │
        └──────────────────────────────────────────────────────────────────┘
```

## Layout

| Path        | Track | What |
|-------------|-------|------|
| `app/`      | A     | React Native CLI app (the scored, offline core) |
| `web/`      | B     | Vercel browser demo: client-side face auth + sync/purge flow |
| `backend/`  | B     | Render sync target + admin dashboard |
| `docs/`     | —     | Implementation plan & notes |

## Models (on-device, < 20 MB total)
- **EdgeFace-S** — recognition, 99.73% LFW @ 1.77M params (IJCB'23 compact-track winner)
- **MobileFaceNet** — proven fallback behind the same `FaceEngine` interface
- **MiniFASNetV2-SE** — passive anti-spoof, paired with an active blink/smile/turn challenge

See `app/assets/models/README.md` for download + netron-verify steps.

## Build status (phase-gated)
- [x] **Phase 1** — scaffold; front-camera preview runs before any ML
- [x] **Phase 2** — face detection + quality gates (one face, ±30° pose, brightness, live guidance)
- [x] **Phase 3 web demo** — Vercel-ready browser face auth + Render sync backend
- [x] **Phase 3 native** — FaceEngine interface, model manifest, deterministic mock fallback
- [x] **Phase 4** — dual liveness logic (passive score + active blink/smile/turn)
- [x] **Phase 5** — enroll + verify + encrypted MMKV-backed store
- [x] **Phase 6** — sync & purge client for Render backend
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
> iOS builds need CocoaPods (not installed here) but share the same JS codebase.

Full plan: [`docs/IMPLEMENTATION_PLAN.md`](docs/IMPLEMENTATION_PLAN.md).
Integration guide:
[`docs/DATALAKE_INTEGRATION_GUIDE.md`](docs/DATALAKE_INTEGRATION_GUIDE.md).

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

> Native model note: the app code now has the FaceEngine contract and tested
> enrollment/liveness/sync pipeline. Real EdgeFace/MiniFASNet `.tflite` assets
> still need to be dropped into `app/assets/models/` and wired to
> `react-native-fast-tflite` for production inference.
