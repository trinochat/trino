/**
 * The composer (Main:234-246): Adjuntar archivo, Emojis and Stickers, the
 * text box and Enviar, with the hint "Enter envía · Shift+Enter, nueva línea"
 * under them. Above, when there are any: a problem, what you reply to and
 * the files about to go.
 *
 * The text is the pane's draft (`draft`, `onDraftChange`), so it survives a
 * change of chat. Enter sends and Shift+Enter breaks the line; an input
 * method keeps its Enter. A message over `maxTextLength` characters, as
 * people count them (an emoji is one), says so and does not go. Files go
 * first, then the text, which waits while any file failed: what failed stays
 * in the tray to try again. Pasted pictures join the tray.
 *
 * The box stays open while the files go. The text that goes is what it held
 * when you sent, and only that text leaves it: what you typed meanwhile
 * stays for the next message. If you open another chat before the files are
 * through, this composer and its tray go, so a file or a sticker that fails
 * then is told in a toast that stays (the app's ToastProvider, at its root).
 */
import { CircleAlert, Paperclip, Send, Smile, Sticker } from 'lucide-react';
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type KeyboardEvent,
  type Ref,
} from 'react';
import type { StickerInfo } from '../../../lib/api';
import { useT } from '../../../lib/i18n';
import { useLang } from '../../../lib/i18n-context';
import { processFile, type ProcessedFile } from '../../../lib/media';
import { IconButton, Textarea, cx, iconSize, useToast } from '../../../ui';
import type { ReplyRef, StickerApi } from '../../types';
import { nameList } from '../lists';
import { composerKeyAction } from './composer-keys';
import { EmojiPicker, detectPlatform, type EmojiPlatform } from './EmojiPicker';
import { FileTray, type TrayItem } from './FileTray';
import { Popover, type PopoverClose } from './Popover';
import { ReplyBar } from './ReplyBar';
import { StickerPicker, type StickerRecents } from './StickerPicker';

/** What the backend takes in one file (MAX_ATTACHMENT_BYTES): bigger ones are refused before they are read. */
const ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024;

export interface ComposerProps {
  /** Who the message goes to, the contact or the group: it names the text box. */
  recipient: string;
  draft: string;
  onDraftChange(text: string): void;
  /** In characters as people count them: Unicode code points, an emoji is one. */
  maxTextLength: number;
  reply: ReplyRef | null;
  /** Takes the reply back; the composer also calls it once the reply went. */
  onClearReply(): void;
  /** Optimistic: the message shows at once as sending. */
  onSendText(text: string, reply?: ReplyRef): void;
  /** Sends the files; the ones it gives back as `failed` stay in the tray, the same objects. */
  onSendFiles(files: readonly ProcessedFile[]): Promise<{ failed: readonly ProcessedFile[] }>;
  onSendSticker(s: StickerInfo): Promise<void>;
  stickers: StickerApi;
  /** Lines of text before the box scrolls: fewer in a short window (accesibilidad.md §4.7, rule 6). */
  maxRows?: number;
  /** The text box, so the pane can give it the focus (Responder). */
  inputRef?: Ref<HTMLTextAreaElement>;
  /** Strips a file's metadata and makes its preview: media.ts, unless a test brings its own. */
  prepareFile?(file: File): Promise<ProcessedFile>;
  /** Which system emoji panel to mention; the webview's own by default. */
  platform?: EmojiPlatform;
  /** Your recent stickers: `prefs` by default. */
  stickerRecents?: StickerRecents;
}

type Picker = 'emoji' | 'stickers';

/** Sets a ref of any kind to a node. */
function assign<T>(ref: Ref<T> | undefined, node: T | null) {
  if (typeof ref === 'function') ref(node);
  else if (ref) ref.current = node;
}

/**
 * The draft once `sent` went: the text you sent leaves it, and what you typed
 * around it while the files went stays. A draft that no longer holds the
 * sent text, because you changed it, stays as you left it.
 */
function withoutSent(draft: string, sent: string): string {
  const at = draft.indexOf(sent);
  return at < 0 ? draft : draft.slice(0, at) + draft.slice(at + sent.length);
}

export function Composer({
  recipient,
  draft,
  onDraftChange,
  maxTextLength,
  reply,
  onClearReply,
  onSendText,
  onSendFiles,
  onSendSticker,
  stickers,
  maxRows = 6,
  inputRef,
  prepareFile = processFile,
  platform,
  stickerRecents,
}: ComposerProps) {
  const t = useT();
  const { lang } = useLang();
  const toast = useToast();
  const box = useRef<HTMLTextAreaElement | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const emojiButton = useRef<HTMLButtonElement>(null);
  const stickerButton = useRef<HTMLButtonElement>(null);
  /** Where the cursor goes once the draft with a new emoji comes back. */
  const caret = useRef<number | null>(null);
  const nextFile = useRef(0);
  const boxId = useId();
  const hintId = useId();
  const tooLongId = useId();
  const [picker, setPicker] = useState<Picker | null>(null);
  const [tray, setTray] = useState<TrayItem[]>([]);
  const [sendingFiles, setSendingFiles] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  /** The draft and the reply as they are now, for a send that waited for its files. */
  const latest = useRef({ draft, reply });
  /** Still on screen: opening another chat unmounts the composer while its files may still be on their way. */
  const mounted = useRef(true);

  const count = [...draft].length;
  const tooLong = count > maxTextLength;

  useLayoutEffect(() => {
    latest.current = { draft, reply };
  });

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useLayoutEffect(() => {
    if (caret.current === null || !box.current) return;
    box.current.setSelectionRange(caret.current, caret.current);
    caret.current = null;
  }, [draft]);

  const setBox = useCallback(
    (node: HTMLTextAreaElement | null) => {
      box.current = node;
      assign(inputRef, node);
    },
    [inputRef],
  );

  const addFiles = (files: readonly File[]) => {
    for (const file of files) {
      if (file.size > ATTACHMENT_MAX_BYTES) {
        setProblem(t('composer2.fileTooBig', { name: file.name }));
        continue;
      }
      const id = `file-${nextFile.current++}`;
      setTray(items => [...items, { id, name: file.name, status: 'preparing' }]);
      prepareFile(file).then(
        ready => setTray(items => items.map(item => (item.id === id ? { id, name: ready.name, status: 'ready', file: ready } : item))),
        () => {
          setTray(items => items.filter(item => item.id !== id));
          setProblem(t('composer2.prepareFailed', { name: file.name }));
        },
      );
    }
  };

  /** What did not go, said where it still shows: the tray's line, or a toast once the chat closed. */
  const reportFailed = (failed: readonly ProcessedFile[]) => {
    const names = nameList(failed.map(file => file.name), lang);
    if (mounted.current) {
      setProblem(t('composer2.filesFailed', { names }));
      return;
    }
    const text =
      failed.length === 1
        ? t('composer2.fileFailedAway', { file: names, name: recipient })
        : t('composer2.filesFailedAway', { files: names, name: recipient });
    toast.show({ tone: 'error', text });
  };

  const send = async () => {
    if (sendingFiles || tooLong) return;
    // What the box holds now is what goes, even if you go on typing while the files go.
    const typed = draft;
    const text = typed.trim();
    const replyTo = reply;
    const ready = tray.flatMap(item => (item.status === 'ready' && item.file ? [item.file] : []));
    if (!text && ready.length === 0) return;
    setProblem(null);
    if (ready.length > 0) {
      setSendingFiles(true);
      let failed: readonly ProcessedFile[];
      try {
        ({ failed } = await onSendFiles(ready));
      } catch {
        failed = ready;
      }
      if (mounted.current) {
        setSendingFiles(false);
        setTray(items => items.filter(item => item.status !== 'ready' || (item.file !== undefined && failed.includes(item.file))));
      }
      if (failed.length > 0) {
        reportFailed(failed);
        return;
      }
    }
    if (text) {
      onSendText(text, replyTo ?? undefined);
      onDraftChange(withoutSent(latest.current.draft, typed));
      // A reply you chose while the files went stays for the next message.
      if (replyTo && latest.current.reply === replyTo) onClearReply();
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // WebKit gives the Enter that ends a composition keyCode 229 and isComposing false.
    const isComposing = event.nativeEvent.isComposing || event.keyCode === 229;
    const action = composerKeyAction({ key: event.key, shiftKey: event.shiftKey, isComposing });
    if (action === 'send') {
      event.preventDefault();
      void send();
    } else if (event.key === 'Escape' && reply && !isComposing) {
      event.preventDefault();
      onClearReply();
    }
  };

  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const pictures = Array.from(event.clipboardData?.items ?? []).flatMap(item => {
      const file = item.type.startsWith('image/') ? item.getAsFile() : null;
      return file ? [file] : [];
    });
    if (pictures.length === 0) return;
    event.preventDefault();
    addFiles(pictures);
  };

  const insertEmoji = (emoji: string) => {
    const start = box.current?.selectionStart ?? draft.length;
    const end = box.current?.selectionEnd ?? start;
    caret.current = start + emoji.length;
    onDraftChange(draft.slice(0, start) + emoji + draft.slice(end));
  };

  const closePicker = (reason: PopoverClose) => {
    const button = picker === 'emoji' ? emojiButton.current : stickerButton.current;
    setPicker(null);
    if (reason === 'escape') button?.focus();
  };

  const sendSticker = async (sticker: StickerInfo) => {
    setPicker(null);
    box.current?.focus();
    try {
      await onSendSticker(sticker);
    } catch {
      if (mounted.current) setProblem(t('composer2.stickerFailed'));
      else toast.show({ tone: 'error', text: t('composer2.stickerFailedAway', { name: recipient }) });
    }
  };

  const toggle = (which: Picker) => setPicker(open => (open === which ? null : which));

  /** Where the focus of a control that goes with its row lands: the text box. */
  const focusBox = () => box.current?.focus();

  return (
    <div className="flex flex-col gap-1.5 border-t border-ui-line px-4 py-3">
      {problem && (
        <p role="alert" className="flex items-start gap-1.5 text-ui-md font-semibold text-ui-danger">
          <CircleAlert {...iconSize('md', 'mt-0.5 shrink-0')} aria-hidden="true" />
          {problem}
        </p>
      )}
      {reply && <ReplyBar reply={reply} onCancel={onClearReply} focusBox={focusBox} />}
      {tray.length > 0 && (
        <FileTray
          items={tray}
          busy={sendingFiles}
          onRemove={id => setTray(items => items.filter(item => item.id !== id))}
          focusBox={focusBox}
        />
      )}
      {sendingFiles && (
        <p role="status" className="text-ui-sm text-ui-muted">
          {t('composer2.sendingFiles')}
        </p>
      )}
      <div className="relative flex flex-wrap items-end gap-1">
        <input
          ref={fileInput}
          type="file"
          multiple
          hidden
          tabIndex={-1}
          onChange={event => {
            const files = Array.from(event.target.files ?? []);
            event.target.value = '';
            addFiles(files);
          }}
        />
        <div className="flex shrink-0 gap-1">
          <IconButton
            aria-label={t('composer2.attach')}
            variant="muted"
            icon={<Paperclip {...iconSize('lg')} />}
            onClick={() => fileInput.current?.click()}
          />
          <IconButton
            ref={emojiButton}
            aria-label={t('composer2.emoji')}
            aria-haspopup="dialog"
            aria-expanded={picker === 'emoji'}
            variant="muted"
            icon={<Smile {...iconSize('lg')} />}
            onClick={() => toggle('emoji')}
          />
          <IconButton
            ref={stickerButton}
            aria-label={t('composer2.stickers')}
            aria-haspopup="dialog"
            aria-expanded={picker === 'stickers'}
            variant="muted"
            icon={<Sticker {...iconSize('lg')} />}
            onClick={() => toggle('stickers')}
          />
        </div>
        <div className="flex min-w-0 flex-[1_1_12rem] items-end gap-1">
          <label htmlFor={boxId} className="sr-only">
            {t('composer2.label', { name: recipient })}
          </label>
          <Textarea
            ref={setBox}
            id={boxId}
            value={draft}
            onChange={event => onDraftChange(event.target.value)}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            minRows={1}
            maxRows={maxRows}
            placeholder={tray.length > 0 ? t('composer2.placeholderFiles') : t('composer2.placeholder')}
            aria-describedby={cx(hintId, tooLong && tooLongId)}
            aria-invalid={tooLong || undefined}
            className="min-w-0 flex-1"
          />
          <IconButton
            aria-label={t('composer2.send')}
            variant="primary"
            icon={<Send {...iconSize('lg')} />}
            disabled={sendingFiles}
            onClick={() => void send()}
          />
        </div>
        {picker && (
          <Popover
            label={picker === 'emoji' ? t('emoji.title') : t('sticker2.title')}
            anchor={picker === 'emoji' ? emojiButton : stickerButton}
            onClose={closePicker}
          >
            {picker === 'emoji' ? (
              <EmojiPicker platform={platform ?? detectPlatform(navigator)} onPick={insertEmoji} />
            ) : (
              <StickerPicker api={stickers} onPick={sticker => void sendSticker(sticker)} recents={stickerRecents} />
            )}
          </Popover>
        )}
      </div>
      {tooLong && (
        <p id={tooLongId} role="alert" className="flex items-start gap-1.5 text-ui-md font-semibold text-ui-danger">
          <CircleAlert {...iconSize('md', 'mt-0.5 shrink-0')} aria-hidden="true" />
          {t('composer2.tooLong', { count, max: maxTextLength })}
        </p>
      )}
      <p id={hintId} className="self-end text-ui-xs text-ui-muted">
        {t('composer2.hint')}
      </p>
    </div>
  );
}
