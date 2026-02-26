#!/bin/bash
# Respawn Controller Monitor - 12 hour monitoring script
# Usage: ./scripts/monitor-respawn.sh <session_id> [duration_hours]

SESSION_ID="${1:-5ecdf859-3605-42d8-b0a2-f8f0a1b5ff98}"
DURATION_HOURS="${2:-12}"
ISSUES_FILE="/home/arkon/default/codeman/respawn-monitor-issues.md"
FIXES_FILE="/home/arkon/default/codeman/respawn-monitor-fixes.md"
API_URL="https://localhost:3000"
POLL_INTERVAL=60  # seconds

# Calculate end time
END_TIME=$(($(date +%s) + DURATION_HOURS * 3600))

log_issue() {
    local severity="$1"
    local message="$2"
    local timestamp=$(date '+%Y-%m-%d %H:%M:%S')
    echo "" >> "$ISSUES_FILE"
    echo "### [$severity] $timestamp" >> "$ISSUES_FILE"
    echo "$message" >> "$ISSUES_FILE"
    echo "" >> "$ISSUES_FILE"
}

add_fix() {
    local issue="$1"
    local fix="$2"
    local timestamp=$(date '+%Y-%m-%d %H:%M:%S')
    echo "" >> "$FIXES_FILE"
    echo "### Issue: $issue" >> "$FIXES_FILE"
    echo "**Detected:** $timestamp" >> "$FIXES_FILE"
    echo "" >> "$FIXES_FILE"
    echo "**Proposed Fix:**" >> "$FIXES_FILE"
    echo "$fix" >> "$FIXES_FILE"
    echo "" >> "$FIXES_FILE"
    echo "---" >> "$FIXES_FILE"
}

# State tracking
PREV_STATE=""
STATE_STUCK_COUNT=0
PREV_CYCLE=0
LAST_ACTIVITY=0
AI_CHECK_ERRORS=0

echo "Starting respawn monitoring for session $SESSION_ID"
echo "Duration: $DURATION_HOURS hours"
echo "Issues logged to: $ISSUES_FILE"
echo "Fixes logged to: $FIXES_FILE"

while [ $(date +%s) -lt $END_TIME ]; do
    # Get respawn status
    RESP=$(curl -sk "$API_URL/api/sessions/$SESSION_ID" 2>/dev/null)

    if [ -z "$RESP" ]; then
        log_issue "ERROR" "API not responding - server may be down"
        add_fix "API not responding" "Check if codeman-web service is running:\n\`\`\`bash\nsystemctl --user status codeman-web\nsystemctl --user restart codeman-web\n\`\`\`"
        sleep $POLL_INTERVAL
        continue
    fi

    # Parse response
    STATE=$(echo "$RESP" | jq -r '.respawn.state // "null"')
    CYCLE=$(echo "$RESP" | jq -r '.respawn.cycleCount // 0')
    ENABLED=$(echo "$RESP" | jq -r '.respawnEnabled // false')
    TOKENS=$(echo "$RESP" | jq -r '.respawn.config.lastTokenCount // 0')
    AI_STATUS=$(echo "$RESP" | jq -r '.respawn.detection.aiCheck.status // "unknown"')
    AI_ERRORS=$(echo "$RESP" | jq -r '.respawn.detection.aiCheck.consecutiveErrors // 0')
    TIME_SINCE_ACTIVITY=$(echo "$RESP" | jq -r '.respawn.timeSinceActivity // 0')
    CONFIDENCE=$(echo "$RESP" | jq -r '.respawn.detection.confidenceLevel // 0')
    SESSION_STATUS=$(echo "$RESP" | jq -r '.status // "unknown"')

    # Check for issues

    # 1. Session not running
    if [ "$SESSION_STATUS" = "stopped" ] || [ "$SESSION_STATUS" = "error" ]; then
        log_issue "CRITICAL" "Session status is '$SESSION_STATUS' - respawn may not function correctly"
        add_fix "Session stopped/error" "Check session health and restart if needed:\n\`\`\`bash\ncurl -sk $API_URL/api/sessions/$SESSION_ID\n# If needed, create new session or restart\n\`\`\`"
    fi

    # 2. Respawn disabled unexpectedly
    if [ "$ENABLED" = "false" ] && [ "$PREV_STATE" != "" ] && [ "$PREV_STATE" != "null" ]; then
        log_issue "WARNING" "Respawn appears to have been disabled (was in state: $PREV_STATE)"
        add_fix "Respawn disabled" "Re-enable respawn controller:\n\`\`\`bash\ncurl -sk -X POST $API_URL/api/sessions/$SESSION_ID/respawn/enable\n\`\`\`"
    fi

    # 3. State stuck for too long (>30 minutes in same state)
    if [ "$STATE" = "$PREV_STATE" ] && [ "$STATE" != "watching" ]; then
        STATE_STUCK_COUNT=$((STATE_STUCK_COUNT + 1))
        if [ $STATE_STUCK_COUNT -ge 30 ]; then  # 30 minutes
            log_issue "WARNING" "State stuck in '$STATE' for $STATE_STUCK_COUNT minutes. Detection: confidence=$CONFIDENCE, timeSinceActivity=${TIME_SINCE_ACTIVITY}ms"
            add_fix "State stuck in $STATE" "The respawn controller may be stuck. Options:\n1. Check terminal for blocking prompts\n2. Send input to unstick:\n\`\`\`bash\ncurl -sk -X POST $API_URL/api/sessions/$SESSION_ID/input -d '{\"input\": \"\\\\r\"}'\n\`\`\`\n3. Restart respawn:\n\`\`\`bash\ncurl -sk -X POST $API_URL/api/sessions/$SESSION_ID/respawn/stop\ncurl -sk -X POST $API_URL/api/sessions/$SESSION_ID/respawn/start\n\`\`\`"
            STATE_STUCK_COUNT=0  # Reset to avoid spam
        fi
    else
        STATE_STUCK_COUNT=0
    fi

    # 4. AI check errors
    if [ "$AI_ERRORS" -gt 2 ] && [ "$AI_ERRORS" -gt "$AI_CHECK_ERRORS" ]; then
        log_issue "WARNING" "AI idle check has $AI_ERRORS consecutive errors (status: $AI_STATUS)"
        add_fix "AI check errors" "AI idle checker is failing. Check:\n1. Claude CLI is working\n2. Sufficient context available\n3. Consider disabling AI check temporarily:\n\`\`\`bash\ncurl -sk -X POST $API_URL/api/sessions/$SESSION_ID/respawn/config -H 'Content-Type: application/json' -d '{\"aiIdleCheckEnabled\": false}'\n\`\`\`"
        AI_CHECK_ERRORS=$AI_ERRORS
    fi

    # 5. Cycle completed - log success
    if [ "$CYCLE" -gt "$PREV_CYCLE" ] && [ "$PREV_CYCLE" -gt 0 ]; then
        log_issue "INFO" "Respawn cycle $CYCLE completed successfully (tokens: $TOKENS)"
    fi

    # 6. Very high time since activity (>10 minutes) while not in watching state
    if [ "$TIME_SINCE_ACTIVITY" -gt 600000 ] && [ "$STATE" != "watching" ]; then
        log_issue "WARNING" "No activity for ${TIME_SINCE_ACTIVITY}ms while in state '$STATE' - may be stuck"
    fi

    # Update tracking vars
    PREV_STATE="$STATE"
    PREV_CYCLE="$CYCLE"

    sleep $POLL_INTERVAL
done

log_issue "INFO" "Monitoring completed after $DURATION_HOURS hours"
echo "Monitoring complete. Check $ISSUES_FILE and $FIXES_FILE"
