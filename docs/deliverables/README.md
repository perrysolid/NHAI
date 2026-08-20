# Judge Mobile Package

This folder contains the installable Android build for hackathon judges plus the iOS packaging notes.

Direct APK:
https://github.com/perrysolid/NHAI/raw/main/docs/deliverables/DatalakeFaceAuth-android-universal-release.apk

## Android APKs

Install the universal APK on a judge phone:

```bash
adb install -r docs/deliverables/DatalakeFaceAuth-android-universal-release.apk
```

| File | Target device | Size | SHA-256 |
|------|---------------|------|---------|
| `DatalakeFaceAuth-android-universal-release.apk` | One APK for all Android phones: arm64-v8a + armeabi-v7a | 82 MB | `88f11ef9001f981b005554f42860c3bbc7deb557b8a92b3e932e04234a9be403` |
| `DatalakeFaceAuth-android-arm64-v8a-release.apk` | Modern 64-bit Android phones (recommended) | 63 MB | `19ed56e990a8dcf1952a2f3e8f3de8ec4384c30a6cf3d85b8d691919963d55c7` |
| `DatalakeFaceAuth-android-armeabi-v7a-release.apk` | Older 32-bit Android phones | 53 MB | `db19e048bf0aabcbc9f2e4bd65e4d3e68e7772f63f069ea0aff29b10cad49568` |

Package details:

- App id: `com.datalakefaceauth`
- Version: `4.2` (versionCode **36**) — confirmed with `aapt dump badging`
- Branch: `main`
- Recognition model: **EdgeFace-S Float32** (14 MB, 512-dim ArcFace — full precision)
- Threshold: `0.65` cosine similarity (genuine ~0.90–0.98, impostor ~0.20–0.50)
- Android minimum: API 26 / Android 8.0+
- Auth path: verification is fully offline — liveness, recognition, matching, and queueing need no network. Enrollment is an online registration (template + role sent to the backend); attendance syncs when back online.
- Bundled model assets: `edgeface_s.tflite` (14.2 MB Float32) + `minifasnet.tflite` (5.7 MB)

## What is in this build

- **One enrollment per device.** A phone belongs to a single inspector; enrolling
  anyone else requires Settings -> Reset device. Several templates on one phone
  would verify whoever matched best, which is a way to mark a colleague present.
- **Per-action liveness deadline.** Each blink/smile/turn must be completed within
  its own window (4s blink/smile, 5s turns) measured from the moment it is asked
  for, rather than sharing one 30s budget. This is the anti-relay control.
- **Voice stops once a verify resolves** instead of narrating over the result.
- **Offline queue fixes.** Failed verifies no longer produce records the backend
  refuses forever, and the queue is bounded.

### Honest scope of the anti-spoof

Blocks printed photos, static images on a screen, and slow or naive replays.
**Passive screen detection (MiniFASNet) is bundled but not enforced** — it is
pending on-device calibration, so a tight looping video, a live video-call relay,
and virtual-camera injection are **not** blocked in this build. See CLAUDE.md §5
for the measurements behind that statement.


## iOS

iOS does not use APK files. The iOS installable equivalent is a signed `.ipa`, usually distributed through TestFlight or direct device installation with an Apple provisioning profile.

The iOS project is included here:

```text
app/ios/DatalakeFaceAuth.xcodeproj
```

Build steps once Apple signing is available:

```bash
cd app
npm install
cd ios
pod install
open DatalakeFaceAuth.xcodeproj
```

Then in Xcode:

1. Select the `DatalakeFaceAuth` target.
2. Choose an Apple Developer Team.
3. Set a valid bundle identifier and provisioning profile.
4. Product -> Archive.
5. Distribute as TestFlight or export a signed `.ipa`.

The React Native source and offline auth flow are shared from the same `app/` codebase; only Apple signing/export is missing locally.
