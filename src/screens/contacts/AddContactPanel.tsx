/**
 * "Agregar" in Contacts (Contacts:54-80): paste the other person's code and
 * see who it is before adding them. The backend checks the code's
 * signatures without saving anything (preview_contact), so "Código válido"
 * means checked. A contact is never overwritten: one with the same name and
 * other keys is replaced only after an explicit yes, and a contact with the
 * same keys and name only gets this code in place of its old one. There is
 * no camera button (plan §1.3: no QR scanning on the desktop in this batch).
 */
import { useEffect, useId, useLayoutEffect, useReducer, useRef, useState } from 'react';
import { CircleAlert } from 'lucide-react';
import { Avatar, Banner, Button, Checkbox, Field, Input, Textarea, iconSize, type BannerTone } from '../../ui';
import { isCommandError } from '../../lib/api';
import { formatFingerprint } from '../../lib/contact-code';
import { useT } from '../../lib/i18n';
import { identityInitials } from '../../lib/initials';
import {
  ADD_CONTACT_IDLE,
  addContactReducer,
  addFailureOf,
  addRequest,
  conflictOf,
  type AddConflict,
  type AddContactCard,
  type AddContactState,
} from './add-contact-state';
import type { ContactsApi } from './contacts-api';
import { CARD, ERROR_LINE, LABEL, MONO_KEY } from './styles';

export interface AddContactPanelProps {
  api: Pick<ContactsApi, 'previewContact' | 'probeNode'>;
  /** The contact was saved under this name. */
  onContactAdded(handle: string): void;
}

export function AddContactPanel({ api, onContactAdded }: AddContactPanelProps) {
  const t = useT();
  const codeId = useId();
  const errorId = useId();
  const [text, setText] = useState('');
  const [state, dispatch] = useReducer(addContactReducer, ADD_CONTACT_IDLE);

  const apiRef = useRef(api);
  useLayoutEffect(() => {
    apiRef.current = api;
  });

  // Check the pasted code once per bundle; a late answer for another one is dropped by the reducer.
  const checking = state.kind === 'checking' ? state.bundleJson : null;
  useEffect(() => {
    if (checking === null) return;
    apiRef.current.previewContact(checking).then(
      preview => dispatch({ type: 'previewed', bundleJson: checking, preview }),
      (error: unknown) =>
        dispatch({
          type: 'previewFailed',
          bundleJson: checking,
          invalid: isCommandError(error) && error.code === 'invalid_code',
        }),
    );
  }, [checking]);

  const onText = (value: string) => {
    setText(value);
    dispatch({ type: 'input', text: value });
  };

  const submit = () => {
    const request = addRequest(state);
    if (!request) return;
    dispatch({ type: 'submit' });
    api.probeNode(request.bundleJson, request.handle, request.replaceExisting).then(
      node => {
        dispatch({ type: 'added', handle: node.handle });
        setText('');
        onContactAdded(node.handle);
      },
      (error: unknown) => dispatch({ type: 'addFailed', error: addFailureOf(error) }),
    );
  };

  const reset = () => {
    setText('');
    dispatch({ type: 'reset' });
  };

  const invalid = state.kind === 'invalid';
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <label htmlFor={codeId} className="font-ui text-ui-base font-semibold text-ui-ink">
          {t('contacts.add.codeLabel')}
        </label>
        <Textarea
          id={codeId}
          mono
          minRows={2}
          maxRows={5}
          value={text}
          onChange={event => onText(event.target.value)}
          readOnly={state.kind === 'adding'}
          spellCheck={false}
          autoComplete="off"
          aria-invalid={invalid || undefined}
          aria-describedby={invalid ? errorId : undefined}
          className="text-ui-md [overflow-wrap:anywhere]"
        />
      </div>

      {invalid && (
        <p id={errorId} role="alert" className={ERROR_LINE}>
          <CircleAlert {...iconSize('md', 'mt-0.5 shrink-0')} aria-hidden="true" />
          <span>{t('contacts.add.invalid')}</span>
        </p>
      )}
      {state.kind === 'checking' && (
        <p role="status" className="m-0 text-ui-md text-ui-muted">
          {t('contacts.add.checking')}
        </p>
      )}
      {state.kind === 'checkFailed' && (
        <div className="flex flex-wrap items-center gap-3">
          <p role="alert" className={ERROR_LINE}>
            <CircleAlert {...iconSize('md', 'mt-0.5 shrink-0')} aria-hidden="true" />
            <span>{t('contacts.add.checkFailed')}</span>
          </p>
          <Button onClick={() => dispatch({ type: 'retry' })}>{t('common2.retry')}</Button>
        </div>
      )}
      {(state.kind === 'ready' || state.kind === 'adding') && (
        <PreviewCard state={state} card={state.card} dispatch={dispatch} onSubmit={submit} onCancel={reset} />
      )}
      {state.kind === 'added' && (
        <p role="status" className="m-0 text-ui-base font-semibold text-ui-ink">
          {t(state.refreshed ? 'contacts.add.refreshed' : 'contacts.add.added', { name: state.handle })}
        </p>
      )}

      <p className="m-0 text-ui-md leading-normal text-ui-muted">{t('contacts.mutualNote')}</p>
    </div>
  );
}

/** What each conflict says, and the banner it takes when the preview shows it. */
const CONFLICT = {
  known: { copy: 'contacts.add.known', tone: 'info' },
  refresh: { copy: 'contacts.add.refresh', tone: 'info' },
  nameTaken: { copy: 'contacts.add.nameTaken', tone: 'warn' },
  sharesKeys: { copy: 'contacts.add.sharesKeys', tone: 'warn' },
} as const satisfies Record<AddConflict['kind'], { copy: string; tone: BannerTone }>;

interface PreviewCardProps {
  state: Extract<AddContactState, { kind: 'ready' | 'adding' }>;
  card: AddContactCard;
  dispatch(event: Parameters<typeof addContactReducer>[1]): void;
  onSubmit(): void;
  onCancel(): void;
}

/** Who the code belongs to, with what stands between them and your contacts (Contacts:61-78). */
function PreviewCard({ state, card, dispatch, onSubmit, onCancel }: PreviewCardProps) {
  const t = useT();
  const titleId = useId();
  const conflict = conflictOf(state);
  const conflictText = conflict && t(CONFLICT[conflict.kind].copy, { name: conflict.handle });
  const request = addRequest(state);
  const error = state.kind === 'ready' ? state.error : undefined;
  const name = card.name.trim() || card.preview.handle.trim();
  const replacing = conflict?.kind === 'nameTaken' && card.confirmReplace;
  const refreshing = conflict?.kind === 'refresh';
  // Nothing to add: the same person under another name, or a contact holding a key of the code.
  const blocked = conflict?.kind === 'known' || conflict?.kind === 'sharesKeys';
  // What the backend refused is an error, read out (accesibilidad.md §3.2);
  // what the preview showed before anything was sent is a banner.
  const refused = error?.code === 'already_contact';
  const nameError =
    error?.code === 'name_taken'
      ? 'contacts.add.nameTakenError'
      : error?.code === 'invalid_name'
        ? 'contacts.add.nameInvalidError'
        : null;

  // A name the backend refused leaves the add button disabled: the next step is the name field.
  const nameRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (nameError) nameRef.current?.focus();
  }, [nameError]);

  return (
    <section aria-labelledby={titleId} className={CARD}>
      <div className="flex items-center gap-3">
        <Avatar initials={identityInitials(name)} size={48} />
        <div className="flex min-w-0 flex-col gap-0.5">
          <span id={titleId} className="text-ui-lg font-bold text-ui-ink [overflow-wrap:anywhere]">
            {name}
          </span>
          <span className="text-ui-md text-ui-muted">{t('contacts.add.valid')}</span>
        </div>
      </div>
      <div className="flex flex-col gap-1">
        <span className={LABEL}>{t('contacts.add.theirKey')}</span>
        <code className={MONO_KEY}>{formatFingerprint(card.preview.fingerprint)}</code>
      </div>

      {conflict &&
        (refused ? (
          <p role="alert" className={ERROR_LINE}>
            <CircleAlert {...iconSize('md', 'mt-0.5 shrink-0')} aria-hidden="true" />
            <span>{conflictText}</span>
          </p>
        ) : (
          <Banner tone={CONFLICT[conflict.kind].tone}>{conflictText}</Banner>
        ))}

      {card.editingName && conflict?.kind !== 'known' && (
        <Field
          label={t('contacts.add.nameLabel')}
          hint={card.name.trim() === '' ? t('contacts.add.nameEmpty') : undefined}
          error={nameError ? <span role="alert">{t(nameError)}</span> : undefined}
        >
          <Input
            ref={nameRef}
            value={card.name}
            onChange={event => dispatch({ type: 'rename', name: event.target.value })}
            readOnly={state.kind === 'adding'}
            autoComplete="off"
          />
        </Field>
      )}
      {conflict?.kind === 'nameTaken' && (state.kind === 'ready' || state.kind === 'adding') && state.card.preview.existing?.blocked ? (
        // UR-2 (R-23): the identity it had stays blocked; the new keys are someone else.
        <p className="m-0 text-ui-md leading-normal text-ui-ink">{t('block.replaceBlocked', { name: conflict.handle })}</p>
      ) : null}
      {conflict?.kind === 'nameTaken' && (
        <Checkbox
          label={t('contacts.add.replace', { name: conflict.handle })}
          description={t('contacts.add.replaceHint')}
          checked={card.confirmReplace}
          disabled={state.kind === 'adding'}
          onChange={event => dispatch({ type: 'confirmReplace', on: event.target.checked })}
        />
      )}

      {/* Only for someone who becomes a contact: a refresh keeps the keys, and so the verification. */}
      {(conflict === null || conflict.kind === 'nameTaken') && name !== '' && (
        <p className="m-0 text-ui-md leading-normal text-ui-muted">{t('contacts.add.verifyNote', { name })}</p>
      )}
      {error?.code === 'other' && (
        <p role="alert" className={ERROR_LINE}>
          <CircleAlert {...iconSize('md', 'mt-0.5 shrink-0')} aria-hidden="true" />
          <span>{t('contacts.add.failed')}</span>
        </p>
      )}

      <div className="flex flex-wrap gap-2">
        {!blocked && (
          <Button
            variant="primary"
            disabled={request === null && state.kind !== 'adding'}
            loading={state.kind === 'adding'}
            onClick={onSubmit}
          >
            {name === ''
              ? t('common2.add')
              : t(
                  refreshing ? 'contacts.add.refreshButton' : replacing ? 'contacts.add.replaceButton' : 'contacts.add.add',
                  { name },
                )}
          </Button>
        )}
        <Button onClick={onCancel} disabled={state.kind === 'adding'}>
          {t('common2.cancel')}
        </Button>
      </div>
    </section>
  );
}
