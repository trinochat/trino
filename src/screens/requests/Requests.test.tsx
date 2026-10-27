// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import type { ReactElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { I18nContext, makeT } from '../../lib/i18n';
import { LangCtx } from '../../lib/i18n-context';
import { RequestPane, type RequestPaneProps } from './RequestPane';
import { RequestsList, type RequestsListProps } from './RequestsList';
import { fakeRequestsApi, request, T0 } from './test-support';
import { useRequests } from './useRequests';

afterEach(cleanup);

function inSpanish(ui: ReactElement) {
  return render(
    <LangCtx.Provider value={{ lang: 'es', setLang: () => {} }}>
      <I18nContext.Provider value={makeT('es')}>{ui}</I18nContext.Provider>
    </LangCtx.Provider>,
  );
}

const MARA = request({
  key: 'cd'.repeat(32),
  name: 'mara',
  by_admin: true,
  via: { kind: 'group', gid: 'g1', group: 'Familia' },
  last_at: T0 - 86_400,
  items: [{ kind: 'text', text: 'Hola, ¿me pasas la dirección?', at: T0 - 86_400 }],
});
const ANA = request({ looks_like: 'Ana Torres' });

describe('useRequests', () => {
  it('reads the list, and again each time the count changes', async () => {
    const { api, emit, listening } = fakeRequestsApi({ requests: [ANA], overflow: 2 });
    const hook = renderHook(() => useRequests(api));
    await waitFor(() => expect(hook.result.current.requests).toEqual([ANA]));
    expect(hook.result.current.overflow).toBe(2);
    api.listRequests.mockResolvedValueOnce({ requests: [ANA, MARA], overflow: 0 });
    act(() => emit({ count: 2 }));
    await waitFor(() => expect(hook.result.current.requests).toHaveLength(2));
    hook.unmount();
    await act(async () => {});
    expect(listening()).toBe(0);
  });

  it('has nothing without the backend for it, and says when it could not read', async () => {
    const none = renderHook(() => useRequests(null));
    expect(none.result.current.requests).toEqual([]);
    const { api } = fakeRequestsApi();
    api.listRequests.mockRejectedValueOnce(new Error('sealed'));
    const hook = renderHook(() => useRequests(api));
    await waitFor(() => expect(hook.result.current.failed).toBe(true));
    await act(() => hook.result.current.refresh());
    expect(hook.result.current.failed).toBe(false);
  });
});

describe('RequestsList (PropSolicitudes cards 2, PropMovilSolicitudes card 2)', () => {
  function list(over: Partial<RequestsListProps> = {}) {
    const props: RequestsListProps = {
      requests: [ANA, MARA],
      overflow: 0,
      failed: false,
      selectedKey: null,
      now: T0 + 7_200,
      onOpen: vi.fn(),
      onBack: vi.fn(),
      onRetry: vi.fn(),
      ...over,
    };
    inSpanish(<RequestsList {...props} />);
    return props;
  }

  // UR-10 (PropMenoresPC card 7): an account of 16 or 17 gets only its links' redemptions, and is told so.
  it('says to an account of 16 or 17 that only the redemptions of its links come', () => {
    list({ onlyLinks: true });
    expect(
      screen.getByText('Solo te llegan las de quien usó tus enlaces. Nada de aquí suena ni se descarga hasta que aceptes.'),
    ).toBeTruthy();
    expect(screen.queryByText('No son tus contactos. Nada de aquí suena ni se descarga hasta que aceptes.')).toBeNull();
  });

  it('says they are not contacts, then each one: who they say they are, from where, when and what', () => {
    const props = list();
    expect(screen.getByRole('heading', { name: 'Solicitudes' })).toBeTruthy();
    expect(screen.getByText('No son tus contactos. Nada de aquí suena ni se descarga hasta que aceptes.')).toBeTruthy();
    const rows = within(screen.getByRole('list', { name: 'Solicitudes' })).getAllByRole('button');
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain('dice llamarse ana');
    expect(rows[0].textContent).toContain('por tu @nombre');
    expect(rows[0].textContent).toContain('Hola, soy Ana, la del taller de cerámica');
    expect(rows[0].textContent).toContain('Se parece a Ana Torres. Revisa la huella.');
    expect(rows[1].textContent).toContain('dice llamarse ~mara');
    expect(rows[1].textContent).toContain('está en «Familia» contigo');
    expect(rows[1].textContent).toContain('Ayer');
    fireEvent.click(rows[1]);
    expect(props.onOpen).toHaveBeenCalledWith(MARA.key);
    fireEvent.click(screen.getByRole('button', { name: 'Volver a los chats' }));
    expect(props.onBack).toHaveBeenCalled();
  });

  it('says how many did not fit, and that there are none', () => {
    list({ overflow: 12 });
    expect(screen.getByText('Llegaron más solicitudes de las que caben (12). Revisa las que tienes.')).toBeTruthy();
    cleanup();
    list({ requests: [] });
    expect(screen.getByText('No tienes solicitudes.')).toBeTruthy();
  });

  it('never shows a photo', () => {
    list();
    expect(document.querySelector('img')).toBeNull();
  });

  it('says when it could not read them, with Reintentar', () => {
    const props = list({ requests: [], failed: true });
    expect(screen.getByText('No se pudieron leer las solicitudes.')).toBeTruthy();
    expect(screen.queryByText('No tienes solicitudes.')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Reintentar' }));
    expect(props.onRetry).toHaveBeenCalled();
  });
});

describe('RequestPane (PropSolicitudes card 4, PropMovilSolicitudes card 3)', () => {
  function pane(over: Partial<RequestPaneProps> = {}) {
    const props: RequestPaneProps = {
      request: ANA,
      onAccept: vi.fn(async () => {}),
      onDelete: vi.fn(async () => {}),
      onBlock: vi.fn(),
      ...over,
    };
    const utils = inSpanish(<RequestPane {...props} />);
    return { ...utils, props };
  }

  // Design test 21.
  it('has no link to touch and loads no picture: the text as text, the file untouched', () => {
    const request = {
      ...ANA,
      items: [
        { kind: 'text' as const, text: 'Te mando las fotos: www.ejemplo.com/fotos https://ejemplo.com/a', at: T0 },
        { kind: 'file' as const, mime: 'image/jpeg', size: 1_258_291, at: T0 + 1 },
        { kind: 'call' as const, video: false, at: T0 + 2 },
      ],
    };
    const { container } = pane({ request });
    expect(screen.getByText('Te mando las fotos: www.ejemplo.com/fotos https://ejemplo.com/a')).toBeTruthy();
    expect(container.querySelector('a')).toBeNull();
    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByText('Mandó un archivo (foto, 1,2 MB). Se descarga si aceptas.')).toBeTruthy();
    expect(screen.getByText(/^ana intentó llamarte · \d\d:\d\d/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Descargar/ })).toBeNull();
    expect(screen.queryByRole('textbox'), 'nothing to write with until you accept').toBeNull();
  });

  it('says who they say they are, its fingerprint, and whom they resemble', () => {
    pane();
    expect(screen.getByRole('heading', { name: 'dice llamarse ana' })).toBeTruthy();
    expect(screen.getByText('por tu @nombre · huella 70A5 83C6')).toBeTruthy();
    expect(screen.getByText('Se parece a Ana Torres. Revisa la huella antes de aceptar.')).toBeTruthy();
  });

  it('says a contact of a group is not your contact, and that the admin named them (R-10)', () => {
    pane({ request: MARA });
    expect(screen.getByRole('heading', { name: 'dice llamarse ~mara' })).toBeTruthy();
    expect(screen.getByText('~mara · nombre que puso el admin · huella 70A5 83C6')).toBeTruthy();
    expect(screen.getByText('~mara está en «Familia» contigo, pero no es tu contacto.')).toBeTruthy();
  });

  it('asks to confirm a link by another way before accepting (R-20)', () => {
    pane({ request: request({ name: 'mara', via: { kind: 'link', label: 'Para Mara' } }) });
    expect(screen.getByText('Antes de aceptar, confirma con Para Mara por otro medio que lo usó.')).toBeTruthy();
  });

  it('says what did not fit', () => {
    pane({ request: request({ dropped: 3 }) });
    expect(screen.getByText('Mandó más de lo que cabe aquí: 3 sin guardar.')).toBeTruthy();
  });

  it('accepts, deletes and blocks, each from its button', async () => {
    const { props } = pane();
    fireEvent.click(screen.getByRole('button', { name: 'Aceptar' }));
    await waitFor(() => expect(props.onAccept).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: 'Eliminar' }));
    await waitFor(() => expect(props.onDelete).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: 'Bloquear' }));
    expect(props.onBlock).toHaveBeenCalled();
  });

  // UR-5 (PropSolicitudes card 4): Reportar after Bloquear.
  it('reports from its button, after Bloquear', () => {
    const onReport = vi.fn();
    pane({ onReport });
    const names = screen.getAllByRole('button').map(button => button.textContent);
    expect(names.indexOf('Reportar')).toBe(names.indexOf('Bloquear') + 1);
    fireEvent.click(screen.getByRole('button', { name: 'Reportar' }));
    expect(onReport).toHaveBeenCalled();
  });

  it('says why an answer failed: a shared key, a request that is gone, or anything else', async () => {
    const clash = Object.assign(new Error('clash'), { code: 'key_clash', message: 'x' });
    const onAccept = vi.fn(async () => {
      throw { code: 'key_clash', message: 'x' };
    });
    pane({ onAccept });
    fireEvent.click(screen.getByRole('button', { name: 'Aceptar' }));
    expect((await screen.findByRole('alert')).textContent).toBe(
      'Esta persona comparte una llave con un contacto tuyo. No se aceptó. Revisa las huellas.',
    );
    cleanup();
    pane({
      onDelete: vi.fn(async () => {
        throw { code: 'not_found', message: 'x' };
      }),
    });
    fireEvent.click(screen.getByRole('button', { name: 'Eliminar' }));
    expect((await screen.findByRole('alert')).textContent).toBe('Esta solicitud ya no está.');
    cleanup();
    pane({ onAccept: vi.fn(async () => Promise.reject(clash.name)) });
    fireEvent.click(screen.getByRole('button', { name: 'Aceptar' }));
    expect((await screen.findByRole('alert')).textContent).toBe('No se pudo. Inténtalo de nuevo.');
  });

  it('goes back to the list on one pane', () => {
    const onBack = vi.fn();
    pane({ onBack });
    fireEvent.click(screen.getByRole('button', { name: 'Volver a Solicitudes' }));
    expect(onBack).toHaveBeenCalled();
  });
});
