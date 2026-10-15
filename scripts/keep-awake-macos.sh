#!/bin/bash
# keep-awake-macos.sh: root helper behind Codeman's "Keep this computer awake" on macOS.
#
# caffeinate (which the server runs itself, no root) stops idle sleep but not lid-close
# sleep. Only `pmset -a disablesleep 1` keeps a closed MacBook awake, and that is a
# machine-wide root setting with no owner process. So this helper, run by the
# com.codeman.keepawake LaunchDaemon every 20 seconds, applies it while the server asks
# for it and undoes it when the server stops asking:
#
#   - The server writes its pid to the request file and rewrites it every 30 seconds
#     while it wants the lid covered (setting on, and on AC when "only on AC" is on).
#   - The request counts only while the file is fresh (under 2 minutes old) AND its pid
#     is alive AND that process belongs to the file's owner. A crashed or hung server
#     therefore releases the lid within about two minutes on its own.
#   - The helper undoes only a disablesleep it set itself (tracked by the .owned file),
#     so an administrator's own `pmset -a disablesleep 1` is never switched off.
#
# install.sh copies this file to a ROOT-OWNED path before the daemon runs it; never run
# it from the user-writable install directory.
#
# Usage: keep-awake-macos.sh <request-file>
# Test hooks (set only by the test suite): CODEMAN_KEEPAWAKE_PMSET, CODEMAN_KEEPAWAKE_STATE_DIR.

set -u

REQ="${1:?usage: keep-awake-macos.sh <request-file>}"
PMSET="${CODEMAN_KEEPAWAKE_PMSET:-/usr/bin/pmset}"
STATE_DIR="${CODEMAN_KEEPAWAKE_STATE_DIR:-/Library/Application Support/Codeman}"
OWNED="$STATE_DIR/keep-awake.owned"

want=0
# -L: refuse a symlink (root must not be steered to read some other file).
# find -mmin -2: modified within the last 2 minutes (BSD and GNU find both support it).
if [ -f "$REQ" ] && [ ! -L "$REQ" ] && [ -n "$(find "$REQ" -mmin -2 2>/dev/null)" ]; then
    pid=$(head -c 32 "$REQ" 2>/dev/null | tr -dc '0-9')
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
        file_uid=$(ls -ln "$REQ" 2>/dev/null | awk '{print $3}')
        pid_uid=$(ps -o uid= -p "$pid" 2>/dev/null | tr -d ' ')
        if [ -n "$file_uid" ] && [ "$file_uid" = "$pid_uid" ]; then
            want=1
        fi
    fi
fi

current=$("$PMSET" -g 2>/dev/null | awk '/SleepDisabled/ {print $2; exit}')
[ -n "$current" ] || current=0

if [ "$want" = "1" ]; then
    # Already 1 without our marker means an administrator set it: leave it and do not
    # claim it, so releasing later never switches their setting off.
    if [ "$current" != "1" ]; then
        if "$PMSET" -a disablesleep 1; then
            mkdir -p "$STATE_DIR" && : > "$OWNED"
        fi
    fi
elif [ -f "$OWNED" ]; then
    if [ "$current" = "1" ]; then
        "$PMSET" -a disablesleep 0 || exit 1
    fi
    rm -f "$OWNED"
fi
exit 0
