// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NodeInfo, ProfileResponse } from '../../../lib/api';
import { commandError, fakeApi, node, PROFILE, renderEs } from '../test-utils';
import { ProfileSection, type ProfileSectionProps } from './ProfileSection';

afterEach(cleanup);

const SHARED =
  'Tu nombre, tu foto y lo que escribas en «Sobre mí» les llegan cifrados a tus contactos y a tus grupos. Los servidores de Trino no los ven.';
const LOCAL =
  'Tu foto y tu nombre se quedan en este equipo. Tus contactos te ven con el nombre que tenía tu código cuando te agregaron.';

function setup(
  props: Partial<ProfileSectionProps> = {},
  { profile = PROFILE, nodes = [] as NodeInfo[] }: { profile?: ProfileResponse; nodes?: NodeInfo[] } = {},
) {
  const api = fakeApi({ listNodes: vi.fn(async () => nodes) });
  const all: ProfileSectionProps = {
    api,
    profile,
    profileSync: true,
    makeAvatar: vi.fn(async () => 'data:image/jpeg;base64,AAAA'),
    onOpenQr: vi.fn(),
    onSaved: vi.fn(),
    ...props,
  };
  const view = renderEs(<ProfileSection {...all} />);
  return { ...view, api, props: all };
}

const aboutField = () => screen.getByRole('textbox', { name: 'Sobre mí' }) as HTMLTextAreaElement;
const describedBy = (element: HTMLElement) =>
  (element.getAttribute('aria-describedby') ?? '')
    .split(/\s+/)
    .filter(Boolean)
    .map(id => document.getElementById(id)?.textContent);

describe('ProfileSection with the shared profile (profileSync and sync 1)', () => {
  it('edits "Sobre mí" in three rows, with a count tied to the field', () => {
    setup();
    const about = aboutField();
    expect(about.value).toBe('Respondo en las tardes.');
    expect(about.getAttribute('rows')).toBe('3');
    expect(describedBy(about)).toContain('23 / 140');
  });

  it('stops "Sobre mí" at 140 scalars, an emoji counting one', () => {
    setup();
    const about = aboutField();
    fireEvent.change(about, { target: { value: 'a'.repeat(139) + '😀' } });
    expect(about.value).toBe('a'.repeat(139) + '😀');
    expect(describedBy(about)).toContain('140 / 140');
    fireEvent.change(about, { target: { value: 'a'.repeat(139) + '😀b' } });
    expect(about.value).toBe('a'.repeat(139) + '😀');
  });

  it('says what the board says: the profile reaches contacts and groups, encrypted', () => {
    setup();
    expect(screen.getByText(SHARED)).toBeTruthy();
    expect(screen.queryByText(LOCAL)).toBeNull();
  });

  it('adds who it does not reach yet, counting the contacts that are not blocked', async () => {
    setup({}, {
      nodes: [
        node('ana', { profile_sync: true }),
        node('beto', { profile_sync: false }),
        node('caro'),
        node('dani', { blocked: true }),
      ],
    });
    expect(
      await screen.findByText(
        'Todavía no les llega a 2 de tus contactos: les llegará cuando te escriban desde una versión nueva de Trino.',
      ),
    ).toBeTruthy();
  });

  it('says it in the singular for one contact', async () => {
    setup({}, { nodes: [node('ana', { profile_sync: true }), node('beto')] });
    expect(
      await screen.findByText(
        'Todavía no le llega a 1 de tus contactos: le llegará cuando te escriba desde una versión nueva de Trino.',
      ),
    ).toBeTruthy();
  });

  it('leaves that line out when every contact gets it', async () => {
    const { api } = setup({}, { nodes: [node('ana', { profile_sync: true }), node('dani', { blocked: true })] });
    await waitFor(() => expect(api.listNodes).toHaveBeenCalled());
    await act(async () => {});
    expect(screen.queryByText(/Todavía no/)).toBeNull();
  });

  it('sends "Sobre mí" with the name and the photo when saving', async () => {
    const { api, props } = setup();
    fireEvent.change(aboutField(), { target: { value: 'Ahora respondo en las noches.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Guardar' }));
    await waitFor(() => expect(api.updateProfile).toHaveBeenCalledWith('rechita', null, 'Ahora respondo en las noches.'));
    expect(await screen.findByText('Perfil guardado.')).toBeTruthy();
    expect(props.onSaved).toHaveBeenCalledTimes(1);
  });
});

describe('ProfileSection without the shared profile', () => {
  it('has no "Sobre mí" and only says that the profile stays here, without the capability', () => {
    const { api } = setup({ profileSync: false });
    expect(screen.queryByRole('textbox', { name: 'Sobre mí' })).toBeNull();
    expect(screen.getByText(LOCAL)).toBeTruthy();
    expect(screen.queryByText(SHARED)).toBeNull();
    expect(api.listNodes).not.toHaveBeenCalled();
  });

  it('does the same when the backend does not send profiles yet', () => {
    setup({ profileSync: true }, { profile: { ...PROFILE, sync: undefined } });
    expect(screen.queryByRole('textbox', { name: 'Sobre mí' })).toBeNull();
    expect(screen.getByText(LOCAL)).toBeTruthy();
  });

  it('saves with the payload of older backends, without "Sobre mí"', async () => {
    const { api } = setup({ profileSync: false });
    fireEvent.click(screen.getByRole('button', { name: 'Guardar' }));
    await waitFor(() => expect(api.updateProfile).toHaveBeenCalledTimes(1));
    expect(vi.mocked(api.updateProfile).mock.calls[0]).toEqual(['rechita', null, undefined]);
  });
});

describe('ProfileSection, always', () => {
  // profile_invalid also stands for control, format or bidi characters, and
  // for a name that shows nothing (B1), so the text names both.
  it('shows a profile over its limits, or with characters that do not show, as an alert', async () => {
    const { api } = setup();
    vi.mocked(api.updateProfile).mockRejectedValueOnce(commandError('profile_invalid'));
    fireEvent.click(screen.getByRole('button', { name: 'Guardar' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain(
      'No se pudo guardar: tu nombre, tu foto o «Sobre mí» pasan del límite o tienen caracteres que no se ven.',
    );
  });

  it('shows any other failure as an alert too, and calls nothing saved', async () => {
    const { api, props } = setup();
    vi.mocked(api.updateProfile).mockRejectedValueOnce(new Error('io'));
    fireEvent.click(screen.getByRole('button', { name: 'Guardar' }));
    expect((await screen.findByRole('alert')).textContent).toContain('No se pudo guardar tu perfil');
    expect(props.onSaved).not.toHaveBeenCalled();
  });

  // `io` is what the backend answers while profiles.bin could not be read at
  // unlock (B1): this session will not write it, so saving again now fails
  // the same way. The next unlock reads it again, so the text says to lock
  // and unlock, and not "Inténtalo de nuevo".
  it('says to lock and unlock, not to try again, when the backend answers io', async () => {
    const { api, props } = setup();
    vi.mocked(api.updateProfile).mockRejectedValueOnce(commandError('io'));
    fireEvent.click(screen.getByRole('button', { name: 'Guardar' }));
    const text = (await screen.findByRole('alert')).textContent ?? '';
    expect(text).toContain(
      'No se pudo guardar tu perfil en este equipo. Bloquea Trino, desbloquéalo y vuelve a guardar: al desbloquear, Trino lee tu perfil de nuevo.',
    );
    expect(text).not.toContain('Inténtalo de nuevo');
    expect(props.onSaved).not.toHaveBeenCalled();
  });

  it('makes the picked photo with makeAvatar and saves what it gives', async () => {
    const { api, props, container } = setup();
    const file = new File([new Uint8Array([1, 2, 3])], 'yo.png', { type: 'image/png' });
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    expect(input.getAttribute('accept')).toBe('image/*');
    fireEvent.change(input, { target: { files: [file] } });
    await waitFor(() => expect(props.makeAvatar).toHaveBeenCalledWith(file));
    const photo = await screen.findByRole('img', { name: 'Tu foto' });
    expect(photo.querySelector('img')?.getAttribute('src')).toBe('data:image/jpeg;base64,AAAA');
    fireEvent.click(screen.getByRole('button', { name: 'Guardar' }));
    await waitFor(() =>
      expect(api.updateProfile).toHaveBeenCalledWith('rechita', 'data:image/jpeg;base64,AAAA', 'Respondo en las tardes.'),
    );
  });

  it('says so when a picture cannot be used', async () => {
    const { container } = setup({ makeAvatar: vi.fn(async () => Promise.reject(new Error('not a picture'))) });
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [new File(['x'], 'nota.txt', { type: 'text/plain' })] } });
    expect((await screen.findByRole('alert')).textContent).toContain('No se pudo usar esa imagen');
  });

  it('opens the file picker from "Editar foto"', () => {
    const { container } = setup();
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    const click = vi.spyOn(input, 'click');
    fireEvent.click(screen.getByRole('button', { name: 'Editar foto' }));
    expect(click).toHaveBeenCalledTimes(1);
  });

  it('offers "Quitar foto" only with a photo, and saves without it', async () => {
    const { api } = setup({}, { profile: { ...PROFILE, avatar: 'data:image/jpeg;base64,BBBB' } });
    fireEvent.click(screen.getByRole('button', { name: 'Quitar foto' }));
    expect(screen.queryByRole('img', { name: 'Tu foto' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Quitar foto' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Guardar' }));
    await waitFor(() => expect(api.updateProfile).toHaveBeenCalledWith('rechita', null, 'Respondo en las tardes.'));
  });

  it('gives the focus to "Editar foto" once "Quitar foto" goes away', () => {
    setup({}, { profile: { ...PROFILE, avatar: 'data:image/jpeg;base64,BBBB' } });
    const remove = screen.getByRole('button', { name: 'Quitar foto' });
    remove.focus();
    fireEvent.click(remove);
    expect(remove.isConnected).toBe(false);
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Editar foto' }));
  });

  it('keeps the name to 40 characters and asks for one before saving', async () => {
    const { api } = setup();
    const name = screen.getByRole('textbox', { name: 'Nombre' }) as HTMLInputElement;
    fireEvent.change(name, { target: { value: 'x'.repeat(41) } });
    expect(name.value).toBe('x'.repeat(40));
    fireEvent.change(name, { target: { value: '   ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Guardar' }));
    await waitFor(() => expect(name.getAttribute('aria-invalid')).toBe('true'));
    expect(describedBy(name)).toContain('Escribe tu nombre.');
    expect(document.activeElement).toBe(name);
    expect(api.updateProfile).not.toHaveBeenCalled();
  });

  it('lists how people find you: only your QR code, which opens its view', () => {
    const { props } = setup();
    const list = screen.getByRole('list', { name: 'Cómo te encuentran' });
    const rows = within(list).getAllByRole('listitem');
    expect(rows).toHaveLength(1);
    fireEvent.click(within(list).getByRole('button', { name: /Tu código QR/ }));
    expect(props.onOpenQr).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Para que te agreguen sin escribir nada.')).toBeTruthy();
  });

  it('never shows an @name', () => {
    const { container } = setup();
    expect(container.textContent).not.toContain('@');
  });
});
