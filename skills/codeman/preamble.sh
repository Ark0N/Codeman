# ---- Codeman agent preamble 1.51.0 (seeded by Codeman at session spawn; the SKILL.md §0 bootstrap rewrites it when missing or stale) ----
# Positional parameters are always written with braces, ${1} and never a bare dollar-digit: Claude Code
# replaces a bare one in a skill body with the matching word of the skill's arguments, and §0 is pasted
# from that body (test/agent-skill.test.ts pins it).
API="${CODEMAN_API_URL:?CODEMAN_API_URL not set; refusing to guess}"
SELF="${CODEMAN_SESSION_ID:?CODEMAN_SESSION_ID not set}"
# Credentials, cheapest first. Your session has usually INHERITED the server's
# CODEMAN_PASSWORD already (§6 explains why, and what to do when it has not);
# the data dir's .env is the documented fallback, the same one `codeman attach`
# reads. The data dir is wherever the hook-secret file lives. Values may be
# quoted or `export`-prefixed.
ENV_FILE="${CODEMAN_HOOK_SECRET_FILE:+${CODEMAN_HOOK_SECRET_FILE%hook-secret}.env}"
envval() { sed -n "s/^\(export \)\{0,1\}${1}=//p" "$ENV_FILE" | tail -1 | sed 's/^"\(.*\)"$/\1/; s/^'\''\(.*\)'\''$/\1/'; }
if [ -z "${CODEMAN_PASSWORD:-}" ] && [ -n "$ENV_FILE" ] && [ -f "$ENV_FILE" ]; then
  CODEMAN_USERNAME=$(envval CODEMAN_USERNAME)
  CODEMAN_PASSWORD=$(envval CODEMAN_PASSWORD)
fi
AUTH=(); [ -n "${CODEMAN_PASSWORD:-}" ] && AUTH=(-u "${CODEMAN_USERNAME:-admin}:$CODEMAN_PASSWORD")
# -k: harmless on http, required on https (self-signed cert).
# X-Codeman-Parent-Session: tags workers YOU spawn as your children, so the web UI can
# draw the lineage. Set once here and every present and future create call carries it.
# The agent inbox reads it too, as "who is calling" (§5.15); every other endpoint ignores
# it. It can never fail a spawn, so there is no case where you would want to leave it off.
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
  "${CURL[@]}" -G "$API/api/v1/sessions/${1}/wait-output" \
    --data-urlencode 'match=shift+tab' --data-urlencode 'from=buffer' \
    --data-urlencode "timeout=${2}" | jq -r '.data.wait.matched // false'
}
_mark_up() {       # <sid> <mark> <timeoutMs> -> "true"/"false": a literal, space-free token
  # in the pane's output, read from the buffer so a composer drawn before the wait counts.
  "${CURL[@]}" -G "$API/api/v1/sessions/${1}/wait-output" \
    --data-urlencode "match=${2}" --data-urlencode 'from=buffer' \
    --data-urlencode "timeout=${3}" | jq -r '.data.wait.matched // false'
}
_dsh_up() {        # <sid> <timeoutMs> -> "true"/"false". The DeepSeek Harness TUI's
  # composer glyph. Override with DSH_READY_MARK for a profile that draws another one.
  _mark_up "${1}" "${DSH_READY_MARK:-❯}" "${2}"
}
_dsh_guide() {     # <sid> -> 0 when the pane shows dsh-TUI's first-run SETUP GUIDE, not a composer.
  # dsh-TUI 0.19.0 opens a guide ("Welcome to dsh-TUI  Step 1 of 4") in every session until a
  # person has finished it once, and the guide's own cursor is `❯`: the readiness mark matches
  # on it (measured, 2 of 2 launches), and an Enter there acts on the highlighted step, which
  # is a sign-in. So a worker whose mark matched is still checked for the guide, on the
  # RENDERED pane with its whitespace removed, and never handed back while it shows.
  "${CURL[@]}" -G "$API/api/v1/sessions/${1}/terminal" --data-urlencode 'full=1' \
    | jq -r '.data.terminalBuffer // empty' \
    | sed -e "s/$(printf '\033')\[[0-9;?]*[a-zA-Z]//g" -e "s/$(printf '\033')[()][AB0]//g" \
    | tr -d ' \t' | grep -qi 'Step[0-9]of[0-9]'
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
  "${CURL[@]}" -G "$API/api/v1/sessions/${1}/terminal" --data-urlencode 'full=1' \
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
  t=$("${CURL[@]}" -G "$API/api/v1/sessions/${1}/terminal" --data-urlencode 'full=1' \
    | jq -r '.data.terminalBuffer // empty' \
    | sed -e "s/$(printf '\033')\[[0-9;?]*[a-zA-Z]//g" -e "s/$(printf '\033')[()][AB0]//g" \
    | tr -d '\r' | grep -a '^[[:space:]]*❯' | tail -1)
  [ -n "$t" ] || { printf '?'; return 0; }
  # Claude Code draws a NO-BREAK SPACE (U+00A0) after the glyph, which [:space:] does
  # not cover, so it is stripped by its bytes, portably (BSD sed has no \xHH).
  printf '%s' "$t" | sed 's/^[[:space:]]*❯//' | tr -d '[:space:]' | sed "s/$(printf '\302\240')//g"
}
_accept_trust() {  # <sid> -> 0 once it has answered the dialog, 1 if it could not
  local sid="${1}" k i=1
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
# ---- the local model: the model Codeman installed on this Mac, as a worker ----
# local_model -> ONE compact JSON object on stdout. rc 0 only when a `local` worker can be
# spawned now (`running:true`) or once spawn_worker has started the runtime (`running:false`):
#   {"spawnable":true,"state":"installed","running":true,"cli":"opencode","cliLabel":"OpenCode",
#    "endpointId":"local-ollama","modelId":"<id>","modelLabel":"<label>",
#    "agents":[{"cli":"opencode","cliLabel":"OpenCode","status":"ready","default":true,"readyMark":"┃"},
#              {"cli":"pi","cliLabel":"Pi","status":"installable","default":false}],
#    "models":[{"id":"<id>","label":"<label>","active":true,"status":"ready","sizeGb":"23.1"}]}
# `cli` is the DEFAULT coding agent, the one `spawn_worker <name> local` starts. `agents` is
# every agent the model can be run with: `local:<cli>` starts one whose status is `ready`
# (`installable`, `installing` and `setup-needed` are a person's to resolve in the window).
# `models` is what is on this Mac; only the `active` one runs, and switching is a person's
# decision too. A Codeman older than 1.51 sends neither list: only `local` works there.
# Otherwise rc 1 and {"spawnable":false,"reason":"<reason>","message":"<why>",...}, the reason
# one of: not-mac, not-installed, install-unfinished, no-agent (installed, but no coding agent
# that can run the model is on this Mac), blocked (installed, but the server
# refuses a session now: the model changed on disk, another program holds the port, the
# runtime does not start), admin-only (multi-user mode, 403), unsupported (a Codeman without
# local models, 404), unauthorized (401, §6), unreachable, error.
# One GET of an EXPERIMENTAL route. It downloads, installs and starts nothing: installing is
# a person's decision, made in Codeman's "Run a local model" window.
local_model() {
  local r code body out
  r=$("${CURL[@]}" -w '\n%{http_code}' "$API/api/v1/local-model")
  code=${r##*$'\n'}; body=${r%$'\n'*}
  case "$code" in
    200) out=$(jq -c '
      def say: (.text // "") as $t
        | reduce ((.vars // {}) | to_entries[]) as $e ($t; gsub("\\{" + $e.key + "\\}"; $e.value));
      .data as $d | ($d.install // {}) as $i | ($i.actions // []) as $a
      | {state:$i.state, running:($i.running == true), cli:$i.cli, cliLabel:$i.cliLabel,
         endpointId:$i.endpointId, modelId:$i.model.id, modelLabel:$i.model.label,
         agents:(if ($i.harnesses | type) == "array"
                 then [$i.harnesses[] | {cli, cliLabel, status, default, readyMark} | with_entries(select(.value != null))]
                 else null end),
         models:(if ($i.library | type) == "array" and ($i.library | length) > 0
                 then [$i.library[] | {id, label, active, status, sizeGb} | with_entries(select(.value != null))]
                 else null end)} as $base
      | if ($d | type) != "object" then {spawnable:false, reason:"error", message:"no data in the answer"}
        elif $i.state == "installed" then
          # With the agents listed and none of them startable there is nothing to spawn,
          # running or not: say that, not "blocked".
          if $i.error == null and $base.agents != null and ([$base.agents[] | select(.status == "ready")] | length) == 0
          then {spawnable:false, reason:"no-agent",
                message:"The model is installed, but no coding agent that can run it is on this Mac. A person installs one in the Run a local model window."} + $base
          # `start` alone over-promises: it is offered too while another program holds the
          # port. Only an error-free start is a runtime spawn_worker can bring up.
          elif ($i.cli and $i.endpointId and $i.model.id)
             and (($a | index("start-session")) != null or (($a | index("start")) != null and $i.error == null))
          then {spawnable:true} + $base
          else {spawnable:false, reason:"blocked", errorCode:$i.error.code,
                message:(if $i.error then ($i.error.message | say)
                         else "The model is installed, but the server offers no session on it right now." end)} + $base
          end
        elif $d.recommendation.reason == "not-macos" then
          {spawnable:false, reason:"not-mac",
           message:("Local models need a Mac with Apple silicon, and this Codeman runs on " + ($d.hardware.platform // "another system") + ".")}
        elif $i.state == "idle" then
          {spawnable:false, reason:"not-installed",
           message:("No local model is installed. " + (if $d.recommendation.verdict == "none" then ($d.recommendation.headline | say)
             else "A person installs one with Run a local model on the Codeman welcome screen." end))}
        else
          {spawnable:false, reason:"install-unfinished", step:$i.step, errorCode:$i.error.code,
           message:("The install is " + ($i.state // "unfinished") + (if $i.step then " at its " + $i.step + " step" else "" end)
             + (if $i.error then ": " + ($i.error.message | say) else "." end)
             + " Only the Run a local model window continues it.")} + $base
        end
      | with_entries(select(.value != null))' <<<"$body" 2>/dev/null) ;;
    000) out=$(jq -nc --arg a "$API" '{spawnable:false,reason:"unreachable",message:("No answer from Codeman at " + $a + ".")}') ;;
    401) out='{"spawnable":false,"reason":"unauthorized","message":"Codeman refused the credentials (401): see the codeman skill, section 6."}' ;;
    403) jq -e '.errorCode == "FORBIDDEN"' <<<"$body" >/dev/null 2>&1 &&
           out='{"spawnable":false,"reason":"admin-only","message":"In multi-user mode the local model is for admins only: ask an admin of this Codeman."}' ;;
    404) out='{"spawnable":false,"reason":"unsupported","message":"This Codeman has no local model support: it predates it."}' ;;
  esac
  [ -n "${out:-}" ] || out=$(jq -nc --arg c "$code" --arg t "$body" \
    '{spawnable:false,reason:"error",status:$c,message:((($t | fromjson? | .error?) // $t)[0:300])}')
  printf '%s\n' "$out"
  [ "$(jq -r .spawnable <<<"$out")" = true ]
}
# _local_ready_model -> local_model's JSON once a `local` worker can start, rc 1 with the
# reason on stderr otherwise. An installed model whose runtime is stopped is started first,
# with exactly what the local model window's Start button sends, and read again until it
# runs (bounded, about 30 s). ⚠️ That start also undoes a Stop the person made: the runtime
# starts with Codeman again from then on. Concurrent spawns may both send it; the server
# runs one runtime verb at a time and a second start keeps the runtime that runs.
_local_ready_model() {
  local lm r i=0
  lm=$(local_model) || { jq -r '"no local model to spawn on (" + .reason + "): " + .message' <<<"$lm" >&2; return 1; }
  [ "$(jq -r .running <<<"$lm")" = true ] && { printf '%s\n' "$lm"; return 0; }
  r=$("${CURL[@]}" -X POST "$API/api/v1/local-model/runtime" -H 'Content-Type: application/json' -d '{"action":"start"}')
  jq -e '.success == true' <<<"$r" >/dev/null 2>&1 || {
    echo "could not start the local model runtime: $(jq -r '.error // empty' <<<"$r" 2>/dev/null || printf '%s' "$r" | head -c 300)" >&2
    return 1; }
  while :; do
    lm=$(local_model) || { jq -r '"the local model runtime was started, but (" + .reason + "): " + .message' <<<"$lm" >&2; return 1; }
    [ "$(jq -r .running <<<"$lm")" = true ] && { printf '%s\n' "$lm"; return 0; }
    i=$((i+1)); [ "$i" -lt 15 ] || { echo "the local model runtime did not report running within 30 s" >&2; return 1; }
    sleep 2
  done
}
# spawn_worker <caseName> [mode] -> session id on stdout, diagnostics on stderr.
# quick-start AND readiness in one call, with a strict contract: NON-EMPTY stdout means
# a READY worker whose end-of-turn signal can be trusted -- a claude worker in a
# hook-carrying case, or a `deepseek` worker whose harness TUI drew its composer -- or a
# `local` worker (below) whose composer drew, which takes a prompt but has NO end-of-turn
# signal unless its harness is claude: drive that one with sendmark.
# Anything less is rc 1 with EMPTY stdout, and the half-spawned session is deleted here
# rather than handed back, because a worker that never drew its composer would eat the
# task prompt with its trust dialog. There is deliberately no pid poll: wait-output
# already blocks until the composer draws, and pid!=null proved startup, never readiness.
# mode `local` is the model Codeman installed on this Mac (local_model), run by its default
# coding agent; `local:<cli>` (`local:pi`, `local:deepseek`, `local:opencode`, `local:claude`)
# picks another one of local_model's `agents`, which must be `ready`. The worker's mode
# becomes that agent, and the endpoint and model ride the quick-start as `customModel`: the
# launch the window's "Start a session" makes. A stopped runtime is started first. Any answer
# that wants a person to confirm something (a context below the agent's safe floor, a model
# swap) fails the spawn: this never confirms on anyone's behalf, and it never installs an
# agent. All local workers share ONE model that answers one request at a time.
# CODEMAN_WORKER_ADVISOR=opus (or fable / sonnet) gives every CLAUDE worker spawned while
# it is set Claude Code's advisor tool: a stronger model the worker consults before
# committing to an approach, on a recurring error and before declaring the task done.
# Other modes ignore it. A value the server refuses fails the spawn (INVALID_INPUT); an
# advisor that ranks below the worker's model is accepted but never attached by claude.
spawn_worker() {
  local name="${1:?spawn_worker needs a case name}" mode="${2:-claude}" q sid cp r lm cm='' mark='' want=''
  case "$mode" in local:*) want=${mode#local:}; mode=local ;; esac
  if [ "$mode" = local ]; then
    lm=$(_local_ready_model) || return 1
    if [ -n "$want" ]; then
      # Only an agent the server lists as startable. A Codeman that lists none (older than
      # 1.51) knows one agent, its `cli`: naming that one is fine, any other is not.
      r=$(jq -r --arg w "$want" 'if (.agents | type) == "array" then ([.agents[] | select(.cli == $w) | .status][0] // "absent")
                                 elif .cli == $w then "ready" else "unlisted" end' <<<"$lm")
      case "$r" in
        ready) ;;
        unlisted) echo "this Codeman lists one coding agent for the local model, $(jq -r .cli <<<"$lm"): use plain \`local\`, or update Codeman to choose another" >&2; return 1 ;;
        absent) echo "the local model cannot be run with '$want' here. Startable: $(jq -r '[.agents[] | select(.status == "ready") | .cli] | join(", ")' <<<"$lm")" >&2; return 1 ;;
        *) echo "the coding agent '$want' is not startable on this Mac ($r): a person installs or sets it up in the Run a local model window. Startable now: $(jq -r '[.agents[] | select(.status == "ready") | .cli] | join(", ")' <<<"$lm")" >&2; return 1 ;;
      esac
      mode=$want
    else
      mode=$(jq -r .cli <<<"$lm")
    fi
    cm=$(jq -c '{endpointId, modelId}' <<<"$lm")
    # Readiness is a token the agent's composer draws once it takes input. The server names
    # the measured one per agent (`readyMark`: opencode `┃`, deepseek `❯`, claude `shift+tab`).
    # For a server that sends none, the two this skill measured itself:
    #  - opencode `┃`: at boot only the composer draws it (1.3.0 and 1.19.5, a prompt pasted
    #    at the mark was submitted every time).
    #  - pi `extended-keys`: pi paints its composer rules in its FIRST frame and ignores Enter
    #    until startup has finished, so its rule is no mark (a prompt sent at it stayed
    #    unsent, 2 of 2). The last line of its startup is a warning that tmux's
    #    `extended-keys` option is off, which it is on Codeman's socket: a prompt sent once
    #    that word showed was submitted, 4 of 4 on pi 1.5.2. It is a side effect, not a
    #    contract, so a pi that stops printing it fails the spawn (the worker is deleted, never
    #    handed back on a guess) until LOCAL_READY_MARK names what it draws instead.
    # claude takes the claude path below.
    mark=$(jq -r --arg m "$mode" '[(.agents // [])[] | select(.cli == $m) | .readyMark // empty][0] // empty' <<<"$lm")
    [ -n "$mark" ] || case "$mode" in opencode) mark='┃' ;; pi) mark='extended-keys' ;; esac
    mark=${LOCAL_READY_MARK:-$mark}
    [ "$mode" = claude ] || [ -n "$mark" ] || {
      echo "the local model runs through $mode, and this skill knows no composer mark for it: set LOCAL_READY_MARK to a space-free token its composer draws" >&2
      return 1; }
  fi
  # parentSessionId doubles the CURL header, so a spawn_worker copied off the shared
  # curl (or a body someone rebuilt from this recipe) still carries its lineage.
  # deepseek: ask for the same permission posture the Run button sends, because the
  # harness's own default (`workspace-write`) still ASKS, and a worker that stops on
  # an approval row is a worker no fan-out can finish. It is not an escalation --
  # claude workers already spawn with permissions skipped, and in multi-user mode the
  # server clamps this back to `workspace-write` for an owner without the grant.
  # Spawn by hand (§5.1) when you want a worker that asks. The advisor is a cloud model,
  # so a claude worker on the local model never gets one.
  # pi on the local model: a custom model session gives pi a home of its own, so it would
  # ask "Trust project folder?" in EVERY session whose parent folders hold agent skills, with
  # Trust preselected, and the task prompt's Enter would answer it. `approveProjectTrust:
  # false` starts it with --no-approve: no dialog, and no project code is trusted for anyone.
  q=$("${CURL[@]}" -X POST "$API/api/v1/quick-start" -H 'Content-Type: application/json' \
      -d "$(jq -nc --arg n "$name" --arg m "$mode" --arg p "$SELF" --arg a "${CODEMAN_WORKER_ADVISOR:-}" --arg cm "$cm" \
        '{caseName:$n,mode:$m,parentSessionId:$p}
         + (if $m == "deepseek" then {deepSeekConfig:{permissionMode:"danger-full-access"}} else {} end)
         + (if $m == "claude" and $a != "" and $cm == "" then {advisorModel:$a} else {} end)
         + (if $m == "pi" and $cm != "" then {piConfig:{approveProjectTrust:false}} else {} end)
         + (if $cm != "" then {customModel:($cm | fromjson)} else {} end)')")
  # The answers that want a PERSON to decide come back as success with no session id.
  if jq -e '(.data // .) | (.requiresContextWarning or .requiresConfirmation)' <<<"$q" >/dev/null 2>&1; then
    jq -r '"quick-start wants a person to confirm something, so no worker was started: " + ((.data // .) | tojson)' <<<"$q" >&2
    return 1
  fi
  sid=$(jq -r 'if .success then .data.sessionId else empty end' <<<"$q")
  # NOT retryable in a loop: every quick-start failure code is terminal (§5.1).
  [ -n "$sid" ] || { jq -c '{error,errorCode}' <<<"$q" >&2; return 1; }
  # A server without advisor support DROPS the field instead of refusing it, so read it
  # back: a worker silently missing the advisor it was asked for is worth one line.
  if [ "$mode" = claude ] && [ -z "$cm" ] && [ -n "${CODEMAN_WORKER_ADVISOR:-}" ] &&
     [ "$("${CURL[@]}" "$API/api/v1/sessions/$sid" | jq -r '.data.advisorModel // empty')" != "$CODEMAN_WORKER_ADVISOR" ]; then
    echo "worker $sid: this Codeman server ignored CODEMAN_WORKER_ADVISOR (no advisor support); it runs without one" >&2
  fi
  if [ -n "$cm" ] && [ "$mode" != claude ]; then
    # No trust dialog and no hook file to vet. opencode and pi have no end-of-turn signal,
    # which is exactly why sendwait refuses them (400) and sendmark drives them. A deepseek
    # worker reports the end of a turn on the local model too, but sendmark is still the way
    # to get its ANSWER: dsh 0.2.2 renamed its transcript file, and until Codeman reads the
    # new one `last-response` comes back empty for it.
    r=$(_mark_up "$sid" "$mark" 45000)
    [ "$r" = true ] || { echo "local worker $sid ($mode) never drew '$mark' within 45 s; deleted it. Look at GET /api/v1/local-model and the pane of a hand-made session before retrying" >&2
      delete_session "$sid" >/dev/null; return 1; }
    if [ "$mode" = deepseek ] && _dsh_guide "$sid"; then
      echo "dsh worker $sid opened DeepSeek Harness's setup guide instead of a composer; deleted it. A person finishes that guide once (start a DeepSeek session from the Run menu), then spawn again" >&2
      delete_session "$sid" >/dev/null; return 1
    fi
    printf '%s\n' "$sid"; return 0
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
    if _dsh_guide "$sid"; then
      echo "dsh worker $sid opened DeepSeek Harness's setup guide instead of a composer; deleted it. A person finishes that guide once (start a DeepSeek session from the Run menu), then spawn again" >&2
      delete_session "$sid" >/dev/null; return 1
    fi
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
# `beta:deepseek` makes that one a DeepSeek Harness worker, `summ:local` a worker on the
# local model, and a mixed fleet is one call. Case names must be UNIQUE: two workers in
# one case directory co-edit the same tree (§4), so a repeat is an error here, not a race
# (the mode never disambiguates two workers, since they would still share the directory).
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
# idle: markers instead (§5.5, sendmark below). ⚠️ A dsh worker running a profile that does not
# implement the status contract is the one case that LOOKS like claude but is not:
# it accepts the send and then burns both waits. One timeout on a dsh worker whose
# pane clearly finished means that profile, so switch that worker to markers.
sendwait() {
  local sid="${1:?}" p="${2:?}" seq="${3:-$(date +%s)}" body r c head n=0 tmp bg i
  # One line, like every other waiting sender (`toSingleLine`, `codeman agent send`,
  # the TUI): the server pastes a multi-line prompt as one block, and the loop below,
  # like the server's own submit check, cannot recognise a pasted block that is still
  # on the composer, so a prompt like `Review this:\n- item 1` would sit unsent for
  # the whole re-wait. Each line is trimmed, blank lines are dropped, the rest are
  # joined with a space. For a long multi-line task, write a file and send its path.
  case "$p" in *$'\n'*|*$'\r'*)
    p=$(printf '%s\n' "$p" | tr '\r' '\n' | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' -e '/^$/d' | paste -sd ' ' -) ;;
  esac
  [ -n "$p" ] || { echo "sendwait: empty prompt" >&2; return 1; }
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
# sendmark <sid> <prompt> [timeoutSec] -> one JSON line, for an AGENT worker with no
# end-of-turn signal: a `local` worker whose agent is not claude, a hook-less claude, and
# every external agent mode but deepseek (a shell worker takes §5.5's echo form instead):
#   {"token":…,"delivered":true,"matched":true,"answerFile":"<path>","answer":"<text>",…}
# rc 0: the answer file was read, after the marker or once the file held still (below).
# 2: neither within the timeout (default 600 s; the worker may still be working, so nothing
# is deleted). 3: the worker's pane ended. 4: the marker printed, but no answer file turned
# up within SENDMARK_FILE_WAIT seconds of it (default 120). 1: the send or a wait failed
# (`detail` says why).
# It adds ONE sentence to your prompt (joined onto one line, as sendwait does): write the
# complete answer to codeman-answer-<token>.md in the working directory, and only then end
# the reply with the word DONE immediately followed by _<token>. The marker is split in what
# is typed, so the prompt echoing into the pane never matches it, and the token is new for
# every call and every worker (§5.5). The send is sendwait's exactly-once body (per-worker clientId,
# epoch-second seq) with a one-second `exit` wait, so `delivered` says the pane took it.
# ⚠️ A marker proves that the model printed the token. Not that it did the work, not that
# it did it right, not even that the turn is over: a reasoning model can restate the
# instruction while it plans. That is why the answer FILE is the second gate. ⚠️ And a
# full-screen agent can print the marker without it ever matching: opencode redraws its
# spinner between the pieces a model streams, so the stripped stream reads D⬝⬝O⬝⬝N⬝⬝E_⬝⬝m…
# (measured on opencode 1.3.0 on Linux, a reply streamed a character or two at a time; the screen
# showed the whole token). So the file is also the way out WITHOUT the marker: present, not
# empty, and unchanged between two rounds of the marker wait (rounds of at most 10 s), it is
# read and `matched` says false. It is read from this machine's disk, only when it is a
# regular file (a symlink is refused), at most 256 KB of it. It stays in the worker's folder
# (§5.14).
# SENDMARK_ANSWER_FILE=0 asks for the marker alone, for a worker that cannot write where it
# runs (codex in a folder it runs read-only, an agent that asks before it writes a file, a
# worker on another host): rc 0 then means only "the marker printed", and the answer is
# yours to read (last_text for codex, §5.4). Without the file there is no way out but the
# marker, so on a full-screen agent that can be rc 2 for a reply that finished.
sendmark() {
  local sid="${1:?}" p="${2:?}" t="${3:-600}" tok mark file='' wd r w='' rem end start got=0 ended=0 matched=false i=0 rc=2 fp prev=''
  case "$p" in *$'\n'*|*$'\r'*)
    p=$(printf '%s\n' "$p" | tr '\r' '\n' | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' -e '/^$/d' | paste -sd ' ' -) ;;
  esac
  [ -n "$p" ] || { echo "sendmark: empty prompt" >&2; return 1; }
  # The token carries six characters of the WORKER's id on top of the second and $RANDOM.
  # Those two repeat: in zsh (the shell Claude Code runs on a Mac) every subshell draws the
  # SAME $RANDOM until the parent shell reads it, and this line is a subshell. Two sendmark
  # calls started in one second for two workers in ONE folder shared a token, and one
  # worker's answer file replaced the other's (seen on a Mac, 2026-11-12).
  tok=$(printf 'm%x%04x%s' "$(date +%s)" "$RANDOM" "$(printf '%s' "$sid" | tr -cd 'a-f0-9' | cut -c1-6)"); mark="DONE_$tok"
  if [ "${SENDMARK_ANSWER_FILE:-1}" != 0 ]; then
    wd=$("${CURL[@]}" "$API/api/v1/sessions/$sid" | jq -r '.data.workingDir // empty' 2>/dev/null)
    [ -n "$wd" ] || { echo "sendmark: could not read the working directory of worker $sid" >&2; return 1; }
    file="$wd/codeman-answer-$tok.md"
    p="$p (When you are done: write your complete answer to the file codeman-answer-$tok.md in your current working directory, and only after that file is written, end your reply with the word DONE immediately followed by _$tok with no space in between.)"
  else
    p="$p (When you are done, end your reply with the word DONE immediately followed by _$tok with no space in between.)"
  fi
  r=$("${CURL[@]}" -X POST "$API/api/v1/sessions/$sid/input" -H 'Content-Type: application/json' \
      --data-binary "$(jq -nc --arg p "$p" --arg c "$CID-$sid" --argjson s "$(date +%s)" \
        '{input:($p+"\r"),useMux:true,clientId:$c,seq:$s,wait:"exit",waitTimeout:1000}')")
  if ! jq -e '.success and .data.delivered' <<<"$r" >/dev/null 2>&1; then
    jq -e '.data.wait.ended or .data.wait.signal == "exit"' <<<"$r" >/dev/null 2>&1 && rc=3 || rc=1
    jq -nc --arg t "$tok" --arg r "$r" '{token:$t,delivered:false,matched:false,answerFile:null,answer:null,detail:($r | fromjson? // $r)}'
    return "$rc"
  fi
  start=$(date +%s); end=$((start + t))
  while :; do   # bounded waits of at most 10 s each, until the timeout
    rem=$((end - $(date +%s))); [ "$rem" -ge 1 ] || break
    [ "$rem" -le 10 ] || rem=10
    w=$("${CURL[@]}" -G "$API/api/v1/sessions/$sid/wait-output" --data-urlencode "match=$mark" \
        --data-urlencode 'from=buffer' --data-urlencode "timeout=$((rem * 1000))")
    jq -e '.data.wait.matched' <<<"$w" >/dev/null 2>&1 && { matched=true; break; }
    jq -e '.data.wait.ended' <<<"$w" >/dev/null 2>&1 && { ended=1; break; }
    jq -e '.success' <<<"$w" >/dev/null 2>&1 || {
      jq -nc --arg t "$tok" --arg w "$w" '{token:$t,delivered:true,matched:false,answerFile:null,answer:null,detail:($w | fromjson? // $w)}'
      return 1; }
    # No marker this round. The answer file is the other way out (see above): it counts once
    # it is a non-empty regular file whose checksum did not change since the last round.
    if [ -n "$file" ] && [ ! -L "$file" ] && [ -f "$file" ] && [ -s "$file" ]; then
      fp=$(cksum < "$file"); [ "$fp" = "$prev" ] && { got=1; break; }; prev=$fp
    else
      prev=''
    fi
  done
  if [ "$matched" = true ] && [ -n "$file" ]; then
    while :; do
      [ -L "$file" ] && { echo "sendmark: $file is a symlink, not read" >&2; break; }
      [ -f "$file" ] && { got=1; break; }
      [ "$i" -lt "${SENDMARK_FILE_WAIT:-120}" ] || break
      # Two seconds of waiting that also notices a worker that died: an exit wait answers at
      # once then. A wait that did not answer (server gone) still costs its two seconds.
      w=$("${CURL[@]}" -G "$API/api/v1/sessions/$sid/wait" --data-urlencode 'until=exit' --data-urlencode 'timeout=2000')
      jq -e '.data.wait.signal == "exit" or .data.wait.ended' <<<"$w" >/dev/null 2>&1 && { ended=1; break; }
      jq -e '.success' <<<"$w" >/dev/null 2>&1 || sleep 2
      i=$((i + 2))
    done
  fi
  if [ "$got" = 1 ]; then
    head -c 262144 "$file" | jq -Rsc --arg t "$tok" --arg f "$file" --argjson m "$matched" \
      --argjson s "$(($(date +%s) - start))" --argjson c "$(($(wc -c < "$file")))" \
      '{token:$t,delivered:true,matched:$m,answerFile:$f,answer:.,truncated:($c > 262144),waitedSec:$s}'
    return 0
  fi
  jq -nc --arg t "$tok" --arg f "$file" --argjson m "$matched" --argjson e "$ended" --argjson s "$(($(date +%s) - start))" \
    '{token:$t,delivered:true,matched:$m,answerFile:(if $f == "" then null else $f end),answer:null,ended:($e == 1),waitedSec:$s}'
  if [ "$matched" = true ]; then
    [ -z "$file" ] && return 0
    [ "$ended" = 1 ] && return 3
    return 4
  fi
  [ "$ended" = 1 ] && return 3
  return 2
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
    t=$("${CURL[@]}" "$API/api/v1/sessions/${1}/last-response" | jq -r '.data.text // empty')
    [ -n "$t" ] && [ "$t" != "$prev" ] && { printf '%s\n' "$t"; return 0; }
    sleep 1
  done
  [ -n "$t" ] && { printf '%s\n' "$t"; return 0; }
  return 1
}

# The stamp is the LAST line on purpose (a truncated write leaves it unset) and is kept
# bare on purpose: the write condition above anchors on it with $, so an inline comment
# here would fail that match and rewrite this file on every single bootstrap.
CODEMAN_PREAMBLE=1.51.0
