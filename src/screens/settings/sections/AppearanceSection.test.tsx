// @vitest-environment jsdom
import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ACCESSIBILITY_STORAGE_KEY } from '../../../design/accessibility';
import { holdAccessibility, holdAppearance, holdScanLines } from '../../../design/apply';
import { APPEARANCE_STORAGE_KEY, resolveTokens } from '../../../design/appearance';
import { AppearanceProvider } from '../../../design/useAppearance';
import { fakeHost, renderEs } from '../test-utils';
import { AppearanceSection } from './AppearanceSection';

afterEach(cleanup);
beforeEach(() => {
  holdAppearance(document, null);
  holdAccessibility(document, null);
  holdScanLines(document, null);
});

function setup(stored: Record<string, string> = {}) {
  const { host, storage } = fakeHost(stored);
  const view = renderEs(
    <AppearanceProvider host={host}>
      <AppearanceSection />
    </AppearanceProvider>,
  );
  return { ...view, storage };
}

const appearanceOf = (storage: { getItem(key: string): string | null }) =>
  JSON.parse(storage.getItem(APPEARANCE_STORAGE_KEY) ?? '{}') as Record<string, string>;

/** `#rrggbb` as jsdom writes a colour back: `rgb(r, g, b)`. */
function rgb(hex: string): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
}

// Settings > Apariencia (Settings:200-232, accesibilidad.md §3.2 and §5.1).
describe('AppearanceSection', () => {
  it('chooses the style with a card per style, marked by more than colour', () => {
    const { storage } = setup();
    const styles = screen.getByRole('group', { name: 'Estilo' });
    const calma = within(styles).getByRole('button', { name: /Calma/ });
    const terminal = within(styles).getByRole('button', { name: /Terminal/ });
    expect(calma.getAttribute('aria-pressed')).toBe('true');
    expect(calma.querySelector('svg')).toBeTruthy();
    expect(terminal.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(terminal);
    expect(appearanceOf(storage).style).toBe('terminal');
    expect(document.documentElement.dataset.style).toBe('terminal');
    expect(terminal.getAttribute('aria-pressed')).toBe('true');
  });

  it('chooses light, dark or like the system', () => {
    const { storage } = setup();
    const mode = screen.getByRole('radiogroup', { name: 'Modo' });
    expect(within(mode).getAllByRole('radio').map(radio => radio.textContent)).toEqual(['Claro', 'Oscuro', 'Como el sistema']);
    fireEvent.click(within(mode).getByRole('radio', { name: 'Oscuro' }));
    expect(appearanceOf(storage).mode).toBe('dark');
  });

  it('names the chosen accent in words beside the swatches, which keep their colour', () => {
    const { storage } = setup();
    expect(screen.getByText('Color de acento: Verde')).toBeTruthy();
    const swatches = screen.getByRole('group', { name: 'Color de acento' });
    const azul = within(swatches).getByRole('button', { name: 'Azul' });
    expect(azul.className).toContain('[forced-color-adjust:none]');
    fireEvent.click(azul);
    expect(appearanceOf(storage).accent).toBe('azul');
    expect(screen.getByText('Color de acento: Azul')).toBeTruthy();
    expect(azul.getAttribute('aria-pressed')).toBe('true');
    expect(azul.querySelector('svg')).toBeTruthy();
  });

  it('draws the style previews with the vision, the contrast and the scan lines in effect', () => {
    setup({ [ACCESSIBILITY_STORAGE_KEY]: JSON.stringify({ vision: 'safe', contrast: 'more' }) });
    const preview = document.querySelector('[data-preview="terminal"]') as HTMLElement;
    expect(preview.dataset.vision).toBe('safe');
    expect(preview.dataset.contrast).toBe('more');
    expect(preview.className).toContain('[forced-color-adjust:none]');
    const more = resolveTokens('terminal', 'light', 'verde', { vision: 'safe', contrast: 'more', scanLines: true });
    const standard = resolveTokens('terminal', 'light', 'verde');
    expect(more.bubbleInLine).not.toBe(standard.bubbleInLine);
    const incoming = preview.querySelector('[data-bubble="in"]') as HTMLElement;
    expect(incoming.style.borderColor).toBe(rgb(more.bubbleInLine));
  });

  it('switches the scan lines only with Terminal', () => {
    const { storage } = setup();
    expect(screen.queryByRole('switch', { name: 'Líneas de escaneo' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Terminal/ }));
    const scan = screen.getByRole('switch', { name: 'Líneas de escaneo' });
    expect(scan.getAttribute('aria-checked')).toBe('true');
    fireEvent.click(scan);
    expect(storage.getItem('trino.pref.scanLines')).toBe('0');
    expect(scan.getAttribute('aria-checked')).toBe('false');
  });

  it('has no text size: it is in Accesibilidad', () => {
    const { container } = setup();
    expect(container.textContent).not.toContain('Tamaño del texto');
  });
});
