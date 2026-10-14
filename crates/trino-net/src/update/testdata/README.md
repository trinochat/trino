# The updater's test vectors

Made with the real `tauri signer` (tauri-cli 2.11.2, the CLI this repository
builds with) and a throwaway key, so the updater is checked against what the
CLI writes, not only against what its tests make:

```sh
npx --no-install tauri signer generate --ci -p throwaway-test -w test.key
printf 'Not an installer: the bytes a test of Trino signed with tauri signer sign.\n' \
  > 'Trino Chat_0.2.0_x64-setup.exe'
npx --no-install tauri signer sign -f test.key -p throwaway-test 'Trino Chat_0.2.0_x64-setup.exe'
```

- `tauri-test.key.pub`: the public key as `tauri signer generate` writes it
  (`test.key.pub`, the minisign .pub file in base64). Key id
  `58B446BCF27F15C2`.
- `tauri-installer.bin`: the signed file (`Trino Chat_0.2.0_x64-setup.exe`).
- `tauri-installer.sig`: its signature as `tauri signer sign` writes it
  (`.sig`, and the `signature` of latest.json), with the trusted comment
  `timestamp:1792017567	file:Trino Chat_0.2.0_x64-setup.exe`.

The private key (`test.key`) was deleted right after signing: it was made for
these files only, and its password is written above because it protects
nothing. It is not Trino's updater key (`2A6861FC701B75D7`), whose private half
only David has (docs/updater.md).

The files are binary to git (`.gitattributes`): a line ending changed on
checkout would make the signature fail.
