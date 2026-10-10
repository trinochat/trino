import { describe, expect, it } from 'vitest';
import {
  OutgoingCandidates,
  callPolicy,
  candidatePolicy,
  filterCandidateInit,
  isPublicAddress,
  keepCandidate,
  relayServers,
  rtcConfiguration,
  scrubCandidate,
  scrubSdp,
} from './ice-privacy';

// Candidate lines shaped like the ones Chromium/WebView2 produces.
const HOST_LAN = 'candidate:1467250027 1 udp 2122260223 192.168.1.20 56143 typ host generation 0 ufrag abcd network-id 1 network-cost 10';
const HOST_MDNS = 'candidate:842163049 1 udp 2122260223 4b1c2a1e-3f0b-4f7a-9a43-5b2c0d7e9f10.local 54321 typ host generation 0 ufrag abcd network-id 1';
const HOST_TCP_LAN = 'candidate:2 1 tcp 1518280447 10.8.0.6 9 typ host tcptype active generation 0';
const HOST_ULA = 'candidate:5 1 udp 2122197247 fd12:3456:789a::5 56150 typ host generation 0';
const HOST_PUBLIC_V6 = 'candidate:6 1 udp 2122197247 2a02:1810:a1b:c00::17 56151 typ host generation 0';
const SRFLX = 'candidate:3 1 udp 1686052607 81.2.69.142 61000 typ srflx raddr 192.168.1.20 rport 56143 generation 0 ufrag abcd';
const SRFLX_PRIVATE = 'candidate:7 1 udp 1686052607 10.20.30.40 61001 typ srflx raddr 192.168.1.20 rport 56143 generation 0';
const RELAY = 'candidate:4 1 udp 41885439 34.120.1.2 3478 typ relay raddr 81.2.69.142 rport 61000 generation 0';

describe('isPublicAddress', () => {
  it.each([
    '192.168.1.20',
    '10.0.0.1',
    '172.16.0.1',
    '172.31.255.254',
    '100.64.0.1', // CGNAT
    '100.127.255.254', // CGNAT upper edge
    '169.254.10.10', // link-local
    '127.0.0.1',
    '0.0.0.0',
    '224.0.0.251', // multicast
    '::1',
    '::',
    'fd12:3456:789a::5', // ULA fc00::/7
    'fc00::1',
    'fe80::1c2b:3aff:fe4d:5e6f', // link-local
    'fe80::1%12', // scoped link-local
    'febf::1', // still fe80::/10
    '::ffff:192.168.1.20', // IPv4-mapped private
    '2001:db8::1', // documentation
    '4b1c2a1e-3f0b-4f7a-9a43-5b2c0d7e9f10.local', // mDNS
    'MyLaptop.LOCAL',
    'not-an-ip',
    '999.1.1.1',
    '',
  ])('treats %s as not public', address => {
    expect(isPublicAddress(address)).toBe(false);
  });

  it.each([
    '81.2.69.142',
    '8.8.8.8',
    '172.32.0.1', // just outside 172.16/12
    '100.128.0.1', // just outside 100.64/10
    '2a02:1810:a1b:c00::17',
    '2001:4860:4860::8888',
    '::ffff:8.8.8.8', // IPv4-mapped public
  ])('treats %s as public', address => {
    expect(isPublicAddress(address)).toBe(true);
  });
});

describe('keepCandidate', () => {
  it('drops host candidates on private, CGNAT, ULA, link-local and mDNS addresses', () => {
    for (const line of [HOST_LAN, HOST_MDNS, HOST_TCP_LAN, HOST_ULA]) {
      expect(keepCandidate(line, 'public'), line).toBe(false);
    }
    expect(keepCandidate('candidate:9 1 udp 1 100.72.1.9 5000 typ host', 'public')).toBe(false);
    expect(keepCandidate('candidate:9 1 udp 1 fe80::1 5000 typ host', 'public')).toBe(false);
    expect(keepCandidate('candidate:9 1 udp 1 127.0.0.1 5000 typ host', 'public')).toBe(false);
  });

  it('keeps srflx, relay and host candidates on a public address', () => {
    expect(keepCandidate(SRFLX, 'public')).toBe(true);
    expect(keepCandidate(RELAY, 'public')).toBe(true);
    expect(keepCandidate(HOST_PUBLIC_V6, 'public')).toBe(true);
  });

  it('drops a srflx whose mapped address is private (STUN inside the LAN)', () => {
    expect(keepCandidate(SRFLX_PRIVATE, 'public')).toBe(false);
  });

  it('accepts the a= prefix used inside an SDP', () => {
    expect(keepCandidate(`a=${SRFLX}`, 'public')).toBe(true);
    expect(keepCandidate(`a=${HOST_LAN}`, 'public')).toBe(false);
  });

  it('keeps only relay candidates in relay-only mode', () => {
    expect(keepCandidate(RELAY, 'relay-only')).toBe(true);
    expect(keepCandidate(SRFLX, 'relay-only')).toBe(false);
    expect(keepCandidate(HOST_PUBLIC_V6, 'relay-only')).toBe(false);
  });

  it('keeps nothing while candidates are withheld', () => {
    for (const line of [HOST_LAN, SRFLX, RELAY]) {
      expect(keepCandidate(line, 'withhold')).toBe(false);
    }
  });

  it('keeps LAN candidates only with the developer switch', () => {
    expect(keepCandidate(HOST_LAN, 'allow-lan')).toBe(true);
    expect(keepCandidate(HOST_MDNS, 'allow-lan')).toBe(true);
    expect(keepCandidate(SRFLX, 'allow-lan')).toBe(true);
  });

  it('drops malformed lines', () => {
    expect(keepCandidate('', 'public')).toBe(false);
    expect(keepCandidate('candidate:1 1 udp 1 81.2.69.142', 'public')).toBe(false);
    expect(keepCandidate('candidate:1 1 udp 1 81.2.69.142 5000 type srflx', 'public')).toBe(false);
    expect(keepCandidate('a=ice-ufrag:abcd', 'allow-lan')).toBe(false);
  });
});

describe('scrubCandidate', () => {
  it('zeroes raddr and rport so the LAN address behind a srflx/relay never leaves', () => {
    expect(scrubCandidate(SRFLX)).toBe(
      'candidate:3 1 udp 1686052607 81.2.69.142 61000 typ srflx raddr 0.0.0.0 rport 0 generation 0 ufrag abcd',
    );
    expect(scrubCandidate(`a=${RELAY}`)).toBe(
      'a=candidate:4 1 udp 41885439 34.120.1.2 3478 typ relay raddr 0.0.0.0 rport 0 generation 0',
    );
  });

  it('uses :: for an IPv6 related address', () => {
    expect(
      scrubCandidate('candidate:8 1 udp 1 2a02:1810::9 6000 typ srflx raddr fd00::9 rport 5000'),
    ).toBe('candidate:8 1 udp 1 2a02:1810::9 6000 typ srflx raddr :: rport 0');
  });

  it('leaves a candidate without related address untouched', () => {
    expect(scrubCandidate(HOST_PUBLIC_V6)).toBe(HOST_PUBLIC_V6);
  });
});

// A Chromium-shaped SDP after ICE gathering, with every kind of leak in it.
const SDP = [
  'v=0',
  'o=- 4611731400430051336 2 IN IP4 127.0.0.1',
  's=-',
  't=0 0',
  'a=group:BUNDLE 0 1',
  'a=extmap-allow-mixed',
  'a=msid-semantic: WMS stream',
  'm=audio 56143 UDP/TLS/RTP/SAVPF 111',
  'c=IN IP4 192.168.1.20',
  'a=rtcp:56144 IN IP4 192.168.1.20',
  `a=${HOST_LAN}`,
  `a=${HOST_MDNS}`,
  `a=${HOST_TCP_LAN}`,
  `a=${SRFLX}`,
  `a=${RELAY}`,
  'a=end-of-candidates',
  'a=ice-ufrag:abcd',
  'a=ice-pwd:0123456789abcdefghijklmn',
  'a=fingerprint:sha-256 AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89',
  'a=setup:actpass',
  'a=mid:0',
  'a=sendrecv',
  'a=rtcp-mux',
  'a=rtpmap:111 opus/48000/2',
  'm=video 9 UDP/TLS/RTP/SAVPF 96',
  'c=IN IP6 fd12:3456:789a::5',
  'a=rtcp:9 IN IP6 fd12:3456:789a::5',
  `a=${HOST_ULA}`,
  'a=mid:1',
  'm=application 0 UDP/DTLS/SCTP webrtc-datachannel',
  'c=IN IP4 0.0.0.0',
  'a=mid:2',
  '',
].join('\r\n');

// Every IPv4 literal in an SDP, to prove nothing private survives.
function ipv4s(sdp: string): string[] {
  return sdp.match(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g) ?? [];
}

describe('scrubSdp', () => {
  it('removes private candidates and default addresses in public mode', () => {
    const out = scrubSdp(SDP, 'public');
    expect(out).not.toContain('192.168.1.20');
    expect(out).not.toContain('10.8.0.6');
    expect(out).not.toContain('fd12:3456:789a::5');
    expect(out).not.toContain('.local');
    expect(out).not.toContain('a=end-of-candidates');
    expect(out).toContain('a=candidate:3 1 udp 1686052607 81.2.69.142 61000 typ srflx raddr 0.0.0.0 rport 0');
    expect(out).toContain('a=candidate:4 1 udp 41885439 34.120.1.2 3478 typ relay raddr 0.0.0.0 rport 0');
    expect(new Set(ipv4s(out))).toEqual(new Set(['127.0.0.1', '0.0.0.0', '81.2.69.142', '34.120.1.2']));
  });

  it('rewrites c=, a=rtcp and the m= port to the trickle placeholders', () => {
    const lines = scrubSdp(SDP, 'public').split('\r\n');
    expect(lines.filter(l => l.startsWith('c='))).toEqual([
      'c=IN IP4 0.0.0.0',
      'c=IN IP4 0.0.0.0',
      'c=IN IP4 0.0.0.0',
    ]);
    expect(lines.filter(l => l.startsWith('a=rtcp:'))).toEqual([
      'a=rtcp:9 IN IP4 0.0.0.0',
      'a=rtcp:9 IN IP4 0.0.0.0',
    ]);
    expect(lines).toContain('m=audio 9 UDP/TLS/RTP/SAVPF 111');
    expect(lines).toContain('m=video 9 UDP/TLS/RTP/SAVPF 96');
  });

  it('keeps a rejected m= section rejected (port 0)', () => {
    expect(scrubSdp(SDP, 'public')).toContain('m=application 0 UDP/DTLS/SCTP webrtc-datachannel');
  });

  it('leaves the session description intact otherwise', () => {
    const out = scrubSdp(SDP, 'public');
    for (const keep of [
      'a=ice-ufrag:abcd',
      'a=ice-pwd:0123456789abcdefghijklmn',
      'a=fingerprint:sha-256 AB:CD:EF',
      'a=setup:actpass',
      'a=group:BUNDLE 0 1',
      'a=rtpmap:111 opus/48000/2',
      'o=- 4611731400430051336 2 IN IP4 127.0.0.1',
    ]) {
      expect(out).toContain(keep);
    }
    expect(out.startsWith('v=0\r\n')).toBe(true);
    expect(out.endsWith('\r\n')).toBe(true);
  });

  it('sends an offer with no candidates at all while they are withheld', () => {
    const out = scrubSdp(SDP, 'withhold');
    expect(out).not.toContain('a=candidate');
    expect(new Set(ipv4s(out))).toEqual(new Set(['127.0.0.1', '0.0.0.0']));
  });

  it('keeps only relay candidates, without the srflx behind them, in relay-only mode', () => {
    const out = scrubSdp(SDP, 'relay-only');
    expect(out.match(/a=candidate/g)).toHaveLength(1);
    expect(out).toContain('typ relay raddr 0.0.0.0 rport 0');
    expect(out).not.toContain('81.2.69.142');
  });

  it('keeps LAN candidates with the developer switch but still scrubs raddr', () => {
    const out = scrubSdp(SDP, 'allow-lan');
    expect(out).toContain(`a=${HOST_LAN}`);
    expect(out).not.toContain('raddr 192.168.1.20');
  });

  it('preserves LF-only line endings', () => {
    const lf = SDP.replace(/\r\n/g, '\n');
    const out = scrubSdp(lf, 'public');
    expect(out).not.toContain('\r');
    expect(out).not.toContain('192.168.1.20');
  });
});

describe('filterCandidateInit', () => {
  it('returns a scrubbed copy of a public candidate with its routing fields', () => {
    expect(
      filterCandidateInit(
        { candidate: SRFLX, sdpMid: '0', sdpMLineIndex: 0, usernameFragment: 'abcd' },
        'public',
      ),
    ).toEqual({
      candidate: 'candidate:3 1 udp 1686052607 81.2.69.142 61000 typ srflx raddr 0.0.0.0 rport 0 generation 0 ufrag abcd',
      sdpMid: '0',
      sdpMLineIndex: 0,
      usernameFragment: 'abcd',
    });
  });

  it('returns null for private candidates, withheld ones and end-of-candidates', () => {
    expect(filterCandidateInit({ candidate: HOST_LAN, sdpMid: '0' }, 'public')).toBeNull();
    expect(filterCandidateInit({ candidate: SRFLX, sdpMid: '0' }, 'withhold')).toBeNull();
    expect(filterCandidateInit({ candidate: '', sdpMid: '0' }, 'allow-lan')).toBeNull();
  });
});

describe('OutgoingCandidates', () => {
  const init = (candidate: string) => ({ candidate, sdpMid: '0', sdpMLineIndex: 0 });

  it('holds every candidate until the callee answers, then releases only public ones', () => {
    const out = new OutgoingCandidates('public');
    expect(out.offer(init(HOST_LAN))).toEqual([]);
    expect(out.offer(init(SRFLX))).toEqual([]);
    expect(out.offer(init(RELAY))).toEqual([]);
    const released = out.release().map(c => c.candidate);
    expect(released).toEqual([scrubCandidate(SRFLX), scrubCandidate(RELAY)]);
  });

  it('trickles later candidates immediately after release, still filtered', () => {
    const out = new OutgoingCandidates('public');
    out.release();
    expect(out.offer(init(HOST_MDNS))).toEqual([]);
    expect(out.offer(init(SRFLX)).map(c => c.candidate)).toEqual([scrubCandidate(SRFLX)]);
  });

  it('sends nothing while an SDP that embeds the candidates is being prepared', () => {
    const out = new OutgoingCandidates('public', 'embed');
    expect(out.offer(init(SRFLX))).toEqual([]);
    expect(out.release()).toEqual([]);
    expect(out.offer(init(RELAY)).map(c => c.candidate)).toEqual([scrubCandidate(RELAY)]);
  });

  it('bounds how many candidates it holds', () => {
    const out = new OutgoingCandidates('allow-lan', 'hold', 2);
    out.offer(init(SRFLX));
    out.offer(init(RELAY));
    out.offer(init(HOST_LAN));
    expect(out.release()).toHaveLength(2);
  });

  it('forgets held candidates when reset', () => {
    const out = new OutgoingCandidates('public');
    out.offer(init(SRFLX));
    out.reset();
    expect(out.release()).toEqual([]);
  });
});

describe('candidatePolicy', () => {
  it('filters LAN candidates unless the developer switch is set', () => {
    expect(candidatePolicy(null)).toBe('public');
    expect(candidatePolicy('')).toBe('public');
    expect(candidatePolicy('0')).toBe('public');
    expect(candidatePolicy('yes please')).toBe('public');
    expect(candidatePolicy('1')).toBe('allow-lan');
    expect(candidatePolicy('true')).toBe('allow-lan');
  });
});

const TURN = {
  urls: [
    'turn:turn.cloudflare.com:3478?transport=udp',
    'turns:turn.cloudflare.com:443?transport=tcp',
  ],
  username: 'u1',
  credential: 'c1',
};
const STUN = { urls: ['stun:stun.l.google.com:19302'] };

describe('relayServers', () => {
  it('keeps TURN servers that carry credentials', () => {
    expect(relayServers([TURN])).toEqual([TURN]);
    expect(relayServers([{ ...TURN, urls: TURN.urls[1] }])).toEqual([
      { ...TURN, urls: TURN.urls[1] },
    ]);
  });

  it('drops STUN and anything that is not TURN, so only the relay learns our address', () => {
    expect(relayServers([STUN, TURN])).toEqual([TURN]);
    expect(relayServers([{ ...TURN, urls: [...TURN.urls, 'stun:stun.cloudflare.com:3478'] }])).toEqual(
      [],
    );
    expect(relayServers([{ ...TURN, urls: ['https://turn.cloudflare.com'] }])).toEqual([]);
  });

  it('drops TURN entries without a username or credential', () => {
    expect(relayServers([{ urls: TURN.urls }])).toEqual([]);
    expect(relayServers([{ ...TURN, username: '' }])).toEqual([]);
    expect(relayServers([{ ...TURN, credential: 7 }])).toEqual([]);
  });

  it('copies only the fields RTCPeerConnection needs', () => {
    expect(relayServers([{ ...TURN, credentialType: 'oauth', extra: 1 }])).toEqual([TURN]);
  });

  it('returns nothing for malformed input', () => {
    for (const bad of [undefined, null, 'turn:x', {}, [null], [{ urls: [] }], [{ urls: [3] }]]) {
      expect(relayServers(bad)).toEqual([]);
    }
  });
});

describe('callPolicy', () => {
  it('reveals relay candidates only in a protected call, whatever the developer switch says', () => {
    expect(callPolicy('protected', null)).toBe('relay-only');
    expect(callPolicy('protected', '1')).toBe('relay-only');
  });

  it('keeps the public filter (and the developer switch) in a direct call', () => {
    expect(callPolicy('direct', null)).toBe('public');
    expect(callPolicy('direct', '1')).toBe('allow-lan');
  });
});

describe('rtcConfiguration', () => {
  it('forces relay-only transport for a protected call', () => {
    expect(rtcConfiguration('protected', [TURN])).toEqual({
      iceServers: [TURN],
      iceTransportPolicy: 'relay',
      bundlePolicy: 'max-bundle',
      iceCandidatePoolSize: 0,
    });
  });

  it('allows every transport for a direct call', () => {
    expect(rtcConfiguration('direct', [STUN])).toEqual({
      iceServers: [STUN],
      iceTransportPolicy: 'all',
      bundlePolicy: 'max-bundle',
      iceCandidatePoolSize: 0,
    });
  });
});
