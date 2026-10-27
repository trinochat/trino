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
 *
 * A right-click on the bubble, or Shift + F10 or the menu key on what has
 * the focus in it, opens the same options as a menu at the pointer (MC-2,
 * PropMenuContextual): on a link, Abrir enlace and Copiar enlace; on a photo,
 * a video or a file, Ver, Descargar and, for a photo where the clipboard
 * takes pictures, Copiar imagen, then the options of the message; and while
 * text in the message is marked, Copiar selección first, in place of Copiar,
 * or alone when the marked text runs over several messages. Beside the
 * bubble, where the row is blank, nothing opens.
 *
 * Who wrote it shows only by the bubble's side and colour, so screen readers
 * hear it first, out of sight: "Tú:" or "Ana Torres:". Where the bubble shows
 * a group member's name, that line is hidden from them instead, so the name
 * is read once.
 */
import { Copy, Download, ExternalLink, Link, Maximize2, Timer } from 'lucide-react';
import { useRef } from 'react';
import type { FileRef } from '../../lib/api';
import { clockTime } from '../../lib/dates';
import { DICTS, useT, type Lang, type TFunction } from '../../lib/i18n';
import { useLang } from '../../lib/i18n-context';
import { Button, MessageBubble, cx, iconSize, useContextMenu, type ContextMenuRequest, type MenuEntry } from '../../ui';
import type { Msg, ReplyRef, SendFailure, SendState } from '../types';
import { Attachment, fileKind, type AttachmentHandle } from './attachments/Attachment';
import { remainingDuration } from './durations';
import { Linkify } from './Linkify';
import { nameList } from './lists';
import { MessageMenu, messageEntries, type MessageMenuActions } from './MessageMenu';
import { ReplyQuote } from './ReplyQuote';

/** What the chat does with a message; the pane passes them down. */
export interface MessageActions {
  onRetry(msgKey: string): void;
  /**
   * `yours`: the message is yours, so the reply bar says "tu mensaje".
   * Without it there is no "Responder": nobody can write here.
   */
  onReply?(reply: ReplyRef, yours: boolean): void;
  /** Copies text: the message's, or what `what` says it is, for the chat to say what it copied. */
  onCopy(text: string, what?: 'selection' | 'link'): void;
  /** Only where the clipboard takes pictures: copies a photo, as a PNG still on its way. */
  onCopyImage?(png: Promise<Blob>): void;
  onForward(msgKey: string): void;
  /** Without it (no K11) there is no "Borrar para mí". */
  onDeleteForMe?(msgKey: string): void;
  /** Opens the report with this message marked (UR-5); only on theirs. */
  onReport?(msgKey: string): void;
  onOpenLink(url: string): void;
  fetchFile(f: FileRef, maxBytes?: number): Promise<string>;
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
  /**
   * Of a contact a group made and you did not accept (UR-3, R-09): its file
   * shows no preview and nothing of it is fetched by itself.
   */
  guarded?: boolean;
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

/**
 * The text marked in the page, if any of it is in this bubble, and whether
 * all of it is.
 */
function markedText(bubble: Element): { text: string; within: boolean } | null {
  const selection = document.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;
  const text = selection.toString();
  const range = selection.getRangeAt(0);
  if (!text.trim() || !range.intersectsNode(bubble)) return null;
  return { text, within: bubble.contains(range.startContainer) && bubble.contains(range.endContainer) };
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

export function MessageItem({ msg, now, sender, authorName, actions, guarded = false }: MessageItemProps) {
  const t = useT();
  const { lang } = useLang();
  const row = useRef<HTMLDivElement>(null);
  const mine = msg.side === 'me';
  const text = msg.text ?? '';
  const left = secondsLeft(msg, now);
  const status = mine && msg.state ? { state: msg.state, label: t(STATUS_LABELS[msg.state]) } : undefined;
  const failed = mine && msg.state === 'failed';
  // "Tú" in a quote is whoever wrote the message that quotes: them in theirs, you in yours.
  const quotesItsAuthor = msg.reply !== undefined && YOU.has(msg.reply.author.trim().toLocaleLowerCase());
  const quoteAuthor = quotesItsAuthor && !mine ? authorName : msg.reply?.author;
  const { onReply, onCopyImage } = actions;
  const attachment = useRef<AttachmentHandle | null>(null);

  const options: MessageMenuActions = {
    onReply: onReply && (() => onReply({ author: mine ? t('msg2.you') : authorName, preview: replyPreview(msg, t) }, mine)),
    onCopy: text ? () => actions.onCopy(text) : undefined,
    onForward: () => actions.onForward(msg.key),
    onDelete: actions.onDeleteForMe ? () => actions.onDeleteForMe?.(msg.key) : undefined,
    onReport: actions.onReport && !mine ? () => actions.onReport?.(msg.key) : undefined,
  };

  /** The menu of a photo, a video or a file: what its card does, then the options of the message. */
  const cardMenu = (card: AttachmentHandle): ContextMenuRequest => {
    const entries: MenuEntry[] = [];
    if (card.view) {
      const label = t(card.kind === 'video' ? 'media.viewVideo' : 'media.viewPhoto');
      entries.push({ id: 'view', label, icon: Maximize2, onSelect: card.view });
    }
    entries.push({ id: 'download', label: t('media.download'), icon: Download, onSelect: card.download });
    const { copyImage } = card;
    if (copyImage && onCopyImage) {
      entries.push({ id: 'copy-image', label: t('media.copyImage'), icon: Copy, onSelect: () => onCopyImage(copyImage()) });
    }
    entries.push({ id: 'card-separator', separator: true }, ...messageEntries(options, t));
    return { label: t('media.menu', { name: card.name }), entries };
  };

  const contextMenu = useContextMenu(target => {
    const bubble = row.current?.querySelector('[data-direction]');
    if (!bubble) return null;
    const onBubble = bubble.contains(target);
    // The options button is the message's too; the rest of the row is blank.
    if (!onBubble && !target.closest('[aria-haspopup="menu"]')) return null;
    const link = onBubble ? target.closest('[data-link]') : null;
    if (link) {
      const url = link.getAttribute('data-link') ?? '';
      return {
        label: t('msg2.linkMenu'),
        entries: [
          { id: 'open-link', label: t('msg2.openLink'), icon: ExternalLink, onSelect: () => actions.onOpenLink(url) },
          { id: 'copy-link', label: t('msg2.copyLink'), icon: Link, onSelect: () => actions.onCopy(url, 'link') },
        ],
      };
    }
    if (onBubble && target.closest('[data-attachment]') && attachment.current) return cardMenu(attachment.current);
    const marked = markedText(bubble);
    if (marked) {
      const copySelection: MenuEntry = {
        id: 'copy-selection',
        label: t('msg2.copySelection'),
        icon: Copy,
        shortcut: { label: t('msg2.copyShortcut'), keys: 'Control+C' },
        onSelect: () => actions.onCopy(marked.text, 'selection'),
      };
      const rest = marked.within ? messageEntries({ ...options, onCopy: undefined }, t) : [];
      return {
        label: t('msg2.selectionMenu'),
        entries: rest.length > 0 ? [copySelection, { id: 'selection-separator', separator: true }, ...rest] : [copySelection],
      };
    }
    return { label: t('msg2.options'), entries: messageEntries(options, t) };
  });

  return (
    <div ref={row} data-message={msg.key} className="flex flex-col gap-1">
      <div
        {...contextMenu.triggerProps}
        className={cx('group/msg flex items-center gap-1', mine ? 'flex-row-reverse' : 'flex-row')}
      >
        <MessageBubble className="contents" direction={mine ? 'out' : 'in'} time={clockTime(msg.ts, lang)} status={status}>
          {/* MessageBubble's own name line, drawn here so screen readers skip it and hear the line after. */}
          {!mine && sender && (
            <span aria-hidden="true" className="text-ui-sm font-bold text-ui-accent-text">
              {sender}
            </span>
          )}
          <span className="sr-only">{mine ? t('msg2.byYou') : t('msg2.by', { name: authorName })}</span>
          {msg.reply && (
            <ReplyQuote author={quoteAuthor ?? ''} preview={msg.reply.preview} mine={mine} yours={mine && quotesItsAuthor} />
          )}
          {msg.file && (
            <Attachment ref={attachment} file={msg.file} mine={mine} fetchFile={actions.fetchFile} guarded={guarded} />
          )}
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
        <MessageMenu align={mine ? 'end' : 'start'} className={MENU_REVEAL} {...options} />
        {contextMenu.menu}
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
