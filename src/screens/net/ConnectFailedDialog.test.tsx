// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ReactElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { I18nContext, makeT } from '../../lib/i18n';
import type { NetStatus } from '../../lib/net';
import { ConnectFailedDialog } from './ConnectFailedDialog';
import { BRIDGES, fakeNet, READY } from './test-support';

afterEach(cleanup);

const T = makeT('es');
const wrap = (ui: ReactElement) => <I18nContext.Provider value={T}>{ui}</I18nContext.Provider>;
const flush = () => act(async () => {});

const BLOCKED: NetStatus = { state: 'blocked', kind: 'filtering', pct: 15 };
const MEANWHILE = 'Puedes leer tus chats. Lo que envíes sale cuando se conecte, si dejas Trino abierto.';

async function show(status: NetStatus) {
  const { api } = fakeNet(status);
  const onClose = vi.fn();
  const onEscape = vi.fn();
  const view = render(wrap(<ConnectFailedDialog status={status} api={api} onClose={onClose} onEscape={onEscape} />));
  await flush();
  const rerender = (next: NetStatus) =>
    view.rerender(wrap(<ConnectFailedDialog status={next} api={api} onClose={onClose} onEscape={onEscape} />));
  return { api, onClose, onEscape, rerender };
}

const button = (name: string) => screen.getByRole('button', { name });

// Card 3 and design test 46: the right text and buttons by the reason.
describe('ConnectFailedDialog', () => {
  it('when the network seems to block Tor: another way first, then trying again, then the way out, small', async () => {
    await show(BLOCKED);
    screen.getByRole('dialog', { name: 'No se pudo conectar', description: 'Parece que la red donde estás no deja usar Tor.' });
    expect(button('Probar otra forma de conectarse').className).toContain('bg-ui-accent');
    expect(button('Volver a intentar').className).not.toContain('bg-ui-accent');
    expect(screen.getByText(MEANWHILE)).toBeTruthy();
    const escape = button('Conectar sin protección…');
    expect(escape.className).not.toContain('bg-ui-accent');
    // Last: after the other actions and the note.
    const order = [...document.querySelectorAll('button, p')].map(node => node.textContent);
    expect(order.indexOf('Conectar sin protección…')).toBeGreaterThan(order.indexOf(MEANWHILE));
  });

  it('tries the first built-in way, then says it is trying and that Windows may ask', async () => {
    const { api, rerender } = await show(BLOCKED);
    await act(async () => fireEvent.click(button('Probar otra forma de conectarse')));
    expect(api.tryBridge.mock.calls).toEqual([['snowflake']]);
    rerender({ state: 'starting', pct: 5 });
    expect(screen.getByRole('status').textContent).toBe('Probando otra forma de conectarse…');
    expect(screen.getByText('Si Windows te pregunta si dejas que un programa de Trino use la red, es normal.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Probar otra forma de conectarse' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Conectar sin protección…' })).toBeNull();
  });

  it('closes once the other way connects, and says it again if that one is blocked too', async () => {
    const first = await show(BLOCKED);
    await act(async () => fireEvent.click(button('Probar otra forma de conectarse')));
    first.rerender({ state: 'starting', pct: 5 });
    first.rerender(READY);
    expect(first.onClose).toHaveBeenCalled();
    cleanup();

    const second = await show(BLOCKED);
    await act(async () => fireEvent.click(button('Probar otra forma de conectarse')));
    second.rerender({ state: 'starting', pct: 5 });
    second.rerender({ state: 'blocked', kind: 'noProgress', pct: 5 });
    expect(screen.getByText('Trino no termina de conectarse de forma privada.')).toBeTruthy();
    expect(button('Conectar sin protección…')).toBeTruthy();
  });

  it('offers no other way when this build has no bridge program', async () => {
    const { api } = fakeNet(BLOCKED);
    api.bridges.mockResolvedValue({ ...BRIDGES, program: false });
    render(wrap(<ConnectFailedDialog status={BLOCKED} api={api} onClose={vi.fn()} onEscape={vi.fn()} />));
    await flush();
    expect(screen.queryByRole('button', { name: 'Probar otra forma de conectarse' })).toBeNull();
    expect(button('Volver a intentar').className).toContain('bg-ui-accent');
  });

  it('asks to fix the clock, with "Volver a intentar" only and no way out', async () => {
    const { api, onClose } = await show({ state: 'blocked', kind: 'clockSkewed', pct: 50 });
    expect(
      screen.getByText('La hora de tu computador está mal. Corrígela en la configuración de fecha y hora, y vuelve a intentar.'),
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Probar otra forma de conectarse' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Conectar sin protección…' })).toBeNull();
    await act(async () => fireEvent.click(button('Volver a intentar')));
    expect(api.retry).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalled();
  });

  it('names the antivirus, and leaves the way out', async () => {
    const { onEscape } = await show({ state: 'ptMissing' });
    expect(screen.getByText('Tu antivirus bloqueó una parte de Trino. Revísalo o vuelve a instalar Trino.')).toBeTruthy();
    fireEvent.click(button('Conectar sin protección…'));
    expect(onEscape).toHaveBeenCalledTimes(1);
  });

  it('closes by itself when there is nothing left to explain', async () => {
    const { onClose, rerender } = await show(BLOCKED);
    rerender({ state: 'starting', pct: 30 });
    expect(onClose).toHaveBeenCalled();
  });

  it('never goes without protection by itself, whatever happens', async () => {
    const { api, rerender } = await show(BLOCKED);
    await act(async () => fireEvent.click(button('Volver a intentar')));
    rerender({ state: 'blocked', kind: 'cantReachTor', pct: 0 });
    expect(api.connectWithoutTor).not.toHaveBeenCalled();
  });

  it('says so when a command fails', async () => {
    const { api } = await show(BLOCKED);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    api.retry.mockRejectedValueOnce(new Error('no'));
    await act(async () => fireEvent.click(button('Volver a intentar')));
    expect(screen.getByText('No se pudo. Vuelve a intentar en un momento.')).toBeTruthy();
    error.mockRestore();
  });
});
