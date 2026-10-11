// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { NodeInfo } from '../../../lib/api';
import { I18nContext, makeT, type Lang } from '../../../lib/i18n';
import { LangCtx } from '../../../lib/i18n-context';
import type { NewChatSlotProps } from '../../types';
import { NewChatDialog } from './NewChatDialog';

afterEach(cleanup);

const node = (handle: string, extra: Partial<NodeInfo> = {}): NodeInfo => ({
  handle,
  fingerprint: '7f3a.91c2.0b5e.d4a8',
  has_session: true,
  added_at: 0,
  ...extra,
});

const CONTACTS = [
  node('Ana Torres'),
  node('Álvaro'),
  node('Carlos Méndez'),
  node('José'),
  node('Ñata'),
  node('Bloqueado', { blocked: true }),
];

function open(props: Partial<NewChatSlotProps> = {}, lang: Lang = 'es') {
  const handlers = {
    onClose: vi.fn(),
    onOpenChat: vi.fn(),
    onCall: vi.fn(),
    onNewGroup: vi.fn(),
    onAddWithCode: vi.fn(),
  };
  render(
    <LangCtx.Provider value={{ lang, setLang: () => {} }}>
      <I18nContext.Provider value={makeT(lang)}>
        <NewChatDialog purpose="chat" contacts={CONTACTS} trust={{ 'Ana Torres': 'verified' }} {...handlers} {...props} />
      </I18nContext.Provider>
    </LangCtx.Provider>,
  );
  return handlers;
}

const search = () => screen.getByRole('searchbox', { name: 'Buscar en tus contactos' });
const type = (text: string) => fireEvent.change(search(), { target: { value: text } });
const shortcuts = () => screen.queryByRole('list', { name: 'Atajos' });

describe('NewChatDialog', () => {
  it('is the "Nuevo chat" dialog, with the search focused and named', () => {
    open();
    expect(screen.getByRole('dialog', { name: 'Nuevo chat' })).toBeTruthy();
    expect(document.activeElement).toBe(search());
    expect(search().getAttribute('placeholder')).toBe('Nombre');
  });

  // Input sets its own min-h-12, and Tailwind puts .min-h-12 after .min-h-11
  // whatever the order of the classes: a second min-h would never apply.
  it('leaves the height of the search box to Input, with no override that would lose', () => {
    open();
    expect(search().className.split(/\s+/).filter(name => name.startsWith('min-h-'))).toHaveLength(1);
  });

  it('closes with Escape and with its close button', () => {
    const handlers = open();
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(handlers.onClose).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Cerrar' }));
    expect(handlers.onClose).toHaveBeenCalledTimes(2);
  });

  it('offers the shortcuts while the search is empty, and they do what they say', () => {
    const handlers = open();
    const list = shortcuts()!;
    expect(within(list).getAllByRole('button').map(button => button.textContent)).toEqual([
      'Nuevo grupo',
      'Agregar con código o QR',
    ]);
    fireEvent.click(within(list).getByRole('button', { name: 'Nuevo grupo' }));
    expect(handlers.onNewGroup).toHaveBeenCalledTimes(1);
    fireEvent.click(within(list).getByRole('button', { name: 'Agregar con código o QR' }));
    expect(handlers.onAddWithCode).toHaveBeenCalledTimes(1);
  });

  it('hides the shortcuts while you search', () => {
    open();
    type('an');
    expect(shortcuts()).toBeNull();
    type('   ');
    expect(shortcuts()).not.toBeNull();
  });

  it('lists the contacts under a heading per letter, each list named after its letter', () => {
    open();
    const headings = screen.getAllByRole('heading', { level: 3 }).map(heading => heading.textContent);
    expect(headings).toEqual(['A', 'C', 'J', 'Ñ']);
    const a = screen.getByRole('list', { name: 'Contactos con A' });
    expect(within(a).getAllByRole('listitem')).toHaveLength(2);
    expect(within(a).getAllByRole('button')).toEqual([
      within(a).getByRole('button', { name: 'Álvaro' }),
      within(a).getByRole('button', { name: 'Ana Torres Verificado' }),
    ]);
    expect(screen.getByRole('list', { name: 'Contactos con Ñ' })).toBeTruthy();
  });

  it('marks only verified contacts, with a compact badge that names it', () => {
    open();
    const ana = screen.getByRole('button', { name: 'Ana Torres Verificado' });
    expect(ana.querySelector('[data-trust="verified"]')).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Carlos Méndez' }).querySelector('[data-trust]')).toBeNull();
  });

  it('leaves blocked contacts out', () => {
    open();
    expect(screen.queryByText('Bloqueado')).toBeNull();
    type('bloq');
    expect(screen.queryByText('Bloqueado')).toBeNull();
  });

  it('opens the chat of the contact you pick, and offers no call in a new chat', () => {
    const handlers = open();
    fireEvent.click(screen.getByRole('button', { name: 'Carlos Méndez' }));
    expect(handlers.onOpenChat).toHaveBeenCalledWith('Carlos Méndez');
    expect(handlers.onCall).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: /^Llamar a/ })).toBeNull();
  });

  it('filters by name without minding accents or case', () => {
    open();
    type('JOSE');
    expect(screen.getAllByRole('heading', { level: 3 }).map(heading => heading.textContent)).toEqual(['J']);
    expect(screen.getByRole('button', { name: 'José' })).toBeTruthy();
  });

  it('says nobody matches, and offers to add with a code', () => {
    const handlers = open();
    type('  zzz ');
    expect(screen.getByText('Nadie en tus contactos coincide con «zzz».')).toBeTruthy();
    expect(screen.queryAllByRole('heading', { level: 3 })).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: 'Agregar con código' }));
    expect(handlers.onAddWithCode).toHaveBeenCalledTimes(1);
  });

  it('is "Nueva llamada" for a call: no shortcuts, and every contact calls with voice', () => {
    const handlers = open({ purpose: 'call' });
    expect(screen.getByRole('dialog', { name: 'Nueva llamada' })).toBeTruthy();
    expect(shortcuts()).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Carlos Méndez' }));
    expect(handlers.onCall).toHaveBeenLastCalledWith('Carlos Méndez', false);
    fireEvent.click(screen.getByRole('button', { name: 'Llamar a José' }));
    expect(handlers.onCall).toHaveBeenLastCalledWith('José', false);
    expect(handlers.onOpenChat).not.toHaveBeenCalled();
  });

  it('says when there are no contacts yet, and offers to add one where no shortcut does', () => {
    const chat = open({ contacts: [] });
    expect(screen.getByText('Todavía no tienes contactos.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Agregar con código' })).toBeNull();
    cleanup();
    const call = open({ contacts: [], purpose: 'call' });
    expect(screen.getByText('Todavía no tienes contactos.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Agregar con código' }));
    expect(call.onAddWithCode).toHaveBeenCalledTimes(1);
    expect(chat.onAddWithCode).not.toHaveBeenCalled();
  });

  // David, 11 Oct: the @name ships later, with the invitations and Tor.
  it('offers no search by @name', () => {
    open();
    type('ana');
    type('');
    expect(document.body.textContent).not.toMatch(/@nombre|@name|por @/i);
    expect(screen.queryByRole('button', { name: /@/ })).toBeNull();
  });

  it('speaks the language of the app', () => {
    open({ purpose: 'call' }, 'en');
    expect(screen.getByRole('dialog', { name: 'New call' })).toBeTruthy();
    expect(screen.getByRole('list', { name: 'Contacts under N' })).toBeTruthy();
  });
});
