// @vitest-environment jsdom
import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SettingsNav, type SettingsNavProps } from './SettingsNav';
import { renderEs } from './test-utils';

afterEach(cleanup);

function setup(props: Partial<SettingsNavProps> = {}) {
  const all: SettingsNavProps = {
    current: 'privacy',
    qrOpen: false,
    profile: { name: 'rechita', avatar: null },
    onSelect: vi.fn(),
    onOpenQr: vi.fn(),
    onClose: vi.fn(),
    ...props,
  };
  renderEs(<SettingsNav {...all} />);
  return all;
}

const rows = (group: string) =>
  within(screen.getByRole('list', { name: group }))
    .getAllByRole('button')
    .map(button => button.textContent);

// The navigation of Settings (PropAjustes:41-119).
describe('SettingsNav', () => {
  it('names its groups: Cuenta, Uso and Más, with the sections in order', () => {
    setup();
    expect(screen.getByRole('navigation', { name: 'Secciones de ajustes' })).toBeTruthy();
    expect(rows('Cuenta')).toEqual(['Cuenta y seguridad']);
    expect(rows('Uso')).toEqual(['Privacidad', 'Notificaciones', 'Apariencia', 'Accesibilidad', 'Idioma']);
    expect(rows('Más')).toEqual(['Avanzado']);
  });

  it('marks the section on screen with aria-current, in bold and with its icon in the accent', () => {
    setup({ current: 'appearance' });
    const current = screen.getByRole('button', { name: 'Apariencia' });
    expect(current.getAttribute('aria-current')).toBe('page');
    expect(current.className).toContain('font-bold');
    expect(current.querySelector('.text-ui-accent-text svg')).toBeTruthy();
    expect(current.className).toMatch(/forced-colors:/);
    const other = screen.getByRole('button', { name: 'Idioma' });
    expect(other.getAttribute('aria-current')).toBeNull();
    expect(other.className).not.toContain('font-bold');
  });

  it('marks nothing when no section is on screen', () => {
    setup({ current: null });
    expect(document.querySelectorAll('[aria-current]')).toHaveLength(0);
  });

  it('opens a section, and closes Settings', () => {
    const props = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Accesibilidad' }));
    expect(props.onSelect).toHaveBeenCalledWith('accessibility');
    fireEvent.click(screen.getByRole('button', { name: 'Cuenta y seguridad' }));
    expect(props.onSelect).toHaveBeenCalledWith('security');
    fireEvent.click(screen.getByRole('button', { name: 'Cerrar ajustes' }));
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  it('opens the profile and the QR code from the card', () => {
    const props = setup();
    fireEvent.click(screen.getByRole('button', { name: /rechita/ }));
    expect(props.onSelect).toHaveBeenCalledWith('profile');
    fireEvent.click(screen.getByRole('button', { name: 'Mostrar tu código QR' }));
    expect(props.onOpenQr).toHaveBeenCalledTimes(1);
  });

  it('gives the focus back to a section’s row when asked', () => {
    setup({ current: null, focusId: 'language' });
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Idioma' }));
  });

  it('has no "Apoyar a Trino"', () => {
    setup();
    expect(document.body.textContent).not.toContain('Apoyar');
  });
});
