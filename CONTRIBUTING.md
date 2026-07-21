# Contributing to Trino Chat

Thanks for wanting to help. Please read this before opening a pull request —
one part of it is not optional.

## Contributor Licence Agreement (required)

Trino Chat is dual-licensed: **AGPL-3.0** for everyone, plus a separate commercial
licence granted by the copyright holder (see [`COPYRIGHT.md`](./COPYRIGHT.md)).

For that to keep working, every contribution must be usable under **both**
licences. So each pull request must contain this line:

> I agree that my contribution may be distributed under the AGPL-3.0 and under
> the project's commercial licence, as described in COPYRIGHT.md.

**Why this is strictly enforced.** If a contribution is AGPL-only, the project
as a whole can no longer be shipped under other terms. In practice that would
block distribution on the Apple App Store, whose terms are incompatible with
the AGPL — this is exactly why VLC was pulled from the App Store in 2011, after
a single contributor objected. A pull request without the line above cannot be
merged, no matter how good it is.

## Security issues — do not open a public issue

Report vulnerabilities privately (see [`SECURITY.md`](./SECURITY.md)). Give us
time to ship a fix before disclosing.

## What helps most

1. **Reviewing the cryptographic code** — `src-tauri/src/{identity,x3dh,ratchet,vault,crypto}.rs`.
   Trino implements X3DH and the Double Ratchet itself; independent eyes on that
   are worth more than any feature.
2. **Testing on real devices** — calls, message delivery, reconnection, mobile.
3. **Translations** — `src/lib/i18n.ts`.
4. **Reproducible builds** — verifying a build you make matches a release.

## Ground rules for code

- Match the surrounding style; no reformatting unrelated code.
- `cargo test --lib` and `npx tsc --noEmit` must pass.
- Anything touching crypto or the message path needs a test.
- Do not weaken existing security checks (bundle key binding, handshake pinning,
  attachment host validation, freshness gates) without saying so explicitly in
  the pull request.

## Honesty about claims

Do not describe Trino Chat as anonymous, metadata-free, or "more secure than Signal".
See [`docs/security-roadmap.md`](./docs/security-roadmap.md) for what is
actually true today. Overclaiming is treated as a bug.
