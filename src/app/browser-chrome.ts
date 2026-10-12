/**
 * Trino is an app, not a web page (MC-1; David, 11 Oct: "tenemos que evitar
 * que el click derecho de navegador aparezca en todo lado"). Left alone, the
 * webview brings its own menu to a right-click (WebView2: Atrás, Actualizar,
 * Guardar como, Imprimir, Más herramientas) and its own shortcuts: Ctrl + R
 * and F5 reload the app and drop what is on screen, Ctrl + P prints it, and
 * Alt + ← goes back. This guard takes them away and leaves the person's own
 * tools where they type.
 *
 * - **The right-click menu** goes everywhere except in the text fields, where
 *   the native one stays for Cortar, Copiar, Pegar and the spelling
 *   suggestions. The guard listens last, on the window and in the bubble
 *   phase, so a component sees a right-click as it came and can open a menu
 *   of its own; one it already handled (default prevented) is left alone.
 *   A component that stops a right-click on its way also prevents its
 *   default, or the native menu shows.
 * - **The browser's shortcuts** go everywhere, text fields included: reload,
 *   print, save, view source, back and forward, and find in the page. The
 *   guard listens first, in the capture phase, so a component that stops a
 *   key cannot let one through, and it only cancels the browser's action:
 *   the app still hears every key. The app's own shortcuts (Ctrl + K, Ctrl +
 *   L, Ctrl + +, Ctrl + - and Ctrl + 0) and the editing keys (Ctrl + C, V, X,
 *   A, Z and Y) are not the browser's, and pass. So do F12 and Ctrl + Shift +
 *   I: dev builds open the developer tools with them, and release builds
 *   have none.
 *
 * WebView2 has a switch of its own for its shortcuts
 * (`AreBrowserAcceleratorKeysEnabled`), but Tauri 2.11 does not pass wry's
 * option for it, and set later through the webview it only applies from the
 * next navigation, which the app never makes. It would also take F12 from
 * dev builds.
 */

import { isEditableTarget } from '../ui/editable';

export interface BrowserChromeOptions {
  /**
   * Apple's platforms: the browser's shortcuts take Cmd there, while Ctrl and
   * Option edit text (Ctrl + F goes a letter forward, Ctrl + P a line up,
   * Option + ← a word back). By default, from the window's user agent.
   */
  apple?: boolean;
}

/**
 * Keys that are the browser's whatever the modifiers: F5 reloads (Ctrl + F5
 * and Shift + F5 too, without the cache), F3 finds the next match (Shift +
 * F3, the previous one), and the reload, back and forward keys of some
 * keyboards.
 */
const BROWSER_KEYS: ReadonlySet<string> = new Set(['F5', 'F3', 'BrowserRefresh', 'BrowserBack', 'BrowserForward']);

/**
 * The letters the browser takes with Ctrl (Cmd on Apple's platforms): R
 * reloads, P prints, S saves the page, U shows its source, F finds in it and
 * G goes to the next match.
 */
const BROWSER_LETTERS: ReadonlySet<string> = new Set(['r', 'p', 's', 'u', 'f', 'g']);

/**
 * Those it also takes with Shift: R skips the cache, P prints through the
 * system's dialog, G goes to the previous match. Ctrl + Shift + U is left
 * alone: on Linux it starts typing a character by its Unicode code.
 */
const BROWSER_LETTERS_WITH_SHIFT: ReadonlySet<string> = new Set(['r', 'p', 'g']);

/**
 * The letter of a key, as the browser reads it: what the key types on a
 * Latin keyboard, and its place (`KeyR`) on one that types other letters,
 * such as Cyrillic or Greek.
 */
function letterOf(event: KeyboardEvent): string {
  const key = event.key.toLowerCase();
  const place = /^Key([A-Z])$/.exec(event.code);
  const nonAscii = key.length === 1 && key.charCodeAt(0) > 0x7f;
  return place && nonAscii ? place[1].toLowerCase() : key;
}

/** Whether a key is one of the browser's shortcuts, which do nothing useful in Trino. */
function isBrowserShortcut(event: KeyboardEvent, apple: boolean): boolean {
  const { key, ctrlKey, metaKey, altKey, shiftKey } = event;
  if (BROWSER_KEYS.has(key)) return true;
  if (altKey) {
    // Alt + ← and Alt + → go back and forward. Ctrl + Alt is AltGr on
    // Windows, which types characters, and Option + an arrow moves a word.
    return !apple && !ctrlKey && !metaKey && !shiftKey && (key === 'ArrowLeft' || key === 'ArrowRight');
  }
  const command = apple ? metaKey && !ctrlKey : ctrlKey && !metaKey;
  if (!command) return false;
  const letter = letterOf(event);
  return BROWSER_LETTERS.has(letter) && (!shiftKey || BROWSER_LETTERS_WITH_SHIFT.has(letter));
}

/** Apple's platforms by the user agent: a Mac, an iPhone or an iPad. */
const isApple = (userAgent: string) => /Macintosh|iPhone|iPad|iPod/.test(userAgent);

/**
 * Takes the browser's right-click menu and shortcuts away from the window,
 * as described above. Returns a function that gives them back.
 */
export function installBrowserChromeGuard(host: Window, options: BrowserChromeOptions = {}): () => void {
  const apple = options.apple ?? isApple(host.navigator.userAgent);
  const onContextMenu = (event: Event) => {
    if (!event.defaultPrevented && !isEditableTarget(event.target)) event.preventDefault();
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (isBrowserShortcut(event, apple)) event.preventDefault();
  };
  host.addEventListener('contextmenu', onContextMenu);
  host.addEventListener('keydown', onKeyDown, true);
  return () => {
    host.removeEventListener('contextmenu', onContextMenu);
    host.removeEventListener('keydown', onKeyDown, true);
  };
}
