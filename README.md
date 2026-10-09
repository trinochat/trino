# Trino Chat

An end-to-end encrypted messenger with **no account, no phone number and no
server of its own**. Identity is a key you hold; messages travel over public
[Nostr](https://nostr.com) relays; calls are peer-to-peer WebRTC.

> **Not affiliated with [Trino](https://trino.io), the distributed SQL query
> engine.** Different project, different field — this one is a messenger.

Desktop app built with Tauri 2 (Rust backend, React frontend), for Windows,
macOS and Linux.

A Flutter client for Android and iOS is **in early development** in
[`apps/mobile`](./apps/mobile). It is currently **interface only**: it does not
implement the protocol, does not connect to relays, and cannot send or receive a
message. It is not shipped and not usable. The plan is to bind it to the same
`trino-core` crate the desktop uses, over FFI, rather than reimplement the
cryptography a second time — see [`docs/mobile-client.md`](./docs/mobile-client.md).

## What it does

- **X3DH + Double Ratchet** message encryption, with forward secrecy and
  out-of-order/skipped-message handling.
- **Voice and video calls** over WebRTC (DTLS-SRTP), with a short
  authentication string derived from both DTLS fingerprints so you can detect a
  man-in-the-middle by reading a code aloud.
- **Local vault** sealed with your passphrase + TOTP; history and sessions are
  encrypted at rest, and auto-lock re-seals it after inactivity.
- **Attachments** encrypted client-side before upload; downloads are fetched by
  content hash, never from a URL a sender chose.
- Groups, stickers, replies, disappearing messages, and a signed announcement
  channel whose authority is a pinned OpenPGP key — not the server hosting it.

## What it does *not* claim

Trino is **not anonymous** and **not metadata-free**. Relays can observe IP
addresses, public keys, who you are talking to, when, and roughly how much.
The cryptographic core is **implemented in-house and has not been externally
audited**.

Please read [`docs/security-roadmap.md`](./docs/security-roadmap.md) for an
honest account of what is protected today, what is not, and what is planned.
Do not describe Trino as "more secure than Signal" — that claim would require an
audit that has not happened.

## Building

Requires Node.js, Rust, and the
[Tauri 2 prerequisites](https://v2.tauri.app/start/prerequisites/) for your
platform.

```bash
npm install
npm run tauri dev     # development
npm run tauri build   # release bundles
```

Backend tests:

```bash
cargo test --workspace
```

The protocol and cryptography are not in this repository. They live in
[trinochat/trino-core](https://github.com/trinochat/trino-core), a pure crate
with no Tauri, no networking and no async runtime, so it can be reviewed without
this application around it. Reviewing that crate is the highest-value thing you
can do:

```bash
git clone https://github.com/trinochat/trino-core && cd trino-core && cargo test
```

## Contributing

Contributions are welcome — see [`CONTRIBUTING.md`](./CONTRIBUTING.md). Note
that pull requests must include the contributor licence line described there.

Reviewing the cryptographic code is the single most valuable contribution.

Security issues: **do not open a public issue**, see [`SECURITY.md`](./SECURITY.md).

## Licence

Licensed under the **GNU AGPL-3.0** — see [`LICENSE`](./LICENSE).

You may use, study, modify and share Trino, provided any version you distribute
or run as a service is also AGPL-3.0 with source available. A separate
**commercial licence** is available from the copyright holder for uses the AGPL
does not suit; see [`COPYRIGHT.md`](./COPYRIGHT.md).

## Trademark

"Trino Chat" and its logo are marks of the project's author. The AGPL grants
rights to the **code**, not to the name: forks and derivative distributions must
use a different name and branding, and must not imply endorsement by or
affiliation with this project.

"Trino" on its own is also the name of an unrelated distributed SQL query
engine, which is a separate project in a different field and is not connected to
this one in any way.
