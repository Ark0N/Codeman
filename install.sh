#!/usr/bin/env bash
# Codeman Universal Installer
# https://github.com/Ark0N/Codeman
#
# Usage: curl -fsSL https://getcodeman.com/install | bash
#        curl -fsSL https://getcodeman.com/install | bash -s -- [flags] [subcommand]
#
# The flow: look at what is already on the machine, ask at most three
# questions (how the dashboard is reached, optionally what to call this
# machine on your tailnet, whether to run Codeman as a service), then do all
# the work unattended and end on the URL, with a QR code for your phone.
#
# Flags (each has an environment-variable twin, listed below):
#   --tailscale | --lan | --local   How the dashboard is reached (question 1)
#   --name <n> | --no-rename        Rename this machine on the tailnet / never ask (question 2)
#   --service | --run | --no-start  What to do at the end (question 3)
#   --yes, -y                       Take every default; still waits on a Tailscale login URL
#   --password <p>                  Dashboard password (visible in `ps`; prefer CODEMAN_PASSWORD)
#   --port <n>                      Port Codeman listens on (default 3000)
#   --help, -h                      Print this text
#
# Environment variables:
#   CODEMAN_NONINTERACTIVE=1  - Skip all prompts and accept their defaults
#                               (CI/automation). Required for headless runs
#                               that need system changes (sudo package
#                               installs, AI CLI download); without it those
#                               steps abort instead of running silently.
#                               Never installs Tailscale, never renames.
#   CODEMAN_INSTALL_DIR       - Custom install directory (default: ~/.codeman/app)
#   CODEMAN_SKIP_SYSTEMD=1    - Skip systemd/launchd service setup prompt
#   CODEMAN_NODE_VERSION      - Node.js major version to install (default: 22)
#   CODEMAN_REPO_URL          - Custom git repository URL (default: upstream Codeman)
#   CODEMAN_BRANCH            - Git branch to install (default: master)
#   CODEMAN_HOST              - Preset the network binding and skip the prompt
#                               (0.0.0.0 for LAN access, 127.0.0.1 for local-only)
#   CODEMAN_PASSWORD          - Preset the dashboard password
#   CODEMAN_PORT              - Port Codeman listens on (default 3000); written
#                               into the service and used as the serve target
#   CODEMAN_TAILSCALE=1       - Preset the Tailscale choice: bind loopback and
#                               front it with `tailscale serve` HTTPS (never
#                               installs Tailscale in non-interactive runs)
#   CODEMAN_TAILSCALE_NAME    - Rename this machine on the tailnet (same as --name)
#
# Subcommands:
#   install.sh update       - Update an existing install
#   install.sh uninstall    - Remove services, symlinks and (optionally) data
#   install.sh tailscale    - Set up (or repair) Tailscale HTTPS access for an existing install
#   install.sh name [<n>]   - Rename this machine on your tailnet (default: codeman-<hostname>)
#   install.sh status       - Print the URLs, the QR code and how to manage the service
#   install.sh cloudflared  - Install cloudflared for the in-app Cloudflare tunnel

set -euo pipefail

# ============================================================================
# Configuration
# ============================================================================

INSTALL_DIR="${CODEMAN_INSTALL_DIR:-$HOME/.codeman/app}"
REPO_URL="${CODEMAN_REPO_URL:-https://github.com/Ark0N/Codeman.git}"
BRANCH="${CODEMAN_BRANCH:-master}"
MIN_NODE_VERSION=18
TARGET_NODE_VERSION="${CODEMAN_NODE_VERSION:-22}"
NONINTERACTIVE="${CODEMAN_NONINTERACTIVE:-0}"
SKIP_SYSTEMD="${CODEMAN_SKIP_SYSTEMD:-0}"

# Network binding chosen during install (choose_network_binding). Empty
# BIND_HOST means "not chosen" (e.g. the update path) and falls back to the
# server's own loopback default.
BIND_HOST=""
BIND_PASSWORD=""
BIND_ACK="0"

# Binding found in an already-installed service (read_existing_binding), used
# so updates and re-installs preserve the user's previous choice instead of
# silently loosening it to the new network-access default.
EXISTING_FOUND="0"
EXISTING_HOST=""
EXISTING_PASSWORD=""
EXISTING_ACK="0"

# Tailscale serve URL configured or detected during this run
# (tailscale_apply / detect_tailscale_serve_url). Empty when the Tailscale path
# was not taken or not completed.
TAILSCALE_SERVE_URL=""
# Set to 1 when serve commands must go through sudo because granting the user
# tailscale "operator" rights failed (ensure_tailscale_operator).
TS_NEED_ROOT="0"
# Tailscale decisions taken in the question phase (tailscale_prepare) and
# applied after the build (tailscale_apply). TS_READY=1 means preflight passed
# (installed, logged in, HTTPS certs on) and a serve shape was chosen.
# TS_SERVE_MODE: keep (our mapping already exists), root (https://<node>),
# path (https://<node>/codeman, when :443 already belongs to another app),
# port (https://<node>:<TS_SERVE_PORT>), replace (take :443 over).
TS_READY="0"
TS_SERVE_MODE=""
TS_SERVE_PATH="/codeman"
TS_SERVE_PORT="8443"
# --name / CODEMAN_TAILSCALE_NAME, and --no-rename.
TS_NAME="${CODEMAN_TAILSCALE_NAME:-}"
TS_NO_RENAME="0"
# Set to 1 when a rename took our serve mapping down (it is keyed by the old
# name), so the caller knows to re-add it and never adds one that was not there.
TS_MAPPING_REMOVED_BY_RENAME="0"
# Set by the INT trap that is armed only while ensure_tailnet_https polls.
TS_HTTPS_POLL_INTERRUPTED="0"
# Where a rename is recorded so uninstall can offer to undo it (tailscaled does
# not remember previous names).
TS_RENAME_RECORD="$HOME/.codeman/tailscale-rename"

# Sub-path Codeman is mounted under ('' for the root). Set by
# tailscale_choose_mapping (path mode) or read back from the service file.
BIND_BASE_URL=""
EXISTING_BASE_URL=""
EXISTING_VERSION=""

# Answer presets from flags. LAUNCH_PRESET: 1 = run now, 2 = service, 3 = do
# not start. ASSUME_YES=1 (--yes) takes every prompt's default but keeps the
# terminal (a Tailscale login URL still waits for a human), unlike
# CODEMAN_NONINTERACTIVE, which is the CI contract and never installs Tailscale.
LAUNCH_PRESET=""
ASSUME_YES="0"
# Set by parse_flags when a flag asks to change how an existing install is
# reached or run, so a bare re-run takes the full flow instead of a quiet update.
RECONFIGURE="0"
SUBCOMMAND=""
SUBCOMMAND_ARG=""
# Answers to question 3 (choose_launch_mode): LAUNCH_CHOICE 1/2/3 as above,
# SERVICE_TYPE systemd | launchd | launchd-daemon (a foreign daemon we left
# alone) | empty (no service manager here).
LAUNCH_CHOICE="3"
SERVICE_TYPE=""

# Everything the unattended steps print goes here; the terminal gets one line
# per step and the tail of this file on failure.
LOG_FILE="$HOME/.codeman/install.log"
SUDO_KEEPALIVE_PID=""
SPINNER_PID=""
# Set once the work phase (clone/build) has begun; gates the cleanup trap's
# "partial installation may remain" advice. CURRENT_STEP names whatever the
# installer was doing when a `set -e` failure ends it (a vendor installer that
# times out otherwise leaves only its own last line on screen).
INSTALL_STARTED="0"
CURRENT_STEP=""

# What preflight_detect found: the missing system packages as prose, and the
# Tailscale state (absent | installed | connected | serving).
MISSING_PKGS=""
TS_STATE="absent"

# puppeteer is a devDependency used only by scripts/browser-comparison.mjs — its
# ~150MB chrome-headless-shell download is never needed to build or run Codeman.
# Skipping it avoids a slow download and a fatal install failure when a prior
# download left a corrupt cache (folder present, executable missing). Respect an
# explicit caller override so contributors can still fetch the browser if needed.
export PUPPETEER_SKIP_DOWNLOAD="${PUPPETEER_SKIP_DOWNLOAD:-1}"


# >>> BEGIN GENERATED CLI CATALOGUE
# Generated from src/config/cli-registry/stock.ts by scripts/generate-cli-catalog.mts.
# Do not edit by hand: run `npm run generate:cli-catalog` and commit the result.
#
# Parallel indexed arrays, bash 3.2 safe (no associative arrays, no nameref, no mapfile).
# The variable-length lists use OFFSET/LENGTH windows into one flat array rather than a
# delimiter, so a $HOME containing a space needs no IFS handling and an entry with nothing
# to contribute (shell has no binaries) gets length 0 and is simply never iterated.
#
# ⚠️ TRUST BOUNDARY: CLI_CMD_LINUX/CLI_CMD_DARWIN are the ONLY source of a command this
# script will ever execute, and they arrive embedded in this file — same TLS fetch, same
# commit as the script itself. Nothing fetched at install time is ever executed; there is
# no network refresh of these arrays. See cli_catalog_select_platform below.
CLI_IDS=('claude' 'shell' 'opencode' 'codex' 'gemini' 'antigravity' 'pi' 'grok' 'deepseek' 'omp')
CLI_LABELS=('Claude' 'Shell' 'OpenCode' 'Codex' 'Gemini' 'Antigravity' 'Pi' 'Grok' 'DeepSeek' 'OMP')
CLI_ENABLED=(1 1 1 1 1 1 1 1 1 1)
CLI_LAUNCHER_ONLY=(0 0 0 0 0 0 0 0 1 0)
CLI_DOCS=('https://docs.claude.com/claude-code' '' 'https://opencode.ai/docs' 'https://developers.openai.com/codex/cli' 'https://github.com/google-gemini/gemini-cli' 'https://antigravity.google/cli' 'https://pi.dev' 'https://github.com/xai-org/grok-build' 'https://github.com/deepseek-ai/deepseek-harness' 'https://omp.sh')
CLI_CMD_LINUX=('curl -fsSL https://claude.ai/install.sh | bash' '' 'curl -fsSL https://opencode.ai/install | bash' 'npm install -g @openai/codex' 'npm install -g @google/gemini-cli' 'curl -fsSL https://antigravity.google/cli/install.sh | bash' 'npm install -g --ignore-scripts @earendil-works/pi-coding-agent' 'curl -fsSL https://x.ai/cli/install.sh | bash' '' 'curl -fsSL https://omp.sh/install | sh')
CLI_CMD_DARWIN=('curl -fsSL https://claude.ai/install.sh | bash' '' 'curl -fsSL https://opencode.ai/install | bash' 'npm install -g @openai/codex' 'npm install -g @google/gemini-cli' 'curl -fsSL https://antigravity.google/cli/install.sh | bash' 'npm install -g --ignore-scripts @earendil-works/pi-coding-agent' 'curl -fsSL https://x.ai/cli/install.sh | bash' '' 'brew install can1357/tap/omp')
CLI_ALL_BINS=('claude' 'opencode' 'codex' 'gemini' 'agy' 'pi' 'grok' 'dsh' 'omp')
CLI_BIN_OFF=(0 1 1 2 3 4 5 6 7 8)
CLI_BIN_LEN=(1 0 1 1 1 1 1 1 1 1)
CLI_ALL_PATHS=("$HOME/.local/bin/claude" "$HOME/.claude/local/claude" "/usr/local/bin/claude" "$HOME/.npm-global/bin/claude" "$HOME/bin/claude" "$HOME/.opencode/bin/opencode" "$HOME/.local/bin/opencode" "/usr/local/bin/opencode" "$HOME/go/bin/opencode" "$HOME/.bun/bin/opencode" "$HOME/.npm-global/bin/opencode" "$HOME/bin/opencode" "$HOME/.codex/bin/codex" "$HOME/.local/bin/codex" "/usr/local/bin/codex" "$HOME/.bun/bin/codex" "$HOME/.npm-global/bin/codex" "$HOME/bin/codex" "$HOME/.gemini/bin/gemini" "$HOME/.local/bin/gemini" "/usr/local/bin/gemini" "$HOME/.bun/bin/gemini" "$HOME/.npm-global/bin/gemini" "$HOME/bin/gemini" "$HOME/.local/bin/agy" "$HOME/.antigravity/bin/agy" "/usr/local/bin/agy" "$HOME/bin/agy" "$HOME/.local/bin/pi" "/usr/local/bin/pi" "$HOME/.bun/bin/pi" "$HOME/.npm-global/bin/pi" "$HOME/bin/pi" "$HOME/.grok/bin/grok" "$HOME/.local/bin/grok" "/usr/local/bin/grok" "$HOME/bin/grok" "$HOME/.local/bin/dsh" "/usr/local/bin/dsh" "$HOME/.npm-global/bin/dsh" "$HOME/bin/dsh" "$HOME/.local/bin/omp" "$HOME/.omp/bin/omp" "/usr/local/bin/omp" "$HOME/.bun/bin/omp" "$HOME/.npm-global/bin/omp" "$HOME/bin/omp")
CLI_PATH_OFF=(0 5 5 12 18 24 28 33 37 41)
CLI_PATH_LEN=(5 0 7 6 6 4 5 4 4 6)
# <<< END GENERATED CLI CATALOGUE

# ============================================================================
# Color Output
# ============================================================================

setup_colors() {
    # Check if terminal supports colors
    if [[ -t 1 ]] && [[ -n "${TERM:-}" ]] && command -v tput &>/dev/null; then
        local ncolors
        ncolors=$(tput colors 2>/dev/null || echo 0)
        if [[ "$ncolors" -ge 8 ]]; then
            RED='\033[0;31m'
            GREEN='\033[0;32m'
            YELLOW='\033[1;33m'
            BLUE='\033[0;34m'
            CYAN='\033[0;36m'
            MAGENTA='\033[0;35m'
            BOLD='\033[1m'
            DIM='\033[2m'
            NC='\033[0m'
            return
        fi
    fi
    # No color support
    RED='' GREEN='' YELLOW='' BLUE='' CYAN='' MAGENTA='' BOLD='' DIM='' NC=''
}

setup_colors

# ============================================================================
# Output Helpers
# ============================================================================

info() {
    echo -e "${BLUE}==>${NC} ${BOLD}$1${NC}"
}

success() {
    echo -e "${GREEN}==>${NC} ${BOLD}$1${NC}"
}

warn() {
    echo -e "${YELLOW}Warning:${NC} $1" >&2
}

error() {
    echo -e "${RED}Error:${NC} $1" >&2
}

die() {
    error "$1"
    exit 1
}

# Security notice — printed at the very end of install/update so it is the last
# thing the user sees. Adapts to the binding chosen during install; the update
# path (BIND_HOST empty) gets the generic text.
print_security_notice() {
    echo ""
    if [[ "$BIND_HOST" == "0.0.0.0" && -z "$BIND_PASSWORD" ]]; then
        echo -e "  ${RED}${BOLD}============================================================${NC}"
        echo -e "  ${RED}${BOLD}  WARNING: NETWORK ACCESS WITHOUT A PASSWORD${NC}"
        echo -e "  ${RED}${BOLD}============================================================${NC}"
        echo -e "  ${RED}The dashboard is reachable by EVERY device on your network,${NC}"
        echo -e "  ${RED}and whoever opens it can run commands as ${BOLD}$USER${NC}${RED} through${NC}"
        echo -e "  ${RED}your AI agents. Anyone on your Wi-Fi owns this machine.${NC}"
        echo ""
        echo -e "  Fix it by setting a password (takes 30 seconds):"
        echo -e "    ${CYAN}•${NC} re-run the installer and choose a password, or"
        echo -e "    ${CYAN}•${NC} add ${CYAN}Environment=CODEMAN_PASSWORD=<yours>${NC} to the service"
        echo -e "  Or switch back to local-only: ${CYAN}CODEMAN_HOST=127.0.0.1${NC}"
        echo -e "  ${DIM}Details: docs/security-architecture.md${NC}"
    elif [[ "$BIND_HOST" == "0.0.0.0" ]]; then
        echo -e "  ${YELLOW}${BOLD}Security:${NC}"
        echo -e "    The dashboard is reachable from your network at port ${CODEMAN_PORT:-3000} and is"
        echo -e "    password-protected (user ${BOLD}admin${NC}). Keep that password strong:"
        echo -e "    whoever logs in can run commands through your agents."
        echo -e "    For access from OUTSIDE your network, prefer Tailscale or a tunnel."
        echo -e "    ${DIM}Details: docs/security-architecture.md${NC}"
    else
        # Loopback bind: when a tailscale serve mapping fronts it, lead with
        # the actual URL instead of the generic "do ONE of" list. Detection is
        # dynamic (tailscaled state is the single source of truth).
        local notice_ts_url="$TAILSCALE_SERVE_URL"
        if [[ -z "$notice_ts_url" ]]; then
            notice_ts_url=$(detect_tailscale_serve_url 2>/dev/null) || notice_ts_url=""
        fi
        if [[ -n "$notice_ts_url" ]]; then
            echo -e "  ${YELLOW}${BOLD}Security:${NC}"
            echo -e "    Codeman binds ${BOLD}127.0.0.1${NC}, fronted by Tailscale serve:"
            echo -e "    reachable at ${BOLD}$notice_ts_url${NC} (HTTPS, your tailnet only)."
            echo -e "    Tailscale authenticates every device before traffic reaches Codeman."
            echo -e "    ${DIM}Details: docs/security-architecture.md${NC}"
        else
            echo -e "  ${YELLOW}${BOLD}Security:${NC}"
            echo -e "    Codeman binds ${BOLD}127.0.0.1${NC} (this machine only) — no password needed by default."
            echo -e "    To reach it from another device, do ONE of:"
            if check_tailscale; then
                echo -e "      ${CYAN}•${NC} ${CYAN}bash $INSTALL_DIR/install.sh tailscale${NC}   ${DIM}(Tailscale is installed here; HTTPS, recommended)${NC}, or"
            else
                echo -e "      ${CYAN}•${NC} tailscale serve / cloudflared tunnel   ${DIM}(recommended)${NC}, or"
            fi
            echo -e "      ${CYAN}•${NC} ${CYAN}codeman web --host 0.0.0.0${NC}  AND set ${CYAN}CODEMAN_PASSWORD${NC}"
            echo -e "    A non-loopback bind without a password still starts, but warns loudly."
            echo -e "    ${DIM}Details: docs/security-architecture.md${NC}"
        fi
    fi
    echo ""
}

# ============================================================================
# Cleanup on Failure
# ============================================================================

# End the spinner and the sudo keepalive. Called from the EXIT trap, and by
# hand right before `exec` in main(): exec replaces this shell WITHOUT running
# the trap, and the keepalive keys on $$, which is then the server's pid, so
# it would refresh the sudo timestamp for the whole life of the server.
stop_background_helpers() {
    if [[ -n "$SPINNER_PID" ]]; then
        kill "$SPINNER_PID" 2>/dev/null || true
        SPINNER_PID=""
        printf '\r\033[K' >&2
    fi
    if [[ -n "$SUDO_KEEPALIVE_PID" ]]; then
        kill "$SUDO_KEEPALIVE_PID" 2>/dev/null || true
        SUDO_KEEPALIVE_PID=""
    fi
    return 0
}

cleanup() {
    local exit_code=$?
    stop_background_helpers
    # The "partial install" advice is only true once the work phase has begun:
    # a bad flag or a refused question exits before anything was written.
    if [[ $exit_code -ne 0 && -n "$CURRENT_STEP" ]]; then
        error "Failed while: $CURRENT_STEP (see the output above). Fix the cause and re-run this installer."
    fi
    if [[ $exit_code -ne 0 && "$INSTALL_STARTED" == "1" ]]; then
        error "Installation failed. Partial installation may remain at $INSTALL_DIR"
        error "To retry, run the installer again or remove the directory manually."
        if [[ -s "$LOG_FILE" ]]; then
            error "Step output was saved to $LOG_FILE"
        fi
    fi
    # A rename takes our serve mapping down in the question phase and the
    # after-the-build half puts it back; a failure in between leaves nothing
    # fronting Codeman, and `install.sh tailscale` is what restores it.
    if [[ $exit_code -ne 0 && "$TS_MAPPING_REMOVED_BY_RENAME" == "1" && -z "$TAILSCALE_SERVE_URL" ]]; then
        error "The Tailscale serve mapping was taken down for the rename and not re-added. Restore it with: bash $INSTALL_DIR/install.sh tailscale"
    fi
}

trap cleanup EXIT

# ============================================================================
# System Detection
# ============================================================================

detect_os() {
    local os
    os="$(uname -s)"
    case "$os" in
        Darwin) echo "macos" ;;
        Linux)  echo "linux" ;;
        MINGW*|MSYS*|CYGWIN*)
            die "Windows is not supported directly. Please use WSL (Windows Subsystem for Linux)."
            ;;
        *)      die "Unsupported operating system: $os" ;;
    esac
}

detect_arch() {
    local arch
    arch="$(uname -m)"
    case "$arch" in
        x86_64|amd64)   echo "x64" ;;
        aarch64|arm64)  echo "arm64" ;;
        armv7l)         echo "armv7" ;;
        *)              die "Unsupported architecture: $arch" ;;
    esac
}

detect_linux_distro() {
    if [[ ! -f /etc/os-release ]]; then
        # Fallback detection for older systems
        if [[ -f /etc/debian_version ]]; then
            echo "debian"
        elif [[ -f /etc/redhat-release ]]; then
            echo "fedora"
        elif [[ -f /etc/arch-release ]]; then
            echo "arch"
        elif [[ -f /etc/alpine-release ]]; then
            echo "alpine"
        else
            echo "unknown"
        fi
        return
    fi

    # Source os-release to get ID
    # shellcheck source=/dev/null
    source /etc/os-release

    case "${ID:-}" in
        debian|ubuntu|linuxmint|pop|elementary|zorin|kali|raspbian)
            echo "debian"
            ;;
        fedora|rhel|centos|rocky|alma|ol|amzn)
            echo "fedora"
            ;;
        arch|manjaro|endeavouros|garuda|artix)
            echo "arch"
            ;;
        opensuse*|sles|suse)
            echo "suse"
            ;;
        alpine)
            echo "alpine"
            ;;
        *)
            # Try ID_LIKE as fallback
            case "${ID_LIKE:-}" in
                *debian*|*ubuntu*) echo "debian" ;;
                *fedora*|*rhel*)   echo "fedora" ;;
                *arch*)            echo "arch" ;;
                *suse*)            echo "suse" ;;
                *)                 echo "unknown" ;;
            esac
            ;;
    esac
}

# ============================================================================
# Prerequisite Checks
# ============================================================================

check_curl_or_wget() {
    if command -v curl &>/dev/null; then
        DOWNLOADER="curl"
        return 0
    elif command -v wget &>/dev/null; then
        DOWNLOADER="wget"
        return 0
    fi
    return 1
}

download() {
    local url="$1"
    local output="$2"

    if [[ "$DOWNLOADER" == "curl" ]]; then
        curl -fsSL "$url" -o "$output"
    else
        wget -q "$url" -O "$output"
    fi
}

download_to_stdout() {
    local url="$1"

    if [[ "$DOWNLOADER" == "curl" ]]; then
        curl -fsSL "$url"
    else
        wget -qO- "$url"
    fi
}

# ============================================================================
# Dependency Checks
# ============================================================================

check_node() {
    if ! command -v node &>/dev/null; then
        return 1
    fi

    local version
    version=$(node --version 2>/dev/null | sed 's/^v//' | cut -d. -f1)
    if [[ -z "$version" ]] || [[ "$version" -lt "$MIN_NODE_VERSION" ]]; then
        return 1
    fi

    return 0
}

check_npm() {
    command -v npm &>/dev/null
}

check_git() {
    command -v git &>/dev/null
}

check_tmux() {
    command -v tmux &>/dev/null
}

# node-pty ships prebuilt binaries for darwin and win32 ONLY, so on Linux it is
# always compiled from source during `npm install`. Without a toolchain that
# fails deep inside node-gyp with `not found: make`, which reads like an npm bug
# rather than a missing system package (issue: fresh Ubuntu 24 server install).
# So the toolchain is checked up front, exactly like git and tmux.
#
# Returns a human-readable list of what is missing, empty when all present.
missing_build_tools() {
    local missing=""
    command -v make &>/dev/null || missing="make"
    if ! command -v c++ &>/dev/null && ! command -v g++ &>/dev/null && ! command -v clang++ &>/dev/null; then
        missing="${missing:+$missing, }g++"
    fi
    command -v python3 &>/dev/null || missing="${missing:+$missing, }python3"
    printf '%s' "$missing"
}

check_build_tools() {
    [[ -z "$(missing_build_tools)" ]]
}

# ============================================================================
# CLI Detection (generic, driven by the generated catalogue above)
# ============================================================================
#
# One implementation for every CLI, replacing nine near-identical
# check_<cli>/get_<cli>_path pairs plus their nine search-path arrays. Those had
# to be extended by hand for each new CLI, and once were not: upstream b6d0f1fa
# is "wire OMP into install.sh's CLI detection (it had none)", where a user with
# only omp installed was told no AI CLI was found and offered Claude Code.
# Adding an entry to stock.ts now wires detection, the install menu and the
# closing reminder in one step.
#
# Probe order per CLI is UNCHANGED and pinned by
# test/install-sh-detection-parity.test.ts: the process PATH first (each declared
# binary name in turn), then each known install path, dir-major.

# `dsh` is the hardest name of the lot: Debian ships an unrelated `dsh`
# (dancer's shell). The server-side resolver settles it by demanding the
# harness's own help banner; detection here only feeds the "you have no AI CLI"
# hint, so the same banner grep is enough — but unlike every sibling probe it
# EXECUTES the candidate, so it must be bounded. </dev/null is load-bearing
# twice over: a foreign binary that blocks on stdin would hang the install, and
# under `curl | bash` a child that reads stdin EATS THE REST OF THIS SCRIPT.
# The timeout (where coreutils ships one; stock macOS has none) bounds a binary
# that ignores EOF, mirroring the server resolver's own EXEC_TIMEOUT_MS.
dsh_banner_probe() {
    local runner=()
    if command -v timeout &>/dev/null; then runner=(timeout 5); fi
    # ⚠️ bash 3.2 (stock macOS): expanding an EMPTY array under `set -u` is an unbound-variable
    # error, not a no-op — `${runner[@]}` alone abort­ed this whole probe with "runner[@]:
    # unbound variable" whenever `timeout` was absent (i.e. exactly the host this comment is
    # about). `${runner[@]+"${runner[@]}"}` expands to nothing when the array is empty and to
    # the quoted elements otherwise, which is safe under `set -u` in both bash 3.2 and 4+.
    ${runner[@]+"${runner[@]}"} "$1" --help </dev/null 2>/dev/null | grep -qi "DeepSeek Harness"
}

# Is "$2" really the CLI "$1" claims to be?
#
# Every CLI but DeepSeek is accepted on being executable, exactly as before.
# DeepSeek stays a hand-written special case ON PURPOSE: the registry expresses
# its identity check as `discovery.identity.regex`, a JavaScript regex, and
# translating that into a `grep` pattern at install time is a transformation
# nobody should be performing on a security-adjacent check. Instead
# test/install-sh-invariants.test.ts pins the grep below against the registry's
# `discovery.identity.regex`, so the two cannot drift apart: an upstream banner
# change fails a test instead of silently mis-detecting here.
_cli_candidate_ok() {
    case "$1" in
        deepseek) dsh_banner_probe "$2" ;;
        *) return 0 ;;
    esac
}

# Resolve every CLI in ONE pass, memoized.
#
# CLI_FOUND_PATH is parallel to CLI_IDS ('' when not found, and also '' for a
# DISABLED entry — it is never probed at all, see below). CLI_FOUND_COUNT
# counts only ENABLED entries that have a binary to look for, which is what the
# "no AI CLI found" gate asks about — `shell` has no binary and must never make
# that gate think an agent is installed.
#
# Memoizing the whole scan generalises the old resolve_dsh memo: the three call
# sites together used to re-run every probe, and for dsh that meant executing a
# possibly-foreign binary repeatedly.
CLI_DETECT_DONE=""
CLI_FOUND_PATH=()
CLI_FOUND_COUNT=0
detect_all_clis() {
    [[ -n "$CLI_DETECT_DONE" ]] && return 0
    CLI_DETECT_DONE=1

    local i j found bin path bin_end path_end
    CLI_FOUND_COUNT=0
    for ((i = 0; i < ${#CLI_IDS[@]}; i++)); do
        found=""

        # A disabled entry is never even probed: every consumer already filters
        # on CLI_ENABLED before showing anything, so the command-v/stat calls
        # below would be pure waste — and, unlike filtering downstream, skipping
        # the probe here is what makes CLI_ENABLED mean "look for it" rather
        # than just "offer it once found".
        if [[ "${CLI_ENABLED[$i]}" != "1" ]]; then
            CLI_FOUND_PATH[$i]=""
            continue
        fi

        # 1. The process PATH, each declared binary name in turn.
        bin_end=$((${CLI_BIN_OFF[$i]} + ${CLI_BIN_LEN[$i]}))
        for ((j = ${CLI_BIN_OFF[$i]}; j < bin_end; j++)); do
            bin="${CLI_ALL_BINS[$j]}"
            if command -v "$bin" &>/dev/null; then
                path="$(command -v "$bin")"
                if _cli_candidate_ok "${CLI_IDS[$i]}" "$path"; then
                    found="$path"
                    break
                fi
            fi
        done

        # 2. The known install locations, dir-major. Note this still runs when a
        #    PATH hit was REJECTED above — that is how a Debian `dsh` on PATH
        #    does not hide a real harness in ~/.local/bin.
        if [[ -z "$found" ]]; then
            path_end=$((${CLI_PATH_OFF[$i]} + ${CLI_PATH_LEN[$i]}))
            for ((j = ${CLI_PATH_OFF[$i]}; j < path_end; j++)); do
                path="${CLI_ALL_PATHS[$j]}"
                if [[ -x "$path" ]] && _cli_candidate_ok "${CLI_IDS[$i]}" "$path"; then
                    found="$path"
                    break
                fi
            done
        fi

        CLI_FOUND_PATH[$i]="$found"
        if [[ -n "$found" ]] && [[ "${CLI_ENABLED[$i]}" == "1" ]] && [[ "${CLI_BIN_LEN[$i]}" -gt 0 ]]; then
            CLI_FOUND_COUNT=$((CLI_FOUND_COUNT + 1))
        fi
    done
    return 0
}

# ----------------------------------------------------------------------------
# Catalogue helpers
# ----------------------------------------------------------------------------

# Pick this platform's install commands out of the generated per-platform arrays.
#
# ⚠️ THE TRUST BOUNDARY LIVES HERE, and it is mechanical rather than a promise:
# CLI_INSTALL_CMD_TRUSTED is written ONLY from CLI_CMD_LINUX/CLI_CMD_DARWIN, i.e.
# only from the block generated into this file, and it is the sole array the
# installer ever executes or displays — there is no second copy a network
# refresh could rewrite. A command that runs therefore arrived in the same
# file, over the same TLS fetch, in the same commit as the `curl | bash` line
# that fetched this script. That is identical trust to the hardcoded vendor
# one-liners this replaces, and it is why nothing fetched at install time is
# ever executed. The server keeps its own, stricter rule unchanged: it never
# executes an entry's install command at all (see CliDiscovery.install.command
# in src/config/cli-registry/types.ts).
CLI_INSTALL_CMD_TRUSTED=()
CLI_PLATFORM_DONE=""
cli_catalog_select_platform() {
    [[ -n "$CLI_PLATFORM_DONE" ]] && return 0
    CLI_PLATFORM_DONE=1
    # detect_os ONCE, not per entry: it forks a subshell, and on an unsupported
    # platform it also prints. Inside the loop that was ten forks and ten copies of
    # the same error, because a `die` inside $( ) can only exit the subshell.
    local i platform
    platform="$(detect_os)"
    for ((i = 0; i < ${#CLI_IDS[@]}; i++)); do
        if [[ "$platform" == "macos" ]]; then
            CLI_INSTALL_CMD_TRUSTED[$i]="${CLI_CMD_DARWIN[$i]}"
        else
            CLI_INSTALL_CMD_TRUSTED[$i]="${CLI_CMD_LINUX[$i]}"
        fi
    done
}

# "Claude, OpenCode, Codex, ..." — the enabled, detectable CLIs, for prose.
cli_catalog_names() {
    local i out=""
    for ((i = 0; i < ${#CLI_IDS[@]}; i++)); do
        [[ "${CLI_ENABLED[$i]}" == "1" ]] || continue
        [[ "${CLI_BIN_LEN[$i]}" -gt 0 ]] || continue
        out="${out:+$out, }${CLI_LABELS[$i]}"
    done
    printf '%s' "$out"
}

# The "install one yourself" hints: every enabled CLI that is not installed,
# showing the trusted install command. An entry with no install command gets
# its docs URL instead of being silently omitted, which is what used to
# happen to Gemini — it had a command in the registry and appeared in no list
# in this script. DeepSeek is the one entry that deliberately HAS a command in
# the registry but an empty one here: installing the launcher alone leaves
# nothing that can drive a pane, so the generator withholds the command for
# any launcherProfile entry (see installCommandFor in generate-cli-catalog.mts)
# and this hint falls through to the docs URL instead — CLI_LAUNCHER_ONLY adds
# one line explaining WHY it is a docs link and not a command, so a user who
# follows that link straight to `npm install -g @deepseek-ai/dsh` (which the
# docs page itself documents) does not land back in the same "installed but
# cannot drive a pane" trap the menu exists to avoid. Data-driven, not an id
# check: any future launcherProfile entry gets the same caveat for free.
cli_catalog_print_install_hints() {
    detect_all_clis
    local i
    for ((i = 0; i < ${#CLI_IDS[@]}; i++)); do
        [[ "${CLI_ENABLED[$i]}" == "1" ]] || continue
        [[ "${CLI_BIN_LEN[$i]}" -gt 0 ]] || continue
        [[ -z "${CLI_FOUND_PATH[$i]}" ]] || continue
        if [[ -n "${CLI_INSTALL_CMD_TRUSTED[$i]}" ]]; then
            echo -e "    ${CYAN}${CLI_INSTALL_CMD_TRUSTED[$i]}${NC}   # ${CLI_LABELS[$i]}"
        elif [[ -n "${CLI_DOCS[$i]}" ]]; then
            echo -e "    ${CLI_LABELS[$i]}: see ${CYAN}${CLI_DOCS[$i]}${NC}"
            if [[ "${CLI_LAUNCHER_ONLY[$i]}" == "1" ]]; then
                echo -e "      (installs a launcher only: it still needs a terminal profile, and Codeman's Run menu can add one)"
            fi
        fi
    done
}

# Resolved at load, not lazily: every element of CLI_INSTALL_CMD_TRUSTED has to
# exist before anything indexes it, or `set -u` aborts on an unset array element
# the first time a hint is printed.
cli_catalog_select_platform

# Offer to install one AI CLI from the catalogue, or let the user skip.
#
# Split out of main() so the bash 3.2 CI step and test/install-sh-invariants.test.ts
# can drive the menu with a stubbed read_reply: the interactive path is the one
# part of this script no static check reaches, and it is where choosing "s" (Skip)
# once fell into the "failed to install" gate and aborted the whole installer.
# That gate therefore lives INSIDE the install branch: skipping is a documented
# choice that continues to the clone and build (sessions just need a CLI later),
# while a chosen install that leaves nothing behind is still fatal.
offer_ai_cli_install() {
    local i
    echo ""
    warn "No AI CLI found. Codeman needs at least one: $(cli_catalog_names)."
    headless_guard "install an AI CLI (curl | bash from its vendor)"
    echo ""

    # The menu is built from the catalogue: every enabled CLI that is not
    # installed and ships an install command we can run. It used to be a
    # fixed four-option prompt offering Claude Code and OpenCode only, so the
    # other seven were unreachable even though the registry knows how to
    # install five of them.
    #
    # ⚠️ TRUST BOUNDARY: the command executed comes from CLI_INSTALL_CMD_TRUSTED,
    # the only array the generated block above writes and the only one the
    # installer ever runs or displays — see cli_catalog_select_platform.
    #
    # ⚠️ The registry's install commands are a MIX: some call `curl` directly
    # (vendor one-liners), others are `npm install -g …`, which never needed
    # curl at all. A wget-only host used to lose the WHOLE menu over this,
    # including every npm entry — the two literals this replaced went through
    # download_to_stdout and so honoured `wget`, and CODEMAN_NONINTERACTIVE=1
    # silently stopped defaulting to Claude Code as documented. Filter per
    # entry instead: only a command that actually starts with `curl ` is
    # curl-dependent, so only THOSE are held back on a wget-only host.
    # Rewriting curl to wget inside a string about to be executed is the
    # wrong instinct either way — the ones we can't run, we show as a hint.
    local -a offer_idx=()
    local curl_only_skipped=0
    for ((i = 0; i < ${#CLI_IDS[@]}; i++)); do
        [[ "${CLI_ENABLED[$i]}" == "1" ]] || continue
        [[ "${CLI_BIN_LEN[$i]}" -gt 0 ]] || continue
        [[ -z "${CLI_FOUND_PATH[$i]}" ]] || continue
        [[ -n "${CLI_INSTALL_CMD_TRUSTED[$i]}" ]] || continue
        if [[ "${DOWNLOADER:-}" != "curl" ]] && [[ "${CLI_INSTALL_CMD_TRUSTED[$i]}" == curl\ * ]]; then
            curl_only_skipped=$((curl_only_skipped + 1))
            continue
        fi
        offer_idx[${#offer_idx[@]}]=$i
    done

    if [[ "$curl_only_skipped" -gt 0 ]]; then
        warn "curl is not available, so $curl_only_skipped install command(s) that need it were left out of the menu below (still shown as hints if you skip)."
    fi

    if [[ ${#offer_idx[@]} -eq 0 ]]; then
        warn "No AI CLI can be installed automatically here. Codeman will run, but sessions need a CLI to drive."
        cli_catalog_print_install_hints
    else
        echo -e "  ${BOLD}Which AI CLI would you like to install?${NC}"
        local n=0 idx
        for idx in "${offer_idx[@]}"; do
            n=$((n + 1))
            echo -e "    ${CYAN}${n})${NC} ${CLI_LABELS[$idx]}"
        done
        echo -e "    ${CYAN}s)${NC} Skip (I'll install one myself)"
        echo ""

        local cli_choice=""
        if [[ "$NONINTERACTIVE" == "1" ]] || ! has_tty; then
            # Explicit automation opt-in: default to the first OFFERED entry.
            # That is registry order, which is Claude Code (order 0), UNLESS
            # this is a wget-only host and Claude's curl one-liner was just
            # filtered out of offer_idx above — there, the first survivor is
            # whichever npm-based entry sorts earliest (Codex today), not
            # Claude. Printed either way so the choice is never silent.
            cli_choice="1"
            info "CODEMAN_NONINTERACTIVE=1: defaulting to ${CLI_LABELS[${offer_idx[0]}]}"
        else
            while true; do
                echo -en "${CYAN}Choose [1-${n}, or s to skip]:${NC} " >&2
                read_reply cli_choice || { cli_choice="1"; break; }
                case "$cli_choice" in
                    s|S) break ;;
                    ''|*[!0-9]*) echo "Please enter a number between 1 and ${n}, or s." >&2 ;;
                    *)
                        if [[ "$cli_choice" -ge 1 ]] && [[ "$cli_choice" -le "$n" ]]; then
                            break
                        fi
                        echo "Please enter a number between 1 and ${n}, or s." >&2
                        ;;
                esac
            done
        fi

        if [[ "$cli_choice" == "s" ]] || [[ "$cli_choice" == "S" ]]; then
            warn "Skipping AI CLI install. Codeman will run, but sessions need a CLI to drive."
            cli_catalog_print_install_hints
        else
            idx="${offer_idx[$((cli_choice - 1))]}"
            info "Installing ${CLI_LABELS[$idx]}..."
            # </dev/null: under `curl | bash` a child that reads stdin would
            # consume the rest of this script.
            bash -c "${CLI_INSTALL_CMD_TRUSTED[$idx]}" </dev/null || true
            hash -r 2>/dev/null || true
            CLI_DETECT_DONE=""
            detect_all_clis
            if [[ -n "${CLI_FOUND_PATH[$idx]}" ]]; then
                success "${CLI_LABELS[$idx]} installed at ${CLI_FOUND_PATH[$idx]}"
            else
                warn "${CLI_LABELS[$idx]} installation failed."
            fi
            if [[ "$CLI_FOUND_COUNT" -eq 0 ]]; then
                die "The selected AI CLI failed to install. Install one manually and re-run the installer."
            fi
        fi
    fi
}


check_cloudflared() {
    # Check ~/.local/bin first (matches tunnel-manager.ts resolution order)
    if [[ -x "$HOME/.local/bin/cloudflared" ]]; then
        return 0
    fi
    if [[ -x "/usr/local/bin/cloudflared" ]]; then
        return 0
    fi
    if command -v cloudflared &>/dev/null; then
        return 0
    fi
    return 1
}

get_cloudflared_path() {
    if [[ -x "$HOME/.local/bin/cloudflared" ]]; then
        echo "$HOME/.local/bin/cloudflared"
        return
    fi
    if [[ -x "/usr/local/bin/cloudflared" ]]; then
        echo "/usr/local/bin/cloudflared"
        return
    fi
    command -v cloudflared 2>/dev/null
}

# ============================================================================
# Dependency Installation
# ============================================================================

ensure_sudo() {
    if [[ $EUID -eq 0 ]]; then
        return 0
    fi
    if ! command -v sudo &>/dev/null; then
        die "sudo is required but not installed. Please install packages manually or run as root."
    fi
    # Validate sudo access
    # When piped (curl | bash), stdin is the pipe — redirect from /dev/tty so sudo can prompt
    if [[ -e /dev/tty ]]; then
        if ! sudo -v 2>/dev/null < /dev/tty; then
            die "Failed to obtain sudo privileges."
        fi
    else
        if ! sudo -v 2>/dev/null; then
            die "Failed to obtain sudo privileges. Try running the script directly instead of piping."
        fi
    fi
}

run_as_root() {
    if [[ $EUID -eq 0 ]]; then
        "$@"
    else
        sudo "$@"
    fi
}

ensure_homebrew() {
    if command -v brew &>/dev/null; then
        return 0
    fi

    info "Installing Homebrew first..."
    # When piped (curl | bash), stdin is the pipe — Homebrew needs TTY for sudo password prompt
    if [[ -e /dev/tty ]]; then
        /bin/bash -c "$(download_to_stdout https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)" < /dev/tty
    else
        NONINTERACTIVE=1 /bin/bash -c "$(download_to_stdout https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
    fi

    # Add Homebrew to PATH for Apple Silicon
    if [[ -f /opt/homebrew/bin/brew ]]; then
        eval "$(/opt/homebrew/bin/brew shellenv)"
    elif [[ -f /usr/local/bin/brew ]]; then
        eval "$(/usr/local/bin/brew shellenv)"
    fi
}

install_node_macos() {
    info "Installing Node.js via Homebrew..."
    ensure_homebrew
    brew install node
}

install_node_debian() {
    info "Installing Node.js v$TARGET_NODE_VERSION via NodeSource..."

    ensure_sudo

    # Install prerequisites
    run_as_root apt-get update -qq
    run_as_root apt-get install -y -qq ca-certificates curl gnupg

    # Setup NodeSource repository (new method)
    run_as_root mkdir -p /etc/apt/keyrings

    # Remove old key if exists to avoid conflicts
    run_as_root rm -f /etc/apt/keyrings/nodesource.gpg

    download_to_stdout https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | run_as_root gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg

    echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_$TARGET_NODE_VERSION.x nodistro main" | run_as_root tee /etc/apt/sources.list.d/nodesource.list > /dev/null

    run_as_root apt-get update -qq
    run_as_root apt-get install -y -qq nodejs
}

install_node_fedora() {
    info "Installing Node.js v$TARGET_NODE_VERSION via NodeSource..."

    ensure_sudo

    # Import NodeSource GPG key
    run_as_root rpm --import https://rpm.nodesource.com/gpgkey/nodesource-repo.gpg.key

    # Create repo file (replaces deprecated setup_XX.x bash script)
    cat << REPO_EOF | run_as_root tee /etc/yum.repos.d/nodesource.repo > /dev/null
[nodesource]
name=Node.js Packages for Linux RPM - nodesource
baseurl=https://rpm.nodesource.com/pub_${TARGET_NODE_VERSION}.x/nodistro/rpm/\$basearch
gpgcheck=1
gpgkey=https://rpm.nodesource.com/gpgkey/nodesource-repo.gpg.key
enabled=1
REPO_EOF

    # Use dnf if available (RHEL 8+, Fedora, AL2023), fall back to yum (RHEL 7, AL2)
    if command -v dnf &>/dev/null; then
        run_as_root dnf install -y nodejs
    else
        run_as_root yum install -y nodejs
    fi
}

install_node_arch() {
    info "Installing Node.js via pacman..."

    ensure_sudo
    run_as_root pacman -Sy --noconfirm nodejs npm

    # Verify version is sufficient
    local version
    version=$(node --version 2>/dev/null | sed 's/^v//' | cut -d. -f1)
    if [[ "$version" -lt "$MIN_NODE_VERSION" ]]; then
        warn "Arch package nodejs is v$version, which is older than required v$MIN_NODE_VERSION"
        warn "Consider using nvm or the nodejs-lts-* package instead"
    fi
}

install_node_alpine() {
    info "Installing Node.js via apk..."

    ensure_sudo
    run_as_root apk add --no-cache nodejs npm

    # Verify version
    local version
    version=$(node --version 2>/dev/null | sed 's/^v//' | cut -d. -f1)
    if [[ "$version" -lt "$MIN_NODE_VERSION" ]]; then
        warn "Alpine package nodejs is v$version, which is older than required v$MIN_NODE_VERSION"
        warn "Consider using a newer Alpine version or building from source"
    fi
}

install_node_suse() {
    info "Installing Node.js v$TARGET_NODE_VERSION via NodeSource..."

    ensure_sudo

    # Import NodeSource GPG key
    run_as_root rpm --import https://rpm.nodesource.com/gpgkey/nodesource-repo.gpg.key

    # Create repo file (replaces deprecated setup_XX.x bash script)
    cat << REPO_EOF | run_as_root tee /etc/zypp/repos.d/nodesource.repo > /dev/null
[nodesource]
name=Node.js Packages for Linux RPM - nodesource
baseurl=https://rpm.nodesource.com/pub_${TARGET_NODE_VERSION}.x/nodistro/rpm/\$basearch
gpgcheck=1
gpgkey=https://rpm.nodesource.com/gpgkey/nodesource-repo.gpg.key
enabled=1
REPO_EOF

    run_as_root zypper install -y nodejs
}

install_tmux_macos() {
    info "Installing tmux via Homebrew..."
    ensure_homebrew
    brew install tmux
}

install_tmux_debian() {
    info "Installing tmux via apt..."
    ensure_sudo
    run_as_root apt-get update -qq
    run_as_root apt-get install -y -qq tmux
}

install_tmux_fedora() {
    info "Installing tmux..."
    ensure_sudo
    if command -v dnf &>/dev/null; then
        run_as_root dnf install -y tmux
    else
        run_as_root yum install -y tmux
    fi
}

install_tmux_arch() {
    info "Installing tmux via pacman..."
    ensure_sudo
    run_as_root pacman -Sy --noconfirm tmux
}

install_tmux_alpine() {
    info "Installing tmux via apk..."
    ensure_sudo
    run_as_root apk add --no-cache tmux
}

install_tmux_suse() {
    info "Installing tmux via zypper..."
    ensure_sudo
    run_as_root zypper install -y tmux
}

install_git_macos() {
    info "Installing Git via Homebrew..."
    ensure_homebrew
    brew install git
}

install_git_debian() {
    info "Installing Git via apt..."
    ensure_sudo
    run_as_root apt-get update -qq
    run_as_root apt-get install -y -qq git
}

install_git_fedora() {
    info "Installing Git..."
    ensure_sudo
    if command -v dnf &>/dev/null; then
        run_as_root dnf install -y git
    else
        run_as_root yum install -y git
    fi
}

install_git_arch() {
    info "Installing Git via pacman..."
    ensure_sudo
    run_as_root pacman -Sy --noconfirm git
}

install_git_alpine() {
    info "Installing Git via apk..."
    ensure_sudo
    run_as_root apk add --no-cache git
}

install_git_suse() {
    info "Installing Git via zypper..."
    ensure_sudo
    run_as_root zypper install -y git
}

# Build toolchain for node-pty's source compile (see missing_build_tools).
install_buildtools_debian() {
    info "Installing build tools via apt (build-essential, python3)..."
    ensure_sudo
    run_as_root apt-get update -qq
    run_as_root apt-get install -y -qq build-essential python3
}

install_buildtools_fedora() {
    info "Installing build tools (gcc, gcc-c++, make, python3)..."
    ensure_sudo
    if command -v dnf &>/dev/null; then
        run_as_root dnf install -y gcc gcc-c++ make python3
    else
        run_as_root yum install -y gcc gcc-c++ make python3
    fi
}

install_buildtools_arch() {
    info "Installing build tools via pacman (base-devel, python)..."
    ensure_sudo
    run_as_root pacman -Sy --noconfirm base-devel python
}

install_buildtools_alpine() {
    info "Installing build tools via apk (build-base, python3)..."
    ensure_sudo
    run_as_root apk add --no-cache build-base python3
}

install_buildtools_suse() {
    info "Installing build tools via zypper..."
    ensure_sudo
    run_as_root zypper install -y gcc gcc-c++ make python3
}

install_buildtools_macos() {
    # macOS normally never gets here: node-pty ships darwin prebuilds. Only a
    # forced source build needs a compiler, and Xcode CLT is its only supplier.
    info "Requesting Xcode Command Line Tools..."
    xcode-select --install 2>/dev/null || true
    die "Finish the Xcode Command Line Tools install in the dialog, then re-run this installer."
}

install_cloudflared_macos() {
    info "Installing cloudflared via Homebrew..."
    ensure_homebrew
    brew install cloudflared
}

install_cloudflared_debian() {
    info "Installing cloudflared..."
    ensure_sudo
    local arch
    arch="$(dpkg --print-architecture 2>/dev/null || echo "amd64")"
    local tmp
    tmp="$(mktemp)"
    download "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-$arch.deb" "$tmp"
    run_as_root dpkg -i "$tmp"
    rm -f "$tmp"
}

install_cloudflared_fedora() {
    info "Installing cloudflared..."
    ensure_sudo
    local arch
    arch="$(uname -m)"
    local rpm_arch="$arch"
    [[ "$arch" == "x86_64" ]] && rpm_arch="x86_64"
    [[ "$arch" == "aarch64" ]] && rpm_arch="aarch64"
    local tmp
    tmp="$(mktemp)"
    download "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-$rpm_arch.rpm" "$tmp"
    run_as_root rpm -i "$tmp" || run_as_root rpm -U "$tmp"
    rm -f "$tmp"
}

install_cloudflared_arch() {
    info "Installing cloudflared binary..."
    local arch
    arch="$(uname -m)"
    local cf_arch="amd64"
    [[ "$arch" == "aarch64" ]] && cf_arch="arm64"
    [[ "$arch" == "armv7l" ]] && cf_arch="arm"
    ensure_sudo
    local tmp
    tmp="$(mktemp)"
    download "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-$cf_arch" "$tmp"
    run_as_root mv "$tmp" /usr/local/bin/cloudflared
    run_as_root chmod +x /usr/local/bin/cloudflared
}

install_cloudflared_alpine() {
    info "Installing cloudflared binary..."
    local arch
    arch="$(uname -m)"
    local cf_arch="amd64"
    [[ "$arch" == "aarch64" ]] && cf_arch="arm64"
    [[ "$arch" == "armv7l" ]] && cf_arch="arm"
    ensure_sudo
    local tmp
    tmp="$(mktemp)"
    download "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-$cf_arch" "$tmp"
    run_as_root mv "$tmp" /usr/local/bin/cloudflared
    run_as_root chmod +x /usr/local/bin/cloudflared
}

install_cloudflared_suse() {
    info "Installing cloudflared..."
    ensure_sudo
    local arch
    arch="$(uname -m)"
    local rpm_arch="$arch"
    local tmp
    tmp="$(mktemp)"
    download "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-$rpm_arch.rpm" "$tmp"
    run_as_root rpm -i "$tmp" || run_as_root rpm -U "$tmp"
    rm -f "$tmp"
}

# ============================================================================
# Interactive Prompts
# ============================================================================

# `curl | bash` leaves stdin attached to the pipe, so a plain `read` never sees
# the keyboard even though the user is sitting at a terminal. These helpers
# prompt via /dev/tty whenever a real terminal is available, and only fall back
# to defaults when there is genuinely none (CI, truly headless pipes).
has_tty() {
    [[ -t 0 ]] && return 0
    { : < /dev/tty; } 2>/dev/null
}

read_reply() {
    # read_reply <varname>: read one line from the user's real terminal
    if [[ -t 0 ]]; then
        read -r "$1"
    else
        read -r "$1" < /dev/tty
    fi
}

read_secret() {
    # read_secret <varname>: like read_reply but without echoing (passwords)
    if [[ -t 0 ]]; then
        read -rs "$1"
    else
        read -rs "$1" < /dev/tty
    fi
    echo "" >&2
}

# headless_guard <action>: refuse consequential system changes (sudo package
# installs, third-party curl | bash installers) when nobody can consent, i.e.
# no terminal AND no explicit CODEMAN_NONINTERACTIVE=1 opt-in. Interactive
# runs fall through to their normal prompt; opted-in automation proceeds with
# the prompt defaults as before.
headless_guard() {
    local action="$1"
    if [[ "$NONINTERACTIVE" == "1" ]] || has_tty; then
        return 0
    fi
    error "No interactive terminal, but the installer would need to: $action."
    error "Re-run from a terminal to be prompted, or set CODEMAN_NONINTERACTIVE=1 to approve such steps in automation."
    exit 1
}

prompt_yes_no() {
    local prompt="$1"
    local default="${2:-y}"

    # Non-interactive, or --yes: take the default.
    if [[ "$NONINTERACTIVE" == "1" ]] || [[ "$ASSUME_YES" == "1" ]] || ! has_tty; then
        [[ "$default" == "y" ]]
        return
    fi

    local yn_hint
    if [[ "$default" == "y" ]]; then
        yn_hint="[Y/n]"
    else
        yn_hint="[y/N]"
    fi

    while true; do
        echo -en "${CYAN}$prompt${NC} $yn_hint " >&2
        read_reply answer || answer="$default"
        answer="${answer:-$default}"
        case "$answer" in
            [Yy]|[Yy][Ee][Ss]) return 0 ;;
            [Nn]|[Nn][Oo])     return 1 ;;
            *)                 echo "Please answer yes or no." >&2 ;;
        esac
    done
}

# Some steps need root (system packages, the Tailscale installer, `tailscale
# up`, the operator grant). Ask for the password ONCE, up front, and keep the
# sudo timestamp warm in the background for the rest of the run, instead of a
# password prompt per step scattered around a multi-minute build.
sudo_session_start() {
    [[ $EUID -eq 0 ]] && return 0
    [[ -n "$SUDO_KEEPALIVE_PID" ]] && return 0
    command -v sudo &>/dev/null || return 0
    if ! sudo -n true 2>/dev/null; then
        echo "" >&2
        info "Some steps need administrator rights. You will be asked for your password once."
        if [[ -e /dev/tty ]]; then
            sudo -v < /dev/tty || die "Failed to obtain sudo privileges."
        else
            sudo -v || die "Failed to obtain sudo privileges. Try running the script directly instead of piping."
        fi
    fi
    # Refreshes the timestamp while this script lives; ends on its own once the
    # installer is gone or the credential lapses.
    (
        while kill -0 "$$" 2>/dev/null; do
            sudo -n true 2>/dev/null || exit 0
            sleep 50
        done
    ) &
    SUDO_KEEPALIVE_PID=$!
    return 0
}

# Open a URL in the user's browser when there is one to open it in (macOS, a
# desktop session, WSL). Silent no-op on a headless box: the URL is printed
# anyway.
open_in_browser() {
    local url="$1"
    if [[ "$(uname -s)" == "Darwin" ]]; then
        open "$url" >/dev/null 2>&1 || true
    elif command -v wslview &>/dev/null; then
        wslview "$url" >/dev/null 2>&1 || true
    elif [[ -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ]] && command -v xdg-open &>/dev/null; then
        xdg-open "$url" >/dev/null 2>&1 &
    fi
    return 0
}

fmt_elapsed() {
    local s="$1"
    if [[ "$s" -ge 60 ]]; then
        printf '%dm %02ds' $((s / 60)) $((s % 60))
    else
        printf '%ds' "$s"
    fi
}

# run_step <label> <command...>: one unattended step, its output in LOG_FILE,
# a spinner on a terminal, one line on success (with the elapsed time) and the
# tail of the log on failure. stdin is /dev/null on purpose: under
# `curl | bash` the script IS stdin, and a child that reads it eats the rest.
run_step() {
    local label="$1"; shift
    local start=$SECONDS rc=0
    mkdir -p "$(dirname "$LOG_FILE")" 2>/dev/null || true
    if ! printf '\n==> %s: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$label" >> "$LOG_FILE" 2>/dev/null; then
        LOG_FILE=/dev/null
    fi
    if [[ -t 2 ]] && [[ -n "$NC" ]]; then
        (
            local frames='|/-\' i=0
            while true; do
                printf '\r  %s %s' "${frames:$((i % 4)):1}" "$label" >&2
                i=$((i + 1))
                sleep 0.2
            done
        ) &
        SPINNER_PID=$!
    else
        info "$label..."
    fi
    "$@" >> "$LOG_FILE" 2>&1 < /dev/null || rc=$?
    if [[ -n "$SPINNER_PID" ]]; then
        kill "$SPINNER_PID" 2>/dev/null || true
        wait "$SPINNER_PID" 2>/dev/null || true
        SPINNER_PID=""
        printf '\r\033[K' >&2
    fi
    if [[ "$rc" -eq 0 ]]; then
        success "$label ($(fmt_elapsed $((SECONDS - start))))"
        return 0
    fi
    error "$label failed (exit $rc). Last lines of $LOG_FILE:"
    tail -n 25 "$LOG_FILE" 2>/dev/null | sed 's/^/    /' >&2
    return "$rc"
}

# ============================================================================
# PATH Management
# ============================================================================

detect_shell_profile() {
    local shell_name
    shell_name="$(basename "${SHELL:-/bin/bash}")"

    case "$shell_name" in
        zsh)
            if [[ -f "$HOME/.zshrc" ]]; then
                echo "$HOME/.zshrc"
            else
                echo "$HOME/.zprofile"
            fi
            ;;
        bash)
            # macOS uses .bash_profile, Linux typically uses .bashrc
            if [[ "$(uname -s)" == "Darwin" ]]; then
                if [[ -f "$HOME/.bash_profile" ]]; then
                    echo "$HOME/.bash_profile"
                else
                    echo "$HOME/.profile"
                fi
            else
                if [[ -f "$HOME/.bashrc" ]]; then
                    echo "$HOME/.bashrc"
                elif [[ -f "$HOME/.bash_profile" ]]; then
                    echo "$HOME/.bash_profile"
                else
                    echo "$HOME/.profile"
                fi
            fi
            ;;
        fish)
            echo "$HOME/.config/fish/config.fish"
            ;;
        *)
            echo "$HOME/.profile"
            ;;
    esac
}

add_to_path() {
    local bin_dir="$1"
    local profile
    profile=$(detect_shell_profile)

    # Check if already in PATH
    if [[ ":$PATH:" == *":$bin_dir:"* ]]; then
        info "PATH already includes $bin_dir"
        return 0
    fi

    # Check if already in profile
    if [[ -f "$profile" ]] && grep -qF "$bin_dir" "$profile" 2>/dev/null; then
        info "PATH export already in $profile"
        return 0
    fi

    info "Adding $bin_dir to PATH in $profile"

    # Create profile directory if needed (for fish)
    mkdir -p "$(dirname "$profile")"

    local shell_name
    shell_name="$(basename "${SHELL:-/bin/bash}")"

    if [[ "$shell_name" == "fish" ]]; then
        echo "" >> "$profile"
        echo "# Added by Codeman installer" >> "$profile"
        echo "fish_add_path $bin_dir" >> "$profile"
    else
        echo "" >> "$profile"
        echo "# Added by Codeman installer" >> "$profile"
        echo "export PATH=\"$bin_dir:\$PATH\"" >> "$profile"
    fi

    # Also export for the current process so codeman works immediately
    export PATH="$bin_dir:$PATH"

    success "Added to $profile"
}

# The `sc` bash chooser was retired in favour of `codeman tui`, which reaches
# sessions 10+, carries the server's real states and leaves an attach with one
# key. Older installers wrote this alias, so take it back out.
#
# Marker-owned on purpose: it matches the exact line WE wrote, so a user's own
# `alias sc=` for something entirely different is never touched. The rewrite
# goes through `cat >` rather than `mv` so the profile keeps its own mode and
# ownership.
remove_sc_alias() {
    local profile
    profile=$(detect_shell_profile)
    [[ -f "$profile" ]] || return 0
    grep -qE "^alias sc='tmux-chooser'\$" "$profile" 2>/dev/null || return 0

    local tmp
    tmp=$(mktemp 2>/dev/null) || return 0
    if sed -e "/^alias sc='tmux-chooser'\$/d" \
           -e '/^# Codeman tmux session shortcut$/d' "$profile" > "$tmp" 2>/dev/null; then
        cat "$tmp" > "$profile"
        info "Removed the retired 'sc' alias from $profile (use: codeman tui)"
    fi
    rm -f "$tmp"
}

# ============================================================================
# Network Binding
# ============================================================================

# Best-effort LAN IP for "open this URL from your phone" hints: the address the
# default route leaves from, not the first one `hostname -I` lists (on a box
# with docker0, an LXD bridge or a tailscale interface that first one is often
# not the LAN at all).
detect_lan_ip() {
    local ip=""
    if [[ "$(uname -s)" == "Darwin" ]]; then
        ip=$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || true)
    else
        ip=$(ip -4 route get 1.1.1.1 2>/dev/null | sed -n 's/.* src \([0-9.]*\).*/\1/p' | head -1)
        [[ -n "$ip" ]] || ip=$(hostname -I 2>/dev/null | awk '{print $1}')
    fi
    echo "${ip:-<your-ip>}"
}

# Escape a value for a quoted systemd Environment="KEY=value" assignment.
systemd_env_escape() {
    printf '%s' "$1" | sed 's/[\\"]/\\&/g'
}

# Escape a value for embedding in a launchd plist <string>.
xml_escape() {
    printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'
}

systemd_env_unescape() {
    printf '%s' "$1" | sed 's/\\\(["\\]\)/\1/g'
}

xml_unescape() {
    printf '%s' "$1" | sed -e 's/&lt;/</g' -e 's/&gt;/>/g' -e 's/&amp;/\&/g'
}

# Read the binding out of an already-installed service file, if any. A service
# file WITHOUT our CODEMAN_HOST line is a pre-1.8 install, which effectively
# ran loopback (the server default), so it reports 127.0.0.1. Also reads back
# the sub-path (CODEMAN_BASE_URL) and the port the service was written with,
# and the installed version, for the preflight summary and the re-run defaults.
read_existing_binding() {
    EXISTING_FOUND="0"; EXISTING_HOST=""; EXISTING_PASSWORD=""; EXISTING_ACK="0"; EXISTING_BASE_URL=""
    local unit="$HOME/.config/systemd/user/codeman-web.service"
    local plist="$HOME/Library/LaunchAgents/com.codeman.web.plist"
    local existing_port=""

    if [[ -f "$unit" ]]; then
        EXISTING_FOUND="1"
        EXISTING_HOST=$(sed -n 's/^Environment=CODEMAN_HOST=//p' "$unit" | head -1)
        local pwline
        pwline=$(sed -n 's/^Environment="CODEMAN_PASSWORD=\(.*\)"$/\1/p' "$unit" | head -1)
        [[ -n "$pwline" ]] && EXISTING_PASSWORD=$(systemd_env_unescape "$pwline")
        grep -q '^Environment=CODEMAN_ALLOW_UNAUTHENTICATED_NETWORK=1' "$unit" && EXISTING_ACK="1"
        EXISTING_BASE_URL=$(sed -n 's/^Environment=CODEMAN_BASE_URL=//p' "$unit" | head -1)
        existing_port=$(sed -n 's/^Environment=CODEMAN_PORT=//p' "$unit" | head -1)
    elif [[ -f "$plist" ]]; then
        EXISTING_FOUND="1"
        EXISTING_HOST=$(awk '/<key>CODEMAN_HOST<\/key>/{getline; print}' "$plist" | sed -n 's/.*<string>\(.*\)<\/string>.*/\1/p')
        local pwraw
        pwraw=$(awk '/<key>CODEMAN_PASSWORD<\/key>/{getline; print}' "$plist" | sed -n 's/.*<string>\(.*\)<\/string>.*/\1/p')
        [[ -n "$pwraw" ]] && EXISTING_PASSWORD=$(xml_unescape "$pwraw")
        grep -q '<key>CODEMAN_ALLOW_UNAUTHENTICATED_NETWORK</key>' "$plist" && EXISTING_ACK="1"
        EXISTING_BASE_URL=$(awk '/<key>CODEMAN_BASE_URL<\/key>/{getline; print}' "$plist" | sed -n 's/.*<string>\(.*\)<\/string>.*/\1/p')
        existing_port=$(awk '/<key>CODEMAN_PORT<\/key>/{getline; print}' "$plist" | sed -n 's/.*<string>\(.*\)<\/string>.*/\1/p')
    fi

    if [[ "$EXISTING_FOUND" == "1" && -z "$EXISTING_HOST" ]]; then
        EXISTING_HOST="127.0.0.1"
    fi
    # The service's port is the port, unless the caller overrode it: every
    # serve target and URL below reads ${CODEMAN_PORT:-3000}.
    if [[ -z "${CODEMAN_PORT:-}" && -n "$existing_port" ]]; then
        export CODEMAN_PORT="$existing_port"
    fi
    EXISTING_VERSION=""
    if [[ -f "$INSTALL_DIR/package.json" ]]; then
        EXISTING_VERSION=$(sed -n 's/^  *"version": *"\([^"]*\)".*/\1/p' "$INSTALL_DIR/package.json" | head -1)
    fi
    return 0
}

# Question 1 of 3: how should the dashboard be reachable? Sets
# BIND_HOST/BIND_PASSWORD/BIND_ACK, and on the Tailscale route runs everything
# Tailscale that needs a human right here (tailscale_prepare), so the build
# afterwards is unattended. Interactive default is Tailscale when it is
# already connected, else network access (0.0.0.0), with loopback as the safer
# alternative. Non-interactive runs keep the safe loopback default unless
# CODEMAN_HOST is preset. The server binary itself still defaults to 127.0.0.1
# either way.
choose_network_binding() {
    # A previous install's choice is the baseline: re-installing must never
    # silently loosen it. That holds for the preset paths below too: a flag
    # re-run (`--lan --service` on a unit that carried a password) used to
    # rewrite the unit without the password AND with the unauthenticated
    # ack, and `--tailscale` dropped the password the same way (found in
    # review, 2026-09-21). The caller's own CODEMAN_PASSWORD still wins.
    read_existing_binding

    # Preset via environment or flag: honor it and skip the prompt entirely.
    # CODEMAN_TAILSCALE=1 composes with a loopback (or absent) CODEMAN_HOST.
    if [[ -n "${CODEMAN_HOST:-}" ]]; then
        BIND_HOST="$CODEMAN_HOST"
        BIND_PASSWORD="${CODEMAN_PASSWORD:-$EXISTING_PASSWORD}"
        if [[ "$BIND_HOST" != "127.0.0.1" && -z "$BIND_PASSWORD" ]]; then
            BIND_ACK="1"
        fi
        if [[ -n "$EXISTING_PASSWORD" && -z "${CODEMAN_PASSWORD:-}" ]]; then
            info "Keeping the existing dashboard password"
        fi
        info "Network binding preset: $BIND_HOST"
        if [[ "${CODEMAN_TAILSCALE:-0}" == "1" ]]; then
            if [[ "$BIND_HOST" == "127.0.0.1" ]]; then
                tailscale_prepare || true
            else
                warn "Tailscale preset ignored: CODEMAN_HOST=$BIND_HOST is not loopback."
            fi
        fi
        return 0
    fi
    if [[ "${CODEMAN_TAILSCALE:-0}" == "1" ]]; then
        BIND_HOST="127.0.0.1"
        BIND_PASSWORD="${CODEMAN_PASSWORD:-$EXISTING_PASSWORD}"
        if [[ -n "$EXISTING_PASSWORD" && -z "${CODEMAN_PASSWORD:-}" ]]; then
            info "Keeping the existing dashboard password"
        fi
        info "Tailscale access preset"
        tailscale_prepare || true
        return 0
    fi

    if [[ "$NONINTERACTIVE" == "1" ]] || ! has_tty; then
        if [[ "$EXISTING_FOUND" == "1" ]]; then
            BIND_HOST="$EXISTING_HOST"
            BIND_PASSWORD="$EXISTING_PASSWORD"
            BIND_ACK="$EXISTING_ACK"
            BIND_BASE_URL="$EXISTING_BASE_URL"
            info "Non-interactive install: preserving existing binding ($BIND_HOST)"
        else
            BIND_HOST="127.0.0.1"
            info "Non-interactive install: binding 127.0.0.1 (preset CODEMAN_HOST=0.0.0.0 to override)"
        fi
        return 0
    fi

    # Tailscale state, for the menu hint and the default choice. Detection
    # only; never installs, logs in, or prompts for sudo here.
    local ts_hint="will be installed for you" ts_ready="0" ts_detected_url="" ts_preview=""
    if check_tailscale; then
        ts_hint="installed, needs login"
        if command -v node &>/dev/null && [[ "$(ts_backend_state)" == "Running" ]]; then
            ts_ready="1"
            ts_hint="already connected"
            ts_preview="https://$(ts_dns_name)"
            ts_detected_url=$(detect_tailscale_serve_url) || ts_detected_url=""
            if [[ -n "$ts_detected_url" ]]; then
                ts_hint="already serving Codeman"
                ts_preview="$ts_detected_url"
            fi
        fi
    fi

    # Defaults: an existing setup wins (existing loopback installs default to
    # Tailscale only when its serve mapping is already present); fresh installs
    # default to Tailscale when it is already connected, else network access.
    # A bare Enter never pulls in new software.
    local default_choice="2"
    if [[ "$EXISTING_FOUND" == "1" && "$EXISTING_HOST" == "127.0.0.1" ]]; then
        if [[ -n "$ts_detected_url" ]]; then
            default_choice="1"
        else
            default_choice="3"
        fi
    elif [[ "$EXISTING_FOUND" != "1" && "$ts_ready" == "1" ]]; then
        default_choice="1"
    fi

    echo -e "  ${BOLD}1/3  How should the Codeman dashboard be reachable?${NC}"
    echo ""
    echo -e "    ${CYAN}1)${NC} ${BOLD}Tailscale${NC} ${DIM}($ts_hint)${NC}${ts_preview:+  $ts_preview}"
    echo -e "       Private VPN access from your phone or laptop, anywhere."
    echo -e "       Real HTTPS, no password needed: your tailnet is the login."
    echo -e "    ${CYAN}2)${NC} ${BOLD}Any device on your network${NC} ${DIM}(0.0.0.0)${NC}"
    echo -e "       Open it straight from your phone or laptop on the same Wi-Fi."
    echo -e "       ${YELLOW}Less safe: set a password so only you control your agents.${NC}"
    echo -e "    ${CYAN}3)${NC} ${BOLD}This machine only${NC} ${DIM}(127.0.0.1)${NC}"
    echo -e "       Safest. Reach it remotely via Tailscale or a tunnel later."
    echo ""
    if [[ "$EXISTING_FOUND" == "1" ]]; then
        echo -e "  ${DIM}Current setup: $EXISTING_HOST$([[ -n "$EXISTING_PASSWORD" ]] && echo ", password set"). Enter keeps it.${NC}"
        echo ""
    fi

    local bind_choice=""
    if [[ "$ASSUME_YES" == "1" ]]; then
        bind_choice="$default_choice"
        info "Taking the default: option $bind_choice"
    else
        while true; do
            echo -en "${CYAN}Choose [1/2/3] (default $default_choice):${NC} " >&2
            read_reply bind_choice || bind_choice="$default_choice"
            bind_choice="${bind_choice:-$default_choice}"
            case "$bind_choice" in
                1|2|3) break ;;
                *) echo "Please enter 1, 2, or 3." >&2 ;;
            esac
        done
    fi

    if [[ "$bind_choice" == "3" ]]; then
        BIND_HOST="127.0.0.1"
        success "Binding 127.0.0.1 (this machine only)"
        return 0
    fi

    if [[ "$bind_choice" == "1" ]]; then
        BIND_HOST="127.0.0.1"
        tailscale_prepare || true

        # Password is optional here: the tailnet already authenticates devices.
        # An existing password is always kept (never silently loosen).
        if [[ -n "$EXISTING_PASSWORD" ]]; then
            BIND_PASSWORD="$EXISTING_PASSWORD"
            info "Keeping the existing dashboard password"
        elif [[ -n "${CODEMAN_PASSWORD:-}" ]]; then
            BIND_PASSWORD="$CODEMAN_PASSWORD"
            info "Using CODEMAN_PASSWORD from the environment"
        elif prompt_yes_no "Add a dashboard password too? (optional; your tailnet already authenticates your devices)" "n"; then
            local ts_pw="" ts_pw2=""
            while true; do
                echo -en "${CYAN}Dashboard password:${NC} " >&2
                read_secret ts_pw || ts_pw=""
                if [[ -z "$ts_pw" ]]; then
                    info "No password set"
                    break
                fi
                echo -en "${CYAN}Confirm password:${NC} " >&2
                read_secret ts_pw2 || ts_pw2=""
                if [[ "$ts_pw" == "$ts_pw2" ]]; then
                    BIND_PASSWORD="$ts_pw"
                    success "Password set (login user: admin)"
                    break
                fi
                echo "Passwords do not match, try again." >&2
            done
        fi
        return 0
    fi

    # Keep a custom non-loopback host from a previous install (e.g. a specific
    # interface IP); otherwise bind all interfaces.
    if [[ "$EXISTING_FOUND" == "1" && -n "$EXISTING_HOST" && "$EXISTING_HOST" != "127.0.0.1" ]]; then
        BIND_HOST="$EXISTING_HOST"
    else
        BIND_HOST="0.0.0.0"
    fi

    if [[ -n "${CODEMAN_PASSWORD:-}" ]]; then
        BIND_PASSWORD="$CODEMAN_PASSWORD"
        info "Using CODEMAN_PASSWORD from the environment"
        return 0
    fi

    # A password is not a default: --yes still asks for one here.
    echo ""
    local pw="" pw2="" keep_hint=""
    [[ -n "$EXISTING_PASSWORD" ]] && keep_hint="Enter to keep the current one" || keep_hint="Enter to skip"
    while true; do
        echo -en "${CYAN}Set a dashboard password (recommended; $keep_hint):${NC} " >&2
        read_secret pw || pw=""
        if [[ -z "$pw" ]]; then
            if [[ -n "$EXISTING_PASSWORD" ]]; then
                BIND_PASSWORD="$EXISTING_PASSWORD"
                success "Keeping the existing password"
                break
            fi
            echo ""
            warn "Without a password, EVERY device on your network gets full access"
            warn "to your agents (they run commands as $USER)."
            # Owner decision (2026-09-20): Enter continues; the warning above and the
            # red notice at the end are what carry the message, not a second prompt.
            if prompt_yes_no "Continue WITHOUT a password?" "y"; then
                BIND_ACK="1"
                break
            fi
            continue
        fi
        echo -en "${CYAN}Confirm password:${NC} " >&2
        read_secret pw2 || pw2=""
        if [[ "$pw" == "$pw2" ]]; then
            BIND_PASSWORD="$pw"
            success "Password set (login user: admin)"
            break
        fi
        echo "Passwords do not match, try again." >&2
    done
    return 0
}

# ============================================================================
# Tailscale Access (loopback bind fronted by `tailscale serve` HTTPS)
# ============================================================================
# The recommended remote-access setup: Codeman stays on 127.0.0.1 and
# tailscaled fronts it with a real Let's Encrypt certificate for
# https://<node>.<tailnet>.ts.net, reachable from the user's tailnet only.
# The app side needs zero configuration (.ts.net is in the server's trusted
# host suffixes). All state lives in tailscaled: no marker files, `tailscale
# serve status` is the single source of truth, and `--bg` config persists
# across reboots on its own.
#
# Two phases, because the login URL, the operator grant and the tailnet HTTPS
# toggle all need a human while `tailscale serve` does not:
#   tailscale_prepare  (question phase)  install, login, operator, HTTPS certs,
#                                        the optional rename, the serve shape
#   tailscale_apply    (after the build) the one serve command, then verify
#
# Safety rules for every function here: NEVER `tailscale serve reset`, never
# touch a mapping this installer did not create, never `tailscale funnel`
# (that is the public internet, a different risk class), never advertise a
# Tailscale Service. Users may have unrelated serve config that a reset would
# destroy.

get_tailscale_path() {
    if command -v tailscale &>/dev/null; then
        command -v tailscale
        return 0
    fi
    # macOS GUI app (App Store or brew cask) ships the CLI inside the bundle
    # and does not put it on PATH.
    if [[ -x "/Applications/Tailscale.app/Contents/MacOS/Tailscale" ]]; then
        echo "/Applications/Tailscale.app/Contents/MacOS/Tailscale"
        return 0
    fi
    return 1
}

check_tailscale() {
    get_tailscale_path >/dev/null 2>&1
}

ts_cmd() {
    local ts_bin
    ts_bin=$(get_tailscale_path) || return 127
    "$ts_bin" "$@"
}

# Serve mutations need root or "operator" rights on Linux; TS_NEED_ROOT is set
# by ensure_tailscale_operator when the operator grant failed. Detection paths
# run with TS_NEED_ROOT=0 and must never trigger a sudo prompt.
ts_cmd_serve() {
    local ts_bin
    ts_bin=$(get_tailscale_path) || return 127
    if [[ "$TS_NEED_ROOT" == "1" ]]; then
        run_as_root "$ts_bin" "$@"
    else
        "$ts_bin" "$@"
    fi
}

# ts_status_field <js-expr>: evaluate an expression against the parsed
# `tailscale status --json` object bound to `s`, printing the result (empty on
# any error). node is guaranteed at every call site (the installer installs it
# before the binding prompt; the subcommand requires a completed install).
ts_status_field() {
    ts_cmd status --json 2>/dev/null | node -e '
        let d = "";
        process.stdin.on("data", (c) => (d += c));
        process.stdin.on("end", () => {
            try {
                const s = JSON.parse(d);
                const v = eval(process.argv[1]);
                if (v !== undefined && v !== null && v !== false) process.stdout.write(String(v));
            } catch {}
        });
    ' "$1" 2>/dev/null
}

# Print the local port that the :443 root handler proxies to, empty when 443
# has no "/" handler. Any scheme counts (http://, and https+insecure:// from
# setups where Codeman itself runs --https), so legacy configs are recognized
# as ours.
ts_serve_443_target_port() {
    ts_cmd_serve serve status --json 2>/dev/null | node -e '
        let d = "";
        process.stdin.on("data", (c) => (d += c));
        process.stdin.on("end", () => {
            try {
                const s = JSON.parse(d);
                for (const [hostport, cfg] of Object.entries(s.Web || {})) {
                    if (!hostport.endsWith(":443")) continue;
                    const proxy = cfg && cfg.Handlers && cfg.Handlers["/"] && cfg.Handlers["/"].Proxy;
                    if (!proxy) continue;
                    const m = String(proxy).match(/:(\d+)\/?$/);
                    if (m) process.stdout.write(m[1]);
                    return;
                }
            } catch {}
        });
    ' 2>/dev/null
}

# Print "<hostport>|<path>|<url>" for the serve handler that proxies to local
# port $1 (a :443 root mapping wins over the others), or nothing. Recognizes
# the three shapes this installer can produce: https://<node>,
# https://<node><path> and https://<node>:<port>.
ts_serve_find_port_mapping() {
    ts_cmd_serve serve status --json 2>/dev/null | node -e '
        let d = "";
        process.stdin.on("data", (c) => (d += c));
        process.stdin.on("end", () => {
            try {
                const want = process.argv[1];
                const s = JSON.parse(d);
                const found = [];
                for (const [hostport, cfg] of Object.entries(s.Web || {})) {
                    const handlers = (cfg && cfg.Handlers) || {};
                    for (const [path, h] of Object.entries(handlers)) {
                        const proxy = h && h.Proxy;
                        if (!proxy) continue;
                        const m = String(proxy).match(/:(\d+)\/?$/);
                        if (!m || m[1] !== want) continue;
                        const i = hostport.lastIndexOf(":");
                        const host = hostport.slice(0, i);
                        const port = hostport.slice(i + 1);
                        const url = "https://" + host + (port === "443" ? "" : ":" + port) + (path === "/" ? "" : path);
                        found.push({ hostport, path, url, rank: (port === "443" ? 0 : 1) + (path === "/" ? 0 : 2) });
                    }
                }
                found.sort((a, b) => a.rank - b.rank);
                if (found.length) process.stdout.write(found[0].hostport + "|" + found[0].path + "|" + found[0].url);
            } catch {}
        });
    ' "$1" 2>/dev/null
}

# Does any serve handler already listen on tailnet port $1?
ts_serve_port_used() {
    ts_cmd_serve serve status --json 2>/dev/null | node -e '
        let d = "";
        process.stdin.on("data", (c) => (d += c));
        process.stdin.on("end", () => {
            try {
                const s = JSON.parse(d);
                for (const hostport of Object.keys(s.Web || {})) {
                    if (hostport.endsWith(":" + process.argv[1])) { process.stdout.write("1"); return; }
                }
            } catch {}
        });
    ' "$1" 2>/dev/null | grep -q 1
}

# The daemon state (Running, NeedsLogin, Stopped, ...) and this node's
# MagicDNS name (no trailing dot), plus its short name and the tailnet suffix.
# Both are read through node when it is there and with a line grep when it is
# not: `tailscale status --json` is printed one key per line and Self precedes
# Peer, so the first match is this node. The preflight summary is the one
# reader that runs before node is installed, and it used to report a
# logged-in node as "not logged in" on exactly the fresh box this installer
# is for; everything else runs after ask_dependencies. Empty when tailscale
# is not running.
ts_backend_state() {
    if command -v node &>/dev/null; then
        ts_status_field 's.BackendState'
        return 0
    fi
    ts_cmd status --json 2>/dev/null | sed -n 's/^ *"BackendState": *"\([^"]*\)".*/\1/p' | head -1 || true
}

ts_dns_name() {
    local dns
    if command -v node &>/dev/null; then
        dns=$(ts_status_field 's.Self && s.Self.DNSName')
    else
        dns=$(ts_cmd status --json 2>/dev/null | sed -n 's/^ *"DNSName": *"\([^"]*\)".*/\1/p' | head -1 || true)
    fi
    printf '%s' "${dns%.}"
}

ts_node_name() {
    local dns
    dns=$(ts_dns_name)
    printf '%s' "${dns%%.*}"
}

ts_tailnet_suffix() {
    local dns
    dns=$(ts_dns_name)
    case "$dns" in
        *.*) printf '%s' "${dns#*.}" ;;
    esac
}

# A tailnet machine name: lowercase letters, digits and dashes, 63 at most.
ts_sanitize_name() {
    printf '%s' "$1" | tr '[:upper:]' '[:lower:]' | sed -e 's/[^a-z0-9-]/-/g' -e 's/--*/-/g' -e 's/^-//' -e 's/-$//' | cut -c1-63
}

# Print the URL tailscale serve already forwards to Codeman's port (any of the
# three shapes), or nothing. Safe to call anywhere (no sudo, no side effects);
# used by the summary, the security notice, uninstall and the re-run default.
detect_tailscale_serve_url() {
    check_tailscale || return 0
    command -v node &>/dev/null || return 0
    [[ "$(ts_backend_state)" == "Running" ]] || return 0
    local mapping
    mapping=$(ts_serve_find_port_mapping "${CODEMAN_PORT:-3000}")
    [[ -n "$mapping" ]] || return 0
    echo "${mapping##*|}"
}

# The serve target for Codeman's port: the bare port (plain HTTP) normally,
# https+insecure://localhost:<port> when a hand-run install answers HTTPS on
# it (codeman web --https), which is the maintainer's own prod shape.
ts_serve_target() {
    local port="${CODEMAN_PORT:-3000}"
    if command -v curl &>/dev/null; then
        if ! curl -sm 3 -o /dev/null "http://127.0.0.1:$port/api/status" 2>/dev/null &&
            curl -skm 3 -o /dev/null "https://127.0.0.1:$port/api/status" 2>/dev/null; then
            echo "https+insecure://localhost:$port"
            return 0
        fi
    fi
    echo "$port"
}

tailscale_retrofit_hint() {
    warn "$1: falling back to local-only access (127.0.0.1)."
    echo -e "  ${DIM}Set up Tailscale access any time later with:${NC} ${CYAN}bash $INSTALL_DIR/install.sh tailscale${NC}" >&2
}

offer_install_tailscale() {
    if [[ "$NONINTERACTIVE" == "1" ]]; then
        info "Tailscale is not installed; skipping (non-interactive runs never install it)."
        return 1
    fi
    headless_guard "install Tailscale (curl | sh from tailscale.com)"

    if [[ "$(uname -s)" == "Darwin" ]]; then
        if command -v brew &>/dev/null; then
            if ! prompt_yes_no "Tailscale is not installed. Install it now with Homebrew?" "y"; then
                return 1
            fi
            if ! brew install --cask tailscale; then
                warn "Homebrew install failed."
                return 1
            fi
            open -a Tailscale 2>/dev/null || true
            info "Log in via the Tailscale menu-bar app if it asks."
        else
            info "Install the Tailscale app first: https://tailscale.com/download/macos"
            open_in_browser "https://tailscale.com/download/macos"
            if ! prompt_yes_no "Continue once Tailscale is installed?" "n"; then
                return 1
            fi
        fi
    else
        if ! prompt_yes_no "Tailscale is not installed. Install it now (official installer from tailscale.com)?" "y"; then
            return 1
        fi
        sudo_session_start
        info "Running the official Tailscale installer..."
        # When piped (curl | bash), stdin is our pipe: give the child installer
        # the real terminal so its own sudo prompt works.
        if [[ -e /dev/tty ]]; then
            if ! sh -c "$(download_to_stdout https://tailscale.com/install.sh)" < /dev/tty; then
                warn "Tailscale installation failed."
                return 1
            fi
        else
            if ! sh -c "$(download_to_stdout https://tailscale.com/install.sh)"; then
                warn "Tailscale installation failed."
                return 1
            fi
        fi
    fi

    if ! check_tailscale; then
        warn "tailscale was not found after the install."
        return 1
    fi
    success "Tailscale installed"
    return 0
}

ensure_tailscale_login() {
    local state
    state=$(ts_backend_state)
    if [[ "$state" == "Running" ]]; then
        return 0
    fi
    if [[ "$NONINTERACTIVE" == "1" ]] || ! has_tty; then
        warn "Tailscale is installed but not connected (state: ${state:-unknown})."
        return 1
    fi

    info "Tailscale needs to log in to your tailnet."
    echo -e "  ${DIM}A login URL will be printed: open it on any device. Waiting up to 5 minutes.${NC}"
    local ts_bin up_ok="0"
    ts_bin=$(get_tailscale_path) || return 1
    if [[ "$(uname -s)" == "Darwin" ]]; then
        # The GUI app's CLI runs as the user; no root needed.
        if "$ts_bin" up --timeout=300s; then up_ok="1"; fi
    else
        sudo_session_start
        if [[ -e /dev/tty ]]; then
            if run_as_root "$ts_bin" up --timeout=300s < /dev/tty; then up_ok="1"; fi
        else
            if run_as_root "$ts_bin" up --timeout=300s; then up_ok="1"; fi
        fi
    fi
    if [[ "$up_ok" != "1" ]]; then
        if [[ "$(uname -s)" == "Darwin" ]]; then
            info "If the CLI cannot log in, open the Tailscale app, log in there, then run:"
            info "  bash $INSTALL_DIR/install.sh tailscale"
        fi
        return 1
    fi
    if [[ "$(ts_backend_state)" == "Running" ]]; then
        success "Connected to your tailnet as $(ts_node_name)"
        return 0
    fi
    return 1
}

# Linux: `tailscale serve` needs root or operator rights. Grant operator once
# (with the user's consent via sudo) so serve config never needs sudo again;
# fall back to sudo-per-command when the grant fails.
ensure_tailscale_operator() {
    if [[ "$(uname -s)" == "Darwin" ]] || [[ $EUID -eq 0 ]]; then
        return 0
    fi
    if ts_cmd serve status &>/dev/null; then
        return 0
    fi
    if ! command -v sudo &>/dev/null; then
        warn "No sudo available; tailscale serve configuration may fail without root."
        TS_NEED_ROOT="1"
        return 0
    fi
    sudo_session_start
    info "Granting your user Tailscale 'operator' rights (lets serve run without root from now on)..."
    local ts_bin
    ts_bin=$(get_tailscale_path) || return 0
    if run_as_root "$ts_bin" set --operator="$USER" 2>/dev/null && ts_cmd serve status &>/dev/null; then
        success "Operator rights granted"
        return 0
    fi
    warn "Could not grant operator rights; serve commands will use sudo."
    TS_NEED_ROOT="1"
    return 0
}

# HTTPS certificates are a per-tailnet admin toggle. Serve without them cannot
# terminate TLS, and a plain-HTTP fallback would silently break the "real
# HTTPS" promise (PWA install, web push), so guide the user through enabling
# them instead of degrading. Polls on its own (the toggle is flipped in a
# browser, and the old "re-check now?" question was one more thing to answer);
# opens the admin page where there is a browser to open it in.
ensure_tailnet_https() {
    # Ctrl+C during the poll used to end the whole installer (the only trap
    # was EXIT) while the prompt said "give up", and the user re-answered every
    # question on the retry. The INT trap is armed for the poll only and
    # restored on every way out; the poll then returns 1, which lands on the
    # retrofit hint like any other Tailscale fallback.
    local rc=0
    TS_HTTPS_POLL_INTERRUPTED="0"
    trap 'TS_HTTPS_POLL_INTERRUPTED=1' INT
    tailnet_https_poll || rc=$?
    trap - INT
    return "$rc"
}

tailnet_https_poll() {
    local waited=0 printed="0" magic cert
    while true; do
        if [[ "$TS_HTTPS_POLL_INTERRUPTED" == "1" ]]; then
            echo "" >&2
            warn "Interrupted; skipping Tailscale for this run."
            return 1
        fi
        magic=$(ts_status_field 's.CurrentTailnet && s.CurrentTailnet.MagicDNSEnabled ? "1" : ""')
        cert=$(ts_status_field 'Array.isArray(s.CertDomains) && s.CertDomains.length > 0 ? "1" : ""')
        if [[ "$magic" == "1" && "$cert" == "1" ]]; then
            if [[ "$printed" == "1" ]]; then
                echo "" >&2
                success "HTTPS certificates are enabled for your tailnet"
            fi
            return 0
        fi
        if [[ "$printed" == "0" ]]; then
            printed="1"
            warn "Your tailnet has not enabled HTTPS certificates yet (a one-time admin toggle)."
            echo -e "    Open ${CYAN}https://login.tailscale.com/admin/dns${NC} and enable:" >&2
            if [[ "$magic" == "1" ]]; then
                echo -e "      ${CYAN}1.${NC} MagicDNS            ${GREEN}(already on)${NC}" >&2
            else
                echo -e "      ${CYAN}1.${NC} MagicDNS" >&2
            fi
            if [[ "$cert" == "1" ]]; then
                echo -e "      ${CYAN}2.${NC} HTTPS Certificates  ${GREEN}(already on)${NC}" >&2
            else
                echo -e "      ${CYAN}2.${NC} HTTPS Certificates" >&2
            fi
            if [[ "$NONINTERACTIVE" == "1" ]] || ! has_tty; then
                return 1
            fi
            open_in_browser "https://login.tailscale.com/admin/dns"
            echo -e "    ${DIM}Waiting for the toggle (checking every 5 s; Ctrl+C skips Tailscale for this run)${NC}" >&2
        fi
        if [[ "$waited" -ge 300 ]]; then
            echo "" >&2
            if ! prompt_yes_no "Still not enabled. Keep waiting? (answering no skips Tailscale setup)" "y"; then
                return 1
            fi
            waited=0
        fi
        # A Ctrl+C lands in this sleep; the trap only records it.
        sleep 5 || true
        waited=$((waited + 5))
        printf '.' >&2
    done
}

# Everything Tailscale that needs a human, in the question phase: install
# consent, the login URL, the one-time operator grant, the tailnet HTTPS
# toggle. Ends with the node connected and certificate-capable, or falls back
# to plain loopback with a retrofit hint.
tailscale_preflight() {
    if ! check_tailscale; then
        if ! offer_install_tailscale; then
            tailscale_retrofit_hint "Tailscale is not installed"
            return 1
        fi
    fi
    if ! command -v node &>/dev/null; then
        tailscale_retrofit_hint "node is not on PATH yet"
        return 1
    fi
    if ! ensure_tailscale_login; then
        tailscale_retrofit_hint "Tailscale is not connected"
        return 1
    fi
    ensure_tailscale_operator
    if ! ensure_tailnet_https; then
        tailscale_retrofit_hint "HTTPS certificates are not enabled for your tailnet"
        return 1
    fi
    return 0
}

# Question 2 of 3: optionally rename this machine on the tailnet so the URL
# reads codeman-<hostname> instead of whatever the OS hostname is. Opt-in and
# default NO, always: the tailnet name is what ssh and every other service on
# this machine are reached by, so a rename is never something to slip past
# someone. `--name <n>` answers it; `--no-rename`, `--yes` and non-interactive
# runs skip it. With "force" (the `name` subcommand) the question is asked
# even on a node already named codeman-*.
tailscale_choose_name() {
    local force="${1:-}"
    [[ "$TS_NO_RENAME" == "1" ]] && return 0
    local current target
    current=$(ts_node_name)
    [[ -n "$current" ]] || return 0
    if [[ -n "$TS_NAME" ]]; then
        target="$TS_NAME"
    else
        if [[ -z "$force" ]] && [[ "$current" == "codeman" || "$current" == codeman-* ]]; then
            return 0
        fi
        if [[ "$NONINTERACTIVE" == "1" ]] || [[ "$ASSUME_YES" == "1" ]] || ! has_tty; then
            return 0
        fi
        local suggested
        suggested="codeman-$(ts_sanitize_name "$(hostname -s 2>/dev/null || hostname)")"
        [[ "$suggested" != "$current" ]] || return 0
        echo "" >&2
        echo -e "  ${BOLD}2/3  Name this machine on your tailnet?${NC}" >&2
        echo "" >&2
        echo -e "  It is ${BOLD}$current${NC} today, so Codeman's URL will be ${BOLD}https://$(ts_dns_name)${NC}." >&2
        echo -e "  It can be renamed to ${BOLD}$suggested${NC} instead. ${DIM}That renames it for ssh and${NC}" >&2
        echo -e "  ${DIM}everything else on your tailnet too, which is why the default is no.${NC}" >&2
        if ! prompt_yes_no "Rename this machine to $suggested?" "n"; then
            return 0
        fi
        target="$suggested"
    fi
    target=$(ts_sanitize_name "$target")
    if [[ -z "$target" ]]; then
        warn "Not a usable tailnet name; keeping $current."
        return 0
    fi
    [[ "$target" != "$current" ]] || return 0
    tailscale_rename_node "$target"
}

# Rename the node. Serve config is keyed by the DNS name it was written under,
# so a mapping of ours that already exists is taken down first and re-added by
# tailscale_apply under the new name: the alternative is a stale entry only
# `serve reset` could remove, and that command is off limits here.
tailscale_rename_node() {
    local target="$1" old newname i orig=""
    old=$(ts_node_name)
    if [[ -n "$(detect_tailscale_serve_url)" ]]; then
        info "Taking down the serve mapping written under the old name (it is re-added after the rename)"
        tailscale_remove_our_mapping || true
        TS_MAPPING_REMOVED_BY_RENAME="1"
        [[ "$TS_SERVE_MODE" != "keep" ]] || TS_SERVE_MODE=""
    fi
    info "Renaming this machine on your tailnet: $old -> $target"
    if ! ts_cmd_serve set --hostname "$target"; then
        warn "tailscale set --hostname failed; keeping the name $old."
        return 1
    fi
    for ((i = 1; i <= 30; i++)); do
        newname=$(ts_node_name)
        if [[ -n "$newname" && "$newname" != "$old" ]]; then break; fi
        sleep 2
    done
    newname=$(ts_node_name)
    if [[ -z "$newname" || "$newname" == "$old" ]]; then
        warn "The tailnet has not picked up the new name yet; it can take a minute (check: tailscale status)."
        return 1
    fi
    if [[ "$newname" != "$target" ]]; then
        warn "The name $target was taken; your tailnet assigned $newname."
    fi
    mkdir -p "$(dirname "$TS_RENAME_RECORD")" 2>/dev/null || true
    [[ -f "$TS_RENAME_RECORD" ]] && orig=$(sed -n 's/^original=//p' "$TS_RENAME_RECORD" | head -1)
    [[ -n "$orig" ]] || orig="$old"
    printf 'original=%s\ncurrent=%s\n' "$orig" "$newname" > "$TS_RENAME_RECORD" 2>/dev/null || true
    success "This machine is now $(ts_dns_name)"
    return 0
}

# Remove OUR serve mapping (whatever shape it has) and nothing else. Never
# `tailscale serve reset`: the other mappings on this node are not ours.
tailscale_remove_our_mapping() {
    local mapping hostport path port
    mapping=$(ts_serve_find_port_mapping "${CODEMAN_PORT:-3000}")
    [[ -n "$mapping" ]] || return 0
    hostport="${mapping%%|*}"
    path="${mapping#*|}"
    path="${path%%|*}"
    port="${hostport##*:}"
    if [[ "$path" == "/" ]]; then
        ts_cmd_serve serve --https="$port" off
    else
        ts_cmd_serve serve --https="$port" --set-path "$path" off
    fi
}

# Decide the serve shape now (detection only, no serve mutation) so the build
# and the service run unattended and the service unit already carries a
# sub-path when one is needed. Sets TS_SERVE_MODE and BIND_BASE_URL.
tailscale_choose_mapping() {
    local port="${CODEMAN_PORT:-3000}" dns existing_url existing_root
    dns=$(ts_dns_name)
    if [[ -z "$dns" ]]; then
        warn "Could not determine this machine's tailnet DNS name."
        return 1
    fi
    existing_url=$(detect_tailscale_serve_url)
    if [[ -n "$existing_url" ]]; then
        TS_SERVE_MODE="keep"
        # A path-shaped mapping of ours means the service keeps that sub-path.
        local hostpart="${existing_url#https://}"
        BIND_BASE_URL=""
        case "$hostpart" in
            */*) BIND_BASE_URL="/${hostpart#*/}" ;;
        esac
        info "Tailscale serve already forwards $existing_url to port $port (kept as-is)"
        return 0
    fi
    existing_root=$(ts_serve_443_target_port)
    if [[ -z "$existing_root" ]]; then
        TS_SERVE_MODE="root"
        BIND_BASE_URL=""
        return 0
    fi

    # :443 belongs to another app on this node. Never clobber it silently.
    local alt_port="$TS_SERVE_PORT" p
    for p in 8443 8444 8445 10443; do
        if ! ts_serve_port_used "$p"; then alt_port="$p"; break; fi
    done
    TS_SERVE_PORT="$alt_port"
    echo "" >&2
    warn "tailscale serve already sends https://$dns to local port $existing_root."
    echo -e "    ${CYAN}1)${NC} Add Codeman under a path:   ${BOLD}https://$dns$TS_SERVE_PATH${NC}   ${DIM}(default)${NC}" >&2
    echo -e "    ${CYAN}2)${NC} Use another port:           ${BOLD}https://$dns:$TS_SERVE_PORT${NC}" >&2
    echo -e "    ${CYAN}3)${NC} Replace that mapping with Codeman" >&2
    echo -e "    ${CYAN}4)${NC} Skip Tailscale for now" >&2
    local choice="1"
    if [[ "$NONINTERACTIVE" == "1" ]] || [[ "$ASSUME_YES" == "1" ]] || ! has_tty; then
        info "Taking the default: a path"
    else
        while true; do
            echo -en "${CYAN}Choose [1/2/3/4] (default 1):${NC} " >&2
            read_reply choice || choice="1"
            choice="${choice:-1}"
            case "$choice" in
                1|2|3|4) break ;;
                *) echo "Please enter 1, 2, 3 or 4." >&2 ;;
            esac
        done
    fi
    case "$choice" in
        1) TS_SERVE_MODE="path"; BIND_BASE_URL="$TS_SERVE_PATH" ;;
        2) TS_SERVE_MODE="port"; BIND_BASE_URL="" ;;
        3) TS_SERVE_MODE="replace"; BIND_BASE_URL="" ;;
        4) return 1 ;;
    esac
    return 0
}

# The question-phase half: preflight, the optional rename, the serve shape.
tailscale_prepare() {
    TS_READY="0"
    TAILSCALE_SERVE_URL=""
    tailscale_preflight || return 1
    tailscale_choose_name || true
    if ! tailscale_choose_mapping; then
        tailscale_retrofit_hint "no serve mapping was chosen"
        return 1
    fi
    TS_READY="1"
    return 0
}

# The after-the-build half: the one serve command the decision calls for. No
# prompts here. Ends with TAILSCALE_SERVE_URL set, and starts the certificate
# issuance in the background so the first real visit is not the slow one.
tailscale_apply() {
    [[ "$TS_READY" == "1" ]] || return 0
    local dns target out=""
    dns=$(ts_dns_name)
    target=$(ts_serve_target)
    case "$TS_SERVE_MODE" in
        keep)
            TAILSCALE_SERVE_URL=$(detect_tailscale_serve_url)
            success "Tailscale serve: $TAILSCALE_SERVE_URL (kept as-is)"
            return 0
            ;;
        root|replace)
            info "Configuring: tailscale serve --bg $target"
            if out=$(ts_cmd_serve serve --bg "$target" 2>&1); then
                TAILSCALE_SERVE_URL="https://$dns"
            fi
            ;;
        path)
            info "Configuring: tailscale serve --bg --set-path $TS_SERVE_PATH $target"
            if out=$(ts_cmd_serve serve --bg --set-path "$TS_SERVE_PATH" "$target" 2>&1); then
                TAILSCALE_SERVE_URL="https://$dns$TS_SERVE_PATH"
            fi
            ;;
        port)
            info "Configuring: tailscale serve --bg --https=$TS_SERVE_PORT $target"
            if out=$(ts_cmd_serve serve --bg --https="$TS_SERVE_PORT" "$target" 2>&1); then
                TAILSCALE_SERVE_URL="https://$dns:$TS_SERVE_PORT"
            fi
            ;;
        *)
            warn "No Tailscale serve shape was chosen; skipping."
            return 1
            ;;
    esac
    if [[ -z "$TAILSCALE_SERVE_URL" ]]; then
        warn "tailscale serve failed:"
        printf '%s\n' "$out" | sed 's/^/    /' >&2
        tailscale_retrofit_hint "tailscale serve could not be configured"
        return 1
    fi
    success "Tailscale HTTPS enabled: $TAILSCALE_SERVE_URL"
    echo -e "  ${DIM}(persists across reboots; inspect with: tailscale serve status)${NC}"
    if command -v curl &>/dev/null; then
        (curl -skm 90 -o /dev/null "$TAILSCALE_SERVE_URL/api/status" >/dev/null 2>&1 &)
    fi
    return 0
}

# Curl the ts.net URL until it answers. 200 = reachable; 401 = reachable behind
# the dashboard password. The first request can be slow while tailscaled
# obtains the Let's Encrypt certificate.
verify_tailscale_access() {
    if [[ -z "$TAILSCALE_SERVE_URL" ]]; then
        return 0
    fi
    if ! command -v curl &>/dev/null; then
        info "curl not available; open $TAILSCALE_SERVE_URL to verify."
        return 0
    fi
    info "Verifying $TAILSCALE_SERVE_URL (the first load can take ~30 s while the certificate is issued)..."
    local i http_code
    for ((i = 1; i <= 15; i++)); do
        http_code=$(curl -skm 10 -o /dev/null -w '%{http_code}' "$TAILSCALE_SERVE_URL/api/status" 2>/dev/null) || http_code=""
        if [[ "$http_code" == "200" || "$http_code" == "401" ]]; then
            success "Reachable: $TAILSCALE_SERVE_URL"
            return 0
        fi
        sleep 3
    done
    warn "Could not reach $TAILSCALE_SERVE_URL/api/status yet."
    warn "It may need another minute (certificate issuance). Inspect: tailscale serve status"
    return 1
}

# Both halves back to back, for the retrofit paths (the `tailscale` subcommand
# and the re-run repair offer). The caller verifies.
setup_tailscale_access() {
    tailscale_prepare || return 1
    tailscale_apply
}

# A path-shaped mapping needs the service to run under that sub-path: rewrite
# the unit from its existing binding and restart it. No-op when nothing
# changed or no service is installed.
sync_service_base_url() {
    [[ "$EXISTING_FOUND" == "1" ]] || return 0
    [[ "$BIND_BASE_URL" != "$EXISTING_BASE_URL" ]] || return 0
    BIND_HOST="${EXISTING_HOST:-127.0.0.1}"
    BIND_PASSWORD="$EXISTING_PASSWORD"
    BIND_ACK="$EXISTING_ACK"
    info "Updating the service to run under ${BIND_BASE_URL:-/} ..."
    local rc=0
    if [[ "$(uname -s)" == "Darwin" ]]; then
        setup_launchd_service || rc=$?
    else
        setup_systemd_service || rc=$?
    fi
    # The unit now carries the new sub-path: that is what the done screen and
    # the next re-run read back.
    [[ "$rc" -ne 0 ]] || EXISTING_BASE_URL="$BIND_BASE_URL"
    return "$rc"
}

# A loopback install with Tailscale already connected but nothing fronting
# Codeman is one command away from working remote access, and that is exactly
# where a user lands when the first install died BEFORE the network-access
# prompt or when they finished a broken build by hand instead of re-running
# the installer. Detect that state on re-run and offer the retrofit, rather
# than leaving them to discover `install.sh tailscale` on their own. Never
# nags a deliberate network bind, and never nags once a serve mapping exists.
maybe_offer_tailscale_repair() {
    # A non-loopback bind already has network access; leave that choice alone.
    if [[ "$EXISTING_FOUND" == "1" && -n "$EXISTING_HOST" && "$EXISTING_HOST" != "127.0.0.1" ]]; then
        return 0
    fi
    check_tailscale || return 0
    command -v node &>/dev/null || return 0
    [[ "$(ts_backend_state)" == "Running" ]] || return 0
    # Already fronting Codeman: nothing to repair.
    [[ -z "$(detect_tailscale_serve_url)" ]] || return 0

    echo ""
    info "Tailscale is connected here, but no serve mapping fronts Codeman yet."
    if [[ "$NONINTERACTIVE" == "1" ]] || ! has_tty; then
        echo -e "  ${DIM}Enable HTTPS access from your tailnet with:${NC} ${CYAN}bash $INSTALL_DIR/install.sh tailscale${NC}"
        return 0
    fi
    if ! prompt_yes_no "Set up Tailscale HTTPS access now? (your tailnet is the login; no password needed)" "y"; then
        echo -e "  ${DIM}Any time later:${NC} ${CYAN}bash $INSTALL_DIR/install.sh tailscale${NC}"
        return 0
    fi
    if setup_tailscale_access; then
        sync_service_base_url || true
        verify_tailscale_access || true
    fi
    return 0
}

# Is Codeman answering on its port right now (HTTP or HTTPS)?
codeman_answers_locally() {
    local port="${CODEMAN_PORT:-3000}"
    command -v curl &>/dev/null || return 1
    curl -sm 5 -o /dev/null "http://127.0.0.1:$port/api/status" 2>/dev/null ||
        curl -skm 5 -o /dev/null "https://127.0.0.1:$port/api/status" 2>/dev/null
}

# `install.sh tailscale`: retrofit Tailscale access onto an existing install
# (also the target of every "set it up later" hint above).
setup_tailscale_subcommand() {
    print_banner
    if ! command -v node &>/dev/null; then
        die "node is required. Install Codeman first (run the installer without arguments)."
    fi

    read_existing_binding
    if [[ "$EXISTING_FOUND" == "1" && -n "$EXISTING_HOST" && "$EXISTING_HOST" != "127.0.0.1" ]]; then
        warn "Your service binds $EXISTING_HOST (network-wide). Tailscale serve will work, but the"
        warn "dashboard stays reachable on your LAN too. Re-run the installer and choose Tailscale"
        warn "to switch to the tighter loopback-only bind."
        echo ""
    fi

    if ! tailscale_prepare; then
        exit 1
    fi
    sync_service_base_url || true
    if ! tailscale_apply; then
        exit 1
    fi

    # Verify end-to-end only when Codeman is actually answering locally.
    if codeman_answers_locally; then
        verify_tailscale_access || true
    else
        info "Codeman does not appear to be running on port ${CODEMAN_PORT:-3000} right now."
        info "Once it is, open: $TAILSCALE_SERVE_URL"
    fi

    BIND_HOST="${EXISTING_HOST:-127.0.0.1}"
    BIND_PASSWORD="$EXISTING_PASSWORD"
    BIND_ACK="$EXISTING_ACK"
    print_done_screen "" ""
    print_security_notice
}

# `install.sh name [<n>]`: rename this machine on the tailnet, re-adding our
# serve mapping under the new name when there was one.
setup_name_subcommand() {
    print_banner
    if ! command -v node &>/dev/null; then
        die "node is required. Install Codeman first (run the installer without arguments)."
    fi
    check_tailscale || die "Tailscale is not installed. Run: bash $INSTALL_DIR/install.sh tailscale"
    if [[ "$(ts_backend_state)" != "Running" ]]; then
        die "Tailscale is not connected. Run: bash $INSTALL_DIR/install.sh tailscale"
    fi
    read_existing_binding
    ensure_tailscale_operator
    [[ -z "$SUBCOMMAND_ARG" ]] || TS_NAME="$SUBCOMMAND_ARG"
    TS_NO_RENAME="0"

    local before after
    before=$(ts_node_name)
    tailscale_choose_name force || true
    after=$(ts_node_name)
    if [[ "$before" == "$after" ]]; then
        info "Name unchanged: $after"
    fi
    if [[ "$TS_MAPPING_REMOVED_BY_RENAME" == "1" ]]; then
        if tailscale_choose_mapping; then
            # The shape can change across a rename (a root mapping freed :443,
            # or the user picks a port this time), and the unit must follow.
            sync_service_base_url || true
            TS_READY="1"
            tailscale_apply || true
            if codeman_answers_locally; then
                verify_tailscale_access || true
            fi
        fi
    fi

    BIND_HOST="${EXISTING_HOST:-127.0.0.1}"
    BIND_PASSWORD="$EXISTING_PASSWORD"
    BIND_ACK="$EXISTING_ACK"
    # With no service on disk the sub-path lives only in this run's choice.
    [[ -n "$BIND_BASE_URL" ]] || BIND_BASE_URL="$EXISTING_BASE_URL"
    print_done_screen "" ""
    print_security_notice
}

# `install.sh status`: the done screen again, for the "what was my URL" moment.
status_subcommand() {
    print_banner
    read_existing_binding
    BIND_HOST="${EXISTING_HOST:-127.0.0.1}"
    BIND_PASSWORD="$EXISTING_PASSWORD"
    BIND_ACK="$EXISTING_ACK"
    BIND_BASE_URL="$EXISTING_BASE_URL"
    print_done_screen "" ""
    print_security_notice
}

# `install.sh cloudflared`: the optional public-tunnel client, taken out of the
# main flow (it was one more question for a thing few installs use). The
# tunnel itself is switched on in App Settings -> Remote access.
cloudflared_subcommand() {
    print_banner
    local os distro=""
    os=$(detect_os)
    [[ "$os" == "linux" ]] && distro=$(detect_linux_distro)
    if check_cloudflared; then
        success "cloudflared is already installed at $(get_cloudflared_path)"
    else
        headless_guard "install cloudflared (system package via sudo)"
        if ! prompt_yes_no "Install cloudflared now?" "y"; then
            exit 0
        fi
        install_dependency "cloudflared" "$os" "$distro"
        hash -r 2>/dev/null || true
        check_cloudflared || die "cloudflared installation failed. See https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/"
        success "cloudflared installed at $(get_cloudflared_path)"
    fi
    if [[ "$os" == "linux" ]] && command -v systemctl &>/dev/null && [[ -f "$INSTALL_DIR/scripts/codeman-tunnel.service" ]]; then
        if prompt_yes_no "Also install the Cloudflare tunnel service? (requires CODEMAN_PASSWORD)" "n"; then
            setup_tunnel_service
        fi
    fi
    echo ""
    echo -e "  Turn the tunnel on in ${BOLD}App Settings -> System -> Remote access${NC}, or with:"
    echo -e "    ${CYAN}$INSTALL_DIR/scripts/tunnel.sh start${NC}"
    echo -e "  ${YELLOW}A tunnel is a PUBLIC URL: set CODEMAN_PASSWORD first.${NC}"
    echo ""
}

# ============================================================================
# Service Setup (Linux systemd / macOS launchd)
# ============================================================================

# Wait briefly for codeman-web.service to report active. A bad node path or a
# busy port makes the unit crash within the first seconds (then sit in
# activating/auto-restart), so a blind "started!" message would be a lie.
verify_systemd_active() {
    local attempt
    for attempt in 1 2 3; do
        sleep 2
        if systemctl --user is-active --quiet codeman-web.service 2>/dev/null; then
            return 0
        fi
    done
    return 1
}

setup_launchd_service() {
    local plist_label="com.codeman.web"
    local agent_dir="$HOME/Library/LaunchAgents"
    local agent_plist="$agent_dir/$plist_label.plist"
    local daemon_plist="/Library/LaunchDaemons/$plist_label.plist"

    info "Setting up macOS LaunchAgent..."

    # A system-level LaunchDaemon is a deliberate setup: a headless Mac with no
    # GUI login cannot start a LaunchAgent at boot, so its owner wrote a daemon
    # by hand. This installer never writes one, so any daemon here is theirs.
    # Leave it alone: an agent next to it would fight the daemon for the port.
    if [[ -f "$daemon_plist" ]]; then
        warn "A system LaunchDaemon already supervises Codeman ($daemon_plist); leaving it in place."
        echo -e "  ${DIM}To switch to a LaunchAgent: sudo launchctl unload $daemon_plist && sudo rm $daemon_plist, then re-run.${NC}" >&2
        SERVICE_TYPE="launchd-daemon"
        return 0
    fi

    # Unload existing agent before overwriting
    if [[ -f "$agent_plist" ]]; then
        launchctl unload "$agent_plist" 2>/dev/null || true
    fi

    mkdir -p "$agent_dir"

    # Build PATH: ensure /opt/homebrew/bin (Apple Silicon) and ~/.local/bin are included
    local svc_path="/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

    # Find node binary path
    local node_path
    node_path=$(command -v node)

    # Binding chosen during install (empty on paths that never asked), the
    # sub-path and the port when they differ from the defaults.
    local bind_plist=""
    if [[ -n "$BIND_HOST" ]]; then
        bind_plist="    <key>CODEMAN_HOST</key>
    <string>$BIND_HOST</string>"
        if [[ -n "$BIND_PASSWORD" ]]; then
            bind_plist+=$'\n'"    <key>CODEMAN_PASSWORD</key>
    <string>$(xml_escape "$BIND_PASSWORD")</string>"
        fi
        if [[ "$BIND_ACK" == "1" ]]; then
            bind_plist+=$'\n'"    <key>CODEMAN_ALLOW_UNAUTHENTICATED_NETWORK</key>
    <string>1</string>"
        fi
    fi
    if [[ -n "$BIND_BASE_URL" ]]; then
        bind_plist+=$'\n'"    <key>CODEMAN_BASE_URL</key>
    <string>$(xml_escape "$BIND_BASE_URL")</string>"
    fi
    if [[ -n "${CODEMAN_PORT:-}" && "${CODEMAN_PORT}" != "3000" ]]; then
        bind_plist+=$'\n'"    <key>CODEMAN_PORT</key>
    <string>$(xml_escape "$CODEMAN_PORT")</string>"
    fi

    cat > "$agent_plist" << EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$plist_label</string>
  <key>ProgramArguments</key>
  <array>
    <string>$node_path</string>
    <string>$INSTALL_DIR/dist/index.js</string>
    <string>web</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>$svc_path</string>
    <key>HOME</key>
    <string>$HOME</string>
    <key>LANG</key>
    <string>en_US.UTF-8</string>
$bind_plist
  </dict>
  <key>WorkingDirectory</key>
  <string>$HOME</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>StandardOutPath</key>
  <string>/tmp/codeman.log</string>
  <key>StandardErrorPath</key>
  <string>/tmp/codeman.log</string>
</dict>
</plist>
EOF

    launchctl load "$agent_plist" 2>/dev/null || true

    # launchctl load is silent about many failures: confirm the agent is loaded
    sleep 2
    if launchctl list "$plist_label" &>/dev/null; then
        success "LaunchAgent installed and started"
        return 0
    fi
    warn "LaunchAgent did not load."
    warn "Inspect: launchctl list | grep codeman ; tail -20 /tmp/codeman.log"
    return 1
}

setup_systemd_service() {
    local service_dir="$HOME/.config/systemd/user"
    local service_file="$service_dir/codeman-web.service"

    info "Setting up systemd user service..."

    mkdir -p "$service_dir"

    # Find node binary path
    local node_path
    node_path=$(command -v node)

    # Binding chosen during install (empty on paths that never asked), the
    # sub-path and the port when they differ from the defaults.
    local bind_env=""
    if [[ -n "$BIND_HOST" ]]; then
        bind_env="Environment=CODEMAN_HOST=$BIND_HOST"
        if [[ -n "$BIND_PASSWORD" ]]; then
            bind_env+=$'\n'"Environment=\"CODEMAN_PASSWORD=$(systemd_env_escape "$BIND_PASSWORD")\""
        fi
        if [[ "$BIND_ACK" == "1" ]]; then
            bind_env+=$'\n'"Environment=CODEMAN_ALLOW_UNAUTHENTICATED_NETWORK=1"
        fi
    fi
    if [[ -n "$BIND_BASE_URL" ]]; then
        bind_env="${bind_env:+$bind_env$'\n'}Environment=CODEMAN_BASE_URL=$BIND_BASE_URL"
    fi
    if [[ -n "${CODEMAN_PORT:-}" && "${CODEMAN_PORT}" != "3000" ]]; then
        bind_env="${bind_env:+$bind_env$'\n'}Environment=CODEMAN_PORT=$CODEMAN_PORT"
    fi

    # Create service file
    cat > "$service_file" << EOF
[Unit]
Description=Codeman Web Server
After=network.target

[Service]
Type=simple
ExecStart=$node_path $INSTALL_DIR/dist/index.js web
WorkingDirectory=$HOME
Restart=always
RestartSec=10
Environment=NODE_ENV=production
Environment=PATH=$PATH
$bind_env

[Install]
WantedBy=default.target
EOF

    # Reload systemd. A user D-Bus session is required for systemctl --user
    # (missing under bare `ssh host 'curl | bash'` provisioning), so detect
    # that up front instead of dying mid-setup with a cryptic trap message.
    if ! systemctl --user daemon-reload 2>/dev/null; then
        warn "systemctl --user is unavailable (no user D-Bus session?); cannot manage user services here."
        warn "Unit written to $service_file. From a normal login shell, enable it with:"
        warn "  systemctl --user daemon-reload && systemctl --user enable --now codeman-web"
        return 1
    fi

    # Enable service
    systemctl --user enable codeman-web.service 2>/dev/null || true

    # Enable lingering (allows service to run after logout)
    if command -v loginctl &>/dev/null; then
        loginctl enable-linger "$USER" 2>/dev/null || true
    fi

    # (Re)start the service. restart, not start: on a re-run over an existing
    # running service, start would be a no-op and leave the OLD build running.
    systemctl --user restart codeman-web.service 2>/dev/null || true

    if verify_systemd_active; then
        success "Systemd service installed and started"
        return 0
    fi
    warn "codeman-web.service did not become active."
    warn "Inspect: systemctl --user status codeman-web ; journalctl --user -u codeman-web -e"
    return 1
}

setup_tunnel_service() {
    local service_dir="$HOME/.config/systemd/user"
    local service_file="$service_dir/codeman-tunnel.service"

    info "Setting up Cloudflare tunnel systemd service..."

    mkdir -p "$service_dir"
    cp "$INSTALL_DIR/scripts/codeman-tunnel.service" "$service_file"

    systemctl --user daemon-reload
    systemctl --user enable codeman-tunnel.service 2>/dev/null || true

    success "Tunnel service installed (start with: systemctl --user start codeman-tunnel)"
    echo -e "  ${DIM}Note: Set CODEMAN_PASSWORD env var before starting the tunnel for security.${NC}"
}

# ============================================================================
# Installation Helpers
# ============================================================================

# npm install with an actionable message for the failure that actually happens
# on a fresh Linux box: no toolchain, so node-pty cannot compile.
#
# CODEMAN_NO_AUTOSTART=1 is load-bearing: scripts/postinstall.js otherwise
# builds dist/ itself and starts a DETACHED `node dist/index.js web` on
# 127.0.0.1:3000 (the npm-global-install convenience). Under this installer
# that orphan outlived the step, the build ran a second time, and the service
# written a minute later crash-looped on EADDRINUSE while the done screen
# reported "running" off the orphan (measured in a fresh Ubuntu 24 sandbox,
# 2026-09-20). The installer owns the build and the start; postinstall must
# do neither here.
npm_install_deps() {
    if run_step "Installing dependencies" env CODEMAN_NO_AUTOSTART=1 npm install --no-fund --no-audit; then
        return 0
    fi

    error "npm install failed."
    if [[ "$(detect_os)" == "linux" ]] && ! check_build_tools; then
        error "Missing native build tools: $(missing_build_tools)"
        error "node-pty has no Linux prebuilds, so it must compile from source."
        error "Install them and re-run this installer:"
        error "  Debian/Ubuntu:  sudo apt-get install -y build-essential python3"
        error "  Fedora/RHEL:    sudo dnf install -y gcc gcc-c++ make python3"
        error "  Arch:           sudo pacman -S --noconfirm base-devel python"
        error "  Alpine:         sudo apk add build-base python3"
    fi
    exit 1
}

install_dependency() {
    local dep_name="$1"
    local os="$2"
    local distro="$3"

    local install_func="install_${dep_name}_${distro:-$os}"

    # Try distro-specific first, then OS-level
    if [[ "$os" == "macos" ]]; then
        install_func="install_${dep_name}_macos"
    elif ! declare -f "$install_func" &>/dev/null; then
        die "Don't know how to install $dep_name on $distro. Please install it manually."
    fi

    "$install_func"
}

# ============================================================================
# Main Installation
# ============================================================================

print_banner() {
    echo -e "${CYAN}${BOLD}"
    cat << 'EOF'
   ____          _
  / ___|___   __| | ___ _ __ ___   __ _ _ __
 | |   / _ \ / _` |/ _ \ '_ ` _ \ / _` | '_ \
 | |__| (_) | (_| |  __/ | | | | | (_| | | | |
  \____\___/ \__,_|\___|_| |_| |_|\__,_|_| |_|
EOF
    echo -e "${NC}${DIM}  The missing control plane for Claude Code${NC}"
    echo ""
}

main() {
    print_banner

    # Check for curl/wget first
    if ! check_curl_or_wget; then
        die "curl or wget is required but neither is installed. Please install one first."
    fi

    # Detect system
    local os arch distro=""
    os=$(detect_os)
    arch=$(detect_arch)

    if [[ "$os" == "linux" ]]; then
        distro=$(detect_linux_distro)
    fi

    # ========================================================================
    # Look first: what is already here (no prompts, no sudo, no changes)
    # ========================================================================
    preflight_detect "$os"
    print_preflight_summary "$os" "$arch" "$distro"

    # ========================================================================
    # Ask everything up front, so the build afterwards can run unattended
    # ========================================================================
    ask_dependencies "$os" "$distro"

    # AI CLI: needs a human choice AND node (installed just above), so it sits
    # here rather than in preflight. Codeman drives one of the CLIs in the
    # generated catalogue; the menu, the detection and the closing reminder all
    # read that one block.
    CLI_DETECT_DONE=""
    detect_all_clis
    if [[ "$CLI_FOUND_COUNT" -eq 0 ]]; then
        offer_ai_cli_install
    fi

    echo ""
    choose_network_binding
    echo ""
    choose_launch_mode "$os"
    echo ""

    # ========================================================================
    # Work: unattended from here on
    # ========================================================================
    info "Installing Codeman to $INSTALL_DIR (a few minutes; you can leave this running)"
    INSTALL_STARTED="1"
    install_or_update_repo
    npm_install_deps
    run_step "Building Codeman" npm run build || exit 1
    install_symlink

    # The dispatcher at the bottom only routes a bare re-run to the quiet
    # update path when this marker exists, so an aborted first install
    # (failed npm install/build, Ctrl+C) re-runs the full setup flow
    # (symlinks, PATH, launch menu) instead of silently "updating".
    date -u +%Y-%m-%dT%H:%M:%SZ > "$INSTALL_DIR/.install-complete"

    local service_ok="true"
    if [[ "$LAUNCH_CHOICE" == "2" ]]; then
        if [[ "$SERVICE_TYPE" == "launchd" ]]; then
            setup_launchd_service || service_ok="false"
        else
            setup_systemd_service || service_ok="false"
        fi
    fi

    tailscale_apply || true
    # With Tailscale configured, prove the URL actually answers now that the
    # server is up (never claim success blindly).
    if [[ "$LAUNCH_CHOICE" == "2" && "$service_ok" == "true" && -n "$TAILSCALE_SERVE_URL" ]]; then
        verify_tailscale_access || true
    fi

    # ========================================================================
    # Done
    # ========================================================================
    print_done_screen "$LAUNCH_CHOICE" "$service_ok"

    # Security notice: last informational block so it stays visible (when not
    # auto-launching below; if we exec, the server prints the same notice anyway).
    print_security_notice

    # Run now in foreground (must be last: exec replaces the shell)
    if [[ "$LAUNCH_CHOICE" == "1" ]]; then
        local profile
        profile=$(detect_shell_profile)

        echo -e "  ${GREEN}${BOLD}Starting Codeman...${NC}"
        echo -e "  ${DIM}Press Ctrl+C to stop${NC}"
        echo ""

        # Source profile to pick up PATH changes, then exec codeman
        # shellcheck disable=SC1090
        source "$profile" 2>/dev/null || true
        export_bind_env
        # exec skips the EXIT trap: end the sudo keepalive here, or it keeps
        # refreshing the sudo timestamp for as long as the server runs.
        stop_background_helpers
        exec node "$INSTALL_DIR/dist/index.js" web
    fi
}

# ----------------------------------------------------------------------------
# Phase 0: look
# ----------------------------------------------------------------------------

# Detection only: no prompts, no sudo, nothing written. Fills MISSING_PKGS,
# the CLI table, the existing binding and TS_STATE for the summary and the
# questions that follow.
preflight_detect() {
    local os="$1"
    MISSING_PKGS=""
    check_git || MISSING_PKGS="git"
    check_node || MISSING_PKGS="${MISSING_PKGS:+$MISSING_PKGS, }Node.js $TARGET_NODE_VERSION"
    check_tmux || MISSING_PKGS="${MISSING_PKGS:+$MISSING_PKGS, }tmux"
    if [[ "$os" == "linux" ]] && ! check_build_tools; then
        MISSING_PKGS="${MISSING_PKGS:+$MISSING_PKGS, }build tools ($(missing_build_tools))"
    fi
    detect_all_clis
    read_existing_binding
    TS_STATE="absent"
    if check_tailscale; then
        TS_STATE="installed"
        if [[ "$(ts_backend_state)" == "Running" ]]; then
            TS_STATE="connected"
            # "serving" needs the serve-status parser, and that needs node
            # (installed by ask_dependencies when missing); the menu hint in
            # choose_network_binding re-checks once it is there.
            if [[ -n "$(detect_tailscale_serve_url)" ]]; then
                TS_STATE="serving"
            fi
        fi
    fi
    return 0
}

print_preflight_summary() {
    local os="$1" arch="$2" distro="$3"
    local found="" i clis="" ts_line existing="none"
    check_git && found="git $(git --version 2>/dev/null | awk '{print $3}')"
    check_node && found="${found:+$found, }Node $(node --version 2>/dev/null)"
    check_tmux && found="${found:+$found, }tmux $(tmux -V 2>/dev/null | awk '{print $2}')"
    if [[ "$os" == "linux" ]] && check_build_tools; then
        found="${found:+$found, }build tools"
    fi
    for ((i = 0; i < ${#CLI_IDS[@]}; i++)); do
        [[ -n "${CLI_FOUND_PATH[$i]}" ]] || continue
        clis="${clis:+$clis, }${CLI_LABELS[$i]}"
    done
    case "$TS_STATE" in
        serving)   ts_line="serving Codeman at $(detect_tailscale_serve_url)" ;;
        connected) ts_line="connected as $(ts_node_name) ($(ts_tailnet_suffix))" ;;
        installed) ts_line="installed, not logged in" ;;
        *)         ts_line="not installed" ;;
    esac
    if [[ -d "$INSTALL_DIR/.git" ]]; then
        existing="$INSTALL_DIR${EXISTING_VERSION:+ (v$EXISTING_VERSION)}"
        if [[ "$EXISTING_FOUND" == "1" ]]; then
            existing="$existing, service binds $EXISTING_HOST${EXISTING_BASE_URL:+ under $EXISTING_BASE_URL}"
        fi
    fi
    echo -e "  ${BOLD}System${NC}      $os ($arch)${distro:+, $distro}"
    echo -e "  ${BOLD}Found${NC}       ${found:-nothing yet}"
    echo -e "  ${BOLD}Missing${NC}     ${MISSING_PKGS:-nothing}"
    echo -e "  ${BOLD}AI CLIs${NC}     ${clis:-none found}"
    echo -e "  ${BOLD}Tailscale${NC}   $ts_line"
    echo -e "  ${BOLD}Existing${NC}    $existing"
    echo ""
    return 0
}

# ----------------------------------------------------------------------------
# Phase 1: ask
# ----------------------------------------------------------------------------

# One consent for every missing system package (it used to be one prompt per
# package, each followed by its own sudo prompt), then the installs, then a
# check that proves each one is really there. The native build toolchain is a
# hard requirement on Linux, not a nicety: node-pty compiles from source there.
ask_dependencies() {
    local os="$1" distro="$2"
    [[ -n "$MISSING_PKGS" ]] || return 0
    headless_guard "install $MISSING_PKGS (system packages via sudo)"
    if ! prompt_yes_no "Install the missing pieces now ($MISSING_PKGS)?" "y"; then
        die "Codeman needs $MISSING_PKGS. Install them and re-run this installer."
    fi
    if [[ "$os" == "linux" ]]; then
        sudo_session_start
    fi
    if ! check_git; then
        CURRENT_STEP="installing git"
        install_dependency "git" "$os" "$distro"
    fi
    if ! check_node; then
        if command -v node &>/dev/null; then
            warn "Node.js $(node --version 2>/dev/null || echo unknown) is installed but version $MIN_NODE_VERSION+ is required."
        fi
        CURRENT_STEP="installing Node.js $TARGET_NODE_VERSION"
        install_dependency "node" "$os" "$distro"
        hash -r 2>/dev/null || true
    fi
    if ! check_tmux; then
        CURRENT_STEP="installing tmux"
        install_dependency "tmux" "$os" "$distro"
    fi
    if [[ "$os" == "linux" ]] && ! check_build_tools; then
        CURRENT_STEP="installing the build tools"
        install_dependency "buildtools" "$os" "$distro"
    fi
    CURRENT_STEP=""
    hash -r 2>/dev/null || true

    # Prove it, never assume it.
    check_git || die "git is still missing after the install."
    check_node || die "Node.js $MIN_NODE_VERSION+ is still missing after the install."
    check_npm || die "npm is not available. Please reinstall Node.js."
    check_tmux || die "tmux is still missing after the install (sessions live inside tmux)."
    if [[ "$os" == "linux" ]] && ! check_build_tools; then
        die "Build tools still missing after install: $(missing_build_tools). Install them manually and re-run."
    fi
    success "Dependencies installed"
    return 0
}

# Question 3 of 3. Sets LAUNCH_CHOICE (1 run now, 2 service, 3 do not start)
# and SERVICE_TYPE. Service is the default: it is what nearly every install
# wants, and Enter used to re-prompt here instead of choosing anything.
choose_launch_mode() {
    local os="$1"
    SERVICE_TYPE=""
    if [[ "$os" == "linux" ]] && [[ "$SKIP_SYSTEMD" != "1" ]] && command -v systemctl &>/dev/null; then
        SERVICE_TYPE="systemd"
    elif [[ "$os" == "macos" ]] && [[ "$SKIP_SYSTEMD" != "1" ]]; then
        SERVICE_TYPE="launchd"
    fi

    if [[ -n "$LAUNCH_PRESET" ]]; then
        LAUNCH_CHOICE="$LAUNCH_PRESET"
        if [[ "$LAUNCH_CHOICE" == "2" && -z "$SERVICE_TYPE" ]]; then
            warn "No service manager available here; Codeman will not be started (run: codeman web)."
            LAUNCH_CHOICE="3"
        fi
        return 0
    fi
    if [[ "$NONINTERACTIVE" == "1" ]] || ! has_tty; then
        LAUNCH_CHOICE="3"
        info "No interactive terminal: not starting Codeman (run 'codeman web' when ready)"
        return 0
    fi

    echo -e "  ${BOLD}3/3  Run Codeman in the background?${NC}"
    echo ""
    if [[ -n "$SERVICE_TYPE" ]]; then
        local label="a systemd service"
        [[ "$SERVICE_TYPE" == "launchd" ]] && label="a LaunchAgent"
        if prompt_yes_no "Run Codeman as $label that starts on boot?" "y"; then
            LAUNCH_CHOICE="2"
            return 0
        fi
    fi
    if prompt_yes_no "Start Codeman in this terminal when the install finishes? (Ctrl+C stops it)" "y"; then
        LAUNCH_CHOICE="1"
    else
        LAUNCH_CHOICE="3"
        info "Not starting. Later: codeman web"
    fi
    return 0
}

# ----------------------------------------------------------------------------
# Phase 2: work
# ----------------------------------------------------------------------------

install_or_update_repo() {
    if [[ -d "$INSTALL_DIR/.git" ]]; then
        info "Existing installation found at $INSTALL_DIR, updating it"
        cd "$INSTALL_DIR"
        git remote set-url origin "$REPO_URL" 2>/dev/null || true

        # Check for local changes
        if ! git diff --quiet 2>/dev/null || ! git diff --staged --quiet 2>/dev/null; then
            warn "Local changes detected in $INSTALL_DIR"
            if prompt_yes_no "Discard local changes and update?" "n"; then
                run_step "Fetching the latest Codeman" git fetch --quiet origin || exit 1
                git reset --hard "origin/$BRANCH" --quiet
            else
                info "Keeping existing installation, skipping update"
            fi
        else
            run_step "Fetching the latest Codeman" git fetch --quiet origin || exit 1
            git reset --hard "origin/$BRANCH" --quiet
        fi
    else
        # Create parent directory
        mkdir -p "$(dirname "$INSTALL_DIR")"

        # Clone repository (shallow for speed)
        run_step "Cloning Codeman" git clone --quiet --depth 1 --branch "$BRANCH" "$REPO_URL" "$INSTALL_DIR" || exit 1
        cd "$INSTALL_DIR"
    fi
    return 0
}

# Create the `codeman` symlink in a common PATH location and make sure that
# location is on PATH.
install_symlink() {
    local symlink_dir="$HOME/.local/bin"
    mkdir -p "$symlink_dir" 2>/dev/null || true
    if [[ -d "$symlink_dir" ]]; then
        ln -sf "$INSTALL_DIR/dist/index.js" "$symlink_dir/codeman"
        info "Created symlink: $symlink_dir/codeman"

        # tmux-chooser/`sc` is retired; `codeman tui` replaces it. Sweep up what
        # an older installer left behind, so an update does not leave a symlink
        # pointing at a script this version no longer ships.
        if [[ -L "$symlink_dir/tmux-chooser" ]]; then
            rm -f "$symlink_dir/tmux-chooser"
            info "Removed the retired tmux-chooser symlink (use: codeman tui)"
        fi
        remove_sc_alias

        # Add ~/.local/bin to PATH if not already there
        if [[ ":$PATH:" != *":$symlink_dir:"* ]]; then
            add_to_path "$symlink_dir"
        fi
    fi
    return 0
}

# ----------------------------------------------------------------------------
# Phase 3: done
# ----------------------------------------------------------------------------

# The environment a hand-started `codeman web` needs in order to match what
# this run chose: every non-default value, composed in ONE place so the done
# screen's Start line and the exec branch of main() cannot disagree (the Start
# line used to print a bare `codeman web` under a URL that carried a sub-path
# and a port). start_command_hint prints the line with a placeholder for the
# password; export_bind_env exports the real values for the exec.
start_command_hint() {
    local env=""
    if [[ -n "$BIND_HOST" && "$BIND_HOST" != "127.0.0.1" ]]; then
        env="CODEMAN_HOST=$BIND_HOST"
        [[ -n "$BIND_PASSWORD" ]] && env="$env CODEMAN_PASSWORD='<your-password>'"
        [[ "$BIND_ACK" == "1" ]] && env="$env CODEMAN_ALLOW_UNAUTHENTICATED_NETWORK=1"
    fi
    [[ -n "$BIND_BASE_URL" ]] && env="${env:+$env }CODEMAN_BASE_URL=$BIND_BASE_URL"
    if [[ -n "${CODEMAN_PORT:-}" && "$CODEMAN_PORT" != "3000" ]]; then
        env="${env:+$env }CODEMAN_PORT=$CODEMAN_PORT"
    fi
    printf '%s' "${env:+$env }codeman web"
}

export_bind_env() {
    if [[ -n "$BIND_HOST" ]]; then
        export CODEMAN_HOST="$BIND_HOST"
        [[ -n "$BIND_PASSWORD" ]] && export CODEMAN_PASSWORD="$BIND_PASSWORD"
        [[ "$BIND_ACK" == "1" ]] && export CODEMAN_ALLOW_UNAUTHENTICATED_NETWORK=1
    fi
    [[ -n "$BIND_BASE_URL" ]] && export CODEMAN_BASE_URL="$BIND_BASE_URL"
    [[ -n "${CODEMAN_PORT:-}" ]] && export CODEMAN_PORT
    return 0
}

# A QR code of the URL, for the phone in the user's hand. Uses the qrcode
# package Codeman itself depends on, so nothing extra is installed; skipped on
# a terminal without color support or too narrow to draw it.
print_qr() {
    local url="$1" cols qr
    [[ -n "$NC" ]] || return 0
    command -v node &>/dev/null || return 0
    [[ -d "$INSTALL_DIR/node_modules/qrcode" ]] || return 0
    cols=$(tput cols 2>/dev/null || echo 0)
    [[ "$cols" -ge 50 ]] || return 0
    qr=$(cd "$INSTALL_DIR" && node -e '
        require("qrcode").toString(process.argv[1], { type: "terminal", small: true }, (err, s) => {
            if (!err) process.stdout.write(s);
        });
    ' "$url" 2>/dev/null) || return 0
    [[ -n "$qr" ]] || return 0
    echo ""
    printf '%s\n' "$qr" | sed 's/^/    /'
    echo -e "    ${DIM}scan to open it on your phone${NC}"
    return 0
}

# The closing screen: the URL first, a QR code, how to manage the service, and
# nothing the user does not need right now. Also what `install.sh status`
# prints. $1 is the launch choice (1/2/3, or empty when nothing was launched
# by this run), $2 whether the service setup succeeded.
print_done_screen() {
    local launch="${1:-}" service_ok="${2:-}"
    local port="${CODEMAN_PORT:-3000}" base="$BIND_BASE_URL" version="" running="0"
    local unit="$HOME/.config/systemd/user/codeman-web.service"
    local agent_plist="$HOME/Library/LaunchAgents/com.codeman.web.plist"
    local daemon_plist="/Library/LaunchDaemons/com.codeman.web.plist"

    if [[ -f "$INSTALL_DIR/package.json" ]]; then
        version=$(sed -n 's/^  *"version": *"\([^"]*\)".*/\1/p' "$INSTALL_DIR/package.json" | head -1)
    fi
    codeman_answers_locally && running="1"

    # Which supervisor, when this run did not decide: whatever is on disk.
    local svc="$SERVICE_TYPE" this_run="$launch"
    if [[ -z "$launch" ]]; then
        svc=""
        if [[ -f "$unit" ]]; then svc="systemd"
        elif [[ -f "$agent_plist" ]]; then svc="launchd"
        elif [[ -f "$daemon_plist" ]]; then svc="launchd-daemon"
        fi
        launch="3"
        [[ -n "$svc" ]] && launch="2"
        service_ok="true"
    fi

    local ts_url="$TAILSCALE_SERVE_URL"
    if [[ -z "$ts_url" ]]; then
        ts_url=$(detect_tailscale_serve_url 2>/dev/null) || ts_url=""
    fi

    echo ""
    echo -e "${GREEN}${BOLD}============================================================${NC}"
    if [[ "$running" == "1" && -n "$this_run" && "$svc" == "launchd-daemon" ]]; then
        # This run built a new dist/ but left the daemon alone, so what answers
        # on the port is still the previous build.
        echo -e "${GREEN}${BOLD}  Codeman${version:+ $version} is built${NC} ${DIM}(the LaunchDaemon still runs the previous build until restarted)${NC}"
    elif [[ "$running" == "1" ]]; then
        echo -e "${GREEN}${BOLD}  Codeman${version:+ $version} is running${NC}"
    else
        echo -e "${GREEN}${BOLD}  Codeman${version:+ $version} is installed${NC} ${DIM}(not running yet)${NC}"
    fi
    echo -e "${GREEN}${BOLD}============================================================${NC}"
    echo ""

    local once="" qr_url=""
    [[ "$running" == "1" ]] || once=", once running"
    if [[ -n "$ts_url" ]]; then
        echo -e "    ${BOLD}Your tailnet${NC}    $ts_url   ${DIM}(HTTPS, any of your devices$once)${NC}"
        qr_url="$ts_url"
    fi
    if [[ "$BIND_HOST" == "0.0.0.0" ]]; then
        local lan="http://$(detect_lan_ip):$port$base"
        echo -e "    ${BOLD}Your network${NC}    $lan   ${DIM}(any device on your Wi-Fi$once)${NC}"
        [[ -n "$qr_url" ]] || qr_url="$lan"
    fi
    echo -e "    ${BOLD}This machine${NC}    http://localhost:$port$base"
    if [[ -n "$qr_url" ]]; then
        print_qr "$qr_url"
    fi
    echo ""

    if [[ "$launch" == "2" && "$service_ok" == "true" ]]; then
        case "$svc" in
            launchd)
                echo -e "    ${BOLD}Manage${NC}    ${CYAN}launchctl unload ~/Library/LaunchAgents/com.codeman.web.plist${NC}   # stop"
                echo -e "              ${CYAN}launchctl load ~/Library/LaunchAgents/com.codeman.web.plist${NC}     # start"
                echo -e "              ${CYAN}tail -f /tmp/codeman.log${NC}                                        # logs"
                echo -e "    ${DIM}A LaunchAgent starts after you log in to this Mac. For a headless Mac see the wiki (Running As A Service).${NC}"
                ;;
            launchd-daemon)
                echo -e "    ${BOLD}Manage${NC}    ${CYAN}sudo launchctl kickstart -k system/com.codeman.web${NC}   # restart (picks up a new build)"
                echo -e "              ${CYAN}sudo launchctl print system/com.codeman.web${NC}          # the LaunchDaemon that supervises it"
                ;;
            *)
                echo -e "    ${BOLD}Manage${NC}    ${CYAN}systemctl --user restart codeman-web${NC}   ${CYAN}journalctl --user -u codeman-web -f${NC}"
                ;;
        esac
    elif [[ "$launch" == "2" ]]; then
        echo -e "    ${YELLOW}${BOLD}The service was set up but is not running yet${NC} (see the warnings above)."
        echo -e "    ${DIM}You can always run it directly:${NC} ${CYAN}$(start_command_hint)${NC}"
    elif [[ "$launch" == "3" ]]; then
        echo -e "    ${BOLD}Start${NC}     ${CYAN}$(start_command_hint)${NC}"
        if [[ "$BIND_HOST" == "0.0.0.0" ]]; then
            echo -e "              ${DIM}(a bare 'codeman web' binds 127.0.0.1, this machine only)${NC}"
        elif [[ "$(start_command_hint)" == "codeman web" ]]; then
            echo -e "              ${DIM}(or: codeman web -d to detach; codeman service install for boot)${NC}"
        else
            echo -e "              ${DIM}(the same variables apply to: codeman web -d)${NC}"
        fi
    fi
    echo -e "    ${BOLD}Update${NC}    re-run the install line, or App Settings -> System -> Updates"
    echo -e "    ${BOLD}Terminal${NC}  ${CYAN}codeman tui${NC}   ${DIM}(session dashboard over SSH, e.g. from Termius)${NC}"
    echo -e "    ${BOLD}Docs${NC}      https://github.com/Ark0N/Codeman/wiki"
    if [[ -z "$ts_url" ]] && [[ "$BIND_HOST" != "0.0.0.0" ]]; then
        echo -e "    ${BOLD}Phone${NC}     ${CYAN}bash $INSTALL_DIR/install.sh tailscale${NC}   ${DIM}(HTTPS on your tailnet, recommended)${NC}"
    fi
    if check_cloudflared; then
        echo -e "    ${BOLD}Tunnel${NC}    ${CYAN}$INSTALL_DIR/scripts/tunnel.sh start${NC}   ${DIM}(Cloudflare, public URL: set CODEMAN_PASSWORD first)${NC}"
    fi
    echo ""

    detect_all_clis
    if [[ "$CLI_FOUND_COUNT" -eq 0 ]]; then
        echo -e "  ${YELLOW}${BOLD}Reminder:${NC} Install at least one AI CLI to start using Codeman:"
        cli_catalog_print_install_hints
        echo ""
    fi
    return 0
}

update() {
    if [[ ! -d "$INSTALL_DIR/.git" ]]; then
        die "Codeman is not installed at $INSTALL_DIR. Run the installer first."
    fi

    info "Updating Codeman..."
    INSTALL_STARTED="1"
    cd "$INSTALL_DIR"
    git remote set-url origin "$REPO_URL" 2>/dev/null || true

    # Never blow away local changes silently (this used to be an unconditional
    # reset --hard). Interactive users get a choice; headless runs auto-stash
    # so the changes stay recoverable, the same policy as scripts/self-update.sh.
    if ! git diff --quiet 2>/dev/null || ! git diff --staged --quiet 2>/dev/null; then
        warn "Local changes detected in $INSTALL_DIR"
        if prompt_yes_no "Stash local changes and update? (recover with: git stash pop)"; then
            git stash push --quiet -m "codeman-installer auto-stash $(date -u +%Y-%m-%dT%H:%M:%SZ)"
            info "Local changes stashed (see 'git stash list' in $INSTALL_DIR)"
        else
            info "Keeping local changes; update skipped."
            return 0
        fi
    fi

    run_step "Fetching the latest Codeman" git fetch --quiet origin || exit 1
    git reset --hard "origin/$BRANCH" --quiet
    npm_install_deps
    run_step "Building Codeman" npm run build || exit 1
    date -u +%Y-%m-%dT%H:%M:%SZ > "$INSTALL_DIR/.install-complete"
    success "Updated to $(node -e "console.log(require('./package.json').version)")"
    echo ""

    # Auto-restart service if running, otherwise tell the user
    local agent_plist="$HOME/Library/LaunchAgents/com.codeman.web.plist"
    if systemctl --user is-active codeman-web.service &>/dev/null 2>&1; then
        info "Restarting codeman-web service..."
        systemctl --user restart codeman-web.service 2>/dev/null || true
        if verify_systemd_active; then
            success "codeman-web service restarted"
        else
            warn "codeman-web.service did not come back up."
            warn "Inspect: systemctl --user status codeman-web ; journalctl --user -u codeman-web -e"
        fi
    elif [[ -f "$agent_plist" ]]; then
        info "Restarting LaunchAgent..."
        launchctl unload "$agent_plist" 2>/dev/null || true
        launchctl load "$agent_plist" 2>/dev/null || true
        success "LaunchAgent restarted"
    elif [[ -f "/Library/LaunchDaemons/com.codeman.web.plist" ]]; then
        # Left alone on purpose (see setup_launchd_service); it keeps running
        # the previous build until its owner restarts it.
        info "A system LaunchDaemon supervises Codeman; restart it to run the new build:"
        echo -e "    ${CYAN}sudo launchctl kickstart -k system/com.codeman.web${NC}"
    else
        echo -e "  ${DIM}Restart codeman web to use the new version:${NC}"
        echo -e "    ${CYAN}codeman web --stop; codeman web -d${NC}"
    fi
    echo ""

    # Reflect the service's actual binding in the closing notice. Updates
    # never rewrite the service files, so the existing choice is authoritative.
    read_existing_binding
    if [[ "$EXISTING_FOUND" == "1" ]]; then
        BIND_HOST="$EXISTING_HOST"
        BIND_PASSWORD="$EXISTING_PASSWORD"
        BIND_ACK="$EXISTING_ACK"
        BIND_BASE_URL="$EXISTING_BASE_URL"
    fi

    # An update is the only place a half-configured install gets a second
    # chance at remote access; the fresh-install path asks outright.
    maybe_offer_tailscale_repair

    # The re-run is how everyone updates, and the first thing people try when
    # they want the URL back: end on the same screen the install ends on.
    print_done_screen "" ""
    print_security_notice
}

uninstall() {
    print_banner
    info "Uninstalling Codeman..."
    echo ""

    # Stop and remove systemd services (Linux)
    for svc in codeman-web codeman-tunnel; do
        if systemctl --user is-active "${svc}.service" &>/dev/null 2>&1; then
            info "Stopping ${svc} service..."
            systemctl --user stop "${svc}.service"
        fi
        if systemctl --user is-enabled "${svc}.service" &>/dev/null 2>&1; then
            info "Disabling ${svc} service..."
            systemctl --user disable "${svc}.service" 2>/dev/null || true
        fi
        local svc_file="$HOME/.config/systemd/user/${svc}.service"
        if [[ -f "$svc_file" ]]; then
            rm -f "$svc_file"
            success "Removed ${svc} service"
        fi
    done
    systemctl --user daemon-reload 2>/dev/null || true

    # Stop and remove launchd services (macOS)
    local agent_plist="$HOME/Library/LaunchAgents/com.codeman.web.plist"
    local daemon_plist="/Library/LaunchDaemons/com.codeman.web.plist"
    if [[ -f "$agent_plist" ]]; then
        launchctl unload "$agent_plist" 2>/dev/null || true
        rm -f "$agent_plist"
        success "Removed LaunchAgent"
    fi
    if [[ -f "$daemon_plist" ]]; then
        # This installer never writes a LaunchDaemon (setup_launchd_service
        # leaves one alone), so this one is the user's own headless-Mac setup:
        # ask before touching it. The default stays yes, because a daemon left
        # pointing at a removed install restarts into failure every 10 s.
        warn "A system LaunchDaemon supervises Codeman ($daemon_plist); this installer did not write it."
        if prompt_yes_no "Remove that LaunchDaemon too (needs sudo)?" "y"; then
            sudo launchctl unload "$daemon_plist" 2>/dev/null || true
            sudo rm -f "$daemon_plist"
            success "Removed LaunchDaemon"
        else
            info "Kept $daemon_plist. Remove it later with: sudo launchctl unload $daemon_plist && sudo rm $daemon_plist"
        fi
    fi

    # Remove OUR tailscale serve mapping (whatever shape it has) only. Other
    # serve config stays untouched, and never `tailscale serve reset`.
    local ts_url=""
    ts_url=$(detect_tailscale_serve_url 2>/dev/null) || ts_url=""
    if [[ -n "$ts_url" ]]; then
        if prompt_yes_no "Remove the Tailscale serve mapping for Codeman ($ts_url)?" "y"; then
            if tailscale_remove_our_mapping 2>/dev/null; then
                success "Removed tailscale serve mapping"
            else
                warn "Could not remove it automatically. Inspect: tailscale serve status"
            fi
        fi
    fi

    # A rename this installer performed is offered back; the record is dropped
    # either way once it no longer describes the machine.
    if [[ -f "$TS_RENAME_RECORD" ]] && check_tailscale && command -v node &>/dev/null; then
        local ts_orig ts_cur ts_now
        ts_orig=$(sed -n 's/^original=//p' "$TS_RENAME_RECORD" | head -1)
        ts_cur=$(sed -n 's/^current=//p' "$TS_RENAME_RECORD" | head -1)
        ts_now=$(ts_node_name)
        if [[ -n "$ts_orig" && -n "$ts_now" && "$ts_now" == "$ts_cur" ]]; then
            if prompt_yes_no "Rename this machine back to $ts_orig on your tailnet?" "y"; then
                if ts_cmd_serve set --hostname "$ts_orig" 2>/dev/null; then
                    success "Renamed back to $ts_orig"
                    rm -f "$TS_RENAME_RECORD"
                else
                    warn "Could not rename it back. Run: sudo tailscale set --hostname $ts_orig"
                fi
            fi
        else
            rm -f "$TS_RENAME_RECORD"
        fi
    fi

    # Remove symlinks
    local symlink_dir="$HOME/.local/bin"
    if [[ -L "$symlink_dir/codeman" ]]; then
        rm -f "$symlink_dir/codeman"
        success "Removed symlink: $symlink_dir/codeman"
    fi
    if [[ -L "$symlink_dir/tmux-chooser" ]]; then
        rm -f "$symlink_dir/tmux-chooser"
        success "Removed symlink: $symlink_dir/tmux-chooser"
    fi
    remove_sc_alias

    # Remove install directory
    if [[ -d "$INSTALL_DIR" ]]; then
        if prompt_yes_no "Remove installation directory ($INSTALL_DIR)?"; then
            rm -rf "$INSTALL_DIR"
            success "Removed $INSTALL_DIR"
        else
            # Clear the marker so a future installer run does full setup again
            # (the symlinks and services being removed here need recreating).
            rm -f "$INSTALL_DIR/.install-complete"
            info "Kept $INSTALL_DIR"
        fi
    fi

    # Ask about data directory
    local data_dir="$HOME/.codeman"
    if [[ -d "$data_dir" ]]; then
        warn "Data directory exists at $data_dir (contains sessions, settings, state)"
        if prompt_yes_no "Remove data directory ($data_dir)?" "n"; then
            rm -rf "$data_dir"
            success "Removed $data_dir"
        else
            info "Kept $data_dir"
        fi
    fi

    echo ""
    success "Codeman uninstalled."
    echo ""
    echo -e "  ${DIM}Note: Shell profile entries (PATH, sc alias) were not removed.${NC}"
    echo -e "  ${DIM}You can remove them manually from $(detect_shell_profile)${NC}"
    echo ""
}

usage() {
    cat << 'EOF'
Codeman installer

  curl -fsSL https://getcodeman.com/install | bash
  curl -fsSL https://getcodeman.com/install | bash -s -- [flags] [subcommand]

Flags
  --tailscale | --lan | --local   How the dashboard is reached (question 1)
  --name <n> | --no-rename        Rename this machine on the tailnet / never ask (question 2)
  --service | --run | --no-start  What to do at the end (question 3)
  --yes, -y                       Take every default; still waits on a Tailscale login URL
  --password <p>                  Dashboard password (visible in ps; prefer CODEMAN_PASSWORD)
  --port <n>                      Port Codeman listens on (default 3000)
  --help, -h                      This text

Subcommands
  update        Update an existing install
  uninstall     Remove services, symlinks and (optionally) data
  tailscale     Set up (or repair) Tailscale HTTPS access for an existing install
  name [<n>]    Rename this machine on your tailnet (default: codeman-<hostname>)
  status        Print the URLs, the QR code and how to manage the service
  cloudflared   Install cloudflared for the in-app Cloudflare tunnel

Environment: CODEMAN_NONINTERACTIVE=1, CODEMAN_INSTALL_DIR, CODEMAN_HOST,
CODEMAN_PASSWORD, CODEMAN_PORT, CODEMAN_TAILSCALE=1, CODEMAN_TAILSCALE_NAME,
CODEMAN_SKIP_SYSTEMD=1, CODEMAN_NODE_VERSION, CODEMAN_REPO_URL, CODEMAN_BRANCH.
EOF
}

# Flags set the same variables their environment-variable twins do, so every
# function below reads one source of truth. A flag that changes how an existing
# install is reached or run also flips RECONFIGURE, so a bare re-run takes the
# full flow (which re-asks nothing the flag already answered) instead of the
# quiet update. A password or a port lives in the unit, so those two reconfigure
# as well: the quiet update never rewrites the unit and used to drop them
# silently.
parse_flags() {
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --tailscale)   CODEMAN_TAILSCALE=1; CODEMAN_HOST=""; RECONFIGURE="1" ;;
            --lan)         CODEMAN_HOST="0.0.0.0"; CODEMAN_TAILSCALE=0; RECONFIGURE="1" ;;
            --local)       CODEMAN_HOST="127.0.0.1"; CODEMAN_TAILSCALE=0; RECONFIGURE="1" ;;
            --name)
                shift
                [[ $# -gt 0 ]] || die "--name needs a value (e.g. --name codeman-$(hostname -s 2>/dev/null || echo box))"
                TS_NAME="$1"; RECONFIGURE="1" ;;
            --name=*)      TS_NAME="${1#--name=}"; RECONFIGURE="1" ;;
            --no-rename)   TS_NO_RENAME="1" ;;
            --service)     LAUNCH_PRESET="2"; RECONFIGURE="1" ;;
            --run)         LAUNCH_PRESET="1"; RECONFIGURE="1" ;;
            --no-start)    LAUNCH_PRESET="3" ;;
            --yes|-y)      ASSUME_YES="1" ;;
            --password)
                shift
                [[ $# -gt 0 ]] || die "--password needs a value"
                CODEMAN_PASSWORD="$1"; RECONFIGURE="1" ;;
            --password=*)  CODEMAN_PASSWORD="${1#--password=}"; RECONFIGURE="1" ;;
            --port)
                shift
                [[ $# -gt 0 ]] || die "--port needs a value"
                CODEMAN_PORT="$1"; export CODEMAN_PORT; RECONFIGURE="1" ;;
            --port=*)      CODEMAN_PORT="${1#--port=}"; export CODEMAN_PORT; RECONFIGURE="1" ;;
            --help|-h)     usage; exit 0 ;;
            update|uninstall|tailscale|name|status|cloudflared)
                [[ -z "$SUBCOMMAND" ]] || die "Only one subcommand at a time ($SUBCOMMAND and $1 given)."
                SUBCOMMAND="$1" ;;
            -*)            die "Unknown option: $1 (see --help)" ;;
            *)
                if [[ "$SUBCOMMAND" == "name" && -z "$SUBCOMMAND_ARG" ]]; then
                    SUBCOMMAND_ARG="$1"
                else
                    die "Unexpected argument: $1 (see --help)"
                fi ;;
        esac
        shift
    done
    if [[ -n "${CODEMAN_PORT:-}" ]] && ! [[ "$CODEMAN_PORT" =~ ^[0-9]+$ && "$CODEMAN_PORT" -ge 1 && "$CODEMAN_PORT" -le 65535 ]]; then
        die "Invalid port: $CODEMAN_PORT"
    fi
    return 0
}

# Sourcing guard: let the test harness load this file for its pure helpers
# without running an install. bash 3.2 cannot be exercised any other way from
# CI — see .github/workflows/ci.yml and test/install-sh-invariants.test.ts.
if [[ -n "${CODEMAN_INSTALL_SH_LIB:-}" ]]; then return 0 2>/dev/null || exit 0; fi

# Wrap in main to prevent partial execution on curl | bash
parse_flags "$@"
case "$SUBCOMMAND" in
    update)      update ;;
    uninstall)   uninstall ;;
    tailscale)   setup_tailscale_subcommand ;;
    name)        setup_name_subcommand ;;
    status)      status_subcommand ;;
    cloudflared) cloudflared_subcommand ;;
    *)
        # Only a COMPLETED install re-runs as a quiet update. A partial one
        # (clone succeeded but build/menu never finished) lacks the marker and
        # re-runs the full flow, so a failed first attempt can actually finish.
        # A flag that changes the setup (--tailscale, --service, ...) also takes
        # the full flow: that is what the flag is for.
        if [[ "$RECONFIGURE" != "1" && -d "$INSTALL_DIR/.git" && -f "$INSTALL_DIR/.install-complete" ]]; then
            print_banner
            update
        else
            main
        fi
        ;;
esac
