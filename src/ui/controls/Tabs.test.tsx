// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Tabs, type TabItem } from './Tabs';

afterEach(cleanup);

type ContactTab = 'add' | 'share' | 'invites';

const ITEMS: readonly TabItem<ContactTab>[] = [
  { value: 'add', label: 'Agregar', panel: <p>Pega el código de la otra persona.</p> },
  { value: 'share', label: 'Mi código', panel: <p>Este es tu código.</p> },
  { value: 'invites', label: 'Invitaciones', panel: <p>No tienes invitaciones.</p> },
];

function ContactTabs({ initial = 'add' }: { initial?: ContactTab }) {
  const [tab, setTab] = useState<ContactTab>(initial);
  return <Tabs aria-label="Opciones de contacto" items={ITEMS} value={tab} onValueChange={setTab} />;
}

const tabs = () => screen.getAllByRole('tab');
const selectedStates = () => tabs().map(tab => tab.getAttribute('aria-selected'));

describe('Tabs', () => {
  it('is a named tab list whose tabs and panels point at each other', () => {
    const { container } = render(<ContactTabs />);
    expect(screen.getByRole('tablist', { name: 'Opciones de contacto' })).toBeTruthy();
    expect(tabs().map(tab => tab.textContent)).toEqual(['Agregar', 'Mi código', 'Invitaciones']);
    const panels = Array.from(container.querySelectorAll('[role="tabpanel"]'));
    expect(panels).toHaveLength(3);
    tabs().forEach((tab, index) => {
      expect(tab.id).not.toBe('');
      expect(tab.getAttribute('aria-controls')).toBe(panels[index].id);
      expect(panels[index].getAttribute('aria-labelledby')).toBe(tab.id);
    });
  });

  it('shows only the panel of the selected tab, named by that tab', () => {
    render(<ContactTabs />);
    expect(selectedStates()).toEqual(['true', 'false', 'false']);
    expect(screen.getAllByRole('tabpanel')).toHaveLength(1);
    expect(screen.getByRole('tabpanel', { name: 'Agregar' }).textContent).toBe('Pega el código de la otra persona.');
    expect(screen.queryByText('Este es tu código.')).toBeNull();
  });

  it('activates a tab on click', () => {
    render(<ContactTabs />);
    fireEvent.click(screen.getByRole('tab', { name: 'Mi código' }));
    expect(selectedStates()).toEqual(['false', 'true', 'false']);
    expect(screen.getByRole('tabpanel', { name: 'Mi código' }).textContent).toBe('Este es tu código.');
  });

  it('moves the focus and activates with the left and right arrows, wrapping around', () => {
    render(<ContactTabs />);
    const [add, share, invites] = tabs();
    add.focus();
    fireEvent.keyDown(add, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(share);
    expect(selectedStates()).toEqual(['false', 'true', 'false']);
    expect(screen.getByRole('tabpanel').textContent).toBe('Este es tu código.');
    fireEvent.keyDown(share, { key: 'ArrowRight' });
    fireEvent.keyDown(invites, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(add);
    fireEvent.keyDown(add, { key: 'ArrowLeft' });
    expect(document.activeElement).toBe(invites);
    expect(selectedStates()).toEqual(['false', 'false', 'true']);
  });

  it('goes to the first and the last tab with Home and End', () => {
    render(<ContactTabs initial="share" />);
    const [add, share, invites] = tabs();
    share.focus();
    fireEvent.keyDown(share, { key: 'End' });
    expect(document.activeElement).toBe(invites);
    fireEvent.keyDown(invites, { key: 'Home' });
    expect(document.activeElement).toBe(add);
    expect(selectedStates()).toEqual(['true', 'false', 'false']);
  });

  it('leaves the up and down arrows alone', () => {
    const onValueChange = vi.fn();
    render(<Tabs aria-label="Opciones" items={ITEMS} value="add" onValueChange={onValueChange} />);
    const [add] = tabs();
    add.focus();
    fireEvent.keyDown(add, { key: 'ArrowDown' });
    fireEvent.keyDown(add, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(add);
    expect(onValueChange).not.toHaveBeenCalled();
  });

  it('keeps one tab stop on the selected tab and lets the panel take the focus', () => {
    render(<ContactTabs initial="invites" />);
    expect(tabs().map(tab => tab.tabIndex)).toEqual([-1, -1, 0]);
    expect(screen.getByRole('tabpanel').tabIndex).toBe(0);
  });

  it('marks the selected tab with an accent indicator', () => {
    render(<ContactTabs />);
    const [selected, other] = tabs();
    // A border, not a background: forced colours keep it.
    expect(selected.classList).toContain('border-b-2');
    expect(selected.classList).toContain('border-ui-accent-text');
    expect(Array.from(selected.classList).filter(name => name.startsWith('after:bg-'))).toEqual([]);
    expect(selected.classList).toContain('text-ui-ink');
    expect(other.classList).not.toContain('border-ui-accent-text');
    expect(other.classList).toContain('text-ui-muted');
    // Forced colours paint a transparent border too: the others drop theirs.
    expect(other.classList).toContain('forced-colors:border-b-0');
  });

  // Reflow (accesibilidad.md §4.7): nothing scrolls sideways from 20 rem, the
  // width of a 640×480 window at 200 % text. There, "Agregar", "Mi código" and
  // "Invitaciones" did not fit in Contactos (review of W4): measured in Edge
  // with the bundled fonts, the last tab stuck out of the row by 35 px in
  // Spanish and by 7 to 10 px in Portuguese.
  it('wraps its tabs onto another row, and a label onto another line, before the row grows past its box', () => {
    render(<ContactTabs />);
    expect(screen.getByRole('tablist').classList).toContain('flex-wrap');
    for (const tab of tabs()) {
      // Each tab keeps its longest word on one row, but is never wider than the row.
      expect(tab.classList).toContain('max-w-full');
      expect(tab.classList).not.toContain('min-w-0');
      // A word longer than the whole row breaks inside its label.
      const label = tab.firstElementChild;
      expect(label?.textContent).toBe(tab.textContent);
      expect(label?.classList).toContain('min-w-0');
      expect(label?.classList).toContain('break-words');
    }
  });
});
