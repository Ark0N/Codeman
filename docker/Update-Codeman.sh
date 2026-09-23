#!/usr/bin/env bash
#
# The scripted major-update path for the Docker Compose deployment.
#
# docker/README.md and docs/docker-self-update.md both point operators here for
# anything the in-app updater itself refuses to apply: a changed
# `server.Dockerfile`, a changed `docker-compose.yaml`, or a new required
# `.env.example` key. None of those can be applied by a container restarting
# itself — a restart reuses the existing image and configuration (see "The
# environment gate" in docs/docker-self-update.md) — so this script does the
# three things an in-place update cannot: force a real image rebuild with no
# layer cache, stop the stack, then hand off to Start-Codeman.sh for the same
# careful PUID/PGID, override-file and fingerprint handling every other start
# goes through.
#
# ⚠️ Build BEFORE stopping the stack, deliberately, same reasoning as
# Start-Codeman.sh's own build-then-down ordering: the build needs nothing
# stopped, so a slow --no-cache rebuild costs no downtime, and a build failure
# (a bad Dockerfile edit, a network blip pulling a base image) leaves the
# ALREADY-RUNNING stack untouched instead of stopped with nothing to bring it
# back.
#
# ⚠️ Clears the codeman-node-modules/codeman-dist named volumes by DEFAULT.
# Docker seeds a named volume from the image only while that volume is EMPTY,
# so a rebuilt image's fresh node_modules/dist otherwise sit unused behind a
# volume's old content and the container comes back up looking unchanged —
# exactly wrong for a script whose whole point is "be certain of what ships".
# Start-Codeman.sh clears codeman-dist when the checkout's HEAD moved and
# codeman-node-modules only when `package-lock.json` changed. A released
# server.Dockerfile change arrives through `git pull`, so HEAD moves and dist
# is refreshed, but a Dockerfile change that bumps the Node base image leaves
# the lockfile untouched while every native module (node-pty is compiled from
# source, there is no Linux prebuild) has to be rebuilt against the new Node
# ABI. Start-Codeman.sh would keep the old codeman-node-modules volume, and it
# never builds with --no-cache. This script clears BOTH volumes, and ONLY
# those two (targeted `docker volume rm` by Compose label, never
# `down --volumes`, which would also take any volume an override file adds).
# Pass --keep-volumes to opt out and reuse whatever is already in them.
#
# Usage: docker/Update-Codeman.sh [--keep-volumes]
#   --keep-volumes   Do not clear codeman-node-modules/codeman-dist. Safe to
#                    combine with a source change Start-Codeman.sh's own
#                    detection would have cleared anyway; unsafe if the reason
#                    you are here is a change to server.Dockerfile alone.

set -euo pipefail

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
env_file="$script_dir/.env"
compose_file="$script_dir/docker-compose.yaml"

keep_volumes=0
for arg in "$@"; do
  case "$arg" in
    --keep-volumes)
      keep_volumes=1
      ;;
    --help | -h)
      printf 'Usage: bash %s [--keep-volumes]\n' "$0"
      exit 0
      ;;
    *)
      printf 'Error: unrecognised argument: %s\n' "$arg" >&2
      printf 'Usage: bash %s [--keep-volumes]\n' "$0" >&2
      exit 1
      ;;
  esac
done

if [[ ! -f "$env_file" ]]; then
  printf 'Error: Docker environment file is missing: %s\n' "$env_file" >&2
  printf 'Create it from %s/.env.example before running this script.\n' "$script_dir" >&2
  exit 1
fi

# Same override-file discovery as Start-Codeman.sh, and deliberately kept in
# step with it: a stack built here and started there must resolve to the exact
# same Compose files, or this script's build could target a configuration the
# handoff's own `up` never actually uses. Compose's own precedence (measured on
# v5.5.0 with both present: it uses .yml and ignores .yaml).
override_yml="$script_dir/docker-compose.override.yml"
override_yaml="$script_dir/docker-compose.override.yaml"
if [[ -f "$override_yml" && -f "$override_yaml" ]]; then
  printf 'Warning: both %s and %s exist; Compose uses .yml and ignores .yaml.\n' \
    "$override_yml" "$override_yaml" >&2
fi
compose_files=(-f "$compose_file")
for override_file in "$override_yml" "$override_yaml"; do
  if [[ -f "$override_file" ]]; then
    compose_files+=(-f "$override_file")
    printf 'Using Compose override file: %s\n' "$override_file"
    break
  fi
done
compose_command=(docker compose --env-file "$env_file" "${compose_files[@]}")

# Collision guard. Start-Codeman.sh has no equivalent; this is the only one,
# and it has to run before this script's own --no-cache build, `down` and
# volume removal below. docker-compose.yaml hard-codes `name: codeman`, so a
# second checkout run without COMPOSE_PROJECT_NAME resolves to the SAME Compose
# project as any other checkout on the host and would operate on ITS
# containers and volumes.
#
# The project name is read from the resolved config's top-level `name` key
# (the first `name` in the output; nested ones come later), the same parse
# Start-Codeman.sh uses. `--format json` needs Compose v2.3+. This is the first
# `docker` call the script makes, so its failure is reported here rather than
# left to `set -e`, which would exit with no output at all.
if ! project_config=$("${compose_command[@]}" config --format json); then
  printf 'Error: `docker compose config --format json` failed (see the message above, if any).\n' >&2
  printf 'Check that Docker and Compose v2.3+ are installed and on PATH, and that\n' >&2
  printf '%s and the Compose files in %s are valid.\n' "$env_file" "$script_dir" >&2
  exit 1
fi
project_name=$(
  printf '%s\n' "$project_config" |
    sed -n 's/^[[:space:]]*"name":[[:space:]]*"\([^"]*\)".*$/\1/p' | head -n1
)
if [[ -n "$project_name" ]]; then
  # `|| true` on the pipeline's LAST command: under `set -o pipefail`, `grep -v`
  # exits 1 when nothing survives the filter — the ordinary, no-collision case,
  # since `docker ps` finds nothing at all on a first-ever deployment or a
  # single matching (own) working_dir gets filtered out. Without it, that exit
  # status propagates through the command substitution and `set -e` aborts the
  # WHOLE script right here, every time, regardless of whether a collision
  # actually exists — caught only by actually running this end-to-end (a
  # static text/regex check on the source cannot see it). The empty-line
  # filter keeps a container with no working_dir label from winning head -n1
  # and hiding a real collision behind it.
  other_working_dir=$(
    docker ps -a --filter "label=com.docker.compose.project=$project_name" \
      --format '{{.Label "com.docker.compose.project.working_dir"}}' 2>/dev/null |
      grep -v -F -x -- "$script_dir" | grep -v '^$' | head -n1 || true
  )
  if [[ -n "$other_working_dir" ]]; then
    printf 'Error: Compose project "%s" is already in use by a DIFFERENT checkout:\n' "$project_name" >&2
    printf '  %s\n' "$other_working_dir" >&2
    printf 'This checkout is:\n' >&2
    printf '  %s\n' "$script_dir" >&2
    printf '\n' >&2
    printf 'docker-compose.yaml hard-codes `name: %s`, so two checkouts on the same host\n' "$project_name" >&2
    printf 'collide unless each one sets a distinct COMPOSE_PROJECT_NAME. Continuing would\n' >&2
    printf 'rebuild and stop the OTHER checkout'"'"'s running container and, by default,\n' >&2
    printf 'delete its codeman-node-modules/codeman-dist volumes.\n' >&2
    printf '\n' >&2
    printf 'Fix: export COMPOSE_PROJECT_NAME=<something-unique-to-this-checkout> before\n' >&2
    printf 'running this script, then retry.\n' >&2
    printf '\n' >&2
    printf 'If instead THIS checkout was moved or renamed after its container was created,\n' >&2
    printf 'the path above is its own old location: remove the old container (for example\n' >&2
    printf '`docker rm -f <container>` for the codeman container) and retry, rather than\n' >&2
    printf 'setting COMPOSE_PROJECT_NAME, which would start a second project beside it.\n' >&2
    exit 1
  fi
fi

# Same owner-detection Start-Codeman.sh uses to derive PUID/PGID for its own
# build — without it, the --no-cache build below gets Compose's untouched
# default of 1000:1000, and on any host whose appdata owner differs (99:100 on
# Unraid, per docker/README.md's chown example), Start-Codeman.sh's own
# correctly-PUID'd build during the handoff then rebuilds those layers with the
# right values anyway — so the "no cache, certain of what ships" image this
# script produces is not the one that actually ends up running.
#
# Deliberately NOT the same as Start-Codeman.sh's own handling of a MISSING
# appdata directory (which creates it): this script updates an EXISTING
# deployment, so a missing appdata path means there is nothing here yet to
# update, and creating one would just be this script quietly doing
# Start-Codeman.sh's first-run job worse.
appdata_path=$(
  "${compose_command[@]}" config --environment |
    awk -F= '$1 == "CODEMAN_APPDATA_PATH" { sub(/^[^=]*=/, ""); print; exit }'
)
if [[ -z "$appdata_path" || ! -d "$appdata_path" ]]; then
  printf 'Error: CODEMAN_APPDATA_PATH is not set or does not exist: %s\n' "${appdata_path:-<unset>}" >&2
  printf 'Run docker/Start-Codeman.sh first to set up a new deployment.\n' >&2
  exit 1
fi

# `stat -c` is GNU, `stat -f` is BSD/macOS; the bind source lives on the Docker
# host, so both need to work. Identical to Start-Codeman.sh's own helper.
owner_of() {
  stat -c '%u:%g' -- "$1" 2>/dev/null || stat -f '%u:%g' "$1" 2>/dev/null
}

if ! owner_ids=$(owner_of "$appdata_path"); then
  printf 'Error: Cannot determine the owner of CODEMAN_APPDATA_PATH: %s\n' "$appdata_path" >&2
  exit 1
fi

export PUID=${owner_ids%%:*}
export PGID=${owner_ids##*:}

if [[ "$PUID" == '0' ]]; then
  printf 'Error: CODEMAN_APPDATA_PATH is owned by root: %s\n' "$appdata_path" >&2
  printf 'Change the directory ownership to the unprivileged account that should run Codeman.\n' >&2
  exit 1
fi

# --no-cache, always: a plain `build` reuses cached layers (npm install, apt
# packages, the CLI installs baked into the image) and can silently keep them
# frozen at whatever they were the day the cache was populated — exactly wrong
# for a major update, whose whole point is being certain of what actually
# ships. `scripts/build-agent-image.mjs` makes the same call for the same
# reason (see its entry in CLAUDE.md's Additional Commands table). Runs BEFORE
# the stack is stopped — see the header comment for why.
printf 'Building a fresh image (--no-cache)...\n'
"${compose_command[@]}" build --no-cache

printf 'Stopping the stack...\n'
if [[ "$keep_volumes" == '1' || -n "$project_name" ]]; then
  "${compose_command[@]}" down
else
  # No resolvable project name means the label filter below could match
  # nothing, so fall back to Compose's own removal, and say what it really does.
  printf 'Warning: could not resolve the Compose project name; clearing EVERY named volume\n' >&2
  printf 'in this Compose project (override file included) with `down --volumes` instead.\n' >&2
  "${compose_command[@]}" down --volumes
fi

# Targeted removal of exactly the two build-artefact volumes, scoped by label to
# THIS project (the volume key alone is shared by any other stack declaring the
# same key). Same lookup as Start-Codeman.sh's refresh. A failure is reported,
# not fatal: the stack is already down, and the handoff below is what brings
# it back up.
if [[ "$keep_volumes" != '1' && -n "$project_name" ]]; then
  printf 'Clearing the codeman-node-modules/codeman-dist volumes (pass --keep-volumes to skip).\n'
  for key in codeman-node-modules codeman-dist; do
    volume_name=$(
      docker volume ls -q \
        --filter "label=com.docker.compose.volume=$key" \
        --filter "label=com.docker.compose.project=$project_name" |
        head -n1
    ) || volume_name=''
    if [[ -n "$volume_name" ]] && ! docker volume rm -- "$volume_name"; then
      printf 'Warning: could not remove volume %s; the container may keep serving the\n' "$volume_name" >&2
      printf 'previous build from it. Remove it by hand and rerun this script.\n' >&2
    fi
  done
fi

# Start-Codeman.sh does everything a plain `up -d` does not: re-derives
# PUID/PGID, pre-creates CODEMAN_CASES_PATH with the right ownership, resolves
# DOCKER_SOCKET_GID, records the server.Dockerfile/docker-compose.yaml
# fingerprint the in-app updater's gate reads on every future update, and
# starts the (already freshly built) image. Reimplementing any of that here
# would only risk drifting out of step with it — hand off instead, exactly as
# docs/docker-self-update.md's own reset procedure does.
#
# ⚠️ `bash`, not a bare exec of the path: Start-Codeman.sh is committed
# non-executable (100644), the same as this script, and is documented
# everywhere as `bash docker/Start-Codeman.sh` rather than
# `./docker/Start-Codeman.sh` — execing the bare path fails with EACCES.
printf 'Handing off to Start-Codeman.sh...\n'
exec bash "$script_dir/Start-Codeman.sh"
