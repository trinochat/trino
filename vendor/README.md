# Vendored crates

Copies of crates.io crates that Trino builds with a fix of its own, through
`[patch.crates-io]` in the root `Cargo.toml`. Each one is the published
crate, unchanged but for the lines its diff here shows. The workspace
excludes this folder, so its crates are not built, linted or formatted as
Trino's own.

## saturating-time 0.5.0

- **Why:** Arti 0.47 (Trino's Tor) does not start on Windows as it comes from
  crates.io. `saturating-time` looks for the smallest `SystemTime` with steps
  down to 1 ns, and on Windows a `SystemTime` moves in 100 ns steps, so
  subtracting less returns the same value and the search never ends. Arti
  then hangs at "15 %: fetching a consensus" with a core busy, since parsing
  the consensus is the first saturating operation (Tor spike S0, 14 Oct
  2026). It is still there in 0.5.0, the version Arti 0.47 uses, and was
  in 0.4.0; David reports it to Arti.
- **The patch** (`saturating-time.diff`, 4 lines and a comment marked `TRINO
  PATCH` in `src/internal.rs`): a step that leaves the value unchanged counts
  as one that fails, so the search narrows its step and ends. Measured in the
  spike: the real consensus parses in 93 ms, the test one in 0.3 ms.
- **The test:** `crates/trino-net/tests/arti_windows_smoke.rs` fails, on
  Windows, if this patch is lost or an Arti update brings the loop back. The
  CI's Windows job runs it.
- **Licence:** MIT OR Apache-2.0, as its `Cargo.toml` says (The Tor Project).
  The package on crates.io ships no licence files, so `LICENSE-MIT` and
  `LICENSE-APACHE` here are the standard texts of those two licences.
- **When to drop it:** at the monthly Arti update (Tor design §6.6), when a
  `saturating-time` release fixes the loop: remove this folder and the
  `[patch.crates-io]` entry, and the smoke test must still pass on Windows.
  The patch only applies to version 0.5.0; a newer one in `Cargo.lock` makes
  cargo warn that the patch is unused, which is the cue to look again.
- **Checked every month:** `.github/workflows/arti-monthly.yml` takes the
  patch out of its own checkout on Windows, updates saturating-time as far
  as Arti allows and runs the smoke test. Its summary says whether the patch
  is still needed. It only reports; dropping the patch is a commit of ours.
