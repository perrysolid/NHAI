# Judge Mobile Package

This folder contains the installable Android build for hackathon judges plus the iOS packaging notes.

Direct APK:
https://github.com/perrysolid/NHAI/raw/feature/edgeface-s-int8-recognition/docs/deliverables/DatalakeFaceAuth-android-universal-release.apk

## Android APKs

Install the universal APK on a judge phone:

```bash
adb install -r docs/deliverables/DatalakeFaceAuth-android-universal-release.apk
```

| File | Target device | Size | SHA-256 |
|------|---------------|------|---------|
| `DatalakeFaceAuth-android-universal-release.apk` | One APK for all Android phones: arm64-v8a + armeabi-v7a | 67 MB | `daa2769a850ee59bf12e0a2fc8010074706410cfabaf9a63ac9eb703d1f41a4f` |
| `DatalakeFaceAuth-android-arm64-v8a-release.apk` | Modern 64-bit Android phones (recommended) | 47 MB | `72c0f9563aaa8de53443f19d7beba3feec026bec42ef80d9a28fdc1a03d5b1a2` |
| `DatalakeFaceAuth-android-armeabi-v7a-release.apk` | Older 32-bit Android phones | 37 MB | `7a28e6652b7dff5bee07e6642961470ffcd7e58b58a940c80199b06ba6754562` |

Package details:

- App id: `com.datalakefaceauth`
- Version: `3.0` (versionCode 22)
- Branch: `feature/edgeface-s-int8-recognition`
- Recognition model: **EdgeFace-S Float32** (14 MB, 512-dim ArcFace — full precision)
- Threshold: `0.65` cosine similarity (genuine ~0.90–0.98, impostor ~0.20–0.50)
- Android minimum: API 26 / Android 8.0+
- Auth path: verification is fully offline — liveness, recognition, matching, and queueing need no network. Enrollment is an online registration (template + role sent to the backend); attendance syncs when back online.
- Bundled model assets: `edgeface_s.tflite` (14 MB Float32) + `minifasnet.tflite` (5.7 MB)


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
