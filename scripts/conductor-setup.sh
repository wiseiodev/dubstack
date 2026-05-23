#!/usr/bin/env bash
# Conductor workspace setup. Invoked by `setup` and `remoteSetup` in conductor.json.
set -euo pipefail

cd "$(dirname "$0")/.."

if [ -s "${NVM_DIR:-$HOME/.nvm}/nvm.sh" ]; then
  # shellcheck disable=SC1091
  . "${NVM_DIR:-$HOME/.nvm}/nvm.sh"
  nvm use
elif command -v fnm >/dev/null 2>&1; then
  fnm use --install-if-missing
fi

corepack enable >/dev/null 2>&1 || true

pnpm install --frozen-lockfile
