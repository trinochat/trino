import { describe, it } from 'vitest';
import { contacts } from './contacts';
import { expectAreaContract } from './contract-test-utils';

// The texts of contacts and groups. Empty after E0: W4 adds its keys here, with the
// prefixes contacts, groupPanel and groupNew, and lists them below.
const KEYS: string[] = [];

describe('contacts strings', () => {
  it('have exactly the keys of their screens, in every language', () => {
    expectAreaContract(contacts, { keys: KEYS });
  });
});
