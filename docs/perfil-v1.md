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

An envelope that already has `prof` goes out as it is.

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
| `name` | string; trimmed, 1 to 64 Unicode scalar values |
| `about` | string; trimmed, 0 to 140 Unicode scalar values |
| `photo` | left out: the photo does not change. `null`: the photo is removed. Otherwise a `data:image/jpeg;base64,`, `data:image/png;base64,` or `data:image/webp;base64,` URL whose payload is standard, padded base64 of at most 20 480 bytes (20 KiB). |

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
  to 64; a photo from before that a profile cannot carry (a GIF, or over
  20 KiB) is left out, so contacts keep the photo of the contact code.

### Size

Relays drop events over 64 KB without a word, and the ratchet writes its
ciphertext in hex, so every byte of a message takes two on the wire. With the
largest photo (20 KiB, which base64 turns into 27 308 characters) the message
is about 27 KB of JSON, and the relay frame that carries it about 55 KB, or
57 918 bytes with a name and an "about" made entirely of characters JSON
escapes to six bytes each. A test builds that frame and keeps it under 60 KiB.

A photo of 24 KiB would not fit: its frame takes about 66 KB, 68 838 bytes in
the worst case.

## Storage on the desktop

`~/.trino/profiles.bin` holds this identity's "about" and revision, and for
each contact the profile it shares and what it announced:

```
nonce (12 bytes) ‖ AES-256-GCM( JSON )

key = HKDF-SHA256( ikm  = identity signing private key,
                   salt = 32 zero bytes,
                   info = "trino-profiles-key-v1",
                   length = 32 )
```

The key differs from the history key (`trino-history-key-v1`). The file is
replaced atomically. This identity's name and photo stay in `config.json`,
which the unlock screen reads before anything is decrypted. Renaming a
contact moves its entry, removing a contact or replacing its keys drops it,
locking clears it from memory and wiping deletes the file.

## Commands and events (desktop)

| | |
|---|---|
| `update_profile(handle, avatar, about?)` | `about` left out keeps the current one, as callers from before profiles expect. `profile_invalid` over the limits above. |
| `get_profile()` | adds `about` and `sync: 1`. |
| `list_nodes()` | the photo the contact's profile decided becomes `avatar` (if none decided, the one in its contact code), plus `profile_name`, `about` and `profile_sync`. |
| `profile-updated {handle}` | a contact's profile, or whether it reads profiles, changed. |

## Limits

- A relay cannot read a profile message, but at up to 58 KB with a photo it
  can guess from the size that a profile changed.
- If someone goes back to 0.1.0 after their last announcement and before your
  next change, the first profile message shows to them once as JSON. Their
  first message without `prof` closes that window.
- On the desktop, outgoing messages announce support once the integration step
  (I0) calls `profile::with_caps` from `send_cipher_inner`. Until then no
  contact is recorded as reading profiles, so no profile message is sent.

## Vectors

Profile messages, byte for byte:

```
{"ty":"profile","v":1,"rev":2,"name":"Ana","about":"","photo":null}
{"ty":"profile","v":1,"rev":3,"name":"Ñandú \"A\"","about":"🙂"}
{"ty":"profile","v":1,"rev":1760000000,"name":"Ana","about":"Hola","photo":"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="}
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
```

as well as a name of 65 scalar values, an "about" of 141, a `data:image/gif`
photo, a photo of 20 481 bytes and a photo whose payload is not base64. The
tests in `src-tauri/src/profile.rs` check every line of this section.
