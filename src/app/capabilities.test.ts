import { afterEach, describe, expect, it, vi } from 'vitest';
import { capabilities } from './capabilities';

// Which backend pieces of the redesign this build has (plan §4, supplement
// §7 and §8). A screen hides what is missing; it never fakes it.
describe('capabilities', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('names the pieces the screens ask about', () => {
    expect(Object.keys(capabilities).sort()).toEqual([
      'callLog',
      'changePassphrase',
      'diagnosticLog',
      'groupMembers',
      'inviteLinks',
      'manageGroups',
      'messageRequests',
      'names',
      'profileSync',
      'relayStatus',
      'totp',
    ]);
  });

  // The group details (I4) show what W8 brought in I0: the members matched
  // to contacts by key (K9), and removing, renaming, leaving and deleting (K10).
  it('turns on the members of a group and managing it, which came in with I0', () => {
    expect(capabilities.groupMembers).toBe(true);
    expect(capabilities.manageGroups).toBe(true);
  });

  it('turns on the shared profile (K12) and the call log (K13), which came in with I0', () => {
    expect(capabilities.profileSync).toBe(true);
    expect(capabilities.callLog).toBe(true);
  });

  // Settings (I2) shows what W7 brought in I0: the relays' real state (K3),
  // two-step verification on and off (K5) and a new password (K6).
  it('turns on the relays’ state, two-step verification and the password change, which came in with I0', () => {
    expect(capabilities.relayStatus).toBe(true);
    expect(capabilities.totp).toBe(true);
    expect(capabilities.changePassphrase).toBe(true);
  });

  // After T3 (W7) only a debug build writes trino-gui.log, and `tauri dev`
  // runs one with Vite's dev server; the exe writes none, so Settings must
  // not say that it does.
  it('says there is a diagnostic log only in a development build', async () => {
    vi.stubEnv('DEV', false);
    vi.resetModules();
    expect((await import('./capabilities')).capabilities.diagnosticLog).toBe(false);

    vi.stubEnv('DEV', true);
    vi.resetModules();
    expect((await import('./capabilities')).capabilities.diagnosticLog).toBe(true);
  });

  // "Construir ya, encender con Tor" (David, 11 Oct): their unit turns them on.
  it('keeps invite links, message requests and @names off until they travel over Tor', () => {
    expect(capabilities.inviteLinks).toBe(false);
    expect(capabilities.messageRequests).toBe(false);
    expect(capabilities.names).toBe(false);
  });

  it('cannot be changed while the app runs', () => {
    expect(Object.isFrozen(capabilities)).toBe(true);
  });
});
