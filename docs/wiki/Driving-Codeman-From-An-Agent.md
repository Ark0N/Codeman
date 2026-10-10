# Driving Codeman From An Agent

Everything the dashboard does is HTTP, so an agent can do it too. This page is for the case
that makes Codeman interesting: **Claude Code running inside a Codeman session, spawning and
supervising other sessions.**

Three routes. In a Claude session, start with the skill. In any other CLI mode, use the
`codeman agent` commands. Raw HTTP is there for everything else.

## The agent skill

A Claude Code skill that teaches the agent the whole API, so you ask in plain English
instead of pasting endpoint documentation into prompts.

### Install it

| How          | Command                                                     | Scope                                                       |
| ------------ | ----------------------------------------------------------- | ----------------------------------------------------------- |
| Skills CLI   | `npx skills add Ark0N/Codeman --skill codeman -g`            | Global, any skills-aware agent.                              |
| Claude Code plugin | `/plugin marketplace add Ark0N/Codeman`, then `/plugin install codeman@codeman` | Global, through Claude Code's plugin manager. `/plugin update codeman` follows releases. Pick this or `codeman skill install`, not both, or the skill is listed twice (`codeman` and `codeman:codeman`). |
| Bundled CLI  | `codeman skill install`                                      | Global, at `~/.claude/skills/codeman`.                       |
| Bundled CLI  | `codeman skill install --case <name>`                        | One case.                                                    |
| Web UI       | **App Settings → Agents & CLIs → Claude → Agent Skill**      | Injects into each case when a Claude session is created. Off by default. |

`codeman skill uninstall [--case <name>]` reverses the CLI installs, and never touches a
`skills/codeman` you wrote yourself.

### Then just ask

| You say                                                                                 | What happens                                                                             |
| --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| "What sessions are running right now?"                                                   | Lists them with name, mode, and status. Read-only.                                          |
| "Start a shell worker on the `myapp` case, run the test suite, tell me if it passes."     | Spawns, waits on a completion marker, reads the exit code, cleans up.                       |
| "Spin up 3 workers for lint, typecheck and tests, run them in parallel, report failures." | One session per task, all started first, then gathered as each finishes.                    |
| "Have a claude worker summarize `src/session.ts`, then close it."                         | Spawns, runs the readiness ladder, sends and waits, reads the answer, deletes the session.  |
| "Watch session w4 and tell me if it gets stuck on a permission prompt."                   | Blocks on the `blocked` signal and surfaces the question to **you**.                        |

Sessions the agent creates get deleted when it is done. You can watch the tabs appear and
disappear in the dashboard while it works.

### What it will and will not do

- **It self-gates.** Outside a Codeman session it refuses to act and does not guess an API
  URL, so a global install costs an unrelated Claude Code session nothing.
- **Unprompted, it may only** spawn sessions, prompt them, and delete ones **it created in
  that conversation, by exact id**, behind a guard that refuses to delete the agent's own
  session.
- **It will not** answer another session's permission prompt on your behalf. It surfaces the
  question instead.
- **Deleting a case** (which erases a real directory of your code), bulk kills, respawn,
  Ralph, cron, orchestrator, and settings writes all require you to ask, naming the target.

Turning the setting back off **does not remove already-injected copies**, because a
create-time sweep would yank the skill out from under other live sessions sharing that
directory. Remove them per case with `codeman skill uninstall --case <name>`.

The skill ships with the verb index always loaded, plus on-demand references for the verbs,
worked multi-worker recipes, endpoint tables, and cross-session messaging. It drives
DeepSeek Harness workers the same way it drives Claude ones (`spawn_workers alpha
beta:deepseek` is a mixed fleet in one call), since those are the two modes with real
completion signals.

## The `codeman agent` commands

The skill is Claude-shaped: Codeman seeds its preamble for Claude sessions only. An
`opencode`, `codex`, `pi` or `gemini` agent runs in the same environment but has nothing
that teaches it the API, so `codeman agent` packages the same verbs as shell commands. It is
a thin client over the endpoints in [the manual path](#the-manual-path), so auth and
ownership apply unchanged, and it refuses to act outside a Codeman session. One line in a
case's `AGENTS.md` is enough: *"other sessions: `codeman agent --help`"*.

```bash
codeman agent ls                                          # sessions; * marks this one
SID=$(codeman agent spawn scratch-1 --mode claude)        # quick-start + wait for the composer where the mode has a ready mark
codeman agent send "$SID" 'review src/, then say DONE' --until stop,exit --timeout 300000
codeman agent read "$SID"                                 # last answer (as the server reads it for that mode)
codeman agent read "$SID" --tail 3000                     # terminal tail, ANSI stripped (every mode)
codeman agent send "$SID" 'run the tests, then print WORKDONE followed by _4711'   # hook-less modes: the marker in halves …
codeman agent wait "$SID" --match WORKDONE_4711           # … and the wait on the joined form
codeman agent interrupt "$SID"                            # a bare ESC, conversation intact
codeman agent rm "$SID"                                   # any session except this one
```

- **Ids** may be the 8-character form `ls` prints. Anything shorter refuses, and so does an
  ambiguous prefix.
- **`send`** takes ONE quoted argument of printable text and presses Enter. A prompt that
  starts with `-` goes after `--`: `codeman agent send "$SID" -- "- fix the bug"`.
- **Markers** follow [the split-marker trick](#the-split-marker-trick): the echo of your own
  prompt is output too, so ask for the marker in halves and wait on the joined form.
- **Exit codes** are the same for every verb: `0` done, `1` error, `2` timeout, `3` the
  worker exited, `4` refused. `--json` prints the response's `data`.

## The manual path

The same operations as raw HTTP, for a CI bot, a shell script, or an agent without skill
support.

### Detect that you are inside Codeman

These are set in every managed session. Read them rather than hardcoding anything:

| Variable                   | Meaning                                                                  |
| -------------------------- | ------------------------------------------------------------------------ |
| `CODEMAN_MUX=1`            | You are in a managed tmux session. Never `tmux kill-session`, `pkill claude`, or `pkill tmux`: you will kill yourself or a sibling. |
| `CODEMAN_API_URL`          | Base URL, with the correct scheme.                                        |
| `CODEMAN_SESSION_ID`       | Your own session id. Use it to avoid acting on yourself.                   |
| `CODEMAN_HOOK_SECRET_FILE` | Path to the hook secret.                                                   |

### Rules of the road

Read these before writing any code. Each one has cost somebody an afternoon.

1. **Input is single line and must end with `\r`.** Enter fires only when the payload
   contains a carriage return. Without it the text sits unsubmitted on the prompt, the
   request still succeeds, and a combined wait burns its full timeout on a turn that never
   started. Embedded newlines are stripped rather than rejected, so `"echo A\necho B\r"` runs
   the joined `echo Aecho B`. One line per call.
2. **Make input idempotent.** Send a stable `clientId` and a monotonic per-session `seq`. The
   server deduplicates, so a retry after a dropped connection cannot double-deliver.
3. **Auth.** With `CODEMAN_PASSWORD` set, use HTTP Basic or the session cookie. A missing
   `Origin` is allowed, so plain curl works. A `401` replies with the bare string
   `Unauthorized`, **not** the JSON envelope, so piping it into `jq` throws a parse error
   instead of showing the failure. Check the status before parsing.
4. **Envelope.** Most endpoints return `{ "success": true, "data": ... }`. A few legacy GETs
   return bare bodies, so handle both: `body.data ?? body`.
5. **Wait instead of polling, and a timeout is not an error.** The wait endpoints answer
   `200` with `wait.timedOut: true`. Loop over short waits rather than one long call, because
   tunnels cut idle connections.
6. **Only `claude` and `deepseek` sessions emit `stop` and `blocked`.** Claude's come from
   Claude Code hooks, DeepSeek's from the harness reporting its state to Codeman. Shell and
   the other external CLIs accept only `idle`, `working`, and `exit`; asking for `stop`
   explicitly there is a `400`, while omitting `until` is always safe. On a shell session
   `idle` fires **once at startup and never again**, so synchronize hook-less sessions with an
   output marker instead.
7. **Nothing reports "ready", so wait for it explicitly.** A new session answers
   `{"signal":"exit","immediate":true}` until its PID exists, and that means *not started*,
   not *crashed*. A Claude worker in a fresh case then sits on the CLI's trust dialog; prompt
   it there and the wait resolves on idle in about two seconds looking exactly like a finished
   turn, while your text sits stuck in the dialog.

### Recipes

```bash
API="${CODEMAN_API_URL:-http://localhost:3000}"
# Add -u admin:"$CODEMAN_PASSWORD" if a password is set, and -k on an HTTPS install.

# What is running
curl -s "$API/api/sessions" | jq '.data[] | {id, name, mode, status}'

# Spawn a worker in a case
curl -s -X POST "$API/api/quick-start" \
  -H 'Content-Type: application/json' \
  -d '{"caseName":"myapp","mode":"shell"}' | jq

# Send a prompt (note the \r)
curl -s -X POST "$API/api/sessions/$ID/input" \
  -H 'Content-Type: application/json' \
  -d '{"input":"run the tests\r","clientId":"my-agent","seq":1}' | jq

# Send and block until the turn finishes (registers the wait BEFORE writing)
curl -s -X POST "$API/api/sessions/$ID/input" \
  -H 'Content-Type: application/json' \
  -d '{"input":"summarize src/session.ts\r","wait":["stop"],"waitTimeout":120000}' | jq

# Or wait for a marker in the output, which works on shell sessions too
curl -s "$API/api/sessions/$ID/wait-output?contains=DONE_17909&from=buffer" | jq

# Read the last answer as clean text (claude, codex, deepseek sessions)
curl -s "$API/api/sessions/$ID/last-response" | jq -r '.data.text'

# Or read the terminal back
curl -s "$API/api/sessions/$ID/terminal?tail=4000" | jq -r '.data.output'

# Clean up, by exact id
curl -s -X DELETE "$API/api/sessions/$ID" | jq
```

Use `POST /api/quick-start` rather than `POST /api/sessions` when a case might be remote:
the plain create endpoint validates the working directory locally and has no case concept.

### The split-marker trick

For hook-less sessions, synchronize on a marker in the output. The catch: your own
keystrokes echo into the output stream, so an unsplit marker matches **before the command
has run**.

Split it so the typed line never contains the string you are waiting for:

```bash
M=DONE; R=17909
# typed: echo ${M}_${R}   →   output contains DONE_17909, the typed line does not
```

Make it unique per call, because tmux repaints replay old screen text.

### Reading output

For `claude`, `codex` and `deepseek` sessions, read the answer from the transcript rather
than the screen: `GET /api/sessions/:id/last-response` returns the last reply as clean text
with no TUI frames or repaint noise. Poll it briefly rather than reading once, because the
transcript lands slightly after the `stop` signal, so a read immediately after send-and-wait
returns often comes back empty.

For everything else, use `terminal?tail=`, not `/output`. The latter's text field is empty for every tmux-backed
session, which is every interactive session. `tail` counts **bytes**, and what comes back is
terminal data with ANSI sequences included.

## Fan-out, and why it needs care

Wait signals are **edge triggered with no history**. A signal that fires with no waiter
registered is unobservable afterwards.

So a fan-out must register its waits before or as it dispatches: use send-and-wait per
worker, or latched output markers. Dispatching all the workers and then waiting on them one
at a time loses the signals of everyone who finished early.

Send-and-wait registers the waiter **before** the write for the same reason. A separate POST
followed by a wait races, and reports the previous turn's state.

## Lineage

A create request can name the session that spawned it, through a body field or a header, and
the dashboard then draws a lineage line from parent to child. The skill sets it automatically.

It is resolved rather than trusted: an unresolvable parent is dropped silently rather than
failing the spawn, because a cosmetic field must never break a worker.

## Read next

- [HTTP API](HTTP-API) - the endpoint map and the envelope.
- [Hooks And Integrations](Hooks-And-Integrations) - events flowing the other way.
- [Watching Agents Work](Watching-Agents-Work) - seeing the fan-out in the UI.
- [`skills/codeman/SKILL.md`](https://github.com/Ark0N/Codeman/blob/master/skills/codeman/SKILL.md) - the skill itself.
