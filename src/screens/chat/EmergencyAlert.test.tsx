// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { ChatHeaderInfo, ChatPaneProps } from '../types';
import { ChatPane } from './ChatPane';
import { at, message, renderIn } from './test-utils';

const ANA: ChatHeaderInfo = { kind: 'contact', name: 'Ana Torres', trust: 'verified', ttlSeconds: 0, blocked: false };
const NOW = at(2026, 10, 17, 18, 0);

afterEach(cleanup);

function props(overrides: Partial<ChatPaneProps> = {}): ChatPaneProps {
  return {
    convo: { kind: 'contact', handle: 'Ana Torres' },
    header: ANA,
    messages: [message('k1', at(2026, 10, 17, 9, 0), { text: '¿Mañana a las 3 en la biblioteca?' })],
    now: NOW,
    maxTextLength: 4000,
    draft: '',
    onDraftChange: vi.fn(),
    onSendText: vi.fn(),
    onRetry: vi.fn(),
    onSendFiles: vi.fn(async () => ({ failed: [] })),
    onSendSticker: vi.fn(async () => {}),
    onForward: vi.fn(),
    onOpenLink: vi.fn(),
    onOpenDetails: vi.fn(),
    fetchFile: vi.fn(async () => ''),
    stickers: { list: vi.fn(async () => []), importFile: vi.fn(), remove: vi.fn() },
    ...overrides,
  };
}

// The trusted contact's side (CE-6, design §7.2 and §11.6; PropClaveEmergencia
// cards 9 and 10).
describe('the warning to a trusted contact, in the chat', () => {
  it('shows neither the question nor the strip without them', () => {
    renderIn(<ChatPane {...props()} />);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByRole('note')).toBeNull();
  });

  it('asks over the chat, with two buttons alike, and says it was accepted', async () => {
    const onEmergencyAnswer = vi.fn(async () => {});
    const { rerender } = renderIn(<ChatPane {...props({ onEmergencyAnswer })} />);
    const dialog = screen.getByRole('dialog', { name: 'Contacto de confianza' });
    expect(dialog.textContent).toContain(
      'Ana Torres quiere avisarte si alguna vez usa su clave de emergencia. Si aceptas, Trino te mostrará un aviso en este chat. ¿Aceptas?',
    );
    expect(dialog.textContent).toContain('Si aceptas, sabrás que Ana Torres tiene una clave de emergencia. Quien revise tu equipo también podría saberlo.');
    const no = within(dialog).getByRole('button', { name: 'No, gracias' });
    const yes = within(dialog).getByRole('button', { name: 'Aceptar' });
    expect(yes.className).toBe(no.className);
    // The question is no message of the chat.
    expect(document.querySelectorAll('[data-message]')).toHaveLength(1);

    fireEvent.click(yes);
    await waitFor(() => expect(onEmergencyAnswer).toHaveBeenCalledWith(true));
    // Answered, the chats no longer bring the question.
    rerender(<ChatPane {...props()} />);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(await screen.findByText('Aceptaste. Si Ana Torres usa su clave de emergencia, verás un aviso en este chat.')).toBeTruthy();
    expect(document.querySelectorAll('[data-message]')).toHaveLength(1);
  });

  it('declines with "No, gracias", and says nothing after', async () => {
    const onEmergencyAnswer = vi.fn(async () => {});
    renderIn(<ChatPane {...props({ onEmergencyAnswer })} />);
    fireEvent.click(screen.getByRole('button', { name: 'No, gracias' }));
    await waitFor(() => expect(onEmergencyAnswer).toHaveBeenCalledWith(false));
    expect(screen.queryByText(/^Aceptaste/)).toBeNull();
  });

  it('stays with an error when the answer could not go', async () => {
    const onEmergencyAnswer = vi.fn(async () => Promise.reject(new Error('offline')));
    renderIn(<ChatPane {...props({ onEmergencyAnswer })} />);
    fireEvent.click(screen.getByRole('button', { name: 'Aceptar' }));
    const dialog = screen.getByRole('dialog');
    expect((await within(dialog).findByRole('alert')).textContent).toBe('No se pudo enviar tu respuesta. Inténtalo de nuevo.');
  });

  it('shows the strip of a warning that came, its message, and what you can do', () => {
    renderIn(
      <ChatPane
        {...props({ emergencyWarning: { at: at(2026, 10, 17, 10, 42), sent: null, message: 'Si no te escribo en dos días, ya sabes qué hacer.' } })}
      />,
    );
    const strip = screen.getByRole('note');
    expect(strip.textContent).toContain(
      'Ana Torres usó su clave de emergencia en uno de sus equipos. El aviso llegó el 17 de octubre a las 10:42.',
    );
    expect(strip.textContent).toContain('«Si no te escribo en dos días, ya sabes qué hacer.»');
    const what = within(strip).getByRole('button', { name: 'Qué puedes hacer' });
    expect(what.getAttribute('aria-expanded')).toBe('false');
    expect(strip.textContent).not.toMatch(/falso/);
    fireEvent.click(what);
    expect(what.getAttribute('aria-expanded')).toBe('true');
    expect(strip.textContent).toContain('Un aviso también puede ser falso: si puedes, confírmalo por otro medio.');
  });

  // CE-D15: with seven days of mailboxes the warning can come days after
  // it was sent, so the strip says both: when it was sent (the hour the
  // warning carries) and when it came.
  it('says when the warning was sent and when it came, on another day', () => {
    renderIn(
      <ChatPane {...props({ emergencyWarning: { at: at(2026, 10, 19, 8, 15), sent: at(2026, 10, 17, 10, 42), message: '' } })} />,
    );
    expect(screen.getByRole('note').textContent).toContain(
      'Ana Torres usó su clave de emergencia en uno de sus equipos. El aviso se envió el 17 de octubre a las 10:42 y llegó el 19 de octubre a las 08:15.',
    );
  });

  it('names the day once when it was sent and came the same day', () => {
    renderIn(
      <ChatPane {...props({ emergencyWarning: { at: at(2026, 10, 17, 10, 43), sent: at(2026, 10, 17, 10, 42), message: '' } })} />,
    );
    expect(screen.getByRole('note').textContent).toContain(
      'Ana Torres usó su clave de emergencia en uno de sus equipos. El aviso se envió el 17 de octubre a las 10:42 y llegó a las 10:43.',
    );
  });

  it('says only when it came for a warning kept without its hour of sending', () => {
    renderIn(<ChatPane {...props({ emergencyWarning: { at: at(2026, 10, 17, 10, 42), sent: null, message: '' } })} />);
    expect(screen.getByRole('note').textContent).toContain('El aviso llegó el 17 de octubre a las 10:42.');
    expect(screen.getByRole('note').textContent).not.toContain('se envió');
  });

  it('leaves the quote out of a warning with no message', () => {
    renderIn(<ChatPane {...props({ emergencyWarning: { at: at(2026, 10, 17, 10, 42), sent: null, message: '' } })} />);
    expect(screen.getByRole('note').textContent).not.toContain('«');
  });
});
