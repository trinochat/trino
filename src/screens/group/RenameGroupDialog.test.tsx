// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { CommandError, GroupInfo } from '../../lib/api';
import { I18nContext, makeT } from '../../lib/i18n';
import { RenameGroupDialog } from './RenameGroupDialog';

afterEach(cleanup);

const GROUP: GroupInfo = { gid: 'g1', name: 'Familia', epoch: 1, is_admin: true, member_count: 3, members: [] };

function mount(renameGroup = vi.fn(async (_gid: string, name: string) => ({ ...GROUP, name }))) {
  const handlers = { onClose: vi.fn(), onRenamed: vi.fn() };
  render(
    <I18nContext.Provider value={makeT('es')}>
      <RenameGroupDialog group={GROUP} api={{ renameGroup }} {...handlers} />
    </I18nContext.Provider>,
  );
  return { renameGroup, ...handlers };
}

const nameBox = () => screen.getByRole('textbox', { name: 'Nombre del grupo' }) as HTMLInputElement;
const save = () => screen.getByRole('button', { name: 'Guardar' }) as HTMLButtonElement;

describe('RenameGroupDialog', () => {
  it('starts from the current name, focused', () => {
    mount();
    expect(screen.getByRole('dialog', { name: 'Renombrar el grupo' })).toBeTruthy();
    expect(nameBox().value).toBe('Familia');
    expect(document.activeElement).toBe(nameBox());
  });

  it('saves only a new name that is not empty, trimmed', async () => {
    const { renameGroup, onRenamed } = mount();
    expect(save().disabled).toBe(true);
    fireEvent.change(nameBox(), { target: { value: '   ' } });
    expect(save().disabled).toBe(true);
    fireEvent.change(nameBox(), { target: { value: '  Familia Pérez ' } });
    fireEvent.submit(nameBox().form!);
    await waitFor(() => expect(onRenamed).toHaveBeenCalledWith(expect.objectContaining({ name: 'Familia Pérez' })));
    expect(renameGroup).toHaveBeenCalledWith('g1', 'Familia Pérez');
  });

  it('says why it could not rename', async () => {
    const notAdmin: CommandError = { code: 'not_admin', message: 'x' };
    mount(vi.fn(async () => Promise.reject(notAdmin)));
    fireEvent.change(nameBox(), { target: { value: 'Otra' } });
    fireEvent.click(save());
    expect((await screen.findByRole('alert')).textContent).toContain('Solo quien administra el grupo puede hacer esto.');
    cleanup();
    const { onRenamed } = mount(vi.fn(async () => Promise.reject(new Error('io'))));
    fireEvent.change(nameBox(), { target: { value: 'Otra' } });
    fireEvent.click(save());
    expect((await screen.findByRole('alert')).textContent).toContain('No se pudo cambiar el nombre. Inténtalo de nuevo.');
    expect(onRenamed).not.toHaveBeenCalled();
  });

  it('closes on Cancelar', () => {
    const { onClose } = mount();
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }));
    expect(onClose).toHaveBeenCalled();
  });
});
