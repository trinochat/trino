#!/usr/bin/env bash
# setup-mac.sh — install everything needed to build trino-gui on macOS.
# Run ONCE on the Mac. ~5-10 min (mostly downloads).

set -e

echo "═══════════════════════════════════════════════════════════"
echo " trino-gui · macOS build environment setup"
echo "═══════════════════════════════════════════════════════════"

echo ""
echo "[1/4] Xcode command-line tools (compiler + linker)..."
if ! xcode-select -p >/dev/null 2>&1; then
  echo "  installing — accept the popup that appears, then re-run this script."
  xcode-select --install || true
else
  echo "  already installed."
fi

echo ""
echo "[2/4] Homebrew + Node.js 22..."
if ! command -v brew >/dev/null 2>&1; then
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
  # add brew to PATH for this shell (Apple Silicon path)
  [ -x /opt/homebrew/bin/brew ] && eval "$(/opt/homebrew/bin/brew shellenv)"
  [ -x /usr/local/bin/brew ] && eval "$(/usr/local/bin/brew shellenv)"
fi
if ! command -v node >/dev/null 2>&1 || [ "$(node -v 2>/dev/null | cut -d. -f1)" != "v22" ]; then
  brew install node@22
  brew link --overwrite --force node@22 || true
fi
echo "  node $(node --version)"
echo "  npm  $(npm --version)"

echo ""
echo "[3/4] Rust (rustup)..."
if ! command -v rustc >/dev/null 2>&1; then
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain stable
fi
source "$HOME/.cargo/env" 2>/dev/null || export PATH="$HOME/.cargo/bin:$PATH"
echo "  rustc $(rustc --version)"
echo "  cargo $(cargo --version)"

echo ""
echo "[4/4] Persist cargo on PATH..."
if ! grep -q 'cargo/env' "$HOME/.zprofile" 2>/dev/null; then
  echo 'source "$HOME/.cargo/env"' >> "$HOME/.zprofile"
fi

echo ""
echo "═══════════════════════════════════════════════════════════"
echo " ✓ DONE. Now build trino-gui:"
echo "═══════════════════════════════════════════════════════════"
echo ""
echo "  cd ~/trino-gui"
echo "  rm -rf node_modules src-tauri/target"
echo "  npm install"
echo "  npm run tauri build"
echo ""
echo "Output: ~/trino-gui/src-tauri/target/release/bundle/dmg/trino-gui_0.1.0_*.dmg"
echo "(also a .app in .../bundle/macos/trino-gui.app)"
