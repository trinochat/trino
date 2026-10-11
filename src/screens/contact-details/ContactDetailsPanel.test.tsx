// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NodeInfo } from '../../lib/api';
import type { PanelLayout, Trust } from '../types';
import { commandError, memoryPrefs, node, renderEs, withLang } from '../settings/test-utils';
import { ContactDetailsPanel, type ContactDetailsApi, type ContactDetailsPanelProps } from './ContactDetailsPanel';

afterEach(cleanup);

function setup({
  contact = node('ana'),
  trust = 'unverified' as Trust,
  layout = 'aside' as PanelLayout,
  api: overrides = {} as Partial<ContactDetailsApi>,
  stored = {} as Record<string, string>,
}: {
  contact?: NodeInfo;
  trust?: Trust;
  layout?: PanelLayout;
  api?: Partial<ContactDetailsApi>;
  stored?: Record<string, string>;
} = {}) {
  const api: ContactDetailsApi = {
    renameNode: vi.fn(async () => {}),
    removeNode: vi.fn(async () => {}),
    blockNode: vi.fn(async () => {}),
    ...overrides,
  };
  const { prefs, storage } = memoryPrefs(stored);
  const props: ContactDetailsPanelProps = {
    node: contact,
    trust,
    layout,
    api,
    prefs,
    onClose: vi.fn(),
    onVerify: vi.fn(),
    onRenamed: vi.fn(),
    onRemoved: vi.fn(),
    onChanged: vi.fn(),
  };
  renderEs(<ContactDetailsPanel {...props} />);
  return { api, prefs, storage, props };
}

// The details of a contact (plan §3 W5, after the patterns of Group.dc.html;
// plan-cambios-11oct §4 W5 for what the shared profile adds).
describe('ContactDetailsPanel', () => {
  it('works as an aside named by the contact, which its button closes', () => {
    const { props } = setup();
    const aside = screen.getByRole('complementary', { name: 'ana' });
    fireEvent.click(within(aside).getByRole('button', { name: 'Cerrar los detalles' }));
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  it('works as a dialog named by the contact, which Escape closes', () => {
    const { props } = setup({ layout: 'dialog' });
    expect(screen.getByRole('dialog', { name: 'ana' })).toBeTruthy();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  it('says how much you trust the contact, and "Verificar" calls onVerify', () => {
    const { props } = setup();
    expect(screen.getByText('Sin verificar')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Verificar' }));
    expect(props.onVerify).toHaveBeenCalledTimes(1);
    cleanup();
    setup({ trust: 'keyChanged' });
    expect(screen.getByText('La clave cambió')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Verificar' })).toBeTruthy();
    cleanup();
    setup({ trust: 'verified' });
    expect(screen.getByText('Verificado')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Ver la verificación' })).toBeTruthy();
  });

  it('shows the photo and "Sobre mí" the contact shares', () => {
    setup({ contact: node('ana', { avatar: 'data:image/jpeg;base64,CCCC', about: 'Respondo en las noches.' }) });
    expect(document.querySelector('img')?.getAttribute('src')).toBe('data:image/jpeg;base64,CCCC');
    expect(screen.getByText('Sobre mí')).toBeTruthy();
    expect(screen.getByText('Respondo en las noches.')).toBeTruthy();
  });

  it('offers the name the contact gave themselves when it differs, and uses it on request', async () => {
    const { api, props, prefs } = setup({
      contact: node('ana', { profile_name: 'Ana María' }),
      stored: { 'note:ana': 'Prima' },
    });
    expect(screen.getByText('Nombre en su perfil: Ana María')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Usar este nombre' }));
    await waitFor(() => expect(api.renameNode).toHaveBeenCalledWith('ana', 'Ana María'));
    await waitFor(() => expect(props.onRenamed).toHaveBeenCalledWith('Ana María'));
    expect(prefs.getNote('Ana María')).toBe('Prima');
    expect(prefs.getNote('ana')).toBe('');
  });

  it('says so when that name is taken, and says nothing when it matches', async () => {
    setup({
      contact: node('ana', { profile_name: 'Beto' }),
      api: { renameNode: vi.fn(async () => Promise.reject(commandError('name_taken'))) },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Usar este nombre' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Ya tienes un contacto con ese nombre.');
    cleanup();
    setup({ contact: node('ana', { profile_name: 'ana' }) });
    expect(screen.queryByText(/Nombre en su perfil/)).toBeNull();
  });

  // A contact's name is also the key of its chat: "channel" and "grp:…" are
  // the keys of the channel and of the groups (convo.ts), and names here are
  // at most 40 characters, where a profile allows 64.
  it('offers no name the contact chose that would stand for a group or the channel, or that is too long', () => {
    const long = 'a'.repeat(64);
    for (const profileName of ['grp:g1', 'channel', long]) {
      const { api, storage } = setup({
        contact: node('ana', { profile_name: profileName }),
        stored: { 'ttl:ana': '30', 'ttl:grp:g1': '3600' },
      });
      expect(screen.getByText(`Nombre en su perfil: ${profileName}`), profileName).toBeTruthy();
      expect(screen.queryByRole('button', { name: 'Usar este nombre' }), profileName).toBeNull();
      expect(api.renameNode).not.toHaveBeenCalled();
      expect(storage.data.get('ttl:grp:g1')).toBe('3600');
      cleanup();
    }
    setup({ contact: node('ana', { profile_name: '🦜'.repeat(40) }) });
    expect(screen.getByRole('button', { name: 'Usar este nombre' })).toBeTruthy();
  });

  it('refuses to rename the contact to a name that stands for a group or the channel', async () => {
    const { api } = setup({ stored: { 'ttl:ana': '30', 'ttl:grp:g1': '3600' } });
    fireEvent.click(screen.getByRole('button', { name: 'Cambiar nombre' }));
    const dialog = screen.getByRole('dialog', { name: 'Cambiar el nombre de ana' });
    const field = within(dialog).getByRole('textbox', { name: 'Nombre' });
    for (const name of ['grp:g1', ' channel ']) {
      fireEvent.change(field, { target: { value: name } });
      fireEvent.click(within(dialog).getByRole('button', { name: 'Guardar' }));
      expect((await within(dialog).findByRole('alert')).textContent, name).toContain(
        'Ese nombre está reservado. Escribe otro.',
      );
    }
    expect(api.renameNode).not.toHaveBeenCalled();
  });

  it('renames the contact with checks, moving what is kept for them', async () => {
    const renameNode = vi
      .fn<ContactDetailsApi['renameNode']>()
      .mockRejectedValueOnce(commandError('name_taken'))
      .mockResolvedValueOnce(undefined);
    const { props, prefs } = setup({ api: { renameNode }, stored: { 'ttl:ana': '3600' } });
    fireEvent.click(screen.getByRole('button', { name: 'Cambiar nombre' }));
    const dialog = screen.getByRole('dialog', { name: 'Cambiar el nombre de ana' });
    const field = within(dialog).getByRole('textbox', { name: 'Nombre' }) as HTMLInputElement;
    expect(field.value).toBe('ana');

    fireEvent.change(field, { target: { value: '  ' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Guardar' }));
    expect(within(dialog).getByText('Escribe un nombre.')).toBeTruthy();
    expect(renameNode).not.toHaveBeenCalled();

    fireEvent.change(field, { target: { value: 'Beto' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Guardar' }));
    expect((await within(dialog).findByRole('alert')).textContent).toContain('Ya tienes un contacto con ese nombre.');

    fireEvent.change(field, { target: { value: 'Ana Prima' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Guardar' }));
    await waitFor(() => expect(props.onRenamed).toHaveBeenCalledWith('Ana Prima'));
    expect(renameNode).toHaveBeenLastCalledWith('ana', 'Ana Prima');
    expect(prefs.getTtl('Ana Prima')).toBe(3600);
  });

  it('keeps a private note on this device', () => {
    const { prefs } = setup({ stored: { 'note:ana': 'Prima' } });
    const note = screen.getByRole('textbox', { name: 'Nota privada' }) as HTMLTextAreaElement;
    expect(note.value).toBe('Prima');
    expect(screen.getByText('Solo se guarda en este equipo.')).toBeTruthy();
    fireEvent.change(note, { target: { value: 'Prima de Bogotá' } });
    expect(prefs.getNote('ana')).toBe('Prima de Bogotá');
  });

  it('follows another contact without a new mount: their note and timer, not the last ones', () => {
    const { prefs } = memoryPrefs({ 'note:ana': 'Prima', 'note:beto': 'Vecino', 'ttl:beto': '3600' });
    const api: ContactDetailsApi = { renameNode: vi.fn(), removeNode: vi.fn(), blockNode: vi.fn() };
    const panel = (contact: NodeInfo) => (
      <ContactDetailsPanel
        node={contact}
        trust="unverified"
        layout="aside"
        api={api}
        prefs={prefs}
        onClose={() => {}}
        onVerify={() => {}}
        onRenamed={() => {}}
        onRemoved={() => {}}
        onChanged={() => {}}
      />
    );
    const { rerender } = render(withLang(panel(node('ana'))));
    expect((screen.getByRole('textbox', { name: 'Nota privada' }) as HTMLTextAreaElement).value).toBe('Prima');
    rerender(withLang(panel(node('beto'))));
    expect((screen.getByRole('textbox', { name: 'Nota privada' }) as HTMLTextAreaElement).value).toBe('Vecino');
    expect((screen.getByRole('combobox', { name: 'Mensajes temporales' }) as HTMLSelectElement).value).toBe('3600');
  });

  it('sets the timer of your new messages, and says honestly what it does', () => {
    const { prefs, props } = setup();
    const timer = screen.getByRole('combobox', { name: 'Mensajes temporales' }) as HTMLSelectElement;
    expect(screen.getByText('Tus mensajes no se borran solos.')).toBeTruthy();
    fireEvent.change(timer, { target: { value: '86400' } });
    expect(prefs.getTtl('ana')).toBe(86400);
    expect(props.onChanged).toHaveBeenCalled();
    expect(
      screen.getByText(
        'Tus mensajes nuevos en este chat se borran de los dos equipos después de 1 día. Cada uno elige el tiempo de sus propios mensajes.',
      ),
    ).toBeTruthy();
  });

  it('blocks and unblocks', async () => {
    const { api, props } = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Bloquear' }));
    await waitFor(() => expect(api.blockNode).toHaveBeenCalledWith('ana', true));
    expect(props.onChanged).toHaveBeenCalledTimes(1);
    expect(await screen.findByText('Bloqueaste a ana: no recibes sus mensajes.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Desbloquear' }));
    await waitFor(() => expect(api.blockNode).toHaveBeenLastCalledWith('ana', false));
  });

  it('shows a failed block as an alert', async () => {
    setup({ api: { blockNode: vi.fn(async () => Promise.reject(new Error('io'))) } });
    fireEvent.click(screen.getByRole('button', { name: 'Bloquear' }));
    expect((await screen.findByRole('alert')).textContent).toContain('No se pudo cambiar el bloqueo');
  });

  it('removes the contact only after an alert dialog that starts on Cancel', async () => {
    const { api, props, prefs } = setup({ stored: { 'note:ana': 'Prima', 'verified:ana': 'f' } });
    fireEvent.click(screen.getByRole('button', { name: 'Eliminar contacto' }));
    const dialog = screen.getByRole('alertdialog', { name: '¿Eliminar a ana?' });
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Cancelar' }));
    const confirm = within(dialog).getByRole('button', { name: 'Eliminar contacto' });
    expect(confirm.querySelector('svg')).toBeTruthy();
    fireEvent.click(confirm);
    await waitFor(() => expect(api.removeNode).toHaveBeenCalledWith('ana'));
    await waitFor(() => expect(props.onRemoved).toHaveBeenCalledTimes(1));
    expect(prefs.getNote('ana')).toBe('');
    expect(prefs.getVerified('ana')).toBeNull();
  });
});
