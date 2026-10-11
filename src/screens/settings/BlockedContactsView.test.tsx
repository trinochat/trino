// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BlockedContactsView } from './BlockedContactsView';
import { node, renderEs } from './test-utils';

afterEach(cleanup);

// "Contactos bloqueados" in Settings > Privacidad (PropAjustes:225).
describe('BlockedContactsView', () => {
  it('lists each blocked contact with "Desbloquear", named after them', () => {
    renderEs(
      <BlockedContactsView blocked={[node('ana', { blocked: true }), node('beto', { blocked: true })]} onUnblock={vi.fn()} onBack={() => {}} />,
    );
    const list = screen.getByRole('list', { name: 'Contactos bloqueados' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(2);
    expect(within(list).getByText('ana')).toBeTruthy();
    expect(within(list).getByRole('button', { name: 'Desbloquear a beto' })).toBeTruthy();
  });

  it('unblocks through onUnblock', async () => {
    const onUnblock = vi.fn(async () => {});
    renderEs(<BlockedContactsView blocked={[node('ana', { blocked: true })]} onUnblock={onUnblock} onBack={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Desbloquear a ana' }));
    await waitFor(() => expect(onUnblock).toHaveBeenCalledWith('ana'));
  });

  it('shows a failed unblock as an alert that names the contact', async () => {
    const onUnblock = vi.fn(async () => Promise.reject(new Error('io')));
    renderEs(<BlockedContactsView blocked={[node('ana', { blocked: true })]} onUnblock={onUnblock} onBack={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Desbloquear a ana' }));
    expect((await screen.findByRole('alert')).textContent).toContain('No se pudo desbloquear a ana.');
  });

  it('says when nobody is blocked', () => {
    renderEs(<BlockedContactsView blocked={[]} onUnblock={vi.fn()} onBack={() => {}} />);
    expect(screen.getByText('No tienes contactos bloqueados.')).toBeTruthy();
    expect(screen.queryByRole('list', { name: 'Contactos bloqueados' })).toBeNull();
  });

  it('goes back to Privacidad', () => {
    const onBack = vi.fn();
    renderEs(<BlockedContactsView blocked={[]} onUnblock={vi.fn()} onBack={onBack} />);
    fireEvent.click(screen.getByRole('button', { name: 'Volver a Privacidad' }));
    expect(onBack).toHaveBeenCalledTimes(1);
  });
});
