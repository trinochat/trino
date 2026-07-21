import { readFile, writeFile } from 'node:fs/promises';
import process from 'node:process';
import * as openpgp from 'openpgp';

const options = parseArgs(process.argv.slice(2));
if (!options.key || !options.input || !options.output) {
  console.error(
    'Usage: npm run updates:sign -- --key private-key.asc --input announcements.json --output public/updates/feed.json [--pubout public/updates/public-key.asc] [--seq N]',
  );
  process.exit(2);
}

const passphrase = process.env.TRINO_UPDATES_KEY_PASSPHRASE;
if (!passphrase) {
  console.error('TRINO_UPDATES_KEY_PASSPHRASE is required');
  process.exit(2);
}

const privateKeyArmored = await readFile(options.key, 'utf8');
const input = JSON.parse(await readFile(options.input, 'utf8'));

// The client refuses a feed whose `seq` is lower than the highest it has already
// accepted, so an old-but-validly-signed feed can't be replayed to suppress a
// security notice. `seq` MUST live inside the signed payload — that's the point.
// Defaults to the current unix time, which is monotonic for free.
const seq =
  options.seq === undefined ? Math.floor(Date.now() / 1000) : Number(options.seq);
if (!Number.isSafeInteger(seq) || seq < 0) {
  console.error(`--seq must be a non-negative integer, got: ${options.seq}`);
  process.exit(2);
}
const payload = JSON.stringify({ ...input, seq });

const privateKey = await openpgp.readPrivateKey({
  armoredKey: privateKeyArmored,
});
const signingKey = await openpgp.decryptKey({
  privateKey,
  passphrase,
});
const message = await openpgp.createMessage({ text: payload });
const signature = await openpgp.sign({
  message,
  signingKeys: signingKey,
  detached: true,
  format: 'armored',
});

await writeFile(
  options.output,
  `${JSON.stringify({ payload, signature }, null, 2)}\n`,
  'utf8',
);
console.log(`Signed announcement feed written to ${options.output} (seq=${seq})`);

// Emitting the public key from the same private key keeps the pair in sync — a
// mismatched pair is the most common way to ship a feed nobody can verify.
if (options.pubout) {
  await writeFile(options.pubout, `${signingKey.toPublic().armor()}\n`, 'utf8');
  console.log(`Public key written to ${options.pubout}`);
}

// The client pins this. Paste it into PINNED_SIGNER_FINGERPRINT in
// src/lib/announcements.ts — until you do, the app trusts NO fetched feed.
const fingerprint = signingKey.getFingerprint().toUpperCase();
console.log(
  `\nSigner fingerprint (pin this in src/lib/announcements.ts):\n  ${fingerprint}\n`,
);

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
