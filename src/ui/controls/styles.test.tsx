// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { ThemeTokens } from '../../design/tokens';
import { Checkbox } from './Checkbox';
import { Field } from './Field';
import { Input } from './Input';
import { PasswordInput } from './PasswordInput';
import { Select } from './Select';
import { COLOR_SCHEME } from './styles';
import { Textarea } from './Textarea';
import { colourToken, contrastFailures, SURFACES } from './test-utils';

afterEach(cleanup);

type Pair = readonly [foreground: keyof ThemeTokens, background: keyof ThemeTokens];

const FIELD_LABELS = ['Nombre', 'Contraseña', 'Mensaje', 'Bloqueo automático'];

/** The four text fields, each inside a Field, with the same error or none. */
function renderTextFields(error?: string): HTMLElement[] {
  render(
    <>
      <Field label="Nombre" error={error}>
        <Input />
      </Field>
      <Field label="Contraseña" error={error}>
        <PasswordInput toggleLabel="Mostrar contraseña" />
      </Field>
      <Field label="Mensaje" error={error}>
        <Textarea />
      </Field>
      <Field label="Bloqueo automático" error={error}>
        <Select>
          <option>Tras 5 minutos</option>
        </Select>
      </Field>
    </>,
  );
  return FIELD_LABELS.map(label => screen.getByLabelText(label));
}

/** Each boundary token against every surface a field can sit on. */
function boundaryPairs(borders: ReadonlyArray<keyof ThemeTokens>): Pair[] {
  return borders.flatMap(border => SURFACES.map((surface): Pair => [border, surface]));
}

describe('text field boundary (WCAG 1.4.11)', () => {
  it('is drawn in controlLine, which reaches 3:1 on every surface in all 16 appearances', () => {
    const borders = renderTextFields().map(field => colourToken(field, 'border'));
    expect(borders).toEqual(['controlLine', 'controlLine', 'controlLine', 'controlLine']);
    expect(contrastFailures(boundaryPairs(borders), 3)).toEqual([]);
  });

  it('turns danger while the field is invalid, which also reaches 3:1', () => {
    const borders = renderTextFields('Revisa este campo.').map(field => colourToken(field, 'border'));
    expect(borders).toEqual(['danger', 'danger', 'danger', 'danger']);
    expect(contrastFailures(boundaryPairs(borders), 3)).toEqual([]);
  });
});

describe('native parts of the controls', () => {
  it('follow the mode through --t-color-scheme, which src/design/apply.ts sets', () => {
    expect(COLOR_SCHEME).toBe('[color-scheme:var(--t-color-scheme)]');
  });

  // The system draws the caret, the selection, the select's list, the checkbox
  // and the scrollbars, light or dark as color-scheme says.
  it('are on the text fields, the select and the checkbox', () => {
    const fields = renderTextFields();
    render(<Checkbox label="Recordar" />);
    const controls = [...fields, screen.getByRole('checkbox', { name: 'Recordar' })];
    const missing = controls
      .filter(control => !control.classList.contains(COLOR_SCHEME))
      .map(control => control.outerHTML.slice(0, 60));
    expect(missing).toEqual([]);
  });
});
