// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LinkAnswer } from '../../lib/net';
import { I18nContext, makeT } from '../../lib/i18n';
import { useLinkOpener, type LinkApi } from './LinkOpener';

afterEach(cleanup);

const URL = 'https://example.org/articulo';

function Host({ api, url = URL }: { api: LinkApi; url?: string }) {
  const links = useLinkOpener(api);
  return (
    <>
      <button type="button" onClick={() => links.openLink(url)}>
        abrir
      </button>
      {links.dialog}
    </>
  );
}

function show(first: LinkAnswer = { state: 'ask', address: URL }) {
  const api = {
    open: vi.fn(async (_url: string, confirmed: boolean): Promise<LinkAnswer> =>
      confirmed ? { state: 'opened', remembered: false } : first,
    ),
  } satisfies LinkApi;
  render(
    <I18nContext.Provider value={makeT('es')}>
      <Host api={api} />
    </I18nContext.Provider>,
  );
  return api;
}

async function openIt() {
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'abrir' })));
}

const BODY = 'Este enlace se abre en tu navegador, sin protección. La página verá desde dónde te conectas.';

// Card 10 and design test 48: a link asks before the browser opens it,
// unless the person said "No volver a preguntar"; the backend decides.
describe('useLinkOpener', () => {
  it('asks first, showing the address as it will open, and nothing opens yet', async () => {
    const api = show();
    await openIt();
    expect(api.open).toHaveBeenCalledWith(URL, false, false);
    const dialog = screen.getByRole('alertdialog', { name: BODY });
    expect(dialog.textContent).toContain(URL);
    const box = screen.getByRole('checkbox', { name: 'No volver a preguntar' }) as HTMLInputElement;
    expect(box.checked).toBe(false);
    expect(screen.getByRole('button', { name: 'Abrir' }).className).toContain('bg-ui-accent');
    expect(screen.getByRole('button', { name: 'Cancelar' }).className).not.toContain('bg-ui-accent');
    expect(api.open).toHaveBeenCalledTimes(1);
  });

  it('opens on Abrir, once, and closes', async () => {
    const api = show();
    await openIt();
    const open = screen.getByRole('button', { name: 'Abrir' });
    await act(async () => {
      fireEvent.click(open);
      fireEvent.click(open);
    });
    expect(api.open).toHaveBeenCalledTimes(2);
    expect(api.open).toHaveBeenLastCalledWith(URL, true, false);
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('passes "No volver a preguntar" with the yes', async () => {
    const api = show();
    await openIt();
    fireEvent.click(screen.getByRole('checkbox', { name: 'No volver a preguntar' }));
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Abrir' })));
    expect(api.open).toHaveBeenLastCalledWith(URL, true, true);
  });

  it('opens nothing on Cancelar or Escape', async () => {
    const api = show();
    await openIt();
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    await openIt();
    fireEvent.keyDown(screen.getByRole('alertdialog'), { key: 'Escape' });
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(api.open.mock.calls.every(([, confirmed]) => confirmed === false)).toBe(true);
  });

  it('asks nothing when the backend opened it already', async () => {
    const api = show({ state: 'opened', remembered: true });
    await openIt();
    expect(api.open).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('says so when the link could not open, and stays', async () => {
    const api = show();
    await openIt();
    api.open.mockRejectedValueOnce(new Error('no browser'));
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Abrir' })));
    expect(screen.getByText('No se pudo abrir el enlace.')).toBeTruthy();
    expect(screen.getByRole('alertdialog')).toBeTruthy();
  });
});
