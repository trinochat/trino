// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { ReactElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { I18nContext, makeT } from '../../lib/i18n';
import type { NetStatus } from '../../lib/net';
import { fakeNet, UPDATES } from './test-support';
import { UpdateNeededDialog } from './UpdateNeededDialog';

afterEach(cleanup);

const renderEs = (ui: ReactElement) => render(<I18nContext.Provider value={makeT('es')}>{ui}</I18nContext.Provider>);

const OBSOLETE: NetStatus = { state: 'obsolete', confirmed: true };
const TITLE = 'Trino necesita actualizarse para seguir conectándose de forma privada';
const FINGERPRINT = 'BFC6 FA22 2C06 51F1 CC27 C634 A07C 8D60 BFE3 D554';

function show(status: NetStatus = OBSOLETE) {
  const { api, emit } = fakeNet(status);
  const onClose = vi.fn();
  const copyText = vi.fn(async (_text: string) => {});
  renderEs(<UpdateNeededDialog status={status} api={api} onClose={onClose} copyText={copyText} />);
  return { api, emit, onClose, copyText };
}

// PropTorSimple card 9 (Tor design §6.5, R-15): Tor Browser first, in
// steps without technical words; the fingerprint under "Opciones
// avanzadas"; going without protection only after its question.
describe('UpdateNeededDialog', () => {
  it('says Trino needs updating, Tor Browser first, and the way without protection small', () => {
    show();
    const dialog = screen.getByRole('dialog', { name: TITLE });
    expect(dialog.textContent).toContain('La forma más segura de descargar la versión nueva es con el navegador Tor Browser.');
    expect(screen.getByRole('button', { name: 'Ver cómo' }).className).toContain('bg-ui-accent');
    expect(screen.getByRole('button', { name: 'Descargarla sin protección…' }).className).not.toContain('bg-ui-accent');
    expect(screen.queryByRole('button', { name: 'Volver a intentar' })).toBeNull();
    // No other way out: card 9 has none.
    expect(screen.queryByRole('button', { name: /Conectar sin protección/ })).toBeNull();
  });

  it('says "puede que" when Trino only guesses it, and offers to try again', async () => {
    const { api } = show({ state: 'obsolete', confirmed: false });
    screen.getByRole('dialog', { name: 'Puede que Trino necesite actualizarse para seguir conectándose de forma privada' });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Volver a intentar' })));
    expect(api.retry).toHaveBeenCalledTimes(1);
  });

  it('shows the steps with Tor Browser, copies the address, and keeps the fingerprint behind "Opciones avanzadas"', async () => {
    const { copyText } = show();
    fireEvent.click(screen.getByRole('button', { name: 'Ver cómo' }));
    const steps = screen.getAllByRole('listitem').map(item => item.textContent);
    expect(steps).toEqual([
      'Instala Tor Browser desde torproject.org.',
      'Abre en él la dirección de abajo y descarga Trino.',
      'Instálalo encima: tus chats se quedan.',
    ]);
    expect(screen.getByText('trinochat.org')).toBeTruthy();
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Copiar la dirección' })));
    expect(copyText).toHaveBeenCalledWith('https://trinochat.org');
    expect(screen.getByRole('status').textContent).toBe('Dirección copiada.');

    expect(screen.queryByText(FINGERPRINT)).toBeNull();
    const advanced = screen.getByRole('button', { name: 'Opciones avanzadas' });
    expect(advanced.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(advanced);
    expect(advanced.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText('Comprobar la firma del archivo con la llave de versiones:')).toBeTruthy();
    expect(screen.getByText(FINGERPRINT)).toBeTruthy();
  });

  it('asks before downloading without protection, Cancelar first, and goes back on it', () => {
    const { api } = show();
    fireEvent.click(screen.getByRole('button', { name: 'Descargarla sin protección…' }));
    const question = screen.getByRole('alertdialog', {
      name: 'Sin protección, trinochat.org, GitHub y tu proveedor de internet verán desde dónde te conectas. Trino igual revisa que la descarga sea auténtica.',
    });
    const cancel = within(question).getByRole('button', { name: 'Cancelar' });
    expect(cancel.className).toContain('bg-ui-accent');
    expect(document.activeElement).toBe(cancel);
    fireEvent.click(cancel);
    expect(api.checkUpdateWithoutTor).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Ver cómo' })).toBeTruthy();
  });

  it('downloads without protection only on "Descargar", says how it goes, and installs only on its button', async () => {
    const { api, emit } = show();
    fireEvent.click(screen.getByRole('button', { name: 'Descargarla sin protección…' }));
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Descargar' })));
    expect(api.checkUpdateWithoutTor).toHaveBeenCalledTimes(1);
    act(() => emit.update({ ...UPDATES, state: { state: 'downloading', version: '0.2.0' } }));
    expect(screen.getByRole('status').textContent).toBe('Descargando la versión nueva…');
    act(() => emit.update({ ...UPDATES, state: { state: 'ready', version: '0.2.0' } }));
    expect(screen.getByRole('status').textContent).toBe('La versión nueva está lista.');
    expect(api.installUpdate).not.toHaveBeenCalled();
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Instalar y reiniciar' })));
    expect(api.installUpdate).toHaveBeenCalledTimes(1);
  });

  it('says so when nothing came, and sends to Tor Browser again', async () => {
    const { emit } = show();
    fireEvent.click(screen.getByRole('button', { name: 'Descargarla sin protección…' }));
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Descargar' })));
    act(() => emit.update({ ...UPDATES, state: { state: 'failed', reason: 'signature' } }));
    expect(screen.getByRole('status').textContent).toBe('No se pudo descargar la versión nueva.');
    expect(screen.getByRole('button', { name: 'Ver cómo' })).toBeTruthy();
  });

  it('closes once Tor connects again', () => {
    const { onClose } = show();
    cleanup();
    const { api } = fakeNet(OBSOLETE);
    renderEs(<UpdateNeededDialog status={{ state: 'ready', transport: 'none' }} api={api} onClose={onClose} copyText={vi.fn()} />);
    expect(onClose).toHaveBeenCalled();
  });
});
