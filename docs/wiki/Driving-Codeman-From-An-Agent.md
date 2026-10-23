# Driving Codeman From An Agent

Everything the dashboard does is HTTP, so an agent can do it too. This page is for the case
that makes Codeman interesting: **Claude Code running inside a Codeman session, spawning and
supervising other sessions.**

Three routes. Start with the skill, whichever CLI the agent is. Where the skill does not
reach (a pi or shell session), use the `codeman agent` commands. Raw HTTP is there for
everything else.

## The agent skill

A skill in the `SKILL.md` format that Claude Code, Codex, Gemini CLI, OpenCode, Grok, OMP
and most other agent CLIs read. It teaches the agent the whole API, so you ask in plain
English instead of pasting endpoint documentation into prompts:

```bash
codeman skill install    # or: npx skills add Ark0N/Codeman --skill codeman -g
```

Then ask the agent in a Codeman session something like *"use codeman to start 5 claude
workers, one per TODO item"*. It starts the workers, hands each one its task, gathers the
answers and deletes the sessions it created.

**[The Codeman Skill](Codeman-Skill)** has the rest: recordings of real runs, every install
route (Claude Code plugin, skills CLI, per case, the web UI setting), prompts that work as
written, what it will and will not do on its own, and the notes for Codex. It drives
DeepSeek Harness workers the same way it drives Claude ones (`spawn_workers alpha
beta:deepseek` is a mixed fleet in one call), since those are the two modes with real
completion signals.

## The `codeman agent` commands

The skill drives the API with `curl` and `jq`. Where it does not reach (a pi or shell
session, a machine without `jq`), the agent runs in the same environment, so `codeman agent`
packages the same verbs as shell commands. It is a thin client over the endpoints in
[the manual path](#the-manual-path), so auth and ownership apply unchanged, and it refuses to
act outside a Codeman session. One line in a case's `AGENTS.md` is enough: *"other sessions:
`codeman agent --help`"*.

```bash
codeman agent ls                                          # sessions; * marks this one
SID=$(codeman agent spawn scratch-1 --mode claude)        # quick-start + wait for the composer where the mode has a ready mark
codeman agent send "$SID" 'review src/, then say DONE' --until stop,exit --timeout 300000
codeman agent read "$SID"                                 # last answer (as the server reads it for that mode)
codeman agent read "$SID" --tail 3000                     # terminal tail, ANSI stripped (every mode)
codeman agent inspect "$SID" --max-bytes 8192 --json     # recent evidence + opaque cursor (pane snapshots are labeled)
codeman agent stage "$SID" --message-file /tmp/prompt.txt --json  # no Enter; known local Codex composer only
codeman agent submit "$SID" --stage-id "$STAGE_ID" --confirm-sha "$SHA256" --json  # one conditional Enter
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

## The MCP server

`codeman mcp` is a [Model Context Protocol](https://modelcontextprotocol.io) server, so any MCP
client (Claude Code, Claude Desktop, Codex, Gemini CLI, Cursor) can drive Codeman, from
inside a Codeman session or from an assistant on your desktop. It is a client of the same
HTTP API, with seven tools: `list_sessions`, `start_session`, `send_prompt`,
`wait_for_session`, `read_output`, `interrupt_session` and `delete_session`.

```bash
# Claude Code
claude mcp add codeman -e CODEMAN_API_URL=https://127.0.0.1:3000 -- codeman mcp
```

```json
{
  "mcpServers": {
    "codeman": {
      "command": "codeman",
      "args": ["mcp"],
      "env": { "CODEMAN_API_URL": "https://127.0.0.1:3000" }
    }
  }
}
```

```toml
# Codex (~/.codex/config.toml): raise the 60 s default tool timeout for long waits
[mcp_servers.codeman]
command = "codeman"
args = ["mcp"]
env = { CODEMAN_API_URL = "https://127.0.0.1:3000" }
env_vars = ["CODEMAN_MUX", "CODEMAN_SESSION_ID"]  # Codex passes MCP servers a minimal env; these let it know the Codeman session it runs in
tool_timeout_sec = 120
```

The JSON form is what Claude Desktop, Cursor and Gemini CLI take. Add `CODEMAN_PASSWORD` to
`env` when the server has a password.

- **It never guesses a server.** Without `CODEMAN_API_URL` (or `--url`) every call says how
  to configure it.
- **Only its own sessions.** Prompting, interrupting and deleting are limited to sessions it
  started; listing, reading and waiting work on everything. `codeman mcp
  --allow-any-session` lifts that, for an assistant that should drive your existing tabs.
- **Waits are short by default** (45 s, at most 600 s), so they fit a client's tool
  timeout. A `timed_out` answer means call again.

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

1. **Input must end with `\r`.** Enter fires only when the payload contains a carriage
   return. Without it the text sits unsubmitted on the prompt, the request still succeeds,
   and a combined wait burns its full timeout on a turn that never started. With
   `useMux`, embedded newlines are kept: the text goes in as one paste and the Enter after
   it submits all of it, so `"echo A\necho B\r"` runs both commands in a shell. The check
   that re-presses a stranded Enter cannot reliably recognise a multi-line paste, so a
   long multi-line prompt to a just-started agent is still safer in a file it is told to
   read.
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
6. **Only `claude` and `deepseek` sessions emit `stop`; `blocked` also fires for `codex`.**
   Claude's come from Claude Code hooks, DeepSeek's from the harness reporting its state to
   Codeman, and Codex's `blocked` from Codeman reading its approval, question and trust
   dialogs off the screen (a wait that asks for `blocked` while such a dialog is already up
   answers at once). Shell and the other external CLIs accept only `idle`, `working`, and
   `exit`; asking for `stop` explicitly there (codex included) is a `400`, while omitting
   `until` is always safe. On a shell session
   `idle` fires **once at startup and never again**, so synchronize hook-less sessions with an
   output marker instead.
7. **Nothing reports "ready", so wait for it explicitly.** A new session answers
   `{"signal":"exit","immediate":true}` until its PID exists, and that means *not started*,
   not *crashed*. A Claude worker in a fresh case then sits on the CLI's trust dialog, whose
   highlighted option is `No, exit`: prompt it there and your Enter quits the CLI. Codeman
   holds `idle` while the dialog is on screen, but that is not a readiness signal either.

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

- [The Codeman Skill](Codeman-Skill) - the skill in action, its install routes and its limits.
- [HTTP API](HTTP-API) - the endpoint map and the envelope.
- [Hooks And Integrations](Hooks-And-Integrations) - events flowing the other way.
- [Watching Agents Work](Watching-Agents-Work) - seeing the fan-out in the UI.
- [`skills/codeman/SKILL.md`](https://github.com/Ark0N/Codeman/blob/master/skills/codeman/SKILL.md) - the skill itself.

Bounded inspection and guarded stage/submit details: [API reference](../api-reference.md#bounded-agent-inspection-and-guarded-input). Stage accepts one printable UTF8 line without trailing whitespace; receipts expire after two minutes. Submit refuses changed/unprovable composers and never automatically replays Enter. `send --no-enter` alone has no receipt.
