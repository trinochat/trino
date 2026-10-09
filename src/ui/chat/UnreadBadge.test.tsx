// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { UnreadBadge } from './UnreadBadge';

afterEach(cleanup);

const classesOf = (element: Element | null) => (element?.getAttribute('class') ?? '').split(/\s+/);

describe('UnreadBadge', () => {
  it.each([0, -1])('renders nothing for a count of %i', count => {
    const { container, rerender } = render(<UnreadBadge count={2} label="sin leer" />);
    expect(container.textContent).toBe('2 sin leer');
    rerender(<UnreadBadge count={count} label="sin leer" />);
    expect(container.innerHTML).toBe('');
  });

  it('shows the count and reads the suffix to screen readers only', () => {
    const { container } = render(<UnreadBadge count={3} label="sin leer" />);
    const badge = container.firstElementChild;
    expect(badge?.textContent).toBe('3 sin leer');
    expect(classesOf(screen.getByText('sin leer'))).toContain('sr-only');
  });

  it('uses the badge colours', () => {
    const { container } = render(<UnreadBadge count={1} label="sin leer" />);
    const classes = classesOf(container.firstElementChild);
    expect(classes).toContain('bg-ui-badge');
    expect(classes).toContain('text-ui-badge-ink');
  });

  it('caps large counts', () => {
    const { container, rerender } = render(<UnreadBadge count={150} label="sin leer" />);
    expect(container.firstElementChild?.textContent).toBe('99+ sin leer');
    rerender(<UnreadBadge count={12} label="sin leer" max={9} />);
    expect(container.firstElementChild?.textContent).toBe('9+ sin leer');
  });
});
