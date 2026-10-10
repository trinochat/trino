import { describe, it } from 'vitest';
import { shell } from './shell';
import { expectAreaContract } from './contract-test-utils';

// The texts of the shell and the inbox. Empty after E0: W2 adds its keys here, with the
// prefixes shell, inbox and forward, and lists them below.
const KEYS: string[] = [];

describe('shell strings', () => {
  it('have exactly the keys of their screens, in every language', () => {
    expectAreaContract(shell, { keys: KEYS });
  });
});
