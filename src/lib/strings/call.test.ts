import { describe, it } from 'vitest';
import { call } from './call';
import { expectAreaContract } from './contract-test-utils';

// The texts of calls and verification. Empty after E0: W6 adds its keys here, with the
// prefixes call2 and verify, and lists them below.
const KEYS: string[] = [];

describe('call strings', () => {
  it('have exactly the keys of their screens, in every language', () => {
    expectAreaContract(call, { keys: KEYS });
  });
});
