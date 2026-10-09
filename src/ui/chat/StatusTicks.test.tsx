// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { StatusTicks } from './StatusTicks';

afterEach(cleanup);

describe('StatusTicks', () => {
  it.each([
    ['sending', 'lucide-clock', 'Enviando'],
    ['sent', 'lucide-check', 'Enviado'],
    ['failed', 'lucide-circle-alert', 'No enviado'],
  ] as const)('shows %s as a hidden icon with screen-reader text', (state, icon, label) => {
    const { container } = render(<StatusTicks state={state} label={label} />);
    const svg = container.querySelector('svg');
    expect(svg?.getAttribute('class')?.split(/\s+/)).toContain(icon);
    expect(svg?.getAttribute('aria-hidden')).toBe('true');
    expect(screen.getByText(label).getAttribute('class')?.split(/\s+/)).toContain('sr-only');
    expect(container.textContent).toBe(label);
  });
});
