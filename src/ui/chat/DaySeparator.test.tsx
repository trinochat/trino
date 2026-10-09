// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { DaySeparator } from './DaySeparator';

afterEach(cleanup);

describe('DaySeparator', () => {
  it('is a centred pill on the raised colour, in the label style', () => {
    const { container } = render(<DaySeparator label="Hoy" />);
    expect(container.firstElementChild?.getAttribute('class')?.split(/\s+/)).toContain('justify-center');
    const pill = screen.getByText('Hoy').getAttribute('class')?.split(/\s+/) ?? [];
    for (const token of [
      'rounded-full',
      'bg-ui-raised',
      'text-ui-muted',
      'font-ui-label',
      'text-[12px]',
      '[text-transform:var(--t-label-transform)]',
      '[letter-spacing:var(--t-label-spacing)]',
    ]) {
      expect(pill).toContain(token);
    }
  });
});
