import { describe, expect, it } from 'vitest';
import { composerKeyAction } from './composer-keys';

const key = (name: string, shiftKey = false, isComposing = false) => ({ key: name, shiftKey, isComposing });

describe('composerKeyAction', () => {
  it('sends on Enter', () => {
    expect(composerKeyAction(key('Enter'))).toBe('send');
  });

  it('breaks the line on Shift+Enter', () => {
    expect(composerKeyAction(key('Enter', true))).toBe('newline');
  });

  // An IME (Japanese, Chinese, Korean, some Windows keyboards) uses Enter to
  // accept the word it is composing: that Enter is not for the composer.
  it('does nothing while an input method is composing, Enter included', () => {
    expect(composerKeyAction(key('Enter', false, true))).toBe('none');
    expect(composerKeyAction(key('Enter', true, true))).toBe('none');
    expect(composerKeyAction(key('Process', false, true))).toBe('none');
  });

  it('leaves every other key to the text box', () => {
    for (const name of ['a', ' ', 'Escape', 'Tab', 'ArrowUp', 'Backspace']) {
      expect(composerKeyAction(key(name)), name).toBe('none');
      expect(composerKeyAction(key(name, true)), `Shift+${name}`).toBe('none');
    }
  });
});
