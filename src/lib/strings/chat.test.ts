import { describe, it } from 'vitest';
import { chat } from './chat';
import { expectAreaContract } from './contract-test-utils';

// The texts of the chat and the channel. Empty after E0: W3 adds its keys here, with the
// prefixes chat2, composer2, msg2, channel, media, emoji and sticker2, and lists them below.
const KEYS: string[] = [];

describe('chat strings', () => {
  it('have exactly the keys of their screens, in every language', () => {
    expectAreaContract(chat, { keys: KEYS });
  });
});
