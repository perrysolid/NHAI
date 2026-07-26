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
| `DatalakeFaceAuth-android-universal-release.apk` | One APK for Android judge phones: arm64-v8a + armeabi-v7a | 70 MB | `ea0a709ed3de21fbf4a83b09b8cf5f87d1d64a0ccdae509b4a8c972799884371` |
| `DatalakeFaceAuth-android-arm64-v8a-release.apk` | Modern 64-bit Android phones | 51 MB | `3edc3fd68d8ca19d445dccb4c39a26a34dd67b02b7e3451f8b3bb9f292ead6d0` |
| `DatalakeFaceAuth-android-armeabi-v7a-release.apk` | Older 32-bit Android phones | 41 MB | `f860562f22f726df061ebb2be08bacf7e7e2ce168b266456c9357667ca3e4e00` |

Package details:

- App id: `com.datalakefaceauth`
- Version: `1.9` (versionCode 10 — matches the in-app `v1.9 · build 10` tag)
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
