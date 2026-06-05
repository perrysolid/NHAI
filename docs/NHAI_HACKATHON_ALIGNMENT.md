# NHAI Hackathon 7.0 Alignment

This repository targets the NHAI problem statement: secure offline facial
recognition and liveness detection for remote field authentication, integrated
with a React Native mobile app and a sync/purge path after connectivity returns.

## Compliance Matrix

| Requirement | Implementation status |
|-------------|-----------------------|
| React Native Android + iOS compatibility | `app/` is a React Native 0.74 CLI project with Android and iOS projects. The offline screens, services, model config, liveness flow, local store, and sync client are shared through the same React Native pipeline so the solution works well across Android and iOS. Android debug and release APK builds pass locally (verified). The iOS project is included and shares the same JS pipeline but has **not** been built here (needs macOS + CocoaPods + Xcode). **Note:** RN 0.74's minimum is **iOS 13.4**, so the project targets 13.4 — see "Known gaps vs spec" re: the spec's iOS 12+ floor. |
| Fully offline authentication | Camera capture, face gates, liveness, recognition, enrollment, verification, encrypted local template store, and local queue are all on-device. The backend is never used for the auth decision. |
| Lightweight model target around 20 MB | Bundled native model assets are `mobilefacenet.tflite` 5.0 MB + `minifasnet.tflite` 5.7 MB = 10.7 MB total. FaceNet-512 was removed because it is about 45 MB. |
| Final compact model path | Current runnable recognition uses MobileFaceNet. EdgeFace-S remains the final compact replacement after TFLite INT8 conversion and Netron I/O verification. |
| Liveness anti-spoofing | Passive MiniFASNet score is combined with active blink, smile, or head-turn challenge checks from ML Kit face landmarks. |
| Under 1 second target | The code includes latency logging and benchmark helpers. Release APK builds are available for physical-device benchmarking; final latency must be measured on target mid-range Android/iOS devices. |
| Standard mobile hardware | Android `minSdkVersion` is 26, matching Android 8.0+, and the included iOS project targets iOS 13.4 (RN 0.74 minimum). The native stack uses CPU-capable TFLite and avoids GPU-only assumptions. |
| 3 GB RAM target | ABI-split release APKs are produced to reduce install footprint. Runtime memory must still be profiled on target 3 GB devices during field validation. |
| Accuracy above 95% | The selected recognition/liveness model families are appropriate for the target. A truthful >95% claim requires validation on a representative dataset covering Indian demographics, lighting, and outdoor conditions. |
| Outdoor lighting robustness | Quality gates check pose, face size, and brightness. Lighting utilities support contrast/brightness preprocessing and torch guidance. |
| Sync and purge after network returns | Verified records are queued locally. `syncPending()` posts to the configured AWS/Render-compatible `/api/sync` endpoint and purges only after successful server acknowledgement. |
| Open-source technologies | React Native, ML Kit-based face detection package, react-native-fast-tflite, TFLite model assets, Vite/React web demo, and Express backend are open-source based. |
| Working prototype source code | Source is included for the native app, browser demo, and sync backend. |
| Documentation and presentation readiness | Implementation plan, Datalake integration guide, web/backend deployment guide, model notes, this alignment matrix, and test report are included under `docs/`. |

## Tradeoff Resolution

FaceNet-512 is runnable but approximately 45 MB, which exceeds the original
compact model target. The submission therefore uses MobileFaceNet as the current
runnable compact recognition model and MiniFASNet for liveness, keeping bundled
model assets at 10.7 MB. EdgeFace-S remains the right final compact replacement
once converted to TFLite INT8 because it should reduce recognition footprint
further while preserving a strong compact-face-recognition baseline.

## Known Gaps vs Spec (be upfront in the deck)

1. **iOS floor is 13.4, not 12.** React Native 0.74 dropped support below iOS
   13.4, so the project cannot target iOS 12. In practice 2026-era mid-range
   field devices run iOS 15+, but if iOS 12 is a hard requirement the only path
   is an older RN line (≈0.72) — a tradeoff to call out, not hide.
2. **iOS build not produced here.** Only the Android release APK is verified
   (39 MB arm64 / 29 MB armv7). iOS needs macOS + Xcode + CocoaPods to build.
3. **Sync target named "AWS" in the brief; we run it on Render.** `syncPending()`
   posts to a standard HTTPS `/api/sync` endpoint, so the same backend deploys to
   AWS (Elastic Beanstalk / Lambda+API Gateway / EC2) unchanged — only the URL
   changes. Demo is on Render for speed; an AWS deploy is a config swap.
4. **`>95%` accuracy + Indian-demographic robustness is not independently
   measured.** Bundled MobileFaceNet is a strong compact baseline but is not
   Indian-demographic fine-tuned; IndicFairFace fine-tuning is the documented
   next step.
5. **`<1s` latency is not device-measured.** Benchmark hooks exist; numbers must
   come from a physical mid-range device.
6. **Web demo (`web/`) is a browser test harness, not the scored model.** It uses
   `@vladmandic/face-api` (MIT) so judges can try the flow from a URL; the
   scored, spec-compliant pipeline is the React Native app's TFLite engine
   (MobileFaceNet + MiniFASNet, ~10.7 MB).

## Honest Validation Boundary

The repository is buildable and tested locally, with the same app architecture
set up to work well on Android, iOS, and the browser demo surface. Final NHAI
scoring claims for `>95%` accuracy and `<1s` recognition+liveness should be
backed by physical-device benchmarks and a representative validation set. The
codebase is prepared for that measurement without depending on network
connectivity.
