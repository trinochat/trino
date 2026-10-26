// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BlockedView } from '../../lib/api';
import { BlockedContactsView } from './BlockedContactsView';
import { blockedView, renderEs } from './test-utils';

afterEach(cleanup);

const UNBLOCKED_ANA =
  'Desbloqueaste a ana. Lo que mandó mientras estaba bloqueado no te llegó, y las invitaciones que tenía contigo no vuelven.';

/** The view with a list that loses each one once it is unblocked, as Privacidad gives it. */
function withList(initial: BlockedView[]) {
  function Harness() {
    const [blocked, setBlocked] = useState(initial);
    return (
      <BlockedContactsView
        blocked={blocked}
        onUnblock={async key => {
          const gone = initial.find(view => view.key === key)!;
          setBlocked(current => current.filter(view => view.key !== key));
          return gone;
        }}
        onBack={() => {}}
      />
    );
  }
  renderEs(<Harness />);
}

// "Bloqueados" in Settings > Privacidad (PropBloquear card 6, PropAjustes:225):
// whom you blocked, contacts or not (UR-2).
describe('BlockedContactsView', () => {
  it('lists each one you blocked with "Desbloquear", the short fingerprint and the day', () => {
    renderEs(
      <BlockedContactsView
        blocked={[blockedView('ana'), blockedView('jhon', { from: 'group', contact: null }), blockedView('beto')]}
        onUnblock={vi.fn()}
        onBack={() => {}}
      />,
    );
    const list = screen.getByRole('list', { name: 'Bloqueados' });
    const rows = within(list).getAllByRole('listitem');
    expect(rows).toHaveLength(3);
    expect(within(rows[0]!).getByText('ana')).toBeTruthy();
    expect(within(rows[0]!).getByText('Huella AB12 CD34 · 14 de octubre')).toBeTruthy();
    // Someone known only from a group: the name the admin wrote, with "~" (R-10).
    expect(within(rows[1]!).getByText('~jhon')).toBeTruthy();
    expect(within(list).getByRole('button', { name: 'Desbloquear a beto' })).toBeTruthy();
  });

  it('names a block of before by its day alone, and someone without a name as such', () => {
    renderEs(
      <BlockedContactsView
        blocked={[blockedView('', { fingerprint: '', contact: null })]}
        onUnblock={vi.fn()}
        onBack={() => {}}
      />,
    );
    expect(screen.getByText('Sin nombre')).toBeTruthy();
    expect(screen.getByText('Desde el 14 de octubre')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Desbloquear a Sin nombre' })).toBeTruthy();
  });

  it('unblocks by key, and says what does not come back (R-24)', async () => {
    withList([blockedView('ana')]);
    fireEvent.click(screen.getByRole('button', { name: 'Desbloquear a ana' }));
    expect((await screen.findByRole('status')).textContent).toBe(UNBLOCKED_ANA);
    expect(screen.getByText('No has bloqueado a nadie.')).toBeTruthy();
  });

  it('hands the key to onUnblock', async () => {
    const onUnblock = vi.fn(async () => blockedView('ana'));
    renderEs(<BlockedContactsView blocked={[blockedView('ana')]} onUnblock={onUnblock} onBack={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Desbloquear a ana' }));
    await waitFor(() => expect(onUnblock).toHaveBeenCalledWith('key-ana'));
  });

  it('shows a failed unblock as an alert that names them', async () => {
    const onUnblock = vi.fn(async () => Promise.reject(new Error('io')));
    renderEs(<BlockedContactsView blocked={[blockedView('ana')]} onUnblock={onUnblock} onBack={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Desbloquear a ana' }));
    expect((await screen.findByRole('alert')).textContent).toContain('No se pudo desbloquear a ana.');
  });

  it('says when nobody is blocked', () => {
    renderEs(<BlockedContactsView blocked={[]} onUnblock={vi.fn()} onBack={() => {}} />);
    expect(screen.getByText('No has bloqueado a nadie.')).toBeTruthy();
    expect(screen.queryByRole('list', { name: 'Bloqueados' })).toBeNull();
  });

  it('goes back to Privacidad', () => {
    const onBack = vi.fn();
    renderEs(<BlockedContactsView blocked={[]} onUnblock={vi.fn()} onBack={onBack} />);
    fireEvent.click(screen.getByRole('button', { name: 'Volver a Privacidad' }));
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('says it is loading while the list is read, and claims nobody is blocked only once it knows', () => {
    renderEs(<BlockedContactsView blocked={null} onUnblock={vi.fn()} onBack={() => {}} />);
    expect(screen.getByRole('status').textContent).toBe('Cargando la lista…');
    expect(screen.queryByText('No has bloqueado a nadie.')).toBeNull();
  });

  it('says when the list could not be read, and tries again', async () => {
    const onRetry = vi.fn(async () => false);
    renderEs(<BlockedContactsView blocked={null} loadFailed onRetry={onRetry} onUnblock={vi.fn()} onBack={() => {}} />);
    expect(screen.getByRole('alert').textContent).toContain('No se pudo cargar la lista de bloqueados.');
    expect(screen.queryByText('No has bloqueado a nadie.')).toBeNull();
    expect(screen.queryByRole('status')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Reintentar' }));
    await waitFor(() => expect(onRetry).toHaveBeenCalledTimes(1));
  });

  // The row of someone unblocked goes away with its button: the heading of
  // the list takes the focus, never the page.
  it('moves the focus to its heading once someone is unblocked, the last one too', async () => {
    withList([blockedView('ana'), blockedView('beto')]);
    const heading = screen.getByRole('heading', { name: 'Bloqueados' });
    const ana = screen.getByRole('button', { name: 'Desbloquear a ana' });
    ana.focus();
    fireEvent.click(ana);
    await waitFor(() => expect(ana.isConnected).toBe(false));
    expect(document.activeElement).toBe(heading);

    const beto = screen.getByRole('button', { name: 'Desbloquear a beto' });
    beto.focus();
    fireEvent.click(beto);
    expect(await screen.findByText('No has bloqueado a nadie.')).toBeTruthy();
    expect(document.activeElement).toBe(heading);
  });

  it('keeps the focus on "Desbloquear" when unblocking fails', async () => {
    renderEs(
      <BlockedContactsView
        blocked={[blockedView('ana')]}
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
