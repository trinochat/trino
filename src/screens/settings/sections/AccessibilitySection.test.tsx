// @vitest-environment jsdom
import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ACCESSIBILITY_STORAGE_KEY,
  DEFAULT_ACCESSIBILITY,
  SYSTEM_TEXT_SCALE_STORAGE_KEY,
} from '../../../design/accessibility';
import { holdAccessibility, holdAppearance, holdScanLines } from '../../../design/apply';
import { AppearanceProvider } from '../../../design/useAppearance';
import { fakeHost, renderEs } from '../test-utils';
import type { SettingsPlatform } from '../types';
import { AccessibilitySection } from './AccessibilitySection';

afterEach(cleanup);
beforeEach(() => {
  holdAppearance(document, null);
  holdAccessibility(document, null);
  holdScanLines(document, null);
});

function setup(
  platform: SettingsPlatform = 'windows',
  stored: Record<string, string> = {},
  system: { moreContrast?: boolean; reducedMotion?: boolean } = {},
) {
  const { host, storage } = fakeHost(stored, system);
  renderEs(
    <AppearanceProvider host={host}>
      <AccessibilitySection platform={platform} />
    </AppearanceProvider>,
  );
  const saved = () => JSON.parse(storage.getItem(ACCESSIBILITY_STORAGE_KEY) ?? 'null');
  return { storage, saved };
}

const sw = (name: string | RegExp) => screen.getByRole('switch', { name });

// Settings > Accesibilidad (accesibilidad.md §2 and §6; plan-cambios-11oct §4 W5).
describe('AccessibilitySection', () => {
  it('has the five settings, with the text size first', () => {
    setup();
    expect(screen.getByRole('heading', { name: 'Accesibilidad' })).toBeTruthy();
    expect(sw(/^Como el sistema/)).toBeTruthy();
    expect(screen.getByRole('slider', { name: 'Tamaño del texto' })).toBeTruthy();
    for (const name of ['Colores para daltonismo', 'Más contraste', 'Reducir movimiento', 'Espaciado amplio']) {
      expect(sw(name), name).toBeTruthy();
    }
  });

  it('shows the size Windows uses in "Como el sistema"', () => {
    setup('windows', { [SYSTEM_TEXT_SCALE_STORAGE_KEY]: '1.25' });
    const system = sw('Como el sistema (125 %)');
    expect(system.getAttribute('aria-checked')).toBe('true');
    expect(screen.getByText('Trino sigue el tamaño del texto de Windows.')).toBeTruthy();
    const slider = screen.getByRole('slider', { name: 'Tamaño del texto' });
    expect(slider.getAttribute('aria-valuetext')).toBe('125 por ciento');
  });

  it('says 100 % on macOS and Linux, whose size the app does not read', () => {
    for (const platform of ['macos', 'linux'] as const) {
      setup(platform, { [SYSTEM_TEXT_SCALE_STORAGE_KEY]: '1' });
      expect(screen.queryByText(/125 %/)).toBeNull();
      expect(sw('Como el sistema (100 %)')).toBeTruthy();
      expect(screen.getByText('Tu sistema no indica un tamaño; se usa 100 %.')).toBeTruthy();
      expect(screen.queryByText(/Windows/)).toBeNull();
      cleanup();
    }
  });

  it('fixes the size with the slider, which turns "Como el sistema" off and sizes the page and its preview', () => {
    const { saved } = setup('windows', { [SYSTEM_TEXT_SCALE_STORAGE_KEY]: '1.25' });
    const slider = screen.getByRole('slider', { name: 'Tamaño del texto' }) as HTMLInputElement;
    fireEvent.change(slider, { target: { value: '3' } });
    expect(saved().textScale).toBe(1.5);
    expect(sw('Como el sistema (125 %)').getAttribute('aria-checked')).toBe('false');
    expect(slider.getAttribute('aria-valuetext')).toBe('150 por ciento');
    expect(screen.getByText('150 %')).toBeTruthy();
    expect(document.documentElement.style.fontSize).toBe('24px');
    const preview = screen.getByRole('group', { name: 'Vista previa del tamaño del texto' });
    expect(within(preview).getByText('¿Te llegó el archivo?').className).toContain('text-ui-base');

    fireEvent.click(sw('Como el sistema (125 %)'));
    expect(saved().textScale).toBe('system');
    expect(document.documentElement.style.fontSize).toBe('20px');
  });

  it('turning "Como el sistema" off keeps the size in effect as a fixed step', () => {
    const { saved } = setup('windows', { [SYSTEM_TEXT_SCALE_STORAGE_KEY]: '1.25' });
    fireEvent.click(sw('Como el sistema (125 %)'));
    expect(saved().textScale).toBe(1.25);
  });

  it('fixes contrast and motion when touched, and offers "Usar lo del sistema" to follow it again', () => {
    const { saved } = setup('windows', {}, { moreContrast: false, reducedMotion: true });
    expect(screen.getByText('Según tu sistema: apagado')).toBeTruthy();
    expect(screen.getByText('Según tu sistema: encendido')).toBeTruthy();
    expect(sw('Reducir movimiento').getAttribute('aria-checked')).toBe('true');
    expect(screen.queryByRole('button', { name: 'Usar lo del sistema' })).toBeNull();

    fireEvent.click(sw('Más contraste'));
    expect(saved().contrast).toBe('more');
    expect(sw('Más contraste').getAttribute('aria-checked')).toBe('true');
    fireEvent.click(sw('Reducir movimiento'));
    expect(saved().motion).toBe('full');
    const back = screen.getAllByRole('button', { name: 'Usar lo del sistema' });
    expect(back).toHaveLength(2);

    fireEvent.click(back[0]!);
    expect(saved().contrast).toBe('system');
    expect(screen.getByText('Según tu sistema: apagado')).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'Usar lo del sistema' })).toHaveLength(1);
  });

  it('shows the warning colours as icon and word, without dots, once colours for colour blindness are on', () => {
    const { saved } = setup();
    expect(screen.queryByRole('list', { name: 'Así se ven los avisos' })).toBeNull();
    fireEvent.click(sw('Colores para daltonismo'));
    expect(saved().vision).toBe('safe');
    const legend = screen.getByRole('list', { name: 'Así se ven los avisos' });
    const items = within(legend).getAllByRole('listitem');
    expect(items.map(item => item.textContent)).toEqual(['Verificado', 'La clave cambió', 'No se envió']);
    expect(items.every(item => item.querySelector('svg'))).toBe(true);
  });

  it('turns the wide spacing on', () => {
    const { saved } = setup();
    fireEvent.click(sw('Espaciado amplio'));
    expect(saved().spacing).toBe('wide');
    expect(document.documentElement.dataset.spacing).toBe('wide');
  });

  it('offers "Restablecer" only when something differs from the defaults, and goes back to them', () => {
    const { saved } = setup();
    expect(screen.queryByRole('button', { name: 'Restablecer' })).toBeNull();
    fireEvent.click(sw('Espaciado amplio'));
    fireEvent.click(screen.getByRole('button', { name: 'Restablecer' }));
    expect(saved()).toEqual({ ...DEFAULT_ACCESSIBILITY });
    expect(screen.queryByRole('button', { name: 'Restablecer' })).toBeNull();
  });

  // Both buttons go away once used: the focus moves to what stays beside
  // them, never to the page.
  it('gives the focus to the switch after "Usar lo del sistema", and to the heading after "Restablecer"', () => {
    setup('windows', {}, { moreContrast: false, reducedMotion: true });
    fireEvent.click(sw('Más contraste'));
    fireEvent.click(sw('Reducir movimiento'));
    const [contrastBack, motionBack] = screen.getAllByRole('button', { name: 'Usar lo del sistema' });
    contrastBack!.focus();
    fireEvent.click(contrastBack!);
    expect(contrastBack!.isConnected).toBe(false);
    expect(document.activeElement).toBe(sw('Más contraste'));
    motionBack!.focus();
    fireEvent.click(motionBack!);
    expect(motionBack!.isConnected).toBe(false);
    expect(document.activeElement).toBe(sw('Reducir movimiento'));

    fireEvent.click(sw('Espaciado amplio'));
    const reset = screen.getByRole('button', { name: 'Restablecer' });
    reset.focus();
    fireEvent.click(reset);
    expect(reset.isConnected).toBe(false);
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Accesibilidad' }));
  });

  it('lists the keyboard shortcuts in a dialog that Escape closes', () => {
    setup();
    fireEvent.click(screen.getByRole('button', { name: 'Ver atajos de teclado' }));
    const dialog = screen.getByRole('dialog', { name: 'Atajos de teclado' });
    for (const keys of ['Ctrl + K', 'Ctrl + L', 'Ctrl + 0', 'Mayús + Enter', 'Esc']) {
      expect(within(dialog).getByText(keys), keys).toBeTruthy();
    }
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('starts from the stored settings', () => {
    setup('windows', { [ACCESSIBILITY_STORAGE_KEY]: JSON.stringify({ vision: 'safe', spacing: 'wide' }) });
    expect(sw('Colores para daltonismo').getAttribute('aria-checked')).toBe('true');
    expect(sw('Espaciado amplio').getAttribute('aria-checked')).toBe('true');
    expect(screen.getByRole('button', { name: 'Restablecer' })).toBeTruthy();
  });
});
