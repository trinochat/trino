/**
 * A chat with a contact or a group (Main:124-250): the header, the warning of
 * a changed security code, the log of messages and calls, and the composer.
 * It is a region named by the chat's name. The shell mounts it with
 * `key={convoKey}`, so what you reply to never crosses to another chat.
 *
 * What a message's options do lives here: Responder fills the reply bar and
 * puts the focus in the box; Copiar and a failed Borrar para mí say what
 * happened above the composer. You cannot write to a contact you blocked,
 * whose messages do not reach you, nor in a group you are no longer in:
 * a line says why in place of the composer. A blocked contact is never
 * called back either.
 */
import { Check, CircleAlert } from 'lucide-react';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { convoKey } from '../../lib/convo';
import { useT } from '../../lib/i18n';
import { Button, iconSize } from '../../ui';
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

export function ChatPane(props: ChatPaneProps) {
  const { header, onCall, onDeleteForMe, onRetry, onForward, onOpenLink, fetchFile } = props;
  const t = useT();
  const headingId = useId();
  const pane = useRef<HTMLElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const [reply, setReply] = useState<ReplyRef | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const composerRows = useComposerRows(pane);

  const contact = header.kind === 'contact';
  const blocked = header.kind === 'contact' && header.blocked;
  const ended = header.kind === 'group' && header.ended;
  const call = contact && !blocked ? onCall : undefined;

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
      onReply: next => {
        setReply(next);
        input.current?.focus();
      },
      onCopy: text => {
        const failed = () => setNotice({ tone: 'alert', text: t('msg2.copyFailed') });
        const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard;
        if (!clipboard) return failed();
        clipboard.writeText(text).then(() => setNotice({ tone: 'status', text: t('msg2.copied') }), failed);
      },
      onDeleteForMe: onDeleteForMe
        ? key => {
            onDeleteForMe(key).catch(() => setNotice({ tone: 'alert', text: t('msg2.deleteFailed') }));
          }
        : undefined,
    }),
    [onRetry, onForward, onOpenLink, fetchFile, onDeleteForMe, t],
  );

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
        reply={reply}
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
    </section>
  );
}
