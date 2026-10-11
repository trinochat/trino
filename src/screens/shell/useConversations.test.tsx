// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CallLogWire, HistItem, NodeInfo } from '../../lib/api';
import { makeT } from '../../lib/i18n';
import { encodeMeta } from '../../lib/message-body';
import type { ProcessedFile } from '../../lib/media';
import { fakeApi, fakeEvents, fakePrefs, sentFile } from './test-fakes';
import { STICKER_INLINE_MAX, useConversations, type ConversationsOptions } from './useConversations';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

// Now: the history drops what already expired by the clock, and some messages here disappear.
const T0 = Math.floor(Date.now() / 1000);
const ANA = { kind: 'contact', handle: 'Ana' } as const;
const FAMILIA = { kind: 'group', gid: 'g1' } as const;

const node = (handle: string, over: Partial<NodeInfo> = {}): NodeInfo => ({
  handle,
  fingerprint: `fp-${handle}`,
  has_session: true,
  added_at: T0,
  ...over,
});

function setup(
  over: Partial<ConversationsOptions> = {},
  { seed = {}, nodes = [node('Ana')], history = {} as Record<string, HistItem[]>, historyFails = false } = {},
) {
  const api = fakeApi();
  api.listNodes.mockResolvedValue(nodes);
  api.listGroups.mockResolvedValue([{ gid: 'g1', name: 'Familia', epoch: 1, is_admin: false, member_count: 3, members: [] }]);
  api.getHistory.mockResolvedValue(history);
  if (historyFails) api.getHistory.mockRejectedValueOnce(new Error('io'));
  const { events, emit, listening } = fakeEvents();
  const { prefs, storage } = fakePrefs(seed);
  const notifier = { message: vi.fn() };
  const focus = { focused: true };
  let next = 0;
  const options: ConversationsOptions = {
    api,
    events,
    prefs,
    notifier,
    capabilities: { sendAck: true, deleteForMe: true },
    isWindowFocused: () => focus.focused,
    openKey: null,
    t: makeT('es'),
    newKey: () => `u${++next}`,
    ...over,
  };
  const hook = renderHook((props: ConversationsOptions) => useConversations(props), { initialProps: options });
  return { hook, api, emit, listening, prefs, storage, notifier, focus, options };
}

/** Lets the hook's first loads settle. */
async function loaded(hook: ReturnType<typeof setup>['hook']) {
  await waitFor(() => expect(hook.result.current.nodes.length).toBeGreaterThan(0));
}

const flush = () => act(async () => {});

describe('useConversations: loading', () => {
  it('loads the contacts, the groups and the history, with the calls in their chat', async () => {
    const history: Record<string, HistItem[]> = {
      Ana: [
        { side: 'them', text: 'hola', ts: T0 },
        {
          side: 'them',
          call: { id: 'c0c0c0c0c0c0c0c0', direction: 'incoming', video: false, outcome: 'missed', duration_sec: 0 },
          ts: T0 + 10,
        },
      ],
    };
    const { hook } = setup({}, { history });
    // Until the contacts are read, nobody can tell that there are none.
    expect(hook.result.current.nodesLoaded).toBe(false);
    await waitFor(() => expect(hook.result.current.messages.Ana).toHaveLength(2));
    expect(hook.result.current.nodesLoaded).toBe(true);
    expect(hook.result.current.groups.map(g => g.name)).toEqual(['Familia']);
    expect(hook.result.current.messages.Ana?.[1]).toMatchObject({ key: 'call:c0c0c0c0c0c0c0c0', side: 'them' });
    expect(hook.result.current.historyFailed).toBe(false);
  });

  it('tells when the history could not be read, and reads it again', async () => {
    const { hook } = setup({}, { history: { Ana: [{ side: 'them', text: 'ya cargó', ts: T0 }] }, historyFails: true });
    await waitFor(() => expect(hook.result.current.historyFailed).toBe(true));
    await act(() => hook.result.current.reloadHistory());
    expect(hook.result.current.historyFailed).toBe(false);
    expect(hook.result.current.messages.Ana?.[0]?.text).toBe('ya cargó');
  });

  it('stops listening when unmounted', async () => {
    const { hook, listening } = setup();
    await loaded(hook);
    expect(listening()).toBeGreaterThan(0);
    hook.unmount();
    await flush();
    expect(listening()).toBe(0);
  });
});

describe('useConversations: what arrives', () => {
  it('counts a message as unread unless its chat is open and the window has the focus', async () => {
    const { hook, emit, focus, options } = setup();
    await loaded(hook);
    act(() => emit.messageReceived({ from_handle: 'Ana', text: 'hola', timestamp: T0 }));
    expect(hook.result.current.unread.Ana).toBe(1);

    hook.rerender({ ...options, openKey: 'Ana' });
    act(() => emit.messageReceived({ from_handle: 'Ana', text: 'sigo aquí', timestamp: T0 + 1 }));
    expect(hook.result.current.unread.Ana).toBe(1);

    focus.focused = false;
    act(() => emit.messageReceived({ from_handle: 'Ana', text: '¿estás?', timestamp: T0 + 2 }));
    expect(hook.result.current.unread.Ana).toBe(2);
    expect(hook.result.current.messages.Ana?.map(m => m.text)).toEqual(['hola', 'sigo aquí', '¿estás?']);
  });

  it('notifies by the same rule, and never for a muted group', async () => {
    const { hook, emit, notifier, options } = setup({}, { seed: { 'trino.pref.groupMuted:g1': '1' } });
    await loaded(hook);
    act(() => emit.messageReceived({ from_handle: 'Ana', text: encodeMeta('hola', { ttl: 60 }), timestamp: T0 }));
    expect(notifier.message).toHaveBeenCalledWith({ convo: ANA, title: 'Ana', text: 'hola', kind: 'text' });

    hook.rerender({ ...options, openKey: 'Ana' });
    act(() => emit.fileMessage({ from_handle: 'Ana', gid: null, file: sentFile('sticker::s1.png', 'image/png'), timestamp: T0 + 1 }));
    expect(notifier.message).toHaveBeenCalledTimes(1);

    // A muted group still counts what is unread, quietly.
    act(() => emit.groupMessage({ gid: 'g1', from_handle: 'Papá', text: 'Llego a las 7', timestamp: T0 + 2 }));
    expect(hook.result.current.unread['grp:g1']).toBe(1);
    expect(notifier.message).toHaveBeenCalledTimes(1);
  });

  it('notifies a file and a group message with the group and the sender', async () => {
    const { hook, emit, notifier } = setup();
    await loaded(hook);
    act(() => emit.fileMessage({ from_handle: 'Papá', gid: 'g1', file: sentFile('foto.jpg', 'image/jpeg'), timestamp: T0 }));
    expect(notifier.message).toHaveBeenLastCalledWith({ convo: FAMILIA, title: 'Familia', text: 'Papá: foto.jpg', kind: 'file' });
    act(() => emit.groupMessage({ gid: 'g1', from_handle: 'Papá', text: 'Llego a las 7', timestamp: T0 + 1 }));
    expect(notifier.message).toHaveBeenLastCalledWith({ convo: FAMILIA, title: 'Familia', text: 'Papá: Llego a las 7', kind: 'text' });
    act(() => emit.fileMessage({ from_handle: 'Mamá', gid: 'g1', file: sentFile('sticker::s9.png', 'image/png'), timestamp: T0 + 2 }));
    expect(notifier.message).toHaveBeenLastCalledWith({ convo: FAMILIA, title: 'Familia', text: 'Mamá: Sticker', kind: 'sticker' });
    expect(hook.result.current.messages['grp:g1']?.map(m => m.from)).toEqual(['Papá', 'Papá', 'Mamá']);
  });

  it('marks a chat read', async () => {
    const { hook, emit } = setup();
    await loaded(hook);
    act(() => emit.messageReceived({ from_handle: 'Ana', text: 'hola', timestamp: T0 }));
    act(() => hook.result.current.markRead('Ana'));
    expect(hook.result.current.unread.Ana ?? 0).toBe(0);
  });

  it('adds a logged call once, at the time it started, and never as unread or as a notification', async () => {
    const { hook, emit, notifier } = setup({}, { history: { Ana: [{ side: 'them', text: 'después', ts: T0 + 60 }] } });
    await waitFor(() => expect(hook.result.current.messages.Ana).toHaveLength(1));
    const log: CallLogWire = {
      peer: 'Ana',
      ts: T0,
      call: { id: 'c1c1c1c1c1c1c1c1', direction: 'incoming', video: false, outcome: 'missed', duration_sec: 0 },
    };
    act(() => emit.callLogged(log));
    act(() => emit.callLogged(log));
    expect(hook.result.current.messages.Ana?.map(m => m.key)).toEqual(['call:c1c1c1c1c1c1c1c1', `${T0 + 60}:0`]);
    expect(hook.result.current.unread.Ana ?? 0).toBe(0);
    expect(notifier.message).not.toHaveBeenCalled();
  });

  it('reads the contacts again when a contact changes its profile', async () => {
    const { hook, api, emit } = setup();
    await loaded(hook);
    api.listNodes.mockResolvedValueOnce([node('Ana', { profile_name: 'Ana T.', about: 'Hola' })]);
    act(() => emit.profileUpdated({ handle: 'Ana' }));
    await waitFor(() => expect(hook.result.current.nodes[0]?.about).toBe('Hola'));
  });

  it('resyncs a session the backend cleared, then resends what was waiting; resends it on a new session', async () => {
    const { hook, api, emit } = setup();
    await loaded(hook);
    act(() => emit.resyncNeeded('Ana'));
    await waitFor(() => expect(api.resendOutbox).toHaveBeenCalledWith('Ana'));
    expect(api.resyncSession).toHaveBeenCalledWith('Ana');
    expect(api.resyncSession.mock.invocationCallOrder[0]).toBeLessThan(api.resendOutbox.mock.invocationCallOrder[0]!);

    act(() => emit.sessionEstablished('Bea'));
    await waitFor(() => expect(api.resendOutbox).toHaveBeenCalledWith('Bea'));
  });

  it('reports a resync that failed', async () => {
    const onError = vi.fn();
    const { hook, api, emit } = setup({ onError });
    await loaded(hook);
    api.resyncSession.mockRejectedValueOnce(new Error('no'));
    act(() => emit.resyncNeeded('Ana'));
    await waitFor(() => expect(onError).toHaveBeenCalledWith({ kind: 'reconnect', handle: 'Ana' }));
  });
});

describe('useConversations: trust', () => {
  it('is verified while the stored fingerprint is the contact’s, and keyChanged once its keys change', async () => {
    const { hook, api, emit } = setup({}, { seed: { 'verified:Ana': 'fp-Ana' }, nodes: [node('Ana'), node('Bea')] });
    await loaded(hook);
    expect(hook.result.current.trust).toEqual({ Ana: 'verified', Bea: 'unverified' });

    act(() => emit.contactKeyMismatch({ handle: 'Ana' }));
    expect(hook.result.current.trust.Ana).toBe('keyChanged');

    await act(() => hook.result.current.acknowledgeKeyChange('Ana'));
    expect(api.acknowledgeKeyChange).toHaveBeenCalledWith('Ana');
    expect(hook.result.current.trust.Ana).toBe('verified');
  });

  it('shows keyChanged for a contact the backend marks with a key change (K8)', async () => {
    const { hook } = setup({}, { nodes: [node('Ana', { key_changed_at: T0, previous_fingerprint: 'old' })] });
    await loaded(hook);
    expect(hook.result.current.trust.Ana).toBe('keyChanged');
  });
});

describe('useConversations: sending', () => {
  it('shows a text at once as sending, then as sent at the time of its receipt', async () => {
    const { hook, api } = setup({}, { seed: { 'ttl:Ana': '60' } });
    await loaded(hook);
    let answer!: (value: { ts: number; accepted_by: string[] }) => void;
    api.sendMessage.mockImplementationOnce(() => new Promise(resolve => (answer = resolve)));

    act(() => hook.result.current.sendText(ANA, 'hola', { author: 'Ana', preview: '¿vienes?' }));
    expect(hook.result.current.messages.Ana?.[0]).toMatchObject({
      key: 'u1',
      side: 'me',
      text: 'hola',
      reply: { author: 'Ana', preview: '¿vienes?' },
      ttl: 60,
      state: 'sending',
    });
    await waitFor(() => expect(api.sendMessage).toHaveBeenCalled());
    // The body carries the reply and the chat's disappearing time.
    const body = encodeMeta('hola', { reply: { author: 'Ana', preview: '¿vienes?' }, ttl: 60 });
    expect(api.sendMessage).toHaveBeenCalledWith('Ana', body);

    await act(async () => answer({ ts: T0 + 3, accepted_by: ['wss://relay.example'] }));
    expect(hook.result.current.messages.Ana?.[0]).toMatchObject({ key: 'u1', state: 'sent', ts: T0 + 3 });
  });

  it('opens a session first when there is none', async () => {
    const { hook, api } = setup({}, { nodes: [node('Ana', { has_session: false })] });
    await loaded(hook);
    await act(async () => hook.result.current.sendText(ANA, 'hola'));
    expect(api.connectNode).toHaveBeenCalledWith('Ana');
    expect(api.connectNode.mock.invocationCallOrder[0]).toBeLessThan(api.sendMessage.mock.invocationCallOrder[0]!);
  });

  it('shows no sent mark without receipts (no K4)', async () => {
    const { hook, api } = setup({ capabilities: { sendAck: false, deleteForMe: false } });
    await loaded(hook);
    api.sendMessage.mockResolvedValueOnce({ ts: T0, accepted_by: [] });
    await act(async () => hook.result.current.sendText(ANA, 'hola'));
    expect(hook.result.current.messages.Ana?.[0]?.state).toBeUndefined();
  });

  it('marks a failed send with its reason, and a retry sends the same body again', async () => {
    const { hook, api } = setup();
    await loaded(hook);
    api.sendMessage.mockRejectedValueOnce({ code: 'offline', message: 'no relay' });
    await act(async () => hook.result.current.sendText(ANA, 'hola'));
    expect(hook.result.current.messages.Ana?.[0]).toMatchObject({ state: 'failed', failure: { kind: 'offline' } });

    api.sendMessage.mockResolvedValueOnce({ ts: T0 + 9, accepted_by: ['wss://r'] });
    await act(async () => hook.result.current.retry(ANA, 'u1'));
    expect(api.sendMessage).toHaveBeenLastCalledWith('Ana', 'hola');
    expect(hook.result.current.messages.Ana?.[0]).toMatchObject({ key: 'u1', state: 'sent', ts: T0 + 9 });
  });

  it('names the members a group message missed, and retries only to them', async () => {
    const { hook, api } = setup();
    await loaded(hook);
    api.sendGroupMessage.mockResolvedValueOnce({ ts: T0, accepted: ['Ana'], failed: ['Luis'] });
    await act(async () => hook.result.current.sendText(FAMILIA, 'hola'));
    expect(hook.result.current.messages['grp:g1']?.[0]).toMatchObject({
      state: 'failed',
      failure: { kind: 'partial', members: ['Luis'] },
    });

    api.sendGroupMessage.mockResolvedValueOnce({ ts: T0 + 5, accepted: ['Luis'], failed: [] });
    await act(async () => hook.result.current.retry(FAMILIA, 'u1'));
    expect(api.sendGroupMessage).toHaveBeenLastCalledWith('g1', 'hola', ['Luis']);
    expect(hook.result.current.messages['grp:g1']?.[0]?.state).toBe('sent');
  });

  it('sends files one by one and gives back the ones that failed', async () => {
    const { hook, api } = setup();
    await loaded(hook);
    const files: ProcessedFile[] = [
      { name: 'a.jpg', mime: 'image/jpeg', dataB64: 'AAAA', thumb: 'data:image/jpeg;base64,AA' },
      { name: 'b.pdf', mime: 'application/pdf', dataB64: 'BBBB', thumb: null },
    ];
    api.sendFile.mockImplementation(async (_handle, name, mime) => {
      if (name === 'b.pdf') throw { code: 'upload_failed', message: 'every server failed' };
      return { ...sentFile(name, mime), ts: T0 + 1, accepted_by: ['wss://r'] };
    });
    let result!: { failed: readonly ProcessedFile[] };
    await act(async () => {
      result = await hook.result.current.sendFiles(ANA, files);
    });
    expect(result.failed).toEqual([files[1]]);
    expect(api.sendFile).toHaveBeenCalledWith('Ana', 'a.jpg', 'image/jpeg', 'AAAA', 'data:image/jpeg;base64,AA');
    const [msg] = hook.result.current.messages.Ana ?? [];
    expect(msg).toMatchObject({ side: 'me', ts: T0 + 1, state: 'sent', file: sentFile('a.jpg', 'image/jpeg') });
    // The receipt is not part of the file the chat shows and forwards.
    expect(msg?.file).not.toHaveProperty('accepted_by');
  });

  it('sends a sticker as a file, with its picture inline only while the event stays small', async () => {
    const { hook, api } = setup();
    await loaded(hook);
    const small = { id: 's1', mime: 'image/png', data_url: 'data:image/png;base64,QUFB' };
    await act(() => hook.result.current.sendSticker(ANA, small));
    expect(api.sendFile).toHaveBeenLastCalledWith('Ana', 'sticker::s1.png', 'image/png', 'QUFB', small.data_url);

    const big = { id: 's2', mime: 'image/webp', data_url: `data:image/webp;base64,${'A'.repeat(STICKER_INLINE_MAX)}` };
    await act(() => hook.result.current.sendSticker(FAMILIA, big));
    expect(api.sendGroupFile).toHaveBeenLastCalledWith('g1', 'sticker::s2.webp', 'image/webp', 'A'.repeat(STICKER_INLINE_MAX), null);
  });

  it('forwards a text by sending it again, and a file without uploading it again', async () => {
    const history: Record<string, HistItem[]> = {
      Ana: [
        { side: 'them', text: encodeMeta('mira esto', { ttl: 60 }), ts: T0 },
        { side: 'them', file: sentFile('plano.pdf'), ts: T0 + 1 },
      ],
    };
    const { hook, api } = setup({}, { history, nodes: [node('Ana'), node('Bea')] });
    await waitFor(() => expect(hook.result.current.messages.Ana).toHaveLength(2));
    await act(() => hook.result.current.forward(ANA, `${T0}:0`, { kind: 'contact', handle: 'Bea' }));
    expect(api.sendMessage).toHaveBeenLastCalledWith('Bea', 'mira esto');
    await act(() => hook.result.current.forward(ANA, `${T0 + 1}:0`, FAMILIA));
    expect(api.forwardFile).toHaveBeenCalledWith('g1', true, sentFile('plano.pdf'));
    expect(hook.result.current.messages.Bea?.[0]).toMatchObject({ side: 'me', text: 'mira esto' });
    expect(hook.result.current.messages['grp:g1']?.[0]).toMatchObject({ side: 'me', file: sentFile('plano.pdf') });
  });
});

describe('useConversations: deleting and expiring', () => {
  const body = encodeMeta('bórralo', { ttl: 3600 });
  const history: Record<string, HistItem[]> = {
    Ana: [
      { side: 'me', text: body, ts: T0 },
      { side: 'them', file: sentFile('foto.jpg'), ts: T0 + 1 },
    ],
  };

  it('deletes for me with the body the backend matches (K11)', async () => {
    const { hook, api } = setup({}, { history });
    await waitFor(() => expect(hook.result.current.messages.Ana).toHaveLength(2));
    await act(() => hook.result.current.deleteForMe(ANA, `${T0}:0`));
    expect(api.deleteHistoryItem).toHaveBeenCalledWith('Ana', T0, 'me', body, null);
    await act(() => hook.result.current.deleteForMe(ANA, `${T0 + 1}:0`));
    expect(api.deleteHistoryItem).toHaveBeenLastCalledWith('Ana', T0 + 1, 'them', null, 'sha-foto.jpg');
    expect(hook.result.current.messages.Ana).toEqual([]);
  });

  it('keeps the message when deleting fails, unless the backend never had it', async () => {
    const { hook, api } = setup({}, { history });
    await waitFor(() => expect(hook.result.current.messages.Ana).toHaveLength(2));
    api.deleteHistoryItem.mockRejectedValueOnce({ code: 'io', message: 'disk' });
    await expect(act(() => hook.result.current.deleteForMe(ANA, `${T0}:0`))).rejects.toMatchObject({ code: 'io' });
    expect(hook.result.current.messages.Ana).toHaveLength(2);

    api.deleteHistoryItem.mockRejectedValueOnce({ code: 'not_found', message: 'gone' });
    await act(() => hook.result.current.deleteForMe(ANA, `${T0}:0`));
    expect(hook.result.current.messages.Ana).toHaveLength(1);
  });

  it('prunes what expired every 10 seconds, here and in the backend', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    vi.setSystemTime(T0 * 1000);
    const shortLived = { Ana: [{ side: 'them' as const, text: encodeMeta('dura poco', { ttl: 5 }), ts: T0 }] };
    const { hook, api } = setup({}, { history: shortLived });
    // waitFor polls with setInterval, which is fake here.
    await flush();
    expect(hook.result.current.messages.Ana).toHaveLength(1);
    await act(async () => {
      vi.advanceTimersByTime(10_000);
    });
    expect(hook.result.current.messages.Ana).toEqual([]);
    expect(api.pruneExpired).toHaveBeenCalled();
    expect(hook.result.current.now).toBe(T0 + 10);
  });

  it('moves a renamed contact and forgets a removed one', async () => {
    const { hook, emit } = setup({}, { history: { Ana: [{ side: 'them', text: 'hola', ts: T0 }] } });
    await waitFor(() => expect(hook.result.current.messages.Ana).toHaveLength(1));
    act(() => emit.messageReceived({ from_handle: 'Ana', text: 'otra', timestamp: T0 + 1 }));
    act(() => hook.result.current.renamed('Ana', 'Ana Torres'));
    expect(hook.result.current.messages['Ana Torres']).toHaveLength(2);
    expect(hook.result.current.unread['Ana Torres']).toBe(1);
    expect(hook.result.current.unread.Ana).toBeUndefined();
    act(() => hook.result.current.removed('Ana Torres'));
    expect(hook.result.current.messages['Ana Torres']).toBeUndefined();
    expect(hook.result.current.unread['Ana Torres']).toBeUndefined();
  });
});
