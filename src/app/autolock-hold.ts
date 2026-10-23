/**
 * What holds the idle lock back besides a call (RC-17, clave de emergencia
 * design §8.4): while "Probar mi clave de emergencia" is open, Trino does not
 * lock for lack of activity. Locking in the middle of the test would leave
 * the person typing the emergency key on the unlock screen, where it erases
 * everything. A lock the system asks for (Windows locking, the computer
 * going to sleep) is not held: the test's own text warns about it.
 *
 * Holds are counted, so two screens holding at once both have to let go.
 * Each release counts once, however often it is called.
 */
import { useEffect } from 'react';

let holds = 0;

/** Holds the idle lock back until the function it returns is called. */
export function holdAutoLock(): () => void {
  holds += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    holds -= 1;
  };
}

/** Whether something holds the idle lock back now (useAutoLock's `isHeld`). */
export function isAutoLockHeld(): boolean {
  return holds > 0;
}

/** Holds the idle lock back while `active`, and while the component is on screen. */
export function useAutoLockHold(active = true): void {
  useEffect(() => (active ? holdAutoLock() : undefined), [active]);
}
