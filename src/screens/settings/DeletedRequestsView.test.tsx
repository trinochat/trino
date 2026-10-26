// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DeletedRequestView } from '../../lib/api';
import { DeletedRequestsView } from './DeletedRequestsView';
import { renderEs } from './test-utils';

afterEach(cleanup);

const OCT_14 = 1_760_400_000;

const deleted = (label: string, over: Partial<DeletedRequestView> = {}): DeletedRequestView => ({
  key: `key-${label}`,
  label,
  fingerprint: 'AB12CD34' + '0'.repeat(56),
  deleted_at: OCT_14,
  ...over,
});

// Ajustes › Privacidad › Solicitudes eliminadas (UR-4, PropAjustes; design §4.3).
describe('DeletedRequestsView', () => {
  it('lists whose requests you deleted, with the short fingerprint, the day and "Deshacer"', () => {
    renderEs(<DeletedRequestsView deleted={[deleted('ana'), deleted('spam')]} onUndo={vi.fn()} onBack={() => {}} />);
    expect(screen.getByRole('heading', { name: 'Solicitudes eliminadas' })).toBeTruthy();
    expect(
      screen.getByText(
        'Lo que te mande alguien en los 30 días después de que eliminaste su solicitud no te llega. Con «Deshacer» te puede volver a escribir.',
      ),
    ).toBeTruthy();
    const rows = within(screen.getByRole('list', { name: 'Solicitudes eliminadas' })).getAllByRole('listitem');
    expect(rows).toHaveLength(2);
    expect(within(rows[0]!).getByText('ana')).toBeTruthy();
    expect(within(rows[0]!).getByText(/^Huella AB12 CD34 · /)).toBeTruthy();
    expect(within(rows[1]!).getByRole('button', { name: 'Deshacer: spam' })).toBeTruthy();
  });

  it('undoes one, and says that they can write again and what does not come back', async () => {
    function Harness() {
      const [list, setList] = useState([deleted('ana')]);
      return (
        <DeletedRequestsView
          deleted={list}
          onUndo={async key => setList(current => current.filter(view => view.key !== key))}
          onBack={() => {}}
        />
      );
    }
    renderEs(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Deshacer: ana' }));
    expect((await screen.findByRole('status')).textContent).toBe(
      'ana ya te puede volver a escribir. Lo que mandó antes no vuelve.',
    );
    expect(screen.getByText('No has eliminado solicitudes.')).toBeTruthy();
  });

  it('says when undoing failed, and when the list cannot be read', async () => {
    const onRetry = vi.fn(async () => true);
    renderEs(
      <DeletedRequestsView
        deleted={[deleted('ana')]}
        onUndo={vi.fn(async () => Promise.reject(new Error('io')))}
        onBack={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Deshacer: ana' }));
    expect((await screen.findByRole('alert')).textContent).toContain('No se pudo deshacer con ana. Inténtalo de nuevo.');
    cleanup();
    renderEs(<DeletedRequestsView deleted={null} loadFailed onRetry={onRetry} onUndo={vi.fn()} onBack={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Reintentar' }));
    await waitFor(() => expect(onRetry).toHaveBeenCalled());
    expect(screen.queryByText('No has eliminado solicitudes.')).toBeNull();
  });

  it('goes back to Privacidad', () => {
    const onBack = vi.fn();
    renderEs(<DeletedRequestsView deleted={[]} onUndo={vi.fn()} onBack={onBack} />);
    fireEvent.click(screen.getByRole('button', { name: 'Volver a Privacidad' }));
    expect(onBack).toHaveBeenCalled();
  });
});
