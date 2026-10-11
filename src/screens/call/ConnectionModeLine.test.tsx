// @vitest-environment jsdom
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConnectionModeLine } from './ConnectionModeLine';
import { renderIn } from './test-support';

afterEach(cleanup);

describe('ConnectionModeLine', () => {
  it('says the call is protected after the time, as a button that explains it', () => {
    const { container } = renderIn(
      <p>
        03:21
        <ConnectionModeLine mode="protected" />
      </p>,
    );
    expect(container.textContent).toBe('03:21·Conexión protegida');
    const button = screen.getByRole('button', { name: 'Conexión protegida' });
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('note')).toBeNull();

    fireEvent.click(button);
    expect(button.getAttribute('aria-expanded')).toBe('true');
    const note = screen.getByRole('note');
    expect(button.getAttribute('aria-controls')).toBe(note.id);
    expect(note.textContent).toBe('Tu contacto no ve tu IP. La llamada pasa por un servidor de Cloudflare, que sí la ve.');

    fireEvent.click(button);
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('note')).toBeNull();
  });

  it('says when the call is direct, and that the contact can see the IP', () => {
    renderIn(<ConnectionModeLine mode="direct" />);
    fireEvent.click(screen.getByRole('button', { name: 'Conexión directa' }));
    expect(screen.getByRole('note').textContent).toBe('Tu contacto puede ver tu IP.');
  });

  it('closes the explanation with Escape, keeping the focus and the Escape to itself', () => {
    const onScreenKey = vi.fn();
    renderIn(
      <div onKeyDown={onScreenKey}>
        <ConnectionModeLine mode="protected" />
      </div>,
    );
    const button = screen.getByRole('button', { name: 'Conexión protegida' });
    button.focus();
    fireEvent.click(button);
    fireEvent.keyDown(button, { key: 'Escape' });
    expect(screen.queryByRole('note')).toBeNull();
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(button);
    expect(onScreenKey).not.toHaveBeenCalled();
    // Closed, Escape is the screen's again (it goes back to the chat).
    fireEvent.keyDown(button, { key: 'Escape' });
    expect(onScreenKey).toHaveBeenCalledTimes(1);
  });

  it('shows nothing without a mode', () => {
    const { container } = renderIn(<ConnectionModeLine mode={null} />);
    expect(container.textContent).toBe('');
  });

  it('shows nothing while the call rings (plan-cambios-11oct §6)', () => {
    const { container } = renderIn(<ConnectionModeLine mode="direct" ringing />);
    expect(container.textContent).toBe('');
  });

  it('is plain text with a dotted underline, not a pill', () => {
    renderIn(<ConnectionModeLine mode="direct" />);
    const button = screen.getByRole('button', { name: 'Conexión directa' });
    expect(button.className).toContain('decoration-dotted');
    expect(button.className).not.toMatch(/(?:^|\s)bg-ui-|rounded-full/);
  });
});
