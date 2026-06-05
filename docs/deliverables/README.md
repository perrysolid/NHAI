# Judge Mobile Package

This folder contains the installable Android build for hackathon judges plus the iOS packaging notes.

[Download Android APK](https://github.com/perrysolid/NHAI/raw/main/docs/deliverables/DatalakeFaceAuth-android-universal-release.apk)

## Android APKs

Install the universal APK on a judge phone:

```bash
adb install -r docs/deliverables/DatalakeFaceAuth-android-universal-release.apk
```

| File | Target device | Size | SHA-256 |
|------|---------------|------|---------|
| `DatalakeFaceAuth-android-universal-release.apk` | One APK for Android judge phones: arm64-v8a + armeabi-v7a | 69 MB | `acc6ede77a8c017b4e99d114d06db4a957df7510507bd9966784502fb2def79f` |

Package details:

- App id: `com.datalakefaceauth`
- Version: `1.0`
- Android minimum: API 26 / Android 8.0+
- Auth path: fully offline; no network call is required for enrollment, liveness, recognition, matching, or queueing.
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
