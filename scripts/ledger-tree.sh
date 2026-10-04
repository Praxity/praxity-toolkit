#!/bin/sh
set -eu
HOME=$1; ROOT=$2; SCRIPT_DIR=$3; shift 3
die() { printf '%s\n' "$*" >&2; exit 1; }
# Keep containment in the bootstrap's shared helper, also used by installed runs.
. "$SCRIPT_DIR/scripts/install-paths.sh"
. "$SCRIPT_DIR/scripts/install-ledger.sh"
MODE=check
case "${1:-}" in --remove) MODE=remove; shift ;; --record-links) MODE=links; shift ;; esac
for FILE do
  # A recorded link may be removed as a link, but its parents must be contained.
  contained "${FILE%/*}"
  KEY=$(ledger_key "$FILE")
  if [ "$MODE" = links ]; then
    TARGET=$(readlink "$FILE")
    HASH=$(printf '%s' "$TARGET" | shasum -a 256 | awk '{print $1}')
    printf 'L\t%s\t%s\n' "$HASH" "$KEY" >> "$LEDGER"
    continue
  fi
  ENTRY=$(ledger_entry "$FILE")
  [ -n "$ENTRY" ] || die "Unowned path preserved: $FILE"
  TYPE=$(printf '%s\n' "$ENTRY" | cut -f 1)
  HASH=$(printf '%s\n' "$ENTRY" | cut -f 2)
  if [ "$TYPE" = L ]; then
    [ -L "$FILE" ] || die "Owned link changed: $FILE"
    ACTUAL=$(readlink "$FILE" | tr -d '\n' | shasum -a 256 | awk '{print $1}')
    [ "$ACTUAL" = "$HASH" ] || die "Owned link changed: $FILE"
  else ledger_assert "$FILE"; fi
  if [ "$MODE" = remove ]; then
    if [ "$TYPE" = D ]; then rmdir "$FILE"; else rm "$FILE"; fi
    printf 'X\t-\t%s\n' "$KEY" >> "$LEDGER"
  fi
done
