#!/bin/bash
#
# Claudeman Tmux Session Manager
# Interactive tool with arrow key navigation
# Reads from ~/.claudeman/mux-sessions.json
#

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
MAGENTA='\033[0;35m'
BOLD='\033[1m'
DIM='\033[2m'
NC='\033[0m'
REVERSE='\033[7m'

# Use the same path as claudeman (src/tmux-manager.ts)
SESSIONS_FILE="${HOME}/.claudeman/mux-sessions.json"


# Cached data
CACHED_JSON=""
CACHED_COUNT=0
LAST_REFRESH=0
REFRESH_INTERVAL=5  # Refresh data every 5 seconds

# Cleanup on exit
cleanup() {
    tput cnorm 2>/dev/null
    stty echo 2>/dev/null
    echo ""
}
trap cleanup EXIT

# Check dependencies
check_dependencies() {
    if ! command -v jq &> /dev/null; then
        echo -e "${RED}Error: 'jq' is required. Install with: sudo apt install jq${NC}"
        exit 1
    fi
    if ! command -v tmux &> /dev/null; then
        echo -e "${RED}Error: 'tmux' is required. Install with: sudo apt install tmux${NC}"
        exit 1
    fi
}

# Refresh cached data if needed
refresh_cache() {
    local now=$(date +%s)
    if [[ $((now - LAST_REFRESH)) -ge $REFRESH_INTERVAL ]] || [[ -z "$CACHED_JSON" ]]; then
        if [[ -f "$SESSIONS_FILE" ]]; then
            CACHED_JSON=$(cat "$SESSIONS_FILE")
        else
            CACHED_JSON="[]"
        fi
        CACHED_COUNT=$(echo "$CACHED_JSON" | jq 'length')
        LAST_REFRESH=$now
    fi
}

# Force refresh
force_refresh() {
    LAST_REFRESH=0
    refresh_cache
}

get_session_field() {
    local index=$1 field=$2
    # Support both muxName (tmux) and screenName (legacy) fields
    if [[ "$field" == "muxName" ]]; then
        local val=$(echo "$CACHED_JSON" | jq -r ".[$index].muxName // .[$index].screenName // \"unknown\"")
        echo "$val"
    else
        echo "$CACHED_JSON" | jq -r ".[$index].$field // \"unknown\""
    fi
}

# Format duration
format_duration() {
    local s=$1 d=$((s/86400)) h=$(((s%86400)/3600)) m=$(((s%3600)/60))
    if [[ $d -gt 0 ]]; then printf "%dd %dh" $d $h
    elif [[ $h -gt 0 ]]; then printf "%dh %dm" $h $m
    elif [[ $m -gt 0 ]]; then printf "%dm" $m
    else printf "%ds" $s; fi
}

# Check if tmux session alive (cached per draw cycle)
declare -A ALIVE_CACHE
check_alive() {
    local mux_name=$1
    if [[ -z "${ALIVE_CACHE[$mux_name]+x}" ]]; then
        if tmux has-session -t "$mux_name" 2>/dev/null; then
            ALIVE_CACHE[$mux_name]=1
        else
            ALIVE_CACHE[$mux_name]=0
        fi
    fi
    [[ "${ALIVE_CACHE[$mux_name]}" -eq 1 ]]
}

clear_alive_cache() {
    ALIVE_CACHE=()
}

# Kill session by index
kill_session() {
    local idx=$1
    local mux_name=$(get_session_field $idx "muxName")
    local pid=$(get_session_field $idx "pid")

    # SAFETY: Never kill own tmux session
    local current_session=$(tmux display-message -p '#{session_name}' 2>/dev/null || echo "")
    if [[ -n "$current_session" && "$mux_name" == "$current_session" ]]; then
        echo -e "${RED}BLOCKED: Cannot kill own tmux session: $mux_name${NC}"
        return 1
    fi

    pkill -TERM -P $pid 2>/dev/null
    kill -TERM -$pid 2>/dev/null
    tmux kill-session -t "$mux_name" 2>/dev/null
    kill -KILL $pid 2>/dev/null

    # Remove from JSON
    CACHED_JSON=$(echo "$CACHED_JSON" | jq "del(.[$idx])")
    echo "$CACHED_JSON" > "$SESSIONS_FILE"
    CACHED_COUNT=$(echo "$CACHED_JSON" | jq 'length')
    clear_alive_cache
}

# Draw header (only once)
draw_header() {
    echo -e "${BOLD}${CYAN}╔══════════════════════════════════════════════════════════╗${NC}"
    echo -e "${BOLD}${CYAN}║         Claudeman Tmux Session Manager                   ║${NC}"
    echo -e "${BOLD}${CYAN}║              ${DIM}Press q or Esc to exit${CYAN}                      ║${NC}"
    echo -e "${BOLD}${CYAN}╚══════════════════════════════════════════════════════════╝${NC}"
    echo ""
}

# Draw a single session row (no_newline=1 for partial updates)
draw_row() {
    local i=$1
    local selected=$2
    local no_newline=${3:-0}
    local now=$(date +%s)

    local name=$(echo "$CACHED_JSON" | jq -r ".[$i].name // \"unnamed\"")
    local mux_name=$(get_session_field $i "muxName")
    local created_at=$(echo "$CACHED_JSON" | jq -r ".[$i].createdAt")
    local mode=$(echo "$CACHED_JSON" | jq -r ".[$i].mode")

    local created_s=$((created_at / 1000))
    local elapsed=$((now - created_s))
    local running=$(format_duration $elapsed)

    local status status_color
    if check_alive "$mux_name"; then
        status="● alive"
        status_color="${GREEN}"
    else
        status="○ dead"
        status_color="${RED}"
    fi

    [[ ${#name} -gt 20 ]] && name="${name:0:17}..."

    local line_end=$'\n'
    [[ $no_newline -eq 1 ]] && line_end=""

    if [[ $i -eq $selected ]]; then
        printf "  ${REVERSE}${BOLD}▶ %-20s %-14s ${status_color}%-12s${NC}${REVERSE} %-8s ${NC}%s" \
            "$name" "$running" "$status" "$mode" "$line_end"
    else
        printf "    %-20s %-14s ${status_color}%-12s${NC} %-8s%s" \
            "$name" "$running" "$status" "$mode" "$line_end"
    fi
}

# Draw footer
draw_footer() {
    echo ""
    echo -e "  ${DIM}──────────────────────────────────────────────────────────────${NC}"
    echo -e "  ${GREEN}↑/↓${NC} Navigate  ${GREEN}Enter${NC} Attach  ${YELLOW}d${NC} Delete  ${RED}D${NC} Delete All  ${BLUE}i${NC} Info  ${DIM}q${NC} Quit"
}

# Full redraw
full_redraw() {
    local selected=$1
    clear
    draw_header

    if [[ $CACHED_COUNT -eq 0 ]]; then
        echo -e "  ${YELLOW}No sessions found${NC}"
        echo -e "  ${DIM}(checking: $SESSIONS_FILE)${NC}"
        echo ""
        echo -e "  ${DIM}Press q to quit${NC}"
        return
    fi

    printf "  ${BOLD}%-22s %-14s %-12s %-8s${NC}\n" "NAME" "RUNNING" "STATUS" "MODE"
    echo -e "  ${DIM}──────────────────────────────────────────────────────────────${NC}"

    for ((i=0; i<CACHED_COUNT; i++)); do
        draw_row $i $selected
    done

    draw_footer
}

# Update just the selection (fast, no flicker)
update_selection() {
    local old_sel=$1
    local new_sel=$2
    local header_lines=7  # Lines before session list

    # Move to old selection, clear line, redraw as unselected
    tput cup $((header_lines + old_sel)) 0
    tput el  # Clear to end of line
    draw_row $old_sel -1 1  # -1 means not selected, 1 means no newline

    # Move to new selection, clear line, redraw as selected
    tput cup $((header_lines + new_sel)) 0
    tput el  # Clear to end of line
    draw_row $new_sel $new_sel 1  # selected, no newline
}

# Show session info
show_info() {
    local idx=$1
    local now=$(date +%s)

    local name=$(get_session_field $idx "name")
    local session_id=$(get_session_field $idx "sessionId")
    local mux_name=$(get_session_field $idx "muxName")
    local pid=$(get_session_field $idx "pid")
    local created_at=$(get_session_field $idx "createdAt")
    local mode=$(get_session_field $idx "mode")
    local working_dir=$(get_session_field $idx "workingDir")

    local created_s=$((created_at / 1000))
    local elapsed=$((now - created_s))
    local started=$(date -d "@$created_s" '+%Y-%m-%d %H:%M:%S' 2>/dev/null || echo "unknown")

    clear
    echo -e "${BOLD}${CYAN}Session Details${NC}"
    echo -e "${DIM}────────────────────────────────────────${NC}"
    echo -e "  ${BOLD}Name:${NC}        $name"
    echo -e "  ${BOLD}Session ID:${NC}  $session_id"
    echo -e "  ${BOLD}Tmux:${NC}        $mux_name"
    echo -e "  ${BOLD}PID:${NC}         $pid"
    echo -e "  ${BOLD}Mode:${NC}        $mode"
    echo -e "  ${BOLD}Directory:${NC}   $working_dir"
    echo -e "  ${BOLD}Started:${NC}     $started"
    echo -e "  ${BOLD}Running:${NC}     $(format_duration $elapsed)"

    if check_alive "$mux_name"; then
        echo -e "  ${BOLD}Status:${NC}      ${GREEN}● alive${NC}"
        local mem=$(ps -o rss= -p $pid 2>/dev/null | tr -d ' ')
        [[ -n "$mem" ]] && echo -e "  ${BOLD}Memory:${NC}      $(echo "scale=1; $mem/1024" | bc) MB"
    else
        echo -e "  ${BOLD}Status:${NC}      ${RED}○ dead${NC}"
    fi

    echo ""
    echo -e "${DIM}Press any key to continue...${NC}"
    read -rsn1
}

# Confirm dialog
confirm() {
    local msg=$1
    tput sc  # Save cursor
    tput cup $((CACHED_COUNT + 12)) 0
    echo -en "  ${YELLOW}$msg (y/n):${NC} "
    read -rsn1 answer
    tput rc  # Restore cursor
    [[ "$answer" == "y" || "$answer" == "Y" ]]
}

# Read single keypress (handles arrow keys)
read_key() {
    local key
    IFS= read -rsn1 key

    if [[ "$key" == $'\x1b' ]]; then
        read -rsn2 -t 0.1 key
        case "$key" in
            '[A') echo "UP" ;;
            '[B') echo "DOWN" ;;
            *) echo "ESC" ;;
        esac
    elif [[ "$key" == "" ]]; then
        echo "ENTER"
    else
        echo "$key"
    fi
}

# Main interactive loop
interactive_menu() {
    local selected=0
    local need_full_redraw=1

    tput civis  # Hide cursor
    force_refresh
    clear_alive_cache
    full_redraw $selected
    need_full_redraw=0

    while true; do
        # Adjust selection if out of bounds
        [[ $selected -ge $CACHED_COUNT ]] && selected=$((CACHED_COUNT > 0 ? CACHED_COUNT - 1 : 0))
        [[ $selected -lt 0 ]] && selected=0

        # Redraw if needed
        if [[ $need_full_redraw -eq 1 ]]; then
            clear_alive_cache
            full_redraw $selected
            need_full_redraw=0
        fi

        local key=$(read_key)
        local old_selected=$selected

        case "$key" in
            UP|k)
                if [[ $selected -gt 0 ]]; then
                    ((selected--))
                    [[ $CACHED_COUNT -gt 0 ]] && update_selection $old_selected $selected
                fi
                ;;
            DOWN|j)
                if [[ $selected -lt $((CACHED_COUNT - 1)) ]]; then
                    ((selected++))
                    [[ $CACHED_COUNT -gt 0 ]] && update_selection $old_selected $selected
                fi
                ;;
            ENTER)
                if [[ $CACHED_COUNT -gt 0 ]]; then
                    local mux_name=$(get_session_field $selected "muxName")
                    if check_alive "$mux_name"; then
                        tput cnorm
                        clear
                        echo -e "${CYAN}Attaching... (Ctrl+B D to detach)${NC}"
                        sleep 0.3
                        tmux attach-session -t "$mux_name"
                        tput civis
                        need_full_redraw=1
                        force_refresh
                    else
                        tput cup $((CACHED_COUNT + 12)) 0
                        echo -e "  ${RED}Session is dead${NC}         "
                        sleep 1
                        need_full_redraw=1
                    fi
                fi
                ;;
            d|x)
                if [[ $CACHED_COUNT -gt 0 ]]; then
                    local name=$(get_session_field $selected "name")
                    if confirm "Kill '$name'?"; then
                        kill_session $selected
                        need_full_redraw=1
                    else
                        need_full_redraw=1
                    fi
                fi
                ;;
            D|X)
                if [[ $CACHED_COUNT -gt 0 ]]; then
                    if confirm "Kill ALL $CACHED_COUNT sessions?"; then
                        for ((i=CACHED_COUNT-1; i>=0; i--)); do
                            kill_session $i
                        done
                    fi
                    need_full_redraw=1
                fi
                ;;
            i)
                if [[ $CACHED_COUNT -gt 0 ]]; then
                    show_info $selected
                    need_full_redraw=1
                fi
                ;;
            q|Q|ESC)
                clear
                echo -e "${DIM}Goodbye!${NC}"
                break
                ;;
        esac
    done

    tput cnorm
}

# Quick list (non-interactive)
quick_list() {
    force_refresh
    local now=$(date +%s)

    if [[ $CACHED_COUNT -eq 0 ]]; then
        echo "No claudeman sessions found."
        exit 0
    fi

    echo "Claudeman Sessions ($SESSIONS_FILE):"
    echo ""
    printf "%-4s %-22s %-14s %-10s %-8s\n" "#" "NAME" "RUNNING" "STATUS" "MODE"
    echo "─────────────────────────────────────────────────────────────────"

    for ((i=0; i<CACHED_COUNT; i++)); do
        local name=$(echo "$CACHED_JSON" | jq -r ".[$i].name // \"unnamed\"")
        local mux_name=$(get_session_field $i "muxName")
        local created_at=$(echo "$CACHED_JSON" | jq -r ".[$i].createdAt")
        local mode=$(echo "$CACHED_JSON" | jq -r ".[$i].mode")

        local created_s=$((created_at / 1000))
        local elapsed=$((now - created_s))
        local running=$(format_duration $elapsed)

        local status="alive"
        check_alive "$mux_name" || status="dead"

        [[ ${#name} -gt 20 ]] && name="${name:0:17}..."

        printf "%-4s %-22s %-14s %-10s %-8s\n" "[$((i+1))]" "$name" "$running" "$status" "$mode"
    done
}

# Usage
usage() {
    cat << EOF
Claudeman Tmux Session Manager

Reads from: $SESSIONS_FILE

Usage: $0 [command]

Commands:
  (none)       Interactive mode with arrow key navigation
  list, ls     List all sessions
  attach N     Attach to session #N
  kill N       Kill session #N (or N,M or N-M)
  kill-all     Kill all sessions
  info N       Show session #N details
  help         Show this help

Interactive Controls:
  ↑/↓ or j/k   Navigate
  Enter        Attach to selected session
  d            Delete selected session
  D            Delete ALL sessions
  i            Show session info
  q/Esc        Quit

Examples:
  $0              # Interactive mode
  $0 list         # List sessions
  $0 attach 1     # Attach to session 1
  $0 kill 2,3     # Kill sessions 2 and 3
EOF
}

# Main
main() {
    check_dependencies

    case "${1:-}" in
        "") interactive_menu ;;
        list|ls) quick_list ;;
        attach)
            [[ -z "${2:-}" ]] && { echo "Usage: $0 attach <N>"; exit 1; }
            force_refresh
            local mux_name=$(get_session_field $(($2-1)) "muxName")
            check_alive "$mux_name" && tmux attach-session -t "$mux_name" || echo "Session dead or not found"
            ;;
        kill)
            [[ -z "${2:-}" ]] && { echo "Usage: $0 kill <N|N,M|N-M>"; exit 1; }
            force_refresh
            if [[ "$2" =~ ^[0-9]+-[0-9]+$ ]]; then
                local start="${2%-*}" end="${2#*-}"
                for ((i=end-1; i>=start-1; i--)); do kill_session $i 2>/dev/null; done
            else
                IFS=',' read -ra nums <<< "$2"
                for num in $(echo "${nums[*]}" | tr ' ' '\n' | sort -rn); do
                    kill_session $((num-1)) 2>/dev/null
                done
            fi
            echo "Done"
            ;;
        kill-all)
            force_refresh
            # SAFETY: Never kill own tmux session
            local current_session=$(tmux display-message -p '#{session_name}' 2>/dev/null || echo "")
            local killed=0
            for ((i=CACHED_COUNT-1; i>=0; i--)); do
                local mux_name=$(get_session_field $i "muxName")
                if [[ -n "$current_session" && "$mux_name" == "$current_session" ]]; then
                    echo -e "${RED}SKIPPED: Own tmux session: $mux_name${NC}"
                    continue
                fi
                kill_session $i
                ((killed++))
            done
            echo "$killed sessions killed"
            ;;
        info)
            [[ -z "${2:-}" ]] && { echo "Usage: $0 info <N>"; exit 1; }
            force_refresh
            show_info $(($2-1))
            ;;
        help|--help|-h) usage ;;
        *) echo "Unknown: $1"; usage; exit 1 ;;
    esac
}

main "$@"
