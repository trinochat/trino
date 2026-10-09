// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createRef } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { Checkbox } from './Checkbox';
import { descriptionsOf } from './test-utils';

afterEach(cleanup);

describe('Checkbox', () => {
  it('is a native checkbox named by its label and described by its description', () => {
    render(<Checkbox label="No volver a preguntar" description="Puedes cambiarlo en Ajustes." />);
    const box = screen.getByRole<HTMLInputElement>('checkbox', { name: 'No volver a preguntar' });
    expect(box.type).toBe('checkbox');
    expect(descriptionsOf(box)).toEqual(['Puedes cambiarlo en Ajustes.']);
  });

  it('toggles from anywhere on its label', () => {
    render(<Checkbox label="No volver a preguntar" description="Puedes cambiarlo en Ajustes." />);
    const box = screen.getByRole<HTMLInputElement>('checkbox');
    fireEvent.click(screen.getByText('No volver a preguntar'));
    expect(box.checked).toBe(true);
    fireEvent.click(screen.getByText('Puedes cambiarlo en Ajustes.'));
    expect(box.checked).toBe(false);
  });

  it('takes the accent colour from the theme token', () => {
    render(<Checkbox label="Recordar" />);
    expect(screen.getByRole('checkbox').classList).toContain('[accent-color:var(--t-accent)]');
  });

  it('is a 44 px target with its label', () => {
    render(<Checkbox label="Recordar" />);
    expect(screen.getByRole('checkbox').closest('label')?.classList).toContain('min-h-11');
  });

  it('forwards the ref to the input', () => {
    const ref = createRef<HTMLInputElement>();
    render(<Checkbox ref={ref} label="Recordar" defaultChecked />);
    expect(ref.current).toBe(screen.getByRole('checkbox', { name: 'Recordar' }));
    expect(ref.current?.checked).toBe(true);
  });
});
