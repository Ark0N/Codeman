# HTTP API Reference

Codeman's HTTP API is a **stable contract** as of 1.0 — see
[`versioning-policy.md`](versioning-policy.md) for the SemVer guarantee. This page
defines the response envelope, status codes, error codes, versioning, and the SSE
event channel.

## Versioning

- The stable, public surface is served under **`/api/v1/...`**. Pin external
  clients to this prefix.
- The unversioned **`/api/...`** paths are a permanent alias of the current
  version (what the bundled web UI uses). They are kept working, but new external
  integrations should use `/api/v1`.
- Breaking changes to the contract ship under a new prefix (`/api/v2`); `/api/v1`
  keeps its semantics. Additive changes (new endpoints, new optional fields, new
  error codes) are non-breaking and may appear in a minor release.
- The implementation rewrites `/api/v1/*` → `/api/*` at the server level
  (`rewriteApiV1Url` in `src/web/server.ts`).

## Response envelope

Every JSON response uses one uniform envelope, applied centrally by a
`preSerialization` hook (`src/web/server.ts`) — handlers return bare data and the
hook wraps it:

**Success** — HTTP `2xx`:

```json
{ "success": true, "data": <payload> }
```

`data` is the endpoint's payload (object, array, or value). Endpoints with no
payload return `{ "success": true, "data": {} }`.

**Error** — HTTP `4xx`/`5xx`:

```json
{ "success": false, "error": "human-readable message", "errorCode": "NOT_FOUND" }
```

`ApiResponse<T>` in `src/types/api.ts` is the canonical type.

> Non-JSON endpoints are exempt from the envelope: `GET /api/sessions/:id/file-raw`,
> `GET /api/sessions/:id/tail-file` (SSE), `GET /api/download`,
> `GET /api/screenshots/:name`, `GET /q/:code` (QR redirect), and the
> `GET /ws/sessions/:id/terminal` WebSocket upgrade.

> The [agent wait endpoints](#long-polling-agent-wait) use the normal envelope but
> are the only JSON endpoints that deliberately **hold the connection open**, for up
> to 600 s. Proxy operators and HTTP clients with a global read timeout need to know
> that before pointing them at Codeman.

⚠️ **A `401` is the one status that is not an envelope.** Authentication is rejected
in a request hook, before any handler runs, and it replies with the bare string
`Unauthorized` (`Unauthorized: hook secret required` on the hook path) plus
`WWW-Authenticate: Basic realm="Codeman"`. There is no `success`, no `error`, and no
`errorCode`, because the wrapping hook only wraps object payloads. So a client that
pipes every response straight into a JSON parser dies with a parse error rather than
reporting an auth failure, which is a confusing way to discover that a password is
set. Branch on the HTTP status **before** parsing.

## Error codes → HTTP status

The single source of truth is `ErrorStatus` / `httpStatusForErrorCode()` in
`src/types/api.ts`. Clients should branch on `errorCode` (stable) and may rely on
the HTTP status.

| `errorCode` | HTTP | Meaning |
|-------------|------|---------|
| `INVALID_INPUT` | 400 | Malformed request / failed validation |
| `UNAUTHORIZED` | 401 | Authentication required or failed |
| `NOT_FOUND` | 404 | Resource does not exist |
| `SESSION_BUSY` | 409 | Session is busy |
| `CONFLICT` | 409 | Conflicts with current state (e.g. already running) |
| `ALREADY_EXISTS` | 409 | Resource already exists |
| `OPERATION_FAILED` | 422 | Well-formed but could not be completed |
| `RATE_LIMITED` | 429 | Too many requests |
| `INTERNAL_ERROR` | 500 | Unexpected server error |

Adding a new error code is non-breaking; removing or renaming one is a major change.

## Long-polling (agent wait)

Three calls block until something happens instead of answering immediately. They
exist because SSE is Codeman's only other "tell me when" channel, and an agent
driving the API from a shell tool cannot practically hold a stream and parse
events inline.

| Call | Blocks until |
|------|--------------|
| `GET /api/v1/sessions/:id/wait` | one of a set of lifecycle signals fires |
| `GET /api/v1/sessions/:id/wait-output` | a literal string appears in the session's output |
| `POST /api/v1/sessions/:id/input` with `wait` | the input is delivered **and then** a signal fires |

`POST .../input` with `wait` is not the same as a `POST` followed by a separate
`GET .../wait`. It registers the waiter **before** writing, which closes the window
in which a separate wait sees the session still idle from the previous turn and
answers instantly with the wrong turn's result. Use it whenever you send a prompt
and want to know when that prompt is done.

### Three semantics that break callers who assume otherwise

**1. A timeout is HTTP `200`, not an error.** A wait that ends without its signal
returns `{"success":true, ...,"wait":{"timedOut":true,"signal":null}}`. The
intended pattern is a client-side loop over short waits, because `tailscale serve`
and cloudflared can both cut an idle connection, and turning every poll boundary
into a `4xx` would make that loop indistinguishable from a real failure. `408` is
auto-retried by several clients (silently doubling the polling load), `504` is what
a genuine tunnel failure looks like, and `204` cannot carry `waitedMs` / `status` /
`limitPaused`. Reserve error handling for the four codes in the table below.

**2. `stop` and `blocked` fire only for `claude` sessions.** Both come from Claude
Code hooks, and no other mode installs them: `shell` runs no agent, and the external
CLIs (`opencode`, `codex`, `gemini`, `antigravity`, `pi`) render their own TUIs and post
no hooks. For every non-`claude` mode only `idle`, `working` and `exit` are
accepted, and of those only `exit` is dependable: see the caveats under
[Signals](#signals) before building on `idle`. Requesting `stop` or `blocked`
**explicitly** on such a session is a
`400`; omitting `until` never fails, the server just drops them from the default set
and echoes the narrowed set back as `wait.until`. Three more places hooks can go
missing even in `claude` mode: a **Docker case** needs
`CODEMAN_DOCKER_BRIDGE_HOOKS=1`, since a container cannot reach a loopback-bound
Codeman (without it, only `idle` / `working` / `exit` work); a **remote-SSH
case** runs the agent on another host, whose hooks may never reach this server at
all; and a case whose hook config was written by **Codeman < 1.13.0 against an
`--https` install** carries hook curls without `-k`, which TLS-fail silently (the
hook line ends in `|| true`). Codeman now writes `curl -sk` and repairs a stale
case config the next time a session starts in that case. When in doubt, ask for
`stop,idle,exit` so a session without hooks still resolves on the heuristic
signal.

**3. `from=now` does not mean "printed after you asked".** tmux repaints the visible
screen on attach, on resize, and on any TUI redraw, and a repaint arrives as
ordinary output, so text that was already on screen can satisfy a fresh wait. This
was observed live: a marker echoed a minute earlier matched instantly on a new
`from=now` wait. It is inherent to running the agent under a multiplexer, so the
contract is a **marker unique to each call** (`MARK="DONE_$RANDOM"`, send
`echo $MARK`, then wait on `$MARK`), never a generic string like `BUILD OK`.

### Signals

| Signal | Source | Actually fires for |
|--------|--------|--------------------|
| `idle` | the session's own `idle` event | `claude`: yes, on ❯-prompt detection after activity. `shell`: **once only**, ~500 ms after start, and never again. External CLIs: not guaranteed (they render their own TUIs and readiness is output stabilization) |
| `working` | the session's own `working` event | `claude` only in practice (spinner and work-keyword detection are Claude output formats) |
| `stop` | the Claude Code `stop` hook, the definitive end-of-turn signal | `claude` only |
| `blocked` | a `permission_prompt` or `elicitation_dialog` hook | `claude` only, and rarer than it looks: see below |
| `exit` | no process is behind the session | every mode |

`stop` is the signal to orchestrate on where it exists; `idle` is a heuristic
fallback that can flap mid-turn when a spinner pauses. The default set when `until`
is omitted is `stop,idle,exit` (`exit` is in there so a worker that crashes resolves
the wait promptly instead of burning the caller's whole timeout on something that
can no longer happen). On a `claude` worker, prefer an explicit `until=stop,exit`
once the session is up: the default set's `idle` also resolves on a spinner pause,
and on a fresh session the **startup** `idle` (emitted when the CLI first comes up)
can land inside your first wait window and report a turn that never ran. Measured:
a session parked on the trust dialog emits no *further* `idle`, so it is the
startup transition, not the dialog, that produces the false success below.

⚠️ **`exit` means "nothing is running", which includes "not started yet".** The
server answers from `pid === null` plus a mux-layer pane-death probe, and that
covers a session that exited — including a worker that died *inside* its tmux pane
while the local attach client (and therefore `pid`) lives on — one that was
detached, and one that was **created but never started**. So the first wait
after `POST /api/v1/sessions` returns `{"signal":"exit","immediate":true}` in
milliseconds, and reading that as "the worker died" is wrong: it means start it, or
wait for it to come up. `status` is carried alongside so nothing is hidden. The
alternative (trusting `status`) is worse, because a dead PTY parks the session at
`status: "idle"`, which would answer the default wait with `immediate: true` for a
worker that has crashed. A worker dying while a wait is parked resolves it within
a few seconds (a background death-watcher), not at the timeout.

⚠️ **`blocked` is reachable less often than the table suggests.** It fires on two
hooks, and the default configuration suppresses one of them: Codeman spawns claude
with `--dangerously-skip-permissions`, so permission prompts do not happen unless the
instance is switched to the `auto` Claude mode (App Settings), or the caller is a
multi-user account without the bypass grant, which is forced to `--permission-mode
auto`. What does still fire under the default is `elicitation_dialog`, the agent
asking the user a question. So `until=stop,blocked,exit` is a reasonable belt on a
long turn, but a worker that never comes back is far more likely to be working than
blocked, and polling `blocked` alone will sit at its timeout.

⚠️ **On a `shell` session, only `exit` and marker-matching are dependable.** A shell
session emits its one `idle` at startup and then stays `status: "idle"` forever,
whatever the pane is doing, so it never emits a *transition*. Since send-and-wait
requires a transition (and so does `fresh=1`), both can only time out there:
a documented default `wait` on a shell worker running `sleep 4` times out at the
full 25 s. Synchronize hook-less sessions with `wait-output` and a unique marker
instead. The same caution applies to the external CLIs.

### Readiness is not a signal

Nothing here reports "the agent is ready for a prompt", and no combination of
`until`/`fresh` synthesizes one. A freshly created session reads as `exit` (above),
and a `claude` worker in a brand-new case comes up on the CLI's **trust dialog**,
which contains a ❯ prompt of its own. Send-and-wait posted at that moment types the
prompt into the dialog, where the `\r` never gets past it, while the session's
startup `idle` lands inside the wait window: the wait resolves on `idle` in a
couple of seconds with `timedOut: false`, which looks exactly like a completed
turn.

The reliable sequence is: poll `GET /api/v1/sessions/:id` until `.data.pid` is
non-null, then `wait-output` for the composer's own marker (`bypass`, the status
bar of a CLI spawned in bypass mode) with a short timeout, handling the trust
dialog only as the bounded fallback.

⚠️ **The fallback is not a bare `\r`.** Claude Code 2.1.252 unnumbered the dialog's
options, reversed them and highlights `No, exit`, so an Enter sent blind quits the
CLI and the pane dies seconds after the spawn. Read the `❯` marker off the current
frame (`GET /api/v1/sessions/:id/terminal?full=1`), send `ESC [ B` while it is on
`No, exit`, re-read, and confirm only once it is on `Yes, I trust this folder`.
Reading the current frame is also what keeps this correct on later runs: the dialog
text stays in the terminal buffer for the life of the session, so a `trust` probe
with `from=buffer` keeps matching long after the dialog is gone. A worked version is in
[`extending-codeman.md`](extending-codeman.md#seam-3-http-api-and-cli).

### `GET /api/v1/sessions/:id/wait`

| Param | Type | Default | Notes |
|-------|------|---------|-------|
| `until` | comma-separated list of `idle,working,stop,blocked,exit` | `stop,idle,exit` | resolves on the first to fire. An unknown token is a `400` naming it, never a silent fallback |
| `timeout` | positive integer ms | `60000` | **validated first, clamped second.** `0`, a negative value and a fractional value are all `400`s, not clamps; a valid value outside `[1000, 600000]` is clamped and echoed as `wait.timeoutMs` |
| `fresh` | `0` \| `1` \| `false` \| `true` | `0` | `1` requires an actual transition, ignoring the state at call time |

```bash
curl -s "$API/api/v1/sessions/$SID/wait?until=stop,exit&timeout=60000"
```

Both GET wait routes answer with `Cache-Control: no-store`, because the documented
pattern polls one identical URL in a loop and a cached `{"timedOut":true}` would
turn that loop into a busy spin. `POST .../input` sends no cache header (it is a
POST, which is not heuristically cacheable).

⚠️ **Unknown query parameters are ignored, not rejected**, with one exception
(`regex`, below). In particular `match=` on `/wait` is silently dropped and you get
a plain signal wait, so check the endpoint path before blaming the parameters.

### `GET /api/v1/sessions/:id/wait-output`

| Param | Type | Default | Notes |
|-------|------|---------|-------|
| `match` | literal string, 1 to 200 chars | required | substring match against the PTY stream with ANSI escapes stripped. A match spanning two PTY chunks is found |
| `nocase` | `0` \| `1` \| `false` \| `true` | `0` | case-insensitive compare. The returned snippet keeps the terminal's original casing |
| `from` | `now` \| `buffer` | `now` | `buffer` scans the tail of the existing terminal buffer (bounded, 256 KB by default) before blocking |
| `timeout` | positive integer ms | `60000` | same validation and clamp as `/wait` |

**Matching is literal, never a pattern.** A `regex` parameter is rejected with a
`400` rather than ignored, so a caller that assumed otherwise finds out immediately
instead of waiting on the wrong thing. The reasoning is in
[`architecture-invariants.md`](architecture-invariants.md#agent-wait-primitives).

#### What the matcher actually sees

The matcher scans the raw PTY stream, **normalized**: ANSI escape sequences are
stripped — CSI, OSC, and the charset-designation escapes a stock bash prompt emits
on every line (`ESC ( B`), so `match=tnode:` matches a prompt that renders
`…@tnode:` — a partial escape arriving at a chunk boundary is held back until its
tail arrives, and a match may straddle PTY chunks: `printf STRAD; sleep 1; printf
DLEQQ` is matchable as `STRADDLEQQ` (all measured live). Three caveats remain:

⚠️ **It is still the byte stream, not the rendered pane.** `GET .../terminal`
answers from a tmux screen capture (`data.source: "mux-visible"`), the finished
picture; the matcher sees the stream that painted it. For linear output the two
agree once escapes are stripped, but a full-screen TUI composes its picture with
cursor positioning, so what the pane shows and what the stream carries can differ.
Seeing your string in `terminal?tail=` makes a match likely, not guaranteed.

⚠️ **A TUI's text can arrive without its spaces.** Claude Code positions words
with cursor moves rather than printing spaces, so screen text can reach the
matcher as `Quicksafetycheck:Isthisaprojectyoucreated...`. Whether a given phrase
keeps its spaces depends on how the TUI happened to draw it (measured: `I trust
this folder` matched, `Quick safety check` did not), so a multi-word `match`
against a TUI pane is unreliable rather than impossible. Match a **single
space-free token**, ideally one you printed yourself. Plain command output (a
shell worker, an `echo`) keeps its spaces.

⚠️ **The returned `snippet` is a rendering of the matched text, not a quotation of
it.** It is cut from the same normalized stream the match ran against, then
cleaned for display: remaining raw control bytes are removed (an agent pipes the
snippet into its own terminal, so a worker's bytes must not be able to reset that
display) and blank runs are collapsed. A printable needle that matched will appear
in it; a needle containing control bytes or a blank run may not survive verbatim.

```bash
MARK="DONE_$RANDOM"
curl -sG "$API/api/v1/sessions/$SID/wait-output" \
  --data-urlencode "match=$MARK" --data-urlencode 'timeout=120000'
```

Build the query with `-G --data-urlencode` rather than by hand: a `+` in a
hand-written query string decodes to a space.

### `POST /api/v1/sessions/:id/input` with `wait`

Two optional fields on the existing endpoint:

| Field | Type | Notes |
|-------|------|-------|
| `wait` | `true` or the same comma grammar as `until` | `true` means the default signal set. Omitted keeps the historical fire-and-forget behavior, unchanged. `null`, `false` and an empty string are all read as **absent**, not as an error and not as "wait for the default" |
| `waitTimeout` | positive integer ms | same validation **and** clamp as `timeout`: `0`, a negative and a fractional value are `400`s, anything valid is clamped into `[1000, 600000]` and echoed as `wait.timeoutMs` |

Both are `nullish`, so an explicit `null` from `JSON.stringify` is accepted as
"absent" rather than failing validation. That is deliberate: `.optional()` would
reject it, which has shipped as a real bug twice.

The input must end with `\r` (a real carriage return in the JSON string): Enter is
sent only when the input contains one, so text without it is typed onto the
worker's prompt but never submitted, and the wait then runs its full timeout on a
turn that never started. Verified live; this is the most common silent failure on
this endpoint.

```bash
curl -s -X POST "$API/api/v1/sessions/$SID/input" \
  -H 'Content-Type: application/json' \
  -d '{"input":"run the tests\r","useMux":true,"clientId":"agent-1","seq":1,
       "wait":"stop","waitTimeout":600000}'
```

A **tagged duplicate** (a `clientId` + `seq` pair the server has already applied)
still honors `wait`, because the caller's question is unanswered, but it answers
from the session's current state rather than requiring a new transition: the
original turn may be long over. It comes back as
`"delivered": false, "duplicate": true`.

**Wake-on-LAN hosts** (`docs/remote-sessions.md` §Wake-on-LAN): when the session's
remote host has a wake target and is asleep, the non-wait form answers `200` with
`{"buffered": true}` — the bytes are held and flushed after the host is back — or
`{"buffered": true, "dropped": true}` for a chunk over the 4 KB wake buffer, which
is gone (never delivered as a fragment). Both fields are additive to the historical
bare `{}`. With `wait`, the route blocks on the wake instead and answers
`422 OPERATION_FAILED` ("did not come back after a wake-on-LAN request — nothing was
sent") when the host never returns, rather than writing into the stalled pane and
reporting `delivered:true` plus a timeout.

Two endpoints back that flow directly, both scoped to one session's remote host and
both refusing a session that is not remote (`400 INVALID_INPUT`):

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/sessions/:id/reachability` | Whether the session's remote host answers SSH right now, plus whether a wake target is configured. Read-only: it never wakes. `{"reachable": true\|false\|null, "wakeConfigured": "mac"\|"command"\|"none"}`, where `null` means the answer is unknown (a proxied host, where a TCP probe proves nothing). |
| `POST` | `/api/sessions/:id/wake` | Wake the host and wait for it to accept SSH again, bounded by the request budget. `422 OPERATION_FAILED` when it does not come back; `400 INVALID_INPUT` with "No wake-on-LAN target configured for this host" when nothing is set. |

⚠️ Waking is deliberately reachable only from an explicit user action (this route, a
session create/attach, or typing into a sleeping session). No watcher, dropped-session
handler or boot-recovery path may wake a host, or a suspended machine would be woken
again seconds after every suspend; `test/remote-wake.test.ts` pins that as an import
fence around `src/remote-wake.ts`.

### Response

All three nest the wait result under `data.wait`, so one client helper works against
any of them:

```json
{ "success": true, "data": {
  "sessionId": "28325fd3-caa7-4178-82bf-87dfebf0f464",
  "status": "idle",
  "limitPaused": false,
  "wait": {
    "signal": "stop", "until": ["stop", "idle", "exit"],
    "timedOut": false, "immediate": false, "ended": false, "aborted": false,
    "waitedMs": 8421, "timeoutMs": 60000
  }
}}
```

`POST .../input` returns the same `wait` object alongside `delivered`, `duplicate`,
`status` and `limitPaused`. `POST .../input` **without** `wait` is unchanged and
still returns `{"success": true, "data": {}}`.

⚠️ `delivered: false` has **two** meanings, and they must be told apart by
`duplicate`: with `duplicate: true` the input was suppressed as an already-applied
redelivery (harmless, the turn it refers to may be long over), while with
`duplicate: false` the **write failed** (typically no PTY behind the session). A
client that reads `delivered === false` as "duplicate" silently treats a failed send
as a success.

| Field | Type | Meaning |
|-------|------|---------|
| `wait.signal` | signal \| `null` | the signal that fired (`/wait` and `/input` only) |
| `wait.until` | array of signals | what the server actually waited on, after narrowing the default set for the session's mode (`/wait` and `/input` only) |
| `wait.matched` | boolean | the string appeared (`/wait-output` only) |
| `wait.match` | string | the literal that was searched for (`/wait-output` only) |
| `wait.snippet` | string \| `null` | bounded window of output around the match, blank runs collapsed for readability (`/wait-output` only) |
| `wait.timedOut` | boolean | the wait hit its timeout. Still a `200` |
| `wait.immediate` | boolean | the condition already held at call time, so nothing was waited for (`waitedMs` is 0) |
| `wait.ended` | boolean | the session went away (deleted or torn down) before the condition was met |
| `wait.aborted` | boolean | the client hung up, so the waiter was released without resolving — and by that definition a client never reads `true`. When the **server** abandons a wait itself (send-and-wait against a session with no PTY), it answers in about a millisecond with `ended: true`, `delivered: false`, `duplicate: false` and `aborted: false`: `delivered`/`ended` carry that story, and `aborted` stays the transport flag. Present for completeness; treat a `true` as "this wait answered nothing", never as an outcome |
| `wait.waitedMs` | number | wall-clock ms actually spent waiting |
| `wait.timeoutMs` | number | the timeout **after clamping**, which is what was applied |
| `status` | `SessionStatus` | the session's status after the wait, so a caller that timed out still learns where things stand |
| `limitPaused` | boolean | the session is paused on a usage limit and will emit nothing until its reset, so a timeout here is expected rather than a stall worth retrying hard |

Read the outcome by discriminator, in this order:

1. `wait.signal !== null` (or `wait.matched === true`): the thing happened.
2. `wait.timedOut`: a poll boundary. Loop again.
3. `wait.ended` or `wait.aborted`: the wait answered nothing, because the session is
   gone or was never running. Re-check the session instead of looping.

`wait.immediate` is not a fourth outcome: it rides along with the first one and
means the condition already held at call time, so nothing was actually waited for.
If that is not what you meant, you wanted `fresh=1` or the send-and-wait form. Note
that `{"signal":"exit","immediate":true}` on a session you just created is the
not-started-yet case, not a crash.

**The timeout is clamped, so read it back.** A request for 1800000 ms is silently
reduced to the server's ceiling (600000 ms by default, operator-tunable), and a
request for 1 ms is raised to 1000 ms. `wait.timeoutMs` is the value that was
applied. Without checking it, a caller that asked for 30 minutes and got 10 will
read the timeout as "the worker is wedged" and kill a session that was working fine.

### Errors

| `errorCode` | HTTP | When |
|-------------|------|------|
| `INVALID_INPUT` | 400 | unknown `until` / `wait` token; `stop` or `blocked` requested explicitly on a mode that installs no hooks (the message names the mode); `regex=` on `/wait-output`; `match` outside 1 to 200 chars; a non-numeric `timeout` |
| `NOT_FOUND` | 404 | no such session, or one this caller does not own |
| `SESSION_BUSY` | 409 | this session's waiter cap is full |
| `RATE_LIMITED` | 429 | a per-owner or process-wide waiter cap is full. Retry later; the session you named is not the problem |

The two capacity codes are deliberately different. A process-wide cap reported as
`SESSION_BUSY` would tell the caller to switch sessions, which cannot help. The
error message names the cap that was hit.

⚠️ A `401` is **not** in this table and is not an envelope at all (see
[Response envelope](#response-envelope)). It matters most here: a polling loop that
pipes each wait straight into `jq` fails with a parse error on every iteration
against a password-protected server, which reads as "the wait endpoints are broken".
Check the status first.

The per-session cap is a **combined** budget: signal waiters and output waiters
count against the same 16, not 16 of each. An abandoned request no longer holds its
slot, because the routes release the waiter when the client disconnects, but a
client that opens many concurrent waits against one session will still hit the cap.

## Session lineage (`parentSessionId`)

A create request may name the session that spawned it, which the web UI draws as a
line between the two tabs. Accepted on `POST /api/v1/sessions` and
`POST /api/v1/quick-start`, either way:

```bash
# as a body field
-d '{"caseName":"worker-1","mode":"claude","parentSessionId":"'"$CODEMAN_SESSION_ID"'"}'

# or as a header, which is what an agent driving many spawns should use: set it once
# on the curl invocation and every spawn call carries it
-H "X-Codeman-Parent-Session: $CODEMAN_SESSION_ID"
```

The body field wins if both are present. The value is resolved against live sessions
(exact id, or a unique prefix of at least 8 characters) and must belong to the same
owner as the session being created.

**It cannot fail your spawn.** An unknown, stale, foreign or malformed value is
silently dropped and the session is created without lineage — never a `400`. It is
also pure decoration: it confers no permission, and a child is unaffected by its
parent exiting. It appears on session state as `parentSessionId` (absent when
unresolved) and survives a server restart.

## Approvals Inbox

Cross-session queue of prompts waiting on a human (permission dialogs,
AskUserQuestion questions, idle prompts). Claude-mode sessions only; items are
in-memory (a server restart drops them; the next prompt re-fires the hook).
Design: [`approvals-inbox-plan.md`](approvals-inbox-plan.md).

- `GET /api/v1/approvals` → `{ approvals: ApprovalItem[] }`, oldest first,
  ownership-scoped in multi-user mode. `ApprovalItem`: `{ id, sessionId,
  sessionName, kind: 'permission'|'question'|'idle', createdAt, toolName?,
  toolSummary?, message?, cwd?, context?, options?: {n, label}[],
  acknowledgedAt? }`. `context` is the ANSI-stripped visible pane frame;
  `options` is present only when the dialog's numbered choices parsed
  confidently; `acknowledgedAt` marks an item a human has already looked at
  (see `/viewed` below) and tells clients not to re-arm its tab alert. Listing
  also runs a staleness sweep over the caller's own items: the pane is
  re-captured, and an item whose dialog no longer parses is resolved as
  `resolved_in_terminal` instead of being returned (only items whose original
  frame parsed `options` can be dropped this way, so an unreadable capture
  keeps the item).
- `POST /api/v1/approvals/:id/answer` with `{ action: 'approve' }` (sends the
  digit `1`), `{ action: 'deny' }` (sends Esc), `{ action: 'option', option: n }`
  (sends the digit; accepted only when `n` is among the item's parsed
  `options`), or `{ action: 'text', text }` (idle prompts only; submits the
  line as a prompt). `404 NOT_FOUND` when the item is no longer pending,
  `409 CONFLICT` when the dialog left the screen or another actor answered
  first, `422 OPERATION_FAILED` when the session refused input.
- `POST /api/v1/approvals/:id/dismiss` removes the item without keystrokes.
- `POST /api/v1/approvals/session/:sessionId/viewed` → `{ sessionId,
  acknowledged: itemId | null }`. Marks the session's pending **idle** item as
  seen by a human (the web UI calls it when you open the session's tab): the
  item stays pending and answerable, but stops arming the yellow tab alert on
  every client, including after a reload. Permission/question items are never
  acknowledged this way, since looking at a dialog does not answer it. `404`
  for an unknown or inaccessible session; acknowledging twice is a no-op
  (`acknowledged: null`).

SSE events: `approval:pending` (full item), `approval:updated` (context/options
re-captured, or the item acknowledged), `approval:resolved` (`{ id, sessionId, kind, resolution }` with
`resolution` one of `answered | resolved_in_terminal | superseded |
session_ended | dismissed | expired`).

## Reboot restore

A host reboot takes the tmux server down with it, so every pane dies and the
board comes up empty. At boot Codeman works out which sessions the reboot
destroyed and holds that plan in memory, and these endpoints let a client offer
it to the user. Nothing creates a pane until the user asks: the boot-time reboot
heuristic decides whether to ASK, never whether to act.

Claude-mode sessions only (others carry their conversation id in their own
config object); remote and docker sessions are never offered, because both need
another host or container to be up. The plan is in-memory, so a server restart
drops it and the offer is gone; the conversations themselves are unaffected,
since they live in the CLI's own transcript store and stay reachable from the
Resume list. A plan nobody spends expires after 24 hours.

- `GET /api/v1/reboot-restore` → `{ sessions: RestorableSession[],
  scrollbackRestored: false }`, ownership-scoped in multi-user mode.
  `RestorableSession`: `{ id, name?, workingDir, mode, owner? }`. The persisted
  record itself is never sent. `scrollbackRestored` is always `false` and exists
  so a client states it: a restored session is a NEW pane, so the conversation
  continues and the terminal history does not.
- `POST /api/v1/reboot-restore/restore` with `{ sessionIds?: string[] }` (omit
  to restore everything the caller can see) → `{ restored: RestorableSession[],
  skipped: { sessionId, reason }[] }`. `reason` is one of `workspace-missing`
  (the directory is gone), `workspace-forbidden` (in multi-user mode it is
  outside the workspace of the user the session belongs to, re-checked against
  that owner's current grant rather than the caller's), `already-live` (the conversation is already
  open, typically resumed by hand from the Resume list), `capacity-reached`
  (the global or per-user session cap), or `rebuild-failed` (the agent would not
  start, most often a CLI binary missing from the server's PATH).
  `409 CONFLICT` when that caller already has a restore running. Entries are
  removed from the plan before any pane is built, so a double-click cannot put
  two panes on one conversation; anything that never became a pane goes back on
  offer, except `already-live`, which cannot stop being true. A restored session
  comes back attached, idle and disarmed: respawn controllers and Ralph loops
  are never re-armed automatically.
- `POST /api/v1/reboot-restore/dismiss` → `{ dismissed: n }`. Drops the offer
  for everything the caller can see.

Each rebuilt session also emits the ordinary `session:created` SSE event, so
clients other than the one that clicked pick it up without refetching.

## Read My Mind intent profiles

Per-case profiles of what the user is trying to accomplish: user/agent-stated
goals plus the user's recently submitted prompts, captured from the Claude
session transcript while the opt-in `readMyMindEnabled` setting is on (default
OFF). Keyed by owner + workingDir, so the profile survives `/clear`, respawns,
and session churn. Stored in `~/.codeman/intents.json` (mode 0600); never fed
into `/api/v1/search`. Design: [`readmymind-plan.md`](readmymind-plan.md);
user guide: [`readmymind.md`](readmymind.md).

- `GET /api/v1/sessions/:id/intent` -> `{ intent: IntentProfile }` for the
  session's case. `IntentProfile`: `{ key, workingDir, updatedAt, goals,
  recentPrompts: { ts, sessionId, text }[] }` (prompts oldest first, FIFO cap
  50, each <= 500 chars). A case with nothing recorded answers an empty
  profile with `updatedAt: 0`; nothing is persisted by reads.
- `PUT /api/v1/sessions/:id/intent` with `{ goals }` (<= 8192 chars, strict
  schema) replaces the goals text and answers the updated profile.
  `400 INVALID_INPUT` on over-long or unknown fields.
- `DELETE /api/v1/sessions/:id/intent` -> `{ deleted: boolean }` forgets the
  case's profile entirely.
- `POST /api/v1/sessions/:id/readmymind` predicts the user's next prompt:
  a one-shot model call over the intent profile plus live session signals
  (pending approval dialog, transcript tail, git state, run-summary events,
  sibling sessions). Body is optional; the rethink flow passes
  `{ steer?, rejected? }` (strict schema: `steer` <= 2000 chars, `rejected`
  up to 10 strings <= 1000 chars). Answers
  `{ suggestions: { prompt, why, kind }[], durationMs }` with 1-3 suggestions
  (`kind`: `continue` | `verify` | `redirect`; prompts are single-line).
  Claude-mode sessions only (`400 INVALID_INPUT` otherwise); one prediction in
  flight per session (`409 CONFLICT`); predictor failures answer
  `502 OPERATION_FAILED`. Takes 5-90 s and costs real tokens. Suggestions are
  only ever returned, never sent: submitting one is the caller's explicit act.

All four enforce session ownership in multi-user mode; a foreign session id
answers `404 NOT_FOUND` (no existence leak), and profiles of two owners of the
same directory are distinct by construction.

## Custom Model Endpoints

Points a session's harness at a user-configured OpenAI-compatible endpoint —
local (llama.cpp, vLLM, DGX Spark) or cloud (Azure AI Foundry, OpenRouter) —
instead of its native cloud backend, gated by the opt-in
`customModelEndpointsEnabled` setting (default OFF). Endpoints are
machine-level infra, like remote/docker hosts: writes are admin-only in
multi-user mode. Design: [`custom-model-endpoints-plan.md`](custom-model-endpoints-plan.md);
user guide: [`custom-model-endpoints.md`](custom-model-endpoints.md).

- `GET /api/v1/model-endpoints` -> `CustomModelHost[]`, an unwrapped bare
  array like every other list route (still riding the standard `{success,
data}` envelope on the wire — unwrap it the same way). Answers `[]` for a
  non-admin in multi-user mode. `apiKey` is never returned; `apiKeySet:
boolean` reports whether one is stored, so a client can render "unchanged
  if left blank" without ever holding the real value.
- `POST /api/v1/model-endpoints` with `{ id, label, baseUrl, apiKey?,
authStyle?, defaultModelId? }` creates one. `id` must match
  `^[a-zA-Z0-9_-]+$`; `authStyle` is `bearer` (default) or `api-key`, never
  both (a real server hung indefinitely when sent both headers on one
  request); `baseUrl` must be `http(s)`, carry no embedded credentials, and
  is refused if it points at (or resolves to) a link-local or
  cloud-metadata address. `409 ALREADY_EXISTS` on a duplicate id.
- `PUT /api/v1/model-endpoints/:id` updates one. An **absent** `apiKey`
  keeps the stored one rather than clearing it — the client never receives
  the real value to resend deliberately unchanged, so omission is the only
  way to say "leave it alone"; there is no way to clear a key back to unset
  this way. `defaultModelId`, when set, must be one of that endpoint's own
  `models` (`400 INVALID_INPUT` otherwise).
- `DELETE /api/v1/model-endpoints/:id` removes one.
- `POST /api/v1/model-endpoints/:id/discover-models` fetches the endpoint's
  own `GET /v1/models` and stores the result as `models`, updating
  `lastDiscoveredAt`, plus (best-effort, only for a model llama-swap's own
  response already reports loaded) `modelContextLengths` and `modelSizesGB`.
  A `defaultModelId` that no longer appears in the fresh list is dropped
  rather than carried forward invalid. Failures answer `422 OPERATION_FAILED`
  with the underlying connection error, or a named egress refusal if the
  resolved address turned out to be blocked. The same refresh also runs
  automatically for every saved endpoint every 5 minutes in the background
  (`refreshAllCustomModelHosts()`, `custom-model-routes.ts`, started from
  `server.ts`), so there is no route for triggering "refresh all" — one
  endpoint being unreachable on a cycle never blocks the others.
- `GET /api/v1/model-endpoints/:id/running-status` -> `{ isLlamaSwap,
running: [{model, state}], logLine? }`, read-only, no admin gate
  (any session owner who could already point a session at this endpoint can
  equally ask what it currently has loaded). `isLlamaSwap` is
  feature-detected via the endpoint's own `GET /running` — a plain
  llama.cpp/OpenAI-compatible server has none and always answers `false`.
  `logLine`, present only when `isLlamaSwap` is true, is the most recent
  REAL backend `llama-server` process log line (`load_model: ...`,
  `llama_server: model loaded`, etc.), sourced from the endpoint's own
  `GET /api/events` SSE stream and filtered to `source: "upstream"` frames
  only (never llama-swap's own `source: "proxy"` request-access log) — one
  connection is held open per endpoint and reused across every poller,
  idle-closed after 30s of nobody asking. This is what the Run-menu
  picker's loading banner polls once a second while a model is loading.
- `POST /api/v1/sessions/:id/custom-model` with `{ endpointId, modelId,
confirmed? } | { clear: true }` applies (or clears) the session's
  selection and **restarts the session's CLI process in place** — every
  supported harness reads its endpoint config at process start, never per
  turn, so there is no live hot-swap. (`POST /api/v1/quick-start`'s own
  `customModel: { endpointId, modelId, confirmed? }` field is the
  no-restart equivalent for a session that doesn't exist yet — see below.)
  A Claude session resumes its existing conversation across the restart;
  pi/omp/grok additionally get a forced `--model`/`-m` value, since for
  those three the config file alone does not select it. `400 INVALID_INPUT`
  for a remote (SSH) or Docker session — both restart their agent
  differently under the hood, and applying to one would report success
  while changing nothing. Two more responses replace the normal
  `{customModel, restarted}` shape, neither an error, and neither restarts
  or creates anything on the first ask. ⚠️ **Each is answered by its OWN
  flag on the retry, and answering one is not consent to the other**: they
  are questions about different people, and while they shared a single flag
  a caller who confirmed the context warning silently agreed to evict
  another session's model as well. Send `confirmedContext: true` to proceed
  past the context warning, `confirmedSwap: true` past the swap conflict,
  and both when both were asked (they accumulate, so the second retry still
  carries the first answer). The original `confirmed: true` still means
  BOTH and is still accepted, because it shipped in this feature's
  HTTP-API-only cut; new callers should send the specific one:
  - `{requiresConfirmation: true, currentlyLoadedModel, affectedSessions}` —
    llama.cpp/llama-swap only runs one model at a time, and switching would
    unload a model another **live session's own selection** is actively
    using. Never returned for a plain (non-llama-swap) server, and never
    just because a swap is needed at all — only when it would disrupt
    someone else.
  - `{requiresContextWarning: true, modelId, contextLength,
minSafeContextTokens}` — Claude Code's own fixed per-turn overhead
    (system prompt + tool schemas) can exceed a small model's entire
    discovered context on its own, before any conversation history exists
    to compact, guaranteeing the very first message fails regardless of
    `CLAUDE_CODE_MAX_CONTEXT_TOKENS`. Gated on the CLI registry declaring a
    `contextLengthVar` (claude only today), so it never fires for another
    harness.
- `POST /api/v1/quick-start`'s `customModel: { endpointId, modelId,
confirmed?, confirmedContext?, confirmedSwap? }` field (alongside its
normal `caseName`/`mode`/etc. body)
  computes the same injection **before** the session exists and launches
  directly on the endpoint — no restart, because there was never a
  native-backend boot to restart away from. Runs the identical checks as
  the dedicated route above (`requiresConfirmation`/`requiresContextWarning`,
  same shapes, same per-question `confirmedContext`/`confirmedSwap` retry),
  and is refused the same way
  for a remote or Docker case. This is what the Run-menu picker uses for
  opencode, Codex, Gemini, Pi, Grok, DeepSeek and OMP; Claude still uses the
  dedicated restart route above (its `--resume`-based restart is far less
  jarring than a full relaunch, and folding it into the one-shot path is
  separate work — see `docs/custom-model-endpoints-plan.md`).

## CLI management

Read and write the CLI registry (`docs/cli-registry.md`). Every **write** route answers `403 FORBIDDEN` while `cliManagementEnabled` is off (the default), and for a non-admin in multi-user mode. A write that would overwrite a `clis.json` which does not parse, or which has group/world permission bits, is refused with `409 CONFLICT` and a message naming the fix; the file is left untouched.

| Method   | Path                          | Body                                                    | Notes                                                                                                   |
| -------- | ----------------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `GET`    | `/api/clis`                   | none                                                    | Every entry, disabled ones included: `id`, `label`, `shortBadge`, `order`, `kind`, `enabled`, `stock`, `installed`, and `installCommand` for a stock entry. Not gated; a non-admin in multi-user mode gets `[]`. |
| `PUT`    | `/api/clis/:id`               | `{ enabled }`                                           | Toggle an existing entry, stock or custom. `404` for an unknown id; `400 INVALID_INPUT` when disabling a `kind: 'shell'` entry. |
| `POST`   | `/api/clis/:id/install`       | none                                                    | Run a **stock** entry's install command (never a custom one: `400`). `409 CONFLICT` while an install for the same id is running; `422 OPERATION_FAILED` with the output tail when it fails. Never enables the entry. |
| `POST`   | `/api/clis`                   | `{ id, label, shortBadge, binaries, argv, enabled? }`   | Create a custom entry. `409 ALREADY_EXISTS` for a stock id or an existing custom id. `enabled` defaults to `true`. |
| `PUT`    | `/api/clis/custom/:id`        | `{ label, shortBadge, binaries, argv, enabled? }`       | Replace an existing custom entry. An absent `enabled` keeps the entry's current state. `400` for a stock id, `404` for an unknown one. |
| `DELETE` | `/api/clis/:id`               | none                                                    | Delete a custom entry. `400` for a stock id, `404` for an unknown one.                                  |

## Voice dictation

Browser dictation transcribed through this server's Claude Code login, i.e. the
same speech-to-text service the CLI's own `/voice` mode uses. Gated on the synced
`claudeVoiceEnabled` setting (default OFF). Design:
[`claude-voice-plan.md`](claude-voice-plan.md).

- `GET /api/v1/voice/status` -> `{ available, reason?, subscriptionType?,
  expiresAt? }`. `reason` is `disabled` (setting off), `no-credentials` (nobody
  signed in to Claude Code on the server), `expired` (the access token elapsed;
  running any Claude session refreshes it) or `malformed`. The OAuth token
  itself is never returned by this or any other endpoint.
- `GET /ws/voice/stream?language=&keyterms=` (WebSocket, not under `/api`)
  relays one dictation. Client sends binary frames of signed 16-bit
  little-endian PCM, 16 kHz mono (<= 64 KB per frame), plus JSON control frames
  `{"t":"finalize"}` (ask for the final transcript) and `{"t":"stop"}`. Server
  sends `{"t":"ready"}`, `{"t":"transcript","text","final"}` (each frame is the
  WHOLE running transcript, not a delta), `{"t":"error","message"}` and
  `{"t":"closed"}`. Close codes: `4003` disallowed Host/Origin, `4004`
  unavailable (reason in the close reason), `4008` too many concurrent streams.
  Streams are capped in count and length (`src/config/voice.ts`).

## Authentication

Optional HTTP Basic (`CODEMAN_USERNAME`/`CODEMAN_PASSWORD`) → opaque
`codeman_session` cookie. When enabled, unauthenticated requests get
`401 UNAUTHORIZED`; rate-limited requests get `429 RATE_LIMITED`. See
[`security-architecture.md`](security-architecture.md).

## SSE event channel

`GET /api/events` is a Server-Sent Events stream (`text/event-stream`); each
message is `event: <name>` + `data: <json>`. The event-name registry
(`src/web/sse-events.ts`, mirrored in `src/web/public/constants.js`) is part of
the stable contract — event names are not renamed without a major bump. An
optional `?sessions=<id,...>` filter suppresses only the high-volume terminal
stream; lifecycle/metadata events are delivered to all clients regardless.

### `sse:heartbeat` (liveness)

Every 15s the server writes a `sse:heartbeat` frame to every connected client:

```
event: sse:heartbeat
data: {"t":1755100000000}
```

`t` is the server's epoch-ms timestamp at write time. The frame carries no
application state and can be ignored for correctness. It exists so a client can
tell a live stream from a dead one: an `EventSource` whose connection has been
idle-closed by a proxy (or that resumed from sleep on a stale socket) keeps
delivering nothing without ever firing `onerror`. Clients that care should treat
silence longer than about three intervals as a dead stream and reconnect, which
is what the bundled frontend does.

This replaced a `:keepalive` SSE **comment**, which served the same
proxy-flushing purpose but is invisible to `EventSource` by spec and so could
never be observed by a client. Consumers written against the old behavior are
unaffected: `EventSource` dispatches only events that have a registered
listener, so an unknown event name is dropped.

## Consuming from JavaScript

The bundled frontend reads responses through `_apiJson()`
(`src/web/public/api-client.js`), which unwraps `{success:true,data}` → `data` and
returns `null` on a non-2xx / `{success:false}` response. External clients should
do the same: check the HTTP status (or `body.success`), then read `body.data`.
