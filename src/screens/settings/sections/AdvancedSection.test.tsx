// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RelayObservation } from '../../../lib/api';
import { fakeApi, PROFILE, renderEs } from '../test-utils';
import type { SettingsApi, SettingsCapabilities } from '../types';
import { AdvancedSection } from './AdvancedSection';

afterEach(cleanup);

function setup(
  capabilities: Pick<SettingsCapabilities, 'relayStatus' | 'diagnosticLog'> = { relayStatus: true },
  overrides: Partial<SettingsApi> = {},
) {
  let emit: ((event: RelayObservation) => void) | undefined;
  const unlisten = vi.fn();
  const api = fakeApi({
    connectionStatus: vi.fn(async () => ({
      up: 1,
      total: 2,
      relays: [
        { url: 'wss://relay.damus.io', connected: true },
        { url: 'wss://nos.lol', connected: false },
      ],
    })),
    onRelayEvent: vi.fn(async (cb: (event: RelayObservation) => void) => {
      emit = cb;
      return unlisten;
    }),
    relayInspectStart: vi.fn(async () => ['wss://relay.damus.io']),
    ...overrides,
  });
  renderEs(<AdvancedSection api={api} profile={PROFILE} capabilities={capabilities} />);
  return { api, unlisten, emit: (event: RelayObservation) => act(() => emit?.(event)) };
}

// Settings > Avanzado (Settings:250-273, plan §1.5).
describe('AdvancedSection', () => {
  it('lists each relay with its real state, as an icon and a word', async () => {
    setup();
    const list = await screen.findByRole('list', { name: 'Servidores de mensajes' });
    const rows = within(list).getAllByRole('listitem');
    expect(rows.map(row => row.textContent)).toEqual(['wss://relay.damus.ioConectado', 'wss://nos.lolSin conexión']);
    expect(rows[0]!.querySelector('[data-icon]')?.getAttribute('data-icon')).toBe('circle');
    expect(rows[1]!.querySelector('[data-icon]')?.getAttribute('data-icon')).toBe('circle-slash');
  });

  it('leaves the relays out without the backend that reports them', async () => {
    const { api } = setup({ relayStatus: false });
    await screen.findByText('Trino Chat 0.1.0');
    expect(screen.queryByRole('list', { name: 'Servidores de mensajes' })).toBeNull();
    expect(api.connectionStatus).not.toHaveBeenCalled();
  });

  it('shows your key in capitals and groups, and the version', async () => {
    setup();
    expect(screen.getByText('70A5 83C6 766D AAD7')).toBeTruthy();
    expect(await screen.findByText('Trino Chat 0.1.0')).toBeTruthy();
  });

  it('says a log is kept only when the backend keeps one', () => {
    setup({ relayStatus: true, diagnosticLog: true });
    expect(screen.getByText(/trino-gui\.log/)).toBeTruthy();
    cleanup();
    setup({ relayStatus: true });
    expect(screen.queryByText(/trino-gui\.log/)).toBeNull();
  });

  it('has no "Agregar relay", no diagnostic switch and no Tor', async () => {
    setup();
    await screen.findByRole('list', { name: 'Servidores de mensajes' });
    expect(screen.queryByText(/Agregar relay/)).toBeNull();
    expect(screen.queryAllByRole('switch')).toEqual([]);
    expect(document.body.textContent).not.toMatch(/(?<!\p{L})Tor(?!\p{L})/u);
  });

  it('watches the relays in "Actividad de red", marking you, and stops when it closes', async () => {
    const { api, unlisten, emit } = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Ver actividad de red' }));
    const dialog = await screen.findByRole('dialog', { name: 'Actividad de red' });
    await waitFor(() => expect(api.relayInspectStart).toHaveBeenCalled());
    expect(vi.mocked(api.onRelayEvent).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(api.relayInspectStart).mock.invocationCallOrder[0]!,
    );
    expect(await within(dialog).findByText('Observando: wss://relay.damus.io')).toBeTruthy();
    expect(within(dialog).getByText('Esperando actividad. Envía un mensaje para ver un evento.')).toBeTruthy();

    emit({ relay: 'wss://relay.damus.io', id: 'e1', from: PROFILE.nostr_pub, to: 'cd34'.repeat(16), size: 512, created_at: 0 });
    const events = within(dialog).getByRole('list', { name: 'Eventos vistos por los servidores' });
    const row = within(events).getByRole('listitem');
    expect(row.textContent).toContain('Tú');
    expect(row.textContent).toContain('cd34cd34cd34');
    expect(row.textContent).toContain('512 B cifrados');

    fireEvent.click(within(dialog).getByRole('button', { name: 'Cerrar' }));
    await waitFor(() => expect(api.relayInspectStop).toHaveBeenCalledTimes(1));
    expect(unlisten).toHaveBeenCalledTimes(1);
  });

  it('says so when the relays cannot be watched', async () => {
    setup({ relayStatus: true }, { relayInspectStart: vi.fn(async () => Promise.reject(new Error('offline'))) });
    fireEvent.click(screen.getByRole('button', { name: 'Ver actividad de red' }));
    const dialog = await screen.findByRole('dialog');
    expect((await within(dialog).findByRole('alert')).textContent).toContain('No se pudo empezar a observar los servidores.');
  });
});
