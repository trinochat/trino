/**
 * The auto-lock of Settings > Cuenta y seguridad: Trino locks after the
 * minutes chosen there without activity, and never at 0.
 *
 * - **A new time applies at once**, counted from the change. App used to
 *   read the setting only when the chats opened, so a change waited for
 *   the next unlock (a beta tester: "no funciona").
 * - **Never during a call** ("Nunca se bloquea durante una llamada"). A call
 *   counts as activity: every check pushes the time back while it goes on,
 *   so the minutes start again once it is over, and the end of a call the
 *   other side hung up does not lock at once.
 * - **On time from the tray.** WebView2 holds back the timers of a hidden
 *   window, so a timer set for the deadline can fire late. The deadline is a
 *   time of day, checked by its own timer, on a tick, and as the window comes
 *   back (`visibilitychange`, `resume`, `focus`). Activity after the deadline
 *   locks instead of counting again: the pointer passing over a window back
 *   from the tray must not keep Trino open.
 *
 * Activity is heard on the window in the capture phase, so a key a screen
 * stopped (a dialog's Escape) still counts.
 */
import { useEffect, useLayoutEffect, useRef } from 'react';

export interface AutoLockOptions {
  /** The chats are open: only then do the minutes run. */
  enabled: boolean;
  /** Minutes without activity before locking; 0 never locks. */
  minutes: number;
  /** A call is in progress: it counts as activity. */
  isCallBusy(): boolean;
  /** Lock now, after `minutes` without activity. Called once until the chats open again. */
  onLock(minutes: number): void;
}

/** What counts as activity. */
export const AUTOLOCK_ACTIVITY_EVENTS = ['mousedown', 'keydown', 'touchstart', 'mousemove', 'wheel'] as const;

/**
 * How often the deadline is checked besides its own timer. A hidden window
 * gets its timers late (about once a minute after a while in the tray), so
 * this keeps the lock within a check of its time there.
 */
export const AUTOLOCK_TICK_MS = 15_000;

const CAPTURE = { capture: true, passive: true } as const;

/** The longest a timer waits (2^31 - 1 ms, 24.8 days); past that it fires at once. */
const MAX_TIMER_MS = 2_147_483_647;

export function useAutoLock({ enabled, minutes, isCallBusy, onLock }: AutoLockOptions): void {
  // Read when a check runs, so a render with new functions neither re-arms
  // the count nor leaves an old function to be called.
  const latest = useRef({ isCallBusy, onLock });
  useLayoutEffect(() => {
    latest.current = { isCallBusy, onLock };
  });

  useEffect(() => {
    if (!enabled || !(minutes > 0)) return;
    const span = minutes * 60_000;
    let deadline = Date.now() + span;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;

    const stop = () => {
      stopped = true;
      clearTimeout(timer);
      clearInterval(tick);
      for (const type of AUTOLOCK_ACTIVITY_EVENTS) window.removeEventListener(type, onActivity, CAPTURE);
      document.removeEventListener('visibilitychange', check);
      document.removeEventListener('resume', check);
      window.removeEventListener('focus', check);
    };

    /** Locks at or past the deadline, unless a call is on; otherwise waits for the rest. */
    function check() {
      if (stopped) return;
      const now = Date.now();
      if (latest.current.isCallBusy()) deadline = Math.max(deadline, now + span);
      if (now < deadline) {
        clearTimeout(timer);
        timer = setTimeout(check, Math.min(deadline - now, MAX_TIMER_MS));
        return;
      }
      stop();
      latest.current.onLock(minutes);
    }

    function onActivity() {
      const now = Date.now();
      // Late: the time ran out while the timers were held back.
      if (now >= deadline) check();
      else deadline = now + span;
    }

    const tick = setInterval(check, AUTOLOCK_TICK_MS);
    timer = setTimeout(check, Math.min(span, MAX_TIMER_MS));
    for (const type of AUTOLOCK_ACTIVITY_EVENTS) window.addEventListener(type, onActivity, CAPTURE);
    document.addEventListener('visibilitychange', check);
    document.addEventListener('resume', check);
    window.addEventListener('focus', check);
    return stop;
  }, [enabled, minutes]);
}
