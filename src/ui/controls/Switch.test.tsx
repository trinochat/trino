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

/** A length in rem from a class: `h-[1.375rem]` → 1.375, or a Tailwind step, `h-7` → 1.75. */
function remOf(element: Element, prefix: string): number {
  for (const name of Array.from(element.classList)) {
    const arbitrary = new RegExp(`^${prefix}-\\[(\\d*\\.?\\d+)rem\\]$`).exec(name);
    if (arbitrary) return Number(arbitrary[1]);
    const step = new RegExp(`^${prefix}-(\\d+(?:\\.5)?)$`).exec(name);
    if (step) return Number(step[1]) / 4;
  }
  throw new Error(`No ${prefix}- length in rem in "${element.getAttribute('class')}"`);
}

describe('Switch geometry and forced colours', () => {
  function parts(checked: boolean) {
    render(<Switch aria-label="Tor" checked={checked} onCheckedChange={() => {}} />);
    const track = screen.getByRole('switch');
    const knob = track.querySelector('[data-part="knob"]');
    if (!knob) throw new Error('The switch has no knob');
    return { track, knob };
  }

  // At 14 px of root the knob stuck out of the track; in rem the parts add
  // up at any text size: the knob and its margins fill the height, and the
  // knob switched on ends one margin before the end.
  it('adds up in rem: knob + 2 margins = height, margin + travel + knob + margin = width', () => {
    const { track, knob } = parts(true);
    const height = remOf(track, 'h');
    const width = remOf(track, 'w');
    const size = remOf(knob, 'h');
    const margin = remOf(knob, 'top');
    expect(remOf(knob, 'w')).toBe(size);
    expect(remOf(knob, 'left')).toBe(margin);
    expect(size + 2 * margin).toBe(height);
    expect(margin + remOf(knob, 'translate-x') + size + margin).toBe(width);
    expect([width, height, size]).toEqual([3, 1.75, 1.375]);
  });

  // Forced colours drop backgrounds: the track keeps an outline and the knob
  // is drawn in the text colour, so its place still says on or off.
  it('keeps the outline of the track and the knob under forced colours', () => {
    const { track, knob } = parts(false);
    for (const name of ['after:border', 'after:border-transparent', 'forced-colors:after:border-[color:CanvasText]']) {
      expect(track.classList).toContain(name);
    }
    for (const name of ['forced-colors:bg-[color:CanvasText]', 'forced-colors:[forced-color-adjust:none]']) {
      expect(knob.classList).toContain(name);
    }
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
