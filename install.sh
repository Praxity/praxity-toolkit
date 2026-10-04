#!/bin/sh
# Run from a reviewed checkout. No system Node, sudo or shell-profile edits.
set -eu
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ROOT="$HOME/.praxity/toolkit"
BIN="$HOME/.praxity/bin"
ACTION=install
MANIFEST=
MANIFEST_DIGEST=
PLATFORM=
die() { printf '%s\n' "$*" >&2; exit 1; }
while [ "$#" -gt 0 ]; do
  case "$1" in
    install|rollback|uninstall) ACTION=$1; shift ;;
    --manifest) [ "$#" -ge 2 ] || die 'Missing --manifest value'; MANIFEST=$2; shift 2 ;;
    --manifest-sha256) [ "$#" -ge 2 ] || die 'Missing --manifest-sha256 value'; MANIFEST_DIGEST=$2; shift 2 ;;
    --platform) [ "$#" -ge 2 ] || die 'Missing --platform value'; PLATFORM=$2; shift 2 ;;
    *) die "Unknown argument: $1" ;;
  esac
done
case "$HOME" in /*) ;; *) die 'HOME must be an absolute path' ;; esac
case "$HOME" in *'
'*) die 'HOME must not contain newlines' ;; esac
# Resolve HOME once, then refuse symlinks in every descendant ancestor.
INSTALL_HOME=$(CDPATH= cd -P -- "$HOME" && pwd -P) || die 'Cannot resolve HOME'
ROOT="$INSTALL_HOME/.praxity/toolkit"
BIN="$INSTALL_HOME/.praxity/bin"
. "$SCRIPT_DIR/scripts/install-paths.sh"
. "$SCRIPT_DIR/scripts/install-ledger.sh"
contained "$ROOT"
command -v shasum >/dev/null 2>&1 || die 'Install needs shasum -a 256'
# Only absent paths are claimed. Existing parents remain unowned containers.
[ ! -L "$LEDGER" ] || die 'Ledger symlink refused'
if [ ! -e "$LEDGER" ]; then
  # The first journal lives in HOME until its recorded parents exist.
  INITIAL_LEDGER="$INSTALL_HOME/.praxity-toolkit-bootstrap.tsv"
  contained "$INITIAL_LEDGER"
  if [ ! -e "$INITIAL_LEDGER" ]; then
    (set -C
      { printf 'praxity-toolkit-install-ledger-v1\n'
        [ -d "$INSTALL_HOME/.praxity" ] || printf 'D\t-\t.praxity\n'
        [ -d "$ROOT" ] || printf 'D\t-\t.praxity/toolkit\n'
      } > "$INITIAL_LEDGER"
    ) || die 'Cannot create ownership ledger exclusively'
  fi
  LEDGER="$INITIAL_LEDGER"
  ledger_validate
  [ -d "$INSTALL_HOME/.praxity" ] || owned_mkdir "$INSTALL_HOME/.praxity"
  [ -d "$ROOT" ] || owned_mkdir "$ROOT"
  mv "$LEDGER" "$ROOT/.install-ledger.tsv"
  LEDGER="$ROOT/.install-ledger.tsv"
fi
[ "$(sed -n '1p' "$LEDGER")" = praxity-toolkit-install-ledger-v1 ] || die 'Unrecognized install ledger'
ledger_validate
[ ! -L "$ROOT/.install-lock" ] || die 'Install lock is a symlink'
if [ -e "$ROOT/.install-lock" ]; then
  contained "$ROOT/.install-lock/pid"
  PID=$(cat "$ROOT/.install-lock/pid" 2>/dev/null || true)
  case "$PID" in
    '') ledger_assert "$ROOT/.install-lock" ;;
    *[!0-9]*) die 'Install locked; inspect the lock' ;;
    *) if kill -0 "$PID" 2>/dev/null; then die "Install locked by process $PID"; fi ;;
  esac
  owned_remove_tree "$ROOT/.install-lock"
fi
owned_mkdir "$ROOT/.install-lock"
LOCK_HASH=$(printf '%s\n' "$$" | shasum -a 256 | awk '{print $1}')
ledger_intent "$ROOT/.install-lock/pid" P "$LOCK_HASH"
printf '%s\n' "$$" > "$ROOT/.install-lock/pid"
ledger_record "$ROOT/.install-lock/pid"
LAUNCHER_TEMP=
WORK=
LEDGER_NODE=
cleanup() {
  [ -z "$LAUNCHER_TEMP" ] || owned_remove_tree "$LAUNCHER_TEMP"
  [ -z "$WORK" ] || owned_remove_tree "$WORK"
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
  [ -z "$2" ] || safe_version "$2"
  ACTIVATION=$(new_temp)
  capture "$ACTIVATION" printf '%s\n%s\n' "$1" "$2"
  owned_publish "$ACTIVATION" "$ROOT/active"
}
launcher_owned() {
  [ ! -e "$BIN/praxity" ] && [ ! -L "$BIN/praxity" ] && return 0
  ledger_assert "$BIN/praxity"
}
for METADATA in active active.tmp .manifest.json .manifest.tsv .plan.tsv .archive-list .archive-links .launcher-sha256; do
  owned_destination "$ROOT/$METADATA"
done
WORK=$(mktemp -u "$ROOT/.metadata.XXXXXX")
owned_mkdir "$WORK"
if [ -f "$ROOT/active" ]; then
  ledger_assert "$ROOT/active"
  ACTIVE_VERSION=$(sed -n '1p' "$ROOT/active")
  safe_version "$ACTIVE_VERSION"
  LEDGER_VERSION=$ACTIVE_VERSION
  if [ "$ACTION" = rollback ]; then
    LEDGER_VERSION=$(sed -n '2p' "$ROOT/active")
    [ -n "$LEDGER_VERSION" ] || die 'No previous pack to roll back to'
    safe_version "$LEDGER_VERSION"
  fi
  ledger_assert "$ROOT/$LEDGER_VERSION/runtimes/node/bin/node"
  LEDGER_NODE="$ROOT/$LEDGER_VERSION/runtimes/node/bin/node"
fi
if [ "$ACTION" = rollback ]; then
  CURRENT=$(sed -n '1p' "$ROOT/active" 2>/dev/null) || die 'No current pack'
  PREVIOUS=$(sed -n '2p' "$ROOT/active" 2>/dev/null) || die 'No previous pack to roll back to'
  [ -n "$PREVIOUS" ] || die 'No previous pack to roll back to'
  owned_version "$PREVIOUS"; launcher_owned
  "$LEDGER_NODE" "$SCRIPT_DIR/src/install.mjs" verify "$ROOT/$PREVIOUS/pack.json" darwin-arm64 "$ROOT/$PREVIOUS"
  # Outgoing damage is diagnostic only. Nothing in that pack is removed.
  if ! ledger_tree_assert "$ROOT/$CURRENT" 2>/dev/null; then printf 'Damaged outgoing pack preserved: %s\n' "$CURRENT" >&2; fi
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
  WORK=
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
MANIFEST_FILE=$(new_temp)
BOOTSTRAP_TSV=$(new_temp)
if [ -z "$MANIFEST" ]; then capture "$MANIFEST_FILE" cat "$SCRIPT_DIR/pack.json";
else
  case "$MANIFEST" in https://*|file:///*) ;; *) die 'Manifest must use https:// or file:///' ;; esac
  fetch "$MANIFEST_FILE" "$MANIFEST" || die 'Manifest download failed; rerun the same command after resolving it'
fi
if [ -n "$MANIFEST_DIGEST" ]; then
  [ "${#MANIFEST_DIGEST}" = 64 ] || die 'Invalid reviewed manifest digest'
  case "$MANIFEST_DIGEST" in *[!a-f0-9]*) die 'Invalid reviewed manifest digest' ;; esac
else
  case "$MANIFEST" in https://*) MANIFEST_DIGEST=$(sha256 "$SCRIPT_DIR/pack.json") ;; esac
fi
if [ -n "$MANIFEST_DIGEST" ]; then
  [ "$(sha256 "$MANIFEST_FILE")" = "$MANIFEST_DIGEST" ] || die 'Manifest SHA-256 mismatch. Supply the reviewed digest with --manifest-sha256 before selecting Node.'
fi
capture "$BOOTSTRAP_TSV" awk -f "$SCRIPT_DIR/scripts/bootstrap-json.awk" "$MANIFEST_FILE"
get() { awk -F '\t' -v key="$1" '$1 == key {print $2}' "$BOOTSTRAP_TSV"; }
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
[ ! -L "$ROOT/.cache" ] || die 'Cache directory is a symlink'
download() (
  URL=$1; HASH=$2; FORMAT=$3
  case "$URL" in https://*|file:///*) ;; *) die 'Artifact URL must use https:// or file:///' ;; esac
  [ "${#HASH}" = 64 ] || die 'Invalid SHA-256'
  case "$HASH" in *[!a-f0-9]*) die 'Invalid SHA-256' ;; esac
  contained "$ROOT/.cache"
  FILE="$HASH.$FORMAT"
  if [ -f "$ROOT/.cache/$FILE" ]; then
    contained "$ROOT/.cache/$FILE"
    [ "$(sha256 "$ROOT/.cache/$FILE")" = "$HASH" ] || die "Cached checksum mismatch: $FILE. Remove the damaged cache file and rerun."
    ledger_assert "$ROOT/.cache/$FILE"
    exit 0
  fi
  owned_mkdir "$ROOT/.cache"
  cd "$ROOT/.cache"
  owned_destination "$ROOT/.cache/$FILE"
  owned_destination "$ROOT/.cache/$FILE.part"
  printf 'Download: %s\n' "$URL"
  PARTIAL=$(new_temp "$ROOT/.cache/$FILE.part")
  fetch "$PARTIAL" "$URL" "$HASH" || die 'Download interrupted or failed; rerun the same install command'
  [ "$(sha256 "$PARTIAL")" = "$HASH" ] || { owned_remove_tree "$PARTIAL"; die "Checksum mismatch: $URL. Nothing activated."; }
  owned_publish "$PARTIAL" "$ROOT/.cache/$FILE"
)
extract() (
  ARCHIVE=$1; DIRECTORY=$2; STRIP=$3
  contained "$DIRECTORY"
  [ ! -L "$DIRECTORY" ] || die 'Staging destination is a symlink'
  ARCHIVE_LIST=$(new_temp)
  ARCHIVE_LINKS=$(new_temp)
  capture "$ARCHIVE_LIST" tar -P -tf "$ARCHIVE"
  LC_ALL=C awk '
    /^\// || /(^|\/)\.\.(\/|$)/ || /\\/ || /^[A-Za-z]:/ {exit 1}
  ' "$ARCHIVE_LIST" || die 'Unsafe archive path'
  capture "$ARCHIVE_LINKS" tar -P -tvf "$ARCHIVE"
  LC_ALL=C awk -v strip="$STRIP" -f "$SCRIPT_DIR/scripts/archive-links.awk" "$ARCHIVE_LINKS" || die 'Unsafe archive link or special file'
  owned_remove_tree "$DIRECTORY"
  owned_mkdir "$DIRECTORY"
  if [ -n "$LEDGER_NODE" ]; then
    "$LEDGER_NODE" "$SCRIPT_DIR/src/install-ledger.mjs" intent-archive "$INSTALL_HOME" "$ROOT" "$DIRECTORY" "$ARCHIVE" "$STRIP"
  else
    # Only Node's executable is needed before the pinned validator can run.
    # Hash its archive bytes before extraction, including implicit parents.
    MEMBER=$(awk -v strip="$STRIP" ' {raw=$0; count=split(raw,parts,"/"); name=""; for(i=strip+1;i<=count;i++) if(parts[i]!="." && parts[i]!="") name=name (name ? "/" : "") parts[i]; if(name=="bin/node") {print raw; found++}} END {if(found!=1) exit 1}' "$ARCHIVE_LIST") || die 'Missing or ambiguous bootstrap Node'
    EXPECTED=$(tar -xOf "$ARCHIVE" "$MEMBER" | shasum -a 256 | awk '{print $1}')
    owned_mkdir "$DIRECTORY/bin"
    ledger_intent "$DIRECTORY/bin/node" P "$EXPECTED"
    tar -xf "$ARCHIVE" -C "$DIRECTORY" --strip-components="$STRIP" "$MEMBER"
    [ "$(sha256 "$DIRECTORY/bin/node")" = "$EXPECTED" ] || die 'Bootstrap extraction hash mismatch'
    ledger_record "$DIRECTORY/bin/node"
    owned_remove_tree "$ARCHIVE_LIST"; owned_remove_tree "$ARCHIVE_LINKS"
    exit 0
  fi
  tar -xf "$ARCHIVE" -C "$DIRECTORY" --strip-components="$STRIP"
  ledger_tree_record "$DIRECTORY"
  owned_remove_tree "$ARCHIVE_LIST"; owned_remove_tree "$ARCHIVE_LINKS"
)
download "$NODE_URL" "$NODE_SHA" "$NODE_FORMAT"
BOOTSTRAP="$ROOT/.bootstrap-$VERSION"
extract "$ROOT/.cache/$NODE_SHA.$NODE_FORMAT" "$BOOTSTRAP" "$NODE_STRIP"
NODE="$BOOTSTRAP/$NODE_ENTRY"
LEDGER_NODE="$NODE"
[ "$("$NODE" --version)" = "v$(get /runtimes/node/version)" ] || die 'Downloaded Node does not match its declared version'
PLAN=$(new_temp)
capture "$PLAN" "$NODE" "$SCRIPT_DIR/src/install.mjs" plan "$MANIFEST_FILE" "$PLATFORM"
MANIFEST_SHA=$(sha256 "$MANIFEST_FILE")
ledger_root_assert
if [ -e "$ROOT/$VERSION" ]; then
  owned_version "$VERSION"
  "$NODE" "$SCRIPT_DIR/src/install.mjs" verify "$MANIFEST_FILE" "$PLATFORM" "$ROOT/$VERSION"
else
  STAGE="$ROOT/.staging-$VERSION"
  check_stage "$STAGE"
  [ ! -L "$STAGE" ] || die 'Staging directory is a symlink'
  [ ! -e "$STAGE" ] || ledger_tree_assert "$STAGE"
  owned_mkdir "$STAGE"
  if [ -f "$STAGE/.manifest-sha256" ]; then [ "$(cat "$STAGE/.manifest-sha256")" = "$MANIFEST_SHA" ] || die 'Interrupted stage has a different manifest; choose a new pack version'; fi
  STAGE_METADATA=$(new_temp)
  capture "$STAGE_METADATA" printf '%s\n' "$MANIFEST_SHA"
  owned_publish "$STAGE_METADATA" "$STAGE/.manifest-sha256"
  TAB=$(printf '\t')
  # Verify every archive first. No installed version or launcher appears on a
  # checksum failure, and a previous active version continues to work.
  while IFS="$TAB" read -r KIND ID URL HASH FORMAT STRIP ENTRY; do download "$URL" "$HASH" "$FORMAT"; done < "$PLAN"
  while IFS="$TAB" read -r KIND ID URL HASH FORMAT STRIP ENTRY; do
    case "$KIND" in runtime) CATEGORY=runtimes ;; tool) CATEGORY=tools ;; *) die 'Invalid install plan' ;; esac
    extract "$ROOT/.cache/$HASH.$FORMAT" "$STAGE/$CATEGORY/$ID" "$STRIP"
  done < "$PLAN"
  for DIRECTORY in src scripts schemas skills fixtures; do
    contained "$STAGE/$DIRECTORY"
    owned_remove_tree "$STAGE/$DIRECTORY"
    "$NODE" "$SCRIPT_DIR/src/install-ledger.mjs" intent-copy "$INSTALL_HOME" "$ROOT" "$STAGE/$DIRECTORY" "$SCRIPT_DIR/$DIRECTORY"
    cp -R "$SCRIPT_DIR/$DIRECTORY" "$STAGE/$DIRECTORY"
    ledger_tree_record "$STAGE/$DIRECTORY"
  done
  for FILE in install.sh package.json; do
    "$NODE" "$SCRIPT_DIR/src/install-ledger.mjs" intent-copy "$INSTALL_HOME" "$ROOT" "$STAGE/$FILE" "$SCRIPT_DIR/$FILE"
    cp "$SCRIPT_DIR/$FILE" "$STAGE/$FILE"
    ledger_record "$STAGE/$FILE"
  done
  "$NODE" "$SCRIPT_DIR/src/install-ledger.mjs" intent-copy "$INSTALL_HOME" "$ROOT" "$STAGE/pack.json" "$MANIFEST_FILE"
  cp "$MANIFEST_FILE" "$STAGE/pack.json"; ledger_record "$STAGE/pack.json"
  "$NODE" "$SCRIPT_DIR/src/install.mjs" finalize "$STAGE/pack.json" "$PLATFORM" "$STAGE" "$ROOT" "$INSTALL_HOME"
  ledger_tree_record "$STAGE"
  launcher_owned
  "$NODE" "$SCRIPT_DIR/src/install-ledger.mjs" intent-move "$INSTALL_HOME" "$ROOT" "$ROOT/$VERSION" "$STAGE"
  mv "$STAGE" "$ROOT/$VERSION"
  ledger_tree_record "$ROOT/$VERSION"
fi
launcher_owned
if [ ! -e "$BIN" ]; then owned_mkdir "$BIN"; else contained "$BIN"; fi
[ ! -L "$BIN" ] || die 'Bin directory is an unowned symlink'
# Exclusive temporary names let a killed activation be retried without touching
# an unowned file or depending on a stale fixed temporary filename.
LAUNCHER_TEMP=$(new_temp "$BIN/.praxity-launcher")
capture "$LAUNCHER_TEMP" cat "$ROOT/$VERSION/launcher.sh"
chmod +x "$LAUNCHER_TEMP"
ledger_record "$LAUNCHER_TEMP"
owned_publish "$LAUNCHER_TEMP" "$BIN/praxity"
LAUNCHER_TEMP=
ledger_record "$BIN/praxity"
LAUNCHER_HASH=$(new_temp)
capture "$LAUNCHER_HASH" sha256 "$BIN/praxity"
owned_publish "$LAUNCHER_HASH" "$ROOT/.launcher-sha256"
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
