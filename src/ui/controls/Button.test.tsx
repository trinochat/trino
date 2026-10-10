// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createRef } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Button, type ButtonVariant } from './Button';
import { colourTokens, contrastFailures, SURFACES } from './test-utils';

afterEach(cleanup);

const VARIANTS: readonly ButtonVariant[] = ['primary', 'secondary', 'ghost', 'danger', 'dangerSolid'];

describe('Button', () => {
  it('is a native button of type "button" unless told otherwise', () => {
    render(
      <>
        <Button>Guardar</Button>
        <Button type="submit">Enviar</Button>
      </>,
    );
    expect(screen.getByRole('button', { name: 'Guardar' }).getAttribute('type')).toBe('button');
    expect(screen.getByRole('button', { name: 'Enviar' }).getAttribute('type')).toBe('submit');
  });

  it.each([
    ['primary', ['bg-ui-accent', 'text-ui-accent-ink']],
    ['secondary', ['border-ui-line', 'bg-transparent', 'text-ui-ink']],
    ['ghost', ['border-transparent', 'bg-transparent', 'text-ui-ink']],
    ['danger', ['border-ui-danger', 'bg-transparent', 'text-ui-danger']],
    ['dangerSolid', ['bg-ui-danger', 'text-ui-surface']],
  ] as const)('draws the %s variant with the theme tokens', (variant, classes) => {
    render(
      <Button variant={variant} leadingIcon={<svg />}>
        Acción
      </Button>,
    );
    const { classList } = screen.getByRole('button');
    for (const name of classes) expect(classList).toContain(name);
  });

  // The solid danger button sits beside green primary buttons, and red and
  // green merge for many people: it needs an icon (and a verb) as well.
  it('needs an icon on the solid danger button, in its type', () => {
    // @ts-expect-error dangerSolid needs a leadingIcon.
    const withoutIcon = <Button variant="dangerSolid">Eliminar</Button>;
    expect(withoutIcon.props.variant).toBe('dangerSolid');
    render(
      <Button variant="dangerSolid" leadingIcon={<svg data-testid="trash" />}>
        Eliminar
      </Button>,
    );
    expect(screen.getByRole('button', { name: 'Eliminar' }).contains(screen.getByTestId('trash'))).toBe(true);
  });

  it('is secondary and 44 px tall by default, and 48 px when large', () => {
    render(
      <>
        <Button>Normal</Button>
        <Button size="lg">Grande</Button>
      </>,
    );
    const normal = screen.getByRole('button', { name: 'Normal' });
    expect(normal.classList).toContain('border-ui-line');
    expect(normal.classList).toContain('min-h-11');
    expect(screen.getByRole('button', { name: 'Grande' }).classList).toContain('min-h-12');
  });

  it('takes the full width only on request', () => {
    render(
      <>
        <Button fullWidth>Ancho</Button>
        <Button>Justo</Button>
      </>,
    );
    expect(screen.getByRole('button', { name: 'Ancho' }).classList).toContain('w-full');
    expect(screen.getByRole('button', { name: 'Justo' }).classList).not.toContain('w-full');
  });

  it('shows a leading icon hidden from assistive technology', () => {
    render(<Button leadingIcon={<svg data-testid="icon" />}>Escanear</Button>);
    const button = screen.getByRole('button', { name: 'Escanear' });
    const icon = screen.getByTestId('icon');
    expect(button.contains(icon)).toBe(true);
    expect(icon.closest('[aria-hidden="true"]')).not.toBeNull();
  });

  it('ignores clicks while disabled', () => {
    const onClick = vi.fn();
    render(
      <Button disabled onClick={onClick}>
        Guardar
      </Button>,
    );
    const button = screen.getByRole<HTMLButtonElement>('button');
    fireEvent.click(button);
    expect(button.disabled).toBe(true);
    expect(onClick).not.toHaveBeenCalled();
  });

  it('stays at full strength while loading, unlike a disabled button', () => {
    render(
      <>
        <Button loading>Guardando</Button>
        <Button disabled>Guardar</Button>
      </>,
    );
    const busy = screen.getByRole('button', { name: 'Guardando' });
    expect(busy.classList).not.toContain('disabled:opacity-50');
    expect(busy.classList).toContain('cursor-progress');
    expect(screen.getByRole('button', { name: 'Guardar' }).classList).toContain('disabled:opacity-50');
  });

  it('is busy and disabled while loading, and shows a spinner', () => {
    const onClick = vi.fn();
    render(
      <>
        <Button loading onClick={onClick}>
          Guardando
        </Button>
        <Button>Listo</Button>
      </>,
    );
    const busy = screen.getByRole<HTMLButtonElement>('button', { name: 'Guardando' });
    expect(busy.getAttribute('aria-busy')).toBe('true');
    expect(busy.disabled).toBe(true);
    expect(busy.querySelector('[aria-hidden="true"] svg')).not.toBeNull();
    fireEvent.click(busy);
    expect(onClick).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Listo' }).hasAttribute('aria-busy')).toBe(false);
  });

  it('forwards the ref and the other attributes to the button', () => {
    const ref = createRef<HTMLButtonElement>();
    render(
      <Button ref={ref} aria-describedby="nota" className="mt-4">
        Aceptar
      </Button>,
    );
    expect(ref.current).toBe(screen.getByRole('button', { name: 'Aceptar' }));
    expect(ref.current?.getAttribute('aria-describedby')).toBe('nota');
    expect(ref.current?.classList).toContain('mt-4');
  });

  it('keeps its text at 4.5:1 on its own fills, or on every surface when transparent', () => {
    const pairs = VARIANTS.flatMap(variant => {
      const { unmount } = render(
        <Button variant={variant} leadingIcon={<svg />}>
          Acción
        </Button>,
      );
      const button = screen.getByRole('button');
      const fills = colourTokens(button, 'bg');
      const backgrounds = button.classList.contains('bg-transparent') ? [...SURFACES, ...fills] : fills;
      const texts = colourTokens(button, 'text');
      unmount();
      expect(texts.length, variant).toBeGreaterThan(0);
      expect(backgrounds.length, variant).toBeGreaterThan(0);
      return texts.flatMap(text => backgrounds.map(background => [text, background] as const));
    });
    expect(contrastFailures(pairs, 4.5)).toEqual([]);
  });
});
