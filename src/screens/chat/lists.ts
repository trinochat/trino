/** Names as a list in the language of the app: "Ana y Luis", "a.pdf, b.pdf y c.pdf". */
import type { Lang } from '../../lib/i18n';

/**
 * `Intl.ListFormat` is ES2021: every webview Trino runs on has it (Chromium
 * 72, WebKit 14.1), but the project's TypeScript library stops at ES2020.
 */
type ListFormatConstructor = new (lang: string, options: { type: 'conjunction' }) => {
  format(list: readonly string[]): string;
};
const ListFormat = (Intl as unknown as { ListFormat?: ListFormatConstructor }).ListFormat;

export function nameList(names: readonly string[], lang: Lang): string {
  return ListFormat ? new ListFormat(lang, { type: 'conjunction' }).format(names) : names.join(', ');
}
