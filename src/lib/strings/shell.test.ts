import { describe, it } from 'vitest';
import { shell } from './shell';
import { expectAreaContract } from './contract-test-utils';

// The texts of the shell and the inbox (W2), with the prefixes shell, inbox and forward.
const KEYS: string[] = [
  // The rows of the inbox.
  'inbox.channel',
  'inbox.preview.you',
  'inbox.preview.file',
  'inbox.preview.sticker',
];

const PLACEHOLDERS: Record<string, string[]> = {
  'inbox.preview.you': ['text'],
  'inbox.preview.file': ['name'],
};

describe('shell strings', () => {
  it('have exactly the keys of their screens, in every language', () => {
    expectAreaContract(shell, { keys: KEYS, placeholders: PLACEHOLDERS });
  });
});
