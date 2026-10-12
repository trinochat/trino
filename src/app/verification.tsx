/**
 * The one-time notice about the verification marks of 0.1.0 (W6, parent
 * decision of 11 Oct; docs/sas-v2.md, "Marks made before v2"). Those marks
 * came from comparing the contact's emojis, a check too weak to verify, and
 * no longer count. Once the chats know their contacts, the notice names the
 * ones that had such a mark and says how to verify them again: by a call.
 * Closed, it removes those marks, so it never shows again; a mark that a
 * call made in the meantime stays.
 */
import { useMemo, useState, type ReactNode } from 'react';
import type { NodeInfo } from '../lib/api';
import { prefs as devicePrefs, type Prefs } from '../lib/prefs';
import { LegacyVerificationNotice } from '../screens/verify';

export interface LegacyMarksOptions {
  /** The chats' contacts: empty until they are read. */
  contacts: readonly NodeInfo[];
  /** The preferences of this device, unless a test brings its own. */
  prefs?: Prefs;
}

/** The notice while some contact has a mark of 0.1.0, else nothing. */
export function useLegacyMarksNotice({ contacts, prefs = devicePrefs }: LegacyMarksOptions): ReactNode {
  // Each close removes marks, which are not React state: `told` reads them again then.
  const [told, setTold] = useState(0);
  const names = useMemo(() => prefs.legacyVerified(contacts.map(contact => contact.handle)), [contacts, prefs, told]);
  if (names.length === 0) return null;
  return (
    <LegacyVerificationNotice
      names={names}
      onClose={() => {
        prefs.clearLegacyVerified(names);
        setTold(n => n + 1);
      }}
    />
  );
}
