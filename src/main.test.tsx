// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// What main.tsx does before the first render. Everything it starts is
// replaced, so only the order and the calls are checked here.
const setContentProtected = vi.fn(async (_on: boolean) => {});
const render = vi.fn();

vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => ({ setContentProtected }) }));
vi.mock('react-dom/client', () => ({ default: { createRoot: () => ({ render }) } }));
vi.mock('./App', () => ({ default: () => null }));
vi.mock('./design/apply', () => ({ initAppearance: vi.fn() }));
vi.mock('./design/fonts', () => ({}));

beforeEach(() => {
  vi.resetModules();
  setContentProtected.mockClear();
  render.mockClear();
  localStorage.clear();
});

afterEach(() => localStorage.clear());

// SC-1: the stored choice reaches the window before the app, and so before
// the unlock screen, is drawn.
describe('main.tsx', () => {
  it('keeps the window out of captures by default, before the first render', async () => {
    await import('./main');
    expect(setContentProtected.mock.calls).toEqual([[true]]);
    expect(render).toHaveBeenCalledTimes(1);
    expect(setContentProtected.mock.invocationCallOrder[0]).toBeLessThan(render.mock.invocationCallOrder[0]!);
  });

  it('lets captures through when you turned it off in Settings', async () => {
    localStorage.setItem('trino.pref.blockCaptures', '0');
    await import('./main');
    expect(setContentProtected.mock.calls).toEqual([[false]]);
    expect(setContentProtected.mock.invocationCallOrder[0]).toBeLessThan(render.mock.invocationCallOrder[0]!);
  });
});
