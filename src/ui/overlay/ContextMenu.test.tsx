// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Copy, Reply, Trash2 } from 'lucide-react';
import { placeMenu, useContextMenu, type ContextMenuBuild } from './ContextMenu';
import type { MenuEntry } from './menu-parts';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function entries(spies: Record<string, () => void> = {}): MenuEntry[] {
  const spy = (id: string) => spies[id] ?? (() => {});
  return [
    { id: 'reply', label: 'Responder', icon: Reply, onSelect: spy('reply') },
    { id: 'copy', label: 'Copiar selección', icon: Copy, shortcut: { label: 'Ctrl + C', keys: 'Control+C' }, onSelect: spy('copy') },
    { id: 'sep', separator: true },
    { id: 'delete', label: 'Borrar para mí', icon: Trash2, tone: 'danger', onSelect: spy('delete') },
  ];
}

const always: ContextMenuBuild = () => ({ label: 'Opciones del mensaje', entries: entries() });

function Area({ build = always, onKeyDown }: { build?: ContextMenuBuild; onKeyDown?: () => void }) {
  const { triggerProps, menu } = useContextMenu(build);
  return (
    // The parent's own key handler, to see what the menu lets through.
    <div onKeyDown={onKeyDown}>
      <div data-testid="area" {...triggerProps}>
        <p>Texto del mensaje</p>
        <button type="button">Foco</button>
        <input aria-label="Campo" />
      </div>
      {menu}
      <button type="button">Fuera</button>
    </div>
  );
}

const area = () => screen.getByTestId('area');
const text = () => screen.getByText('Texto del mensaje');
const focusButton = () => screen.getByRole('button', { name: 'Foco' });
const outside = () => screen.getByRole('button', { name: 'Fuera' });
const item = (name: string) => screen.getByRole('menuitem', { name });
const menu = () => screen.queryByRole('menu');
const press = (key: string, init: KeyboardEventInit = {}) =>
  fireEvent.keyDown(document.activeElement ?? document.body, { key, ...init });
const classesOf = (element: Element) => (element.getAttribute('class') ?? '').split(/\s+/);
const popup = () => document.querySelector<HTMLElement>('[data-context-menu]')!;

function rect(left: number, top: number, width: number, height: number): DOMRect {
  return { left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) } as DOMRect;
}

/** The popup measures 200 × 300; "Foco" sits at (100, 600), 120 × 40. jsdom's window is 1024 × 768. */
function mockSizes() {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    if (this.hasAttribute('data-context-menu')) return rect(0, 0, 200, 300);
    if (this.textContent === 'Foco') return rect(100, 600, 120, 40);
    return rect(0, 0, 0, 0);
  });
}

describe('placeMenu', () => {
  const view = { width: 1024, height: 768 };
  const size = { width: 200, height: 300 };
  const point = (x: number, y: number) => ({ left: x, top: y, right: x, bottom: y });

  it('opens at the point, to the right and below, when it fits', () => {
    expect(placeMenu(point(100, 100), size, view)).toEqual({ left: 100, top: 100 });
  });

  it('flips to the left of the point when it would leave the window on the right', () => {
    expect(placeMenu(point(1000, 100), size, view)).toEqual({ left: 800, top: 100 });
  });

  it('flips above the point when it would leave the window at the bottom', () => {
    expect(placeMenu(point(100, 700), size, view)).toEqual({ left: 100, top: 400 });
  });

  it('opens under an element, and over it when there is no room under it', () => {
    const element = { left: 100, top: 600, right: 220, bottom: 640 };
    expect(placeMenu({ left: 100, top: 40, right: 220, bottom: 80 }, size, view)).toEqual({ left: 100, top: 80 });
    expect(placeMenu(element, size, view)).toEqual({ left: 100, top: 300 });
  });

  it('stays inside the window, 8 px from its edges, when neither side has room', () => {
    expect(placeMenu(point(500, 200), { width: 200, height: 700 }, view)).toEqual({ left: 500, top: 60 });
    expect(placeMenu(point(5, 5), size, view)).toEqual({ left: 8, top: 8 });
    expect(placeMenu(point(100, 100), { width: 2000, height: 2000 }, view)).toEqual({ left: 8, top: 8 });
  });
});

describe('useContextMenu', () => {
  it('opens on a right-click, named by its label, with the focus on the first item, and takes the native menu', () => {
    render(<Area />);
    const shown = fireEvent.contextMenu(text(), { clientX: 40, clientY: 50 });
    expect(shown).toBe(false);
    expect(screen.getByRole('menu', { name: 'Opciones del mensaje' })).toBeTruthy();
    expect(document.activeElement).toBe(item('Responder'));
  });

  it('opens at the pointer, and flips to stay inside the window', () => {
    mockSizes();
    render(<Area />);
    fireEvent.contextMenu(text(), { clientX: 40, clientY: 50 });
    expect([popup().style.left, popup().style.top]).toEqual(['40px', '50px']);
    press('Escape');
    fireEvent.contextMenu(text(), { clientX: 1000, clientY: 700 });
    expect([popup().style.left, popup().style.top]).toEqual(['800px', '400px']);
  });

  it('passes what was right-clicked to the menu it builds', () => {
    const build = vi.fn<ContextMenuBuild>(() => ({ label: 'Opciones', entries: entries() }));
    render(<Area build={build} />);
    fireEvent.contextMenu(text());
    expect(build).toHaveBeenCalledWith(text());
  });

  it('opens nothing, and leaves the event alone, where the screen has no menu', () => {
    render(<Area build={() => null} />);
    expect(fireEvent.contextMenu(text())).toBe(true);
    expect(menu()).toBeNull();
  });

  it('leaves a text field its native menu', () => {
    render(<Area />);
    expect(fireEvent.contextMenu(screen.getByRole('textbox', { name: 'Campo' }))).toBe(true);
    expect(menu()).toBeNull();
  });

  it('leaves a right-click that an inner menu already took', () => {
    render(<Area />);
    text().addEventListener('contextmenu', event => event.preventDefault());
    fireEvent.contextMenu(text());
    expect(menu()).toBeNull();
  });

  it.each([
    ['Shift + F10', { key: 'F10', shiftKey: true }],
    ['the menu key', { key: 'ContextMenu' }],
  ])('opens with %s under the focused element, with the focus on the first item', (_, init) => {
    mockSizes();
    render(<Area />);
    focusButton().focus();
    expect(fireEvent.keyDown(focusButton(), init)).toBe(false);
    expect(document.activeElement).toBe(item('Responder'));
    // "Foco" ends at 640, and 300 more would leave the window: the menu goes over it.
    expect([popup().style.left, popup().style.top]).toEqual(['100px', '300px']);
  });

  it('takes the key-up of the menu key, which Windows turns into a native menu', () => {
    render(<Area />);
    focusButton().focus();
    fireEvent.keyDown(focusButton(), { key: 'ContextMenu' });
    expect(fireEvent.keyUp(document.activeElement!, { key: 'ContextMenu' })).toBe(false);
  });

  it('ignores F10 with Ctrl and the menu key in a text field', () => {
    render(<Area />);
    focusButton().focus();
    expect(fireEvent.keyDown(focusButton(), { key: 'F10', shiftKey: true, ctrlKey: true })).toBe(true);
    const field = screen.getByRole('textbox', { name: 'Campo' });
    field.focus();
    expect(fireEvent.keyDown(field, { key: 'ContextMenu' })).toBe(true);
    expect(menu()).toBeNull();
  });

  it('moves with the arrows, wraps, and jumps with Home and End, past the separator', () => {
    render(<Area />);
    fireEvent.contextMenu(text());
    press('ArrowDown');
    expect(document.activeElement).toBe(item('Copiar selección'));
    press('ArrowDown');
    expect(document.activeElement).toBe(item('Borrar para mí'));
    press('ArrowDown');
    expect(document.activeElement).toBe(item('Responder'));
    press('ArrowUp');
    expect(document.activeElement).toBe(item('Borrar para mí'));
    press('Home');
    expect(document.activeElement).toBe(item('Responder'));
    press('End');
    expect(document.activeElement).toBe(item('Borrar para mí'));
    expect(screen.getAllByRole('separator')).toHaveLength(1);
  });

  it('chooses an item, closes, and gives the focus back before the item acts', () => {
    let focusedWhenChosen: Element | null = null;
    const reply = vi.fn(() => {
      focusedWhenChosen = document.activeElement;
    });
    render(<Area build={() => ({ label: 'Opciones', entries: entries({ reply }) })} />);
    focusButton().focus();
    press('F10', { shiftKey: true });
    fireEvent.click(item('Responder'));
    expect(reply).toHaveBeenCalledTimes(1);
    expect(menu()).toBeNull();
    expect(focusedWhenChosen).toBe(focusButton());
  });

  it('closes on Escape, gives the focus back, and keeps the key from the screen around it', () => {
    const parentKeys = vi.fn();
    render(<Area onKeyDown={parentKeys} />);
    focusButton().focus();
    press('ContextMenu');
    parentKeys.mockClear();
    press('Escape');
    expect(menu()).toBeNull();
    expect(document.activeElement).toBe(focusButton());
    expect(parentKeys).not.toHaveBeenCalled();
  });

  it('gives the focus back to what had it before a right-click', () => {
    render(<Area />);
    focusButton().focus();
    fireEvent.contextMenu(text());
    press('Escape');
    expect(document.activeElement).toBe(focusButton());
  });

  it('closes on Tab and gives the focus back', () => {
    render(<Area />);
    focusButton().focus();
    press('ContextMenu');
    expect(press('Tab')).toBe(false);
    expect(menu()).toBeNull();
    expect(document.activeElement).toBe(focusButton());
  });

  it('closes on a click outside, but not on one inside', () => {
    render(<Area />);
    fireEvent.contextMenu(text());
    fireEvent.mouseDown(item('Copiar selección'));
    expect(menu()).not.toBeNull();
    fireEvent.mouseDown(outside());
    expect(menu()).toBeNull();
  });

  it('takes a right-click inside the open menu without opening another', () => {
    const build = vi.fn(always);
    render(<Area build={build} />);
    fireEvent.contextMenu(text());
    expect(fireEvent.contextMenu(item('Copiar selección'))).toBe(false);
    expect(build).toHaveBeenCalledTimes(1);
    expect(menu()).not.toBeNull();
  });

  it.each([
    ['a scroll', () => fireEvent.scroll(area())],
    ['a resize', () => fireEvent(window, new Event('resize'))],
    ['the window losing the focus', () => fireEvent(window, new Event('blur'))],
  ])('closes on %s and gives the focus back', (_, act) => {
    render(<Area />);
    focusButton().focus();
    press('F10', { shiftKey: true });
    act();
    expect(menu()).toBeNull();
    expect(document.activeElement).toBe(focusButton());
  });

  it('stays open when the menu itself scrolls', () => {
    render(<Area />);
    fireEvent.contextMenu(text());
    fireEvent.scroll(popup());
    expect(menu()).not.toBeNull();
  });

  it('draws 44 px items with a 16 px icon each, the danger item in red, and the shortcut as a hint', () => {
    render(<Area />);
    fireEvent.contextMenu(text());
    for (const menuItem of screen.getAllByRole('menuitem')) {
      expect(classesOf(menuItem)).toContain('min-h-11');
      expect(classesOf(menuItem.querySelector('svg')!)).toContain('size-[1rem]');
    }
    expect(classesOf(item('Borrar para mí'))).toContain('text-ui-danger');
    expect(classesOf(item('Responder'))).not.toContain('text-ui-danger');
    const copy = item('Copiar selección');
    expect(copy.getAttribute('aria-keyshortcuts')).toBe('Control+C');
    expect(screen.getByText('Ctrl + C').getAttribute('aria-hidden')).toBe('true');
  });

  it('keeps a marked item under forced colours, and takes the control line for its border in Terminal', () => {
    render(<Area />);
    fireEvent.contextMenu(text());
    expect(classesOf(popup())).toEqual(expect.arrayContaining(['border-ui-line', 'terminal:border-ui-control-line']));
    expect(classesOf(item('Responder'))).toContain('forced-colors:focus:outline-[color:Highlight]');
  });
});
