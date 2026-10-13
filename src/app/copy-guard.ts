/**
 * Ctrl + C, Ctrl + X and the text fields' own Copiar and Cortar, without the
 * clipboard history (cifrado local CL-6b, design §8 and test 46).
 *
 * The webview copies on its own, and Windows keeps what it copies in the
 * clipboard history (Win + V) and may send it to your other devices. So on
 * Windows the app takes every copy and cut: this guard cancels the
 * webview's and hands the selected text to `copy`, the backend's copy with
 * the marks that keep it out of the history (src/lib/clipboard.ts).
 *
 * - **What is copied:** the selection in a text field, or else the page's
 *   selection, such as part of a message. With nothing selected, the copy is
 *   left to the webview, which copies nothing.
 * - **Cut** removes the selection from a field that can be written, as the
 *   webview would, and tells the field it changed. Out of a field, or from
 *   one that is read-only, a cut takes nothing out.
 * - **Passwords** are never copied: the webview refuses, and so does this.
 * - **A copy a component already took** (its default prevented) is left
 *   alone. The guard listens on the window in the bubble phase, last.
 *
 * Dragging text into another program does not go through the clipboard.
 */
import { isEditableTarget } from '../ui/editable';

type TextField = HTMLInputElement | HTMLTextAreaElement;

function isTextField(target: EventTarget | null): target is TextField {
  return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement;
}

/** The text selected in a field, or '' where the field has no selection (a number field). */
function selectedIn(field: TextField): { text: string; start: number; end: number } {
  try {
    const start = field.selectionStart ?? 0;
    const end = field.selectionEnd ?? 0;
    return { text: field.value.slice(start, end), start, end };
  } catch {
    return { text: '', start: 0, end: 0 };
  }
}

/** Takes the cut text out of the field, as the webview would, with an input event. */
function removeSelection(field: TextField, start: number, end: number): void {
  // The webview's own delete keeps Ctrl + Z; a document without it (tests) edits the value.
  const deleted =
    typeof document.execCommand === 'function' && document.activeElement === field && document.execCommand('delete');
  if (deleted) return;
  field.setRangeText('', start, end, 'end');
  field.dispatchEvent(new Event('input', { bubbles: true }));
}

/**
 * Takes the window's copies and cuts, as described above, and copies their
 * text with `copy`. Returns a function that gives them back to the webview.
 */
export function installCopyGuard(host: Window, copy: (text: string) => Promise<void>): () => void {
  const onCopyOrCut = (event: Event) => {
    if (event.defaultPrevented) return;
    const cut = event.type === 'cut';
    const target = event.target;
    let text: string;
    let field: { element: TextField; start: number; end: number } | null = null;
    if (isTextField(target)) {
      if (target instanceof HTMLInputElement && target.type === 'password') return;
      const selected = selectedIn(target);
      text = selected.text;
      if (cut && isEditableTarget(target)) field = { element: target, start: selected.start, end: selected.end };
    } else {
      if (cut) return;
      text = host.getSelection()?.toString() ?? '';
    }
    if (!text) return;
    event.preventDefault();
    copy(text).catch(() => console.warn('copying through the backend failed'));
    if (field) removeSelection(field.element, field.start, field.end);
  };
  host.addEventListener('copy', onCopyOrCut);
  host.addEventListener('cut', onCopyOrCut);
  return () => {
    host.removeEventListener('copy', onCopyOrCut);
    host.removeEventListener('cut', onCopyOrCut);
  };
}
