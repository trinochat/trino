import { describe, it } from 'vitest';
import { chat } from './chat';
import { expectAreaContract } from './contract-test-utils';

// The texts of the chat and the channel (W3), with the prefixes chat2,
// composer2, msg2, channel, media, emoji and sticker2. A call in the chat
// takes its words from callEvent.* (common.ts), not from here.
const KEYS: string[] = [
  // A message: its menu, its states and what it quotes.
  'msg2.options',
  'msg2.reply',
  'msg2.forward',
  'msg2.deleteForMe',
  'msg2.sending',
  'msg2.sent',
  'msg2.failed',
  'msg2.notSent',
  'msg2.notSentOffline',
  'msg2.notSentRejected',
  'msg2.notSentTooLong',
  'msg2.notSentNoSession',
  'msg2.partial',
  'msg2.you',
  'msg2.someone',
  'msg2.ttl',
  'msg2.photo',
  'msg2.video',
  'msg2.sticker',
  'msg2.file',
  'msg2.copied',
  'msg2.copyFailed',
  'msg2.deleteFailed',
  // Pictures, videos, stickers and files in a message, and the viewer.
  'media.view',
  'media.download',
  'media.downloadName',
  'media.downloading',
  'media.downloadFailed',
  'media.unsafe',
  'media.sticker',
  'media.stickerFailed',
  'media.loading',
];

const PLACEHOLDERS: Record<string, string[]> = {
  'msg2.partial': ['names'],
  'msg2.ttl': ['time'],
  'msg2.file': ['name'],
  'media.view': ['name'],
  'media.downloadName': ['name'],
};

describe('chat strings', () => {
  it('have exactly the keys of their screens, in every language', () => {
    expectAreaContract(chat, { keys: KEYS, placeholders: PLACEHOLDERS });
  });
});
