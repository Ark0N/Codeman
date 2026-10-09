#!/usr/bin/env bash
#
# Sets up (on the first run) and starts the Docker Compose deployment.
#
# A new install is two commands, from a fresh clone:
#
#   git clone https://github.com/Ark0N/Codeman.git && cd Codeman
#   bash docker/Start-Codeman.sh
#
# With no docker/.env yet, this asks three questions (data folder, port,
# password; Enter takes the default each time), writes docker/.env from
# .env.example, builds the image, starts the container, waits until Codeman
# answers and prints the URL to open. Every later run (after a `git pull`, or
# when the in-app updater asks for it) skips the questions and rebuilds and
# restarts the stack.
#
# Usage: bash docker/Start-Codeman.sh [--yes] [--setup-only] [--no-wait]
#   --yes, -y      First run: take every default without asking. Also what
#                  happens when no terminal is attached.
#   --setup-only   Write docker/.env and stop, so it can be reviewed first.
#   --no-wait      Do not wait for Codeman to answer after starting it.
#
# A first run takes its defaults from CODEMAN_APPDATA_PATH, CODEMAN_PORT and
# CODEMAN_PASSWORD when they are set in the environment.
#
# Bash 3.2 clean on purpose: Docker Desktop on macOS runs this with
# /bin/bash 3.2 (no ${x,,}, mapfile, associative arrays or here-strings).

set -euo pipefail

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
env_file="$script_dir/.env"
example_file="$script_dir/.env.example"
compose_file="$script_dir/docker-compose.yaml"

assume_yes=0
setup_only=0
no_wait=0
for arg in "$@"; do
  case "$arg" in
    --yes | -y) assume_yes=1 ;;
    --setup-only) setup_only=1 ;;
    --no-wait) no_wait=1 ;;
    --help | -h)
      printf 'Usage: bash %s [--yes] [--setup-only] [--no-wait]\n' "$0"
      printf '  --yes, -y      First run: take every default without asking\n'
      printf '  --setup-only   Write docker/.env and stop, so it can be reviewed first\n'
      printf '  --no-wait      Do not wait for Codeman to answer after starting it\n'
      exit 0
      ;;
    *)
      printf 'Error: unrecognised argument: %s\n' "$arg" >&2
      printf 'Usage: bash %s [--yes] [--setup-only] [--no-wait]\n' "$0" >&2
      exit 1
      ;;
  esac
done

# ── Preflight ────────────────────────────────────────────────────────────────
# The three things a new machine most often lacks, each named with its fix
# before anything else runs (a missing daemon used to surface as a bare Compose
# error from the first `config` call below).

# PURE: is dotted version $1 older than $2? An unparseable $1 is never "older":
# the `config --environment` failure handler below still catches a real miss.
version_older_than() {
  local re='^([0-9]+)\.([0-9]+)\.([0-9]+)'
  local a b c x y z
  [[ "$1" =~ $re ]] || return 1
  a=$((10#${BASH_REMATCH[1]})) b=$((10#${BASH_REMATCH[2]})) c=$((10#${BASH_REMATCH[3]}))
  [[ "$2" =~ $re ]] || return 1
  x=$((10#${BASH_REMATCH[1]})) y=$((10#${BASH_REMATCH[2]})) z=$((10#${BASH_REMATCH[3]}))
  if ((a != x)); then
    ((a < x))
    return
  fi
  if ((b != y)); then
    ((b < y))
    return
  fi
  ((c < z))
}

# `docker compose config --environment`, which everything below reads the
# settings through, first shipped in Compose v2.27.2 (docker/compose#11891).
min_compose_version='2.27.2'

if ! command -v docker >/dev/null 2>&1; then
  printf 'Error: Docker is not installed (no `docker` command on PATH).\n' >&2
  printf 'Install Docker Engine (Linux: https://docs.docker.com/engine/install/) or\n' >&2
  printf 'Docker Desktop (macOS, Windows), then rerun this script.\n' >&2
  exit 1
fi

if ! docker compose version >/dev/null 2>&1; then
  printf 'Error: the Docker Compose v2 plugin is missing (`docker compose version` failed).\n' >&2
  if command -v docker-compose >/dev/null 2>&1; then
    printf 'The standalone `docker-compose` found on PATH is not a substitute for it.\n' >&2
  fi
  printf 'Install it from https://docs.docker.com/compose/install/linux/\n' >&2
  printf '(Debian/Ubuntu with Docker'"'"'s apt repository: sudo apt-get install docker-compose-plugin).\n' >&2
  exit 1
fi

compose_version=$(docker compose version --short 2>/dev/null || true)
compose_version=${compose_version#v}
if version_older_than "$compose_version" "$min_compose_version"; then
  printf 'Error: Docker Compose %s is too old; Codeman needs %s or newer.\n' \
    "$compose_version" "$min_compose_version" >&2
  printf 'Update the Compose plugin (https://docs.docker.com/compose/install/linux/), then rerun.\n' >&2
  exit 1
fi

if ! docker_info_error=$(docker info --format '{{.ServerVersion}}' 2>&1 >/dev/null); then
  case "$docker_info_error" in
    *[Pp]ermission\ denied*)
      account=$(id -un 2>/dev/null || printf 'your account')
      printf 'Error: %s is not allowed to use Docker yet.\n' "$account" >&2
      printf 'Add it to the docker group, then log out and back in (or run `newgrp docker`):\n' >&2
      printf '  sudo usermod -aG docker %s\n' "$account" >&2
      printf 'Prefer that over running this script with sudo: Codeman'"'"'s data folder has to\n' >&2
      printf 'belong to a normal account, and a first run refuses to set it up as root.\n' >&2
      ;;
    *)
      printf 'Error: the Docker daemon is not reachable. Start it (Linux: sudo systemctl start\n' >&2
      printf 'docker; macOS and Windows: open Docker Desktop), then rerun this script.\n' >&2
      printf 'Docker said: %s\n' "$docker_info_error" >&2
      ;;
  esac
  exit 1
fi

# ── First-run setup ──────────────────────────────────────────────────────────
# Runs only while docker/.env does not exist, and never edits an existing one.
# The file is generated FROM .env.example (its KEY= lines rewritten in place),
# so every key the example sets is present: the in-app updater refuses an
# update while the user's .env lacks a key the target release's example sets
# (diffRequiredEnvKeys, src/web/self-update.ts), and a hand-picked subset would
# trip that on the very next release.

first_run=0
generated_password=''

is_interactive() {
  [[ "$assume_yes" != '1' && "${CODEMAN_NONINTERACTIVE:-0}" != '1' && -t 0 ]]
}

# Reads one answer into $answer (with -s, without echo). End of input (Ctrl+D)
# cancels the setup rather than looping on a default that was just refused.
ask() {
  if ! IFS= read -r "$@" answer; then
    printf '\nSetup cancelled; nothing was written.\n' >&2
    exit 1
  fi
}

# True when something on this host already accepts connections on the port.
# bash's /dev/tcp needs no extra tool on Linux or macOS.
port_in_use() {
  (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null || (exec 3<>"/dev/tcp/::1/$1") 2>/dev/null
}

first_free_port() {
  local port=$1
  local last=$(($1 + 99))
  while ((port <= last)); do
    if ! port_in_use "$port"; then
      printf '%s' "$port"
      return 0
    fi
    port=$((port + 1))
  done
  printf '%s' "$1"
}

host_timezone() {
  local tz='' re='^[A-Za-z0-9_+/-]+$'
  if [[ -r /etc/timezone ]]; then
    tz=$(head -n1 /etc/timezone 2>/dev/null) || tz=''
  fi
  if [[ -z "$tz" ]] && command -v timedatectl >/dev/null 2>&1; then
    tz=$(timedatectl show -p Timezone --value 2>/dev/null) || tz=''
  fi
  if [[ -z "$tz" && -L /etc/localtime ]]; then
    tz=$(readlink /etc/localtime 2>/dev/null) || tz=''
    tz=${tz##*zoneinfo/}
  fi
  if [[ ! "$tz" =~ $re ]]; then
    tz='Etc/UTC'
  fi
  printf '%s' "$tz"
}

generate_password() {
  local pw=''
  # `|| true`: head closing the pipe early is the normal case, not a failure.
  pw=$(LC_ALL=C tr -dc 'A-Za-z0-9' </dev/urandom 2>/dev/null | head -c 24) || true
  if ((${#pw} != 24)) && command -v openssl >/dev/null 2>&1; then
    pw=$(openssl rand -base64 48 | LC_ALL=C tr -dc 'A-Za-z0-9' | head -c 24) || true
  fi
  if ((${#pw} != 24)); then
    printf 'Error: could not generate a password; set CODEMAN_PASSWORD and rerun.\n' >&2
    exit 1
  fi
  printf '%s' "$pw"
}

# Compose reads .env values with its own dotenv rules: `$` interpolates and an
# unquoted ` #` starts a comment. A single-quoted value is taken literally, so
# anything beyond plain path characters is written that way (the accept_*
# checks below refuse the one character it cannot hold, a single quote).
env_quote() {
  local re='^[A-Za-z0-9._/@:+-]*$'
  if [[ "$1" =~ $re ]]; then
    printf '%s' "$1"
  else
    printf "'%s'" "$1"
  fi
}

repo_root=$(cd -- "$script_dir/.." && pwd)

# Sets setup_appdata, or says why the answer cannot be used and returns 1.
accept_appdata_path() {
  local p=$1
  case "$p" in
    '~') p=$HOME ;;
    '~/'*) p="$HOME/${p#\~/}" ;;
  esac
  while [[ "$p" == */ && "$p" != / ]]; do
    p=${p%/}
  done
  case "$p" in
    *"'"* | *$'\n'*)
      printf '  The path cannot contain a single quote or a line break.\n' >&2
      return 1
      ;;
  esac
  if [[ "$p" != /* ]]; then
    printf '  Use an absolute path, one that starts with /.\n' >&2
    return 1
  fi
  # The folder becomes the container's home directory, so its `.codeman` is
  # the server's state directory: $HOME itself would share state.json with a
  # Codeman installed directly on this machine.
  if [[ "$p" == / || "$p" == "$HOME" ]]; then
    printf '  Pick a folder of its own; it becomes the container'"'"'s home directory.\n' >&2
    return 1
  fi
  if [[ "$p" == "$HOME/.codeman" || "$p" == "$HOME/.codeman/"* ]]; then
    printf '  %s belongs to a Codeman installed directly on this machine; pick another folder.\n' "$HOME/.codeman" >&2
    return 1
  fi
  # Inside the checkout it would sit in the image build context (COPY . .),
  # CLI logins and all.
  if [[ "$p" == "$repo_root" || "$p" == "$repo_root/"* ]]; then
    printf '  Pick a folder outside %s; that folder is copied into the image when it is built.\n' "$repo_root" >&2
    return 1
  fi
  setup_appdata=$p
}

accept_port() {
  local re='^[0-9]+$'
  if [[ ! "$1" =~ $re ]] || ((10#$1 < 1 || 10#$1 > 65535)); then
    printf '  Use a port number from 1 to 65535.\n' >&2
    return 1
  fi
  setup_port=$((10#$1))
}

accept_password() {
  case "$1" in
    *"'"* | *$'\n'*)
      printf '  The password cannot contain a single quote or a line break.\n' >&2
      return 1
      ;;
  esac
  if ((${#1} < 8)); then
    printf '  Use at least 8 characters.\n' >&2
    return 1
  fi
  if [[ "$1" == 'changeme' ]]; then
    printf '  That is the published example password; pick another.\n' >&2
    return 1
  fi
  setup_password=$1
}

write_env_file() {
  local tmp="$env_file.tmp.$$" line
  (
    umask 077
    {
      printf '# Written by Start-Codeman.sh on its first run, from .env.example.\n'
      printf '# Change any value here, then rerun: bash docker/Start-Codeman.sh\n'
      printf '\n'
      while IFS= read -r line || [[ -n "$line" ]]; do
        case "$line" in
          TZ=*) printf 'TZ=%s\n' "$(env_quote "$setup_tz")" ;;
          CODEMAN_APPDATA_PATH=*) printf 'CODEMAN_APPDATA_PATH=%s\n' "$(env_quote "$setup_appdata")" ;;
          CODEMAN_CASES_PATH=*) printf 'CODEMAN_CASES_PATH=%s\n' "$(env_quote "$setup_cases")" ;;
          CODEMAN_PORT=*) printf 'CODEMAN_PORT=%s\n' "$setup_port" ;;
          CODEMAN_PASSWORD=*) printf 'CODEMAN_PASSWORD=%s\n' "$(env_quote "$setup_password")" ;;
          *) printf '%s\n' "$line" ;;
        esac
      done <"$example_file"
    } >"$tmp"
  )
  chmod 600 "$tmp"
  mv -- "$tmp" "$env_file"
}

run_first_run_setup() {
  local answer again default_appdata default_port port_note='' password_note username
  if [[ "$EUID" == '0' ]]; then
    printf 'Error: %s does not exist yet, and the first-run setup does not run as root.\n' "$env_file" >&2
    printf 'Run it as the normal account that should own Codeman'"'"'s data (that account\n' >&2
    printf 'needs to be in the docker group). On a root-only host such as Unraid, copy\n' >&2
    printf '%s to %s by hand instead,\n' "$example_file" "$env_file" >&2
    printf 'point CODEMAN_APPDATA_PATH at a folder an unprivileged account owns, set\n' >&2
    printf 'CODEMAN_PASSWORD, and rerun.\n' >&2
    exit 1
  fi
  if [[ ! -f "$example_file" ]]; then
    printf 'Error: %s is missing, so there is nothing to build docker/.env from.\n' "$example_file" >&2
    exit 1
  fi

  default_appdata=${CODEMAN_APPDATA_PATH:-$HOME/codeman-docker}
  if [[ -n "${CODEMAN_PORT:-}" ]]; then
    default_port=$CODEMAN_PORT
  else
    default_port=$(first_free_port 3000)
    if [[ "$default_port" != '3000' ]]; then
      port_note=' (3000 is already taken on this machine)'
    fi
  fi
  setup_tz=$(host_timezone)
  username=$(sed -n 's/^CODEMAN_USERNAME=//p' "$example_file" | head -n1)

  printf '\nCodeman Docker setup\n'
  printf 'There is no docker/.env yet, so this first run writes one. Enter takes the [default].\n\n'

  if is_interactive; then
    while :; do
      printf '  Data folder (state, CLI logins, projects) [%s]: ' "$default_appdata"
      ask
      if [[ -z "$answer" ]]; then
        answer=$default_appdata
      fi
      if accept_appdata_path "$answer"; then
        break
      fi
    done
    while :; do
      printf '  Port [%s]%s: ' "$default_port" "$port_note"
      ask
      if [[ -z "$answer" ]]; then
        answer=$default_port
      fi
      if accept_port "$answer"; then
        break
      fi
    done
    if [[ -n "${CODEMAN_PASSWORD:-}" ]]; then
      accept_password "$CODEMAN_PASSWORD" || exit 1
      printf '  Password: taken from CODEMAN_PASSWORD\n'
    else
      while :; do
        printf '  Password [Enter generates a strong one]: '
        ask -s
        printf '\n'
        if [[ -z "$answer" ]]; then
          setup_password=$(generate_password)
          generated_password=$setup_password
          break
        fi
        if ! accept_password "$answer"; then
          continue
        fi
        printf '  Repeat the password: '
        again=$answer
        ask -s
        printf '\n'
        if [[ "$again" == "$answer" ]]; then
          break
        fi
        printf '  The two entries differ; try again.\n' >&2
      done
    fi
  else
    printf '  No questions asked (no terminal attached, or --yes): taking the defaults.\n'
    accept_appdata_path "$default_appdata" || exit 1
    accept_port "$default_port" || exit 1
    if [[ -n "${CODEMAN_PASSWORD:-}" ]]; then
      accept_password "$CODEMAN_PASSWORD" || exit 1
    else
      setup_password=$(generate_password)
      generated_password=$setup_password
    fi
  fi

  if port_in_use "$setup_port"; then
    printf '  Note: something on this machine already listens on port %s, so starting will\n' "$setup_port" >&2
    printf '  fail until it stops or CODEMAN_PORT in docker/.env names a free port.\n' >&2
  fi

  setup_cases="$setup_appdata/codeman-cases"
  write_env_file
  first_run=1

  if [[ -n "$generated_password" ]]; then
    password_note="$generated_password  (generated; shown again once Codeman is up)"
  else
    password_note='the one you chose'
  fi
  printf '\nWrote %s (readable only by you):\n' "$env_file"
  printf '  Data folder  %s\n' "$setup_appdata"
  printf '  Projects     %s\n' "$setup_cases"
  printf '  Port         %s\n' "$setup_port"
  printf '  Time zone    %s\n' "$setup_tz"
  printf '  Username     %s\n' "${username:-admin}"
  printf '  Password     %s\n' "$password_note"
  printf 'Everything else in it is optional (Git identity, private repositories, reverse\n'
  printf 'proxy); docker/README.md explains each setting.\n\n'
}

if [[ ! -f "$env_file" ]]; then
  run_first_run_setup
elif [[ "$setup_only" == '1' ]]; then
  printf '%s already exists; the setup only runs when it does not, and never edits it.\n' "$env_file"
fi

if [[ "$setup_only" == '1' ]]; then
  printf 'Start Codeman with: bash %s\n' "$script_dir/Start-Codeman.sh"
  exit 0
fi

# Naming a Compose file explicitly disables Compose's automatic discovery of
# the override file, so it has to be added back by hand. Without this, local
# customisation in docker-compose.override.yml is silently ignored. The
# candidates are checked in Compose's own precedence order - measured on
# Compose v5.5.0 with both present: it uses `.yml` and ignores `.yaml`.
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

# Every setting is read through Compose's own resolution (shell environment over
# .env, quoting, interpolation), once. A failure is reported here with what
# Compose said, instead of `set -e` ending the script at an empty value.
compose_stderr=$(mktemp "${TMPDIR:-/tmp}/codeman-compose.XXXXXX")
if ! compose_environment=$("${compose_command[@]}" config --environment 2>"$compose_stderr"); then
  if grep -q -- 'unknown flag: --environment' "$compose_stderr"; then
    printf 'Error: this Docker Compose (%s) is too old; Codeman needs %s or newer.\n' \
      "${compose_version:-unknown version}" "$min_compose_version" >&2
  else
    cat -- "$compose_stderr" >&2
    printf 'Error: `docker compose config` could not read %s and the Compose files (see above).\n' "$env_file" >&2
  fi
  rm -f -- "$compose_stderr"
  exit 1
fi
# Compose's own warnings (an unset variable, say) still reach the terminal, once.
cat -- "$compose_stderr" >&2
rm -f -- "$compose_stderr"

# No early `exit` in the awk program: it reads all of its input, so printf never
# meets a closed pipe (a SIGPIPE would end the script under pipefail).
compose_env_value() {
  printf '%s\n' "$compose_environment" |
    awk -F= -v key="$1" '$1 == key && !found { sub(/^[^=]*=/, ""); print; found = 1 }'
}
appdata_path=$(compose_env_value CODEMAN_APPDATA_PATH)
cases_path=$(compose_env_value CODEMAN_CASES_PATH)
docker_socket=$(compose_env_value DOCKER_SOCKET)
codeman_port=$(compose_env_value CODEMAN_PORT)
codeman_username=$(compose_env_value CODEMAN_USERNAME)
codeman_password=$(compose_env_value CODEMAN_PASSWORD)

# The container publishes its port on every interface and holds the host's
# Docker socket, so whoever signs in to Codeman can run anything on this host.
# The example's placeholder is a published password: refuse it outright.
if [[ "$codeman_password" == 'changeme' ]]; then
  printf 'Error: CODEMAN_PASSWORD is still the example value "changeme".\n' >&2
  printf 'Codeman is reachable from your network and controls Docker on this machine, so\n' >&2
  printf 'set a real password in %s, then rerun this script.\n' "$env_file" >&2
  exit 1
fi
if [[ -z "$codeman_password" ]]; then
  printf 'Warning: CODEMAN_PASSWORD is empty, so anyone who can reach port %s can use Codeman,\n' "${codeman_port:-?}" >&2
  printf 'which controls Docker on this machine. Set one in %s unless something in front of it\n' "$env_file" >&2
  printf 'already asks for a login.\n' >&2
fi
unset codeman_password

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
  if ! mkdir -p -- "$appdata_path"; then
    printf 'Error: cannot create CODEMAN_APPDATA_PATH: %s\n' "$appdata_path" >&2
    printf 'Create it as the account that should run Codeman, or pick another folder in %s.\n' "$env_file" >&2
    exit 1
  fi
fi

if [[ -z "$cases_path" ]]; then
  printf 'Error: CODEMAN_CASES_PATH is not set in %s\n' "$env_file" >&2
  exit 1
fi

# `stat -c` is GNU, `stat -f` is BSD/macOS; the bind sources live on the Docker
# host, so both need to work.
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

# Pre-creating this here, exactly like CODEMAN_APPDATA_PATH above, means Compose
# never has to materialise a missing bind source itself - which it does as
# root:root - so the in-container entrypoint's chown never has to run for this
# path at all. It happens AFTER PUID/PGID are known (they come from the appdata
# directory just above) so the new directory can be given that exact owner: a
# plain `mkdir -p` lands as the invoking user's uid and PRIMARY gid, and on a
# host set up the way the README suggests (`chown -R 99:100 <appdata>`) that gid
# is not PGID, which the container would then refuse to run on. Unlike appdata,
# an EXISTING cases directory is left exactly as it is: the README explicitly
# allows pointing this at a normal projects directory the host account already
# owns, and the container checks that it is WRITABLE as PUID:PGID rather than
# who owns it.
if [[ ! -d "$cases_path" ]]; then
  mkdir -p -- "$cases_path"
  if [[ "$(owner_of "$cases_path")" != "$PUID:$PGID" ]]; then
    # As root this always succeeds; as a member of PGID a chgrp does; anyone
    # else gets the clear error here, where the fix is obvious, rather than a
    # restart loop from the container.
    if ! chown -- "$PUID:$PGID" "$cases_path" 2>/dev/null; then
      printf 'Error: created CODEMAN_CASES_PATH (%s) but could not make it %s:%s (the owner of CODEMAN_APPDATA_PATH).\n' \
        "$cases_path" "$PUID" "$PGID" >&2
      printf 'Run `chown %s:%s %s` as root, or create the directory as that account, then retry.\n' \
        "$PUID" "$PGID" "$cases_path" >&2
      exit 1
    fi
  fi
fi

if [[ -z "$docker_socket" || ! -S "$docker_socket" ]]; then
  printf 'Error: DOCKER_SOCKET is not a Unix socket: %s\n' "${docker_socket:-<unset>}" >&2
  printf 'Set DOCKER_SOCKET in %s to the socket your Docker daemon listens on.\n' "$env_file" >&2
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
# ⚠️ A worktree checkout has `.git` as a FILE (`gitdir: <path>`), not a
# directory, so this returns nothing there and the volume-refresh check below
# silently no-ops — consistent with the `-d .git` test used everywhere else in
# this script, not a special case, but worth knowing if a worktree checkout
# stops picking up a stale-volume refresh it should have caught.
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

# ── Start, then wait until Codeman answers ──────────────────────────────────
# `up -d` returns as soon as the container exists, which says nothing about the
# server inside it. The wait asks the server itself through `docker exec` (the
# same request as the compose healthcheck, which first runs only after its 30 s
# interval), notices a crash loop by the restart count moving, and ends on the
# URL to open. Docker's own view works with any network setup, macvlan included.

logs_hint="cd $(printf '%q' "$script_dir") && docker compose logs -f codeman"

# Docker's own output above says what broke; this adds the next step. A first
# build fetches hundreds of packages, so a network hiccup is the usual cause of
# a failed build, and a rerun picks up from Docker's layer cache.
compose_failed() {
  printf '\nError: `docker compose %s` failed (see the output above).\n' "$1" >&2
  case "$1" in
    build)
      printf 'A network hiccup while building is the usual cause; rerunning this script\n' >&2
      printf 'resumes from Docker'"'"'s cache.\n' >&2
      ;;
    *--build*)
      printf 'If it stopped while building the image, a network hiccup is the usual cause,\n' >&2
      printf 'and rerunning this script resumes from Docker'"'"'s cache.\n' >&2
      ;;
  esac
  exit 1
}

lan_ip() {
  local ip=''
  if [[ "$(uname -s)" == 'Darwin' ]]; then
    ip=$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null) || ip=''
  else
    # The address the default route leaves from: the first one `hostname -I`
    # lists is often docker0 or a VPN interface.
    ip=$(ip -4 route get 1.1.1.1 2>/dev/null | sed -n 's/.* src \([0-9.]*\).*/\1/p') || ip=''
    ip=${ip%%$'\n'*}
    if [[ -z "$ip" ]]; then
      ip=$(hostname -I 2>/dev/null) || ip=''
      ip=${ip%% *}
    fi
  fi
  printf '%s' "$ip"
}

print_access_summary() {
  local cid=$1 published host_port bind_host lan addresses dir_q
  dir_q=$(printf '%q' "$script_dir")
  published=$("${compose_command[@]}" port codeman "$codeman_port" 2>/dev/null) || published=''
  published=${published%%$'\n'*}
  printf '\n'
  if [[ -n "$published" ]]; then
    host_port=${published##*:}
    bind_host=${published%:*}
    printf '  Open        http://localhost:%s\n' "$host_port"
    case "$bind_host" in
      127.0.0.1 | '[::1]' | ::1) ;;
      *)
        lan=$(lan_ip)
        if [[ -n "$lan" ]]; then
          printf '              http://%s:%s  (from other devices on your network)\n' "$lan" "$host_port"
        fi
        ;;
    esac
  else
    addresses=$(docker inspect --format '{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}' "$cid" 2>/dev/null) || addresses=''
    printf '  Open        http://<container address>:%s  (no host port is published; container addresses: %s)\n' \
      "$codeman_port" "${addresses:-unknown}"
  fi
  printf '  Sign in     %s, with the CODEMAN_PASSWORD from %s\n' "${codeman_username:-admin}" "$env_file"
  if [[ -n "$generated_password" ]]; then
    printf '  Password    %s  (generated on this first run)\n' "$generated_password"
  fi
  if [[ "$first_run" == '1' ]]; then
    printf '\n  Next: start a session from the dashboard and log its CLI in once. Logins are\n'
    printf '  kept in %s, so they survive rebuilds.\n' "$appdata_path"
  fi
  printf '\n'
  printf '  Logs        cd %s && docker compose logs -f codeman\n' "$dir_q"
  printf '  Stop        cd %s && docker compose down\n' "$dir_q"
  printf '  Update      App Settings > Updates in the dashboard, or rerun this script\n'
}

report_when_ready() {
  local cid state status health restarts first_restarts='' waited=0 limit=180 probe dots=0
  cid=$("${compose_command[@]}" ps -q codeman 2>/dev/null) || cid=''
  cid=${cid%%$'\n'*}
  if [[ -z "$cid" ]]; then
    printf 'Error: Compose started no codeman container. Look at: %s\n' "$logs_hint" >&2
    return 1
  fi
  if [[ "$no_wait" == '1' ]]; then
    printf '\nCodeman is starting (--no-wait given, so not waiting for it).\n'
    print_access_summary "$cid"
    return 0
  fi
  if [[ -t 1 ]]; then
    dots=1
  fi
  probe="fetch('http://127.0.0.1:${codeman_port}/api/status').then((r) => process.exit(r.status < 500 ? 0 : 1)).catch(() => process.exit(1))"
  printf 'Waiting for Codeman to answer...'
  while :; do
    state=$(docker inspect --format '{{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}{{end}}|{{.RestartCount}}' "$cid" 2>/dev/null) || state='missing||0'
    status=${state%%|*}
    health=${state#*|}
    health=${health%%|*}
    restarts=${state##*|}
    if [[ -z "$first_restarts" ]]; then
      first_restarts=$restarts
    fi
    if [[ "$health" == 'healthy' ]] ||
      { [[ "$status" == 'running' ]] && docker exec "$cid" node -e "$probe" >/dev/null 2>&1; }; then
      printf ' ready.\n'
      print_access_summary "$cid"
      return 0
    fi
    if [[ "$status" == 'exited' || "$status" == 'dead' || "$status" == 'missing' || "$status" == 'restarting' ||
      "$health" == 'unhealthy' || "$restarts" != "$first_restarts" ]]; then
      printf '\n'
      printf 'Error: Codeman did not come up (container %s). Its last log lines:\n\n' "${status:-unknown}" >&2
      "${compose_command[@]}" logs --tail 40 codeman >&2 || true
      printf '\nFollow the full log with: %s\n' "$logs_hint" >&2
      return 1
    fi
    if ((waited >= limit)); then
      printf '\n'
      printf 'Warning: Codeman has not answered after %s seconds. It may still be starting;\n' "$limit" >&2
      printf 'follow it with: %s\n' "$logs_hint" >&2
      return 1
    fi
    if ((dots)); then
      printf '.'
    fi
    sleep 2
    waited=$((waited + 2))
  done
}

if [[ "$first_run" == '1' ]]; then
  printf 'Building the image. The first build downloads and compiles everything and takes a\n'
  printf 'few minutes; later starts reuse most of it.\n'
fi

# codeman-node-modules and codeman-dist (docker-compose.yaml) are seeded from
# the image only while EMPTY, so a rebuilt image's fresh output sits unused
# behind old volume content until something clears it. The in-app self-updater
# never hits this — it rebuilds INSIDE the running container, into the very
# volume already in use — but a `docker compose build` triggered from outside
# it (this script, after a `git pull`) does: the container comes back up
# looking unchanged. Detect that here and clear just the affected volume(s) so
# the build below actually takes effect. Best-effort: with no sha256 tool this
# quietly does nothing, same as the environment-gate block above.
volumes_to_refresh=()
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

  [[ -n "$repo_head" && "$repo_head" != "$prev_head" ]] && volumes_to_refresh+=('codeman-dist')
  [[ -n "$lockfile_sha" && "$lockfile_sha" != "$prev_lockfile_sha" ]] && volumes_to_refresh+=('codeman-node-modules')
fi

if [[ ${#volumes_to_refresh[@]} -eq 0 ]]; then
  "${compose_command[@]}" up --build -d || compose_failed 'up --build'
  report_when_ready || exit 1
  exit 0
fi

# Runs even on this script's very first invocation against an EXISTING
# deployment, deliberately: that deployment's volumes may already be stale
# (there was no earlier version of this check to have caught it), and clearing
# an already-empty or nonexistent volume is a harmless no-op, so there is no
# fresh-install case this needs to avoid.
printf 'Source changed since the last start; refreshing: %s\n' "${volumes_to_refresh[*]}"

# Build BEFORE taking the stack down: the image build is the slow part and needs
# no container stopped, so the deployment is offline only for the recreate.
"${compose_command[@]}" build || compose_failed build

# `com.docker.compose.volume` is the volume KEY, not a project-qualified name -
# a second stack on the same host (a beta instance started with a different
# COMPOSE_PROJECT_NAME, say) that also declares a volume keyed `codeman-dist`
# shares that label, and `head -n1` would pick whichever the daemon happens to
# list first. Scope the lookup to THIS stack's own resolved project name so it
# can only ever match this stack's volume. The name is read from the resolved
# config's top-level `name` key, indentation-agnostic (the formatting is not a
# contract), and the FIRST `name` in the output is the project's: nested ones
# (a network's `name:`) come later. `--format json` needs Compose v2.3+.
project_name=$(
  "${compose_command[@]}" config --format json 2>/dev/null |
    sed -n 's/^[[:space:]]*"name":[[:space:]]*"\([^"]*\)".*$/\1/p' | head -n1
)

"${compose_command[@]}" down

# Track whether the volumes were actually cleared. The marker below is written
# ONLY on success: with an unresolvable project name the label filter would
# match nothing, nothing would be removed, and a marker recording the new HEAD
# would stop this check from ever firing again while the stale volume kept
# serving old code. A failed removal likewise leaves the marker alone, so the
# next start retries, and the stack is brought back up regardless rather than
# left down.
refreshed=1
if [[ -z "$project_name" ]]; then
  # The documented reset (docs/docker-self-update.md): both volumes re-seed from
  # the image by a plain copy, so clearing the extra one costs a copy, not data.
  printf 'Warning: could not resolve the Compose project name; clearing both build-artefact volumes with `down --volumes` instead.\n' >&2
  "${compose_command[@]}" down --volumes || refreshed=0
else
  for key in "${volumes_to_refresh[@]}"; do
    volume_name=$(
      docker volume ls -q \
        --filter "label=com.docker.compose.volume=$key" \
        --filter "label=com.docker.compose.project=$project_name" |
        head -n1
    )
    if [[ -n "$volume_name" ]] && ! docker volume rm -- "$volume_name"; then
      printf 'Warning: could not remove volume %s; it will be retried on the next start.\n' "$volume_name" >&2
      refreshed=0
    fi
  done
fi

if [[ "$refreshed" == '1' ]]; then
  printf '{\n  "headCommit": "%s",\n  "lockfileSha256": "%s"\n}\n' \
    "$repo_head" "$lockfile_sha" >"$source_state_file.tmp"
  mv -- "$source_state_file.tmp" "$source_state_file"
  if [[ "$EUID" == '0' ]]; then
    chown -- "$PUID:$PGID" "$source_state_file"
  fi
else
  printf 'Warning: the build-artefact volumes were NOT refreshed; the container may serve stale code until the next successful start.\n' >&2
fi

# Already built above, so no --build here: a second build would only re-check
# the cache.
"${compose_command[@]}" up -d || compose_failed up
report_when_ready || exit 1
