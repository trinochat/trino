#!/usr/bin/env bash
# Fetch lyrebird, Trino's bridge program, for a release build (Tor design §5.1,
# decision 7).
#
# 1. Downloads the Tor Expert Bundle and its signature from torproject.org.
# 2. Checks the OpenPGP signature with the Tor Browser Developers key,
#    EF6E286DDA85EA2A4BA7DE684E2C6E8793298290, in a keyring of its own made
#    for this run and removed after it (never your keyring). Only a GOODSIG
#    whose VALIDSIG names that primary key passes.
# 3. Only then extracts lyrebird, its licence and Tor Browser's pt_config.json
#    (the built-in bridges), into a new empty folder.
# 4. Checks lyrebird's SHA-256 against src-tauri/binaries/lyrebird.pin, and
#    pt_config.json against crates/trino-net/src/tor/pt_config.json: a
#    download that does not match is refused. With --update, it writes them
#    instead, for you to review and commit.
# 5. Puts lyrebird where Tauri's externalBin takes it,
#    src-tauri/binaries/lyrebird-<target>[.exe], and its licence beside it.
#    Both are ignored by git; `tauri build --config src-tauri/tauri.bridges.conf.json`
#    ships them.
#
# Usage:
#   scripts/fetch-lyrebird.sh <target>                    # the pinned version
#   scripts/fetch-lyrebird.sh --update <version> <target> # a new one
#   <target>: x86_64-pc-windows-msvc | x86_64-unknown-linux-gnu
# Offline, with files you already have (they are checked the same way):
#   --bundle-dir <dir>  the .tar.gz and its .asc, instead of downloading them
#   --key <file>        the Tor Browser Developers key, instead of keys.openpgp.org
#
# Needs bash, curl, gpg, tar and sha256sum (Git for Windows has them all).
# It never runs anything it downloads.

set -euo pipefail

TOR_BROWSER_DEVELOPERS=EF6E286DDA85EA2A4BA7DE684E2C6E8793298290
KEY_URL="https://keys.openpgp.org/vks/v1/by-fingerprint/$TOR_BROWSER_DEVELOPERS"
MIRRORS=(
  "https://dist.torproject.org/torbrowser"
  "https://archive.torproject.org/tor-package-archive/torbrowser"
)

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
pin="$root/src-tauri/binaries/lyrebird.pin"
pt_config="$root/crates/trino-net/src/tor/pt_config.json"
out="$root/src-tauri/binaries"

die() { echo "fetch-lyrebird: $*" >&2; exit 1; }

update=""
bundle_dir=""
key_file=""
while [ $# -gt 1 ]; do
  case "$1" in
    --update) update="${2:-}"; shift 2 ;;
    --bundle-dir) bundle_dir="${2:-}"; shift 2 ;;
    --key) key_file="${2:-}"; shift 2 ;;
    *) break ;;
  esac
done
target="${1:-}"
case "$target" in
  x86_64-pc-windows-msvc)   bundle_os="windows-x86_64"; exe="lyrebird.exe" ;;
  x86_64-unknown-linux-gnu) bundle_os="linux-x86_64";   exe="lyrebird" ;;
  *) die "usage: $0 [--update <version>] <x86_64-pc-windows-msvc|x86_64-unknown-linux-gnu>" ;;
esac

# The pinned line for this target: <target> <version> <sha256>.
pinned_line="$(grep -E "^$target " "$pin" || true)"
if [ -n "$update" ]; then
  version="$update"
else
  [ -n "$pinned_line" ] || die "no line for $target in $pin: run with --update <version>"
  version="$(echo "$pinned_line" | awk '{print $2}')"
  pinned_sha="$(echo "$pinned_line" | awk '{print $3}')"
fi
[[ "$version" =~ ^[0-9]+(\.[0-9]+)+$ ]] || die "not a version: $version"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
mkdir "$work/gnupg" "$work/download" "$work/extract"
chmod 700 "$work/gnupg" 2>/dev/null || true
export GNUPGHOME="$work/gnupg"

file="tor-expert-bundle-$bundle_os-$version.tar.gz"
fetched=""
if [ -n "$bundle_dir" ]; then
  cp "$bundle_dir/$file" "$bundle_dir/$file.asc" "$work/download/" || die "no $file in $bundle_dir"
  fetched="$bundle_dir"
fi
for mirror in "${MIRRORS[@]}"; do
  [ -z "$fetched" ] || break
  if curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 \
       --output "$work/download/$file" "$mirror/$version/$file" &&
     curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 \
       --output "$work/download/$file.asc" "$mirror/$version/$file.asc"; then
    fetched="$mirror"
    break
  fi
done
[ -n "$fetched" ] || die "could not download $file"
echo "took $file from $fetched"

# The signature, with the pinned key only.
if [ -n "$key_file" ]; then
  cp "$key_file" "$work/key.asc" || die "no key in $key_file"
else
  curl --fail --silent --show-error --proto '=https' --tlsv1.2 \
    --output "$work/key.asc" "$KEY_URL" || die "could not download the Tor Browser Developers key"
fi
gpg --batch --quiet --import "$work/key.asc" 2>/dev/null || die "could not import the key"
status="$(gpg --batch --status-fd 1 --verify "$work/download/$file.asc" "$work/download/$file" 2>/dev/null || true)"
echo "$status" | grep -q '^\[GNUPG:\] GOODSIG ' || die "BAD signature on $file"
# VALIDSIG <signing key> ... <primary key>: the last field is the primary key.
primary="$(echo "$status" | awk '$2 == "VALIDSIG" {print $NF}')"
[ "$primary" = "$TOR_BROWSER_DEVELOPERS" ] || die "signed by $primary, not by the Tor Browser Developers"
echo "good signature by $TOR_BROWSER_DEVELOPERS"

# Only the three files, by their names.
tar -xzf "$work/download/$file" -C "$work/extract" \
  "tor/pluggable_transports/$exe" \
  "tor/pluggable_transports/pt_config.json" \
  "docs/lyrebird.txt"
lyrebird="$work/extract/tor/pluggable_transports/$exe"
[ -f "$lyrebird" ] && [ ! -L "$lyrebird" ] || die "no lyrebird in $file"
sha="$(sha256sum "$lyrebird" | awk '{print $1}')"

if [ -n "$update" ]; then
  # Rewrite this target's line, keeping the others and the comments.
  { grep -vE "^$target " "$pin"; echo "$target $version $sha"; } > "$work/pin"
  cp "$work/pin" "$pin"
  cp "$work/extract/tor/pluggable_transports/pt_config.json" "$pt_config"
  echo "updated $pin and $pt_config: review the diff and commit them"
else
  [ "$sha" = "$pinned_sha" ] || die "lyrebird's SHA-256 is $sha, but $pin says $pinned_sha"
  cmp -s "$work/extract/tor/pluggable_transports/pt_config.json" "$pt_config" ||
    die "the built-in bridges of $version differ from $pt_config: run with --update and review"
fi

mkdir -p "$out"
suffix=""
[ "$exe" = "lyrebird.exe" ] && suffix=".exe"
cp "$lyrebird" "$out/lyrebird-$target$suffix"
cp "$work/extract/docs/lyrebird.txt" "$out/lyrebird-LICENSE.txt"
echo "lyrebird $sha -> $out/lyrebird-$target$suffix"
