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
  'inbox.draft',
  'inbox.unread',
  'inbox.group',
  'inbox.muted',
  'inbox.trust.verified',
  'inbox.trust.keyChanged',
  // The head of the sidebar, its search and its chips.
  'inbox.newChat',
  'inbox.newCall',
  'inbox.connection.connected',
  'inbox.connection.connecting',
  'inbox.connection.offline',
  'inbox.search.label',
  'inbox.search.placeholder',
  'inbox.filter.label',
  'inbox.filter.all',
  'inbox.filter.unread',
  'inbox.filter.groups',
  'inbox.empty',
  'inbox.noMatch',
  'inbox.firstContact',
  'inbox.addWithCode',
  'inbox.invites.notice',
  'inbox.stranger.notice',
  'inbox.notice.view',
  // The tabs and the call log (PropLlamadas).
  'inbox.tabs.label',
  'inbox.tabs.chats',
  'inbox.tabs.calls',
  'inbox.tabs.callsMissed',
  'inbox.tabs.callsMissedA11y',
  'inbox.tabs.callsMissedA11yOne',
  'inbox.calls.filterLabel',
  'inbox.calls.all',
  'inbox.calls.missed',
  'inbox.calls.listLabel',
  'inbox.calls.callTo',
  'inbox.calls.empty',
  'inbox.calls.emptyMissed',
  'inbox.calls.lockedNote',
  // The foot of the sidebar.
  'inbox.profile.caption',
  'inbox.profile.share',
  'inbox.profile.settings',
];

const PLACEHOLDERS: Record<string, string[]> = {
  'inbox.preview.you': ['text'],
  'inbox.preview.file': ['name'],
  'inbox.connection.connected': ['up', 'total'],
  'inbox.noMatch': ['q'],
  'inbox.tabs.callsMissed': ['n'],
  'inbox.tabs.callsMissedA11y': ['n'],
  'inbox.calls.callTo': ['name'],
};

describe('shell strings', () => {
  it('have exactly the keys of their screens, in every language', () => {
    expectAreaContract(shell, { keys: KEYS, placeholders: PLACEHOLDERS });
  });
});
