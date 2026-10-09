# Security Policy

## Reporting a vulnerability

**Do not open a public issue for a security problem.**

Report it privately through GitHub's *Report a vulnerability* button (Security
tab), which opens a private advisory only the maintainer can see.

Please include: what the flaw is, how to reproduce it, and what an attacker
gains. A proof of concept helps a lot.

You will get an acknowledgement as quickly as the maintainer reasonably can —
this is an independent project, not a funded team, so please be patient. Once a
fix ships, credit will be given in the advisory unless you prefer otherwise.

## Scope

In scope:

- The cryptographic implementation: X3DH, the Double Ratchet, the sealed vault,
  identity/bundle verification.
- The message and call-signalling path, including replay, injection and
  session-desync handling.
- Attachment handling, the announcement channel signature check, and anything
  that could leak the user's IP or link them to their identity.
- Anything letting a peer, a relay, or a network attacker read, forge, suppress
  or attribute messages.

Out of scope:

- Weaknesses in the public Nostr relays themselves, or the fact that relays can
  observe metadata — this is a known, documented limitation. See
  [`docs/security-roadmap.md`](./docs/security-roadmap.md).
- Attacks requiring an already-compromised device or an unlocked vault.
- Social engineering.

## What Trino does *not* claim

Trino is **not** anonymous and **not** metadata-free today. Relays can observe
IP addresses, public keys, recipients, timing and approximate volume. Trino has
**not** had an external cryptographic audit, and its X3DH/Double Ratchet
implementation is written in-house rather than using an audited library.

Treat it accordingly, and read `docs/security-roadmap.md` before relying on it.
