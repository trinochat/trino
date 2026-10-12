// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installBrowserChromeGuard } from './browser-chrome';

// MC-1 (David, 11 Oct): "tenemos que evitar que el click derecho de navegador
// aparezca en todo lado". The webview's own menu (Atrás, Actualizar, Guardar
// como, Imprimir, Más herramientas) and its shortcuts (reload, print, find…)
// are not Trino's. The guard runs on jsdom's real window, so the capture and
// bubble phases below are the browser's own.

/** Puts an element in the page and returns it, or the part of it `selector` names. */
function add(html: string, selector?: string): HTMLElement {
  const holder = document.createElement('div');
  holder.innerHTML = html;
  const element = holder.firstElementChild as HTMLElement;
  document.body.append(element);
  return selector ? (element.querySelector(selector) as HTMLElement) : element;
}

const contextMenu = () => new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 });

/** Right-clicks a node: whether a listener cancelled the native menu. */
const rightClick = (target: EventTarget, event = contextMenu()) => !target.dispatchEvent(event);

/** Presses a key on a node: whether a listener cancelled what the browser does with it. */
const press = (target: EventTarget, init: KeyboardEventInit) =>
  !target.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));

let stop: () => void;
beforeEach(() => {
  stop = installBrowserChromeGuard(window);
});
afterEach(() => {
  stop();
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe('the right-click menu', () => {
  it('goes away outside the text fields', () => {
    expect(rightClick(add('<p>Hola, Ana</p>'))).toBe(true);
    expect(rightClick(add('<button type="button">Enviar</button>'))).toBe(true);
    expect(rightClick(document.body)).toBe(true);
  });

  // The native menu there cuts, copies, pastes and suggests spellings.
  it.each([
    ['a text field', '<input aria-label="Nombre">'],
    ['a password field', '<input type="password" aria-label="Contraseña">'],
    ['a search box', '<input type="search" aria-label="Buscar">'],
    ['a number field', '<input type="number" aria-label="Minutos">'],
    ['a text area', '<textarea aria-label="Mensaje"></textarea>'],
    ['editable content', '<div contenteditable="true">Hola</div>'],
    ['what is inside editable content', '<div contenteditable="true"><b>Hola</b></div>', 'b'],
  ])('stays in %s', (_where, html, selector?: string) => {
    expect(rightClick(add(html, selector))).toBe(false);
  });

  // Nothing to type there: the native menu would be the page's.
  it.each([
    ['a read-only field', '<input readonly value="trino2:abc" aria-label="Tu código">'],
    ['a disabled text area', '<textarea disabled aria-label="Mensaje"></textarea>'],
    ['a field of a disabled group', '<fieldset disabled><input aria-label="Nombre"></fieldset>', 'input'],
    ['a checkbox', '<input type="checkbox" aria-label="Tengo 18 años o más">'],
    ['a part made not editable', '<div contenteditable="true"><span contenteditable="false">Ana</span></div>', 'span'],
  ])('goes away on %s', (_where, html, selector?: string) => {
    expect(rightClick(add(html, selector))).toBe(true);
  });

  // The guard listens last, on the window: a component sees the right-click
  // as it came, and can open a menu of its own.
  it('lets a component see the right-click first, untouched', () => {
    const row = add('<div>Ana</div>');
    const seen: boolean[] = [];
    row.addEventListener('contextmenu', event => seen.push(event.defaultPrevented));
    rightClick(row);
    expect(seen).toEqual([false]);
  });

  // A component's own menu cancels the native one, as the old chat's bubble
  // did and MC-2's menus will; such a menu closes on the next right-click
  // anywhere, so the event travels on.
  it('leaves alone a right-click a component already handled', () => {
    const bubble = add('<div>Hola</div>');
    bubble.addEventListener('contextmenu', event => event.preventDefault());
    const event = contextMenu();
    const preventDefault = vi.spyOn(event, 'preventDefault');
    const later = vi.fn();
    window.addEventListener('contextmenu', later);
    try {
      expect(rightClick(bubble, event)).toBe(true);
      expect(preventDefault).toHaveBeenCalledTimes(1);
      expect(later).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener('contextmenu', later);
    }
  });
});

describe('the browser shortcuts', () => {
  it.each([
    ['F5 (reload)', { key: 'F5' }],
    ['Ctrl + F5', { key: 'F5', ctrlKey: true }],
    ['Shift + F5', { key: 'F5', shiftKey: true }],
    ['the reload key', { key: 'BrowserRefresh' }],
    ['Ctrl + R', { key: 'r', ctrlKey: true }],
    ['Ctrl + Shift + R', { key: 'R', ctrlKey: true, shiftKey: true }],
    ['Ctrl + R with Caps Lock on', { key: 'R', ctrlKey: true }],
    // Like the browser, by the key's place where the keyboard is not Latin.
    ['Ctrl + R on a Russian keyboard', { key: 'к', code: 'KeyR', ctrlKey: true }],
    ['Ctrl + P (print)', { key: 'p', ctrlKey: true }],
    ['Ctrl + Shift + P', { key: 'P', ctrlKey: true, shiftKey: true }],
    ['Ctrl + S (save)', { key: 's', ctrlKey: true }],
    ['Ctrl + U (view source)', { key: 'u', ctrlKey: true }],
    ['Alt + ← (back)', { key: 'ArrowLeft', altKey: true }],
    ['Alt + → (forward)', { key: 'ArrowRight', altKey: true }],
    ['the back key', { key: 'BrowserBack' }],
    ['the forward key', { key: 'BrowserForward' }],
    ['Ctrl + F (find in the page)', { key: 'f', ctrlKey: true }],
    ['F3 (next match)', { key: 'F3' }],
    ['Shift + F3', { key: 'F3', shiftKey: true }],
    ['Ctrl + G', { key: 'g', ctrlKey: true }],
    ['Ctrl + Shift + G', { key: 'G', ctrlKey: true, shiftKey: true }],
  ] as const)('%s does nothing, in a text field too', (_shortcut, init) => {
    expect(press(add('<p>Hola</p>'), init)).toBe(true);
    expect(press(add('<textarea aria-label="Mensaje"></textarea>'), init)).toBe(true);
  });

  it.each([
    ['Ctrl + K (search)', { key: 'k', ctrlKey: true }],
    ['Ctrl + L (lock)', { key: 'l', ctrlKey: true }],
    ['Ctrl + + (larger text)', { key: '+', ctrlKey: true }],
    ['Ctrl + = (larger text)', { key: '=', ctrlKey: true }],
    ['Ctrl + - (smaller text)', { key: '-', ctrlKey: true }],
    ["Ctrl + 0 (the system's text size)", { key: '0', ctrlKey: true }],
    ['Ctrl + C', { key: 'c', ctrlKey: true }],
    ['Ctrl + V', { key: 'v', ctrlKey: true }],
    ['Ctrl + X', { key: 'x', ctrlKey: true }],
    ['Ctrl + A', { key: 'a', ctrlKey: true }],
    ['Ctrl + Z', { key: 'z', ctrlKey: true }],
    ['Ctrl + Y', { key: 'y', ctrlKey: true }],
    ['Ctrl + Shift + Z', { key: 'Z', ctrlKey: true, shiftKey: true }],
    // Dev builds open the developer tools with these; release builds have none.
    ['F12', { key: 'F12' }],
    ['Ctrl + Shift + I', { key: 'I', ctrlKey: true, shiftKey: true }],
    ['r, typed', { key: 'r' }],
    ['Shift + R, typed', { key: 'R', shiftKey: true }],
    // Ctrl + Alt is AltGr on Windows, which types characters.
    ['AltGr + Q, which types @', { key: '@', ctrlKey: true, altKey: true }],
    ['AltGr + R', { key: 'r', ctrlKey: true, altKey: true }],
    ['←', { key: 'ArrowLeft' }],
    ['Ctrl + ← (a word back)', { key: 'ArrowLeft', ctrlKey: true }],
    ['Shift + ← (select)', { key: 'ArrowLeft', shiftKey: true }],
    // On Linux it starts typing a character by its Unicode code.
    ['Ctrl + Shift + U', { key: 'U', ctrlKey: true, shiftKey: true }],
  ] as const)('%s still works', (_shortcut, init) => {
    expect(press(add('<textarea aria-label="Mensaje"></textarea>'), init)).toBe(false);
  });

  // The guard listens first, in the capture phase.
  it('cancels a shortcut that a component stops on its way', () => {
    const field = add('<input aria-label="Buscar">');
    field.addEventListener('keydown', event => event.stopPropagation());
    expect(press(field, { key: 'F5' })).toBe(true);
    expect(press(field, { key: 'r', ctrlKey: true })).toBe(true);
  });

  // It cancels the browser's action and nothing else: the app still hears the
  // key, and the auto-lock counts it as activity.
  it('lets the app hear every key', () => {
    const heard = vi.fn();
    window.addEventListener('keydown', heard);
    try {
      press(document.body, { key: 'r', ctrlKey: true });
      press(document.body, { key: 'k', ctrlKey: true });
      expect(heard).toHaveBeenCalledTimes(2);
    } finally {
      window.removeEventListener('keydown', heard);
    }
  });
});

// The browser's shortcuts take Cmd there, while Ctrl and Option edit text:
// Ctrl + F goes a letter forward, Ctrl + P a line up, Option + ← a word back.
describe("on Apple's platforms", () => {
  const MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)';

  it('takes the shortcuts with Cmd', () => {
    stop();
    stop = installBrowserChromeGuard(window, { apple: true });
    expect(press(document.body, { key: 'r', metaKey: true })).toBe(true);
    expect(press(document.body, { key: 'p', metaKey: true })).toBe(true);
    expect(press(document.body, { key: 'f', metaKey: true })).toBe(true);
  });

  it('leaves Ctrl and Option to the text, and the inspector alone', () => {
    stop();
    stop = installBrowserChromeGuard(window, { apple: true });
    const field = add('<textarea aria-label="Mensaje"></textarea>');
    expect(press(field, { key: 'f', ctrlKey: true })).toBe(false);
    expect(press(field, { key: 'p', ctrlKey: true })).toBe(false);
    expect(press(field, { key: 'ArrowLeft', altKey: true })).toBe(false);
    expect(press(field, { key: 'i', metaKey: true, altKey: true })).toBe(false);
  });

  it('tells the platform from the window', () => {
    stop();
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(MAC);
    stop = installBrowserChromeGuard(window);
    expect(press(document.body, { key: 'r', metaKey: true })).toBe(true);
    expect(press(document.body, { key: 'f', ctrlKey: true })).toBe(false);
  });
});

describe('stopping', () => {
  it('gives the menu and the shortcuts back', () => {
    stop();
    expect(rightClick(add('<p>Hola</p>'))).toBe(false);
    expect(press(document.body, { key: 'F5' })).toBe(false);
    expect(press(document.body, { key: 'r', ctrlKey: true })).toBe(false);
  });
});
