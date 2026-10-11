// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import type { GroupInvite } from '../../lib/api';
import { I18nContext, makeT } from '../../lib/i18n';
import type { ContactsTab } from '../types';
import { ContactsDialog, type ContactsDialogProps } from './ContactsDialog';

beforeEach(() => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const BUNDLE = JSON.stringify({
  handle: 'Ana Torres',
  idSig: 'd4'.repeat(64),
  ikDhPub: '8f'.repeat(32),
  ikSignPub: '3b'.repeat(32),
  nostrPub: 'a1'.repeat(32),
  opkId: null,
  opkPub: null,
  spkId: 7,
  spkPub: 'e7'.repeat(32),
  spkSig: '0f'.repeat(64),
});

const invite = (gid: string): GroupInvite => ({ gid, name: `Grupo ${gid}`, from_handle: 'Ana', member_count: 3, received_at: 1 });

function mount(props: Partial<ContactsDialogProps> = {}, initialTab: ContactsTab = 'add') {
  const api = {
    shareBundle: vi.fn(async () => BUNDLE),
    getProfile: vi.fn(async () => ({ handle: 'Ana Torres', avatar: null, fingerprint: '70a5.83c6.766d.aad7', nostr_pub: '' })),
    previewContact: vi.fn(),
    probeNode: vi.fn(),
    acceptGroupInvite: vi.fn(),
    declineGroupInvite: vi.fn(),
  };
  const handlers = { onClose: vi.fn(), onContactAdded: vi.fn(), onGroupJoined: vi.fn(), onInvitesChanged: vi.fn() };
  const onTabChange = vi.fn();
  function Host() {
    const [tab, setTab] = useState<ContactsTab>(initialTab);
    return (
      <ContactsDialog
        api={api}
        download={vi.fn()}
        tab={tab}
        onTabChange={next => {
          onTabChange(next);
          setTab(next);
        }}
        invites={[]}
        strangerAttempts={0}
        {...handlers}
        {...props}
      />
    );
  }
  render(
    <I18nContext.Provider value={makeT('es')}>
      <Host />
    </I18nContext.Provider>,
  );
  return { api, onTabChange, ...handlers };
}

describe('ContactsDialog', () => {
  it('is the "Contactos" dialog with three named tabs', () => {
    mount();
    expect(screen.getByRole('dialog', { name: 'Contactos' })).toBeTruthy();
    expect(screen.getByRole('tablist', { name: 'Opciones de contacto' })).toBeTruthy();
    expect(screen.getAllByRole('tab').map(tab => tab.textContent)).toEqual(['Agregar', 'Mi código', 'Invitaciones']);
  });

  it('counts the invitations on their tab, and never says · 0', () => {
    mount({ invites: [invite('a'), invite('b')] });
    expect(screen.getByRole('tab', { name: 'Invitaciones · 2' })).toBeTruthy();
    cleanup();
    mount({ invites: [] });
    expect(screen.getByRole('tab', { name: 'Invitaciones' })).toBeTruthy();
  });

  it('opens on the tab it is given, and reports a change of tab', async () => {
    const { onTabChange } = mount({}, 'share');
    expect(screen.getByRole('tab', { name: 'Mi código' }).getAttribute('aria-selected')).toBe('true');
    expect(await screen.findByRole('img', { name: 'Tu código QR' })).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: 'Agregar' }));
    expect(onTabChange).toHaveBeenCalledWith('add');
    expect(screen.getByRole('textbox', { name: 'Pega el código de la otra persona' })).toBeTruthy();
  });

  it('shows the invitations and the note about strangers on their tab', () => {
    mount({ invites: [invite('a')], strangerAttempts: 1 }, 'invites');
    expect(screen.getByRole('heading', { name: 'Grupo a' })).toBeTruthy();
    expect(screen.getByText(/^Alguien que no está en tus contactos intentó escribirte\./)).toBeTruthy();
  });

  it('closes with its button and with Escape', () => {
    const { onClose } = mount();
    fireEvent.click(screen.getByRole('button', { name: 'Cerrar' }));
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('has no camera and no message from strangers to open', () => {
    mount({ strangerAttempts: 2 }, 'invites');
    expect(document.body.textContent).not.toMatch(/cámara|solicitud/i);
  });
});
