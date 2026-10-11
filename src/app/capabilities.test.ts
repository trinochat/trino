import { describe, expect, it } from 'vitest';
import { capabilities } from './capabilities';

// Which backend pieces of the redesign this build has (plan §4, supplement
// §7 and §8). A screen hides what is missing; it never fakes it.
describe('capabilities', () => {
  it('names the five pieces the screens ask about', () => {
    expect(Object.keys(capabilities).sort()).toEqual(['callLog', 'inviteLinks', 'messageRequests', 'names', 'profileSync']);
  });

  it('turns on the shared profile (K12) and the call log (K13), which came in with I0', () => {
    expect(capabilities.profileSync).toBe(true);
    expect(capabilities.callLog).toBe(true);
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
