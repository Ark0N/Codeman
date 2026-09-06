#!/usr/bin/env bash

set -euo pipefail

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
env_file="$script_dir/.env"
compose_file="$script_dir/docker-compose.yaml"

if [[ ! -f "$env_file" ]]; then
  printf 'Error: Docker environment file is missing: %s\n' "$env_file" >&2
  printf 'Create it from %s/.env.example before starting Codeman.\n' "$script_dir" >&2
  exit 1
fi

# Naming a Compose file explicitly disables Compose's automatic discovery of
# the override file, so it has to be added back by hand. Without this, local
# customisation in docker-compose.override.yml is silently ignored. The
# candidates are checked in Compose's own precedence order.
compose_files=(-f "$compose_file")
for override_file in \
  "$script_dir/docker-compose.override.yaml" \
  "$script_dir/docker-compose.override.yml"; do
  if [[ -f "$override_file" ]]; then
    compose_files+=(-f "$override_file")
    printf 'Using Compose override file: %s\n' "$override_file"
    break
  fi
done
compose_command=(docker compose --env-file "$env_file" "${compose_files[@]}")
appdata_path=$(
  "${compose_command[@]}" config --environment |
    awk -F= '$1 == "CODEMAN_APPDATA_PATH" { sub(/^[^=]*=/, ""); print; exit }'
)
docker_socket=$(
  "${compose_command[@]}" config --environment |
    awk -F= '$1 == "DOCKER_SOCKET" { sub(/^[^=]*=/, ""); print; exit }'
)

if [[ -z "$appdata_path" ]]; then
  printf 'Error: CODEMAN_APPDATA_PATH is not set in %s\n' "$env_file" >&2
  exit 1
fi

if [[ ! -d "$appdata_path" ]]; then
  if [[ "$EUID" == '0' ]]; then
    printf 'Error: Refusing to create CODEMAN_APPDATA_PATH as root: %s\n' "$appdata_path" >&2
    printf 'Create it as the unprivileged account that should run Codeman, then retry.\n' >&2
    exit 1
  fi
  mkdir -p -- "$appdata_path"
fi

if owner_ids=$(stat -c '%u:%g' -- "$appdata_path" 2>/dev/null); then
  :
elif owner_ids=$(stat -f '%u:%g' "$appdata_path" 2>/dev/null); then
  :
else
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

if [[ -z "$docker_socket" || ! -S "$docker_socket" ]]; then
  printf 'Error: DOCKER_SOCKET is not a Unix socket: %s\n' "${docker_socket:-<unset>}" >&2
  exit 1
fi

if socket_ids=$(stat -c '%u:%g' -- "$docker_socket" 2>/dev/null); then
  :
elif socket_ids=$(stat -f '%u:%g' "$docker_socket" 2>/dev/null); then
  :
else
  printf 'Error: Cannot determine the owner of DOCKER_SOCKET: %s\n' "$docker_socket" >&2
  exit 1
fi

export DOCKER_SOCKET_GID=${socket_ids##*:}

repo_path=${CODEMAN_REPO_PATH:-$(cd -- "$script_dir/.." && pwd)}
if [[ ! -d "$repo_path" ]]; then
  printf 'Error: CODEMAN_REPO_PATH is not a directory: %s\n' "$repo_path" >&2
  exit 1
fi
export CODEMAN_REPO_PATH="$repo_path"

# The in-app updater runs `git checkout` and `npm install` against this checkout
# as PUID:PGID. If the directory belongs to someone else, git refuses outright
# ("detected dubious ownership") and the update fails at the first step — so warn
# here, where the fix is obvious, rather than in a failed update hours later.
if repo_owner=$(stat -c '%u' -- "$repo_path" 2>/dev/null || stat -f '%u' "$repo_path" 2>/dev/null); then
  if [[ "$repo_owner" != "$PUID" ]]; then
    printf 'Warning: %s is owned by UID %s but Codeman runs as UID %s.\n' "$repo_path" "$repo_owner" "$PUID" >&2
    printf 'In-app updates will fail until the ownership matches. Codeman itself still starts.\n' >&2
  fi
fi

if [[ ! -d "$repo_path/.git" ]]; then
  printf 'Note: %s is not a git checkout, so in-app updates are unavailable.\n' "$repo_path" >&2
fi

# Reads HEAD without requiring a `git` binary on the host — this script
# otherwise checks the checkout only by testing for `.git` as a directory, and
# resolving refs by hand keeps that the same "no host git needed" guarantee.
git_head_commit() {
  local git_dir="$1/.git" head_ref ref_path
  [[ -d "$git_dir" ]] || return 1
  head_ref=$(cat -- "$git_dir/HEAD" 2>/dev/null) || return 1
  if [[ "$head_ref" == ref:* ]]; then
    ref_path="${head_ref#ref: }"
    if [[ -f "$git_dir/$ref_path" ]]; then
      cat -- "$git_dir/$ref_path"
    else
      # Packed after a `git gc`; the loose ref file above is gone.
      awk -v ref="$ref_path" '$2 == ref { print $1; exit }' "$git_dir/packed-refs" 2>/dev/null
    fi
  else
    printf '%s' "$head_ref"
  fi
}

# Record what the container is about to be built and created FROM. The in-app
# updater compares these against the release it wants to apply: a release that
# changes either file cannot be applied by the container restarting itself (a
# restart reuses the existing image and config), so it is refused and the user
# is sent back here. Written on every start, so the baseline always describes
# the container that is actually running. See docs/docker-self-update.md.
if command -v sha256sum >/dev/null 2>&1; then
  sha256_of() { sha256sum -- "$1" | cut -d' ' -f1; }
elif command -v shasum >/dev/null 2>&1; then
  sha256_of() { shasum -a 256 -- "$1" | cut -d' ' -f1; }
else
  sha256_of() { printf ''; }
fi

dockerfile_sha=$(sha256_of "$script_dir/server.Dockerfile")
compose_sha=$(sha256_of "$compose_file")
if [[ -n "$dockerfile_sha" && -n "$compose_sha" ]]; then
  # $CODEMAN_APPDATA_PATH is mounted at the runtime account's home, so this is
  # dataPath('docker-env-applied.json') as the server inside the container sees it.
  state_dir="$appdata_path/.codeman"
  mkdir -p -- "$state_dir"
  printf '{\n  "dockerfileSha256": "%s",\n  "composeSha256": "%s"\n}\n' \
    "$dockerfile_sha" "$compose_sha" >"$state_dir/docker-env-applied.json.tmp"
  mv -- "$state_dir/docker-env-applied.json.tmp" "$state_dir/docker-env-applied.json"
  # A root-run start (common on Unraid) would otherwise leave a root-owned
  # `.codeman` on a FIRST start, before the container has created it as PUID,
  # and the unprivileged server could then never write its own state there.
  if [[ "$EUID" == '0' ]]; then
    chown -- "$PUID:$PGID" "$state_dir" "$state_dir/docker-env-applied.json"
  fi
else
  printf 'Warning: no sha256 tool found; in-app updates will not detect environment changes.\n' >&2
fi

# codeman-node-modules and codeman-dist (docker-compose.yaml) are seeded from
# the image only while EMPTY, so a rebuilt image's fresh output sits unused
# behind old volume content until something clears it. The in-app self-updater
# never hits this — it rebuilds INSIDE the running container, into the very
# volume already in use — but a `docker compose build` triggered from outside
# it (this script, after a `git pull`) does: the container comes back up
# looking unchanged. Detect that here and clear just the affected volume(s) so
# `--build` below actually takes effect. Best-effort: with no sha256 tool this
# quietly does nothing, same as the environment-gate block above.
if [[ -n "$dockerfile_sha" ]]; then
  repo_head=$(git_head_commit "$repo_path" || true)
  lockfile_sha=$(sha256_of "$repo_path/package-lock.json" 2>/dev/null || true)
  source_state_file="$state_dir/docker-build-source.json"
  prev_head=''
  prev_lockfile_sha=''
  if [[ -f "$source_state_file" ]]; then
    prev_head=$(sed -n 's/.*"headCommit": *"\([^"]*\)".*/\1/p' "$source_state_file")
    prev_lockfile_sha=$(sed -n 's/.*"lockfileSha256": *"\([^"]*\)".*/\1/p' "$source_state_file")
  fi

  volumes_to_refresh=()
  [[ -n "$repo_head" && "$repo_head" != "$prev_head" ]] && volumes_to_refresh+=('codeman-dist')
  [[ -n "$lockfile_sha" && "$lockfile_sha" != "$prev_lockfile_sha" ]] && volumes_to_refresh+=('codeman-node-modules')

  if [[ ${#volumes_to_refresh[@]} -gt 0 ]]; then
    # Runs even on this script's very first invocation against an EXISTING
    # deployment, deliberately: that deployment's volumes may already be
    # stale (there was no earlier version of this check to have caught it),
    # and clearing an already-empty or nonexistent volume is a harmless
    # no-op, so there is no fresh-install case this needs to avoid.
    printf 'Source changed since the last start; refreshing: %s\n' "${volumes_to_refresh[*]}"
    "${compose_command[@]}" down
    for key in "${volumes_to_refresh[@]}"; do
      volume_name=$(docker volume ls -q --filter "label=com.docker.compose.volume=$key" | head -n1)
      [[ -n "$volume_name" ]] && docker volume rm -- "$volume_name"
    done
  fi

  printf '{\n  "headCommit": "%s",\n  "lockfileSha256": "%s"\n}\n' \
    "$repo_head" "$lockfile_sha" >"$source_state_file.tmp"
  mv -- "$source_state_file.tmp" "$source_state_file"
  if [[ "$EUID" == '0' ]]; then
    chown -- "$PUID:$PGID" "$source_state_file"
  fi
fi

exec "${compose_command[@]}" up --build -d
