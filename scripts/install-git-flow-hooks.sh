#!/bin/sh
# Install the Git Flow guard hooks into .git/hooks
# Run from the project root: ./scripts/install-git-flow-hooks.sh

set -e
SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
GIT_ROOT=$(cd "$SCRIPT_DIR/.." && git rev-parse --show-toplevel 2>/dev/null) || true
HOOKS_SRC="${SCRIPT_DIR}/git-hooks"
if [ -z "$GIT_ROOT" ]; then
  echo "Error: not inside a git repository."
  exit 1
fi
HooksDir="${GIT_ROOT}/.git/hooks"

install_hook() {
  local name="$1"
  local src="${HOOKS_SRC}/${name}"
  local dst="${HooksDir}/${name}"
  if [ ! -f "$src" ]; then
    echo "Error: $src not found"
    exit 1
  fi
  cp "$src" "$dst"
  chmod +x "$dst"
  echo "  Installed: $name"
}

echo "Installing Git Flow guard hooks..."
install_hook pre-commit
install_hook commit-msg
echo "Done. Commits on main/develop are now blocked and the Conventional Commits format is enforced."
