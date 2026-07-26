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
| `DatalakeFaceAuth-android-universal-release.apk` | One APK for Android judge phones: arm64-v8a + armeabi-v7a | 70 MB | `8c0682ddc0bf972b516d810eeb0606da9f00caafd8625787db98dc3f72fa22dd` |
| `DatalakeFaceAuth-android-arm64-v8a-release.apk` | Modern 64-bit Android phones | 51 MB | `d54e8c2636e5ae9ccf9d2e9e646f536dd6dd425e8c005201527e4eaabdaedaa0` |
| `DatalakeFaceAuth-android-armeabi-v7a-release.apk` | Older 32-bit Android phones | 41 MB | `3ba6077f94ff56e03ff58b3d82cc050b78513b50aa1712666032d58e298aaaca` |

Package details:

- App id: `com.datalakefaceauth`
- Version: `2.5` (versionCode 16 — matches the in-app `v2.5 · build 16` tag)
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
