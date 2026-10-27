// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { BlockTarget, ReportPreview, SentReport, SentReportView } from '../../lib/api';
import { I18nContext, makeT } from '../../lib/i18n';
import { LangCtx } from '../../lib/i18n-context';
import type { Msg } from '../types';
import { candidatesOf } from './report-model';
import { ReportDialog, type ReportDialogApi, type ReportDialogProps } from './ReportDialog';

afterEach(cleanup);

const LINA: BlockTarget = { kind: 'contact', handle: 'Lina Ríos' };
const DAY = 1_791_916_200;
const PHOTO = { url: 'u', key: 'k', sha256: 'e'.repeat(64), mime: 'image/jpeg', name: 'foto.jpg', size: 1_150_000, thumb: 'data:image/jpeg;base64,AA==' };
const CHAT: Msg[] = [
  { key: 'm1', side: 'them', ts: DAY, text: 'Si no me contestas, voy a ir a tu casa.' },
  { key: 'm2', side: 'me', ts: DAY + 60, text: 'Por favor, déjame en paz.' },
  { key: 'm4', side: 'them', ts: DAY + 120, file: PHOTO },
  { key: 'm3', side: 'them', ts: DAY + 180, text: 'Sé dónde trabajas.' },
];

const SENT: SentReport = { id: 'R-7KQ2-9MXD', day: '2026-10-14', queued: true, blocked: true };

interface Mount {
  preview?: Partial<ReportPreview>;
  sent?: Partial<SentReport>;
  props?: Partial<ReportDialogProps>;
}

function mount({ preview = {}, sent = {}, props = {} }: Mount = {}) {
  let changed: (() => void) | null = null;
  let listed: SentReportView[] = [];
  const api: ReportDialogApi = {
    reportPreview: vi.fn(async () => ({ fingerprint: '1a2b.3c4d.5e6f.7a8b', self_handle: 'lina', can_send: true, ...preview })),
    sendReport: vi.fn(async () => ({ ...SENT, ...sent })),
    cancelReport: vi.fn(async () => {}),
    listSentReports: vi.fn(async () => listed),
    blockIdentity: vi.fn(async () => ({ key: 'k', label: 'Lina Ríos', fingerprint: '', blocked_at: 0, from: 'contact' as const, contact: 'Lina Ríos' })),
    onReportsChanged: vi.fn(async (cb: () => void) => {
      changed = cb;
      return () => {
        changed = null;
      };
    }),
  };
  const handlers = { onClose: vi.fn(), onBlocked: vi.fn(), openLink: vi.fn(), copyText: vi.fn(async (_text: string) => {}) };
  render(
    <LangCtx.Provider value={{ lang: 'es', setLang: () => {} }}>
      <I18nContext.Provider value={makeT('es')}>
        <ReportDialog target={LINA} name="Lina Ríos" candidates={candidatesOf(CHAT, null)} api={api} {...handlers} {...props} />
      </I18nContext.Provider>
    </LangCtx.Provider>,
  );
  const goes = (views: SentReportView[]) =>
    act(async () => {
      listed = views;
      changed?.();
    });
  return { api, goes, ...handlers };
}

const dialog = () => screen.getByRole('dialog', { name: 'Reportar a Lina Ríos' });
const next = () => fireEvent.click(within(dialog()).getByRole('button', { name: 'Siguiente' }));
const choose = (label: string) => fireEvent.click(within(dialog()).getByRole('radio', { name: label }));

describe('ReportDialog (PropReportar)', () => {
  // Card 2: nothing chosen at first; a child at risk in bold.
  it('asks what happened, with nothing chosen and Siguiente waiting for an answer', () => {
    mount();
    expect(within(dialog()).getByText('Paso 1 de 3')).toBeTruthy();
    const radios = within(dialog()).getAllByRole('radio');
    expect(radios.map(radio => radio.textContent?.trim())).toEqual([
      'Spam o publicidad',
      'Acoso, amenazas o insultos',
      'Se hace pasar por otra persona',
      'Estafa o fraude',
      'Imágenes íntimas sin consentimiento',
      'Un niño, niña o adolescente en riesgo',
      'Otra cosa',
    ]);
    expect(radios.every(radio => radio.getAttribute('aria-checked') === 'false')).toBe(true);
    expect((within(dialog()).getByRole('button', { name: 'Siguiente' }) as HTMLButtonElement).disabled).toBe(true);
  });

  // Cards 3 and 4 for spam: only the key, then the exact list; it goes, and they are blocked.
  it('sends only the key for spam, says exactly what goes, and blocks them with it', async () => {
    const { api } = mount();
    choose('Spam o publicidad');
    next();
    expect(within(dialog()).getByText('Paso 2 de 3 · Spam o publicidad')).toBeTruthy();
    expect(within(dialog()).getByRole('radio', { name: 'Solo su llave' }).getAttribute('aria-checked')).toBe('true');
    expect(within(dialog()).getByText('Se envía solo su llave. Trino no ve ningún mensaje.')).toBeTruthy();
    fireEvent.change(within(dialog()).getByLabelText('Cuéntanos qué pasó (opcional)'), { target: { value: 'publicidad' } });
    next();
    await screen.findByText('Esto le envías a Trino:');
    const items = within(dialog()).getAllByRole('listitem').map(item => item.textContent);
    expect(items).toEqual([
      'la llave y la huella de Lina Ríos (1A2B 3C4D 5E6F 7A8B) y el nombre que se puso;',
      '«Spam o publicidad»;',
      'tu descripción.',
    ]);
    expect(within(dialog()).getByText('Trino revisa cada reporte y lo borra en 30 días como máximo.')).toBeTruthy();
    const block = within(dialog()).getByRole('checkbox', { name: 'Bloquear a Lina Ríos' }) as HTMLInputElement;
    expect(block.checked).toBe(true);
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Enviar reporte' }));
    await waitFor(() =>
      expect(api.sendReport).toHaveBeenCalledWith(
        LINA,
        { category: 'spam', mode: 'key_only', picks: [], note: 'publicidad', want_reply: false },
        true,
      ),
    );
    expect(await screen.findByText('El reporte se enviará cuando Tor conecte.')).toBeTruthy();
    expect(screen.getByText('Código R-7KQ2-9MXD')).toBeTruthy();
  });

  // Card 3 for harassment: the message you touched marked, and the photo only as that it exists.
  it('sends the messages you mark, the one you touched first, never the photo itself', async () => {
    const { api } = mount({ props: { initial: 'm1' } });
    choose('Acoso, amenazas o insultos');
    next();
    expect(within(dialog()).getByRole('radio', { name: 'Con mensajes' }).getAttribute('aria-checked')).toBe('true');
    const box = (name: RegExp) => within(dialog()).getByRole('checkbox', { name }) as HTMLInputElement;
    expect(box(/Si no me contestas/).checked).toBe(true);
    expect(box(/Por favor/).checked).toBe(false);
    expect(within(dialog()).getByText('Las fotos y los videos nunca se envían. Va solo que existen, su tamaño aproximado y su día.')).toBeTruthy();
    fireEvent.click(box(/Sé dónde trabajas/));
    fireEvent.click(box(/Foto, unos/));
    next();
    await screen.findByText('Esto le envías a Trino:');
    const items = within(dialog()).getAllByRole('listitem').map(item => item.textContent);
    expect(items).toContain('2 mensajes suyos, con su día;');
    expect(items).toContain('que mandó fotos o archivos (1), con su tamaño aproximado y su día (no se envían);');
    fireEvent.click(within(dialog()).getByRole('checkbox', { name: 'Quiero ver la respuesta de Trino en este equipo' }));
    fireEvent.click(within(dialog()).getByRole('checkbox', { name: 'Bloquear a Lina Ríos' }));
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Enviar reporte' }));
    await waitFor(() => expect(api.sendReport).toHaveBeenCalledTimes(1));
    const [, draft, block] = vi.mocked(api.sendReport).mock.calls[0];
    expect(draft.mode).toBe('messages');
    expect(draft.want_reply).toBe(true);
    expect(block).toBe(false);
    expect(draft.picks.map(pick => pick.text ?? pick.sha256)).toEqual([
      'Si no me contestas, voy a ir a tu casa.',
      'e'.repeat(64),
      'Sé dónde trabajas.',
    ]);
  });

  // Card 5: global (15 Oct), INHOPE, and no message at all.
  it('for a child at risk, says what to do first, opens INHOPE and sends no message', async () => {
    const { api, openLink } = mount();
    choose('Un niño, niña o adolescente en riesgo');
    next();
    expect(within(dialog()).getByText('Si alguien está en peligro ahora, llama a la línea de emergencias de tu país.')).toBeTruthy();
    expect(dialog().textContent).not.toMatch(/123|Fiscal|ADenunciar/);
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Buscar la línea de denuncia de tu país' }));
    expect(openLink).toHaveBeenCalledWith('https://www.inhope.org');
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Avisar a Trino' }));
    expect(within(dialog()).getByText('Solo va su llave y lo que cuentes. Ningún mensaje, foto ni video.')).toBeTruthy();
    expect(within(dialog()).queryAllByRole('checkbox')).toEqual([]);
    next();
    fireEvent.click(await within(dialog()).findByRole('button', { name: 'Enviar reporte' }));
    await waitFor(() => expect(api.sendReport).toHaveBeenCalledTimes(1));
    const [, draft] = vi.mocked(api.sendReport).mock.calls[0];
    expect(draft).toMatchObject({ category: 'child', mode: 'description_only', picks: [] });
  });

  // Card 6: StopNCII.org, and no content either.
  it('for intimate images, opens StopNCII.org', () => {
    const { openLink } = mount();
    choose('Imágenes íntimas sin consentimiento');
    next();
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Abrir StopNCII.org' }));
    expect(openLink).toHaveBeenCalledWith('https://stopncii.org');
  });

  // Card 7, and David's decision of 26 Oct: once it went, the honest text and the 30 days.
  it('says it went, honestly, once the watcher sent it', async () => {
    const { goes } = mount();
    choose('Spam o publicidad');
    next();
    next();
    fireEvent.click(await within(dialog()).findByRole('button', { name: 'Enviar reporte' }));
    await screen.findByText('El reporte se enviará cuando Tor conecte.');
    await goes([{ id: 'R-7KQ2-9MXD', created_at: 0, state: 'sent', write_instead: false, reply: null }]);
    expect(await screen.findByText('Reporte enviado. Código R-7KQ2-9MXD.')).toBeTruthy();
    expect(screen.getByText('Un reporte solo nunca basta para cortar a nadie.')).toBeTruthy();
    expect(screen.getByText('Trino revisa cada reporte y lo borra en 30 días como máximo.')).toBeTruthy();
  });

  it('cancels it while it waits', async () => {
    const { api } = mount();
    choose('Spam o publicidad');
    next();
    next();
    fireEvent.click(await within(dialog()).findByRole('button', { name: 'Enviar reporte' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Cancelar el reporte' }));
    await waitFor(() => expect(api.cancelReport).toHaveBeenCalledWith('R-7KQ2-9MXD'));
    expect(await screen.findByText('Cancelaste el reporte. No se envió.')).toBeTruthy();
  });

  // U24: with nothing that seals it, the e-mail and only the report's details.
  it('offers the e-mail and copies only the details when it cannot go', async () => {
    const { copyText } = mount({ preview: { can_send: false }, sent: { queued: false, blocked: false } });
    choose('Acoso, amenazas o insultos');
    next();
    fireEvent.change(within(dialog()).getByLabelText('Cuéntanos qué pasó (opcional)'), { target: { value: 'Me escribe.' } });
    next();
    fireEvent.click(await within(dialog()).findByRole('button', { name: 'Enviar reporte' }));
    expect(
      await screen.findByText(
        'Por ahora los reportes no salen desde la app. Escribe a abuso@trinochat.org con estos datos; no adjuntes mensajes, fotos ni videos.',
      ),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Copiar datos del reporte' }));
    await waitFor(() => expect(copyText).toHaveBeenCalledTimes(1));
    const copied = vi.mocked(copyText).mock.calls[0][0];
    expect(copied.split('\n')[0]).toBe('Reporte R-7KQ2-9MXD');
    expect(copied).toContain('Tipo: Acoso, amenazas o insultos');
    expect(copied).toContain('Tu descripción: Me escribe.');
    expect(copied).not.toMatch(/contestas|trabajas|foto/i);
    expect(await screen.findByText('Copiaste los datos. Pégalos en un correo a abuso@trinochat.org con el asunto «Reporte R-7KQ2-9MXD».')).toBeTruthy();
  });

  // "Reportar también" from the block's confirmation: blocked, sent or not.
  it('blocks them even if you cancel, when it came from blocking', async () => {
    const { api, onBlocked, onClose } = mount({ props: { mustBlock: true } });
    choose('Spam o publicidad');
    next();
    next();
    const block = (await within(dialog()).findByRole('checkbox', { name: 'Bloquear a Lina Ríos' })) as HTMLInputElement;
    expect(block.checked && block.disabled).toBe(true);
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Cancelar' }));
    await waitFor(() => expect(api.blockIdentity).toHaveBeenCalledWith(LINA));
    expect(onBlocked).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
    expect(api.sendReport).not.toHaveBeenCalled();
  });
});
