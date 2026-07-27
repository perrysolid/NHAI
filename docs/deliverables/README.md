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
| `DatalakeFaceAuth-android-universal-release.apk` | One APK for Android judge phones: arm64-v8a + armeabi-v7a | 70 MB | `0d3f3e1f0e116a76e30941ea96ba0e101809850a5e58cb95464682e61eb021ef` |
| `DatalakeFaceAuth-android-arm64-v8a-release.apk` | Modern 64-bit Android phones | 51 MB | `06b2ccebe1bf97b2eda3811fa1b03e5485115dac09c1994d42257bcab97999a5` |
| `DatalakeFaceAuth-android-armeabi-v7a-release.apk` | Older 32-bit Android phones | 41 MB | `54fbdd340404a2f3ad788e9cbc87e2a2ef1028f366944e5a48c3d333fbd17711` |

Package details:

- App id: `com.datalakefaceauth`
- Version: `3.0` (versionCode 22 — matches the in-app `v3.0 · build 22` tag)
- Android minimum: API 26 / Android 8.0+
- Auth path: verification is fully offline — liveness, recognition, matching, and queueing need no network. Enrollment is an online registration (template + role sent to the backend); attendance syncs when back online.
- Bundled model assets were verified inside the release APK.
- The Gradle release build also emits smaller ABI-split APKs locally if needed.

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
