#!/usr/bin/env sh
# Usage: sync-env.sh <example-env-file> <target-env-file>
#
# Adds every active KEY=... line from the example that is missing in the
# target. Existing lines are never changed, so local values (such as a custom
# audit log path) are kept. Commented example lines (# KEY=...) are optional:
# they are only reported, not added. Both files hold 1Password references and
# paths only, never secret values.
set -eu

EXAMPLE="$1"
TARGET="$2"

if [ ! -f "$TARGET" ]; then
  cp "$EXAMPLE" "$TARGET"
  chmod 600 "$TARGET"
  echo "sync-env: created $TARGET from $(basename "$EXAMPLE")"
  exit 0
fi

has_key() {
  grep -Eq "^[[:space:]]*$1=" "$TARGET"
}

added=""
optional=""
while IFS= read -r line || [ -n "$line" ]; do
  case "$line" in
    "#"*)
      key=$(printf '%s\n' "$line" | sed -nE 's/^#[[:space:]]*([A-Z][A-Z0-9_]*)=.*/\1/p')
      if [ -n "$key" ] && ! has_key "$key"; then optional="$optional $key"; fi
      ;;
    *=*)
      key=$(printf '%s\n' "${line%%=*}" | tr -d '[:space:]')
      case "$key" in
        "" | *[!A-Z0-9_]*) continue ;;
      esac
      if ! has_key "$key"; then
        # Make sure the appended line starts on its own line.
        if [ -s "$TARGET" ] && [ -n "$(tail -c 1 "$TARGET")" ]; then echo >> "$TARGET"; fi
        printf '%s\n' "$line" >> "$TARGET"
        added="$added $key"
      fi
      ;;
  esac
done < "$EXAMPLE"

chmod 600 "$TARGET"

if [ -n "$added" ]; then
  echo "sync-env: added to $(basename "$TARGET"):$added (restart Claude Code to load them)"
else
  echo "sync-env: $(basename "$TARGET") is up to date"
fi
if [ -n "$optional" ]; then
  echo "sync-env: optional, not set:$optional (see $(basename "$EXAMPLE"))"
fi
