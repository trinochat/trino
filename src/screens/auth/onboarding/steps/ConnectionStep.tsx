/**
 * The "Conexión" step (PropTorSimple, card 1; Tor design §9.2, TOR-6):
 * Tor explained once, in plain words, and the option for whoever must not
 * be seen using Trino: "No quiero que mi proveedor note que uso Trino",
 * which starts Tor through a built-in bridge, with its cost in one line.
 * Off by default: most people need no bridge, and it makes the first
 * connection take a minute or two. Tor starts only from this step's
 * "Continuar" (OnboardingFlow), never before.
 *
 * With the bridges' commands (TOR-8), "En mi red bloquean Tor" opens card 4
 * in the step: "Buscar una forma que funcione aquí", which starts the search
 * at once and goes on, and under "Opciones avanzadas" the ways and the code
 * someone gave you. A way chosen there is what "Continuar" starts, and the
 * option shows ticked for it, with the way named under it when it is not
 * the option's own (Snowflake). Only a pasted code reaches the backend
 * before "Continuar", to be checked and held in memory; nothing connects.
 */
import { ArrowLeft } from 'lucide-react';
import { useEffect, useState, type Ref } from 'react';
import { useT } from '../../../../lib/i18n';
import type { BridgesInfo, FirstWay } from '../../../../lib/net';
import { Checkbox, cx, FOCUS_RING, IconButton, iconSize } from '../../../../ui';
import { BridgesPanel, wayName, type BridgeWay } from '../../../net/BridgesView';
import type { SearchState } from '../../../net/bridge-search';
import type { FirstRunBridgesApi } from '../../../types';
import { InlineError } from '../../common/InlineError';
import { HIDDEN_TRANSPORT, hiddenOf, type OnboardingEvent, type OnboardingState } from '../onboarding-machine';
import { StepHeader } from './StepHeader';

export interface ConnectionStepProps {
  state: OnboardingState;
  send(event: OnboardingEvent): void;
  headingId: string;
  headingRef: Ref<HTMLHeadingElement>;
  stepErrorRef: Ref<HTMLDivElement>;
  /** Card 4's commands; without them there is no "En mi red bloquean Tor". */
  bridges?: FirstRunBridgesApi;
}

/** The way of card 4 that shows checked for the step's choice; none for the search. */
function panelWay(way: FirstWay): BridgeWay | null {
  switch (way.kind) {
    case 'none':
      return 'auto';
    case 'builtin':
      return way.transport;
    case 'private':
      return 'code';
    case 'search':
      return null;
  }
}

/** The step does not run the search: it starts on its own "Continuar". */
const NOT_SEARCHING: SearchState = { phase: 'idle' };

export function ConnectionStep({ state, send, headingId, headingRef, stepErrorRef, bridges }: ConnectionStepProps) {
  const t = useT();
  const [info, setInfo] = useState<BridgesInfo | null>(null);

  useEffect(() => {
    if (!bridges || !state.bridges) return;
    let active = true;
    bridges.info().then(
      next => active && setInfo(next),
      error => console.error('net_bridges_get failed', error),
    );
    return () => {
      active = false;
    };
  }, [bridges, state.bridges]);

  const error =
    state.error?.field === 'step' ? (
      // It takes the focus, so it is read where the person is, but it is not a Tab stop.
      <div ref={stepErrorRef} tabIndex={-1} className="outline-none">
        <InlineError>{t(state.error.key)}</InlineError>
      </div>
    ) : null;

  if (bridges && state.bridges) {
    return (
      <div className="flex flex-col gap-[1.125rem]">
        <div className="flex min-w-0 items-center gap-2">
          <IconButton
            aria-label={t('net.bridges.back')}
            icon={<ArrowLeft {...iconSize('lg')} />}
            onClick={() => send({ type: 'closeBridges' })}
          />
          <StepHeader ref={headingRef} id={headingId} title={t('net.bridges.title')} />
        </div>
        {info ? (
          <BridgesPanel
            way={panelWay(state.way)}
            builtin={info.builtin}
            program={info.program}
            codeInUse={state.way.kind === 'private'}
            search={NOT_SEARCHING}
            busy={state.busy !== null}
            onSearch={() => send({ type: 'search' })}
            onPick={way =>
              send({ type: 'setWay', way: way === 'auto' ? { kind: 'none' } : { kind: 'builtin', transport: way } })
            }
            onCode={async text => {
              const answer = await bridges.keepCode(text);
              if (answer.saved) send({ type: 'setWay', way: { kind: 'private' } });
              return answer;
            }}
            check={bridges.check}
          />
        ) : null}
        {error}
      </div>
    );
  }

  // The way, named under the option, when it is not the option's own.
  const named =
    state.way.kind === 'builtin'
      ? state.way.transport === HIDDEN_TRANSPORT
        ? null
        : wayName(t, state.way.transport)
      : state.way.kind === 'private'
        ? wayName(t, 'code')
        : state.way.kind === 'search'
          ? wayName(t, 'search')
          : null;

  return (
    <div className="flex flex-col gap-[1.125rem]">
      <StepHeader ref={headingRef} id={headingId} title={t('net.welcome.title')} body={t('net.welcome.body')} />
      <div className="flex flex-col gap-1.5">
        <Checkbox
          className="rounded-ui-lg border border-ui-line px-3.5"
          label={t('net.welcome.hidden')}
          description={t('net.welcome.hiddenBody')}
          checked={hiddenOf(state)}
          disabled={state.busy !== null}
          onChange={event => send({ type: 'setHidden', checked: event.target.checked })}
        />
        {named ? <p className="m-0 px-1 text-ui-md text-ui-muted">{t('net.welcome.way', { way: named })}</p> : null}
      </div>
      {bridges ? (
        <button
          type="button"
          disabled={state.busy !== null}
          onClick={() => send({ type: 'openBridges' })}
          className={cx(
            'inline-flex min-h-11 items-center self-center rounded-ui px-2 font-ui text-ui-base font-semibold text-ui-accent-text hover:underline disabled:opacity-60',
            FOCUS_RING,
          )}
        >
          {t('net.welcome.blocked')}
        </button>
      ) : null}
      {error}
    </div>
  );
}
