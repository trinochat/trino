# Test certificates

Made with OpenSSL on 14 Oct 2026 for the tests of `src/http.rs`, and used only
by `src/mock_http.rs` (feature `test-util`):

- `ca.der`: a P-256 CA, "Trino test CA (tests only)", valid for 100 years.
- `leaf.der`: a server certificate the CA signed for `*.trino.invalid`,
  `*.cdn.trino.invalid`, `trinochat.org` and `*.trinochat.org`.
- `leaf.key.der`: its private key (PKCS#8).

The CA's own key was not kept. Nothing outside a test trusts this CA: the
app's HTTP client checks servers against the web's roots (webpki-roots), and a
test checks that it refuses this certificate.
