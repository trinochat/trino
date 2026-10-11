// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { classesOf, renderAuth, resetDocument } from '../test-harness';
import { WindowTitlebar, type WindowApi } from './WindowTitlebar';

afterEach(() => {
  cleanup();
  resetDocument();
});

/** A window whose maximized state the test sets. */
function fakeWindow(maximized = false) {
  const state = { maximized };
  const api: WindowApi = {
    minimize: vi.fn(),
    toggleMaximize: vi.fn(() => {
      state.maximized = !state.maximized;
    }),
    close: vi.fn(),
    isMaximized: vi.fn(() => Promise.resolve(state.maximized)),
  };
  return { api, state };
}

/** Lets the pending isMaximized answers arrive. */
const settle = () => act(async () => {});

describe('WindowTitlebar', () => {
  it('has a named button for each window action, and each calls the window', async () => {
    const { api } = fakeWindow();
    renderAuth(<WindowTitlebar api={api} />);
    await settle();
    fireEvent.click(screen.getByRole('button', { name: 'Minimizar' }));
    expect(api.minimize).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Maximizar' }));
    expect(api.toggleMaximize).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Cerrar' }));
    expect(api.close).toHaveBeenCalledTimes(1);
  });

  it('offers to restore a maximized window, and follows the window as it changes', async () => {
    const { api, state } = fakeWindow(true);
    renderAuth(<WindowTitlebar api={api} />);
    await settle();
    expect(screen.getByRole('button', { name: 'Restaurar' })).toBeTruthy();
    // Maximizing from the system (double click, Win + ↑) resizes the page.
    state.maximized = false;
    fireEvent(window, new Event('resize'));
    await settle();
    expect(screen.getByRole('button', { name: 'Maximizar' })).toBeTruthy();
  });

  it('speaks the language of the app', async () => {
    renderAuth(<WindowTitlebar api={fakeWindow().api} />, { lang: 'en' });
    await settle();
    expect(screen.getByRole('button', { name: 'Minimize' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Close' })).toBeTruthy();
  });

  // accesibilidad.md §4.7, rule 7: 36 px at 100 %, never more than 48 px, so
  // at 200 % text the bar does not eat the window. The window is dragged by it.
  it('is a drag region of min(2.25rem, 48px), with the Trino mark and no TRINO://', async () => {
    const { container } = renderAuth(<WindowTitlebar api={fakeWindow().api} />);
    await settle();
    const bar = container.querySelector('[data-tauri-drag-region]');
    expect(bar).not.toBeNull();
    expect(classesOf(bar)).toContain('[height:min(2.25rem,48px)]');
    // TrinoLogo's own drawing, not one of the buttons' icons.
    expect(bar?.querySelector('svg[viewBox="0 0 94 33"]')).not.toBeNull();
    expect(container.textContent).not.toMatch(/TRINO:\/\//i);
  });
});
