# Test Report

**Date:** 20 August 2026
**Build under test:** `v4.2` (versionCode 36), commit `c688a23`

Every result below was produced by running the command shown, on this commit.
Nothing is carried over from an earlier report.

## Summary

| Package | Type-check | Lint | Tests | Build |
|---------|-----------|------|-------|-------|
| `app/` (React Native) | clean | 0 errors, 4 warnings | **150 passing** (16 suites) | Android release APKs build |
| `backend/` (Express) | clean | — | **58 passing** (14 suites) | `tsc` build clean |
| `web/` (Vite mirror) | clean | clean | 4 Playwright E2E specs | Vite production build |

## Native App

Environment: React Native 0.74 app in `app/`.

| Check | Command | Result |
|-------|---------|--------|
| Unit tests | `npx jest` | **Passed — 16 suites, 150 tests**, 6.5 s |
| Type-check | `npx tsc --noEmit` | Passed, no errors |
| Lint | `npm run lint` | Passed — 0 errors, 4 `no-inline-styles` warnings |
| Release build | `./gradlew assembleRelease` | Passed — ABI-split + universal APKs |

The app type-checks under **both** states of `FLAGS.CALIBRATE_LIVENESS`.

### Release APK outputs

Shipped in `docs/deliverables/`. Version confirmed with `aapt dump badging`:
`versionCode='36' versionName='4.2'`.

| APK | Size | SHA-256 |
|-----|------|---------|
| `DatalakeFaceAuth-android-universal-release.apk` | 82 MB | `88f11ef9001f981b005554f42860c3bbc7deb557b8a92b3e932e04234a9be403` |
| `DatalakeFaceAuth-android-arm64-v8a-release.apk` | 63 MB | `19ed56e990a8dcf1952a2f3e8f3de8ec4384c30a6cf3d85b8d691919963d55c7` |
| `DatalakeFaceAuth-android-armeabi-v7a-release.apk` | 53 MB | `db19e048bf0aabcbc9f2e4bd65e4d3e68e7772f63f069ea0aff29b10cad49568` |

### Bundled model footprint

| Model | Role | Size |
|-------|------|------|
| `edgeface_s.tflite` | recognition — 112×112 → 512-d ArcFace, **float32** | 14.2 MB |
| `minifasnet.tflite` | passive anti-spoof — 80×80 BGR, 3-class | 5.7 MB |
| **Total** | | **19.9 MB** |

Inside the 20 MB brief. FaceNet-512 is not bundled (~45 MB, misses the target).
EdgeFace-S ships float32 rather than INT8 — a deliberate accuracy tradeoff; see
`docs/NHAI_HACKATHON_ALIGNMENT.md`.

### Notes

- Gradle heap raised to 4 GB to avoid Jetifier memory failures.
- ABI splits enabled for `armeabi-v7a` and `arm64-v8a`.
- Dependency versions pinned to match RN 0.74 and the project's AGP.
- The iOS project shares the same offline auth services, model config, local
  store, and sync client. It is **not built here** — needs macOS + Xcode +
  CocoaPods and an Apple Developer Team for signing.
- `CameraScreen.test.tsx` drives a free-running yaw oscillation against the
  liveness state machine. If its "hands-free verify" case fails, that is a real
  signal about the state machine, not a flaky test to retry.

## Sync Backend

Environment: Express backend in `backend/`, `node:test` via `tsx`.

| Check | Command | Result |
|-------|---------|--------|
| Unit tests | `npm test` | **Passed — 14 suites, 58 tests**, 1.1 s |
| Type-check (incl. tests) | `npm run typecheck` | Passed |
| Build | `npm run build` | Passed |

### Live deployment check

Verified against the running Render instance on 20 August 2026:

```
$ curl https://datalake-face-sync.onrender.com/health
{"ok":true,"store":"postgres"}
```

`GET /admin` without a passcode correctly returns **401**, confirming the ops
console fails closed. Both auth guards refuse to start the process when their
credentials are unset.

> **Note on the free Render tier:** the instance sleeps when idle, so the first
> request after a quiet period can take ~30 s to wake. A second request returns
> immediately. This affects the demo only — never authentication, which is
> entirely on-device.

## Web Mirror

Environment: Vite/React browser demo in `web/`.

| Check | Command | Result |
|-------|---------|--------|
| Lint | `npm run lint` | Passed |
| Build | `npm run build` | Passed |
| E2E | `npm run test:e2e` | Passed — 4 Playwright specs |

Vite emits a large-chunk warning; the production build completes successfully.

## What These Tests Do Not Establish

The suite covers correctness of the pure logic — quality gates, cropping,
alignment, scoring, geofence, liveness state machine, sync/store behaviour — and
that everything compiles and builds. It does **not** establish field accuracy.

Two headline claims remain unmeasured on real hardware:

1. **`>95%` accuracy** on a representative Indian-demographic set. The model
   architecture and threshold are sound, but the number itself is a target, not
   a measurement.
2. **`<1s` recognize + liveness** on a mid-range device. Instrumentation exists
   and displays per-verify latency; the figure needs a physical device.

Additionally, **passive liveness is bundled but not enforced** pending on-device
calibration, so the anti-spoof coverage is the behavioural challenge only. See
`docs/NHAI_HACKATHON_ALIGNMENT.md` for the measured per-attack breakdown.

The codebase is instrumented for all of the above and needs no network
connectivity to perform the measurements.
