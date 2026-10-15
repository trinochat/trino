// The monthly Arti routine (Tor design §6.6), for
// .github/workflows/arti-monthly.yml. It only reads and reports:
//
//   node scripts/arti-monthly.mjs versions    # arti-client and saturating-time:
//                                             # in Cargo.lock and on crates.io,
//                                             # as `json=<…>` for GITHUB_OUTPUT
//   node scripts/arti-monthly.mjs drop-patch  # takes the saturating-time entry
//                                             # out of the root Cargo.toml, in
//                                             # the runner's checkout only
//   node scripts/arti-monthly.mjs locked <crate>   # its version in Cargo.lock
//   node scripts/arti-monthly.mjs report      # the summary, from VERSIONS,
//                                             # SMOKE and UNPATCHED
//
// `report` writes GITHUB_STEP_SUMMARY and exits 1 when something needs David
// (a new Arti, or the patch no longer needed), so GitHub tells him; that is
// not an error in the code.

import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PATCH_LINE = /^saturating-time = \{ path = "vendor\/saturating-time" \}\r?\n/m;

/** The version of `name` in a Cargo.lock, or null. */
export function lockedVersion(lockText, name) {
  const blocks = lockText.split(/\r?\n\[\[package\]\]\r?\n/);
  for (const block of blocks) {
    const n = /^name = "([^"]+)"/m.exec(block);
    const v = /^version = "([^"]+)"/m.exec(block);
    if (n && v && n[1] === name) return v[1];
  }
  return null;
}

/** The `[package]` version of a Cargo.toml. */
export function manifestVersion(manifestText) {
  const pkg = manifestText.split(/^\[package\]\s*$/m)[1] ?? '';
  const v = /^version = "([^"]+)"/m.exec(pkg);
  if (!v) throw new Error('no [package] version');
  return v[1];
}

/** The newest stable version, from crates.io's answer for a crate. */
export function stableVersion(json) {
  const v = JSON.parse(json)?.crate?.max_stable_version;
  if (typeof v !== 'string' || !/^\d+\.\d+\.\d+$/.test(v)) {
    throw new Error('crates.io gave no stable version');
  }
  return v;
}

/** Whether version `a` is newer than `b` (x.y.z, by number). */
export function isNewer(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] > pb[i];
  }
  return false;
}

/** The root Cargo.toml without the saturating-time patch entry. */
export function dropPatch(manifestText) {
  if (!PATCH_LINE.test(manifestText)) {
    throw new Error('no saturating-time patch in Cargo.toml');
  }
  return manifestText.replace(PATCH_LINE, '');
}

/**
 * The month's summary. `smoke` is the outcome of Arti's Windows smoke test
 * built without the patch ('success', 'failure', or '' when it did not run).
 */
export function report({ arti, saturating, smoke }) {
  const lines = ['## Arti, monthly routine', ''];
  let attention = false;
  const known = (v) => typeof v === 'string' && v !== '';

  lines.push('| | In Trino | On crates.io |', '|---|---|---|');
  lines.push(`| arti-client | ${arti.current || '?'} | ${arti.latest || '?'} |`);
  lines.push(`| saturating-time | ${saturating.vendored || '?'} (vendored, patched) | ${saturating.latest || '?'} |`);
  lines.push('');

  if (!known(arti.latest) || !known(saturating.latest)) {
    attention = true;
    lines.push('- **Check by hand:** could not read a version from crates.io.');
  }
  if (known(arti.latest) && known(arti.current) && isNewer(arti.latest, arti.current)) {
    attention = true;
    lines.push(
      `- **New arti-client ${arti.latest}.** Do the monthly update (docs/tor.md, ` +
        '"La rutina de cada mes"): `cargo upgrade` in Cargo.toml, not only the ' +
        'lock, and the network smoke test by hand.',
    );
  } else if (known(arti.latest)) {
    lines.push('- arti-client is current.');
  }

  if (smoke === 'success') {
    attention = true;
    lines.push(
      `- **The saturating-time patch is no longer needed:** Arti started on Windows ` +
        `without it, with saturating-time ${saturating.unpatched || '?'}. Drop ` +
        '`vendor/saturating-time` and the `[patch.crates-io]` entry (vendor/README.md).',
    );
  } else if (smoke === 'failure') {
    lines.push(
      `- The saturating-time patch is still needed: without it, Arti does not start ` +
        `on Windows (saturating-time ${saturating.unpatched || '?'}).`,
    );
  } else {
    attention = true;
    lines.push('- **The Windows check without the patch did not run**: see the job log.');
  }

  if (
    known(saturating.latest) &&
    known(saturating.vendored) &&
    isNewer(saturating.latest, saturating.vendored) &&
    smoke !== 'success'
  ) {
    attention = true;
    lines.push(
      `- saturating-time ${saturating.latest} is out. If this Arti cannot take it ` +
        'yet, the next arti-client may; look at it in the monthly update.',
    );
  }
  lines.push(
    '',
    'The upstream report (anonticket, pending moderation) is checked by hand. ' +
      'This workflow only reports: it changes nothing in the repository.',
  );
  return { attention, markdown: lines.join('\n') + '\n' };
}

async function crate(name) {
  const res = await fetch(`https://crates.io/api/v1/crates/${name}`, {
    // crates.io asks every client for a User-Agent that says who it is.
    headers: { 'User-Agent': `trino-ci (https://github.com/${process.env.GITHUB_REPOSITORY ?? 'trinochat'})` },
  });
  return stableVersion(await res.text());
}

async function main([command, arg]) {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const read = (path) => readFileSync(root + path, 'utf8');
  switch (command) {
    case 'versions': {
      const lock = read('Cargo.lock');
      const out = {
        arti: { current: lockedVersion(lock, 'arti-client') ?? '', latest: '' },
        saturating: { vendored: manifestVersion(read('vendor/saturating-time/Cargo.toml')), latest: '' },
      };
      try {
        out.arti.latest = await crate('arti-client');
        out.saturating.latest = await crate('saturating-time');
      } catch (e) {
        console.error(`arti-monthly: ${e.message}`);
      }
      console.log(`json=${JSON.stringify(out)}`);
      return 0;
    }
    case 'drop-patch':
      writeFileSync(root + 'Cargo.toml', dropPatch(read('Cargo.toml')));
      return 0;
    case 'locked':
      console.log(lockedVersion(read('Cargo.lock'), arg) ?? '');
      return 0;
    case 'report': {
      const versions = JSON.parse(process.env.VERSIONS || '{"arti":{},"saturating":{}}');
      versions.saturating.unpatched = process.env.UNPATCHED ?? '';
      const r = report({ ...versions, smoke: process.env.SMOKE ?? '' });
      console.log(r.markdown);
      if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, r.markdown);
      if (r.attention) console.log('Not an error: something above needs a look.');
      return r.attention ? 1 : 0;
    }
    default:
      console.error('usage: arti-monthly.mjs versions | drop-patch | locked <crate> | report');
      return 2;
  }
}

// Run as a program, not imported by the tests.
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  process.exitCode = await main(process.argv.slice(2));
}
