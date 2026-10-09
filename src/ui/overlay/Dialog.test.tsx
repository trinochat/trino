// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { useRef, useState } from 'react';
import { Dialog, type DialogProps } from './Dialog';

afterEach(cleanup);

const noop = () => {};

/** A screen with a button that opens the dialog, the way the app uses it. */
function Page(props: Partial<DialogProps>) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Abrir
      </button>
      <Dialog title="Contactos" {...props} open={open} onClose={() => setOpen(false)}>
        <button type="button">Primero</button>
        <button type="button">Último</button>
      </Dialog>
    </>
  );
}

/** Opens the page's dialog; a real click also focuses the button, fireEvent does not. */
function openFromButton() {
  const opener = screen.getByRole('button', { name: 'Abrir' });
  opener.focus();
  fireEvent.click(opener);
  return opener;
}

const scrim = () => document.querySelector<HTMLElement>('[data-scrim]');
const press = (key: string, init: KeyboardEventInit = {}) =>
  fireEvent.keyDown(document.activeElement ?? document.body, { key, ...init });
const classesOf = (element: Element | null) => (element?.getAttribute('class') ?? '').split(/\s+/);

describe('Dialog', () => {
  it('renders nothing while closed', () => {
    render(<Dialog open={false} onClose={noop} title="Contactos" />);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('is a modal dialog named by its title and described by its description', () => {
    render(<Dialog open onClose={noop} title="Contactos" description="Pega el código de la otra persona." />);
    const dialog = screen.getByRole('dialog', { name: 'Contactos' });
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    const description = document.getElementById(dialog.getAttribute('aria-describedby') ?? '');
    expect(description?.textContent).toBe('Pega el código de la otra persona.');
  });

  it('can be an alertdialog', () => {
    render(<Dialog open onClose={noop} role="alertdialog" title="¿Borrar la identidad?" />);
    const dialog = screen.getByRole('alertdialog', { name: '¿Borrar la identidad?' });
    expect(dialog.getAttribute('aria-modal')).toBe('true');
  });

  it('can be named and described by elements the screen renders itself', () => {
    render(
      <Dialog open onClose={noop} labelledBy="h-in" describedBy="d-in">
        <h2 id="h-in">Ana Torres</h2>
        <p id="d-in">Videollamada entrante</p>
      </Dialog>,
    );
    const dialog = screen.getByRole('dialog', { name: 'Ana Torres' });
    expect(dialog.getAttribute('aria-describedby')).toBe('d-in');
  });

  it('focuses the first focusable element on open', () => {
    render(<Page />);
    openFromButton();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Primero' }));
  });

  it('focuses the element passed as initialFocusRef', () => {
    function WithInitialFocus() {
      const last = useRef<HTMLButtonElement>(null);
      return (
        <Dialog open onClose={noop} title="Contactos" initialFocusRef={last}>
          <button type="button">Primero</button>
          <button type="button" ref={last}>
            Último
          </button>
        </Dialog>
      );
    }
    render(<WithInitialFocus />);
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Último' }));
  });

  it('focuses the dialog itself when nothing inside can take focus, and keeps it there on Tab', () => {
    render(
      <Dialog open onClose={noop} title="Contactos">
        <p>Sin controles</p>
      </Dialog>,
    );
    const dialog = screen.getByRole('dialog');
    expect(document.activeElement).toBe(dialog);
    press('Tab');
    expect(document.activeElement).toBe(dialog);
  });

  it('traps Tab: from the last element to the first, and back with Shift+Tab', () => {
    render(<Page />);
    openFromButton();
    const first = screen.getByRole('button', { name: 'Primero' });
    const last = screen.getByRole('button', { name: 'Último' });
    last.focus();
    press('Tab');
    expect(document.activeElement).toBe(first);
    press('Tab', { shiftKey: true });
    expect(document.activeElement).toBe(last);
  });

  it('skips disabled controls when trapping Tab', () => {
    render(
      <Dialog open onClose={noop} title="Contactos">
        <button type="button">Primero</button>
        <button type="button">Segundo</button>
        <button type="button" disabled>
          Desactivado
        </button>
      </Dialog>,
    );
    screen.getByRole('button', { name: 'Segundo' }).focus();
    press('Tab');
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Primero' }));
  });

  it('brings focus back inside when it has escaped to the page behind', () => {
    render(<Page />);
    const opener = openFromButton();
    opener.focus();
    press('Tab');
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Primero' }));
  });

  it('closes on Escape and gives focus back to the opener', () => {
    render(<Page />);
    const opener = openFromButton();
    expect(screen.getByRole('dialog').contains(document.activeElement)).toBe(true);
    press('Escape');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it('ignores Escape when closeOnEscape is false', () => {
    render(<Page closeOnEscape={false} />);
    openFromButton();
    press('Escape');
    expect(screen.queryByRole('dialog')).not.toBeNull();
  });

  it('closes on a scrim click when closeOnScrimClick is on', () => {
    const onClose = vi.fn();
    render(<Dialog open onClose={onClose} title="Contactos" closeOnScrimClick />);
    fireEvent.click(scrim()!);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('ignores scrim clicks when closeOnScrimClick is off', () => {
    const onClose = vi.fn();
    render(<Dialog open onClose={onClose} title="Contactos" closeOnScrimClick={false} />);
    fireEvent.click(scrim()!);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('closes on scrim clicks by default, but an alertdialog waits for an explicit answer', () => {
    const onClose = vi.fn();
    const { rerender } = render(<Dialog open onClose={onClose} title="Contactos" />);
    fireEvent.click(scrim()!);
    expect(onClose).toHaveBeenCalledTimes(1);
    rerender(<Dialog open onClose={onClose} role="alertdialog" title="¿Borrar la identidad?" />);
    fireEvent.click(scrim()!);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('does not close on clicks inside the panel', () => {
    const onClose = vi.fn();
    render(
      <Dialog open onClose={onClose} title="Contactos">
        <p>Texto</p>
      </Dialog>,
    );
    fireEvent.click(screen.getByText('Texto'));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('offers a close button only when given its label', () => {
    const onClose = vi.fn();
    const { rerender } = render(<Dialog open onClose={onClose} title="Contactos" />);
    expect(screen.queryByRole('button')).toBeNull();
    rerender(<Dialog open onClose={onClose} title="Contactos" closeLabel="Cerrar" />);
    fireEvent.click(screen.getByRole('button', { name: 'Cerrar' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('puts the close button last in the Tab order, so the content gets the first focus', () => {
    render(<Page closeLabel="Cerrar" />);
    openFromButton();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Primero' }));
    const names = within(screen.getByRole('dialog'))
      .getAllByRole('button')
      .map(button => button.getAttribute('aria-label') ?? button.textContent);
    expect(names).toEqual(['Primero', 'Último', 'Cerrar']);
    screen.getByRole('button', { name: 'Cerrar' }).focus();
    press('Tab');
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Primero' }));
  });

  it('closes only the topmost of two stacked dialogs on Escape', () => {
    const closeOuter = vi.fn();
    const closeInner = vi.fn();
    render(
      <>
        <Dialog open onClose={closeOuter} title="Ajustes">
          <button type="button">Fuera</button>
        </Dialog>
        <Dialog open onClose={closeInner} role="alertdialog" title="¿Seguro?">
          <button type="button">Dentro</button>
        </Dialog>
      </>,
    );
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Dentro' }));
    press('Escape');
    expect(closeInner).toHaveBeenCalledTimes(1);
    expect(closeOuter).not.toHaveBeenCalled();
  });

  it('draws the panel with the surface, border and large radius tokens', () => {
    render(<Dialog open onClose={noop} title="Contactos" />);
    const classes = classesOf(screen.getByRole('dialog'));
    for (const token of ['bg-ui-surface', 'border', 'border-ui-line', 'rounded-ui-lg']) {
      expect(classes).toContain(token);
    }
  });

  it('dims the page with tokens only: ink in light mode, the outer colour in dark mode', () => {
    render(<Dialog open onClose={noop} title="Contactos" />);
    const classes = classesOf(scrim());
    expect(classes).toContain('bg-ui-ink');
    expect(classes).toContain('[[data-mode=dark]_&]:bg-ui-outer');
    expect(scrim()?.getAttribute('aria-hidden')).toBe('true');
  });
});
