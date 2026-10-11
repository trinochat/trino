// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NodeInfo } from '../../lib/api';
import { BlockedContactsView } from './BlockedContactsView';
import { node, renderEs } from './test-utils';

afterEach(cleanup);

/** The view with a list that loses each contact once it is unblocked, as Privacidad gives it. */
function withList(initial: NodeInfo[]) {
  function Harness() {
    const [blocked, setBlocked] = useState(initial);
    return (
      <BlockedContactsView
        blocked={blocked}
        onUnblock={async handle => setBlocked(current => current.filter(contact => contact.handle !== handle))}
        onBack={() => {}}
      />
    );
  }
  renderEs(<Harness />);
}

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

  it('says it is loading while the contacts are read, and claims nobody is blocked only once it knows', () => {
    renderEs(<BlockedContactsView blocked={null} onUnblock={vi.fn()} onBack={() => {}} />);
    expect(screen.getByRole('status').textContent).toBe('Cargando tus contactos…');
    expect(screen.queryByText('No tienes contactos bloqueados.')).toBeNull();
  });

  it('says when the contacts could not be read, and tries again', async () => {
    const onRetry = vi.fn(async () => false);
    renderEs(<BlockedContactsView blocked={null} loadFailed onRetry={onRetry} onUnblock={vi.fn()} onBack={() => {}} />);
    expect(screen.getByRole('alert').textContent).toContain('No se pudo cargar la lista de contactos.');
    expect(screen.queryByText('No tienes contactos bloqueados.')).toBeNull();
    expect(screen.queryByRole('status')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Reintentar' }));
    await waitFor(() => expect(onRetry).toHaveBeenCalledTimes(1));
  });

  // The row of an unblocked contact goes away with its button: the heading
  // of the list takes the focus, never the page.
  it('moves the focus to its heading once a contact is unblocked, the last one too', async () => {
    withList([node('ana', { blocked: true }), node('beto', { blocked: true })]);
    const heading = screen.getByRole('heading', { name: 'Contactos bloqueados' });
    const ana = screen.getByRole('button', { name: 'Desbloquear a ana' });
    ana.focus();
    fireEvent.click(ana);
    await waitFor(() => expect(ana.isConnected).toBe(false));
    expect(document.activeElement).toBe(heading);

    const beto = screen.getByRole('button', { name: 'Desbloquear a beto' });
    beto.focus();
    fireEvent.click(beto);
    expect(await screen.findByText('No tienes contactos bloqueados.')).toBeTruthy();
    expect(document.activeElement).toBe(heading);
  });

  it('keeps the focus on "Desbloquear" when unblocking fails', async () => {
    renderEs(
      <BlockedContactsView
        blocked={[node('ana', { blocked: true })]}
        onUnblock={vi.fn(async () => Promise.reject(new Error('io')))}
        onBack={() => {}}
      />,
    );
    const ana = screen.getByRole('button', { name: 'Desbloquear a ana' });
    ana.focus();
    fireEvent.click(ana);
    await screen.findByRole('alert');
    expect(document.activeElement).toBe(ana);
  });
});
