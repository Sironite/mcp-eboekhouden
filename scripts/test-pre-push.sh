#!/usr/bin/env sh
# Tests for .githooks/pre-push in throwaway repositories.
set -eu

HOOK="$(cd "$(dirname "$0")/.." && pwd)/.githooks/pre-push"
DIR=$(mktemp -d)
trap 'rm -rf "$DIR"' EXIT

fail() {
  echo "FAIL: $1" >&2
  exit 1
}

export GIT_AUTHOR_NAME=test GIT_AUTHOR_EMAIL=test@example.invalid
export GIT_COMMITTER_NAME=test GIT_COMMITTER_EMAIL=test@example.invalid

git init -q --bare -b main "$DIR/remote.git"
git clone -q "$DIR/remote.git" "$DIR/work" 2>/dev/null
cd "$DIR/work"
git commit -q --allow-empty -m base
git push -q origin main
base=$(git rev-parse HEAD)

# Runs the hook for a push of <sha> to main, with the remote at <remote_sha>.
hook() {
  printf 'refs/heads/main %s refs/heads/main %s\n' "$1" "$2" | sh "$HOOK" origin url >/dev/null 2>&1
}

# A pull request branch on the remote.
git checkout -q -b feature
git commit -q --allow-empty -m feature
git push -q origin feature
feature=$(git rev-parse HEAD)

hook "$feature" "$base" || fail "fast-forward to a pushed PR branch was blocked"

# A local commit on main that is on no remote branch.
git checkout -q main
git commit -q --allow-empty -m local-only
local_only=$(git rev-parse HEAD)
hook "$local_only" "$base" && fail "direct push of a local commit was allowed"

# Not a fast-forward (remote is ahead of the pushed commit's history).
hook "$base" "$feature" && fail "non-fast-forward push was allowed"

# Deleting main.
hook 0000000000000000000000000000000000000000 "$base" && fail "deleting main was allowed"

# Pushes to other branches are not affected.
printf 'refs/heads/feature %s refs/heads/feature %s\n' "$local_only" "$feature" | sh "$HOOK" origin url ||
  fail "push to a non-main branch was blocked"

echo "test-pre-push: all tests passed"
