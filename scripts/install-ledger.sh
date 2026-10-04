# Installer ownership is a path record, never a directory name or marker.
# The append-only journal keeps the last record per path. Missing records are
# unowned; hashes prevent deletion of files edited after their creation.
LEDGER="$ROOT/.install-ledger.tsv"
TAB=$(printf '\t')
sha256() { shasum -a 256 "$1" | awk '{print $1}'; }
ledger_key() {
  case "$1" in "$HOME"/*) ;; *) die "Path containment refused: $1" ;; esac
  case "$1" in *"$TAB"*|*'
'*) die "Unsupported ledger path: $1" ;; esac
  printf '%s\n' "${1#"$HOME/"}"
}
ledger_entry() {
  KEY=$(ledger_key "$1")
  awk -F '\t' -v key="$KEY" '$3 == key {row=$0} END {print row}' "$LEDGER"
}
ledger_record() {
  contained "$1"
  if [ -d "$1" ]; then TYPE=D; HASH=-
  elif [ -f "$1" ]; then TYPE=F; HASH=$(sha256 "$1")
  else die "Unsupported owned path: $1"; fi
  printf '%s\t%s\t%s\n' "$TYPE" "$HASH" "$(ledger_key "$1")" >> "$LEDGER"
}
ledger_assert() (
  contained "$1"
  ENTRY=$(ledger_entry "$1")
  [ -n "$ENTRY" ] || die "Unowned path preserved: $1"
  TYPE=$(printf '%s\n' "$ENTRY" | cut -f 1)
  HASH=$(printf '%s\n' "$ENTRY" | cut -f 2)
  case "$TYPE" in
    D) [ -d "$1" ] || die "Owned directory changed: $1" ;;
    F) [ -f "$1" ] && [ "$(sha256 "$1")" = "$HASH" ] || die "Installed file damaged or owned file changed: $1" ;;
    *) die "Unowned path preserved: $1" ;;
  esac
)
ledger_tree_assert() {
  contained "$1"
  if [ -n "${LEDGER_NODE:-}" ]; then "$LEDGER_NODE" "$SCRIPT_DIR/src/install-ledger.mjs" assert "$HOME" "$ROOT" "$1"; return; fi
  [ ! -e "$1" ] || find "$1" -exec sh "$SCRIPT_DIR/scripts/ledger-tree.sh" "$HOME" "$ROOT" "$SCRIPT_DIR" {} +
}
ledger_tree_record() {
  contained "$1"
  if [ -n "${LEDGER_NODE:-}" ]; then "$LEDGER_NODE" "$SCRIPT_DIR/src/install-ledger.mjs" record "$HOME" "$ROOT" "$1"; return; fi
  # Called only for output in a freshly created or fully preflighted tree.
  find "$1" -type d -print | awk -v home="$HOME/" '{print "D\t-\t" substr($0,length(home)+1)}' >> "$LEDGER"
  find "$1" -type f -exec shasum -a 256 {} + | awk -v home="$HOME/" '{hash=substr($0,1,64); path=substr($0,67); print "F\t" hash "\t" substr(path,length(home)+1)}' >> "$LEDGER"
  find "$1" -type l -exec sh "$SCRIPT_DIR/scripts/ledger-tree.sh" "$HOME" "$ROOT" "$SCRIPT_DIR" --record-links {} +
}
owned_mkdir() {
  contained "$1"
  if [ -e "$1" ]; then ledger_assert "$1"; return; fi
  [ -d "${1%/*}" ] || owned_mkdir "${1%/*}"
  mkdir "$1"
  ledger_record "$1"
}
owned_remove_tree() {
  [ -e "$1" ] || return 0
  if [ -n "${LEDGER_NODE:-}" ]; then "$LEDGER_NODE" "$SCRIPT_DIR/src/install-ledger.mjs" remove "$HOME" "$ROOT" "$1"; return; fi
  ledger_tree_assert "$1"
  # find -depth removes each recorded entry. Never recursively delete a parent.
  find "$1" -depth -exec sh "$SCRIPT_DIR/scripts/ledger-tree.sh" "$HOME" "$ROOT" "$SCRIPT_DIR" --remove {} +
}

ledger_root_assert() {
  for PATH_NAME in "$ROOT"/* "$ROOT"/.[!.]* "$ROOT"/..?*; do
    [ -e "$PATH_NAME" ] || [ -L "$PATH_NAME" ] || continue
    [ "$PATH_NAME" = "$LEDGER" ] && continue
    ledger_tree_assert "$PATH_NAME"
  done
}
