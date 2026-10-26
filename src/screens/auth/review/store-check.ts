/**
 * What the one dialog at unlock shows (cifrado local CL-2b, design §6.1,
 * §6.2 and §11.4), from the report the backend sends with the unlock answer
 * (src-tauri/src/store/report.rs). The backend decides what happens to each
 * file; this only sorts the findings into one question for everything that
 * waits for a choice, the lines that only tell what Trino did, and the offer
 * about files of an earlier version. Pure, so the tests read it as a table.
 */
import type { IntegrityReport, MigrationNote, UnsealResponse } from '../../../lib/api';

/** What a file holds, as the dialog names it. */
export type ItemId =
  | 'account'
  | 'prefs'
  | 'history'
  | 'sessions'
  | 'profiles'
  | 'requests'
  | 'stickers'
  | 'index'
  | 'vault'
  | 'store'
  | 'other';

/** The files that ask; their texts say what each answer risks. */
export type AskItem = 'account' | 'prefs' | 'history' | 'profiles' | 'other';

/** What the dialog tells about a file Trino handled by itself. */
export type NoticeKind =
  | 'altered'
  | 'unlisted'
  | 'olderAside'
  | 'missing'
  | 'missingPrefs'
  | 'missingStickers'
  | 'newSessions'
  | 'unreadable'
  | 'held'
  | 'index'
  | 'vaultChanged'
  | 'totpFlag'
  | 'otherAccount'
  | 'storeMissing';

export interface Notice {
  item: ItemId;
  kind: NoticeKind;
}

/**
 * One question for every file that waits (design §6.1: "una sola pregunta").
 * `older` when every one is a copy older than the last Trino wrote, else
 * `unverified`: nothing could tell whether they are the last.
 */
export interface Question {
  kind: 'older' | 'unverified';
  /** The logical names, for `store_choose`. */
  files: string[];
  /** What they hold, once each, in order. */
  items: AskItem[];
}

export interface StoreCheck {
  question: Question | null;
  notices: Notice[];
  /** Files of an earlier version that nothing shows are this account's (design §4.8). */
  plainFiles: boolean;
}

/** What the step between unlocking and the chats needs from the unlock answer. */
export interface Review {
  integrity?: IntegrityReport;
  migration?: MigrationNote;
  /** TRINO_HOME chose the data folder: the note says the others wait. */
  customDataDir: boolean;
}

/** Files of earlier versions that the migration names, by what they held. */
const OLD_FILES: Readonly<Record<string, ItemId>> = {
  'config.json': 'account',
  'friends.json': 'account',
  'groups.json': 'account',
  'group_invites.json': 'account',
  'history.bin': 'history',
  'ratchets.bin': 'sessions',
  'profiles.bin': 'profiles',
  'profiles.bin.damaged': 'profiles',
};

const STORE_ITEMS: readonly ItemId[] = [
  'account',
  'prefs',
  'history',
  'sessions',
  'profiles',
  // Solicitudes (UR-4): it never asks, it is only told.
  'requests',
  'index',
  'vault',
  'store',
];

/** What `file`, a logical name of the store or a file of before, holds. */
export function itemOf(file: string): ItemId {
  if ((STORE_ITEMS as readonly string[]).includes(file)) return file as ItemId;
  if (file.startsWith('sticker:') || file.startsWith('stickers/') || file === 'stickers') return 'stickers';
  return OLD_FILES[file] ?? 'other';
}

const asked = (item: ItemId): AskItem =>
  item === 'account' || item === 'prefs' || item === 'history' || item === 'profiles' ? item : 'other';

/** The line about one finding Trino handled by itself, or none when there is nothing to tell. */
function noticeOf(file: string, what: string, action: string): Notice | null {
  const item = itemOf(file);
  if (action === 'use') return null;
  if (item === 'store') return { item, kind: what === 'otherAccount' ? 'otherAccount' : 'storeMissing' };
  if (item === 'vault') return { item, kind: what === 'totpFlag' ? 'totpFlag' : 'vaultChanged' };
  if (item === 'index') return { item, kind: 'index' };
  if (action === 'newSessions') return { item, kind: 'newSessions' };
  // Kept as it is and never written this session: one that could not be
  // read now, or an earlier version's history that does not open (H2).
  if (action === 'keepForLater') return { item, kind: what === 'unreadable' ? 'unreadable' : 'held' };
  switch (what) {
    case 'unlisted':
      return { item, kind: 'unlisted' };
    case 'olderCopy':
      return { item, kind: 'olderAside' };
    case 'missing':
      if (item === 'prefs') return { item, kind: 'missingPrefs' };
      if (item === 'stickers') return { item, kind: 'missingStickers' };
      return { item, kind: 'missing' };
    default:
      return { item, kind: 'altered' };
  }
}

/** The dialog for `report`, or null when there is nothing to show. */
export function storeCheckOf(report: IntegrityReport | undefined): StoreCheck | null {
  const files: string[] = [];
  const items: AskItem[] = [];
  let allOlder = true;
  const notices: Notice[] = [];
  let plainFiles = false;
  for (const { file, what, action } of report?.findings ?? []) {
    if (action === 'offerImport') {
      plainFiles = true;
    } else if (action === 'ask') {
      if (!files.includes(file)) files.push(file);
      const item = asked(itemOf(file));
      if (!items.includes(item)) items.push(item);
      allOlder &&= what === 'olderCopy';
    } else {
      const notice = noticeOf(file, what, action);
      if (notice && !notices.some(n => n.item === notice.item && n.kind === notice.kind)) notices.push(notice);
    }
  }
  const question: Question | null = files.length > 0 ? { kind: allOlder ? 'older' : 'unverified', files, items } : null;
  if (!question && notices.length === 0 && !plainFiles) return null;
  return { question, notices, plainFiles };
}

/** What the step before the chats keeps of the unlock answer: never the preferences. */
export function reviewOf(response: UnsealResponse): Review {
  return {
    ...(response.integrity ? { integrity: response.integrity } : {}),
    ...(response.migration ? { migration: response.migration } : {}),
    customDataDir: response.custom_data_dir,
  };
}

/** Whether the unlock answer stops before the chats: something to tell or ask, or the note after the migration. */
export function needsReview(response: UnsealResponse): boolean {
  return storeCheckOf(response.integrity) !== null || response.migration !== undefined;
}
