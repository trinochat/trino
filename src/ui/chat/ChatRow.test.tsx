// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ChatRow, type ChatRowProps } from './ChatRow';

afterEach(cleanup);

const classesOf = (element: Element | null) => (element?.getAttribute('class') ?? '').split(/\s+/);

function renderRow(props: Partial<ChatRowProps> = {}) {
  return render(
    <ChatRow
      name="Carlos Méndez"
      avatar={{ initials: 'CM' }}
      preview="Mañana te confirmo la hora"
      time="Ayer"
      onClick={() => {}}
      {...props}
    />,
  );
}

const row = () => screen.getByRole('button');

describe('ChatRow', () => {
  // `raised` is nearly the same colour as the sidebar in Terminal light, so the
  // selection is shown with the accent's soft tint plus an accent bar, which
  // keeps 3:1 against the row in every theme.
  it('is marked aria-current, tinted and given the accent bar when selected', () => {
    renderRow({ selected: true });
    expect(row().getAttribute('aria-current')).toBe('true');
    expect(classesOf(row())).toContain('bg-ui-accent-soft');
    const bar = row().querySelector('[data-selection-bar]');
    expect(bar).not.toBeNull();
    expect(bar?.getAttribute('aria-hidden')).toBe('true');
    expect(classesOf(bar)).toContain('bg-ui-accent-text');
  });

  it('has no aria-current, tint or accent bar when not selected', () => {
    renderRow();
    expect(row().getAttribute('aria-current')).toBeNull();
    expect(classesOf(row())).not.toContain('bg-ui-accent-soft');
    expect(row().querySelector('[data-selection-bar]')).toBeNull();
  });

  it('is at least 64 px tall and calls onClick', () => {
    const onClick = vi.fn();
    renderRow({ onClick });
    expect(classesOf(row())).toContain('min-h-[64px]');
    fireEvent.click(row());
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('shows the name and a one-line preview', () => {
    renderRow();
    expect(screen.getByText('Carlos Méndez')).not.toBeNull();
    const preview = screen.getByText('Mañana te confirmo la hora');
    expect(classesOf(preview)).toContain('truncate');
    expect(classesOf(preview)).toContain('text-ui-muted');
  });

  it('starts the preview with the draft prefix in the accent text colour', () => {
    renderRow({ draftPrefix: 'Borrador:' });
    const prefix = screen.getByText('Borrador:');
    expect(classesOf(prefix)).toContain('text-ui-accent-text');
    expect(classesOf(prefix)).toContain('font-semibold');
    expect(prefix.parentElement?.textContent).toBe('Borrador: Mañana te confirmo la hora');
  });

  it('shows the time in the mono font at 12 px', () => {
    renderRow();
    const time = screen.getByText('Ayer');
    for (const token of ['font-ui-mono', 'text-[12px]', 'text-ui-muted']) {
      expect(classesOf(time)).toContain(token);
    }
  });

  it('shows the unread badge with its screen-reader suffix, and nothing at 0', () => {
    const { rerender } = renderRow({ unread: { count: 3, label: 'sin leer' } });
    expect(screen.getByText('sin leer').parentElement?.textContent).toBe('3 sin leer');
    rerender(
      <ChatRow name="Carlos Méndez" avatar={{ initials: 'CM' }} unread={{ count: 0, label: 'sin leer' }} onClick={() => {}} />,
    );
    expect(screen.queryByText('sin leer')).toBeNull();
  });

  it('adds a compact trust badge whose label joins the row’s accessible name', () => {
    renderRow({ name: 'Ana Torres', trust: { kind: 'verified', label: 'Verificado' } });
    expect(screen.getByRole('button', { name: /Ana Torres.*Verificado/ })).not.toBeNull();
    expect(classesOf(screen.getByText('Verificado'))).toContain('sr-only');
  });

  it('uses a decorative 44 px avatar', () => {
    renderRow({ avatar: { initials: 'F', kind: 'group' } });
    const avatar = screen.getByText('F');
    expect(classesOf(avatar)).toContain('h-11');
    expect(avatar.getAttribute('aria-hidden')).toBe('true');
  });
});
