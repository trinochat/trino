/**
 * "Protección reforzada" (cifrado local CL-6b, design §10; David's
 * decision 5): one switch, off by default, that sets stricter values
 * together. Each lives in its own preference and can still be changed on
 * its own afterwards:
 *
 * - the auto-lock after a minute;
 * - locking with Windows, on;
 * - notifications "Nada": only "Trino Chat: Nuevo mensaje", so neither who
 *   writes nor the group shows, and a call does not name who calls;
 * - the window out of captures (`setContentProtected`);
 * - and, while it is on, what you copy is cleared after 30 seconds
 *   (src/lib/clipboard.ts reads the switch).
 *
 * Turning it on remembers what those values were; turning it off gives
 * each back, unless it was changed meanwhile. The window is told first
 * about captures, and only a change it took is kept, as the captures switch
 * does. It never turns the emergency key on, which does not exist yet.
 */
import type { Prefs, ReinforcedBefore } from '../../lib/prefs';

/** The values it sets (design §10). */
export const REINFORCED_VALUES: Readonly<ReinforcedBefore> = Object.freeze({
  autolockMinutes: 1,
  lockWithSystem: true,
  notifPreview: 'none',
  blockCaptures: true,
});

export interface ReinforcedDeps {
  prefs: Prefs;
  /** The window, out of captures or not: `setContentProtected` of the settings' api. */
  setContentProtected(protect: boolean): Promise<void>;
}

/** Whether every value took: the switch says so when one did not. */
export interface ReinforcedResult {
  ok: boolean;
}

/** The values now. */
function current(prefs: Prefs): ReinforcedBefore {
  return {
    autolockMinutes: prefs.getAutolockMinutes(),
    lockWithSystem: prefs.getLockWithSystem(),
    notifPreview: prefs.getNotifPreview(),
    blockCaptures: prefs.getBlockCaptures(),
  };
}

/** Puts `values` in place where they differ; resolves to whether each took. */
async function apply(deps: ReinforcedDeps, values: Partial<ReinforcedBefore>): Promise<boolean> {
  const { prefs } = deps;
  const now = current(prefs);
  let ok = true;
  if (values.autolockMinutes !== undefined && values.autolockMinutes !== now.autolockMinutes) {
    ok = prefs.setAutolockMinutes(values.autolockMinutes) && ok;
  }
  if (values.lockWithSystem !== undefined && values.lockWithSystem !== now.lockWithSystem) {
    ok = prefs.setLockWithSystem(values.lockWithSystem) && ok;
  }
  if (values.notifPreview !== undefined && values.notifPreview !== now.notifPreview) {
    ok = prefs.setNotifPreview(values.notifPreview) && ok;
  }
  if (values.blockCaptures !== undefined && values.blockCaptures !== now.blockCaptures) {
    try {
      await deps.setContentProtected(values.blockCaptures);
      ok = prefs.setBlockCaptures(values.blockCaptures) && ok;
    } catch {
      ok = false;
    }
  }
  return ok;
}

export async function turnOnReinforced(deps: ReinforcedDeps): Promise<ReinforcedResult> {
  const { prefs } = deps;
  // On already: what it remembers is still the values of before.
  let ok = true;
  if (!prefs.getReinforced() || prefs.getReinforcedBefore() === null) {
    ok = prefs.setReinforcedBefore(current(prefs));
  }
  ok = prefs.setReinforced(true) && ok;
  ok = (await apply(deps, REINFORCED_VALUES)) && ok;
  return { ok };
}

export async function turnOffReinforced(deps: ReinforcedDeps): Promise<ReinforcedResult> {
  const { prefs } = deps;
  const before = prefs.getReinforcedBefore();
  let ok = prefs.setReinforced(false);
  if (before) {
    // Only what is still as it set it: a value changed meanwhile stays.
    const now = current(prefs);
    const back: Partial<ReinforcedBefore> = {};
    for (const key of Object.keys(REINFORCED_VALUES) as (keyof ReinforcedBefore)[]) {
      if (now[key] === REINFORCED_VALUES[key]) Object.assign(back, { [key]: before[key] });
    }
    ok = (await apply(deps, back)) && ok;
  }
  ok = prefs.setReinforcedBefore(null) && ok;
  return { ok };
}
