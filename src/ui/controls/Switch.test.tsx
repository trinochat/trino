// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createRef, useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ThemeTokens } from '../../design/tokens';
import { Switch, type SwitchProps } from './Switch';
import { colourToken, contrastFailures, descriptionsOf, pressActivationKey, SURFACES } from './test-utils';

afterEach(cleanup);

type Pair = readonly [foreground: keyof ThemeTokens, background: keyof ThemeTokens];

/** A switch that keeps its own state, like a settings screen would. */
function Toggle({ initial = false, disabled = false }: { initial?: boolean; disabled?: boolean }) {
  const [checked, setChecked] = useState(initial);
  return (
    <Switch
      label="Sonido de mensajes"
      description="Un sonido corto cuando llega un mensaje."
      checked={checked}
      onCheckedChange={setChecked}
      disabled={disabled}
    />
  );
}

describe('Switch', () => {
  it('is a switch named by its visible label and described by its description', () => {
    render(<Toggle />);
    const control = screen.getByRole('switch', { name: 'Sonido de mensajes' });
    expect(control.getAttribute('aria-checked')).toBe('false');
    expect(descriptionsOf(control)).toEqual(['Un sonido corto cuando llega un mensaje.']);
  });

  it('can take its name from aria-label or aria-labelledby instead', () => {
    render(
      <>
        <span id="tor">Ocultar mi IP con Tor</span>
        <Switch aria-label="Registro de diagnóstico" checked={false} onCheckedChange={() => {}} />
        <Switch aria-labelledby="tor" checked onCheckedChange={() => {}} />
      </>,
    );
    expect(screen.getByRole('switch', { name: 'Registro de diagnóstico' }).getAttribute('aria-checked')).toBe('false');
    expect(screen.getByRole('switch', { name: 'Ocultar mi IP con Tor' }).getAttribute('aria-checked')).toBe('true');
  });

  it('requires a label, an aria-label or an aria-labelledby in its type', () => {
    // @ts-expect-error: a switch needs an accessible name.
    const props: SwitchProps = { checked: false, onCheckedChange: () => {} };
    expect(props).not.toHaveProperty('label');
  });

  it('toggles aria-checked on click', () => {
    render(<Toggle />);
    const control = screen.getByRole('switch');
    fireEvent.click(control);
    expect(control.getAttribute('aria-checked')).toBe('true');
    fireEvent.click(control);
    expect(control.getAttribute('aria-checked')).toBe('false');
  });

  it('toggles with Space and Enter, as the native button it is', () => {
    render(<Toggle />);
    const control = screen.getByRole('switch');
    expect(control.tagName).toBe('BUTTON');
    expect(control.getAttribute('type')).toBe('button');
    pressActivationKey(control, ' ');
    expect(control.getAttribute('aria-checked')).toBe('true');
    pressActivationKey(control, 'Enter');
    expect(control.getAttribute('aria-checked')).toBe('false');
  });

  it('toggles when its visible label is clicked', () => {
    render(<Toggle />);
    fireEvent.click(screen.getByText('Sonido de mensajes'));
    expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('true');
  });

  it('stays put while disabled', () => {
    const onCheckedChange = vi.fn();
    render(<Switch aria-label="Tor" checked={false} onCheckedChange={onCheckedChange} disabled />);
    fireEvent.click(screen.getByRole('switch'));
    expect(onCheckedChange).not.toHaveBeenCalled();
  });

  it('forwards the ref to the button', () => {
    const ref = createRef<HTMLButtonElement>();
    render(<Switch ref={ref} aria-label="Tor" checked={false} onCheckedChange={() => {}} />);
    expect(ref.current).toBe(screen.getByRole('switch'));
  });
});

describe('Switch contrast (WCAG 1.4.11)', () => {
  /** The colour tokens of the track and the knob, read from the rendered classes. */
  function partsOf(checked: boolean) {
    const { unmount } = render(<Switch aria-label="Tor" checked={checked} onCheckedChange={() => {}} />);
    const track = screen.getByRole('switch');
    const knob = track.querySelector('[data-part="knob"]');
    if (!knob) throw new Error('The switch has no knob');
    const parts = { track: colourToken(track, 'bg'), knob: colourToken(knob, 'bg') };
    unmount();
    return parts;
  }

  it('draws the off track in muted, never in the decorative line colour', () => {
    expect(partsOf(false)).toEqual({ track: 'muted', knob: 'surface' });
    expect(partsOf(true)).toEqual({ track: 'accent', knob: 'accentInk' });
  });

  it('reaches 3:1 between each track and the surfaces, and between the knob and its track, in all 16 appearances', () => {
    const on = partsOf(true);
    const off = partsOf(false);
    const pairs: Pair[] = [
      [on.knob, on.track],
      [off.knob, off.track],
      ...SURFACES.flatMap((surface): Pair[] => [
        [on.track, surface],
        [off.track, surface],
      ]),
    ];
    expect(contrastFailures(pairs, 3)).toEqual([]);
  });
});
