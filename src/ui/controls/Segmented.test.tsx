// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { Segmented, type SegmentedOption } from './Segmented';
import { pressActivationKey } from './test-utils';

afterEach(cleanup);

type Mode = 'light' | 'dark' | 'system';

const MODES: readonly SegmentedOption<Mode>[] = [
  { value: 'light', label: 'Claro' },
  { value: 'dark', label: 'Oscuro' },
  { value: 'system', label: 'Sistema' },
];

function ModePicker({ initial = 'light' }: { initial?: Mode }) {
  const [mode, setMode] = useState<Mode>(initial);
  return <Segmented aria-label="Modo" options={MODES} value={mode} onValueChange={setMode} />;
}

const segments = () => screen.getAllByRole('radio');
const checkedStates = () => segments().map(segment => segment.getAttribute('aria-checked'));

describe('Segmented', () => {
  it('is a radio group of segments with a single tab stop', () => {
    render(<ModePicker initial="dark" />);
    expect(screen.getByRole('radiogroup', { name: 'Modo' })).toBeTruthy();
    expect(segments().map(segment => segment.textContent)).toEqual(['Claro', 'Oscuro', 'Sistema']);
    expect(checkedStates()).toEqual(['false', 'true', 'false']);
    expect(segments().map(segment => segment.tabIndex)).toEqual([-1, 0, -1]);
  });

  it('selects a segment on click and with Space', () => {
    render(<ModePicker />);
    fireEvent.click(screen.getByRole('radio', { name: 'Sistema' }));
    expect(checkedStates()).toEqual(['false', 'false', 'true']);
    const dark = screen.getByRole('radio', { name: 'Oscuro' });
    dark.focus();
    pressActivationKey(dark, ' ');
    expect(checkedStates()).toEqual(['false', 'true', 'false']);
  });

  it('moves the selection with the arrow keys, Home and End', () => {
    render(<ModePicker />);
    const [light, dark, system] = segments();
    light.focus();
    fireEvent.keyDown(light, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(dark);
    expect(checkedStates()).toEqual(['false', 'true', 'false']);
    fireEvent.keyDown(dark, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(system);
    fireEvent.keyDown(system, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(light);
    fireEvent.keyDown(light, { key: 'ArrowLeft' });
    expect(document.activeElement).toBe(system);
    expect(checkedStates()).toEqual(['false', 'false', 'true']);
    fireEvent.keyDown(system, { key: 'Home' });
    expect(checkedStates()).toEqual(['true', 'false', 'false']);
    fireEvent.keyDown(light, { key: 'End' });
    expect(checkedStates()).toEqual(['false', 'false', 'true']);
  });

  it('fills the selected segment with the accent, and every segment is a 44 px target', () => {
    render(<ModePicker />);
    const [light, dark] = segments();
    expect(light.classList).toContain('bg-ui-accent');
    expect(light.classList).toContain('text-ui-accent-ink');
    expect(dark.classList).not.toContain('bg-ui-accent');
    expect(dark.classList).toContain('text-ui-ink');
    expect(segments().every(segment => segment.classList.contains('min-h-11'))).toBe(true);
  });

  // 600 against 700 hardly shows, so the others drop to 400; a hidden bold
  // copy of each label keeps the width, so nothing moves on a change.
  it('sets the selected segment in bold and the others in normal weight, keeping the bold width', () => {
    render(<ModePicker />);
    const [light, dark, system] = segments();
    expect(light.classList).toContain('font-bold');
    for (const segment of [dark, system]) expect(segment.classList).toContain('font-normal');
    expect(segments().some(segment => segment.classList.contains('font-semibold'))).toBe(false);
    expect(segments().map(segment => segment.getAttribute('data-label'))).toEqual(['Claro', 'Oscuro', 'Sistema']);
    for (const name of ['after:content-[attr(data-label)]', 'after:invisible', 'after:h-0', 'after:font-bold']) {
      expect(segments().every(segment => segment.classList.contains(name))).toBe(true);
    }
  });

  // Forced colours repaint the accent fill with the system's background: the
  // selected segment keeps its own system colours instead.
  it('marks the selected segment, and only it, for forced colours and for more contrast', () => {
    render(<ModePicker />);
    const [light, dark] = segments();
    const marks = [
      'forced-colors:bg-[color:Highlight]',
      'forced-colors:text-[color:HighlightText]',
      'forced-colors:[forced-color-adjust:none]',
      'more-contrast:ring-2',
      'more-contrast:ring-inset',
      'more-contrast:ring-ui-accent-ink',
    ];
    expect(marks.filter(name => !light.classList.contains(name))).toEqual([]);
    expect(marks.filter(name => dark.classList.contains(name))).toEqual([]);
  });
});
