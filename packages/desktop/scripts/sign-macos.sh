#!/usr/bin/env bash
# Sign Codeman.app with a Developer ID, have Apple notarize it and staple the
# ticket to it, then build Codeman.dmg around the stapled app and do the same
# for the DMG. On macOS.
#
#   packages/desktop/scripts/sign-macos.sh <Codeman.app> <out-dir>
#   packages/desktop/scripts/sign-macos.sh --check   # only check the environment below
#
# <Codeman.app> is re-signed and stapled in place. <out-dir> receives
# Codeman.dmg and Codeman.dmg.sha256, the latter with the bare file name in it,
# so `shasum -a 256 -c Codeman.dmg.sha256` works next to a downloaded copy. Both
# appear only once every check passed; a failed run leaves neither, not even an
# older pair, so nothing half-done can be uploaded by mistake.
#
# The environment names who signs:
#   SIGN_IDENTITY       a "Developer ID Application: ..." identity in a keychain
#                       on the search list, by name or by the SHA-1 hash that
#                       `security find-identity -v -p codesigning` prints
# and how to reach Apple's notary service, either through a profile saved with
# `xcrun notarytool store-credentials <profile> --apple-id ... --team-id ...`:
#   NOTARY_PROFILE      the profile's name
#   NOTARY_KEYCHAIN     optional, the keychain that holds it (default: login)
# or with the Apple ID itself:
#   APPLE_ID, APPLE_APP_PASSWORD (an app-specific password), APPLE_TEAM_ID
#
# By hand, on a Mac with the certificate in the login keychain:
#   SIGN_IDENTITY="Developer ID Application: ..." NOTARY_PROFILE=codeman-notary \
#     packages/desktop/scripts/sign-macos.sh packages/desktop/dist/Codeman.app packages/desktop/dist
#
# The release workflow (.github/workflows/desktop-dmg.yml) runs it in a job that
# builds nothing: the job that runs cargo, and with it the build script of every
# crate in Cargo.lock, never holds a signing secret.
set -euo pipefail

[ "$(uname -s)" = Darwin ] || { echo "sign-macos.sh runs on macOS only" >&2; exit 1; }

DESKTOP=$(cd "$(dirname "$0")/.." && pwd)
ENTITLEMENTS="$DESKTOP/macos/entitlements.plist"

# Fails with the name of what is missing, before any work, so a missing secret
# costs seconds rather than a build.
check_env() {
  if [ -z "${SIGN_IDENTITY:-}" ]; then
    echo "sign-macos.sh needs SIGN_IDENTITY" >&2
    exit 2
  fi
  if [ -n "${NOTARY_PROFILE:-}" ]; then
    return 0
  fi
  local name
  for name in APPLE_ID APPLE_APP_PASSWORD APPLE_TEAM_ID; do
    if [ -z "$(eval "printf '%s' \"\${$name:-}\"")" ]; then
      echo "sign-macos.sh needs NOTARY_PROFILE, or APPLE_ID, APPLE_APP_PASSWORD and APPLE_TEAM_ID ($name is empty)" >&2
      exit 2
    fi
  done
}

if [ "${1:-}" = --check ] && [ $# -eq 1 ]; then
  check_env
  exit 0
fi
[ $# -eq 2 ] || { echo "usage: $0 <Codeman.app> <out-dir> | --check" >&2; exit 2; }
check_env

APP=$1
OUT=$2
[ -d "$APP/Contents/MacOS" ] || { echo "$APP is not an app bundle" >&2; exit 2; }
mkdir -p "$OUT"
OUT=$(cd "$OUT" && pwd)
rm -f "$OUT/Codeman.dmg" "$OUT/Codeman.dmg.sha256"
NAME=$(basename "$APP" .app)

if [ -n "${NOTARY_PROFILE:-}" ]; then
  NOTARY_AUTH=(--keychain-profile "$NOTARY_PROFILE")
  if [ -n "${NOTARY_KEYCHAIN:-}" ]; then
    NOTARY_AUTH=("${NOTARY_AUTH[@]}" --keychain "$NOTARY_KEYCHAIN")
  fi
else
  # On notarytool's command line, which the job's log never shows.
  NOTARY_AUTH=(--apple-id "$APPLE_ID" --password "$APPLE_APP_PASSWORD" --team-id "$APPLE_TEAM_ID")
fi

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

# Submit a file to the notary service and wait. Anything but Accepted stops the
# script with the submission id and Apple's log, which names the file and the
# reason (an unsigned binary, a missing timestamp, no hardened runtime...).
notarize() {
  local file=$1 result="$WORK/notary.plist" rc=0 status id
  echo "Submitting $(basename "$file") to Apple's notary service"
  xcrun notarytool submit "$file" "${NOTARY_AUTH[@]}" --wait --timeout 45m \
    --output-format plist > "$result" || rc=$?
  status=$(/usr/libexec/PlistBuddy -c 'Print :status' "$result" 2>/dev/null || true)
  id=$(/usr/libexec/PlistBuddy -c 'Print :id' "$result" 2>/dev/null || true)
  if [ "$status" != Accepted ]; then
    echo "Notarization of $(basename "$file") ended as '${status:-unknown}' (submission ${id:-none}, notarytool exit $rc)" >&2
    cat "$result" >&2 || true
    if [ -n "$id" ]; then
      xcrun notarytool log "$id" "${NOTARY_AUTH[@]}" >&2 || true
    fi
    exit 1
  fi
  echo "Notarized $(basename "$file") (submission $id)"
}

# The app: hardened runtime (which notarization requires), a secure timestamp,
# and the entitlements the hardened runtime needs for microphone and camera.
codesign --force --options runtime --timestamp --entitlements "$ENTITLEMENTS" \
  --sign "$SIGN_IDENTITY" "$APP"
codesign --verify --strict --verbose=2 "$APP"
DETAILS=$(codesign --display --verbose=2 "$APP" 2>&1)
printf '%s\n' "$DETAILS" | grep -E '^(Authority|TeamIdentifier|Timestamp)=' || true
case "$DETAILS" in
  *"Authority=Developer ID Application: "*) ;;
  *) echo "$APP is not signed with a Developer ID Application certificate" >&2; exit 1 ;;
esac
case "$DETAILS" in
  *"(runtime)"*) ;;
  *) echo "$APP is signed without the hardened runtime" >&2; exit 1 ;;
esac

ditto -c -k --keepParent "$APP" "$WORK/$NAME.zip"
notarize "$WORK/$NAME.zip"
xcrun stapler staple "$APP"
xcrun stapler validate "$APP"
spctl --assess --type execute --verbose=2 "$APP"

# The DMG around the stapled app, signed and notarized in its own right, so the
# image opens without a warning and the app inside opens offline.
DMG="$WORK/Codeman.dmg"
"$DESKTOP/scripts/make-dmg.sh" "$APP" "$DMG"
codesign --force --timestamp --sign "$SIGN_IDENTITY" "$DMG"
codesign --verify --strict --verbose=2 "$DMG"
notarize "$DMG"
xcrun stapler staple "$DMG"
xcrun stapler validate "$DMG"
spctl --assess --type open --context context:primary-signature --verbose=2 "$DMG"

(cd "$WORK" && shasum -a 256 Codeman.dmg > Codeman.dmg.sha256)
mv "$DMG" "$WORK/Codeman.dmg.sha256" "$OUT/"
echo "Signed and notarized $APP"
echo "Built $OUT/Codeman.dmg ($(du -h "$OUT/Codeman.dmg" | cut -f1)), sha256 $(cut -d' ' -f1 "$OUT/Codeman.dmg.sha256")"
