/** Types for scripts/gen-sas-assets.mjs, which src/lib/sas-symbols.test.ts imports. */

/** The lucide-react version the drawings are taken from. */
export declare const LUCIDE_VERSION: string;

/** index → [lucide component, es, en, pt]. */
export declare const FROZEN_TABLE: ReadonlyArray<readonly [lucide: string, es: string, en: string, pt: string]>;

/** Both generated files, as their exact text (LF line endings). */
export declare function buildSasAssets(): { json: string; license: string };
