// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { ConnectionChip } from './ConnectionChip';

afterEach(cleanup);

const classesOf = (element: Element | null) => (element?.getAttribute('class') ?? '').split(/\s+/);

describe('ConnectionChip', () => {
  it.each([
    ['connected', 'bg-ui-ok', 'Conectado por Tor · 3 de 3 relays'],
    ['connecting', 'bg-ui-warn', 'Conectando…'],
    ['offline', 'bg-ui-danger', 'Sin conexión'],
  ] as const)('shows %s with a %s dot that follows the real state', (status, dotColour, label) => {
    render(<ConnectionChip status={status} label={label} />);
    const chip = screen.getByRole('status');
    expect(chip.textContent).toBe(label);
    const dot = chip.querySelector('[aria-hidden="true"]');
    expect(classesOf(dot)).toContain(dotColour);
    for (const other of ['bg-ui-ok', 'bg-ui-warn', 'bg-ui-danger'].filter(colour => colour !== dotColour)) {
      expect(classesOf(dot)).not.toContain(other);
    }
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
