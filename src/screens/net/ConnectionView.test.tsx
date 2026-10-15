// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { ReactElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { I18nContext, makeT } from '../../lib/i18n';
import type { NetStatus } from '../../lib/net';
import { ConnectionView } from './ConnectionView';
import { BRIDGES, fakeNet, READY } from './test-support';

afterEach(cleanup);

const flush = () => act(async () => {});
const renderEs = (ui: ReactElement) => render(<I18nContext.Provider value={makeT('es')}>{ui}</I18nContext.Provider>);

async function show(status: NetStatus = READY) {
  const fake = fakeNet(status);
  const onBack = vi.fn();
  renderEs(<ConnectionView api={fake.api} onBack={onBack} />);
  await flush();
  return { ...fake, onBack };
}

const button = (name: string | RegExp) => screen.getByRole('button', { name });
const toggle = (name: string) => screen.getByRole('switch', { name });
const ESCAPE = 'Conectar sin protección (solo esta vez)…';

// PropTorSimple, card 6: three things in view, the rest under "Opciones
// avanzadas", closed; the way out small and last.
describe('ConnectionView (Ajustes › Privacidad › Conexión)', () => {
  it('names itself and its state, with a way back to Privacidad', async () => {
    const { onBack } = await show();
    expect(screen.getByRole('heading', { name: 'Conexión' })).toBeTruthy();
    expect(screen.getByText('Conectado de forma privada')).toBeTruthy();
    fireEvent.click(button('Volver a Privacidad'));
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('shows "Qué ven los demás", the daily updates and, closed, the advanced options', async () => {
    await show();
    expect(within(screen.getByRole('list', { name: 'Conexión' })).getByRole('button', { name: /Qué ven los demás/ })).toBeTruthy();
    const daily = toggle('Buscar actualizaciones cada día');
    expect(daily.getAttribute('aria-checked')).toBe('true');
    expect(screen.getByText('Trino siempre te pregunta antes de instalar.')).toBeTruthy();
    const advanced = button('Opciones avanzadas');
    expect(advanced.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('switch', { name: 'Conectarse solo después de desbloquear' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Volver a conectarse de forma privada' })).toBeNull();
    // The way out, small and last.
    const all = screen.getAllByRole('button');
    expect(all[all.length - 1]!.textContent).toBe(ESCAPE);
  });

  it('turns the daily updates off and on', async () => {
    const { api } = await show();
    await act(async () => fireEvent.click(toggle('Buscar actualizaciones cada día')));
    expect(api.setDailyUpdates).toHaveBeenCalledWith(false);
    expect(toggle('Buscar actualizaciones cada día').getAttribute('aria-checked')).toBe('false');
  });

  it('says so when a change cannot be kept, and shows it as it was', async () => {
    const { api } = await show();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    api.setDailyUpdates.mockRejectedValueOnce(new Error('io'));
    await act(async () => fireEvent.click(toggle('Buscar actualizaciones cada día')));
    expect(screen.getByRole('alert').textContent).toBe('No se pudo guardar el cambio.');
    expect(toggle('Buscar actualizaciones cada día').getAttribute('aria-checked')).toBe('true');
    error.mockRestore();
  });

  it('has "Conectarse solo después de desbloquear" under the advanced options', async () => {
    const { api } = await show();
    fireEvent.click(button('Opciones avanzadas'));
    expect(button('Opciones avanzadas').getAttribute('aria-expanded')).toBe('true');
    const onUnlock = toggle('Conectarse solo después de desbloquear');
    expect(onUnlock.getAttribute('aria-checked')).toBe('false');
    expect(screen.getByText('Trino tarda un poco más al abrir, pero no se conecta mientras está bloqueado.')).toBeTruthy();
    await act(async () => fireEvent.click(onUnlock));
    expect(api.setStartOnUnlock).toHaveBeenCalledWith(true);
    expect(toggle('Conectarse solo después de desbloquear').getAttribute('aria-checked')).toBe('true');
  });

  it('keeps it on and fixed with a connection code someone gave you', async () => {
    const fake = fakeNet();
    fake.api.bridges.mockResolvedValue({ ...BRIDGES, private: true, lines: 2, start: 'on_unlock', transport: 'obfs4' });
    renderEs(<ConnectionView api={fake.api} onBack={vi.fn()} />);
    await flush();
    fireEvent.click(button('Opciones avanzadas'));
    const onUnlock = toggle('Conectarse solo después de desbloquear') as HTMLButtonElement;
    expect(onUnlock.getAttribute('aria-checked')).toBe('true');
    expect(onUnlock.disabled).toBe(true);
    expect(screen.getByText('Con un código de conexión que te dieron, va siempre así.')).toBeTruthy();
  });

  it('goes without protection only after its question, then offers the way back', async () => {
    const { api, emit } = await show();
    fireEvent.click(button(ESCAPE));
    const question = screen.getByRole('alertdialog', { name: '¿Conectar sin protección?' });
    await act(async () => fireEvent.click(within(question).getByRole('button', { name: 'Conectar sin protección' })));
    expect(api.connectWithoutTor).toHaveBeenCalledTimes(1);
    act(() => emit.net({ state: 'direct' }));

    const state = screen.getByText('Sin protección hasta que cierres Trino');
    expect(state.className).toEqual(expect.stringContaining('text-ui-warn'));
    expect(screen.getByText('Sin protección, Trino no busca actualizaciones.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: ESCAPE })).toBeNull();
    const back = button('Volver a conectarse de forma privada');
    expect(back.className).toContain('bg-ui-accent');
    await act(async () => fireEvent.click(back));
    expect(api.backToTor).toHaveBeenCalledTimes(1);
    act(() => emit.net(READY));
    expect(screen.getByText('Conectado de forma privada')).toBeTruthy();
  });

  it('cancels the question without going anywhere', async () => {
    const { api } = await show();
    fireEvent.click(button(ESCAPE));
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Cancelar' }));
    expect(api.connectWithoutTor).not.toHaveBeenCalled();
    expect(screen.getByText('Conectado de forma privada')).toBeTruthy();
  });

  it('says how it is going while it connects or cannot', async () => {
    const { emit } = await show({ state: 'starting', pct: 20 });
    expect(screen.getByText('Conectando de forma privada…')).toBeTruthy();
    act(() => emit.net({ state: 'blocked', kind: 'filtering', pct: 20 }));
    expect(screen.getByText('No se pudo conectar')).toBeTruthy();
  });
});

// PropTorSimple, card 7: three short lines and one that promises nothing
// more; the full detail under "Opciones avanzadas".
describe('ConnectionView: "Qué ven los demás"', () => {
  it('says what the others see, plainly, and goes back to Conexión', async () => {
    await show();
    fireEvent.click(button('Qué ven los demás'));
    expect(screen.getByRole('heading', { name: 'Qué ven los demás' })).toBeTruthy();
    const lines = within(screen.getByRole('list', { name: 'Qué ven los demás' }))
      .getAllByRole('listitem')
      .map(item => item.textContent);
    expect(lines).toEqual([
      'Los servidores no ven desde dónde te conectas, pero sí a quién le escribes y cuándo.',
      'Tu proveedor de internet ve que usas Tor y, si no usas otra forma de conectarse, puede notar que no es el navegador Tor Browser.',
      'En las llamadas, Cloudflare —la empresa que pasa el audio— ve desde dónde te conectas. Al abrir un enlace, la página también.',
    ]);
    expect(screen.getByText('Trino protege desde dónde te conectas, pero no te hace invisible.')).toBeTruthy();

    expect(screen.queryByText(/datos de diagnóstico/)).toBeNull();
    fireEvent.click(button('Opciones avanzadas'));
    expect(screen.getByText(/código de conexión que te dieron hace más difícil/)).toBeTruthy();
    expect(screen.getByText(/datos de diagnóstico a Microsoft/)).toBeTruthy();
    expect(screen.getByText(/queda una carpeta que muestra que usas Tor/)).toBeTruthy();

    fireEvent.click(button('Volver a Conexión'));
    expect(screen.getByRole('heading', { name: 'Conexión' })).toBeTruthy();
  });
});

// PropTorSimple, cards 6 and 4 (TOR-8): "Si en tu red bloquean Tor", with
// the way in use, opens "Otra forma de conectarse".
describe('ConnectionView: "Si en tu red bloquean Tor"', () => {
  it('shows the way in use in the list and opens the other ways, then comes back', async () => {
    const { api } = await show();
    const row = within(screen.getByRole('list', { name: 'Conexión' })).getByRole('button', { name: /Si en tu red bloquean Tor/ });
    expect(row.textContent).toBe('Si en tu red bloquean TorAutomático');
    await act(async () => fireEvent.click(row));
    expect(screen.getByRole('heading', { name: 'Otra forma de conectarse' })).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Otra forma de conectarse' }));

    api.bridges.mockResolvedValue({ ...BRIDGES, transport: 'obfs4' });
    fireEvent.click(button('Opciones avanzadas'));
    await act(async () => fireEvent.click(screen.getByRole('radio', { name: 'obfs4 (integrado)' })));
    await act(async () => fireEvent.click(button('Volver a Conexión')));
    expect(screen.getByRole('heading', { name: 'Conexión' })).toBeTruthy();
    expect(button(/Si en tu red bloquean Tor/).textContent).toBe('Si en tu red bloquean Torobfs4');
  });

  it('names a code someone gave you, without its lines', async () => {
    const fake = fakeNet();
    fake.api.bridges.mockResolvedValue({ ...BRIDGES, private: true, lines: 2, start: 'on_unlock', transport: 'obfs4' });
    renderEs(<ConnectionView api={fake.api} onBack={vi.fn()} />);
    await flush();
    expect(button(/Si en tu red bloquean Tor/).textContent).toBe('Si en tu red bloquean TorCon un código');
  });
});
