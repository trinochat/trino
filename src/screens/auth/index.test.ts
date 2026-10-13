import { describe, expect, it } from 'vitest';
import * as auth from './index';

// What the integration (I1) imports to replace the boot console, ForgeWizard,
// UnsealScreen and the old title bar, all from one place.
describe('the auth screens', () => {
  it('export the screens, the phases and the consent record', () => {
    expect(Object.keys(auth).sort()).toEqual(
      [
        'AuthFrame',
        'CONSENT_STORAGE_KEY',
        'INITIAL_PHASE',
        'OnboardingFlow',
        'PRIVACY_POLICY_URL',
        'PRIVACY_POLICY_VERSION',
        'StartupScreen',
        'StoreReview',
        'UnlockScreen',
        'WindowTitlebar',
        'loadConsentRecord',
        'needsReview',
        'phaseReducer',
        'reviewOf',
      ].sort(),
    );
  });

  it('start the app by reading the status', () => {
    expect(auth.phaseReducer(auth.INITIAL_PHASE, { type: 'statusFailed' })).toEqual({ kind: 'startupError' });
  });
});
