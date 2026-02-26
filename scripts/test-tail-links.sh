#!/bin/bash
# Test script for clickable file links in Codeman terminal
# Creates a log file and continuously writes timestamped data

LOGFILE="/tmp/codeman-test-$(date +%s).log"

echo "Created log file: $LOGFILE"
echo ""
echo "You can monitor this file with:"
echo "  tail -f $LOGFILE"
echo ""
echo "Starting to write data every 2 seconds..."
echo ""

# Write initial content
echo "=== Test Log Started at $(date) ===" > "$LOGFILE"

# Write data continuously
count=0
while true; do
    count=$((count + 1))
    echo "[$(date '+%H:%M:%S')] Entry #$count - Random: $RANDOM" >> "$LOGFILE"

    # Print status every 5 entries
    if [ $((count % 5)) -eq 0 ]; then
        echo "Wrote $count entries to $LOGFILE"
    fi

    sleep 2
done
