/**
 * Listening to backend events from an effect. Each `on*` of lib/api.ts
 * answers with a promise of its unlisten function; an effect cleaned up
 * before that promise settles must still unlisten once it does.
 */

/** Listens with every subscription; the function returned stops them all, now or once each one is ready. */
export function listenAll(subscriptions: ReadonlyArray<Promise<() => void>>): () => void {
  let active = true;
  const stops: Array<() => void> = [];
  for (const subscription of subscriptions) {
    subscription
      .then(stop => {
        if (active) stops.push(stop);
        else stop();
      })
      .catch(error => console.error('listening to a backend event failed', error));
  }
  return () => {
    active = false;
    for (const stop of stops.splice(0)) stop();
  };
}

/** Epoch seconds, like `Msg.ts`. */
export const nowSeconds = () => Math.floor(Date.now() / 1000);
