// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderAuth, resetDocument } from '../test-harness';
import { StartupScreen } from './StartupScreen';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  resetDocument();
});

describe('StartupScreen', () => {
  // The status usually answers in a few ms: a message shown at once would
  // only flash before the next screen. The live region is there from the
  // start, empty, so the message is announced when it appears.
  it('says it is opening Trino only once it takes a moment', () => {
    vi.useFakeTimers();
    const { container } = renderAuth(<StartupScreen failed={false} onRetry={() => {}} />);
    expect(screen.getByRole('status').textContent).toBe('');
    expect(container.querySelector('svg')).toBeNull();
    act(() => {
      vi.advanceTimersByTime(400);
    });
    expect(screen.getByRole('status').textContent).toBe('Abriendo Trino…');
    expect(container.querySelector('svg')).not.toBeNull();
  });

  // Principle 1 (trino-rediseno.md): no fake boot console, no TRINO://, nothing blinking.
  it('has no boot console, no TRINO:// and nothing that blinks', () => {
    const { container } = renderAuth(<StartupScreen failed={false} onRetry={() => {}} delayMs={0} />);
    expect(container.textContent).not.toMatch(/TRINO:\/\//i);
    expect(container.innerHTML).not.toMatch(/animate-/);
  });

  it('says when Trino could not start, and tries again from a focused button', () => {
    const onRetry = vi.fn();
    renderAuth(<StartupScreen failed onRetry={onRetry} />);
    expect(screen.getByRole('alert').textContent).toBe('No se pudo abrir Trino. Inténtalo de nuevo.');
    const retry = screen.getByRole('button', { name: 'Reintentar' });
    expect(document.activeElement).toBe(retry);
    fireEvent.click(retry);
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});
