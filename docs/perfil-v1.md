# Profile v1 ("profile1"): name, photo and "about" for your contacts

Each side shares a name, a photo and an "about" with its contacts, end to end
encrypted like every other message: the profile is one more plaintext inside
the double ratchet of each contact. This file fixes the bytes, so the mobile
app and, later, trino-core can implement the same thing and pass the same
vectors.

The desktop implementation lives in `src-tauri/src/profile.rs`, not in
trino-core: changing the core takes a push and a new pin.

## Why it needs a gate

0.1.0 decodes plaintexts with trino-core's `decode_envelope`
(`envelope.rs`, identical at `1bac851` and `4ce6775`): an envelope whose `ty`
it does not know is shown **as raw JSON, as a text message**, while an extra
field in a `text`, `grp` or `file` envelope is ignored and the message shows
as usual. So a profile message must only ever reach a Trino that announced it
reads them, and the announcement rides in a field 0.1.0 ignores.

## The announcement

Every outgoing `text`, `grp` and `file` envelope gets one more field, last:

```
"prof":{"v":1,"have":N}
```

- `v`: the highest profile message version this Trino reads. Today `1`.
- `have`: the revision of **the recipient's** profile this Trino holds; `0`
  when it holds none. Group messages are encrypted per member, so each copy
  carries the `have` of its own recipient.
- `call`, `roster`, the handshake (`__trino_handshake__`) and profile
  messages never carry it.

The field goes in before the closing brace of the compact envelope, and every
byte before it stays as it was:

```
in   {"ty":"text","body":"hola","id":"m1"}               (have = 7)
out  {"ty":"text","body":"hola","id":"m1","prof":{"v":1,"have":7}}

in   {"ty":"grp","gid":"g1","ep":4,"body":"hola grupo"}  (have = 0)
out  {"ty":"grp","gid":"g1","ep":4,"body":"hola grupo","prof":{"v":1,"have":0}}
```

An envelope that already has `prof` goes out as it is. On the desktop, every
message to a contact is encrypted in one place, `seal_for` in
`src-tauri/src/commands.rs`, which adds the field there: no text, group or
file message goes out without it.

**Receiving** a `text`, `grp` or `file` envelope records what its sender
announced:

- `prof` is an object with an integer `v` ≥ 1 and an integer `have` ≥ 0: the
  sender reads profile messages up to version `v` and holds revision `have`
  of ours. Other fields inside `prof` belong to newer versions and are
  ignored.
- Anything else, or no `prof` at all: the sender reads none. It is an older
  version, or someone went back to one, so the record is **cleared**.
- Only the newest message counts, by the event's `created_at`: relays deliver
  in any order, and the catch-up after a restart often newest first. A
  message older than the last one recorded changes nothing.

## The profile message

```
{"ty":"profile","v":1,"rev":N,"name":"…","about":"…","photo":…}
```

Sent as compact UTF-8 JSON, keys in this order, non-ASCII as UTF-8 (not
`\u` escapes). Receivers accept the keys in any order.

| Field | Rule |
|---|---|
| `ty` | `"profile"` |
| `v` | `1` exactly |
| `rev` | integer ≥ 1. It only grows: each change takes the larger of the previous revision + 1 and the unix time in seconds. A Trino gives its profile a first revision (the unix time) the first time it opens with profiles, so contacts get it without waiting for an edit. |
| `name` | string; trimmed, 1 to 64 Unicode scalar values, of the characters below, at least one of them one that shows |
| `about` | string; trimmed, 0 to 140 Unicode scalar values, of the characters below; line breaks (U+000A) are allowed |
| `photo` | left out: the photo does not change. `null`: the photo is removed. Otherwise a `data:image/jpeg;base64,`, `data:image/png;base64,` or `data:image/webp;base64,` URL whose payload is standard, padded base64 of at most 20 480 bytes (20 KiB). |

A name or an "about" holds no control character (general category Cc; the
"about" may break lines with U+000A), no line or paragraph separator
(U+2028, U+2029) and no format character (Cf, as of Unicode 15.1) other than
U+200C ZERO WIDTH NON-JOINER and U+200D ZERO WIDTH JOINER, which emoji such as
👩‍💻 and scripts such as Persian need. The bidi controls (U+202A to U+202E,
U+2066 to U+2069) and the zero-width spaces are format characters: they could
make a name read as another, or as nothing. A character that shows is any
other than white space, a control or format character, a variation selector
(U+FE00 to U+FE0F, U+E0100 to U+E01EF), U+034F, the Hangul fillers (U+115F,
U+1160, U+3164, U+FFA0), U+17B4, U+17B5, the Mongolian variation selectors
(U+180B to U+180D, U+180F) and the blank Braille pattern (U+2800).

**Any other field, or any other `v`, makes the message invalid**: a new field
takes a new version. An invalid message is dropped in silence.

A receiver applies a valid message only when its `rev` is greater than the
revision it holds for that contact: it replaces the name and the "about", and
the photo as the `photo` field says. A profile message, valid or not, **never
goes further**: it is not a chat message, never enters the history and never
notifies. The name a contact gives itself never replaces the name the user
gave that contact; the app shows it next to it.

### Who gets it

- Only contacts whose newest `text`, `grp` or `file` message announced
  `v` ≥ 1, including contacts that came with a group's roster, and never
  blocked ones.
- After every change of name, photo or "about", in the background. A failed
  send never fails the change.
- Again when a contact that reads profiles announces a `have` lower than the
  current revision (it lost the message in the 24 h catch-up window, or a
  relay was down): once per session and revision, so a contact that cannot
  take it does not get it again with every message.
- A name kept from before profiles longer than 64 scalar values goes out cut
  to 64, and a name or an "about" kept from before the rules on characters
  goes out without the characters receivers refuse (a name with nothing left
  that shows goes as `anon`); a photo from before that a profile cannot carry
  (a GIF, or over 20 KiB) is left out, so contacts keep the photo of the
  contact code.

### Size

Relays drop events over 64 KB without a word, and the ratchet writes its
ciphertext in hex, so every byte of a message takes two on the wire. With the
largest photo (20 KiB, which base64 turns into 27 308 characters) the message
is about 27 KB of JSON, and the relay frame that carries it about 55 KB, or
57 102 bytes with a name and an "about" made entirely of characters four
bytes long in UTF-8, the longest JSON writes of any character they may hold.
Characters JSON escapes to six bytes are control characters, which they may
not hold; made of those, the frame would take 57 918 bytes. A test builds
both frames and keeps them under 60 KiB.

A photo of 24 KiB would not fit: its frame takes about 66 KB, 68 838 bytes in
the worst case.

## Storage on the desktop

The profiles live in the encrypted store of local encryption (cifrado
local): `~/.trino/store/profiles.bin` holds this identity's "about" and
revision, and for each contact the profile it shares and what it announced,
as JSON inside the store's envelope (`src-tauri/src/store/envelope.rs`):

```
header: "TRDAT\0" ‖ format 1 ‖ kind 5 ‖ key_gen ‖ id_vault ‖ nonce
‖ AES-256-GCM( seq ‖ length ‖ JSON ‖ zeros up to the next size step )

key = HKDF-SHA256( ikm  = the data key the vault carries,
                   salt = id_vault,
                   info = "trino-store-v1/profiles" )
```

The header and the logical name `profiles` are the associated data. The file
is replaced atomically, and the store's index notes each write. This
identity's name and photo are in the store's `account.bin`, with the rest of
the account; the unlock screen reads no name. Renaming a contact moves its
entry, removing a contact or replacing its keys drops it, locking clears it
from memory, and wiping destroys the vault, whose data key opens the store,
and then removes the store.

Only a missing `profiles.bin` starts afresh at unlock. One that does not
open (changed, put in the place of another file, or planted) is set aside in
`store/aside/` unopened, and the session starts afresh. An older copy, or one
the index cannot vouch for, waits for the user's choice at unlock. One that
cannot be read now (another program holding it, say), or that waits for that
choice, stays as it is: that session never writes it and never sends this
profile, and `update_profile` answers `io` until an unlock reads it again.

Earlier versions kept `~/.trino/profiles.bin` as `nonce ‖ AES-256-GCM(JSON)`
under `HKDF-SHA256(identity signing private key, 32 zero bytes,
"trino-profiles-key-v1")`, and moved one that did not decrypt to
`profiles.bin.damaged`. The first unlock with local encryption moves the
first into the store and keeps the second in `store/aside/`.

## Commands and events (desktop)

| | |
|---|---|
| `update_profile(handle, avatar, about?)` | `about` left out keeps the current one, as callers from before profiles expect. `profile_invalid` over the limits above, except for the name and the photo already saved, which may come back as they are: a name from before profiles stays here and goes out as "Who gets it" says, and a photo from before profiles stays here while contacts keep the one in the contact code. |
| `get_profile()` | adds `about` and `sync: 1`. |
| `list_nodes()` | the photo the contact's profile decided becomes `avatar` (if none decided, the one in its contact code), plus `profile_name`, `about` and `profile_sync`. |
| `profile-updated {handle}` | a contact's profile, or whether it reads profiles, changed. |

## Limits

- A relay cannot read a profile message, but at up to 58 KB with a photo it
  can guess from the size that a profile changed.
- If someone goes back to 0.1.0 after their last announcement and before your
  next change, the first profile message shows to them once as JSON. Their
  first message without `prof` closes that window.

## Vectors

Profile messages, byte for byte:

```
{"ty":"profile","v":1,"rev":2,"name":"Ana","about":"","photo":null}
{"ty":"profile","v":1,"rev":3,"name":"Ñandú \"A\"","about":"🙂"}
{"ty":"profile","v":1,"rev":1760000000,"name":"Ana","about":"Hola","photo":"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="}
{"ty":"profile","v":1,"rev":4,"name":"Ana","about":"Línea 1\nLínea 2"}
```

Invalid, and dropped:

```
{"ty":"profile","v":2,"rev":3,"name":"Ana","about":""}           another version
{"ty":"profile","rev":3,"name":"Ana","about":""}                 no version
{"ty":"profile","v":1,"rev":3,"name":"Ana","about":"","x":1}     a field too many
{"ty":"profile","v":1,"rev":0,"name":"Ana","about":""}           revision 0
{"ty":"profile","v":1,"rev":"3","name":"Ana","about":""}         revision as a string
{"ty":"profile","v":1,"rev":3,"name":"Ana"}                      no about
{"ty":"profile","v":1,"rev":3,"name":"   ","about":""}           empty name
{"ty":"profile","v":1,"rev":3,"name":7,"about":""}               name not a string
{"ty":"profile","v":1,"rev":3,"name":"Ana\u202e","about":""}     a bidi control in the name
{"ty":"profile","v":1,"rev":3,"name":"An\u0007a","about":""}     a control character in the name
{"ty":"profile","v":1,"rev":3,"name":"Ana\nLópez","about":""}    a line break in the name
{"ty":"profile","v":1,"rev":3,"name":"\u200b","about":""}        a name with nothing that shows
{"ty":"profile","v":1,"rev":3,"name":"\u3164","about":""}        the same, with a Hangul filler
{"ty":"profile","v":1,"rev":3,"name":"Ana","about":"\u2066x\u2069"}  bidi isolates in the about
{"ty":"profile","v":1,"rev":3,"name":"Ana","about":"a\tb"}       a tab in the about
```

as well as a name of 65 scalar values, an "about" of 141, a `data:image/gif`
photo, a photo of 20 481 bytes and a photo whose payload is not base64. The
tests in `src-tauri/src/profile.rs` check every line of this section.
