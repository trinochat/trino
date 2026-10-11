// @vitest-environment jsdom
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EndCallConfirmDialog } from './EndCallConfirmDialog';
import { renderIn } from './test-support';
import type { EndConfirmReason } from './useCallController';

afterEach(cleanup);

function ask(reason: EndConfirmReason | null) {
  const onAnswer = vi.fn();
  const view = renderIn(<EndCallConfirmDialog reason={reason} onAnswer={onAnswer} />);
  return { ...view, onAnswer };
}

describe('EndCallConfirmDialog', () => {
  it('asks before locking, with Cancel focused and on Escape', () => {
    const { onAnswer } = ask('lock');
    screen.getByRole('alertdialog', {
      name: 'Hay una llamada en curso',
      description: 'Bloquear Trino cuelga la llamada y apaga el micrófono y la cámara.',
    });
    const cancel = screen.getByRole('button', { name: 'Cancelar' });
    expect(document.activeElement).toBe(cancel);
    fireEvent.keyDown(cancel, { key: 'Escape' });
    expect(onAnswer.mock.calls).toEqual([[false]]);
  });

  it('hangs up and locks only from its own button, which carries an icon', () => {
    const { onAnswer } = ask('lock');
    const confirm = screen.getByRole('button', { name: 'Colgar y bloquear' });
    expect(confirm.querySelector('svg')).not.toBeNull();
    fireEvent.click(confirm);
    expect(onAnswer.mock.calls).toEqual([[true]]);
  });

  it('asks before closing the window', () => {
    const { onAnswer } = ask('close');
    screen.getByRole('alertdialog', {
      name: 'Hay una llamada en curso',
      description: 'Cerrar la ventana cuelga la llamada y apaga el micrófono y la cámara.',
    });
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }));
    fireEvent.click(screen.getByRole('button', { name: 'Colgar y cerrar' }));
    expect(onAnswer.mock.calls).toEqual([[false], [true]]);
  });

  it('shows nothing when nothing asks', () => {
    ask(null);
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });
});
