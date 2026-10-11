// @vitest-environment jsdom
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProfileCard, type ProfileCardProps } from './ProfileCard';
import { renderEs } from './test-utils';

afterEach(cleanup);

function setup(props: Partial<ProfileCardProps> = {}) {
  const all: ProfileCardProps = {
    name: 'rechita',
    avatar: null,
    current: false,
    qrCurrent: false,
    onOpenProfile: vi.fn(),
    onOpenQr: vi.fn(),
    ...props,
  };
  renderEs(<ProfileCard {...all} />);
  return all;
}

// The profile card at the top of Settings (PropAjustes:44-53).
describe('ProfileCard', () => {
  it('opens your profile from your name', () => {
    const props = setup();
    const card = screen.getByRole('button', { name: /rechita/ });
    expect(card.textContent).toContain('Tu perfil');
    fireEvent.click(card);
    expect(props.onOpenProfile).toHaveBeenCalledTimes(1);
  });

  it('opens your QR code from its own button', () => {
    const props = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Mostrar tu código QR' }));
    expect(props.onOpenQr).toHaveBeenCalledTimes(1);
  });

  it('marks what is on screen: the profile, or the QR code', () => {
    setup({ current: true });
    expect(screen.getByRole('button', { name: /rechita/ }).getAttribute('aria-current')).toBe('page');
    expect(screen.getByRole('button', { name: 'Mostrar tu código QR' }).getAttribute('aria-current')).toBeNull();
    cleanup();
    setup({ qrCurrent: true });
    expect(screen.getByRole('button', { name: /rechita/ }).getAttribute('aria-current')).toBeNull();
    expect(screen.getByRole('button', { name: 'Mostrar tu código QR' }).getAttribute('aria-current')).toBe('page');
  });

  it('shows the photo when there is one', () => {
    setup({ avatar: 'data:image/jpeg;base64,AAAA' });
    expect(document.querySelector('img')?.getAttribute('src')).toBe('data:image/jpeg;base64,AAAA');
  });

  it('keeps a place for the name people find you by, empty in this batch', () => {
    setup();
    expect(document.body.textContent).not.toContain('@');
    cleanup();
    setup({ findableName: 'rechita' });
    expect(screen.getByText('@rechita')).toBeTruthy();
  });
});
