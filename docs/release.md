# Cutting a release

## What ships

Desktop only: Windows, macOS (Apple Silicon and Intel) and Linux. The Flutter
client in `apps/mobile` is interface-only and is **not** part of any release —
see [`mobile-client.md`](./mobile-client.md).

## Procedure

```bash
git tag v0.1.0-beta.1
git push origin v0.1.0-beta.1
```

`.github/workflows/release.yml` builds all four bundles and opens a **draft
prerelease** on GitHub. Nothing reaches anyone until you review the artifacts and
press publish.

Keep `version` in `src-tauri/tauri.conf.json` in step with the tag.

## Signing

All signing inputs come from repository secrets. With none of them set the
workflow still succeeds, but the bundles are unsigned. Know what that costs
before inviting testers:

| Platform | Unsigned experience |
|---|---|
| macOS | Gatekeeper blocks it: "cannot be opened because Apple cannot check it for malicious software." On recent macOS the right-click → Open trick no longer works; testers must approve the app in System Settings → Privacy & Security, or clear the quarantine attribute from a terminal. |
| Windows | SmartScreen shows "Windows protected your PC" with the publisher as unknown. |
| Linux | No warning; `.deb` and `.AppImage` install normally. |

For a messenger that asks people to trust it with their private keys, shipping
binaries nobody can verify undercuts the entire proposition. Treat signing as
part of the beta, not as polish afterwards.

### macOS — Apple Developer Program, 99 USD/year

Set `APPLE_CERTIFICATE` (base64 of the exported `.p12`),
`APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`, `APPLE_ID`,
`APPLE_PASSWORD` (an app-specific password, not the account password) and
`APPLE_TEAM_ID`. The workflow then signs and notarises automatically.

Camera and microphone usage descriptions must be present in
`src-tauri/Info.plist` or notarisation-adjacent permission prompts fail at
runtime.

### Windows — code signing certificate

An OV certificate is the cheap option but still trips SmartScreen until it
accumulates reputation. An EV certificate on a hardware token clears SmartScreen
immediately and costs substantially more. Configure via
`bundle.windows.certificateThumbprint` in `tauri.conf.json`, or a custom
`signCommand` for a cloud HSM.

### Updater

`TAURI_SIGNING_PRIVATE_KEY` signs the update manifest so the app only installs
updates you produced. Generate the pair once:

```bash
npm run tauri signer generate
```

Store the private key as a secret. The public key goes into `tauri.conf.json`
under the updater plugin. **This is separate from the OpenPGP key that signs the
announcement channel** — see [`announcement-channel.md`](./announcement-channel.md).
Do not reuse one for the other; they have different threat models and different
rotation stories.

## Before tagging a public beta

Drawn from the P0 list in [`security-roadmap.md`](./security-roadmap.md):

- [ ] CI green on all three desktop platforms
- [ ] `cargo deny check` clean — no advisories, no licence drift
- [ ] Call and TURN hardening; no shared public TURN credentials in the build
- [ ] Vault recovery and encrypted backup path exists and is tested
- [ ] Signed updates working end to end
- [ ] Manual cross-platform pass against the matrix in `security-roadmap.md`
- [ ] Privacy policy published, with no absolute claims
- [ ] README and in-app copy state plainly that the crypto is unaudited
