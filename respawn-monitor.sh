#!/bin/bash

# Respawn Controller Monitor for w3-reddit-analyse
# Monitors for 12 hours, logs issues and suggested fixes

SESSION_ID="5ecdf859-3605-42d8-b0a2-f8f0a1b5ff98"
SESSION_NAME="w3-reddit-analyse"
ISSUES_FILE="/home/arkon/default/claudeman/respawn-issues.md"
FIXES_FILE="/home/arkon/default/claudeman/respawn-fixes.md"
LOG_FILE="/home/arkon/default/claudeman/respawn-monitor.log"
API_BASE="https://localhost:3000"
DURATION_HOURS=12
POLL_INTERVAL=30  # seconds

# Initialize files
cat > "$ISSUES_FILE" << 'EOF'
# Respawn Controller Issues - w3-reddit-analyse

Monitoring started: $(date)
Session ID: 5ecdf859-3605-42d8-b0a2-f8f0a1b5ff98

## Issues Detected

EOF
sed -i "s/\$(date)/$(date)/" "$ISSUES_FILE"

cat > "$FIXES_FILE" << 'EOF'
# Suggested Fixes for Respawn Controller Issues

**DO NOT EXECUTE** - Waiting for user review

## Fixes

EOF

echo "=== Respawn Monitor Started: $(date) ===" > "$LOG_FILE"
echo "Session: $SESSION_NAME ($SESSION_ID)" >> "$LOG_FILE"
echo "Duration: $DURATION_HOURS hours" >> "$LOG_FILE"
echo "Poll interval: ${POLL_INTERVAL}s" >> "$LOG_FILE"
echo "" >> "$LOG_FILE"

# Track state for anomaly detection
PREV_STATE=""
PREV_TOKENS=0
STATE_STUCK_COUNT=0
LAST_ACTIVITY_TIME=$(date +%s)
ISSUE_COUNT=0

log_issue() {
    local severity="$1"
    local title="$2"
    local details="$3"
    ISSUE_COUNT=$((ISSUE_COUNT + 1))

    echo "" >> "$ISSUES_FILE"
    echo "### Issue #$ISSUE_COUNT [$severity] - $(date '+%Y-%m-%d %H:%M:%S')" >> "$ISSUES_FILE"
    echo "**$title**" >> "$ISSUES_FILE"
    echo "" >> "$ISSUES_FILE"
    echo "$details" >> "$ISSUES_FILE"
    echo "" >> "$ISSUES_FILE"

    echo "[$(date '+%H:%M:%S')] ISSUE #$ISSUE_COUNT [$severity]: $title" >> "$LOG_FILE"
}

log_fix() {
    local issue_num="$1"
    local fix_title="$2"
    local fix_details="$3"

    echo "" >> "$FIXES_FILE"
    echo "### Fix for Issue #$issue_num" >> "$FIXES_FILE"
    echo "**$fix_title**" >> "$FIXES_FILE"
    echo "" >> "$FIXES_FILE"
    echo "$fix_details" >> "$FIXES_FILE"
    echo "" >> "$FIXES_FILE"
}

END_TIME=$(($(date +%s) + DURATION_HOURS * 3600))

while [ $(date +%s) -lt $END_TIME ]; do
    TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S')

    # Fetch session status
    RESPONSE=$(curl -sk "$API_BASE/api/sessions/$SESSION_ID" 2>/dev/null)

    if [ -z "$RESPONSE" ] || [ "$RESPONSE" = "null" ]; then
        log_issue "CRITICAL" "API request failed or session not found" "Could not fetch session data. Server may be down or session deleted."
        log_fix "$ISSUE_COUNT" "Check server status" "1. Check if claudeman-web is running: \`systemctl --user status claudeman-web\`
2. If down, restart: \`systemctl --user restart claudeman-web\`
3. Check server logs: \`journalctl --user -u claudeman-web -n 50\`"
        sleep $POLL_INTERVAL
        continue
    fi

    # Parse response
    STATUS=$(echo "$RESPONSE" | jq -r '.status // "unknown"')
    RESPAWN_ENABLED=$(echo "$RESPONSE" | jq -r '.respawnEnabled // "null"')
    RESPAWN_STATE=$(echo "$RESPONSE" | jq -r '.respawnState // "null"')
    INPUT_TOKENS=$(echo "$RESPONSE" | jq -r '.inputTokens // 0')
    OUTPUT_TOKENS=$(echo "$RESPONSE" | jq -r '.outputTokens // 0')
    TOTAL_TOKENS=$((INPUT_TOKENS + OUTPUT_TOKENS))

    # Fetch respawn controller details if enabled
    if [ "$RESPAWN_ENABLED" = "true" ]; then
        RESPAWN_DETAILS=$(curl -sk "$API_BASE/api/sessions/$SESSION_ID/respawn/status" 2>/dev/null)
        RESPAWN_STATE=$(echo "$RESPAWN_DETAILS" | jq -r '.state // "unknown"')
        DETECTION_STATUS=$(echo "$RESPAWN_DETAILS" | jq -r '.detectionStatus // {}')
        IDLE_CONFIDENCE=$(echo "$DETECTION_STATUS" | jq -r '.idleConfidence // 0')
        TIME_IN_STATE=$(echo "$RESPAWN_DETAILS" | jq -r '.timeInState // 0')
        LAST_ERROR=$(echo "$RESPAWN_DETAILS" | jq -r '.lastError // "none"')
    fi

    echo "[$TIMESTAMP] status=$STATUS respawn=$RESPAWN_ENABLED state=$RESPAWN_STATE tokens=$TOTAL_TOKENS" >> "$LOG_FILE"

    # Check 1: Respawn not enabled when it should be
    if [ "$RESPAWN_ENABLED" = "null" ] || [ "$RESPAWN_ENABLED" = "false" ]; then
        if [ -z "$RESPAWN_NOT_ENABLED_LOGGED" ]; then
            log_issue "INFO" "Respawn controller not enabled" "Respawn is currently disabled for this session. State: $RESPAWN_ENABLED"
            log_fix "$ISSUE_COUNT" "Enable respawn controller" "Via API:
\`\`\`bash
curl -sk -X POST '$API_BASE/api/sessions/$SESSION_ID/respawn/enable'
\`\`\`

Or via web UI: Open session tab -> Respawn panel -> Enable"
            RESPAWN_NOT_ENABLED_LOGGED=1
        fi
    else
        unset RESPAWN_NOT_ENABLED_LOGGED

        # Check 2: State stuck for too long
        if [ "$RESPAWN_STATE" = "$PREV_STATE" ] && [ -n "$PREV_STATE" ]; then
            STATE_STUCK_COUNT=$((STATE_STUCK_COUNT + 1))

            # Stuck in same state for 10+ minutes (20 polls at 30s)
            if [ $STATE_STUCK_COUNT -ge 20 ]; then
                STUCK_MINS=$((STATE_STUCK_COUNT * POLL_INTERVAL / 60))
                log_issue "WARNING" "State stuck: $RESPAWN_STATE for ${STUCK_MINS}+ minutes" "The respawn controller has been in '$RESPAWN_STATE' state for over $STUCK_MINS minutes.
Time in state: ${TIME_IN_STATE}ms
Detection status: $DETECTION_STATUS"

                case "$RESPAWN_STATE" in
                    "watching")
                        log_fix "$ISSUE_COUNT" "Watching state stuck" "The controller is watching but not detecting idle. Possible causes:
1. Session is actively working (expected behavior)
2. Idle detection thresholds too high

Check session activity:
\`\`\`bash
curl -sk '$API_BASE/api/sessions/$SESSION_ID' | jq '{status, lastActivityAt}'
\`\`\`

If truly idle, try adjusting config:
\`\`\`bash
curl -sk -X POST '$API_BASE/api/sessions/$SESSION_ID/respawn/config' -H 'Content-Type: application/json' -d '{\"idleThresholdMs\": 30000}'
\`\`\`"
                        ;;
                    "confirming_idle")
                        log_fix "$ISSUE_COUNT" "Confirming idle stuck" "Stuck confirming idle state. The session may be oscillating between idle/working.

Check idle confidence:
\`\`\`bash
curl -sk '$API_BASE/api/sessions/$SESSION_ID/respawn/status' | jq '.detectionStatus'
\`\`\`

Consider increasing confirmation time or check for output patterns that reset detection."
                        ;;
                    "ai_checking")
                        log_fix "$ISSUE_COUNT" "AI check stuck" "AI idle check is taking too long or failing.

Check AI checker status and logs:
\`\`\`bash
journalctl --user -u claudeman-web -n 100 | grep -i 'ai.*check\\|idle.*check'
\`\`\`

The AI checker spawns a separate Claude process. It may be hanging. Consider:
1. Check for stuck Claude processes: \`ps aux | grep claude\`
2. Restart the respawn controller:
\`\`\`bash
curl -sk -X POST '$API_BASE/api/sessions/$SESSION_ID/respawn/stop'
sleep 2
curl -sk -X POST '$API_BASE/api/sessions/$SESSION_ID/respawn/start'
\`\`\`"
                        ;;
                    "sending_"*|"waiting_"*)
                        log_fix "$ISSUE_COUNT" "Send/wait state stuck" "Stuck in $RESPAWN_STATE - the controller is trying to send a command but may not be receiving expected response.

Check terminal output:
\`\`\`bash
curl -sk '$API_BASE/api/sessions/$SESSION_ID/terminal?tail=10000' | tail -100
\`\`\`

Try restarting respawn:
\`\`\`bash
curl -sk -X POST '$API_BASE/api/sessions/$SESSION_ID/respawn/stop'
curl -sk -X POST '$API_BASE/api/sessions/$SESSION_ID/respawn/start'
\`\`\`"
                        ;;
                    *)
                        log_fix "$ISSUE_COUNT" "Unknown stuck state" "State '$RESPAWN_STATE' is stuck. Review respawn-controller.ts for this state's expected behavior and transitions."
                        ;;
                esac
                STATE_STUCK_COUNT=0
            fi
        else
            STATE_STUCK_COUNT=0
            PREV_STATE="$RESPAWN_STATE"
        fi

        # Check 3: Error in respawn controller
        if [ "$LAST_ERROR" != "none" ] && [ "$LAST_ERROR" != "null" ] && [ -n "$LAST_ERROR" ]; then
            log_issue "ERROR" "Respawn controller error" "Error reported: $LAST_ERROR"
            log_fix "$ISSUE_COUNT" "Resolve respawn error" "Error: $LAST_ERROR

General recovery steps:
1. Stop respawn: \`curl -sk -X POST '$API_BASE/api/sessions/$SESSION_ID/respawn/stop'\`
2. Check session health: \`curl -sk '$API_BASE/api/sessions/$SESSION_ID' | jq .\`
3. Restart respawn: \`curl -sk -X POST '$API_BASE/api/sessions/$SESSION_ID/respawn/start'\`

If error persists, check server logs:
\`journalctl --user -u claudeman-web -n 200 | grep -i error\`"
        fi

        # Check 4: Token count not progressing during active work
        if [ "$STATUS" = "busy" ] && [ "$RESPAWN_STATE" = "watching" ]; then
            if [ $TOTAL_TOKENS -eq $PREV_TOKENS ] && [ $PREV_TOKENS -gt 0 ]; then
                TOKENS_STUCK_COUNT=$((TOKENS_STUCK_COUNT + 1))
                if [ $TOKENS_STUCK_COUNT -ge 10 ]; then  # 5 minutes
                    log_issue "WARNING" "Tokens not increasing while busy" "Session status is 'busy' but token count hasn't changed in 5+ minutes.
Current: $TOTAL_TOKENS, Previous: $PREV_TOKENS
This could indicate a hung Claude process."
                    log_fix "$ISSUE_COUNT" "Check for hung session" "The session may be hung. Check:

1. Session process status:
\`\`\`bash
screen -ls | grep reddit
\`\`\`

2. Attach to screen and check:
\`\`\`bash
screen -r claudeman-w3-reddit-analyse
# Press Ctrl+A D to detach
\`\`\`

3. If hung, restart the session via web UI or:
\`\`\`bash
curl -sk -X POST '$API_BASE/api/sessions/$SESSION_ID/stop'
# Then start a new session
\`\`\`"
                    TOKENS_STUCK_COUNT=0
                fi
            else
                TOKENS_STUCK_COUNT=0
            fi
        fi
        PREV_TOKENS=$TOTAL_TOKENS

        # Check 5: Rapid state cycling (flapping)
        if [ "$RESPAWN_STATE" != "$PREV_STATE" ]; then
            STATE_CHANGES=$((STATE_CHANGES + 1))
        fi

        # Check every 5 minutes for flapping
        if [ $((STATE_CHANGES_CHECK_COUNT % 10)) -eq 0 ] && [ $STATE_CHANGES_CHECK_COUNT -gt 0 ]; then
            if [ $STATE_CHANGES -gt 20 ]; then  # More than 20 state changes in 5 mins
                log_issue "WARNING" "State flapping detected" "Respawn controller changed states $STATE_CHANGES times in the last 5 minutes. This indicates instability."
                log_fix "$ISSUE_COUNT" "Reduce state flapping" "The controller is cycling states too rapidly. This usually means:
1. Idle detection is too sensitive
2. Session output is oscillating

Adjust detection thresholds:
\`\`\`bash
curl -sk -X POST '$API_BASE/api/sessions/$SESSION_ID/respawn/config' -H 'Content-Type: application/json' -d '{
  \"idleThresholdMs\": 60000,
  \"completionConfirmMs\": 15000
}'
\`\`\`"
            fi
            STATE_CHANGES=0
        fi
        STATE_CHANGES_CHECK_COUNT=$((STATE_CHANGES_CHECK_COUNT + 1))

        # Check 6: High token usage without respawn cycling
        if [ $TOTAL_TOKENS -gt 180000 ]; then
            log_issue "WARNING" "High token usage: $TOTAL_TOKENS" "Token count is very high. Auto-compact or respawn should have triggered by now."
            log_fix "$ISSUE_COUNT" "Handle high token usage" "Tokens at $TOTAL_TOKENS. Consider:

1. Manual compact:
\`\`\`bash
curl -sk -X POST '$API_BASE/api/sessions/$SESSION_ID/input' -H 'Content-Type: application/json' -d '{\"input\": \"/compact\\r\"}'
\`\`\`

2. Check auto-compact settings:
\`\`\`bash
curl -sk '$API_BASE/api/sessions/$SESSION_ID' | jq '{autoCompactEnabled, autoCompactThreshold}'
\`\`\`"
        fi
    fi

    sleep $POLL_INTERVAL
done

echo "" >> "$ISSUES_FILE"
echo "---" >> "$ISSUES_FILE"
echo "Monitoring completed: $(date)" >> "$ISSUES_FILE"
echo "Total issues detected: $ISSUE_COUNT" >> "$ISSUES_FILE"

echo "" >> "$FIXES_FILE"
echo "---" >> "$FIXES_FILE"
echo "Monitoring completed: $(date)" >> "$FIXES_FILE"

echo "" >> "$LOG_FILE"
echo "=== Monitoring Complete: $(date) ===" >> "$LOG_FILE"
echo "Total issues: $ISSUE_COUNT" >> "$LOG_FILE"
