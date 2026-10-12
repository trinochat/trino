/**
 * Local preferences, kept in `localStorage` on this device only. Every read
 * and write is wrapped, so blocked or full storage gives the defaults and a
 * `false` from the setter instead of an exception.
 *
 * The keys the current screens use stay exactly as they are (`verified:`,
 * `note:`, `ttl:`, `autolock`, `updates.*`, `sticker-recents`), so nothing
 * people saved is lost. The preferences of the redesign live under
 * `trino.pref.*`. Drafts never come here: they would sit on disk in clear text.
 *
 * A verification keeps its key, `verified:<handle>`, but its value says how
 * the contact was verified (verification-marks.ts, docs/sas-v2.md): only a
 * call's "Coinciden" or a QR scanned in person verifies, and the bare
 * fingerprint 0.1.0 stored after its weak checks no longer counts.
 */
import { legacyMarks, markVerifies, readMark, verifiedMark } from './verification-marks';

/** The part of `Storage` the preferences use; `window.localStorage` fits. */
export type PrefsStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export const NOTIF_PREVIEWS = ['full', 'name', 'none'] as const;
/** What a message notification shows: the text, only the name, or nothing. */
export type NotifPreview = (typeof NOTIF_PREVIEWS)[number];

// No preference touches the question of calling directly when TURN fails:
// it is asked on every call, never remembered, and Cancel is the default
// (docs/llamadas-turn.md). The IP warning "once per contact" went away with
// TURN, since the contact no longer sees your IP (plan-cambios-11oct §1.2).

export const RINGTONES = ['soft', 'silent'] as const;
export type Ringtone = (typeof RINGTONES)[number];

/** The defaults of the approved Settings screen (Settings.dc.html). */
export const PREF_DEFAULTS = Object.freeze({
  notifPreview: 'name' as NotifPreview,
  messageSound: true,
  callNotifyHidden: true,
  ringtone: 'soft' as Ringtone,
  /** From 0 to 100, like the slider. */
  ringVolume: 60,
  muteGroupsByDefault: false,
  /** Terminal dark's scan lines; Settings > Appearance switches them off. */
  scanLines: true,
  /**
   * Keep the window out of screenshots, recordings and screen sharing (SC-1;
   * David, 12 Oct: on by default, and it can be turned off). Read before
   * unlocking, like the appearance: main.tsx applies it as the app starts.
   */
  blockCaptures: true,
});

/** Minutes without activity before Trino locks; 0 never locks. */
export const DEFAULT_AUTOLOCK_MINUTES = 5;
export const STICKER_RECENTS_MAX = 24;

/** The per-contact keys, moved on a rename and removed with the contact. */
const CONTACT_PREFIXES = ['note:', 'ttl:', 'verified:'] as const;

const PREF = 'trino.pref.';

export interface Prefs {
  /**
   * The contact's verification mark as stored: `call:<fp>` or `qr:<fp>`, a
   * bare fingerprint of 0.1.0 (which no longer counts), or null.
   */
  getVerified(handle: string): string | null;
  /**
   * Verified by a call or a QR, and with the fingerprint the contact still
   * has (`markVerifies`). A mark of 0.1.0 never counts.
   */
  isVerified(handle: string, fingerprint: string): boolean;
  /**
   * "Coinciden" on a call's SAS: the mark of a call, with the contact's
   * fingerprint now (`verifiedMark(fingerprint, 'call')`). Nothing else
   * verifies on this device, so nothing else calls it.
   */
  setVerified(handle: string, fingerprint: string): boolean;
  clearVerified(handle: string): boolean;
  /** The contacts among `handles` whose mark comes from 0.1.0, in that order: who the one-time notice names. */
  legacyVerified(handles: readonly string[]): string[];
  /** Removes the marks of 0.1.0 among `handles`, once told; a mark of a call or a QR stays. */
  clearLegacyVerified(handles: readonly string[]): void;
  getNote(handle: string): string;
  setNote(handle: string, note: string): boolean;
  /** Seconds until a new message in that conversation disappears; 0 is off. */
  getTtl(convoKey: string): number;
  setTtl(convoKey: string, seconds: number): boolean;
  /**
   * Minutes of inactivity before the app locks; 0 is off. A stored value
   * that is not a number, or is negative, reads as the default 5. App.tsx
   * still reads `autolock` itself: there a value that is not a number never
   * locks and a negative one locks at once. The auto-lock of the
   * integration (I2) moves to this reading on purpose.
   */
  getAutolockMinutes(): number;
  setAutolockMinutes(minutes: number): boolean;
  getUpdatesMuted(): boolean;
  setUpdatesMuted(muted: boolean): boolean;
  /** The id of the last announcement read, or ''. */
  getUpdatesLastRead(): string;
  setUpdatesLastRead(id: string): boolean;
  /** Sticker ids, the most recent first. */
  getStickerRecents(): string[];
  pushStickerRecent(id: string): boolean;
  /** Moves what is stored for a contact to its new handle. */
  renameContact(oldHandle: string, newHandle: string): void;
  /** Removes what is stored for a contact. */
  forgetContact(handle: string): void;

  getNotifPreview(): NotifPreview;
  setNotifPreview(value: NotifPreview): boolean;
  getMessageSound(): boolean;
  setMessageSound(on: boolean): boolean;
  /** Notify of an incoming call while the window is hidden. */
  getCallNotifyHidden(): boolean;
  setCallNotifyHidden(on: boolean): boolean;
  /**
   * When the call log was last seen, in epoch seconds like `Msg.ts`; 0 before
   * the first time. "Llamadas · N" counts the missed calls after it.
   */
  getCallsSeenAt(): number;
  /** Refuses a moment that is negative or not a number. */
  setCallsSeenAt(ts: number): boolean;
  getRingtone(): Ringtone;
  setRingtone(value: Ringtone): boolean;
  getRingVolume(): number;
  setRingVolume(volume: number): boolean;
  /** New groups start muted. */
  getMuteGroupsByDefault(): boolean;
  setMuteGroupsByDefault(on: boolean): boolean;
  getGroupMuted(gid: string): boolean;
  setGroupMuted(gid: string, muted: boolean): boolean;
  /**
   * Terminal dark's scan lines. The text size is not here: it is part of the
   * accessibility settings (`src/design/accessibility.ts`).
   */
  getScanLines(): boolean;
  setScanLines(on: boolean): boolean;
  /**
   * Keep the window out of screenshots, recordings and screen sharing. Only
   * the choice: src/app/capture-protection.ts applies it to the window.
   */
  getBlockCaptures(): boolean;
  setBlockCaptures(on: boolean): boolean;
}

/**
 * Preferences over `storage`, or over `localStorage` when none is given (read
 * on each call, so a webview that refuses it only gets the defaults).
 */
export function createPrefs(storage?: PrefsStorage): Prefs {
  const store = (): PrefsStorage => storage ?? globalThis.localStorage;

  const read = (key: string): string | null => {
    try {
      return store().getItem(key);
    } catch {
      return null;
    }
  };
  const write = (key: string, value: string): boolean => {
    try {
      store().setItem(key, value);
      return true;
    } catch {
      return false;
    }
  };
  const remove = (key: string): boolean => {
    try {
      store().removeItem(key);
      return true;
    } catch {
      return false;
    }
  };

  const readFlag = (key: string, fallback: boolean): boolean => {
    const value = read(key);
    return value === '1' ? true : value === '0' ? false : fallback;
  };
  const writeFlag = (key: string, on: boolean) => write(key, on ? '1' : '0');
  const readChoice = <T extends string>(key: string, options: readonly T[], fallback: T): T => {
    const value = read(key);
    return (options as readonly (string | null)[]).includes(value) ? (value as T) : fallback;
  };
  const clampVolume = (volume: number) => Math.min(100, Math.max(0, Math.round(volume)));
  const getStickerRecents = (): string[] => {
    try {
      const value: unknown = JSON.parse(read('sticker-recents') || '[]');
      return Array.isArray(value) && value.every(id => typeof id === 'string') ? value : [];
    } catch {
      return [];
    }
  };

  return {
    getVerified: handle => read('verified:' + handle),
    isVerified: (handle, fingerprint) => markVerifies(read('verified:' + handle), fingerprint),
    setVerified: (handle, fingerprint) => write('verified:' + handle, verifiedMark(fingerprint, 'call')),
    clearVerified: handle => remove('verified:' + handle),
    legacyVerified: handles => legacyMarks(handles.map(handle => [handle, read('verified:' + handle)] as const)),
    clearLegacyVerified: handles => {
      for (const handle of handles) {
        if (readMark(read('verified:' + handle)).kind === 'legacy') remove('verified:' + handle);
      }
    },
    getNote: handle => read('note:' + handle) || '',
    setNote: (handle, note) => write('note:' + handle, note),
    // As `ttlFor` in App.tsx read it: anything but a positive number is off.
    getTtl: convoKey => {
      const value = Number(read('ttl:' + convoKey) || '0');
      return Number.isFinite(value) && value > 0 ? value : 0;
    },
    setTtl: (convoKey, seconds) =>
      seconds > 0 ? write('ttl:' + convoKey, String(seconds)) : remove('ttl:' + convoKey),
    getAutolockMinutes: () => {
      const value = Number(read('autolock') ?? DEFAULT_AUTOLOCK_MINUTES);
      return Number.isFinite(value) && value >= 0 ? value : DEFAULT_AUTOLOCK_MINUTES;
    },
    setAutolockMinutes: minutes => write('autolock', String(minutes)),
    getUpdatesMuted: () => read('updates.muted') === '1',
    setUpdatesMuted: muted => writeFlag('updates.muted', muted),
    getUpdatesLastRead: () => read('updates.lastRead') || '',
    setUpdatesLastRead: id => write('updates.lastRead', id),
    getStickerRecents,
    pushStickerRecent: id => {
      const recents = [id, ...getStickerRecents().filter(other => other !== id)];
      return write('sticker-recents', JSON.stringify(recents.slice(0, STICKER_RECENTS_MAX)));
    },
    renameContact: (oldHandle, newHandle) => {
      for (const prefix of CONTACT_PREFIXES) {
        const value = read(prefix + oldHandle);
        if (value !== null) write(prefix + newHandle, value);
        remove(prefix + oldHandle);
      }
    },
    forgetContact: handle => {
      for (const prefix of CONTACT_PREFIXES) remove(prefix + handle);
    },

    getNotifPreview: () => readChoice(PREF + 'notifPreview', NOTIF_PREVIEWS, PREF_DEFAULTS.notifPreview),
    setNotifPreview: value => write(PREF + 'notifPreview', value),
    getMessageSound: () => readFlag(PREF + 'messageSound', PREF_DEFAULTS.messageSound),
    setMessageSound: on => writeFlag(PREF + 'messageSound', on),
    getCallNotifyHidden: () => readFlag(PREF + 'callNotifyHidden', PREF_DEFAULTS.callNotifyHidden),
    setCallNotifyHidden: on => writeFlag(PREF + 'callNotifyHidden', on),
    getCallsSeenAt: () => {
      const value = Number(read(PREF + 'callsSeenAt') || '0');
      return Number.isFinite(value) && value > 0 ? value : 0;
    },
    setCallsSeenAt: ts => Number.isFinite(ts) && ts >= 0 && write(PREF + 'callsSeenAt', String(ts)),
    getRingtone: () => readChoice(PREF + 'ringtone', RINGTONES, PREF_DEFAULTS.ringtone),
    setRingtone: value => write(PREF + 'ringtone', value),
    getRingVolume: () => {
      const value = Number(read(PREF + 'ringVolume') ?? Number.NaN);
      return Number.isFinite(value) ? clampVolume(value) : PREF_DEFAULTS.ringVolume;
    },
    setRingVolume: volume => write(PREF + 'ringVolume', String(clampVolume(volume))),
    getMuteGroupsByDefault: () => readFlag(PREF + 'muteGroupsByDefault', PREF_DEFAULTS.muteGroupsByDefault),
    setMuteGroupsByDefault: on => writeFlag(PREF + 'muteGroupsByDefault', on),
    getGroupMuted: gid => readFlag(PREF + 'groupMuted:' + gid, false),
    setGroupMuted: (gid, muted) => writeFlag(PREF + 'groupMuted:' + gid, muted),
    getScanLines: () => readFlag(PREF + 'scanLines', PREF_DEFAULTS.scanLines),
    setScanLines: on => writeFlag(PREF + 'scanLines', on),
    getBlockCaptures: () => readFlag(PREF + 'blockCaptures', PREF_DEFAULTS.blockCaptures),
    setBlockCaptures: on => writeFlag(PREF + 'blockCaptures', on),
  };
}

/** The preferences of this device, in `localStorage`. */
export const prefs: Prefs = createPrefs();
