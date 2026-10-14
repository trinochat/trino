// Signs the news feed ("Novedades de Trino") with the "Trino Updates" key,
// through GnuPG (Tor design §7, R-06). The app checks it in Rust with rPGP
// against the public key built into the program
// (crates/trino-net/src/news/trino-updates.asc), never one from the network.
//
// The private key stays in GnuPG: this script never reads it, never takes a
// passphrase, and gpg asks for it in its own window (pinentry). A key kept as
// a file is imported once with `gpg --import`.
//
// Usage:
//   npm run updates:sign -- --input announcements.json --output feed.json
//     [--latest 0.2.0] [--valid-days 45] [--seq N]
//     [--local-user <fingerprint>] [--gnupghome <folder>]
//
// What it signs, inside the payload:
// - `seq`: the app refuses a feed lower than the highest it has seen, so an
//   old feed, validly signed, cannot be replayed. Default: the time now, in
//   seconds, which only grows.
// - `latest`: the newest version published. Default: package.json's. An app
//   that sees a `latest` no mirror offers warns that updates are held back.
// - `validUntil`: until when this feed counts as current, in seconds since
//   1970. After it, the app warns that it could not check for new versions:
//   re-sign the feed before then (the monthly release does). Default: 45 days
//   from now.
import { spawnSync } from 'node:child_process';
import { readFile, rm, writeFile } from 'node:fs/promises';
import process from 'node:process';

/** The "Trino Updates" key the app pins (crates/trino-net/src/news/mod.rs). */
const TRINO_UPDATES = '4DE8E4BC5872E37566FA4114A62EE5607F666A6B';
const DAY = 24 * 60 * 60;

const options = parseArgs(process.argv.slice(2));
if (!options.input || !options.output) {
  console.error(
    'Usage: npm run updates:sign -- --input announcements.json --output feed.json [--latest X.Y.Z] [--valid-days N] [--seq N] [--local-user FPR] [--gnupghome DIR]',
  );
  process.exit(2);
}

const now = Math.floor(Date.now() / 1000);
const seq = integer(options.seq ?? String(now), '--seq');
const validDays = integer(options['valid-days'] ?? '45', '--valid-days');
if (validDays < 1) fail('--valid-days must be at least 1');
const latest =
  options.latest ??
  JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).version;
if (!/^\d{1,9}\.\d{1,9}\.\d{1,9}$/.test(latest)) {
  fail(`--latest must be a version like 0.2.0, got: ${latest}`);
}
const signer = (options['local-user'] ?? TRINO_UPDATES).replace(/\s+/g, '').toUpperCase();
if (!/^[0-9A-F]{40}$/.test(signer)) fail('--local-user must be a 40-digit fingerprint');

const input = JSON.parse(await readFile(options.input, 'utf8'));
if (!Array.isArray(input.announcements)) fail('the input has no "announcements" list');
const payload = JSON.stringify({
  ...input,
  seq,
  latest,
  validUntil: now + validDays * DAY,
});

const gnupghome = options.gnupghome ? ['--homedir', options.gnupghome] : [];
// `!` makes gpg sign with that exact key, the primary one, never a subkey:
// the app verifies against the primary key only.
const signed = gpg(
  [...gnupghome, '--batch', '--pinentry-mode', 'ask', '--armor', '--detach-sign',
    '--local-user', `${signer}!`, '--output', '-'],
  payload,
);
if (signed.status !== 0) fail(`gpg could not sign:\n${signed.stderr}`);
const signature = signed.stdout;

// Read the signature back before writing anything: a good signature by the
// primary key the app pins (or the one asked for), over these exact bytes.
const checkFile = `${options.output}.check-signature.asc`;
await writeFile(checkFile, signature, 'utf8');
const checked = gpg([...gnupghome, '--batch', '--status-fd', '1', '--verify', checkFile, '-'], payload);
await rm(checkFile, { force: true });
const validsig = checked.stdout
  .split('\n')
  .find(line => line.startsWith('[GNUPG:] VALIDSIG '));
// VALIDSIG <signing key> <date> <time> <expiry> <version> <reserved>
// <algorithm> <hash> <class> <primary key>.
const fields = validsig?.split(' ') ?? [];
if (checked.status !== 0 || fields[2] !== signer || fields[11] !== signer) {
  fail(`the signature does not check out as ${signer}:\n${checked.stdout}${checked.stderr}`);
}

await writeFile(
  options.output,
  `${JSON.stringify({ payload, signature }, null, 2)}\n`,
  'utf8',
);
console.log(
  `Signed news feed written to ${options.output}\n  seq=${seq} latest=${latest} validUntil=${new Date(
    (now + validDays * DAY) * 1000,
  ).toISOString()}\n  signer=${signer}`,
);

function gpg(args, stdin) {
  return spawnSync(options.gpg ?? 'gpg', args, { input: stdin, encoding: 'utf8' });
}

function integer(value, flag) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) {
    fail(`${flag} must be a non-negative integer, got: ${value}`);
  }
  return number;
}

function fail(message) {
  console.error(message);
  process.exit(2);
}

function parseArgs(args) {
  const result = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (!key?.startsWith('--') || !value) continue;
    result[key.slice(2)] = value;
  }
  return result;
}
