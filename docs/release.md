# Cutting a release

## What ships

Windows and Linux. The Linux job produces a `.deb`, an `.rpm` and an
`.AppImage`; the AppImage is the one to hand to anyone not on Debian or Fedora,
Arch included.

**macOS is not built.** The code compiles there — CI proved it before the step
that failed — but bundling requires a Developer ID certificate and the workflow
cannot produce an unsigned `.app` without one. See "macOS" below.

The Flutter client in `apps/mobile` is interface-only and is **not** part of any
release — see [`mobile-client.md`](./mobile-client.md).

## Procedure

```bash
git tag v0.1.0-beta.1
git push origin v0.1.0-beta.1
```

`.github/workflows/release.yml` builds the Windows and Linux bundles and opens a **draft
prerelease** on GitHub. Nothing reaches anyone until you review the artifacts and
press publish.

Keep `version` in `src-tauri/tauri.conf.json` in step with the tag.

## Signing

Signing inputs come from repository secrets. Windows and Linux build fine
without them and ship unsigned; macOS does not, which is why it is out of the
matrix. Know what unsigned costs before inviting testers:

| Platform | Unsigned experience |
|---|---|
| Windows | SmartScreen shows "Windows protected your PC" with the publisher as unknown. |
| Linux | No warning; `.deb` and `.AppImage` install normally. |

For a messenger that asks people to trust it with their private keys, shipping
binaries nobody can verify undercuts the entire proposition. Treat signing as
part of the beta, not as polish afterwards.

### macOS — Apple Developer Program, 99 USD/year

macOS is currently absent from the release matrix. Bringing it back takes two
things, and the second is the one that is easy to get wrong.

First, the secrets. Set `APPLE_CERTIFICATE` (base64 of the exported `.p12`),
`APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`, `APPLE_ID`,
`APPLE_PASSWORD` (an app-specific password, not the account password) and
`APPLE_TEAM_ID`. The workflow then signs and notarises automatically.

Second, the wiring. Tauri decides to codesign by checking whether
`APPLE_CERTIFICATE` is **present**, not whether it contains anything. A
workflow-level `env:` key always defines the variable — empty when the secret
does not exist — so listing the secrets under `env:` sends every macOS build
into the signing path, where it dies on an empty `.p12` with
`SecKeychainItemImport: One or more parameters passed to a function were not
valid`. Export them from a step that skips them when no certificate is
configured, so the variables genuinely do not exist until one is.

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

Trino has its own updater, through Tor (Tor design §6; not Tauri's plugin,
which cannot go through Tor). Its minisign key was generated once by David
with `tauri signer generate`, password-protected; the public half is built
into the program (`crates/trino-net/src/update/sig.rs`, key id
`2A6861FC701B75D7`) and the private half stays with him: it is **not** a
repository secret and CI never signs updates. Each release's installer is
signed by hand with `tauri signer sign`, which asks for the password, and
published with its `latest.json`: the steps are in
[`updater.md`](./updater.md). **This is separate from the OpenPGP key that
signs the announcement channel** — see
[`announcement-channel.md`](./announcement-channel.md). Do not reuse one for
the other; they have different threat models and different rotation stories.

Windows ships one NSIS installer, per user (`bundle.targets` has no `msi`).

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
