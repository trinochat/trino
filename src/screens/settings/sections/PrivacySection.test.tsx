// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NodeInfo } from '../../../lib/api';
import { fakeApi, node, renderEs } from '../test-utils';
import type { SettingsApi } from '../types';
import { PrivacySection } from './PrivacySection';

afterEach(cleanup);

const CALLS_LINE =
  'Tus llamadas pasan por un servidor de Cloudflare: tu contacto no ve tu IP, pero Cloudflare sí. Si una llamada no se puede proteger, Trino te pregunta antes de llamar directo.';

function setup(nodes: NodeInfo[]) {
  let current = nodes;
  const api = fakeApi({
    listNodes: vi.fn(async () => current),
    blockNode: vi.fn(async (handle: string, blocked: boolean) => {
      current = current.map(n => (n.handle === handle ? { ...n, blocked } : n));
    }),
  });
  const onContactsChanged = vi.fn();
  const view = renderEs(<PrivacySection api={api} onContactsChanged={onContactsChanged} />);
  return { ...view, api, onContactsChanged };
}

// Settings > Privacidad (plan-cambios-11oct §4 W5): the blocked contacts and
// the line on calls; nothing about Tor, the old IP warning or @names.
describe('PrivacySection', () => {
  it('counts the blocked contacts on their row', async () => {
    setup([node('ana', { blocked: true }), node('beto', { blocked: true }), node('caro')]);
    const rows = screen.getByRole('list', { name: 'Privacidad' });
    expect(await within(rows).findByRole('button', { name: /Contactos bloqueados\s*2/ })).toBeTruthy();
  });

  it('says "Ninguno" without any', async () => {
    setup([node('caro')]);
    expect(await screen.findByRole('button', { name: /Contactos bloqueados\s*Ninguno/ })).toBeTruthy();
  });

  it('opens the list and unblocks with blockNode(handle, false)', async () => {
    const { api, onContactsChanged } = setup([node('ana', { blocked: true }), node('caro')]);
    fireEvent.click(await screen.findByRole('button', { name: /Contactos bloqueados\s*1/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Desbloquear a ana' }));
    await waitFor(() => expect(api.blockNode).toHaveBeenCalledWith('ana', false));
    expect(await screen.findByText('No tienes contactos bloqueados.')).toBeTruthy();
    expect(onContactsChanged).toHaveBeenCalledTimes(1);
  });

  it('comes back from the list with the new count', async () => {
    setup([node('ana', { blocked: true })]);
    fireEvent.click(await screen.findByRole('button', { name: /Contactos bloqueados\s*1/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Desbloquear a ana' }));
    await screen.findByText('No tienes contactos bloqueados.');
    fireEvent.click(screen.getByRole('button', { name: 'Volver a Privacidad' }));
    expect(await screen.findByRole('button', { name: /Contactos bloqueados\s*Ninguno/ })).toBeTruthy();
  });

  it('says that calls go through Cloudflare, which sees your IP', () => {
    setup([]);
    expect(screen.getByText(CALLS_LINE)).toBeTruthy();
  });

  it('has no IP warning, no Tor, no "Quién puede escribirte", no @name and no default timer', async () => {
    const { container, api } = setup([node('ana', { blocked: true })]);
    await waitFor(() => expect(api.listNodes).toHaveBeenCalled());
    const text = container.textContent ?? '';
    expect(text).not.toMatch(/Avisar|antes de una llamada que muestra|(?<!\p{L})Tor(?!\p{L})|Quién puede escribirte|@|por defecto/u);
    expect(screen.queryAllByRole('radiogroup')).toEqual([]);
    expect(screen.queryAllByRole('switch')).toEqual([]);
  });

  it('says so when the contacts cannot be read', async () => {
    const api = fakeApi({ listNodes: vi.fn(async () => Promise.reject(new Error('no_vault'))) });
    renderEs(<PrivacySection api={api} />);
    expect((await screen.findByRole('alert')).textContent).toContain('No se pudo cargar la lista de contactos.');
  });

  // Without the contacts, the app does not know who is blocked: the list
  // says so and tries again, and never says that nobody is.
  it('says in the list that the contacts could not be read, and reads them again', async () => {
    const listNodes = vi
      .fn<SettingsApi['listNodes']>()
      .mockRejectedValueOnce(new Error('no_vault'))
      .mockResolvedValue([node('ana', { blocked: true })]);
    renderEs(<PrivacySection api={fakeApi({ listNodes })} />);
    await screen.findByRole('alert');
    fireEvent.click(screen.getByRole('button', { name: /Contactos bloqueados/ }));
    const heading = await screen.findByRole('heading', { name: 'Contactos bloqueados' });
    expect(screen.getByRole('alert').textContent).toContain('No se pudo cargar la lista de contactos.');
    expect(screen.queryByText('No tienes contactos bloqueados.')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Reintentar' }));
    expect(await screen.findByRole('button', { name: 'Desbloquear a ana' })).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(document.activeElement).toBe(heading);
  });

  it('says so when the list cannot be read again after an unblock, without the contact unblocked', async () => {
    const listNodes = vi
      .fn<SettingsApi['listNodes']>()
      .mockResolvedValueOnce([node('ana', { blocked: true }), node('beto', { blocked: true })])
      .mockRejectedValue(new Error('io'));
    renderEs(<PrivacySection api={fakeApi({ listNodes })} />);
    fireEvent.click(await screen.findByRole('button', { name: /Contactos bloqueados\s*2/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Desbloquear a ana' }));
    expect((await screen.findByRole('alert')).textContent).toContain('No se pudo cargar la lista de contactos.');
    expect(screen.queryByRole('button', { name: 'Desbloquear a ana' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Desbloquear a beto' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Reintentar' })).toBeTruthy();
  });
});
