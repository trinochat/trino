# Test data

`mdconsensus1.txt` is the microdescriptor consensus that ships with
`tor-netdoc` 0.47.0 as `testdata/mdconsensus1.txt` (The Tor Project, MIT OR
Apache-2.0, https://gitlab.torproject.org/tpo/core/arti), copied unchanged.
It is from 2020 and not a live consensus: `arti_windows_smoke.rs` only needs
something Arti parses the way it parses the real one, with no network.

It stays LF on every checkout (`.gitattributes` at the root), as the parser
expects.
