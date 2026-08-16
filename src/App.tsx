import {
  useState,
  useEffect,
  useRef,
  useContext,
  createContext,
  Component,
  type CSSProperties,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { I18nContext, makeT, detectLang, useT, LANGS, type Lang } from './lib/i18n';
import {
  Activity,
  ArrowDown,
  Ban,
  Bell,
  BellOff,
  Check,
  ChevronDown,
  ChevronLeft,
  Clock3,
  Copy,
  Film,
  Fingerprint,
  Grid2X2,
  Hash,
  ImagePlus,
  Info,
  KeyRound,
  LoaderCircle,
  LockKeyhole,
  Megaphone,
  MessageCircle,
  Minus,
  MoreVertical,
  Palette,
  Paperclip,
  Pencil,
  Plus,
  Search as SearchIcon,
  SendHorizontal,
  Settings,
  Share2,
  ShieldAlert,
  ShieldCheck,
  ShieldQuestion,
  Smile,
  Smartphone,
  Square,
  Trash2,
  UserRound,
  UserPlus,
  UsersRound,
  X,
} from 'lucide-react';

// Lets the Settings modal change the active language + re-render the whole app.
const LangCtx = createContext<{ lang: Lang; setLang: (l: Lang) => void }>({
  lang: 'en',
  setLang: () => {},
});
const ThemeCtx = createContext<{
  theme: ThemePreference;
  setTheme: (theme: ThemePreference) => void;
}>({
  theme: loadThemePreference(),
  setTheme: () => {},
});
import { QRCodeSVG } from 'qrcode.react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { processFile, type ProcessedFile } from './lib/media';
import {
  ACCENT_OPTIONS,
  applyThemePreference,
  loadThemePreference,
  saveThemePreference,
  type ThemePreference,
  type ThemePreset,
} from './lib/theme';
import {
  BUNDLED_ANNOUNCEMENTS,
  loadAnnouncementFeed,
  type Announcement,
  type AnnouncementFeed,
} from './lib/announcements';
import {
  configureIceServers,
  initCall,
  handleSignal,
  startCall,
  acceptIncoming,
  rejectIncoming,
  hangup,
  toggleMute,
  toggleCamera,
  type CallErrorCode,
  type CallState,
  type MediaState,
} from './lib/call';
import {
  startRingback,
  startRingtone,
  stopRinging,
  blipConnect,
  blipEnd,
} from './lib/sfx';
import {
  api,
  notify,
  ensureNotifyPermission,
  onMessageReceived,
  onGroupMessage,
  onGroupUpdated,
  onFileMessage,
  onCallSignal,
  onResyncNeeded,
  onSessionEstablished,
  onRelayEvent,
  openLink,
  type NodeInfo,
  type GroupInfo,
  type FileRef,
  type ProfileResponse,
  type StatusResponse,
  type StickerInfo,
} from './lib/api';
import './App.css';

const isMobile = /android|iphone|ipad|ipod/i.test(navigator.userAgent);
const SAFE_RASTER_MIMES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
const SAFE_VIDEO_MIMES = new Set(['video/mp4', 'video/webm', 'video/ogg']);
const INLINE_THUMB_MAX_CHARS = 180_000;
const INLINE_STICKER_MAX_CHARS = 7_100_000;
const INLINE_MEDIA_MAX_CHARS = 35_000_000;

function safeInlineRasterSrc(
  src?: string | null,
  maxChars = INLINE_THUMB_MAX_CHARS,
): string | undefined {
  if (!src || src.length > maxChars) return undefined;
  const match = src.match(
    /^data:image\/(jpeg|png|gif|webp);base64,([A-Za-z0-9+/]+={0,2})$/,
  );
  return match ? src : undefined;
}

function safeInlineVideoSrc(src?: string | null): string | undefined {
  if (!src || src.length > INLINE_MEDIA_MAX_CHARS) return undefined;
  const match = src.match(/^data:video\/(mp4|webm|ogg);base64,([A-Za-z0-9+/]+={0,2})$/);
  return match ? src : undefined;
}

type Phase = 'boot' | 'forge' | 'unseal' | 'main';

interface ChatMessage {
  side: 'me' | 'them';
  text?: string;
  time: string;
  from?: string; // sender handle, for group messages
  file?: FileRef; // when present, this is a file/image message
  reply?: { author: string; preview: string }; // quoted message this replies to
  ttl?: number; // seconds until self-destruct
  expiresAt?: number; // absolute epoch seconds when it disappears
}

// New ASCII-safe metadata envelope for TTL (+optional reply):
// "trm1:" + base64url(JSON{t:text, d:ttlSec, r:{author,preview}}).
const META_PREFIX = 'trm1:';
// Per-conversation self-destruct TTL (seconds), stored locally. 0 = off.
function ttlFor(convoKey: string): number {
  const v = Number(localStorage.getItem('ttl:' + convoKey) || '0');
  return Number.isFinite(v) && v > 0 ? v : 0;
}
const TTL_OPTIONS: { key: string; v: number }[] = [
  { key: 'ttl.off', v: 0 },
  { key: 'ttl.seconds30', v: 30 },
  { key: 'ttl.minutes5', v: 300 },
  { key: 'ttl.hour1', v: 3600 },
  { key: 'ttl.day1', v: 86400 },
  { key: 'ttl.week1', v: 604800 },
];
function encodeMeta(
  text: string,
  opts: { reply?: { author: string; preview: string }; ttl?: number },
): string {
  if (opts.ttl) {
    const obj: { t: string; d: number; r?: { author: string; preview: string } } = {
      t: text,
      d: opts.ttl,
    };
    if (opts.reply) obj.r = { author: opts.reply.author, preview: opts.reply.preview.slice(0, 90) };
    return META_PREFIX + b64urlEncode(JSON.stringify(obj));
  }
  if (opts.reply) return encodeReply(opts.reply.author, opts.reply.preview, text);
  return text;
}

// Reply is encoded inside the message body (frontend-only, no wire change):
// \x01R\x01<b64 author>\x01<b64 preview>\x01<actual text>
const REPLY_MARK = 'R';
function encodeReply(author: string, preview: string, text: string): string {
  const a = btoa(unescape(encodeURIComponent(author)));
  const p = btoa(unescape(encodeURIComponent(preview.slice(0, 90))));
  return REPLY_MARK + a + '' + p + '' + text;
}
function decodeBody(body: string): {
  reply?: { author: string; preview: string };
  text: string;
  ttl?: number;
} {
  if (body.startsWith(META_PREFIX)) {
    try {
      const obj = JSON.parse(b64urlDecode(body.slice(META_PREFIX.length)));
      return {
        text: String(obj.t ?? ''),
        reply: obj.r ? { author: String(obj.r.author), preview: String(obj.r.preview) } : undefined,
        ttl: typeof obj.d === 'number' ? obj.d : undefined,
      };
    } catch {
      return { text: body };
    }
  }
  if (!body.startsWith(REPLY_MARK)) return { text: body };
  const parts = body.slice(REPLY_MARK.length).split('');
  if (parts.length < 3) return { text: body };
  try {
    return {
      reply: {
        author: decodeURIComponent(escape(atob(parts[0]!))),
        preview: decodeURIComponent(escape(atob(parts[1]!))),
      },
      text: parts.slice(2).join(''),
    };
  } catch {
    return { text: body };
  }
}

function App() {
  const [phase, setPhase] = useState<Phase>('boot');
  const [bootText, setBootText] = useState<string[]>([]);
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lang, setLangState] = useState<Lang>(detectLang);
  const [theme, setThemeState] = useState<ThemePreference>(loadThemePreference);
  const t = makeT(lang);
  const setLang = (l: Lang) => {
    localStorage.setItem('lang', l);
    setLangState(l);
  };
  const setTheme = (next: ThemePreference) => {
    saveThemePreference(next);
    setThemeState(next);
  };

  useEffect(() => {
    applyThemePreference(theme);
  }, [theme]);

  useEffect(() => {
    api.status().then(setStatus).catch(error => {
      console.error('startup status failed', error);
      setError(t('error.startup'));
    });
  }, []);

  useEffect(() => {
    if (phase !== 'boot' || !status) return;
    const lines = [
      '[+] kernel: trino 0.1.0',
      `[+] ${t('boot.console.storage')}: ${status.home_dir}`,
      status.has_vault
        ? `[+] ${t('boot.console.vaultFound')}`
        : `[+] ${t('boot.console.vaultMissing')}`,
      '',
      status.has_vault ? `> ${t('boot.console.unlock')}` : `> ${t('boot.console.create')}`,
    ];
    let idx = 0;
    const timer = setInterval(() => {
      setBootText(prev => [...prev, lines[idx]!]);
      idx++;
      if (idx >= lines.length) {
        clearInterval(timer);
        setTimeout(() => setPhase(status.has_vault ? 'unseal' : 'forge'), 500);
      }
    }, 140);
    return () => clearInterval(timer);
  }, [phase, status]);

  // Auto-lock: seal the vault after N minutes of inactivity (0 = disabled).
  useEffect(() => {
    if (phase !== 'main') return;
    const mins = Number(localStorage.getItem('autolock') ?? '5');
    if (!mins) return;
    let timer: ReturnType<typeof setTimeout>;
    const reset = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        api.lockVault().catch(() => {});
        setPhase('unseal');
      }, mins * 60_000);
    };
    const events = ['mousedown', 'keydown', 'touchstart', 'mousemove', 'wheel'];
    events.forEach(e => window.addEventListener(e, reset, { passive: true }));
    reset();
    return () => {
      clearTimeout(timer);
      events.forEach(e => window.removeEventListener(e, reset));
    };
  }, [phase]);

  return (
    <ThemeCtx.Provider value={{ theme, setTheme }}>
      <LangCtx.Provider value={{ lang, setLang }}>
        <I18nContext.Provider value={t}>
          <div className="h-full flex flex-col">
            {!isMobile && <Titlebar />}
            <main className="flex-1 overflow-hidden">
              {error && <div className="bg-crimson/20 text-crimson p-2 text-xs">{error}</div>}
              {phase === 'boot' && <BootScreen lines={bootText} />}
              {phase === 'forge' && <ForgeWizard onDone={() => setPhase('unseal')} />}
              {phase === 'unseal' && (
                <UnsealScreen
                  handle={status?.handle ?? ''}
                  onDone={() => setPhase('main')}
                />
              )}
              {phase === 'main' && <MainShell />}
            </main>
          </div>
        </I18nContext.Provider>
      </LangCtx.Provider>
    </ThemeCtx.Provider>
  );
}

function Titlebar() {
  const t = useT();
  const win = getCurrentWindow();
  return (
    <div
      data-tauri-drag-region
      className="flex h-9 select-none items-center border-b border-bg-line bg-bg-deep px-3"
    >
      <span className="pointer-events-none font-mono text-[11px] font-semibold tracking-[0.12em] text-ink-dim">
        TRINO://DESKTOP
      </span>
      <span className="pointer-events-none mx-2 text-bg-line">/</span>
      <span className="pointer-events-none text-[10px] uppercase tracking-[0.1em] text-ink-muted">
        {t('app.encryptedMesh')}
      </span>
      <div className="ml-auto flex items-center gap-1 -mr-1">
        <button
          type="button"
          aria-label={t('window.minimize')}
          onClick={() => win.minimize()}
          className="titlebar-button"
        >
          <Minus className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          aria-label={t('window.maximize')}
          onClick={() => win.toggleMaximize()}
          className="titlebar-button"
        >
          <Square className="h-3 w-3" />
        </button>
        <button
          type="button"
          aria-label={t('window.close')}
          onClick={() => win.close()}
          className="titlebar-button titlebar-button--danger"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}

function TrinoMark({ className = 'w-10 h-10', glow = true }: { className?: string; glow?: boolean }) {
  return (
    <svg
      className={className}
      viewBox="0 0 256 256"
      fill="none"
      style={glow ? { filter: 'drop-shadow(0 0 4px #22ff66)' } : undefined}
    >
      <rect x="10" y="10" width="236" height="236" rx="40" fill="#070a07" stroke="#22ff66" strokeWidth="4" strokeOpacity="0.7" />
      <circle cx="44" cy="46" r="5" fill="#ff5566" />
      <circle cx="64" cy="46" r="5" fill="#ffcc00" />
      <circle cx="84" cy="46" r="5" fill="#22ff66" />
      <polyline points="74,108 120,148 74,188" stroke="#22ff66" strokeWidth="15" strokeLinecap="round" strokeLinejoin="round" fill="none" />
      <rect x="140" y="172" width="54" height="16" rx="4" fill="#22ff66" />
    </svg>
  );
}

function AuthLayout({
  eyebrow,
  stage,
  title,
  description,
  children,
}: {
  eyebrow: string;
  stage?: string;
  title: string;
  description: string;
  children: ReactNode;
}) {
  const t = useT();
  return (
    <div className="auth-layout">
      <AuthAmbient />
      <section className="auth-intro">
        <div className="auth-brand">
          <TrinoMark className="h-12 w-12" glow={false} />
          <div>
            <div className="font-mono text-sm font-bold tracking-[0.16em] text-ink">
              TRINO://ID
            </div>
            <div className="mt-1 text-[10px] uppercase tracking-[0.12em] text-phosphor-dim">
              {t('boot.tagline')}
            </div>
          </div>
        </div>

        <div className="auth-intro__message">
          <span className="auth-kicker">{t('auth.privateNode')}</span>
          <div className="mt-4 text-xl font-semibold leading-snug text-ink">
            {t('auth.statement')}
          </div>
          <div className="mt-3 max-w-sm text-xs leading-relaxed text-ink-muted">
            {t('auth.statementSub')}
          </div>
        </div>

        <div className="auth-specs">
          <div><span>{t('auth.vault')}</span><strong>LOCAL / AES-256</strong></div>
          <div><span>{t('auth.connection')}</span><strong>RATCHET E2E</strong></div>
          <div><span>{t('auth.network')}</span><strong>NOSTR MESH</strong></div>
        </div>
      </section>

      <section className="auth-workspace">
        <div className="auth-workspace__inner animate-pop-in">
          <div className="flex items-center justify-between gap-4">
            <div className="auth-kicker">{eyebrow}</div>
            {stage && (
              <div className="text-[10px] uppercase tracking-[0.12em] text-ink-muted">
                {stage}
              </div>
            )}
          </div>
          <h1 className="mt-4 text-2xl font-semibold leading-tight text-ink">{title}</h1>
          <p className="mt-2 max-w-md text-xs leading-relaxed text-ink-muted">{description}</p>
          <div className="mt-7">{children}</div>
        </div>
      </section>
    </div>
  );
}

function BootScreen({ lines }: { lines: string[] }) {
  const t = useT();
  return (
    <AuthLayout
      eyebrow={t('boot.starting')}
      title={t('boot.title')}
      description={t('boot.description')}
    >
      <div className="boot-console" aria-live="polite">
        {lines.map((line, index) => (
          <div key={index} className="boot-console__line">
            <span className="text-phosphor/70">{String(index + 1).padStart(2, '0')}</span>
            <span>{line || ' '}</span>
          </div>
        ))}
        <span className="ml-9 inline-block h-4 w-2 bg-phosphor animate-cursor-blink" />
      </div>
    </AuthLayout>
  );
}

function ForgeWizard({ onDone }: { onDone: () => void }) {
  const t = useT();
  const [step, setStep] = useState<'input' | 'qr'>('input');
  const [handle, setHandle] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ otpauth_uri: string; bundle_json: string; fingerprint: string } | null>(null);

  const submit = async () => {
    setError(null);
    if (!handle.trim() || !passphrase) {
      setError(t('forge.required'));
      return;
    }
    setBusy(true);
    try {
      const r = await api.forge(handle.trim(), passphrase);
      setResult(r);
      setStep('qr');
    } catch (error) {
      console.error('identity creation failed', error);
      setError(t('forge.createError'));
    } finally {
      setBusy(false);
    }
  };

  if (step === 'qr' && result) {
    return (
      <AuthLayout
        eyebrow={t('forge.enrollment')}
        stage="02 / 02"
        title={t('forge.success')}
        description={t('forge.successDesc')}
      >
        <div className="auth-enrollment">
          <div className="auth-enrollment__qr">
            <div className="mb-3 flex items-center gap-2 text-xs text-ink-dim">
              <Smartphone className="h-4 w-4 text-cyan" />
              {t('forge.scan')}
            </div>
            <div className="qr-frame">
              <QRCodeSVG
                value={result.otpauth_uri}
                size={190}
                fgColor="#07100b"
                bgColor="#edf7f0"
              />
            </div>
          </div>

          <div className="space-y-3">
            <CopyBox label={t('forge.fingerprint')} value={result.fingerprint} />
            <details className="auth-details">
              <summary>{t('forge.showUri')}</summary>
              <pre>{result.otpauth_uri}</pre>
            </details>
          </div>
        </div>

        <div className="mt-5">
          <div className="mb-2 text-[10px] uppercase tracking-[0.12em] text-ink-muted">
            {t('forge.bundle')}
          </div>
          <BundleCopy json={result.bundle_json} />
        </div>

        <button className="auth-primary mt-6" onClick={onDone}>
          <LockKeyhole className="h-4 w-4" />
          {t('forge.continue')}
        </button>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout
      eyebrow={t('forge.title')}
      stage="01 / 02"
      title={t('forge.title')}
      description={t('forge.desc')}
    >
      <form
        className="auth-form"
        onSubmit={event => {
          event.preventDefault();
          submit();
        }}
      >
        <label className="auth-field">
          <span>{t('forge.handle')}</span>
        <input
          className="auth-input"
          value={handle}
          onChange={e => setHandle(e.target.value)}
          placeholder={t('forge.handlePlaceholder')}
          autoFocus
        />
        </label>

        <label className="auth-field">
          <span>{t('forge.pass')}</span>
        <input
          className="auth-input"
          type="password"
          value={passphrase}
          onChange={e => setPassphrase(e.target.value)}
          placeholder={t('forge.passPlaceholder')}
        />
        </label>

        <div className="auth-security-note">
          <KeyRound className="h-4 w-4 shrink-0 text-phosphor" />
          <span>{t('forge.passHint')}</span>
        </div>

        {error && <div className="auth-error">{error}</div>}

        <button className="auth-primary" disabled={busy} type="submit">
          {busy ? (
            <LoaderCircle className="h-4 w-4 animate-spin" />
          ) : (
            <Fingerprint className="h-4 w-4" />
          )}
          {busy ? t('forge.sealing') : t('forge.submit')}
        </button>
      </form>
    </AuthLayout>
  );
}

function BundleCopy({ json }: { json: string }) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  return (
    <div className="rounded-md border border-bg-line bg-bg-deep p-3">
      <pre className="max-h-24 overflow-y-auto whitespace-pre-wrap break-all font-mono text-[10px] leading-relaxed text-ink-muted">
        {json}
      </pre>
      <button
        className="term-button mt-3 text-xs"
        onClick={async () => {
          await navigator.clipboard.writeText(json);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
      >
        {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
        {copied ? t('common.copied') : t('common.copyBundle')}
      </button>
    </div>
  );
}

function CopyBox({ label, value }: { label: string; value: string }) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  return (
    <div className="w-full rounded-md border border-bg-line bg-bg-deep p-3">
      <div className="mb-1 text-[10px] uppercase tracking-[0.12em] text-ink-muted">{label}</div>
      <div className="flex items-center gap-2">
        <code className="max-h-16 flex-1 overflow-y-auto break-all text-[11px] text-ink-dim">{value}</code>
        <button
          className="icon-button border-bg-line"
          onClick={async () => {
            await navigator.clipboard.writeText(value);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
          title={copied ? t('common.copied') : t('common.copy')}
        >
          {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
        </button>
      </div>
    </div>
  );
}

function UnsealScreen({ handle, onDone }: { handle: string; onDone: () => void }) {
  const t = useT();
  const [passphrase, setPassphrase] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmWipe, setConfirmWipe] = useState(false);
  const [wiping, setWiping] = useState(false);

  const submit = async () => {
    setError(null);
    setBusy(true);
    try {
      await api.unseal(passphrase, code);
      onDone();
    } catch (error) {
      console.error('unlock failed', error);
      setError(t('unseal.unlockError'));
    } finally {
      setBusy(false);
    }
  };

  const doWipe = async () => {
    setWiping(true);
    try {
      await api.wipe();
      localStorage.clear();
      window.location.reload();
    } catch (error) {
      console.error('vault deletion failed', error);
      setError(t('unseal.deleteError'));
      setWiping(false);
    }
  };

  return (
    <AuthLayout
      eyebrow={t('unseal.eyebrow')}
      stage={t('unseal.status')}
      title={t('unseal.title')}
      description={t('unseal.desc')}
    >
      <div className="auth-identity-row">
        <Avatar
          name={handle || t('unseal.identity')}
          size={44}
          status="away"
          statusLabel={t('unseal.status')}
        />
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold text-ink">
            {handle || t('unseal.identity')}
          </div>
          <div className="mt-0.5 text-[10px] uppercase tracking-[0.12em] text-ink-muted">
            {t('unseal.localIdentity')}
          </div>
        </div>
      </div>

      <form
        className="auth-form mt-5"
        onSubmit={event => {
          event.preventDefault();
          submit();
        }}
      >
        <label className="auth-field">
          <span>{t('forge.pass')}</span>
        <input
          className="auth-input"
          type="password"
          value={passphrase}
          onChange={e => setPassphrase(e.target.value)}
          placeholder={t('unseal.passPlaceholder')}
          autoFocus
        />
        </label>

        <label className="auth-field">
          <span>{t('unseal.totp')}</span>
          <input
            className="auth-input auth-input--totp"
            inputMode="numeric"
            autoComplete="one-time-code"
            value={code}
            onChange={event => setCode(event.target.value.replace(/\D/g, '').slice(0, 6))}
            placeholder="000000"
          />
        </label>

        {error && <div className="auth-error">{error}</div>}

        <button className="auth-primary" disabled={busy} type="submit">
          {busy ? (
            <LoaderCircle className="h-4 w-4 animate-spin" />
          ) : (
            <LockKeyhole className="h-4 w-4" />
          )}
          {busy ? t('unseal.working') : t('unseal.submit')}
        </button>
      </form>

      <div className="auth-danger-zone">
        {!confirmWipe ? (
          <button
            className="auth-danger-trigger"
            onClick={() => setConfirmWipe(true)}
            type="button"
          >
            <Trash2 className="h-3.5 w-3.5" />
            {t('unseal.forgot')}
          </button>
        ) : (
          <div className="auth-danger-confirm animate-fade-in">
            <div className="text-xs leading-relaxed text-crimson">
              {t('unseal.wipeWarning')}
            </div>
            <div className="mt-3 flex gap-2">
              <button
                className="term-button flex-1 text-xs"
                disabled={wiping}
                onClick={() => setConfirmWipe(false)}
                type="button"
              >
                {t('common.cancel')}
              </button>
              <button
                className="flex flex-1 items-center justify-center gap-2 rounded-md border border-crimson/60 bg-crimson/10 px-3 py-2 text-xs text-crimson transition-colors hover:bg-crimson/20"
                disabled={wiping}
                onClick={doWipe}
                type="button"
              >
                {wiping && <LoaderCircle className="h-3.5 w-3.5 animate-spin" />}
                {wiping ? t('unseal.wiping') : t('unseal.wipe')}
              </button>
            </div>
          </div>
        )}
      </div>
    </AuthLayout>
  );
}

// Ambient CRT scanlines + faint vignette for the auth screens.
function AuthAmbient() {
  return (
    <div
      className="pointer-events-none absolute inset-0 opacity-50"
      style={{
        background:
          'repeating-linear-gradient(transparent 0 2px, rgba(34,255,102,0.025) 3px 3px)',
      }}
    />
  );
}

function ding(): void {
  try {
    new Audio(
      'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=',
    ).play().catch(() => {});
  } catch {
    // ignore
  }
}

type Selection =
  | { kind: 'node'; id: string }
  | { kind: 'group'; id: string }
  | { kind: 'system'; id: 'updates' }
  | null;
type SidebarView = 'chats' | 'groups';

const groupUnreadKey = (gid: string) => `grp:${gid}`;

function MainShell() {
  const t = useT();
  const [nodes, setNodes] = useState<NodeInfo[]>([]);
  const [groups, setGroups] = useState<GroupInfo[]>([]);
  const [sel, setSel] = useState<Selection>(null);
  const [msgsByHandle, setMsgsByHandle] = useState<Record<string, ChatMessage[]>>({});
  const [msgsByGroup, setMsgsByGroup] = useState<Record<string, ChatMessage[]>>({});
  const [showAddNode, setShowAddNode] = useState(false);
  const [showShare, setShowShare] = useState(false);
  const [showNewGroup, setShowNewGroup] = useState(false);
  const [showAddMember, setShowAddMember] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showInspector, setShowInspector] = useState(false);
  const [callState, setCallState] = useState<CallState>('idle');
  const [callPeer, setCallPeer] = useState<string | null>(null);
  const [callVideo, setCallVideo] = useState(false);
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  const [callSas, setCallSas] = useState('');
  const [callError, setCallError] = useState('');
  const [callMedia, setCallMedia] = useState<MediaState>({
    muted: false,
    cameraOn: false,
    hasVideo: false,
  });
  const [sealing, setSealing] = useState(false);
  const [forwarding, setForwarding] = useState<ChatMessage | null>(null);
  const [myFingerprint, setMyFingerprint] = useState('');
  const [myAvatar, setMyAvatar] = useState<string | null>(null);
  const [myHandle, setMyHandle] = useState('');
  const [search, setSearch] = useState('');
  const [sidebarView, setSidebarView] = useState<SidebarView>('chats');
  const [announcementFeed, setAnnouncementFeed] = useState<AnnouncementFeed>({
    announcements: BUNDLED_ANNOUNCEMENTS,
    source: 'bundled',
  });
  const [updatesMuted, setUpdatesMuted] = useState(
    () => localStorage.getItem('updates.muted') === '1',
  );
  const [updatesReadId, setUpdatesReadId] = useState(
    () => localStorage.getItem('updates.lastRead') || '',
  );
  const [activityError, setActivityError] = useState<string | null>(null);
  const activityTimerRef = useRef<number | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [unread, setUnread] = useState<Record<string, number>>({});
  const selRef = useRef(sel);
  useEffect(() => {
    selRef.current = sel;
  }, [sel]);

  const reportFailure = (message: string, error: unknown) => {
    console.error(message, error);
    setActivityError(message);
    if (activityTimerRef.current !== null) window.clearTimeout(activityTimerRef.current);
    activityTimerRef.current = window.setTimeout(() => setActivityError(null), 6000);
  };

  useEffect(
    () => () => {
      if (activityTimerRef.current !== null) window.clearTimeout(activityTimerRef.current);
    },
    [],
  );

  useEffect(() => {
    let active = true;
    loadAnnouncementFeed()
      .then(feed => {
        if (active) setAnnouncementFeed(feed);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);

  // Reliable "is the trino window focused?" flag. document.hasFocus() is
  // unreliable in the Tauri webview (can report focused while minimized or in
  // the tray), so we track the real window focus event instead. When it's
  // false we fire OS notifications, so they arrive whenever trino isn't in the
  // foreground — minimized, behind another window, or hidden to the tray.
  const windowFocusedRef = useRef(true);
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    const w = getCurrentWindow();
    w.isFocused()
      .then(f => {
        windowFocusedRef.current = f;
      })
      .catch(() => {});
    w.onFocusChanged(({ payload: focused }) => {
      windowFocusedRef.current = focused;
    })
      .then(fn => {
        unlisten = fn;
      })
      .catch(() => {});
    return () => unlisten?.();
  }, []);

  useEffect(() => {
    api
      .getProfile()
      .then(p => {
        setMyFingerprint(p.fingerprint);
        setMyAvatar(p.avatar ?? null);
        setMyHandle(p.handle ?? '');
      })
      .catch(() => {});
  }, []);

  // Ctrl/Cmd+K focuses the chat search (desktop convenience).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Self-destruct: prune expired messages from the view + from disk every 10s.
  useEffect(() => {
    const prune = (prev: Record<string, ChatMessage[]>, now: number) => {
      let changed = false;
      const next: Record<string, ChatMessage[]> = {};
      for (const [k, arr] of Object.entries(prev)) {
        const f = arr.filter(m => !m.expiresAt || m.expiresAt > now);
        if (f.length !== arr.length) changed = true;
        next[k] = f;
      }
      return changed ? next : prev;
    };
    const t = setInterval(() => {
      const now = Math.floor(Date.now() / 1000);
      setMsgsByHandle(prev => prune(prev, now));
      setMsgsByGroup(prev => prune(prev, now));
      api.pruneExpired().catch(() => {});
    }, 10000);
    return () => clearInterval(t);
  }, []);

  const refreshNodes = async () => {
    try {
      setNodes(await api.listNodes());
    } catch (e) {
      console.error(e);
    }
  };
  const refreshGroups = async () => {
    try {
      setGroups(await api.listGroups());
    } catch (e) {
      console.error(e);
    }
  };

  useEffect(() => {
    refreshNodes();
    refreshGroups();
    ensureNotifyPermission();
    const u1 = onMessageReceived(event => {
      const { reply, text, ttl } = decodeBody(event.text);
      setMsgsByHandle(prev => ({
        ...prev,
        [event.from_handle]: [
          ...(prev[event.from_handle] ?? []),
          {
            side: 'them',
            text,
            reply,
            ttl: ttl || undefined,
            expiresAt: ttl ? event.timestamp + ttl : undefined,
            time: formatTime(event.timestamp),
          },
        ],
      }));
      refreshNodes();
      ding();
      if (!windowFocusedRef.current) notify(event.from_handle, text || `📎 ${t('message.file')}`);
      if (
        selRef.current?.kind !== 'node' ||
        selRef.current.id !== event.from_handle
      ) {
        setUnread(u => ({ ...u, [event.from_handle]: (u[event.from_handle] || 0) + 1 }));
      }
    });
    const u2 = onGroupMessage(event => {
      const { reply, text, ttl } = decodeBody(event.text);
      setMsgsByGroup(prev => ({
        ...prev,
        [event.gid]: [
          ...(prev[event.gid] ?? []),
          {
            side: 'them',
            text,
            reply,
            ttl: ttl || undefined,
            expiresAt: ttl ? event.timestamp + ttl : undefined,
            time: formatTime(event.timestamp),
            from: event.from_handle,
          },
        ],
      }));
      ding();
      if (!windowFocusedRef.current) {
        notify(`${t('notification.group')} · ${event.from_handle}`, text || `📎 ${t('message.file')}`);
      }
      if (selRef.current?.kind !== 'group' || selRef.current.id !== event.gid) {
        const key = groupUnreadKey(event.gid);
        setUnread(u => ({ ...u, [key]: (u[key] || 0) + 1 }));
      }
    });
    const u3 = onGroupUpdated(() => {
      refreshGroups();
      refreshNodes();
    });
    const u4 = onFileMessage(event => {
      const msg: ChatMessage = {
        side: 'them',
        file: event.file,
        time: formatTime(event.timestamp),
        from: event.from_handle,
      };
      if (event.gid) {
        const gid = event.gid;
        setMsgsByGroup(prev => ({ ...prev, [gid]: [...(prev[gid] ?? []), msg] }));
        if (selRef.current?.kind !== 'group' || selRef.current.id !== gid) {
          const key = groupUnreadKey(gid);
          setUnread(u => ({ ...u, [key]: (u[key] || 0) + 1 }));
        }
      } else {
        setMsgsByHandle(prev => ({
          ...prev,
          [event.from_handle]: [...(prev[event.from_handle] ?? []), msg],
        }));
      }
      ding();
      if (!windowFocusedRef.current) notify(event.from_handle, '📎 ' + event.file.name);
      if (
        !event.gid &&
        (selRef.current?.kind !== 'node' || selRef.current.id !== event.from_handle)
      ) {
        setUnread(u => ({ ...u, [event.from_handle]: (u[event.from_handle] || 0) + 1 }));
      }
    });
    return () => {
      u1.then(u => u());
      u2.then(u => u());
      u3.then(u => u());
      u4.then(u => u());
    };
  }, []);

  // WebRTC call wiring: drive the call manager from React state.
  useEffect(() => {
    api
      .getCallConfig()
      .then(config => configureIceServers(config.ice_servers))
      .catch(error => console.error('call configuration failed', error));
    initCall({
      onState: (s, info) => {
        setCallState(s);
        if (info.peer) setCallPeer(info.peer);
        setCallVideo(info.video);
        if (s === 'ringing-out') startRingback();
        else if (s === 'ringing-in') startRingtone();
        else if (s === 'connecting') stopRinging();
        else if (s === 'connected') {
          stopRinging();
          blipConnect();
          setSealing(true);
          setTimeout(() => setSealing(false), 1700);
        } else if (s === 'ended') {
          stopRinging();
          blipEnd();
          setLocalStream(null);
          setRemoteStream(null);
          setCallMedia({ muted: false, cameraOn: false, hasVideo: false });
          // Only settle to idle if nothing new started (e.g. a retry offer
          // can flip us to ringing-in right after an 'ended').
          setTimeout(() => setCallState(c => (c === 'ended' ? 'idle' : c)), 500);
        } else if (s === 'rejected') {
          // Stay on a "rejected" screen (close / retry) — don't auto-close.
          stopRinging();
          blipEnd();
          setLocalStream(null);
          setRemoteStream(null);
          setCallMedia({ muted: false, cameraOn: false, hasVideo: false });
        }
      },
      onLocalStream: setLocalStream,
      onRemoteStream: setRemoteStream,
      onSas: setCallSas,
      onMedia: setCallMedia,
      onError: (code: CallErrorCode) => {
        console.error('call failed', code);
        setCallError(`call.error.${code}`);
        setTimeout(() => setCallError(''), 4000);
      },
    });
    const u = onCallSignal(e => handleSignal(e.from_handle, e.payload));
    return () => {
      u.then(fn => fn());
    };
  }, []);

  // Auto-heal: the backend cleared a desynced session and asks us to
  // re-handshake. connectNode re-initiates X3DH; the tie-break reconverges;
  // then we replay buffered outgoing so nothing sent during the desync is lost.
  useEffect(() => {
    const u1 = onResyncNeeded(handle => {
      api
        .resyncSession(handle)
        .then(() => api.resendOutbox(handle))
        .then(refreshNodes)
        .catch(e => reportFailure(t('error.reconnect'), e));
    });
    // The peer re-established with us (we're the responder) → replay our outbox.
    const u2 = onSessionEstablished(handle => {
      api.resendOutbox(handle).catch(() => {});
    });
    return () => {
      u1.then(fn => fn());
      u2.then(fn => fn());
    };
  }, []);

  // Load the encrypted local history once unsealed; live messages append after.
  useEffect(() => {
    api
      .getHistory()
      .then(hist => {
        const byHandle: Record<string, ChatMessage[]> = {};
        const byGroup: Record<string, ChatMessage[]> = {};
        for (const [convo, items] of Object.entries(hist)) {
          const msgs: ChatMessage[] = items.map(it => {
            const dec = it.text
              ? decodeBody(it.text)
              : { text: undefined, reply: undefined, ttl: undefined };
            return {
              side: it.side,
              text: dec.text,
              reply: dec.reply,
              ttl: dec.ttl || undefined,
              expiresAt: dec.ttl ? it.ts + dec.ttl : undefined,
              file: it.file ?? undefined,
              from: it.from ?? undefined,
              time: formatTime(it.ts),
            };
          })
          .filter((m: ChatMessage) => !m.expiresAt || m.expiresAt > Math.floor(Date.now() / 1000));
          if (convo.startsWith('grp:')) byGroup[convo.slice(4)] = msgs;
          else byHandle[convo] = msgs;
        }
        setMsgsByHandle(prev => {
          const merged: Record<string, ChatMessage[]> = { ...byHandle };
          for (const [k, v] of Object.entries(prev)) merged[k] = [...(byHandle[k] ?? []), ...v];
          return merged;
        });
        setMsgsByGroup(prev => {
          const merged: Record<string, ChatMessage[]> = { ...byGroup };
          for (const [k, v] of Object.entries(prev)) merged[k] = [...(byGroup[k] ?? []), ...v];
          return merged;
        });
      })
      .catch(e => reportFailure(t('error.loadHistory'), e));
  }, []);

  const activeGroup = sel?.kind === 'group' ? groups.find(g => g.gid === sel.id) : undefined;
  const avatarOf = (handle: string) => nodes.find(n => n.handle === handle)?.avatar;
  const q = search.trim().toLowerCase();
  const filteredNodes = q ? nodes.filter(n => n.handle.toLowerCase().includes(q)) : nodes;
  const filteredGroups = q ? groups.filter(g => g.name.toLowerCase().includes(q)) : groups;
  const announcements = [...announcementFeed.announcements].sort(
    (a, b) => Date.parse(a.publishedAt) - Date.parse(b.publishedAt),
  );
  // NB: Array.prototype.at is ES2022; tsconfig targets ES2020, so index it.
  const latestAnnouncement = announcements[announcements.length - 1];
  const systemMatchesSearch =
    !q ||
    t('updates.title').toLowerCase().includes(q) ||
    latestAnnouncement?.title.toLowerCase().includes(q);
  const updatesUnread =
    latestAnnouncement && updatesReadId !== latestAnnouncement.id ? 1 : 0;
  const activeLinks = nodes.filter(n => n.has_session).length;
  const chatUnread =
    updatesUnread +
    nodes.reduce((total, node) => total + (unread[node.handle] || 0), 0);
  const groupUnread = groups.reduce(
    (total, group) => total + (unread[groupUnreadKey(group.gid)] || 0),
    0,
  );
  const messagePreview = (last: ChatMessage | undefined, isGroup = false) => {
    if (!last) return undefined;
    if (last.file) {
      const label = last.file.name.startsWith('sticker::')
        ? t('message.sticker')
        : `${t('message.file')} · ${last.file.name}`;
      return isGroup && last.side === 'them' && last.from ? `${last.from}: ${label}` : label;
    }
    const body = last.text ?? '';
    if (last.side === 'me') return `${t('message.you')}: ${body}`;
    return isGroup && last.from ? `${last.from}: ${body}` : body;
  };

  return (
    <div className="app-shell h-full overflow-hidden">
      <aside
        className={`sidebar-shell flex-col h-full w-full md:w-auto ${
          sel ? 'hidden md:flex' : 'flex'
        }`}
      >
        <header className="sidebar-brand">
          <TrinoMark className="w-9 h-9 shrink-0" glow={false} />
          <div className="min-w-0 flex-1">
            <div className="font-mono text-[13px] font-bold tracking-[0.16em] text-ink truncate">
              TRINO://MESH
            </div>
            <div className="mt-0.5 flex items-center gap-1.5 text-[10px] text-ink-muted">
              <span className="h-1.5 w-1.5 rounded-full bg-phosphor shadow-[0_0_7px_rgba(34,255,102,0.75)]" />
              <span>{t('sidebar.networkReady')}</span>
              <span aria-hidden="true">/</span>
              <span>{activeLinks} {t('sidebar.links')}</span>
            </div>
          </div>
        </header>

        <div className="sidebar-search">
          <SearchIcon className="h-4 w-4 shrink-0 text-ink-muted" aria-hidden="true" />
          <input
            ref={searchRef}
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder={`${t('sidebar.search')}…`}
            aria-label={t('sidebar.search')}
            className="min-w-0 flex-1 bg-transparent text-[13px] text-ink outline-none placeholder:text-ink-muted"
          />
          {search && (
            <button
              type="button"
              className="icon-button h-7 w-7"
              onClick={() => {
                setSearch('');
                searchRef.current?.focus();
              }}
              title={t('sidebar.clearSearch')}
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>

        <nav className="sidebar-tabs" aria-label={t('sidebar.navigation')}>
          <button
            type="button"
            className={`sidebar-tab ${sidebarView === 'chats' ? 'sidebar-tab--active' : ''}`}
            aria-pressed={sidebarView === 'chats'}
            onClick={() => setSidebarView('chats')}
          >
            <MessageCircle className="h-4 w-4" />
            <span>{t('sidebar.chats')}</span>
            <span className="sidebar-tab__count">{nodes.length + 1}</span>
            {chatUnread > 0 && (
              <span className="sidebar-tab__unread" aria-label={`${chatUnread} ${t('sidebar.unread')}`}>
                {chatUnread > 99 ? '99+' : chatUnread}
              </span>
            )}
          </button>
          <button
            type="button"
            className={`sidebar-tab ${sidebarView === 'groups' ? 'sidebar-tab--active' : ''}`}
            aria-pressed={sidebarView === 'groups'}
            onClick={() => setSidebarView('groups')}
          >
            <UsersRound className="h-4 w-4" />
            <span>{t('sidebar.groups')}</span>
            <span className="sidebar-tab__count">{groups.length}</span>
            {groupUnread > 0 && (
              <span className="sidebar-tab__unread" aria-label={`${groupUnread} ${t('sidebar.unread')}`}>
                {groupUnread > 99 ? '99+' : groupUnread}
              </span>
            )}
          </button>
        </nav>

        <div className="sidebar-list-heading">
          <span>
            {sidebarView === 'chats' ? t('sidebar.recentChats') : t('sidebar.yourGroups')}
          </span>
          <button
            type="button"
            className="icon-button icon-button--accent"
            title={sidebarView === 'chats' ? t('sidebar.addContact') : t('sidebar.createGroup')}
            onClick={() => {
              if (sidebarView === 'chats') setShowAddNode(true);
              else setShowNewGroup(true);
            }}
          >
            {sidebarView === 'chats' ? (
              <UserPlus className="h-4 w-4" />
            ) : (
              <Plus className="h-4 w-4" />
            )}
          </button>
        </div>

        <div className="sidebar-list">
          {sidebarView === 'chats' && systemMatchesSearch && (
            <SystemRow
              title={t('updates.title')}
              preview={latestAnnouncement?.title || t('updates.empty')}
              time={latestAnnouncement ? formatAnnouncementDate(latestAnnouncement.publishedAt) : undefined}
              unread={updatesUnread}
              muted={updatesMuted}
              verified={announcementFeed.source === 'verified'}
              active={sel?.kind === 'system'}
              onClick={() => {
                setSel({ kind: 'system', id: 'updates' });
                if (latestAnnouncement) {
                  setUpdatesReadId(latestAnnouncement.id);
                  localStorage.setItem('updates.lastRead', latestAnnouncement.id);
                }
              }}
            />
          )}
          {sidebarView === 'chats' && nodes.length === 0 && !q && (
            <div className="sidebar-empty">
              <MessageCircle className="h-6 w-6 text-phosphor/70" />
              <div>
                <div className="text-sm text-ink">{t('sidebar.noChatsTitle')}</div>
                <div className="mt-1 text-xs leading-relaxed text-ink-muted">
                  {t('sidebar.noNodes')}
                </div>
              </div>
              <button className="term-button text-xs" onClick={() => setShowAddNode(true)}>
                <UserPlus className="h-3.5 w-3.5" />
                {t('sidebar.addContact')}
              </button>
            </div>
          )}
          {sidebarView === 'chats' &&
            filteredNodes.length === 0 &&
            !systemMatchesSearch &&
            q && (
            <div className="sidebar-no-results">
              {t('sidebar.noResults')} “{search}”
            </div>
          )}
          {sidebarView === 'chats' && filteredNodes.map(n => {
            const arr = msgsByHandle[n.handle] ?? [];
            const last = arr.length ? arr[arr.length - 1] : undefined;
            return (
              <NodeRow
                key={n.handle}
                handle={n.handle}
                hasSession={n.has_session}
                avatar={n.avatar}
                lastMsg={messagePreview(last)}
                lastTime={last?.time}
                unread={unread[n.handle]}
                active={sel?.kind === 'node' && sel.id === n.handle}
                onClick={() => {
                  setSel({ kind: 'node', id: n.handle });
                  setUnread(u => ({ ...u, [n.handle]: 0 }));
                }}
              />
            );
          })}

          {sidebarView === 'groups' && groups.length === 0 && !q && (
            <div className="sidebar-empty">
              <Hash className="h-6 w-6 text-cyan/80" />
              <div>
                <div className="text-sm text-ink">{t('sidebar.noGroupsTitle')}</div>
                <div className="mt-1 text-xs leading-relaxed text-ink-muted">
                  {t('sidebar.noGroups')}
                </div>
              </div>
              <button className="term-button text-xs" onClick={() => setShowNewGroup(true)}>
                <Plus className="h-3.5 w-3.5" />
                {t('sidebar.createGroup')}
              </button>
            </div>
          )}
          {sidebarView === 'groups' && groups.length > 0 && filteredGroups.length === 0 && q && (
            <div className="sidebar-no-results">
              {t('sidebar.noResults')} “{search}”
            </div>
          )}
          {sidebarView === 'groups' && filteredGroups.map(g => {
            const arr = msgsByGroup[g.gid] ?? [];
            const last = arr.length ? arr[arr.length - 1] : undefined;
            const unreadCount = unread[groupUnreadKey(g.gid)];
            return (
              <GroupRow
                key={g.gid}
                group={g}
                lastMsg={messagePreview(last, true)}
                lastTime={last?.time}
                unread={unreadCount}
                active={sel?.kind === 'group' && sel.id === g.gid}
                onClick={() => {
                  setSel({ kind: 'group', id: g.gid });
                  setUnread(u => ({ ...u, [groupUnreadKey(g.gid)]: 0 }));
                }}
              />
            );
          })}
        </div>

        <footer className="sidebar-profile">
          <Avatar
            src={myAvatar}
            name={myHandle || t('sidebar.you')}
            size={38}
            status="online"
            statusLabel={t('sidebar.vaultReady')}
          />
          <div className="min-w-0 flex-1">
            <div
              className="truncate text-sm font-semibold text-ink"
              title={myHandle || t('sidebar.you')}
            >
              {myHandle || t('sidebar.you')}
            </div>
          </div>
          <div className="sidebar-profile__actions">
            <button
              type="button"
              title={t('sidebar.share')}
              className="icon-button"
              onClick={() => setShowShare(true)}
            >
              <Share2 className="h-4 w-4" />
            </button>
            <button
              type="button"
              title={t('sidebar.inspector')}
              className="icon-button"
              onClick={() => setShowInspector(true)}
            >
              <Activity className="h-4 w-4" />
            </button>
            <button
              type="button"
              title={t('sidebar.settings')}
              className="icon-button"
              onClick={() => setShowSettings(true)}
            >
              <Settings className="h-4 w-4" />
            </button>
          </div>
        </footer>
      </aside>

      <div className={`h-full min-h-0 w-full ${sel ? 'block' : 'hidden md:block'}`}>
      {sel?.kind === 'system' ? (
        <SystemChatView
          onBack={() => setSel(null)}
          announcements={announcements}
          feed={announcementFeed}
          muted={updatesMuted}
          onToggleMuted={() =>
            setUpdatesMuted(current => {
              const next = !current;
              localStorage.setItem('updates.muted', next ? '1' : '0');
              return next;
            })
          }
        />
      ) : sel?.kind === 'node' ? (
        <ChatView
          onBack={() => setSel(null)}
          handle={sel.id}
          avatar={avatarOf(sel.id)}
          hasSession={nodes.find(n => n.handle === sel.id)?.has_session ?? false}
          fingerprint={nodes.find(n => n.handle === sel.id)?.fingerprint ?? ''}
          myFingerprint={myFingerprint}
          blocked={nodes.find(n => n.handle === sel.id)?.blocked ?? false}
          onBlockChanged={refreshNodes}
          onCall={video => startCall(sel.id, video).catch(e => console.error('call failed', e))}
          messages={msgsByHandle[sel.id] ?? []}
          onSend={async (text, reply) => {
            const handle = sel.id;
            try {
              const node = nodes.find(n => n.handle === handle);
              if (!node?.has_session) {
                await api.connectNode(handle);
                await refreshNodes();
              }
              const ttl = ttlFor(handle);
              const body = encodeMeta(text, { reply, ttl });
              await api.sendMessage(handle, body);
              const now = Math.floor(Date.now() / 1000);
              setMsgsByHandle(prev => ({
                ...prev,
                [handle]: [
                  ...(prev[handle] ?? []),
                  {
                    side: 'me',
                    text,
                    reply,
                    ttl: ttl || undefined,
                    expiresAt: ttl ? now + ttl : undefined,
                    time: formatTime(now),
                  },
                ],
              }));
            } catch (e) {
              reportFailure(t('error.sendMessage'), e);
              throw e;
            }
          }}
          onForward={m => setForwarding(m)}
          onDelete={index => {
            const handle = sel.id;
            setMsgsByHandle(prev => ({
              ...prev,
              [handle]: (prev[handle] ?? []).filter((_, i) => i !== index),
            }));
          }}
          onRenamed={newHandle => {
            const old = sel.id;
            setMsgsByHandle(prev => {
              const copy = { ...prev };
              if (copy[old]) {
                copy[newHandle] = copy[old]!;
                delete copy[old];
              }
              return copy;
            });
            setSel({ kind: 'node', id: newHandle });
            refreshNodes();
          }}
          onDeleted={() => {
            const old = sel.id;
            setMsgsByHandle(prev => {
              const copy = { ...prev };
              delete copy[old];
              return copy;
            });
            setSel(null);
            refreshNodes();
          }}
          onSendFile={async p => {
            const handle = sel.id;
            try {
              const file = await api.sendFile(handle, p.name, p.mime, p.dataB64, p.thumb);
              setMsgsByHandle(prev => ({
                ...prev,
                [handle]: [
                  ...(prev[handle] ?? []),
                  { side: 'me', file, time: formatTime(Math.floor(Date.now() / 1000)) },
                ],
              }));
            } catch (e) {
              reportFailure(t('error.sendFile'), e);
              throw e;
            }
          }}
          onSendSticker={async s => {
            const handle = sel.id;
            try {
              const b64 = s.data_url.split(',')[1] || '';
              const name = 'sticker::' + s.id + '.' + (s.mime.split('/')[1] || 'png');
              const thumb = s.data_url.length < 60000 ? s.data_url : null;
              const file = await api.sendFile(handle, name, s.mime, b64, thumb);
              setMsgsByHandle(prev => ({
                ...prev,
                [handle]: [
                  ...(prev[handle] ?? []),
                  { side: 'me', file, time: formatTime(Math.floor(Date.now() / 1000)) },
                ],
              }));
            } catch (e) {
              reportFailure(t('error.sendSticker'), e);
              throw e;
            }
          }}
        />
      ) : activeGroup ? (
        <GroupChatView
          onBack={() => setSel(null)}
          group={activeGroup}
          messages={msgsByGroup[activeGroup.gid] ?? []}
          avatarOf={avatarOf}
          onAddMember={() => setShowAddMember(true)}
          onSend={async (text, reply) => {
            const gid = activeGroup.gid;
            try {
              const ttl = ttlFor('grp:' + gid);
              const body = encodeMeta(text, { reply, ttl });
              await api.sendGroupMessage(gid, body);
              const now = Math.floor(Date.now() / 1000);
              setMsgsByGroup(prev => ({
                ...prev,
                [gid]: [
                  ...(prev[gid] ?? []),
                  {
                    side: 'me',
                    text,
                    reply,
                    ttl: ttl || undefined,
                    expiresAt: ttl ? now + ttl : undefined,
                    time: formatTime(now),
                  },
                ],
              }));
            } catch (e) {
              reportFailure(t('error.sendMessage'), e);
              throw e;
            }
          }}
          onForward={m => setForwarding(m)}
          onDelete={index => {
            const gid = activeGroup.gid;
            setMsgsByGroup(prev => ({
              ...prev,
              [gid]: (prev[gid] ?? []).filter((_, i) => i !== index),
            }));
          }}
          onSendFile={async p => {
            const gid = activeGroup.gid;
            try {
              const file = await api.sendGroupFile(gid, p.name, p.mime, p.dataB64, p.thumb);
              setMsgsByGroup(prev => ({
                ...prev,
                [gid]: [
                  ...(prev[gid] ?? []),
                  { side: 'me', file, time: formatTime(Math.floor(Date.now() / 1000)) },
                ],
              }));
            } catch (e) {
              reportFailure(t('error.sendFile'), e);
              throw e;
            }
          }}
          onSendSticker={async s => {
            const gid = activeGroup.gid;
            try {
              const b64 = s.data_url.split(',')[1] || '';
              const name = 'sticker::' + s.id + '.' + (s.mime.split('/')[1] || 'png');
              const thumb = s.data_url.length < 60000 ? s.data_url : null;
              const file = await api.sendGroupFile(gid, name, s.mime, b64, thumb);
              setMsgsByGroup(prev => ({
                ...prev,
                [gid]: [
                  ...(prev[gid] ?? []),
                  { side: 'me', file, time: formatTime(Math.floor(Date.now() / 1000)) },
                ],
              }));
            } catch (e) {
              reportFailure(t('error.sendSticker'), e);
              throw e;
            }
          }}
        />
      ) : (
        <EmptyChat />
      )}
      </div>

      {showAddNode && (
        <AddNodeModal
          onClose={() => setShowAddNode(false)}
          onAdded={async () => {
            setShowAddNode(false);
            await refreshNodes();
          }}
        />
      )}
      {showShare && <ShareModal onClose={() => setShowShare(false)} />}
      {showSettings && (
        <SettingsModal onClose={() => setShowSettings(false)} onSaved={() => setShowSettings(false)} />
      )}
      {showInspector && <RelayInspector onClose={() => setShowInspector(false)} />}
      {forwarding && (
        <ForwardModal
          nodes={nodes}
          groups={groups}
          onClose={() => setForwarding(null)}
          onPick={async (targetId, isGroup) => {
            const m = forwarding;
            setForwarding(null);
            try {
              if (m.file) {
                await api.forwardFile(targetId, isGroup, m.file);
              } else if (m.text) {
                if (isGroup) {
                  await api.sendGroupMessage(targetId, m.text);
                } else {
                  const node = nodes.find(n => n.handle === targetId);
                  if (!node?.has_session) {
                    await api.connectNode(targetId);
                    await refreshNodes();
                  }
                  await api.sendMessage(targetId, m.text);
                }
              }
              const echo: ChatMessage = {
                side: 'me',
                text: m.text,
                file: m.file,
                time: formatTime(Math.floor(Date.now() / 1000)),
              };
              if (isGroup) {
                setMsgsByGroup(prev => ({ ...prev, [targetId]: [...(prev[targetId] ?? []), echo] }));
              } else {
                setMsgsByHandle(prev => ({ ...prev, [targetId]: [...(prev[targetId] ?? []), echo] }));
              }
            } catch (e) {
              reportFailure(t('error.forward'), e);
            }
          }}
        />
      )}
      {callState === 'ringing-in' && (
        <IncomingCall
          peer={callPeer}
          video={callVideo}
          avatar={callPeer ? avatarOf(callPeer) : undefined}
          onAccept={() => acceptIncoming().catch(e => console.error('accept failed', e))}
          onReject={() => rejectIncoming()}
        />
      )}
      {(callState === 'ringing-out' || callState === 'connecting' || callState === 'connected') && (
        <CallOverlay
          state={callState}
          peer={callPeer}
          video={callVideo}
          sas={callSas}
          localStream={localStream}
          remoteStream={remoteStream}
          media={callMedia}
          error={callError}
          avatar={callPeer ? avatarOf(callPeer) : undefined}
        />
      )}
      {callState === 'rejected' && (
        <RejectedCall
          peer={callPeer}
          avatar={callPeer ? avatarOf(callPeer) : undefined}
          onClose={() => setCallState('idle')}
          onRetry={() => {
            const p = callPeer;
            const v = callVideo;
            if (p) startCall(p, v).catch(e => console.error('retry failed', e));
          }}
        />
      )}
      {sealing && <LockSeal />}
      {showNewGroup && (
        <NewGroupModal
          onClose={() => setShowNewGroup(false)}
          onCreated={async gid => {
            setShowNewGroup(false);
            await refreshGroups();
            setSel({ kind: 'group', id: gid });
          }}
        />
      )}
      {showAddMember && activeGroup && (
        <AddMemberModal
          group={activeGroup}
          nodes={nodes}
          onClose={() => setShowAddMember(false)}
          onAdded={async () => {
            setShowAddMember(false);
            await refreshGroups();
          }}
        />
      )}
      {activityError && (
        <div
          role="alert"
          aria-live="assertive"
          className="fixed bottom-3 left-1/2 z-[90] w-[min(42rem,calc(100vw-1.5rem))] -translate-x-1/2 border border-crimson/50 bg-bg-deep/95 px-3 py-2 text-xs text-crimson shadow-[0_0_18px_rgba(255,85,102,0.16)]"
        >
          <span className="mr-2 text-phosphor-dim">&gt; {t('error.notice')}</span>
          {activityError}
        </div>
      )}
    </div>
  );
}

function SystemChatView({
  announcements,
  feed,
  muted,
  onToggleMuted,
  onBack,
}: {
  announcements: Announcement[];
  feed: AnnouncementFeed;
  muted: boolean;
  onToggleMuted: () => void;
  onBack: () => void;
}) {
  const t = useT();
  return (
    <section className="flex h-full min-h-0 flex-col">
      <header className="flex h-14 items-center gap-3 border-b border-bg-line px-4">
        <button
          className="md:hidden -ml-1 mr-0.5 icon-button shrink-0"
          onClick={onBack}
          title={t('common.back')}
        >
          <ChevronLeft className="h-5 w-5" />
        </button>
        <span className="system-avatar system-avatar--header" aria-hidden="true">
          <Megaphone className="h-5 w-5" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 truncate text-ink">
            <span className="truncate">{t('updates.title')}</span>
            {feed.source === 'verified' && (
              <ShieldCheck className="h-3.5 w-3.5 shrink-0 text-phosphor" />
            )}
          </div>
          <div className="truncate text-[11px] text-ink-muted">
            {t('updates.readOnly')}
          </div>
        </div>
        <button
          type="button"
          className="icon-button"
          onClick={onToggleMuted}
          aria-label={muted ? t('updates.unmute') : t('updates.mute')}
          title={muted ? t('updates.unmute') : t('updates.mute')}
        >
          {muted ? <BellOff className="h-4 w-4" /> : <Bell className="h-4 w-4" />}
        </button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-4 sm:px-5">
        <div
          className={`updates-trust ${
            feed.source === 'verified' ? 'updates-trust--verified' : ''
          } ${feed.source === 'untrusted' ? 'updates-trust--untrusted' : ''}`}
        >
          {feed.source === 'verified' ? (
            <ShieldCheck className="h-4 w-4 shrink-0 text-phosphor" />
          ) : feed.source === 'untrusted' ? (
            <ShieldAlert className="h-4 w-4 shrink-0 text-crimson" />
          ) : (
            <LockKeyhole className="h-4 w-4 shrink-0 text-ink-muted" />
          )}
          <div className="min-w-0">
            <div className="text-xs text-ink">
              {feed.source === 'verified'
                ? t('updates.verified')
                : feed.source === 'untrusted'
                  ? t('updates.untrusted')
                  : t('updates.bundled')}
            </div>
            <div className="mt-0.5 break-all text-[10px] text-ink-muted">
              {feed.source === 'untrusted'
                ? t('updates.untrustedHelp')
                : feed.signerFingerprint
                  ? `${t('updates.signer')}: ${feed.signerFingerprint}`
                  : t('updates.bundledHelp')}
            </div>
          </div>
        </div>

        <div className="updates-feed">
          {announcements.map(announcement => (
            <article className="updates-message" key={announcement.id}>
              <div className="updates-message__title">{announcement.title}</div>
              <div className="updates-message__body">{announcement.body}</div>
              <footer className="updates-message__meta">
                <span>{formatAnnouncementDate(announcement.publishedAt, true)}</span>
                {announcement.version && <span>v{announcement.version}</span>}
                {announcement.url && (
                  <button type="button" onClick={() => openLink(announcement.url!)}>
                    {t('updates.open')}
                  </button>
                )}
              </footer>
            </article>
          ))}
        </div>
      </div>

      <footer className="updates-readonly">
        <LockKeyhole className="h-4 w-4 shrink-0 text-phosphor" />
        <div className="min-w-0">
          <div className="text-xs text-ink">{t('updates.readOnly')}</div>
          <div className="truncate text-[10px] text-ink-muted">{t('updates.readOnlyHelp')}</div>
        </div>
      </footer>
    </section>
  );
}

function formatAnnouncementDate(value: string, detailed = false): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat(undefined, detailed
    ? { day: 'numeric', month: 'short', year: 'numeric' }
    : { day: 'numeric', month: 'short' }).format(date);
}

function GroupChatView({
  group,
  messages,
  onSend,
  onSendFile,
  onSendSticker,
  onAddMember,
  onForward,
  onDelete,
  avatarOf,
  onBack,
}: {
  onBack: () => void;
  group: GroupInfo;
  messages: ChatMessage[];
  onSend: (text: string, reply?: { author: string; preview: string }) => Promise<void> | void;
  onSendFile: (p: ProcessedFile) => Promise<void> | void;
  onSendSticker: (s: StickerInfo) => Promise<void> | void;
  onAddMember: () => void;
  onForward: (m: ChatMessage) => void;
  onDelete: (index: number) => void;
  avatarOf: (handle: string) => string | null | undefined;
}) {
  const t = useT();
  const [replyingTo, setReplyingTo] = useState<{ author: string; preview: string } | null>(null);
  const { scrollRef, endRef, atBottom, onScroll, scrollToBottom } = useAutoScroll(messages.length);
  const previewOf = (m: ChatMessage) => m.text || (m.file ? '📎 ' + m.file.name : '');
  return (
    <section className="flex flex-col h-full min-h-0 relative">
      <div className="h-14 border-b border-bg-line px-4 flex items-center justify-between">
        <div className="flex items-center min-w-0">
          <button
            className="md:hidden -ml-2 mr-1 icon-button shrink-0"
            onClick={onBack}
            title={t('common.back')}
          >
            <ChevronLeft className="h-5 w-5" />
          </button>
          <GroupAvatar name={group.name} size={36} />
          <div className="ml-2.5 min-w-0">
            <div className="truncate text-ink">{group.name}</div>
            <div className="truncate text-[11px] text-ink-muted">
              {group.member_count} {group.member_count === 1 ? t('sidebar.member') : t('sidebar.members')}
              {group.is_admin ? ` · ${t('sidebar.admin')}` : ''}
            </div>
          </div>
        </div>
        {group.is_admin && (
          <button className="term-button text-xs" onClick={onAddMember}>
            <UserPlus className="h-3.5 w-3.5" />
            {t('group.addMember')}
          </button>
        )}
      </div>
      <div ref={scrollRef} onScroll={onScroll} className="flex-1 overflow-y-auto p-4">
        {messages.length === 0 && (
          <div className="text-phosphor-dim text-sm">{t('chat.empty')}</div>
        )}
        {messages.map((m, i) => {
          const prev = messages[i - 1];
          const grouped = !!prev && prev.side === m.side && prev.from === m.from;
          return (
            <div key={i} className={grouped ? 'mt-0.5' : 'mt-3 first:mt-0'}>
              <Bubble
                {...m}
                grouped={grouped}
                avatar={m.from ? avatarOf(m.from) : undefined}
                onReply={() =>
                  setReplyingTo({
                    author: m.side === 'me' ? t('message.you') : m.from || t('message.someone'),
                    preview: previewOf(m),
                  })
                }
                onForward={() => onForward(m)}
                onDelete={() => onDelete(i)}
              />
            </div>
          );
        })}
        <div ref={endRef} />
      </div>
      {!atBottom && <ScrollDownBtn onClick={scrollToBottom} />}
      <MessageComposer
        onSendText={onSend}
        onSendFile={onSendFile}
        onSendSticker={onSendSticker}
        replyingTo={replyingTo}
        setReplyingTo={setReplyingTo}
        placeholder={t('composer.placeholderGroup')}
      />
    </section>
  );
}

function NewGroupModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (gid: string) => void;
}) {
  const t = useT();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const create = async () => {
    if (!name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const info = await api.createGroup(name.trim());
      onCreated(info.gid);
    } catch {
      setError(t('group.createError'));
      setBusy(false);
    }
  };
  return (
    <Modal onClose={onClose} title={t('group.newTitle')}>
      <div className="text-phosphor-dim text-xs mb-3">
        {t('group.newDesc')}
      </div>
      <input
        className="term-input w-full mb-4"
        placeholder={t('group.namePlaceholder')}
        value={name}
        onChange={e => setName(e.target.value)}
        onKeyDown={e => e.key === 'Enter' && create()}
        autoFocus
      />
      {error && <div className="text-crimson text-xs mb-3">{error}</div>}
      <button type="button" className="term-button w-full" disabled={busy} onClick={create}>
        {busy ? t('group.creating') : t('group.create')}
      </button>
    </Modal>
  );
}

function AddMemberModal({
  group,
  nodes,
  onClose,
  onAdded,
}: {
  group: GroupInfo;
  nodes: NodeInfo[];
  onClose: () => void;
  onAdded: () => void;
}) {
  const t = useT();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const candidates = nodes.filter(n => !group.members.includes(n.handle));
  const add = async (handle: string) => {
    setBusy(handle);
    setError(null);
    try {
      await api.addGroupMember(group.gid, handle);
      onAdded();
    } catch {
      setError(t('group.addError'));
      setBusy(null);
    }
  };
  return (
    <Modal onClose={onClose} title={`${t('group.addTitle')} #${group.name}`}>
      <div className="text-phosphor-dim text-xs mb-3">
        {t('group.addDesc')}
      </div>
      {candidates.length === 0 && (
        <div className="text-phosphor-dim text-sm">{t('group.noCandidates')}</div>
      )}
      <div className="space-y-1 max-h-64 overflow-y-auto">
        {candidates.map(n => (
          <button
            type="button"
            key={n.handle}
            className="w-full text-left px-3 py-2 hover:bg-bg-line flex items-center justify-between"
            disabled={busy !== null}
            onClick={() => add(n.handle)}
          >
            <span className="text-phosphor">{n.handle}</span>
            <span className="text-phosphor-dim text-xs">
              {busy === n.handle ? t('group.adding') : n.fingerprint}
            </span>
          </button>
        ))}
      </div>
      {error && <div className="text-crimson text-xs mt-3">{error}</div>}
    </Modal>
  );
}

function ThemePreview({ preset, accent }: { preset: ThemePreset; accent: string }) {
  return (
    <span
      className={`theme-preview theme-preview--${preset}`}
      style={{ '--preview-accent': accent } as CSSProperties}
      aria-hidden="true"
    >
      <span className="theme-preview__rail" />
      <span className="theme-preview__content">
        <span />
        <span />
      </span>
    </span>
  );
}

function SettingsModal({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const t = useT();
  const { lang, setLang } = useContext(LangCtx);
  const { theme, setTheme } = useContext(ThemeCtx);
  const [profile, setProfile] = useState<ProfileResponse | null>(null);
  const [handle, setHandle] = useState('');
  const [avatar, setAvatar] = useState<string | null>(null);
  const [autolock, setAutolock] = useState(() => localStorage.getItem('autolock') ?? '5');
  const [autostart, setAutostart] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!isMobile) api.getAutostart().then(setAutostart).catch(() => {});
  }, []);
  const [error, setError] = useState<string | null>(null);
  const [confirmWipe, setConfirmWipe] = useState(false);
  const [wiping, setWiping] = useState(false);
  const picker = useFilePicker(
    p => {
      if (p.thumb) setAvatar(p.thumb);
    },
    () => setError(t('settings.invalidPhoto')),
  );

  const doWipe = async () => {
    setWiping(true);
    try {
      await api.wipe();
      localStorage.clear();
      window.location.reload();
    } catch {
      setError(t('settings.deleteError'));
      setWiping(false);
    }
  };

  useEffect(() => {
    api
      .getProfile()
      .then(p => {
        setProfile(p);
        setHandle(p.handle);
        setAvatar(p.avatar);
      })
      .catch(() => setError(t('settings.loadError')));
  }, []);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.updateProfile(handle.trim() || profile?.handle || 'anon', avatar);
      onSaved();
    } catch {
      setError(t('settings.saveError'));
      setBusy(false);
    }
  };

  return (
    <Modal onClose={onClose} title={t('settings.title')}>
      <div className="flex items-center gap-4 mb-5">
        <Avatar src={avatar} name={handle} size={72} />
        <div className="flex flex-col gap-2">
          {picker.input}
          <button type="button" className="text-cyan text-sm hover:underline text-left" onClick={picker.open}>
            {t('settings.changePhoto')}
          </button>
          {avatar && (
            <button
              className="text-crimson text-xs hover:underline text-left"
              onClick={() => setAvatar(null)}
              type="button"
            >
              {t('settings.removePhoto')}
            </button>
          )}
        </div>
      </div>
      <label className="text-xs text-phosphor-dim block mb-1">{t('settings.name')}</label>
      <input
        className="term-input w-full mb-4"
        value={handle}
        maxLength={40}
        onChange={e => setHandle(e.target.value)}
        onKeyDown={e => e.key === 'Enter' && save()}
      />
      <label className="text-xs text-phosphor-dim block mb-1">{t('settings.language')}</label>
      <select
        className="term-input w-full mb-4"
        value={lang}
        onChange={e => setLang(e.target.value as Lang)}
      >
        {LANGS.map(l => (
          <option key={l.code} value={l.code}>
            {l.label}
          </option>
        ))}
      </select>
      <div className="settings-section-label">
        <Palette className="h-3.5 w-3.5" />
        {t('settings.appearance')}
      </div>
      <div className="theme-preset-grid">
        {(['trino', 'corporate', 'simple'] as ThemePreset[]).map(preset => (
          <button
            key={preset}
            type="button"
            className={`theme-preset ${theme.preset === preset ? 'theme-preset--active' : ''}`}
            aria-pressed={theme.preset === preset}
            onClick={() => setTheme({ ...theme, preset })}
          >
            <ThemePreview preset={preset} accent={theme.accent} />
            <span>{t(`theme.${preset}`)}</span>
          </button>
        ))}
      </div>
      <div className="mt-3 text-[10px] text-ink-muted">{t('settings.accentColor')}</div>
      <div className="theme-swatches" role="group" aria-label={t('settings.accentColor')}>
        {ACCENT_OPTIONS.map(accent => (
          <button
            key={accent}
            type="button"
            className={`theme-swatch ${theme.accent === accent ? 'theme-swatch--active' : ''}`}
            style={{ '--swatch-color': accent } as CSSProperties}
            aria-label={t('settings.chooseAccent')}
            aria-pressed={theme.accent === accent}
            onClick={() => setTheme({ ...theme, accent })}
          >
            {theme.accent === accent && <Check className="h-3.5 w-3.5" />}
          </button>
        ))}
        <label
          className="theme-swatch theme-swatch--custom"
          title={t('settings.customAccent')}
          style={{ '--swatch-color': theme.accent } as CSSProperties}
        >
          <Palette className="h-3.5 w-3.5" />
          <input
            type="color"
            value={theme.accent}
            aria-label={t('settings.customAccent')}
            onChange={event => setTheme({ ...theme, accent: event.target.value })}
          />
        </label>
      </div>
      <label className="text-xs text-phosphor-dim block mb-1">{t('settings.autoLock')}</label>
      <select
        className="term-input w-full mb-4"
        value={autolock}
        onChange={e => {
          setAutolock(e.target.value);
          localStorage.setItem('autolock', e.target.value);
        }}
      >
        <option value="0">{t('time.off')}</option>
        <option value="1">{t('time.minute1')}</option>
        <option value="5">{t('time.minutes5')}</option>
        <option value="15">{t('time.minutes15')}</option>
        <option value="30">{t('time.minutes30')}</option>
        <option value="60">{t('time.hour1')}</option>
      </select>
      {!isMobile && (
        <label className="flex items-center gap-2 mb-4 cursor-pointer text-sm text-phosphor">
          <input
            type="checkbox"
            checked={autostart}
            onChange={e => {
              const v = e.target.checked;
              setAutostart(v);
              api.setAutostart(v).catch(() => setAutostart(!v));
            }}
          />
          {t('settings.startWithWindows')}
        </label>
      )}
      {profile && (
        <div className="text-phosphor-dim text-[11px] mb-4 space-y-1">
          <div>
            {t('settings.securityFingerprint')}: <span className="text-phosphor">{profile.fingerprint}</span>
          </div>
          <div className="truncate">{t('settings.networkKey')}: {profile.nostr_pub.slice(0, 24)}…</div>
        </div>
      )}
      <div className="text-phosphor-dim text-[10px] mb-4">
        {t('settings.shareHelp')}
      </div>
      {error && <div className="text-crimson text-xs mb-3">{error}</div>}
      <button type="button" className="term-button w-full" disabled={busy} onClick={save}>
        {busy ? t('common.saving') : t('common.save')}
      </button>

      <div className="mt-6 pt-4 border-t border-crimson/30">
        <div className="text-crimson text-[10px] uppercase tracking-widest mb-2 flex items-center gap-1">
          {t('settings.dangerTitle')}
        </div>
        <div className="text-phosphor-dim text-[11px] mb-3 leading-relaxed">
          {t('settings.dangerDesc')}
        </div>
        {!confirmWipe ? (
          <button
            className="w-full border border-crimson/50 text-crimson px-4 py-2 rounded hover:bg-crimson/10 transition-colors text-sm"
            onClick={() => setConfirmWipe(true)}
            type="button"
          >
            {t('settings.deleteAll')}
          </button>
        ) : (
          <div className="flex gap-2">
            <button
              className="flex-1 border border-bg-line text-phosphor-dim px-4 py-2 rounded hover:text-phosphor text-sm"
              disabled={wiping}
              onClick={() => setConfirmWipe(false)}
              type="button"
            >
              {t('common.cancel')}
            </button>
            <button
              className="flex-1 border border-crimson bg-crimson/10 text-crimson px-4 py-2 rounded hover:bg-crimson/20 text-sm animate-flicker"
              disabled={wiping}
              onClick={doWipe}
              type="button"
            >
              {wiping ? t('unseal.wiping') : t('settings.confirmDeleteAll')}
            </button>
          </div>
        )}
      </div>
    </Modal>
  );
}

function RadarPing({ active, children }: { active: boolean; children: React.ReactNode }) {
  return (
    <div className="relative grid place-items-center">
      {active && (
        <>
          <span className="absolute inset-0 rounded-full border-2 border-phosphor/50 animate-radar" />
          <span
            className="absolute inset-0 rounded-full border-2 border-phosphor/50 animate-radar"
            style={{ animationDelay: '0.6s' }}
          />
          <span
            className="absolute inset-0 rounded-full border-2 border-phosphor/50 animate-radar"
            style={{ animationDelay: '1.2s' }}
          />
        </>
      )}
      {children}
    </div>
  );
}

function Scanlines() {
  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden">
      <div className="absolute inset-0 opacity-[0.06] bg-[repeating-linear-gradient(0deg,transparent,transparent_2px,#22ff66_3px)]" />
      <div className="absolute left-0 right-0 h-24 bg-gradient-to-b from-transparent via-phosphor/10 to-transparent animate-scan-sweep" />
    </div>
  );
}

function LockSeal() {
  const t = useT();
  return (
    <div className="fixed inset-0 z-[60] bg-bg-deep/92 backdrop-blur-md grid place-items-center animate-fade-in">
      <Scanlines />
      <div className="flex flex-col items-center gap-5">
        <svg viewBox="0 0 120 120" className="w-40 h-40 text-phosphor animate-seal-glow">
          <rect x="34" y="58" width="52" height="48" rx="8" fill="none" stroke="currentColor" strokeWidth="5" />
          <circle cx="60" cy="76" r="6" fill="currentColor" />
          <rect x="57" y="80" width="6" height="14" rx="2" fill="currentColor" />
          <path
            d="M 45 60 V 46 A 15 15 0 0 1 75 46 V 60"
            fill="none"
            stroke="currentColor"
            strokeWidth="5"
            strokeLinecap="round"
            className="animate-shackle-close"
            style={{ transformOrigin: '60px 58px' }}
          />
        </svg>
        <div className="text-phosphor tracking-[0.45em] uppercase text-sm animate-seal-pop glow">
          {t('security.encrypted')} ✓
        </div>
      </div>
    </div>
  );
}

function CallIcon({ d }: { d: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className="w-5 h-5"
    >
      <path d={d} />
    </svg>
  );
}
const CALL_ICONS = {
  mic: 'M12 2a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3zM5 10v1a7 7 0 0 0 14 0v-1M12 19v3',
  micOff: 'M1 1l22 22M9 9v2a3 3 0 0 0 5.1 2.1M15 9.3V5a3 3 0 0 0-5.9-.6M17 17A7 7 0 0 1 5 12v-1m14 0v1M12 19v3',
  cam: 'M23 7l-7 5 7 5V7zM1 5h13a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H1z',
  camOff: 'M1 1l22 22M16 16v1a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h1m5 0h5a2 2 0 0 1 2 2v3',
};

function CircleBtn({
  on,
  onClick,
  title,
  children,
}: {
  on: boolean;
  onClick: () => void;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={`w-11 h-11 rounded-full grid place-items-center transition-colors ${
        on ? 'bg-white text-bg-deep' : 'bg-white/10 text-white hover:bg-white/20'
      }`}
    >
      {children}
    </button>
  );
}

function CallOverlay({
  state,
  peer,
  video,
  sas,
  localStream,
  remoteStream,
  media,
  error,
  avatar,
}: {
  state: CallState;
  peer: string | null;
  video: boolean;
  sas: string;
  localStream: MediaStream | null;
  remoteStream: MediaStream | null;
  media: MediaState;
  error: string;
  avatar?: string | null;
}) {
  const t = useT();
  const remoteRef = useRef<HTMLVideoElement>(null);
  const localRef = useRef<HTMLVideoElement>(null);
  const showVideo = video || media.hasVideo;
  const [elapsed, setElapsed] = useState(0);
  const connectedAtRef = useRef<number | null>(null);
  useEffect(() => {
    if (remoteRef.current) remoteRef.current.srcObject = remoteStream;
  }, [remoteStream]);
  useEffect(() => {
    if (localRef.current) localRef.current.srcObject = localStream;
  }, [localStream]);
  useEffect(() => {
    if (state !== 'connected') {
      connectedAtRef.current = null;
      setElapsed(0);
      return;
    }
    if (connectedAtRef.current == null) connectedAtRef.current = Date.now();
    const iv = setInterval(
      () => setElapsed(Math.floor((Date.now() - (connectedAtRef.current ?? Date.now())) / 1000)),
      500,
    );
    return () => clearInterval(iv);
  }, [state]);
  const status =
    state === 'connected'
      ? `${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, '0')}`
      : state === 'ringing-out'
        ? t('call.calling')
        : t('call.connecting');

  return (
    <div className="fixed inset-0 z-50 bg-bg-deep flex flex-col animate-fade-in">
      {/* remote video fills the screen for video calls; voice shows the avatar.
          the element stays mounted either way so remote audio always plays. */}
      <video
        ref={remoteRef}
        autoPlay
        playsInline
        className={showVideo ? 'absolute inset-0 w-full h-full object-cover bg-black' : 'hidden'}
      />
      {!showVideo && (
        <div className="flex-1 flex flex-col items-center justify-center gap-5 px-6">
          <RadarPing active={state !== 'connected'}>
            <Avatar src={avatar} name={peer ?? '?'} size={120} />
          </RadarPing>
          <div className="text-phosphor-bright text-2xl glow">{peer}</div>
          <div className="text-phosphor-dim text-xs tracking-[0.3em] uppercase">{status}</div>
          {sas && (
            <div className="flex flex-col items-center gap-1 mt-3">
              <div className="text-2xl tracking-[0.3em] select-all">{sas}</div>
              <div className="text-phosphor-dim text-[10px]">
                {t('call.securityCodeHelp')}
              </div>
            </div>
          )}
        </div>
      )}

      {showVideo && sas && (
        <div className="absolute left-1/2 top-5 -translate-x-1/2 rounded-md border border-white/15 bg-black/65 px-3 py-2 text-center backdrop-blur-md">
          <div className="text-base text-white">{sas}</div>
          <div className="mt-0.5 text-[9px] text-white/60">
            {t('call.securityCodeHelp')}
          </div>
        </div>
      )}

      {media.hasVideo && (
        <video
          ref={localRef}
          autoPlay
          playsInline
          muted
          className={`absolute top-4 right-4 w-28 rounded-xl border border-white/15 shadow-xl bg-black ${
            media.cameraOn ? '' : 'opacity-30'
          }`}
        />
      )}

      {error && (
        <div className="absolute top-6 left-1/2 -translate-x-1/2 px-4 py-2 rounded-full bg-crimson/20 border border-crimson/40 text-crimson text-xs animate-fade-in">
          {t(error)}
        </div>
      )}

      {/* Telegram-style control bar */}
      <div
        className="absolute left-3 right-3 flex items-center gap-2.5 rounded-2xl bg-black/70 backdrop-blur-md border border-white/10 px-4 py-3"
        style={{ bottom: 'calc(env(safe-area-inset-bottom) + 1rem)' }}
      >
        <div className="flex items-center gap-3 min-w-0 flex-1">
          <Avatar src={avatar} name={peer ?? '?'} size={38} />
          <div className="min-w-0 leading-tight">
            <div className="text-white font-medium truncate">{peer}</div>
            <div className="text-white/50 text-xs truncate">{status}</div>
          </div>
        </div>
        <CircleBtn
          on={media.muted}
          onClick={() => toggleMute()}
          title={media.muted ? t('call.unmute') : t('call.mute')}
        >
          <CallIcon d={media.muted ? CALL_ICONS.micOff : CALL_ICONS.mic} />
        </CircleBtn>
        <CircleBtn
          on={media.cameraOn}
          onClick={() => toggleCamera()}
          title={media.cameraOn ? t('call.cameraOff') : t('call.cameraOn')}
        >
          <CallIcon d={media.cameraOn ? CALL_ICONS.cam : CALL_ICONS.camOff} />
        </CircleBtn>
        <button
          type="button"
          onClick={() => hangup()}
          className="ml-1 h-11 px-5 rounded-full bg-crimson text-white font-medium hover:brightness-110 transition-all"
        >
          {t('call.hangup')}
        </button>
      </div>
    </div>
  );
}

function IncomingCall({
  peer,
  video,
  avatar,
  onAccept,
  onReject,
}: {
  peer: string | null;
  video: boolean;
  avatar?: string | null;
  onAccept: () => void;
  onReject: () => void;
}) {
  const t = useT();
  return (
    <div className="fixed inset-0 bg-bg-deep/90 backdrop-blur-sm z-50 grid place-items-center animate-fade-in overflow-hidden">
      <Scanlines />
      <div className="term-card flex flex-col items-center gap-4 p-8 animate-pop-in relative">
        <RadarPing active>
          <Avatar src={avatar} name={peer ?? '?'} size={90} />
        </RadarPing>
        <div className="text-phosphor-bright text-lg glow">{peer}</div>
        <div className="text-phosphor text-xs tracking-[0.3em] uppercase animate-flicker">
          {video ? t('call.incomingVideo') : t('call.incoming')}
        </div>
        <div className="flex gap-5 mt-2">
          <button
            type="button"
            onClick={onReject}
            className="w-14 h-14 rounded-full bg-crimson text-bg grid place-items-center hover:scale-110 transition-transform"
            title={t('call.reject')}
          >
            <IconPhone className="w-6 h-6 rotate-[135deg]" />
          </button>
          <button
            type="button"
            onClick={onAccept}
            className="w-14 h-14 rounded-full bg-phosphor text-bg grid place-items-center hover:scale-110 transition-transform"
            title={t('call.accept')}
          >
            {video ? <IconVideo className="w-6 h-6" /> : <IconPhone className="w-6 h-6" />}
          </button>
        </div>
      </div>
    </div>
  );
}

function RejectedCall({
  peer,
  avatar,
  onClose,
  onRetry,
}: {
  peer: string | null;
  avatar?: string | null;
  onClose: () => void;
  onRetry: () => void;
}) {
  const t = useT();
  return (
    <div className="fixed inset-0 bg-bg-deep/90 backdrop-blur-sm z-50 grid place-items-center animate-fade-in overflow-hidden">
      <Scanlines />
      <div className="term-card flex flex-col items-center gap-4 p-8 animate-pop-in relative">
        <div className="opacity-60 grayscale">
          <Avatar src={avatar} name={peer ?? '?'} size={90} />
        </div>
        <div className="text-phosphor-bright text-lg glow">{peer}</div>
        <div className="text-crimson text-xs tracking-[0.3em] uppercase">
          {t('call.rejected')}
        </div>
        <div className="flex gap-4 mt-2">
          <button
            type="button"
            onClick={onClose}
            className="px-5 py-2.5 rounded-full bg-bg-line text-phosphor hover:bg-bg-panel transition-colors text-sm"
          >
            {t('common.close')}
          </button>
          <button
            type="button"
            onClick={onRetry}
            className="px-5 py-2.5 rounded-full bg-phosphor text-bg grid place-items-center gap-2 hover:scale-105 transition-transform text-sm font-semibold flex items-center"
          >
            <IconPhone className="w-4 h-4" />
            {t('common.retry')}
          </button>
        </div>
      </div>
    </div>
  );
}

function SystemRow({
  title,
  preview,
  time,
  unread,
  muted,
  verified,
  active,
  onClick,
}: {
  title: string;
  preview: string;
  time?: string;
  unread: number;
  muted: boolean;
  verified: boolean;
  active: boolean;
  onClick: () => void;
}) {
  const t = useT();
  return (
    <button
      type="button"
      className={`conversation-row conversation-row--system ${
        active ? 'conversation-row--active' : ''
      }`}
      aria-current={active ? 'page' : undefined}
      onClick={onClick}
    >
      <span className="system-avatar" aria-hidden="true">
        <Megaphone className="h-5 w-5" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          <span className={`min-w-0 flex-1 truncate ${unread ? 'font-semibold text-ink' : 'text-ink/90'}`}>
            {title}
          </span>
          {verified ? (
            <ShieldCheck className="h-3.5 w-3.5 shrink-0 text-phosphor" aria-label={t('updates.verified')} />
          ) : (
            <LockKeyhole className="h-3.5 w-3.5 shrink-0 text-ink-muted" aria-label={t('updates.bundled')} />
          )}
          {time && (
            <span className={`shrink-0 text-[11px] ${unread ? 'text-phosphor' : 'text-ink-muted'}`}>
              {time}
            </span>
          )}
        </span>
        <span className="flex items-center gap-2">
          <span className={`min-w-0 flex-1 truncate text-xs ${unread ? 'text-ink-dim' : 'text-ink-muted'}`}>
            {preview}
          </span>
          {muted && <BellOff className="h-3.5 w-3.5 shrink-0 text-ink-muted" />}
          {!!unread && <span className="unread-badge">{unread}</span>}
        </span>
      </span>
    </button>
  );
}

function NodeRow({
  handle,
  hasSession,
  active,
  avatar,
  lastMsg,
  lastTime,
  unread,
  onClick,
}: {
  handle: string;
  hasSession: boolean;
  active: boolean;
  avatar?: string | null;
  lastMsg?: string;
  lastTime?: string;
  unread?: number;
  onClick: () => void;
}) {
  const t = useT();
  return (
    <button
      type="button"
      className={`conversation-row ${active ? 'conversation-row--active' : ''}`}
      aria-current={active ? 'page' : undefined}
      onClick={onClick}
    >
      <Avatar
        src={avatar}
        name={handle}
        size={44}
        status={hasSession ? 'online' : 'offline'}
        statusLabel={hasSession ? t('chat.session') : t('chat.noSession')}
      />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <div
            className={`truncate flex-1 ${
              unread ? 'text-ink font-semibold' : 'text-ink/90'
            }`}
          >
            {handle}
          </div>
          {lastTime && (
            <div className={`shrink-0 text-[11px] ${unread ? 'text-phosphor' : 'text-ink-muted'}`}>
              {lastTime}
            </div>
          )}
        </div>
        <div className="flex items-center gap-2">
          <div
            className={`truncate text-xs flex-1 ${unread ? 'text-ink-dim' : 'text-ink-muted'}`}
          >
            {lastMsg || (hasSession ? t('chat.session') : t('chat.noSession'))}
          </div>
          {!!unread && (
            <span className="unread-badge">
              {unread > 99 ? '99+' : unread}
            </span>
          )}
        </div>
      </div>
    </button>
  );
}

function GroupRow({
  group,
  active,
  lastMsg,
  lastTime,
  unread,
  onClick,
}: {
  group: GroupInfo;
  active: boolean;
  lastMsg?: string;
  lastTime?: string;
  unread?: number;
  onClick: () => void;
}) {
  const t = useT();
  return (
    <button
      type="button"
      className={`conversation-row ${active ? 'conversation-row--active' : ''}`}
      aria-current={active ? 'page' : undefined}
      onClick={onClick}
    >
      <GroupAvatar name={group.name} size={44} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <div className={`min-w-0 flex-1 truncate ${unread ? 'font-semibold text-ink' : 'text-ink/90'}`}>
            {group.name}
          </div>
          {group.is_admin && (
            <span className="shrink-0 text-[10px] uppercase text-amber/80">
              {t('sidebar.admin')}
            </span>
          )}
          {lastTime && (
            <div className={`shrink-0 text-[11px] ${unread ? 'text-cyan' : 'text-ink-muted'}`}>
              {lastTime}
            </div>
          )}
        </div>
        <div className="flex items-center gap-2">
          <div className={`min-w-0 flex-1 truncate text-xs ${unread ? 'text-ink-dim' : 'text-ink-muted'}`}>
            {lastMsg || `${group.member_count} ${group.member_count === 1 ? t('sidebar.member') : t('sidebar.members')}`}
          </div>
          {!!unread && (
            <span className="unread-badge unread-badge--group">
              {unread > 99 ? '99+' : unread}
            </span>
          )}
        </div>
      </div>
    </button>
  );
}

function EmptyChat() {
  const t = useT();
  return (
    <section className="flex h-full min-h-0 flex-col items-center justify-center px-6 text-center">
      <TrinoMark className="h-12 w-12 opacity-55" glow={false} />
      <div className="mt-4 max-w-[18rem] text-sm font-semibold leading-snug text-ink">
        {t('empty.title')}
      </div>
      <div className="mt-2 max-w-[20rem] text-xs leading-relaxed text-ink-muted">
        {t('empty.sub')}
      </div>
      <div className="mt-5 flex items-center gap-2 text-[10px] uppercase tracking-[0.12em] text-phosphor-dim">
        <span className="h-px w-6 bg-phosphor/25" />
        {t('empty.ready')}
        <span className="h-px w-6 bg-phosphor/25" />
      </div>
    </section>
  );
}

function fileToB64(f: File): Promise<string> {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result).split(',')[1] || '');
    r.onerror = rej;
    r.readAsDataURL(f);
  });
}

function getRecentStickers(): string[] {
  try {
    return JSON.parse(localStorage.getItem('sticker-recents') || '[]');
  } catch {
    return [];
  }
}
function pushRecentSticker(id: string) {
  const r = getRecentStickers().filter(x => x !== id);
  r.unshift(id);
  localStorage.setItem('sticker-recents', JSON.stringify(r.slice(0, 24)));
}

function StickerPicker({ onPick, onClose }: { onPick: (s: StickerInfo) => void; onClose: () => void }) {
  const t = useT();
  const [stickers, setStickers] = useState<StickerInfo[]>([]);
  const [tab, setTab] = useState<'recent' | 'all' | 'animated'>('all');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [managing, setManaging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recents, setRecents] = useState<string[]>(getRecentStickers);
  const fileRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const refresh = async () => {
    setLoading(true);
    try {
      setStickers(await api.listStickers());
    } catch (loadError) {
      console.error('sticker load failed', loadError);
      setError(t('sticker.loadError'));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    refresh();
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    const onPointerDown = (event: PointerEvent) => {
      if (!panelRef.current?.contains(event.target as Node)) onClose();
    };
    window.addEventListener('keydown', onKey);
    const timer = window.setTimeout(() => {
      document.addEventListener('pointerdown', onPointerDown);
    }, 0);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onPointerDown);
    };
  }, [onClose]);

  const importFiles = async (files: File[]) => {
    if (files.length === 0) return;
    setBusy(true);
    setError(null);
    for (const file of files) {
      if (file.size > 5 * 1024 * 1024) {
        setError(t('sticker.tooLarge'));
        continue;
      }
      try {
        const b64 = await fileToB64(file);
        await api.importSticker(b64, file.type || 'image/png');
      } catch (importError) {
        console.error('sticker import failed', importError);
        setError(t('sticker.importError'));
      }
    }
    await refresh();
    setTab('all');
    setBusy(false);
  };

  const pick = (sticker: StickerInfo) => {
    pushRecentSticker(sticker.id);
    setRecents(getRecentStickers());
    onPick(sticker);
  };

  const removeSticker = async (sticker: StickerInfo) => {
    try {
      await api.deleteSticker(sticker.id);
      const nextRecents = getRecentStickers().filter(id => id !== sticker.id);
      localStorage.setItem('sticker-recents', JSON.stringify(nextRecents));
      setRecents(nextRecents);
      await refresh();
    } catch (deleteError) {
      console.error('sticker delete failed', deleteError);
      setError(t('sticker.deleteError'));
    }
  };

  const recentStickers = recents
    .map(id => stickers.find(sticker => sticker.id === id))
    .filter((sticker): sticker is StickerInfo => !!sticker);
  const animatedStickers = stickers.filter(sticker => sticker.mime === 'image/gif');
  const shown =
    tab === 'recent' ? recentStickers : tab === 'animated' ? animatedStickers : stickers;
  const sectionTitle =
    tab === 'recent'
      ? t('sticker.recent')
      : tab === 'animated'
        ? t('sticker.animated')
        : t('sticker.all');

  const TabButton = ({
    id,
    title,
    children,
  }: {
    id: 'recent' | 'all' | 'animated';
    title: string;
    children: ReactNode;
  }) => (
    <button
      type="button"
      title={title}
      className={`sticker-tab ${tab === id ? 'sticker-tab--active' : ''}`}
      aria-pressed={tab === id}
      onClick={() => {
        setTab(id);
        setManaging(false);
      }}
    >
      {children}
    </button>
  );

  return (
    <div
      ref={panelRef}
      className="sticker-panel animate-pop-in"
      onClick={event => event.stopPropagation()}
    >
      <input
        type="file"
        ref={fileRef}
        className="hidden"
        multiple
        accept="image/jpeg,image/png,image/gif,image/webp"
        onChange={async event => {
          const files = event.target.files ? Array.from(event.target.files) : [];
          event.target.value = '';
          await importFiles(files);
        }}
      />

      <div className="sticker-panel__header">
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold text-ink">{t('sticker.title')}</div>
          <div className="mt-0.5 text-[10px] text-ink-muted">
            {busy
              ? t('sticker.importing')
              : `${shown.length} ${shown.length === 1 ? t('sticker.item') : t('sticker.items')}`}
          </div>
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            className={`icon-button ${managing ? 'border-crimson/30 bg-crimson/10 text-crimson' : ''}`}
            title={managing ? t('sticker.done') : t('sticker.manage')}
            onClick={() => setManaging(value => !value)}
            disabled={stickers.length === 0}
          >
            {managing ? <Check className="h-4 w-4" /> : <Trash2 className="h-4 w-4" />}
          </button>
          <button type="button" className="icon-button" onClick={onClose} title={t('common.close')}>
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>

      <div className="sticker-panel__content">
        <div className="sticker-section-heading">
          <span>{sectionTitle}</span>
          {loading && <LoaderCircle className="h-3.5 w-3.5 animate-spin text-phosphor" />}
        </div>

        {error && (
          <div role="alert" className="sticker-error">
            {error}
          </div>
        )}

        {!loading && shown.length === 0 ? (
          <div className="sticker-empty">
            {tab === 'recent' ? (
              <Clock3 className="h-7 w-7" />
            ) : tab === 'animated' ? (
              <Film className="h-7 w-7" />
            ) : (
              <ImagePlus className="h-7 w-7" />
            )}
            <div className="text-sm text-ink">
              {tab === 'recent'
                ? t('sticker.emptyRecent')
                : tab === 'animated'
                  ? t('sticker.emptyAnimated')
                  : t('sticker.emptyAll')}
            </div>
            {tab === 'all' && (
              <button
                type="button"
                className="term-button text-xs"
                onClick={() => fileRef.current?.click()}
              >
                <ImagePlus className="h-3.5 w-3.5" />
                {t('sticker.import')}
              </button>
            )}
          </div>
        ) : (
          <div className="sticker-grid">
            {shown.map(sticker => {
              const safeSrc = safeInlineRasterSrc(
                sticker.data_url,
                INLINE_STICKER_MAX_CHARS,
              );
              return (
                <div key={sticker.id} className="sticker-tile">
                  {safeSrc ? (
                    <button
                      type="button"
                      className="sticker-tile__send"
                      onClick={() => pick(sticker)}
                      title={t('sticker.send')}
                      disabled={managing}
                    >
                      <img src={safeSrc} alt="" className="sticker-tile__image" />
                    </button>
                  ) : (
                    <div className="grid h-full w-full place-items-center text-[10px] text-crimson">
                      {t('sticker.invalid')}
                    </div>
                  )}
                  {managing && (
                    <button
                      type="button"
                      className="sticker-tile__delete"
                      onClick={() => removeSticker(sticker)}
                      title={t('sticker.delete')}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="sticker-panel__tabs">
        <TabButton id="recent" title={t('sticker.recent')}>
          <Clock3 className="h-4 w-4" />
        </TabButton>
        <TabButton id="all" title={t('sticker.all')}>
          <Grid2X2 className="h-4 w-4" />
        </TabButton>
        <TabButton id="animated" title={t('sticker.animated')}>
          <Film className="h-4 w-4" />
        </TabButton>
        <span className="mx-1 h-6 w-px bg-bg-line" />
        <button
          type="button"
          className="sticker-tab ml-auto"
          title={t('sticker.import')}
          onClick={() => fileRef.current?.click()}
          disabled={busy}
        >
          {busy ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <ImagePlus className="h-4 w-4" />}
        </button>
      </div>
    </div>
  );
}

function MessageComposer({
  onSendText,
  onSendFile,
  onSendSticker,
  replyingTo,
  setReplyingTo,
  placeholder,
}: {
  onSendText: (
    text: string,
    reply?: { author: string; preview: string },
  ) => Promise<void> | void;
  onSendFile: (p: ProcessedFile) => Promise<void> | void;
  onSendSticker: (s: StickerInfo) => Promise<void> | void;
  replyingTo: { author: string; preview: string } | null;
  setReplyingTo: (r: { author: string; preview: string } | null) => void;
  placeholder: string;
}) {
  const t = useT();
  const [showStickers, setShowStickers] = useState(false);
  const [text, setText] = useState('');
  const [tray, setTray] = useState<ProcessedFile[]>([]);
  const [sending, setSending] = useState<{ total: number; done: number } | null>(null);
  const [composerError, setComposerError] = useState<string | null>(null);
  const ref = useRef<HTMLInputElement>(null);

  const addFiles = async (files: File[]) => {
    for (const f of files) {
      try {
        setTray(t => [...t, { name: '…', mime: f.type, dataB64: '', thumb: null } as ProcessedFile]);
        const p = await processFile(f);
        setTray(t => {
          const copy = [...t];
          const idx = copy.findIndex(x => x.name === '…');
          if (idx >= 0) copy[idx] = p;
          else copy.push(p);
          return copy;
        });
      } catch (err) {
        console.error('file processing failed', err);
        setComposerError(t('composer.processFileError'));
        setTray(t => t.filter(x => x.name !== '…'));
      }
    }
  };

  const onPaste = async (e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    const imgs: File[] = [];
    for (const it of Array.from(items)) {
      if (it.type.startsWith('image/')) {
        const f = it.getAsFile();
        if (f) imgs.push(f);
      }
    }
    if (imgs.length) {
      e.preventDefault();
      await addFiles(imgs);
    }
  };

  const send = async () => {
    if (sending) return;
    setComposerError(null);
    const body = text.trim();
    if (tray.length === 0) {
      if (!body) return;
      try {
        await onSendText(body, replyingTo ?? undefined);
        setText('');
        setReplyingTo(null);
      } catch (err) {
        console.error('message send failed', err);
        setComposerError(t('error.sendMessage'));
      }
      return;
    }
    const ready = tray.filter(x => x.name !== '…' && x.dataB64);
    setSending({ total: ready.length, done: 0 });
    const failed: ProcessedFile[] = [];
    for (const p of ready) {
      try {
        await onSendFile(p);
      } catch (err) {
        console.error('file upload failed', err);
        failed.push(p);
        setComposerError(t('error.sendFile'));
      }
      setSending(s => (s ? { ...s, done: s.done + 1 } : s));
    }
    setTray(failed);
    if (failed.length === 0 && body) {
      try {
        await onSendText(body, replyingTo ?? undefined);
        setText('');
        setReplyingTo(null);
      } catch (err) {
        console.error('message send failed', err);
        setComposerError(t('error.sendMessage'));
      }
    } else if (failed.length === 0) {
      setText('');
      setReplyingTo(null);
    }
    setSending(null);
  };

  const pct = sending && sending.total > 0 ? Math.round((sending.done / sending.total) * 100) : 0;

  return (
    <>
      {replyingTo && (
        <div className="border-t border-bg-line px-4 py-2 flex items-center gap-2 bg-bg-panel">
          <div className="border-l-2 border-cyan pl-2 flex-1 min-w-0">
            <div className="text-cyan text-xs">
              {t('composer.replyingTo')} {replyingTo.author}
            </div>
            <div className="text-phosphor-dim text-xs truncate">{replyingTo.preview}</div>
          </div>
          <button
            type="button"
            className="icon-button h-8 w-8 text-crimson"
            onClick={() => setReplyingTo(null)}
            title={t('common.close')}
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      )}
      {tray.length > 0 && (
        <div className="border-t border-bg-line px-3 py-2 bg-bg-panel">
          <div className="flex gap-2 flex-wrap">
            {tray.map((p, i) => {
              const safeThumb = safeInlineRasterSrc(p.thumb);
              return (
                <div key={i} className="relative w-16 h-16 rounded border border-bg-line overflow-hidden bg-bg-deep grid place-items-center">
                  {safeThumb ? (
                    <img src={safeThumb} alt="" className="w-full h-full object-cover" />
                  ) : p.name === '…' ? (
                    <span className="text-phosphor-dim text-xs animate-pulse">…</span>
                  ) : (
                    <span className="text-phosphor-dim text-[9px] px-1 text-center break-all">{p.name}</span>
                  )}
                  {!sending && (
                    <button
                      type="button"
                      className="absolute right-0 top-0 grid h-6 w-6 place-items-center bg-bg-deep/90 text-crimson"
                      onClick={() => setTray(t => t.filter((_, j) => j !== i))}
                      title={t('composer.removeFile')}
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
              );
            })}
          </div>
          {sending && (
            <div className="mt-2">
              <div className="text-phosphor-dim text-[11px] mb-1">
                {t('composer.uploading')} {sending.done}/{sending.total}…
              </div>
              <div className="h-1.5 bg-bg-deep rounded overflow-hidden">
                <div
                  className="h-full bg-phosphor transition-all duration-300"
                  style={{ width: `${pct}%` }}
                />
              </div>
            </div>
          )}
        </div>
      )}
      {composerError && (
        <div
          role="alert"
          className="border-t border-crimson/35 bg-crimson/5 px-4 py-1.5 text-[11px] text-crimson"
        >
          {t('error.notice')}: {composerError}
        </div>
      )}
      <div className="composer-bar">
        <input
          type="file"
          ref={ref}
          className="hidden"
          multiple
          accept="image/*,video/*,*/*"
          onChange={async e => {
            const files = e.target.files ? Array.from(e.target.files) : [];
            e.target.value = '';
            await addFiles(files);
          }}
        />
        <div className="composer-field">
          <div className="relative shrink-0">
            <button
              className={`composer-icon ${showStickers ? 'composer-icon--active' : ''}`}
              title={t('sticker.title')}
              onClick={() => setShowStickers(value => !value)}
              type="button"
            >
              <Smile className="h-[18px] w-[18px]" />
            </button>
            {showStickers && (
              <StickerPicker
                onClose={() => setShowStickers(false)}
                onPick={async sticker => {
                  try {
                    await onSendSticker(sticker);
                    setShowStickers(false);
                  } catch (sendError) {
                    console.error('sticker send failed', sendError);
                    setComposerError(t('error.sendSticker'));
                  }
                }}
              />
            )}
          </div>
          <input
            className="composer-input"
            value={text}
            onChange={event => setText(event.target.value)}
            onPaste={onPaste}
            onKeyDown={event => event.key === 'Enter' && send()}
            placeholder={tray.length ? t('composer.optionalText') : placeholder}
            autoFocus
          />
          <button
            className="composer-icon"
            title={t('composer.attachFiles')}
            onClick={() => ref.current?.click()}
            type="button"
          >
            <Paperclip className="h-[18px] w-[18px]" />
          </button>
        </div>
        <button
          className="composer-send"
          disabled={!!sending}
          onClick={send}
          title={t('composer.send')}
          type="button"
        >
          {sending ? (
            <LoaderCircle className="h-[18px] w-[18px] animate-spin" />
          ) : (
            <SendHorizontal className="h-[18px] w-[18px]" />
          )}
        </button>
      </div>
    </>
  );
}

function ChatView({
  handle,
  avatar,
  hasSession,
  fingerprint,
  myFingerprint,
  messages,
  blocked,
  onSend,
  onSendFile,
  onSendSticker,
  onCall,
  onForward,
  onDelete,
  onRenamed,
  onDeleted,
  onBlockChanged,
  onBack,
}: {
  onBack: () => void;
  handle: string;
  avatar?: string | null;
  hasSession: boolean;
  fingerprint: string;
  myFingerprint: string;
  blocked: boolean;
  messages: ChatMessage[];
  onSend: (text: string, reply?: { author: string; preview: string }) => Promise<void> | void;
  onSendFile: (p: ProcessedFile) => Promise<void> | void;
  onSendSticker: (s: StickerInfo) => Promise<void> | void;
  onCall: (video: boolean) => void;
  onForward: (m: ChatMessage) => void;
  onDelete: (index: number) => void;
  onRenamed: (newHandle: string) => void;
  onDeleted: () => void;
  onBlockChanged: () => void;
}) {
  const t = useT();
  const [replyingTo, setReplyingTo] = useState<{ author: string; preview: string } | null>(null);
  const [showInfo, setShowInfo] = useState(false);
  const [note, setNote] = useState(() => localStorage.getItem('note:' + handle) || '');
  const { scrollRef, endRef, atBottom, onScroll, scrollToBottom } = useAutoScroll(messages.length);

  useEffect(() => {
    setNote(localStorage.getItem('note:' + handle) || '');
  }, [handle, showInfo]);

  const previewOf = (m: ChatMessage) => m.text || (m.file ? '📎 ' + m.file.name : '');

  return (
    <section className="flex flex-col h-full min-h-0 relative">
      <div className="flex h-14 items-center gap-3 border-b border-bg-line px-4">
        <button
          className="md:hidden -ml-1 mr-0.5 icon-button shrink-0"
          onClick={onBack}
          title={t('common.back')}
        >
          <ChevronLeft className="h-5 w-5" />
        </button>
        <button
          className="flex items-center gap-3 min-w-0 flex-1 text-left hover:opacity-80 transition-opacity"
          onClick={() => setShowInfo(true)}
          title={t('chat.info')}
        >
          <Avatar
            src={avatar}
            name={handle}
            size={36}
            status={hasSession ? 'online' : 'offline'}
            statusLabel={hasSession ? t('chat.session') : t('chat.noSession')}
          />
          <div className="min-w-0">
            <div className="truncate leading-tight text-ink">{handle}</div>
            <div className="flex truncate text-xs leading-tight text-ink-muted">
              <IconShield className="w-3 h-3 text-phosphor/60" />
              <span className="ml-1 truncate">
                {note || (hasSession ? t('chat.session') : t('chat.noSession'))}
              </span>
            </div>
          </div>
        </button>
        <div className="chat-header-actions">
          <button
            type="button"
            aria-label={t('chat.info')}
            title={t('chat.info')}
            onClick={() => setShowInfo(true)}
            className="icon-button"
          >
            <Info className="h-4 w-4" />
          </button>
          <button
            type="button"
            aria-label={t('chat.call')}
            title={t('chat.call')}
            onClick={() => onCall(false)}
            className="icon-button"
          >
            <IconPhone />
          </button>
          <button
            type="button"
            aria-label={t('chat.video')}
            title={t('chat.video')}
            onClick={() => onCall(true)}
            className="icon-button"
          >
            <IconVideo />
          </button>
        </div>
      </div>
      {showInfo && (
        <ChatInfoPanel
          handle={handle}
          avatar={avatar}
          hasSession={hasSession}
          fingerprint={fingerprint}
          myFingerprint={myFingerprint}
          blocked={blocked}
          onClose={() => setShowInfo(false)}
          onRenamed={h => {
            setShowInfo(false);
            onRenamed(h);
          }}
          onDeleted={() => {
            setShowInfo(false);
            onDeleted();
          }}
          onBlockChanged={onBlockChanged}
        />
      )}
      <div ref={scrollRef} onScroll={onScroll} className="flex-1 overflow-y-auto p-3 sm:p-4">
        {messages.length === 0 && (
          <div className="text-phosphor-dim text-xs">{t('chat.empty')}</div>
        )}
        {messages.map((m, i) => {
          const prev = messages[i - 1];
          const grouped = !!prev && prev.side === m.side && prev.from === m.from;
          return (
            <div key={i} className={grouped ? 'mt-0.5' : 'mt-3 first:mt-0'}>
              <Bubble
                {...m}
                from={m.side === 'me' ? undefined : handle}
                avatar={avatar ?? undefined}
                grouped={grouped}
                onReply={() =>
                  setReplyingTo({
                    author: m.side === 'me' ? t('message.you') : handle,
                    preview: previewOf(m),
                  })
                }
                onForward={() => onForward(m)}
                onDelete={() => onDelete(i)}
              />
            </div>
          );
        })}
        <div ref={endRef} />
      </div>
      {!atBottom && <ScrollDownBtn onClick={scrollToBottom} />}
      <MessageComposer
        onSendText={onSend}
        onSendFile={onSendFile}
        onSendSticker={onSendSticker}
        replyingTo={replyingTo}
        setReplyingTo={setReplyingTo}
        placeholder={t('composer.placeholder')}
      />
    </section>
  );
}

// Auto-scrolls to the newest message ONLY when the user is already near the
// bottom, so reading older messages isn't interrupted. Exposes a flag + jump
// helper for a "scroll to bottom" button.
function useAutoScroll(dep: number) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const [atBottom, setAtBottom] = useState(true);
  const onScroll = () => {
    const el = scrollRef.current;
    if (el) setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 140);
  };
  useEffect(() => {
    if (atBottom) endRef.current?.scrollIntoView({ behavior: 'smooth' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dep]);
  const scrollToBottom = () => endRef.current?.scrollIntoView({ behavior: 'smooth' });
  return { scrollRef, endRef, atBottom, onScroll, scrollToBottom };
}

function ScrollDownBtn({ onClick }: { onClick: () => void }) {
  const t = useT();
  return (
    <button
      type="button"
      onClick={onClick}
      title={t('chat.scrollToEnd')}
      className="absolute bottom-[4.75rem] right-4 z-10 grid h-9 w-9 place-items-center rounded-full border border-bg-line bg-bg-panel text-ink-muted shadow-lg transition-colors hover:bg-bg-raised hover:text-ink"
    >
      <ArrowDown className="h-4 w-4" />
    </button>
  );
}

// Renders message text with clickable URLs that open in the system browser.
function Linkify({ text }: { text: string }) {
  const parts = text.split(/(https?:\/\/[^\s]+)/g);
  return (
    <div className="whitespace-pre-wrap break-words">
      {parts.map((p, i) =>
        /^https?:\/\//.test(p) ? (
          <a
            key={i}
            href={p}
            className="text-cyan underline break-all"
            onClick={e => {
              e.preventDefault();
              e.stopPropagation();
              openLink(p);
            }}
          >
            {p}
          </a>
        ) : (
          <span key={i}>{p}</span>
        ),
      )}
    </div>
  );
}

function Bubble({
  side,
  text,
  time,
  from,
  file,
  reply,
  ttl,
  avatar,
  grouped,
  onReply,
  onForward,
  onDelete,
}: ChatMessage & {
  avatar?: string | null;
  grouped?: boolean;
  onReply?: () => void;
  onForward?: () => void;
  onDelete?: () => void;
}) {
  const t = useT();
  const isMe = side === 'me';
  const isSticker = !!file && file.name.startsWith('sticker::');
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const openMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    setMenu({ x: e.clientX, y: e.clientY });
  };
  const menuItems: MenuItem[] = [
    ...(onReply ? [{ label: t('message.reply'), onClick: onReply }] : []),
    ...(text
      ? [{ label: t('common.copy'), onClick: () => navigator.clipboard.writeText(text).catch(() => {}) }]
      : []),
    ...(onForward ? [{ label: t('message.forward'), onClick: onForward }] : []),
    ...(onDelete ? [{ label: t('message.deleteForMe'), onClick: onDelete, danger: true }] : []),
  ];
  return (
    <div
      className={`group flex items-end gap-2 animate-slide-up ${
        isMe ? 'justify-end' : 'justify-start'
      }`}
    >
      {!isMe && from && (grouped ? <div className="w-[26px] shrink-0" /> : <Avatar src={avatar} name={from} size={26} />)}
      {/* actions menu button (left of my bubbles) */}
      {isMe && menuItems.length > 0 && (
        <button
          type="button"
          className="icon-button h-7 w-7 self-center opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
          title={t('message.actions')}
          onClick={e => setMenu({ x: e.clientX, y: e.clientY })}
        >
          <MoreVertical className="h-4 w-4" />
        </button>
      )}
      <div
        onContextMenu={openMenu}
        onDoubleClick={() => onReply?.()}
        className={
          isSticker
            ? 'max-w-2xl cursor-default'
            : `message-bubble ${isMe ? 'message-bubble--me' : 'message-bubble--them'}`
        }
      >
        {!isMe && from && !grouped && <div className="text-cyan text-xs mb-0.5">{from}</div>}
        {reply && (
          <div className="border-l-2 border-cyan/60 pl-2 mb-1 text-xs text-phosphor-dim">
            <span className="text-cyan">{reply.author}</span>
            <div className="truncate max-w-[16rem]">{reply.preview}</div>
          </div>
        )}
        {file ? (
          <FileBubble file={file} />
        ) : (
          <Linkify text={text ?? ''} />
        )}
        <div className={`mt-1 text-[11px] text-ink-muted ${isSticker ? 'text-center' : 'text-right'}`}>
          {ttl ? '⏱ ' : ''}
          {time}
        </div>
      </div>
      {/* actions menu button (right of their bubbles) */}
      {!isMe && menuItems.length > 0 && (
        <button
          type="button"
          className="icon-button h-7 w-7 self-center opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
          title={t('message.actions')}
          onClick={e => setMenu({ x: e.clientX, y: e.clientY })}
        >
          <MoreVertical className="h-4 w-4" />
        </button>
      )}
      {menu && menuItems.length > 0 && (
        <ContextMenu x={menu.x} y={menu.y} items={menuItems} onClose={() => setMenu(null)} />
      )}
    </div>
  );
}

interface MenuItem {
  label: string;
  onClick: () => void;
  danger?: boolean;
}
function ContextMenu({ x, y, items, onClose }: { x: number; y: number; items: MenuItem[]; onClose: () => void }) {
  useEffect(() => {
    const close = () => onClose();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    // Attach on the NEXT tick so the click/contextmenu that opened this menu
    // doesn't immediately close it.
    const id = window.setTimeout(() => {
      window.addEventListener('click', close);
      window.addEventListener('contextmenu', close);
      window.addEventListener('keydown', onKey);
    }, 0);
    return () => {
      window.clearTimeout(id);
      window.removeEventListener('click', close);
      window.removeEventListener('contextmenu', close);
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose]);
  // Portal to <body> so no overflow/transform ancestor can clip it.
  return createPortal(
    <div
      role="menu"
      className="fixed z-[80] min-w-[9rem] term-card p-1 animate-pop-in"
      style={{ left: Math.min(x, window.innerWidth - 170), top: Math.min(y, window.innerHeight - 150) }}
      onClick={e => e.stopPropagation()}
    >
      {items.map((it, i) => (
        <button
          role="menuitem"
          key={i}
          className={`w-full text-left px-3 py-1.5 text-sm rounded hover:bg-bg-line ${
            it.danger ? 'text-crimson' : 'text-phosphor'
          }`}
          onClick={() => {
            it.onClick();
            onClose();
          }}
        >
          {it.label}
        </button>
      ))}
    </div>,
    document.body,
  );
}


function IconClip({ className = 'w-4 h-4' }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
    </svg>
  );
}

function IconDownload({ className = 'w-5 h-5' }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="7 10 12 15 17 10" />
      <line x1="12" y1="15" x2="12" y2="3" />
    </svg>
  );
}

function IconClose({ className = 'w-5 h-5' }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}

function IconPhone({ className = 'w-4 h-4' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.9.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92z" />
    </svg>
  );
}

function IconVideo({ className = 'w-4 h-4' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="23 7 16 12 23 17 23 7" />
      <rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
    </svg>
  );
}

function IconShield({ className = 'w-4 h-4' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
      <path d="m9 12 2 2 4-4" />
    </svg>
  );
}

type AvatarStatus = 'online' | 'offline' | 'away';
type AvatarKind = 'person' | 'group';

const AVATAR_TONES = [
  { backgroundColor: '#10261a', color: '#76f39c', borderColor: '#245a38' },
  { backgroundColor: '#10232b', color: '#83d8ff', borderColor: '#245165' },
  { backgroundColor: '#2a2112', color: '#f2c96d', borderColor: '#665126' },
  { backgroundColor: '#291826', color: '#ef9ae2', borderColor: '#65335d' },
  { backgroundColor: '#2b1918', color: '#ff9f91', borderColor: '#663630' },
] as const;

function identityHash(name: string): number {
  let hash = 0;
  for (const char of name.trim().toLowerCase()) {
    hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  }
  return hash;
}

function identityInitials(name: string): string {
  const clean = name.trim().replace(/^[@#]+/, '');
  if (!clean) return '?';
  const parts = clean.split(/[\s._-]+/).filter(Boolean);
  if (parts.length > 1) {
    return `${parts[0][0]}${parts[parts.length - 1][0]}`.toUpperCase();
  }
  return clean.slice(0, 2).toUpperCase();
}

function Avatar({
  src,
  name,
  size = 32,
  status,
  statusLabel,
  kind = 'person',
}: {
  src?: string | null;
  name: string;
  size?: number;
  status?: AvatarStatus;
  statusLabel?: string;
  kind?: AvatarKind;
}) {
  const safeSrc = safeInlineRasterSrc(src);
  const [imageFailed, setImageFailed] = useState(false);
  const tone = AVATAR_TONES[identityHash(`${kind}:${name}`) % AVATAR_TONES.length];
  const showImage = kind === 'person' && !!safeSrc && !imageFailed;
  const statusSize = Math.max(9, Math.round(size * 0.25));

  useEffect(() => {
    setImageFailed(false);
  }, [safeSrc]);

  return (
    <span
      className={`identity-avatar ${kind === 'group' ? 'identity-avatar--group' : ''}`}
      style={{
        width: size,
        height: size,
        fontSize: Math.max(10, Math.round(size * 0.34)),
        backgroundColor: tone.backgroundColor,
        color: tone.color,
        borderColor: tone.borderColor,
      }}
    >
      {showImage ? (
        <img
          src={safeSrc}
          alt={name}
          className="identity-avatar__image"
          onError={() => setImageFailed(true)}
        />
      ) : (
        <span className="identity-avatar__initials" role="img" aria-label={name}>
          {identityInitials(name)}
        </span>
      )}
      {kind === 'group' && (
        <span className="identity-avatar__group-mark" aria-hidden="true">
          <Hash />
        </span>
      )}
      {status && (
        <span
          className={`identity-avatar__status identity-avatar__status--${status}`}
          style={{ width: statusSize, height: statusSize }}
          title={statusLabel}
          aria-label={statusLabel}
        />
      )}
    </span>
  );
}

function GroupAvatar({ name, size = 32 }: { name: string; size?: number }) {
  return <Avatar name={name} size={size} kind="group" />;
}

function FileBubble({ file }: { file: FileRef }) {
  const t = useT();
  const isImage = SAFE_RASTER_MIMES.has(file.mime);
  const isVideo = SAFE_VIDEO_MIMES.has(file.mime);
  const isMedia = isImage || isVideo;
  const safeThumb = safeInlineRasterSrc(file.thumb);
  const [fullUrl, setFullUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [viewing, setViewing] = useState(false);
  const renderUrl = fullUrl
    ? isImage
      ? safeInlineRasterSrc(fullUrl, INLINE_MEDIA_MAX_CHARS)
      : safeInlineVideoSrc(fullUrl)
    : undefined;

  const kb = Math.max(1, Math.round(file.size / 1024));
  const sizeLabel = kb >= 1024 ? `${(kb / 1024).toFixed(1)} MB` : `${kb} KB`;

  const getFull = async (): Promise<string> => {
    if (fullUrl) return fullUrl;
    setLoading(true);
    setError(null);
    try {
      const url = await api.fetchFile(file.url, file.key, file.sha256, file.mime);
      setFullUrl(url);
      return url;
    } catch {
      setError(t('file.downloadError'));
      throw new Error('fetch failed');
    } finally {
      setLoading(false);
    }
  };

  const view = async () => {
    try {
      const url = await getFull();
      const renderable = isImage
        ? safeInlineRasterSrc(url, INLINE_MEDIA_MAX_CHARS)
        : safeInlineVideoSrc(url);
      if (!renderable) {
        setError(t('file.unsafeFormat'));
        return;
      }
      setViewing(true);
    } catch {
      /* handled */
    }
  };
  const download = async () => {
    try {
      const url = await getFull();
      const a = document.createElement('a');
      a.href = url;
      a.download = file.name;
      a.click();
    } catch {
      /* handled */
    }
  };

  const isSticker = isImage && file.name.startsWith('sticker::');
  useEffect(() => {
    if (isSticker && !safeThumb && !fullUrl) getFull().catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  if (isSticker) {
    const src =
      safeThumb || safeInlineRasterSrc(fullUrl, INLINE_STICKER_MAX_CHARS);
    return src ? (
      <img src={src} alt={t('message.sticker')} className="max-w-[150px] max-h-[150px] object-contain" />
    ) : (
      <div className="w-24 h-24 grid place-items-center text-phosphor-dim text-xs">
        {error ? '✕ sticker' : '…'}
      </div>
    );
  }

  return (
    <div className="space-y-1">
      {isMedia && safeThumb ? (
        <div
          className="relative inline-block cursor-pointer group overflow-hidden rounded"
          onClick={view}
          title={t('file.view')}
        >
          <img
            src={safeThumb}
            alt={file.name}
            className="max-w-[220px] max-h-52 rounded transition-transform duration-200 group-hover:scale-105"
          />
          <div className="absolute inset-0 bg-bg-deep/0 group-hover:bg-bg-deep/20 transition-colors" />
          {isVideo && (
            <div className="absolute inset-0 grid place-items-center">
              <span className="w-12 h-12 grid place-items-center rounded-full bg-bg-deep/60 text-phosphor text-xl transition-transform group-hover:scale-110">
                ▶
              </span>
            </div>
          )}
        </div>
      ) : (
        <div className="text-cyan text-sm">📎 {file.name}</div>
      )}
      <div className="text-phosphor-dim text-[10px]">
        {sizeLabel}
        {loading ? ` · ${t('file.downloading')}` : ''}
        {error ? ` · ${error}` : ''}
      </div>
      <div className="flex gap-3 text-xs">
        {isMedia && (
          <button className="text-cyan hover:underline" onClick={view} disabled={loading}>
            {t('file.view')}
          </button>
        )}
        <button className="text-cyan hover:underline" onClick={download} disabled={loading}>
          {t('file.download')}
        </button>
      </div>
      {viewing && renderUrl && (
        <MediaViewer
          url={renderUrl}
          mime={file.mime}
          name={file.name}
          onClose={() => setViewing(false)}
        />
      )}
    </div>
  );
}

function MediaViewer({
  url,
  mime,
  name,
  onClose,
}: {
  url: string;
  mime: string;
  name: string;
  onClose: () => void;
}) {
  const t = useT();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const download = () => {
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`${t('file.viewer')}: ${name}`}
      className="fixed inset-0 bg-bg-deep/95 backdrop-blur-md z-50 flex flex-col animate-fade-in"
      onClick={onClose}
    >
      {/* toolbar */}
      <div
        className="h-12 shrink-0 border-b border-phosphor/20 bg-bg-panel flex items-center gap-1 px-4"
        onClick={e => e.stopPropagation()}
      >
        <IconClip className="w-4 h-4 text-phosphor-dim shrink-0" />
        <span className="text-phosphor-bright text-sm truncate flex-1 ml-1">{name}</span>
        <ViewerBtn title={t('file.download')} onClick={download}>
          <IconDownload />
        </ViewerBtn>
        <ViewerBtn title={`${t('common.close')} (Esc)`} danger onClick={onClose}>
          <IconClose />
        </ViewerBtn>
      </div>

      {/* centered media */}
      <div className="flex-1 grid place-items-center p-6 overflow-auto" onClick={onClose}>
        <div className="animate-pop-in" onClick={e => e.stopPropagation()}>
          {SAFE_VIDEO_MIMES.has(mime) ? (
            // eslint-disable-next-line jsx-a11y/media-has-caption
            <video src={url} controls autoPlay className="max-w-[90vw] max-h-[78vh] rounded shadow-2xl" />
          ) : (
            <img
              src={url}
              alt={name}
              className="max-w-[90vw] max-h-[78vh] object-contain rounded shadow-2xl"
            />
          )}
        </div>
      </div>
    </div>
  );
}

function ViewerBtn({
  title,
  onClick,
  danger,
  children,
}: {
  title: string;
  onClick: () => void;
  danger?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      title={title}
      onClick={onClick}
      className={`w-9 h-9 grid place-items-center rounded transition-all duration-150 hover:scale-110 ${
        danger
          ? 'text-phosphor-dim hover:text-crimson hover:bg-crimson/10'
          : 'text-phosphor/70 hover:text-phosphor hover:bg-phosphor/10'
      }`}
    >
      {children}
    </button>
  );
}

// Open a file picker, strip metadata + build a thumbnail, hand the result to `onPick`.
function useFilePicker(
  onPick: (p: ProcessedFile) => void,
  onError: (error: unknown) => void,
) {
  const ref = useRef<HTMLInputElement>(null);
  const input = (
    <input
      type="file"
      ref={ref}
      className="hidden"
      accept="image/*,video/*,*/*"
      onChange={async e => {
        const f = e.target.files?.[0];
        e.target.value = '';
        if (!f) return;
        try {
          onPick(await processFile(f));
        } catch (err) {
          onError(err);
        }
      }}
    />
  );
  return { input, open: () => ref.current?.click() };
}

function AddNodeModal({ onClose, onAdded }: { onClose: () => void; onAdded: () => void }) {
  const t = useT();
  const [bundleJson, setBundleJson] = useState('');
  const [handle, setHandle] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setError(null);
    setBusy(true);
    try {
      const json = fromCompactCode(bundleJson) ?? bundleJson;
      let h = handle.trim();
      if (!h) {
        try {
          h = JSON.parse(json).handle || '';
        } catch {
          /* ignore */
        }
      }
      await api.probeNode(json, h || t('contact.defaultName'));
      onAdded();
    } catch {
      setError(t('contact.addError'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal onClose={onClose} title={t('contact.addTitle')}>
      <div className="text-xs text-phosphor-dim mb-3">
        {t('contact.addDesc')}
      </div>
      <textarea
        className="term-input w-full h-24 mb-3 font-mono text-xs"
        value={bundleJson}
        onChange={e => setBundleJson(e.target.value)}
        placeholder="trino1:eyJ…"
      />
      <label className="text-xs text-phosphor-dim block mb-1">
        {t('contact.nameOptional')}
      </label>
      <input
        className="term-input w-full mb-4"
        value={handle}
        onChange={e => setHandle(e.target.value)}
        placeholder={t('contact.namePlaceholder')}
      />
      {error && <div className="text-crimson text-xs mb-3">{error}</div>}
      <div className="flex gap-2">
        <button type="button" className="term-button flex-1" onClick={onClose}>
          {t('common.cancel')}
        </button>
        <button type="button" className="term-button flex-1" disabled={busy} onClick={submit}>
          {busy ? t('contact.adding') : t('contact.add')}
        </button>
      </div>
    </Modal>
  );
}

class QRBoundary extends Component<{ children: ReactNode; fallback: string }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    if (this.state.failed) {
      return (
        <div className="text-crimson text-xs text-center px-4">
          {this.props.fallback}
        </div>
      );
    }
    return this.props.children;
  }
}

function ShareModal({ onClose }: { onClose: () => void }) {
  const t = useT();
  const [bundle, setBundle] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showJson, setShowJson] = useState(false);

  useEffect(() => {
    api.shareBundle().then(setBundle).catch(() => setError(t('contact.shareError')));
  }, [t]);

  const code = bundle ? toCompactCode(bundle) : '';

  return (
    <Modal onClose={onClose} title={t('contact.shareTitle')}>
      <div className="text-xs text-phosphor-dim mb-4">
        {t('contact.shareDesc')}
      </div>
      {error && <div className="text-crimson text-xs mb-3">{error}</div>}
      {bundle && (
        <div className="flex flex-col items-center gap-4">
          {code ? (
            <div className="bg-white p-3 rounded-lg">
              <QRBoundary fallback={t('contact.qrError')}>
                <QRCodeSVG value={code} size={200} fgColor="#070a07" bgColor="#ffffff" level="L" />
              </QRBoundary>
            </div>
          ) : (
            <div className="text-crimson text-xs">{t('contact.codeError')}</div>
          )}
          {code && <CopyBox label={t('contact.codeLabel')} value={code} />}
          <button
            className="text-phosphor-dim text-xs hover:text-phosphor"
            onClick={() => setShowJson(v => !v)}
          >
            {showJson ? t('common.hide') : t('common.show')} {t('contact.fullData')}
          </button>
          {showJson && <BundleCopy json={bundle} />}
        </div>
      )}
      <button type="button" className="term-button w-full mt-4" onClick={onClose}>
        {t('common.close')}
      </button>
    </Modal>
  );
}

function ChatInfoPanel({
  handle,
  avatar,
  hasSession,
  fingerprint,
  myFingerprint,
  blocked,
  onClose,
  onRenamed,
  onDeleted,
  onBlockChanged,
}: {
  handle: string;
  avatar?: string | null;
  hasSession: boolean;
  fingerprint: string;
  myFingerprint: string;
  blocked: boolean;
  onClose: () => void;
  onRenamed: (newHandle: string) => void;
  onDeleted: () => void;
  onBlockChanged: () => void;
}) {
  const t = useT();
  const closeRef = useRef<HTMLButtonElement>(null);
  const [tab, setTab] = useState<'profile' | 'privacy' | 'security'>('profile');
  const [sas, setSas] = useState('');
  const [note, setNote] = useState(() => localStorage.getItem('note:' + handle) || '');
  const [ttl, setTtl] = useState(() => ttlFor(handle));
  const [verified, setVerified] = useState(
    () => !!fingerprint && localStorage.getItem('verified:' + handle) === fingerprint,
  );
  const [editingName, setEditingName] = useState(false);
  const [newName, setNewName] = useState(handle);
  const [confirmDel, setConfirmDel] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    closeRef.current?.focus();
    return () => {
      window.removeEventListener('keydown', onKey);
      previous?.focus();
    };
  }, [onClose]);

  useEffect(() => {
    emojiSas(fingerprint, myFingerprint).then(setSas);
  }, [fingerprint, myFingerprint]);

  useEffect(() => {
    setVerified(
      !!fingerprint && localStorage.getItem('verified:' + handle) === fingerprint,
    );
  }, [fingerprint, handle]);

  const saveNote = (v: string) => {
    setNote(v);
    localStorage.setItem('note:' + handle, v);
  };

  const migrateLocalValue = (prefix: string, nextHandle: string) => {
    const value = localStorage.getItem(prefix + handle);
    if (value !== null) localStorage.setItem(prefix + nextHandle, value);
    localStorage.removeItem(prefix + handle);
  };

  const rename = async () => {
    const n = newName.trim();
    if (!n || n === handle) {
      setEditingName(false);
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      await api.renameNode(handle, n);
      migrateLocalValue('note:', n);
      migrateLocalValue('ttl:', n);
      migrateLocalValue('verified:', n);
      onRenamed(n);
    } catch {
      setErr(t('chat.renameError'));
      setBusy(false);
    }
  };
  const del = async () => {
    setBusy(true);
    setErr(null);
    try {
      await api.removeNode(handle);
      localStorage.removeItem('note:' + handle);
      localStorage.removeItem('ttl:' + handle);
      localStorage.removeItem('verified:' + handle);
      onDeleted();
    } catch {
      setErr(t('contact.deleteError'));
      setBusy(false);
    }
  };

  const tabs = [
    { id: 'profile' as const, label: t('chat.profile'), icon: UserRound },
    { id: 'privacy' as const, label: t('chat.privacy'), icon: Clock3 },
    { id: 'security' as const, label: t('chat.security'), icon: Fingerprint },
  ];

  return createPortal(
    <div className="chat-info-backdrop" onClick={onClose}>
      <aside
        role="dialog"
        aria-modal="true"
        aria-label={t('chat.info')}
        className="chat-info-panel"
        onClick={event => event.stopPropagation()}
      >
        <header className="chat-info-header">
          <div className="min-w-0">
            <div className="text-sm font-semibold text-ink">{t('chat.info')}</div>
            <div className="mt-0.5 truncate text-[10px] text-ink-muted">
              {hasSession ? t('chat.channelReady') : t('chat.channelPending')}
            </div>
          </div>
          <button
            ref={closeRef}
            className="icon-button"
            onClick={onClose}
            title={t('common.close')}
            type="button"
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="chat-info-identity">
          <Avatar
            src={avatar}
            name={handle}
            size={64}
            status={hasSession ? 'online' : 'offline'}
            statusLabel={hasSession ? t('chat.channelReady') : t('chat.channelPending')}
          />
          <div className="min-w-0 flex-1">
            {editingName ? (
              <div className="flex min-w-0 items-center gap-1.5">
                <input
                  className="term-input h-9 min-w-0 flex-1"
                  value={newName}
                  maxLength={40}
                  onChange={event => setNewName(event.target.value)}
                  onKeyDown={event => {
                    if (event.key === 'Enter') void rename();
                    if (event.key === 'Escape') setEditingName(false);
                  }}
                  autoFocus
                />
                <button
                  className="icon-button icon-button--accent"
                  disabled={busy}
                  onClick={() => void rename()}
                  title={t('common.save')}
                  type="button"
                >
                  {busy ? (
                    <LoaderCircle className="h-4 w-4 animate-spin" />
                  ) : (
                    <Check className="h-4 w-4" />
                  )}
                </button>
                <button
                  className="icon-button"
                  disabled={busy}
                  onClick={() => setEditingName(false)}
                  title={t('common.cancel')}
                  type="button"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            ) : (
              <button
                className="chat-info-name"
                onClick={() => {
                  setNewName(handle);
                  setEditingName(true);
                }}
                title={t('chat.rename')}
                type="button"
              >
                <span className="truncate">{handle}</span>
                <Pencil className="h-3.5 w-3.5 shrink-0" />
              </button>
            )}
            <div className="mt-1 flex items-center gap-1.5 text-[10px] text-ink-muted">
              <IconShield className={hasSession ? 'h-3 w-3 text-phosphor' : 'h-3 w-3'} />
              <span>{hasSession ? t('chat.session') : t('chat.noSession')}</span>
            </div>
          </div>
        </div>

        <div className="chat-info-tabs" role="tablist" aria-label={t('chat.info')}>
          {tabs.map(item => {
            const TabIcon = item.icon;
            return (
              <button
                key={item.id}
                className={`chat-info-tab ${tab === item.id ? 'chat-info-tab--active' : ''}`}
                role="tab"
                aria-selected={tab === item.id}
                onClick={() => setTab(item.id)}
                type="button"
              >
                <TabIcon className="h-3.5 w-3.5" />
                <span>{item.label}</span>
              </button>
            );
          })}
        </div>

        <div className="chat-info-body">
          {err && (
            <div className="chat-info-error" role="alert">
              {err}
            </div>
          )}

          {tab === 'profile' && (
            <section className="chat-info-section" role="tabpanel">
              <label className="chat-info-label" htmlFor="chat-private-note">
                {t('chat.note')}
              </label>
              <textarea
                id="chat-private-note"
                className="term-input mt-2 min-h-28 w-full resize-y text-sm"
                value={note}
                maxLength={500}
                onChange={event => saveNote(event.target.value)}
                placeholder={t('chat.notePlaceholder')}
              />
              <div className="chat-info-help">{t('chat.localNoteHelp')}</div>
            </section>
          )}

          {tab === 'privacy' && (
            <div role="tabpanel">
              <section className="chat-info-section">
                <label className="chat-info-label" htmlFor="chat-message-ttl">
                  {t('chat.disappearingMessages')}
                </label>
                <select
                  id="chat-message-ttl"
                  className="term-input mt-2 w-full text-sm"
                  value={ttl}
                  onChange={event => {
                    const value = Number(event.target.value);
                    setTtl(value);
                    if (value > 0) localStorage.setItem('ttl:' + handle, String(value));
                    else localStorage.removeItem('ttl:' + handle);
                  }}
                >
                  {TTL_OPTIONS.map(option => (
                    <option key={option.v} value={option.v}>
                      {t(option.key)}
                    </option>
                  ))}
                </select>
                <div className="chat-info-help">
                  {ttl > 0 ? t('chat.disappearingOn') : t('chat.disappearingOff')}
                </div>
              </section>

              <section className="chat-info-section chat-info-section--divided">
                <div className="chat-info-action-row">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 text-xs text-ink">
                      <Ban className={`h-4 w-4 ${blocked ? 'text-crimson' : 'text-ink-muted'}`} />
                      <span>{blocked ? t('contact.unblock') : t('contact.block')}</span>
                    </div>
                    <div className="chat-info-help">
                      {blocked ? t('contact.blockedHelp') : t('contact.blockHelp')}
                    </div>
                  </div>
                  <button
                    className="term-button shrink-0 px-3 text-xs"
                    disabled={busy}
                    onClick={async () => {
                      setBusy(true);
                      setErr(null);
                      try {
                        await api.blockNode(handle, !blocked);
                        onBlockChanged();
                      } catch {
                        setErr(t('contact.blockError'));
                      } finally {
                        setBusy(false);
                      }
                    }}
                    type="button"
                  >
                    {blocked ? t('contact.unblock') : t('contact.block')}
                  </button>
                </div>
              </section>

              <section className="chat-info-section chat-info-danger">
                {!confirmDel ? (
                  <button
                    className="chat-info-danger-button"
                    onClick={() => setConfirmDel(true)}
                    type="button"
                  >
                    <Trash2 className="h-4 w-4" />
                    {t('contact.delete')}
                  </button>
                ) : (
                  <div>
                    <div className="text-xs leading-relaxed text-crimson">
                      {t('contact.deleteConfirm')} {handle}? {t('contact.deleteConsequence')}
                    </div>
                    <div className="mt-3 flex justify-end gap-2">
                      <button
                        className="term-button px-3 text-xs"
                        disabled={busy}
                        onClick={() => setConfirmDel(false)}
                        type="button"
                      >
                        {t('common.cancel')}
                      </button>
                      <button
                        className="chat-info-danger-confirm"
                        disabled={busy}
                        onClick={() => void del()}
                        type="button"
                      >
                        {busy && <LoaderCircle className="h-3.5 w-3.5 animate-spin" />}
                        {t('contact.delete')}
                      </button>
                    </div>
                  </div>
                )}
              </section>
            </div>
          )}

          {tab === 'security' && (
            <div role="tabpanel">
              <section className="chat-info-security-state">
                <div
                  className={`chat-info-security-icon ${
                    verified ? 'chat-info-security-icon--verified' : ''
                  }`}
                >
                  {verified ? (
                    <ShieldCheck className="h-5 w-5" />
                  ) : (
                    <ShieldQuestion className="h-5 w-5" />
                  )}
                </div>
                <div className="min-w-0">
                  <div className="text-sm font-semibold text-ink">
                    {verified ? t('chat.verified') : t('chat.unverified')}
                  </div>
                  <div className="mt-1 text-[11px] leading-relaxed text-ink-muted">
                    {hasSession ? t('chat.channelReady') : t('chat.channelPending')}
                  </div>
                </div>
              </section>

              <section className="chat-info-sas">
                <div className="chat-info-label">{t('chat.verificationCode')}</div>
                <div className="chat-info-sas-code" aria-label={t('chat.verificationCode')}>
                  {sas || '...'}
                </div>
                <div className="text-center text-[11px] leading-relaxed text-ink-muted">
                  {t('chat.verifyWith')} <span className="text-ink">{handle}</span>.{' '}
                  {t('chat.verifyHelp')}
                </div>
                <button
                  className={verified ? 'chat-info-verify-reset' : 'chat-info-verify'}
                  disabled={!sas}
                  onClick={() => {
                    if (verified) {
                      localStorage.removeItem('verified:' + handle);
                      setVerified(false);
                    } else {
                      localStorage.setItem('verified:' + handle, fingerprint);
                      setVerified(true);
                    }
                  }}
                  type="button"
                >
                  {verified ? (
                    <ShieldQuestion className="h-4 w-4" />
                  ) : (
                    <ShieldCheck className="h-4 w-4" />
                  )}
                  {verified ? t('chat.clearVerification') : t('chat.markVerified')}
                </button>
              </section>

              <details className="chat-info-technical">
                <summary>
                  <span className="flex items-center gap-2">
                    <Fingerprint className="h-4 w-4" />
                    {t('chat.technicalDetails')}
                  </span>
                  <ChevronDown className="chat-info-technical-chevron h-4 w-4" />
                </summary>
                <div className="mt-4 space-y-4">
                  <div>
                    <div className="chat-info-label">{t('chat.contactFingerprint')}</div>
                    <code className="chat-info-fingerprint">{fingerprint || '...'}</code>
                  </div>
                  <div>
                    <div className="chat-info-label">{t('chat.yourFingerprint')}</div>
                    <code className="chat-info-fingerprint">{myFingerprint || '...'}</code>
                  </div>
                </div>
              </details>
            </div>
          )}
        </div>
      </aside>
    </div>,
    document.body,
  );
}

function ForwardModal({
  nodes,
  groups,
  onClose,
  onPick,
}: {
  nodes: NodeInfo[];
  groups: GroupInfo[];
  onClose: () => void;
  onPick: (targetId: string, isGroup: boolean) => void;
}) {
  const t = useT();
  return (
    <Modal onClose={onClose} title={t('message.forwardTo')}>
      <div className="space-y-1 max-h-72 overflow-y-auto">
        {nodes.map(n => (
          <button
            key={'n' + n.handle}
            className="w-full flex items-center gap-2 px-2 py-2 hover:bg-bg-line rounded text-left"
            onClick={() => onPick(n.handle, false)}
          >
            <Avatar src={n.avatar} name={n.handle} size={28} />
            <span className="text-phosphor">{n.handle}</span>
          </button>
        ))}
        {groups.map(g => (
          <button
            key={'g' + g.gid}
            className="w-full flex items-center gap-2 px-2 py-2 hover:bg-bg-line rounded text-left"
            onClick={() => onPick(g.gid, true)}
          >
            <span className="text-cyan text-lg">#</span>
            <span className="text-phosphor">{g.name}</span>
          </button>
        ))}
        {nodes.length === 0 && groups.length === 0 && (
          <div className="text-phosphor-dim text-sm p-2">{t('message.noForwardTargets')}</div>
        )}
      </div>
    </Modal>
  );
}

interface RelayEvt {
  id: string;
  from: string;
  to: string;
  size: number;
  time: string;
  mineFrom: boolean;
  mineTo: boolean;
}
function RelayInspector({ onClose }: { onClose: () => void }) {
  const t = useT();
  const [events, setEvents] = useState<RelayEvt[]>([]);
  const [statusKey, setStatusKey] = useState('inspector.connecting');
  const [myPub, setMyPub] = useState('');
  const [relays, setRelays] = useState<string[]>([]);
  useEffect(() => {
    // The observation happens in Rust, over the relays this device is actually
    // connected to. Opening a WebSocket here would only ever see whatever host
    // the CSP happens to allow, which is not the same thing.
    let mine = '';
    let unlisten: (() => void) | undefined;
    let cancelled = false;

    (async () => {
      try {
        const profile = await api.getProfile();
        mine = profile.nostr_pub || '';
        if (!cancelled) setMyPub(mine);
      } catch {
        /* the inspector still works without highlighting our own key */
      }

      try {
        unlisten = await onRelayEvent(obs => {
          setEvents(prev =>
            [
              {
                id: obs.id,
                from: obs.from.slice(0, 12),
                to: obs.to ? obs.to.slice(0, 12) : '——',
                size: obs.size,
                time: new Date(obs.created_at * 1000).toLocaleTimeString(),
                mineFrom: !!mine && obs.from === mine,
                mineTo: !!mine && obs.to === mine,
              },
              ...prev.filter(e => e.id !== obs.id),
            ].slice(0, 80),
          );
        });

        const connected = await api.relayInspectStart();
        if (cancelled) return;
        setRelays(connected);
        setStatusKey('inspector.connected');
      } catch {
        if (!cancelled) setStatusKey('inspector.connectionError');
      }
    })();

    return () => {
      cancelled = true;
      unlisten?.();
      void api.relayInspectStop();
    };
  }, []);

  const label = (pub: string, mine: boolean) =>
    mine ? <span className="text-magenta font-bold">{t('message.you').toUpperCase()}</span> : <span>{pub}…</span>;

  return (
    <Modal onClose={onClose} title={t('inspector.title')}>
      <div className="text-xs text-phosphor-dim mb-2">{t(statusKey)}</div>
      <div className="border border-bg-line bg-bg-deep rounded p-2 text-[11px] leading-relaxed mb-3">
        {t('inspector.description')}
      </div>
      {relays.length > 0 && (
        <div className="text-phosphor-dim text-[10px] font-mono mb-2">
          {t('inspector.relays')}: {relays.join(' · ')}
        </div>
      )}
      <div className="max-h-80 overflow-y-auto font-mono text-[11px] space-y-0.5">
        {events.length === 0 ? (
          <div className="text-phosphor-dim p-2">{t('inspector.waiting')}</div>
        ) : (
          events.map(ev => (
            <div
              key={ev.id}
              className={`flex items-center gap-2 px-1 py-0.5 rounded ${
                ev.mineFrom || ev.mineTo ? 'bg-phosphor/5' : ''
              }`}
            >
              <span className="text-phosphor-dim shrink-0">{ev.time}</span>
              <span className="shrink-0">🔒</span>
              <span className="text-cyan truncate">{label(ev.from, ev.mineFrom)}</span>
              <span className="text-crimson shrink-0">→</span>
              <span className="text-cyan truncate">{label(ev.to, ev.mineTo)}</span>
              <span className="text-phosphor-dim shrink-0 ml-auto">
                {ev.size} B {t('inspector.encrypted')}
              </span>
            </div>
          ))
        )}
      </div>
      <div className="text-phosphor-dim text-[10px] mt-2">
        {myPub ? `${t('inspector.yourKey')}: ${myPub.slice(0, 16)}…` : ''}
      </div>
    </Modal>
  );
}

function Modal({
  onClose,
  title,
  children,
}: {
  onClose: () => void;
  title: string;
  children: React.ReactNode;
}) {
  const t = useT();
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    closeRef.current?.focus();
    return () => {
      window.removeEventListener('keydown', onKey);
      previous?.focus();
    };
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-bg-deep/85 p-4 backdrop-blur-md sm:p-6"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="modal-panel max-h-[86vh] w-full max-w-xl overflow-y-auto"
        onClick={e => e.stopPropagation()}
      >
        <div className="modal-header">
          <div className="min-w-0">
            <div className="text-[9px] uppercase tracking-[0.14em] text-phosphor-dim">
              TRINO://PANEL
            </div>
            <div className="mt-1 truncate text-sm font-semibold text-ink">{title}</div>
          </div>
          <button
            ref={closeRef}
            className="icon-button"
            onClick={onClose}
            title={t('common.close')}
            type="button"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="p-4 sm:p-5">{children}</div>
      </div>
    </div>
  );
}

// Compact shareable code: `trino1:<base64url(bundle without avatar)>`.
// The avatar is dropped so the code stays small enough to fit in a QR.
function b64urlEncode(str: string): string {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlDecode(s: string): string {
  let b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  while (b64.length % 4) b64 += '=';
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

function toCompactCode(bundleJson: string): string {
  try {
    const obj = JSON.parse(bundleJson);
    delete obj.avatar;
    return 'trino1:' + b64urlEncode(JSON.stringify(obj));
  } catch {
    return '';
  }
}

function fromCompactCode(input: string): string | null {
  const raw = input.trim();
  if (!raw.startsWith('trino1:')) return null;
  try {
    return b64urlDecode(raw.slice(7));
  } catch {
    return null;
  }
}

// Emoji safety number (SAS) for a chat: hash of both identity fingerprints,
// order-independent so both peers see the same emojis. If they match, no MITM.
const SAS_SET = [
  '🐛', '🔑', '🔒', '🛰', '🦠', '💾', '🖥', '📡', '🧬', '⚡', '🔥', '🌐', '🧠', '👾', '🛡', '🗝',
  '📟', '🔌', '🧩', '🎛', '🚀', '⭐', '🌙', '🎧', '📀', '🧿', '🔭', '🕹', '💿', '📼', '🧫', '🔬',
  '🦅', '🐉', '🌵', '🍄', '🎯', '🧨', '💣', '🕵', '🔦', '📎', '🧷', '⛓', '🪝', '🧲', '⚙', '🪫',
  '🛸', '🌀', '❄', '🌊', '🎲', '♟', '🧭', '⏳', '📮', '🔗', '💊', '🩸', '🦂', '🕷', '🐙', '🦑',
];
async function emojiSas(a: string, b: string, n = 6): Promise<string> {
  if (!a || !b) return '';
  const joined = [a, b].sort().join('|');
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(joined));
  const bytes = new Uint8Array(digest);
  return Array.from({ length: n }, (_, i) => SAS_SET[bytes[i]! % SAS_SET.length]).join(' ');
}

function formatTime(ts: number): string {
  const d = new Date(ts * 1000);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export default App;
