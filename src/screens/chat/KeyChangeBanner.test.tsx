// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { KeyChangeBanner } from './KeyChangeBanner';
import { renderIn } from './test-utils';

afterEach(cleanup);

describe('KeyChangeBanner', () => {
  it("says the contact's code changed and how to check it, politely", () => {
    renderIn(<KeyChangeBanner name="Carlos Méndez" />);
    const banner = screen.getByRole('status');
    expect(banner.textContent).toContain(
      'El código de seguridad de Carlos Méndez cambió. Antes de enviarle algo privado, llámale y comparen los símbolos de la llamada.',
    );
  });

  it('verifies the contact, or takes the new code as it is', () => {
    const onVerify = vi.fn();
    const onAcknowledge = vi.fn();
    renderIn(<KeyChangeBanner name="Carlos Méndez" onVerify={onVerify} onAcknowledge={onAcknowledge} />);
    fireEvent.click(screen.getByRole('button', { name: 'Verificar' }));
    fireEvent.click(screen.getByRole('button', { name: 'Entendido' }));
    expect(onVerify).toHaveBeenCalledTimes(1);
    expect(onAcknowledge).toHaveBeenCalledTimes(1);
  });

  it('has no buttons for what the chat cannot do', () => {
    renderIn(<KeyChangeBanner name="Carlos Méndez" />);
    expect(screen.queryByRole('button')).toBeNull();
  });

  // Plan-cambios §3.1: only the SAS of a call verifies; nobody is told to compare a code to verify.
  it('sends you to a call to verify, never to compare the code by itself', () => {
    renderIn(<KeyChangeBanner name="Carlos Méndez" />);
    expect(screen.getByRole('status').textContent).not.toMatch(/compara(?:r)? (?:esta|el) (?:clave|código)/i);
  });
});
