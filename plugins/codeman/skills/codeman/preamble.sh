# ---- Codeman agent preamble 1.33.4 (seeded by Codeman at session spawn; the SKILL.md §0 bootstrap rewrites it when missing or stale) ----
API="${CODEMAN_API_URL:?CODEMAN_API_URL not set; refusing to guess}"
SELF="${CODEMAN_SESSION_ID:?CODEMAN_SESSION_ID not set}"
# Credentials, cheapest first. Your session has usually INHERITED the server's
# CODEMAN_PASSWORD already (§6 explains why, and what to do when it has not);
# the data dir's .env is the documented fallback, the same one `codeman attach`
# reads. The data dir is wherever the hook-secret file lives. Values may be
# quoted or `export`-prefixed.
ENV_FILE="${CODEMAN_HOOK_SECRET_FILE:+${CODEMAN_HOOK_SECRET_FILE%hook-secret}.env}"
envval() { sed -n "s/^\(export \)\{0,1\}$1=//p" "$ENV_FILE" | tail -1 | sed 's/^"\(.*\)"$/\1/; s/^'\''\(.*\)'\''$/\1/'; }
if [ -z "${CODEMAN_PASSWORD:-}" ] && [ -n "$ENV_FILE" ] && [ -f "$ENV_FILE" ]; then
  CODEMAN_USERNAME=$(envval CODEMAN_USERNAME)
  CODEMAN_PASSWORD=$(envval CODEMAN_PASSWORD)
fi
AUTH=(); [ -n "${CODEMAN_PASSWORD:-}" ] && AUTH=(-u "${CODEMAN_USERNAME:-admin}:$CODEMAN_PASSWORD")
# -k: harmless on http, required on https (self-signed cert).
# X-Codeman-Parent-Session: tags workers YOU spawn as your children, so the web UI can
# draw the lineage. Set once here and every present and future create call carries it;
# it is ignored on every other endpoint. Purely cosmetic (see §5.1) and it can never
# fail a spawn, so there is no case where you would want to leave it off.
# X-Codeman-Agent-Origin: marks a case directory a spawn CREATES as agent scratch, so the
# user can find and delete it long after your workers are gone (§5.14). Same deal: set
# once, cosmetic, never fails a spawn, and it labels only directories Codeman creates.
CURL=(curl -sk "${AUTH[@]}" -H "X-Codeman-Parent-Session: $SELF" -H "X-Codeman-Agent-Origin: codeman-skill")
CID=codeman-agent-1            # FIXED literal, never "agent-$$": see below

# Fail-CLOSED session delete. The DELETE lives INSIDE the guard on purpose: the older
# `is_self "$SID" || curl -X DELETE ...` shape failed OPEN, because an undefined
# is_self exits 127 and the `||` branch then ran the delete completely unguarded.
# Undefined delete_session is "command not found", which deletes nothing.
delete_session() {
  local id="${1:-}"
  [ -n "$id" ] || { echo "refusing: empty session id"; return 1; }
  [ "${#SELF}" -ge 8 ] || { echo "refusing: \$SELF unset or too short to prove this is not me"; return 1; }
  # ids appear in full AND 8-char form (Docker exports a truncated $SELF; mux names and
  # UI surfaces carry 8-char ids), so compare by prefix in BOTH directions. Equality or
  # a one-directional check each miss a real combination, and the miss deletes you.
  case "$id" in "$SELF"*) echo "refusing: $id is me"; return 1 ;; esac
  case "$SELF" in "$id"*) echo "refusing: $id is me"; return 1 ;; esac
  "${CURL[@]}" -X DELETE "$API/api/v1/sessions/$id"
}

# ---- fast path: the four verbs, already written. §1 composes them. ----
_composer_up() {   # <sid> <timeoutMs> -> "true"/"false". `shift+tab` is the one token
  "${CURL[@]}" -G "$API/api/v1/sessions/$1/wait-output" \
    --data-urlencode 'match=shift+tab' --data-urlencode 'from=buffer' \
    --data-urlencode "timeout=$2" | jq -r '.data.wait.matched // false'
}
_dsh_up() {        # <sid> <timeoutMs> -> "true"/"false". The DeepSeek Harness TUI's
  # composer glyph. Override with DSH_READY_MARK for a profile that draws another one.
  "${CURL[@]}" -G "$API/api/v1/sessions/$1/wait-output" \
    --data-urlencode "match=${DSH_READY_MARK:-❯}" --data-urlencode 'from=buffer' \
    --data-urlencode "timeout=$2" | jq -r '.data.wait.matched // false'
}
# ---- the workspace-trust dialog: READ the screen, never press Enter blind ----
# Claude Code 2.1.252 dropped the option numbers, REVERSED them, and highlights
# "No, exit" by default:
#     Security guide
#   ❯ No, exit
#     Yes, I trust this folder
#   Enter to confirm . Esc to cancel
# so the bare \r that answered the old layout now answers *exit* and the pane is
# dead (`status 1`) seconds after the spawn -- measured on a live 2.1.252 case.
# These two read the rendered pane and steer onto the trust option instead.
_trust_key() {     # <sid> -> "confirm" | "move" | "" (nothing safe to press)
  # full=1 returns the RENDERED pane; a claude pane keeps no tmux history, so that
  # is the current frame rather than every repaint since launch. tail -1 anyway,
  # because the freshest marked row is the only one still true.
  "${CURL[@]}" -G "$API/api/v1/sessions/$1/terminal" --data-urlencode 'full=1' \
    | jq -r '.data.terminalBuffer // empty' \
    | sed -e "s/$(printf '\033')\[[0-9;?]*[a-zA-Z]//g" -e "s/$(printf '\033')[()][AB0]//g" \
    | tr -d ' \t' | grep -i '❯[0-9.]*\(yes,itrustthisfolder\|no,exit\)' | tail -1 \
    | sed -e 's/.*[Yy]es,.*/confirm/' -e 's/.*[Nn]o,.*/move/'
}
# ---- the composer: is the prompt still sitting there, unsent? ----
# ⚠️ Claude Code 2.1.277 (auto-installed 2026-09-18) takes typed text the moment the
# composer paints but IGNORES Enter for the first 30-50 seconds after it: the \r that
# Codeman sends 50 ms after the text and a lone nudge at 20 s both leave the prompt
# stranded, with `0 tokens`, while the wait burns its whole timeout. Measured through
# this very route: Enter at 28 s stranded, Enter at 51 s submitted. So sendwait READS
# the composer and keeps pressing Enter while the prompt is still there.
_composer_text() { # <sid> -> the composer's text with ALL whitespace removed: "" once
  # the prompt was taken, "?" when the pane shows no composer at all. The composer is
  # the LAST `❯` line: Claude Code echoes a submitted prompt with the same glyph higher
  # up in the transcript, so only the last one says whether the text was taken.
  local t
  t=$("${CURL[@]}" -G "$API/api/v1/sessions/$1/terminal" --data-urlencode 'full=1' \
    | jq -r '.data.terminalBuffer // empty' \
    | sed -e "s/$(printf '\033')\[[0-9;?]*[a-zA-Z]//g" -e "s/$(printf '\033')[()][AB0]//g" \
    | tr -d '\r' | grep -a '^[[:space:]]*❯' | tail -1)
  [ -n "$t" ] || { printf '?'; return 0; }
  # Claude Code draws a NO-BREAK SPACE (U+00A0) after the glyph, which [:space:] does
  # not cover, so it is stripped by its bytes, portably (BSD sed has no \xHH).
  printf '%s' "$t" | sed 's/^[[:space:]]*❯//' | tr -d '[:space:]' | sed "s/$(printf '\302\240')//g"
}
_accept_trust() {  # <sid> -> 0 once it has answered the dialog, 1 if it could not
  local sid="$1" k i=1
  while [ "$i" -le 6 ]; do
    k=$(_trust_key "$sid")
    [ -n "$k" ] || return 1   # no dialog on screen, or a layout this cannot read
    # A SEPARATE clientId for these keys. seq is monotonic per clientId, so
    # spending prompt numbers here would make the next sendwait -- whose default
    # seq is the epoch second -- look like a stale duplicate and vanish silently.
    "${CURL[@]}" -X POST "$API/api/v1/sessions/$sid/input" -H 'Content-Type: application/json' \
      -d "$(jq -nc --arg k "$([ "$k" = confirm ] && printf '\r' || printf '\033[B')" \
              --arg c "$CID-trust-$sid" --argjson s "$i" \
              '{input:$k,useMux:true,clientId:$c,seq:$s}')" >/dev/null
    [ "$k" = confirm ] && return 0
    sleep 1; i=$((i+1))   # re-read: the arrow is CONFIRMED before Enter goes out
  done
  return 1
}
# spawn_worker <caseName> [mode] -> session id on stdout, diagnostics on stderr.
# quick-start AND readiness in one call, with a strict contract: NON-EMPTY stdout means
# a READY worker whose end-of-turn signal can be trusted -- a claude worker in a
# hook-carrying case, or a `deepseek` worker whose harness TUI drew its composer.
# Anything less is rc 1 with EMPTY stdout, and the half-spawned session is deleted here
# rather than handed back, because a worker that never drew its composer would eat the
# task prompt with its trust dialog. There is deliberately no pid poll: wait-output
# already blocks until the composer draws, and pid!=null proved startup, never readiness.
# CODEMAN_WORKER_ADVISOR=opus (or fable / sonnet) gives every CLAUDE worker spawned while
# it is set Claude Code's advisor tool: a stronger model the worker consults before
# committing to an approach, on a recurring error and before declaring the task done.
# Other modes ignore it. A value the server refuses fails the spawn (INVALID_INPUT); an
# advisor that ranks below the worker's model is accepted but never attached by claude.
spawn_worker() {
  local name="${1:?spawn_worker needs a case name}" mode="${2:-claude}" q sid cp r
  # parentSessionId doubles the CURL header, so a spawn_worker copied off the shared
  # curl (or a body someone rebuilt from this recipe) still carries its lineage.
  # deepseek: ask for the same permission posture the Run button sends, because the
  # harness's own default (`workspace-write`) still ASKS, and a worker that stops on
  # an approval row is a worker no fan-out can finish. It is not an escalation --
  # claude workers already spawn with permissions skipped, and in multi-user mode the
  # server clamps this back to `workspace-write` for an owner without the grant.
  # Spawn by hand (§5.1) when you want a worker that asks.
  q=$("${CURL[@]}" -X POST "$API/api/v1/quick-start" -H 'Content-Type: application/json' \
      -d "$(jq -nc --arg n "$name" --arg m "$mode" --arg p "$SELF" --arg a "${CODEMAN_WORKER_ADVISOR:-}" \
        '{caseName:$n,mode:$m,parentSessionId:$p}
         + (if $m == "deepseek" then {deepSeekConfig:{permissionMode:"danger-full-access"}} else {} end)
         + (if $m == "claude" and $a != "" then {advisorModel:$a} else {} end)')")
  sid=$(jq -r 'if .success then .data.sessionId else empty end' <<<"$q")
  # NOT retryable in a loop: every quick-start failure code is terminal (§5.1).
  [ -n "$sid" ] || { jq -c '{error,errorCode}' <<<"$q" >&2; return 1; }
  # A server without advisor support DROPS the field instead of refusing it, so read it
  # back: a worker silently missing the advisor it was asked for is worth one line.
  if [ "$mode" = claude ] && [ -n "${CODEMAN_WORKER_ADVISOR:-}" ] &&
     [ "$("${CURL[@]}" "$API/api/v1/sessions/$sid" | jq -r '.data.advisorModel // empty')" != "$CODEMAN_WORKER_ADVISOR" ]; then
    echo "worker $sid: this Codeman server ignored CODEMAN_WORKER_ADVISOR (no advisor support); it runs without one" >&2
  fi
  if [ "$mode" = deepseek ]; then
    # The one non-claude mode with REAL end-of-turn signals: its TUI reports
    # idle/working/blocked to Codeman, so sendwait, until=stop and the Approvals
    # Inbox all work here exactly as they do for claude. No hook file to vet
    # (the bridge is env-injected, not a workspace file) and no trust dialog.
    # ⚠️ Readiness is still not optional, and NOT interchangeable with the stop
    # signal: the harness's boot report lands ~300ms BEFORE the composer paints
    # (measured 2.26s vs 2.56s after spawn), so a sendwait fired straight after
    # quick-start returns on that BOOT signal, reports a turn that never ran, and
    # strands the prompt in a pane that was not yet taking input.
    r=$(_dsh_up "$sid" 45000)
    [ "$r" = true ] || { echo "dsh worker $sid never drew a composer: no pane-capable profile, a profile whose composer is not '${DSH_READY_MARK:-❯}' (set DSH_READY_MARK), or a harness that failed to boot -- check GET /api/v1/deepseek/status. Deleted it" >&2
      delete_session "$sid" >/dev/null; return 1; }
    printf '%s\n' "$sid"; return 0
  fi
  [ "$mode" = claude ] || { printf '%s\n' "$sid"; return 0; }   # no other mode draws a composer to wait on
  # The server installs hooks into every claude workspace now, so this grep normally
  # passes; it stays because the install is gated on a setting the operator can turn
  # off, remote sessions never get hooks, and a session created by an older server
  # still has none. No marker means sendwait would false-resolve on flapping idle,
  # possibly inside the user's REAL repo: refuse rather than run the job there.
  cp=$(jq -r '.data.casePath // empty' <<<"$q")
  grep -qs '/api/hook-event' "$cp/.claude/settings.local.json" || {
    echo "case '$name' resolved to '$cp', which has no Codeman hooks (workspaceHooksEnabled off, remote, or an older server?): turn the setting on, or work §5.1+§5.5 by hand with markers" >&2
    delete_session "$sid" >/dev/null; return 1; }
  # Short composer wait FIRST, then the trust dialog: a case still showing the
  # dialog can never pass the composer wait, so acting early keeps a cold case from
  # paying the whole long wait before the fallback even runs (§5.2). A warm case
  # matches in under a second and never reaches it, and _accept_trust returns in a
  # blink when there is no dialog, so this costs nothing in the ordinary slow case.
  r=$(_composer_up "$sid" 5000)
  if [ "$r" != true ]; then
    # Codeman answers this dialog itself and normally wins the race; this is the
    # bounded fallback for when its 90 s window / 6-keystroke cap has run out.
    _accept_trust "$sid"
    r=$(_composer_up "$sid" 45000)
  fi
  [ "$r" = true ] || { echo "worker $sid never drew a composer; deleted it. Retry by hand via the §5.2 ladder (its billed stage-4 probe included)" >&2
    delete_session "$sid" >/dev/null; return 1; }
  printf '%s\n' "$sid"
}
# spawn_workers <caseName[:mode]>... -> one "<caseName> <sessionId>" line per worker, in
# order; the sessionId column is EMPTY for a spawn that failed (stderr has why).
# CONCURRENT: N workers cost about what one costs. Spawning them one Bash call at a time
# is the single biggest avoidable delay in this skill. A bare name is a claude worker;
# `beta:deepseek` makes that one a DeepSeek Harness worker, and a mixed fleet is one
# call. Case names must be UNIQUE: two workers in one case directory co-edit the same
# tree (§4), so a repeat is an error here, not a race (the mode never disambiguates two
# workers, since they would still share the directory).
spawn_workers() {
  local d spec n m i=0
  [ "$#" -gt 0 ] || { echo "spawn_workers: no case names given" >&2; return 1; }
  [ -z "$(printf '%s\n' "$@" | sed 's/:.*//' | sort | uniq -d)" ] || { echo "spawn_workers: duplicate case names" >&2; return 1; }
  d=$(mktemp -d "${TMPDIR:-/tmp}/codeman-spawn.XXXXXX") || return 1
  for spec in "$@"; do
    n=${spec%%:*}; m=${spec#*:}; [ "$m" = "$spec" ] && m=claude
    ( spawn_worker "$n" "$m" > "$d/$i" ) & i=$((i+1))
  done
  wait
  i=0; for spec in "$@"; do printf '%s %s\n' "${spec%%:*}" "$(cat "$d/$i" 2>/dev/null)"; i=$((i+1)); done
  rm -rf "$d"
}
# sendwait <sid> <prompt> [seq] -> blocks until that worker's turn ENDS (~10 min ceiling
# across its two waits). One billed turn. The \r and the per-worker clientId are applied
# here, which is why you never hand-build this body. seq defaults to the CURRENT EPOCH
# SECOND so that every new prompt is a new frame: the server drops any (clientId,seq)
# pair it has already applied, so a fixed default would make every later prompt to that
# worker a silent no-op that still "succeeds" and reports the previous turn's state.
# Pass seq explicitly for exactly one reason: resending a possibly-delivered frame as a
# deliberate duplicate, at the SAME number (§5.3).
# Delivery is SELF-HEALING: the Enter can be lost (an Ink repaint eats it, and Claude
# Code 2.1.277+ ignores it outright for the first 30-50 s after the composer paints),
# leaving the typed prompt stranded on the composer while a long wait runs its whole
# timeout (observed live, twelve reviews in a row). So the first wait is short; on its
# timeout the ORIGINAL frame is resent unchanged as a long re-wait (a tagged duplicate:
# the server re-waits without retyping, §5.3) and kept open in the background, while
# the composer is READ (_composer_text) and, as long as the prompt is still sitting
# there, a bare \r goes out about every ten seconds, up to twelve times. An empty
# composer ends the loop, so a prompt that was taken is never nudged again, and the
# wait that was open the whole time is what reports the turn's end. Trustworthy for a worker
# spawn_worker handed back -- claude (hooks vetted) or deepseek (status bridge) --
# and for those only. Hook-less workspaces and the other modes resolve on flapping
# idle: markers instead (§5.5). ⚠️ A dsh worker running a profile that does not
# implement the status contract is the one case that LOOKS like claude but is not:
# it accepts the send and then burns both waits. One timeout on a dsh worker whose
# pane clearly finished means that profile, so switch that worker to markers.
sendwait() {
  local sid="${1:?}" p="${2:?}" seq="${3:-$(date +%s)}" body r c head n=0 tmp bg i
  # `wait:"stop,exit"`, never the `wait:true` default set: that set also carries
  # `idle`, which is INFERRED from output stabilization and flaps mid-turn. On a
  # dsh worker whose TUI repaints rarely the session reads `idle` while the model
  # is still answering, and the re-wait below then resolved in 0 ms with
  # `signal:"idle"` on a turn that had another three minutes to run (measured).
  # A wait named after the end of a turn should only end with the turn, or with
  # the worker. ⚠️ This is also what makes a wrong mode LOUD: the modes that
  # cannot deliver `stop` answer 400 (before writing anything) instead of
  # resolving on a flap, which is the answer that sends you to markers (§5.5).
  body=$(jq -nc --arg p "$p" --arg c "$CID-$sid" --argjson s "$seq" \
    '{input:($p+"\r"),useMux:true,clientId:$c,seq:$s,wait:"stop,exit",waitTimeout:20000}')
  r=$("${CURL[@]}" -X POST "$API/api/v1/sessions/$sid/input" \
        -H 'Content-Type: application/json' --data-binary "$body")
  if jq -e '.data.delivered and .data.wait.timedOut' <<<"$r" >/dev/null 2>&1; then
    # ⚠️ The long re-wait is registered FIRST and stays open for the rest of this call,
    # in the background, while the Enter loop below works the composer. Signals have
    # no history: a `stop` that fires while no wait is open (during a composer read
    # between two short waits, measured) is lost, and the next wait then runs its
    # whole timeout on a turn that already ended. The resend is a tagged DUPLICATE,
    # so the server skips the write and re-waits without retyping (§5.3).
    tmp=$(mktemp "${TMPDIR:-/tmp}/codeman-wait.XXXXXX") || return 1
    "${CURL[@]}" -X POST "$API/api/v1/sessions/$sid/input" \
        -H 'Content-Type: application/json' --data-binary "$(jq -c '.waitTimeout=580000' <<<"$body")" > "$tmp" &
    bg=$!
    # The prompt's head with whitespace removed, matched literally (the "$head"
    # quoting inside ${c#...} keeps a * or ? in the prompt from acting as a glob).
    head=$(printf '%s' "$p" | tr -d '[:space:]' | sed "s/$(printf '\302\240')//g" | head -c 24)
    while [ "$n" -lt 12 ] && [ ! -s "$tmp" ]; do   # a non-empty file means the wait ended
      c=$(_composer_text "$sid")
      if [ "$c" = '?' ]; then
        [ "$n" -eq 0 ] || break         # unreadable pane: one Enter, then trust it
      elif [ -z "$head" ] || [ "${c#"$head"}" = "$c" ]; then
        break                           # composer empty (taken) or holding other text
      fi
      n=$((n+1))
      "${CURL[@]}" -X POST "$API/api/v1/sessions/$sid/input" -H 'Content-Type: application/json' \
        -d "$(jq -nc --arg c "$CID-$sid" --argjson s "$(date +%s)" \
          '{input:"\r",useMux:true,clientId:$c,seq:$s}')" >/dev/null
      i=0; while [ "$i" -lt 10 ] && [ ! -s "$tmp" ]; do sleep 1; i=$((i+1)); done
    done
    wait "$bg"
    # The duplicate reports `delivered:false` -- truthfully, but about the wrong send.
    # The first one delivered, so carry that forward, or §1's cleanup reads a completed
    # turn as an undelivered one and keeps a finished worker forever.
    r=$(jq -c 'if .success and (.data.wait.ended | not) then .data.delivered = true else . end' < "$tmp")
    rm -f "$tmp"
  fi
  printf '%s\n' "$r"
}
# last_text <sid> [prev] -> that worker's last assistant message (claude, codex and
# deepseek write a real transcript; the other modes have none, so read the terminal
# instead -- §5.4). Polled, because the transcript write LAGS the stop signal, and
# "some text exists" is not "THIS turn's text exists": right after a SECOND turn on the same worker the endpoint still serves
# the previous answer for a beat (observed live). When reading consecutive turns, pass
# the previous answer as [prev]: the poll then holds out for text that differs from it,
# falling back to whatever it last saw if the budget runs dry, so an honestly repeated
# answer still comes back. Non-zero exit means the worker really never wrote one.
last_text() {
  local t="" prev="${2:-}"
  for _ in $(seq 1 15); do
    t=$("${CURL[@]}" "$API/api/v1/sessions/$1/last-response" | jq -r '.data.text // empty')
    [ -n "$t" ] && [ "$t" != "$prev" ] && { printf '%s\n' "$t"; return 0; }
    sleep 1
  done
  [ -n "$t" ] && { printf '%s\n' "$t"; return 0; }
  return 1
}

# The stamp is the LAST line on purpose (a truncated write leaves it unset) and is kept
# bare on purpose: the write condition above anchors on it with $, so an inline comment
# here would fail that match and rewrite this file on every single bootstrap.
CODEMAN_PREAMBLE=1.33.4
