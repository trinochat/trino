// @vitest-environment jsdom
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DirectConsentRequest } from '../../lib/call';
import { DirectCallConsentDialog } from './DirectCallConsentDialog';
import { countingStorage, renderIn } from './test-support';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const OUTGOING: DirectConsentRequest = { peer: 'ana', outgoing: true };
const INCOMING: DirectConsentRequest = { peer: 'ana', outgoing: false };

function show(consent: DirectConsentRequest | null) {
  const onAnswer = vi.fn();
  const view = renderIn(<DirectCallConsentDialog consent={consent} peerName="Ana Torres" onAnswer={onAnswer} />);
  return { ...view, onAnswer };
}

describe('DirectCallConsentDialog', () => {
  describe('when calling', () => {
    it('is an alertdialog named by its title and described by the question', () => {
      show(OUTGOING);
      const dialog = screen.getByRole('alertdialog', {
        name: 'No se pudo proteger la llamada.',
        description: '¿Llamar sin protección? Tu contacto verá desde dónde te conectas.',
      });
      expect(dialog.getAttribute('aria-modal')).toBe('true');
    });

    // Card 12: Cancelar is the main button; going without protection is not.
    it('draws Cancelar as the main button and "Llamar" as a plain one', () => {
      show(OUTGOING);
      expect(screen.getByRole('button', { name: 'Cancelar' }).className).toContain('bg-ui-accent');
      expect(screen.getByRole('button', { name: 'Llamar' }).className).not.toContain('bg-ui-accent');
      expect(screen.getByRole('button', { name: 'Llamar' }).className).not.toContain('bg-ui-danger');
    });

    it('focuses Cancel, the safe answer, and gives false on Escape', () => {
      const { onAnswer } = show(OUTGOING);
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Cancelar' }));
      fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
      expect(onAnswer.mock.calls).toEqual([[false]]);
    });

    it('gives false on Cancel and true only on "Llamar"', () => {
      const { onAnswer, unmount } = show(OUTGOING);
      fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }));
      expect(onAnswer.mock.calls).toEqual([[false]]);
      unmount();
      const second = show(OUTGOING);
      fireEvent.click(screen.getByRole('button', { name: 'Llamar' }));
      expect(second.onAnswer.mock.calls).toEqual([[true]]);
    });
  });

  describe('when answering', () => {
    it('names who would see the IP, and focuses "No contestar"', () => {
      const { onAnswer } = show(INCOMING);
      screen.getByRole('alertdialog', {
        name: 'No se pudo proteger la llamada.',
        description: '¿Contestar sin protección? Ana Torres verá desde dónde te conectas.',
      });
      const decline = screen.getByRole('button', { name: 'No contestar' });
      expect(document.activeElement).toBe(decline);
      fireEvent.click(decline);
      expect(onAnswer.mock.calls).toEqual([[false]]);
    });

    it('gives true only on "Contestar"', () => {
      const { onAnswer } = show(INCOMING);
      fireEvent.click(screen.getByRole('button', { name: 'Contestar' }));
      expect(onAnswer.mock.calls).toEqual([[true]]);
    });
  });

  it('shows nothing without a question', () => {
    show(null);
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('closes when the question goes away, so a late click does nothing', () => {
    const { onAnswer, rerender } = show(OUTGOING);
    const confirm = screen.getByRole('button', { name: 'Llamar' });
    rerender(<DirectCallConsentDialog consent={null} peerName="Ana Torres" onAnswer={onAnswer} />);
    expect(screen.queryByRole('alertdialog')).toBeNull();
    fireEvent.click(confirm);
    expect(onAnswer).not.toHaveBeenCalled();
  });

  it('answers once: a second click on the same question does nothing', () => {
    const { onAnswer } = show(OUTGOING);
    const confirm = screen.getByRole('button', { name: 'Llamar' });
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }));
    expect(onAnswer.mock.calls).toEqual([[true]]);
  });

  it('asks again for a new question', () => {
    const { onAnswer, rerender } = show(OUTGOING);
    fireEvent.click(screen.getByRole('button', { name: 'Llamar' }));
    rerender(<DirectCallConsentDialog consent={null} peerName="Ana Torres" onAnswer={onAnswer} />);
    rerender(<DirectCallConsentDialog consent={{ ...OUTGOING }} peerName="Ana Torres" onAnswer={onAnswer} />);
    fireEvent.click(screen.getByRole('button', { name: 'Llamar' }));
    expect(onAnswer.mock.calls).toEqual([[true], [true]]);
  });

  // Asked on every call and never remembered (docs/llamadas-turn.md).
  it('neither reads nor writes a preference', () => {
    const { storage, accesses } = countingStorage();
    vi.stubGlobal('localStorage', storage);
    const { onAnswer } = show(OUTGOING);
    fireEvent.click(screen.getByRole('button', { name: 'Llamar' }));
    expect(onAnswer).toHaveBeenCalledWith(true);
    expect(accesses).toEqual([]);
  });

  it('speaks the language of the app', () => {
    const onAnswer = vi.fn();
    renderIn(<DirectCallConsentDialog consent={INCOMING} peerName="Ana" onAnswer={onAnswer} />, 'en');
    screen.getByRole('alertdialog', {
      name: 'The call could not be protected.',
      description: 'Answer without protection? Ana will see where you connect from.',
    });
    screen.getByRole('button', { name: 'Don’t answer' });
  });
});
