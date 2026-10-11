/**
 * The password meter of the first run (Onboarding:100-106): a local
 * heuristic with no dependencies, by length alone. The policy itself lives in
 * Rust (`passphrase.rs`, through `checkPassphrase`), so this never decides
 * whether a password is accepted; it only says how it compares, and drops to
 * weak once the policy said no (plan §1.1).
 */

export type Strength = 'weak' | 'fair' | 'good' | 'strong';

/** The policy's minimum (David, R3.3), the first length that is not weak. */
const FAIR_FROM = 10;
const GOOD_FROM = 15;
const STRONG_FROM = 20;

/**
 * How many of the meter's four bars each level fills: the level is drawn by
 * the count, not by the colour, and is said in words beside it.
 */
export const STRENGTH_BARS: Readonly<Record<Strength, number>> = { weak: 1, fair: 2, good: 3, strong: 4 };

export interface StrengthOptions {
  /** The policy rejected this password, such as a common one. */
  failsPolicy?: boolean;
}

/**
 * The level of a password, or null while it is empty. Length counts Unicode
 * scalars (`[...s].length`), as the backend does, so an emoji is one.
 */
export function passphraseStrength(passphrase: string, { failsPolicy = false }: StrengthOptions = {}): Strength | null {
  if (passphrase === '') return null;
  const length = [...passphrase].length;
  if (failsPolicy || length < FAIR_FROM) return 'weak';
  if (length < GOOD_FROM) return 'fair';
  if (length < STRONG_FROM) return 'good';
  return 'strong';
}
