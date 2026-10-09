// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { Button } from './Button';
import { Checkbox } from './Checkbox';
import { Field } from './Field';
import { IconButton } from './IconButton';
import { Input } from './Input';
import { PasswordInput } from './PasswordInput';
import { RadioCardGroup } from './RadioCardGroup';
import { Segmented } from './Segmented';
import { Select } from './Select';
import { FOCUS_RING } from './styles';
import { Switch } from './Switch';
import { Tabs } from './Tabs';
import { Textarea } from './Textarea';

afterEach(cleanup);

const CHOICES = [
  { value: 'a', label: 'A' },
  { value: 'b', label: 'B' },
];

describe('focus ring (WCAG 2.4.7)', () => {
  it('is on every element of every control that can take the focus', () => {
    const { container } = render(
      <>
        <Button>Botón</Button>
        <IconButton aria-label="Icono" icon={null} />
        <Field label="Campo">
          <Input />
        </Field>
        <PasswordInput aria-label="Contraseña" toggleLabel="Mostrar contraseña" />
        <Textarea aria-label="Texto" />
        <Select aria-label="Lista">
          <option>Uno</option>
        </Select>
        <Switch aria-label="Interruptor" checked={false} onCheckedChange={() => {}} />
        <Checkbox label="Casilla" />
        <RadioCardGroup aria-label="Opciones" options={CHOICES} value="a" onValueChange={() => {}} />
        <Segmented aria-label="Segmentos" options={CHOICES} value="a" onValueChange={() => {}} />
        <Tabs
          aria-label="Pestañas"
          items={CHOICES.map(choice => ({ ...choice, panel: choice.label }))}
          value="a"
          onValueChange={() => {}}
        />
      </>,
    );
    const focusable = Array.from(container.querySelectorAll('button, input, select, textarea, [tabindex]'));
    // 2 buttons, input, password and its toggle, textarea, select, switch, checkbox,
    // 2 radio cards, 2 segments, 2 tabs and 2 panels.
    expect(focusable).toHaveLength(17);
    const ring = FOCUS_RING.split(' ');
    const missing = focusable
      .filter(element => !ring.every(name => element.classList.contains(name)))
      .map(element => element.outerHTML.slice(0, 90));
    expect(missing).toEqual([]);
  });

  it('draws the ring in the accent text colour, 2 px wide and 2 px away', () => {
    expect(FOCUS_RING.split(' ')).toEqual(
      expect.arrayContaining([
        'focus-visible:outline',
        'focus-visible:outline-2',
        'focus-visible:outline-offset-2',
        'focus-visible:outline-ui-accent-text',
      ]),
    );
  });
});
