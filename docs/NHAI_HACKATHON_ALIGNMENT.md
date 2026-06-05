# NHAI Hackathon 7.0 Alignment

This repository targets the NHAI problem statement: secure offline facial
recognition and liveness detection for remote field authentication, integrated
with a React Native mobile app and a sync/purge path after connectivity returns.

## Compliance Matrix

| Requirement | Implementation status |
|-------------|-----------------------|
| React Native Android + iOS compatibility | `app/` is a React Native 0.74 CLI project with Android and iOS projects. Android debug and release APK builds pass locally. iOS uses the same JS/native module graph; local iOS build was not run on this machine. |
| Fully offline authentication | Camera capture, face gates, liveness, recognition, enrollment, verification, encrypted local template store, and local queue are all on-device. The backend is never used for the auth decision. |
| Lightweight model target around 20 MB | Bundled native model assets are `mobilefacenet.tflite` 5.0 MB + `minifasnet.tflite` 5.7 MB = 10.7 MB total. FaceNet-512 was removed because it is about 45 MB. |
| Final compact model path | Current runnable recognition uses MobileFaceNet. EdgeFace-S remains the final compact replacement after TFLite INT8 conversion and Netron I/O verification. |
| Liveness anti-spoofing | Passive MiniFASNet score is combined with active blink, smile, or head-turn challenge checks from ML Kit face landmarks. |
| Under 1 second target | The code includes latency logging and benchmark helpers. Release APK builds are available for physical-device benchmarking; final latency must be measured on target mid-range Android/iOS devices. |
| Standard mobile hardware | Android `minSdkVersion` is 26, matching Android 8.0+. The native stack uses CPU-capable TFLite and avoids GPU-only assumptions. |
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

## Honest Validation Boundary

The repository is buildable and tested locally, but final NHAI scoring claims for
`>95%` accuracy and `<1s` recognition+liveness should be backed by physical
device benchmarks and a representative validation set. The codebase is prepared
for that measurement without depending on network connectivity.
