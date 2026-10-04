contained() (
  case "$1" in "$HOME"/*) ;; *) die "Path containment refused: $1" ;; esac
  case "$1" in */../*|*/./*|*/..|*/.) die "Unnormalized path refused: $1" ;; esac
  CURSOR=$1
  while [ "$CURSOR" != "$HOME" ]; do
    [ ! -L "$CURSOR" ] || die "Ancestor symlink refused: $CURSOR"
    if [ -d "$CURSOR" ]; then
      RESOLVED=$(CDPATH= cd -P -- "$CURSOR" && pwd -P) || die 'Cannot resolve path'
      case "$RESOLVED" in "$HOME"/*) ;; *) die "Path containment refused: $CURSOR" ;; esac
    fi
    CURSOR=${CURSOR%/*}
  done
)
check_stage() {
  contained "$1"
  if [ -d "$1" ]; then
    # Node checks every resumed link against the whole stage. Recorded internal
    # archive links remain valid; extraction still checks its own ancestors.
    "$NODE" "$SCRIPT_DIR/src/install.mjs" inspect "${MANIFEST_FILE:-$ROOT/.manifest.json}" "$PLATFORM" "$1"
  fi
}
