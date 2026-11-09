#!/usr/bin/env sh
# Installs or updates the production copy of the server from origin/main.
# The production copy is separate from the development checkout, so building
# or switching branches during development never changes what the
# bookkeeping folder runs.
set -eu

TARGET="${1:-$HOME/.local/share/mcp-eboekhouden}"
# Repository to install from: MCP_EBOEKHOUDEN_REPO, or the origin of the
# checkout this script lives in.
REPO="${MCP_EBOEKHOUDEN_REPO:-$(git -C "$(dirname "$0")/.." remote get-url origin)}"

if [ -d "$TARGET/.git" ]; then
  if [ -n "$(git -C "$TARGET" status --porcelain --untracked-files=no)" ]; then
    echo "install-prod: $TARGET has local changes; aborting." >&2
    exit 1
  fi
  git -C "$TARGET" fetch --quiet origin main
  git -C "$TARGET" checkout --quiet --detach origin/main
else
  mkdir -p "$(dirname "$TARGET")"
  git clone --quiet --branch main "$REPO" "$TARGET"
  git -C "$TARGET" checkout --quiet --detach origin/main
fi

cd "$TARGET"
npm ci --no-audit --no-fund --loglevel=error
npm run build --silent
sh scripts/sync-env.sh .env.op.example .env.op

echo "install-prod: $(git rev-parse --short HEAD) installed in $TARGET"
echo "Register it from the bookkeeping folder with:"
echo "  claude mcp add -s local eboekhouden -- op run --env-file=\"$TARGET/.env.op\" -- node \"$TARGET/dist/index.js\""
