// @vitest-environment jsdom
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IncomingCallDialog, type IncomingCallDialogProps } from './IncomingCallDialog';
import { renderIn } from './test-support';

afterEach(cleanup);

function ring(props: Partial<IncomingCallDialogProps> = {}) {
  const onAnswer = vi.fn();
  const onDecline = vi.fn();
  const view = renderIn(
    <IncomingCallDialog
      open
      name="Ana Torres"
      avatar={null}
      video={false}
      verified={false}
      onAnswer={onAnswer}
      onDecline={onDecline}
      {...props}
    />,
  );
  return { ...view, onAnswer, onDecline };
}

describe('IncomingCallDialog', () => {
  it('names who calls and says it is a call, in an alertdialog', () => {
    ring();
    const dialog = screen.getByRole('alertdialog', { name: 'Ana Torres', description: 'Llamada entrante' });
    expect(dialog.getAttribute('aria-modal')).toBe('true');
  });

  it('answers a voice call, or declines it', () => {
    const { onAnswer, onDecline } = ring();
    expect(screen.getAllByRole('button').map(button => button.textContent)).toEqual(['Contestar', 'Rechazar']);
    fireEvent.click(screen.getByRole('button', { name: 'Contestar' }));
    expect(onAnswer.mock.calls).toEqual([[{ video: false }]]);
    fireEvent.click(screen.getByRole('button', { name: 'Rechazar' }));
    expect(onDecline).toHaveBeenCalledTimes(1);
  });

  it('answers a video call with video, or with audio only (Call:74-76)', () => {
    const { onAnswer } = ring({ video: true });
    screen.getByRole('alertdialog', { name: 'Ana Torres', description: 'Videollamada entrante' });
    expect(screen.getAllByRole('button').map(button => button.textContent)).toEqual([
      'Contestar con video',
      'Contestar solo con audio',
      'Rechazar',
    ]);
    fireEvent.click(screen.getByRole('button', { name: 'Contestar con video' }));
    fireEvent.click(screen.getByRole('button', { name: 'Contestar solo con audio' }));
    expect(onAnswer.mock.calls).toEqual([[{ video: true }], [{ video: false }]]);
  });

  it('says the contact is verified only when it is', () => {
    const { unmount } = ring();
    expect(screen.queryByText('Contacto verificado')).toBeNull();
    unmount();
    ring({ verified: true });
    expect(screen.getByText('Contacto verificado')).toBeTruthy();
  });

  // With TURN the contact never sees the IP: the old "Si contestas, Ana verá tu IP" would be false.
  it('says nothing about the IP', () => {
    ring({ video: true, verified: true });
    expect(screen.getByRole('alertdialog').textContent).not.toMatch(/\bIP\b/);
  });

  it('keeps the keys typed in a chat from answering or declining it', () => {
    const { onAnswer, onDecline } = ring();
    expect(document.activeElement?.tagName).not.toBe('BUTTON');
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    fireEvent.keyDown(document.activeElement!, { key: 'Enter' });
    expect(onAnswer).not.toHaveBeenCalled();
    expect(onDecline).not.toHaveBeenCalled();
    expect(screen.getByRole('alertdialog')).toBeTruthy();
  });

  it('shows nothing while no call rings', () => {
    ring({ open: false });
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });
});
