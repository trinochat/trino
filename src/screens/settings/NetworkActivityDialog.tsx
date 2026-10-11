/**
 * "Actividad de red", rebuilt from the old RelayInspector (App.tsx): what
 * the relays this device is connected to can see of each event, which is
 * never its content, encrypted, but the keys of who sends and who gets it,
 * when and how big. The watching happens in Rust (`relay_inspect_start`):
 * it listens first, then starts, and stops when the dialog closes, once no
 * start is still connecting.
 */
import { ArrowRight, Lock } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { RelayObservation } from '../../lib/api';
import { clockTime } from '../../lib/dates';
import { useT } from '../../lib/i18n';
import { useLang } from '../../lib/i18n-context';
import { Dialog, iconSize } from '../../ui';
import { ErrorLine } from './ErrorLine';
import type { SettingsApi } from './types';

export interface NetworkActivityDialogProps {
  api: Pick<SettingsApi, 'relayInspectStart' | 'relayInspectStop' | 'onRelayEvent'>;
  /** Your network key, to mark your own events. */
  myNostrPub?: string;
  onClose(): void;
}

/** The newest events, as the old inspector kept them. */
const MAX_EVENTS = 80;
/** How much of a key is shown: enough to tell keys apart, never the whole. */
const KEY_CHARS = 12;

type Watch = { state: 'starting' } | { state: 'watching'; relays: string[] } | { state: 'failed' };

/*
 * The backend keeps one list of inspector connections for the app: a start
 * closes what is there and adds each relay as it connects, which can take
 * seconds, and a stop closes only what is there. A stop sent while a start
 * still connects leaves the relays it connects later open, streaming to
 * nobody. So a dialog that closes waits for every start still connecting,
 * its own and any earlier one, before it stops; and only the dialog opened
 * last stops, so a dialog that closed never cuts the watch of the one open
 * now, whose own closing stops everything.
 */
const connecting = new Set<Promise<unknown>>();
let lastOpened = 0;

export function NetworkActivityDialog({ api, myNostrPub, onClose }: NetworkActivityDialogProps) {
  const t = useT();
  const { lang } = useLang();
  const [watch, setWatch] = useState<Watch>({ state: 'starting' });
  const [events, setEvents] = useState<RelayObservation[]>([]);

  useEffect(() => {
    const opening = ++lastOpened;
    let live = true;
    let unlisten: (() => void) | undefined;
    (async () => {
      try {
        const stop = await api.onRelayEvent(event => {
          setEvents(current => [event, ...current.filter(other => other.id !== event.id)].slice(0, MAX_EVENTS));
        });
        if (!live) {
          stop();
          return;
        }
        unlisten = stop;
        const start = api.relayInspectStart();
        connecting.add(start);
        const settled = () => connecting.delete(start);
        start.then(settled, settled);
        const relays = await start;
        if (live) setWatch({ state: 'watching', relays });
      } catch {
        if (live) setWatch({ state: 'failed' });
      }
    })();
    return () => {
      live = false;
      unlisten?.();
      void Promise.allSettled([...connecting])
        .then(() => (opening === lastOpened ? api.relayInspectStop() : undefined))
        .catch(() => {});
    };
    // Once per opening.
  }, []);

  const who = (key: string) =>
    !key ? (
      <span className="text-ui-muted">{t('settings2.network.noRecipient')}</span>
    ) : myNostrPub && key === myNostrPub ? (
      <span className="font-bold text-ui-accent-text">{t('settings2.network.you')}</span>
    ) : (
      <span className="font-ui-mono">{key.slice(0, KEY_CHARS)}</span>
    );

  return (
    <Dialog open size="lg" onClose={onClose} closeLabel={t('common2.close')} title={t('settings2.network.title')}>
      <p className="m-0 text-ui-md leading-normal text-ui-muted">{t('settings2.network.body')}</p>
      {watch.state === 'failed' ? (
        <ErrorLine>{t('settings2.network.error')}</ErrorLine>
      ) : (
        <p role="status" className="m-0 text-ui-md text-ui-ink">
          {watch.state === 'starting'
            ? t('settings2.network.connecting')
            : t('settings2.network.observing', { relays: watch.relays.join(' · ') })}
        </p>
      )}
      {events.length === 0 ? (
        <p className="m-0 text-ui-md text-ui-muted">{t('settings2.network.waiting')}</p>
      ) : (
        <ul
          role="list"
          aria-label={t('settings2.network.events')}
          className="m-0 flex max-h-80 list-none flex-col overflow-y-auto rounded-ui border border-ui-line p-0 font-ui text-ui-sm"
        >
          {events.map(event => (
            <li
              key={event.id}
              className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 border-b border-ui-line px-2.5 py-1.5 last:border-b-0"
            >
              <span className="font-ui-mono text-ui-muted">{clockTime(event.created_at, lang)}</span>
              <Lock {...iconSize('sm', 'shrink-0 text-ui-muted')} aria-hidden="true" />
              <span className="min-w-0 [overflow-wrap:anywhere]">{who(event.from)}</span>
              <ArrowRight {...iconSize('sm', 'shrink-0 text-ui-muted')} aria-hidden="true" />
              <span className="min-w-0 [overflow-wrap:anywhere]">{who(event.to)}</span>
              <span className="ml-auto text-ui-muted">{t('settings2.network.size', { n: event.size })}</span>
            </li>
          ))}
        </ul>
      )}
      {myNostrPub ? (
        <p className="m-0 text-ui-sm text-ui-muted">
          {t('settings2.network.yourKey', { key: myNostrPub.slice(0, 16) })}
        </p>
      ) : null}
    </Dialog>
  );
}
