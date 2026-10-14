// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ReactElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { I18nContext, makeT } from '../../lib/i18n';
import { fakeNet } from './test-support';
import { WithoutTorDialog } from './WithoutTorDialog';

afterEach(cleanup);

const renderEs = (ui: ReactElement) => render(<I18nContext.Provider value={makeT('es')}>{ui}</I18nContext.Provider>);

function show() {
  const { api } = fakeNet({ state: 'blocked', kind: 'filtering', pct: 10 });
  const onClose = vi.fn();
  const onDone = vi.fn();
  renderEs(<WithoutTorDialog api={api} onClose={onClose} onDone={onDone} />);
  return { api, onClose, onDone };
}

// Card 5 and design test 47: the confirmation says what it costs, lasts
// until Trino closes, and its safe answer is the default.
describe('WithoutTorDialog', () => {
  it('asks, named by its question and described by what it costs', () => {
    show();
    const dialog = screen.getByRole('alertdialog', {
      name: '¿Conectar sin protección?',
      description:
        'Solo hasta que cierres Trino. Tu proveedor de internet y los servidores verán desde dónde te conectas, y tu proveedor verá que usas Trino. La próxima vez, Trino vuelve a conectarse de forma privada.',
    });
    expect(dialog.getAttribute('aria-modal')).toBe('true');
  });

  it('starts on Cancelar, the main button, and Escape cancels without asking the backend', () => {
    const { api, onClose } = show();
    const cancel = screen.getByRole('button', { name: 'Cancelar' });
    expect(document.activeElement).toBe(cancel);
    expect(cancel.className).toContain('bg-ui-accent');
    expect(screen.getByRole('button', { name: 'Conectar sin protección' }).className).not.toContain('bg-ui-accent');
    fireEvent.keyDown(cancel, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(api.connectWithoutTor).not.toHaveBeenCalled();
  });

  it('goes without protection only on its own button, once', async () => {
    const { api, onDone } = show();
    const confirm = screen.getByRole('button', { name: 'Conectar sin protección' });
    await act(async () => {
      fireEvent.click(confirm);
      fireEvent.click(confirm);
    });
    expect(api.connectWithoutTor).toHaveBeenCalledTimes(1);
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('says so when it could not, and stays private', async () => {
    const { api, onDone } = show();
    api.connectWithoutTor.mockRejectedValueOnce(new Error('refused'));
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Conectar sin protección' })));
    expect(screen.getByText('No se pudo conectar sin protección. Sigues conectándote de forma privada.')).toBeTruthy();
    expect(onDone).not.toHaveBeenCalled();
  });
});
