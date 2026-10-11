// @vitest-environment jsdom
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CallBar, type CallBarProps } from './CallBar';
import { renderIn } from './test-support';

afterEach(cleanup);

function bar(props: Partial<CallBarProps> = {}) {
  const handlers = { onToggleMute: vi.fn(), onHangUp: vi.fn(), onReturn: vi.fn() };
  renderIn(<CallBar peerName="Ana Torres" connectedAt={1_000} now={202_000} muted={false} {...handlers} {...props} />);
  return handlers;
}

describe('CallBar', () => {
  it('is the region "Llamada en curso", with who and how long (Main:43-66)', () => {
    bar();
    const region = screen.getByRole('region', { name: 'Llamada en curso' });
    expect(region.textContent).toContain('En llamada con Ana Torres · 03:21');
  });

  it('says it is calling or connecting until the call connects', () => {
    bar({ connectedAt: null, ringing: true });
    expect(screen.getByRole('region').textContent).toContain('Llamando…');
    cleanup();
    bar({ connectedAt: null });
    expect(screen.getByRole('region').textContent).toContain('Conectando…');
  });

  it('mutes with a 44 px toggle whose icon shows the state', () => {
    const { onToggleMute } = bar();
    const mute = screen.getByRole('button', { name: 'Silenciar micrófono' });
    expect(mute.getAttribute('aria-pressed')).toBe('false');
    expect(mute.className).toMatch(/(?:^|\s)h-11(?:\s|$)/);
    expect(mute.className).toMatch(/(?:^|\s)w-11(?:\s|$)/);
    expect(mute.querySelector('svg')!.getAttribute('class')).toContain('lucide-mic ');
    fireEvent.click(mute);
    expect(onToggleMute).toHaveBeenCalledTimes(1);
    cleanup();
    bar({ muted: true });
    const muted = screen.getByRole('button', { name: 'Silenciar micrófono' });
    expect(muted.getAttribute('aria-pressed')).toBe('true');
    expect(muted.querySelector('svg')!.getAttribute('class')).toContain('lucide-mic-off');
  });

  it('hangs up, and goes back to the call', () => {
    const { onHangUp, onReturn } = bar();
    const hangUp = screen.getByRole('button', { name: 'Colgar' });
    expect(hangUp.querySelector('svg')!.getAttribute('class')).toContain('lucide-phone-off');
    fireEvent.click(hangUp);
    fireEvent.click(screen.getByRole('button', { name: 'Volver a la llamada' }));
    expect(onHangUp).toHaveBeenCalledTimes(1);
    expect(onReturn).toHaveBeenCalledTimes(1);
  });

  // How the call travels is said once, on the call screen.
  it('does not repeat how the call travels', () => {
    bar();
    expect(screen.getByRole('region').textContent).not.toMatch(/Conexión/);
  });
});
