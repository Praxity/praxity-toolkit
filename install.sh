#!/bin/sh
# Run from a reviewed checkout. No system Node, sudo or shell-profile edits.
set -eu
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ROOT="$HOME/.praxity/toolkit"
BIN="$HOME/.praxity/bin"
ACTION=install
MANIFEST=
PLATFORM=
die() { printf '%s\n' "$*" >&2; exit 1; }
while [ "$#" -gt 0 ]; do
  case "$1" in
    install|rollback|uninstall) ACTION=$1; shift ;;
    --manifest) [ "$#" -ge 2 ] || die 'Missing --manifest value'; MANIFEST=$2; shift 2 ;;
    --platform) [ "$#" -ge 2 ] || die 'Missing --platform value'; PLATFORM=$2; shift 2 ;;
    *) die "Unknown argument: $1" ;;
  esac
done
case "$HOME" in /*) ;; *) die 'HOME must be an absolute path' ;; esac
case "$HOME" in *'
'*) die 'HOME must not contain newlines' ;; esac
# Resolve HOME once, then refuse symlinks in every descendant ancestor.
HOME=$(CDPATH= cd -P -- "$HOME" && pwd -P) || die 'Cannot resolve HOME'
ROOT="$HOME/.praxity/toolkit"
BIN="$HOME/.praxity/bin"
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
    # Resumed stages are checked in full before the first extraction or copy.
    find "$1" -type l -exec sh -c 'for path do echo "Stage symlink refused: $path" >&2; done' sh {} + > /dev/null
    [ -z "$(find "$1" -type l -print)" ] || die "Stage symlink refused: $1"
  fi
}
contained "$ROOT"
mkdir -p "$ROOT"
[ ! -L "$ROOT/.install-lock" ] || die 'Install lock is a symlink'
if ! mkdir "$ROOT/.install-lock" 2>/dev/null; then
  PID=$(cat "$ROOT/.install-lock/pid" 2>/dev/null || true)
  case "$PID" in ''|*[!0-9]*) die "Install locked: $ROOT/.install-lock. Inspect the lock before removing it." ;; esac
  if kill -0 "$PID" 2>/dev/null; then die "Install locked by process $PID"; fi
  # A dead process left the lock. Only its two known entries are removed.
  rm -f "$ROOT/.install-lock/pid"
  rmdir "$ROOT/.install-lock" || die 'Lock contains unexpected files'
  mkdir "$ROOT/.install-lock" || die 'Another installer acquired the lock'
fi
printf '%s\n' "$$" > "$ROOT/.install-lock/pid"
LAUNCHER_TEMP=
cleanup() {
  [ -z "$LAUNCHER_TEMP" ] || rm -f "$LAUNCHER_TEMP"
  rm -f "$ROOT/.install-lock/pid"
  rmdir "$ROOT/.install-lock"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

sha256() {
  if command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | awk '{print $1}';
  elif command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}';
  else die 'Install needs shasum or sha256sum'; fi
}
safe_version() {
  printf '%s\n' "$1" | LC_ALL=C awk 'BEGIN {ok=0} /^[0-9]+\.[0-9]+\.[0-9]+(-[a-zA-Z0-9.-]+)?$/ {ok=1} END {exit !ok}' || die 'Invalid pack version'
}
owned_version() {
  safe_version "$1"
  [ ! -L "$ROOT/$1" ] && [ "$(cat "$ROOT/$1/.praxity-install" 2>/dev/null)" = praxity-toolkit ] || die "Unowned pack: $1"
}
activate() {
  owned_version "$1"
  [ -z "$2" ] || owned_version "$2"
  # One rename commits both pointers, including rollback after interruption.
  printf '%s\n%s\n' "$1" "$2" > "$ROOT/active.tmp"
  mv -f "$ROOT/active.tmp" "$ROOT/active"
}
launcher_owned() {
  [ ! -e "$BIN/praxity" ] && return 0
  [ ! -L "$BIN/praxity" ] || die 'Launcher is an unowned symlink'
  [ -f "$ROOT/.launcher-sha256" ] && [ "$(sha256 "$BIN/praxity")" = "$(cat "$ROOT/.launcher-sha256")" ] || die "Launcher changed or is unowned: $BIN/praxity"
}
if [ "$ACTION" = rollback ]; then
  CURRENT=$(sed -n '1p' "$ROOT/active" 2>/dev/null) || die 'No current pack'
  PREVIOUS=$(sed -n '2p' "$ROOT/active" 2>/dev/null) || die 'No previous pack to roll back to'
  [ -n "$PREVIOUS" ] || die 'No previous pack to roll back to'
  owned_version "$CURRENT"; owned_version "$PREVIOUS"; launcher_owned
  "$ROOT/$CURRENT/runtimes/node/bin/node" "$ROOT/$CURRENT/src/install.mjs" verify "$ROOT/$PREVIOUS/pack.json" darwin-arm64 "$ROOT/$PREVIOUS"
  activate "$PREVIOUS" "$CURRENT"
  printf 'Active pack: %s\n' "$PREVIOUS"
  exit 0
fi
if [ "$ACTION" = uninstall ]; then
  launcher_owned
  # Preserve unrelated ~/.praxity data, tool components and host skills.
  for DIRECTORY in "$ROOT"/*; do
    [ -d "$DIRECTORY" ] || continue
    VERSION_NAME=${DIRECTORY##*/}
    owned_version "$VERSION_NAME"
  done
  rm -f "$BIN/praxity"
  for DIRECTORY in "$ROOT"/*; do [ ! -d "$DIRECTORY" ] || rm -rf -- "$DIRECTORY"; done
  for DIRECTORY in "$ROOT"/.cache "$ROOT"/.staging-* "$ROOT"/.bootstrap-*; do
    [ ! -e "$DIRECTORY" ] || { [ ! -L "$DIRECTORY" ] || die 'Unowned staging symlink'; rm -rf -- "$DIRECTORY"; }
  done
  rm -f "$ROOT/active" "$ROOT/active.tmp" "$ROOT/.launcher-sha256" "$ROOT/.manifest.json" "$ROOT/.manifest.tsv" "$ROOT/.plan.tsv" "$ROOT/.archive-list" "$ROOT/.archive-links"
  printf '%s\n' 'Toolkit removed. Host skills and optional tool components remain installed and are tracked separately.'
  exit 0
fi

command -v curl >/dev/null 2>&1 || die 'Install needs curl'
command -v tar >/dev/null 2>&1 || die 'Install needs tar'
command -v mktemp >/dev/null 2>&1 || die 'Install needs mktemp'
if [ -z "$PLATFORM" ]; then
  OS=$(uname -s); CPU=$(uname -m)
  case "$OS:$CPU" in Darwin:arm64) PLATFORM=darwin-arm64 ;; *) die "Unsupported platform: $OS $CPU. Only Apple Silicon macOS is implemented." ;; esac
fi
[ "$PLATFORM" = darwin-arm64 ] || die "Platform not implemented: $PLATFORM"
if [ -z "$MANIFEST" ]; then cp "$SCRIPT_DIR/pack.json" "$ROOT/.manifest.json";
else
  case "$MANIFEST" in https://*|file:///*) ;; *) die 'Manifest must use https:// or file:///' ;; esac
  (cd "$ROOT" && curl --fail --location --proto '=https,file' --proto-redir '=https' --connect-timeout 15 --max-time 300 --retry 2 --output .manifest.json "$MANIFEST") || die 'Manifest download failed; rerun the same command after resolving it'
fi
awk -f "$SCRIPT_DIR/scripts/bootstrap-json.awk" "$ROOT/.manifest.json" > "$ROOT/.manifest.tsv"
get() { awk -F '\t' -v key="$1" '$1 == key {print $2}' "$ROOT/.manifest.tsv"; }
VERSION=$(get /version)
safe_version "$VERSION"
NODE_URL=$(get "/runtimes/node/archives/$PLATFORM/url")
NODE_SHA=$(get "/runtimes/node/archives/$PLATFORM/sha256")
NODE_FORMAT=$(get "/runtimes/node/archives/$PLATFORM/format")
NODE_STRIP=$(get "/runtimes/node/archives/$PLATFORM/stripComponents")
NODE_ENTRY=$(get "/runtimes/node/entry/$PLATFORM")
case "$NODE_ENTRY" in bin/node) ;; *) die 'Unsupported bootstrap Node entry' ;; esac
[ "$NODE_STRIP" = 0 ] || [ "$NODE_STRIP" = 1 ] || die 'Invalid bootstrap stripComponents'
case "$NODE_FORMAT" in tar.gz|tar.xz) ;; *) die 'Unsupported bootstrap Node archive' ;; esac
mkdir -p "$ROOT/.cache"
[ ! -L "$ROOT/.cache" ] || die 'Cache directory is a symlink'
download() (
  URL=$1; HASH=$2; FORMAT=$3
  case "$URL" in https://*|file:///*) ;; *) die 'Artifact URL must use https:// or file:///' ;; esac
  [ "${#HASH}" = 64 ] || die 'Invalid SHA-256'
  case "$HASH" in *[!a-f0-9]*) die 'Invalid SHA-256' ;; esac
  cd "$ROOT/.cache"
  FILE="$HASH.$FORMAT"
  if [ -f "$FILE" ]; then
    [ "$(sha256 "$FILE")" = "$HASH" ] || die "Cached checksum mismatch: $FILE. Remove the damaged cache file and rerun."
    exit 0
  fi
  printf 'Download: %s\n' "$URL"
  # Interrupted partial files are retried; complete verified downloads survive.
  curl --fail --location --proto '=https,file' --proto-redir '=https' --connect-timeout 15 --max-time 300 --retry 2 --output "$FILE.part" "$URL" || die 'Download interrupted or failed; rerun the same install command'
  [ "$(sha256 "$FILE.part")" = "$HASH" ] || { rm -f "$FILE.part"; die "Checksum mismatch: $URL. Nothing activated."; }
  mv "$FILE.part" "$FILE"
)
extract() (
  ARCHIVE=$1; DIRECTORY=$2; STRIP=$3
  contained "$DIRECTORY"
  [ ! -L "$DIRECTORY" ] || die 'Staging destination is a symlink'
  tar -P -tf "$ARCHIVE" > "$ROOT/.archive-list"
  LC_ALL=C awk '
    /^\// || /(^|\/)\.\.(\/|$)/ || /\\/ || /^[A-Za-z]:/ {exit 1}
  ' "$ROOT/.archive-list" || die 'Unsafe archive path'
  tar -P -tvf "$ARCHIVE" > "$ROOT/.archive-links"
  LC_ALL=C awk -v strip="$STRIP" -f "$SCRIPT_DIR/scripts/archive-links.awk" "$ROOT/.archive-links" || die 'Unsafe archive link or special file'
  rm -rf -- "$DIRECTORY"
  mkdir -p "$DIRECTORY"
  tar -xf "$ARCHIVE" -C "$DIRECTORY" --strip-components="$STRIP"
  rm -f "$ROOT/.archive-list" "$ROOT/.archive-links"
)
download "$NODE_URL" "$NODE_SHA" "$NODE_FORMAT"
BOOTSTRAP="$ROOT/.bootstrap-$VERSION"
extract "$ROOT/.cache/$NODE_SHA.$NODE_FORMAT" "$BOOTSTRAP" "$NODE_STRIP"
NODE="$BOOTSTRAP/$NODE_ENTRY"
[ "$("$NODE" --version)" = "v$(get /runtimes/node/version)" ] || die 'Downloaded Node does not match its declared version'
"$NODE" "$SCRIPT_DIR/src/install.mjs" plan "$ROOT/.manifest.json" "$PLATFORM" > "$ROOT/.plan.tsv"
MANIFEST_SHA=$(sha256 "$ROOT/.manifest.json")
if [ -e "$ROOT/$VERSION" ]; then
  owned_version "$VERSION"
  "$NODE" "$SCRIPT_DIR/src/install.mjs" verify "$ROOT/.manifest.json" "$PLATFORM" "$ROOT/$VERSION"
else
  STAGE="$ROOT/.staging-$VERSION"
  check_stage "$STAGE"
  [ ! -L "$STAGE" ] || die 'Staging directory is a symlink'
  mkdir -p "$STAGE"
  if [ -f "$STAGE/.manifest-sha256" ]; then [ "$(cat "$STAGE/.manifest-sha256")" = "$MANIFEST_SHA" ] || die 'Interrupted stage has a different manifest; choose a new pack version'; fi
  printf '%s\n' "$MANIFEST_SHA" > "$STAGE/.manifest-sha256"
  TAB=$(printf '\t')
  # Verify every archive first. No installed version or launcher appears on a
  # checksum failure, and a previous active version continues to work.
  while IFS="$TAB" read -r KIND ID URL HASH FORMAT STRIP ENTRY; do download "$URL" "$HASH" "$FORMAT"; done < "$ROOT/.plan.tsv"
  while IFS="$TAB" read -r KIND ID URL HASH FORMAT STRIP ENTRY; do
    case "$KIND" in runtime) CATEGORY=runtimes ;; tool) CATEGORY=tools ;; *) die 'Invalid install plan' ;; esac
    extract "$ROOT/.cache/$HASH.$FORMAT" "$STAGE/$CATEGORY/$ID" "$STRIP"
  done < "$ROOT/.plan.tsv"
  for DIRECTORY in src scripts schemas skills fixtures; do
    contained "$STAGE/$DIRECTORY"
    [ ! -e "$STAGE/$DIRECTORY" ] || rm -rf -- "$STAGE/$DIRECTORY"
    cp -R "$SCRIPT_DIR/$DIRECTORY" "$STAGE/$DIRECTORY"
  done
  cp "$SCRIPT_DIR/install.sh" "$SCRIPT_DIR/package.json" "$STAGE/"
  cp "$ROOT/.manifest.json" "$STAGE/pack.json"
  "$NODE" "$SCRIPT_DIR/src/install.mjs" finalize "$STAGE/pack.json" "$PLATFORM" "$STAGE" "$ROOT"
  launcher_owned
  mv "$STAGE" "$ROOT/$VERSION"
fi
launcher_owned
mkdir -p "$BIN"
[ ! -L "$BIN" ] || die 'Bin directory is an unowned symlink'
# Exclusive temporary names let a killed activation be retried without touching
# an unowned file or depending on a stale fixed temporary filename.
LAUNCHER_TEMP=$(mktemp "$BIN/.praxity-launcher.XXXXXX")
cp "$ROOT/$VERSION/launcher.sh" "$LAUNCHER_TEMP"
chmod +x "$LAUNCHER_TEMP"
mv -f "$LAUNCHER_TEMP" "$BIN/praxity"
LAUNCHER_TEMP=
sha256 "$BIN/praxity" > "$ROOT/.launcher-sha256"
CURRENT=$(sed -n '1p' "$ROOT/active" 2>/dev/null || true)
PREVIOUS=$(sed -n '2p' "$ROOT/active" 2>/dev/null || true)
if [ -n "$CURRENT" ] && [ "$CURRENT" != "$VERSION" ]; then
  owned_version "$CURRENT"
  PREVIOUS=$CURRENT
fi
activate "$VERSION" "$PREVIOUS"
rm -rf -- "$BOOTSTRAP"
printf 'Installed pack %s. Add this line to PATH yourself:\n' "$VERSION"
printf 'export PATH="$HOME/.praxity/bin:$PATH"\n'
printf '%s\n' 'Close Studio before rollback or uninstall. Optional components require praxity setup consent.'
"$BIN/praxity" doctor
