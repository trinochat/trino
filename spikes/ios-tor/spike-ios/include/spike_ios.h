// The C side of spike-ios (src/lib.rs), for the spike app's Swift
// (Runner-Bridging-Header.h). Every function returns a JSON string, never
// NULL, that the caller frees with spike_free. The blocking ones
// (spike_tor_start, spike_ws_probe, spike_tor_stop) must not run on the
// main thread.

#ifndef SPIKE_IOS_H
#define SPIKE_IOS_H

#include <stdbool.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

// Start Tor with tor_home as its folder, which must be named "tor-spike".
// fresh wipes it first (a cold start); trust_dirs turns Arti's folder
// permission checks off. Returns once Arti's client exists, not when Tor is
// ready: spike_tor_status follows it.
char *spike_tor_start(const char *tor_home, bool fresh, bool trust_dirs);

// The state now, the time to ready and every state seen since the start.
char *spike_tor_status(void);

// A WebSocket to url over Tor (NULL: wss://nos.lol), one read-only REQ and
// its EOSE, within limit_secs (5 to 300) in all. Never publishes.
char *spike_ws_probe(const char *url, uint32_t limit_secs);

// Stop Tor; blocks until its files are closed.
char *spike_tor_stop(void);

// A timestamped note from the app ("background", "foreground").
char *spike_note(const char *text);

// Everything so far: runs, probes, notes, memory and errors.
char *spike_report(void);

void spike_free(char *json);

#ifdef __cplusplus
}
#endif

#endif
