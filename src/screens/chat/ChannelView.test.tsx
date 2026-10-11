// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import type { Announcement } from '../../lib/announcements';
import type { ChannelViewProps } from '../types';
import { ChannelView } from './ChannelView';
import { at, renderIn } from './test-utils';

afterEach(cleanup);

const NOW = at(2026, 10, 11, 18, 0);
const iso = (ts: number) => new Date(ts * 1000).toISOString();

const BETA: Announcement = {
  id: 'beta-2',
  title: 'Ya está la beta 2',
  body: 'Ya está disponible la beta 2 de Trino para Windows y Linux. Detalles en https://trino.chat/beta.',
  publishedAt: iso(at(2026, 10, 5, 10, 0)),
  version: '0.2.0',
  url: 'https://trino.chat/descargas',
};
const CALLS: Announcement = {
  id: 'calls',
  title: 'Llamadas protegidas',
  body: 'Tus llamadas pasan por un servidor de Cloudflare.',
  publishedAt: iso(at(2026, 10, 11, 9, 30)),
};

function show(extra: Partial<ChannelViewProps> = {}) {
  const props: ChannelViewProps = {
    announcements: [CALLS, BETA],
    source: 'verified',
    lastReadId: null,
    muted: false,
    onToggleMuted: vi.fn(),
    onOpenLink: vi.fn(),
    now: NOW,
    ...extra,
  };
  renderIn(<ChannelView {...props} />);
  return props;
}

const log = () => screen.getByRole('log', { name: 'Novedades' });

describe('ChannelView', () => {
  it('is the official channel, read only: no composer, and a line that says who posts', () => {
    show();
    expect(screen.getByRole('region', { name: 'Novedades de Trino' })).toBeTruthy();
    expect(screen.getByText('Canal oficial · solo lectura')).toBeTruthy();
    expect(screen.getByText('Solo el equipo de Trino publica en este canal.')).toBeTruthy();
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('shows each announcement as a message of its day, the newest at the end', () => {
    show();
    const text = log().textContent ?? '';
    expect(text.indexOf('Lunes')).toBeLessThan(text.indexOf('Ya está la beta 2'));
    expect(text.indexOf('Ya está la beta 2')).toBeLessThan(text.indexOf('Hoy'));
    expect(text.indexOf('Hoy')).toBeLessThan(text.indexOf('Llamadas protegidas'));
    expect(within(log()).getByText('Versión 0.2.0')).toBeTruthy();
  });

  it('says the news were signed by the Trino team, or came with the app', () => {
    show();
    expect(screen.getByText('Firmado por el equipo de Trino')).toBeTruthy();
    cleanup();
    show({ source: 'bundled' });
    expect(screen.getByText('Incluidas en esta versión de Trino')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  // A feed that fails its signature is an attack sign, not a missing file (announcements.ts).
  it('warns, as an alert, when news came that failed the signature check', () => {
    show({ source: 'untrusted' });
    expect(screen.getByRole('alert').textContent).toContain(
      'Llegaron novedades que no pasaron la verificación de firma, así que no se muestran.',
    );
    expect(screen.queryByText('Firmado por el equipo de Trino')).toBeNull();
  });

  it('mutes and unmutes the news, saying which it is', () => {
    const props = show();
    const mute = screen.getByRole('button', { name: 'Silenciar novedades' });
    expect(mute.getAttribute('aria-pressed')).toBe('false');
    expect(mute.querySelector('svg.lucide-bell')).not.toBeNull();
    fireEvent.click(mute);
    expect(props.onToggleMuted).toHaveBeenCalledTimes(1);
    cleanup();
    show({ muted: true });
    const muted = screen.getByRole('button', { name: 'Silenciar novedades' });
    expect(muted.getAttribute('aria-pressed')).toBe('true');
    expect(muted.querySelector('svg.lucide-bell-off')).not.toBeNull();
  });

  it('opens the links of an announcement outside the app', () => {
    const props = show();
    fireEvent.click(screen.getByRole('link', { name: 'https://trino.chat/beta' }));
    fireEvent.click(screen.getByRole('button', { name: 'Abrir enlace' }));
    expect(props.onOpenLink).toHaveBeenNthCalledWith(1, 'https://trino.chat/beta');
    expect(props.onOpenLink).toHaveBeenNthCalledWith(2, 'https://trino.chat/descargas');
  });

  it('marks where the unread news start, and nothing when all were read', () => {
    show({ lastReadId: 'beta-2' });
    const text = log().textContent ?? '';
    expect(text.indexOf('Ya está la beta 2')).toBeLessThan(text.indexOf('Sin leer'));
    expect(text.indexOf('Sin leer')).toBeLessThan(text.indexOf('Llamadas protegidas'));
    cleanup();
    show({ lastReadId: 'calls' });
    expect(screen.queryByText('Sin leer')).toBeNull();
    cleanup();
    show({ lastReadId: null });
    expect(screen.queryByText('Sin leer')).toBeNull();
  });

  it('says so when there is no news', () => {
    show({ announcements: [] });
    expect(within(log()).getByText('Todavía no hay novedades.')).toBeTruthy();
  });

  it('goes back to the list when the window has room for one pane only', () => {
    const onBack = vi.fn();
    show({ onBack });
    fireEvent.click(screen.getByRole('button', { name: 'Atrás' }));
    expect(onBack).toHaveBeenCalledTimes(1);
  });
});
