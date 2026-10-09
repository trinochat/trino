// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { TrustBadge } from './TrustBadge';

afterEach(cleanup);

const classesOf = (element: Element | null) => (element?.getAttribute('class') ?? '').split(/\s+/);

describe('TrustBadge', () => {
  it('shows a verified contact with the shield icon and a visible label in the accent text colour', () => {
    const { container } = render(<TrustBadge kind="verified" label="Verificada" />);
    const label = screen.getByText('Verificada');
    expect(classesOf(label)).not.toContain('sr-only');
    expect(classesOf(container.firstElementChild)).toContain('text-ui-accent-text');
    const icon = container.querySelector('svg');
    expect(icon?.getAttribute('class')).toContain('lucide-shield-check');
    expect(icon?.getAttribute('aria-hidden')).toBe('true');
  });

  it('in compact mode shows only the icon and keeps the label for screen readers', () => {
    const { container } = render(<TrustBadge kind="verified" label="Verificado" compact action={<button type="button">Verificar</button>} />);
    expect(classesOf(screen.getByText('Verificado'))).toContain('sr-only');
    expect(container.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('shows an unverified contact in muted text, followed by the action the screen passes', () => {
    render(<TrustBadge kind="unverified" label="Sin verificar" action={<button type="button">Verificar</button>} />);
    expect(classesOf(screen.getByText('Sin verificar').closest('[data-trust]'))).toContain('text-ui-muted');
    expect(screen.getByRole('button', { name: 'Verificar' })).not.toBeNull();
  });

  it.each([
    ['keyChanged', 'La clave cambió'],
    ['request', 'No está en tus contactos'],
  ] as const)('shows %s in the warning tone', (kind, label) => {
    render(<TrustBadge kind={kind} label={label} />);
    expect(classesOf(screen.getByText(label).closest('[data-trust]'))).toContain('text-ui-warn');
  });

  it.each([
    ['verified', 'lucide-shield-check'],
    ['unverified', 'lucide-shield'],
    ['keyChanged', 'lucide-shield-alert'],
    ['request', 'lucide-shield-question'],
  ] as const)('gives %s its own icon in compact mode', (kind, icon) => {
    const { container } = render(<TrustBadge kind={kind} label="Estado" compact />);
    expect(container.querySelector('svg')?.getAttribute('class')?.split(/\s+/)).toContain(icon);
  });
});
