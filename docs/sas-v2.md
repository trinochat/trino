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

### Why the call SAS covers the identities

In 0.1.0 the call SAS hashed only the two DTLS fingerprints. A relay that
passes both fingerprints through unchanged makes that SAS match without
proving anything about who is on the other end, so "they match, mark as
verified" was not sound. In v2 the call SAS also covers both identity digests
and the call id. If the symbols match on both sides, each side holds the
other's real identity key, and the media path has nobody in the middle. That
is why "They match" in a call may mark the contact as verified
(`verified:<handle>` with the current fingerprint).

The `trino-sas-call-v2` and `trino-sas-contact-v2` prefixes keep the two
derivations apart: the same two people get different symbols for a call and
for their contact check.

## Symbols

`assets/sas/sas-v2.json`:

```json
{
  "version": 2,
  "source": "lucide-react@0.468.0",
  "viewBox": "0 0 24 24",
  "strokeWidth": 2,
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

**How to draw a symbol** (any platform):

- no fill (`fill="none"`), except the nodes that say `fill="currentColor"`;
- stroke in the **text colour** (`currentColor` on the web), width 2 in
  viewBox units, scaled with the icon;
- **round line caps and round line joins.** This is not cosmetic: several
  icons draw dots as zero-length segments (`M8 14v.5`, `M16 8h.01`), which
  only show with round caps;
- always show the word next to or under the icon, in the app's language.
  Screen readers read the words; the icons are hidden from them.

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
  one of them arrives with CR line endings or a BOM. The drawings follow the rules under
  [Symbols](#symbols); a platform draws the nodes itself (Flutter: parse the
  path data and stroke it) rather than substituting a look-alike icon font.
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
  "They don't match" text above.

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

The tests cover: the golden vectors and the invalid inputs; that the order of
A and B does not matter; that a call and a contact give different symbols;
that the result is 7 indices below 64 taken as `d[i] >> 2`; that changing any
single input changes the result; that the table is exactly the frozen one,
with 64 different icons and 64 different words per language, each with a
capital first letter; that none of the forbidden icons is in it; and that the
committed JSON and licence notice match the generator.

## Licence

The icon drawings come from [Lucide](https://lucide.dev) (lucide-react
0.468.0) under the ISC License; portions are from Feather (MIT). The notice is
in `assets/sas/LICENSE-lucide.txt`. The words, the derivation and the rest of
this spec are part of Trino and under its licence.
