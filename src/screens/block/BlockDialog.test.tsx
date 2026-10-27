// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { BlockPreview, BlockTarget, BlockedView, CommandError } from '../../lib/api';
import { I18nContext, makeT } from '../../lib/i18n';
import { BlockDialog, type BlockDialogApi } from './BlockDialog';

afterEach(cleanup);

const ANA: BlockTarget = { kind: 'contact', handle: 'Andrés Rojas' };
const IK = 'ab'.repeat(32);

function preview(over: Partial<BlockPreview> = {}): BlockPreview {
  return {
    label: 'Andrés Rojas',
    ik_sign_pub: IK,
    fingerprint: '3F9A 12C0 7B44 E1D5',
    contact: 'Andrés Rojas',
    shared_groups: [],
    clash: false,
    blocked: false,
    ...over,
  };
}

const done: BlockedView = {
  key: IK,
  label: 'Andrés Rojas',
  fingerprint: '3F9A 12C0 7B44 E1D5',
  blocked_at: 1_760_000_000,
  from: 'contact',
  contact: 'Andrés Rojas',
};

function mount(shown: BlockPreview = preview(), over: Partial<BlockDialogApi> = {}, target: BlockTarget = ANA) {
  const api: BlockDialogApi = {
    blockPreview: vi.fn(async () => shown),
    blockIdentity: vi.fn(async () => done),
    removeGroupMember: vi.fn(async () => ({ gid: 'g1', name: 'Fútbol', epoch: 2, is_admin: true, member_count: 5, members: [] })),
    leaveGroup: vi.fn(async () => {}),
    ...over,
  };
  const handlers = { onBlocked: vi.fn(), onClose: vi.fn(), onLeftGroup: vi.fn() };
  render(
    <I18nContext.Provider value={makeT('es')}>
      <BlockDialog target={target} name="Andrés Rojas" api={api} {...handlers} />
    </I18nContext.Provider>,
  );
  return { api, ...handlers };
}

const description = (dialog: HTMLElement) =>
  document.getElementById(dialog.getAttribute('aria-describedby') ?? '')?.textContent;

describe('BlockDialog: Reportar también (UR-5)', () => {
  it('reports too, if you tick it: the report blocks them, sent or not', async () => {
    const onReport = vi.fn();
    const api: BlockDialogApi = {
      blockPreview: vi.fn(async () => preview()),
      blockIdentity: vi.fn(async () => done),
      removeGroupMember: vi.fn(async () => ({ gid: 'g1', name: 'Fútbol', epoch: 2, is_admin: true, member_count: 5, members: [] })),
      leaveGroup: vi.fn(async () => {}),
    };
    render(
      <I18nContext.Provider value={makeT('es')}>
        <BlockDialog target={ANA} name="Andrés Rojas" api={api} onBlocked={vi.fn()} onClose={vi.fn()} onReport={onReport} />
      </I18nContext.Provider>,
    );
    const box = (await screen.findByRole('checkbox', { name: 'Reportar también' })) as HTMLInputElement;
    expect(box.checked).toBe(false);
    fireEvent.click(box);
    fireEvent.click(await screen.findByRole('button', { name: 'Bloquear' }));
    expect(onReport).toHaveBeenCalledTimes(1);
    expect(api.blockIdentity).not.toHaveBeenCalled();
  });
});

describe('BlockDialog (PropBloquear, card 3)', () => {
  it('asks first, says what it does and that they are not told, with Cancelar focused', async () => {
    const { api } = mount();
    const dialog = screen.getByRole('alertdialog', { name: '¿Bloquear a Andrés Rojas?' });
    expect(description(dialog)).toBe(
      'No te podrá escribir, llamar ni agregarte a grupos con esta cuenta, y no recibirá tu perfil. No se le avisa.',
    );
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Cancelar' }));
    expect(api.blockPreview).toHaveBeenCalledWith(ANA);
    // Red and with an icon, never blocked in one click.
    const confirm = await screen.findByRole('button', { name: 'Bloquear' });
    expect(confirm.className).toContain('bg-ui-danger');
    expect(confirm.querySelector('svg')).not.toBeNull();
    expect(api.blockIdentity).not.toHaveBeenCalled();
    // Without a report to open, no "Reportar también".
    expect(screen.queryByRole('checkbox')).toBeNull();
  });

  it('blocks on Bloquear and hands back who was blocked', async () => {
    const { api, onBlocked } = mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Bloquear' }));
    await waitFor(() => expect(onBlocked).toHaveBeenCalledWith(done));
    expect(api.blockIdentity).toHaveBeenCalledWith(ANA);
  });

  it('closes on Cancelar and on Escape, never on a click outside', () => {
    const { onClose, api } = mount();
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }));
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    fireEvent.click(document.querySelector('[data-scrim]')!);
    expect(onClose).toHaveBeenCalledTimes(2);
    expect(api.blockIdentity).not.toHaveBeenCalled();
  });

  // U5 and R-25: they stop getting what you write in your groups, and may notice.
  it('says what happens in the groups you share, and offers to remove them where you administer', async () => {
    const { api } = mount(
      preview({ shared_groups: [{ gid: 'g1', name: 'Fútbol del jueves', i_administer: true, they_administer: false }] }),
    );
    expect(
      await screen.findByText(
        'Tampoco recibirá lo que escribas en los grupos que tienen en común. Puede notar que faltan tus mensajes.',
      ),
    ).toBeTruthy();
    expect(screen.getByText('También puedes sacarlo de «Fútbol del jueves».')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Sacar del grupo' }));
    expect(await screen.findByText('Lo sacaste de «Fútbol del jueves».')).toBeTruthy();
    expect(api.removeGroupMember).toHaveBeenCalledWith('g1', IK);
    expect(screen.queryByRole('button', { name: 'Sacar del grupo' })).toBeNull();
  });

  // R-04: their rosters still count, so the group keeps working.
  it('says that you keep seeing who comes and goes where they administer, and offers to leave', async () => {
    const { api, onLeftGroup } = mount(
      preview({ shared_groups: [{ gid: 'g2', name: 'Fútbol del jueves', i_administer: false, they_administer: true }] }),
    );
    expect(
      await screen.findByText(
        'Andrés Rojas administra «Fútbol del jueves». Seguirás viendo quién entra y quién sale, pero no sus mensajes.',
      ),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Salir del grupo' }));
    expect(await screen.findByText('Saliste de «Fútbol del jueves».')).toBeTruthy();
    expect(api.leaveGroup).toHaveBeenCalledWith('g2');
    expect(onLeftGroup).toHaveBeenCalledWith('g2');
  });

  it('says nothing of groups when you share none', async () => {
    mount();
    await screen.findByRole('button', { name: 'Bloquear' });
    expect(screen.queryByText(/grupos que tienen en común/)).toBeNull();
  });

  // P1 R-14: a key they proved they hold is another contact's.
  it('shows a key clash instead of Bloquear', async () => {
    const { api } = mount(preview({ clash: true }));
    expect(
      await screen.findByText('Esta persona comparte una llave con un contacto tuyo. No se bloqueó. Revisa las huellas.'),
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Bloquear' })).toBeNull();
    expect(api.blockIdentity).not.toHaveBeenCalled();
  });

  it('shows a clash the backend found on blocking, and a failure otherwise', async () => {
    const clash: CommandError = { code: 'key_clash', message: 'clash' };
    mount(preview(), { blockIdentity: vi.fn(async () => Promise.reject(clash)) });
    fireEvent.click(await screen.findByRole('button', { name: 'Bloquear' }));
    expect(await screen.findByText(/comparte una llave con un contacto tuyo/)).toBeTruthy();
    cleanup();
    mount(preview(), { blockIdentity: vi.fn(async () => Promise.reject(new Error('io'))) });
    fireEvent.click(await screen.findByRole('button', { name: 'Bloquear' }));
    expect(await screen.findByText('No se pudo bloquear. Inténtalo de nuevo.')).toBeTruthy();
  });

  it('names the person as the backend has them once it answers, and works for a member', async () => {
    const juan: BlockTarget = { kind: 'member', gid: 'g1', ik_sign_pub: IK };
    const { api } = mount(preview({ label: 'jhon', contact: null }), {}, juan);
    expect(await screen.findByRole('alertdialog', { name: '¿Bloquear a ~jhon?' })).toBeTruthy();
    fireEvent.click(await screen.findByRole('button', { name: 'Bloquear' }));
    await waitFor(() => expect(api.blockIdentity).toHaveBeenCalledWith(juan));
  });
});
