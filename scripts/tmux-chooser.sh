#!/bin/bash
# ============================================================================
# Codeman Sessions - Mobile-friendly Tmux Session Chooser
# Optimized for iPhone/Termius (portrait ~45 chars, landscape ~95 chars)
# ============================================================================
#
# Design principles:
#   - Single-digit selection (1-9) for fast thumb typing
#   - Compact display, no wasted space
#   - Color-coded status for quick scanning
#   - Names pulled from Codeman state.json
#   - Minimal keystrokes to attach
#
# Usage:
#   tmux-chooser          # Interactive chooser
#   tmux-chooser 1        # Quick attach to session 1
#   tmux-chooser -l       # List only (non-interactive)
#   tmux-chooser -h       # Help
#
# Alias: alias sc='tmux-chooser'
#   Then: sc      (interactive)
#         sc 2    (attach session 2)
#
# ============================================================================

set -e

# ============================================================================
# Configuration
# ============================================================================

CODEMAN_STATE="$HOME/.codeman/state.json"
CODEMAN_SESSIONS="$HOME/.codeman/mux-sessions.json"


# iPhone 17 Pro portrait width (conservative)
MAX_WIDTH=44
MAX_NAME_LEN=28

# Page size for pagination (leave room for header/footer)
PAGE_SIZE=7

# Auto-refresh timeout (seconds) - 0 to disable
AUTO_REFRESH=60

# ============================================================================
# Icon Detection (Nerd Fonts vs ASCII)
# ============================================================================

detect_icons() {
    if [[ "$TERM_PROGRAM" == "iTerm"* ]] || \
       [[ "$TERM" == "xterm-kitty" ]] || \
       [[ -n "$WEZTERM_PANE" ]] || \
       [[ "$LC_TERMINAL" == "iTerm2" ]]; then
        ICON_SESSION="󰆍"
        ICON_ATTACHED="●"
        ICON_DETACHED="○"
        ICON_UNKNOWN="◌"
    else
        ICON_SESSION="[T]"
        ICON_ATTACHED="*"
        ICON_DETACHED="-"
        ICON_UNKNOWN="?"
    fi
}

detect_icons

# ============================================================================
# Colors - ANSI 256 for better Termius compatibility
# ============================================================================

R='\033[0m'        # Reset
B='\033[1m'        # Bold
D='\033[2m'        # Dim
GREEN='\033[38;5;82m'
YELLOW='\033[38;5;220m'
BLUE='\033[38;5;75m'
CYAN='\033[38;5;87m'
RED='\033[38;5;203m'
GRAY='\033[38;5;245m'
WHITE='\033[38;5;255m'
BG_SEL='\033[48;5;236m'

# ============================================================================
# Utilities
# ============================================================================

truncate() {
    local str="$1"
    local max="$2"
    local len=${#str}

    if [ "$len" -le "$max" ]; then
        echo "$str"
        return
    fi

    if [[ "$str" == *"/"* ]]; then
        echo "..${str: -$((max-2))}"
    else
        echo "${str:0:$((max-1))}…"
    fi
}

find_full_session_id() {
    local short_id="$1"

    if [ -f "$CODEMAN_STATE" ]; then
        local full_id
        full_id=$(jq -r --arg short "$short_id" '
            .sessions | keys[] | select(startswith($short))
        ' "$CODEMAN_STATE" 2>/dev/null | head -1)
        if [ -n "$full_id" ]; then
            echo "$full_id"
            return
        fi
    fi

    if [ -f "$CODEMAN_SESSIONS" ]; then
        local full_id
        full_id=$(jq -r --arg short "$short_id" '
            .[] | select(.sessionId | startswith($short)) | .sessionId
        ' "$CODEMAN_SESSIONS" 2>/dev/null | head -1)
        if [ -n "$full_id" ]; then
            echo "$full_id"
            return
        fi
    fi

    echo "$short_id"
}

get_session_name() {
    local session_id="$1"
    local name=""
    local workdir=""

    if [ -f "$CODEMAN_SESSIONS" ]; then
        local result
        result=$(jq -r --arg id "$session_id" '
            .[] | select(.sessionId | startswith($id)) | "\(.name // "")\t\(.workingDir // "")"
        ' "$CODEMAN_SESSIONS" 2>/dev/null | head -1)
        if [ -n "$result" ]; then
            name="${result%%	*}"
            workdir="${result#*	}"
        fi
    fi

    if [ -z "$name" ] && [ -f "$CODEMAN_STATE" ]; then
        local result
        result=$(jq -r --arg id "$session_id" '
            .sessions | to_entries[] | select(.key | startswith($id)) | "\(.value.name // "")\t\(.value.workingDir // "")"
        ' "$CODEMAN_STATE" 2>/dev/null | head -1)
        if [ -n "$result" ]; then
            name="${result%%	*}"
            [ -z "$workdir" ] && workdir="${result#*	}"
        fi
    fi

    if [ -n "$name" ]; then
        echo "$name"
        return
    fi

    if [ -n "$workdir" ]; then
        echo "${workdir##*/}"
        return
    fi

    echo "${session_id:0:8}"
}

get_working_dir() {
    local session_id="$1"

    if [ -f "$CODEMAN_SESSIONS" ]; then
        local dir
        dir=$(jq -r --arg id "$session_id" '
            .[] | select(.sessionId | startswith($id)) | .workingDir // empty
        ' "$CODEMAN_SESSIONS" 2>/dev/null | head -1)
        if [ -n "$dir" ] && [ "$dir" != "null" ]; then
            echo "${dir/#$HOME/~}"
            return
        fi
    fi

    if [ -f "$CODEMAN_STATE" ]; then
        local dir
        dir=$(jq -r --arg id "$session_id" '
            .sessions | to_entries[] | select(.key | startswith($id)) | .value.workingDir // empty
        ' "$CODEMAN_STATE" 2>/dev/null | head -1)
        if [ -n "$dir" ] && [ "$dir" != "null" ]; then
            echo "${dir/#$HOME/~}"
            return
        fi
    fi
    echo ""
}

get_tokens() {
    local session_id="$1"

    if [ -f "$CODEMAN_STATE" ]; then
        local tokens
        tokens=$(jq -r --arg id "$session_id" '
            .sessions | to_entries[] | select(.key | startswith($id)) |
            ((.value.inputTokens // 0) + (.value.outputTokens // 0))
        ' "$CODEMAN_STATE" 2>/dev/null | head -1)

        if [ -n "$tokens" ] && [ "$tokens" != "null" ] && [ "$tokens" -gt 0 ] 2>/dev/null; then
            if [ "$tokens" -gt 1000 ]; then
                echo "$((tokens / 1000))k"
            else
                echo "${tokens}"
            fi
            return
        fi
    fi
    echo ""
}

get_respawn_status() {
    local session_id="$1"

    if [ -f "$CODEMAN_SESSIONS" ]; then
        local respawn_enabled
        respawn_enabled=$(jq -r --arg id "$session_id" '
            .[] | select(.sessionId | startswith($id)) | .respawnConfig.enabled // false
        ' "$CODEMAN_SESSIONS" 2>/dev/null | head -1)

        if [ "$respawn_enabled" = "true" ]; then
            echo "R"
            return
        fi
    fi
    echo ""
}

check_deps() {
    if ! command -v jq &>/dev/null; then
        echo -e "${YELLOW}Note: Install jq for session names${R}"
        echo ""
    fi
}

# ============================================================================
# Tmux Session Parser
# ============================================================================

declare -a SESSION_PIDS
declare -a MUX_NAMES
declare -a SESSION_STATES
declare -a SESSION_IDS
declare -a DISPLAY_NAMES
declare -a WORKING_DIRS
declare -a TOKEN_COUNTS
declare -a RESPAWN_STATUS

parse_sessions() {
    SESSION_PIDS=()
    MUX_NAMES=()
    SESSION_STATES=()
    SESSION_IDS=()
    DISPLAY_NAMES=()
    WORKING_DIRS=()
    TOKEN_COUNTS=()
    RESPAWN_STATUS=()

    local i=0

    # Parse tmux list-sessions output
    while IFS= read -r line; do
        local session_name="${line%%:*}"

        # Only show codeman sessions
        if [[ "$session_name" != codeman-* ]]; then
            continue
        fi

        # Check if attached
        local state="Detached"
        if [[ "$line" == *"(attached)"* ]]; then
            state="Attached"
        fi

        # Get PID from tmux
        local pid
        pid=$(tmux display-message -t "$session_name" -p '#{pane_pid}' 2>/dev/null || echo "0")

        SESSION_PIDS+=("$pid")
        MUX_NAMES+=("$session_name")
        SESSION_STATES+=("$state")

        # Extract session ID from codeman session name
        local session_id=""
        local cm_regex='^codeman-(.+)$'
        if [[ "$session_name" =~ $cm_regex ]]; then
            session_id="${BASH_REMATCH[1]}"
        fi
        SESSION_IDS+=("$session_id")

        # Get display name and metadata
        if [ -n "$session_id" ]; then
            DISPLAY_NAMES+=("$(get_session_name "$session_id")")
            WORKING_DIRS+=("$(get_working_dir "$session_id")")
            TOKEN_COUNTS+=("$(get_tokens "$session_id")")
            RESPAWN_STATUS+=("$(get_respawn_status "$session_id")")
        else
            DISPLAY_NAMES+=("$session_name")
            WORKING_DIRS+=("")
            TOKEN_COUNTS+=("")
            RESPAWN_STATUS+=("")
        fi

        i=$((i + 1))
    done < <(tmux list-sessions 2>/dev/null || true)
}

# ============================================================================
# Display Functions
# ============================================================================

clear_screen() {
    printf '\033[2J\033[H'
}

print_header() {
    local count=${#SESSION_PIDS[@]}
    echo -e "${B}${CYAN}Codeman Sessions${R} ${D}($count)${R}"
    echo -e "${D}$(printf '%.0s─' {1..32})${R}"
}

print_entry() {
    local idx="$1"
    local num=$((idx + 1))
    local name="${DISPLAY_NAMES[$idx]}"
    local state="${SESSION_STATES[$idx]}"
    local dir="${WORKING_DIRS[$idx]}"
    local tokens="${TOKEN_COUNTS[$idx]}"
    local respawn="${RESPAWN_STATUS[$idx]}"

    local name_max=$MAX_NAME_LEN
    [ -n "$respawn" ] && name_max=$((name_max - 2))
    [ -n "$tokens" ] && name_max=$((name_max - 4))
    name=$(truncate "$name" $name_max)

    local status_icon status_color
    if [[ "$state" == *"Attached"* ]]; then
        status_icon="$ICON_ATTACHED"
        status_color="$GREEN"
    elif [[ "$state" == *"Detached"* ]]; then
        status_icon="$ICON_DETACHED"
        status_color="$GRAY"
    else
        status_icon="$ICON_UNKNOWN"
        status_color="$YELLOW"
    fi

    local num_str="${B}${WHITE}${num})${R}"
    local name_str="${B}${WHITE}${name}${R}"
    local status_str="${status_color}${status_icon}${R}"

    local respawn_str=""
    if [ -n "$respawn" ]; then
        respawn_str=" ${GREEN}${respawn}${R}"
    fi

    local token_str=""
    if [ -n "$tokens" ]; then
        token_str=" ${D}${tokens}${R}"
    fi

    echo -e " ${num_str} ${name_str} ${status_str}${respawn_str}${token_str}"

    if [ -n "$dir" ]; then
        dir=$(truncate "$dir" $((MAX_NAME_LEN - 2)))
        echo -e "    ${D}${dir}${R}"
    fi
}

print_footer() {
    local page="$1"
    local total_pages="$2"

    echo ""
    echo -e "${D}────────────────────────────────${R}"

    if [ "$total_pages" -gt 1 ]; then
        echo -e " ${D}Page $((page+1))/$total_pages${R}  ${GRAY}[${WHITE}n${GRAY}]ext [${WHITE}p${GRAY}]rev${R}"
    fi

    echo -e " ${GRAY}[${WHITE}1-9${GRAY}]attach [${WHITE}r${GRAY}]efresh [${WHITE}q${GRAY}]uit${R}"
}

print_no_sessions() {
    clear_screen
    echo -e "${B}${CYAN}Codeman Sessions${R}"
    echo -e "${D}$(printf '%.0s─' {1..32})${R}"
    echo ""
    echo -e "  ${YELLOW}No tmux sessions found${R}"
    echo ""
    echo -e "  ${D}Start one with:${R}"
    echo -e "  ${WHITE}codeman web${R}"
    echo ""
    echo -e "${D}$(printf '%.0s─' {1..32})${R}"
    echo -e " ${GRAY}[${WHITE}r${GRAY}]efresh [${WHITE}q${GRAY}]uit${R}"
}

# ============================================================================
# Main Display Loop
# ============================================================================

current_page=0

render() {
    clear_screen
    parse_sessions

    local count=${#SESSION_PIDS[@]}

    if [ "$count" -eq 0 ]; then
        print_no_sessions
        return
    fi

    local total_pages=$(( (count + PAGE_SIZE - 1) / PAGE_SIZE ))

    if [ "$current_page" -ge "$total_pages" ]; then
        current_page=$((total_pages - 1))
    fi
    if [ "$current_page" -lt 0 ]; then
        current_page=0
    fi

    local start=$((current_page * PAGE_SIZE))
    local end=$((start + PAGE_SIZE))
    if [ "$end" -gt "$count" ]; then
        end=$count
    fi

    print_header
    echo ""

    for ((i = start; i < end; i++)); do
        print_entry $i
    done

    print_footer $current_page $total_pages
}

attach_session() {
    local idx="$1"
    local mux_name="${MUX_NAMES[$idx]}"

    if [ -z "$mux_name" ]; then
        return 1
    fi

    clear_screen
    echo -e "${GREEN}Attaching to ${B}${DISPLAY_NAMES[$idx]}${R}${GREEN}...${R}"
    echo -e "${D}(Ctrl+B D to detach)${R}"
    sleep 0.3

    tmux attach-session -t "$mux_name"

    return 0
}

# ============================================================================
# Input Handler
# ============================================================================

handle_input() {
    local key="$1"
    local count=${#SESSION_PIDS[@]}
    local total_pages=$(( (count + PAGE_SIZE - 1) / PAGE_SIZE ))

    case "$key" in
        [1-9])
            local idx=$((key - 1))
            if [ "$idx" -lt "$count" ]; then
                attach_session "$idx"
                return 0
            fi
            ;;

        $'\e')
            read -rsn2 -t 0.1 seq 2>/dev/null || true
            case "$seq" in
                '[A'|'[D')
                    if [ "$total_pages" -gt 1 ]; then
                        current_page=$(( (current_page - 1 + total_pages) % total_pages ))
                    fi
                    ;;
                '[B'|'[C')
                    if [ "$total_pages" -gt 1 ]; then
                        current_page=$(( (current_page + 1) % total_pages ))
                    fi
                    ;;
            esac
            ;;

        n|N|j|J)
            if [ "$total_pages" -gt 1 ]; then
                current_page=$(( (current_page + 1) % total_pages ))
            fi
            ;;

        p|P|k|K)
            if [ "$total_pages" -gt 1 ]; then
                current_page=$(( (current_page - 1 + total_pages) % total_pages ))
            fi
            ;;

        r|R)
            ;;

        q|Q)
            clear_screen
            exit 0
            ;;

        '')
            if [ "$count" -eq 1 ]; then
                attach_session 0
                return 0
            fi
            ;;
    esac

    return 0
}

# ============================================================================
# List Mode
# ============================================================================

list_mode() {
    parse_sessions
    local count=${#SESSION_PIDS[@]}

    if [ "$count" -eq 0 ]; then
        echo "No tmux sessions"
        exit 0
    fi

    for ((i = 0; i < count; i++)); do
        local num=$((i + 1))
        local name="${DISPLAY_NAMES[$i]}"
        local state="${SESSION_STATES[$i]}"
        local respawn="${RESPAWN_STATUS[$i]}"
        local indicator="-"
        [[ "$state" == *"Attached"* ]] && indicator="*"
        [ -n "$respawn" ] && indicator="${indicator}R"

        echo "$num) $name [$indicator]"
    done
}

# ============================================================================
# Quick Attach
# ============================================================================

quick_attach() {
    local num="$1"
    parse_sessions

    local count=${#SESSION_PIDS[@]}
    local idx=$((num - 1))

    if [ "$idx" -lt 0 ] || [ "$idx" -ge "$count" ]; then
        echo -e "${RED}Invalid session: $num${R}"
        echo "Available: 1-$count"
        exit 1
    fi

    attach_session "$idx"
}

# ============================================================================
# Help
# ============================================================================

show_help() {
    cat << 'EOF'
Codeman Sessions - Mobile-friendly Tmux Session Chooser

USAGE:
  sc              Interactive chooser
  sc <number>     Quick attach to session N
  sc -l           List sessions (non-interactive)
  sc -h           Show this help

INTERACTIVE KEYS:
  1-9      Attach to session
  n/j/↓    Next page
  p/k/↑    Previous page
  r        Refresh
  q        Quit

INDICATORS:
  * / ●    Attached (someone connected)
  - / ○    Detached (available)
  R        Respawn enabled
  45k      Token count

TIPS:
  - Detach from tmux: Ctrl+B D
  - Session names from Codeman state
  - Optimized for Termius/iPhone

EOF
}

# ============================================================================
# Main
# ============================================================================

main() {
    case "${1:-}" in
        -h|--help)
            show_help
            exit 0
            ;;
        -l|--list)
            list_mode
            exit 0
            ;;
        [1-9]|[1-9][0-9])
            quick_attach "$1"
            exit $?
            ;;
    esac

    check_deps

    render

    while true; do
        local timeout_opt=""
        if [ "$AUTO_REFRESH" -gt 0 ]; then
            timeout_opt="-t $AUTO_REFRESH"
        fi

        if read -rsn1 $timeout_opt key 2>/dev/null; then
            handle_input "$key"
        fi
        render
    done
}

trap 'clear_screen; exit 0' INT

main "$@"
