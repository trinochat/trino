/** Types for scripts/arti-monthly.mjs, which src/lib/arti-monthly.test.ts imports. */

/** The version of `name` in a Cargo.lock, or null. */
export declare function lockedVersion(lockText: string, name: string): string | null;

/** The `[package]` version of a Cargo.toml. */
export declare function manifestVersion(manifestText: string): string;

/** The newest stable version, from crates.io's answer for a crate. */
export declare function stableVersion(json: string): string;

/** Whether version `a` is newer than `b` (x.y.z, by number). */
export declare function isNewer(a: string, b: string): boolean;

/** The root Cargo.toml without the saturating-time patch entry. */
export declare function dropPatch(manifestText: string): string;

/** The month's summary, and whether something needs a look. */
export declare function report(input: {
  arti: { current: string; latest: string };
  saturating: { vendored: string; latest: string; unpatched: string };
  smoke: string;
}): { attention: boolean; markdown: string };
