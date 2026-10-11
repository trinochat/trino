# SAS v2: verification symbols

The short authentication string (SAS) is what two people compare, out loud or
side by side, to check that nobody sits between them. Version 2 shows **7
outline icons, each with a word**, instead of the emojis of 0.1.0. The same
spec, the same symbol table and the same test vectors serve the desktop app,
the mobile app and the website.

Files:

| File | What it is |
|---|---|
| `assets/sas/sas-v2.json` | The 64 symbols: icon drawing and word in es, en, pt. Generated, committed. |
| `assets/sas/vectors.json` | Golden vectors for both derivations, from an independent implementation. |
| `assets/sas/LICENSE-lucide.txt` | The ISC notice of Lucide, which the drawings come from. |
| `scripts/gen-sas-assets.mjs` | Builds `sas-v2.json` and the notice from `lucide-react@0.468.0`. |
| `scripts/sas_vectors.py` | Builds `vectors.json` with Python `hashlib`. |
| `src/lib/sas.ts` | The derivation (WebCrypto). |
| `src/lib/sas-symbols.ts` | Loads the table; lookups by index and language. |
| `src/lib/SasSymbol.tsx` | `SasIcon` (the icon alone) and `SasSymbol` (icon and word). |

## Derivation

There are two SAS: one for a **call**, one for a **contact** (verifying the
keys of someone you chat with).

```
call:    d = SHA-256( "trino-sas-call-v2" 0x00 callId
                      0x00 min(idA, idB)    0x00 max(idA, idB)
                      0x00 min(dtlsA, dtlsB) 0x00 max(dtlsA, dtlsB) )

contact: d = SHA-256( "trino-sas-contact-v2" 0x00 min(idA, idB) 0x00 max(idA, idB) )

indices[i] = d[i] >> 2,  for i = 0..6
```

- Every part is encoded as UTF-8 (in practice all of it is ASCII) and the
  parts are joined by a single `0x00` byte. There is no trailing separator.
- `idA`, `idB`: identity digests (the backend's `identity_digest`: SHA-256 of
  the identity signing key, the identity DH key and the Nostr key), as **64
  lowercase hex digits**. One is mine; the other is the contact's **as I saved
  it**, not as the peer claims it now.
- `dtlsA`, `dtlsB`: the DTLS `sha-256` fingerprints of the local and remote
  SDP, as `parseFp` in `src/lib/call.ts` gives them: **64 lowercase hex
  digits, without colons**.
- `callId`: the call's id as `call.ts` accepts it: 16 to 64 characters of
  `A-Z a-z 0-9 _ -`.
- `min` and `max` compare the strings by plain ASCII order. Sorting makes the
  result independent of who is A and who is B, so both sides compute the same
  thing.
- Each index is the top 6 bits of one digest byte. 256 / 64 = 4, so every
  symbol is equally likely: 7 symbols × 6 bits = **42 bits**.

**Inputs in any other form are refused**, never normalised (`SasInputError`
in TypeScript). Upper-case hex, colons, wrong lengths and call ids outside the
rule above are bugs in the caller; deriving symbols from them would only show
two people a mismatch nobody can explain. `vectors.json` lists such inputs
under `invalid`, and every implementation must reject all of them.

### What a match proves, and how much

In 0.1.0 the call SAS hashed only the two DTLS fingerprints. A relay that
passes both fingerprints through unchanged makes that SAS match without
proving anything about who is on the other end, so "they match, mark as
verified" was not sound. In v2 the call SAS also covers both identity digests
and the call id, so a match speaks about the keys as well as the media path.

A SAS is short (42 bits) and nothing is committed before it is shown, so a
match is a bound on the attacker's work, not a proof. The two derivations
give very different bounds:

- **Call SAS: about 2^42 work, in real time, for each call.** The DTLS
  certificates are new for every call (`call.ts` builds the
  `RTCPeerConnection` without `certificates`), so nothing can be prepared in
  advance. Someone in the middle must give one side her fingerprint before
  that side answers with its own fresh one; only then can she search for a
  fingerprint for the other side that gives the same 7 symbols. That is a
  search over about 2^42 certificates while the call rings
  (`RING_TIMEOUT_MS`, 45 s), which takes on the order of tens of high-end
  GPUs (if the DTLS stack only matches the fingerprint and does not check
  the certificate's self-signature; more if it does). A failed attempt shows
  two people different symbols. So a match means, within that margin, that
  each side holds the other's real identity key and the media path has
  nobody in the middle.
  - The bound assumes that neither fingerprint changes after the first
    answer. If a renegotiation could carry new fingerprints on both legs,
    the attacker would choose both and the search would fall to a birthday
    search of about 2^21 per leg. So no match may outlive a change of the
    remote fingerprint: see [The DTLS fingerprint rule](#the-dtls-fingerprint-rule).
- **Contact SAS: about 2^21 work, offline.** Its only inputs are the two
  identity digests: static, with nothing fresh and nothing committed. Someone
  who swaps both contact codes during the exchange gives Alice an identity X
  posing as Bob and Bob an identity Y posing as Alice, and picks X and Y
  herself. She needs the 42 bits of SAS(idA, X) and SAS(idB, Y) to agree,
  which a birthday search finds after about 2^21 identities per side: a few
  million key generations and hashes, minutes on a laptop, all before anyone
  compares. Alice and Bob then see the same 7 symbols while each holds her
  key.

The `trino-sas-call-v2` and `trino-sas-contact-v2` prefixes keep the two
derivations apart: the same two people get different symbols for a call and
for their contact check.

### How a contact gets verified

Decided on 10 Oct 2026, for the desktop app, the mobile app and the website
alike. A contact is marked as verified in only two ways:

1. **"They match" on a call's SAS.** It writes `verified:<handle>` with the
   contact's current fingerprint, under [The DTLS fingerprint
   rule](#the-dtls-fingerprint-rule).
2. **Scanning, in person, a QR code with the full identity digest** (at
   least 128 bits). Only a platform with a camera offers it; the desktop
   app cannot scan, so no desktop screen shows this way.

The **contact SAS is a quick check** and never verifies: its 7 symbols come
with no "They match" button, and comparing them never writes
`verified:<handle>`. At about 2^21 offline work (above) a match cannot
carry a verification; 0.1.0's 6 emojis (36 bits) had the same weakness. No
copy presents the contact's symbols, or any short key, as a way to verify:
the way to verify a contact is to call them and compare the call's
symbols.

Deriving the contact SAS from a commit-then-reveal exchange of fresh nonces
inside the app, as ZRTP does, would make the contact's symbols strong
enough to verify. It was set aside: it would be a protocol addition and a
third derivation. The decision changes nothing in this spec's derivations
or vectors.

### The DTLS fingerprint rule

A requirement for every call screen, on every platform. If the remote DTLS
fingerprint changes during a call (the same call id, another fingerprint
after the first answer):

- **the call ends**, and the person is told that the connection's key
  changed and that they should call again and compare the symbols again;
- **a verification made during that call is undone:** if the contact was
  not verified when the call started and "They match" was pressed in it,
  `verified:<handle>` is cleared. A contact verified before the call keeps
  its mark, which came from an earlier call or a QR scan.

## Symbols

`assets/sas/sas-v2.json`:

```json
{
  "version": 2,
  "source": "lucide-react@0.468.0",
  "viewBox": "0 0 24 24",
  "strokeWidth": 2,
  "fill": "none",
  "strokeLinecap": "round",
  "strokeLinejoin": "round",
  "symbols": [
    { "index": 0, "lucide": "Cat",
      "nodes": [["path", {"d": "M12 5c.67 ..."}], ["path", {"d": "M8 14v.5"}]],
      "words": {"es": "Gato", "en": "Cat", "pt": "Gato"} }
  ]
}
```

- `symbols[i]` is the symbol for index `i`, 0 to 63.
- `nodes` are SVG elements, `[tag, attributes]`, drawn in order inside a
  `viewBox` of `0 0 24 24`. Tags are `path`, `circle`, `ellipse`, `rect`,
  `line`, `polyline` and `polygon`. The attributes are geometry only, plus
  `fill="currentColor"` on a few solid dots (the sound hole of Guitar).

**How to draw a symbol** (any platform). The top-level `strokeWidth`,
`fill`, `strokeLinecap` and `strokeLinejoin` of the JSON are lucide's own
drawing rules; read them from the file instead of relying on a platform's
defaults (Flutter's are butt caps, miter joins and a black fill):

- no fill (`fill: "none"`), except the nodes that say `fill="currentColor"`;
- stroke in the **text colour** (`currentColor` on the web), width
  `strokeWidth` (2) in viewBox units, scaled with the icon;
- **round line caps and round line joins** (`strokeLinecap` and
  `strokeLinejoin`: `"round"`). This is not cosmetic: several icons draw
  dots as zero-length segments (`M8 14v.5`, `M16 8h.01`; the pips of Dice5,
  the chips of Cookie, the eyes of Bird, Rabbit and Squirrel), which only
  show with round caps;
- always show the word next to or under the icon, in the app's language.
  Screen readers read the words; the icons are hidden from them. The word
  carries its language (`lang` on the web), so a screen reader uses the
  right voice even when it differs from the app's language;
- **size the icon with the text**, never in fixed pixels: `em` or `rem` on
  the web (`SasIcon` defaults to `1.25em`, 20 px at 16 px text), the text
  scaler on mobile. A larger text setting must make the icons grow with
  their words;
- **at 100 % text size, never below 20 px** wherever two people compare
  symbols, the small key at the top of a call included, and **28 px** in
  the comparison panel and the contact verification dialog. At 16 px
  several icons look alike: Gato/Perro, Pluma/Hoja, Limón/Pizza,
  Galleta/Brújula, Pino/Carpa/Montaña and the rounded boxes
  Tren/Mochila/Reloj/Leche; the dots of Dado and Galleta are about one
  pixel.

Some Spanish words are close when read aloud: Fuego/Huevo most of all, then
Uvas/Huevo, Martillo/Castillo, Limón/Sillón, Camión/Avión and Luna/Pluma.
A confused pair lets two SAS that differ only in those symbols pass as a
match, a small loss against an attacker who aims for such a pair. Showing
each icon with its word keeps the confusion unlikely; changing the words
would be a new table (SAS v3).

The table is part of the human protocol, so it lives outside i18n and is
**frozen**: changing an icon, a word or the order is a new SAS version, not an
edit. The selection rules: no icon that means something in the UI (phone,
microphone, lock, key, shield, bell...); nothing violent, medical,
creepy-crawly or about death; `Flower2` rather than `Flower`, which looks like
`Sun`; nothing called `Map`. Three entries of the first draft were replaced:
`Shell` "Concha" (rude in parts of Latin America) by `Banana` "Banano",
`PawPrint` "Huella" (heard as "Huevo") by `Candy` "Dulce", and `Snowflake`
"Nieve" (heard as "Nube") by `Citrus` "Limón".

### The table

| # | Lucide icon | es | en | pt |
|---|---|---|---|---|
| 0 | Cat | Gato | Cat | Gato |
| 1 | Dog | Perro | Dog | Cachorro |
| 2 | Fish | Pez | Fish | Peixe |
| 3 | Bird | Pájaro | Bird | Pássaro |
| 4 | Rabbit | Conejo | Rabbit | Coelho |
| 5 | Turtle | Tortuga | Turtle | Tartaruga |
| 6 | Snail | Caracol | Snail | Caracol |
| 7 | Squirrel | Ardilla | Squirrel | Esquilo |
| 8 | Banana | Banano | Banana | Banana |
| 9 | Feather | Pluma | Feather | Pena |
| 10 | Candy | Dulce | Candy | Doce |
| 11 | TreePine | Pino | Pine tree | Pinheiro |
| 12 | TreePalm | Palmera | Palm tree | Palmeira |
| 13 | Flower2 | Flor | Flower | Flor |
| 14 | Leaf | Hoja | Leaf | Folha |
| 15 | Clover | Trébol | Clover | Trevo |
| 16 | Mountain | Montaña | Mountain | Montanha |
| 17 | Sun | Sol | Sun | Sol |
| 18 | Moon | Luna | Moon | Lua |
| 19 | Star | Estrella | Star | Estrela |
| 20 | Cloud | Nube | Cloud | Nuvem |
| 21 | Citrus | Limón | Lemon | Limão |
| 22 | Rainbow | Arcoíris | Rainbow | Arco-íris |
| 23 | Zap | Rayo | Lightning | Raio |
| 24 | Flame | Fuego | Fire | Fogo |
| 25 | Umbrella | Paraguas | Umbrella | Guarda-chuva |
| 26 | Milk | Leche | Milk | Leite |
| 27 | Cherry | Cereza | Cherry | Cereja |
| 28 | Carrot | Zanahoria | Carrot | Cenoura |
| 29 | Grape | Uvas | Grapes | Uvas |
| 30 | Pizza | Pizza | Pizza | Pizza |
| 31 | Coffee | Café | Coffee | Café |
| 32 | IceCreamCone | Helado | Ice cream | Sorvete |
| 33 | Egg | Huevo | Egg | Ovo |
| 34 | Cookie | Galleta | Cookie | Biscoito |
| 35 | Popcorn | Crispetas | Popcorn | Pipoca |
| 36 | Soup | Sopa | Soup | Sopa |
| 37 | Bike | Bicicleta | Bicycle | Bicicleta |
| 38 | Truck | Camión | Truck | Caminhão |
| 39 | TrainFront | Tren | Train | Trem |
| 40 | Plane | Avión | Plane | Avião |
| 41 | Sailboat | Velero | Sailboat | Veleiro |
| 42 | Rocket | Cohete | Rocket | Foguete |
| 43 | Anchor | Ancla | Anchor | Âncora |
| 44 | Guitar | Guitarra | Guitar | Violão |
| 45 | Drum | Tambor | Drum | Tambor |
| 46 | Watch | Reloj | Watch | Relógio |
| 47 | Shirt | Camisa | Shirt | Camisa |
| 48 | Glasses | Gafas | Glasses | Óculos |
| 49 | Crown | Corona | Crown | Coroa |
| 50 | Gift | Regalo | Gift | Presente |
| 51 | House | Casa | House | Casa |
| 52 | Castle | Castillo | Castle | Castelo |
| 53 | Tent | Carpa | Tent | Barraca |
| 54 | Book | Libro | Book | Livro |
| 55 | Scissors | Tijeras | Scissors | Tesoura |
| 56 | Dice5 | Dado | Dice | Dado |
| 57 | Trophy | Trofeo | Trophy | Troféu |
| 58 | Compass | Brújula | Compass | Bússola |
| 59 | Magnet | Imán | Magnet | Ímã |
| 60 | Hammer | Martillo | Hammer | Martelo |
| 61 | Gem | Diamante | Diamond | Diamante |
| 62 | Backpack | Mochila | Backpack | Mochila |
| 63 | Armchair | Sillón | Armchair | Poltrona |

`sas-v2.json` is the source of truth; this copy is checked against it by
`src/lib/sas-symbols.test.ts`.

## Compatibility with 0.1.0

- **Nothing changes on the wire, and nothing may.** No version field is added
  to the call signals: `parseSignal` in 0.1.0 rejects unknown keys
  (`call.ts`), and trino-core uses `deny_unknown_fields` (`call_signal.rs`).
- **The change breaks at the human level.** A peer on 0.1.0 (or on the test
  build `d8746ff`) shows 5 emojis; a peer on v2 shows 7 icons with words. They
  **never match**, and since no version is exchanged, the app cannot tell.
  - The "They don't match" text says: hang up and call again; if your contact
    has not updated Trino, they will see other symbols, so both should update
    and compare again.
  - The release announcement says so too.
- **The contact SAS changes as well**, from 6 emojis to 7 icons. Existing
  `verified:<handle>` marks stay valid, because they store the fingerprint,
  not the SAS.
- The copy changes from "Compare these emojis" to "Compare these symbols".

## One table, three platforms

The desktop app, the mobile app (`apps/mobile`) and the website must show the
same symbol for the same index, or two people comparing them will see a
mismatch that is not there.

- **Same table.** Every platform draws from `assets/sas/sas-v2.json`, never
  from its own icon set or its own copy of the words. Where a platform cannot
  read the file in place (Flutter only bundles assets inside its package), it
  keeps a **byte-identical copy** (LF line endings) and a test that compares
  the copy with this one. `.gitattributes` pins the SAS files to LF on every
  checkout, whatever `core.autocrlf` says, and `sas-symbols.test.ts` fails if
  one of them arrives with CR line endings or a BOM.
- **Same drawing.** The drawings follow the rules under
  [Symbols](#symbols). A platform draws the nodes itself (Flutter: parse the
  path data and stroke it) rather than substituting a look-alike icon font,
  and takes `fill`, `strokeWidth`, `strokeLinecap` and `strokeLinejoin` from
  the JSON. Its tests check that its painter uses those values.
- **Same derivation.** Every implementation of the derivation must pass every
  vector in `assets/sas/vectors.json`: the same digest and the same 7 indices
  for each `call` and `contact` vector, and a refusal for every `invalid`
  input. The vectors include swapped A/B pairs, equal values, values that
  differ in one digit, all-zero and all-`f` values, and the shortest and
  longest call ids. The invalid ones include call ids of a valid length with
  a single character outside the set (`.`, `~` and the standard base64 `+`,
  `/`, `=`), so a port cannot accept a looser alphabet than `call.ts`.
- **Same licence notice.** Ship `LICENSE-lucide.txt` (or its text) wherever
  the drawings go, including the website.
- **Same presentation rules:** 7 symbols in order, each icon with its word in
  the reader's language; one accessible label that reads the 7 words; the
  "They don't match" text above; the sizes under [Symbols](#symbols), which
  grow with the text size.

## Regenerating and checking

```sh
node scripts/gen-sas-assets.mjs      # assets/sas/sas-v2.json and LICENSE-lucide.txt
python -I scripts/sas_vectors.py     # assets/sas/vectors.json
npx vitest run src/lib/sas.test.ts src/lib/sas-symbols.test.ts src/lib/SasSymbol.test.tsx
```

Both scripts are deterministic: on an unchanged tree they rewrite the files
byte for byte. The generator refuses to run against any lucide-react other
than 0.468.0, and the drift test rebuilds the table in memory and fails if the
committed file differs. Upgrading lucide-react therefore cannot change the
symbols by accident; if new drawings are ever wanted, that is SAS v3.

The app draws from the committed JSON, not from lucide-react, so the rest of
the app may upgrade lucide-react for its own icons. Then only the drift check
is skipped, and the test run says so (`drift check skipped: lucide-react X is
installed`); the committed JSON and the hand-kept copy of the table in
`sas-symbols.test.ts` remain the guard. Regenerating needs 0.468.0 again.

The tests cover: the golden vectors and the invalid inputs, including one
right-length call id for each character outside the set; that the order of
A and B does not matter; that a call and a contact give different symbols;
that the result is 7 indices below 64 taken as `d[i] >> 2`; that changing any
single input changes the result; that the table is exactly the frozen one,
with 64 different icons and 64 different words per language, each with a
capital first letter; that none of the forbidden icons is in it; that it
carries the drawing rules; that the committed JSON and licence notice match
the generator; that the shared files arrive with LF only; and that the icon
sizes with the text and the word carries its language.

## Licence

The icon drawings come from [Lucide](https://lucide.dev) (lucide-react
0.468.0) under the ISC License; portions are from Feather (MIT). The notice is
in `assets/sas/LICENSE-lucide.txt`. The words, the derivation and the rest of
this spec are part of Trino and under its licence.
