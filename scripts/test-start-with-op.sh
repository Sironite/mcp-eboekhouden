#!/usr/bin/env sh
# Tests for start-with-op.sh with a fake `op` on PATH; never calls 1Password.
set -eu

SCRIPT="$(cd "$(dirname "$0")" && pwd)/start-with-op.sh"
DIR=$(mktemp -d)
trap 'rm -rf "$DIR"' EXIT

fail() {
  echo "FAIL: $1" >&2
  exit 1
}

mkdir -p "$DIR/bin"
cat > "$DIR/bin/op" <<'EOF'
#!/usr/bin/env sh
case "$1 $2" in
  "vault list") [ "${FAKE_OP_SIGNED_IN:-0}" = 1 ] && exit 0 || { echo "not signed in" >&2; exit 1; } ;;
  "run --env-file="*) echo "op-run $2 $3 $4 $5"; exit 0 ;;
esac
exit 2
EOF
chmod +x "$DIR/bin/op"
touch "$DIR/env.op"

out=$(PATH="$DIR/bin:$PATH" FAKE_OP_SIGNED_IN=0 sh "$SCRIPT" "$DIR/env.op" 2>&1) && fail "started while not signed in"
echo "$out" | grep -q "not signed in" || fail "missing sign-in message: $out"
echo "$out" | grep -q "OP_BIOMETRIC_UNLOCK_ENABLED" || fail "missing macOS hint: $out"

out=$(PATH="$DIR/bin:$PATH" sh "$SCRIPT" "$DIR/missing.op" 2>&1) && fail "started without env file"
echo "$out" | grep -q "not found" || fail "missing env file message: $out"

out=$(PATH="$DIR/bin:$PATH" FAKE_OP_SIGNED_IN=1 sh "$SCRIPT" "$DIR/env.op")
echo "$out" | grep -q "^op-run --env-file=$DIR/env.op -- node .*/dist/index.js$" || fail "unexpected op run call: $out"

echo "test-start-with-op: all tests passed"
