// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen } from '@testing-library/react';
import type { ChatHeaderInfo } from '../types';
import { ChatHeader, type ChatHeaderProps } from './ChatHeader';
import { classesOf, renderIn } from './test-utils';

afterEach(cleanup);

const ANA: ChatHeaderInfo = { kind: 'contact', name: 'Ana Torres', trust: 'verified', ttlSeconds: 0, blocked: false };
const FAMILIA: ChatHeaderInfo = { kind: 'group', name: 'Familia', memberCount: 4, ended: false, ttlSeconds: 0 };

function show(header: ChatHeaderInfo, extra: Partial<ChatHeaderProps> = {}) {
  const props: ChatHeaderProps = { header, onOpenDetails: vi.fn(), ...extra };
  renderIn(<ChatHeader {...props} />);
  return props;
}

describe('ChatHeader', () => {
  it('names the chat in a heading that wraps instead of cutting the name', () => {
    show({ ...ANA, name: 'Ana María Torres de la Concepción Villavicencio' });
    const heading = screen.getByRole('heading', { level: 1 });
    expect(heading.textContent).toBe('Ana María Torres de la Concepción Villavicencio');
    expect(classesOf(heading)).toContain('[overflow-wrap:anywhere]');
    expect(classesOf(heading)).not.toContain('truncate');
  });

  it('says a contact is verified, without a gender, and that it holds on this device', () => {
    show(ANA);
    const badge = screen.getByText('Código verificado en este equipo');
    expect(badge.closest('[data-trust]')?.getAttribute('data-trust')).toBe('verified');
    expect(screen.queryByText(/Verificada/)).toBeNull();
  });

  it('offers to verify a contact that is not, when it can', () => {
    const props = show({ ...ANA, trust: 'unverified' }, { onVerify: vi.fn() });
    expect(screen.getByText('Sin verificar')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Verificar' }));
    expect(props.onVerify).toHaveBeenCalledTimes(1);
    cleanup();
    show({ ...ANA, trust: 'unverified' });
    expect(screen.queryByRole('button', { name: 'Verificar' })).toBeNull();
  });

  it('says when the security code of a contact changed', () => {
    show({ ...ANA, trust: 'keyChanged' });
    const badge = screen.getByText('El código de seguridad cambió');
    expect(badge.closest('[data-trust]')?.getAttribute('data-trust')).toBe('keyChanged');
  });

  it('counts the members of a group, and opens its details', () => {
    const props = show(FAMILIA);
    expect(screen.getByText('4 miembros')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Detalles del grupo' }));
    expect(props.onOpenDetails).toHaveBeenCalledTimes(1);
    cleanup();
    show({ ...FAMILIA, memberCount: 1 });
    expect(screen.getByText('1 miembro')).toBeTruthy();
  });

  it('says when you are no longer in a group', () => {
    show({ ...FAMILIA, ended: true });
    expect(screen.getByText('Ya no eres parte de este grupo')).toBeTruthy();
    expect(screen.queryByText('4 miembros')).toBeNull();
  });

  it('has call buttons only for a contact the chat can call', () => {
    const onCall = vi.fn();
    show(ANA, { onCall });
    fireEvent.click(screen.getByRole('button', { name: 'Llamada de voz' }));
    fireEvent.click(screen.getByRole('button', { name: 'Videollamada' }));
    expect(onCall.mock.calls).toEqual([[false], [true]]);
    cleanup();
    show(ANA);
    expect(screen.queryByRole('button', { name: 'Llamada de voz' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Detalles del chat' })).toBeTruthy();
    cleanup();
    show(FAMILIA, { onCall });
    expect(screen.queryByRole('button', { name: 'Llamada de voz' })).toBeNull();
  });

  it('says a contact is blocked and offers no call to them', () => {
    show({ ...ANA, blocked: true }, { onCall: vi.fn() });
    expect(screen.getByText('Bloqueado')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Llamada de voz' })).toBeNull();
  });

  it('shows how long the messages of a chat last, and nothing when they stay', () => {
    show({ ...ANA, ttlSeconds: 86_400 });
    const chip = screen.getByText('Temporales: 1 día');
    expect(chip.querySelector('svg.lucide-timer')).not.toBeNull();
    cleanup();
    show(ANA);
    expect(screen.queryByText(/Temporales/)).toBeNull();
  });

  it('goes back to the list when the window has room for one pane only', () => {
    const onBack = vi.fn();
    show(ANA, { onBack });
    fireEvent.click(screen.getByRole('button', { name: 'Atrás' }));
    expect(onBack).toHaveBeenCalledTimes(1);
    cleanup();
    show(ANA);
    expect(screen.queryByRole('button', { name: 'Atrás' })).toBeNull();
  });

  it("shows the contact's photo, or the initials", () => {
    const { container } = renderIn(
      <ChatHeader header={{ ...ANA, avatarSrc: 'data:image/jpeg;base64,/9j/4AAQ' }} onOpenDetails={() => {}} />,
    );
    expect(container.querySelector('img')?.getAttribute('src')).toBe('data:image/jpeg;base64,/9j/4AAQ');
    cleanup();
    renderIn(<ChatHeader header={ANA} onOpenDetails={() => {}} />);
    expect(screen.getByText('AT')).toBeTruthy();
  });
});
