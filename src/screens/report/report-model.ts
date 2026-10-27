/**
 * What the report's three steps show (uso responsable UR-5, PropReportar;
 * `Uso responsable/diseno.md` §6.2 and U24). What goes is decided again in
 * Rust (`trino_engine::report`): this only says it.
 */
import type { ReportCategory, ReportMode, ReportPick } from '../../lib/api';
import type { Lang, TFunction } from '../../lib/i18n';
import type { Msg } from '../types';

/** The kinds of design §6.2, in their order. */
export const REPORT_CATEGORIES: readonly ReportCategory[] = [
  'spam',
  'harassment',
  'impersonation',
  'fraud',
  'ncii',
  'child',
  'other',
];

/** The one you touched and 10 more (design §6.2), as Rust caps them. */
export const MAX_PICKS = 11;

/** A message or a file that may go: its own key, whose, and how Rust finds it. */
export interface ReportCandidate {
  key: string;
  mine: boolean;
  ts: number;
  text?: string;
  file?: { mime: string; size: number };
  pick: ReportPick;
}

/** Intimate images and a child at risk carry no content at all (U2, §8.2). */
export function takesNoContent(category: ReportCategory): boolean {
  return category === 'child' || category === 'ncii';
}

/** What a kind starts with (U2): spam, only the key; the rest, with messages. */
export function defaultMode(category: ReportCategory): ReportMode {
  if (takesNoContent(category)) return 'description_only';
  return category === 'spam' ? 'key_only' : 'messages';
}

/**
 * What may go of a chat: everything but the calls; in a group (`from`, the
 * reported member's name here), only theirs and yours (design test 26).
 */
export function candidatesOf(messages: readonly Msg[], from: string | null): ReportCandidate[] {
  return messages
    .filter(message => !message.call && (message.text !== undefined || message.file !== undefined))
    .filter(message => from === null || message.side === 'me' || message.from === from)
    .map(message => ({
      key: message.key,
      mine: message.side === 'me',
      ts: message.ts,
      ...(message.text !== undefined && { text: message.text }),
      ...(message.file && { file: { mime: message.file.mime, size: message.file.size } }),
      pick: {
        ts: message.ts,
        side: message.side,
        from: message.from ?? null,
        text: message.file ? null : (message.text ?? null),
        sha256: message.file?.sha256 ?? null,
      },
    }));
}

/** "1A2B 3C4D 5E6F 7A8B", as the boards write a fingerprint. */
export function shownFingerprint(fingerprint: string): string {
  return fingerprint.replace(/\./g, ' ').toUpperCase();
}

export interface ConfirmInput {
  /** How the dialog names them. */
  name: string;
  fingerprint: string;
  /** The name they gave themselves, if known: the one that goes. */
  selfName: string | null;
  category: ReportCategory;
  mode: ReportMode;
  chosen: readonly ReportCandidate[];
  note: string;
}

/** PropReportar card 4: the exact list of what goes, and what does not. */
export function confirmLines(t: TFunction, input: ConfirmInput): { sends: string[]; notSent: string } {
  const fingerprint = shownFingerprint(input.fingerprint);
  const withMessages = !takesNoContent(input.category) && input.mode === 'messages';
  const chosen = withMessages ? input.chosen : [];
  const theirs = chosen.filter(candidate => !candidate.mine && !candidate.file).length;
  const mine = chosen.filter(candidate => candidate.mine && !candidate.file).length;
  const files = chosen.filter(candidate => candidate.file).length;
  const sends = [
    t(input.selfName ? 'report.sendsKey' : 'report.sendsKeyNoName', { name: input.name, fingerprint }),
  ];
  if (theirs > 0) sends.push(theirs === 1 ? t('report.sendsTheirsOne') : t('report.sendsTheirs', { n: theirs }));
  if (mine > 0) sends.push(mine === 1 ? t('report.sendsMineOne') : t('report.sendsMine', { n: mine }));
  if (files > 0) sends.push(t('report.sendsMedia', { n: files }));
  sends.push(t('report.sendsKind', { kind: t(`report.cat.${input.category}`) }));
  if (input.note.trim() !== '') sends.push(t('report.sendsNote'));
  return { sends, notSent: t(withMessages && chosen.length > 0 ? 'report.notSentMessages' : 'report.notSent') };
}

export interface ReportData {
  id: string;
  /** "2026-10-13", as Rust gives it. */
  day: string;
  category: ReportCategory;
  fingerprint: string;
  selfName: string | null;
  note: string;
}

/** "13 oct 2026": a UTC day in the language of the app. */
function shownDay(day: string, lang: Lang): string {
  const at = Date.parse(`${day}T12:00:00Z`);
  if (Number.isNaN(at)) return day;
  return new Intl.DateTimeFormat(lang, { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })
    .format(at)
    .replace(/\./g, '')
    .replace(/ de /g, ' ');
}

/**
 * "Copiar datos del reporte" (U24): the block for an e-mail to
 * abuso@trinochat.org. Never a message, a photo or an attachment.
 */
export function reportData(t: TFunction, lang: Lang, data: ReportData): string {
  const lines = [
    t('report.dataTitle', { id: data.id }),
    t('report.dataKind', { kind: t(`report.cat.${data.category}`) }),
    t('report.dataFingerprint', { fingerprint: shownFingerprint(data.fingerprint) }),
  ];
  if (data.selfName) lines.push(t('report.dataName', { name: data.selfName }));
  lines.push(t('report.dataDay', { day: shownDay(data.day, lang) }));
  if (data.note.trim() !== '') lines.push(t('report.dataNote', { note: data.note.trim() }));
  return lines.join('\n');
}
