/**
 * The chats' side of the warning to a trusted contact (clave de emergencia
 * CE-6, design §7.2 and §11.6): which contacts ask to warn you, and whose
 * warning came. Read at the start and again with each `emergency-alert`
 * the backend sends; a warning that came is also told the way a message
 * is (the notifier, with what Settings › Notificaciones allows).
 *
 * `forChat` gives each chat with a contact what ChatPane shows: the strip
 * of its warning, and its question with the way to answer it. A group or
 * the channel gets nothing.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { EmergencyAlertEvent, EmergencyAlerts } from '../lib/api';
import type { ConvoRef } from '../lib/convo';
import type { ChatPaneProps } from '../screens/types';

/** What it takes from the backend: `api.emergencyAlerts`, `api.answerEmergencyAlert` and `onEmergencyAlert` of src/lib/api.ts. */
export interface EmergencyAlertsBackend {
  emergencyAlerts(): Promise<EmergencyAlerts>;
  answerEmergencyAlert(handle: string, accept: boolean): Promise<void>;
  /** Resolves to the function that stops listening. */
  onEmergencyAlert(cb: (event: EmergencyAlertEvent) => void): Promise<() => void>;
}

export type ChatAlerts = Pick<ChatPaneProps, 'emergencyWarning' | 'onEmergencyAnswer'>;

const NONE: EmergencyAlerts = { asks: [], warnings: [] };

export function useEmergencyAlerts(
  backend: EmergencyAlertsBackend | null,
  onWarned: (handle: string) => void,
): (convo: ConvoRef) => ChatAlerts {
  const [alerts, setAlerts] = useState<EmergencyAlerts>(NONE);
  const warned = useRef(onWarned);
  warned.current = onWarned;

  const read = useCallback(async () => {
    if (!backend) return;
    try {
      setAlerts(await backend.emergencyAlerts());
    } catch {
      // Nothing to show this time: the next event reads again.
    }
  }, [backend]);

  useEffect(() => {
    if (!backend) return;
    let live = true;
    let stop: (() => void) | undefined;
    void read();
    backend
      .onEmergencyAlert(event => {
        void read();
        if (event.what === 'warned') warned.current(event.handle);
      })
      .then(
        unlisten => {
          if (live) stop = unlisten;
          else unlisten();
        },
        () => {},
      );
    return () => {
      live = false;
      stop?.();
    };
  }, [backend, read]);

  return useCallback(
    (convo: ConvoRef): ChatAlerts => {
      if (!backend || convo.kind !== 'contact') return {};
      const out: ChatAlerts = {};
      const warning = alerts.warnings.find(item => item.handle === convo.handle);
      if (warning) out.emergencyWarning = { at: warning.at, sent: warning.sent, message: warning.message };
      if (alerts.asks.includes(convo.handle)) {
        out.onEmergencyAnswer = async (accept: boolean) => {
          await backend.answerEmergencyAlert(convo.handle, accept);
          await read();
        };
      }
      return out;
    },
    [alerts, backend, read],
  );
}
