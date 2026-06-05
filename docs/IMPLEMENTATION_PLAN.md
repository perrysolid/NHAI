# NHAI Innovation Hackathon 7.0 — Implementation Plan

On-device offline auth (React Native) + Vercel web demo + AWS/Render-compatible
sync backend.

**Constraints:** React Native (Android+iOS) · 100% offline auth · <1s · >95% acc ·
~20MB models · Android 8+/iOS 12+ · 3GB RAM · CPU-only · open-source.

**One line:** recognition + liveness run on-device & offline; Vercel hosts the
browser demo, and AWS/Render hosts only the offline→online sync target + admin
dashboard (never in the auth path).

## Architecture
```
DEVICE (offline, scored): Camera → Face detect (ML Kit) → Liveness (MiniFASNet +
active challenge) → Recognition (MobileFaceNet now; EdgeFace-S target) → queue
   │ (only when network returns)
   ▼
AWS/RENDER (online): POST /api/sync → validate → Postgres → 200 OK → device PURGES.
/admin dashboard (optional Gemini summary + Groq NL query).
```
Why not server-side models: the rubric scores offline operation (airplane-mode
test); serverless cold-starts + payload limits make vision inference unreliable.
The honest online role is only the sync/admin half.

## Models (on-device footprint < 20 MB)
- **MobileFaceNet** — bundled compact runnable recognition model from
  `face_detection_tflite`, 112×112 input, 192-d embedding, ~5 MB.
- **EdgeFace-S** (George et al., TBIOM 2024) — IJCB'23 Efficient FR Competition
  compact-track winner. 1.77M params, 99.73% LFW. 112×112×3, mean/std 0.5 →
  512-d embedding → cosine. Export PyTorch→ONNX→TFLite INT8 (~1–2 MB).
  Weights: github.com/otroshi/edgeface.
- **FaceNet-512 tradeoff** — runnable now but about 45 MB, so it is intentionally
  excluded from the native bundle. EdgeFace-S INT8 is the right final compact
  replacement once converted and verified.
- **MiniFASNetV2-SE** (Silent-Face-Anti-Spoofing, Apache-2.0) — passive RGB
  anti-spoof ~98%, 0.6–1.8 MB, 80×80×3, 3-class softmax (idx 1 = live).
  + **active challenge** (ML Kit: blink/smile/head-turn) → defeats print AND replay.
- **ML Kit face detector** (vision-camera-face-detector) — bbox, eyeOpenProbability,
  smilingProbability, head Euler angles for cropping/alignment + active liveness.

## On-device stack (pinned)
react-native 0.74.x · react-native-vision-camera ^4.5 · react-native-worklets-core
^1.3.3 · react-native-reanimated ^3.12 (babel plugin LAST) · vision-camera-resize-plugin
^3 · react-native-fast-tflite ^1.3 · react-native-vision-camera-face-detector ^1.7 ·
react-native-mmkv ^2.12 · @react-native-community/netinfo ^11.
Android: minSdk 26, compile/target 34, kotlin 1.9. Keep inference behind a
`FaceEngine` interface so EdgeFace↔MobileFaceNet and tflite↔onnx are one-line swaps.

## Web + sync stack (Track B)
Vite/React browser demo on Vercel · Express backend deployable on AWS or Render ·
Postgres optional via `DATABASE_URL` · `POST /api/sync` · `GET /api/records`
(auth-gated) · `/admin` dashboard. Secrets via env vars.

## Build order — Track A (scored core)
1. Get models; verify exact I/O in netron.app (prevents #1 runtime bug).
2. Scaffold → blank camera preview RUNS on Android (go/no-go gate).  ← **Phase 1**
3. Face detection + quality gates (one face, ±30° pose, brightness).
4. FaceEngine: TFLite engine wired with bundled MobileFaceNet + MiniFASNet;
   replace MobileFaceNet with EdgeFace-S INT8 for the smallest final build.
5. Liveness: passive >0.7 AND active challenge within timeout.
6. Enroll (avg 3 embeddings) + verify (cosine ≥0.55) + encrypted MMKV queue.
7. Sync client: online → POST queue to AWS/Render endpoint → on 200 purge.
8. Lighting robustness + benchmark helpers.

## Build order — Track B (parallel)
1. Vercel web demo with browser camera, local enroll/verify, active liveness, and sync queue.
2. AWS/Render backend with `/api/sync` + DB schema `{userId,timestamp,livenessPassed,matchDistance,deviceId}`.
3. `/admin` dashboard.
4. Deploy; set env; hand Track A the endpoint URL.
Integration: Track A's `SYNC_URL` config + `MOCK_MODE` flag lets the device demo the
full sync→purge lifecycle before the backend is live.

## Deliverables (rubric-mapped)
- Working prototype + source (Android demo; iOS = same codebase) → Feasibility 30
- Offline liveness (passive MiniFASNet + active blink/smile/turn) → Innovation 30
- INT8 EdgeFace, size benchmark documented → Innovation 30
- Sync & purge to AWS/Render endpoint, lighting robustness (CLAHE/torch) → Scalability 20
- Source + integration guide → Presentation 20

## Demo script (90s, airplane mode throughout)
1. Airplane mode on — "fully offline".
2. Enroll a face (3 captures).
3. Verify — passes <1s; show latency.
4. Spoof test — printed photo + phone-screen photo → both rejected (the winning moment).
5. Live blink/smile active challenge.
6. Network on → records sync to backend dashboard → local queue purges to empty.
7. End on Benchmark screen: model assets 10.7 MB, offline auth path, and device latency report.

## Sources
- EdgeFace — arXiv 2307.01838; IEEE TBIOM 2024; github.com/otroshi/edgeface.
- MobileFaceNet — arXiv 1804.07573 (fallback).
- Silent-Face-Anti-Spoofing / MiniFASNet — github.com/minivision-ai/Silent-Face-Anti-Spoofing (Apache-2.0).
- react-native-fast-tflite + vision-camera-resize-plugin — github.com/mrousavy (MIT).
- vision-camera-face-detector — github.com/luicfrr/react-native-vision-camera-face-detector (MIT).
- netron.app — verify model I/O before coding.
- IndicFairFace — Indian-balanced dataset for documented fine-tune (next step).
