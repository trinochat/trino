// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { NodeInfo } from '../lib/api';
import type { Prefs } from '../lib/prefs';
import { memoryPrefs, node, withLang } from '../screens/settings/test-utils';
import { useLegacyMarksNotice } from './verification';

// The marks of 0.1.0 no longer count (W6, parent decision of 11 Oct): once
// the chats know their contacts, the people whose mark was one of those are
// told once, by name, and the old marks go (plan-cambios-11oct §7, I5).

afterEach(cleanup);

const FP = 'ab12.cd34.ef56.7890';
const OTHER = '0000.1111.2222.3333';
const CONTACTS = [node('Ana', { fingerprint: FP }), node('Beto', { fingerprint: FP }), node('Diego', { fingerprint: OTHER })];

function Chats({ contacts, prefs }: { contacts: readonly NodeInfo[]; prefs: Prefs }) {
  return <>{useLegacyMarksNotice({ contacts, prefs })}</>;
}

function mount(stored: Record<string, string>, contacts: readonly NodeInfo[] = CONTACTS) {
  const { prefs, storage } = memoryPrefs(stored);
  const view = render(withLang(<Chats contacts={contacts} prefs={prefs} />));
  const rerender = (next: readonly NodeInfo[]) => view.rerender(withLang(<Chats contacts={next} prefs={prefs} />));
  return { prefs, storage, rerender };
}

const notice = () => screen.queryByRole('dialog', { name: 'Vuelve a verificar a tus contactos' });

describe('useLegacyMarksNotice', () => {
  it('names the contacts whose mark comes from 0.1.0, once the chats know them', () => {
    const { rerender } = mount({ 'verified:Ana': FP, 'verified:Beto': `call:${FP}`, 'verified:Diego': OTHER }, []);
    expect(notice()).toBeNull();

    rerender(CONTACTS);
    const list = within(notice()!).getByRole('list', { name: 'Contactos que tenías verificados' });
    expect(within(list).getAllByRole('listitem').map(item => item.textContent)).toEqual(['Ana', 'Diego']);
  });

  it('removes those marks once closed, so it never shows again', () => {
    const { storage, rerender } = mount({ 'verified:Ana': FP, 'verified:Beto': `call:${FP}` });
    fireEvent.click(within(notice()!).getByRole('button', { name: 'Entendido' }));
    expect(notice()).toBeNull();
    expect(Object.fromEntries(storage.data)).toEqual({ 'verified:Beto': `call:${FP}` });

    rerender([...CONTACTS]);
    expect(notice()).toBeNull();
  });

  // A call can verify one of them while the notice is open: that mark is new, and stays.
  it('keeps a mark that a call made while it was open', () => {
    const { prefs, storage } = mount({ 'verified:Ana': FP });
    prefs.setVerified('Ana', FP);
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(notice()).toBeNull();
    expect(storage.data.get('verified:Ana')).toBe(`call:${FP}`);
  });

  it('shows nothing when no contact has an old mark', () => {
    mount({ 'verified:Beto': `qr:${FP}` });
    expect(notice()).toBeNull();
  });
});
