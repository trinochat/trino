# Mobile Client Boundary

## Decision

The mobile edition will be a separate application. It must not import the
desktop React shell, `src/App.tsx`, Tauri window APIs, tray behavior, desktop
permissions, or desktop command bindings.

The initial client lives in `apps/mobile` and uses Flutter for Android and iOS
only. Flutter is a mobile UI/runtime choice, not a way to reuse the desktop
interface. The app owns its own navigation, widgets, state and platform
integrations.

Desktop and mobile should look related, but each client owns its navigation,
layout, lifecycle, permissions, secure storage, notifications, calling UI, and
background behavior.

## What Can Be Shared

- Protocol DTOs and event schemas.
- Pure ratchet, identity, message-envelope, and validation logic.
- Test vectors for encryption, replay handling, attachments, and groups.
- Translation keys and portable design tokens.
- Compatibility tests that prove both clients read and write the same wire
  format.
- The signed announcement schema and verification vectors documented in
  `docs/announcement-channel.md`.

## What Must Stay Platform-Specific

- Desktop: Tauri commands, window controls, tray, filesystem paths, and desktop
  notification behavior.
- Mobile: system key store integration, encrypted local database, biometric
  unlock, push notifications, camera/gallery permissions, background network
  limits, audio routing, and mobile call lifecycle.
- UI: desktop sidebar workflows and mobile navigation must be implemented
  independently.

## Target Boundaries

```text
crates/
  trino-core/          pure protocol, identity, ratchet, groups, validation
  trino-storage/       storage traits and encrypted record types

apps/
  desktop/             current Tauri host and desktop React interface
  mobile/              independent mobile client and native bridge

packages/
  protocol-contracts/  generated DTOs, event schemas, compatibility fixtures
  design-tokens/       colors, spacing, typography values only
```

The current Rust modules should be extracted into `trino-core` only when they
can compile without Tauri types or global desktop state. The desktop command
layer then becomes an adapter around that core. The mobile app should expose
the same operations through its own native bridge.

## Mobile Navigation

- Conversation list as the first screen.
- Bottom navigation on phones and a navigation rail on larger touch devices.
- Dedicated chat and group screens with native back navigation.
- Identity and vault management under a profile/settings route.
- Calls presented through full-screen mobile call surfaces.
- Network diagnostics kept behind an advanced settings route.
- Bottom sheets for attachments and contact details instead of desktop modals.
- Touch targets of at least 44 logical pixels and no hover-only actions.

## Delivery Order

1. Freeze protocol fixtures and cross-client compatibility tests.
2. Extract pure Rust protocol and ratchet code from the Tauri command layer.
3. Define storage and notification interfaces without desktop assumptions.
4. Build mobile identity creation and vault unlock.
5. Add direct messages, groups, attachments, notifications, and calls in that
   order.

Appearance settings and the announcement UI remain native to each client. The
OpenPGP verification logic should move into `trino-core` before the mobile
client connects to production update infrastructure.
