/**
 * One message of a conversation (Main:174-212): its bubble, with the quote it
 * replies to, a file, the text with its links and the clock of a
 * disappearing message; then its options, and under a failed message what
 * happened and Reintentar.
 *
 * The bubble is the MessageBubble of src/ui. Its own box is left out
 * (`contents`) so the bubble and the options button sit side by side in one
 * row, and its width stays 72 % of the log's; this row draws the failure line
 * itself. The options appear when the pointer is over the message or the
 * focus is in it, as in Signal: a row "Opciones" under every message
 * (Main:200) doubled the height of the log once the received ones had it too.
 */
import { Timer } from 'lucide-react';
import { useRef } from 'react';
import type { FileRef } from '../../lib/api';
import { clockTime } from '../../lib/dates';
import { DICTS, useT, type Lang, type TFunction } from '../../lib/i18n';
import { useLang } from '../../lib/i18n-context';
import { Button, MessageBubble, cx, iconSize } from '../../ui';
import type { Msg, ReplyRef, SendFailure, SendState } from '../types';
import { Attachment, fileKind } from './attachments/Attachment';
import { remainingDuration } from './durations';
import { Linkify } from './Linkify';
import { nameList } from './lists';
import { MessageMenu } from './MessageMenu';
import { ReplyQuote } from './ReplyQuote';

/** What the chat does with a message; the pane passes them down. */
export interface MessageActions {
  onRetry(msgKey: string): void;
  onReply(reply: ReplyRef): void;
  onCopy(text: string): void;
  onForward(msgKey: string): void;
  /** Without it (no K11) there is no "Borrar para mí". */
  onDeleteForMe?(msgKey: string): void;
  onOpenLink(url: string): void;
  fetchFile(f: FileRef): Promise<string>;
}

export interface MessageItemProps {
  /** A message with text or a file; a call goes to CallEventItem. */
  msg: Msg;
  /** Epoch seconds: the clock of a disappearing message counts from here. */
  now: number;
  /** The name over a group member's message, on the first of a run. */
  sender?: string;
  /** Who sent their message, as you call them: the contact, or the group member. */
  authorName: string;
  actions: MessageActions;
}

const STATUS_LABELS: Readonly<Record<SendState, string>> = {
  sending: 'msg2.sending',
  sent: 'msg2.sent',
  failed: 'msg2.failed',
};

const FAILURE_TEXTS: Readonly<Record<Exclude<SendFailure, 'partial'>, string>> = {
  offline: 'msg2.notSentOffline',
  not_accepted: 'msg2.notSentRejected',
  too_long: 'msg2.notSentTooLong',
  no_session: 'msg2.notSentNoSession',
  other: 'msg2.notSent',
};

/**
 * "You" in every language of the app, as the old screens wrote it too ("tú").
 * A quote travels with its author as the sender wrote it, so "Tú" in their
 * message is them, who quoted themselves.
 */
const YOU = new Set(Object.values(DICTS).map(texts => (texts['msg2.you'] ?? '').toLocaleLowerCase()));

/** Out of sight until the pointer is over the message or the focus is in it; screen readers always have it. */
const MENU_REVEAL =
  'shrink-0 opacity-0 transition-opacity reduce-motion:transition-none group-hover/msg:opacity-100 group-focus-within/msg:opacity-100';

/** What a reply shows of a message: the start of its text, or what its file is. Like the wire, 90 characters. */
export function replyPreview(msg: Msg, t: TFunction): string {
  if (msg.text) return [...msg.text.replace(/\s+/g, ' ').trim()].slice(0, 90).join('');
  if (!msg.file) return '';
  switch (fileKind(msg.file)) {
    case 'sticker':
      return t('msg2.sticker');
    case 'image':
      return t('msg2.photo');
    case 'video':
      return t('msg2.video');
    case 'file':
      return t('msg2.file', { name: msg.file.name });
  }
}

/** Why a message was not sent, and for a group, who it did not reach. */
function failureText(failure: Msg['failure'], t: TFunction, lang: Lang): string {
  if (failure?.kind === 'partial') {
    const names = failure.members ?? [];
    return names.length === 0 ? t('msg2.notSent') : t('msg2.partial', { names: nameList(names, lang) });
  }
  return t(failure ? FAILURE_TEXTS[failure.kind] : 'msg2.notSent');
}

/** Seconds until a disappearing message goes, or undefined for one that stays. */
function secondsLeft(msg: Msg, now: number): number | undefined {
  if (msg.expiresAt !== undefined) return msg.expiresAt - now;
  if (msg.ttl) return msg.ts + msg.ttl - now;
  return undefined;
}

export function MessageItem({ msg, now, sender, authorName, actions }: MessageItemProps) {
  const t = useT();
  const { lang } = useLang();
  const row = useRef<HTMLDivElement>(null);
  const mine = msg.side === 'me';
  const text = msg.text ?? '';
  const left = secondsLeft(msg, now);
  const status = mine && msg.state ? { state: msg.state, label: t(STATUS_LABELS[msg.state]) } : undefined;
  const failed = mine && msg.state === 'failed';
  const quoteAuthor =
    msg.reply && !mine && YOU.has(msg.reply.author.trim().toLocaleLowerCase()) ? authorName : msg.reply?.author;

  return (
    <div ref={row} data-message={msg.key} className="flex flex-col gap-1">
      <div className={cx('group/msg flex items-center gap-1', mine ? 'flex-row-reverse' : 'flex-row')}>
        <MessageBubble
          className="contents"
          direction={mine ? 'out' : 'in'}
          sender={mine ? undefined : sender}
          time={clockTime(msg.ts, lang)}
          status={status}
        >
          {msg.reply && <ReplyQuote author={quoteAuthor ?? ''} preview={msg.reply.preview} mine={mine} />}
          {msg.file && <Attachment file={msg.file} mine={mine} fetchFile={actions.fetchFile} />}
          {text && (
            <p className="whitespace-pre-wrap text-ui-base [overflow-wrap:anywhere]">
              <Linkify text={text} onOpenLink={actions.onOpenLink} />
            </p>
          )}
          {left !== undefined && (
            <span
              className={cx(
                'inline-flex items-center gap-1 self-end text-ui-xs',
                mine ? 'text-ui-bubble-me-muted' : 'text-ui-muted',
              )}
            >
              <Timer {...iconSize('sm', 'shrink-0')} aria-hidden="true" />
              {t('msg2.ttl', { time: remainingDuration(left, lang) })}
            </span>
          )}
        </MessageBubble>
        <MessageMenu
          align={mine ? 'end' : 'start'}
          className={MENU_REVEAL}
          onReply={() => actions.onReply({ author: mine ? t('msg2.you') : authorName, preview: replyPreview(msg, t) })}
          onCopy={text ? () => actions.onCopy(text) : undefined}
          onForward={() => actions.onForward(msg.key)}
          onDelete={actions.onDeleteForMe ? () => actions.onDeleteForMe?.(msg.key) : undefined}
        />
      </div>
      {failed && (
        <div className="flex flex-wrap items-center justify-end gap-2 text-ui-md">
          <span className="font-semibold text-ui-danger">{failureText(msg.failure, t, lang)}</span>
          {msg.failure?.kind !== 'too_long' && (
            <Button
              onClick={event => {
                // The line goes once the message is on its way again: the focus stays with the message.
                const focused = event.currentTarget === document.activeElement;
                actions.onRetry(msg.key);
                if (focused) row.current?.querySelector<HTMLElement>('[aria-haspopup="menu"]')?.focus();
              }}
            >
              {t('common2.retry')}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
