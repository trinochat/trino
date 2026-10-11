// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useEffect } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { ChatRow } from './chat/ChatRow';
import { Button } from './controls/Button';
import { Checkbox } from './controls/Checkbox';
import { Field } from './controls/Field';
import { IconButton } from './controls/IconButton';
import { Input } from './controls/Input';
import { PasswordInput } from './controls/PasswordInput';
import { RadioCardGroup } from './controls/RadioCardGroup';
import { Segmented } from './controls/Segmented';
import { Select } from './controls/Select';
import { Switch } from './controls/Switch';
import { Tabs } from './controls/Tabs';
import { Textarea } from './controls/Textarea';
import { FOCUS_RING, FOCUS_RING_INSET, focusableWithin } from './focus';
import { Dialog } from './overlay/Dialog';
import { Menu } from './overlay/Menu';
import { ToastProvider, useToast } from './overlay/Toast';

afterEach(cleanup);

/** The library's sources, tests aside, to find where the ring is defined. */
const SOURCES: Record<string, string> = import.meta.glob<string>(['./**/*.{ts,tsx}', '!./**/*.test.{ts,tsx}'], {
  query: '?raw',
  import: 'default',
  eager: true,
});

/** `FOCUS_RING =` or `FOCUS_RING_INSET =`: a definition, not a comparison, an arrow or an import. */
const RING_DEFINITION = /\b(FOCUS_RING(?:_INSET)?)\s*=(?![=>])/g;

/** What both rings share: a 2 px outline in the accent text colour, without the legacy glow. */
const RING = [
  'focus-visible:outline',
  'focus-visible:outline-2',
  'focus-visible:outline-ui-accent-text',
  'focus-visible:shadow-none',
];

/** The ring's colour under forced colours: the contrast theme's own text colour. */
const FORCED_RING = 'forced-colors:focus-visible:outline-[color:CanvasText]';

const CHOICES = [
  { value: 'a', label: 'A' },
  { value: 'b', label: 'B' },
];

/** Every control of the library that can take the focus, the first choice of each group selected. */
function Controls() {
  return (
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
    </>
  );
}

const FOCUSABLE = 'button, input, select, textarea, [tabindex]';

function ShowErrorToast() {
  const toast = useToast();
  useEffect(() => {
    toast.show({ tone: 'error', text: 'Sin conexión', actionLabel: 'Reintentar', onAction: () => {} });
  }, [toast]);
  return null;
}

/** The start of each element that lacks one of the classes. */
function missingClasses(elements: readonly Element[], classes: readonly string[]): string[] {
  return elements
    .filter(element => !classes.every(name => element.classList.contains(name)))
    .map(element => element.outerHTML.slice(0, 90));
}

describe('focusableWithin', () => {
  it('lists what Tab reaches, in document order', () => {
    const { container } = render(
      <div>
        <a href="https://trino.chat">Enlace</a>
        <a>Sin destino</a>
        <button type="button">Botón</button>
        <button type="button" disabled>
          Desactivado
        </button>
        <input type="hidden" />
        <input aria-label="Campo" />
        <span tabIndex={-1}>Solo por código</span>
        <span tabIndex={0}>Con tabindex</span>
        <div hidden>
          <button type="button">Oculto</button>
        </div>
      </div>,
    );
    const names = focusableWithin(container).map(element => element.getAttribute('aria-label') ?? element.textContent);
    expect(names).toEqual(['Enlace', 'Botón', 'Campo', 'Con tabindex']);
  });
});

describe('focus ring (WCAG 2.4.7)', () => {
  it('draws the ring in the accent text colour, 2 px wide and 2 px away', () => {
    expect(FOCUS_RING.split(' ')).toEqual(expect.arrayContaining([...RING, 'focus-visible:outline-offset-2']));
  });

  // WCAG 1.4.11 and the more contrast setting: a 3 px ring, inset ones still inside.
  it('grows to 3 px with more contrast', () => {
    expect(FOCUS_RING.split(' ')).toContain('more-contrast:focus-visible:outline-[3px]');
    expect(FOCUS_RING_INSET.split(' ')).toEqual(
      expect.arrayContaining(['more-contrast:focus-visible:outline-[3px]', 'more-contrast:focus-visible:outline-offset-[-3px]']),
    );
  });

  it('draws the inset ring just inside the element, for rows and menu items that would clip it', () => {
    expect(FOCUS_RING_INSET.split(' ')).toEqual(
      expect.arrayContaining([...RING, 'focus-visible:outline-offset-[-2px]']),
    );
  });

  // A contrast theme of Windows gives the ring a system colour, except on an
  // element that keeps its own colours (`forced-color-adjust: none`), such
  // as the selected segment: there it would stay in the accent text colour,
  // about 2:1 on a dark contrast theme. The ring is drawn outside the
  // element, on the theme's Canvas, so it takes CanvasText.
  it("takes the contrast theme's text colour under forced colours", () => {
    expect(FOCUS_RING.split(' ')).toContain(FORCED_RING);
  });

  it('keeps that colour on every element that keeps its own colours under forced colours', () => {
    const { container } = render(<Controls />);
    const keeping = Array.from(container.querySelectorAll(FOCUSABLE)).filter(element =>
      element.closest('[class*="forced-color-adjust:none"]'),
    );
    // The selected segment, at least.
    expect(keeping.length).toBeGreaterThan(0);
    expect(missingClasses(keeping, [FORCED_RING])).toEqual([]);
  });

  it('is on every element of every control that can take the focus', () => {
    const { container } = render(<Controls />);
    const focusable = Array.from(container.querySelectorAll(FOCUSABLE));
    // 2 buttons, input, password and its toggle, textarea, select, switch, checkbox,
    // 2 radio cards, 2 segments, 2 tabs and 2 panels.
    expect(focusable).toHaveLength(17);
    expect(missingClasses(focusable, FOCUS_RING.split(' '))).toEqual([]);
  });

  it('is on every element of the overlays and chat rows that can take the focus', () => {
    render(
      <ToastProvider closeLabel="Cerrar aviso">
        <ShowErrorToast />
        <ChatRow name="Ana Torres" avatar={{ initials: 'AT' }} onClick={() => {}} />
        <Menu label="Opciones del mensaje" items={[{ id: 'copy', label: 'Copiar', onSelect: () => {} }]} />
        <Dialog open onClose={() => {}} title="Contactos" closeLabel="Cerrar" />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Opciones del mensaje' }));
    const focusable = [...focusableWithin(document.body), ...screen.getAllByRole('menuitem')];
    expect(focusable).toHaveLength(6);
    expect(missingClasses(focusable, RING)).toEqual([]);
  });

  it('is defined once in the library, in src/ui/focus.ts', () => {
    const definitions = Object.entries(SOURCES).flatMap(([key, source]) =>
      [...source.matchAll(RING_DEFINITION)].map(match => `src/ui/${key.slice(2)}: ${match[1]}`),
    );
    expect(definitions).toEqual(['src/ui/focus.ts: FOCUS_RING', 'src/ui/focus.ts: FOCUS_RING_INSET']);
  });
});
