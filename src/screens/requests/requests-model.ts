/**
 * What Solicitudes says of a request (uso responsable UR-4,
 * `Uso responsable/diseno.md` §4.3 and §12.2). Pure, so the tests read it
 * as a table.
 */
import type { RequestView } from '../../lib/api';
import { formatFingerprint } from '../../lib/contact-code';
import type { Lang, TFunction as T } from '../../lib/i18n';

/** Their name as they gave it, or "~name" when the admin of a group wrote it (R-10). */
export function shownName(request: Pick<RequestView, 'name' | 'by_admin'>): string {
  if (!request.name) return '?';
  return request.by_admin ? `~${request.name}` : request.name;
}

/** Where it came from: "por tu @nombre", "usó tu enlace «Para Mara»"… */
export function viaOf(request: Pick<RequestView, 'via'>, t: T): string {
  const { via } = request;
  switch (via.kind) {
    case 'name':
      return t('requests.via.name');
    case 'link':
      return t('requests.via.link', { label: via.label });
    case 'code':
      return t('requests.via.code', { label: via.label });
    case 'group':
      return t('requests.via.group', { group: via.group });
  }
}

/** The first two groups of a fingerprint, as the boards show it: "70A5 83C6". */
export function shortFingerprint(fingerprint: string): string {
  return formatFingerprint(fingerprint).split(' ').slice(0, 2).join(' ');
}

/** The row's second line: their latest text, else that a file came or that they tried to call. */
export function previewOf(request: Pick<RequestView, 'items'>, t: T): string {
  const texts = request.items.filter(item => item.kind === 'text');
  const latest = texts[texts.length - 1];
  if (latest) return latest.text;
  if (request.items.some(item => item.kind === 'file')) return t('requests.previewFile');
  return t('requests.previewCall');
}

export type FileKind = 'photo' | 'video' | 'audio' | 'file';

/** What a file is, by its type, for "Mandó un archivo (foto, 1,2 MB)". */
export function fileKindOf(mime: string): FileKind {
  if (mime.startsWith('image/')) return 'photo';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  return 'file';
}

/** "2 kB", "1,2 MB": the size in the language of the app, as the chat's files say it. */
export function sizeText(bytes: number, lang: Lang): string {
  const kilobytes = bytes / 1024;
  if (kilobytes < 1024) {
    return new Intl.NumberFormat(lang, { style: 'unit', unit: 'kilobyte', maximumFractionDigits: 0 }).format(
      Math.max(1, Math.round(kilobytes)),
    );
  }
  return new Intl.NumberFormat(lang, { style: 'unit', unit: 'megabyte', maximumFractionDigits: 1 }).format(
    kilobytes / 1024,
  );
}
