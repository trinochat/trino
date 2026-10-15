# Trino mobile (demo)

The Flutter app of Trino for Android and iOS. **For now it is a demo:** the
screens run on an in-memory fake engine (`lib/engine/fake_engine.dart`) with
sample chats and contacts. Nothing leaves the phone, nothing is stored, and no
real message is sent or received. The shared Rust engine will replace the fake
one behind the same `TrinoEngine` interface
(see [`docs/mobile-client.md`](../../docs/mobile-client.md)).

On both platforms the app is called "Trino" under its icon and has the id
`org.trinochat.app`. The launcher icons are rendered from
`assets/brand/trino-logo-calma.svg`: one opaque 1024 px square for iOS, which
rounds the corners itself, and for Android a 48 dp tile plus an adaptive icon
whose middle 72 dp is the Calma tile.

## What the demo shows

The screens follow the approved phone mockups of the redesign (Calma and
Terminal, light and dark): four tabs (Chats, Llamadas, Contactos, Ajustes), the
Tor state said in words under the Chats title, message requests in a grey row
above the chats, the call key as the SAS v2 outline symbols, Cuenta y seguridad
(optional fingerprint, how often the passphrase is asked again, Protección
reforzada), Dispositivos, the connection screens (bridges, connecting without
protection, what others see), the first run and linking this phone to the
computer by QR.

What the demo cannot do yet is behind small interfaces with a demo
implementation, so no package was added:

- **Camera:** `lib/platform/qr_scanner.dart`. The scanner says it does not use
  the camera and offers "Simular escaneo (demostración)"; the demo computer
  confirms the link by itself after 4 seconds.
- **Fingerprint and Face ID:** `lib/platform/biometrics.dart`.
- **Tor, bridges, requests, devices and the call history:** the fake engine.

The SAS table (`assets/sas/sas-v2.json`) is a byte-for-byte copy of the
desktop's (`feat/rediseno @ 7b3d454`); `assets/sas/.gitattributes` keeps Git from
changing its line endings. The real engine must give the seven indices the
desktop computes for the same call.

## Screenshots

```sh
flutter test test/screenshots --dart-define=TRINO_SHOTS_DIR=<folder>
```

renders the screens in Calma light and Terminal dark to PNG files. Without the
folder those tests are skipped.

## Requirements

It needs Flutter 3.47.5 stable, the version pinned in `pubspec.yaml`. Android
builds also need the Android SDK. iOS builds need a Mac, so they run on GitHub
Actions.

## Tests

```sh
flutter pub get
flutter analyze
flutter test
```

`test/config/` reads the native projects: the app ids, the name under the icon,
the launcher icons, the TestFlight export options and the export compliance
answer.

## Android APK

```sh
flutter build apk --release --split-per-abi
```

The APKs land in `build/app/outputs/flutter-apk/`; most phones take
`app-arm64-v8a-release.apk`. There is no release key yet, so the release build
is signed with the debug key: fine for testing, not for a store.

## iOS on TestFlight

[`.github/workflows/ios-testflight.yml`](../../.github/workflows/ios-testflight.yml)
builds the app on a macOS runner (`macos-26`, Xcode 26.6) and uploads it to App
Store Connect. The archive is built unsigned; `xcodebuild -exportArchive` then
signs it with the team's cloud-managed distribution certificate, through an App
Store Connect API key, and uploads it. So it needs neither a Mac nor a
registered device.

One-time setup:

1. **The app in App Store Connect.** Apps, then + and New App, with the bundle
   id `org.trinochat.app` (team `3KD8QNQXH6`).
2. **An API key.** Users and Access, Integrations, App Store Connect API, Team
   Keys, then Generate API Key, with the **Admin** role, which cloud signing
   from `xcodebuild` needs. Download the `.p8` file: Apple offers it only once.
3. **Three repository secrets** in GitHub (Settings, Secrets and variables,
   Actions, New repository secret):

   | Secret | What to paste |
   | --- | --- |
   | `ASC_KEY_ID` | The key's Key ID, from the keys table. |
   | `ASC_ISSUER_ID` | The Issuer ID shown above the keys table. |
   | `ASC_KEY_P8` | The whole `AuthKey_<Key ID>.p8` file, with its `BEGIN` and `END` lines. |

Each upload:

1. In GitHub, open Actions, then **iOS TestFlight**, then Run workflow, and
   choose the branch to build. GitHub only lists the workflow once its file is
   on the default branch. The build number is the run number, so upload again
   with a new run: re-running a run that already uploaded reuses its number,
   which App Store Connect rejects.
2. In App Store Connect, open the app, then TestFlight. Under Internal Testing,
   create a group with + and invite yourself. Once the build finishes processing
   (a few minutes), add it to the group, or turn on automatic distribution.
3. On the iPhone, install TestFlight from the App Store, accept the invitation
   with the same Apple Account, and install Trino.

Without a Mac this workflow cannot be tried locally: its first real run is the
test.

## Export compliance

`ios/Runner/Info.plist` declares `ITSAppUsesNonExemptEncryption` as `false`, so
App Store Connect does not ask about encryption on every build. That answer is
true **only for this demo**, whose fake engine has no cryptography of its own
and which only uses the system's HTTPS. When the real engine and its end-to-end
encryption are wired in, the key must become `true`, and the account holder must
answer Apple's export compliance questions. Trino uses standard algorithms that
iOS does not provide, which points to the US mass-market self-classification
(ECCN 5D992.c, EAR § 740.17(b)(1); the old encryption registration number no
longer exists) and, if the app is offered in France, the French encryption
declaration. `test/config/export_compliance_test.dart` fails while the plist
says `false` and `main()` runs on any engine other than the demo one.

## Sources

- `xcodebuild` flags (`-allowProvisioningUpdates`, `-authenticationKeyPath`,
  `-authenticationKeyID`, `-authenticationKeyIssuerID`, `-exportArchive`):
  [man page](https://keith.github.io/xcode-man-pages/xcodebuild.1.html). Run
  `xcodebuild -help` for the export options (`method`, `destination`,
  `signingStyle`, `teamID`, `manageAppVersionAndBuildNumber`).
- [Cloud-managed certificates](https://developer.apple.com/help/account/certificates/cloud-managed-certificates),
  [team API keys](https://developer.apple.com/documentation/appstoreconnectapi/creating-api-keys-for-app-store-connect-api)
  (individual keys cannot use the provisioning endpoints), and
  [cloud signing with an Admin key](https://developer.apple.com/forums/thread/698117).
- Why the archive is unsigned: signing it needs a development certificate on
  the machine, which a fresh runner mints anew each time
  ([fastlane discussion](https://github.com/fastlane/fastlane/discussions/19973);
  [a workflow that hit the certificate limit and moved signing to the export](https://github.com/hideoutgames/zremote/pull/64)).
- [Uploading builds](https://developer.apple.com/help/app-store-connect/manage-builds/upload-builds)
  (iOS apps must be built with Xcode 26 or later) and
  [internal testers](https://developer.apple.com/help/app-store-connect/test-a-beta-version/add-internal-testers).
- [Single-size app icon](https://developer.apple.com/documentation/xcode/configuring-your-app-icon);
  an App Store icon with alpha is rejected with ITMS-90717
  ([Apple forums](https://developer.apple.com/forums/thread/795411)).
- [`flutter build ios --config-only` in CI](https://docs.flutter.dev/deployment/cd).
- [Runner images](https://github.com/actions/runner-images) and
  [running a workflow by hand](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/manually-run-a-workflow).
- Export compliance:
  [Apple's guide](https://developer.apple.com/documentation/security/complying-with-encryption-export-regulations),
  [App Store Connect overview](https://developer.apple.com/help/app-store-connect/manage-app-information/overview-of-export-compliance),
  [2021 BIS rule on mass-market reporting](https://www.thompsonhine.com/publications/bis-eliminates-most-mass-market-encryption-reporting-obligations).
