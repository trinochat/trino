// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { ConnectionChip } from './ConnectionChip';

afterEach(cleanup);

const classesOf = (element: Element | null) => (element?.getAttribute('class') ?? '').split(/\s+/);

describe('ConnectionChip', () => {
  // Colour alone tells nothing to someone who cannot see it, and forced
  // colours drop a dot drawn as a background: each state has its own icon,
  // drawn in the state's colour, and the label says the state in words.
  it.each([
    ['connected', 'circle', 'text-ui-ok', 'Conectado por Tor · 3 de 3 relays'],
    ['connecting', 'circle-dashed', 'text-ui-warn', 'Conectando…'],
    ['offline', 'circle-slash', 'text-ui-danger', 'Sin conexión'],
  ] as const)('shows %s with an icon of its own, %s, in %s', (status, icon, colour, label) => {
    render(<ConnectionChip status={status} label={label} />);
    const chip = screen.getByRole('status');
    expect(chip.textContent).toBe(label);
    const mark = chip.querySelector('[aria-hidden="true"]');
    expect(mark?.tagName.toLowerCase()).toBe('svg');
    expect(mark?.getAttribute('data-icon')).toBe(icon);
    expect(classesOf(mark)).toContain(colour);
    expect(classesOf(mark).filter(name => name.startsWith('bg-'))).toEqual([]);
  });

  it('fills only the circle of a working connection, and sizes the icons in rem', () => {
    const fills = (['connected', 'connecting', 'offline'] as const).map(status => {
      const { container, unmount } = render(<ConnectionChip status={status} label={status} />);
      const icon = container.querySelector('svg');
      const result = [icon?.getAttribute('fill'), icon?.getAttribute('width')];
      unmount();
      return result;
    });
    expect(fills).toEqual([
      ['currentColor', '0.625rem'],
      ['none', '0.625rem'],
      ['none', '0.625rem'],
    ]);
  });

  it('uses the label style on the accent-soft background', () => {
    render(<ConnectionChip status="connected" label="Conectado" />);
    const classes = classesOf(screen.getByRole('status'));
    for (const token of [
      'bg-ui-accent-soft',
      'text-ui-muted',
      'font-ui-label',
      '[text-transform:var(--t-label-transform)]',
      '[letter-spacing:var(--t-label-spacing)]',
    ]) {
      expect(classes).toContain(token);
    }
  });
});
