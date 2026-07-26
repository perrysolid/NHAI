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
| `DatalakeFaceAuth-android-universal-release.apk` | One APK for Android judge phones: arm64-v8a + armeabi-v7a | 70 MB | `22c63278f140ec204892e0a0b037219beb605684c78bb4627bad55c54a7497e1` |
| `DatalakeFaceAuth-android-arm64-v8a-release.apk` | Modern 64-bit Android phones | 51 MB | `0720944bf42f737bd49732cf832c2bbb2342117668c36ce1daa497acf9bc3c46` |
| `DatalakeFaceAuth-android-armeabi-v7a-release.apk` | Older 32-bit Android phones | 41 MB | `1494a349b7ea6b0c4cece3486fdac1fd691ac7a197db9e2f3bd95a8e48167308` |

Package details:

- App id: `com.datalakefaceauth`
- Version: `2.2` (versionCode 13 — matches the in-app `v2.2 · build 13` tag)
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
