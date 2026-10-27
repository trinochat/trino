// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SentReportView } from '../../lib/api';
import { SentReportsView } from './SentReportsView';
import { renderEs } from './test-utils';

afterEach(cleanup);

const OCT_14 = 1_791_985_600;

const report = (id: string, over: Partial<SentReportView> = {}): SentReportView => ({
  id,
  created_at: OCT_14,
  state: 'sent',
  write_instead: false,
  reply: null,
  ...over,
});

// Ajustes › Privacidad › Reportes enviados (UR-5, PropReportar card 8; R-06; David, 26 Oct).
describe('SentReportsView', () => {
  it('shows only "Reporte", the code and the day, and says it all goes within 30 days', () => {
    renderEs(<SentReportsView reports={[report('R-7KQ2-9MXD'), report('R-3PLM-2QAZ')]} onCancel={vi.fn()} onBack={() => {}} />);
    expect(screen.getByRole('heading', { name: 'Reportes enviados' })).toBeTruthy();
    expect(
      screen.getByText(
        'Solo el código y la fecha, por 30 días. Lo que enviaste no se guarda en este equipo. Trino revisa cada reporte y lo borra en 30 días como máximo; pasado ese tiempo, el reporte sale de esta lista.',
      ),
    ).toBeTruthy();
    const rows = within(screen.getByRole('list', { name: 'Reportes enviados' })).getAllByRole('listitem');
    expect(rows).toHaveLength(2);
    expect(within(rows[0]!).getByText('Reporte')).toBeTruthy();
    expect(within(rows[0]!).getByText(/^R-7KQ2-9MXD · /)).toBeTruthy();
    // Never whom or what.
    expect(rows[0]!.textContent).not.toMatch(/Acoso|Spam|Lina/);
  });

  it('shows the answer of Trino, and what to do when it could not go', () => {
    renderEs(
      <SentReportsView
        reports={[
          report('R-3PLM-2QAZ', { reply: 'no pudo hacer nada.' }),
          report('R-AAAA-BBBB', { state: 'refused', write_instead: true }),
        ]}
        onCancel={vi.fn()}
        onBack={() => {}}
      />,
    );
    expect(screen.getByText('Trino revisó tu reporte R-3PLM-2QAZ: no pudo hacer nada.')).toBeTruthy();
    expect(screen.getByText('No se pudo enviar.')).toBeTruthy();
    expect(screen.getByText('Puedes escribir a abuso@trinochat.org con el código R-AAAA-BBBB.')).toBeTruthy();
  });

  it('cancels one that waits', async () => {
    const onCancel = vi.fn(async () => {});
    renderEs(<SentReportsView reports={[report('R-AAAA-BBBB', { state: 'waiting' })]} onCancel={onCancel} onBack={() => {}} />);
    expect(screen.getByText('En espera: se enviará cuando Tor conecte.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar el reporte R-AAAA-BBBB' }));
    await waitFor(() => expect(onCancel).toHaveBeenCalledWith('R-AAAA-BBBB'));
  });

  it('says when there is none, and when the list cannot be read', () => {
    renderEs(<SentReportsView reports={[]} onCancel={vi.fn()} onBack={() => {}} />);
    expect(screen.getByText('No has enviado reportes en los últimos 30 días.')).toBeTruthy();
    cleanup();
    renderEs(<SentReportsView reports={null} loadFailed onCancel={vi.fn()} onBack={() => {}} />);
    expect(screen.getByText('No se pudieron cargar los reportes.')).toBeTruthy();
  });
});
