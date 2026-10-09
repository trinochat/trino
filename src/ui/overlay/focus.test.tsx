// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useEffect } from 'react';
import { ChatRow } from '../chat/ChatRow';
import { Dialog } from './Dialog';
import { focusableWithin } from './focus';
import { Menu } from './Menu';
import { ToastProvider, useToast } from './Toast';

afterEach(cleanup);

/** The ring the controls use too: an outline in the accent text colour, without the legacy glow. */
const RING = [
  'focus-visible:outline',
  'focus-visible:outline-2',
  'focus-visible:outline-ui-accent-text',
  'focus-visible:shadow-none',
];

function ShowErrorToast() {
  const toast = useToast();
  useEffect(() => {
    toast.show({ tone: 'error', text: 'Sin conexión', actionLabel: 'Reintentar', onAction: () => {} });
  }, [toast]);
  return null;
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
    expect(focusable.length).toBe(6);
    for (const element of focusable) {
      const classes = (element.getAttribute('class') ?? '').split(/\s+/);
      for (const token of RING) expect(classes, element.outerHTML).toContain(token);
    }
  });
});
