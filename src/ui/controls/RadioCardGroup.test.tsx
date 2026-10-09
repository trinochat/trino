// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RadioCardGroup, type RadioCardOption } from './RadioCardGroup';
import { descriptionsOf, pressActivationKey } from './test-utils';

afterEach(cleanup);

type Preview = 'full' | 'name' | 'none';

const OPTIONS: readonly RadioCardOption<Preview>[] = [
  { value: 'full', label: 'Nombre y mensaje', description: 'Se ve quién escribe y el texto.' },
  { value: 'name', label: 'Solo el nombre', description: 'Se ve quién escribe, pero no lo que dice.' },
  { value: 'none', label: 'Nada' },
];

/** A group that keeps its own value, like a settings screen would. */
function Preferences({
  initial = null,
  options = OPTIONS,
}: {
  initial?: Preview | null;
  options?: readonly RadioCardOption<Preview>[];
}) {
  const [value, setValue] = useState<Preview | null>(initial);
  return <RadioCardGroup label="Qué se ve en la notificación" options={options} value={value} onValueChange={setValue} />;
}

const radios = () => screen.getAllByRole('radio');
const checkedStates = () => radios().map(radio => radio.getAttribute('aria-checked'));
const tabStops = () => radios().map(radio => radio.tabIndex);

describe('RadioCardGroup', () => {
  it('is a radio group named by its label, with one radio per option', () => {
    render(<Preferences initial="name" />);
    const group = screen.getByRole('radiogroup', { name: 'Qué se ve en la notificación' });
    const named = ['Nombre y mensaje', 'Solo el nombre', 'Nada'].map(name => screen.getByRole('radio', { name }));
    expect(radios()).toEqual(named);
    expect(named.every(radio => group.contains(radio))).toBe(true);
    expect(checkedStates()).toEqual(['false', 'true', 'false']);
  });

  it('names each radio by its label and describes it by its description', () => {
    render(<Preferences />);
    const full = screen.getByRole('radio', { name: 'Nombre y mensaje' });
    expect(descriptionsOf(full)).toEqual(['Se ve quién escribe y el texto.']);
    expect(screen.getByRole('radio', { name: 'Nada' }).hasAttribute('aria-describedby')).toBe(false);
  });

  it('can take its name from aria-label instead', () => {
    render(<RadioCardGroup aria-label="Idioma" options={OPTIONS} value="full" onValueChange={() => {}} />);
    expect(screen.getByRole('radiogroup', { name: 'Idioma' })).toBeTruthy();
  });

  it('selects an option on click', () => {
    render(<Preferences />);
    fireEvent.click(screen.getByRole('radio', { name: 'Nada' }));
    expect(checkedStates()).toEqual(['false', 'false', 'true']);
  });

  it('keeps a single tab stop, on the checked option or else the first one', () => {
    const { unmount } = render(<Preferences initial="none" />);
    expect(tabStops()).toEqual([-1, -1, 0]);
    unmount();
    render(<Preferences />);
    expect(tabStops()).toEqual([0, -1, -1]);
  });

  it('moves the focus and the selection with the arrow keys, wrapping around', () => {
    render(<Preferences initial="full" />);
    const [full, name, none] = radios();
    full.focus();

    fireEvent.keyDown(full, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(name);
    expect(checkedStates()).toEqual(['false', 'true', 'false']);
    expect(tabStops()).toEqual([-1, 0, -1]);

    fireEvent.keyDown(name, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(none);
    fireEvent.keyDown(none, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(full);
    fireEvent.keyDown(full, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(none);
    fireEvent.keyDown(none, { key: 'ArrowLeft' });
    expect(document.activeElement).toBe(name);
    expect(checkedStates()).toEqual(['false', 'true', 'false']);
  });

  it('jumps to the first and the last option with Home and End', () => {
    render(<Preferences initial="name" />);
    const [full, name, none] = radios();
    name.focus();
    fireEvent.keyDown(name, { key: 'End' });
    expect(document.activeElement).toBe(none);
    expect(checkedStates()).toEqual(['false', 'false', 'true']);
    fireEvent.keyDown(none, { key: 'Home' });
    expect(document.activeElement).toBe(full);
    expect(checkedStates()).toEqual(['true', 'false', 'false']);
  });

  it('selects the focused option with Space', () => {
    render(<Preferences />);
    const [full] = radios();
    full.focus();
    pressActivationKey(full, ' ');
    expect(checkedStates()).toEqual(['true', 'false', 'false']);
  });

  it('skips disabled options', () => {
    const options = OPTIONS.map(option => ({ ...option, disabled: option.value === 'name' }));
    render(<Preferences initial="full" options={options} />);
    const [full, , none] = radios();
    full.focus();
    fireEvent.keyDown(full, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(none);
    expect(checkedStates()).toEqual(['false', 'false', 'true']);
  });

  it('does not report a change for the option that is already checked', () => {
    const onValueChange = vi.fn();
    render(<RadioCardGroup aria-label="Vista previa" options={OPTIONS} value="full" onValueChange={onValueChange} />);
    const [full] = radios();
    fireEvent.click(full);
    fireEvent.keyDown(full, { key: 'Home' });
    expect(onValueChange).not.toHaveBeenCalled();
  });

  it('marks the checked option with the accent border, the soft fill and a filled dot', () => {
    render(<Preferences initial="full" />);
    const [checked, unchecked] = radios();
    expect(checked.classList).toContain('border-2');
    expect(checked.classList).toContain('border-ui-accent-text');
    expect(checked.classList).toContain('bg-ui-accent-soft');
    expect(checked.querySelector('[data-part="dot"]')?.classList).toContain('bg-ui-accent-text');
    expect(unchecked.classList).toContain('border-ui-line');
    expect(unchecked.querySelector('[data-part="dot"]')?.classList).toContain('border-ui-muted');
  });
});
