import { describe, expect, it } from 'vitest';
import {
  RecentIds,
  decideIncomingOffer,
  holdsMedia,
  isBusy,
  resolveGlare,
  sanitizeIceServers,
  signalBelongsToCall,
  type CallState,
  type OfferContext,
} from './call-rules';

const A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const B = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const C = 'cccccccccccccccccccccccccccccccc';

const ALL: CallState[] = [
  'idle',
  'starting',
  'ringing-out',
  'ringing-in',
  'connecting',
  'connected',
  'rejected',
  'ended',
];

describe('isBusy / holdsMedia', () => {
  it('counts every live phase as busy, including starting', () => {
    expect(ALL.filter(isBusy)).toEqual([
      'starting',
      'ringing-out',
      'ringing-in',
      'connecting',
      'connected',
    ]);
  });

  it('only reports media for phases that may hold the microphone or camera', () => {
    expect(ALL.filter(holdsMedia)).toEqual(['starting', 'ringing-out', 'connecting', 'connected']);
  });
});

describe('signalBelongsToCall', () => {
  const current = { callId: A, peer: 'alice' };

  it('accepts a signal only when both the call id and the sender match', () => {
    expect(signalBelongsToCall(current, 'alice', A)).toBe(true);
  });

  it('rejects a signal for our call id sent by another contact', () => {
    expect(signalBelongsToCall(current, 'mallory', A)).toBe(false);
  });

  it('rejects a signal from the peer for another call', () => {
    expect(signalBelongsToCall(current, 'alice', B)).toBe(false);
  });

  it('rejects everything when there is no call', () => {
    expect(signalBelongsToCall({ callId: null, peer: null }, 'alice', A)).toBe(false);
    expect(signalBelongsToCall({ callId: A, peer: null }, 'alice', A)).toBe(false);
  });
});

describe('RecentIds', () => {
  it('remembers ids it was given', () => {
    const ids = new RecentIds(4);
    ids.add('x');
    expect(ids.has('x')).toBe(true);
    expect(ids.has('y')).toBe(false);
  });

  it('forgets the oldest id beyond its capacity', () => {
    const ids = new RecentIds(3);
    for (const id of ['a', 'b', 'a', 'c', 'd']) ids.add(id);
    expect(ids.has('a')).toBe(false);
    expect(['b', 'c', 'd'].every(id => ids.has(id))).toBe(true);
    expect(ids.size).toBe(3);
  });
});

describe('resolveGlare', () => {
  it('lets the lower call id win', () => {
    expect(resolveGlare(A, B)).toBe('ours');
    expect(resolveGlare(B, A)).toBe('theirs');
  });

  it('reaches opposite, consistent outcomes on both devices', () => {
    for (const [x, y] of [
      [A, B],
      [C, A],
      ['0f0f0f0f0f0f0f0f', 'f0f0f0f0f0f0f0f0'],
    ]) {
      expect(resolveGlare(x!, y!)).not.toBe(resolveGlare(y!, x!));
    }
  });
});

describe('decideIncomingOffer', () => {
  const base: OfferContext = {
    state: 'idle',
    peer: null,
    callId: null,
    outgoing: false,
    connected: false,
    from: 'alice',
    offerCallId: B,
    alreadyEnded: false,
  };

  it('rings when idle, after an ended call or on the rejected screen', () => {
    for (const state of ['idle', 'ended', 'rejected'] as CallState[]) {
      expect(decideIncomingOffer({ ...base, state })).toBe('ring');
    }
  });

  // UR-2: the backend drops what someone blocked sends; this is the second guard (design §3.2).
  it('never rings for someone you blocked, whatever the call state', () => {
    for (const state of ['idle', 'ended', 'ringing-in', 'connected'] as CallState[]) {
      expect(decideIncomingOffer({ ...base, state, blocked: true })).toBe('ignore');
    }
    expect(decideIncomingOffer({ ...base, blocked: false })).toBe('ring');
  });

  it('does not ring for a late offer whose call already ended', () => {
    expect(decideIncomingOffer({ ...base, alreadyEnded: true })).toBe('ignore');
  });

  it('ignores a duplicate delivery of the offer that is already ringing', () => {
    expect(
      decideIncomingOffer({ ...base, state: 'ringing-in', peer: 'alice', callId: B }),
    ).toBe('ignore');
  });

  it('applies the tie-break when both people call each other', () => {
    const glare = { ...base, state: 'ringing-out' as CallState, peer: 'alice', outgoing: true };
    expect(decideIncomingOffer({ ...glare, callId: A, offerCallId: B })).toBe('glare-keep-ours');
    expect(decideIncomingOffer({ ...glare, callId: C, offerCallId: B })).toBe('glare-take-theirs');
  });

  it('also detects glare while our own call is still starting', () => {
    expect(
      decideIncomingOffer({
        ...base,
        state: 'starting',
        peer: 'alice',
        callId: C,
        outgoing: true,
        offerCallId: B,
      }),
    ).toBe('glare-take-theirs');
  });

  it('replaces a stale call when the same peer calls again before connecting', () => {
    expect(
      decideIncomingOffer({ ...base, state: 'ringing-in', peer: 'alice', callId: A }),
    ).toBe('replace');
    expect(
      decideIncomingOffer({
        ...base,
        state: 'connecting',
        peer: 'alice',
        callId: A,
        outgoing: true,
      }),
    ).toBe('replace');
  });

  it('declines a new offer from the peer of a connected call', () => {
    expect(
      decideIncomingOffer({
        ...base,
        state: 'connected',
        peer: 'alice',
        callId: A,
        connected: true,
      }),
    ).toBe('busy');
  });

  it('declines an offer from someone else while busy', () => {
    for (const state of ['starting', 'ringing-out', 'ringing-in', 'connecting', 'connected'] as CallState[]) {
      expect(
        decideIncomingOffer({ ...base, state, peer: 'bob', callId: A, from: 'alice' }),
      ).toBe('busy');
    }
  });
});

describe('sanitizeIceServers', () => {
  it('accepts an empty list, meaning no STUN at all', () => {
    expect(sanitizeIceServers([])).toEqual([]);
  });

  it('keeps valid STUN and TURN entries as given', () => {
    const servers = [
      { urls: 'stun:stun.example.net:3478' },
      { urls: ['turns:turn.example.net:5349?transport=tcp'], username: 'u', credential: 'p' },
    ];
    expect(sanitizeIceServers(servers)).toEqual(servers);
  });

  it('drops invalid entries without falling back to hardcoded servers', () => {
    expect(
      sanitizeIceServers([
        { urls: 'http://evil.example' },
        { urls: [] },
        { urls: [42] },
        null,
        'stun:bare-string',
      ]),
    ).toEqual([]);
  });

  it('treats anything that is not a list as no servers', () => {
    expect(sanitizeIceServers(undefined)).toEqual([]);
    expect(sanitizeIceServers({ urls: 'stun:x' })).toEqual([]);
  });
});
