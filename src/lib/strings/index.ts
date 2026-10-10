/**
 * The app's texts, split by screen area so the units of the redesign each
 * edit their own file. `i18n.ts` merges them into `DICTS`.
 */
import { auth } from './auth';
import { call } from './call';
import { chat } from './chat';
import { common } from './common';
import { contacts } from './contacts';
import { legacy } from './legacy';
import { settings } from './settings';
import { shell } from './shell';
import type { AreaStrings } from './types';

export type { AreaStrings } from './types';

export const AREAS = { legacy, common, auth, shell, chat, contacts, settings, call } as const;

export type AreaName = keyof typeof AREAS;

/**
 * The key prefixes (the text before the first dot) each area may use, so two
 * units never write the same key. `legacy` keeps the prefixes of the old
 * screens; the new areas never reuse them.
 */
export const NAMESPACES: Readonly<Record<AreaName, readonly string[]>> = {
  legacy: [
    'app', 'auth', 'boot', 'call', 'chat', 'common', 'composer', 'contact', 'empty', 'error',
    'file', 'forge', 'group', 'inspector', 'message', 'notification', 'security', 'settings',
    'sidebar', 'sticker', 'theme', 'time', 'ttl', 'unseal', 'updates', 'window',
  ],
  common: ['common2', 'time2'],
  auth: ['onb', 'unlock2', 'start', 'titlebar'],
  shell: ['shell', 'inbox', 'forward'],
  chat: ['chat2', 'composer2', 'msg2', 'channel', 'media', 'emoji', 'sticker2'],
  contacts: ['contacts', 'groupPanel', 'groupNew'],
  settings: ['settings2', 'contactInfo'],
  call: ['call2', 'verify'],
};

/** One dictionary per language with the keys of every area. Areas never share a key. */
export function mergeAreas(areas: Readonly<Record<string, AreaStrings>>): AreaStrings {
  const merged: AreaStrings = { es: {}, en: {}, pt: {} };
  for (const area of Object.values(areas)) {
    for (const lang of Object.keys(merged) as (keyof AreaStrings)[]) Object.assign(merged[lang], area[lang]);
  }
  return merged;
}
