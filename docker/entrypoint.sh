#!/bin/sh
# Corrects the ownership of the host bind mounts, then drops to PUID:PGID.
#
# Compose binds CODEMAN_APPDATA_PATH and CODEMAN_CASES_PATH from the host. When
# either path does not exist yet - a first run, a cleared application-data
# directory, a restored backup - the Docker daemon creates it owned by root,
# and an unprivileged server cannot then create its own state directory. The
# result is a container that restarts forever on:
#
#   Failed to start web server: EACCES: permission denied, mkdir '/home/<user>/.codeman'
#
# Running this as root and dropping afterwards removes that failure mode without
# leaving the server privileged.

set -eu

# Honour an explicit `user:` in Compose: when the container was not started as
# root there is nothing to correct and no privilege to drop.
if [ "$(id -u)" -ne 0 ]; then
  exec "$@"
fi

: "${PUID:=1000}"
: "${PGID:=1000}"

for target in "${HOME:-}" "${CODEMAN_CASES_PATH:-}"; do
  [ -n "$target" ] && [ -d "$target" ] || continue
  owner=$(stat -c '%u:%g' "$target")
  [ "$owner" = "${PUID}:${PGID}" ] && continue

  # Only ever correct a directory the DAEMON created (root-owned, because
  # neither PUID nor PGID existed yet when it materialised the missing bind
  # source). Anything else - a host tree that legitimately belongs to some
  # OTHER account, such as an existing CODEMAN_CASES_PATH the README already
  # allows pointing at a normal project directory - is not this container's
  # to reassign; recursively chowning it on every mismatch silently rewrote
  # a credentials tree or a projects directory to PUID:PGID with one log
  # line to explain it. Refuse instead, the same way Start-Codeman.sh already
  # refuses to touch a root-owned appdata directory it did not expect.
  if [ "${owner%%:*}" != '0' ]; then
    printf 'entrypoint: %s is owned by %s, which is neither root nor PUID:PGID (%s:%s).\n' \
      "$target" "$owner" "$PUID" "$PGID" >&2
    printf 'entrypoint: refusing to change ownership of a directory this container did not create.\n' >&2
    printf 'entrypoint: either chown it on the host, or set PUID/PGID to match its current owner.\n' >&2
    exit 1
  fi

  # Deliberately not fatal for a root-owned directory. A bind mount backed by
  # NFS, CIFS or a rootless daemon can refuse chown while still being
  # perfectly writable, and those deployments must keep working. A warning is
  # more useful than a container that will not start.
  if chown -R "${PUID}:${PGID}" "$target" 2>/dev/null; then
    printf 'entrypoint: corrected ownership of %s to %s:%s\n' "$target" "$PUID" "$PGID"
  else
    printf 'entrypoint: warning: cannot change ownership of %s to %s:%s\n' \
      "$target" "$PUID" "$PGID" >&2
    printf 'entrypoint: warning: continuing; set the ownership on the host if startup fails\n' >&2
  fi
done

# Preserve the supplementary groups Compose granted through group_add - that is
# how the Docker socket stays reachable - while discarding root's own group.
supplementary=$(id -G | tr ' ' '\n' | grep -vx 0 | paste -sd, -)
[ -n "$supplementary" ] || supplementary="$PGID"

# --bounding-set -all: with the reuid/regid drop above, CapPrm/CapEff are
# already empty, but the bounding set otherwise still lists everything
# cap_add granted (visible as a nonzero CapBnd even post-drop). no-new-privileges
# already makes that moot - nothing can regain a capability outside the
# bounding set - but clearing it too is free and matches what "drops to
# PUID:PGID" actually promises.
exec setpriv --reuid "$PUID" --regid "$PGID" --groups "$supplementary" --bounding-set -all "$@"
