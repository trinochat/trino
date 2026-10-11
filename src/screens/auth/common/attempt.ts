/**
 * The promise of a call, also when the call throws before it returns one,
 * such as an API stand-in or a command outside Tauri: the screens then treat
 * it as a failure instead of waiting for an answer that never comes.
 */
export function attempt<T>(call: () => Promise<T>): Promise<T> {
  try {
    return call();
  } catch (error) {
    return Promise.reject(error);
  }
}
