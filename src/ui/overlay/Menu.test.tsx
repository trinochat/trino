// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Dialog } from './Dialog';
import { Menu, type MenuItem } from './Menu';

afterEach(cleanup);

const FOOTNOTE = 'Se borra en el equipo de Ana y se pide a los relays que lo eliminen.';

function messageItems(spies: Record<string, () => void> = {}): MenuItem[] {
  const spy = (id: string) => spies[id] ?? (() => {});
  return [
    { id: 'reply', label: 'Responder', onSelect: spy('reply') },
    { id: 'copy', label: 'Copiar', onSelect: spy('copy') },
    { id: 'delete-mine', label: 'Borrar para mí', onSelect: spy('delete-mine') },
    {
      id: 'delete-all',
      label: 'Borrar para todos',
      tone: 'danger',
      onSelect: spy('delete-all'),
      describedByFootnote: true,
    },
  ];
}

function renderMenu(items = messageItems(), footnote?: string) {
  return render(
    <>
      <Menu label="Opciones del mensaje" items={items} footnote={footnote} />
      <button type="button">Fuera</button>
    </>,
  );
}

const trigger = () => screen.getByRole('button', { name: 'Opciones del mensaje' });
const item = (name: string) => screen.getByRole('menuitem', { name });
const press = (key: string, init: KeyboardEventInit = {}) =>
  fireEvent.keyDown(document.activeElement ?? document.body, { key, ...init });
const classesOf = (element: Element) => (element.getAttribute('class') ?? '').split(/\s+/);

describe('Menu', () => {
  it('is a menu button that starts closed', () => {
    renderMenu();
    expect(trigger().getAttribute('aria-haspopup')).toBe('menu');
    expect(trigger().getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('opens on click, named by its trigger, with focus on the first item', () => {
    renderMenu();
    fireEvent.click(trigger());
    const menu = screen.getByRole('menu', { name: 'Opciones del mensaje' });
    expect(trigger().getAttribute('aria-expanded')).toBe('true');
    expect(trigger().getAttribute('aria-controls')).toBe(menu.id);
    expect(document.activeElement).toBe(item('Responder'));
  });

  it('moves with the arrow keys and wraps at both ends', () => {
    renderMenu();
    fireEvent.click(trigger());
    press('ArrowDown');
    expect(document.activeElement).toBe(item('Copiar'));
    press('ArrowUp');
    expect(document.activeElement).toBe(item('Responder'));
    press('ArrowUp');
    expect(document.activeElement).toBe(item('Borrar para todos'));
    press('ArrowDown');
    expect(document.activeElement).toBe(item('Responder'));
  });

  it('jumps to the last item with End and to the first with Home', () => {
    renderMenu();
    fireEvent.click(trigger());
    press('End');
    expect(document.activeElement).toBe(item('Borrar para todos'));
    press('Home');
    expect(document.activeElement).toBe(item('Responder'));
  });

  it('opens from the keyboard: ArrowDown on the trigger focuses the first item, ArrowUp the last', () => {
    renderMenu();
    trigger().focus();
    press('ArrowDown');
    expect(document.activeElement).toBe(item('Responder'));
    press('Escape');
    expect(document.activeElement).toBe(trigger());
    press('ArrowUp');
    expect(document.activeElement).toBe(item('Borrar para todos'));
  });

  it('closes on Escape and returns focus to the trigger', () => {
    renderMenu();
    fireEvent.click(trigger());
    press('Escape');
    expect(screen.queryByRole('menu')).toBeNull();
    expect(trigger().getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(trigger());
  });

  it('calls onSelect of the chosen item, closes and returns focus to the trigger', () => {
    const copy = vi.fn();
    const reply = vi.fn();
    renderMenu(messageItems({ copy, reply }));
    fireEvent.click(trigger());
    fireEvent.click(item('Copiar'));
    expect(copy).toHaveBeenCalledTimes(1);
    expect(reply).not.toHaveBeenCalled();
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(trigger());
  });

  it('closes on Tab', () => {
    renderMenu();
    fireEvent.click(trigger());
    press('Tab');
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('closes on a click outside, but not on one inside', () => {
    renderMenu(messageItems(), FOOTNOTE);
    fireEvent.click(trigger());
    fireEvent.mouseDown(screen.getByText(FOOTNOTE));
    expect(screen.queryByRole('menu')).not.toBeNull();
    fireEvent.mouseDown(screen.getByRole('button', { name: 'Fuera' }));
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('closes when the trigger is clicked again', () => {
    renderMenu();
    fireEvent.click(trigger());
    fireEvent.click(trigger());
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('gives danger items the danger tone and every item a 44 px target', () => {
    renderMenu();
    fireEvent.click(trigger());
    expect(classesOf(item('Borrar para todos'))).toContain('text-ui-danger');
    expect(classesOf(item('Copiar'))).not.toContain('text-ui-danger');
    for (const menuItem of screen.getAllByRole('menuitem')) {
      expect(classesOf(menuItem)).toContain('min-h-[44px]');
    }
  });

  it('shows the footnote under the items and links it to the item it explains', () => {
    renderMenu(messageItems(), FOOTNOTE);
    fireEvent.click(trigger());
    const footnote = screen.getByText(FOOTNOTE);
    expect(screen.getByRole('menu').contains(footnote)).toBe(false);
    expect(item('Borrar para todos').getAttribute('aria-describedby')).toBe(footnote.id);
    expect(item('Copiar').getAttribute('aria-describedby')).toBeNull();
  });

  it('describes the whole menu with the footnote when no item claims it', () => {
    const items = messageItems().map(({ describedByFootnote: _, ...rest }) => rest);
    renderMenu(items, FOOTNOTE);
    fireEvent.click(trigger());
    expect(screen.getByRole('menu').getAttribute('aria-describedby')).toBe(screen.getByText(FOOTNOTE).id);
  });

  it('closes only itself on Escape inside a dialog', () => {
    const closeDialog = vi.fn();
    render(
      <Dialog open onClose={closeDialog} title="Mensaje">
        <Menu label="Opciones del mensaje" items={messageItems()} />
      </Dialog>,
    );
    fireEvent.click(trigger());
    press('Escape');
    expect(screen.queryByRole('menu')).toBeNull();
    expect(closeDialog).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(trigger());
  });
});
