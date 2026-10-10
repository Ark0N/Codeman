---
name: codeman
description: >-
  Drive Codeman, the session manager this agent is running inside, over its HTTP API:
  list sessions, start worker sessions, send them prompts, block until they finish
  (wait / wait-output / send-and-wait), read their output, and clean up; where
  available, message claude workers directly (Claude Code cross-session messaging).
  Use when asked to orchestrate or parallelize work across Codeman sessions, watch
  another session, or start and manage workers. Only usable inside a Codeman-managed
  session (CODEMAN_MUX=1); refuse to act otherwise.
---

# Driving Codeman from inside a session

You are an agent running inside a Codeman-managed terminal session. Codeman is the
server that spawned you; its HTTP API can start, prompt, watch, and delete other
sessions.

**Read as far as your job needs and no further.** §0 is the bootstrap, run once. §1 is
the whole fast path: spawn N workers, task them, collect answers. **If §1 covers your
job, run it and stop there.** The sections after it are for jobs it does not cover, and
reading them to be thorough is the main reason a ten-second run takes minutes. §2 is the
verb table when your job is a different one. §3 and §4 are the rules; §6 is setup and
credentials, which you only need when something 401s.

Everything else loads on demand, and is meant to be opened at one section, not read
through: the verbs in detail (the old §5) in [reference/verbs.md](reference/verbs.md),
worked multi-worker flows in [reference/recipes.md](reference/recipes.md), endpoint
tables and a symptom gallery in [reference/endpoints.md](reference/endpoints.md), and
direct messaging to claude workers in [reference/messaging.md](reference/messaging.md).

Workers in **every other mode** never receive this preamble, but they have the same
environment: tell them *"other sessions: `codeman agent --help`"* — the bundled CLI
(`ls`, `spawn`, `send`, `wait`, `read`, `interrupt`, `rm`) is the same verbs over the
same endpoints, with the guards below (no control bytes, no self-delete, no guessed
URL) enforced in code.

## 0. Guard and bootstrap

If `CODEMAN_MUX` is not `1`, **stop and say so**. Do not guess an API URL; a server
you are not part of is not yours to drive.

⚠️ **Your shell state does not survive between tool calls.** Each Bash call starts a
fresh shell, so `$API`, `$SELF`, the `CURL` array and `delete_session` are all gone by
the next call, and `$$` is a different pid. **The filesystem does survive**, so write
the preamble to a file once and source it afterwards, rather than re-pasting a
hundred-odd lines at the top of every call (a half-re-pasted preamble used to be the
single most likely way to break a run).

**Codeman seeds the preamble file for you** when it spawns a claude session (server
1.18.3+), so the bootstrap is usually nothing at all: these are the two lines every
later call opens with, and your first REAL call performs them anyway:

```bash
. "${XDG_CACHE_HOME:-$HOME/.cache}/codeman-agent-$CODEMAN_SESSION_ID.sh" 2>/dev/null
[ "${CODEMAN_PREAMBLE:-}" = 1.33.4 ] || { echo "preamble missing or stale; run the full §0 block"; exit 1; }
```

⚠️ **Never spend a Bash call on this check alone.** §1's block opens with this same
loader, so when §1 is the job, start there: the check rides the spawn call for free,
and a standalone "preamble OK" call buys nothing while costing a full model turn
(measured live: a lone check plus the deliberation around it added ~6 s to a 28 s
two-worker run). §0 is done the moment any job call passes its opening check. Only
when a call reports missing or stale, run the full block below once — and run it
**verbatim**: paste it as-is, never re-type it, trim it, or "extract the parts you
need". A hand-assembled
preamble is the documented failure mode of this skill: one live run rebuilt it
"minimally" and lost the `X-Codeman-Parent-Session` header (every worker spawned with
no lineage arc in the web UI) and the fast-path functions (the spawn fell back to a
serial quick-start loop plus pid polls), turning a ten-second job into a fifty-second
one. If your harness directs temporary files into a scratchpad directory, that
directive covers task scratch, not this file: it is a per-session cache that every
later call re-sources by this exact path, so keep the path below. If you must relocate
it anyway, copy the block's content byte-for-byte unchanged and source your path in
every later call instead.

```bash
test "${CODEMAN_MUX:-}" = 1 || { echo "Not inside a Codeman-managed session; refusing to act."; exit 1; }
: "${CODEMAN_SESSION_ID:?CODEMAN_SESSION_ID not set}" "${HOME:?HOME not set}"
PRE="${XDG_CACHE_HOME:-$HOME/.cache}/codeman-agent-$CODEMAN_SESSION_ID.sh"
mkdir -p "$(dirname "$PRE")"
# Rewrite unless the file already ends with THIS version's stamp, so a stale or a
# half-written file self-heals here instead of costing you a round trip to rm it.
grep -qs '^CODEMAN_PREAMBLE=1.33.4$' "$PRE" || (umask 077; cat > "$PRE" <<'PREAMBLE'
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
PREAMBLE
)
. "$PRE"; [ "${CODEMAN_PREAMBLE:-}" = 1.33.4 ] || { echo "preamble at $PRE is stale or truncated: rm it and re-run this block"; exit 1; }
```

Every later Bash call that touches the API starts with the same two loader lines from
the top of this section.

Why it is built this way, all of it load-bearing:

- **It still fails closed.** A missing or truncated file means `delete_session` is
  undefined, and an undefined function is "command not found", which deletes nothing.
  ⚠️ This argument covers accidents, NOT a hostile file: a *complete* attacker-written
  preamble can define `delete_session` and set the stamp, and sourcing executes it. What
  defends against that is the path choice in the next bullet, not this one. Never
  hand-roll a `DELETE` of your own, which is the one thing that would route around this.
- **The version stamp is the LAST line, and the write condition greps for it.** That one
  choice covers staleness and truncation together: an old skill version's file and a
  half-written one both fail the grep and are rewritten in place, so neither costs you a
  round trip to diagnose and `rm`. The older `[ -s "$PRE" ]` condition could not tell a
  complete file from a half-written one and left both to the post-source guard, which can
  only refuse, not repair. That guard stays as the fail-closed backstop: if the rewrite
  itself is cut short, `CODEMAN_PREAMBLE` is unset and the call stops.
- **Not `/tmp`.** On a shared machine `/tmp` is world-writable, so another local user
  can pre-create the exact path you are about to `.` and have their code run as you.
  `$HOME`-derived paths are not world-writable, and the file is written 0600 anyway.
  The file holds the credential-*recovery code*, not a recovered password.
- **Never put `$$` in a `clientId`.** It changes per call, so the "resend the identical
  request" loop in §5.3 would stop being a duplicate and would **retype the prompt**,
  submitting the turn twice. Use the fixed literal `$CID`.
- Only real environment variables (`CODEMAN_*`, `HOME`) survive, which is why the
  preamble rebuilds `$API` and `$SELF` from them on every source rather than baking
  them in.

If a call comes back as unparseable text instead of JSON, that is almost always a
plain-text 401: see §6 and [the symptom gallery](reference/endpoints.md#symptom-gallery).

## 1. The fast path: N workers, one Bash call

**If the job is "spawn N claude workers, give them tasks, collect the answers", this
block is the whole thing. Run it, report, and stop reading. §2 onward is for jobs this
does not cover; you are not being careless by not reading them.**

Fill in the case names and the prompts, then run it as your FIRST Bash call: no
standalone preamble check before it (line one below IS that check), and no
reconnaissance. `ls ~/codeman-cases` answers nothing this block needs: invented
fresh names need no lookup, and `spawn_worker` refuses a name that already exists
rather than silently reusing it. Everything below is `spawn_workers` / `sendwait` /
`last_text` / `delete_session` from the §0 preamble, so there is nothing to assemble
and no per-call body to hand-build.

```bash
. "${XDG_CACHE_HOME:-$HOME/.cache}/codeman-agent-$CODEMAN_SESSION_ID.sh" 2>/dev/null   # §0 loader
[ "${CODEMAN_PREAMBLE:-}" = 1.33.4 ] || { echo "preamble missing or stale; run the full §0 block"; exit 1; }
N=(alpha beta)                    # INVENT one fresh case name per worker; never list cases first
                                  # (a name may carry a mode: `beta:deepseek`, see below)
T=('reply with one line: the absolute path of your working directory'
   'reply with one line: your model name')            # tasks, same order as N

S=(); while read -r _ s; do S+=("$s"); done < <(spawn_workers "${N[@]}")   # concurrent
for i in "${!N[@]}"; do [ -n "${S[$i]:-}" ] || FAIL=1; done
[ -z "${FAIL:-}" ] || { echo "a spawn failed (stderr says why; §5.1): deleting the siblings"
  for s in "${S[@]}"; do [ -n "$s" ] && delete_session "$s" >/dev/null; done; exit 1; }

D=$(mktemp -d) || { for s in "${S[@]}"; do delete_session "$s" >/dev/null; done; exit 1; }
for i in "${!N[@]}"; do sendwait "${S[$i]}" "${T[$i]}" > "$D/$i" & done; wait
for i in "${!N[@]}"; do
  jq -ce --arg n "${N[$i]}" \
    '{worker:$n,delivered:.data.delivered,timedOut:.data.wait.timedOut,signal:.data.wait.signal}' \
    "$D/$i" || echo "{\"worker\":\"${N[$i]}\",\"error\":\"send produced no result\"}"
  echo "== ${N[$i]}"; last_text "${S[$i]}" || echo "(no response written)"
done
for i in "${!N[@]}"; do   # delete ONLY what finished; a timeout means STILL WORKING (§3 rule 5)
  if jq -e '.success and .data.delivered and (.data.wait.timedOut|not)' "$D/$i" >/dev/null 2>&1
  then delete_session "${S[$i]}" >/dev/null
  else echo "kept ${N[$i]} (${S[$i]}): its line above says why; re-wait or repair (§5.3), then delete_session it"
  fi
done; rm -rf "$D"
```

Measured against a live 1.18.0 server: two cold workers spawned and ready in **6.3 s**,
both turns dispatched and both answers read in **4.0 s** more. If your run takes minutes,
the time went into deliberation, not the API. The four things that actually cost time:

- **Spawning serially.** One worker per Bash call is one model turn per worker. `&` plus
  `wait`, as above, makes N workers cost about what one costs.
- **Reconnaissance turns before the spawn.** A standalone preamble check, an
  `ls ~/codeman-cases`, a `list_sessions` "to see what is there": each is a whole
  model turn spent learning something this block already handles (line one performs
  the preamble check, invented names need no listing, and `spawn_worker` refuses
  collisions). A live two-worker run spent ~12 s of its 28 s total on exactly two
  such turns; the API work in between was under 10 s.
- **Re-deriving the happy path** from §5.1 + §5.2 + §5.3 + §5.10. That is what the
  preamble functions exist to end. Compose them; do not rebuild them. The tells that
  you are rebuilding anyway: a `for` loop around `quick-start`, a poll on `.data.pid`,
  a bespoke `ready()` or `spawn()` of your own. Each is a worse copy of a function
  already sitting in your preamble; the live run that wrote them spawned serially,
  polled pid for nothing, and shipped its workers without lineage.
- **Verifying what is already checked for you.** Two verifications specifically are not
  worth a call here, because `spawn_worker` carries them: the hooks check (it refuses a
  name that resolved to a hook-less directory with one local grep, so a worker it hands
  back always has a working `stop` and `sendwait` is trustworthy), and the pid poll,
  which is dead weight because `wait-output` already blocks on the composer.

Four things this block leans on, each one link away, no detour needed to run it:

- Those case names must be **fresh scratch names**: they create
  `~/codeman-cases/<name>`, not your repo. A name that already means something (a
  linked case, a pre-existing directory) is refused by `spawn_worker` rather than
  silently reused. Spawning where the work actually is (a linked case, a git worktree)
  is a different call, and picking the wrong one is the costliest mistake in this
  skill: §5.1. Those workspaces do get hooks now, unless the operator disabled it.
- `sendwait` supplies the `\r`, picks a fresh `seq`, and self-heals a stranded Enter.
  A prompt without the `\r` is never submitted (§3), a reused `seq` is silently
  swallowed as an already-applied duplicate, and a lost Enter strands the prompt on the
  composer until a bare `\r` follows: Claude Code 2.1.277 and later ignore Enter for the
  first 30 to 50 seconds after the composer paints while still taking the text, so
  `sendwait` reads the composer and keeps pressing Enter until the prompt has left it.
  All three are reasons to let `sendwait` build the call rather than hand-rolling it.
- Each `sendwait` costs that worker one billed turn, as does every prompt you send it.
- For long or high-stakes worker tasks, `CODEMAN_WORKER_ADVISOR=opus spawn_workers "${N[@]}"`
  (`fable`, `opus` or `sonnet`) gives each claude worker Claude Code's advisor tool: a
  stronger model it consults before committing to an approach, on a recurring error and
  before declaring the task done. Advisor calls bill extra tokens, and an advisor ranked
  below the worker's own model is never attached (on an Opus worker only `opus` and
  `fable` do anything).
- Deleting the sessions does **not** remove the case directories. They are marked as
  agent-created, so `GET /api/v1/cases/agent-created` lists them for cleanup: §5.14.

### DeepSeek Harness workers

The block above spawns claude workers. Any entry in `N` may instead name a mode
(`beta:deepseek`), and **a `deepseek` worker is driven by the same four verbs, with no
change to the rest of the block**: `spawn_workers` waits for its composer, `sendwait`
blocks on its real end-of-turn signal, `last_text` reads its answer, `delete_session`
removes it.

That is true of no other non-claude mode, and it is worth knowing why: the DeepSeek
Harness TUI reports `idle`/`working`/`blocked` to Codeman over the supervisor contract it
implements, so dsh is the one external CLI with definitive `stop`/`blocked` signals
instead of guessed-from-silence ones — and it writes a structured transcript, which is
what `last-response` reads for it. `shell`, `opencode`, `codex`, `gemini`, `antigravity`,
`pi`, `grok` and `omp` have neither and still need markers ([§5.5](reference/verbs.md#55-markers-for-hook-less-workers)).

Three things to know before you spawn one:

- **It needs a pane-capable profile.** `dsh` ships only `web`/`headless`, so the terminal
  agent is always an installed profile. `GET /api/v1/deepseek/status` answers both
  questions separately (`available` = the binary, `runnable` = a profile that can drive a
  pane); a spawn without one fails with `OPERATION_FAILED` rather than falling back.
- **Do not task it on the strength of a `stop` alone.** The harness reports `idle` at
  boot ~300 ms *before* its composer paints (measured 2.26 s vs 2.56 s), so a `sendwait`
  fired straight after `quick-start` resolves on that boot signal, reports a turn that
  never ran, and leaves the prompt in a pane that was not yet taking input. Letting
  `spawn_worker` gate on readiness is what steps past that edge; it is not optional.
- **A profile that does not implement the contract looks like a hang.** Codeman cannot
  know at spawn time whether one does. The tell is a `sendwait` that times out on a
  worker whose pane clearly finished: that profile is one of them, so drive it with
  markers instead.

## 2. What do you want to do?

One row per job. Acting on this table alone is correct; the §5 links are the detail.

| I want to | Call | Detail |
|-----------|------|--------|
| start a worker **where the work is** | `POST /api/v1/quick-start {"caseName":…}`, which **creates** `~/codeman-cases/<name>` unless the name is already a case. Any other path (a git worktree): `POST /api/v1/sessions {"workingDir":…}` then `POST /api/v1/sessions/:id/interactive`. Both install hooks by default, so expect full signals in either, and **verify** rather than assume. N workers means N worktrees | [§5.1](reference/verbs.md#51-where-to-spawn) |
| know a new worker can accept a prompt | `GET .../wait-output?match=shift+tab&from=buffer` (urlencode the `+`); a `deepseek` worker draws `❯` instead, and its boot `stop` fires ~300 ms BEFORE that, so never read the signal as readiness | [§5.2](reference/verbs.md#52-readiness) |
| deliver a task **and** know when it finished | `POST .../input` with `"input":"…\r"`, `clientId`, `seq`, `"wait":true`. Resolves on `stop`, so it is trustworthy where the signal is real: claude mode with hooks (installed by default, but the operator can disable it and remote sessions never get them) and `deepseek` mode through its status bridge. Costs the worker one billed turn | [§5.3](reference/verbs.md#53-send-a-task-and-wait) |
| know a hook-less worker finished | it has no `stop`, and `wait:true` there resolves on flapping `idle` **without erroring**: make it print a split, unique marker and `wait-output` on that instead | [§5.5](reference/verbs.md#55-markers-for-hook-less-workers) |
| read the answer | `GET .../last-response`, **polled** (claude, codex and deepseek write a transcript; empty for the other modes) | [§5.4](reference/verbs.md#54-read-the-answer) |
| know if it is alive | `GET .../wait?until=exit&timeout=1000`: an immediate `signal:"exit"` means dead. `status` and `pid` both lie | [§5.6](reference/verbs.md#56-alive-and-stuck) |
| know if it is stuck | `GET .../active-tools` and `GET .../run-summary` are structured and free; two `terminal?tail=` samples are the crude fallback | [§5.6](reference/verbs.md#56-alive-and-stuck) |
| make a runaway worker stop | `POST .../input {"input":"\u001b"}` (ESC, **no** `\r`). Deleting the session would destroy the conversation instead | [§5.7](reference/verbs.md#57-interrupt-without-destroying) |
| resume a worker halted on a usage limit | `POST .../auto-resume {"enabled":true}`. Respawn and Ralph are **not** the remedy: respawn runs `/clear` | [§5.8](reference/verbs.md#58-usage-limits) |
| give a worker big input | write a file into its workspace with your own tools and send one short line pointing at it. The composer takes 65536 characters, single-line, newlines stripped | [§5.9](reference/verbs.md#59-big-input-via-the-workspace) |
| watch N workers at once | one in-flight wait per worker (per-session waiter cap 16); fan-out shapes differ for claude and shell | [§5.10](reference/verbs.md#510-fan-out) |
| find yourself, list what exists | `GET /api/v1/sessions`, match your `$SELF` by **prefix** | [§5.11](reference/verbs.md#511-list-and-find-yourself) |
| read or record what the user wants | `GET/PUT .../intent`, and `POST .../readmymind` to predict | [§5.12](reference/verbs.md#512-read-my-mind) |
| talk to a claude worker directly | `ListAgents` / `SendMessage`, when the feature is on at both ends | [§5.13](reference/verbs.md#513-messaging-claude-workers) |
| clean up | `delete_session "$SID"` per id you created. Case directories and git worktrees are **not** removed with it; `GET /api/v1/cases/agent-created` lists the scratch case dirs your spawns left behind, for you to report | [§5.14](reference/verbs.md#514-clean-up) |

## 3. Rules digest

Ten one-liners. Each breaks something concrete; the reason is one link away.

1. **End every input with `\r`** or Enter is never sent and the text sits unsubmitted
   ([§5.3](reference/verbs.md#53-send-a-task-and-wait)).
2. **Never branch on `.data.status`.** It reads `idle` mid-turn and `idle` on a dead
   worker ([§5.6](reference/verbs.md#56-alive-and-stuck)).
3. **Split your markers.** Your typed command echoes into the output stream, so an
   unsplit marker matches before the command runs
   ([§5.5](reference/verbs.md#55-markers-for-hook-less-workers)).
4. **Match single space-free tokens against TUI output.** A TUI positions words with
   cursor moves, so multi-word matches are unreliable there
   ([§5.2](reference/verbs.md#52-readiness)).
5. **A wait timeout is a 200, not an error.** Loop over short waits; the clamp and the
   applied `wait.timeoutMs` are in
   [endpoints.md](reference/endpoints.md#limits-and-caps).
6. **Signals are edge-triggered with no history.** Register the waiter before the
   event can happen; a `stop` that fires with no waiter is unobservable afterwards
   ([§5.10](reference/verbs.md#510-fan-out)).
7. **Never delete without `delete_session`.** The server lets a session delete itself
   ([§4](#4-safety-rules)).
8. **One in-flight wait per worker.** The per-session waiter cap is 16 and abandoned
   waits count against it ([§5.10](reference/verbs.md#510-fan-out)).
9. **Every message you send a worker costs it a billed turn**, including a readiness
   ping and an interrupted turn ([§5.7](reference/verbs.md#57-interrupt-without-destroying)).
10. **Never answer another session's dialog.** Approving a permission prompt you did
    not raise authorizes an action the user never saw ([§4](#4-safety-rules)).

## 4. Safety rules

You are yourself a session on this server, and the API has **no undo**.

- **Never act on your own session, and know that `delete_session` is the ONLY guard.**
  The server has no self-protection: a session that DELETEs its own id succeeds and
  dies silently (verified live). **Always delete through `delete_session "$SID"` from
  §0; never write a bare `curl -X DELETE` and never reintroduce the
  `is_self … || curl -X DELETE …` shape.** That older form failed open: with the
  function undefined (a missing or truncated preamble file, see §0) bash returns 127,
  the `||` branch fires, and the delete runs with no self-check at all. Wrapping the
  request inside the guard is what makes a lost preamble delete nothing instead of
  deleting you. Apply the same prefix-both-directions reasoning before any kill,
  respawn, or input call you write by hand.
- **Mutating calls you may make unprompted** (this is an allowlist):
  `POST /api/v1/quick-start`; `POST /api/v1/sessions` + `POST /api/v1/sessions/:id/interactive`
  (or `/shell`) for a directory the user's own task named; `POST /api/v1/sessions/:id/input`;
  and `DELETE /api/v1/sessions/:id` **only** for a session you created in this
  conversation, by exact id. Keep a list of the ids you create. Everything else
  mutating needs the user to have asked for it.
- **Never call these** unless the user explicitly asked, naming the target:
  - `DELETE /api/cases/:name` recursively **deletes a real directory of the user's
    code** from disk. One wrong case name destroys work that was never yours.
  - `DELETE /api/sessions` (no id) is a **bulk kill of every session**, the user's
    real work included. `DELETE /api/subagents/:agentId` kills one background agent;
    `DELETE /api/subagents` (no id) does *not* kill anything, it clears the watcher's
    map and timers, which blinds every subagent surface in the UI until they are
    rediscovered. Neither is yours to call.
  - respawn / ralph / orchestrator / cron mutations: respawn runs `/clear` (wipes a
    conversation), orchestrator state is a single global slot, cron jobs outlive you.
  - `PUT /api/settings`, `POST /api/system/update`: global UI settings; server restart.
  - `POST /api/approvals/:id/answer`. It types a digit, an Esc or free text into
    whichever session raised the prompt. Approving another session's permission
    dialog authorizes a tool call the user never saw, from a session that is not
    yours. Answer only a prompt raised by a worker you created, and only when the
    user asked you to.
- **Never spawn a worker into the directory you are editing**, and give N workers N
  git worktrees rather than one shared checkout. Two agents in one working tree
  interleave writes and each reads the other's half-finished files; a `git checkout`
  in one yanks the tree out from under the other. Creating worktrees changes the
  user's repository state, so say that you did; **removing** one discards any
  uncommitted work inside it, so ask first ([§5.1](reference/verbs.md#51-where-to-spawn)).
- Never `tmux kill-session`, `pkill tmux`, `pkill claude`. The API is the only interface.
- Sessions count against a **global cap of 50** (and, in multi-user mode, a per-user
  cap of 25 that fires the same 409). Case creation is uncapped and writes real
  directories. Clean up every session you start, and never retry `quick-start` in a
  loop.

## 5. Recipes → [reference/verbs.md](reference/verbs.md)

The per-verb detail lives in [reference/verbs.md](reference/verbs.md), loaded on demand
so it is not paid for on every skill load. Section numbers and anchors are unchanged, so
a `§5.4` reference still resolves. **§1 already covers the common job without any of
these**; open the one row you actually hit.

| Open | When |
|------|------|
| [5.1 Where to spawn](reference/verbs.md#51-where-to-spawn) | the work is **not** a fresh scratch case: a linked case, a git worktree, any path that already existed. Hooks are absent there, which silently breaks send-and-wait. The costliest mistake in this skill |
| [5.2 Readiness](reference/verbs.md#52-readiness) | a worker never drew its composer, or you need the trust-dialog ladder by hand |
| [5.3 Send a task and wait](reference/verbs.md#53-send-a-task-and-wait) | the `sendwait` body, its signals, and the duplicate-resend loop |
| [5.4 Read the answer](reference/verbs.md#54-read-the-answer) | `last_text` came back empty, or the mode is not claude/codex/deepseek |
| [5.5 Markers for hook-less workers](reference/verbs.md#55-markers-for-hook-less-workers) | the worker has no `stop` hook: synchronize on a split, unique printed marker |
| [5.6 Alive and stuck](reference/verbs.md#56-alive-and-stuck) | is it dead or just slow? `status` and `pid` both lie |
| [5.7 Interrupt without destroying](reference/verbs.md#57-interrupt-without-destroying) | a runaway worker you want to stop but keep |
| [5.8 Usage limits](reference/verbs.md#58-usage-limits) | a worker halted on a subscription limit |
| [5.9 Big input via the workspace](reference/verbs.md#59-big-input-via-the-workspace) | the prompt is larger than one composer line |
| [5.10 Fan out](reference/verbs.md#510-fan-out) | many workers at once: waiter caps, and why signals are edge-triggered |
| [5.11 List and find yourself](reference/verbs.md#511-list-and-find-yourself) | enumerate sessions, or match `$SELF` by prefix |
| [5.12 Read My Mind](reference/verbs.md#512-read-my-mind) | read or record what the user wants for a case |
| [5.13 Messaging claude workers](reference/verbs.md#513-messaging-claude-workers) | `ListAgents` / `SendMessage` instead of the HTTP path |
| [5.14 Clean up](reference/verbs.md#514-clean-up) | what deleting a session does **not** remove, and how to list the case dirs you left |

## 6. Setup and auth

You need this section only when the API answers something `jq` cannot parse, or when
you are on a server old enough to lack the wait endpoints. Endpoint-level detail lives
in [endpoints.md](reference/endpoints.md#auth-and-credentials).

### Credentials

Auth is active only when the server has `CODEMAN_PASSWORD` (or is in multi-user mode).
**Your session has usually inherited that password already**, which is why the §0
preamble tries `$CODEMAN_PASSWORD` first: Codeman does not strip it. `buildClaudeEnv()`
(`src/session-cli-builder.ts`) spreads the server's entire `process.env` into the
session and deletes only `COLORTERM` and `CLAUDECODE`, and the tmux spawn path applies
no denylist either. On a stock password-protected install (`install.sh` writes the
password into the systemd unit or launchd plist, so the server process carries it) the
value is simply in your environment.

It is not guaranteed, though, which is what the fallbacks are for. A tmux pane
inherits the **tmux server's** environment, and that server can predate the password;
and the data dir's `.env` is only ever read by the `codeman` CLI itself, never loaded
into the web server's environment.

Fallback 1, in the §0 preamble already: the data dir's `.env`, the same file
`codeman attach` reads. It is hand-authored; nothing ever writes it.

Fallback 2, for a stock install where the supervisor definition is the only copy on
disk. Append this to the preamble file (before its version-stamp line) and re-source:

```bash
if [ -z "${CODEMAN_PASSWORD:-}" ]; then    # install.sh puts it in the service definition
  UNIT="$HOME/.config/systemd/user/codeman-web.service"
  PLIST="$HOME/Library/LaunchAgents/com.codeman.web.plist"
  if [ -f "$UNIT" ]; then
    # install.sh backslash-escapes " and \ in the unit value; undo it or a password
    # containing either recovers wrong and auth fails.
    CODEMAN_PASSWORD=$(sed -n 's/^Environment="CODEMAN_PASSWORD=\(.*\)"$/\1/p' "$UNIT" | head -1 | sed 's/\\\(["\\]\)/\1/g')
  elif [ -f "$PLIST" ]; then
    # install.sh XML-escapes the plist value; undo it (&amp; LAST, mirroring escape order).
    CODEMAN_PASSWORD=$(awk '/<key>CODEMAN_PASSWORD<\/key>/{getline; print}' "$PLIST" | sed -n 's/.*<string>\(.*\)<\/string>.*/\1/p' \
      | sed -e 's/&lt;/</g' -e 's/&gt;/>/g' -e 's/&amp;/\&/g')
  fi
fi
```

⚠️ **A 401 is plain text, not the JSON envelope**, so on a password-protected server
every `jq` in these recipes dies with `jq: parse error` instead of showing
`UNAUTHORIZED`. If that happens, check the status with `-w '%{http_code}'`; if it is
401 and no fallback found a credential, **stop and tell the user you need
credentials**. The same is true of the guards that run before any handler: the Host
allowlist (`403 Forbidden: host not allowed`), the Origin/CSRF guard, and the auth
rate limiter's 429 all answer in plain text. The hook-secret bypass covers only
`/api/hook-event` and `/api/status-telemetry`, never session control.

In multi-user mode accounts live in `users.json` and the credential is a real user's
name and password. A recovered `CODEMAN_PASSWORD` still often works: `bootstrapInitialAdmin()`
(`user-store.ts:417-427`) creates the FIRST admin from `CODEMAN_USERNAME`/`CODEMAN_PASSWORD`
on first boot when no users exist, so on a stock multi-user install that pair usually IS
a valid admin login until someone changes it. Try it once; if it fails, ask the user
rather than retrying (ten failures rate-limit the address).

### Server version

The wait endpoints first ship in Codeman **1.13.0**, but do not gate on the version
number: a dev build can serve them while reporting an older version. Probe instead.
`GET .../wait` on a real session id answering 404 with an `.error` starting `Route `
means the server predates them (fall back to polling `GET .../terminal?tail=` and say
so). `Session ... not found` means your session id is wrong, not the server.

### Where the API is unreachable

- **Remote-SSH cases** do not export `CODEMAN_MUX`/`CODEMAN_API_URL` into the session,
  so the §0 guard fails closed and you refuse to act. That is correct behavior, not a
  bug to work around.
- **Inside a Docker case**, a loopback-bound server is unreachable from the container,
  and `CODEMAN_DOCKER_BRIDGE_HOOKS=1` does not fix it: that opens a hooks-only
  listener, so hook events flow but `/api/v1/*` stays refused. Report it rather than
  retrying; making it reachable is an operator decision.

Everything else (endpoint tables, per-mode signal table, error codes, capacity limits,
Docker/remote caveats): [reference/endpoints.md](reference/endpoints.md). Fan-out
orchestration and blocked-worker handling: [reference/recipes.md](reference/recipes.md).
