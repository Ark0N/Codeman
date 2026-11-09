#!/bin/bash
# keep-awake-lid.sh: the root helper behind "Keep This Mac Awake > Also With the Lid
# Closed" in the Codeman app for Mac.
#
# The app keeps the Mac from idle sleep on its own, with no root (a power assertion).
# Closing the lid is another matter: only `pmset -a disablesleep 1` keeps a closed
# MacBook awake, and that is a machine-wide root setting with no owner process. So this
# helper, run by the com.getcodeman.keepawake LaunchDaemon every 20 seconds, applies it
# while the app asks for it and undoes it when the app stops asking:
#
#   - The app writes its pid to the request file, and rewrites it every 30 seconds, while
#     it wants the lid covered.
#   - The request counts only while the file is fresh (under 2 minutes old), is not a
#     symlink, its pid is alive, that process belongs to the file's owner, and the Mac
#     runs on its power adapter. An app that quits or crashes is a dead pid, so the lid
#     is released at the next run.
#   - Never on battery, whatever the app says: a closed MacBook that cannot sleep in a
#     bag only heats up and drains.
#   - It undoes only a disablesleep it set itself (the .owned file), so an
#     administrator's own `pmset -a disablesleep 1` is never switched off.
#
# The app writes this file to a ROOT-OWNED path itself, behind macOS's administrator
# prompt; a root daemon must never run a file a user can edit.
#
# Usage: keep-awake-lid.sh <request-file>
# Test hooks (set only by the test suite; launchd passes no environment of the user's):
# CODEMAN_KEEPAWAKE_PMSET, CODEMAN_KEEPAWAKE_STATE_DIR.
#
# bash 3.2 (what macOS ships) and BSD tools only.

set -u

REQ="${1:?usage: keep-awake-lid.sh <request-file>}"
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

# The power adapter, or nothing: an unreadable answer counts as battery.
if [ "$want" = "1" ] && ! "$PMSET" -g batt 2>/dev/null | grep -q "'AC Power'"; then
    want=0
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
