// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createRef } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IconButton, type IconButtonProps, type IconButtonVariant } from './IconButton';
import { colourTokens, contrastFailures, SURFACES } from './test-utils';

afterEach(cleanup);

const VARIANTS: readonly IconButtonVariant[] = ['ghost', 'muted', 'secondary', 'primary', 'danger'];

describe('IconButton', () => {
  it('is named by its aria-label and hides the icon', () => {
    const onClick = vi.fn();
    render(<IconButton aria-label="Cerrar" icon={<svg data-testid="icon" />} onClick={onClick} />);
    const button = screen.getByRole('button', { name: 'Cerrar' });
    expect(button.getAttribute('type')).toBe('button');
    expect(screen.getByTestId('icon').closest('[aria-hidden="true"]')).not.toBeNull();
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('requires the aria-label in its type', () => {
    // @ts-expect-error: an icon-only button has no other accessible name.
    const props: IconButtonProps = { icon: null };
    expect(props).not.toHaveProperty('aria-label');
  });

  it('is a 44 px target by default and 36 px in dense rows', () => {
    render(
      <>
        <IconButton aria-label="Normal" icon={null} />
        <IconButton aria-label="Denso" size="sm" icon={null} />
      </>,
    );
    const normal = screen.getByRole('button', { name: 'Normal' }).classList;
    const dense = screen.getByRole('button', { name: 'Denso' }).classList;
    expect([normal.contains('h-11'), normal.contains('w-11')]).toEqual([true, true]);
    expect([dense.contains('h-9'), dense.contains('w-9')]).toEqual([true, true]);
  });

  it('reports aria-pressed only when it is a toggle', () => {
    render(
      <>
        <IconButton aria-label="Silenciar" pressed icon={null} />
        <IconButton aria-label="Cámara" pressed={false} icon={null} />
        <IconButton aria-label="Ajustes" icon={null} />
      </>,
    );
    expect(screen.getByRole('button', { name: 'Silenciar' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: 'Cámara' }).getAttribute('aria-pressed')).toBe('false');
    expect(screen.getByRole('button', { name: 'Ajustes' }).hasAttribute('aria-pressed')).toBe(false);
  });

  it('marks the pressed state with the accent', () => {
    render(<IconButton aria-label="Silenciar" pressed icon={null} />);
    const { classList } = screen.getByRole('button');
    expect(classList).toContain('bg-ui-accent-soft');
    expect(classList).toContain('text-ui-accent-text');
  });

  it.each([
    ['ghost', ['bg-transparent', 'text-ui-ink']],
    ['muted', ['bg-transparent', 'text-ui-muted']],
    ['secondary', ['border-ui-line', 'bg-ui-surface', 'text-ui-ink']],
    ['primary', ['bg-ui-accent', 'text-ui-accent-ink']],
    ['danger', ['bg-transparent', 'text-ui-danger']],
  ] as const)('draws the %s variant with the theme tokens', (variant, classes) => {
    render(<IconButton aria-label="Acción" variant={variant} icon={null} />);
    const { classList } = screen.getByRole('button');
    for (const name of classes) expect(classList).toContain(name);
  });

  it('keeps its icon at 3:1 on its fills, or on every surface when transparent (WCAG 1.4.11)', () => {
    const states = [...VARIANTS.map(variant => ({ variant, pressed: false })), { variant: 'ghost' as const, pressed: true }];
    const pairs = states.flatMap(({ variant, pressed }) => {
      const { unmount } = render(<IconButton aria-label="Acción" variant={variant} pressed={pressed} icon={null} />);
      const button = screen.getByRole('button');
      const fills = colourTokens(button, 'bg');
      const backgrounds = button.classList.contains('bg-transparent') ? [...SURFACES, ...fills] : fills;
      const icons = colourTokens(button, 'text');
      unmount();
      return icons.flatMap(icon => backgrounds.map(background => [icon, background] as const));
    });
    expect(pairs.length).toBeGreaterThan(VARIANTS.length);
    expect(contrastFailures(pairs, 3)).toEqual([]);
  });

  it('forwards the ref to the button', () => {
    const ref = createRef<HTMLButtonElement>();
    render(<IconButton ref={ref} aria-label="Enviar" variant="primary" icon={null} />);
    expect(ref.current).toBe(screen.getByRole('button', { name: 'Enviar' }));
  });
});
