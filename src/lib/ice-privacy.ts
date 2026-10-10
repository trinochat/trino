// ice-privacy.ts — decides which of our network addresses a call may reveal.
//
// WebRTC gathers a candidate for every interface it can see: the LAN address,
// VPN and virtual adapters, and (after getUserMedia) the raw addresses that
// Chromium would otherwise hide behind mDNS names. Everything that leaves this
// device in an SDP or an `ice` signal goes through this module first:
//
// - host candidates on private, CGNAT, link-local, ULA, loopback or mDNS
//   addresses are dropped; only publicly routable ones survive;
// - srflx/prflx candidates survive only when their mapped address is public;
// - relay candidates always survive (their address is the TURN server's);
// - `raddr`/`rport` are zeroed, because they carry the LAN address a srflx was
//   mapped from (and the public address behind a relay);
// - `c=`, `a=rtcp` and the `m=` port lose the default candidate they repeat.
//
// Developer switch: set `localStorage['trino.dev.allowLanCandidates'] = '1'`
// in the devtools console to keep LAN candidates, so two machines on the same
// network can test a call without hairpin NAT. Off by default; never ship it on.
//
// Protected calls (the default) go through TURN only: `relay` transport and
// the `relay-only` policy, so the contact never learns our address. Direct
// calls happen only after the user agrees. See docs/llamadas-turn.md.

import type { IceServerConfig } from './call-rules';

/**
 * - `protected`: TURN relay only; the contact never sees our IP.
 * - `direct`: STUN and peer-to-peer; the contact sees our public IP.
 */
export type ConnectionMode = 'protected' | 'direct';

/**
 * - `withhold`: reveal nothing (the caller's offer, before the callee answers).
 * - `public`: reveal publicly routable candidates only (the default).
 * - `relay-only`: reveal TURN relay candidates only.
 * - `allow-lan`: developer switch; keep LAN candidates too.
 */
export type CandidatePolicy = 'withhold' | 'public' | 'relay-only' | 'allow-lan';

/**
 * - `hold`: queue candidates until `release()` (caller waiting for the answer).
 * - `embed`: drop them; the SDP about to be sent already carries them.
 * - `trickle`: send them as they come.
 */
export type GateMode = 'hold' | 'embed' | 'trickle';

/** The plain-object shape of `RTCIceCandidate.toJSON()`. */
export interface CandidateInit {
  candidate?: string;
  sdpMid?: string | null;
  sdpMLineIndex?: number | null;
  usernameFragment?: string | null;
}

export const DEV_ALLOW_LAN_KEY = 'trino.dev.allowLanCandidates';

/** Policy for a call, from the developer switch's stored value. */
export function candidatePolicy(devSwitch: string | null): CandidatePolicy {
  return devSwitch === '1' || devSwitch === 'true' ? 'allow-lan' : 'public';
}

/** A protected call reveals relay candidates only; the developer switch does not apply. */
export function callPolicy(mode: ConnectionMode, devSwitch: string | null): CandidatePolicy {
  return mode === 'protected' ? 'relay-only' : candidatePolicy(devSwitch);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/**
 * The servers a protected call may use: TURN entries with a username and a
 * credential. An entry with any other URL (STUN included) is dropped, so
 * nothing but the relay ever learns our address.
 */
export function relayServers(servers: unknown): IceServerConfig[] {
  if (!Array.isArray(servers)) return [];
  const kept: IceServerConfig[] = [];
  for (const server of servers) {
    if (typeof server !== 'object' || server === null) continue;
    const { urls, username, credential } = server as Record<string, unknown>;
    const list = Array.isArray(urls) ? urls : [urls];
    if (
      list.length > 0 &&
      list.every(url => typeof url === 'string' && /^turns?:/.test(url)) &&
      nonEmptyString(username) &&
      nonEmptyString(credential)
    ) {
      kept.push({ urls: urls as string | string[], username, credential });
    }
  }
  return kept;
}

/**
 * The `RTCPeerConnection` configuration. No candidate pool, so nothing is
 * gathered before there is a description; one bundled transport, so one set
 * of candidates to filter.
 */
export function rtcConfiguration(
  mode: ConnectionMode,
  servers: IceServerConfig[],
): RTCConfiguration {
  return {
    iceServers: servers,
    iceTransportPolicy: mode === 'protected' ? 'relay' : 'all',
    bundlePolicy: 'max-bundle',
    iceCandidatePoolSize: 0,
  };
}

function parseIpv4(address: string): number[] | null {
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(address)) return null;
  const octets = address.split('.').map(Number);
  return octets.every(o => o <= 255) ? octets : null;
}

function isPublicIpv4([a, b, c]: number[]): boolean {
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false; // this-net, private, loopback, multicast/reserved
  if (a === 100 && b! >= 64 && b! <= 127) return false; // CGNAT 100.64/10
  if (a === 169 && b === 254) return false; // link-local
  if (a === 172 && b! >= 16 && b! <= 31) return false; // private 172.16/12
  if (a === 192 && b === 168) return false; // private
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return false; // IETF protocol, TEST-NET-1
  if (a === 198 && (b === 18 || b === 19)) return false; // benchmarking
  if (a === 198 && b === 51 && c === 100) return false; // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return false; // TEST-NET-3
  return true;
}

/** Eight 16-bit groups, or null when the text is not an IPv6 address. */
function parseIpv6(text: string): number[] | null {
  let address = text;
  let tail: number[] = [];
  const lastColon = address.lastIndexOf(':');
  const dotted = address.slice(lastColon + 1);
  if (dotted.includes('.')) {
    const v4 = parseIpv4(dotted);
    if (!v4) return null;
    tail = [(v4[0]! << 8) | v4[1]!, (v4[2]! << 8) | v4[3]!];
    address = address.slice(0, lastColon + 1) + '0:0';
  }
  const halves = address.split('::');
  if (halves.length > 2) return null;
  const parse = (part: string) => (part === '' ? [] : part.split(':'));
  const head = parse(halves[0]!);
  const rest = halves.length === 2 ? parse(halves[1]!) : [];
  const missing = 8 - head.length - rest.length;
  if (halves.length === 2 ? missing < 1 : missing !== 0) return null;
  const groups = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill('0'), ...rest];
  if (!groups.every(g => /^[0-9a-f]{1,4}$/i.test(g))) return null;
  const values = groups.map(g => parseInt(g, 16));
  if (tail.length) values.splice(6, 2, ...tail);
  return values;
}

function isPublicIpv6(g: number[]): boolean {
  const mappedV4 = g.slice(0, 5).every(x => x === 0) && g[5] === 0xffff;
  const nat64 = g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every(x => x === 0);
  if (mappedV4 || nat64) {
    return isPublicIpv4([g[6]! >> 8, g[6]! & 0xff, g[7]! >> 8, g[7]! & 0xff]);
  }
  // Only global unicast (2000::/3) is public; that excludes ::, ::1, ULA
  // fc00::/7, link-local fe80::/10, site-local fec0::/10 and multicast.
  if ((g[0]! & 0xe000) !== 0x2000) return false;
  return !(g[0] === 0x2001 && g[1] === 0x0db8); // documentation
}

/** True only for addresses that are routable on the public Internet. */
export function isPublicAddress(address: string): boolean {
  const a = address.trim().toLowerCase();
  if (!a || a.endsWith('.local')) return false;
  const v4 = parseIpv4(a);
  if (v4) return isPublicIpv4(v4);
  if (!a.includes(':')) return false; // hostnames and garbage
  const v6 = parseIpv6(a.replace(/^\[|\]$/g, '').replace(/%.*$/, ''));
  return v6 !== null && isPublicIpv6(v6);
}

interface ParsedCandidate {
  prefix: string; // "a=" inside an SDP, "" in an ice signal
  tokens: string[];
  address: string;
  type: string;
}

function parseCandidate(line: string): ParsedCandidate | null {
  const trimmed = line.trim();
  const prefix = trimmed.startsWith('a=') ? 'a=' : '';
  const body = trimmed.slice(prefix.length);
  if (!body.startsWith('candidate:')) return null;
  const tokens = body.split(/\s+/);
  // candidate:<foundation> <component> <transport> <priority> <address> <port> typ <type> …
  if (tokens.length < 8 || tokens[6] !== 'typ' || !/^\d+$/.test(tokens[5]!)) return null;
  return { prefix, tokens, address: tokens[4]!, type: tokens[7]! };
}

/** Whether a candidate line may leave this device under `policy`. */
export function keepCandidate(candidateLine: string, policy: CandidatePolicy): boolean {
  if (policy === 'withhold') return false;
  const c = parseCandidate(candidateLine);
  if (!c) return false;
  if (c.type === 'relay') return true;
  if (policy === 'relay-only') return false;
  if (!['host', 'srflx', 'prflx'].includes(c.type)) return false;
  return policy === 'allow-lan' || isPublicAddress(c.address);
}

/** Zero `raddr`/`rport`; they reveal the address a srflx/relay was mapped from. */
export function scrubCandidate(candidateLine: string): string {
  const c = parseCandidate(candidateLine);
  if (!c) return candidateLine;
  const tokens = [...c.tokens];
  for (let i = 8; i < tokens.length - 1; i++) {
    if (tokens[i] === 'raddr') tokens[i + 1] = tokens[i + 1]!.includes(':') ? '::' : '0.0.0.0';
    else if (tokens[i] === 'rport') tokens[i + 1] = '0';
  }
  return c.prefix + tokens.join(' ');
}

/**
 * Filter an SDP before it is sent: drop candidates `policy` does not allow,
 * scrub the rest, and replace the default-candidate address and port that
 * `c=`, `a=rtcp` and `m=` repeat with the placeholders trickle ICE uses.
 */
export function scrubSdp(sdp: string, policy: CandidatePolicy): string {
  const eol = sdp.includes('\r\n') ? '\r\n' : '\n';
  const out: string[] = [];
  for (const line of sdp.split(/\r?\n/)) {
    if (line.startsWith('a=candidate:')) {
      if (keepCandidate(line, policy)) out.push(scrubCandidate(line));
    } else if (line === 'a=end-of-candidates') {
      // Dropped: candidates we filtered out or withheld may still be trickled.
    } else if (/^c=IN IP[46] /.test(line)) {
      out.push('c=IN IP4 0.0.0.0');
    } else if (line.startsWith('a=rtcp:')) {
      out.push(/^a=rtcp:\d+ IN IP[46] /.test(line) ? 'a=rtcp:9 IN IP4 0.0.0.0' : 'a=rtcp:9');
    } else if (line.startsWith('m=')) {
      // Port 0 marks a rejected or bundle-only section and must stay 0.
      out.push(line.replace(/^(m=\S+ )(\d+)(\/\d+)?( )/, (all, head, port, _n, sp) =>
        port === '0' ? all : `${head}9${sp}`,
      ));
    } else {
      out.push(line);
    }
  }
  return out.join(eol);
}

/** A copy of an `ice` signal's candidate that may be sent, or null. */
export function filterCandidateInit(
  c: CandidateInit,
  policy: CandidatePolicy,
): CandidateInit | null {
  if (!c.candidate || !keepCandidate(c.candidate, policy)) return null;
  return { ...c, candidate: scrubCandidate(c.candidate) };
}

/**
 * Our outgoing candidates for one call. The caller starts in `hold`, so no
 * address leaves before the callee accepts; `release()` hands over what was
 * held (filtered) and switches to `trickle`.
 */
export class OutgoingCandidates {
  private held: CandidateInit[] = [];

  constructor(
    private policy: CandidatePolicy,
    private mode: GateMode = 'hold',
    private readonly maxHeld = 64,
  ) {}

  /** A candidate was gathered; returns what to send right now. */
  offer(c: CandidateInit): CandidateInit[] {
    if (this.mode === 'embed') return [];
    const safe = filterCandidateInit(c, this.policy);
    if (!safe) return [];
    if (this.mode === 'trickle') return [safe];
    if (this.held.length < this.maxHeld) this.held.push(safe);
    return [];
  }

  /** Stop sending: the SDP about to go out carries the candidates itself. */
  embed(): void {
    this.mode = 'embed';
  }

  /** Switch to trickling and return the candidates held so far. */
  release(): CandidateInit[] {
    const held = this.held;
    this.held = [];
    this.mode = 'trickle';
    return held;
  }

  /** Forget everything; used when the call ends. */
  reset(policy: CandidatePolicy = this.policy): void {
    this.held = [];
    this.policy = policy;
    this.mode = 'hold';
  }
}
