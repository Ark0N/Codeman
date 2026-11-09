#!/usr/bin/env bash
# Build Codeman.app (and optionally a .dmg) from packages/desktop, on macOS.
#
#   packages/desktop/scripts/bundle-macos.sh            # this Mac's architecture
#   packages/desktop/scripts/bundle-macos.sh --universal --dmg
#   SIGN_IDENTITY="Developer ID Application: ..." packages/desktop/scripts/bundle-macos.sh --dmg
#   SIGN_IDENTITY="Developer ID Application: ..." NOTARY_PROFILE=<profile> \
#     packages/desktop/scripts/bundle-macos.sh --universal --notarize
#
# Without SIGN_IDENTITY the app is signed ad hoc: it runs on the Mac that built
# it, and a copy downloaded on another Mac is stopped by Gatekeeper. On macOS 15
# and later, try to open it once, then click Open Anyway in System Settings >
# Privacy & Security; on macOS 14 and earlier, right-click it and choose Open.
# Or run `xattr -dr com.apple.quarantine /Applications/Codeman.app` on the copy
# in /Applications. A Developer ID signature + notarization avoids all of this.
#
# --dmg writes dist/Codeman-<version>.dmg, signed with SIGN_IDENTITY when it is
# set. --notarize hands the built app to scripts/sign-macos.sh, which signs it
# with SIGN_IDENTITY, has Apple notarize it, staples the ticket to it and does
# the same for dist/Codeman.dmg, the DMG built around it (so --dmg is implied).
# sign-macos.sh's header lists what it needs: SIGN_IDENTITY, and NOTARY_PROFILE
# or APPLE_ID, APPLE_APP_PASSWORD and APPLE_TEAM_ID. The release workflow
# (.github/workflows/desktop-dmg.yml) runs this script ad hoc in one job and
# sign-macos.sh in another, so the job that runs cargo holds no secret.
set -euo pipefail

cd "$(dirname "$0")/.."
[ "$(uname -s)" = Darwin ] || { echo "bundle-macos.sh runs on macOS only" >&2; exit 1; }

UNIVERSAL=0
DMG=0
NOTARIZE=0
for arg in "$@"; do
  case "$arg" in
    --universal) UNIVERSAL=1 ;;
    --dmg) DMG=1 ;;
    --notarize) NOTARIZE=1 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

if [ "$NOTARIZE" = 1 ]; then
  # Checked before the build, so a missing secret costs seconds, not a build.
  ./scripts/sign-macos.sh --check
fi

VERSION=$(sed -n 's/^version = "\(.*\)"$/\1/p' Cargo.toml | head -1)
[ -n "$VERSION" ] || { echo "could not read the version from Cargo.toml" >&2; exit 1; }

# The binary targets the same macOS as LSMinimumSystemVersion in Info.plist,
# so the two cannot disagree.
MACOSX_DEPLOYMENT_TARGET=$(/usr/libexec/PlistBuddy -c 'Print :LSMinimumSystemVersion' macos/Info.plist)
[ -n "$MACOSX_DEPLOYMENT_TARGET" ] || { echo "could not read LSMinimumSystemVersion from macos/Info.plist" >&2; exit 1; }
export MACOSX_DEPLOYMENT_TARGET

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

# Build with cargo and set BUILT to the executable cargo reports for
# codeman-desktop. Asking cargo, rather than assuming ./target, keeps
# CARGO_TARGET_DIR, build.target-dir and build.target from a cargo config
# working, and a stale binary from an older build is never bundled.
cargo_build() {
  local json
  json=$(cargo build --locked --release "$@" --message-format=json-render-diagnostics)
  BUILT=$(printf '%s\n' "$json" | awk '
    index($0, "\"reason\":\"compiler-artifact\"") &&
    index($0, "\"kind\":[\"bin\"]") &&
    index($0, "\"name\":\"codeman-desktop\"") &&
    match($0, /"executable":"[^"]*"/) { path = substr($0, RSTART + 14, RLENGTH - 15) }
    END { print path }')
  if [ -z "$BUILT" ] || [ ! -x "$BUILT" ]; then
    echo "cargo did not report a codeman-desktop executable${BUILT:+ (it named $BUILT)}" >&2
    exit 1
  fi
}

if [ "$UNIVERSAL" = 1 ]; then
  rustup target add aarch64-apple-darwin x86_64-apple-darwin >/dev/null
  cargo_build --target aarch64-apple-darwin
  ARM_BIN=$BUILT
  cargo_build --target x86_64-apple-darwin
  INTEL_BIN=$BUILT
  BIN="$WORK/codeman-desktop-universal"
  lipo -create -output "$BIN" "$ARM_BIN" "$INTEL_BIN"
else
  cargo_build
  BIN=$BUILT
fi

APP=dist/Codeman.app
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BIN" "$APP/Contents/MacOS/codeman-desktop"
sed "s/__VERSION__/$VERSION/g" macos/Info.plist > "$APP/Contents/Info.plist"
plutil -lint "$APP/Contents/Info.plist" >/dev/null
printf 'APPL????' > "$APP/Contents/PkgInfo"

# assets/icon.png (1024x1024, already on Apple's icon grid) -> Codeman.icns
ICONSET="$WORK/Codeman.iconset"
mkdir -p "$ICONSET"
for size in 16 32 128 256 512; do
  sips -z "$size" "$size" assets/icon.png --out "$ICONSET/icon_${size}x${size}.png" >/dev/null
  double=$((size * 2))
  sips -z "$double" "$double" assets/icon.png --out "$ICONSET/icon_${size}x${size}@2x.png" >/dev/null
done
iconutil -c icns "$ICONSET" -o "$APP/Contents/Resources/Codeman.icns"

if [ -n "${SIGN_IDENTITY:-}" ]; then
  codesign --force --options runtime --timestamp \
    --entitlements macos/entitlements.plist --sign "$SIGN_IDENTITY" "$APP"
else
  codesign --force --sign - "$APP"
fi
codesign --verify --strict "$APP"

echo "Built $(pwd)/$APP ($(du -sh "$APP" | cut -f1), version $VERSION, macOS $MACOSX_DEPLOYMENT_TARGET or later)"

if [ "$NOTARIZE" = 1 ]; then
  ./scripts/sign-macos.sh "$APP" dist
elif [ "$DMG" = 1 ]; then
  DMG_PATH="dist/Codeman-$VERSION.dmg"
  ./scripts/make-dmg.sh "$APP" "$DMG_PATH"
  if [ -n "${SIGN_IDENTITY:-}" ]; then
    codesign --force --timestamp --sign "$SIGN_IDENTITY" "$DMG_PATH"
  fi
  echo "Built $(pwd)/$DMG_PATH ($(du -sh "$DMG_PATH" | cut -f1))"
fi
