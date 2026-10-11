// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { ConnectionChip } from './ConnectionChip';

afterEach(cleanup);

const classesOf = (element: Element | null) => (element?.getAttribute('class') ?? '').split(/\s+/);

const STATE_COLOURS = ['text-ui-ok', 'text-ui-warn', 'text-ui-danger'];

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
    // Never another state's colour beside its own, which one of them would win.
    for (const other of STATE_COLOURS.filter(name => name !== colour)) {
      expect(classesOf(mark)).not.toContain(other);
    }
    expect(classesOf(mark).filter(name => name.startsWith('bg-'))).toEqual([]);
  });

  // 10 px in the attributes, which every engine reads, and 0.625 rem in the
  // class that beats them and grows with the text (iconSize, type.ts).
  it('fills only the circle of a working connection, and sizes the icons in rem over a px fallback', () => {
    const icons = (['connected', 'connecting', 'offline'] as const).map(status => {
      const { container, unmount } = render(<ConnectionChip status={status} label={status} />);
      const icon = container.querySelector('svg');
      const result = [
        icon?.getAttribute('fill'),
        icon?.getAttribute('width'),
        icon?.getAttribute('height'),
        classesOf(icon).includes('size-[0.625rem]'),
      ];
      unmount();
      return result;
    });
    expect(icons).toEqual([
      ['currentColor', '10', '10', true],
      ['none', '10', '10', true],
      ['none', '10', '10', true],
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
