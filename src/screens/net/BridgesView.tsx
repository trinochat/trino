/**
 * "Otra forma de conectarse" (PropTorSimple, card 4; PropTor card 4 for
 * what goes under "Opciones avanzadas"; Tor design §5.2, §5.3, §10.2; TOR-8).
 *
 * - One main action: "Buscar una forma que funcione aquí", the search of
 *   bridge-search.ts (the built-in ways in the backend's order, Snowflake
 *   then obfs4). Its line says what it does, in plain words. It is not the
 *   mockup's moat query ("Trino le pregunta al Proyecto Tor…"): moat is not
 *   built, its query needs an authorization of its own, so the text does
 *   not promise it.
 * - "Opciones avanzadas", closed: Automático (no bridge; the search is
 *   offered when Tor does not connect), the built-in ways with the line
 *   that they are known and do not hide Tor, and "Tengo un código de
 *   conexión que me dieron": a paste box checked line by line as it is typed
 *   (`net_bridges_check`, which keeps nothing), kept sealed in the store by
 *   "Usar este código" (`net_bridges_set`), with the honest line about the
 *   working copy and the trace it can leave. The text leaves the screen
 *   once kept.
 * - Before Snowflake (chosen or tried), the line that Windows may ask about
 *   a program of Trino (R-22).
 *
 * `BridgesPanel` is the card's body, shared with the first run's "Conexión"
 * step (ConnectionStep), which decides on "Continuar"; `BridgesView` is
 * Ajustes › Privacidad › Conexión's, where every choice is kept at once and
 * Tor starts again with it.
 */
import { ArrowLeft } from 'lucide-react';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { useT, type TFunction } from '../../lib/i18n';
import type { BridgeChoice, BridgeLineError, BridgesChecked, BridgesInfo, BridgesSet, TransportKind } from '../../lib/net';
import { Button, Field, IconButton, iconSize, RadioCardGroup, Textarea, type RadioCardOption } from '../../ui';
import { ErrorLine } from '../settings/ErrorLine';
import { SettingsSection } from '../settings/SettingsSection';
import { Advanced } from './Advanced';
import type { SearchState } from './bridge-search';
import type { NetScreensApi } from './net-api';
import { useBridgeSearch } from './useBridgeSearch';

/** The ways of "Opciones avanzadas": Automático, a built-in kind, or a code someone gave you. */
export type BridgeWay = 'auto' | 'code' | TransportKind;

/** The way in use, from what the backend says. */
export function wayOf(info: BridgesInfo): BridgeWay {
  if (info.private === true) return 'code';
  return info.transport === 'none' ? 'auto' : info.transport;
}

/** The short name of a way, for the row of Ajustes and the first run. */
export function wayName(t: TFunction, way: BridgeWay | 'search'): string {
  switch (way) {
    case 'auto':
      return t('net.bridges.short.auto');
    case 'code':
      return t('net.bridges.short.code');
    case 'search':
      return t('net.bridges.short.search');
    default:
      return TRANSPORT_NAMES[way];
  }
}

/** The names of the ways: technical names, the same in every language. */
const TRANSPORT_NAMES: Record<TransportKind, string> = {
  none: 'Tor',
  snowflake: 'Snowflake',
  obfs4: 'obfs4',
  webtunnel: 'WebTunnel',
  meek: 'meek',
};

/** A pasted line that is not a bridge, in words. */
function lineErrorText(t: TFunction, { line, error }: BridgeLineError): string {
  if (line === 0) return t(error === 'tooMany' ? 'net.bridges.err.tooMany' : 'net.bridges.err.empty');
  // A line that is only the word "Bridge" is not a code Trino knows either.
  const kind = error === 'empty' || error === 'tooMany' ? 'unknownTransport' : error;
  return t(`net.bridges.err.${kind}`, { n: line });
}

/** How long typing pauses before the paste box is checked. */
const CHECK_PAUSE_MS = 250;

export interface BridgesPanelProps {
  /** The way checked under "Opciones avanzadas": in use, or chosen in the first run; null for none. */
  way: BridgeWay | null;
  /** The built-in kinds, in the order the search tries them. */
  builtin: readonly TransportKind[];
  /** Whether this build has the bridge program: without it there is no other way. */
  program: boolean;
  /** Whether a code someone gave you is in use: the search does not go over it. */
  codeInUse: boolean;
  search: SearchState;
  onSearch(): void;
  /** Automático or a built-in way. */
  onPick(way: 'auto' | TransportKind): void;
  /** "Usar este código": what the backend said. */
  onCode(text: string): Promise<Pick<BridgesSet, 'saved' | 'errors'>>;
  /** Check what is typed, keeping nothing. */
  check(text: string): Promise<BridgesChecked>;
  busy?: boolean;
  /** A choice could not be kept. */
  error?: ReactNode;
}

export function BridgesPanel({
  way,
  builtin,
  program,
  codeInUse,
  search,
  onSearch,
  onPick,
  onCode,
  check,
  busy = false,
  error,
}: BridgesPanelProps) {
  const t = useT();
  const searchBodyId = useId();
  // "Tengo un código…" is shown at once; it is kept only with its lines.
  const [codeOpen, setCodeOpen] = useState(false);
  const [text, setText] = useState('');
  const [errors, setErrors] = useState<BridgeLineError[]>([]);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);
  const checking = useRef(0);

  // Checked after a pause in typing; an answer to older text counts for nothing.
  useEffect(() => {
    const asked = ++checking.current;
    if (!text.trim()) {
      setErrors([]);
      return;
    }
    const timer = setTimeout(() => {
      check(text).then(
        result => {
          if (asked === checking.current) setErrors(result.errors);
        },
        failure => console.error('net_bridges_check failed', failure),
      );
    }, CHECK_PAUSE_MS);
    return () => clearTimeout(timer);
  }, [text, check]);

  const shown: BridgeWay | null = codeOpen ? 'code' : way;
  const trying = search.phase === 'trying';
  const snowflake = (trying && search.transport === 'snowflake') || shown === 'snowflake';

  const pick = (next: BridgeWay) => {
    setSaved(false);
    if (next === 'code') {
      setCodeOpen(true);
      return;
    }
    setCodeOpen(false);
    setText('');
    if (next !== way) onPick(next);
  };

  const keepCode = async () => {
    setSaving(true);
    setSaved(false);
    setSaveFailed(false);
    try {
      const answer = await onCode(text);
      checking.current += 1;
      if (answer.saved) {
        setText('');
        setErrors([]);
        setSaved(true);
      } else {
        setErrors(answer.errors);
      }
    } catch (failure) {
      console.error('the connection code was not kept', failure);
      setSaveFailed(true);
    } finally {
      setSaving(false);
    }
  };

  if (!program) {
    return <p className="m-0 text-ui-base leading-normal text-ui-ink">{t('net.bridges.noProgram')}</p>;
  }

  const options: RadioCardOption<BridgeWay>[] = [
    { value: 'auto', label: t('net.bridges.auto') },
    ...builtin.map(kind => ({ value: kind, label: t('net.bridges.builtin', { name: TRANSPORT_NAMES[kind] }) })),
    { value: 'code', label: t('net.bridges.code') },
  ];

  return (
    <>
      <p className="m-0 text-ui-base leading-normal text-ui-ink">{t('net.bridges.intro')}</p>
      {codeInUse ? (
        <p className="m-0 text-ui-md leading-normal text-ui-muted">{t('net.bridges.withCode')}</p>
      ) : (
        <div className="flex flex-col gap-2">
          <Button variant="primary" size="lg" aria-describedby={searchBodyId} disabled={trying || busy} onClick={onSearch}>
            {t('net.bridges.search')}
          </Button>
          <p id={searchBodyId} className="m-0 text-ui-md leading-normal text-ui-muted">
            {t('net.bridges.searchBody')}
          </p>
          <SearchLine search={search} />
          {trying && search.transport === 'snowflake' ? (
            <p className="m-0 text-ui-md leading-normal text-ui-muted">{t('net.failed.tryingNote')}</p>
          ) : null}
        </div>
      )}
      {error ? <ErrorLine>{error}</ErrorLine> : null}
      <div className="flex flex-col gap-2.5 border-t border-ui-line pt-3">
        <Advanced>
          <RadioCardGroup aria-label={t('net.bridges.group')} options={options} value={shown} onValueChange={pick} />
          {shown === 'auto' ? <p className="m-0 text-ui-md leading-normal text-ui-muted">{t('net.bridges.autoBody')}</p> : null}
          {shown !== null && shown !== 'auto' && shown !== 'code' ? (
            <p className="m-0 text-ui-md leading-normal text-ui-muted">{t('net.bridges.builtinBody')}</p>
          ) : null}
          {snowflake && !trying ? (
            <p className="m-0 text-ui-md leading-normal text-ui-muted">{t('net.failed.tryingNote')}</p>
          ) : null}
          {shown === 'code' ? (
            <div className="flex flex-col gap-2.5">
              {codeInUse ? <p className="m-0 text-ui-md leading-normal text-ui-muted">{t('net.bridges.codeInUse')}</p> : null}
              <Field
                label={t('net.bridges.codeLabel')}
                hint={t('net.bridges.codeHint')}
                error={
                  errors.length > 0 ? (
                    <>
                      {errors.map(lineError => (
                        <span key={`${lineError.line}-${lineError.error}`} className="block">
                          {lineErrorText(t, lineError)}
                        </span>
                      ))}
                    </>
                  ) : undefined
                }
              >
                <Textarea
                  mono
                  minRows={2}
                  maxRows={8}
                  spellCheck={false}
                  autoComplete="off"
                  value={text}
                  onChange={event => {
                    setSaved(false);
                    setText(event.target.value);
                  }}
                />
              </Field>
              <Button
                className="self-start"
                loading={saving}
                disabled={!text.trim() || busy}
                onClick={() => void keepCode()}
              >
                {t('net.bridges.codeSave')}
              </Button>
            </div>
          ) : null}
          {saveFailed ? <ErrorLine>{t('net.settings.errSave')}</ErrorLine> : null}
          {saved ? (
            <p role="status" className="m-0 text-ui-md font-semibold text-ui-ink">
              {t('net.bridges.codeSaved')}
            </p>
          ) : null}
        </Advanced>
      </div>
    </>
  );
}

/** How the search goes, read out: one line, nothing while it has not run. */
function SearchLine({ search }: { search: SearchState }) {
  const t = useT();
  const text =
    search.phase === 'trying'
      ? t('net.bridges.trying', { step: search.step, total: search.of })
      : search.phase === 'found'
        ? t('net.bridges.found')
        : search.phase === 'none'
          ? t('net.bridges.none')
          : null;
  if (search.phase === 'failed') return <ErrorLine>{t('net.failed.error')}</ErrorLine>;
  if (!text) return null;
  return (
    <p role="status" className="m-0 text-ui-base font-semibold leading-normal text-ui-ink">
      {text}
    </p>
  );
}

export interface BridgesViewProps {
  api: Pick<NetScreensApi, 'bridges' | 'setBridges' | 'checkBridges' | 'tryBridge' | 'onNetChanged'>;
  /** "Volver a Conexión". */
  onBack(): void;
}

/** Card 4 in Ajustes › Privacidad › Conexión: each choice kept at once. */
export function BridgesView({ api, onBack }: BridgesViewProps) {
  const t = useT();
  const [info, setInfo] = useState<BridgesInfo | null>(null);
  const [search, searcher] = useBridgeSearch(api);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  const refresh = () =>
    api.bridges().then(
      next => setInfo(next),
      failure => console.error('net_bridges_get failed', failure),
    );

  useEffect(() => {
    void refresh();
  }, [api]);

  // What the search found is kept by the backend: show it as the way in use.
  useEffect(() => {
    if (search.phase === 'found') void refresh();
  }, [search.phase]);

  const keep = async (choice: BridgeChoice): Promise<BridgesSet> => {
    searcher.cancel();
    setBusy(true);
    setFailed(false);
    try {
      const answer = await api.setBridges(choice);
      if (answer.saved) await refresh();
      return answer;
    } finally {
      setBusy(false);
    }
  };

  const onPick = (way: 'auto' | TransportKind) => {
    const choice: BridgeChoice = way === 'auto' ? { kind: 'none' } : { kind: 'builtin', transport: way };
    keep(choice).catch(failure => {
      console.error('net_bridges_set failed', failure);
      setFailed(true);
    });
  };

  return (
    <SettingsSection
      autoFocus
      title={t('net.bridges.title')}
      before={<IconButton aria-label={t('net.seen.back')} icon={<ArrowLeft {...iconSize('lg')} />} onClick={onBack} />}
    >
      {info ? (
        <BridgesPanel
          way={wayOf(info)}
          builtin={info.builtin}
          program={info.program}
          codeInUse={info.private === true}
          search={search}
          onSearch={() => {
            setFailed(false);
            void searcher.start();
          }}
          onPick={onPick}
          onCode={text => keep({ kind: 'private', text })}
          check={api.checkBridges}
          busy={busy}
          error={failed ? t('net.settings.errSave') : undefined}
        />
      ) : null}
    </SettingsSection>
  );
}
