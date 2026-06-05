# Test Report

Date: 5 June 2026

## Native App

Environment: React Native 0.74 app in `app/`.

| Check | Result |
|-------|--------|
| `npm run lint` | Passed |
| `npm test -- --runInBand` | Passed: 7 suites, 20 tests |
| `npx tsc --noEmit` | Passed |
| `./gradlew assembleDebug` | Passed |
| `./gradlew assembleRelease` | Passed |

Release APK outputs:

| APK | Size |
|-----|------|
| `app-arm64-v8a-release.apk` | 39 MB |
| `app-armeabi-v7a-release.apk` | 29 MB |

Bundled native model footprint:

| Model | Size |
|-------|------|
| `mobilefacenet.tflite` | 5.0 MB |
| `minifasnet.tflite` | 5.7 MB |
| Total | 10.7 MB |

Notes:

- Gradle heap was raised to 4 GB to avoid Jetifier memory failures.
- Android ABI splits are enabled for `armeabi-v7a` and `arm64-v8a`.
- Dependency versions are pinned to match React Native 0.74 and the Android
  Gradle plugin used by the project.
- The iOS project is included and uses the same React Native offline auth
  services, model config, local store, and sync client; install CocoaPods before
  producing the local iOS build.
- FaceNet-512 is not bundled because its approximate 45 MB size misses the
  compact model target.

## Web Demo

Environment: Vite/React browser demo in `web/`.

| Check | Result |
|-------|--------|
| `npm run lint` | Passed |
| `npm run build` | Passed |
| `npm run test:e2e` | Passed: 4 tests |

Build note: Vite emitted a large chunk warning, but the production build
completed successfully.

## Sync Backend

Environment: Express backend in `backend/`.

| Check | Result |
|-------|--------|
| `npm run build` | Passed |
| `GET /health` | Passed: `{"ok":true,"store":"memory"}` |
| `POST /api/sync` | Passed: accepted 1 record |
| `GET /api/records` | Passed: returned the synced record |

Smoke payload accepted:

```json
{
  "userId": "inspector_01",
  "timestamp": 1780655230110,
  "deviceId": "rn-test",
  "livenessPassed": true,
  "matchDistance": 0.74
}
```

## Remaining Field Validation

The prototype is ready for physical-device benchmarking. Final claims for
sub-second recognition+liveness and above-95% accuracy should be measured on
target mid-range Android/iOS devices with representative Indian demographics
and outdoor lighting conditions.
