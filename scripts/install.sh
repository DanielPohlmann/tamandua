#!/bin/bash
# Install tamandua — from local checkout or from GitHub.
#
# Usage:
#   curl ... | bash                                  # remote install (GitHub)
#   ./scripts/install.sh                             # run from repo root
#   ./scripts/install.sh --local /path/to/tamandua   # explicit local path
set -euo pipefail

echo "Installing Tamandua..."

LOCAL_SOURCE=""
if [ "${1:-}" = "--local" ]; then
  LOCAL_SOURCE="${2:-$(pwd)}"
fi

REPO="igorhvr/tamandua"
BRANCH="main"

if [ -n "$LOCAL_SOURCE" ]; then
  # --- Local install from source checkout ---
  if [ ! -f "$LOCAL_SOURCE/package.json" ]; then
    echo "Error: $LOCAL_SOURCE doesn't look like a tamandua checkout (no package.json)"
    exit 1
  fi
  REPO_DIR="$LOCAL_SOURCE"
  echo "Using local source: $REPO_DIR"
else
  # --- Remote install (clone from GitHub) ---
  INSTALL_DIR="${HOME}/.tamandua/repo"

  if [ -d "$INSTALL_DIR" ]; then
    echo "Updating existing installation..."
    cd "$INSTALL_DIR"
    git fetch origin
    git reset --hard "origin/$BRANCH"
  else
    echo "Cloning repository..."
    git clone --depth 1 --branch "$BRANCH" "https://github.com/${REPO}.git" "$INSTALL_DIR"
    cd "$INSTALL_DIR"
  fi
  REPO_DIR="$INSTALL_DIR"
fi

cd "$REPO_DIR"

# Check Node.js version
NODE_VERSION=$(node -v 2>/dev/null | sed 's/v//' | cut -d. -f1)
if [ -z "$NODE_VERSION" ] || [ "$NODE_VERSION" -lt 22 ]; then
  echo "Error: Node.js >= 22 required. Current: $(node -v 2>/dev/null || echo 'not found')"
  exit 1
fi

# Install and build
echo "Installing dependencies..."
npm install
echo "Building..."
npm run build

# Create launcher at ~/.local/bin/tamandua.
#
# On Git Bash/MSYS a plain `ln -sf` silently makes a *copy* instead of a real
# symlink unless winsymlinks:nativestrict is set — and a copy breaks
# bin/tamandua's `readlink -f "$0"` resolution (it would look for dist/ under
# ~/.local instead of the repo). Native symlinks, however, require Windows
# Developer Mode or admin, so nativestrict may fail with "Operation not
# permitted". To always end up with a working launcher: try a real symlink
# first, and if that's not permitted, write a thin wrapper that execs the repo
# launcher by absolute path (so readlink -f still resolves dist/ against the
# real checkout).
mkdir -p "$HOME/.local/bin"
LAUNCHER="$HOME/.local/bin/tamandua"
if ! MSYS="${MSYS:+$MSYS }winsymlinks:nativestrict" ln -sf "$REPO_DIR/bin/tamandua" "$LAUNCHER" 2>/dev/null; then
  echo "Note: symlinks not permitted; writing a wrapper launcher instead."
  cat > "$LAUNCHER" <<EOF
#!/bin/sh
# Auto-generated wrapper — execs the tamandua launcher in its repo checkout.
exec "$REPO_DIR/bin/tamandua" "\$@"
EOF
fi
chmod +x "$LAUNCHER"

# Install bundled workflows
set +e
"$HOME/.local/bin/tamandua" workflow install --all 2>&1
WF_INSTALL_EXIT=$?
set -e

echo ""
echo "Tamandua installed successfully!"
if [ $WF_INSTALL_EXIT -ne 0 ]; then
  echo "Warning: workflow installation failed (exit $WF_INSTALL_EXIT)"
fi
echo ""
echo "Make sure ~/.local/bin is in your PATH if not already."
