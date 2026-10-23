// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { holdAutoLock, isAutoLockHeld } from './autolock-hold';
import { AUTOLOCK_ACTIVITY_EVENTS, AUTOLOCK_TICK_MS, useAutoLock, type AutoLockOptions } from './useAutoLock';

// The auto-lock of Settings > Cuenta y seguridad. A beta tester wrote that it
// "no funciona": App read the setting only when the chats opened, so a new
// time waited for the next unlock. These tests run on fake timers. A window
// hidden in the tray is a clock that moves while no timer runs, because
// WebView2 holds back the timers of a hidden page.

const SECOND = 1_000;
const MINUTE = 60 * SECOND;

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function setup(initial: Partial<AutoLockOptions> = {}) {
  let busy = false;
  const onLock = vi.fn<(minutes: number) => void>();
  let props: AutoLockOptions = { enabled: true, minutes: 5, isCallBusy: () => busy, isHeld: isAutoLockHeld, onLock, ...initial };
  const hook = renderHook((options: AutoLockOptions) => useAutoLock(options), { initialProps: props });
  return {
    onLock,
    setBusy: (next: boolean) => {
      busy = next;
    },
    /** The app renders again with these options. */
    rerender: (change: Partial<AutoLockOptions>) => {
      props = { ...props, ...change };
      hook.rerender(props);
    },
  };
}

/** Time passes with the window on screen: the timers run. */
const wait = (ms: number) =>
  act(() => {
    vi.advanceTimersByTime(ms);
  });
/** Time passes with the window hidden in the tray: the clock moves, and no timer runs. */
const hiddenFor = (ms: number) => vi.setSystemTime(Date.now() + ms);
/** Someone uses the app: the event starts on the page and bubbles up to the window. */
const use = (type: string) =>
  act(() => {
    document.body.dispatchEvent(new Event(type, { bubbles: true }));
  });

describe('useAutoLock', () => {
  it('locks after the minutes without activity', () => {
    const { onLock } = setup({ minutes: 5 });
    wait(5 * MINUTE - 1);
    expect(onLock).not.toHaveBeenCalled();
    wait(1);
    expect(onLock).toHaveBeenCalledTimes(1);
    expect(onLock).toHaveBeenCalledWith(5);
  });

  it.each(AUTOLOCK_ACTIVITY_EVENTS)('counts the minutes from the start again after a %s', type => {
    const { onLock } = setup({ minutes: 1 });
    wait(50 * SECOND);
    use(type);
    wait(MINUTE - 1);
    expect(onLock).not.toHaveBeenCalled();
    wait(1);
    expect(onLock).toHaveBeenCalledWith(1);
  });

  it('counts activity that a screen kept to itself', () => {
    const { onLock } = setup({ minutes: 1 });
    // A dialog that handles Escape may stop the key there; it was still activity.
    const stop = (event: Event) => event.stopPropagation();
    document.body.addEventListener('keydown', stop);
    try {
      wait(50 * SECOND);
      use('keydown');
      wait(MINUTE - 1);
      expect(onLock).not.toHaveBeenCalled();
      wait(1);
      expect(onLock).toHaveBeenCalledTimes(1);
    } finally {
      document.body.removeEventListener('keydown', stop);
    }
  });

  it('never locks at 0, and counts from the moment it is turned on again', () => {
    const { onLock, rerender } = setup({ minutes: 1 });
    wait(30 * SECOND);
    rerender({ minutes: 0 });
    wait(24 * 60 * MINUTE);
    expect(onLock).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);

    rerender({ minutes: 1 });
    wait(MINUTE - 1);
    expect(onLock).not.toHaveBeenCalled();
    wait(1);
    expect(onLock).toHaveBeenCalledWith(1);
  });

  it('applies a new time at once, counted from the change', () => {
    const { onLock, rerender } = setup({ minutes: 15 });
    wait(2 * MINUTE);
    rerender({ minutes: 1 });
    wait(MINUTE - 1);
    expect(onLock).not.toHaveBeenCalled();
    wait(1);
    expect(onLock).toHaveBeenCalledTimes(1);
    expect(onLock).toHaveBeenCalledWith(1);
  });

  // "Nunca se bloquea durante una llamada" (Settings). A call counts as
  // activity: the minutes start again once it is over, so the end of a call
  // that the other side hung up does not lock at once.
  it('never locks during a call, and counts the minutes again from its end', () => {
    const { onLock, setBusy } = setup({ minutes: 1 });
    setBusy(true);
    // The call goes on for 11.5 minutes, ending as a check sees it.
    const ended = 46 * AUTOLOCK_TICK_MS;
    wait(ended);
    expect(onLock).not.toHaveBeenCalled();
    setBusy(false);
    wait(MINUTE - 1);
    expect(onLock).not.toHaveBeenCalled();
    wait(1);
    expect(onLock).toHaveBeenCalledWith(1);
  });

  it.each([
    ['visibilitychange', () => document.dispatchEvent(new Event('visibilitychange'))],
    ['resume', () => document.dispatchEvent(new Event('resume'))],
    ['focus', () => window.dispatchEvent(new Event('focus'))],
  ])('locks on the %s of a window back from the tray, once its time ran out there', (_name, comeBack) => {
    const { onLock } = setup({ minutes: 1 });
    hiddenFor(5 * MINUTE);
    expect(onLock).not.toHaveBeenCalled();
    act(comeBack);
    expect(onLock).toHaveBeenCalledTimes(1);
    expect(onLock).toHaveBeenCalledWith(1);
  });

  it('checks the time on a tick while the window stays hidden in the tray', () => {
    const { onLock } = setup({ minutes: 1 });
    hiddenFor(2 * MINUTE);
    // The timer set for the deadline is still held back; the next tick runs.
    wait(AUTOLOCK_TICK_MS);
    expect(onLock).toHaveBeenCalledTimes(1);
    expect(onLock).toHaveBeenCalledWith(1);
  });

  it('does not let activity after the time ran out keep Trino open', () => {
    const { onLock } = setup({ minutes: 1 });
    hiddenFor(2 * MINUTE);
    // The pointer moves over the window as it comes back from the tray.
    use('mousemove');
    expect(onLock).toHaveBeenCalledTimes(1);
  });

  it('locks once, and counts again when the chats open again', () => {
    const { onLock, rerender } = setup({ minutes: 1 });
    wait(MINUTE);
    expect(onLock).toHaveBeenCalledTimes(1);
    wait(10 * MINUTE);
    use('keydown');
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    expect(onLock).toHaveBeenCalledTimes(1);

    // Locked: the chats close. Unlocked: they open again.
    rerender({ enabled: false });
    expect(vi.getTimerCount()).toBe(0);
    rerender({ enabled: true });
    wait(MINUTE - 1);
    expect(onLock).toHaveBeenCalledTimes(1);
    wait(1);
    expect(onLock).toHaveBeenCalledTimes(2);
  });

  it('stops counting and listening while the chats are closed', () => {
    const { onLock, rerender } = setup({ minutes: 1 });
    wait(30 * SECOND);
    rerender({ enabled: false });
    wait(10 * MINUTE);
    hiddenFor(10 * MINUTE);
    use('mousemove');
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    expect(onLock).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);

    rerender({ enabled: true });
    wait(MINUTE);
    expect(onLock).toHaveBeenCalledTimes(1);
  });

  // A timer cannot wait longer than 2^31 - 1 ms (24.8 days): past that it
  // fires at once. A stored time that long must neither spin nor lock early.
  it('waits for a time longer than a timer can take in steps it can', () => {
    const later = vi.spyOn(globalThis, 'setTimeout');
    try {
      const { onLock } = setup({ minutes: 40_000 });
      wait(MINUTE);
      expect(onLock).not.toHaveBeenCalled();
      expect(later.mock.calls.length).toBeLessThan(10);
      hiddenFor(40_000 * MINUTE);
      wait(AUTOLOCK_TICK_MS);
      expect(onLock).toHaveBeenCalledWith(40_000);
    } finally {
      later.mockRestore();
    }
  });

  it('keeps counting through a render with new functions, and calls the newest', () => {
    const { onLock, rerender } = setup({ minutes: 1 });
    wait(50 * SECOND);
    const newer = vi.fn<(minutes: number) => void>();
    rerender({ onLock: newer, isCallBusy: () => false });
    wait(10 * SECOND);
    expect(onLock).not.toHaveBeenCalled();
    expect(newer).toHaveBeenCalledWith(1);
  });

  // RC-17 (clave de emergencia, design §8.4): while "Probar mi clave de
  // emergencia" is open, the idle lock waits, so nobody goes on typing the
  // key on the unlock screen. Once it closes, the minutes start again.
  it('waits while the emergency key is being tested, and counts again once it closes', () => {
    const release = holdAutoLock();
    const { onLock } = setup({ minutes: 1 });
    wait(10 * MINUTE);
    hiddenFor(10 * MINUTE);
    wait(AUTOLOCK_TICK_MS);
    expect(onLock).not.toHaveBeenCalled();
    release();
    wait(MINUTE - 1);
    expect(onLock).not.toHaveBeenCalled();
    wait(AUTOLOCK_TICK_MS);
    expect(onLock).toHaveBeenCalledWith(1);
  });

  it('lets a hold go once, however often it is released', () => {
    const first = holdAutoLock();
    const second = holdAutoLock();
    first();
    first();
    expect(isAutoLockHeld()).toBe(true);
    second();
    expect(isAutoLockHeld()).toBe(false);
  });

  it('is held by App only through the test of the emergency key', () => {
    const app = import.meta.glob<string>('../App.tsx', { query: '?raw', import: 'default', eager: true })['../App.tsx'];
    expect(app).toMatch(/useAutoLock\(\{[^}]*isHeld: isAutoLockHeld/s);
  });
});
