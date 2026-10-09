// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { createRef } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { Field } from './Field';
import { Input } from './Input';
import { Select } from './Select';
import { descriptionsOf } from './test-utils';

afterEach(cleanup);

describe('Field', () => {
  it('labels its control', () => {
    render(
      <Field label="Nombre">
        <Input />
      </Field>,
    );
    const input = screen.getByRole('textbox', { name: 'Nombre' });
    expect(input.hasAttribute('aria-invalid')).toBe(false);
    expect(input.hasAttribute('aria-describedby')).toBe(false);
  });

  it('describes the control with the hint', () => {
    render(
      <Field label="Código" hint="Cambia cada 30 segundos.">
        <Input />
      </Field>,
    );
    const input = screen.getByRole('textbox', { name: 'Código' });
    expect(descriptionsOf(input)).toEqual(['Cambia cada 30 segundos.']);
    expect(screen.getByText('Cambia cada 30 segundos.').classList).toContain('text-ui-muted');
  });

  it('marks an error with aria-invalid and adds it to the description', () => {
    render(
      <Field label="Contraseña" hint="Al menos 8 caracteres." error="Las contraseñas no coinciden.">
        <Input />
      </Field>,
    );
    const input = screen.getByRole('textbox', { name: 'Contraseña' });
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(descriptionsOf(input)).toEqual(['Al menos 8 caracteres.', 'Las contraseñas no coinciden.']);
    expect(input.classList).toContain('border-ui-danger');
    expect(input.classList).not.toContain('border-ui-control-line');
  });

  it('shows the error in the danger colour with an icon, not by colour alone', () => {
    render(
      <Field label="Contraseña" error="Contraseña incorrecta.">
        <Input />
      </Field>,
    );
    const error = screen.getByText('Contraseña incorrecta.').closest('p');
    expect(error?.classList).toContain('text-ui-danger');
    expect(error?.querySelector('svg[aria-hidden="true"]')).not.toBeNull();
  });

  it("uses the Field's id and keeps the control's own description", () => {
    render(
      <>
        <p id="nota">Solo relays con wss://.</p>
        <Field label="Relay" id="relay" hint="Por ejemplo, wss://nos.lol.">
          <Input aria-describedby="nota" />
        </Field>
      </>,
    );
    const input = screen.getByRole('textbox', { name: 'Relay' });
    expect(input.id).toBe('relay');
    expect(descriptionsOf(input)).toEqual(['Por ejemplo, wss://nos.lol.', 'Solo relays con wss://.']);
  });

  it('gives each field its own ids', () => {
    render(
      <>
        <Field label="Uno" hint="Primera pista.">
          <Input />
        </Field>
        <Field label="Dos" hint="Segunda pista.">
          <Input />
        </Field>
      </>,
    );
    const one = screen.getByRole('textbox', { name: 'Uno' });
    const two = screen.getByRole('textbox', { name: 'Dos' });
    expect(one.id).not.toBe(two.id);
    expect(descriptionsOf(two)).toEqual(['Segunda pista.']);
  });

  it('wires a Select the same way', () => {
    render(
      <Field label="Bloqueo automático" error="Elige cuándo se bloquea.">
        <Select defaultValue="5">
          <option value="5">Tras 5 minutos</option>
          <option value="never">Nunca</option>
        </Select>
      </Field>,
    );
    const select = screen.getByRole('combobox', { name: 'Bloqueo automático' });
    expect(select.tagName).toBe('SELECT');
    expect(select.getAttribute('aria-invalid')).toBe('true');
    expect(descriptionsOf(select)).toEqual(['Elige cuándo se bloquea.']);
  });
});

describe('Input', () => {
  it('is a styled text input that also works without a Field', () => {
    const ref = createRef<HTMLInputElement>();
    render(<Input ref={ref} aria-label="Buscar" />);
    const input = screen.getByRole('textbox', { name: 'Buscar' });
    expect(ref.current).toBe(input);
    expect(input.getAttribute('type')).toBe('text');
    expect(input.classList).toContain('min-h-12');
    expect(input.classList).toContain('border-ui-control-line');
    expect(input.classList).toContain('font-ui');
    expect(input.hasAttribute('aria-invalid')).toBe(false);
  });

  it('switches to the monospace font for keys and codes', () => {
    render(<Input aria-label="Código" mono />);
    const { classList } = screen.getByRole('textbox', { name: 'Código' });
    expect(classList).toContain('font-ui-mono');
    expect(classList).not.toContain('font-ui');
  });
});

describe('Select', () => {
  it('is a native select with a decorative chevron', () => {
    const ref = createRef<HTMLSelectElement>();
    render(
      <Select ref={ref} aria-label="Tono">
        <option>Trino suave</option>
        <option>Campana</option>
      </Select>,
    );
    const select = screen.getByRole('combobox', { name: 'Tono' });
    expect(ref.current).toBe(select);
    expect(select.classList).toContain('appearance-none');
    expect(select.parentElement?.querySelector('svg[aria-hidden="true"]')).not.toBeNull();
  });
});
