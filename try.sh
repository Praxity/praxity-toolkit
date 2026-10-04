#!/bin/sh
# One-command trial on an Apple Silicon Mac: download the toolkit, install the
# pack, run the doctor, then open Studio's editor on the bundled sample course.
#
#   curl -fsSL https://raw.githubusercontent.com/Praxity/praxity-toolkit/main/try.sh | sh
#
# It only touches ~/praxity-toolkit-main (the downloaded toolkit), ~/.praxity
# (the installed pack) and a copy of the sample course in ~/praxity-trial-course.
# Optional downloads (Check's browser, Java, veraPDF) need consent, so run
# `~/.praxity/bin/praxity setup check` yourself afterwards if you want them.
set -eu

toolkit="$HOME/praxity-toolkit-main"
course="$HOME/praxity-trial-course"
praxity="$HOME/.praxity/bin/praxity"

step() { printf '\n== %s\n' "$1"; }

step "Downloading the toolkit to $toolkit"
rm -rf "$toolkit"
curl -fsSL https://github.com/Praxity/praxity-toolkit/archive/refs/heads/main.tar.gz | tar xz -C "$HOME"

step "Installing the pack (no administrator rights needed)"
(cd "$toolkit" && sh install.sh)

step "Checking the installation"
"$praxity" doctor || echo "(doctor reported problems; the details are above)"

step "Starting Studio's editor on a copy of the sample course"
if [ ! -d "$course" ]; then cp -R "$toolkit/fixtures/course" "$course"; fi
log=$(mktemp "${TMPDIR:-/tmp}/praxity-studio.XXXXXX")
"$praxity" studio "$course" --no-open >"$log" 2>&1 &
server=$!
# The URL carries a private session token, so it is opened directly and never written elsewhere.
url=""
tries=0
while [ -z "$url" ] && [ "$tries" -lt 60 ]; do
  if ! kill -0 "$server" 2>/dev/null; then
    cat "$log"; rm -f "$log"; echo "Studio stopped before it was ready."; exit 1
  fi
  url=$(grep -o 'http://127\.0\.0\.1:[0-9]*/#session=[A-Za-z0-9_-]*' "$log" | head -n 1 || true)
  tries=$((tries + 1))
  [ -n "$url" ] || sleep 1
done
rm -f "$log"
if [ -z "$url" ]; then kill "$server" 2>/dev/null || true; echo "Studio did not print a ready URL."; exit 1; fi

open -a Safari "$url"
printf '\nStudio is open in Safari. Edit something, save, then try HTML and PDF export.\n'
printf 'Course copy: %s\nPress Ctrl+C here when you are done.\n' "$course"
trap 'kill "$server" 2>/dev/null || true; printf "\nStopped Studio.\n"; exit 0' INT TERM
wait "$server"
