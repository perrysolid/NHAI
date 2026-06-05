# NHAI Innovation Hackathon 7.0 — Implementation Plan

On-device offline auth (React Native) + Vercel sync backend.

**Constraints:** React Native (Android+iOS) · 100% offline auth · <1s · >95% acc ·
~20MB models · Android 8+/iOS 12+ · 3GB RAM · CPU-only · open-source.

**One line:** recognition + liveness run on-device & offline; Vercel hosts only the
offline→online sync target + admin dashboard (never in the auth path).

## Architecture
```
DEVICE (offline, scored): Camera → Face detect (ML Kit) → Liveness (MiniFASNet +
active challenge) → Recognition (EdgeFace) → cosine match → encrypted local queue
   │ (only when network returns)
   ▼
VERCEL (online): POST /api/sync → validate → Postgres → 200 OK → device PURGES.
/admin dashboard (optional Gemini summary + Groq NL query).
```
Why not models on Vercel: the rubric scores offline operation (airplane-mode test);
serverless cold-starts + payload limits make vision inference unreliable. Vercel's
honest role is the *sync* half.

## Models (on-device footprint < 20 MB)
- **EdgeFace-S** (George et al., TBIOM 2024) — IJCB'23 Efficient FR Competition
  compact-track winner. 1.77M params, 99.73% LFW. 112×112×3, mean/std 0.5 →
  512-d embedding → cosine. Export PyTorch→ONNX→TFLite INT8 (~1–2 MB).
  Weights: github.com/otroshi/edgeface.
- **MobileFaceNet** — proven fallback (99.55% LFW, 4 MB / ~1 MB INT8, ArcFace).
  One-line swap behind the same `FaceEngine` interface.
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

## Vercel backend stack (Track B)
Next.js (App Router) · Vercel Postgres or Supabase · `POST /api/sync` ·
`GET /api/records` (auth-gated) · `/admin` dashboard · optional Gemini/Groq
enrichment behind `ENRICHMENT_ENABLED`. Secrets via env vars.

## Build order — Track A (scored core)
1. Get models; verify exact I/O in netron.app (prevents #1 runtime bug).
2. Scaffold → blank camera preview RUNS on Android (go/no-go gate).  ← **Phase 1**
3. Face detection + quality gates (one face, ±30° pose, brightness).
4. FaceEngine: load EdgeFace + MiniFASNet; resize-plugin → correct input buffers.
5. Liveness: passive >0.7 AND active challenge within timeout.
6. Enroll (avg 3 embeddings) + verify (cosine ≥0.55) + encrypted MMKV queue.
7. Sync client: online → POST queue → on 200 purge.
8. CLAHE/torch lighting; Benchmark screen.

## Build order — Track B (parallel)
1. Next.js + `/api/sync` + DB schema `{userId,timestamp,livenessScore,matchScore,deviceId}`.
2. `/admin` dashboard.
3. Optional Gemini anomaly summary + Groq NL query (online-only).
4. Deploy; set env; hand Track A the endpoint URL.
Integration: Track A's `SYNC_URL` config + `MOCK_MODE` flag lets the device demo the
full sync→purge lifecycle before the backend is live.

## Deliverables (rubric-mapped)
- Working prototype + source (Android demo; iOS = same codebase) → Feasibility 30
- Offline liveness (passive MiniFASNet + active blink/smile/turn) → Innovation 30
- INT8 EdgeFace, size benchmark documented → Innovation 30
- Sync & purge to Vercel, lighting robustness (CLAHE/torch) → Scalability 20
- Source + integration guide + PPTX deck → Presentation 20

## Demo script (90s, airplane mode throughout)
1. Airplane mode on — "fully offline".
2. Enroll a face (3 captures).
3. Verify — passes <1s; show latency.
4. Spoof test — printed photo + phone-screen photo → both rejected (the winning moment).
5. Live blink/smile active challenge.
6. Network on → records sync to Vercel dashboard → local queue purges to empty.
7. End on Benchmark screen: <1s, ~3MB models, EdgeFace 99.73% LFW, 100% offline.

## Sources
- EdgeFace — arXiv 2307.01838; IEEE TBIOM 2024; github.com/otroshi/edgeface.
- MobileFaceNet — arXiv 1804.07573 (fallback).
- Silent-Face-Anti-Spoofing / MiniFASNet — github.com/minivision-ai/Silent-Face-Anti-Spoofing (Apache-2.0).
- react-native-fast-tflite + vision-camera-resize-plugin — github.com/mrousavy (MIT).
- vision-camera-face-detector — github.com/luicfrr/react-native-vision-camera-face-detector (MIT).
- netron.app — verify model I/O before coding.
- IndicFairFace — Indian-balanced dataset for documented fine-tune (next step).
