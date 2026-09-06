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
  [ "$(stat -c '%u:%g' "$target")" = "${PUID}:${PGID}" ] && continue

  # Deliberately not fatal. A bind mount backed by NFS, CIFS or a rootless
  # daemon can refuse chown while still being perfectly writable, and those
  # deployments must keep working. A warning is more useful than a container
  # that will not start.
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

exec setpriv --reuid "$PUID" --regid "$PGID" --groups "$supplementary" "$@"
