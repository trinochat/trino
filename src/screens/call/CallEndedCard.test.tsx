// @vitest-environment jsdom
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CallEndedCard } from './CallEndedCard';
import { renderIn } from './test-support';
import type { CallEndCard } from './useCallController';

afterEach(cleanup);

const CARD: CallEndCard = {
  callId: 'c'.repeat(32),
  peer: 'ana',
  name: 'Ana Torres',
  avatar: null,
  reason: 'ended',
  durationSec: 201,
  video: false,
  logged: false,
};

function show(card: CallEndCard | null) {
  const onCallAgain = vi.fn();
  const onClose = vi.fn();
  const view = renderIn(<CallEndedCard card={card} onCallAgain={onCallAgain} onClose={onClose} />);
  return { ...view, onCallAgain, onClose };
}

describe('CallEndedCard', () => {
  it('ends with who, how long, and that the microphone and camera are off (Call:166-177)', () => {
    show(CARD);
    const dialog = screen.getByRole('dialog', { name: 'Llamada finalizada' });
    expect(dialog.textContent).toContain('Ana Torres · 03:21');
    expect(dialog.textContent).toContain('El micrófono y la cámara ya están apagados.');
  });

  it('says the call stays in the chat only once it is recorded', () => {
    const { unmount } = show(CARD);
    expect(screen.getByRole('dialog').textContent).not.toContain('registrada');
    unmount();
    show({ ...CARD, logged: true });
    expect(screen.getByRole('dialog').textContent).toContain('Queda registrada en el chat.');
  });

  it('shows the name alone for a call that never connected', () => {
    show({ ...CARD, reason: 'rejected', durationSec: null });
    const dialog = screen.getByRole('dialog', { name: 'Llamada rechazada' });
    expect(dialog.textContent).toContain('Ana Torres');
    expect(dialog.textContent).not.toContain('·');
  });

  it.each([
    ['no-answer', 'No contestó'],
    ['connection', 'Se perdió la conexión'],
    ['microphone', 'No se encontró un micrófono'],
    ['signal', 'No se pudo hacer la llamada'],
  ] as const)('names the reason %s', (reason, title) => {
    show({ ...CARD, reason, durationSec: null });
    expect(screen.getByRole('dialog', { name: title })).toBeTruthy();
  });

  it('tells how to give Trino the microphone back', () => {
    show({ ...CARD, reason: 'permission', durationSec: null });
    const dialog = screen.getByRole('dialog', { name: 'Trino no puede usar el micrófono' });
    expect(dialog.textContent).toContain('Revisa el permiso del micrófono en la configuración del sistema.');
  });

  // The DTLS fingerprint rule (docs/sas-v2.md): told plainly, as an alert.
  it('says the call ended because the key of the connection changed', () => {
    show({ ...CARD, reason: 'security', logged: true });
    const dialog = screen.getByRole('alertdialog', {
      name: 'Cambió la clave de la conexión',
      description:
        'La llamada terminó porque cambió la clave de la conexión. Vuelve a llamar y comparen los símbolos otra vez.',
    });
    expect(dialog).toBeTruthy();
  });

  it('calls again, or closes from "Cerrar", which has the focus, and from Escape', () => {
    const { onCallAgain, onClose } = show(CARD);
    const close = screen.getByRole('button', { name: 'Cerrar' });
    expect(document.activeElement).toBe(close);
    fireEvent.click(screen.getByRole('button', { name: 'Volver a llamar' }));
    expect(onCallAgain).toHaveBeenCalledTimes(1);
    fireEvent.click(close);
    fireEvent.keyDown(close, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('shows nothing without a call that ended', () => {
    show(null);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });
});
