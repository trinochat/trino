/**
 * The app's texts, split by screen area so the units of the redesign each
 * edit their own file. `i18n.ts` merges them into `DICTS`.
 */
import { auth } from './auth';
import { call } from './call';
import { chat } from './chat';
import { common } from './common';
import { contacts } from './contacts';
import { emergency } from './emergency';
import { net } from './net';
import { settings } from './settings';
import { shell } from './shell';
import type { AreaStrings } from './types';

export type { AreaStrings } from './types';

export const AREAS = { common, auth, shell, chat, contacts, settings, call, net, emergency } as const;

export type AreaName = keyof typeof AREAS;

/**
 * The key prefixes (the text before the first dot) each area may use, so two
 * units never write the same key.
 */
export const NAMESPACES: Readonly<Record<AreaName, readonly string[]>> = {
  common: ['common2', 'time2', 'callEvent'],
  auth: ['onb', 'unlock2', 'start', 'titlebar', 'integrity', 'migrated'],
  shell: ['shell', 'inbox', 'forward'],
  chat: ['chat2', 'composer2', 'msg2', 'channel', 'media', 'emoji', 'sticker2'],
  contacts: ['contacts', 'groupPanel', 'groupNew'],
  settings: ['settings2', 'contactInfo'],
  call: ['call2', 'verify'],
  // Tor in the app (TOR-6): the first run's step, the inbox's line, the panels and Ajustes › Conexión.
  net: ['net'],
  // The emergency key (CE-5): its page of Settings, its dialogs and the network.
  emergency: ['emergency'],
};

/** One dictionary per language with the keys of every area. Areas never share a key. */
export function mergeAreas(areas: Readonly<Record<string, AreaStrings>>): AreaStrings {
  const merged: AreaStrings = { es: {}, en: {}, pt: {} };
  for (const area of Object.values(areas)) {
    for (const lang of Object.keys(merged) as (keyof AreaStrings)[]) Object.assign(merged[lang], area[lang]);
  }
  return merged;
}
