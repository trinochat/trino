// @vitest-environment jsdom
import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProfileQrView } from './ProfileQrView';
import { renderEs } from './test-utils';

afterEach(cleanup);

// "Tu código QR" in Settings (PropAjustes:168-191): the share panel of the
// contacts unit (W4), through renderShareCode. Settings draws no QR of its own.
describe('ProfileQrView', () => {
  it('shows the share panel under the heading "Tu código QR"', () => {
    renderEs(<ProfileQrView onBack={() => {}} renderShareCode={() => <p>Panel para compartir</p>} />);
    const view = screen.getByRole('region', { name: 'Tu código QR' });
    expect(within(view).getByText('Panel para compartir')).toBeTruthy();
  });

  it('goes back to the profile', () => {
    const onBack = vi.fn();
    renderEs(<ProfileQrView onBack={onBack} renderShareCode={() => null} />);
    fireEvent.click(screen.getByRole('button', { name: 'Volver al perfil' }));
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('draws nothing but its icons: the QR is the share panel’s', () => {
    const { container } = renderEs(<ProfileQrView onBack={() => {}} renderShareCode={() => null} />);
    const drawings = Array.from(container.querySelectorAll('svg, canvas'));
    expect(drawings.length).toBeGreaterThan(0);
    expect(drawings.every(drawing => drawing.classList.contains('lucide'))).toBe(true);
  });

  it('moves the focus to its heading when asked, as it opens from a row that goes away', () => {
    renderEs(<ProfileQrView onBack={() => {}} renderShareCode={() => null} autoFocus />);
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Tu código QR' }));
  });
});
