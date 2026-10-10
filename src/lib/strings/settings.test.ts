import { describe, it } from 'vitest';
import { settings } from './settings';
import { expectAreaContract } from './contract-test-utils';

// The texts of the settings and the contact details. Empty after E0: W5 adds its keys here, with the
// prefixes settings2 and contactInfo, and lists them below.
const KEYS: string[] = [];

describe('settings strings', () => {
  it('have exactly the keys of their screens, in every language', () => {
    expectAreaContract(settings, { keys: KEYS });
  });
});
