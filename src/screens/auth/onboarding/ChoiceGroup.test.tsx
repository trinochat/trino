// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { classesOf } from '../test-harness';
import { ChoiceDot, ChoiceGroup, type ChoiceOption } from './ChoiceGroup';

afterEach(cleanup);

type Style = 'calma' | 'terminal';
const OPTIONS: ChoiceOption<Style>[] = [
  { value: 'calma', label: 'Calma', description: 'Limpio y sencillo.', lang: 'es' },
  { value: 'terminal', label: 'Terminal', description: 'Estilo consola.' },
];

function Group({ onChange = vi.fn() }: { onChange?: (value: Style) => void }) {
  const [value, setValue] = useState<Style>('calma');
  return (
    <ChoiceGroup
      aria-label="Estilo"
      options={OPTIONS}
      value={value}
      onValueChange={next => {
        setValue(next);
        onChange(next);
      }}
      renderItem={(option, { checked, labelId, descriptionId }) => (
        <>
          <span aria-hidden="true">vista previa</span>
          <ChoiceDot checked={checked} />
          <span id={labelId}>{option.label}</span>
          <span id={descriptionId}>{option.description}</span>
        </>
      )}
    />
  );
}

describe('ChoiceGroup', () => {
  it('is a radio group whose cards are named by their label and described by their description', () => {
    render(<Group />);
    expect(screen.getByRole('radiogroup', { name: 'Estilo' })).toBeTruthy();
    const calma = screen.getByRole('radio', { name: 'Calma' });
    expect(calma.getAttribute('aria-checked')).toBe('true');
    expect(document.getElementById(calma.getAttribute('aria-describedby') ?? '')?.textContent).toBe('Limpio y sencillo.');
    expect(calma.getAttribute('lang')).toBe('es');
    expect(screen.getByRole('radio', { name: 'Terminal' }).getAttribute('aria-checked')).toBe('false');
  });

  it('is one Tab stop, and the arrows move and select', () => {
    const onChange = vi.fn();
    render(<Group onChange={onChange} />);
    const [calma, terminal] = screen.getAllByRole('radio');
    expect([calma.tabIndex, terminal.tabIndex]).toEqual([0, -1]);
    fireEvent.keyDown(calma, { key: 'ArrowRight' });
    expect(onChange).toHaveBeenCalledWith('terminal');
    expect(document.activeElement).toBe(terminal);
    expect([calma.tabIndex, terminal.tabIndex]).toEqual([-1, 0]);
    fireEvent.click(calma);
    expect(onChange).toHaveBeenLastCalledWith('calma');
  });

  // Never by colour alone (accesibilidad.md §3): the dot is a thick ring
  // when checked, and forced colours give the checked border the system's
  // selection colour.
  it('shows the checked card by its shape too, also under forced colours', () => {
    render(<Group />);
    const [calma, terminal] = screen.getAllByRole('radio');
    expect(classesOf(calma)).toEqual(expect.arrayContaining(['border-2', 'border-ui-accent-text', 'forced-colors:border-[color:Highlight]']));
    expect(classesOf(terminal)).toEqual(expect.arrayContaining(['border-2', 'border-ui-line']));
    expect(classesOf(terminal)).not.toContain('forced-colors:border-[color:Highlight]');
    const dots = [calma, terminal].map(card => card.querySelector('.rounded-full'));
    expect(classesOf(dots[0])).toContain('border-[0.3125rem]');
    expect(classesOf(dots[1])).toContain('border-2');
    expect(dots.every(dot => dot?.getAttribute('aria-hidden') === 'true')).toBe(true);
  });
});
