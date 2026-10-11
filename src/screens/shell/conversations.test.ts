import { describe, expect, it } from 'vitest';
import type { CallEventWire, CallLogWire, FileRef, HistItem } from '../../lib/api';
import { encodeMeta } from '../../lib/message-body';
import type { Msg } from '../types';
import {
  EMPTY_CONVERSATIONS,
  bodyOf,
  conversationsReducer,
  messagesOf,
  type Conversations,
  type ConversationsAction,
} from './conversations';

const T0 = 1_760_000_000;

const FILE: FileRef = {
  url: 'https://blossom.example/abc',
  key: 'k',
  sha256: 'abc',
  mime: 'image/png',
  name: 'foto.png',
  size: 10,
};

const call = (id: string, over: Partial<CallEventWire> = {}): CallEventWire => ({
  id,
  direction: 'incoming',
  video: false,
  outcome: 'missed',
  duration_sec: 0,
  ...over,
});

function run(actions: ConversationsAction[], from: Conversations = EMPTY_CONVERSATIONS): Conversations {
  return actions.reduce(conversationsReducer, from);
}

const keysOf = (state: Conversations, convo: string) => messagesOf(state, convo).map(m => m.key);
const textsOf = (state: Conversations, convo: string) => messagesOf(state, convo).map(m => m.text);

describe('conversationsReducer: the history', () => {
  it('loads every conversation with stable keys and its timestamps', () => {
    const history: Record<string, HistItem[]> = {
      Ana: [
        { side: 'them', text: 'hola', ts: T0 },
        { side: 'me', text: 'qué más', ts: T0 + 5 },
        { side: 'me', text: 'todo bien', ts: T0 + 5 },
      ],
      'grp:g1': [{ side: 'them', from: 'Papá', text: 'Llego a las 7', ts: T0 + 9 }],
    };
    const state = run([{ type: 'history', history, now: T0 + 60 }]);
    // `${ts}:${n}`: n tells apart the items of one second.
    expect(keysOf(state, 'Ana')).toEqual([`${T0}:0`, `${T0 + 5}:0`, `${T0 + 5}:1`]);
    expect(messagesOf(state, 'Ana').map(m => [m.side, m.ts, m.text])).toEqual([
      ['them', T0, 'hola'],
      ['me', T0 + 5, 'qué más'],
      ['me', T0 + 5, 'todo bien'],
    ]);
    expect(messagesOf(state, 'grp:g1')[0]).toMatchObject({ side: 'them', from: 'Papá', text: 'Llego a las 7' });
  });

  it('decodes replies and disappearing messages, keeps files and drops what already expired', () => {
    const reply = { author: 'Ana', preview: '¿Vienes?' };
    const history: Record<string, HistItem[]> = {
      Ana: [
        { side: 'them', text: encodeMeta('ya se borró', { ttl: 30 }), ts: T0 },
        { side: 'me', text: encodeMeta('sí, voy', { reply, ttl: 3600 }), ts: T0 + 10 },
        { side: 'them', file: FILE, ts: T0 + 20 },
      ],
    };
    const state = run([{ type: 'history', history, now: T0 + 100 }]);
    const [answer, file] = messagesOf(state, 'Ana');
    expect(messagesOf(state, 'Ana')).toHaveLength(2);
    expect(answer).toMatchObject({ text: 'sí, voy', reply, ttl: 3600, expiresAt: T0 + 10 + 3600 });
    expect(file).toMatchObject({ side: 'them', file: FILE });
    expect(file?.text).toBeUndefined();
  });

  it('turns a call of the history into a call event keyed by its id, on the side of its direction', () => {
    const history: Record<string, HistItem[]> = {
      Ana: [
        { side: 'them', text: 'te llamo', ts: T0 },
        // The side of the item does not decide: an outgoing call is mine.
        { side: 'them', call: call('a1b2c3d4e5f6g7h8', { direction: 'outgoing', outcome: 'answered', duration_sec: 240 }), ts: T0 + 30 },
        { side: 'me', call: call('z9y8x7w6v5u4t3s2', { ttl: 600 }), ts: T0 + 90 },
      ],
    };
    const state = run([{ type: 'history', history, now: T0 + 100 }]);
    const [, outgoing, missed] = messagesOf(state, 'Ana');
    expect(outgoing).toEqual({
      key: 'call:a1b2c3d4e5f6g7h8',
      side: 'me',
      ts: T0 + 30,
      call: { id: 'a1b2c3d4e5f6g7h8', direction: 'outgoing', video: false, outcome: 'answered', durationSec: 240 },
    });
    expect(missed).toMatchObject({ key: 'call:z9y8x7w6v5u4t3s2', side: 'them', ttl: 600, expiresAt: T0 + 90 + 600 });
    expect(missed?.text).toBeUndefined();
  });

  it('keeps the body each text travelled with, which "Borrar para mí" matches', () => {
    const body = encodeMeta('sí, voy', { ttl: 3600 });
    const state = run([{ type: 'history', history: { Ana: [{ side: 'me', text: body, ts: T0 }] }, now: T0 }]);
    expect(bodyOf(state, 'Ana', `${T0}:0`)).toBe(body);
  });
});

describe('conversationsReducer: live messages', () => {
  it('adds an incoming message in order of its time, decoded, with a key of its own', () => {
    const state = run([
      { type: 'history', history: { Ana: [{ side: 'me', text: 'hola', ts: T0 + 10 }] }, now: T0 + 10 },
      { type: 'incoming', convo: 'Ana', ts: T0 + 20, body: encodeMeta('¿todo bien?', { ttl: 60 }) },
      // A late event goes before the newer message.
      { type: 'incoming', convo: 'Ana', ts: T0 + 5, body: 'primero' },
      { type: 'incoming', convo: 'grp:g1', ts: T0 + 30, body: 'Llego a las 7', from: 'Papá' },
    ]);
    expect(textsOf(state, 'Ana')).toEqual(['primero', 'hola', '¿todo bien?']);
    const late = messagesOf(state, 'Ana')[2]!;
    expect(late).toMatchObject({ side: 'them', ttl: 60, expiresAt: T0 + 80 });
    expect(late.key).toMatch(/^live:/);
    expect(messagesOf(state, 'grp:g1')[0]).toMatchObject({ from: 'Papá', text: 'Llego a las 7' });
  });

  it('adds an incoming file', () => {
    const state = run([{ type: 'incoming', convo: 'grp:g1', ts: T0, file: FILE, from: 'Papá' }]);
    expect(messagesOf(state, 'grp:g1')[0]).toMatchObject({ side: 'them', file: FILE, from: 'Papá' });
  });

  // App.tsx put the live messages after the history it loaded later, and a
  // message the backend had already saved showed twice.
  it('never shows twice a live message that the history also brings', () => {
    const history: Record<string, HistItem[]> = {
      Ana: [
        { side: 'them', text: 'hola', ts: T0 },
        { side: 'them', file: FILE, ts: T0 + 1 },
      ],
    };
    const before = run([
      { type: 'incoming', convo: 'Ana', ts: T0, body: 'hola' },
      { type: 'incoming', convo: 'Ana', ts: T0 + 1, file: FILE },
      { type: 'history', history, now: T0 + 2 },
    ]);
    expect(keysOf(before, 'Ana')).toEqual([`${T0}:0`, `${T0 + 1}:0`]);

    // The event of a message the history already brought.
    const after = run([{ type: 'incoming', convo: 'Ana', ts: T0, body: 'hola' }], before);
    expect(keysOf(after, 'Ana')).toEqual([`${T0}:0`, `${T0 + 1}:0`]);
  });

  it('keeps two equal messages that both arrived live', () => {
    const state = run([
      { type: 'history', history: {}, now: T0 },
      { type: 'incoming', convo: 'Ana', ts: T0, body: 'jaja' },
      { type: 'incoming', convo: 'Ana', ts: T0, body: 'jaja' },
    ]);
    expect(textsOf(state, 'Ana')).toEqual(['jaja', 'jaja']);
    expect(new Set(keysOf(state, 'Ana')).size).toBe(2);
  });

  it('keeps the live messages the history does not have', () => {
    const state = run([
      { type: 'incoming', convo: 'Ana', ts: T0 + 50, body: 'nuevo' },
      { type: 'history', history: { Ana: [{ side: 'them', text: 'viejo', ts: T0 }] }, now: T0 + 50 },
    ]);
    expect(textsOf(state, 'Ana')).toEqual(['viejo', 'nuevo']);
  });
});

describe('conversationsReducer: what I send', () => {
  const mine = (key: string, ts: number, text: string): Msg => ({ key, side: 'me', ts, text, state: 'sending' });

  it('shows a message at once as sending, then sent with the time of its receipt', () => {
    const state = run([
      { type: 'incoming', convo: 'Ana', ts: T0 + 3, body: 'otra cosa' },
      { type: 'optimistic', convo: 'Ana', msg: mine('u1', T0 + 1, 'hola'), body: 'hola' },
    ]);
    expect(messagesOf(state, 'Ana')[0]).toMatchObject({ key: 'u1', state: 'sending' });
    expect(bodyOf(state, 'Ana', 'u1')).toBe('hola');

    // The relay stored it later than the clock here said: it moves to its place.
    const sent = run([{ type: 'sent', convo: 'Ana', key: 'u1', receipt: { ts: T0 + 4 } }], state);
    expect(keysOf(sent, 'Ana')).toEqual([expect.stringMatching(/^live:/), 'u1']);
    expect(messagesOf(sent, 'Ana')[1]).toMatchObject({ state: 'sent', ts: T0 + 4 });
  });

  it('shows no sent mark without a receipt, since nothing confirmed it reached a relay', () => {
    const state = run([
      { type: 'optimistic', convo: 'Ana', msg: mine('u1', T0, 'hola'), body: 'hola' },
      { type: 'sent', convo: 'Ana', key: 'u1', receipt: null },
    ]);
    const [msg] = messagesOf(state, 'Ana');
    expect(msg?.state).toBeUndefined();
    expect(msg?.ts).toBe(T0);
  });

  it('marks a failed message and sends it again on retry', () => {
    const failed = run([
      { type: 'optimistic', convo: 'Ana', msg: mine('u1', T0, 'hola'), body: 'hola' },
      { type: 'failed', convo: 'Ana', key: 'u1', failure: { kind: 'offline' } },
    ]);
    expect(messagesOf(failed, 'Ana')[0]).toMatchObject({ state: 'failed', failure: { kind: 'offline' } });

    const again = run([{ type: 'retry', convo: 'Ana', key: 'u1' }], failed);
    expect(messagesOf(again, 'Ana')[0]?.state).toBe('sending');
    expect(messagesOf(again, 'Ana')[0]?.failure).toBeUndefined();
  });

  it('names the members a group message did not reach', () => {
    const state = run([
      { type: 'optimistic', convo: 'grp:g1', msg: mine('u1', T0, 'hola'), body: 'hola' },
      { type: 'failed', convo: 'grp:g1', key: 'u1', failure: { kind: 'partial', members: ['Luis'] }, ts: T0 + 2 },
    ]);
    expect(messagesOf(state, 'grp:g1')[0]).toMatchObject({
      state: 'failed',
      ts: T0 + 2,
      failure: { kind: 'partial', members: ['Luis'] },
    });
  });

  it('drops my sent message when the history already holds it under its receipt time', () => {
    const state = run([
      { type: 'optimistic', convo: 'Ana', msg: mine('u1', T0, 'hola'), body: 'hola' },
      { type: 'history', history: { Ana: [{ side: 'me', text: 'hola', ts: T0 + 1 }] }, now: T0 + 1 },
      { type: 'sent', convo: 'Ana', key: 'u1', receipt: { ts: T0 + 1 } },
    ]);
    expect(keysOf(state, 'Ana')).toEqual([`${T0 + 1}:0`]);
  });

  it('keeps a message that is still sending when the history loads', () => {
    const state = run([
      { type: 'optimistic', convo: 'Ana', msg: mine('u1', T0, 'hola'), body: 'hola' },
      { type: 'history', history: { Ana: [{ side: 'me', text: 'hola', ts: T0 }] }, now: T0 },
    ]);
    expect(keysOf(state, 'Ana')).toEqual([`${T0}:0`, 'u1']);
  });
});

describe('conversationsReducer: deleting, expiring, renaming and removing', () => {
  const loaded = run([
    {
      type: 'history',
      history: {
        Ana: [
          { side: 'them', text: encodeMeta('se borra', { ttl: 10 }), ts: T0 },
          { side: 'me', text: 'se queda', ts: T0 + 1 },
        ],
        'grp:g1': [{ side: 'them', text: 'hola grupo', ts: T0 }],
      },
      now: T0,
    },
  ]);

  it('deletes one message and its body', () => {
    const state = run([{ type: 'deleted', convo: 'Ana', key: `${T0 + 1}:0` }], loaded);
    expect(textsOf(state, 'Ana')).toEqual(['se borra']);
    expect(bodyOf(state, 'Ana', `${T0 + 1}:0`)).toBeUndefined();
  });

  it('prunes what expired, and changes nothing when nothing did', () => {
    expect(run([{ type: 'pruned', now: T0 + 5 }], loaded)).toBe(loaded);
    const state = run([{ type: 'pruned', now: T0 + 10 }], loaded);
    expect(textsOf(state, 'Ana')).toEqual(['se queda']);
    expect(textsOf(state, 'grp:g1')).toEqual(['hola grupo']);
  });

  it('moves a renamed contact with its bodies, joining any messages already under the new name', () => {
    const state = run(
      [
        { type: 'incoming', convo: 'Ana Torres', ts: T0 + 2, body: 'ya con el nombre nuevo' },
        { type: 'renamed', from: 'Ana', to: 'Ana Torres' },
      ],
      loaded,
    );
    expect(messagesOf(state, 'Ana')).toEqual([]);
    expect(textsOf(state, 'Ana Torres')).toEqual(['se borra', 'se queda', 'ya con el nombre nuevo']);
    expect(bodyOf(state, 'Ana Torres', `${T0 + 1}:0`)).toBe('se queda');
  });

  it('forgets a removed conversation', () => {
    const state = run([{ type: 'removed', convo: 'grp:g1' }], loaded);
    expect(messagesOf(state, 'grp:g1')).toEqual([]);
    expect(Object.keys(state)).toEqual(['Ana']);
  });
});

describe('conversationsReducer: calls logged now (K13)', () => {
  const logged = (id: string, ts: number, over: Partial<CallEventWire> = {}): CallLogWire => ({
    peer: 'Ana',
    ts,
    call: call(id, over),
  });

  it('puts the call at the time it started, before what was written during it', () => {
    const state = run([
      { type: 'incoming', convo: 'Ana', ts: T0 + 60, body: 'se cortó' },
      { type: 'call', log: logged('c1c1c1c1c1c1c1c1', T0, { direction: 'outgoing', outcome: 'answered', duration_sec: 120 }) },
    ]);
    expect(keysOf(state, 'Ana')).toEqual(['call:c1c1c1c1c1c1c1c1', expect.stringMatching(/^live:/)]);
    expect(messagesOf(state, 'Ana')[0]).toMatchObject({ side: 'me', ts: T0, call: { outcome: 'answered', durationSec: 120 } });
  });

  it('adds a call once, whether the history or a repeated event brings it again', () => {
    const fromHistory = run([
      { type: 'history', history: { Ana: [{ side: 'them', call: call('d1d1d1d1d1d1d1d1'), ts: T0 }] }, now: T0 },
      { type: 'call', log: logged('d1d1d1d1d1d1d1d1', T0) },
      { type: 'call', log: logged('d1d1d1d1d1d1d1d1', T0) },
    ]);
    expect(keysOf(fromHistory, 'Ana')).toEqual(['call:d1d1d1d1d1d1d1d1']);

    const fromEvent = run([
      { type: 'call', log: logged('e1e1e1e1e1e1e1e1', T0) },
      { type: 'history', history: { Ana: [{ side: 'them', call: call('e1e1e1e1e1e1e1e1'), ts: T0 }] }, now: T0 },
    ]);
    expect(keysOf(fromEvent, 'Ana')).toEqual(['call:e1e1e1e1e1e1e1e1']);
  });

  it('lets a logged call expire with the chat', () => {
    const state = run([{ type: 'call', log: logged('f1f1f1f1f1f1f1f1', T0, { ttl: 60 }) }]);
    expect(messagesOf(state, 'Ana')[0]).toMatchObject({ ttl: 60, expiresAt: T0 + 60 });
    expect(messagesOf(run([{ type: 'pruned', now: T0 + 59 }], state), 'Ana')).toHaveLength(1);
    expect(messagesOf(run([{ type: 'pruned', now: T0 + 60 }], state), 'Ana')).toEqual([]);
  });
});
