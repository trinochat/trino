// @vitest-environment jsdom
import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { sasWords } from '../../lib/sas-symbols';
import { SasKey } from './SasKey';
import { renderIn } from './test-support';
import type { CallSas } from './useCallController';

afterEach(cleanup);

const INDICES = [0, 44, 12, 43, 27, 37, 42];
const WORDS = sasWords(INDICES, 'es');

function show(sas: CallSas = { indices: INDICES, verified: false }, onMatch = vi.fn(), onMismatch = vi.fn()) {
  const view = renderIn(
    <div data-testid="stage" onKeyDown={event => (event.target as HTMLElement).setAttribute('data-escaped', event.key)}>
      <SasKey sas={sas} peerName="Ana Torres" onMatch={onMatch} onMismatch={onMismatch}>
        <span>Avatar</span>
      </SasKey>
    </div>,
  );
  return { ...view, onMatch, onMismatch };
}

const pill = () => screen.getByRole('button', { name: /^(Símbolos de la llamada|Llamada verificada)/ });

describe('SasKey', () => {
  it('shows the 7 symbols at the top, each icon with its word, and reads the words in order', () => {
    show();
    const key = pill();
    expect(key.getAttribute('aria-label')).toBe(`Símbolos de la llamada: ${WORDS.join(', ')}`);
    expect(key.getAttribute('aria-expanded')).toBe('false');
    const icons = key.querySelectorAll('svg[data-sas]');
    expect(icons).toHaveLength(7);
    // 20 px at 100 %, the least wherever two people compare symbols (docs/sas-v2.md).
    for (const icon of icons) expect(icon.getAttribute('width')).toBe('20');
    expect(Array.from(key.querySelectorAll('[lang]'), word => word.textContent)).toEqual(WORDS);
    expect(screen.getByText('Avatar')).toBeTruthy();
  });

  it('opens the comparison: 7 bigger symbols with their words, and what a match means', () => {
    show();
    fireEvent.click(pill());
    expect(pill().getAttribute('aria-expanded')).toBe('true');
    const panel = screen.getByRole('group', { name: 'Compara estos símbolos con Ana Torres' });
    expect(pill().getAttribute('aria-controls')).toBe(panel.id);
    expect(panel.textContent).toContain('Si Ana Torres ve los mismos en su pantalla, nadie está escuchando en medio.');
    const list = within(panel).getByRole('list', { name: 'Símbolos de la llamada' });
    const items = within(list).getAllByRole('listitem');
    expect(items.map(item => item.textContent)).toEqual(WORDS);
    // 28 px at 100 % in the comparison panel.
    for (const item of items) expect(item.querySelector('svg')!.getAttribute('width')).toBe('28');
    expect(screen.queryByText('Avatar')).toBeNull();
  });

  it('confirms the match, closes the comparison and gives the focus back to the key', () => {
    const { onMatch } = show();
    fireEvent.click(pill());
    fireEvent.click(screen.getByRole('button', { name: 'Coinciden' }));
    expect(onMatch).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('group')).toBeNull();
    expect(document.activeElement).toBe(pill());
  });

  it('asks both to update and call again when the symbols do not match', () => {
    const { onMatch } = show();
    fireEvent.click(pill());
    fireEvent.click(screen.getByRole('button', { name: 'No coinciden' }));
    expect(screen.getByRole('alert').textContent).toBe(
      'Puede que alguien esté en medio. Cuelga y vuelve a llamar. Si tu contacto no ha actualizado Trino, verá otros símbolos: actualicen los dos y comparen otra vez.',
    );
    expect(onMatch).not.toHaveBeenCalled();
  });

  // "Coinciden" pressed by mistake is undone by "No coinciden" (review of W6): the call has to hear it.
  it('tells the call when the symbols do not match, and takes the alert away on a later match', () => {
    const { onMatch, onMismatch } = show();
    fireEvent.click(pill());
    fireEvent.click(screen.getByRole('button', { name: 'No coinciden' }));
    expect(onMismatch).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Coinciden' }));
    expect(onMatch).toHaveBeenCalledTimes(1);
    fireEvent.click(pill());
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('group').textContent).toContain('nadie está escuchando en medio');
  });

  it('closes with Escape, keeping the key for itself and the focus on the key', () => {
    show();
    fireEvent.click(pill());
    const match = screen.getByRole('button', { name: 'Coinciden' });
    match.focus();
    fireEvent.keyDown(match, { key: 'Escape' });
    expect(screen.queryByRole('group')).toBeNull();
    expect(document.activeElement).toBe(pill());
    expect(match.getAttribute('data-escaped')).toBeNull();
    // Closed, Escape goes on to the screen around it.
    fireEvent.keyDown(pill(), { key: 'Escape' });
    expect(pill().getAttribute('data-escaped')).toBe('Escape');
  });

  it('says the call is verified, and still opens the symbols', () => {
    show({ indices: INDICES, verified: true });
    const key = pill();
    expect(key.getAttribute('aria-label')).toBe(`Llamada verificada. Símbolos: ${WORDS.join(', ')}`);
    expect(key.textContent).toContain('Llamada verificada');
    fireEvent.click(key);
    expect(screen.getByRole('list', { name: 'Símbolos de la llamada' })).toBeTruthy();
  });

  it('starts over when the symbols change', () => {
    const { rerender, onMatch } = show();
    fireEvent.click(pill());
    fireEvent.click(screen.getByRole('button', { name: 'No coinciden' }));
    rerender(
      <div>
        <SasKey sas={{ indices: [1, 2, 3, 4, 5, 6, 7], verified: false }} peerName="Ana Torres" onMatch={onMatch} onMismatch={() => {}} />
      </div>,
    );
    expect(pill().getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
