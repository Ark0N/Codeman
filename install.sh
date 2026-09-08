#!/usr/bin/env bash
# Codeman Universal Installer
# https://github.com/Ark0N/Codeman
#
# Usage: curl -fsSL https://raw.githubusercontent.com/Ark0N/Codeman/master/install.sh | bash
#
# Environment variables:
#   CODEMAN_NONINTERACTIVE=1  - Skip all prompts and accept their defaults
#                               (CI/automation). Required for headless runs
#                               that need system changes (sudo package
#                               installs, AI CLI download); without it those
#                               steps abort instead of running silently.
#   CODEMAN_INSTALL_DIR       - Custom install directory (default: ~/.codeman/app)
#   CODEMAN_SKIP_SYSTEMD=1    - Skip systemd/launchd service setup prompt
#   CODEMAN_NODE_VERSION      - Node.js major version to install (default: 22)
#   CODEMAN_REPO_URL          - Custom git repository URL (default: upstream Codeman)
#   CODEMAN_BRANCH            - Git branch to install (default: master)
#   CODEMAN_HOST              - Preset the network binding and skip the prompt
#                               (e.g. 0.0.0.0 for LAN access, 127.0.0.1 for
#                               local-only; interactive default is 0.0.0.0,
#                               non-interactive default is 127.0.0.1)
#   CODEMAN_PASSWORD          - Preset the dashboard password (skips the
#                               password prompt when binding to the network)
#   CODEMAN_TAILSCALE=1       - Preset the Tailscale choice: bind loopback and
#                               front it with `tailscale serve` HTTPS (skips
#                               the network prompt; never installs Tailscale
#                               in non-interactive runs)
#
# Subcommands:
#   install.sh update     - Update an existing install
#   install.sh uninstall  - Remove services, symlinks and (optionally) data
#   install.sh tailscale  - Set up (or repair) Tailscale serve HTTPS access
#                           for an existing install

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
# (setup_tailscale_access / detect_tailscale_serve_url). Empty when the
# Tailscale path was not taken or not completed.
TAILSCALE_SERVE_URL=""
# Set to 1 when serve commands must go through sudo because granting the user
# tailscale "operator" rights failed (ensure_tailscale_operator).
TS_NEED_ROOT="0"

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
CLI_KIND=('agent' 'shell' 'agent' 'agent' 'agent' 'agent' 'agent' 'agent' 'agent' 'agent')
CLI_NPM=('@anthropic-ai/claude-code' '' 'opencode-ai' '@openai/codex' '@google/gemini-cli' '' '@earendil-works/pi-coding-agent' '' '@deepseek-ai/dsh' '')
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
        echo -e "    The dashboard is reachable from your network at port 3000 and is"
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

cleanup() {
    local exit_code=$?
    if [[ $exit_code -ne 0 ]]; then
        error "Installation failed. Partial installation may remain at $INSTALL_DIR"
        error "To retry, run the installer again or remove the directory manually."
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
        missing="${missing:+$missing, }a C++ compiler (g++)"
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

# Index of "$1" in CLI_IDS -> CLI_IDX, returning 1 with CLI_IDX=-1 when unknown.
# A global rather than an echo because this runs inside loops, and a subshell per
# lookup is a fork per CLI per call site.
CLI_IDX=-1
_cli_index() {
    local want="$1" i
    CLI_IDX=-1
    for ((i = 0; i < ${#CLI_IDS[@]}; i++)); do
        if [[ "${CLI_IDS[$i]}" == "$want" ]]; then
            CLI_IDX=$i
            return 0
        fi
    done
    return 1
}

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
# nobody should be performing on a security-adjacent check. The parity test pins
# that the registry still demands "DeepSeek Harness", so an upstream banner
# change fails a test instead of silently mis-detecting here.
_cli_candidate_ok() {
    case "$1" in
        deepseek) dsh_banner_probe "$2" ;;
        *) return 0 ;;
    esac
}

# Resolve every CLI in ONE pass, memoized.
#
# CLI_FOUND_PATH is parallel to CLI_IDS ('' when not found). CLI_FOUND_COUNT
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

# Is this CLI installed? Unknown id is "no", never an error.
check_cli() {
    detect_all_clis
    _cli_index "$1" || return 1
    [[ -n "${CLI_FOUND_PATH[$CLI_IDX]}" ]]
}

# Where it was found, or nothing.
get_cli_path() {
    detect_all_clis
    _cli_index "$1" || return 1
    printf '%s\n' "${CLI_FOUND_PATH[$CLI_IDX]}"
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
# and this hint falls through to the docs URL instead.
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
        fi
    done
}

# Resolved at load, not lazily: every element of CLI_INSTALL_CMD_TRUSTED has to
# exist before anything indexes it, or `set -u` aborts on an unset array element
# the first time a hint is printed.
cli_catalog_select_platform


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

    if [[ "$NONINTERACTIVE" == "1" ]] || ! has_tty; then
        # Non-interactive, use default
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

# Best-effort LAN IP for "open this URL from your phone" hints.
detect_lan_ip() {
    local ip=""
    if [[ "$(uname -s)" == "Darwin" ]]; then
        ip=$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || true)
    else
        ip=$(hostname -I 2>/dev/null | awk '{print $1}')
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
# ran loopback (the server default), so it reports 127.0.0.1.
read_existing_binding() {
    EXISTING_FOUND="0"; EXISTING_HOST=""; EXISTING_PASSWORD=""; EXISTING_ACK="0"
    local unit="$HOME/.config/systemd/user/codeman-web.service"
    local plist="$HOME/Library/LaunchAgents/com.codeman.web.plist"

    if [[ -f "$unit" ]]; then
        EXISTING_FOUND="1"
        EXISTING_HOST=$(sed -n 's/^Environment=CODEMAN_HOST=//p' "$unit" | head -1)
        local pwline
        pwline=$(sed -n 's/^Environment="CODEMAN_PASSWORD=\(.*\)"$/\1/p' "$unit" | head -1)
        [[ -n "$pwline" ]] && EXISTING_PASSWORD=$(systemd_env_unescape "$pwline")
        grep -q '^Environment=CODEMAN_ALLOW_UNAUTHENTICATED_NETWORK=1' "$unit" && EXISTING_ACK="1"
    elif [[ -f "$plist" ]]; then
        EXISTING_FOUND="1"
        EXISTING_HOST=$(awk '/<key>CODEMAN_HOST<\/key>/{getline; print}' "$plist" | sed -n 's/.*<string>\(.*\)<\/string>.*/\1/p')
        local pwraw
        pwraw=$(awk '/<key>CODEMAN_PASSWORD<\/key>/{getline; print}' "$plist" | sed -n 's/.*<string>\(.*\)<\/string>.*/\1/p')
        [[ -n "$pwraw" ]] && EXISTING_PASSWORD=$(xml_unescape "$pwraw")
        grep -q '<key>CODEMAN_ALLOW_UNAUTHENTICATED_NETWORK</key>' "$plist" && EXISTING_ACK="1"
    fi

    if [[ "$EXISTING_FOUND" == "1" && -z "$EXISTING_HOST" ]]; then
        EXISTING_HOST="127.0.0.1"
    fi
    return 0
}

# Ask how the dashboard should be reachable and set BIND_HOST/BIND_PASSWORD/
# BIND_ACK. Interactive default is network access (0.0.0.0) because that is
# what most installs need; loopback is offered as the safer alternative.
# Non-interactive runs keep the safe loopback default unless CODEMAN_HOST is
# preset. The server binary itself still defaults to 127.0.0.1 either way.
choose_network_binding() {
    # Preset via environment: honor it and skip the prompt entirely.
    # CODEMAN_TAILSCALE=1 composes with a loopback (or absent) CODEMAN_HOST.
    if [[ -n "${CODEMAN_HOST:-}" ]]; then
        BIND_HOST="$CODEMAN_HOST"
        BIND_PASSWORD="${CODEMAN_PASSWORD:-}"
        if [[ "$BIND_HOST" != "127.0.0.1" && -z "$BIND_PASSWORD" ]]; then
            BIND_ACK="1"
        fi
        info "Network binding preset via CODEMAN_HOST: $BIND_HOST"
        if [[ "${CODEMAN_TAILSCALE:-0}" == "1" ]]; then
            if [[ "$BIND_HOST" == "127.0.0.1" ]]; then
                setup_tailscale_access || true
            else
                warn "CODEMAN_TAILSCALE=1 ignored: CODEMAN_HOST=$BIND_HOST is not loopback."
            fi
        fi
        return 0
    fi
    if [[ "${CODEMAN_TAILSCALE:-0}" == "1" ]]; then
        BIND_HOST="127.0.0.1"
        BIND_PASSWORD="${CODEMAN_PASSWORD:-}"
        info "Tailscale access preset via CODEMAN_TAILSCALE=1"
        setup_tailscale_access || true
        return 0
    fi

    # A previous install's choice is the baseline: re-installing must never
    # silently loosen it.
    read_existing_binding

    if [[ "$NONINTERACTIVE" == "1" ]] || ! has_tty; then
        if [[ "$EXISTING_FOUND" == "1" ]]; then
            BIND_HOST="$EXISTING_HOST"
            BIND_PASSWORD="$EXISTING_PASSWORD"
            BIND_ACK="$EXISTING_ACK"
            info "Non-interactive install: preserving existing binding ($BIND_HOST)"
        else
            BIND_HOST="127.0.0.1"
            info "Non-interactive install: binding 127.0.0.1 (preset CODEMAN_HOST=0.0.0.0 to override)"
        fi
        return 0
    fi

    # Tailscale state, for the menu hint and the default choice. Detection
    # only; never installs, logs in, or prompts for sudo here.
    local ts_hint="will be installed for you" ts_ready="0" ts_detected_url=""
    if check_tailscale; then
        ts_hint="installed, needs login"
        if command -v node &>/dev/null && [[ "$(ts_status_field 's.BackendState')" == "Running" ]]; then
            ts_ready="1"
            ts_hint="already connected"
            ts_detected_url=$(detect_tailscale_serve_url) || ts_detected_url=""
            if [[ -n "$ts_detected_url" ]]; then
                ts_hint="already serving Codeman"
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

    echo -e "  ${BOLD}Network access${NC}"
    echo ""
    echo -e "  How should the Codeman dashboard be reachable?"
    echo ""
    echo -e "    ${CYAN}1)${NC} ${BOLD}Tailscale${NC} ${DIM}($ts_hint)${NC}"
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
    while true; do
        echo -en "${CYAN}Choose [1/2/3] (default $default_choice):${NC} " >&2
        read_reply bind_choice || bind_choice="$default_choice"
        bind_choice="${bind_choice:-$default_choice}"
        case "$bind_choice" in
            1|2|3) break ;;
            *) echo "Please enter 1, 2, or 3." >&2 ;;
        esac
    done

    if [[ "$bind_choice" == "3" ]]; then
        BIND_HOST="127.0.0.1"
        success "Binding 127.0.0.1 (this machine only)"
        return 0
    fi

    if [[ "$bind_choice" == "1" ]]; then
        BIND_HOST="127.0.0.1"
        setup_tailscale_access || true

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
            if prompt_yes_no "Continue WITHOUT a password?" "n"; then
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
# Safety rule for every function here: NEVER `tailscale serve reset` and never
# touch mappings other than 443 -> Codeman's port. Users may have unrelated
# serve config (other ports, other apps) that a reset would destroy.

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

# Print the local port that the :443 web handler proxies to, empty when 443 is
# unconfigured. Any scheme counts (http://, and https+insecure:// from setups
# where Codeman itself runs --https), so legacy configs are recognized as ours.
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

# Print https://<node>.<tailnet>.ts.net when tailscale is running AND serve
# already forwards 443 to Codeman's port; print nothing otherwise. Safe to call
# anywhere (no sudo, no side effects); used by the security notice, uninstall,
# and the re-run default.
detect_tailscale_serve_url() {
    check_tailscale || return 0
    command -v node &>/dev/null || return 0
    [[ "$(ts_status_field 's.BackendState')" == "Running" ]] || return 0
    local port="${CODEMAN_PORT:-3000}"
    [[ "$(ts_serve_443_target_port)" == "$port" ]] || return 0
    local dns
    dns=$(ts_status_field 's.Self && s.Self.DNSName')
    [[ -n "$dns" ]] || return 0
    echo "https://${dns%.}"
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
            if ! prompt_yes_no "Continue once Tailscale is installed?" "n"; then
                return 1
            fi
        fi
    else
        if ! prompt_yes_no "Tailscale is not installed. Install it now (official installer from tailscale.com)?" "y"; then
            return 1
        fi
        info "Running the official Tailscale installer (it may ask for sudo)..."
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
    state=$(ts_status_field 's.BackendState')
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
    [[ "$(ts_status_field 's.BackendState')" == "Running" ]]
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
    info "Granting your user Tailscale 'operator' rights (one-time sudo; lets serve run without root)..."
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
# them instead of degrading.
ensure_tailnet_https() {
    while true; do
        local magic cert
        magic=$(ts_status_field 's.CurrentTailnet && s.CurrentTailnet.MagicDNSEnabled ? "1" : ""')
        cert=$(ts_status_field 'Array.isArray(s.CertDomains) && s.CertDomains.length > 0 ? "1" : ""')
        if [[ "$magic" == "1" && "$cert" == "1" ]]; then
            return 0
        fi
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
        if ! prompt_yes_no "Re-check now? (answering no skips Tailscale setup)" "y"; then
            return 1
        fi
    done
}

setup_tailscale_serve() {
    local port="${CODEMAN_PORT:-3000}"
    local dns url existing
    dns=$(ts_status_field 's.Self && s.Self.DNSName')
    if [[ -z "$dns" ]]; then
        warn "Could not determine this machine's tailnet DNS name."
        return 1
    fi
    url="https://${dns%.}"

    existing=$(ts_serve_443_target_port)
    if [[ "$existing" == "$port" ]]; then
        TAILSCALE_SERVE_URL="$url"
        success "Tailscale serve already forwards $url to port $port (kept as-is)"
        return 0
    fi
    if [[ -n "$existing" ]]; then
        warn "tailscale serve already forwards $url (port 443) to local port $existing."
        if ! prompt_yes_no "Replace that mapping with Codeman (port $port)?" "n"; then
            info "Keeping the existing mapping."
            return 1
        fi
    fi

    info "Configuring: tailscale serve --bg $port"
    local serve_out
    if serve_out=$(ts_cmd_serve serve --bg "$port" 2>&1); then
        TAILSCALE_SERVE_URL="$url"
        success "Tailscale HTTPS enabled: $url"
        echo -e "  ${DIM}(persists across reboots; inspect with: tailscale serve status)${NC}"
        return 0
    fi
    warn "tailscale serve failed:"
    printf '%s\n' "$serve_out" | sed 's/^/    /' >&2
    return 1
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
    info "Verifying $TAILSCALE_SERVE_URL (first load can take ~30s while the HTTPS certificate is issued)..."
    local i http_code
    for ((i = 1; i <= 10; i++)); do
        http_code=$(curl -skm 10 -o /dev/null -w '%{http_code}' "$TAILSCALE_SERVE_URL/api/status" 2>/dev/null) || http_code=""
        if [[ "$http_code" == "200" || "$http_code" == "401" ]]; then
            success "Reachable: $TAILSCALE_SERVE_URL"
            return 0
        fi
        sleep 3
    done
    warn "Could not reach $TAILSCALE_SERVE_URL/api/status yet."
    warn "It may need another minute (certificate issuance). Inspect: tailscale serve status"
    warn "If Codeman itself runs with --https, the serve target must be:"
    warn "  tailscale serve --bg https+insecure://localhost:${CODEMAN_PORT:-3000}"
    return 1
}

# Orchestrator: walk every state (not installed -> logged out -> operator ->
# tailnet HTTPS -> serve) and end with TAILSCALE_SERVE_URL set, or fall back
# gracefully (the caller keeps the loopback bind either way).
setup_tailscale_access() {
    TAILSCALE_SERVE_URL=""
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
    if ! setup_tailscale_serve; then
        tailscale_retrofit_hint "tailscale serve could not be configured"
        return 1
    fi
    return 0
}

# A loopback install with Tailscale already connected but nothing fronting
# Codeman is one command away from working remote access — and that is exactly
# where a user lands when the first install died BEFORE the network-access
# prompt (it runs after the build, so any build failure costs the network step
# too) or when they finished a broken build by hand instead of re-running the
# installer. Detect that state on re-run and offer the retrofit, rather than
# leaving them to discover `install.sh tailscale` on their own. Never nags a
# deliberate network bind, and never nags once a serve mapping already exists.
maybe_offer_tailscale_repair() {
    # A non-loopback bind already has network access; leave that choice alone.
    if [[ "$EXISTING_FOUND" == "1" && -n "$EXISTING_HOST" && "$EXISTING_HOST" != "127.0.0.1" ]]; then
        return 0
    fi
    check_tailscale || return 0
    command -v node &>/dev/null || return 0
    [[ "$(ts_status_field 's.BackendState')" == "Running" ]] || return 0
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
        verify_tailscale_access || true
    fi
    return 0
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

    if ! setup_tailscale_access; then
        exit 1
    fi

    # Verify end-to-end only when Codeman is actually answering locally.
    local port="${CODEMAN_PORT:-3000}" server_up="0"
    if command -v curl &>/dev/null; then
        if curl -skm 5 -o /dev/null "http://127.0.0.1:$port/api/status" 2>/dev/null ||
            curl -skm 5 -o /dev/null "https://127.0.0.1:$port/api/status" 2>/dev/null; then
            server_up="1"
        fi
    fi
    if [[ "$server_up" == "1" ]]; then
        verify_tailscale_access || true
    else
        info "Codeman does not appear to be running on port $port right now."
        info "Once it is, open: $TAILSCALE_SERVE_URL"
    fi

    BIND_HOST="${EXISTING_HOST:-127.0.0.1}"
    BIND_PASSWORD="$EXISTING_PASSWORD"
    print_security_notice
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

    # Remove any existing LaunchDaemon (system-level) to prevent duplicates.
    # We standardize on LaunchAgent (user-level) — it doesn't require sudo,
    # inherits the user's environment, and is the correct choice for user apps.
    if [[ -f "$daemon_plist" ]]; then
        warn "Found system-level LaunchDaemon at $daemon_plist — removing to prevent duplicate"
        sudo launchctl unload "$daemon_plist" 2>/dev/null || true
        sudo rm -f "$daemon_plist"
        success "Removed duplicate LaunchDaemon"
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

    # Binding chosen during install (empty on paths that never asked)
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

    # Binding chosen during install (empty on paths that never asked)
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
npm_install_deps() {
    if npm install --quiet --no-fund --no-audit 2>/dev/null; then
        return 0
    fi
    if npm install --no-fund --no-audit; then
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

    info "Detected: $os ($arch)${distro:+ - $distro}"
    echo ""

    # ========================================================================
    # Check/Install Dependencies
    # ========================================================================

    # Git
    info "Checking Git..."
    if ! check_git; then
        headless_guard "install Git (system package via sudo)"
        if prompt_yes_no "Git is not installed. Install it now?"; then
            install_dependency "git" "$os" "$distro"
        else
            die "Git is required to install Codeman."
        fi
    else
        success "Git is installed"
    fi

    # Node.js
    info "Checking Node.js (v$MIN_NODE_VERSION+)..."
    if ! check_node; then
        local node_version=""
        if command -v node &>/dev/null; then
            node_version=$(node --version 2>/dev/null || echo "unknown")
            warn "Node.js $node_version is installed but version $MIN_NODE_VERSION+ is required."
        fi

        headless_guard "install Node.js v$TARGET_NODE_VERSION (system package via sudo)"
        if prompt_yes_no "Install Node.js v$TARGET_NODE_VERSION?"; then
            install_dependency "node" "$os" "$distro"

            # Rehash to pick up new node
            hash -r 2>/dev/null || true
        else
            die "Node.js $MIN_NODE_VERSION+ is required to run Codeman."
        fi
    else
        local node_ver
        node_ver=$(node --version 2>/dev/null)
        success "Node.js $node_ver is installed"
    fi

    # Verify npm (should come with Node.js)
    if ! check_npm; then
        die "npm is not available. Please reinstall Node.js."
    fi

    # Terminal multiplexer (tmux required)
    info "Checking tmux..."
    if check_tmux; then
        success "tmux is installed"
    else
        headless_guard "install tmux (system package via sudo)"
        if prompt_yes_no "tmux is not installed. Install it now?"; then
            install_dependency "tmux" "$os" "$distro"
        else
            die "tmux is required for session persistence."
        fi
    fi

    # Native build toolchain. node-pty compiles from source on Linux, so this is
    # a hard requirement there, not a nicety.
    if [[ "$os" == "linux" ]]; then
        info "Checking build tools (node-pty compiles from source on Linux)..."
        local missing_tools
        missing_tools="$(missing_build_tools)"
        if [[ -z "$missing_tools" ]]; then
            success "Build tools are installed"
        else
            warn "Missing build tools: $missing_tools"
            headless_guard "install build tools (system package via sudo)"
            if prompt_yes_no "Install the build tools now?"; then
                install_dependency "buildtools" "$os" "$distro"
                hash -r 2>/dev/null || true
                missing_tools="$(missing_build_tools)"
                if [[ -n "$missing_tools" ]]; then
                    die "Build tools still missing after install: $missing_tools. Install them manually and re-run."
                fi
                success "Build tools installed"
            else
                die "A build toolchain (make, g++, python3) is required: node-pty has no Linux prebuilds and compiles from source."
            fi
        fi
    fi

    # AI CLI. Codeman drives one of the CLIs in the generated catalogue above;
    # this used to be a hand-written list here, in the gate below, and in the
    # closing reminder — three places that had to agree and did not (the comment
    # itself named six of the nine).
    info "Checking AI CLI tools..."
    detect_all_clis
    local i
    for ((i = 0; i < ${#CLI_IDS[@]}; i++)); do
        [[ "${CLI_ENABLED[$i]}" == "1" ]] || continue
        [[ "${CLI_BIN_LEN[$i]}" -gt 0 ]] || continue
        if [[ -n "${CLI_FOUND_PATH[$i]}" ]]; then
            success "${CLI_LABELS[$i]} found at ${CLI_FOUND_PATH[$i]}"
        fi
    done

    if [[ "$CLI_FOUND_COUNT" -eq 0 ]]; then
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
                # Explicit automation opt-in: default to the first offered entry,
                # which is registry order, which is Claude Code (order 0) — the
                # same default this prompt has always taken non-interactively.
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
            fi

            if [[ "$CLI_FOUND_COUNT" -eq 0 ]]; then
                die "The selected AI CLI failed to install. Install one manually and re-run the installer."
            fi
        fi
    fi


    # cloudflared (optional — for remote/mobile access via Cloudflare Tunnel)
    info "Checking cloudflared (optional, for remote access)..."
    if check_cloudflared; then
        success "cloudflared found at $(get_cloudflared_path)"
    else
        if prompt_yes_no "Install cloudflared? (enables remote/mobile access via Cloudflare Tunnel)" "n"; then
            install_dependency "cloudflared" "$os" "$distro"
            hash -r 2>/dev/null || true
            if check_cloudflared; then
                success "cloudflared installed at $(get_cloudflared_path)"
            else
                warn "cloudflared installation failed. You can install it manually later."
            fi
        else
            info "Skipped (you can install cloudflared later for remote access)"
        fi
    fi

    echo ""

    # ========================================================================
    # Clone/Update Repository
    # ========================================================================

    info "Installing Codeman to $INSTALL_DIR..."

    if [[ -d "$INSTALL_DIR/.git" ]]; then
        info "Existing installation found, updating..."
        cd "$INSTALL_DIR"
        git remote set-url origin "$REPO_URL" 2>/dev/null || true

        # Check for local changes
        if ! git diff --quiet 2>/dev/null || ! git diff --staged --quiet 2>/dev/null; then
            warn "Local changes detected in $INSTALL_DIR"
            if prompt_yes_no "Discard local changes and update?" "n"; then
                git fetch --quiet origin
                git reset --hard "origin/$BRANCH" --quiet
            else
                info "Keeping existing installation, skipping update"
            fi
        else
            git fetch --quiet origin
            git reset --hard "origin/$BRANCH" --quiet
        fi
    else
        # Create parent directory
        mkdir -p "$(dirname "$INSTALL_DIR")"

        # Clone repository (shallow for speed)
        git clone --quiet --depth 1 --branch "$BRANCH" "$REPO_URL" "$INSTALL_DIR"
        cd "$INSTALL_DIR"
    fi

    success "Repository ready"

    # ========================================================================
    # Build
    # ========================================================================

    info "Installing dependencies..."
    npm_install_deps

    info "Building..."
    npm run build --quiet 2>/dev/null || npm run build

    success "Build complete"

    # ========================================================================
    # Add to PATH
    # ========================================================================

    # Create symlink in a common PATH location
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

    # ========================================================================
    # Mark install complete
    # ========================================================================

    # The dispatcher at the bottom only routes a bare re-run to the quiet
    # update path when this marker exists, so an aborted first install
    # (failed npm install/build, Ctrl+C) re-runs the full setup flow
    # (symlinks, PATH, launch menu) instead of silently "updating".
    date -u +%Y-%m-%dT%H:%M:%SZ > "$INSTALL_DIR/.install-complete"

    # ========================================================================
    # Launch Options
    # ========================================================================

    echo ""
    echo -e "${GREEN}${BOLD}============================================================${NC}"
    echo -e "${GREEN}${BOLD}  Codeman installed successfully!${NC}"
    echo -e "${GREEN}${BOLD}============================================================${NC}"
    echo ""

    # Ask how the dashboard should be reachable BEFORE the launch menu, so the
    # service files and the run-now path all inherit the choice.
    choose_network_binding
    echo ""

    local launch_choice=""
    local has_service=false
    local service_type=""

    if [[ "$os" == "linux" ]] && [[ "$SKIP_SYSTEMD" != "1" ]] && command -v systemctl &>/dev/null; then
        has_service=true
        service_type="systemd"
    elif [[ "$os" == "macos" ]] && [[ "$SKIP_SYSTEMD" != "1" ]]; then
        has_service=true
        service_type="launchd"
    fi

    if [[ "$has_service" == "true" ]]; then
        local service_label="systemd service"
        [[ "$service_type" == "launchd" ]] && service_label="LaunchAgent"

        echo -e "  ${BOLD}How would you like to run Codeman?${NC}"
        echo ""
        echo -e "    ${CYAN}1)${NC} Run now in this terminal"
        echo -e "    ${CYAN}2)${NC} Install as $service_label (auto-start on boot)"
        echo -e "    ${CYAN}3)${NC} Don't start — I'll run it later"
        echo ""

        if [[ "$NONINTERACTIVE" == "1" ]] || ! has_tty; then
            launch_choice="3"
            info "No interactive terminal detected: not starting (run 'codeman web' when ready)"
        else
            while true; do
                echo -en "${CYAN}Choose [1/2/3]:${NC} " >&2
                read_reply launch_choice || { launch_choice="3"; break; }
                case "$launch_choice" in
                    1|2|3) break ;;
                    *) echo "Please enter 1, 2, or 3." >&2 ;;
                esac
            done
        fi
    else
        # No service manager available — only offer run now or skip
        echo -e "  ${BOLD}Would you like to start Codeman now?${NC}"
        echo ""
        echo -e "    ${CYAN}1)${NC} Run now in this terminal"
        echo -e "    ${CYAN}2)${NC} Don't start — I'll run it later"
        echo ""

        if [[ "$NONINTERACTIVE" == "1" ]] || ! has_tty; then
            launch_choice="2"
            info "No interactive terminal detected: not starting (run 'codeman web' when ready)"
        else
            while true; do
                echo -en "${CYAN}Choose [1/2]:${NC} " >&2
                read_reply launch_choice || { launch_choice="2"; break; }
                case "$launch_choice" in
                    1) break ;;
                    2) break ;;
                    *) echo "Please enter 1 or 2." >&2 ;;
                esac
            done
        fi
        # Remap: no-systemd choice "2" (skip) → internal "3"
        [[ "$launch_choice" == "2" ]] && launch_choice="3"
    fi

    echo ""

    # Handle service setup
    if [[ "$launch_choice" == "2" ]]; then
        local service_ok=true
        if [[ "$service_type" == "launchd" ]]; then
            setup_launchd_service || service_ok=false
        else
            setup_systemd_service || service_ok=false
        fi

        # Offer tunnel service if cloudflared is available (Linux only: systemd tunnel service).
        # Skipped when service setup failed: it needs the same systemctl --user access.
        if [[ "$service_ok" == "true" ]] && [[ "$service_type" == "systemd" ]] && check_cloudflared && [[ -f "$INSTALL_DIR/scripts/codeman-tunnel.service" ]]; then
            echo ""
            if prompt_yes_no "Also set up Cloudflare tunnel service? (requires CODEMAN_PASSWORD)" "n"; then
                setup_tunnel_service
            fi
        fi

        echo ""
        if [[ "$service_ok" == "true" ]]; then
            # With Tailscale configured, prove the URL actually answers now
            # that the server is up (never claim success blindly).
            if [[ -n "$TAILSCALE_SERVE_URL" ]]; then
                verify_tailscale_access || true
                echo ""
            fi
            echo -e "  ${GREEN}${BOLD}Codeman is running now!${NC}"
            echo ""
            echo -e "    ${CYAN}# Open in browser${NC}"
            if [[ -n "$TAILSCALE_SERVE_URL" ]]; then
                echo -e "    $TAILSCALE_SERVE_URL   ${DIM}(any device on your tailnet, HTTPS)${NC}"
                echo -e "    http://localhost:3000       ${DIM}(this machine)${NC}"
            elif [[ "$BIND_HOST" == "0.0.0.0" ]]; then
                echo -e "    http://$(detect_lan_ip):3000   ${DIM}(any device on your network)${NC}"
                echo -e "    http://localhost:3000       ${DIM}(this machine)${NC}"
            else
                echo -e "    http://localhost:3000"
            fi
        else
            echo -e "  ${YELLOW}${BOLD}The service was set up but is not running yet${NC} (see warnings above)."
            echo -e "  ${DIM}You can always run it directly:${NC} ${CYAN}codeman web${NC}"
        fi
        echo ""
        echo -e "  ${BOLD}Manage the service:${NC}"
        echo ""
        if [[ "$service_type" == "launchd" ]]; then
            echo -e "    ${CYAN}launchctl unload ~/Library/LaunchAgents/com.codeman.web.plist${NC}   # Stop"
            echo -e "    ${CYAN}launchctl load ~/Library/LaunchAgents/com.codeman.web.plist${NC}     # Start"
            echo -e "    ${CYAN}tail -f /tmp/codeman.log${NC}                                        # View logs"
        else
            echo -e "    ${CYAN}systemctl --user stop codeman-web${NC}    # Stop"
            echo -e "    ${CYAN}systemctl --user restart codeman-web${NC} # Restart"
            echo -e "    ${CYAN}systemctl --user status codeman-web${NC}  # Check status"
            echo -e "    ${CYAN}journalctl --user -u codeman-web -f${NC}  # View logs"
        fi
        echo ""
    fi

    # Show quick-start help for non-service paths
    if [[ "$launch_choice" != "2" ]]; then
        echo -e "  ${BOLD}Quick Start:${NC}"
        echo ""
        if [[ "$BIND_HOST" == "0.0.0.0" ]]; then
            if [[ -n "$BIND_PASSWORD" ]]; then
                echo -e "    ${CYAN}CODEMAN_HOST=0.0.0.0 CODEMAN_PASSWORD='<your-password>' codeman web${NC}"
            else
                echo -e "    ${CYAN}CODEMAN_HOST=0.0.0.0 codeman web${NC}"
            fi
            echo -e "    ${DIM}(a bare 'codeman web' binds 127.0.0.1, this machine only)${NC}"
            echo ""
            echo -e "    ${CYAN}# Open in browser${NC}"
            echo -e "    http://$(detect_lan_ip):3000   ${DIM}(any device on your network)${NC}"
        else
            echo -e "    ${CYAN}codeman web${NC}            # Start the web server"
            echo -e "    ${CYAN}codeman web --https${NC}    # With HTTPS (for remote access)"
            echo ""
            echo -e "    ${CYAN}# Open in browser${NC}"
            echo -e "    http://localhost:3000"
            if [[ -n "$TAILSCALE_SERVE_URL" ]]; then
                echo -e "    $TAILSCALE_SERVE_URL   ${DIM}(any device on your tailnet, once running)${NC}"
            fi
        fi
        echo ""
    fi

    if [[ -n "$TAILSCALE_SERVE_URL" ]]; then
        echo -e "  ${BOLD}Remote Access (Tailscale):${NC}"
        echo ""
        echo -e "    $TAILSCALE_SERVE_URL   ${DIM}(HTTPS, any device on your tailnet)${NC}"
        echo -e "    ${CYAN}tailscale serve status${NC}      # Inspect the mapping"
        echo ""
    fi

    if check_cloudflared; then
        echo -e "  ${BOLD}Remote Access (Cloudflare Tunnel):${NC}"
        echo ""
        echo -e "    ${CYAN}./scripts/tunnel.sh start${NC}   # Start tunnel"
        echo -e "    ${CYAN}./scripts/tunnel.sh url${NC}     # Show tunnel URL"
        echo -e "    ${CYAN}./scripts/tunnel.sh stop${NC}    # Stop tunnel"
        echo ""
    fi

    echo -e "  ${BOLD}Mobile Access (Termius/SSH):${NC}"
    echo ""
    echo -e "    ${CYAN}codeman tui${NC}     # Full-screen session dashboard"
    echo -e "    ${CYAN}codeman tui 2${NC}   # Attach straight to session 2"
    echo -e "    ${CYAN}codeman tui -l${NC}  # Numbered list, then exit"
    echo ""

    echo -e "  ${BOLD}Documentation:${NC}"
    echo -e "    https://github.com/Ark0N/Codeman"
    echo ""

    detect_all_clis
    if [[ "$CLI_FOUND_COUNT" -eq 0 ]]; then
        echo -e "  ${YELLOW}${BOLD}Reminder:${NC} Install at least one AI CLI to start using Codeman:"
        cli_catalog_print_install_hints
    fi

    # Security notice — last informational block so it stays visible (when not
    # auto-launching below; if we exec, the server prints the same notice anyway).
    print_security_notice

    # Run now in foreground (must be last — exec replaces the shell)
    if [[ "$launch_choice" == "1" ]]; then
        local profile
        profile=$(detect_shell_profile)

        echo -e "  ${GREEN}${BOLD}Starting Codeman...${NC}"
        echo -e "  ${DIM}Press Ctrl+C to stop${NC}"
        echo ""

        # Source profile to pick up PATH changes, then exec codeman
        # shellcheck disable=SC1090
        source "$profile" 2>/dev/null || true
        if [[ -n "$BIND_HOST" ]]; then
            export CODEMAN_HOST="$BIND_HOST"
            [[ -n "$BIND_PASSWORD" ]] && export CODEMAN_PASSWORD="$BIND_PASSWORD"
            [[ "$BIND_ACK" == "1" ]] && export CODEMAN_ALLOW_UNAUTHENTICATED_NETWORK=1
        fi
        exec node "$INSTALL_DIR/dist/index.js" web
    fi
}

update() {
    if [[ ! -d "$INSTALL_DIR/.git" ]]; then
        die "Codeman is not installed at $INSTALL_DIR. Run the installer first."
    fi

    info "Updating Codeman..."
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

    git fetch --quiet origin
    git reset --hard "origin/$BRANCH" --quiet
    npm_install_deps
    npm run build --quiet 2>/dev/null || npm run build
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
    else
        echo -e "  ${DIM}Restart codeman web to use the new version:${NC}"
        echo -e "    ${CYAN}pkill -f 'codeman.*web'; codeman web &${NC}"
    fi
    echo ""

    # Reflect the service's actual binding in the closing notice. Updates
    # never rewrite the service files, so the existing choice is authoritative.
    read_existing_binding
    if [[ "$EXISTING_FOUND" == "1" ]]; then
        BIND_HOST="$EXISTING_HOST"
        BIND_PASSWORD="$EXISTING_PASSWORD"
        BIND_ACK="$EXISTING_ACK"
    fi

    # An update is the only place a half-configured install gets a second
    # chance at remote access; the fresh-install path asks outright.
    maybe_offer_tailscale_repair

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
        sudo launchctl unload "$daemon_plist" 2>/dev/null || true
        sudo rm -f "$daemon_plist"
        success "Removed LaunchDaemon"
    fi

    # Remove OUR tailscale serve mapping (443 -> Codeman's port) only. Other
    # serve config stays untouched, and never `tailscale serve reset`.
    local ts_url=""
    ts_url=$(detect_tailscale_serve_url 2>/dev/null) || ts_url=""
    if [[ -n "$ts_url" ]]; then
        if prompt_yes_no "Remove the Tailscale serve mapping for Codeman ($ts_url)?" "y"; then
            if ts_cmd_serve serve --https=443 off 2>/dev/null; then
                success "Removed tailscale serve mapping"
            else
                warn "Could not remove it automatically. Run: tailscale serve --https=443 off"
            fi
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

# Sourcing guard: let the test harness load this file for its pure helpers
# without running an install. bash 3.2 cannot be exercised any other way from
# CI — see .github/workflows/ci.yml and test/install-sh-invariants.test.ts.
if [[ -n "${CODEMAN_INSTALL_SH_LIB:-}" ]]; then return 0 2>/dev/null || exit 0; fi

# Wrap in main to prevent partial execution on curl | bash
case "${1:-}" in
    update)    update ;;
    uninstall) uninstall ;;
    tailscale) setup_tailscale_subcommand ;;
    *)
        # Only a COMPLETED install re-runs as a quiet update. A partial one
        # (clone succeeded but build/menu never finished) lacks the marker and
        # re-runs the full flow, so a failed first attempt can actually finish.
        if [[ -z "${1:-}" && -d "$INSTALL_DIR/.git" && -f "$INSTALL_DIR/.install-complete" ]]; then
            print_banner
            update
        else
            main "$@"
        fi
        ;;
esac
