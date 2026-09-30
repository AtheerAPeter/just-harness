#!/usr/bin/env bash
# Installs or updates Just Harness on macOS.
#
#   curl -fsSL https://raw.githubusercontent.com/AtheerAPeter/just-harness/main/install.sh | bash
#
# Files fetched with curl are not marked as downloaded from the internet, so the
# app opens without the "Apple could not verify" prompt that a browser download
# gets.
set -euo pipefail

REPO="AtheerAPeter/just-harness"
APP="Just Harness.app"

if [ -t 1 ]; then
  BOLD=$'\033[1m' DIM=$'\033[2m' GREEN=$'\033[32m' RED=$'\033[31m' BLUE=$'\033[34m' RESET=$'\033[0m'
else
  BOLD="" DIM="" GREEN="" RED="" BLUE="" RESET=""
fi

step() { printf "  ${BLUE}›${RESET} %s\n" "$1"; }
done_() { printf "  ${GREEN}✓${RESET} %s\n" "$1"; }
fail() { printf "\n  ${RED}✗ %s${RESET}\n\n" "$1" >&2; exit 1; }

printf "\n  ${BOLD}Just Harness${RESET} ${DIM}· the basics are all you need${RESET}\n\n"

[ "$(uname -s)" = "Darwin" ] || fail "Just Harness runs on macOS only."
[ "$(uname -m)" = "arm64" ] || fail "Just Harness needs a Mac with Apple Silicon (M1 or newer)."

step "Finding the latest release"
release=$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest") ||
  fail "Could not reach GitHub. Check your connection and try again."
url=$(printf '%s' "$release" | grep -o '"browser_download_url": *"[^"]*\.dmg"' | head -1 | sed 's/.*"\(https[^"]*\)"/\1/')
version=$(printf '%s' "$release" | grep -o '"tag_name": *"[^"]*"' | head -1 | sed 's/.*"\([^"]*\)"$/\1/')
[ -n "$url" ] || fail "The latest release has no macOS download."
done_ "Found ${version}"

work=$(mktemp -d)
mount=""
cleanup() {
  [ -n "$mount" ] && hdiutil detach "$mount" -quiet >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT

step "Downloading"
curl -fL --progress-bar "$url" -o "$work/JustHarness.dmg" || fail "The download failed. Try again."
done_ "Downloaded"

step "Installing"
mount=$(hdiutil attach "$work/JustHarness.dmg" -nobrowse -readonly | tail -1 | cut -f3)
[ -d "$mount/$APP" ] || fail "The download did not contain $APP."

# /Applications when it is writable (admin accounts), otherwise ~/Applications.
target="/Applications"
if [ ! -w "$target" ]; then
  target="$HOME/Applications"
  mkdir -p "$target"
fi

if pgrep -f "$APP/Contents/MacOS" >/dev/null 2>&1; then
  osascript -e 'quit app "Just Harness"' >/dev/null 2>&1 || true
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    pgrep -f "$APP/Contents/MacOS" >/dev/null 2>&1 || break
    sleep 1
  done
fi

rm -rf "$target/$APP"
ditto "$mount/$APP" "$target/$APP"
xattr -dr com.apple.quarantine "$target/$APP" 2>/dev/null || true
done_ "Installed to $target"

open "$target/$APP"

printf "\n  ${GREEN}${BOLD}Just Harness ${version} is ready.${RESET}\n"
printf "  ${DIM}Run the same command again any time to update.${RESET}\n\n"
