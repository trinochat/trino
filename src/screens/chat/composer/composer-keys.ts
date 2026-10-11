/**
 * What a key press in the composer does: Enter sends, Shift+Enter breaks the
 * line (the text box does it itself), and anything else is left to the text
 * box. While an input method composes a word, its Enter belongs to it.
 */
export type ComposerKeyAction = 'send' | 'newline' | 'none';

export function composerKeyAction(e: { key: string; shiftKey: boolean; isComposing: boolean }): ComposerKeyAction {
  if (e.isComposing || e.key !== 'Enter') return 'none';
  return e.shiftKey ? 'newline' : 'send';
}
