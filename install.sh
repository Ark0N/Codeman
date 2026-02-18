#!/usr/bin/env bash
# Claudeman Universal Installer
# https://github.com/Ark0N/claudeman
#
# Usage: curl -fsSL https://raw.githubusercontent.com/Ark0N/claudeman/master/install.sh | bash
#
# Environment variables:
#   CLAUDEMAN_NONINTERACTIVE=1  - Skip all prompts (for CI/automation)
#   CLAUDEMAN_INSTALL_DIR       - Custom install directory (default: ~/.claudeman/app)
#   CLAUDEMAN_SKIP_SYSTEMD=1    - Skip systemd service setup prompt
#   CLAUDEMAN_NODE_VERSION      - Node.js major version to install (default: 22)

set -euo pipefail

# ============================================================================
# Configuration
# ============================================================================

INSTALL_DIR="${CLAUDEMAN_INSTALL_DIR:-$HOME/.claudeman/app}"
REPO_URL="https://github.com/Ark0N/claudeman.git"
MIN_NODE_VERSION=18
TARGET_NODE_VERSION="${CLAUDEMAN_NODE_VERSION:-22}"
NONINTERACTIVE="${CLAUDEMAN_NONINTERACTIVE:-0}"
SKIP_SYSTEMD="${CLAUDEMAN_SKIP_SYSTEMD:-0}"

# Claude CLI search paths (from src/session.ts)
CLAUDE_SEARCH_PATHS=(
    "$HOME/.local/bin/claude"
    "$HOME/.claude/local/claude"
    "/usr/local/bin/claude"
    "$HOME/.npm-global/bin/claude"
    "$HOME/bin/claude"
)

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

check_claude() {
    # Check PATH first
    if command -v claude &>/dev/null; then
        return 0
    fi

    # Check known install locations
    for path in "${CLAUDE_SEARCH_PATHS[@]}"; do
        if [[ -x "$path" ]]; then
            return 0
        fi
    done

    return 1
}

get_claude_path() {
    if command -v claude &>/dev/null; then
        command -v claude
        return
    fi

    for path in "${CLAUDE_SEARCH_PATHS[@]}"; do
        if [[ -x "$path" ]]; then
            echo "$path"
            return
        fi
    done
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
    if ! sudo -v 2>/dev/null; then
        die "Failed to obtain sudo privileges."
    fi
}

run_as_root() {
    if [[ $EUID -eq 0 ]]; then
        "$@"
    else
        sudo "$@"
    fi
}

install_node_macos() {
    info "Installing Node.js via Homebrew..."

    if ! command -v brew &>/dev/null; then
        info "Installing Homebrew first..."
        /bin/bash -c "$(download_to_stdout https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

        # Add Homebrew to PATH for Apple Silicon
        if [[ -f /opt/homebrew/bin/brew ]]; then
            eval "$(/opt/homebrew/bin/brew shellenv)"
        elif [[ -f /usr/local/bin/brew ]]; then
            eval "$(/usr/local/bin/brew shellenv)"
        fi
    fi

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

    # Use NodeSource for consistent version across Fedora versions
    download_to_stdout "https://rpm.nodesource.com/setup_$TARGET_NODE_VERSION.x" | run_as_root bash -
    run_as_root dnf install -y nodejs
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

    # Use NodeSource for openSUSE
    download_to_stdout "https://rpm.nodesource.com/setup_$TARGET_NODE_VERSION.x" | run_as_root bash -
    run_as_root zypper install -y nodejs
}

install_tmux_macos() {
    info "Installing tmux via Homebrew..."
    brew install tmux
}

install_tmux_debian() {
    info "Installing tmux via apt..."
    ensure_sudo
    run_as_root apt-get update -qq
    run_as_root apt-get install -y -qq tmux
}

install_tmux_fedora() {
    info "Installing tmux via dnf..."
    ensure_sudo
    run_as_root dnf install -y tmux
}

install_tmux_arch() {
    info "Installing tmux via pacman..."
    ensure_sudo
    run_as_root pacman -Sy --noconfirm tmux
}

install_tmux_alpine() {
    info "Installing tmux via apk..."
    run_as_root apk add --no-cache tmux
}

install_tmux_suse() {
    info "Installing tmux via zypper..."
    ensure_sudo
    run_as_root zypper install -y tmux
}

install_git_macos() {
    info "Installing Git via Homebrew..."
    brew install git
}

install_git_debian() {
    info "Installing Git via apt..."
    ensure_sudo
    run_as_root apt-get update -qq
    run_as_root apt-get install -y -qq git
}

install_git_fedora() {
    info "Installing Git via dnf..."
    ensure_sudo
    run_as_root dnf install -y git
}

install_git_arch() {
    info "Installing Git via pacman..."
    ensure_sudo
    run_as_root pacman -Sy --noconfirm git
}

install_git_alpine() {
    info "Installing Git via apk..."
    run_as_root apk add --no-cache git
}

install_git_suse() {
    info "Installing Git via zypper..."
    ensure_sudo
    run_as_root zypper install -y git
}

# ============================================================================
# Interactive Prompts
# ============================================================================

prompt_yes_no() {
    local prompt="$1"
    local default="${2:-y}"

    if [[ "$NONINTERACTIVE" == "1" ]]; then
        [[ "$default" == "y" ]]
        return
    fi

    # Check if stdin is a terminal
    if [[ ! -t 0 ]]; then
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
        read -r answer
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
        echo "# Added by Claudeman installer" >> "$profile"
        echo "fish_add_path $bin_dir" >> "$profile"
    else
        echo "" >> "$profile"
        echo "# Added by Claudeman installer" >> "$profile"
        echo "export PATH=\"$bin_dir:\$PATH\"" >> "$profile"
    fi

    success "Added to $profile - restart your shell or run: source $profile"
}

setup_sc_alias() {
    local profile
    profile=$(detect_shell_profile)

    # Check if alias already exists
    if [[ -f "$profile" ]] && grep -qE "^alias sc=" "$profile" 2>/dev/null; then
        info "Alias 'sc' already configured in $profile"
        return 0
    fi

    local shell_name
    shell_name="$(basename "${SHELL:-/bin/bash}")"

    if [[ "$shell_name" == "fish" ]]; then
        echo "" >> "$profile"
        echo "# Claudeman tmux session shortcut" >> "$profile"
        echo "alias sc='tmux-chooser'" >> "$profile"
    else
        echo "" >> "$profile"
        echo "# Claudeman tmux session shortcut" >> "$profile"
        echo "alias sc='tmux-chooser'" >> "$profile"
    fi

    info "Added 'sc' alias for tmux-chooser"
}

# ============================================================================
# Systemd Service Setup (Linux only)
# ============================================================================

setup_systemd_service() {
    local service_dir="$HOME/.config/systemd/user"
    local service_file="$service_dir/claudeman-web.service"

    info "Setting up systemd user service..."

    mkdir -p "$service_dir"

    # Find node binary path
    local node_path
    node_path=$(command -v node)

    # Create service file
    cat > "$service_file" << EOF
[Unit]
Description=Claudeman Web Server
After=network.target

[Service]
Type=simple
ExecStart=$node_path $INSTALL_DIR/dist/index.js web
WorkingDirectory=$HOME
Restart=always
RestartSec=10
Environment=NODE_ENV=production
Environment=PATH=$PATH

[Install]
WantedBy=default.target
EOF

    # Reload systemd
    systemctl --user daemon-reload

    # Enable service
    systemctl --user enable claudeman-web.service 2>/dev/null || true

    # Enable lingering (allows service to run after logout)
    if command -v loginctl &>/dev/null; then
        loginctl enable-linger "$USER" 2>/dev/null || true
    fi

    success "Systemd service installed at $service_file"
    info "Start with: systemctl --user start claudeman-web"
}

# ============================================================================
# Installation Helpers
# ============================================================================

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
   ____ _                 _
  / ___| | __ _ _   _  __| | ___ _ __ ___   __ _ _ __
 | |   | |/ _` | | | |/ _` |/ _ \ '_ ` _ \ / _` | '_ \
 | |___| | (_| | |_| | (_| |  __/ | | | | | (_| | | | |
  \____|_|\__,_|\__,_|\__,_|\___|_| |_| |_|\__,_|_| |_|
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
        if prompt_yes_no "Git is not installed. Install it now?"; then
            install_dependency "git" "$os" "$distro"
        else
            die "Git is required to install Claudeman."
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

        if prompt_yes_no "Install Node.js v$TARGET_NODE_VERSION?"; then
            install_dependency "node" "$os" "$distro"

            # Rehash to pick up new node
            hash -r 2>/dev/null || true
        else
            die "Node.js $MIN_NODE_VERSION+ is required to run Claudeman."
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
        if prompt_yes_no "tmux is not installed. Install it now?"; then
            install_dependency "tmux" "$os" "$distro"
        else
            die "tmux is required for session persistence."
        fi
    fi

    # Claude CLI (warning only)
    info "Checking Claude CLI..."
    if ! check_claude; then
        echo ""
        warn "Claude CLI is not installed!"
        echo -e "  ${DIM}Claudeman requires Claude CLI to manage AI sessions.${NC}"
        echo -e "  ${DIM}Install it with:${NC}"
        echo ""
        echo -e "    ${CYAN}curl -fsSL https://claude.ai/install.sh | bash${NC}"
        echo ""
        echo -e "  ${DIM}Or see: https://docs.anthropic.com/en/docs/claude-code${NC}"
        echo ""
    else
        local claude_path
        claude_path=$(get_claude_path)
        success "Claude CLI found at $claude_path"
    fi

    echo ""

    # ========================================================================
    # Clone/Update Repository
    # ========================================================================

    info "Installing Claudeman to $INSTALL_DIR..."

    if [[ -d "$INSTALL_DIR/.git" ]]; then
        info "Existing installation found, updating..."
        cd "$INSTALL_DIR"

        # Check for local changes
        if ! git diff --quiet 2>/dev/null || ! git diff --staged --quiet 2>/dev/null; then
            warn "Local changes detected in $INSTALL_DIR"
            if prompt_yes_no "Discard local changes and update?" "n"; then
                git fetch --quiet origin
                git reset --hard origin/master --quiet
            else
                info "Keeping existing installation, skipping update"
            fi
        else
            git fetch --quiet origin
            git reset --hard origin/master --quiet
        fi
    else
        # Create parent directory
        mkdir -p "$(dirname "$INSTALL_DIR")"

        # Clone repository (shallow for speed)
        git clone --quiet --depth 1 "$REPO_URL" "$INSTALL_DIR"
        cd "$INSTALL_DIR"
    fi

    success "Repository ready"

    # ========================================================================
    # Build
    # ========================================================================

    info "Installing dependencies..."
    npm install --quiet --no-fund --no-audit 2>/dev/null || npm install --no-fund --no-audit

    info "Building..."
    npm run build --quiet 2>/dev/null || npm run build

    success "Build complete"

    # ========================================================================
    # Add to PATH
    # ========================================================================

    local bin_dir="$INSTALL_DIR/dist"
    add_to_path "$bin_dir"

    # Create symlink in a common PATH location if possible
    local symlink_dir="$HOME/.local/bin"
    mkdir -p "$symlink_dir" 2>/dev/null || true
    if [[ -d "$symlink_dir" ]]; then
        ln -sf "$INSTALL_DIR/dist/index.js" "$symlink_dir/claudeman"
        info "Created symlink: $symlink_dir/claudeman"

        # Install tmux-chooser as 'tmux-chooser' command
        if [[ -f "$INSTALL_DIR/scripts/tmux-chooser.sh" ]]; then
            ln -sf "$INSTALL_DIR/scripts/tmux-chooser.sh" "$symlink_dir/tmux-chooser"
            info "Created symlink: $symlink_dir/tmux-chooser"
            # Add 'sc' alias for quick access
            setup_sc_alias
        fi

        # Add ~/.local/bin to PATH if not already there
        if [[ ":$PATH:" != *":$symlink_dir:"* ]]; then
            add_to_path "$symlink_dir"
        fi
    fi


    # ========================================================================
    # Systemd Service (Linux only)
    # ========================================================================

    if [[ "$os" == "linux" ]] && [[ "$SKIP_SYSTEMD" != "1" ]] && command -v systemctl &>/dev/null; then
        echo ""
        if prompt_yes_no "Set up systemd service for auto-start?" "n"; then
            setup_systemd_service
        fi
    fi

    # ========================================================================
    # Success!
    # ========================================================================

    echo ""
    echo -e "${GREEN}${BOLD}============================================================${NC}"
    echo -e "${GREEN}${BOLD}  Claudeman installed successfully!${NC}"
    echo -e "${GREEN}${BOLD}============================================================${NC}"
    echo ""
    echo -e "  ${BOLD}Quick Start:${NC}"
    echo ""
    echo -e "    ${CYAN}# Start the web server${NC}"
    echo -e "    claudeman web"
    echo ""
    echo -e "    ${CYAN}# Start with HTTPS (only needed for remote access)${NC}"
    echo -e "    claudeman web --https"
    echo ""
    echo -e "    ${CYAN}# Open in browser${NC}"
    echo -e "    http://localhost:3000"
    echo ""
    echo -e "  ${BOLD}Mobile Access (Termius/SSH):${NC}"
    echo ""
    echo -e "    ${CYAN}sc${NC}              # Interactive tmux session chooser"
    echo -e "    ${CYAN}sc 2${NC}            # Quick attach to session 2"
    echo -e "    ${CYAN}sc -h${NC}           # Help"
    echo ""

    if [[ "$os" == "linux" ]] && [[ -f "$HOME/.config/systemd/user/claudeman-web.service" ]]; then
        echo -e "  ${BOLD}Systemd Service:${NC}"
        echo ""
        echo -e "    ${CYAN}systemctl --user start claudeman-web${NC}   # Start"
        echo -e "    ${CYAN}systemctl --user status claudeman-web${NC}  # Check status"
        echo -e "    ${CYAN}journalctl --user -u claudeman-web -f${NC}  # View logs"
        echo ""
    fi

    echo -e "  ${BOLD}Documentation:${NC}"
    echo -e "    https://github.com/Ark0N/claudeman"
    echo ""

    if ! check_claude; then
        echo -e "  ${YELLOW}${BOLD}Reminder:${NC} Install Claude CLI to start using Claudeman:"
        echo -e "    ${CYAN}curl -fsSL https://claude.ai/install.sh | bash${NC}"
        echo ""
    fi

    # Remind to reload shell if PATH was modified
    local profile
    profile=$(detect_shell_profile)
    if [[ ":$PATH:" != *":$bin_dir:"* ]]; then
        echo -e "  ${DIM}Restart your shell or run: source $profile${NC}"
        echo ""
    fi
}

# Wrap in main to prevent partial execution on curl | bash
main "$@"
