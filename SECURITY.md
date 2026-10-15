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
- Anything that makes a connection leave without Tor (other than a call's
  audio and video), or makes Trino fall back to a direct connection without
  the user asking. See [`docs/tor.md`](./docs/tor.md).
- The updater: its signature checks, its mirrors and redirects, and the
  permit it uses without Tor when Arti is obsolete
  ([`docs/updater.md`](./docs/updater.md)).
- Private bridge lines left in the clear, on disk or in the interface.
- Anything letting a peer, a relay, or a network attacker read, forge, suppress
  or attribute messages.

Out of scope:

- Weaknesses in the public Nostr relays themselves, or the fact that relays can
  observe metadata — this is a known, documented limitation. See
  [`docs/security-roadmap.md`](./docs/security-roadmap.md).
- What Cloudflare sees of a call (both IPs), what an internet provider sees of
  Tor, and what WebView2 sends to Microsoft by itself: documented below and in
  [`docs/tor.md`](./docs/tor.md).
- Weaknesses in Tor or Arti themselves; report those to the Tor Project.
- Attacks requiring an already-compromised device or an unlocked vault.
- Social engineering.

## What Trino does *not* claim

Trino is **not** anonymous and **not** metadata-free today. On the desktop it
connects through Tor by default, so relays see a Tor exit rather than your IP
address, but:

- relays still see public keys, recipients, timing and approximate volume, so
  they still see who writes to whom, until the planned protocol change with
  one-time envelope keys and rotating mailboxes;
- a call's audio and video go through Cloudflare's TURN relay outside Tor, so
  Cloudflare sees your IP address and your contact's;
- without a bridge, your internet provider sees that you use Tor, and can tell
  from its TLS fingerprint that it is not Tor Browser;
- WebView2 and Windows send their own data to Microsoft, including WebView2's
  crash reports for now.

Trino has **not** had an external cryptographic audit, and its X3DH/Double
Ratchet implementation is written in-house rather than using an audited
library.

Treat it accordingly, and read `docs/security-roadmap.md` before relying on it.
