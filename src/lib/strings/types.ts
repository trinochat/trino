import type { Lang } from '../i18n';

/** The texts of one screen area: for each language, its keys and their texts. */
export type AreaStrings = Record<Lang, Record<string, string>>;
