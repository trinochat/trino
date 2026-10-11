// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { I18nContext, makeT } from '../../lib/i18n';
import type { InboxItem } from '../types';
import { ForwardDialog } from './ForwardDialog';

afterEach(cleanup);

const TARGETS: InboxItem[] = [
  { ref: { kind: 'contact', handle: 'Ana' }, key: 'Ana', name: 'Ana', avatar: { initials: 'AN', kind: 'person' }, unread: 0 },
  { ref: { kind: 'group', gid: 'g1' }, key: 'grp:g1', name: 'Familia', avatar: { initials: 'FA', kind: 'group' }, unread: 2 },
];

function renderDialog(onPick = vi.fn(), onClose = vi.fn()) {
  render(
    <I18nContext.Provider value={makeT('es')}>
      <ForwardDialog open targets={TARGETS} onPick={onPick} onClose={onClose} />
    </I18nContext.Provider>,
  );
  return { onPick, onClose };
}

describe('ForwardDialog', () => {
  it('is a dialog named "Reenviar a…" with the chats to choose from', () => {
    renderDialog();
    const dialog = screen.getByRole('dialog', { name: 'Reenviar a…' });
    const list = within(dialog).getByRole('list', { name: 'Chats' });
    const buttons = within(list).getAllByRole('button');
    expect(buttons).toHaveLength(2);
    expect(within(list).getByRole('button', { name: 'Ana' })).toBe(buttons[0]);
    expect(within(list).getByRole('button', { name: 'Familia' })).toBe(buttons[1]);
  });

  it('finds a chat by name, without minding case or accents, and says when none matches', () => {
    renderDialog();
    const search = screen.getByRole('searchbox', { name: 'Buscar chat' });
    fireEvent.change(search, { target: { value: 'FAMÍLIA' } });
    const list = screen.getByRole('list', { name: 'Chats' });
    expect(within(list).getAllByRole('button')).toHaveLength(1);
    expect(within(list).getByRole('button', { name: 'Familia' })).toBeTruthy();
    fireEvent.change(search, { target: { value: 'zzz' } });
    expect(screen.getByText('Ningún chat coincide con «zzz».')).toBeTruthy();
  });

  it('forwards to the chosen chat', () => {
    const { onPick } = renderDialog();
    fireEvent.click(screen.getByRole('button', { name: 'Familia' }));
    expect(onPick).toHaveBeenCalledWith({ kind: 'group', gid: 'g1' });
  });

  it('closes with Escape and with its close button', () => {
    const { onClose } = renderDialog();
    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.click(screen.getByRole('button', { name: 'Cerrar' }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
