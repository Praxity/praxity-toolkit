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
. "$SCRIPT_DIR/scripts/install-paths.sh"
. "$SCRIPT_DIR/scripts/install-ledger.sh"
contained "$ROOT"
command -v shasum >/dev/null 2>&1 || die 'Install needs shasum -a 256'
# Only absent paths are claimed. Existing parents remain unowned containers.
NEW_PARENT=
NEW_ROOT=
if [ ! -e "$HOME/.praxity" ]; then mkdir "$HOME/.praxity"; NEW_PARENT=1; fi
if [ ! -e "$ROOT" ]; then mkdir "$ROOT"; NEW_ROOT=1; fi
[ ! -L "$LEDGER" ] || die 'Ledger symlink refused'
if [ ! -e "$LEDGER" ]; then
  (set -C; printf 'praxity-toolkit-install-ledger-v1\n' > "$LEDGER") || die 'Cannot create ownership ledger exclusively'
fi
[ "$(sed -n '1p' "$LEDGER")" = praxity-toolkit-install-ledger-v1 ] || die 'Unrecognized install ledger'
[ -z "$NEW_PARENT" ] || ledger_record "$HOME/.praxity"
[ -z "$NEW_ROOT" ] || ledger_record "$ROOT"
[ ! -L "$ROOT/.install-lock" ] || die 'Install lock is a symlink'
if [ -e "$ROOT/.install-lock" ]; then
  contained "$ROOT/.install-lock/pid"
  PID=$(cat "$ROOT/.install-lock/pid" 2>/dev/null || true)
  case "$PID" in ''|*[!0-9]*) die 'Install locked; inspect the lock' ;; esac
  if kill -0 "$PID" 2>/dev/null; then die "Install locked by process $PID"; fi
  owned_remove_tree "$ROOT/.install-lock"
fi
owned_mkdir "$ROOT/.install-lock"
printf '%s\n' "$$" > "$ROOT/.install-lock/pid"
ledger_record "$ROOT/.install-lock/pid"
LAUNCHER_TEMP=
LEDGER_NODE=
cleanup() {
  [ -z "$LAUNCHER_TEMP" ] || owned_remove_tree "$LAUNCHER_TEMP"
  owned_remove_tree "$ROOT/.install-lock"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
safe_version() {
  printf '%s\n' "$1" | LC_ALL=C awk 'BEGIN {ok=0} /^[0-9]+\.[0-9]+\.[0-9]+(-[a-zA-Z0-9.-]+)?$/ {ok=1} END {exit !ok}' || die 'Invalid pack version'
}
owned_version() {
  safe_version "$1"
  ledger_assert "$ROOT/$1"
  ledger_tree_assert "$ROOT/$1"
}
activate() {
  owned_version "$1"
  [ -z "$2" ] || owned_version "$2"
  printf '%s\n%s\n' "$1" "$2" > "$ROOT/active.tmp"
  ledger_record "$ROOT/active.tmp"
  mv -f "$ROOT/active.tmp" "$ROOT/active"
  ledger_record "$ROOT/active"
}
launcher_owned() {
  [ ! -e "$BIN/praxity" ] && [ ! -L "$BIN/praxity" ] && return 0
  ledger_assert "$BIN/praxity"
}
if [ -f "$ROOT/active" ]; then
  ledger_assert "$ROOT/active"
  ACTIVE_VERSION=$(sed -n '1p' "$ROOT/active")
  safe_version "$ACTIVE_VERSION"
  ledger_assert "$ROOT/$ACTIVE_VERSION/runtimes/node/bin/node"
  LEDGER_NODE="$ROOT/$ACTIVE_VERSION/runtimes/node/bin/node"
fi
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
  # Preflight all content before deleting any installer output. User additions
  # inside installed versions, caches and stages remain and name the refusal.
  ledger_root_assert
  [ ! -e "$BIN/praxity" ] || owned_remove_tree "$BIN/praxity"
  for PATH_NAME in "$ROOT"/* "$ROOT"/.[!.]* "$ROOT"/..?*; do
    [ -e "$PATH_NAME" ] || continue
    case "$PATH_NAME" in "$LEDGER"|"$ROOT/.install-lock"|"$ROOT/${ACTIVE_VERSION:-}") continue ;; esac
    owned_remove_tree "$PATH_NAME"
  done
  owned_remove_tree "$ROOT/.install-lock"
  trap - EXIT
  if [ -n "${ACTIVE_VERSION:-}" ]; then owned_remove_tree "$ROOT/$ACTIVE_VERSION"; fi
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
ledger_record "$ROOT/.manifest.json"
awk -f "$SCRIPT_DIR/scripts/bootstrap-json.awk" "$ROOT/.manifest.json" > "$ROOT/.manifest.tsv"
ledger_record "$ROOT/.manifest.tsv"
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
owned_mkdir "$ROOT/.cache"
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
    ledger_assert "$ROOT/.cache/$FILE"
    exit 0
  fi
  [ ! -e "$FILE.part" ] || ledger_assert "$ROOT/.cache/$FILE.part"
  printf 'Download: %s\n' "$URL"
  # Interrupted partial files are retried; complete verified downloads survive.
  curl --fail --location --proto '=https,file' --proto-redir '=https' --connect-timeout 15 --max-time 300 --retry 2 --output "$FILE.part" "$URL" || { [ ! -f "$FILE.part" ] || ledger_record "$ROOT/.cache/$FILE.part"; die 'Download interrupted or failed; rerun the same install command'; }
  ledger_record "$ROOT/.cache/$FILE.part"
  [ "$(sha256 "$FILE.part")" = "$HASH" ] || { owned_remove_tree "$ROOT/.cache/$FILE.part"; die "Checksum mismatch: $URL. Nothing activated."; }
  mv "$FILE.part" "$FILE"
  ledger_record "$ROOT/.cache/$FILE"
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
  owned_remove_tree "$DIRECTORY"
  owned_mkdir "$DIRECTORY"
  tar -xf "$ARCHIVE" -C "$DIRECTORY" --strip-components="$STRIP"
  ledger_tree_record "$DIRECTORY"
  ledger_record "$ROOT/.archive-list"; ledger_record "$ROOT/.archive-links"
  owned_remove_tree "$ROOT/.archive-list"; owned_remove_tree "$ROOT/.archive-links"
)
download "$NODE_URL" "$NODE_SHA" "$NODE_FORMAT"
BOOTSTRAP="$ROOT/.bootstrap-$VERSION"
extract "$ROOT/.cache/$NODE_SHA.$NODE_FORMAT" "$BOOTSTRAP" "$NODE_STRIP"
NODE="$BOOTSTRAP/$NODE_ENTRY"
LEDGER_NODE="$NODE"
[ "$("$NODE" --version)" = "v$(get /runtimes/node/version)" ] || die 'Downloaded Node does not match its declared version'
"$NODE" "$SCRIPT_DIR/src/install.mjs" plan "$ROOT/.manifest.json" "$PLATFORM" > "$ROOT/.plan.tsv"
ledger_record "$ROOT/.plan.tsv"
MANIFEST_SHA=$(sha256 "$ROOT/.manifest.json")
ledger_root_assert
if [ -e "$ROOT/$VERSION" ]; then
  owned_version "$VERSION"
  "$NODE" "$SCRIPT_DIR/src/install.mjs" verify "$ROOT/.manifest.json" "$PLATFORM" "$ROOT/$VERSION"
else
  STAGE="$ROOT/.staging-$VERSION"
  check_stage "$STAGE"
  [ ! -L "$STAGE" ] || die 'Staging directory is a symlink'
  [ ! -e "$STAGE" ] || ledger_tree_assert "$STAGE"
  owned_mkdir "$STAGE"
  if [ -f "$STAGE/.manifest-sha256" ]; then [ "$(cat "$STAGE/.manifest-sha256")" = "$MANIFEST_SHA" ] || die 'Interrupted stage has a different manifest; choose a new pack version'; fi
  printf '%s\n' "$MANIFEST_SHA" > "$STAGE/.manifest-sha256"
  ledger_record "$STAGE/.manifest-sha256"
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
    owned_remove_tree "$STAGE/$DIRECTORY"
    cp -R "$SCRIPT_DIR/$DIRECTORY" "$STAGE/$DIRECTORY"
    ledger_tree_record "$STAGE/$DIRECTORY"
  done
  cp "$SCRIPT_DIR/install.sh" "$SCRIPT_DIR/package.json" "$STAGE/"
  ledger_record "$STAGE/install.sh"; ledger_record "$STAGE/package.json"
  cp "$ROOT/.manifest.json" "$STAGE/pack.json"
  ledger_record "$STAGE/pack.json"
  "$NODE" "$SCRIPT_DIR/src/install.mjs" finalize "$STAGE/pack.json" "$PLATFORM" "$STAGE" "$ROOT"
  ledger_tree_record "$STAGE"
  launcher_owned
  mv "$STAGE" "$ROOT/$VERSION"
  ledger_tree_record "$ROOT/$VERSION"
fi
launcher_owned
if [ ! -e "$BIN" ]; then owned_mkdir "$BIN"; else contained "$BIN"; fi
[ ! -L "$BIN" ] || die 'Bin directory is an unowned symlink'
# Exclusive temporary names let a killed activation be retried without touching
# an unowned file or depending on a stale fixed temporary filename.
LAUNCHER_TEMP=$(mktemp "$BIN/.praxity-launcher.XXXXXX")
cp "$ROOT/$VERSION/launcher.sh" "$LAUNCHER_TEMP"
chmod +x "$LAUNCHER_TEMP"
ledger_record "$LAUNCHER_TEMP"
mv -f "$LAUNCHER_TEMP" "$BIN/praxity"
LAUNCHER_TEMP=
ledger_record "$BIN/praxity"
sha256 "$BIN/praxity" > "$ROOT/.launcher-sha256"
ledger_record "$ROOT/.launcher-sha256"
CURRENT=$(sed -n '1p' "$ROOT/active" 2>/dev/null || true)
PREVIOUS=$(sed -n '2p' "$ROOT/active" 2>/dev/null || true)
if [ -n "$CURRENT" ] && [ "$CURRENT" != "$VERSION" ]; then
  owned_version "$CURRENT"
  PREVIOUS=$CURRENT
fi
activate "$VERSION" "$PREVIOUS"
LEDGER_NODE="$ROOT/$VERSION/runtimes/node/$NODE_ENTRY"
owned_remove_tree "$BOOTSTRAP"
printf 'Installed pack %s. Add this line to PATH yourself:\n' "$VERSION"
printf 'export PATH="$HOME/.praxity/bin:$PATH"\n'
printf '%s\n' 'Close Studio before rollback or uninstall. Optional components require praxity setup consent.'
"$BIN/praxity" doctor
