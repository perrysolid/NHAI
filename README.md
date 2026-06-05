# DatalakeFaceAuth — Offline On-Device Face Auth for NHAI Datalake 3.0

On-device, **100% offline** face recognition + liveness (React Native, Android &
iOS). Recognition + liveness run entirely on the device; a Vercel backend is used
**only** as the offline→online sync target and admin dashboard — never in the auth
path.

```
        ┌──────────────────── DEVICE (offline, scored) ────────────────────┐
        │ Camera → Face detect (ML Kit) → Liveness (MiniFASNet + active) →  │
        │ Recognition (EdgeFace) → cosine match → encrypted local queue     │
        └─────────────────────────────┬────────────────────────────────────┘
                                       │  (only when network returns)
                                       ▼
        ┌──────────────────── VERCEL (online, not in auth path) ───────────┐
        │ POST /api/sync → validate → Postgres → 200 OK → device PURGES     │
        │ /admin dashboard (optional Gemini summary + Groq NL query)        │
        └──────────────────────────────────────────────────────────────────┘
```

## Layout

| Path        | Track | What |
|-------------|-------|------|
| `app/`      | A     | React Native CLI app (the scored, offline core) |
| `backend/`  | B     | Next.js/Vercel sync target + admin dashboard *(not started)* |
| `docs/`     | —     | Implementation plan & notes |

## Models (on-device, < 20 MB total)
- **EdgeFace-S** — recognition, 99.73% LFW @ 1.77M params (IJCB'23 compact-track winner)
- **MobileFaceNet** — proven fallback behind the same `FaceEngine` interface
- **MiniFASNetV2-SE** — passive anti-spoof, paired with an active blink/smile/turn challenge

See `app/assets/models/README.md` for download + netron-verify steps.

## Build status (phase-gated)
- [x] **Phase 1** — scaffold; front-camera preview runs before any ML
- [x] **Phase 2** — face detection + quality gates (one face, ±30° pose, brightness, live guidance)
- [ ] Phase 3 — FaceEngine (EdgeFace + MiniFASNet inference)
- [ ] Phase 4 — dual liveness (passive + active)
- [ ] Phase 5 — enroll + verify + encrypted MMKV store
- [ ] Phase 6 — sync & purge to Vercel
- [ ] Phase 7 — robustness (CLAHE/torch) + benchmark screen
- [ ] Phase 8 — README + Datalake 3.0 integration guide

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
