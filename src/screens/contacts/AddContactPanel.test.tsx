// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { CommandError, ContactPreview, NodeInfo } from '../../lib/api';
import { toCompactCodeV2 } from '../../lib/contact-code';
import { I18nContext, makeT } from '../../lib/i18n';
import { AddContactPanel } from './AddContactPanel';

afterEach(cleanup);

const BUNDLE = JSON.stringify({
  handle: 'Ana Torres',
  idSig: 'd4'.repeat(64),
  ikDhPub: '8f'.repeat(32),
  ikSignPub: '3b'.repeat(32),
  nostrPub: 'a1'.repeat(32),
  opkId: null,
  opkPub: null,
  spkId: 7,
  spkPub: 'e7'.repeat(32),
  spkSig: '0f'.repeat(64),
});
const CODE = toCompactCodeV2(BUNDLE);

const preview = (existing: ContactPreview['existing'] = null): ContactPreview => ({
  handle: 'Ana Torres',
  fingerprint: '7f3a.91c2.0b5e.d4a8',
  identity_digest: 'ab'.repeat(32),
  existing,
});
const nodeFor = (handle: string): NodeInfo => ({ handle, fingerprint: '7f3a.91c2.0b5e.d4a8', has_session: false, added_at: 1 });
const commandError = (code: CommandError['code'], extra: Partial<CommandError> = {}): CommandError => ({
  code,
  message: code,
  ...extra,
});

function mount(answer: () => Promise<ContactPreview> = async () => preview()) {
  const api = {
    previewContact: vi.fn(answer),
    probeNode: vi.fn(async (_bundleJson: string, handle: string, _replace?: boolean) => nodeFor(handle)),
  };
  const onContactAdded = vi.fn();
  render(
    <I18nContext.Provider value={makeT('es')}>
      <AddContactPanel api={api} onContactAdded={onContactAdded} />
    </I18nContext.Provider>,
  );
  return { api, onContactAdded };
}

const codeBox = () => screen.getByRole('textbox', { name: 'Pega el código de la otra persona' });
const paste = (text: string) => fireEvent.change(codeBox(), { target: { value: text } });

describe('AddContactPanel', () => {
  it('shows the card of a pasted code: the name, "Código válido" and the key in groups', async () => {
    const { api } = mount();
    paste(CODE);
    expect(await screen.findByText('Código válido')).toBeTruthy();
    expect(api.previewContact).toHaveBeenCalledWith(JSON.stringify(JSON.parse(BUNDLE)));
    expect(screen.getByText('Ana Torres')).toBeTruthy();
    expect(screen.getByText('Su clave')).toBeTruthy();
    expect(screen.getByText('7F3A 91C2 0B5E D4A8')).toBeTruthy();
  });

  it('adds the contact under the name in its code', async () => {
    const { api, onContactAdded } = mount();
    paste(CODE);
    fireEvent.click(await screen.findByRole('button', { name: 'Agregar a Ana Torres' }));
    await waitFor(() => expect(onContactAdded).toHaveBeenCalledWith('Ana Torres'));
    expect(api.probeNode).toHaveBeenCalledWith(expect.any(String), 'Ana Torres', undefined);
    expect(screen.getByRole('status').textContent).toBe('Agregaste a Ana Torres.');
    expect((codeBox() as HTMLTextAreaElement).value).toBe('');
  });

  it('says a text that is no code is not valid, without asking the backend', () => {
    const { api } = mount();
    paste('hola, este es mi código');
    expect(screen.getByRole('alert').textContent).toContain('Este código no es válido.');
    expect(codeBox().getAttribute('aria-invalid')).toBe('true');
    expect(api.previewContact).not.toHaveBeenCalled();
  });

  it('says a code the backend refused is not valid', async () => {
    mount(async () => Promise.reject(commandError('invalid_code')));
    paste(CODE);
    expect((await screen.findByRole('alert')).textContent).toContain('Este código no es válido.');
    expect(screen.queryByText('Código válido')).toBeNull();
  });

  it('lets a failed check be retried', async () => {
    let fail = true;
    const { api } = mount(async () => (fail ? Promise.reject(new Error('io')) : preview()));
    paste(CODE);
    expect((await screen.findByRole('alert')).textContent).toContain('No se pudo comprobar el código.');
    fail = false;
    fireEvent.click(screen.getByRole('button', { name: 'Reintentar' }));
    expect(await screen.findByText('Código válido')).toBeTruthy();
    expect(api.previewContact).toHaveBeenCalledTimes(2);
  });

  it('warns when the name belongs to a contact with other keys, and replaces it only after a yes', async () => {
    const { api } = mount(async () => preview({ handle: 'Ana Torres', same_keys: false }));
    paste(CODE);
    expect(await screen.findByText(/Ya tienes un contacto llamado «Ana Torres» con otra clave\./)).toBeTruthy();
    const add = screen.getByRole('button', { name: 'Agregar a Ana Torres' }) as HTMLButtonElement;
    expect(add.disabled).toBe(true);

    fireEvent.click(screen.getByRole('checkbox', { name: 'Reemplazar a Ana Torres por esta clave' }));
    fireEvent.click(screen.getByRole('button', { name: 'Reemplazar a Ana Torres' }));
    await waitFor(() => expect(api.probeNode).toHaveBeenCalledWith(expect.any(String), 'Ana Torres', true));
  });

  it('saves under another name instead, without replacing anyone', async () => {
    const { api } = mount(async () => preview({ handle: 'Ana Torres', same_keys: false }));
    paste(CODE);
    fireEvent.change(await screen.findByRole('textbox', { name: 'Guardar como' }), { target: { value: 'Ana del trabajo' } });
    expect(screen.queryByRole('checkbox')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Agregar a Ana del trabajo' }));
    await waitFor(() => expect(api.probeNode).toHaveBeenCalledWith(expect.any(String), 'Ana del trabajo', undefined));
  });

  it('knows a person you already have under another name, and offers no add', async () => {
    mount(async () => preview({ handle: 'Anita', same_keys: true }));
    paste(CODE);
    expect(await screen.findByText('Ya tienes a esta persona en tus contactos, como «Anita».')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Agregar a/ })).toBeNull();
  });

  it('asks for another name when the backend says the name is taken', async () => {
    const { api } = mount();
    api.probeNode.mockRejectedValueOnce(commandError('name_taken'));
    paste(CODE);
    fireEvent.click(await screen.findByRole('button', { name: 'Agregar a Ana Torres' }));
    expect(await screen.findByText('Ese nombre ya lo tiene otro contacto. Elige otro.')).toBeTruthy();
    expect(screen.getByRole('textbox', { name: 'Guardar como' }).getAttribute('aria-invalid')).toBe('true');
  });

  it('says so when adding fails, and keeps the card to try again', async () => {
    const { api, onContactAdded } = mount();
    api.probeNode.mockRejectedValueOnce('io error');
    paste(CODE);
    fireEvent.click(await screen.findByRole('button', { name: 'Agregar a Ana Torres' }));
    expect((await screen.findByRole('alert')).textContent).toContain('No se pudo agregar el contacto.');
    expect(onContactAdded).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Agregar a Ana Torres' })).toBeTruthy();
  });

  it('starts over on Cancelar', async () => {
    mount();
    paste(CODE);
    fireEvent.click(await screen.findByRole('button', { name: 'Cancelar' }));
    expect(screen.queryByText('Código válido')).toBeNull();
    expect((codeBox() as HTMLTextAreaElement).value).toBe('');
  });

  it('has no camera button, and its notes are the honest ones', async () => {
    mount();
    expect(screen.queryByRole('button', { name: /cámara|escanear/i })).toBeNull();
    expect(screen.getByText('Para hablar, los dos tienen que agregarse con su código.')).toBeTruthy();
    paste(CODE);
    expect(
      await screen.findByText(
        'Para verificar a Ana Torres, llámale y comparen los símbolos de la llamada. También puedes hacerlo después desde el chat.',
      ),
    ).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/compara esta clave|solicitud/i);
  });
});
