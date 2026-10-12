/**
 * Verifying a contact (W6, plan-cambios-11oct §3.1). Only a call verifies:
 * "Coinciden" on the call's SAS. So this dialog shows the contact's 7
 * symbols as a quick check, which never verifies and has no "Coinciden"
 * (its derivation falls to about 2^21 offline work, docs/sas-v2.md), and
 * offers the call that does. A contact verified in a call says so
 * ("Verificaste a {name} en una llamada.") instead of the way to verify.
 * Without both identity digests (K7) there are no symbols to show.
 */
import { Phone } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import { useT } from '../../lib/i18n';
import { SasSymbol } from '../../lib/SasSymbol';
import { contactSas } from '../../lib/sas';
import type { VerifyContactSlotProps } from '../types';
import { Button, Dialog, TrustBadge, iconSize } from '../../ui';

export type VerifyContactDialogProps = VerifyContactSlotProps;

export function VerifyContactDialog({ peer, myIdentityDigest, onClose, onCall, verified }: VerifyContactDialogProps) {
  const t = useT();
  const quickId = useId();
  const [symbols, setSymbols] = useState<readonly number[] | null>(null);
  const theirs = peer.identity_digest ?? null;

  useEffect(() => {
    setSymbols(null);
    if (!myIdentityDigest || !theirs) return;
    let current = true;
    contactSas({ idA: myIdentityDigest, idB: theirs })
      .then(indices => {
        if (current) setSymbols(indices);
      })
      .catch(error => console.error('contact SAS unavailable', error));
    return () => {
      current = false;
    };
  }, [myIdentityDigest, theirs]);

  const name = peer.handle;
  return (
    <Dialog open onClose={onClose} title={t('verify.title', { name })}>
      {symbols && (
        <section aria-labelledby={quickId} className="flex flex-col gap-3">
          <h3 id={quickId} className="m-0 text-ui-lg font-bold">
            {t('verify.quickCheck')}
          </h3>
          <ul
            role="list"
            aria-label={t('verify.symbols')}
            className="m-0 grid list-none grid-cols-[repeat(auto-fit,minmax(3.5rem,1fr))] gap-x-1 gap-y-3 p-0"
          >
            {symbols.map((index, i) => (
              <li key={i} className="flex min-w-0 justify-center text-center text-ui-sm font-semibold">
                <SasSymbol index={index} size="2xl" />
              </li>
            ))}
          </ul>
          <p className="m-0 text-ui-md leading-normal text-ui-muted">{t('verify.quickCheckBody')}</p>
        </section>
      )}
      {verified ? (
        <TrustBadge kind="verified" label={t('verify.done', { name })} />
      ) : (
        <p className="m-0 text-ui-base leading-normal">{t('verify.howTo', { name })}</p>
      )}
      <div className="flex flex-wrap justify-end gap-2">
        {!verified && onCall && (
          <Button variant="primary" leadingIcon={<Phone {...iconSize('md')} />} onClick={onCall}>
            {t('verify.call')}
          </Button>
        )}
        <Button onClick={onClose}>{t('common2.close')}</Button>
      </div>
    </Dialog>
  );
}
