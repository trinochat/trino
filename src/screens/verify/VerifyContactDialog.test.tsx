// @vitest-environment jsdom
import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NodeInfo } from '../../lib/api';
import { contactSas } from '../../lib/sas';
import { sasWords } from '../../lib/sas-symbols';
import { renderIn } from '../call/test-support';
import { VerifyContactDialog, type VerifyContactDialogProps } from './VerifyContactDialog';

afterEach(cleanup);

const ME = '1'.repeat(64);
const ANA: NodeInfo = {
  handle: 'Ana Torres',
  fingerprint: 'ab12.cd34.ef56.7890',
  has_session: true,
  added_at: 0,
  identity_digest: '2'.repeat(64),
};

function show(props: Partial<VerifyContactDialogProps> = {}) {
  const onClose = vi.fn();
  const onCall = vi.fn();
  const view = renderIn(<VerifyContactDialog peer={ANA} myIdentityDigest={ME} onClose={onClose} onCall={onCall} {...props} />);
  return { ...view, onClose, onCall };
}

describe('VerifyContactDialog', () => {
  it('is titled "Verificar a {name}"', () => {
    show();
    expect(screen.getByRole('dialog', { name: 'Verificar a Ana Torres' })).toBeTruthy();
  });

  it('shows the 7 symbols of the contact as a quick check, each with its word, at 28 px', async () => {
    show();
    const expected = sasWords(await contactSas({ idA: ME, idB: ANA.identity_digest! }), 'es');
    const list = await screen.findByRole('list', { name: 'Símbolos del chequeo rápido' });
    const items = within(list).getAllByRole('listitem');
    expect(items.map(item => item.textContent)).toEqual(expected);
    for (const item of items) expect(item.querySelector('svg')!.getAttribute('width')).toBe('28');
    expect(screen.getByRole('heading', { name: 'Chequeo rápido' })).toBeTruthy();
    expect(screen.getByRole('dialog').textContent).toContain(
      'Si ven los mismos símbolos, es buena señal, pero no basta para verificar.',
    );
  });

  // David, 10 Oct: only a call's SAS verifies; the contact's symbols never do.
  it('has no "Coinciden": it explains how to verify, by calling', async () => {
    const { onCall } = show();
    await screen.findByRole('list');
    expect(screen.queryByRole('button', { name: /coinciden/i })).toBeNull();
    expect(screen.getByRole('dialog').textContent).toContain(
      'Para verificar a Ana Torres, llámale y comparen los símbolos de la llamada.',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Llamar' }));
    expect(onCall).toHaveBeenCalledTimes(1);
  });

  it('offers no call without a way to call', async () => {
    show({ onCall: undefined });
    await screen.findByRole('list');
    expect(screen.queryByRole('button', { name: 'Llamar' })).toBeNull();
  });

  it('says when the contact was verified in a call', async () => {
    show({ verified: true });
    await screen.findByRole('list');
    expect(screen.getByRole('dialog').textContent).toContain('Verificaste a Ana Torres en una llamada.');
    expect(screen.queryByRole('button', { name: 'Llamar' })).toBeNull();
  });

  it('shows no symbols without the identity digests (K7)', async () => {
    show({ peer: { ...ANA, identity_digest: null } });
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(screen.queryByRole('list')).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Chequeo rápido' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Llamar' })).toBeTruthy();
  });

  it('closes from "Cerrar" and from Escape', () => {
    const { onClose } = show();
    fireEvent.click(screen.getByRole('button', { name: 'Cerrar' }));
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
