// @vitest-environment jsdom
import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderIn } from '../call/test-support';
import { LegacyVerificationNotice } from './LegacyVerificationNotice';

afterEach(cleanup);

describe('LegacyVerificationNotice', () => {
  it('says once that the old marks no longer count, for whom, and how to verify again', () => {
    const onClose = vi.fn();
    renderIn(<LegacyVerificationNotice names={['Ana Torres', 'Bruno']} onClose={onClose} />);
    const dialog = screen.getByRole('dialog', {
      name: 'Vuelve a verificar a tus contactos',
      description:
        'Antes, Trino marcaba a un contacto como verificado con una comparación que no era lo bastante segura. Esas marcas ya no cuentan.',
    });
    const list = within(dialog).getByRole('list', { name: 'Contactos que tenías verificados' });
    expect(within(list).getAllByRole('listitem').map(item => item.textContent)).toEqual(['Ana Torres', 'Bruno']);
    expect(dialog.textContent).toContain('Para verificar de nuevo a un contacto, llámale y comparen los símbolos de la llamada.');
    fireEvent.click(screen.getByRole('button', { name: 'Entendido' }));
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  // The desktop has no camera to scan a QR with: no screen offers that way (plan-cambios-11oct §3.1).
  it('offers only the way this device has: a call', () => {
    renderIn(<LegacyVerificationNotice names={['Ana Torres']} onClose={() => {}} />);
    expect(screen.getByRole('dialog').textContent).not.toMatch(/QR/);
  });

  it('shows nothing when no old mark is left', () => {
    renderIn(<LegacyVerificationNotice names={[]} onClose={() => {}} />);
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
