// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { installCopyGuard } from './copy-guard';

let stop: (() => void) | undefined;
afterEach(() => {
  stop?.();
  stop = undefined;
  document.body.innerHTML = '';
  getSelection()?.removeAllRanges();
});

/** A copy or a cut as the webview fires it: Ctrl + C, Ctrl + X or a menu's item. */
function fire(kind: 'copy' | 'cut', target: EventTarget = document.body): Event {
  const event = new Event(kind, { bubbles: true, cancelable: true });
  target.dispatchEvent(event);
  return event;
}

function install() {
  const copy = vi.fn(async (_text: string) => {});
  stop = installCopyGuard(window, copy);
  return copy;
}

/** Selects `from` to `to` of a paragraph's text, as the mouse would. */
function selectIn(paragraph: HTMLElement, from: number, to: number) {
  const range = document.createRange();
  range.setStart(paragraph.firstChild!, from);
  range.setEnd(paragraph.firstChild!, to);
  getSelection()!.removeAllRanges();
  getSelection()!.addRange(range);
}

// Cifrado local CL-6b, design test 46: every copy goes through the backend,
// so it stays out of the clipboard history. The guard cancels the webview's
// own copy and hands the selected text over instead.
describe('every copy goes through the backend', () => {
  it("Ctrl + C on a message's text copies the selection there, not with the webview", () => {
    const copy = install();
    document.body.innerHTML = '<p>Perfecto, nos vemos el jueves</p>';
    const paragraph = document.querySelector('p')!;
    selectIn(paragraph, 0, 8);
    const event = fire('copy', paragraph);
    expect(event.defaultPrevented).toBe(true);
    expect(copy).toHaveBeenCalledWith('Perfecto');
  });

  it("copies what is selected in a text field, with Ctrl + C or the field's menu", () => {
    const copy = install();
    document.body.innerHTML = '<input value="hola Ana" /><textarea>uno\ndos</textarea>';
    const input = document.querySelector('input')!;
    input.focus();
    input.setSelectionRange(5, 8);
    expect(fire('copy', input).defaultPrevented).toBe(true);
    expect(copy).toHaveBeenLastCalledWith('Ana');

    const area = document.querySelector('textarea')!;
    area.focus();
    area.setSelectionRange(0, 7);
    fire('copy', area);
    expect(copy).toHaveBeenLastCalledWith('uno\ndos');
  });

  it('Ctrl + X in a text field copies there and takes the selection out of the field', () => {
    const copy = install();
    document.body.innerHTML = '<input value="hola Ana" />';
    const input = document.querySelector('input')!;
    const typed = vi.fn();
    input.addEventListener('input', typed);
    input.focus();
    input.setSelectionRange(4, 8);
    expect(fire('cut', input).defaultPrevented).toBe(true);
    expect(copy).toHaveBeenCalledWith(' Ana');
    expect(input.value).toBe('hola');
    expect(typed).toHaveBeenCalled();
  });

  it('cuts nothing out of a field that cannot be written', () => {
    const copy = install();
    document.body.innerHTML = '<input value="hola Ana" readonly />';
    const input = document.querySelector('input')!;
    input.focus();
    input.setSelectionRange(5, 8);
    fire('cut', input);
    expect(copy).toHaveBeenCalledWith('Ana');
    expect(input.value).toBe('hola Ana');
  });

  it('never copies a password, and lets the webview refuse as it does', () => {
    const copy = install();
    document.body.innerHTML = '<input type="password" value="secreto" />';
    const input = document.querySelector('input')!;
    input.focus();
    input.setSelectionRange(0, 7);
    expect(fire('copy', input).defaultPrevented).toBe(false);
    expect(fire('cut', input).defaultPrevented).toBe(false);
    expect(copy).not.toHaveBeenCalled();
  });

  it('leaves a copy alone with nothing selected, or one a component already took', () => {
    const copy = install();
    document.body.innerHTML = '<p>Hola</p>';
    expect(fire('copy').defaultPrevented).toBe(false);
    selectIn(document.querySelector('p')!, 0, 4);
    document.body.addEventListener('copy', event => event.preventDefault(), { once: true });
    fire('copy', document.querySelector('p')!);
    expect(copy).not.toHaveBeenCalled();
  });

  it('a cut outside a text field copies nothing, as the webview would', () => {
    const copy = install();
    document.body.innerHTML = '<p>Hola</p>';
    selectIn(document.querySelector('p')!, 0, 4);
    expect(fire('cut', document.querySelector('p')!).defaultPrevented).toBe(false);
    expect(copy).not.toHaveBeenCalled();
  });

  it('gives the webview its copy back once removed', () => {
    const copy = install();
    stop!();
    stop = undefined;
    document.body.innerHTML = '<p>Hola</p>';
    selectIn(document.querySelector('p')!, 0, 4);
    expect(fire('copy', document.querySelector('p')!).defaultPrevented).toBe(false);
    expect(copy).not.toHaveBeenCalled();
  });

  it('is installed by the app wherever copies go through the backend', () => {
    const app = import.meta.glob<string>('../App.tsx', { query: '?raw', import: 'default', eager: true })['../App.tsx'];
    expect(app).toMatch(/clipboard\.throughBackend\(\)\s*\?\s*installCopyGuard\(window, clipboard\.copyText\)/);
  });
});
