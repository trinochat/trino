// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createRef } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { Field } from './Field';
import { PasswordInput } from './PasswordInput';
import { descriptionsOf } from './test-utils';

afterEach(cleanup);

describe('PasswordInput', () => {
  it('hides the password until the toggle shows it', () => {
    render(
      <Field label="Contraseña">
        <PasswordInput toggleLabel="Mostrar contraseña" defaultValue="caballo-correcto" />
      </Field>,
    );
    const input = screen.getByLabelText<HTMLInputElement>('Contraseña');
    const toggle = screen.getByRole('button', { name: 'Mostrar contraseña' });
    expect(input.type).toBe('password');
    expect(toggle.getAttribute('aria-pressed')).toBe('false');

    fireEvent.click(toggle);
    expect(input.type).toBe('text');
    expect(input.value).toBe('caballo-correcto');
    expect(toggle.getAttribute('aria-pressed')).toBe('true');

    fireEvent.click(toggle);
    expect(input.type).toBe('password');
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
  });

  it('keeps the shown password away from the spell checker', () => {
    render(<PasswordInput aria-label="Contraseña" toggleLabel="Mostrar contraseña" />);
    const input = screen.getByLabelText('Contraseña');
    expect(input.getAttribute('spellcheck')).toBe('false');
    expect(input.getAttribute('autocapitalize')).toBe('off');
  });

  it('takes the Field wiring on the input', () => {
    render(
      <Field label="Contraseña" error="Contraseña incorrecta.">
        <PasswordInput toggleLabel="Mostrar contraseña" />
      </Field>,
    );
    const input = screen.getByLabelText('Contraseña');
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(descriptionsOf(input)).toEqual(['Contraseña incorrecta.']);
  });

  it('disables the toggle with the input', () => {
    render(<PasswordInput aria-label="Contraseña" toggleLabel="Mostrar contraseña" disabled />);
    expect(screen.getByLabelText<HTMLInputElement>('Contraseña').disabled).toBe(true);
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Mostrar contraseña' }).disabled).toBe(true);
  });

  it('forwards the ref to the input', () => {
    const ref = createRef<HTMLInputElement>();
    render(<PasswordInput ref={ref} aria-label="Contraseña" toggleLabel="Mostrar contraseña" />);
    expect(ref.current).toBe(screen.getByLabelText('Contraseña'));
  });
});
