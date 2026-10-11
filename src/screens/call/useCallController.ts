/**
 * The call controller of the redesign (W6). It drives call.ts, follows each
 * call through its states and gives the call screens what they show: the
 * moment of the call, how it travels, the question of calling directly, the
 * SAS v2, the end card, and the confirmation before locking or closing.
 *
 * It stores nothing. The call log (K13), the verification marks and the
 * alerts of Settings come in through `deps`, so the integration (I5)
 * decides where they live. In particular, nothing on the path of the
 * question "call directly?" reads or writes a preference: it is asked on
 * every call and never remembered (docs/llamadas-turn.md).
 *
 * It also applies the DTLS fingerprint rule (docs/sas-v2.md): if the remote
 * fingerprint changes during a call, the call ends, and a "Coinciden" given
 * in it is undone unless the contact was verified before the call.
 * "No coinciden" undoes such a "Coinciden" the same way, and the call goes
 * on, no longer verified.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CallDirection, CallEventWire, CallLogWire, CallSignalEvent } from '../../lib/api';
import * as callModule from '../../lib/call';
import type {
  CallErrorCode,
  CallState,
  ConnectionMode,
  DirectConsentRequest,
  MediaState,
  SasInputs,
} from '../../lib/call';
import { RecentIds, isBusy } from '../../lib/call-rules';
import { useT } from '../../lib/i18n';
import { callSas } from '../../lib/sas';
import * as sfx from '../../lib/sfx';
import type { RingtoneOptions } from '../../lib/sfx';
import { MAX_CALL_SECONDS, callOutcome, type CallRecord, type LocalEnd } from './call-outcome';
import { endReasonOf, viewOf, type CallEndReason, type CallView, type EndTrace } from './call-view-model';

/** What the controller uses of call.ts; the tests give it a fake. */
export type CallEngine = Pick<
  typeof callModule,
  | 'initCall'
  | 'handleSignal'
  | 'startCall'
  | 'acceptIncoming'
  | 'rejectIncoming'
  | 'hangup'
  | 'hangupAndWait'
  | 'teardownCall'
  | 'toggleMute'
  | 'toggleCamera'
  | 'answerDirectConsent'
  | 'isCallBusy'
  | 'callHoldsMedia'
>;

/** What the controller plays of sfx.ts. */
export type CallSounds = Pick<typeof sfx, 'startRingback' | 'startRingtone' | 'stopRinging' | 'blipConnect' | 'blipEnd'>;

/** A contact as the call screens need it. */
export interface CallPeer {
  name: string;
  avatar: string | null;
  /** Verified on this device: "Coinciden" on a call's SAS, or a QR scanned in person. */
  verified: boolean;
  /** The identity digest saved for the contact (K7); null until the backend gives it. */
  identityDigest: string | null;
}

/** The call alerts of Settings > Notificaciones (W5), read when a call rings. */
export interface CallAlerts {
  ringtone(): RingtoneOptions;
  /** Notify an incoming call while the window is hidden. */
  notifyWhenHidden(): boolean;
  /** That notification may name the caller (the preview of the notifications). */
  notifyWithName(): boolean;
}

/** The defaults of Settings: "Trino suave" at 60, and notify with the name. */
const DEFAULT_ALERTS: CallAlerts = {
  ringtone: () => ({ tone: 'soft', volume: 60 }),
  notifyWhenHidden: () => true,
  notifyWithName: () => true,
};

export interface CallControllerDeps {
  api: {
    notify(title: string, body: string): Promise<void>;
    /** K13; called only with `capabilities.callLog`, once per call. */
    recordCall(peer: string, call: CallEventWire, startedAt: number): Promise<CallLogWire>;
  };
  events: { onCallSignal(cb: (event: CallSignalEvent) => void): Promise<() => void> };
  peer(handle: string): CallPeer | null;
  me: { identityDigest: string | null };
  isWindowVisible(): boolean;
  /** "Coinciden" on the call's SAS: mark the contact as verified with its current fingerprint. */
  onVerified(handle: string): void;
  /** The remote DTLS fingerprint changed after a "Coinciden" of this call: clear that mark. */
  onVerificationRevoked(handle: string): void;
  /** Seconds until a message of that chat disappears, 0 for never: the call's record goes with them. */
  ttlFor(handle: string): number;
  capabilities: { callLog: boolean };
  /** Default: the defaults of Settings. */
  alerts?: CallAlerts;
  /** Default: call.ts. */
  engine?: CallEngine;
  /** Default: sfx.ts. */
  sounds?: CallSounds;
  /** Epoch milliseconds. Default: Date.now. */
  now?(): number;
}

/** The SAS v2 of the call in progress: 7 indices into the symbol table. */
export interface CallSas {
  indices: readonly number[];
  /**
   * "Coinciden" in this call, or the contact was verified before it. After
   * "No coinciden", false until a later "Coinciden": the symbols did not
   * match, whatever an earlier call verified.
   */
  verified: boolean;
}

export interface CallEndCard {
  callId: string;
  peer: string;
  name: string;
  avatar: string | null;
  reason: CallEndReason;
  /** Seconds in the call, for a call that connected; null otherwise. */
  durationSec: number | null;
  /** It was placed or offered as a video call ("Volver a llamar" calls the same way). */
  video: boolean;
  /** The backend recorded the call in its chat (K13): "Queda registrada en el chat." */
  logged: boolean;
}

/** What asks before a call is hung up: locking, or closing the window. */
export type EndConfirmReason = 'lock' | 'close';

export interface CallController {
  view: CallView;
  /** The contact of the call in progress, ringing included; null without one. */
  activePeer: string | null;
  /** Who the call in progress, or the last one, is with. */
  peer: (CallPeer & { handle: string }) | null;
  direction: CallDirection | null;
  /** The call carries video: offered, negotiated, or this camera on. */
  video: boolean;
  /** The call shows as the bar over the chats instead of its screen. */
  minimized: boolean;
  setMinimized(minimized: boolean): void;
  /** Epoch milliseconds of the first `connected`, or null. */
  connectedAt: number | null;
  mode: ConnectionMode | null;
  /** The open question of calling directly, or null. */
  consent: DirectConsentRequest | null;
  /** Through `answerDirectConsent`; anything but true cancels. */
  answerConsent(allow: boolean): void;
  media: MediaState;
  localStream: MediaStream | null;
  remoteStream: MediaStream | null;
  sas: CallSas | null;
  /** "Coinciden". */
  confirmMatch(): void;
  /**
   * "No coinciden": the call is no longer verified, and a "Coinciden" given
   * in it is undone, its mark included unless the contact was verified
   * before the call (as the DTLS fingerprint rule does). The call goes on.
   */
  reportMismatch(): void;
  /** A problem during the call that did not end it. */
  notice: 'camera' | null;
  ended: CallEndCard | null;
  dismissEnded(): void;
  /** "Volver a llamar" from the end card. */
  callAgain(): void;
  /** The confirmation open before ending the call, or null. */
  endConfirm: EndConfirmReason | null;
  answerEndConfirm(ok: boolean): void;
  /** A contact's name, or its handle. */
  nameOf(handle: string): string;
  start(handle: string, video: boolean): void;
  /** `{ video: false }` answers a video call with the microphone only. */
  accept(opts?: { video?: boolean }): void;
  reject(): void;
  hangup(): void;
  toggleMute(): void;
  toggleCamera(): void;
  /** Hang up and wait for the bye and the call's record (bounded): before locking. */
  hangupAndWait(): Promise<void>;
  /**
   * Before locking, closing the window or quitting from the tray: true when
   * it may go on. During a call, locking and closing ask first and hang up
   * on yes; quitting hangs up at once, because the tray's "Salir" already
   * chose to quit and the backend exits after a short grace anyway.
   */
  confirmEnd(reason: EndConfirmReason | 'quit'): Promise<boolean>;
}

const NO_MEDIA: MediaState = { muted: false, cameraOn: false, hasVideo: false };
/** How long a failed camera shows. */
const NOTICE_MS = 4_000;
/** How long locking or closing waits for the call's record before going on. */
const RECORD_WAIT_MS = 1_500;
/** The calls already recorded, so a late copy of an end never records twice. */
const RECORDED_REMEMBERED = 64;

/** One call as the controller follows it. */
interface LiveCall extends EndTrace {
  callId: string;
  peer: string;
  /** Placed or offered as a video call. */
  video: boolean;
  startedAt: number;
  states: CallState[];
  errors: CallErrorCode[];
  verifiedAtStart: boolean;
  matched: boolean;
  remoteDtls: string | null;
  indices: readonly number[] | null;
  finished: boolean;
}

interface PendingConfirm {
  reason: EndConfirmReason;
  resolve(ok: boolean): void;
}

export function useCallController(deps: CallControllerDeps): CallController {
  const t = useT();
  const latest = useRef({ deps, t });
  useLayoutEffect(() => {
    latest.current = { deps, t };
  });

  const [state, setState] = useState<CallState>('idle');
  const [peerHandle, setPeerHandle] = useState<string | null>(null);
  const [video, setVideo] = useState(false);
  const [mode, setMode] = useState<ConnectionMode | null>(null);
  const [consent, setConsent] = useState<DirectConsentRequest | null>(null);
  const [media, setMedia] = useState<MediaState>(NO_MEDIA);
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  const [sas, setSas] = useState<CallSas | null>(null);
  const [minimized, setMinimized] = useState(false);
  const [ended, setEnded] = useState<CallEndCard | null>(null);
  const [notice, setNotice] = useState<'camera' | null>(null);
  const [connectedAt, setConnectedAt] = useState<number | null>(null);
  const [endConfirm, setEndConfirm] = useState<EndConfirmReason | null>(null);

  // What the callbacks of call.ts and the actions share, built once.
  const [live] = useState(() => ({
    call: null as LiveCall | null,
    consent: null as DirectConsentRequest | null,
    ended: null as CallEndCard | null,
    confirm: null as PendingConfirm | null,
    records: new Set<Promise<void>>(),
    recorded: new RecentIds(RECORDED_REMEMBERED),
    noticeTimer: null as ReturnType<typeof setTimeout> | null,
  }));

  const actions = useMemo(() => {
    const d = () => latest.current.deps;
    const engine = () => d().engine ?? callModule;
    const sounds = () => d().sounds ?? sfx;
    const alerts = () => d().alerts ?? DEFAULT_ALERTS;
    const now = () => (d().now ?? Date.now)();
    const nameOf = (handle: string) => d().peer(handle)?.name || handle;

    const showEnded = (card: CallEndCard | null) => {
      live.ended = card;
      setEnded(card);
    };
    /** What this side did to end the call; the first one counts. */
    const markLocal = (kind: LocalEnd) => {
      const call = live.call;
      if (call && !call.finished && call.local === null) call.local = kind;
    };

    function notifyIfHidden(call: LiveCall) {
      const { isWindowVisible, api } = d();
      if (isWindowVisible() || !alerts().notifyWhenHidden()) return;
      const title = alerts().notifyWithName() ? nameOf(call.peer) : 'Trino';
      const body = latest.current.t(call.video ? 'call2.incoming.video' : 'call2.incoming.voice');
      api.notify(title, body).catch(error => console.error('call notification failed', error));
    }

    /** The sounds of a state, and the notification of a call that rings while the window is hidden. */
    function play(s: CallState, call: LiveCall) {
      const tones = sounds();
      switch (s) {
        case 'ringing-out':
          tones.startRingback({ volume: alerts().ringtone().volume });
          break;
        case 'ringing-in':
          tones.startRingtone(alerts().ringtone());
          notifyIfHidden(call);
          break;
        case 'connecting':
          tones.stopRinging();
          break;
        case 'connected':
          // Once per call: an ICE restart reconnects without a second blip.
          if (call.states.indexOf('connected') === call.states.length - 1) {
            tones.stopRinging();
            tones.blipConnect();
          }
          break;
        case 'ended':
        case 'rejected':
          tones.stopRinging();
          if (call.states.some(x => x === 'ringing-out' || x === 'connecting' || x === 'connected')) tones.blipEnd();
          break;
        default:
          break;
      }
    }

    function record(call: LiveCall, outcome: CallRecord) {
      live.recorded.add(call.callId);
      const { api, ttlFor } = d();
      const wire: CallEventWire = {
        id: call.callId,
        direction: call.direction,
        video: call.video,
        outcome: outcome.outcome,
        duration_sec: outcome.durationSec,
        ttl: ttlFor(call.peer) || null,
      };
      const done: Promise<void> = api
        .recordCall(call.peer, wire, Math.floor(call.startedAt / 1000))
        .then(() => {
          const card = live.ended;
          if (card && card.callId === call.callId) showEnded({ ...card, logged: true });
        })
        .catch(error => console.error('call not recorded', error))
        .finally(() => live.records.delete(done));
      live.records.add(done);
    }

    function finish(call: LiveCall, at: number) {
      call.finished = true;
      call.endedAt = at;
      const reason = endReasonOf(call);
      const outcome = callOutcome(call);
      setSas(null);
      setNotice(null);
      showEnded(
        reason
          ? {
              callId: call.callId,
              peer: call.peer,
              name: nameOf(call.peer),
              avatar: d().peer(call.peer)?.avatar ?? null,
              reason,
              durationSec:
                call.connectedAt === null
                  ? null
                  : Math.min(MAX_CALL_SECONDS, Math.max(0, Math.floor((at - call.connectedAt) / 1000))),
              video: call.video,
              logged: false,
            }
          : null,
      );
      if (d().capabilities.callLog && outcome && !live.recorded.has(call.callId)) record(call, outcome);
      // Asked to lock or close and the call ended by itself: nothing is left to hang up.
      const confirm = live.confirm;
      if (confirm) {
        live.confirm = null;
        setEndConfirm(null);
        confirm.resolve(true);
      }
    }

    function onState(s: CallState, info: { peer: string | null; video: boolean; callId: string | null }) {
      const at = now();
      let call = live.call;
      if (info.callId && info.peer && call?.callId !== info.callId) {
        if (call && !call.finished) finish(call, at);
        call = {
          callId: info.callId,
          peer: info.peer,
          // Only our own startCall begins at `starting`; an offer rings, or is answered at once.
          direction: s === 'starting' ? 'outgoing' : 'incoming',
          video: info.video,
          startedAt: at,
          states: [],
          errors: [],
          local: null,
          connectedAt: null,
          endedAt: at,
          security: false,
          verifiedAtStart: d().peer(info.peer)?.verified === true,
          matched: false,
          remoteDtls: null,
          indices: null,
          finished: false,
        };
        live.call = call;
        setSas(null);
        setNotice(null);
        setConnectedAt(null);
        setMinimized(false);
        showEnded(null);
      }
      const current = call && call.callId === info.callId && !call.finished ? call : null;
      if (current) {
        current.states.push(s);
        if (s === 'connected' && current.connectedAt === null) {
          current.connectedAt = at;
          setConnectedAt(at);
        }
      }
      setState(s);
      setPeerHandle(info.peer);
      setVideo(info.video);
      if (!current) return;
      play(s, current);
      if (s === 'ended' || s === 'rejected') finish(current, at);
    }

    function onError(code: CallErrorCode) {
      const call = live.call;
      if (call && !call.finished) call.errors.push(code);
      if (code !== 'camera') return;
      setNotice('camera');
      if (live.noticeTimer) clearTimeout(live.noticeTimer);
      live.noticeTimer = setTimeout(() => setNotice(null), NOTICE_MS);
    }

    /** The 7 symbols, from the call id, both identity digests and both fingerprints. */
    function deriveSymbols(call: LiveCall, inputs: SasInputs) {
      const mine = d().me.identityDigest;
      const theirs = d().peer(call.peer)?.identityDigest;
      // Without both identities there is no SAS v2 that could verify anything (K7).
      if (!mine || !theirs) return;
      callSas({ callId: inputs.callId, idA: mine, idB: theirs, dtlsA: inputs.localDtls, dtlsB: inputs.remoteDtls })
        .then(indices => {
          if (live.call !== call || call.finished || call.security) return;
          call.indices = indices;
          setSas({ indices, verified: call.verifiedAtStart || call.matched });
        })
        .catch(error => console.error('call SAS unavailable', error));
    }

    function onSasInputs(inputs: SasInputs) {
      const call = live.call;
      if (!call || call.finished || inputs.callId !== call.callId) return;
      if (call.remoteDtls === null) {
        call.remoteDtls = inputs.remoteDtls;
        deriveSymbols(call, inputs);
        return;
      }
      if (call.remoteDtls === inputs.remoteDtls) return;
      // docs/sas-v2.md, "The DTLS fingerprint rule".
      call.security = true;
      setSas(null);
      try {
        if (call.matched && !call.verifiedAtStart) d().onVerificationRevoked(call.peer);
      } finally {
        engine().hangup();
      }
    }

    function consentAsked(request: DirectConsentRequest | null) {
      live.consent = request;
      setConsent(request);
    }

    async function settleRecords() {
      const pending = [...live.records];
      if (pending.length === 0) return;
      await Promise.race([Promise.allSettled(pending), new Promise(resolve => setTimeout(resolve, RECORD_WAIT_MS))]);
    }

    async function hangupAndWait() {
      markLocal('hangup');
      await engine().hangupAndWait();
      await settleRecords();
    }

    function start(handle: string, withVideo: boolean) {
      const calls = engine();
      if (calls.isCallBusy()) return;
      showEnded(null);
      setMinimized(false);
      calls.startCall(handle, withVideo).catch(error => console.error('call failed', error));
    }

    return {
      engine,
      sounds,
      nameOf,
      onState,
      onError,
      onSasInputs,
      consentAsked,
      hangupAndWait,
      start,
      accept(opts?: { video?: boolean }) {
        engine()
          .acceptIncoming(opts)
          .catch(error => console.error('answer failed', error));
      },
      reject() {
        markLocal('decline');
        engine().rejectIncoming();
      },
      hangup() {
        markLocal('hangup');
        engine().hangup();
      },
      answerConsent(allow: boolean) {
        const request = live.consent;
        if (allow !== true && request) markLocal(request.outgoing ? 'hangup' : 'decline');
        engine().answerDirectConsent(allow === true);
      },
      toggleMute() {
        engine().toggleMute();
      },
      toggleCamera() {
        engine()
          .toggleCamera()
          .catch(error => console.error('camera switch failed', error));
      },
      confirmMatch() {
        const call = live.call;
        if (!call || call.finished || call.security || !call.indices) return;
        call.matched = true;
        setSas({ indices: call.indices, verified: true });
        d().onVerified(call.peer);
      },
      reportMismatch() {
        const call = live.call;
        if (!call || call.finished || call.security || !call.indices) return;
        const undo = call.matched && !call.verifiedAtStart;
        call.matched = false;
        setSas({ indices: call.indices, verified: false });
        if (undo) d().onVerificationRevoked(call.peer);
      },
      dismissEnded() {
        showEnded(null);
      },
      callAgain() {
        const card = live.ended;
        if (!card) return;
        showEnded(null);
        start(card.peer, card.video);
      },
      async confirmEnd(reason: EndConfirmReason | 'quit'): Promise<boolean> {
        if (reason === 'quit') {
          await hangupAndWait();
          return true;
        }
        const calls = engine();
        const during = reason === 'lock' ? calls.isCallBusy() : calls.callHoldsMedia();
        if (!during) return true;
        live.confirm?.resolve(false);
        return new Promise<boolean>(resolve => {
          live.confirm = { reason, resolve };
          setEndConfirm(reason);
        });
      },
      answerEndConfirm(ok: boolean) {
        const pending = live.confirm;
        if (!pending) return;
        live.confirm = null;
        setEndConfirm(null);
        if (!ok) {
          pending.resolve(false);
          return;
        }
        void hangupAndWait().finally(() => pending.resolve(true));
      },
      dispose() {
        const pending = live.confirm;
        live.confirm = null;
        pending?.resolve(false);
        if (live.noticeTimer) clearTimeout(live.noticeTimer);
      },
    };
  }, []);

  useEffect(() => {
    let disposed = false;
    const calls = actions.engine();
    calls.initCall({
      onState: (s, info) => {
        if (!disposed) actions.onState(s, info);
      },
      onLocalStream: stream => {
        if (!disposed) setLocalStream(stream);
      },
      onRemoteStream: stream => {
        if (!disposed) setRemoteStream(stream);
      },
      // The old screen's emoji code; the SAS v2 comes from onSasInputs.
      onSas: () => {},
      onError: code => {
        if (!disposed) actions.onError(code);
      },
      onMedia: next => {
        if (!disposed) setMedia(next);
      },
      onConnectionMode: next => {
        if (!disposed) setMode(next);
      },
      onDirectConsent: request => {
        if (!disposed) actions.consentAsked(request);
      },
      onSasInputs: inputs => {
        if (!disposed) actions.onSasInputs(inputs);
      },
    });
    let unlisten: (() => void) | null = null;
    latest.current.deps.events
      .onCallSignal(event => {
        if (!disposed) calls.handleSignal(event.from_handle, event.payload);
      })
      .then(fn => {
        if (disposed) fn();
        else unlisten = fn;
      })
      .catch(error => console.error('call signals unavailable', error));
    return () => {
      disposed = true;
      unlisten?.();
      actions.dispose();
      // Leaving (locking, reloading) never leaves the microphone or camera on.
      calls.teardownCall();
      actions.sounds().stopRinging();
    };
  }, [actions]);

  const peerInfo = peerHandle ? deps.peer(peerHandle) : null;
  return {
    view: viewOf(state, ended !== null),
    activePeer: isBusy(state) ? peerHandle : null,
    peer: peerHandle
      ? {
          handle: peerHandle,
          name: peerInfo?.name || peerHandle,
          avatar: peerInfo?.avatar ?? null,
          verified: peerInfo?.verified === true,
          identityDigest: peerInfo?.identityDigest ?? null,
        }
      : null,
    direction: live.call?.direction ?? null,
    video: video || media.hasVideo,
    minimized,
    setMinimized,
    connectedAt,
    mode,
    consent,
    answerConsent: actions.answerConsent,
    media,
    localStream,
    remoteStream,
    sas,
    confirmMatch: actions.confirmMatch,
    reportMismatch: actions.reportMismatch,
    notice,
    ended,
    dismissEnded: actions.dismissEnded,
    callAgain: actions.callAgain,
    endConfirm,
    answerEndConfirm: actions.answerEndConfirm,
    nameOf: actions.nameOf,
    start: actions.start,
    accept: actions.accept,
    reject: actions.reject,
    hangup: actions.hangup,
    toggleMute: actions.toggleMute,
    toggleCamera: actions.toggleCamera,
    hangupAndWait: actions.hangupAndWait,
    confirmEnd: actions.confirmEnd,
  };
}
