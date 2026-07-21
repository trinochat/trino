# Copyright, licensing and commercial use

Copyright (c) 2026 rech. All rights reserved.

"Trino Chat" and its logo are marks of the copyright holder. This document and
the AGPL cover the **code**; they grant no rights to the name or branding. A
fork must ship under a different name. (The unrelated distributed SQL engine
also called "Trino" is a separate project in a different field.)

## Open source licence

Trino Chat is released under the **GNU Affero General Public License v3.0**
(see [`LICENSE`](./LICENSE)).

In plain terms, you are free to use, study, modify and share Trino, **provided
that** any version you distribute — or run as a network service — is also
released under the AGPL-3.0, with its complete source code and this copyright
notice preserved.

That means nobody can take Trino, close it, and ship it as their own
proprietary product. Improvements stay in the open.

## Additional permission for app stores (AGPL section 7)

As an additional permission under section 7 of the GNU Affero General Public
License version 3, you are permitted to distribute this software through an
application store, even if that store's terms and conditions restrict the
freedoms granted by the AGPL (for example device limits, DRM, or redistribution
restrictions).

This mirrors the exception Signal added to its own AGPL notice in 2016. It
exists so that Trino — and any fork complying with the AGPL — can be published
on the Apple App Store, Google Play and similar stores without the licence
conflict that had VLC removed from the App Store in 2011.

## Commercial licence

The AGPL binds everyone **except the copyright holder**. If the AGPL's
obligations do not suit your use — for example you want to embed Trino in a
closed-source product — a separate commercial licence is available.

Contact the copyright holder to arrange one.

## Contributing

Contributions are welcome. Because Trino is dual-licensed, contributors are
asked to agree that their contributions may be distributed **both** under the
AGPL-3.0 **and** under the commercial licence above. Without that agreement a
contribution can only ever be AGPL, which would block commercial licensing of
the project as a whole.

Practically: open a pull request and state in it that you agree to the above.

## Supporting the project

Trino is developed independently. If you want to support it, the most valuable
contributions are:

- reviewing the cryptographic and security-sensitive code;
- reporting vulnerabilities privately before disclosing them publicly;
- testing calls, message delivery and mobile builds on real devices;
- translations.

## Security posture

Trino does **not** claim to be anonymous or metadata-free. Read
[`docs/security-roadmap.md`](./docs/security-roadmap.md) for an honest account
of what is protected today and what is not. Please do not describe Trino as
"more secure than Signal" — that claim requires an external audit that has not
happened yet.
