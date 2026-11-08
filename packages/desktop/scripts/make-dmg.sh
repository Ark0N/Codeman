#!/usr/bin/env bash
# Put Codeman.app in a compressed disk image next to a link to /Applications,
# so opening the image shows the app and the folder to drag it into.
#
#   packages/desktop/scripts/make-dmg.sh <Codeman.app> <out.dmg>
#
# bundle-macos.sh (--dmg) and sign-macos.sh both call it, so a local test DMG
# and the release DMG are laid out the same way. It signs nothing.
set -euo pipefail

[ "$(uname -s)" = Darwin ] || { echo "make-dmg.sh runs on macOS only" >&2; exit 1; }
[ $# -eq 2 ] || { echo "usage: $0 <Codeman.app> <out.dmg>" >&2; exit 2; }

APP=$1
DMG=$2
[ -d "$APP/Contents/MacOS" ] || { echo "$APP is not an app bundle" >&2; exit 2; }

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

STAGE="$WORK/dmg"
mkdir -p "$STAGE"
# ditto keeps what cp -R can lose: extended attributes, and with them a
# stapled notarization ticket.
ditto "$APP" "$STAGE/$(basename "$APP")"
ln -s /Applications "$STAGE/Applications"

# Hosted macOS runners now and then fail hdiutil with "Resource busy"; the
# same command a few seconds later passes.
rm -f "$DMG"
tries=1
until hdiutil create -quiet -volname Codeman -srcfolder "$STAGE" -ov -format UDZO "$DMG"; do
  if [ "$tries" -ge 3 ]; then
    echo "hdiutil create failed $tries times" >&2
    exit 1
  fi
  tries=$((tries + 1))
  echo "hdiutil create failed, trying again in 10 seconds" >&2
  rm -f "$DMG"
  sleep 10
done
hdiutil verify -quiet "$DMG"
