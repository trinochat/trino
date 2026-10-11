/**
 * The log of a conversation (Main:169-214): its messages and calls in time
 * order, a separator before each day, and a group member's name over the
 * first of their messages.
 *
 * It is a polite live region (role="log") that reads out only what is added,
 * once: every message keeps its key, so an update never mounts it again,
 * and a day's separator keeps its key when "Hoy" turns "Ayer". It scrolls on
 * its own and takes the focus, so the keyboard can scroll it too.
 */
import { ArrowDown } from 'lucide-react';
import { useMemo } from 'react';
import { useT } from '../../lib/i18n';
import { useLang } from '../../lib/i18n-context';
import { DaySeparator, FOCUS_RING_INSET, IconButton, cx, iconSize } from '../../ui';
import type { Msg } from '../types';
import { CallEventItem } from './CallEventItem';
import { withDaySeparators, type LogItem } from './day';
import { MessageItem, type MessageActions } from './MessageItem';
import { useStickyScroll } from './use-sticky-scroll';

export interface MessageListProps {
  messages: readonly Msg[];
  /** Epoch seconds: the day separators and the clocks of disappearing messages count from here. */
  now: number;
  /** A contact's chat, by the contact's name, or a group's, whose messages say who sent them. */
  peer: { kind: 'contact'; name: string } | { kind: 'group' };
  actions: MessageActions;
  /** Calls the contact back from a missed call; without it, no "Devolver llamada". */
  onCall?(video: boolean): void;
}

/** The newest message of the log, which the scrolling follows. */
function newest(items: readonly LogItem[]): Msg | undefined {
  const last = items[items.length - 1];
  return last?.type === 'msg' ? last.msg : undefined;
}

/** Whether `msg` goes on from `before` by the same person, so its name is not repeated. */
function sameRun(before: Msg | null, msg: Msg): boolean {
  return before !== null && !before.call && before.side === msg.side && before.from === msg.from;
}

export function MessageList({ messages, now, peer, actions, onCall }: MessageListProps) {
  const t = useT();
  const { lang } = useLang();
  const items = useMemo(() => withDaySeparators(messages, now, lang, t), [messages, now, lang, t]);
  const last = newest(items);
  const scroll = useStickyScroll(last?.key, last?.side === 'me');

  let before: Msg | null = null;
  const rows = items.map(item => {
    if (item.type === 'day') {
      before = null;
      return <DaySeparator key={item.key} label={item.label} />;
    }
    const msg = item.msg;
    const run = sameRun(before, msg);
    before = msg;
    if (msg.call) return <CallEventItem key={msg.key} call={msg.call} ts={msg.ts} onCall={onCall} />;
    const author = peer.kind === 'contact' ? peer.name : (msg.from ?? t('msg2.someone'));
    return (
      <MessageItem
        key={msg.key}
        msg={msg}
        now={now}
        sender={peer.kind === 'group' && msg.side === 'them' && !run ? author : undefined}
        authorName={author}
        actions={actions}
      />
    );
  });

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div
        ref={scroll.ref}
        role="log"
        aria-live="polite"
        aria-relevant="additions"
        aria-label={t('chat2.log')}
        tabIndex={0}
        onScroll={scroll.onScroll}
        className={cx('flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto p-4', FOCUS_RING_INSET)}
      >
        {rows.length === 0 ? <p className="m-auto text-center text-ui-md text-ui-muted">{t('chat2.empty')}</p> : rows}
      </div>
      {scroll.away && (
        <IconButton
          aria-label={t('chat2.toLatest')}
          variant="secondary"
          icon={<ArrowDown {...iconSize('lg')} />}
          onClick={event => {
            // The button goes once you are at the newest message: its focus goes to the log.
            const focused = event.currentTarget === document.activeElement;
            scroll.toEnd();
            if (focused) scroll.ref.current?.focus({ preventScroll: true });
          }}
          className="absolute bottom-3 end-4 [box-shadow:var(--t-shadow)]"
        />
      )}
    </div>
  );
}
