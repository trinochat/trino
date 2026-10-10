// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CallConfirmDialog } from './App';
import { DICTS, LANGS } from './lib/i18n';

afterEach(cleanup);

const TITLE = 'No se pudo proteger la llamada.';
const WARNING = '¿Llamar directo? Tu contacto verá tu IP.';

// The texts MainShell gives this dialog and the call's status line. They are
// the old call screen's, so they live in src/lib/strings/legacy.ts.
const PROTECTED_CALL_KEYS = [
  'call.unprotected.title',
  'call.unprotected.body',
  'call.callDirect',
  'call.mode.protected',
  'call.mode.direct',
  'call.mode.directHelp',
];

function renderConsent() {
  const onConfirm = vi.fn();
  const onCancel = vi.fn();
  render(
    <CallConfirmDialog
      title={TITLE}
      message={WARNING}
      confirmLabel="Llamar directo"
      onConfirm={onConfirm}
      onCancel={onCancel}
    />,
  );
  return { onConfirm, onCancel };
}

describe('CallConfirmDialog', () => {
  it('announces the warning, not only the title, to screen readers', () => {
    renderConsent();
    const dialog = screen.getByRole('alertdialog', { name: TITLE, description: WARNING });
    expect(dialog.getAttribute('aria-modal')).toBe('true');
  });

  it('focuses Cancel and cancels on Escape', () => {
    const { onConfirm, onCancel } = renderConsent();
    expect(document.activeElement?.textContent).toBe('common.cancel');
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });
});

describe('the texts of protected calls', () => {
  it.each(LANGS.map(l => l.code))('exist in %s', lang => {
    expect(PROTECTED_CALL_KEYS.filter(key => !DICTS[lang][key]?.trim())).toEqual([]);
  });

  it('ask in Spanish what docs/llamadas-turn.md quotes', () => {
    expect([DICTS.es['call.unprotected.title'], DICTS.es['call.unprotected.body']]).toEqual([TITLE, WARNING]);
  });
});
