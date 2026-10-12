import { describe, expect, it, vi } from 'vitest';
import { makeT } from '../lib/i18n';
import { createPrefs, type PrefsStorage } from '../lib/prefs';
import type { ConvoRef } from '../screens/types';
import { createNotifier } from './notifier';

// How the chats tell of a message that arrives where you are not looking
// (plan §4, I6). W2's shell decides when: its chat is not on screen or
// Trino is not in front, and its group is not muted. The notifier decides
// how, with what Settings > Notificaciones chose (W5) and the tone of W6.

function setup({ inFront = false }: { inFront?: boolean } = {}) {
  const data = new Map<string, string>();
  const storage: PrefsStorage = {
    getItem: key => data.get(key) ?? null,
    setItem: (key, value) => {
      data.set(key, value);
    },
    removeItem: key => {
      data.delete(key);
    },
  };
  const prefs = createPrefs(storage);
  const notify = vi.fn(async (_title: string, _body: string) => {});
  const tone = vi.fn();
  const front = { now: inFront };
  const notifier = createNotifier({ prefs, t: makeT('es'), notify, tone, isWindowFocused: () => front.now });
  return { notifier, prefs, notify, tone, front };
}

const ANA: ConvoRef = { kind: 'contact', handle: 'Ana' };
const FAMILIA: ConvoRef = { kind: 'group', gid: 'g1' };

describe('createNotifier', () => {
  it('notifies the system while Trino is not in front, by default with the name and not the message', () => {
    const { notifier, notify, tone } = setup();
    notifier.message({ convo: ANA, title: 'Ana', text: 'Llego a las 7', kind: 'text' });
    expect(notify).toHaveBeenCalledWith('Ana', 'Nuevo mensaje');
    // The system's notification makes its own sound: the tone would be a second one.
    expect(tone).not.toHaveBeenCalled();
  });

  it('plays the message tone while Trino is in front, with no notification of the system', () => {
    const { notifier, notify, tone } = setup({ inFront: true });
    notifier.message({ convo: ANA, title: 'Ana', text: 'Llego a las 7', kind: 'text' });
    expect(tone).toHaveBeenCalledTimes(1);
    expect(notify).not.toHaveBeenCalled();
  });

  it('plays no tone when Settings turned the message sound off', () => {
    const { notifier, prefs, tone } = setup({ inFront: true });
    prefs.setMessageSound(false);
    notifier.message({ convo: ANA, title: 'Ana', text: 'hola', kind: 'text' });
    expect(tone).not.toHaveBeenCalled();
  });

  // Settings > Notificaciones: "Nombre y mensaje", "Solo el nombre" or "Nada".
  it.each([
    ['full', { title: 'Ana', text: 'Llego a las 7', kind: 'text' }, ['Ana', 'Llego a las 7']],
    ['full', { title: 'Ana', text: 'contrato.pdf', kind: 'file' }, ['Ana', 'Te envió un archivo']],
    ['full', { title: 'Ana', kind: 'sticker' }, ['Ana', 'Te envió un sticker']],
    ['name', { title: 'Ana', text: 'Llego a las 7', kind: 'text' }, ['Ana', 'Nuevo mensaje']],
    ['none', { title: 'Ana', text: 'Llego a las 7', kind: 'text' }, ['Trino Chat', 'Nuevo mensaje']],
  ] as const)('shows at the level "%s" only what Settings allows', (level, message, shown) => {
    const { notifier, prefs, notify } = setup();
    prefs.setNotifPreview(level);
    notifier.message({ convo: ANA, ...message });
    expect(notify).toHaveBeenCalledWith(...shown);
  });

  // A mark of this device that cuts the sound and the notification (W4,
  // plan §1.4). The shell already leaves such a group out; the notifier
  // holds to the mark as well.
  it('neither sounds nor notifies for a group muted on this device', () => {
    const { notifier, prefs, notify, tone, front } = setup();
    prefs.setGroupMuted('g1', true);
    notifier.message({ convo: FAMILIA, title: 'Familia', text: 'Mamá: Llego a las 7', kind: 'text' });
    front.now = true;
    notifier.message({ convo: FAMILIA, title: 'Familia', text: 'Mamá: Llego a las 7', kind: 'text' });
    expect(notify).not.toHaveBeenCalled();
    expect(tone).not.toHaveBeenCalled();

    prefs.setGroupMuted('g1', false);
    notifier.message({ convo: FAMILIA, title: 'Familia', text: 'Mamá: Llego a las 7', kind: 'text' });
    expect(tone).toHaveBeenCalledTimes(1);
  });

  it('reads Settings at each message, so a change applies to the next one', () => {
    const { notifier, prefs, notify } = setup();
    notifier.message({ convo: ANA, title: 'Ana', text: 'uno', kind: 'text' });
    prefs.setNotifPreview('full');
    notifier.message({ convo: ANA, title: 'Ana', text: 'dos', kind: 'text' });
    expect(notify.mock.calls).toEqual([
      ['Ana', 'Nuevo mensaje'],
      ['Ana', 'dos'],
    ]);
  });

  it('lets a notification that fails go without breaking the chats', async () => {
    const { notifier, notify } = setup();
    notify.mockRejectedValueOnce(new Error('no permission'));
    expect(() => notifier.message({ convo: ANA, title: 'Ana', text: 'hola', kind: 'text' })).not.toThrow();
    // An unhandled rejection would fail the run after this test.
    await Promise.resolve();
  });
});
