import { describe, expect, it } from 'vitest';
import type { Announcement } from '../../lib/announcements';
import type { FileRef, GroupInfo, NodeInfo } from '../../lib/api';
import { makeT } from '../../lib/i18n';
import type { InboxItem, Msg } from '../types';
import { buildInboxItems, filterItems, type InboxSources } from './inbox-model';

const t = makeT('es');
const T0 = 1_760_000_000;

const node = (handle: string, over: Partial<NodeInfo> = {}): NodeInfo => ({
  handle,
  fingerprint: `fp-${handle}`,
  has_session: true,
  added_at: T0 - 86_400,
  ...over,
});

const group = (gid: string, name: string, over: Partial<GroupInfo> = {}): GroupInfo => ({
  gid,
  name,
  epoch: 1,
  is_admin: false,
  member_count: 4,
  members: [],
  ...over,
});

const text = (side: Msg['side'], ts: number, body: string, from?: string): Msg => ({
  key: `${ts}:0`,
  side,
  ts,
  text: body,
  ...(from && { from }),
});

const FILE: FileRef = { url: 'u', key: 'k', sha256: 's', mime: 'application/pdf', name: 'contrato.pdf', size: 1 };

const NEWS: Announcement = {
  id: 'n1',
  title: 'Ya está la beta 2',
  body: '…',
  publishedAt: new Date((T0 - 3600) * 1000).toISOString(),
};

function sources(over: Partial<InboxSources> = {}): InboxSources {
  return {
    nodes: [],
    groups: [],
    channel: { unread: 0 },
    messages: {},
    unread: {},
    drafts: new Map(),
    trust: {},
    t,
    ...over,
  };
}

const names = (items: readonly InboxItem[]) => items.map(item => item.name);

describe('buildInboxItems', () => {
  it('makes one row per contact, per group and for the channel, with their keys and references', () => {
    const items = buildInboxItems(
      sources({ nodes: [node('Ana', { avatar: 'data:image/png;base64,AA' })], groups: [group('g1', 'Familia')] }),
    );
    const byKey = Object.fromEntries(items.map(item => [item.key, item]));
    expect(byKey.Ana).toMatchObject({
      ref: { kind: 'contact', handle: 'Ana' },
      name: 'Ana',
      avatar: { initials: 'AN', src: 'data:image/png;base64,AA', kind: 'person' },
      unread: 0,
    });
    expect(byKey['grp:g1']).toMatchObject({ ref: { kind: 'group', gid: 'g1' }, name: 'Familia', avatar: { kind: 'group' } });
    expect(byKey.channel).toMatchObject({ ref: { kind: 'channel' }, name: 'Novedades de Trino' });
  });

  it('puts the most recent activity first', () => {
    const items = buildInboxItems(
      sources({
        nodes: [node('Ana'), node('Carlos'), node('Nuevo', { added_at: T0 + 500 })],
        groups: [group('g1', 'Familia')],
        channel: { latest: NEWS, unread: 0 },
        messages: {
          Ana: [text('them', T0 + 100, 'hola')],
          Carlos: [text('them', T0 - 7200, 'viejo')],
          'grp:g1': [text('them', T0 + 300, 'Llego a las 7', 'Papá')],
        },
      }),
    );
    // A contact added just now and not written to yet goes by the time it was added.
    expect(names(items)).toEqual(['Nuevo', 'Familia', 'Ana', 'Novedades de Trino', 'Carlos']);
    // Its row shows no time: there is no message yet.
    expect(items[0]?.lastTs).toBeUndefined();
    expect(items[1]?.lastTs).toBe(T0 + 300);
  });

  it('previews the last message: mine with "Tú:", a group sender by name, files, stickers and calls', () => {
    const sticker: FileRef = { ...FILE, name: 'sticker::abc.png', mime: 'image/png' };
    const items = buildInboxItems(
      sources({
        nodes: [node('Ana'), node('Bea'), node('Carlos'), node('Dani')],
        groups: [group('g1', 'Familia')],
        messages: {
          Ana: [text('me', T0, 'nos vemos')],
          Bea: [{ key: 'k', side: 'them', ts: T0, file: FILE }],
          Carlos: [{ key: 'k', side: 'me', ts: T0, file: sticker }],
          Dani: [
            text('them', T0, 'te llamo'),
            {
              key: 'call:x',
              side: 'them',
              ts: T0 + 5,
              call: { id: 'x', direction: 'incoming', video: false, outcome: 'missed', durationSec: 0 },
            },
          ],
          'grp:g1': [text('them', T0, 'Llego a las 7', 'Papá')],
        },
      }),
    );
    const preview = (key: string) => items.find(item => item.key === key)?.preview;
    expect(preview('Ana')).toBe('Tú: nos vemos');
    expect(preview('Bea')).toBe('Archivo: contrato.pdf');
    expect(preview('Carlos')).toBe('Tú: Sticker');
    // The call's own text names who called.
    expect(preview('Dani')).toBe('Llamada perdida');
    expect(preview('grp:g1')).toBe('Papá: Llego a las 7');
  });

  it('carries the draft, the unread count, the trust and the muted groups and channel', () => {
    const items = buildInboxItems(
      sources({
        nodes: [node('Ana')],
        groups: [group('g1', 'Familia'), group('g2', 'Trabajo')],
        channel: { latest: NEWS, unread: 1, muted: true },
        unread: { Ana: 2, 'grp:g2': 5 },
        drafts: new Map([['Ana', 'Mañana te confirmo']]),
        trust: { Ana: 'verified' },
        mutedGroups: new Set(['g2']),
      }),
    );
    const byKey = Object.fromEntries(items.map(item => [item.key, item]));
    expect(byKey.Ana).toMatchObject({ draft: 'Mañana te confirmo', unread: 2, trust: 'verified' });
    expect(byKey.Ana?.muted).toBeFalsy();
    expect(byKey['grp:g1']?.muted).toBeFalsy();
    expect(byKey['grp:g2']).toMatchObject({ unread: 5, muted: true });
    expect(byKey.channel).toMatchObject({ unread: 1, muted: true, preview: 'Ya está la beta 2' });
  });
});

describe('filterItems', () => {
  const items = buildInboxItems(
    sources({
      nodes: [node('Ana'), node('Álvaro'), node('Carlos')],
      groups: [group('g1', 'Familia')],
      channel: { latest: NEWS, unread: 1 },
      messages: { Carlos: [text('them', T0, 'Te envié el contrato')] },
      unread: { Ana: 1 },
    }),
  );

  it('shows everything, the unread chats or the groups', () => {
    expect(filterItems(items, 'all', '')).toHaveLength(5);
    expect(names(filterItems(items, 'unread', '')).sort()).toEqual(['Ana', 'Novedades de Trino']);
    expect(names(filterItems(items, 'groups', ''))).toEqual(['Familia']);
  });

  it('searches names and previews, ignoring case and accents', () => {
    expect(names(filterItems(items, 'all', 'alvaro'))).toEqual(['Álvaro']);
    expect(names(filterItems(items, 'all', 'ANA'))).toEqual(['Ana']);
    expect(names(filterItems(items, 'all', 'contrató'))).toEqual(['Carlos']);
    expect(names(filterItems(items, 'all', '  beta  '))).toEqual(['Novedades de Trino']);
    expect(filterItems(items, 'groups', 'ana')).toEqual([]);
  });

  // Opening an unread chat reads it; under "No leídos" its row would vanish
  // with the focus on it. The shell keeps that one row until the chip or the
  // chat changes; the search still applies, since you typed it.
  it('keeps one chat whatever the chip, but not past the search', () => {
    expect(names(filterItems(items, 'unread', '', 'Carlos')).sort()).toEqual(['Ana', 'Carlos', 'Novedades de Trino']);
    expect(names(filterItems(items, 'groups', '', 'Carlos'))).toEqual(['Carlos', 'Familia']);
    expect(names(filterItems(items, 'unread', 'ana', 'Carlos'))).toEqual(['Ana']);
    expect(filterItems(items, 'unread', '', null)).toEqual(filterItems(items, 'unread', ''));
  });
});
