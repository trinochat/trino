// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ToastProvider, useToast, type ToastApi, type ToastOptions } from './Toast';

let api: ToastApi;

function CaptureApi() {
  api = useToast();
  return null;
}

function renderProvider() {
  render(
    <ToastProvider closeLabel="Cerrar aviso">
      <CaptureApi />
    </ToastProvider>,
  );
}

const show = (options: ToastOptions) => act(() => void api.show(options));
const advance = (ms: number) => act(() => void vi.advanceTimersByTime(ms));
const politeRegion = () => document.querySelector<HTMLElement>('[aria-live="polite"]');
/** The toast card that holds this text. */
const toast = (text: string) => screen.getByText(text).closest<HTMLElement>('[data-toast]');
const classesOf = (element: Element | null) => (element?.getAttribute('class') ?? '').split(/\s+/);

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('Toast', () => {
  it('announces info toasts in a polite live region and removes them after 5 s', () => {
    renderProvider();
    show({ tone: 'info', text: 'Código copiado' });
    expect(politeRegion()?.textContent).toContain('Código copiado');
    advance(4999);
    expect(screen.queryByText('Código copiado')).not.toBeNull();
    advance(1);
    expect(screen.queryByText('Código copiado')).toBeNull();
  });

  it('puts success toasts in the same region and honours durationMs', () => {
    renderProvider();
    show({ tone: 'success', text: 'Contacto agregado', durationMs: 2000 });
    expect(politeRegion()?.textContent).toContain('Contacto agregado');
    advance(1999);
    expect(screen.queryByText('Contacto agregado')).not.toBeNull();
    advance(1);
    expect(screen.queryByText('Contacto agregado')).toBeNull();
  });

  it('shows errors as alerts outside the polite region that stay until closed', () => {
    renderProvider();
    show({ tone: 'error', text: 'No se pudo enviar la imagen', durationMs: 1000 });
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('No se pudo enviar la imagen');
    expect(politeRegion()?.contains(alert)).toBe(false);
    advance(60_000);
    expect(screen.queryByText('No se pudo enviar la imagen')).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Cerrar aviso' }));
    expect(screen.queryByText('No se pudo enviar la imagen')).toBeNull();
  });

  it('lets a toast override the close label of the provider', () => {
    renderProvider();
    show({ tone: 'error', text: 'Sin conexión', closeLabel: 'Descartar' });
    expect(screen.getByRole('button', { name: 'Descartar' })).not.toBeNull();
  });

  it('shows at most three toasts, the newest ones', () => {
    renderProvider();
    for (const text of ['Uno', 'Dos', 'Tres', 'Cuatro']) show({ tone: 'info', text });
    expect(screen.queryByText('Uno')).toBeNull();
    for (const text of ['Dos', 'Tres', 'Cuatro']) expect(screen.queryByText(text)).not.toBeNull();
  });

  it('keeps an error that newer toasts pushed out, and shows it again when they go', () => {
    renderProvider();
    show({ tone: 'error', text: 'No se pudo enviar' });
    for (const text of ['Uno', 'Dos', 'Tres']) show({ tone: 'info', text });
    expect(screen.queryByText('No se pudo enviar')).toBeNull();
    advance(5000);
    expect(screen.getByRole('alert').textContent).toContain('No se pudo enviar');
  });

  it('runs the action and dismisses the toast', () => {
    const onAction = vi.fn();
    renderProvider();
    show({ tone: 'info', text: 'Mensaje borrado', actionLabel: 'Deshacer', onAction });
    fireEvent.click(screen.getByRole('button', { name: 'Deshacer' }));
    expect(onAction).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('Mensaje borrado')).toBeNull();
  });

  it('pauses the countdown while the pointer is over the toast', () => {
    renderProvider();
    show({ tone: 'info', text: 'Mensaje borrado', actionLabel: 'Deshacer', onAction: () => {} });
    advance(1000);
    fireEvent.mouseEnter(toast('Mensaje borrado')!);
    advance(10_000);
    expect(screen.queryByText('Mensaje borrado')).not.toBeNull();
    fireEvent.mouseLeave(toast('Mensaje borrado')!);
    advance(3999);
    expect(screen.queryByText('Mensaje borrado')).not.toBeNull();
    advance(1);
    expect(screen.queryByText('Mensaje borrado')).toBeNull();
  });

  it('pauses the countdown while focus is inside the toast', () => {
    renderProvider();
    show({ tone: 'info', text: 'Mensaje borrado', actionLabel: 'Deshacer', onAction: () => {} });
    act(() => screen.getByRole('button', { name: 'Deshacer' }).focus());
    advance(10_000);
    expect(screen.queryByText('Mensaje borrado')).not.toBeNull();
    act(() => screen.getByRole('button', { name: 'Deshacer' }).blur());
    advance(5000);
    expect(screen.queryByText('Mensaje borrado')).toBeNull();
  });

  it('dismisses a toast by the id show returned', () => {
    renderProvider();
    let id = '';
    act(() => {
      id = api.show({ tone: 'error', text: 'Sin conexión' });
    });
    expect(screen.queryByText('Sin conexión')).not.toBeNull();
    act(() => api.dismiss(id));
    expect(screen.queryByText('Sin conexión')).toBeNull();
  });

  it('marks errors with the danger background and the rest with the surface', () => {
    renderProvider();
    show({ tone: 'error', text: 'Sin conexión' });
    show({ tone: 'success', text: 'Guardado' });
    expect(classesOf(toast('Sin conexión'))).toContain('bg-ui-danger-bg');
    expect(classesOf(toast('Guardado'))).toContain('bg-ui-surface');
  });
});
