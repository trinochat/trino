/**
 * A chat with a contact or a group (Main:124-250): the header, the warning of
 * a changed security code, the log of messages and calls, and the composer.
 * It is a region named by the chat's name. The shell mounts it with
 * `key={convoKey}`, so what you reply to never crosses to another chat.
 *
 * What a message's options do lives here: Responder fills the reply bar and
 * puts the focus in the box; Copiar says it copied. Borrar para mí asks
 * first, since it cannot be undone, and says above the composer when it
 * failed. You cannot write to a contact you blocked, whose messages do not
 * reach you, nor in a group you are no longer in: a line says why in place
 * of the composer, and no message offers Responder. A blocked contact is
 * never called back either.
 */
import { Check, CircleAlert, Trash2 } from 'lucide-react';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { convoKey } from '../../lib/convo';
import { useT } from '../../lib/i18n';
import { Button, Dialog, iconSize } from '../../ui';
import type { ChatPaneProps, ReplyRef } from '../types';
import { ChatHeader } from './ChatHeader';
import { Composer } from './composer/Composer';
import { KeyChangeBanner } from './KeyChangeBanner';
import type { MessageActions } from './MessageItem';
import { MessageList } from './MessageList';
import { useComposerRows } from './use-composer-rows';

/** How long "Mensaje copiado." stays, in ms. */
const NOTICE_MS = 4000;

type Notice = { tone: 'status' | 'alert'; text: string };

/** The messages of a chat's log, in its order: calls are no messages and have no options. */
function messageRows(root: HTMLElement | null): HTMLElement[] {
  return Array.from(root?.querySelectorAll<HTMLElement>('[data-message]') ?? []);
}

interface DeleteQuestionProps {
  /** In a group the message reached several people. */
  group: boolean;
  /** The contact, or the group. */
  name: string;
  onCancel(): void;
  onConfirm(): void;
}

/**
 * The question before Borrar para mí, which K11 makes permanent: an
 * alertdialog that starts on Cancelar, as Escape does, and a solid red
 * button with its icon and its verb. It says what the deletion reaches:
 * this device only, for good; whoever already has the message keeps it.
 */
function DeleteQuestion({ group, name, onCancel, onConfirm }: DeleteQuestionProps) {
  const t = useT();
  const cancel = useRef<HTMLButtonElement>(null);
  return (
    <Dialog
      open
      role="alertdialog"
      size="sm"
      title={t('msg2.deleteTitle')}
      description={group ? t('msg2.deleteBodyGroup') : t('msg2.deleteBody', { name })}
      initialFocusRef={cancel}
      onClose={onCancel}
    >
      <div className="flex flex-wrap justify-end gap-2">
        <Button ref={cancel} onClick={onCancel}>
          {t('common2.cancel')}
        </Button>
        <Button variant="dangerSolid" leadingIcon={<Trash2 {...iconSize('md')} />} onClick={onConfirm}>
          {t('msg2.deleteForMe')}
        </Button>
      </div>
    </Dialog>
  );
}

export function ChatPane(props: ChatPaneProps) {
  const { header, onCall, onDeleteForMe, onRetry, onForward, onOpenLink, fetchFile } = props;
  const t = useT();
  const headingId = useId();
  const pane = useRef<HTMLElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  /** What you reply to, and whether that message is yours. */
  const [reply, setReply] = useState<{ ref: ReplyRef; yours: boolean } | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  /** The message Borrar para mí asks about, until you answer. */
  const [deleting, setDeleting] = useState<string | null>(null);
  /** A deletion on its way: the message that goes, and the one that takes the focus it leaves. */
  const refocus = useRef<{ gone: string; next: string | null } | null>(null);
  const composerRows = useComposerRows(pane);

  const contact = header.kind === 'contact';
  const blocked = header.kind === 'contact' && header.blocked;
  const ended = header.kind === 'group' && header.ended;
  const call = contact && !blocked ? onCall : undefined;
  const writable = !blocked && !ended;

  // A status leaves on its own; an alert stays until the next notice.
  useEffect(() => {
    if (notice?.tone !== 'status') return;
    const timer = setTimeout(() => setNotice(null), NOTICE_MS);
    return () => clearTimeout(timer);
  }, [notice]);

  const actions = useMemo<MessageActions>(
    () => ({
      onRetry,
      onForward,
      onOpenLink,
      fetchFile,
      onReply: writable
        ? (next, yours) => {
            setReply({ ref: next, yours });
            input.current?.focus();
          }
        : undefined,
      onCopy: text => {
        const failed = () => setNotice({ tone: 'alert', text: t('msg2.copyFailed') });
        const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard;
        if (!clipboard) return failed();
        clipboard.writeText(text).then(() => setNotice({ tone: 'status', text: t('msg2.copied') }), failed);
      },
      onDeleteForMe: onDeleteForMe ? setDeleting : undefined,
    }),
    [onRetry, onForward, onOpenLink, fetchFile, onDeleteForMe, writable, t],
  );

  const confirmDelete = () => {
    const key = deleting;
    setDeleting(null);
    if (key === null || !onDeleteForMe) return;
    const rows = messageRows(pane.current);
    const at = rows.findIndex(row => row.dataset.message === key);
    const next = at < 0 ? undefined : (rows[at + 1] ?? rows[at - 1]);
    refocus.current = { gone: key, next: next?.dataset.message ?? null };
    onDeleteForMe(key).catch(() => {
      refocus.current = null;
      setNotice({ tone: 'alert', text: t('msg2.deleteFailed') });
    });
  };

  // Once a deleted message has left, the focus it held goes to the next
  // message's options, else to the one before, else to the log; a focus you
  // already put somewhere else stays there.
  const { messages } = props;
  useEffect(() => {
    const pending = refocus.current;
    if (!pending || messages.some(msg => msg.key === pending.gone)) return;
    refocus.current = null;
    const active = document.activeElement;
    if (active && active !== document.body) return;
    const row = messageRows(pane.current).find(element => element.dataset.message === pending.next);
    const options = row?.querySelector<HTMLElement>('[aria-haspopup="menu"]');
    (options ?? pane.current?.querySelector<HTMLElement>('[role="log"]'))?.focus();
  }, [messages]);

  let footer;
  if (blocked) {
    footer = (
      <div className="flex flex-wrap items-center justify-center gap-3 border-t border-ui-line px-4 py-3 text-center text-ui-md text-ui-muted">
        <p className="min-w-0 flex-[1_1_16rem]">{t('chat2.blockedNote')}</p>
        <Button onClick={props.onOpenDetails}>{t('chat2.openDetails')}</Button>
      </div>
    );
  } else if (ended) {
    footer = (
      <p className="border-t border-ui-line px-4 py-3.5 text-center text-ui-md text-ui-muted">{t('chat2.endedNote')}</p>
    );
  } else {
    footer = (
      <Composer
        recipient={header.name}
        draft={props.draft}
        onDraftChange={props.onDraftChange}
        maxTextLength={props.maxTextLength}
        reply={reply?.ref ?? null}
        replyToYours={reply?.yours}
        onClearReply={() => setReply(null)}
        onSendText={props.onSendText}
        onSendFiles={props.onSendFiles}
        onSendSticker={props.onSendSticker}
        stickers={props.stickers}
        maxRows={composerRows}
        inputRef={input}
      />
    );
  }

  return (
    <section
      ref={pane}
      aria-labelledby={headingId}
      data-convo={convoKey(props.convo)}
      className="flex h-full min-h-0 min-w-0 flex-col bg-ui-surface"
    >
      <ChatHeader
        header={header}
        headingId={headingId}
        onCall={call}
        onOpenDetails={props.onOpenDetails}
        onVerify={props.onVerify}
        onBack={props.onBack}
      />
      {header.kind === 'contact' && header.trust === 'keyChanged' && (
        <KeyChangeBanner name={header.name} onVerify={props.onVerify} onAcknowledge={props.onAcknowledgeKeyChange} />
      )}
      <MessageList
        messages={props.messages}
        now={props.now}
        peer={header.kind === 'contact' ? { kind: 'contact', name: header.name } : { kind: 'group' }}
        actions={actions}
        onCall={call}
      />
      <div role="status" className="px-4 text-ui-md text-ui-muted">
        {notice?.tone === 'status' && (
          <span className="flex items-center gap-1.5 pt-2">
            <Check {...iconSize('md', 'shrink-0')} aria-hidden="true" />
            {notice.text}
          </span>
        )}
      </div>
      {notice?.tone === 'alert' && (
        <p role="alert" className="mx-4 mt-2 flex items-start gap-1.5 text-ui-md font-semibold text-ui-danger">
          <CircleAlert {...iconSize('md', 'mt-0.5 shrink-0')} aria-hidden="true" />
          {notice.text}
        </p>
      )}
      {footer}
      {deleting !== null && (
        <DeleteQuestion
          group={header.kind === 'group'}
          name={header.name}
          onCancel={() => setDeleting(null)}
          onConfirm={confirmDelete}
        />
      )}
    </section>
  );
}
