// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgeView } from '../../lib/api';
import { AgeSettingsView } from './AgeSettingsView';
import { renderEs } from './test-utils';

afterEach(cleanup);

const NOV_1 = 1_793_534_400;
const view = (over: Partial<AgeView> = {}): AgeView => ({
  bracket: 'adult',
  adult_from: null,
  instant: false,
  from_store: false,
  ...over,
});

function mount(shown: AgeView, after: AgeView = shown) {
  const api = {
    setAge: vi.fn(async (_bracket: 'minor' | 'adult') => after),
    cancelAgeChange: vi.fn(async () => view({ bracket: 'minor' })),
  };
  renderEs(<AgeSettingsView age={shown} api={api} onChanged={vi.fn()} onBack={() => {}} />);
  return api;
}

// Ajustes › Privacidad › Edad (UR-10, PropMenoresPC cards 5 and 6; U17, U23).
describe('AgeSettingsView', () => {
  // Card 5: from 18 or more to 16 or 17 at once, saying what goes and what stays.
  it('closes the account at once, after saying what goes and what stays', async () => {
    const api = mount(view(), view({ bracket: 'minor' }));
    expect(screen.getByRole('heading', { name: 'Edad' })).toBeTruthy();
    expect(screen.getByText('Dijiste que tienes 18 años o más.')).toBeTruthy();
    expect(screen.getByText('Solo sirve para decidir qué tan abierta es tu cuenta. No sale de tus equipos.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Tengo 16 o 17' }));
    const dialog = screen.getByRole('alertdialog', { name: '¿Cambiar a 16 o 17?' });
    expect(within(dialog).getByText('se eliminan las solicitudes que no llegaron por tus enlaces;')).toBeTruthy();
    expect(within(dialog).getByText('Tus contactos y tus chats se quedan.')).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cambiar' }));
    await waitFor(() => expect(api.setAge).toHaveBeenCalledWith('minor'));
    expect(await screen.findByText('Listo. Tu cuenta tiene ahora las protecciones de 16 y 17 años.')).toBeTruthy();
  });

  // Card 6: not a switch: Cancelar first, the warning against pressure, and 7 days.
  it('asks to 18 or more with Cancelar first, the warning and the wait, and lets it be cancelled', async () => {
    const api = mount(view({ bracket: 'minor' }), view({ bracket: 'minor', adult_from: NOV_1 }));
    expect(screen.getByText('Dijiste que tienes 16 o 17 años. Por eso:')).toBeTruthy();
    expect(screen.getByText('no tienes @nombre ni tarjeta pública;')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Tengo 18 o más' }));
    const dialog = screen.getByRole('alertdialog', { name: '¿Tienes 18 años o más?' });
    expect(
      within(dialog).getByText('Si alguien te pidió que cambies esto, no lo hagas y cuéntaselo a un adulto de confianza.'),
    ).toBeTruthy();
    expect(within(dialog).getByText('El cambio se aplica en 7 días. Mientras tanto todo sigue igual, y lo puedes cancelar aquí.')).toBeTruthy();
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Cancelar' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Sí, tengo 18 o más' }));
    await waitFor(() => expect(api.setAge).toHaveBeenCalledWith('adult'));
    expect(await screen.findByText(/^Tu cuenta se abre el 1 de noviembre\. Hasta entonces todo sigue igual\.$/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar el cambio' }));
    await waitFor(() => expect(api.cancelAgeChange).toHaveBeenCalled());
    expect(await screen.findByText('Cancelaste el cambio. Tu cuenta sigue con las protecciones de 16 y 17 años.')).toBeTruthy();
  });

  // U17: in the first 24 hours, at once, and it says so.
  it('says it is at once in the first day', () => {
    mount(view({ bracket: 'minor', instant: true }));
    fireEvent.click(screen.getByRole('button', { name: 'Tengo 18 o más' }));
    expect(screen.getByText('Creaste tu cuenta hace menos de un día, así que el cambio se aplica al instante.')).toBeTruthy();
  });

  // U16: with the phone's signal there is nothing to change here.
  it('offers no change when the phone says it', () => {
    mount(view({ bracket: 'minor', from_store: true }));
    expect(screen.getByText('Lo dice la cuenta de tu teléfono. Si está mal, corrígelo en la cuenta de tu teléfono.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Tengo/ })).toBeNull();
  });

  it('says when it could not change', async () => {
    const api = mount(view());
    api.setAge.mockRejectedValueOnce(new Error('io'));
    fireEvent.click(screen.getByRole('button', { name: 'Tengo 16 o 17' }));
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Cambiar' }));
    expect((await screen.findByRole('alert')).textContent).toContain('No se pudo cambiar. Inténtalo de nuevo.');
  });
});
