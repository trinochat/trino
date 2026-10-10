// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MessageBubble } from './MessageBubble';

afterEach(cleanup);

const classesOf = (element: Element | null) => (element?.getAttribute('class') ?? '').split(/\s+/);
const bubble = (direction: 'in' | 'out') => document.querySelector(`[data-direction="${direction}"]`);

describe('MessageBubble', () => {
  it('draws incoming messages with the incoming bubble tokens', () => {
    render(<MessageBubble direction="in" text="Hola" time="10:35" />);
    const classes = classesOf(bubble('in'));
    for (const token of ['bg-ui-bubble-in', 'text-ui-bubble-in-ink', 'border', 'border-ui-bubble-in-line', 'rounded-ui-bubble']) {
      expect(classes).toContain(token);
    }
  });

  it('draws your own messages with the bubble-me tokens, which follow the accent', () => {
    render(<MessageBubble direction="out" text="Hola" time="10:31" />);
    const classes = classesOf(bubble('out'));
    for (const token of ['bg-ui-bubble-me', 'text-ui-bubble-me-ink', 'border', 'border-ui-bubble-me-line', 'rounded-ui-bubble']) {
      expect(classes).toContain(token);
    }
  });

  it('lines incoming messages up on the left and yours on the right, at most min(72%, 520px) wide', () => {
    const { container } = render(
      <>
        <MessageBubble direction="in" text="Hola" time="10:35" />
        <MessageBubble direction="out" text="Hola" time="10:36" />
      </>,
    );
    const [incoming, outgoing] = Array.from(container.children);
    expect(classesOf(incoming)).toContain('items-start');
    expect(classesOf(outgoing)).toContain('items-end');
    expect(classesOf(bubble('in'))).toContain('max-w-[min(72%,32.5rem)]');
  });

  it('keeps the line breaks of the text, at 15 px', () => {
    render(<MessageBubble direction="out" text={'Primera línea\nSegunda línea'} time="10:31" />);
    const text = screen.getByText(/Primera línea/);
    expect(text.textContent).toBe('Primera línea\nSegunda línea');
    expect(classesOf(text)).toContain('whitespace-pre-wrap');
    expect(classesOf(text)).toContain('text-ui-base');
  });

  it('shows the sender of an incoming group message in the accent text colour', () => {
    render(<MessageBubble direction="in" sender="Mamá" text="¿Quién trae el pan?" time="08:50" />);
    const sender = screen.getByText('Mamá');
    expect(classesOf(sender)).toContain('text-ui-accent-text');
    expect(classesOf(sender)).toContain('text-ui-sm');
    expect(classesOf(sender)).toContain('font-bold');
  });

  it('never shows a sender on your own messages', () => {
    render(<MessageBubble direction="out" sender="Yo" text="Lo compro" time="08:55" />);
    expect(bubble('out')?.textContent).toContain('Lo compro');
    expect(screen.queryByText('Yo')).toBeNull();
  });

  it('shows the time in the mono font at 12 px, muted to match the bubble', () => {
    render(
      <>
        <MessageBubble direction="in" text="Sí" time="10:35" />
        <MessageBubble direction="out" text="Vale" time="10:38" />
      </>,
    );
    const incomingMeta = classesOf(screen.getByText('10:35').closest('[data-meta]'));
    const outgoingMeta = classesOf(screen.getByText('10:38').closest('[data-meta]'));
    for (const token of ['font-ui-mono', 'text-ui-xs']) {
      expect(incomingMeta).toContain(token);
      expect(outgoingMeta).toContain(token);
    }
    expect(incomingMeta).toContain('text-ui-muted');
    expect(outgoingMeta).toContain('text-ui-bubble-me-muted');
  });

  it.each([
    ['sending', 'Enviando'],
    ['sent', 'Enviado'],
    ['failed', 'No enviado'],
  ] as const)('tells screen readers the %s state', (state, label) => {
    render(<MessageBubble direction="out" text="Hola" time="10:38" status={{ state, label }} />);
    expect(classesOf(screen.getByText(label))).toContain('sr-only');
  });

  it('adds the failure row with the retry slot under a failed message', () => {
    const retry = vi.fn();
    render(
      <MessageBubble
        direction="out"
        text="Te paso la dirección luego"
        time="18:30"
        status={{ state: 'failed', label: 'No enviado' }}
        failure={{
          text: 'No se envió.',
          retry: (
            <button type="button" onClick={retry}>
              Reintentar
            </button>
          ),
        }}
      />,
    );
    const failure = screen.getByText('No se envió.');
    expect(classesOf(failure)).toContain('text-ui-danger');
    expect(bubble('out')?.contains(failure)).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Reintentar' }));
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it('shows no failure row unless the message failed', () => {
    render(
      <MessageBubble
        direction="out"
        text="Hola"
        time="10:38"
        status={{ state: 'sent', label: 'Enviado' }}
        failure={{ text: 'No se envió.' }}
      />,
    );
    expect(screen.getByText('Enviado')).not.toBeNull();
    expect(screen.queryByText('No se envió.')).toBeNull();
  });

  it('renders attachments passed as children inside the bubble', () => {
    render(
      <MessageBubble direction="in" time="10:40">
        <img src="blob:foto" alt="Foto del contrato" />
      </MessageBubble>,
    );
    expect(bubble('in')?.contains(screen.getByRole('img', { name: 'Foto del contrato' }))).toBe(true);
  });
});
