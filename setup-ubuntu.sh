#!/usr/bin/env bash
# setup-ubuntu.sh
# Installs everything needed to build trino-gui on Ubuntu 22.04 WSL.
# Run ONCE, takes ~5-10 min total (mostly download).

set -e

echo "═══════════════════════════════════════════════════════════"
echo " trino-gui · Ubuntu build environment setup"
echo "═══════════════════════════════════════════════════════════"
echo ""

echo "[1/4] Updating apt and installing Tauri system deps..."
sudo apt update
sudo apt install -y \
  libwebkit2gtk-4.1-dev \
  build-essential \
  curl \
  wget \
  file \
  libxdo-dev \
  libssl-dev \
  libayatana-appindicator3-dev \
  librsvg2-dev \
  pkg-config

echo ""
echo "[2/4] Installing Node.js 22 (NodeSource)..."
if ! command -v node >/dev/null 2>&1 || [ "$(node -v 2>/dev/null | cut -d. -f1)" != "v22" ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt install -y nodejs
fi
echo "  node $(node --version)"
echo "  npm  $(npm --version)"

echo ""
echo "[3/4] Installing Rust (rustup)..."
if ! command -v rustc >/dev/null 2>&1; then
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain stable
fi
# Ensure cargo is on PATH for this shell
export PATH="$HOME/.cargo/bin:$PATH"
echo "  rustc $(rustc --version)"
echo "  cargo $(cargo --version)"

echo ""
echo "[4/4] Adding cargo to your shell PATH permanently..."
if ! grep -q 'cargo/env' "$HOME/.bashrc" 2>/dev/null; then
  echo 'source "$HOME/.cargo/env"' >> "$HOME/.bashrc"
fi

echo ""
echo "═══════════════════════════════════════════════════════════"
echo " ✓ DONE. Now copy the project into Ubuntu (NOT in /mnt/c/)"
echo "═══════════════════════════════════════════════════════════"
echo ""
echo "Run these next:"
echo ""
echo "  cp -r "$(pwd)" ~/trino-gui   # o la ruta donde tengas el proyecto"
echo "  cd ~/trino-gui"
echo "  rm -rf node_modules src-tauri/target"
echo "  npm install"
echo "  npm run tauri build"
echo ""
echo "Build will take ~10-15 min (compiles Rust release mode)."
echo "Output: ~/trino-gui/src-tauri/target/release/bundle/appimage/trino-gui_0.1.0_amd64.AppImage"
