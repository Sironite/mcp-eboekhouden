#!/usr/bin/env sh
# Tests for sync-env.sh. Runs in a temporary directory; touches no real env files.
set -eu

SCRIPT="$(cd "$(dirname "$0")" && pwd)/sync-env.sh"
DIR=$(mktemp -d)
trap 'rm -rf "$DIR"' EXIT

fail() {
  echo "FAIL: $1" >&2
  exit 1
}

cat > "$DIR/example" <<'EOF'
# Comment line
EBOEKHOUDEN_API_TOKEN="op://Vault/item/credential"
EBOEKHOUDEN_API_TOKEN_EXPIRES="op://Vault/item/expires"
# EBOEKHOUDEN_AUDIT_LOG="/path/audit.jsonl"
EOF

# Existing target with a custom value and no trailing newline.
printf 'EBOEKHOUDEN_API_TOKEN="op://Custom/item/credential"' > "$DIR/target"

out=$(sh "$SCRIPT" "$DIR/example" "$DIR/target")
echo "$out" | grep -q "added to target: EBOEKHOUDEN_API_TOKEN_EXPIRES" || fail "missing key not reported: $out"
echo "$out" | grep -q "optional, not set: EBOEKHOUDEN_AUDIT_LOG" || fail "optional key not reported: $out"

grep -qx 'EBOEKHOUDEN_API_TOKEN="op://Custom/item/credential"' "$DIR/target" || fail "existing value changed"
grep -qx 'EBOEKHOUDEN_API_TOKEN_EXPIRES="op://Vault/item/expires"' "$DIR/target" || fail "missing key not added on its own line"
[ "$(grep -c '^EBOEKHOUDEN_API_TOKEN=' "$DIR/target")" -eq 1 ] || fail "existing key duplicated"
grep -q "EBOEKHOUDEN_AUDIT_LOG" "$DIR/target" && fail "optional key was added"

perms=$(ls -l "$DIR/target" | cut -c1-10)
[ "$perms" = "-rw-------" ] || fail "permissions are $perms, expected -rw-------"

out=$(sh "$SCRIPT" "$DIR/example" "$DIR/target")
echo "$out" | grep -q "is up to date" || fail "second run not idempotent: $out"

# An optional key that is already set is not reported.
echo 'EBOEKHOUDEN_AUDIT_LOG="/my/audit.jsonl"' >> "$DIR/target"
out=$(sh "$SCRIPT" "$DIR/example" "$DIR/target")
echo "$out" | grep -q "optional" && fail "set optional key still reported: $out"

# Missing target is created from the example.
out=$(sh "$SCRIPT" "$DIR/example" "$DIR/new")
echo "$out" | grep -q "created" || fail "missing target not created: $out"
cmp -s "$DIR/example" "$DIR/new" || fail "created file differs from example"

echo "test-sync-env: all tests passed"
