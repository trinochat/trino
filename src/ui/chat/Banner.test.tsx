// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { Banner } from './Banner';

afterEach(cleanup);

const classesOf = (element: Element | null) => (element?.getAttribute('class') ?? '').split(/\s+/);

describe('Banner', () => {
  it.each([
    ['info', 'status', 'bg-ui-accent-soft', 'text-ui-accent-text'],
    ['warn', 'status', 'bg-ui-warn-bg', 'text-ui-warn'],
    ['danger', 'alert', 'bg-ui-danger-bg', 'text-ui-danger'],
  ] as const)('a %s banner is a %s on its tinted background', (tone, role, background, iconColour) => {
    render(<Banner tone={tone}>El código de seguridad de Carlos cambió.</Banner>);
    const banner = screen.getByRole(role);
    expect(banner.textContent).toContain('El código de seguridad de Carlos cambió.');
    expect(classesOf(banner)).toContain(background);
    const icon = banner.querySelector('svg');
    expect(icon?.getAttribute('aria-hidden')).toBe('true');
    expect(classesOf(icon?.parentElement ?? null)).toContain(iconColour);
  });

  it('renders the action the screen passes', () => {
    render(
      <Banner tone="warn" action={<button type="button">Comprobar código</button>}>
        El código de seguridad de Carlos cambió.
      </Banner>,
    );
    expect(screen.getByRole('status').contains(screen.getByRole('button', { name: 'Comprobar código' }))).toBe(true);
  });
});
