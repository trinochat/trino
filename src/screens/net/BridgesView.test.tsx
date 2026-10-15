// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { ReactElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { I18nContext, makeT } from '../../lib/i18n';
import type { BridgesInfo, NetStatus } from '../../lib/net';
import { bridgeSearchOf } from './bridge-search';
import { BridgesView } from './BridgesView';
import { BRIDGES, fakeNet, READY } from './test-support';

afterEach(cleanup);

const flush = () => act(async () => {});
// The paste box checks what is typed after a short pause.
const pause = () => act(() => new Promise(resolve => setTimeout(resolve, 400)));
const renderEs = (ui: ReactElement) => render(<I18nContext.Provider value={makeT('es')}>{ui}</I18nContext.Provider>);

const SEARCH = 'Buscar una forma que funcione aquí';
const SEARCH_BODY = 'Trino prueba una por una las formas que trae, hasta que una funcione. Puede tardar unos minutos.';
const CODE = 'Tengo un código de conexión que me dieron';
const BUILTIN_NOTE = 'Las formas que trae Trino las conoce cualquiera: sirven si bloquean Tor, pero no esconden que lo usas.';
const BLOCKED: NetStatus = { state: 'blocked', kind: 'filtering', pct: 15 };

async function show(info: BridgesInfo = BRIDGES, status: NetStatus = BLOCKED) {
  const fake = fakeNet(status);
  fake.api.bridges.mockResolvedValue(info);
  const onBack = vi.fn();
  renderEs(<BridgesView api={fake.api} onBack={onBack} />);
  await flush();
  return { ...fake, onBack };
}

const button = (name: string) => screen.getByRole('button', { name });
const advanced = () => act(async () => fireEvent.click(button('Opciones avanzadas')));
const radio = (name: string) => screen.getByRole('radio', { name });

// PropTorSimple, card 4 (TOR-8): one action by default, the automatic
// search; the concrete ways and the code someone gave you under "Opciones
// avanzadas", closed at first.
describe('BridgesView (Otra forma de conectarse)', () => {
  it('has one main action, the search, and the rest closed under "Opciones avanzadas"', async () => {
    const { onBack } = await show();
    expect(screen.getByRole('heading', { name: 'Otra forma de conectarse' })).toBeTruthy();
    expect(screen.getByText('Si en tu red bloquean Tor, Trino puede entrar por otra puerta.')).toBeTruthy();
    const search = screen.getByRole('button', { name: SEARCH, description: SEARCH_BODY });
    expect(search.className).toContain('bg-ui-accent');
    expect(button('Opciones avanzadas').getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('radiogroup')).toBeNull();
    expect(screen.queryByText(/Proyecto Tor/)).toBeNull();
    fireEvent.click(button('Volver a Conexión'));
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('searches through the built-in ways in order, says how it goes, and what it found', async () => {
    const { api, emit } = await show();
    await act(async () => fireEvent.click(button(SEARCH)));
    expect(api.tryBridge.mock.calls).toEqual([['snowflake']]);
    expect(screen.getByRole('status').textContent).toBe('Probando otra forma de conectarse… (1 de 2)');
    expect(screen.getByText('Si Windows te pregunta si dejas que un programa de Trino use la red, es normal.')).toBeTruthy();
    expect((button(SEARCH) as HTMLButtonElement).disabled).toBe(true);

    api.bridges.mockResolvedValue({ ...BRIDGES, transport: 'snowflake' });
    await act(async () => {
      emit.net({ state: 'starting', pct: 20 });
      emit.net({ state: 'ready', transport: 'snowflake' });
    });
    expect(screen.getByRole('status').textContent).toBe('Listo: Trino encontró una forma que funciona aquí.');
    await advanced();
    expect(radio('Snowflake (integrado)').getAttribute('aria-checked')).toBe('true');
  });

  it('says when no way Trino carries worked, and points to the code', async () => {
    const { emit } = await show();
    await act(async () => fireEvent.click(button(SEARCH)));
    for (const step of [1, 2]) {
      await act(async () => {
        emit.net({ state: 'starting', pct: 5 });
        emit.net({ state: 'blocked', kind: 'noProgress', pct: 5 });
      });
      await flush();
      if (step === 1) expect(screen.getByRole('status').textContent).toBe('Probando otra forma de conectarse… (2 de 2)');
    }
    expect(screen.getByRole('status').textContent).toBe(
      'Ninguna de las formas que trae Trino funcionó aquí. Si alguien te dio un código de conexión, pégalo en «Opciones avanzadas».',
    );
  });

  it('lists the ways under "Opciones avanzadas": Automático, the built-ins in order and the code', async () => {
    await show();
    await advanced();
    const group = screen.getByRole('radiogroup', { name: 'Forma de conectarse' });
    expect(within(group).getAllByRole('radio').map(option => option.textContent)).toEqual([
      'Automático (recomendado)',
      'Snowflake (integrado)',
      'obfs4 (integrado)',
      CODE,
    ]);
    expect(radio('Automático (recomendado)').getAttribute('aria-checked')).toBe('true');
    expect(screen.getByText('Trino se conecta de la forma normal y, si no puede, te ofrece buscar otra.')).toBeTruthy();
  });

  it('keeps a built-in way at once, says that it does not hide Tor, and stops a search going on', async () => {
    const { api } = await show();
    await act(async () => fireEvent.click(button(SEARCH)));
    await advanced();
    api.bridges.mockResolvedValue({ ...BRIDGES, transport: 'obfs4' });
    await act(async () => fireEvent.click(radio('obfs4 (integrado)')));
    expect(api.setBridges.mock.calls).toEqual([[{ kind: 'builtin', transport: 'obfs4' }]]);
    expect(bridgeSearchOf(api).get()).toEqual({ phase: 'idle' });
    expect(radio('obfs4 (integrado)').getAttribute('aria-checked')).toBe('true');
    expect(screen.getByText(BUILTIN_NOTE)).toBeTruthy();

    api.bridges.mockResolvedValue(BRIDGES);
    await act(async () => fireEvent.click(radio('Automático (recomendado)')));
    expect(api.setBridges).toHaveBeenLastCalledWith({ kind: 'none' });
  });

  it('warns about Windows before Snowflake', async () => {
    const { api } = await show();
    await advanced();
    api.bridges.mockResolvedValue({ ...BRIDGES, transport: 'snowflake' });
    await act(async () => fireEvent.click(radio('Snowflake (integrado)')));
    expect(screen.getByText('Si Windows te pregunta si dejas que un programa de Trino use la red, es normal.')).toBeTruthy();
  });

  it('says so when a way cannot be kept, and shows the one in use', async () => {
    const { api } = await show();
    await advanced();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    api.setBridges.mockRejectedValueOnce(new Error('this build has no bridge program'));
    await act(async () => fireEvent.click(radio('obfs4 (integrado)')));
    expect(screen.getByRole('alert').textContent).toBe('No se pudo guardar el cambio.');
    expect(radio('Automático (recomendado)').getAttribute('aria-checked')).toBe('true');
    error.mockRestore();
  });

  it('checks a pasted code line by line, keeps it only when every line is a bridge, and forgets the text', async () => {
    const { api } = await show();
    await advanced();
    await act(async () => fireEvent.click(radio(CODE)));
    expect(api.setBridges).not.toHaveBeenCalled();
    const box = screen.getByRole('textbox', { name: 'Pega aquí el código' }) as HTMLTextAreaElement;
    expect(screen.getByText(/en algunos discos puede quedar un rastro/)).toBeTruthy();

    api.checkBridges.mockResolvedValue({
      lines: 0,
      errors: [
        { line: 2, error: 'badAddress' },
        { line: 3, error: 'noFingerprint' },
      ],
    });
    fireEvent.change(box, { target: { value: 'obfs4 192.0.2.10:443 …\nobfs4 nada\nobfs4 192.0.2.11:443' } });
    await pause();
    expect(api.checkBridges).toHaveBeenLastCalledWith('obfs4 192.0.2.10:443 …\nobfs4 nada\nobfs4 192.0.2.11:443');
    expect(screen.getByText('La línea 2 no tiene una dirección válida.')).toBeTruthy();
    expect(screen.getByText('A la línea 3 le falta la huella del puente.')).toBeTruthy();
    expect(box.getAttribute('aria-invalid')).toBe('true');

    // The backend checks again when it keeps them: bad lines keep nothing.
    api.setBridges.mockResolvedValueOnce({ saved: false, errors: [{ line: 0, error: 'tooMany' }], status: BLOCKED });
    await act(async () => fireEvent.click(button('Usar este código')));
    expect(screen.getByText('Son demasiadas líneas: pega como mucho 20.')).toBeTruthy();

    api.checkBridges.mockResolvedValue({ lines: 1, errors: [] });
    fireEvent.change(box, { target: { value: 'obfs4 192.0.2.10:443 0123456789ABCDEF0123456789ABCDEF01234567 cert=x iat-mode=0' } });
    await pause();
    expect(box.getAttribute('aria-invalid')).not.toBe('true');
    expect(screen.queryByText('La línea 2 no tiene una dirección válida.')).toBeNull();
    api.bridges.mockResolvedValue({ ...BRIDGES, transport: 'obfs4', private: true, lines: 1, start: 'on_unlock' });
    await act(async () => fireEvent.click(button('Usar este código')));
    expect(api.setBridges).toHaveBeenLastCalledWith({
      kind: 'private',
      text: 'obfs4 192.0.2.10:443 0123456789ABCDEF0123456789ABCDEF01234567 cert=x iat-mode=0',
    });
    expect(box.value).toBe('');
    expect(screen.getByRole('status').textContent).toBe('Código guardado.');
    expect(radio(CODE).getAttribute('aria-checked')).toBe('true');
  });

  it('with a code in use: no search over it, the code checked, and how to change it', async () => {
    await show({ ...BRIDGES, transport: 'obfs4', private: true, lines: 2, start: 'on_unlock' });
    expect(screen.queryByRole('button', { name: SEARCH })).toBeNull();
    expect(screen.getByText('Te conectas con un código de conexión que te dieron.')).toBeTruthy();
    await advanced();
    expect(radio(CODE).getAttribute('aria-checked')).toBe('true');
    expect(screen.getByText('Ya usas un código que te dieron. Pega otro para cambiarlo.')).toBeTruthy();
  });

  it('without the bridge program, says so and offers nothing that would need it', async () => {
    await show({ ...BRIDGES, program: false });
    expect(screen.getByText('Esta versión de Trino no trae el programa para conectarse de otra forma.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: SEARCH })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Opciones avanzadas' })).toBeNull();
  });

  it('never goes without protection, whatever the search finds', async () => {
    const { api, emit } = await show(BRIDGES, READY);
    await act(async () => fireEvent.click(button(SEARCH)));
    await act(async () => {
      emit.net({ state: 'starting', pct: 5 });
      emit.net({ state: 'blocked', kind: 'offline', pct: 0 });
    });
    expect(api.connectWithoutTor).not.toHaveBeenCalled();
    expect(api.tryBridge).toHaveBeenCalledTimes(1);
  });
});
