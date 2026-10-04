# Installer ownership is a path record, never a directory name or marker.
# The append-only journal keeps the last record per path. Missing records are
# unowned; hashes prevent deletion of files edited after their creation.
LEDGER="$ROOT/.install-ledger.tsv"
TAB=$(printf '\t')
ledger_validate() {
  LC_ALL=C awk -F '\t' '
    function hash(value) {return length(value)==64 && value !~ /[^a-f0-9]/}
    NR==1 {if($0!="praxity-toolkit-install-ledger-v1") exit 1; next}
    {
      if(NF!=3 || $3=="" || $3 ~ /(^\/|\\|\/\/|\/$|(^|\/)\.\.?(\/|$)|^[A-Za-z]:|\r)/) exit 1
      if($1 ~ /^(D|X|B)$/) {if($2!="-") exit 1}
      else if($1 ~ /^(F|L|Q)$/) {if(!hash($2)) exit 1}
      else if($1=="P") {if($2!="-" && !hash($2)) exit 1}
      else if($1=="U") {if(split($2,parts,":")!=2 || (parts[1]!="-" && !hash(parts[1])) || !hash(parts[2])) exit 1}
      else exit 1
    }
  ' "$LEDGER" || die 'Corrupted install journal; see README recovery'
}
sha256() (
  SHA_OUTPUT=$(shasum -a 256 "$1") || die "Cannot hash file: $1"
  printf '%s\n' "$SHA_OUTPUT" | awk '{print $1}'
)
ledger_key() {
  case "$1" in "$INSTALL_HOME"/*) ;; *) die "Path containment refused: $1" ;; esac
  case "$1" in *"$TAB"*|*'
'*) die "Unsupported ledger path: $1" ;; esac
  printf '%s\n' "${1#"$INSTALL_HOME/"}"
}
ledger_entry() {
  KEY=$(ledger_key "$1")
  awk -F '\t' -v key="$KEY" '$3 == key {row=$0} END {print row}' "$LEDGER"
}
ledger_intent() {
  contained "$1"
  printf '%s\t%s\t%s\n' "$2" "$3" "$(ledger_key "$1")" >> "$LEDGER"
}
ledger_record() (
  contained "$1"
  if [ -d "$1" ]; then TYPE=D; HASH=-
  elif [ -f "$1" ]; then TYPE=F; HASH=$(sha256 "$1")
  else die "Unsupported owned path: $1"; fi
  printf '%s\t%s\t%s\n' "$TYPE" "$HASH" "$(ledger_key "$1")" >> "$LEDGER"
)
ledger_assert() (
  contained "$1"
  ENTRY=$(ledger_entry "$1")
  [ -n "$ENTRY" ] || die "unowned path preserved: $1"
  TYPE=$(printf '%s\n' "$ENTRY" | cut -f 1)
  HASH=$(printf '%s\n' "$ENTRY" | cut -f 2)
  case "$TYPE" in
    D) [ -d "$1" ] || die "Owned directory changed: $1" ;;
    P|B) [ -f "$1" ] || die "Pending output changed: $1" ;;
    U) [ -f "$1" ] || die "Owned file changed: $1"
       ACTUAL=$(sha256 "$1")
       [ "$ACTUAL" = "${HASH%:*}" ] || [ "$ACTUAL" = "${HASH#*:}" ] || die "Owned file changed: $1" ;;
    F) [ -f "$1" ] && [ "$(sha256 "$1")" = "$HASH" ] || die "Installed file damaged or owned file changed: $1" ;;
    *) die "unowned path preserved: $1" ;;
  esac
)
ledger_tree_assert() {
  contained "$1"
  if [ -n "${LEDGER_NODE:-}" ]; then "$LEDGER_NODE" "$SCRIPT_DIR/src/install-ledger.mjs" assert "$INSTALL_HOME" "$ROOT" "$1"; return; fi
  [ ! -e "$1" ] || find "$1" -exec sh "$SCRIPT_DIR/scripts/ledger-tree.sh" "$INSTALL_HOME" "$ROOT" "$SCRIPT_DIR" {} +
}
ledger_tree_record() {
  contained "$1"
  if [ -n "${LEDGER_NODE:-}" ]; then "$LEDGER_NODE" "$SCRIPT_DIR/src/install-ledger.mjs" record "$INSTALL_HOME" "$ROOT" "$1"; return; fi
  # Called only for output in a freshly created or fully preflighted tree.
  find "$1" -type d -print | awk -v home="$INSTALL_HOME/" '{print "D\t-\t" substr($0,length(home)+1)}' >> "$LEDGER"
  find "$1" -type f -exec shasum -a 256 {} + | awk -v home="$INSTALL_HOME/" '{hash=substr($0,1,64); path=substr($0,67); print "F\t" hash "\t" substr(path,length(home)+1)}' >> "$LEDGER"
  find "$1" -type l -exec sh "$SCRIPT_DIR/scripts/ledger-tree.sh" "$INSTALL_HOME" "$ROOT" "$SCRIPT_DIR" --record-links {} +
}
owned_mkdir() {
  contained "$1"
  if [ -e "$1" ]; then ledger_assert "$1"; return; fi
  [ -d "${1%/*}" ] || owned_mkdir "${1%/*}"
  ledger_intent "$1" D -
  mkdir "$1"
  ledger_record "$1"
}
owned_remove_tree() {
  [ -e "$1" ] || return 0
  if [ -n "${LEDGER_NODE:-}" ]; then "$LEDGER_NODE" "$SCRIPT_DIR/src/install-ledger.mjs" remove "$INSTALL_HOME" "$ROOT" "$1"; return; fi
  ledger_tree_assert "$1"
  # find -depth removes each recorded entry. Never recursively delete a parent.
  find "$1" -depth -exec sh "$SCRIPT_DIR/scripts/ledger-tree.sh" "$INSTALL_HOME" "$ROOT" "$SCRIPT_DIR" --remove {} +
}

owned_destination() {
  contained "$1"
  [ ! -e "$1" ] && [ ! -L "$1" ] || ledger_assert "$1"
}
owned_publish() {
  SOURCE=$1; DESTINATION=$2
  ledger_assert "$SOURCE"
  owned_destination "$DESTINATION"
  OLD=-
  [ ! -f "$DESTINATION" ] || OLD=$(sha256 "$DESTINATION")
  NEW=$(sha256 "$SOURCE")
  # A killed rename accepts only the old or new recorded bytes on recovery.
  printf 'U\t%s:%s\t%s\n' "$OLD" "$NEW" "$(ledger_key "$DESTINATION")" >> "$LEDGER"
  mv -f "$SOURCE" "$DESTINATION"
  ledger_record "$DESTINATION"
  printf 'X\t-\t%s\n' "$(ledger_key "$SOURCE")" >> "$LEDGER"
}
new_temp() {
  # Select an absent name, journal it, then create exclusively. mktemp's create
  # would leave an unrecorded file if killed before its next command.
  TEMPORARY=$(mktemp -u "${1:-$WORK/item}.XXXXXX") || die 'Cannot choose metadata temporary'
  contained "$TEMPORARY"
  [ ! -e "$TEMPORARY" ] && [ ! -L "$TEMPORARY" ] || die 'Temporary already exists'
  ledger_intent "$TEMPORARY" B -
  (set -C; : > "$TEMPORARY") || die 'Cannot create exclusive metadata temporary'
  ledger_record "$TEMPORARY"
  printf '%s\n' "$TEMPORARY"
}
capture() {
  OUTPUT=$1; shift
  ledger_assert "$OUTPUT"
  ledger_intent "$OUTPUT" B -
  STATUS=0
  "$@" > "$OUTPUT" || STATUS=$?
  ledger_record "$OUTPUT"
  return "$STATUS"
}
fetch() {
  OUTPUT=$1; URL=$2
  ledger_assert "$OUTPUT"
  ledger_intent "$OUTPUT" P "${3:--}"
  STATUS=0
  (cd -- "${OUTPUT%/*}" && curl --fail --location --proto '=https,file' --proto-redir '=https' --connect-timeout 15 --max-time 300 --retry 2 --output "${OUTPUT##*/}" "$URL") || STATUS=$?
  ledger_record "$OUTPUT"
  return "$STATUS"
}

ledger_root_assert() {
  for PATH_NAME in "$ROOT"/* "$ROOT"/.[!.]* "$ROOT"/..?*; do
    [ -e "$PATH_NAME" ] || [ -L "$PATH_NAME" ] || continue
    [ "$PATH_NAME" = "$LEDGER" ] && continue
    ledger_tree_assert "$PATH_NAME"
  done
}
