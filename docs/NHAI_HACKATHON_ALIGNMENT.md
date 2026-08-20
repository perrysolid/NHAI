# NHAI Hackathon 7.0 Alignment

This repository targets the NHAI problem statement: secure offline facial
recognition and liveness detection for remote field authentication, integrated
with a React Native mobile app and a sync/purge path after connectivity returns.

**Verified against build `v4.2` (versionCode 36), 20 August 2026.** Every number
below was measured or read from the code, not estimated. Where a claim is *not*
independently validated, it is marked as such rather than rounded up.

## Compliance Matrix

| Requirement | Implementation status |
|-------------|-----------------------|
| React Native Android + iOS compatibility | `app/` is a React Native 0.74 CLI project with Android and iOS projects. Offline screens, services, model config, liveness flow, local store, and sync client are shared across both platforms. Android release APKs build and are shipped in `docs/deliverables/`. The iOS project is included and shares the same JS pipeline but has **not** been built here (needs macOS + Xcode + CocoaPods). **Note:** the project targets **iOS 15.5** because the bundled ML Kit face detector requires it — see "Known gaps vs spec". |
| Fully offline authentication | Camera capture, quality gates, liveness, recognition, verification, encrypted local template store, and the local queue are all on-device. **The backend is never in the auth decision path.** Enrollment registers the template with the backend; verification needs no network at all. |
| Lightweight model target around 20 MB | Bundled TFLite assets are `edgeface_s.tflite` **14.2 MB** (float32) + `minifasnet.tflite` **5.7 MB** = **19.9 MB**. Inside the 20 MB brief, but with little headroom — a float16/INT8 re-quantisation of EdgeFace-S is the documented lever. |
| Final compact model path | **EdgeFace-S is the active, bundled recognition model** (`ACTIVE_RECOGNITION = 'edgeface_s'`). It ships as **float32, not INT8** — the switch was deliberate, for match accuracy. MobileFaceNet remains a spec placeholder in config with no bundled asset; selecting it throws at load. |
| Liveness anti-spoofing | A randomized active challenge (blink / smile / head-turn, random subset in random order, each with its own response deadline) plus a motion-parallax 3D structure check. Passive MiniFASNet is computed and recorded but **not currently enforced** — see "Honest scope of the anti-spoof" below. |
| Under 1 second target | Recognize + match latency is instrumented and displayed per verification. Release APKs are available for physical-device benchmarking; the sub-second figure still needs measurement on target mid-range hardware. |
| Standard mobile hardware | Android `minSdkVersion` 26 (Android 8.0+); the iOS project targets 15.5. CPU TFLite delegate throughout — no GPU-only assumptions. |
| 3 GB RAM target | ABI-split release APKs reduce install footprint (53–63 MB per ABI vs 82 MB universal). Runtime memory still needs profiling on a real 3 GB device. |
| Accuracy above 95% | **Not independently measured.** EdgeFace-S is a strong compact ArcFace baseline and the operating threshold sits in a measured separation gap (genuine 0.70–0.95, impostor 0.30–0.55, threshold 0.65), but a truthful >95% claim requires validation on a representative Indian-demographic set. Treat it as a target. |
| Outdoor lighting robustness | Quality gates bound pose, face size, and exposure (luma 25–252), and illumination feeds the composite score. **Note:** the contrast-normalisation utility in `robustness/lighting.ts` is written but not wired into the running pipeline. |
| Sync and purge after network returns | Verified records queue locally in encrypted MMKV. `syncPending()` posts to `/api/sync` and purges **only** records the server explicitly acknowledges in `acceptedRecords` — never optimistically. |
| Open-source technologies | React Native, react-native-vision-camera, react-native-fast-tflite, ML Kit face detection, MMKV, EdgeFace, MiniFASNet, Vite/React, Express — all MIT / Apache-2.0. |
| Working prototype source code | Full source for the native app, browser mirror, and sync backend is in this repo. |
| Documentation and presentation readiness | Architecture, integration guide, deployment guides, model notes, this alignment matrix, and a verified test report are under `docs/`. |

## Model Decision Record

FaceNet-512 was dropped early: at ~45 MB it misses the compact-model target
outright. The submission ran on MobileFaceNet for part of development, then
switched to **EdgeFace-S** as the final recognition model.

The one non-obvious choice is **float32 over INT8**. EdgeFace-S was originally
integrated as INT8 (~1–2 MB) — commit `400102a` deliberately switched to float32
for match accuracy, trading ~13 MB of budget for reliable matching. That is why
the bundled total is 19.9 MB rather than the ~10.7 MB quoted in older revisions
of this document. Re-quantising to float16 (~3.5 MB) is the documented next step
and would restore substantial headroom.

**Templates are not portable across models.** Any re-quantisation or fine-tune
changes the embedding space and forces re-enrollment of every user — templates
whose dimension does not match the active model are filtered out at load, so
users would simply see "no enrollments". This is intended behaviour, and it makes
model changes a migration rather than a deploy.

## Honest Scope of the Anti-Spoof

The randomized behavioural challenge is currently the **only enforced**
anti-spoof control. Passive screen detection (MiniFASNet) is bundled and scored
on every verify, but is **not enforced** pending on-device calibration.

| Attack | Status |
|--------|--------|
| Printed photo | **Blocked** — a blink requires an eye-open swing a flat image cannot produce |
| Static image on a screen | **Blocked** — same, plus randomized smile/turn |
| Slow or naive looping video | **Blocked** — a 20 s loop passes ~4% of the time against per-action deadlines |
| Tight looping video (loop shorter than the deadline) | **Not blocked** — measured at ~100% pass; randomizing action order does not help, because a short loop presents every gesture inside its window |
| Live video-call relay | **Not blocked** — the deadline is currently 4–5 s, well above a relay's 100–500 ms round trip |
| Virtual-camera / frame injection | **Not blocked** — no capture-provenance or device-integrity check exists |

These are measured results, not assumptions. The fix for the bottom three rows is
to challenge *the physics of capture* rather than the person's behaviour —
calibrating the passive model, then screen-flash spatial confinement. A root
cause was found and fixed during development: MiniFASNet expects raw 0–255 input,
and was being fed 0–1, which made it emit a near-constant score regardless of
input. What remains is genuine threshold calibration on target hardware.

Note that ISO/IEC 30107-3 covers presentation attacks only; injection attacks are
governed separately. **Scope any spoof-resistance claim to the attack class
actually tested.**

## Known Gaps vs Spec

1. **iOS floor is 15.5, not 12.** Two constraints stack: React Native 0.74 drops
   support below iOS 13.4, and the on-device ML Kit face detector requires iOS
   15.5+. In practice 2026-era mid-range field devices run iOS 15+, so this is a
   non-issue in the field — but if iOS 12 is a hard requirement it means swapping
   ML Kit for a lighter-floored detector. A tradeoff to call out, not hide.
2. **iOS build not produced here.** Only the Android release APKs are verified.
   iOS needs macOS + Xcode + CocoaPods and an Apple Developer Team for signing.
3. **AWS path is real.** The backend ships a `Dockerfile` + `apprunner.yaml` and
   deploys unchanged to App Runner / Elastic Beanstalk / ECS-Fargate / EC2, with
   RDS Postgres via `DATABASE_URL`. Render is the one-click alternative and is
   what the live demo instance runs on.
4. **`>95%` accuracy is not independently measured.** EdgeFace-S is not
   Indian-demographic fine-tuned; IndicFairFace fine-tuning is documented in
   `finetune/` as the next step, with evaluation-only use of the bias set.
5. **`<1s` latency is not device-measured.** Instrumentation exists and is shown
   in the UI; the number must come from a physical mid-range device.
6. **Passive liveness is disabled pending calibration** (see above).
7. **Two secrets are shared across the fleet.** The device API key is baked into
   the binary, and the MMKV encryption key is a hardcoded literal. Both are
   acceptable for a hackathon build and are **hard blockers for a real rollout** —
   per-device credentials and a platform-keystore key are the fix.
8. **Web demo (`web/`) is a browser mirror, not the scored deliverable.** It uses
   `@vladmandic/face-api` with 128-d descriptors so judges can try the flow from a
   URL. It shares no code with `app/` and its thresholds are independent. The
   scored, spec-compliant pipeline is the React Native app's TFLite engine.

## Honest Validation Boundary

The repository is buildable, tested, and deployed. `app/` passes **150 unit
tests**, `backend/` passes **58**, and `web/` passes 4 Playwright E2E specs; all
three type-check clean.

What that does *not* establish is field accuracy. Final NHAI scoring claims for
`>95%` accuracy and `<1s` recognition+liveness should be backed by
physical-device benchmarks against a representative validation set covering
Indian demographics, outdoor lighting, and the actual target hardware. The
codebase is instrumented for that measurement and does not depend on network
connectivity to perform it.
