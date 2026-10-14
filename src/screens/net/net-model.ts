/**
 * What each state of the network shows (PropTorSimple, cards 2, 3 and 6;
 * Tor design §5.3, §9.3, §10.1-§10.3), as pure functions the screens
 * share: the inbox's one line of text, the "No se pudo conectar" panel and
 * the state in Ajustes › Privacidad › Conexión.
 *
 * Nothing here ever leads to going without Tor by itself: "Conectar sin
 * protección" is only offered, small and after the other actions, where
 * the person may want it; never while Tor is starting, never for a clock
 * that is off (it would not help), never without internet.
 */
import type { NetStatus } from '../../lib/net';
import type { TVars } from '../../lib/i18n';

/** How the line reads: quiet while it works, stronger when it needs you, a warning without protection. */
export type TorLineTone = 'muted' | 'alert' | 'warn';

/** The inbox's line under the wordmark (card 2): a text key, its tone, and whether "Ver qué hacer" follows. */
export interface TorLine {
  key: string;
  vars?: TVars;
  tone: TorLineTone;
  /** "Ver qué hacer", which opens the panel of card 3. */
  action: boolean;
}

/** The line for `status`; null hides it: connected, before Tor starts, or unknown. */
export function torLineOf(status: NetStatus | null): TorLine | null {
  if (!status) return null;
  switch (status.state) {
    case 'starting':
      return { key: 'net.line.starting', vars: { pct: status.pct }, tone: 'muted', action: false };
    case 'blocked':
      return status.kind === 'offline'
        ? { key: 'net.line.waitingInternet', tone: 'muted', action: false }
        : { key: 'net.line.failed', tone: 'alert', action: true };
    case 'ptMissing':
    case 'obsolete':
      return { key: 'net.line.failed', tone: 'alert', action: true };
    case 'direct':
      return { key: 'net.line.unprotected', tone: 'warn', action: false };
    case 'off':
    case 'ready':
      return null;
  }
}

/** The panel of card 3: why, whether to try another way to connect, and whether "Conectar sin protección…" shows. */
export interface Failure {
  key: string;
  tryOther: boolean;
  escape: boolean;
}

/** The panel for `status`; null when there is no failure to explain. */
export function failureOf(status: NetStatus | null): Failure | null {
  if (!status) return null;
  switch (status.state) {
    case 'blocked':
      switch (status.kind) {
        case 'offline':
          return null;
        case 'filtering':
        case 'cantReachTor':
          return { key: 'net.failed.blocked', tryOther: true, escape: true };
        case 'cantBootstrap':
        case 'noProgress':
          return { key: 'net.failed.slow', tryOther: true, escape: true };
        case 'clockSkewed':
          return { key: 'net.failed.clock', tryOther: false, escape: false };
      }
      return null;
    case 'ptMissing':
      return { key: 'net.failed.antivirus', tryOther: false, escape: true };
    case 'obsolete':
      return { key: 'net.failed.obsolete', tryOther: false, escape: true };
    default:
      return null;
  }
}

/** The state under "Conexión" in Ajustes (card 6). */
export function settingsStatusOf(status: NetStatus | null): string {
  if (!status) return 'net.settings.connecting';
  switch (status.state) {
    case 'ready':
      return 'net.settings.private';
    case 'direct':
      return 'net.settings.unprotected';
    case 'blocked':
      return status.kind === 'offline' ? 'net.line.waitingInternet' : 'net.settings.failed';
    case 'ptMissing':
    case 'obsolete':
      return 'net.settings.failed';
    case 'off':
    case 'starting':
      return 'net.settings.connecting';
  }
}
