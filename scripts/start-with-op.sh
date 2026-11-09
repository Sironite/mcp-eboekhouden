#!/usr/bin/env sh
# Usage: start-with-op.sh [env-file]
#
# Starts the server with secrets from 1Password (`op run`). Checks first that the
# 1Password CLI can reach an account, and fails fast with a clear message
# instead of hanging on an interactive "add an account" prompt, which an MCP
# client cannot answer.
set -eu

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="${1:-$ROOT/.env.op}"

if ! command -v op >/dev/null 2>&1; then
  echo "start-with-op: the 1Password CLI (op) is not installed or not on PATH." >&2
  exit 1
fi
if [ ! -f "$ENV_FILE" ]; then
  echo "start-with-op: $ENV_FILE not found; copy .env.op.example to .env.op first." >&2
  exit 1
fi
if ! op vault list </dev/null >/dev/null 2>&1; then
  cat >&2 <<'EOF'
start-with-op: the 1Password CLI is not signed in.
  - Unlock the 1Password app and enable Settings > Developer > "Integrate with 1Password CLI".
  - On macOS, if `op` reports "No accounts configured" or "not currently signed in"
    although the integration is on, set OP_BIOMETRIC_UNLOCK_ENABLED=true.
  - Check with: op vault list
EOF
  exit 1
fi

exec op run --env-file="$ENV_FILE" -- node "$ROOT/dist/index.js"
