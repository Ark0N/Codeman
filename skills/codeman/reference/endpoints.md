# Codeman API reference for agents

Loaded on demand from the `codeman` skill. Assumes the guard variables from
[SKILL.md](../SKILL.md) (`$API`, `$SELF`, `"${CURL[@]}"`). Canonical contract:
`docs/api-reference.md` in the Codeman repo; this file is the agent-relevant subset,
verified live.

Four sections:

- [Auth and credentials](#auth-and-credentials) - when the server wants a password and
  where to find one.
- [Symptom gallery](#symptom-gallery) - a response you did not expect, what it means,
  what to do. Start here when something looks broken.
- [Endpoint tables](#endpoint-tables) - everything you can call, with the traps.
- [Limits and caps](#limits-and-caps) - every number the server will enforce on you.

## Auth and credentials

**When auth is on at all.** In single-user mode the server authenticates only if its
process has `CODEMAN_PASSWORD` set; with no password `registerAuthMiddleware` returns
before installing the hook (`middleware/auth.ts:232`) and every route is open, so `-u`
is unnecessary. In multi-user mode (`--multiuser`) auth is **always** active even
without `CODEMAN_PASSWORD`, and the credential is then a real user's name and password,
not a shared one. The username defaults to `admin` (`CODEMAN_USERNAME`).

**Use Basic, not the cookie.** Send `-u user:password` on every call. A successful
Basic auth also mints a 24 h `codeman_session` cookie, but that is the browser's path:
curl throws it away unless you keep a jar, and re-sending Basic costs nothing. There is
no bearer token and no login endpoint for session control. The hook-secret bypass
(`X-Codeman-Hook-Secret`) covers `POST /api/hook-event` and `POST /api/status-telemetry`
only and can never drive a session.

**The 401 is plain text.** It is the literal body `Unauthorized` with a
`WWW-Authenticate: Basic realm="Codeman"` header, not the JSON envelope, so `jq` dies
with a parse error and `.errorCode` is simply absent (see
[symptom 6](#6-jq-parse-error-instead-of-an-errorcode)). Ten failed attempts from one
IP then get a plain-text `429 Too Many Requests` with `Retry-After`, decaying over 15
minutes (`AUTH_FAILURE_MAX` = 10, `AUTH_FAILURE_WINDOW_MS` = 15 min). **Never retry a
failing credential in a loop**: you will lock the address out of the login path for
everything, including the user's browser through a tunnel (tunneled traffic arrives as
127.0.0.1, so one bucket covers it all).

**Where the password is, in order.**

1. **`$CODEMAN_PASSWORD` in your own environment. Check this first.** A session
   inherits it whenever the server has it: `buildClaudeEnv()`
   (`session-cli-builder.ts:167-189`) spawns with `...process.env` and deletes only
   `COLORTERM` and `CLAUDECODE`. Nothing strips the password. (On the tmux path it
   arrives by tmux-server inheritance rather than an explicit export:
   `buildEnvExports()` in `tmux-manager.ts:1603` never names it, so a tmux server that
   outlived the Codeman process which had the password can leave a pane without it.
   That is what the fallbacks below are for.)
2. **The data dir's `.env`**, the same fallback the `codeman attach` CLI uses. It is
   hand-authored; nothing ever writes it. Locate the data dir from
   `$CODEMAN_HOOK_SECRET_FILE`, which is always exported. Values may be quoted or
   `export`-prefixed.
3. **The supervisor definition**, which is where a stock password-protected
   `install.sh` actually keeps it (systemd user unit on Linux, LaunchAgent plist on
   macOS). ⚠️ Both are **escaped on write, so they must be unescaped on read** or a
   password containing the escaped characters recovers wrong and auth fails with no
   hint that the value was mangled:

   | Where | install.sh escapes | You must unescape |
   |-------|--------------------|-------------------|
   | systemd unit `Environment="CODEMAN_PASSWORD=…"` | `sed 's/[\\"]/\\&/g'` (backslash-escapes `"` and `\`) | `sed 's/\\\(["\\]\)/\1/g'` |
   | launchd plist `<string>…</string>` | `&` → `&amp;`, `<` → `&lt;`, `>` → `&gt;` (in that order) | `&lt;`, `&gt;`, then **`&amp;` LAST** |

   The `&amp;` ordering is not cosmetic: unescaping `&amp;` first turns a stored
   `&amp;lt;` back into `<`, silently corrupting any password containing `&`.

   ⚠️ `install.sh` writes the password into the unit **only on the LAN binding path**
   (the block is inside `if [[ -n "$BIND_HOST" ]]`), and the `codeman service install`
   CLI never writes it at all. A loopback/Tailscale install with a password set some
   other way has nothing to recover here.

4. **Nothing found: stop and ask the user.** Do not guess, and do not brute-force the
   rate limiter.

```bash
# 2 and 3, in order. Runs only when $CODEMAN_PASSWORD is empty.
ENV_FILE="${CODEMAN_HOOK_SECRET_FILE:+${CODEMAN_HOOK_SECRET_FILE%hook-secret}.env}"
envval() { sed -n "s/^\(export \)\{0,1\}$1=//p" "$ENV_FILE" | tail -1 | sed 's/^"\(.*\)"$/\1/; s/^'\''\(.*\)'\''$/\1/'; }
if [ -z "${CODEMAN_PASSWORD:-}" ] && [ -n "$ENV_FILE" ] && [ -f "$ENV_FILE" ]; then
  CODEMAN_USERNAME=$(envval CODEMAN_USERNAME)
  CODEMAN_PASSWORD=$(envval CODEMAN_PASSWORD)
fi
if [ -z "${CODEMAN_PASSWORD:-}" ]; then
  UNIT="$HOME/.config/systemd/user/codeman-web.service"
  PLIST="$HOME/Library/LaunchAgents/com.codeman.web.plist"
  if [ -f "$UNIT" ]; then
    CODEMAN_PASSWORD=$(sed -n 's/^Environment="CODEMAN_PASSWORD=\(.*\)"$/\1/p' "$UNIT" | head -1 | sed 's/\\\(["\\]\)/\1/g')
  elif [ -f "$PLIST" ]; then
    CODEMAN_PASSWORD=$(awk '/<key>CODEMAN_PASSWORD<\/key>/{getline; print}' "$PLIST" | sed -n 's/.*<string>\(.*\)<\/string>.*/\1/p' \
      | sed -e 's/&lt;/</g' -e 's/&gt;/>/g' -e 's/&amp;/\&/g')
  fi
fi
AUTH=(); [ -n "${CODEMAN_PASSWORD:-}" ] && AUTH=(-u "${CODEMAN_USERNAME:-admin}:$CODEMAN_PASSWORD")
CURL=(curl -sk "${AUTH[@]}")   # -k: harmless on http, required on https (self-signed cert)
```

A recovered password is a **secret you were handed to make calls with**. Never echo it,
never write it into a file, never put it in a prompt you send to another session, and
never include it in a report.

## Envelope and errors

Every JSON response: `{"success":true,"data":…}` or
`{"success":false,"error":"…","errorCode":"…"}`. Branch on `errorCode`:

| `errorCode` | HTTP | Meaning |
|-------------|------|---------|
| `INVALID_INPUT` | 400 | malformed request; the message names the bad field |
| `UNAUTHORIZED` | 401 | auth required or failed (send `-u user:password`). ⚠️ The 401 body is plain text, NOT this envelope, see [Auth and credentials](#auth-and-credentials) |
| `FORBIDDEN` | 403 | authenticated but not permitted: an admin-only route in multi-user mode, a `workingDir`/case path outside your own workspace, or a shell session without the can-bypass-permissions grant. ⚠️ **Not** what an ownership miss on a session returns: a session you do not own answers 404 `NOT_FOUND`, identically to one that does not exist (deliberate, it leaks no existence) |
| `NOT_FOUND` | 404 | no such session, or one this caller does not own. Also quick-start's answer for an unknown remote or docker host |
| `SESSION_BUSY` | 409 | on a **wait**: this session's waiter cap (16, combined signal+output) is full. On **quick-start**: a session cap is full, so clean up before starting more. Two different caps can raise it: the global 50 (`MAX_CONCURRENT_SESSIONS`), and in multi-user mode the per-user cap, which defaults to half of that, **25** (`maxSessionsPerUser()`, `config/multiuser.ts:59-63`). The message tells you which |
| `CONFLICT` / `ALREADY_EXISTS` | 409 | conflicts with current state |
| `OPERATION_FAILED` | 422 | well-formed but could not be completed |
| `RATE_LIMITED` | 429 | per-owner or process-wide waiter pool is full; back off, switching sessions will not help |
| `INTERNAL_ERROR` | 500 | server bug |

`SESSION_BUSY` vs `RATE_LIMITED` on the wait endpoints is deliberate: the first means
"too many waiters on *this* session", the second means the *pool* is full.

⚠️ **The guards that run before any handler answer in PLAIN TEXT, not this envelope**,
so `jq` reports a parse error and `.errorCode` is simply absent. All of them:
`401 Unauthorized` (Basic auth, carries `WWW-Authenticate`), `401 Unauthorized: hook
secret required`, `403 Forbidden: host not allowed` (Host allowlist), `403 Forbidden:
cross-site request blocked` (Origin/CSRF guard), the auth rate limiter's
`429 Too Many Requests` (with `Retry-After`; distinct from the JSON `RATE_LIMITED`
above, which is the waiter pool), and `503 Too many SSE connections` on `/api/events`.
When a call returns something `jq` cannot parse, read the status with
`-w '%{http_code}'` and the raw body before assuming a bug.

## Symptom gallery

Eight responses that look like a bug and are not. Each one: what you see, what it
means, what to do.

### 1. `delivered:true`, then every wait times out

**You see** `{"delivered":true,"duplicate":false,"wait":{"timedOut":true,"signal":null}}`,
and every later wait on that session times out too while the worker sits there looking
idle.

**It means** the input had no `\r`, so Enter was never sent. `delivered:true` means
"written to the pane", never "submitted": your text is parked on the worker's composer,
no turn ever started, and there is no signal for a wait to catch. No response field
catches this, which is why it is the number-one silent failure.

**Fix** Submit it: `POST .../input` with `{"input":"\r"}` and a fresh `seq`. That is
the **only** recovery (verified live: Ctrl+U (0x15) and Esc do NOT clear the composer).
Read `terminal?tail=2000` first to confirm the prompt is really sitting on the `❯` line.
⚠️ The flush costs the worker a **billed turn** in which it reasons about the stray
line, so open the next real prompt with "ignore the garbled line above:".

### 2. `.data.delivered` is `null`

**You see** `.data.delivered` reads `null`, and `.data` itself is `{}`.

**It means** you sent fire-and-forget (no `wait` field in the body). `delivered` and
`duplicate` exist **only** on the send-and-wait variant; the plain path answers an empty
`{"success":true,"data":{}}`. `null` here says the field does not exist, not that
delivery failed.

**Fix** Stop probing a field the response does not carry. Either add `"wait":true` so
the same call reports delivery, or confirm out of band with a `wait-output` marker
(`from=buffer`, unique token). Fire-and-forget gets no delivery confirmation at all.

### 3. `{"ended":true}` on a session that still exists

**You see** `{"delivered":false,"duplicate":false,"wait":{"ended":true,"aborted":false,"signal":null}}`,
while `GET /api/v1/sessions/:id` happily returns the session.

**It means** the write did not land. tmux `send-keys` succeeds against a dead pane, so
the route probes the pane and rewrites `delivered` to false when the worker inside it is
gone (`session-routes.ts:1284-1293`). Nothing was written, so no turn is coming: the
server releases its own waiter immediately rather than making you burn the timeout,
which is what sets `ended:true`, and it rewrites `aborted` back to `false` because you
are still reading the response. The session object outliving the worker is normal, and
so is its pid: that pid is the local tmux attach client, not the agent.

**Fix** **Read `delivered`; it is the discriminator.** `delivered:false` +
`duplicate:false` means restart the worker, nothing was typed (and the `seq` was
un-recorded, so resending the same `clientId`+`seq` against a restarted worker is safe
and will not be refused as a duplicate). Only on the two GET wait routes, which carry no
`delivered` field, does `ended:true` mean what it sounds like: the session was torn down
mid-wait or the server is shutting down. Stop looping there.

### 4. `matched:false` and the response echoes `match:"shift tab"`

**You see** a wait-output for `shift+tab` returning `{"matched":false,"match":"shift tab"}`.

**It means** you hand-built the query string. In a URL query `+` decodes to a space, so
the server searched for the literal `shift tab`, which appears in no statusline. The
echoed-back `match` is how you spot it.

**Fix** Build every wait-output query with `-G --data-urlencode 'match=shift+tab'`. Same
trap for any marker containing `+`, `&`, `%`, `#` or a space.

### 5. A marker matched instantly, before the command ran

**You see** `wait.matched:true` within milliseconds, and `wait.snippet` shows your own
command line rather than its output.

**It means** your keystrokes are output too. A marker that appears verbatim in the line
you typed matches the moment it is typed.

**Fix** Split the marker so the typed line never contains it: send
`M=DONE; …; echo ${M}_1234\r` and wait on `DONE_1234`. Same symptom, second cause: a
generic marker (`BUILD OK`) matched against stale text, either from `from=buffer`
scanning an earlier run or from tmux replaying old screen content as fresh output on an
attach/resize/redraw. A unique-per-call token (`DONE_$RANDOM`) makes both `from` modes
safe.

### 6. `jq` parse error instead of an `errorCode`

**You see** `jq: parse error: Invalid numeric literal…` on every call, no `errorCode`
anywhere.

**It means** the response is not the envelope. The guards that run before any handler
answer in plain text (full list under [Envelope and errors](#envelope-and-errors)): 401
Basic auth, 401 hook secret, 403 host not allowed, 403 cross-site blocked, 429 auth rate
limit, 503 too many SSE connections.

**Fix** Re-run the call with `-w '\n%{http_code}\n'` and no `jq`, then read the status
and the raw body. 401 sends you to [Auth and credentials](#auth-and-credentials); 403
means a Host/Origin problem, not a bug in your request; 429 means back off for up to 15
minutes, never retry the credential.

### 7. `last-response` returns an empty string right after `stop`

**You see** `.data.text` is `""` on a claude worker whose send-and-wait just returned
`signal:"stop"`.

**It means** usually nothing is wrong. `text` is read from the transcript file, which is
flushed slightly *after* the `stop` hook fires, so a read taken the instant the wait
returns is too early (verified live: empty on the first call, full prose seconds later).
It is also `""` before the worker's first completed turn, and permanently `""` for
`shell`, `opencode`, `gemini`, `antigravity`, `pi`, `grok` and `omp`, which write no transcript at
all. `deepseek` is NOT one of those — it is read from `$DSH_HOME/sessions/**` and lags
for the same reason claude does (the harness finalizes the assistant message just after
it reports `idle`), so poll it the same way.

**Fix** Poll it, bounded (10 tries, 1 s apart). If it is still empty on a hook-less mode,
that is expected, not a failure: read `terminal?tail=` and strip ANSI instead.

### 8. Send-and-wait resolves instantly with `signal:"idle"`, and the answer is last turn's

**You see** a claude worker's send-and-wait coming back suspiciously fast with
`wait.signal:"idle"`, and `last-response` then returns text that answers your
**previous** prompt.

**It means** that session has no Codeman hooks, so `stop` can never fire and the wait
silently degraded to `idle`, which flaps mid-turn. Nothing rejected your request:
`wait:true` (and even an explicit `until=stop`) is accepted because the 400 is about
session **mode**, and the mode really is `claude`. Hooks are installed into every
claude workspace at session create (synced `workspaceHooksEnabled`, default ON) and
swept across recovered sessions at boot, so a linked case or a raw `workingDir` gets
them too; with the setting off, on a remote session, or on a session from an older
server, they are absent, see the table under
[Signals by mode](#signals-by-mode). Measured before that changed: on a
linked case whose `.claude/settings.local.json` carries env/model/permissions/statusLine
and no `hooks` block, a `wait?until=stop,exit` parked for twelve consecutive 60 s rounds
never resolved although the worker finished its turn.

**Fix** Check before you rely on `stop`: read `<workingDir>/.claude/settings.local.json`
and look for a `hooks` key whose contents mention `/api/hook-event`. No hooks means
synchronize with a split `wait-output` marker instead (entry 5 has the shape), exactly
as you would for a shell worker. To get hooks, spawn into a case Codeman creates rather
than into an existing checkout.

## Endpoint tables

### Sessions

| Task | Call |
|------|------|
| list sessions (metadata only, ~1.5 KB each, safe to poll) | `GET /api/v1/sessions` |
| one session (has `.data.pid`, `null` until the PTY spawns) | `GET /api/v1/sessions/:id`, ⚠️ **neither a liveness nor a busy check**, see below |
| unified list incl. history | `GET /api/v1/sessions/unified` → `.data.sessions[]` (NOT `.data[]`), and it folds in transcript history from the whole machine, never use it to verify cleanup; `GET /api/v1/sessions` is the cleanup check |
| start case + session in one call | `POST /api/v1/quick-start` |
| create a session in an arbitrary directory (no case, **no PTY**, id at `.data.session.id`) | `POST /api/v1/sessions`, then `POST /api/v1/sessions/:id/interactive` or `.../shell` to start it, see [Starting a worker](#starting-a-worker) |
| send input | `POST /api/v1/sessions/:id/input` |
| **read a worker's answer** (claude/codex/deepseek) | `GET /api/v1/sessions/:id/last-response` → `.data.{text,timestamp}`, clean transcript text, no TUI noise. ⚠️ **Poll it**, see [symptom 7](#7-last-response-returns-an-empty-string-right-after-stop) |
| read the whole conversation | `GET /api/v1/sessions/:id/last-response?context=full` → `.data.messages[]`. ⚠️ **Only `{role,text}` is present for every mode.** `kind`/`label` come from claude (`prompt`/`response`), deepseek and the pane parser (which also emit `status`/`tool`) but NOT from codex; `timestamp` from claude and codex but not deepseek/pane; `turn` and `queued:true` (a prompt typed while the agent was working) from claude only. `.data.text` is unchanged by `context=full` — it stays the last assistant message, never `messages[-1]` |
| read the last **answered turn** (claude only) | `GET /api/v1/sessions/:id/last-response?context=turn` → `.data.messages[]` holds every assistant message of the most recent turn that has one (the whole answer, not just its final row); `.data.text` is still the last assistant row. Other modes answer `text` only, with no `messages` |
| read terminal (tail is in **BYTES**, raw ANSI) | `GET /api/v1/sessions/:id/terminal?tail=3000` → `.data.terminalBuffer`, for *diagnosis* (unsubmitted prompt?), not for reading answers |
| full tmux scrollback (context bomb; post-mortems only) | `GET /api/v1/sessions/:id/terminal?full=1` |
| background agents, one session | `GET /api/v1/sessions/:id/subagents` |
| background agents, global list | `GET /api/v1/subagents` (admin-only in multi-user mode) |
| the case's intent profile (Read My Mind: user goals + recent real prompts) | `GET /api/v1/sessions/:id/intent` → `.data.intent.{goals,recentPrompts}` (empty with `updatedAt: 0` until something is recorded) |
| replace the user-goals text on the case's intent profile | `PUT /api/v1/sessions/:id/intent` body `{"goals":"…"}` (≤ 8192 chars, strict schema; REPLACES the text, read + merge first) |
| forget the case's intent profile (only when the user asks) | `DELETE /api/v1/sessions/:id/intent` → `.data.deleted` |
| predict the user's next prompt (Read My Mind; claude-mode only, 5-90 s, costs real tokens) | `POST /api/v1/sessions/:id/readmymind` body `{}` (rethink: `{"steer":"…","rejected":["…"]}`) → `.data.suggestions[].{prompt,why,kind}`, suggestions are PROPOSALS; never send one to a session unless the user asked. 409 = one already running; 400 = non-claude mode |
| server status / version | `GET /api/v1/status` → `.data.version` |
| delete one session (yours only, via `delete_session`) | `DELETE /api/v1/sessions/:id`, never call it bare; the fail-closed helper in SKILL.md is the only self-protection that exists. Answers `{"success":true,"data":{}}`: an **empty** body is the success signal, there is nothing to read back |

`DELETE /api/v1/sessions/:id` takes one undocumented query parameter, `killMux`, and
it defaults to `true` (anything other than the exact string `false` means kill). With
`?killMux=false` the call **detaches instead of killing**: the tmux session and the
agent inside it keep running, the session drops out of `GET /api/v1/sessions` so it
looks deleted, and it is deliberately left in persisted state for recovery (the
lifecycle log records `detached`, not `deleted`). That is the wrong tool for agent
cleanup: your worker keeps burning tokens where neither you nor the user can see it,
and the list you would check to confirm cleanup shows it gone. Delete plainly, and let
`killMux` default.

⚠️ **`.data.status` is a heuristic and is often simply wrong. Never branch on it.**
Measured on a live claude worker: `status` read `idle` while the worker was mid-turn
and actively producing output, with `lastActivityAt` equal to the moment of the call.
It is wrong in both directions, so neither value tells you anything you can act on:

- **`idle` does not mean finished.** Use `stop` (the definitive end-of-turn hook) via
  send-and-wait, or an output marker. If you must judge from outside, sample
  `terminal?tail=` twice a few seconds apart and compare: a changing buffer is the
  only cheap positive proof that a worker is still working. The structured
  alternatives are [active-tools and run-summary](#is-it-stuck-structured-signals).
- **`idle` does not mean alive.** A worker that dies inside its pane keeps
  `status:"idle"` and a pid (that pid is the local tmux attach client, not the
  worker). `wait?until=exit` is the death check.

Treat `status` as a UI hint. Every synchronization decision in these recipes is built
on signals and markers for exactly this reason.

⚠️ `GET /api/v1/sessions/:id/output` → `.data.textOutput` looks like the obvious read
but stays **empty for interactive tmux-backed sessions** (it is fed only by the legacy
JSON-stream path). Verified empty on live claude and shell sessions. Use
`last-response` for claude/codex/deepseek answers; only fall back to `terminal?tail=` for
hook-less modes, or to diagnose a prompt that was never submitted, and strip ANSI:

```bash
# `\x1b` is a GNU-sed extension. BSD sed (macOS, the default there) reads it as a
# literal "x1b", matches nothing, and hands back raw ANSI, silently. Feed sed a real
# ESC byte instead; that form works on GNU and BSD alike.
ESC=$(printf '\033')
… | jq -r '.data.terminalBuffer' | sed -e "s/${ESC}\[[0-9;?]*[a-zA-Z]//g" -e "s/${ESC}([B0]//g"
```

### Starting a worker

`POST /api/v1/quick-start` body (all optional):
`{"caseName":"worker-1","mode":"claude","sessionName":"w9-worker","effort":"high"}`
,  `mode` ∈ `claude|shell|opencode|codex|gemini|antigravity|pi|grok|deepseek|omp`; response is
`.data.{sessionId, caseName, casePath}`. Creates the case directory (a real directory
on the user's disk) if missing, do not retry it in a loop, and remember the name.

⚠️ A `mode` whose CLI is **not installed on the server** fails the spawn with
`OPERATION_FAILED`; it never falls back to claude. Probe first whenever you did not pick
the mode yourself: `GET /api/v1/claude/status`, `GET /api/v1/opencode/status`,
`GET /api/v1/codex/status`, `GET /api/v1/gemini/status`, `GET /api/v1/antigravity/status`, `GET /api/v1/grok/status`, `GET /api/v1/deepseek/status`,
`GET /api/v1/pi/status` and `GET /api/v1/omp/status` each return `.data.{available, path}` (no session needed).
Pi's, grok's and OMP's also carry `.data.version`, because `pi` is a short generic name,
`grok` is a name with npm squatters, and `omp` is a similarly short name, so an unrelated
binary on `$PATH` can shadow any of them: the resolver rejects one whose `--version` is
not version-shaped, so `available:false` there can mean "a different program of the same
name is in front" rather than "nothing is installed". `shell` has no CLI to probe.

⚠️ **Branch on `.success` before reading `.data.sessionId`.** On any failure the field
is absent, `jq -r` prints the literal string `null`, and every later call then targets
`/api/v1/sessions/null`, burning the full readiness budget and reporting jq noise
instead of the real cause. The failure codes here are `SESSION_BUSY` (a **session** cap:
the global 50, or the per-user 25 in multi-user mode, never the waiter cap),
`NOT_FOUND` (an unknown remote host or docker host named by the case), `FORBIDDEN`,
`CONFLICT`, `OPERATION_FAILED` and `INVALID_INPUT`. None of them are retryable in a
loop.

⚠️ A case directory quick-start **creates** for you is labelled agent-created (a
`.codeman-agent-case.json` marker, written because the §0 preamble sends
`X-Codeman-Agent-Origin`), which is what lets the user find it afterwards:
`GET /api/v1/cases/agent-created` returns `.data.cases[]` of
`{name, path, createdAt, createdBy, parentSessionId, inUse, modifiedAt}`, newest first,
read-only, scoped to the caller's own case space. Report it when you finish; deleting is
`DELETE /api/v1/cases/:name` and is the user's call by name ([§5.14](verbs.md#514-clean-up)).
A directory that already existed is never labelled.

⚠️ `caseName` resolves through the linked-cases registry first, so a name that happens
to match a case the user linked in lands in that **real repo**, not a fresh scratch
directory. Pick distinctive scratch names, and use a linked name deliberately when you
do want a worker in an existing checkout. It no longer decides whether you get hooks:
every claude create path installs them, so a linked case and a raw path both get a
`stop` signal unless the operator turned `workspaceHooksEnabled` off
([Signals by mode](#signals-by-mode)).

**The two-step alternative, `POST /api/v1/sessions`.** Use it when you need a session in
a directory that is not a case (body takes `workingDir`, `mode`, `name`, `effort`,
`envOverrides`). Three differences that break copied code:

- The id is at **`.data.session.id`**, not quick-start's `.data.sessionId`
  (`session-routes.ts:878` returns `{ session: lightState }`).
- **It spawns no PTY.** The session exists with `pid:null` and nothing running, so
  `wait?until=exit` answers `exit` immediately. Follow it with
  `POST /api/v1/sessions/:id/interactive` (claude and the other agent CLIs) or
  `POST /api/v1/sessions/:id/shell` (shell mode) to actually start the worker.
- Its capacity failure is **`OPERATION_FAILED` (422)**, not quick-start's
  `SESSION_BUSY` (409), from the same global-50 / per-user-25 caps
  (`session-routes.ts:648`).

⚠️ `POST .../interactive` accepts `{"clearBreaker":true}`, which resets the **PTY-exit
circuit breaker**. That breaker exists to stop a session that keeps crashing on spawn
from being restarted forever, so clearing it re-arms a crash loop. Treat it like the
respawn mutations: **only when the user explicitly asks**. Auto-restart and reattach
callers send no body at all.

### Input

`POST /api/v1/sessions/:id/input` body:
`{"input":"one line\r","useMux":true,"clientId":"agent-1","seq":1}` plus optionally
`"wait"` / `"waitTimeout"` ([below](#the-wait-primitives)).

- ⚠️ **The input must contain `\r`** (the JSON escape, i.e. a real carriage return)
  **or Enter is never sent**: the text is typed onto the worker's prompt and sits
  there unsubmitted. This is [symptom 1](#1-deliveredtrue-then-every-wait-times-out),
  the number-one silent failure.
- `input` must be single-line (newlines are stripped). To send a bare Enter (confirm
  a dialog), send `{"input":"\r"}`.
- `input` is capped at **65536** characters. ⚠️ **Two caps disagree and the smaller one
  is the real one**: the Zod schema allows 100000 (`schemas.ts:1035`), so a 65537-to-100000
  character body passes validation and *then* 400s at the route against
  `MAX_INPUT_LENGTH` = `64 * 1024` (`session-routes.ts:1158`, `config/terminal-limits.ts:12`).
  The error message says "bytes" but the check counts JS string length, so it is really
  characters. Either way **nothing is typed** on rejection; it is not a truncation.
  Since the value is one line anyway, a prompt that big means you are pasting a file
  into the composer: write it to disk in the worker's case directory and send a path
  instead. `clientId` is capped at 128 characters on the same terms.
- `clientId`+`seq` give exactly-once delivery: the server applies each pair at most
  once. Increment `seq` per new input.

### Interrupting a runaway worker

You do not have to delete a worker that is off in the weeds. Esc interrupts the current
turn and leaves the conversation intact.

| Task | Call |
|------|------|
| interrupt the current turn (claude) | `POST /api/v1/sessions/:id/input` with `{"input":"\u001b","useMux":true,"clientId":"…","seq":N}` |

`\u001b` is the JSON escape for the ESC byte (`\x1b` is **not** valid JSON and the body
will 400). It survives to the pane because `sendInput` strips only `\r` and `\n` and
then `trimEnd()`s (`tmux-manager.ts:2975`, second copy at `:3132`), and `0x1b` is not JS
whitespace, so an Esc-only body takes the text-without-Enter branch and reaches
`send-keys -l` intact. In-repo proof: the Approvals deny path sends exactly `'\x1b'`
this way (`approval-routes.ts:43`).

- **Send it alone, with no `\r`.** Esc is a keypress, not a line.
- ⚠️ **`POST /api/sessions/:id/send-key` is NOT this endpoint.** Its allowlist is
  exactly `S-Enter` and `C-Enter`, both mapping to hex `0a`
  (`session-routes.ts:1490-1499`); anything else is a 400 `INVALID_INPUT: Key not
  allowed`. There is no named `Escape` key.
- ⚠️ **One Esc does not always land** (observed, not guaranteed by this API: what Esc
  does after it reaches the pane is claude's own behavior, not Codeman's). An
  interrupted claude may need a second one, so
  **read `terminal?tail=2000` after** rather than assuming, and confirm the composer is
  clean before sending the next real prompt.
- The interrupted turn is still billed for the work it already did. Interrupt is
  cheaper than respawn, which runs `/clear` and destroys the conversation.

### Is it stuck? structured signals

Two reads that answer "is this worker actually doing something" without parsing a
screen.

| Task | Call |
|------|------|
| what bash commands the worker is running right now | `GET /api/v1/sessions/:id/active-tools` → `.data.tools[]`, each `{id, command, filePaths, timeout?, startedAt, status, sessionId}` (`types/tools.ts:30-45`); `timeout` is optional, present only when claude printed one |
| a timeline of what has happened in this session | `GET /api/v1/sessions/:id/run-summary` → **`.summary`** |

Quirks that will bite you:

- ⚠️ **`run-summary` IS enveloped: read `.data.summary`.** The handler returns a bare
  `{summary}` (`session-routes.ts:997-1012`), but a global `preSerialization` hook
  (`server.ts:696-711`) wraps every `/api/*` object payload that lacks a `success` key
  into `{success:true,data:payload}`, so the wire shape is
  `{"success":true,"data":{"summary":{…}}}`. Reading `.summary` off the top level gets
  you `undefined`. (The same hook is why the delete route's `return {}` reaches you as
  `{"success":true,"data":{}}`.) A missing tracker is created on the fly, so a fresh
  session answers with an empty timeline rather than a 404.
- ⚠️ **`active-tools` proves presence, never absence.** It is fed by the BashToolParser,
  which reads Claude's rendered `● Bash(…)` lines, and `_processExpensiveParsers`
  returns early for every external CLI mode (`session.ts:~2225`), so it is permanently
  `[]` on `opencode`/`codex`/`gemini`/`antigravity`/`pi`/`grok`/`deepseek`/`omp`. ⚠️ **`shell` is NOT one of those**
  (`isExternalCliMode`, `session.ts:176-187`, lists only those seven), so the parser does
  run on a shell worker, and `TEXT_COMMAND_PATTERN` (`bash-tool-parser.ts:89`) matches
  bare `tail|cat|head|less|grep|watch|multitail <path>` lines with no `● Bash(` wrapper:
  a shell worker running `cat build.log` really does populate this. In practice it stays
  empty for most shell work. It also never sees non-Bash
  tools: a claude worker deep in Read/Edit/Task/WebFetch shows an empty list while
  working hard. Capped at 20 entries. A **non-empty** list is solid proof of life; an
  empty one means nothing.
- `.summary.events[]` are `{id, timestamp, type, severity, title, details?, metadata?}`
  (`types/run-summary.ts:50-65`). ⚠️ The prose fields are **`title`** and **`details`**,
  not `message`/`detail`: a gather doing `.[].message` gets `null` for every event and
  reads as an empty timeline. `.summary.stats` carries token totals, active/idle
  milliseconds and `errorCount`/`warningCount`.
- **The server already computes stuck-ness.** After 10 minutes in one state with no
  change it appends one event `type:"state_stuck"`, `severity:"warning"`,
  `details:"In state for N+ minutes"` (`run-summary.ts:37`, `:394-405`). ⚠️ Two limits:
  it is latched **per state**, not per session (`stateStuckWarned` is reset to `false` on
  every state change, `run-summary.ts:152`), so it fires at most once per state but can
  fire repeatedly across a session, and its presence is not proof of a *current* stall;
  and the "state" it watches is the
  **respawn state machine's**, fed only by `RespawnController` transitions
  (`respawn-event-wiring.ts:58`), so a plain worker with no respawn attached records no
  state and can never warn. Absence is never evidence of health.

### Usage limits

| Task | Call |
|------|------|
| arm auto-resume on a usage-limit pause | `POST /api/v1/sessions/:id/auto-resume` body `{"enabled":true}` → `.data.autoResume.{enabled,resumeAt}` |

When a claude worker hits a subscription usage limit it stops mid-run and every wait on
it times out. The tell is `.data.limitPaused:true`, which rides along on every wait
result: a timeout is then *expected*, so do not retry hard and do not kill the worker.
Arming auto-resume makes Codeman parse the reset time out of the worker's own message
and send Esc + `continue` about two minutes after reset, keeping the conversation.

- Arming it **after** the pause still works: `setAutoResume(true)` re-scans the last
  8 KB of the terminal buffer once and arms only if the parsed reset time is still in
  the future (`session.ts:1079-1091`). If the limit footer has already scrolled out of
  that window, nothing arms and the call reports `resumeAt` absent.
- ⚠️ **Respawn and Ralph are NOT the workaround.** A respawn cycle runs `/clear`, which
  wipes the conversation you were waiting on. The server blocks respawn cycles while a
  session is limit-paused for exactly that reason; do not route around it.
- Claude-mode only, and it is a mutating call on the session's behavior: only for
  sessions you created, or when the user asked.

### The fleet watcher: `GET /api/events`

One SSE stream carries every session's lifecycle and hook events, so you can watch a
whole fleet on one connection instead of polling each worker.

| Param | Notes |
|-------|-------|
| `sessions` | comma list of ids. Filters **only** `session:terminal` batches |
| `clientId` | any 8-64 char token matching `/^[A-Za-z0-9_-]{8,64}$/` (`server.ts:180`), a uuid being merely one; lets you change the filter later via `POST /api/events/subscribe` without reconnecting |

**The trick: `?sessions=<bogus>` gives you a quiet stream.** The filter is applied in
`flushSessionTerminalBatch()` only; `broadcast()` deliberately ignores it so lifecycle
and metadata events reach every client regardless (the comment at
`sse-stream-manager.ts:269-275` says so in as many words). Subscribing to an id that
does not exist therefore suppresses the high-volume terminal firehose while
`session:created`, `session:deleted`, `session:exit`, `session:idle`, `session:working`,
`hook:stop`, `hook:permission_prompt`, `approval:pending` and the rest keep flowing.

```bash
# BOUNDED and FILTERED, always. The first frame is `event: init` with light state.
timeout 120 "${CURL[@]}" -N "$API/api/events?sessions=none" \
  | grep --line-buffered -E '^event: (session:(exit|deleted|idle)|hook:stop|approval:pending)'
```

- ⚠️ **Unbounded or unfiltered, this is a context bomb.** Without `--max-time`/`timeout`
  the call never returns, and without `grep` a busy server will hand you megabytes.
  Never pipe it raw into your own output.
- ⚠️ **It consumes an SSE slot.** `MAX_SSE_CLIENTS` is 100 process-wide, shared with
  every open browser tab; over the cap the server answers a plain-text
  `503 Too many SSE connections`. A curl you forget to bound holds its slot until it
  exits.
- ⚠️ **It is edge-triggered between calls.** Anything that fires while you are not
  connected is gone; there is no replay and no cursor. So the stream is **the watcher**
  and latched `wait-output` markers are **the ledger**: use the stream to notice
  something happening across many sessions, and a marker (or send-and-wait) to *prove*
  a specific turn finished. Never let a fleet's correctness depend on having been
  connected at the right moment.

### Approvals: the safe way to answer a dialog

When a claude worker stops on a permission prompt or a question, the Approvals Inbox
holds it as a structured item. Reading that is strictly better than ANSI-stripping the
dialog off `terminal?tail=` and guessing which digit to type.

| Task | Call |
|------|------|
| list prompts waiting on a human | `GET /api/v1/approvals` → `.data.approvals[]` |
| answer one | `POST /api/v1/approvals/:id/answer` body `{"action":"approve"\|"deny"\|"option"\|"text", "option":N, "text":"…"}` |
| drop one without keystrokes | `POST /api/v1/approvals/:id/dismiss` |

An item is `{id, sessionId, sessionName, kind, createdAt, toolName?, toolSummary?,
message?, cwd?, context?, options?}`. `kind` is `permission` | `question` | `idle`;
`options[]` is `{n, label}` and is present **only when the captured pane frame parsed
confidently**. `approve` sends `1`, `deny` sends Esc, `option` sends the digit, and
`text` (idle prompts only, ≤ 4000 chars) sends the text plus `\r`. Menu answers
deliberately carry no `\r`, because dialogs react to the keypress itself.

Why this beats screen-scraping: the server **refuses a digit that is not among the
parsed options** (`Option N is not among the parsed dialog options`), and it
**re-captures the pane before writing**, answering 409 `The dialog is no longer on
screen` if the dialog has gone. Answering is take-then-write, so a double-tap cannot
double-send, and a failed write restores the item. Claude-mode only (409 `CONFLICT`
otherwise); one item per session, a new prompt supersedes the old one; in-memory, so a
server restart loses the queue; 12 h TTL.

⚠️ **HARD RULE: an agent must never auto-answer an approval.** The whole point of the
prompt is that a human decides. Surface the item to the user (`toolName`,
`toolSummary`/`message`, and the `options[]` labels), get their decision, then relay it.
Approving a permission dialog on your own is exactly the laundering this skill forbids.

⚠️ And only for **sessions you created**. `GET /api/v1/approvals` returns everything you
can access, which includes the user's own working sessions. An approval belonging to one
of those is something you **report**, never something you answer.

### The wait primitives

Three bounded long-polls. Shared semantics:

- **Timeout = HTTP 200** with `wait.timedOut:true`. Loop over short waits (60 s);
  `tailscale serve` / cloudflared cut idle connections.
- Timeouts are **clamped** to `[1000, 600000]` ms (operator-tunable); the applied
  value is echoed as `wait.timeoutMs`, read it back, never assume.
- ⚠️ Clamping only covers **positive integers**. `timeout=0`, a negative value, a
  fraction (`timeout=1500.5`) and anything non-numeric (`timeout=30s`) are rejected by
  the schema as a 400 `INVALID_INPUT` naming the field, not silently clamped up to
  the floor. Omit the parameter to take the 60 000 ms default; never send a computed
  remainder without rounding it and checking it is still above zero. Same rule for
  `waitTimeout` in the input body, where the value must additionally be a JSON number
  (a quoted `"60000"` is a 400).
- All three nest the result under `.data.wait`, same shape, so one helper parses all.
- `.data.status` (post-wait `SessionStatus`) and `.data.limitPaused` ride along.
  `limitPaused:true` means the session is paused on a usage limit and will emit
  nothing until reset, a timeout is then *expected*; do not retry hard, and do not
  kill the worker. The remedy is [auto-resume](#usage-limits).

#### Signals by mode

| Signal | Meaning | Available for |
|--------|---------|---------------|
| `idle` | output stabilized + prompt detected, heuristic, can flap mid-turn | every mode |
| `working` | session started producing output | every mode |
| `stop` | Claude Code `stop` hook, the definitive end-of-turn | `claude` only |
| `blocked` | `permission_prompt` / `elicitation_dialog` hook, the worker needs an answer | `claude` only |
| `exit` | PTY exited or session deleted | every mode |

⚠️ **`claude` mode is necessary for `stop`/`blocked`, not sufficient. The real
precondition is that the session's working directory has a Codeman hooks block**, which
is now installed by default rather than depending on who created the directory:

| The worker's directory | Hooks | `stop` / `blocked` | Synchronize with |
|------------------------|-------|--------------------|------------------|
| any claude workspace, with `workspaceHooksEnabled` ON (the default) | installed at session create, add-only merge | fire | send-and-wait on `stop` |
| the same, with the setting OFF and no block already on disk | none added | never fire | `wait-output` markers only |
| a remote SSH session, a docker case that opted out, a workspace Codeman cannot write | none | never fire | `wait-output` markers only |
| a session created by a pre-1.19.0 server and never restarted since | whatever it had | only if present | check, then choose |

The install is an add-only merge, so a user's own hook entries survive and a malformed
settings file is left untouched. Sessions recovered at server boot get the same sweep,
which is what heals sessions created before this behavior existed. When in doubt, test
it rather than reason about it: grep for `/api/hook-event` in
`<casePath>/.claude/settings.local.json`.

Before 1.19.0, `writeHooksConfig()` ran only on the create paths and `quick-start`
against an existing directory called `refreshStaleCodemanHooks()`, which never *adds* a
block, so a linked case or a raw `workingDir` had no hooks at all. `POST
/api/cases/link` still only records a name-to-path entry; what changed is that the
session-create path installs hooks regardless of how the directory got there. See
[symptom 8](#8-send-and-wait-resolves-instantly-with-signalidle-and-the-answer-is-last-turns).

Default `until` set: `stop,idle,exit`. On modes with no hook signals the server silently
drops `stop`/`blocked` from the *default* set (echoed back as `wait.until`, e.g.
`["idle","exit"]` on shell); requesting them *explicitly* there is a 400 naming the
mode. ⚠️ `deepseek` is not one of those: its harness reports its own lifecycle, so it
keeps the full default set and accepts an explicit `until=stop`. ⚠️ For dsh the answer is
per-SESSION rather than per-mode — a session created with `statusReporting: false` has no
bridge, and an explicit `until=stop` there is a 400 naming that setting. ⚠️ That 400 is
otherwise about **mode**, so a hooks-less *claude* session accepts
`until=stop` happily and then never resolves it. ⚠️ On hook-less modes the lifecycle
signals are also **coarse in practice**: a
short shell command produced **no** `idle` transition within 60 s (verified live), so
a `fresh=1` / fresh-delivery wait can burn its whole timeout while the work finished
long ago. Synchronize hook-less modes with `wait-output` markers instead.

Two more places hooks go missing even in claude mode: **Docker cases** need
`CODEMAN_DOCKER_BRIDGE_HOOKS=1` on the server (without it only `idle`/`working`/
`exit` arrive), and **remote-SSH cases** run the agent on another host whose hooks may
never reach this server. When unsure, ask for `stop,idle,exit`.

⚠️ **Signals are edge-triggered with no history.** A signal that fires while no
waiter is registered is gone; no later wait can observe it (`until=stop` on a worker
whose turn already ended just times out, with or without `fresh`, verified live).
Register the waiter before the event can happen: send-and-wait does exactly that,
and `wait-output` markers with `from=buffer` are latched by construction. Never
fire-and-forget N prompts and then gather signal-waits worker by worker; every
worker that finishes before its gather is unobservable (see recipes.md Flow 4).

#### `GET /api/v1/sessions/:id/wait`

| Param | Default | Notes |
|-------|---------|-------|
| `until` | `stop,idle,exit` | comma list; unknown token → 400 naming it |
| `timeout` | 60000 | ms, positive integer only (0/negative/fractional = 400); clamped, applied value echoed as `wait.timeoutMs` |
| `fresh` | `0` | `1` requires an actual *transition*, ignoring the state at call time |

⚠️ A session whose PTY has not spawned (`pid:null`) or has exited counts as `exit`
**right now**: with the default set the call answers immediately
(`signal:"exit", immediate:true`). That is how you detect a dead worker cheaply, but
it also means "wait for my just-created session" needs the readiness recipe in
SKILL.md, not this endpoint.

#### `GET /api/v1/sessions/:id/wait-output`

| Param | Default | Notes |
|-------|---------|-------|
| `match` | required | literal substring, 1–200 chars, ANSI-stripped; chunk-straddling matches found; **no regex**, a `regex=` param is a 400 |
| `nocase` | `0` | case-insensitive compare; snippet keeps original casing |
| `from` | `now` | `buffer` scans the tail (~256 KB) of existing output first |
| `timeout` | 60000 | same clamp, same positive-integer rule |

Four traps, all observed live:

1. **The echo of your own typed command is output.** A marker appearing verbatim in
   the input line matches the moment the text is typed, before the command runs.
   Split the marker with a shell variable: send `M=DONE; …; echo ${M}_1234\r`, wait
   on `DONE_1234` ([symptom 5](#5-a-marker-matched-instantly-before-the-command-ran)).
2. **`from=now` misses text printed before the wait landed**, a marker echoed just
   before the request registered timed out at full length. After sending a command,
   always wait with `from=buffer`.
3. **`from=now` can also match too much**: tmux repaints old screen content as
   ordinary output on attach/resize/redraw, so a *generic* marker (`BUILD OK`)
   matches stale text. Unique-per-call markers (`DONE_$RANDOM`) make both `from`
   modes safe.
4. **TUI output can be space-less in the stream.** Full-screen TUIs (claude, codex,
   …) position words with cursor-movement escapes rather than literal spaces, so
   the stripped stream can read `Yes,Itrustthisfolder` while the pane shows the
   spaced phrase. Whether a given phrase keeps its spaces depends on how the TUI
   drew it (observed live: some multi-word matches fire, some never do), so treat
   multi-word matches against TUI screens as unreliable and match a **single
   space-free token** (`trust`, `shift+tab`). Plain command output (shell workers,
   `echo` lines) keeps real spaces.

Build the query with `-G --data-urlencode` (a `+` in a hand-built query decodes to a
space, [symptom 4](#4-matchedfalse-and-the-response-echoes-matchshift-tab)). Result
extras: `wait.matched`, `wait.match`, `wait.snippet` (bounded window around the match,
blank runs collapsed, the snippet is often all you need to read).

#### `POST /api/v1/sessions/:id/input` with `wait`

| Field | Notes |
|-------|-------|
| `wait` | `true` (default signal set) or the same comma grammar as `until`; absent = historical fire-and-forget |
| `waitTimeout` | ms, same clamp; a JSON number, positive integer (`"60000"` is a 400) |

Registers the waiter **before** typing, which closes the race where send-then-wait
sees the previous turn's idle state and returns instantly. Response adds `delivered`
and `duplicate` beside the standard `wait` object; both are absent on the
fire-and-forget path ([symptom 2](#2-datadelivered-is-null)).

A **tagged duplicate** (same `clientId`+`seq` already applied) does not retype but
still honors `wait`, answering from the session's *current* state instead of
requiring a new transition (`delivered:false, duplicate:true`, verified: ~20 ms,
command ran exactly once). That is what makes the resend-identical-request loop in
SKILL.md correct: iteration 1 delivers and needs a transition; later iterations
resolve immediately if the turn ended in between. ⚠️ The flip side: a duplicate's
`immediate:true` answer is the current state and nothing more, an idle worker
whose prompt was never submitted (missing `\r`) produces the same
`signal:"idle", immediate:true` as one that finished the turn. Confirm from
`terminal?tail=` before reporting success; SKILL.md's loop shows where.

⚠️ `delivered:false` with `duplicate:false` is a third thing entirely, and it is the
one people misread: the write did not land, see
[symptom 3](#3-endedtrue-on-a-session-that-still-exists).

#### Outcome parsing, in order

1. `wait.signal != null` (or `wait.matched == true`), the thing happened.
   `wait.immediate:true` rides along and means the condition already held at call
   time; if that is not what you meant, you wanted `fresh=1` or send-and-wait.
2. `wait.timedOut`, poll boundary; loop again.
3. `wait.ended`, the wait was released early, with no signal, match or timeout. On
   the two GET routes that means the session was torn down mid-wait or the server is
   shutting down: stop looping. On send-and-wait, **read `delivered` first**:
   `delivered:false` means the write never landed and the server released its own
   waiter, so the session may well still exist and the recovery is to restart the
   worker, not to mourn it ([symptom 3](#3-endedtrue-on-a-session-that-still-exists)).

## Limits and caps

Every number the server will enforce on an orchestrating agent. All are
env-overridable by the operator, so treat them as defaults and read back what the
response echoes.

| Cap | Default | Where it bites |
|-----|---------|----------------|
| `input` length | **65536** characters | 400 `INVALID_INPUT` at the route; the Zod schema's 100000 is the wrong number to plan against, and nothing is typed on rejection |
| `clientId` length | 128 characters | same 400 |
| concurrent waiters, one session | 16 (signal + output combined) | 409 `SESSION_BUSY` on a wait. Reuse one wait per worker |
| concurrent waiters, one owner | 48 (multi-user only; no owner = no cap) | 429 `RATE_LIMITED` |
| concurrent waiters, process-wide | 128 | 429 `RATE_LIMITED`; switching sessions does not help, back off |
| wait timeout | clamped to `[1000, 600000]` ms, default 60000 | positive integers only; anything else is a 400, not a clamp |
| `match` string | 1–200 characters, literal only | 400; `regex=` is rejected outright |
| `from=buffer` scan window | 256 KB tail of the terminal buffer | a marker older than that tail is invisible even with `from=buffer` |
| wait-output snippet context | 80 characters either side | `wait.snippet` is bounded, not the whole line |
| sessions, process-wide | 50 (`MAX_CONCURRENT_SESSIONS`) | 409 `SESSION_BUSY` on quick-start |
| sessions, per user | 25 in multi-user mode (half the global cap) | the same 409, with a different message |
| SSE clients, process-wide | 100 (`MAX_SSE_CLIENTS`) | plain-text `503 Too many SSE connections`; shared with every browser tab |
| active bash tools tracked | 20 per session | oldest entries drop off `active-tools` |
| auth failures per IP | 10, decaying over 15 min | plain-text 429 with `Retry-After`; locks out the login path, so never loop a bad credential |

Case creation is **uncapped**, which is the one place restraint has to come from you:
every `quick-start` with a new `caseName` creates a real directory on the user's disk.

## Troubleshooting

Response-shape surprises are in the [symptom gallery](#symptom-gallery). This table is
for environment and setup problems.

| Symptom | Cause / fix |
|---------|-------------|
| every curl fails with a certificate error | you dropped `-k`; `CODEMAN_API_URL` is HTTPS with a self-signed cert |
| `GET .../sessions/$CODEMAN_SESSION_ID` 404s | Docker case: the env id is truncated to 8 chars; find yourself with `startswith($SELF)`, and always self-compare by prefix, in both directions |
| `CODEMAN_MUX` unset but you seem to be in a session | remote-SSH case: the env vars are not exported there. Fail closed, refuse to act |
| connection refused from inside a container | a loopback-bound server is unreachable from a container, and `CODEMAN_DOCKER_BRIDGE_HOOKS=1` does **not** fix that: it opens a hooks-only listener, so hook events start flowing but `/api/v1/*` stays refused. Driving the API from inside a Docker case needs a reachable bind (an operator decision); report it, don't retry |
| wait routes 404 on a valid session id | read the `.error` text: a `Route ...` prefix means the server predates the wait endpoints (< 1.13.0; a dev build can serve them while reporting an older version, so probe, never version-compare), poll `terminal?tail=` and say so. `Session ... not found` means your id is wrong, not the server |
| wait on `stop` never resolves | a mode with no hook signals, or hooks not reaching the server (Docker/remote), or a case created by Codeman < 1.13.0 against an `--https` install (its hook curls lacked `-k` and TLS-failed silently; a 1.13.0+ server rewrites them the next time a session starts in that case). Use markers or `idle,exit` |
| wait on `stop` never resolves, on a **dsh** worker whose pane clearly finished | that profile does not implement the harness's supervisor contract, which Codeman cannot detect at request time (an unrecognized profile is treated as launchable on purpose). The wait is accepted and then times out. Drive that worker with markers, or switch to a profile that reports — `@deepseek-harness-tui/dsh-tui` does |
| new claude worker ignores its first prompt | it was showing the first-run trust dialog and Codeman's auto-accept did not fire (it is bounded by a 90 s window and a keystroke cap); use the readiness recipe in SKILL.md, wait for `shift+tab` first, answer the dialog only as the bounded fallback |
| a brand-new claude worker's pane is DEAD (`status 1`) seconds after the spawn | something pressed Enter at the first-run trust dialog. Since claude-cli 2.1.252 its options are unnumbered, reversed, and the highlighted default is `No, exit`, so a blind `\r` — an up-front Enter, or a task prompt typed into the dialog — quits the CLI. Answer it by reading the `❯` marker off `terminal?full=1` and arrowing onto `Yes, I trust this folder` first: `_accept_trust` in the §0 preamble |
| readiness burns its whole budget, then the worker answers fine anyway | you matched `bypass`, which is the statusline of ONE permission mode. Codeman spawns `--dangerously-skip-permissions` by default, but the server's `claudeMode` setting also has `auto` (`auto mode on`), `allowedTools` and `normal` (both `don't ask on`), and the effective per-session value is not exposed on `GET /api/v1/sessions/:id`. Match **`shift+tab`** instead: every mode's status bar ends `(shift+tab to cycle)` (measured per mode against claude-cli 2.1.226). Expect `blocked` signals mid-turn on the non-default modes |
| ANSI escapes survive the strip pipeline | `sed -e 's/\x1b…'` on macOS: `\x1b` is GNU-only, BSD sed matches nothing and strips nothing. Use the `ESC=$(printf '\033')` form above |
| `wait-output` times out although the pane shows the text | multi-word match against a TUI screen; the stream has no spaces there, match one token |
| 409 `SESSION_BUSY` on a wait | too many concurrent waiters on that session (cap 16 combined); reuse one wait per worker |
| 429 `RATE_LIMITED` on a wait | global/owner waiter pool full; back off, do not switch sessions |
| ready claude worker missing from `ListAgents` | cross-session messaging is off for that end: CLI < 2.1.224, the feature flag not (yet) on (observed: two 2.1.226 sessions on one box, only one with an inbox socket), a telemetry-disabling env var, a Docker/remote case, or a non-claude mode. Not an error: drive it over the HTTP recipes. See `reference/messaging.md` |
| `SendMessage` says "not an agent in this conversation" | first contact with a peer needs the ref: re-send with the exact `name [ref]` string from the `ListAgents` row, or from that error's own suggestion |
| message sent, worker never acts, no reply, no `stop` | the message was held (permission-class mismatch: a non-default `claudeMode` spawns prompting-class workers, and the approval dialog expires unattended after ~5 min) or refused (`crossSessionInbound`). Run the bounded backstop, then deliver once over HTTP input. See `reference/messaging.md` |
