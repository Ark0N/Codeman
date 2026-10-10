# Worked orchestration flows

Loaded on demand from the `codeman` skill. Every flow assumes the SKILL.md preamble is
in scope (`$API`, `$SELF`, `$CID`, `"${CURL[@]}"`, `delete_session`, plus the fast-path
verbs `spawn_worker` / `spawn_workers` / `sendwait` / `last_text`); see
[SKILL.md §0](../SKILL.md#0-guard-and-bootstrap) for it and
[the safety rules](../SKILL.md#4-safety-rules) for what you may call unprompted.

⚠️ **These flows are the long way round, and most jobs do not need them.** If the job is
"spawn N claude workers, task them, collect the answers", [SKILL.md
§1](../SKILL.md#1-the-fast-path-n-workers-one-bash-call) already is that job in one Bash
call, measured at about 10 s for two cold workers end to end. Come here when you need a
mechanism §1 does not cover: shell or otherwise hook-less workers (Flows 2, 3), a worker
stuck on a permission dialog (Flow 5), messaging (Flow 6), or real work in git worktrees
(Flow 7). The flows below spell each step out because they are teaching the mechanism;
spelling them out again when §1 would have done is the most common way an agent turns a
ten-second run into a multi-minute one.

⚠️ **Shell state does not survive between tool calls**, so every Bash call below opens
by sourcing the preamble file the §0 bootstrap wrote, and checking its version stamp:

```bash
. "${XDG_CACHE_HOME:-$HOME/.cache}/codeman-agent-$CODEMAN_SESSION_ID.sh" 2>/dev/null
[ "${CODEMAN_PREAMBLE:-}" = 1.33.4 ] || { echo "preamble missing or stale; re-run the §0 bootstrap"; exit 1; }
```

Do **not** re-paste the preamble body into each call. Sourcing it is what retires the
half-paste hazard the fail-closed `delete_session` exists to contain, and a `clientId` you
rebuild from `$$` changes per call, which turns the duplicate-resend loop in Flow 1
into a second typed prompt.

Track every session id you create; delete them (and only them) when done. The two
silent killers: **every input ends with `\r`**, and **markers must be split** so the
typed-line echo does not match them.

| Flow | Use it when |
|------|-------------|
| [1](#flow-1-claude-worker-end-to-end) | one claude worker: spawn, readiness, task, answer, delete |
| [2](#flow-2-shell-worker-marker-synchronized) | one shell/hook-less worker synchronized on a printed marker |
| [3](#flow-3-fan-out-n-shell-workers) | N shell workers, gathered as each finishes |
| [4](#flow-4-fan-out-n-claude-workers) | N claude workers (send-and-wait is synchronous, so the shell shape does not translate) |
| [5](#flow-5-watch-for-a-worker-stuck-on-a-prompt) | a worker may be sitting on a permission dialog |
| [6](#flow-6-claude-fan-out-over-messaging) | same as 4, but cross-session messaging is available |
| [7](#flow-7-the-whole-job) | the real ask, start to finish: parallel work in git worktrees, reviewed, reported |

Flows 1-6 each teach one mechanism. Flow 7 is a whole job built out of them, and it is
the one to read if you are about to orchestrate real work.

## Flow 1: claude worker, end to end

Start a worker, get it truly ready (trust dialog included), give it a task, wait for
the turn to finish, read the answer, clean up. Verified live: the stop hook resolves
the send-and-wait within seconds of the turn ending.

```bash
# 1. start (returns before the CLI inside is ready). ALWAYS check .success: on failure
#    .data.sessionId is null, jq -r yields the string "null", and every step below
#    then runs against /api/v1/sessions/null and reports jq noise, not the cause.
Q=$("${CURL[@]}" -X POST "$API/api/v1/quick-start" -H 'Content-Type: application/json' \
  -d '{"caseName":"worker-tests","mode":"claude"}')
SID=$(jq -r 'if .success then .data.sessionId else empty end' <<<"$Q")
[ -n "$SID" ] || { jq -c '{error, errorCode}' <<<"$Q"; echo "quick-start failed"; exit 1; }
CREATED+=("$SID")   # the cleanup list
SEQ=1               # $CID is the fixed literal from the preamble; never rebuild it from $$

# 2. readiness. "wait for idle" or "wait for ❯" is NOT readiness: a fresh session
#    reports idle before anything spawned, and the first-run trust dialog contains ❯.
#    Codeman CAN auto-accept that dialog: it reads the RENDERED PANE (capturePaneText
#    plus a two-marker screen match in session-trust-dialog.ts), not the output stream.
#    It still misses two ways, and both leave the dialog up until someone answers it:
#    it only scans in the first 90 s after the pane started (TRUST_DIALOG_WINDOW_MS),
#    and it gives up after 6 keystrokes (TRUST_DIALOG_MAX_ATTEMPTS). So: composer
#    marker first, dialog only as the bounded fallback.
#    ⚠️ The dialog is NOT answered with Enter. Since claude-cli 2.1.252 the options
#    lost their numbers, swapped places, and the highlighted one is `No, exit`, so a
#    blind \r quits the CLI and the pane is dead seconds after the spawn (measured).
#    _accept_trust (§0 preamble) reads the ❯ marker off the rendered pane, arrows onto
#    `Yes, I trust this folder`, re-reads to confirm the move landed, and only then
#    presses Enter.
#    Stage 1 is SHORT on purpose: an already-trusted case matches in <1 s, while a
#    virgin case can never pass it (the dialog is up) and always pays it in full,
#    the long budget belongs to stage 3, after the dialog is answered.
#    Single-token matches only: TUI text is space-less in the stream.
#    ⚠️ `bypass` is the statusline of ONE permission mode (the default one Codeman
#    spawns). The server's `claudeMode` setting also has auto/allowedTools/normal
#    spawns whose statusline differs, and the per-session effective mode is not
#    exposed on GET /api/v1/sessions/:id. `shift+tab` is the one token EVERY mode's
#    status bar ends with ('(shift+tab to cycle)'), measured per mode, so match that
#    and not `bypass`.
#    The `+` needs --data-urlencode or it decodes to a space. Stage 4 remains the last
#    resort: proving readiness by making the worker answer rather than by chrome.
for _ in $(seq 1 30); do
  [ "$("${CURL[@]}" "$API/api/v1/sessions/$SID" | jq '.data.pid')" != null ] && break; sleep 1
done
# (pid != null proves startup only, a worker that later dies inside its pane keeps
#  status "idle" and a pid. The death check is wait?until=exit.)
R=$("${CURL[@]}" -G "$API/api/v1/sessions/$SID/wait-output" \
    --data-urlencode 'match=shift+tab' --data-urlencode 'from=buffer' --data-urlencode 'timeout=5000')
if ! jq -e '.data.wait.matched' <<<"$R" >/dev/null; then
  _accept_trust "$SID"   # reads the marker and steers; never a blind \r. Own clientId,
                         # so it spends none of $SEQ's numbers.
  R=$("${CURL[@]}" -G "$API/api/v1/sessions/$SID/wait-output" \
      --data-urlencode 'match=shift+tab' --data-urlencode 'from=buffer' --data-urlencode 'timeout=45000')
fi
if ! jq -e '.data.wait.matched' <<<"$R" >/dev/null; then
  # stage 4, mode-agnostic and bounded: answering a trivial prompt IS readiness.
  # COSTS THE WORKER ONE BILLED TURN, so it only runs when the fast marker missed.
  # Split token (the typed line echoes into the stream) and unique per call. Must stay
  # AFTER the dialog fallback: the select widget swallows the text and the \r answers
  # whatever is highlighted, which on a live dialog is `No, exit`.
  TOK="${RANDOM}_$$"
  "${CURL[@]}" -X POST "$API/api/v1/sessions/$SID/input" -H 'Content-Type: application/json' \
    -d '{"input":"reply with the word READY immediately followed by _'"$TOK"' and nothing else\r","useMux":true,"clientId":"'"$CID"'","seq":'$SEQ'}' >/dev/null
  SEQ=$((SEQ+1))
  "${CURL[@]}" -G "$API/api/v1/sessions/$SID/wait-output" \
    --data-urlencode "match=READY_$TOK" --data-urlencode 'from=buffer' --data-urlencode 'timeout=60000' \
    | jq -e '.data.wait.matched' >/dev/null || echo "worker $SID not ready; inspect terminal?tail="
fi

# 3. send-and-wait, looping on the IDENTICAL request (tagged duplicate: no retype).
#    The first iteration costs the worker one billed turn; the resends cost none (they
#    do not retype, they only re-ask about the same delivery).
#    BOUNDED (a \r-less send would otherwise loop forever), body built with jq -n so
#    quotes/backslashes/$ in a real prompt survive; note the appended \r.
PROMPT='run the unit tests and summarize failures in one line'
BODY=$(jq -n --arg p "$PROMPT" --arg c "$CID" --argjson s "$SEQ" \
  '{input:($p+"\r"),useMux:true,clientId:$c,seq:$s,wait:true,waitTimeout:60000}')
for TRY in $(seq 1 10); do
  R=$("${CURL[@]}" -X POST "$API/api/v1/sessions/$SID/input" \
      -H 'Content-Type: application/json' --data-binary "$BODY")
  if jq -e '.data.wait.timedOut' <<<"$R" >/dev/null; then
    jq -e '.data.limitPaused' <<<"$R" >/dev/null && sleep 60   # usage-limit pause: silence is expected
    [ "$TRY" = 2 ] && "${CURL[@]}" "$API/api/v1/sessions/$SID/terminal?tail=2000" \
      | jq -r '.data.terminalBuffer' | tail -5   # is the prompt sitting unsubmitted?
    continue
  fi
  # Resolved, but duplicate + immediate is only "the session is idle NOW", which a
  # never-submitted (\r-less) prompt also produces. Check before believing it:
  if jq -e '.data.duplicate and .data.wait.immediate' <<<"$R" >/dev/null; then
    "${CURL[@]}" "$API/api/v1/sessions/$SID/terminal?tail=2000" \
      | jq -r '.data.terminalBuffer' | tail -5
    # prompt still on the ❯ composer line = never submitted; {"input":"\r"} is the
    # only recovery (and that flush costs the worker one billed turn, reasoning about
    # the junk line), then loop again
  fi
  break
done
SEQ=$((SEQ+1))

# 4. interpret. Read `delivered` BEFORE `ended`: on the send-and-wait path `ended` does
#    NOT mean "the session is gone" on its own.
case "$(jq -r '.data.wait.signal' <<<"$R")" in
  stop) : ;;                          # definitive end of turn
  idle) : ;;                          # heuristic, and if it rode a duplicate with
                                      # immediate:true, it proves nothing ran (step 3)
  exit) echo "worker died" ;;
  null)
    if jq -e '.data.wait.ended' <<<"$R" >/dev/null; then
      if jq -e '.data.delivered == false and .data.duplicate == false' <<<"$R" >/dev/null; then
        # The session still EXISTS. tmux send-keys succeeds against a dead pane, so the
        # server checks the pane, rewrites delivered to false and releases its own
        # waiter (session-routes.ts) rather than blocking for the full timeout. Nothing
        # was typed and no turn is coming. RECOVERY: restart the worker
        # (POST .../interactive), then resend at the SAME seq: the failed delivery was
        # un-recorded, so the resend is not refused as a duplicate. Deleting the
        # session here would kill a session that is still there.
        echo "nothing was written; worker $SID needs a restart"
      else
        # delivered:true (or a duplicate) plus ended = the wait was released because the
        # session really was deleted/torn down mid-wait. The worker is gone; stop.
        echo "session torn down mid-wait"
      fi
    fi
    ;;
esac
#    On the two GET waits there is no `delivered` field at all, so `ended` there does
#    mean the session went away.

# 5. read the answer. For a claude worker this is last-response: clean transcript text,
#    no TUI repaint noise. Do NOT scrape the terminal for this, a full-screen TUI
#    draws with cursor moves, so the stripped buffer is nearly one long line and the
#    answer arrives buried in redraw garbage.
#    POLL it: the transcript flush lags the stop signal, so a single read taken the
#    instant step 3 returned comes back "" even though the turn finished (verified live).
for _ in $(seq 1 10); do
  TXT=$("${CURL[@]}" "$API/api/v1/sessions/$SID/last-response" | jq -r '.data.text')
  [ -n "$TXT" ] && break; sleep 1
done
printf '%s\n' "$TXT"
#    (.data is {text,timestamp}; text is also "" before the first completed turn and
#     always "" for shell/opencode/gemini/antigravity/pi/grok/omp/copilot, which have no transcript, use
#     the terminal tail there, and here only to diagnose an unsubmitted prompt.)

# 6. clean up: exact id, own list only, through the fail-closed preamble helper
delete_session "$SID"
```

Increment `SEQ` for every *new* input to the same worker. Reuse the same `SEQ` only to
re-ask about the same delivery (the duplicate-wait loop above).

## Flow 1b: DeepSeek Harness worker, end to end

A `deepseek` worker is driven with the same four verbs as a claude one, because the
harness reports its own lifecycle: its `stop` is a real end-of-turn signal, and its
answer comes from a real transcript. The differences are all at the edges.

```bash
# 0. Is there anything to spawn? `available` is the binary, `runnable` is a profile
#    that can drive a pane -- dsh ships only web/headless, so the two differ.
"${CURL[@]}" "$API/api/v1/deepseek/status" | jq -c '{available:.data.available,runnable:.data.runnable,profile:.data.defaultProfile}'

# 1. Spawn. `deepSeekConfig` is optional: an absent profile picks the first
#    pane-capable one, and an absent permissionMode leaves the harness on its own
#    workspace-write default, which still ASKS before it acts.
Q=$("${CURL[@]}" -X POST "$API/api/v1/quick-start" -H 'Content-Type: application/json' \
  -d '{"caseName":"dsh-worker","mode":"deepseek","deepSeekConfig":{"permissionMode":"danger-full-access"}}')
SID=$(jq -r 'if .success then .data.sessionId else empty end' <<<"$Q")
[ -n "$SID" ] || { jq -c '{error, errorCode}' <<<"$Q"; exit 1; }   # OPERATION_FAILED = no runnable profile
CREATED+=("$SID")

# 2. Readiness, and ONLY readiness. ⚠️ Do not use the stop signal for this: the
#    harness reports idle at BOOT, ~300 ms before the composer paints.
"${CURL[@]}" -G "$API/api/v1/sessions/$SID/wait-output" \
  --data-urlencode 'match=❯' --data-urlencode 'from=buffer' --data-urlencode 'timeout=45000' \
  | jq -e '.data.wait.matched' >/dev/null || { echo "no composer"; delete_session "$SID"; exit 1; }

# 3. Task it. Identical to a claude worker, including the \r and the (clientId, seq).
"${CURL[@]}" -X POST "$API/api/v1/sessions/$SID/input" -H 'Content-Type: application/json' \
  -d '{"input":"Read calc.py and tell me in one sentence whether add() is correct.\r","useMux":true,"clientId":"codeman-dsh-1","seq":1,"wait":"stop,exit","waitTimeout":300000}' \
  | jq -c '{delivered:.data.delivered,signal:.data.wait.signal,timedOut:.data.wait.timedOut}'

# 4. Read it. From $DSH_HOME/sessions/**, not the pane -- scraping a dsh pane returns
#    its ASCII-art splash. Poll: the harness finalizes the message just after it
#    reports idle. Two answers are not the model's words and say so:
#    "Turn error: …" (the provider or harness failed) and "Turn ended: …" (early stop).
for _ in $(seq 1 15); do
  TXT=$("${CURL[@]}" "$API/api/v1/sessions/$SID/last-response" | jq -r '.data.text')
  [ -n "$TXT" ] && break; sleep 1
done
printf '%s\n' "$TXT"

# 5. Full conversation, if you need the tool calls too:
#    "${CURL[@]}" "$API/api/v1/sessions/$SID/last-response?context=full" | jq -r '.data.messages[]|"[\(.label)] \(.text)"'

delete_session "$SID"
```

⚠️ **`wait:"stop,exit"`, not `wait:true`.** The default set also carries `idle`, which
for an external CLI is inferred from output stabilization: a dsh TUI that repaints
rarely reads as idle mid-turn, and a wait carrying `idle` then resolves in 0 ms on a
turn with minutes left to run (measured). The same reason the preamble's `sendwait`
asks for `stop,exit` on every mode.

## Flow 2: shell worker, marker-synchronized

`shell` sessions have no hooks (`stop`/`blocked` are a 400 there), and their lifecycle
signals are coarse, a short command may emit no `idle` transition at all (verified
live), so send-and-wait can burn its whole timeout. The reliable pattern is a split,
unique marker plus `wait-output from=buffer`:

```bash
Q=$("${CURL[@]}" -X POST "$API/api/v1/quick-start" -H 'Content-Type: application/json' \
  -d '{"caseName":"builder","mode":"shell"}')
SID=$(jq -r 'if .success then .data.sessionId else empty end' <<<"$Q")
[ -n "$SID" ] || { jq -c '{error, errorCode}' <<<"$Q"; echo "quick-start failed"; exit 1; }
CREATED+=("$SID")
for _ in $(seq 1 30); do
  [ "$("${CURL[@]}" "$API/api/v1/sessions/$SID" | jq '.data.pid')" != null ] && break; sleep 1
done

# Split marker: the typed line carries ${M}_N, only the OUTPUT carries DONE_N.
# An unsplit marker matches the echo of your own keystrokes before the build runs.
N="${RANDOM}_$$"; MARK="DONE_$N"
"${CURL[@]}" -X POST "$API/api/v1/sessions/$SID/input" -H 'Content-Type: application/json' \
  -d '{"input":"M=DONE; npm run build; echo ${M}_'"$N"' rc=$?\r","useMux":true,"clientId":"codeman-build-1","seq":1}'

for TRY in $(seq 1 30); do   # BOUNDED (30 min): a \r-less send makes an uncapped loop infinite
  R=$("${CURL[@]}" -G "$API/api/v1/sessions/$SID/wait-output" \
      --data-urlencode "match=$MARK" --data-urlencode 'from=buffer' --data-urlencode 'timeout=60000')
  jq -e '.data.wait.matched' <<<"$R" >/dev/null && break
  jq -e '.data.wait.ended'   <<<"$R" >/dev/null && { echo "worker gone"; break; }
  [ "$TRY" = 2 ] && "${CURL[@]}" "$API/api/v1/sessions/$SID/terminal?tail=2000" \
    | jq -r '.data.terminalBuffer' | tail -5   # command still sitting unsubmitted?
done
jq -r '.data.wait.snippet' <<<"$R"    # e.g. "DONE_123_456 rc=0", the exit code rides the marker line
```

If the bound runs out without a match, the build is unfinished, not failed: say exactly
that in your report (with the last terminal tail), and do not silently present partial
results as the outcome.

## Flow 3: fan out N shell workers

Start everything first, then gather. One in-flight wait per worker, the per-session
waiter cap is 16 and abandoned concurrent waits pile up against it.

```bash
declare -A WORKER MARKS
for task in lint typecheck unit; do
  Q=$("${CURL[@]}" -X POST "$API/api/v1/quick-start" -H 'Content-Type: application/json' \
    -d '{"caseName":"fan-'"$task"'","mode":"shell"}')
  SID=$(jq -r 'if .success then .data.sessionId else empty end' <<<"$Q")
  [ -n "$SID" ] || { jq -c '{error, errorCode}' <<<"$Q"; echo "$task: spawn failed"; continue; }
  WORKER[$task]=$SID; CREATED+=("$SID")
done
for task in "${!WORKER[@]}"; do
  SID=${WORKER[$task]}
  for _ in $(seq 1 30); do
    [ "$("${CURL[@]}" "$API/api/v1/sessions/$SID" | jq '.data.pid')" != null ] && break; sleep 1
  done
  N="${task}_${RANDOM}"; MARKS[$task]="DONE_$N"
  "${CURL[@]}" -X POST "$API/api/v1/sessions/$SID/input" -H 'Content-Type: application/json' \
    -d '{"input":"M=DONE; npm run '"$task"'; echo ${M}_'"$N"' rc=$?\r","useMux":true,"clientId":"codeman-fan-'"$task"'","seq":1}'
done
for task in "${!WORKER[@]}"; do        # sequential gather; each wait blocks until that worker is done
  DONE=0
  for TRY in $(seq 1 30); do           # BOUNDED per worker, same reasoning as Flow 2
    R=$("${CURL[@]}" -G "$API/api/v1/sessions/${WORKER[$task]}/wait-output" \
        --data-urlencode "match=${MARKS[$task]}" --data-urlencode 'from=buffer' --data-urlencode 'timeout=60000')
    jq -e '.data.wait.matched or .data.wait.ended' <<<"$R" >/dev/null && { DONE=1; break; }
  done
  # Name the bound when it runs out: an exhausted gather is an UNFINISHED worker, and
  # reporting only the ones that matched reads as "all done" when it was not.
  [ "$DONE" = 1 ] || { echo "$task: still running after 30 min, not gathered"; continue; }
  echo "$task: $(jq -r '.data.wait.snippet // "worker gone"' <<<"$R" | tail -1)"
done
```

## Flow 4: fan out N claude workers

Send-and-wait is synchronous, so the shell-flow shape ("send everything, then
gather") does not translate directly: the send *is* the wait, and worker 2's prompt
would not go out until worker 1's turn ended. Two working patterns, both verified
live (and one anti-pattern, measured failing, replaced by B):

**A. Background the send-and-waits** (simplest; each resolved on `stop` while the
other was still running). Each send costs its worker one billed turn:

`sendwait <sid> <prompt> [seq]` is a preamble function ([SKILL.md
§0](../SKILL.md#0-guard-and-bootstrap)); it applies the `\r` and a per-worker `clientId`,
and picks a fresh `seq` (the current epoch second) per call, so do not redefine it here
and pass `seq` yourself only to resend an identical frame as a deliberate duplicate.
Background one call per worker and `wait`:

```bash
D=$(mktemp -d)   # a function's stdout is per-worker, so collect it in files, not a var
sendwait "$SID1" 'refactor module A and reply DONE' > "$D/1" &
sendwait "$SID2" 'write tests for module B and reply DONE' > "$D/2" &
wait
jq -c '.data.wait | {signal, waitedMs}' "$D/1" "$D/2"; rm -rf "$D"
```

One in-flight wait per worker keeps you far from the 16-per-session waiter cap.

**B. Fire-and-forget, then gather with output markers.** If you must send every
prompt before waiting on anything, do **not** gather with signal waits: signals
are edge-triggered with no history, so a `stop` that fires before the gather
reaches that worker is gone and unobservable afterwards, `fresh=1` cannot help,
and neither can omitting it (measured: worker 2's turn ended at +2 s, its
sequential `until=stop,exit&fresh=1` gather burned its full bounded 300 s and
reported nothing). Gather instead on a marker each worker prints itself, which
`from=buffer` re-finds no matter when it appeared:

```bash
# SIDS[1], SIDS[2] = worker ids that already passed Flow 1's readiness.
# The typed prompt must NOT contain the finished marker verbatim (your keystrokes
# echo into the output stream and would match instantly), so ask for it in halves:
declare -A TOK
for i in 1 2; do
  TOK[$i]="${RANDOM}_$i"
  BODY=$(jq -n --arg p "do task $i; when completely done print the word WORKDONE immediately followed by _${TOK[$i]}" \
    --arg c "codeman-fan-$i" --argjson s 2 '{input:($p+"\r"),useMux:true,clientId:$c,seq:$s}')
  "${CURL[@]}" -X POST "$API/api/v1/sessions/${SIDS[$i]}/input" \
    -H 'Content-Type: application/json' --data-binary "$BODY"   # one billed turn per worker
done
for i in 1 2; do        # order no longer matters: the marker is latched in the buffer
  "${CURL[@]}" -G "$API/api/v1/sessions/${SIDS[$i]}/wait-output" \
    --data-urlencode "match=WORKDONE_${TOK[$i]}" --data-urlencode 'from=buffer' \
    --data-urlencode 'timeout=600000' | jq -c '.data.wait | {matched, snippet}'
done
```

That gather is one bounded 600 s wait per worker. If `matched` is false when it
returns, the worker is still running or forgot the marker: loop it a bounded number of
times, and if it still has not matched, report that worker as unfinished rather than
dropping it from the summary.

Use A unless you genuinely need to send everything before waiting on anything: A
needs no marker discipline, and resolves on the definitive `stop` instead of on
the worker remembering to print a token.

## Flow 5: watch for a worker stuck on a prompt

Claude workers can block on a permission dialog. `blocked` is a wait signal
(claude-mode only, and it needs Codeman's hooks in the worker's directory: see Flow 7
step 4), so watch for it and surface the question to the user instead of guessing an
answer. Expect it routinely on a server whose `claudeMode` is not the default bypass
one (the same setting that decides whether the readiness marker in Flow 1 ever
appears):

```bash
ESC=$(printf '\033')   # \x1b is GNU-sed only; BSD sed (macOS) would strip nothing
R=$("${CURL[@]}" "$API/api/v1/sessions/$SID/wait?until=stop,blocked,exit&timeout=60000")
if [ "$(jq -r '.data.wait.signal' <<<"$R")" = blocked ]; then
  "${CURL[@]}" "$API/api/v1/sessions/$SID/terminal?tail=2000" | jq -r '.data.terminalBuffer' \
    | sed -e "s/${ESC}\[[0-9;?]*[a-zA-Z]//g" | grep -v '^[[:space:]]*$' | tail -15
  # show this to the user and ask how to answer; do NOT auto-confirm another
  # session's permission prompt
fi
```

Where the worker has no hooks, `blocked` never fires and a stuck worker looks exactly
like a slow one: your marker wait burns its whole bound. The fallback is the same
terminal tail, taken when a bound runs out, and the same rule about not answering it
yourself.

## Flow 6: claude fan-out over messaging

Preferred over Flow 4 when messaging is available (probe per worker first; see
[messaging.md](messaging.md)): tasks go out as multi-line, exactly-once messages with
no `\r`/marker discipline, and results come back as latched replies that, unlike the
edge-triggered signals, cannot be missed by a late gather. Spawn, readiness and
cleanup do not change.

1. Spawn N workers with quick-start and run Flow 1's readiness ladder on each
   (messaging cannot answer a trust dialog).
2. `ListAgents` once. Map each row to a worker by its `tmux codeman-<id8>` column
   (`<id8>` = first 8 chars of the quick-start `sessionId`); note each `name [ref]`.
   A worker without a row is driven over Flow 4 instead; mixed fleets are fine.
3. `SendMessage` each worker its task (one billed turn per worker), first contact in
   the `name [ref]` form, with a per-worker reply token baked in: "... when done, reply
   to the sender of this message with one line: RESULT_<token-i>: <one-line summary>".
4. Gather = the replies themselves; they attach to your subsequent tool results in
   completion order. Pace the loop with the bounded HTTP backstop per worker still
   missing a reply: `wait until=stop,exit&timeout=60000`, then a `last-response`
   read (`stop` can lose the registration race to a fast worker; the poll covers
   that). Stop fired or `last-response` non-empty but no reply = the worker ignored
   the reply instruction: take `last-response` as its result. Nothing after a few
   bounded rounds = the message was held or dropped (messaging.md, delivery
   classes): deliver that one task over HTTP input instead (Flow 4 B), once, and
   say so in your report.
5. `delete_session` each worker; the preamble guard as always.

Never resend the same message text as a nag: identical repeats are dropped by the
loop throttle. If a second message is genuinely needed, change the text ("status?"),
and cap the total.

## Flow 7: the whole job

The ask, as a user actually states it: *"fix these 3 failing test suites, have the work
reviewed, and report back."* Flows 1-6 are mechanisms; this is one job end to end,
including the parts you do with your **own** tools rather than the API.

Shape: discover the work → one git worktree per worker → one worker per worktree →
hand out the tasks → gather → one reviewer over the results → report → clean up.

Each Bash call below opens by sourcing the §0 preamble file and checking its stamp,
as shown at the top of this file. Do not re-paste the preamble body.

### 1. Discover the work (your own tools, no API)

Run the failing suites yourself, or read the CI log the user pointed at, and produce a
concrete list: three suite paths and, for each, the one-line symptom. Do this before
spawning anything. A worker you hand a vague task to spends a billed turn rediscovering
what you already know, and three workers rediscover it three times. This step costs
your own turn only; no worker exists yet.

Say `parser`, `router` and `cache` came out of it.

### 2. One git worktree per worker (your own tools, no API)

⚠️ **The checkout is shared.** Three workers in one directory `git checkout` over each
other, edit the same files, and stage each other's half-finished work; the user's own
session is in there too. One worktree per worker is what makes parallel work safe.

⚠️ **Codeman never creates a worktree.** It only *detects* one after the fact: the
unified session list recovers `worktreeName`/`worktreeRepo` from the Claude transcript
(`session-routes.ts`, `services/unified-session-service.ts`) so the UI can label the
session. There is no create-a-worktree endpoint, so `git worktree add` is yours to run,
and `git worktree remove` is the user's to approve (step 8).

```bash
REPO=$(git -C . rev-parse --show-toplevel)
BASE=$(git -C "$REPO" rev-parse HEAD)      # record it: the reviewer diffs against this
WT="$HOME/codeman-worktrees"               # OUTSIDE the repo, so nothing shows up in its status
mkdir -p "$WT"
for s in parser router cache review; do
  git -C "$REPO" worktree add -b "fix/$s" "$WT/$s" "$BASE" || echo "worktree $s failed; drop that suite"
done
```

The fourth worktree is the reviewer's, for the same reason: a reviewer reading the
shared checkout sees whatever the user's own session is doing to it mid-review.

⚠️ **A worktree checks out TRACKED files only.** Untracked and gitignored
infrastructure does not come along, and `.claude/` is gitignored in many repos
(including Codeman's own), which is exactly where the hooks live. That single fact
drives step 4.

### 3. Spawn one worker per worktree (API)

`quick-start` puts a worker in a *case*, not in your worktree. Pointing a session at an
arbitrary path is `POST /api/v1/sessions` with `workingDir`, and it takes **two** calls:
create builds the session but spawns no PTY (`pid` stays null, there is no pane), and
`/interactive` starts the CLI.

```bash
declare -A WORKER
for s in parser router cache; do
  C=$("${CURL[@]}" -X POST "$API/api/v1/sessions" -H 'Content-Type: application/json' \
      --data-binary "$(jq -n --arg d "$WT/$s" --arg n "fix-$s" '{workingDir:$d,mode:"claude",name:$n}')")
  # NOTE the shape: .data.session.id here, NOT quick-start's .data.sessionId.
  SID=$(jq -r 'if .success then .data.session.id else empty end' <<<"$C")
  [ -n "$SID" ] || { jq -c '{error, errorCode}' <<<"$C"; echo "$s: create failed"; continue; }
  CREATED+=("$SID")          # add it BEFORE starting: a session that failed to start still exists
  "${CURL[@]}" -X POST "$API/api/v1/sessions/$SID/interactive" \
    -H 'Content-Type: application/json' -d '{}' | jq -e '.success' >/dev/null \
    || { echo "$s: PTY did not start"; continue; }
  WORKER[$s]=$SID
done
```

- ⚠️ The capacity failure here is **`OPERATION_FAILED` (422)**, not quick-start's
  `SESSION_BUSY` (`session-routes.ts` checks `sessionCapacityMessage` before parsing
  the body). Branching only on `SESSION_BUSY` misreads a full server as a bad request.
- ⚠️ Send `/interactive` an empty body. `{"clearBreaker":true}` resets the PTY-exit
  circuit breaker, which exists to stop a worker that crashes on every start from being
  restarted in a loop; clearing it unasked re-arms that loop.
- Then run **Flow 1's readiness stages 1-3** on each SID. A path claude has never been
  run in shows the trust dialog, and typing your task into it does not just lose the
  task: the select widget swallows the text and the trailing `\r` answers the
  highlighted option, which since claude-cli 2.1.252 is `No, exit`. Stages 1-3 cost no
  turn; stage 4, if it fires, costs that worker one billed turn.

### 4. Hand out the tasks: markers, not send-and-wait

⚠️ **These workers have no `stop` and no `blocked`, so send-and-wait cannot tell you a
turn ended.** Codeman writes its hooks block into `<dir>/.claude/settings.local.json`
only when it **creates** the directory (quick-start on a case name that does not exist
yet, `POST /api/cases`, clone, docker quickcreate). `POST /api/sessions` runs only
`refreshStaleCodemanHooks()`, which no-ops when there is no Codeman hooks block to
refresh, and linking a folder as a case writes just the name→path registry entry. A
fresh worktree therefore starts hook-less, and stays that way.

What breaks if you use send-and-wait anyway: `wait:true` is accepted (the 400 is about
*mode*, not about hooks, and these are claude-mode sessions), so the call falls back to
the default set's `idle`, which is a heuristic that flaps mid-turn. You get a "finished"
answer for a turn still running, and `last-response` then hands you the *previous*
turn's text. The contrast is the lesson: a worker whose workspace carries the hooks
block (Flow 1, and by default any other workspace too) has a `stop` that is definitive
and free. Where the block is absent you pay one marker per worker instead.

```bash
declare -A TOK
i=0
for s in "${!WORKER[@]}"; do
  i=$((i+1)); TOK[$s]="${RANDOM}_$i"
  P="You are in the git worktree $WT/$s on branch fix/$s. Fix the failing suite test/$s.test.ts: make it pass without weakening the assertions, and change no file outside what that fix needs. Commit on this branch when it passes; do not push and do not merge. Then print the word WORKDONE immediately followed by _${TOK[$s]}"
  BODY=$(jq -n --arg p "$P" --arg c "codeman-job-$s" '{input:($p+"\r"),useMux:true,clientId:$c,seq:1}')
  "${CURL[@]}" -X POST "$API/api/v1/sessions/${WORKER[$s]}/input" \
    -H 'Content-Type: application/json' --data-binary "$BODY" >/dev/null   # one billed turn per worker
done
```

The marker is asked for in halves (`WORKDONE` + `_<token>`) because your typed prompt
echoes into the output stream: a whole marker in the prompt matches the instant it is
typed, and every worker reports done before it has started. The commit is what makes
step 6 reviewable and what keeps a later `worktree remove` from throwing work away.

### 5. Gather

One bounded wait per worker, sequential; the marker is latched in the buffer, so gather
order does not matter.

```bash
declare -A RESULT
for s in "${!WORKER[@]}"; do
  DONE=0
  for TRY in $(seq 1 30); do   # BOUNDED, 30 x 60 s: a \r-less send would loop forever otherwise
    R=$("${CURL[@]}" -G "$API/api/v1/sessions/${WORKER[$s]}/wait-output" \
        --data-urlencode "match=WORKDONE_${TOK[$s]}" --data-urlencode 'from=buffer' \
        --data-urlencode 'timeout=60000')
    jq -e '.data.wait.matched' <<<"$R" >/dev/null && { DONE=1; break; }
    jq -e '.data.wait.ended'   <<<"$R" >/dev/null && break     # session gone (no delivered field on a GET wait)
  done
  if [ "$DONE" = 1 ]; then
    for _ in $(seq 1 10); do   # last-response LAGS the marker; poll, bounded
      T=$("${CURL[@]}" "$API/api/v1/sessions/${WORKER[$s]}/last-response" | jq -r '.data.text')
      [ -n "$T" ] && break; sleep 1
    done
    RESULT[$s]=$T
  else
    # Bound exhausted. It is NOT a failure and NOT a success: it is unfinished, and it
    # goes into the report as such. A stuck permission dialog looks exactly like this
    # (no hooks means no `blocked` signal), so peek before deciding.
    RESULT[$s]="unfinished after 30 min"
    "${CURL[@]}" "$API/api/v1/sessions/${WORKER[$s]}/terminal?tail=2000" \
      | jq -r '.data.terminalBuffer' | tail -15    # Flow 5's fallback; show it to the user, answer nothing
  fi
done
```

`last-response` reads the transcript under `~/.claude/projects`, not the hooks, so it
works fine on these hook-less workers. It is the synchronization you lost, not the read
path.

### 6. One reviewer over the results (the review pair)

One reviewer, after the gather, never before: a reviewer started early reviews an empty
diff and reports success. It gets its own worktree (step 2) and reads the others by
absolute path, so it never touches the shared checkout.

```bash
C=$("${CURL[@]}" -X POST "$API/api/v1/sessions" -H 'Content-Type: application/json' \
    --data-binary "$(jq -n --arg d "$WT/review" '{workingDir:$d,mode:"claude",name:"review"}')")
RID=$(jq -r 'if .success then .data.session.id else empty end' <<<"$C")
[ -n "$RID" ] && CREATED+=("$RID") && "${CURL[@]}" -X POST "$API/api/v1/sessions/$RID/interactive" \
  -H 'Content-Type: application/json' -d '{}' >/dev/null
# ... Flow 1 readiness stages 1-3 on $RID ...

RTOK="${RANDOM}_rev"
P="Review three independent fixes. For each of $WT/parser (branch fix/parser), $WT/router (fix/router) and $WT/cache (fix/cache): run 'git -C <path> diff $BASE' to see the change, then run that worktree's suite. Report one block per worktree: PASS, or the concrete problem and the file:line it is in. Weakened assertions and unrelated edits count as problems. Change nothing. Then print the word REVIEWDONE immediately followed by _$RTOK"
BODY=$(jq -n --arg p "$P" --arg c "codeman-job-review" '{input:($p+"\r"),useMux:true,clientId:$c,seq:1}')
"${CURL[@]}" -X POST "$API/api/v1/sessions/$RID/input" \
  -H 'Content-Type: application/json' --data-binary "$BODY" >/dev/null   # one billed turn
for TRY in $(seq 1 30); do   # BOUNDED, same reasoning as the gather
  R=$("${CURL[@]}" -G "$API/api/v1/sessions/$RID/wait-output" \
      --data-urlencode "match=REVIEWDONE_$RTOK" --data-urlencode 'from=buffer' --data-urlencode 'timeout=60000')
  jq -e '.data.wait.matched' <<<"$R" >/dev/null && break
done
for _ in $(seq 1 10); do
  REVIEW=$("${CURL[@]}" "$API/api/v1/sessions/$RID/last-response" | jq -r '.data.text'); [ -n "$REVIEW" ] && break; sleep 1
done
```

If the reviewer objects to a worktree, send that objection back to **that worker only**
(one more billed turn for it, plus one for a re-review), with a fresh token and a fresh
`seq`. **Cap this at one rework round.** If the reviewer still objects after it, stop
and put the remaining objection in the report verbatim: an uncapped review loop spends
the user's tokens on an argument between two workers, and you would be reporting a
consensus you manufactured. Say in the report that you capped it.

### 7. Report to the user

One block, in the user's terms, not the API's:

- per suite: fixed / unfinished / still objected to, the branch name and the worktree
  path, and the reviewer's verdict for it;
- everything you dropped, by name: a suite whose gather bound ran out, a worktree that
  failed to create, the capped rework round;
- what you did **not** do: nothing was merged, pushed, rebased or deleted. The user
  asked for fixes and a review, so the branches are left where they can inspect them.

### 8. Clean up: sessions yes, worktrees ask

```bash
for id in "${CREATED[@]}"; do
  delete_session "$id"
done
```

The sessions are yours; delete every one, including the reviewer and any that failed to
start. **The worktrees are not.** They hold the user's unmerged commits, and
`git worktree remove` deletes that directory from disk, exactly like
`DELETE /api/v1/cases/:name`. Print the commands and let the user decide:

```bash
# for the USER to run or approve, once they have taken what they want:
git -C "$REPO" worktree remove "$WT/parser"    # --force would discard uncommitted work; never add it yourself
git -C "$REPO" branch -d fix/parser            # -d refuses while the branch is unmerged, which is the point
```

## Cleanup discipline

At the end of the conversation (or on abort), delete exactly what you created:

```bash
for id in "${CREATED[@]}"; do
  delete_session "$id"
done
```

- Only ids from your own `CREATED` list. Never enumerate `/api/v1/sessions` and
  delete by pattern; other sessions belong to the user.
- Always go through `delete_session`. It refuses an empty id, refuses when `$SELF` is
  unset or too short to prove the target is not you, and prefix-checks in both
  directions. A hand-written `curl -X DELETE`, or the old
  `is_self "$id" || curl -X DELETE …`, has none of that: an undefined `is_self` exits
  127 and the `||` branch deletes unguarded.
- If you created a *case* purely as scratch and the user confirmed it is disposable,
  `DELETE /api/v1/cases/:name` removes it, but that recursively deletes the
  directory from disk, so never do it without the user's explicit go-ahead for that
  exact name. Git worktrees you created (Flow 7) are the same class of object: list
  the paths, hand over the `git worktree remove` command, and let the user run it.
