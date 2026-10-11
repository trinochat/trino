/**
 * The rows of the inbox (Main:87-111): one per contact, per group and for the
 * announcements channel, in order of their last activity, with the preview,
 * draft, unread count, trust and mute of each. Pure, so the shell and its
 * tests build the same rows.
 */
import type { Announcement } from '../../lib/announcements';
import type { GroupInfo, NodeInfo } from '../../lib/api';
import { callEventText } from '../../lib/call-events';
import { convoKey } from '../../lib/convo';
import type { TFunction } from '../../lib/i18n';
import { identityInitials } from '../../lib/initials';
import type { InboxFilter, InboxItem, Msg, Trust } from '../types';

export interface InboxSources {
  nodes: readonly NodeInfo[];
  groups: readonly GroupInfo[];
  /** The announcements channel: its latest post, whether it is unread, whether it is muted. */
  channel: { latest?: Announcement; unread: number; muted?: boolean };
  /** By conversation key, in order of `ts`. */
  messages: Readonly<Record<string, readonly Msg[]>>;
  unread: Readonly<Record<string, number>>;
  drafts: ReadonlyMap<string, string>;
  trust: Readonly<Record<string, Trust>>;
  /** The gids of the muted groups. */
  mutedGroups?: ReadonlySet<string>;
  t: TFunction;
}

/** A sticker travels as a file named `sticker::<id>.<ext>`, as the old screens send it. */
const isSticker = (name: string) => name.startsWith('sticker::');

/** The one line of a chat row: the last message, said from the reader's side. */
export function previewOf(msg: Msg, isGroup: boolean, t: TFunction): string {
  // A call's own text names its direction: "Llamada saliente · 4 min".
  if (msg.call) return callEventText(msg.call, t, 'chat');
  const body = msg.file
    ? isSticker(msg.file.name)
      ? t('inbox.preview.sticker')
      : t('inbox.preview.file', { name: msg.file.name })
    : msg.text ?? '';
  if (msg.side === 'me') return t('inbox.preview.you', { text: body });
  return isGroup && msg.from ? `${msg.from}: ${body}` : body;
}

/** Epoch seconds of an announcement, or undefined for a date that does not read. */
function announcementTs(item: Announcement): number | undefined {
  const ms = Date.parse(item.publishedAt);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : undefined;
}

interface Ranked {
  item: InboxItem;
  /** When the chat was last active; a contact not written to yet counts from when it was added. */
  activity: number;
}

export function buildInboxItems(sources: InboxSources): InboxItem[] {
  const { messages, unread, drafts, trust, t } = sources;
  const last = (key: string) => {
    const list = messages[key];
    return list && list.length > 0 ? list[list.length - 1] : undefined;
  };
  const shared = (key: string) => {
    const draft = drafts.get(key);
    return { unread: unread[key] ?? 0, ...(draft && { draft }) };
  };

  const contacts: Ranked[] = sources.nodes.map(node => {
    const ref = { kind: 'contact' as const, handle: node.handle };
    const key = convoKey(ref);
    const msg = last(key);
    const nodeTrust = trust[node.handle];
    return {
      activity: msg?.ts ?? node.added_at,
      item: {
        ref,
        key,
        name: node.handle,
        avatar: { initials: identityInitials(node.handle), kind: 'person', ...(node.avatar && { src: node.avatar }) },
        ...(msg && { preview: previewOf(msg, false, t), lastTs: msg.ts }),
        ...shared(key),
        ...(nodeTrust && { trust: nodeTrust }),
      },
    };
  });

  const groups: Ranked[] = sources.groups.map(group => {
    const ref = { kind: 'group' as const, gid: group.gid };
    const key = convoKey(ref);
    const msg = last(key);
    return {
      activity: msg?.ts ?? 0,
      item: {
        ref,
        key,
        name: group.name,
        avatar: { initials: identityInitials(group.name), kind: 'group' },
        ...(msg && { preview: previewOf(msg, true, t), lastTs: msg.ts }),
        ...shared(key),
        ...(sources.mutedGroups?.has(group.gid) && { muted: true }),
      },
    };
  });

  const { latest } = sources.channel;
  const latestTs = latest ? announcementTs(latest) : undefined;
  const channel: Ranked = {
    activity: latestTs ?? 0,
    item: {
      ref: { kind: 'channel' },
      key: convoKey({ kind: 'channel' }),
      name: t('inbox.channel'),
      avatar: { initials: 'T', kind: 'person' },
      ...(latest && { preview: latest.title }),
      ...(latestTs !== undefined && { lastTs: latestTs }),
      unread: sources.channel.unread,
      ...(sources.channel.muted && { muted: true }),
    },
  };

  return [...contacts, ...groups, channel]
    .sort((a, b) => b.activity - a.activity || a.item.name.localeCompare(b.item.name))
    .map(ranked => ranked.item);
}

/** Lower case without accents, so "alvaro" finds "Álvaro". */
function fold(text: string): string {
  return text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

/**
 * The chats a chip and a search leave. `keep` names a chat the chip does not
 * hide: the shell's open chat, opened from this list, which reading takes
 * out of "No leídos" while its row has the focus. The search still applies.
 */
export function filterItems(
  items: readonly InboxItem[],
  filter: InboxFilter,
  query: string,
  keep: string | null = null,
): InboxItem[] {
  const needle = fold(query.trim());
  return items.filter(item => {
    if (item.key !== keep) {
      if (filter === 'unread' && !(item.unread > 0)) return false;
      if (filter === 'groups' && item.ref.kind !== 'group') return false;
    }
    return !needle || fold(item.name).includes(needle) || fold(item.preview ?? '').includes(needle);
  });
}
