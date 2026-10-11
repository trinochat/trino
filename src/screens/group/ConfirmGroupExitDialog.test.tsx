// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { CommandError } from '../../lib/api';
import { I18nContext, makeT } from '../../lib/i18n';
import { ConfirmGroupExitDialog, type ConfirmGroupExitDialogProps } from './ConfirmGroupExitDialog';

afterEach(cleanup);

function mount(props: Partial<ConfirmGroupExitDialogProps> = {}) {
  const handlers = { onConfirm: vi.fn(async () => {}), onCancel: vi.fn() };
  render(
    <I18nContext.Provider value={makeT('es')}>
      <ConfirmGroupExitDialog kind="leave" groupName="Familia" {...handlers} {...props} />
    </I18nContext.Provider>,
  );
  return handlers;
}

const description = (dialog: HTMLElement) =>
  document.getElementById(dialog.getAttribute('aria-describedby') ?? '')?.textContent;

describe('ConfirmGroupExitDialog', () => {
  it('asks before leaving, in an alertdialog with the safe answer focused', () => {
    mount();
    const dialog = screen.getByRole('alertdialog', { name: '¿Salir de Familia?' });
    expect(description(dialog)).toBe(
      'Dejarás de recibir sus mensajes. Si quien lo administra cambia el grupo, te puede llegar otra invitación, y puedes rechazarla.',
    );
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Cancelar' }));
  });

  it('says what deleting does not reach', () => {
    mount({ kind: 'delete' });
    const dialog = screen.getByRole('alertdialog', { name: '¿Eliminar Familia?' });
    expect(description(dialog)).toBe(
      'Se elimina para todos los miembros. A quien use una versión anterior de Trino, o lleve más de un día sin conectarse, el grupo le puede seguir apareciendo.',
    );
    // A solid red button sits beside green ones: it carries an icon and a verb.
    const confirm = screen.getByRole('button', { name: 'Eliminar el grupo' });
    expect(confirm.className).toContain('bg-ui-danger');
    expect(confirm.querySelector('svg')).not.toBeNull();
  });

  it('says what removing someone does not reach', () => {
    mount({ kind: 'remove', memberName: 'Papá' });
    const dialog = screen.getByRole('alertdialog', { name: '¿Quitar a Papá del grupo?' });
    expect(description(dialog)).toBe(
      'Le llega el cambio firmado. Si usa una versión anterior de Trino, el grupo le puede seguir apareciendo.',
    );
    expect(screen.getByRole('button', { name: 'Quitar del grupo' })).toBeTruthy();
  });

  it('cancels with its button and with Escape, and never on a click outside', () => {
    const { onCancel, onConfirm } = mount();
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }));
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    fireEvent.click(document.querySelector('[data-scrim]')!);
    expect(onCancel).toHaveBeenCalledTimes(2);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('confirms once, and stays busy while it runs', async () => {
    let finish!: () => void;
    const onConfirm = vi.fn(() => new Promise<void>(resolve => (finish = resolve)));
    mount({ onConfirm });
    const confirm = screen.getByRole('button', { name: 'Salir del grupo' }) as HTMLButtonElement;
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(confirm.getAttribute('aria-busy')).toBe('true');
    finish();
    await waitFor(() => expect(confirm.getAttribute('aria-busy')).toBeNull());
  });

  it('says why it failed: only the admin can, or try again', async () => {
    const notAdmin: CommandError = { code: 'not_admin', message: 'not admin' };
    mount({ kind: 'delete', onConfirm: vi.fn(async () => Promise.reject(notAdmin)) });
    fireEvent.click(screen.getByRole('button', { name: 'Eliminar el grupo' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Solo quien administra el grupo puede hacer esto.');
    cleanup();
    mount({ onConfirm: vi.fn(async () => Promise.reject(new Error('io'))) });
    fireEvent.click(screen.getByRole('button', { name: 'Salir del grupo' }));
    expect((await screen.findByRole('alert')).textContent).toContain('No se pudo salir del grupo. Inténtalo de nuevo.');
  });
});
