# Agent Control Plan: skill packaging + wait primitives

**Status**: steps 1 to 8 DONE and RELEASED. The wait primitives and the skill itself
(steps 1 to 5) shipped in **1.13.0**; the `codeman skill install` CLI, per-case injection
and `agentSkillEnabled` (step 6) shipped in **1.14.1** and were republished with fixes in
**1.14.2**. Steps 1 to 5 were multi-round verified on 2026-08-08, step 6 on 2026-08-09;
see [§7 Build log](#7-build-log-what-actually-happened) for what shipped, what each
verification round found, and the two items that genuinely remain open (§2.4's footgun
guard and the Part 3 deferrals).

**Date**: 2026-08-08
**Scope**: Part 1 (agent skill) and Part 2 (wait primitives) were specified and built.
Parts 3 to 5 are captured so they are not lost, but remain deliberately deferred.

---

## 0. Where this came from: what herdr does

[herdr](https://github.com/herdrdev/herdr) (Rust, Apache-2.0, ~25.8k stars) is a terminal
multiplexer built around AI coding agents. Relevant findings from the research pass:

| Capability      | How herdr does it                                                                                                                                                                                                             |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Agent state     | Four states (`idle`, `working`, `blocked`, `done`) that roll up pane to tab to workspace in a sidebar                                                                                                                         |
| Detection       | Lifecycle hooks where the agent supports them (it names Pi and MastraCode), otherwise TOML manifests matched against a live bottom-buffer snapshot. Bundled manifests plus remote updates from herdr.dev, local overrides win |
| Control API     | Newline-delimited JSON over a Unix socket (`~/.config/herdr/sessions/<name>/herdr.sock`), `{"id":"req_1","method":"pane.split","params":{}}`, dot-notation methods, plus long-lived event subscriptions                       |
| Discoverability | `herdr api schema` prints a machine-readable schema                                                                                                                                                                           |
| Agent skill     | `npx skills add herdrdev/herdr --skill herdr -g`, a SKILL.md wrapping the CLI, guarded by `test "${HERDR_ENV:-}" = 1` so an agent outside a herdr pane refuses to act                                                         |
| Persistence     | Background server, detach with `ctrl+b q`, snapshot restore of workspaces/tabs/panes/cwd/layout, experimental screen-history replay, agent resume via native session ids, live PTY handoff across server replacement          |
| Plugins         | `herdr-plugin.toml` manifest, actions, event hooks, plugin panes, link handlers, GitHub-topic marketplace index                                                                                                               |

The commands the skill teaches the agent:

| Group     | Commands                                                                                                                                                                                                                                                |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| workspace | `workspace list`, `workspace create`                                                                                                                                                                                                                    |
| tab       | `tab list --workspace <id>`, `tab create`                                                                                                                                                                                                               |
| pane      | `pane current`, `pane list`, `pane layout`, `pane split --current --direction right --cwd <path> --no-focus`, `pane run <id> "<cmd>"`, `pane wait-output <id> --match/--regex <p> --timeout <ms>`, `pane read <id> --source visible\|recent\|detection` |
| agent     | `agent list`, `agent start <name> --kind <type> --pane <id>`, `agent prompt <name> "<text>" --wait --timeout <ms>`, `agent wait <name> --until <state> --timeout <ms>`, `agent send-keys`, `agent get`, `agent read`                                    |

### The honest comparison

herdr and Codeman are not the same product. herdr is a local, keyboard-first multiplexer with
no server, no web UI, and no autonomy layer. Codeman is a server with a browser and mobile UI,
remote and Docker cases, respawn, Ralph, cron, and the orchestrator, none of which herdr has.

What herdr genuinely does better is being **callable by the agent running inside it**. For
Codeman that is a packaging problem plus one missing primitive, not an architecture problem.

---

## 1. Gap analysis

| herdr capability             | Codeman equivalent today                                                                                           | Gap                                                                                   |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| `pane split` + `agent start` | `POST /api/quick-start`, `POST /api/sessions`                                                                      | none, already there                                                                   |
| `agent prompt`               | `POST /api/sessions/:id/input` with `clientId`+`seq` exactly-once                                                  | no `--wait`                                                                           |
| `pane read`                  | `GET /api/sessions/:id/output`, `GET /api/sessions/:id/terminal?full=1`                                            | none                                                                                  |
| `agent list` / `agent get`   | `GET /api/sessions`, `GET /api/sessions/unified`, `GET /api/status`                                                | none                                                                                  |
| `agent wait --until <state>` | SSE only (`/api/events`)                                                                                           | **missing**, and SSE is impractical from a shell tool                                 |
| `pane wait-output --match`   | nothing                                                                                                            | **missing**                                                                           |
| Skill file                   | README section "Driving Codeman from an Agent"                                                                     | **not packaged**, an agent will never find it                                         |
| Env guard `HERDR_ENV=1`      | `CODEMAN_MUX=1`, `CODEMAN_API_URL`, `CODEMAN_SESSION_ID` already exported at spawn                                 | none, the guard variables exist                                                       |
| `blocked` state              | hook events (`permission_prompt`, `elicitation_dialog`) plus CSS classes plus the phone overview NEEDS YOU section | not in the wire contract (`SessionStatus = 'idle' \| 'busy' \| 'stopped' \| 'error'`) |
| `api schema`                 | hand-written `docs/api-reference.md`                                                                               | no machine-readable schema                                                            |
| Detection manifests          | hardcoded in `usage-limit-patterns.ts`, `respawn-*-patterns`, `regex-patterns.ts`                                  | patterns are code, not data                                                           |
| Plugin runtime               | deliberately refused, see `docs/extending-codeman.md`                                                              | not a gap, a decision                                                                 |
| Session handoff on restart   | tmux owns the PTYs, so they already survive a Codeman restart                                                      | not a gap, solved by architecture                                                     |

**Conclusion**: roughly 90% of the capability surface already exists. Parts 1 and 2 below close
the two real gaps.

The table is the 2026-08-08 snapshot that motivated the work, kept as written. The three rows
marked missing are closed since: `GET .../wait` and `GET .../wait-output` shipped in 1.13.0, and
the skill is packaged at `skills/codeman` (npm tarball included). `blocked` as a wire-contract
state, and the machine-readable schema, are still open (Parts 3 and 4).

---

## 2. Part 1: the Codeman agent skill

### 2.1 Goal

An agent running inside a Codeman session can discover and correctly drive Codeman without the
user pasting API docs into the prompt, and without inventing dangerous calls.

### 2.2 Layout and distribution

The `npx skills` CLI (vercel-labs/skills) clones a GitHub repo and looks for
`skills/<name>/SKILL.md`. Claude Code natively discovers `.claude/skills/<name>/SKILL.md` in a
project and `~/.claude/skills/` globally. Both are satisfied with one source of truth plus a
symlink, which is the pattern this repo already uses for `remotion-best-practices`.

```
skills/
  codeman/
    SKILL.md            <- single source of truth
    reference/
      endpoints.md      <- full endpoint tables, loaded on demand
      recipes.md        <- worked multi-session orchestration examples
.claude/skills/codeman -> ../../skills/codeman     (symlink, dogfooding in this repo)
```

Adding a `skills/` directory to the repo root costs one entry in the GitHub listing. CLAUDE.md
keeps the root short on purpose, so this needs a conscious sign-off; the alternative is
`docs/skills/codeman/` with a `--skill` path argument, which breaks the one-liner install.
**Recommendation**: accept `skills/` at the root, because the install one-liner is the whole
point of shipping a skill.

Install paths, in order of how a user gets it:

1. `npx skills add Ark0N/Codeman --skill codeman -g` (global, any agent, matches the herdr flow).
2. `codeman skill install [--global | --case <name>]`, a new CLI subcommand writing the same
   file. This is the path for users who installed via npm and never cloned the repo.
3. **Automatic per-case injection**, modeled exactly on `applyStatusLineConfig(casePath, enabled)`
   in `hooks-config.ts`: write `<case>/.claude/skills/codeman/SKILL.md` at case creation,
   gated on a new setting. Codeman already writes `<case>/.claude/settings.local.json` hooks
   through `writeHooksConfig()`, so this is the same mechanism with the same lifecycle.

Setting name: `agentSkillEnabled`. Synced (not per-device), since it changes on-disk case
content rather than display. Default: **ON after the dogfooding phase, OFF in the first
release**. Rationale for starting OFF: Claude Code loads every skill's name and description
into context on every turn, so an always-on skill has a small permanent token cost, and we
should measure that we are buying something with it first.

### 2.3 SKILL.md content

Frontmatter, per the skills convention (`name` + `description` required):

```yaml
---
name: codeman
description: >-
  Control Codeman, the session manager this agent is running inside: list sessions,
  start worker sessions, send prompts, read terminal output, and wait for other agents
  to finish. Only usable when CODEMAN_MUX=1.
---
```

Body sections, in order:

**1. Guard (first thing, non-negotiable).**

```bash
test "${CODEMAN_MUX:-}" = 1 || { echo "not inside a Codeman session"; exit 1; }
API="${CODEMAN_API_URL:?CODEMAN_API_URL not set, refusing to guess}"
SELF="${CODEMAN_SESSION_ID:-}"
```

If `CODEMAN_MUX` is not `1`, the agent must stop and say it is not running inside a
Codeman-managed session. Same shape as herdr's `HERDR_ENV` guard, and the variables are
already exported by `tmux-manager.buildEnvExports()`. No fallback URL when
`CODEMAN_API_URL` is unset: any guess is the wrong scheme on an HTTPS install (prod is
HTTPS with a self-signed cert, hence `curl -sk` throughout), and a server the agent
cannot identify is not one it should be driving.

**2. Rules of the road.** Lifted and tightened from README lines 666 to 745:

- Single-line input only. Multi-line breaks the agent TUI (Ink).
- Always send `clientId` + a monotonic `seq` on `POST .../input` so a retry cannot double-deliver.
- Envelope is `{success, data}`; a few legacy GETs are bare, so read `body.data ?? body`.
- Add `-u admin:"$CODEMAN_PASSWORD"` when a password is set. Prod is HTTPS, so `curl -sk`.
- Prefer `/api/v1/*`, the stable alias.

**3. Safety rules (the section that does not exist anywhere today).**

- Never act on `$CODEMAN_SESSION_ID`. That is you.
- Only `DELETE` sessions **you created in this conversation**, by exact id. Keep the list.
- Never bulk-delete, never loop a `DELETE` over `/api/sessions`. There is no undo.
- Never `tmux kill-session`, `pkill tmux`, `pkill claude`. Use the API.
- Creating a session consumes a slot against the 50-session cap. Clean up what you start.

**4. Recipes**, each one a single copy-pasteable curl:

| Task                 | Call                                                                                                                                                                    |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| list sessions        | `GET /api/v1/sessions`                                                                                                                                                  |
| find yourself        | match ids by PREFIX of `$CODEMAN_SESSION_ID` (Docker cases truncate it to 8 chars, so an equality check never fires there)                                              |
| start a worker       | `POST /api/v1/quick-start {caseName, mode, effort}`                                                                                                                     |
| send a prompt        | `POST /api/v1/sessions/:id/input {input:"…\r", useMux:true, clientId, seq}` (the trailing `\r` is what sends Enter; without it the text sits on the prompt unsubmitted) |
| send prompt and wait | `POST /api/v1/sessions/:id/input {input:"…\r", wait:"stop", waitTimeout:600000}` (Part 2)                                                                               |
| wait for a worker    | `GET /api/v1/sessions/:id/wait?until=stop,blocked&timeout=300000` (Part 2)                                                                                              |
| wait for a marker    | `GET /api/v1/sessions/:id/wait-output?match=DONE_<random>&timeout=120000` (Part 2; unique per call, per §3.3's repaint rule)                                            |
| read output          | `GET /api/v1/sessions/:id/output`                                                                                                                                       |
| read full scrollback | `GET /api/v1/sessions/:id/terminal?full=1`                                                                                                                              |
| watch sub-agents     | `GET /api/v1/subagents`                                                                                                                                                 |
| schedule work        | `POST /api/v1/cron/jobs`                                                                                                                                                |
| clean up             | `DELETE /api/v1/sessions/:id`                                                                                                                                           |

**5. Pointer to `reference/endpoints.md`** for anything not in the table, so the always-loaded
part of the skill stays small.

### 2.4 An ergonomics guard worth adding server-side

The skill will tell the agent not to act on itself, but a confused agent can still try. Propose:
the skill sends `X-Codeman-Caller-Session: $CODEMAN_SESSION_ID` on every request, and the server
refuses destructive operations (`DELETE /api/sessions/:id`, kill, respawn stop) when that header
equals the target id, with a clear error.

This is a **footgun guard, not a security control**: any caller can omit the header. Document it
as such so nobody mistakes it for a boundary. It costs about 10 lines in `route-helpers.ts`.

### 2.5 Verification

Per the always-end-to-end-test rule, "the skill exists" is not done. Done is:

1. Symlink it into `.claude/skills/`, start a real throwaway Codeman session, and ask that agent
   to "start a worker session that runs the test suite and tell me when it finishes".
2. Confirm from the outside that exactly one new session appeared, got the prompt, and that the
   lead agent waited rather than polling in a busy loop.
3. Confirm the guard: run the same prompt in a shell with `CODEMAN_MUX` unset and confirm refusal.
4. Confirm cleanup: the worker session is deleted by exact id and no other session was touched.

Never run this against `w1`/`w2`/`w3`.

### 2.6 Files touched

- `skills/codeman/SKILL.md` (new), `skills/codeman/reference/*.md` (new)
- `.claude/skills/codeman` symlink (new)
- `src/cli.ts` (new `skill install` subcommand)
- `src/hooks-config.ts` (new `applyAgentSkill(casePath, enabled)`, mirroring `applyStatusLineConfig`)
- `src/web/schemas.ts` (`agentSkillEnabled` in `SettingsUpdateSchema`, which is `.strict()`)
- `src/web/routes/system-routes.ts` (settings PUT must resolve the flag from `merged`, never
  from the raw body, per the partial-PUT invariant)
- `src/web/public/settings-ui.js` + `index.html` (checkbox)
- `package.json` `files` array, so `skills/` ships to npm
- README pointer, `docs/extending-codeman.md` seam 3 pointer

---

## 3. Part 2: wait primitives

### 3.1 Goal

Make Codeman orchestratable from a shell tool. Today the only "tell me when" channel is SSE,
which a curl-driven agent cannot practically consume: it would have to hold a streaming
connection and parse events inline. herdr solves this with blocking CLI calls. Codeman should
solve it with bounded long-poll endpoints.

All three additions are **additive**, so the versioning policy stays intact (new endpoints and
new optional fields are non-breaking).

### 3.2 The signal model

A waiter resolves on the first of a set of signals. Sources that already exist:

| Signal    | Source today                                                                                                                                  |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `idle`    | `Session` emits `idle` (session.ts ~1775 for Claude, ~2101 for shell), wired at `session-listener-wiring.ts:402`                              |
| `working` | `Session` emits `working` (session.ts ~1788), wired at `session-listener-wiring.ts:401`                                                       |
| `stop`    | `POST /api/hook-event` with `event: 'stop'`, the definitive "Claude finished responding" signal already used by `controller.signalStopHook()` |
| `blocked` | `POST /api/hook-event` with `permission_prompt` or `elicitation_dialog`                                                                       |
| `exit`    | `Session` emits `exit`                                                                                                                        |

`stop` is the highest-quality signal for "the turn is over" and should be the documented default
for orchestration. `idle` is heuristic: output stabilization plus prompt detection, and it can
flap mid-turn when a spinner pauses. External CLI modes (`isExternalCliMode()`) have no stop
hook at all, so for opencode/codex/gemini/antigravity only `idle`, `working` and `exit` are
available. **The skill and the docs must say which signals exist per mode**, otherwise an agent
waits forever on `stop` in a codex session.

### 3.3 Endpoint specs

#### A. `GET /api/sessions/:id/wait`

| Param     | Type                                           | Default          | Notes                                                        |
| --------- | ---------------------------------------------- | ---------------- | ------------------------------------------------------------ |
| `until`   | comma list of `idle,working,stop,blocked,exit` | `stop,idle,exit` | resolves on first match                                      |
| `timeout` | ms                                             | 60000            | clamped to `MAX_WAIT_MS` (600000)                            |
| `fresh`   | `0`/`1`                                        | `0`              | `1` requires a _transition_, ignoring the state at call time |

Response (always 200 unless the session is missing or a cap is hit):

```json
{
  "success": true,
  "data": {
    "signal": "stop",
    "timedOut": false,
    "immediate": false,
    "ended": false,
    "waitedMs": 8421,
    "status": "idle",
    "sessionId": "...",
    "until": ["stop", "idle", "exit"],
    "limitPaused": false
  }
}
```

`until` is echoed back because the server may narrow it: `stop`/`blocked` are dropped
from the DEFAULT set for external CLI modes (asking for them EXPLICITLY is a 400
instead, since omitting `until` must never 400). `limitPaused` tells a caller that a
timeout was expected rather than a stall worth retrying hard.

**A timeout is not an error.** `{"timedOut": true, "signal": null}` with HTTP 200, so a caller
can loop without treating every poll boundary as a failure. Errors are reserved for
`NOT_FOUND` (unknown or not-owned session) and `SESSION_BUSY` (waiter cap exceeded).

`immediate: true` means the session was already in the requested state and `fresh` was not set.

#### B. `GET /api/sessions/:id/wait-output`

| Param     | Type                           | Default  | Notes                                                     |
| --------- | ------------------------------ | -------- | --------------------------------------------------------- |
| `match`   | literal string, 1 to 200 chars | required | substring match against ANSI-stripped output              |
| `nocase`  | `0`/`1`                        | `0`      | case-insensitive compare                                  |
| `from`    | `now` \| `buffer`              | `now`    | `buffer` scans the existing text buffer first, then waits |
| `timeout` | ms                             | 60000    | clamped to `MAX_WAIT_MS`                                  |

Response: `{ matched: true, timedOut: false, snippet: "...", waitedMs }`.

**No regex in v1, deliberately.** `search-service.ts` already avoids regex specifically so there
is no ReDoS surface, and this endpoint would be even more exposed since the pattern is attacker
supplied and the input is a live stream. herdr can offer `--regex` because Rust's regex crate is
linear-time with no backtracking; JS `RegExp` is not. If regex is wanted later, the honest
options are a length-capped subset compiled once with a match budget, or `re2`. Note it and move on.

Implementation detail that will bite if missed: a match can straddle two PTY chunks. Keep a
carry buffer of `match.length - 1` bytes from the previous chunk and test `carry + chunk`.

⚠️ **`from=now` does not mean "printed after you asked".** tmux repaints the visible
screen on attach, resize, or any TUI redraw, and a repaint arrives as ordinary `terminal`
data. Observed live: a marker echoed a minute earlier matched instantly on a fresh
`from=now` wait. This is inherent to a terminal multiplexer, not fixable in the registry,
so the contract is: **use a marker unique per call** (`echo DONE_$RANDOM`), never a
generic one like `BUILD OK`. The skill's recipes must show that.

The returned snippet is whitespace-collapsed (blank runs to a single newline) for
readability only; matching runs on the raw stripped text. Without it, a real pane's
`\r\n` padding between the prompt and the match fills the whole context window with
nothing, which was the first thing the live test showed.

#### C. `wait` on the existing input endpoint

`POST /api/sessions/:id/input` gains two optional fields:

```json
{ "input": "run the tests\r", "useMux": true, "clientId": "agent-1", "seq": 7, "wait": "stop", "waitTimeout": 600000 }
```

(The trailing `\r` is required on every input body: `sendInput` sends Enter only
when the input contains a carriage return.)

Response gains `"wait": { "signal": "stop", "timedOut": false, "waitedMs": 41230 }`.

This is the important one, because it closes a race the standalone `GET .../wait` cannot: between
"input delivered" and "session flips to working" there is a window where a naive
send-then-wait sees the _pre-existing_ idle state and returns instantly. The combined endpoint
**registers the waiter before writing**, so that window does not exist. This is exactly why herdr
ships `agent prompt --wait` as its own thing.

`wait` accepts `true` (the default signal set) or the same comma grammar as `until`.
Both new fields are `.nullish()`, not `.optional()`: a third-party caller building the
body with `JSON.stringify` keeps an explicit `null` on the wire, and `.optional()`
rejects that with `INVALID_INPUT`. That gotcha has shipped as a real bug twice.

Two behaviors to preserve carefully:

- **`useMux` is fire-and-forget today.** The handler responds without awaiting `writeViaMux`, on
  purpose (a tmux child process must not block the HTTP response). With `wait` present the
  handler already has to stay open, so it can await delivery, and a `writeViaMux` failure becomes
  observable for the first time. The non-wait path must keep its current fire-and-forget shape
  byte for byte.
- **Duplicate suppression.** A tagged redelivery (`clientId`+`seq` already applied) returns 200
  without writing. With `wait` set it still waits, since the caller's intent is "tell me when
  this settles". But it waits with `requireTransition: false`, unlike a fresh delivery: the
  original turn may be long over, and requiring a new transition would block a redelivery until
  timeout for no reason. Fresh delivery requires a transition, a duplicate answers from the
  current state.
- **Capacity rollback.** `shouldApplyInput()` MUTATES (it records the seq), and it runs before
  the waiter is registered. If registration then fails on a full pool, the handler must call
  `forgetInputSeq` before returning `SESSION_BUSY`, or the caller's retry is rejected as a
  duplicate and the input is lost by the very mechanism reliable delivery exists for.

### 3.4 Module design

New file `src/web/session-wait-registry.ts`, with the IO-free core unit-testable in isolation
(same split as `self-update.ts`):

```ts
type WaitSignal = 'idle' | 'working' | 'stop' | 'blocked' | 'exit';

waitForSignal(sessionId, { until: Set<WaitSignal>, timeoutMs, requireTransition }): Promise<WaitResult>
notifySignal(sessionId, signal: WaitSignal): void
waitForOutput(sessionId, { match, nocase, timeoutMs }): Promise<OutputWaitResult>
notifyOutput(sessionId, chunk: string): void
cancelAll(sessionId, reason): void
```

Wiring points, all existing:

- `src/web/session-listener-wiring.ts` around lines 190 and 200 already handles `working` and
  `idle` and broadcasts them. Add a `notifySignal()` call next to each broadcast, plus `exit`.
- `src/web/routes/hook-event-routes.ts` already switches on `event` for the respawn controller.
  Add `notifySignal(sessionId, 'stop' | 'blocked')` in the same switch.
- Output: `notifyOutput()` rides the ALREADY-attached `terminal` listener in
  session-listener-wiring.ts. An earlier draft had the registry hand out attach/detach
  callbacks so a listener could be added lazily; that was deleted once it was clear no
  second listener is needed at all. The cost is one Map lookup per PTY chunk, which is why
  the no-waiter check comes before the ANSI strip.
- Session deletion calls `notifySignal('exit')` then `cancelAll()`, so no promise is left
  hanging. Both are required: `_doCleanupSession` detaches the session's listeners BEFORE
  `session.stop()`, so on a delete the PTY exit event never reaches the registry, and an
  `until=exit` caller would otherwise get a bare `ended` instead of its signal. Found by
  live-testing the delete path, not by the unit tests.

Memory-leak discipline, per the 24-hour-session rules: every waiter owns a timer that is cleared
on resolve, the per-session waiter set is deleted when it empties, and the output listener is
removed with it. `test/memory-leak-prevention.test.ts` should grow a case for this.

Caps in a new `src/config/agent-wait.ts` (limits live in `src/config/`, env-overridable):

| Constant                  | Default | Why                                     |
| ------------------------- | ------- | --------------------------------------- |
| `MAX_WAIT_MS`             | 600000  | an unbounded long-poll is a socket leak |
| `DEFAULT_WAIT_MS`         | 60000   | short enough to survive most proxies    |
| `MAX_WAITERS_PER_SESSION` | 16      |                                         |
| `MAX_WAITERS_TOTAL`       | 128     | same reasoning as `MAX_SSE_CLIENTS`     |

Exceeding a cap returns `SESSION_BUSY`, not a silent queue.

### 3.5 Transport concerns

Fastify is constructed with defaults in `server.ts:329-331`. `requestTimeout` defaults to 0
(disabled) and `keepAliveTimeout` (72s) applies between requests, not to an in-flight one, so a
10-minute in-process hold is fine. **Verify this on the real instance before relying on it.**

Intermediaries are the actual risk. Prod is reached through `tailscale serve`, and users also run
cloudflared tunnels; both can cut an idle connection. That is why `DEFAULT_WAIT_MS` is 60s and
why the documented pattern is a client-side loop over short waits rather than one 10-minute call.
The skill's recipes must show the loop.

### 3.6 Edge cases to get right

| Case                            | Behavior                                                                                                                                                                                                    |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Session already idle, `fresh=0` | return immediately, `immediate: true`                                                                                                                                                                       |
| Session already idle, `fresh=1` | wait for the next transition into a requested state                                                                                                                                                         |
| Session dies mid-wait           | resolve with `signal: "exit"` if `exit` was requested, otherwise resolve `timedOut:false, signal:null, ended:true`. Never hang                                                                              |
| Session deleted mid-wait        | same, resolve, do not throw. Verified live: `until=exit` gets `signal:"exit"`, a concurrent `until=blocked` gets `ended:true`, both in ~0ms                                                                 |
| Shutdown with a wait pending    | `cancelEverything()` in `stop()`. Verified live: SIGTERM with a 300s wait in flight exits in 1s                                                                                                             |
| External CLI mode               | `stop` and `blocked` never fire. Reject `until=stop` for those modes with a clear `INVALID_INPUT` rather than hanging until timeout                                                                         |
| Multi-user                      | goes through `findSessionOrFail(ctx, id, req)`, which already enforces ownership                                                                                                                            |
| Remote / Docker cases           | signals originate from the same `Session` object, so no special casing. Docker hooks need `CODEMAN_DOCKER_BRIDGE_HOOKS=1` for `stop`/`blocked` to arrive at all; without it, only `idle` works. Document it |
| Respawn `/clear` mid-wait       | a respawn cycle emits `idle`. Callers waiting on `stop` are unaffected; callers on `idle` may resolve early. Documented, not fixed                                                                          |
| Limit pause                     | if the session is paused on a usage limit, nothing will fire until the reset. The wait times out honestly. Consider surfacing `limitPaused: true` in the response so the caller can back off                |

### 3.7 Tests

- `test/session-wait-registry.test.ts` (pure): immediate resolve, transition-required, multi-signal
  first-wins, timeout, cap exceeded, cancel on session end, no listener leak after resolve,
  chunk-straddling output match, case-insensitive match.
- `test/routes/session-wait-routes.test.ts` (`app.inject()`, no port): all three endpoints against
  a `MockSession`, including the 200-with-`timedOut` contract and the ownership 404.
- `test/routes/session-input-wait.test.ts`: the send-and-wait race, plus proof that the non-wait
  path is unchanged (still returns before `writeViaMux` settles).
- Live verification on a throwaway session before COM, per the always-end-to-end-test rule.

### 3.8 Files touched

- `src/config/agent-wait.ts` (new)
- `src/web/session-wait-registry.ts` (new)
- `src/web/session-listener-wiring.ts` (notify on idle/working/exit)
- `src/web/routes/hook-event-routes.ts` (notify on stop/blocked)
- `src/web/routes/session-routes.ts` (two new routes, `wait` fields on input)
- `src/web/schemas.ts` (`SessionWaitQuerySchema`, `SessionWaitOutputQuerySchema`, extend
  `SessionInputWithLimitSchema`. Note: `.optional()` rejects `null`, so the frontend and any
  generated client must send `undefined`, never `null`)
- `docs/api-reference.md`, `docs/extending-codeman.md`, README API table
- `skills/codeman/SKILL.md` recipes (Part 1 depends on this)

---

## 4. Deferred: parts 3 to 5

Not in scope now, kept here so they are not lost.

### Part 3: promote `blocked` to a first-class state

`SessionStatus` is `'idle' | 'busy' | 'stopped' | 'error'`. "Needs you" exists three times over:
hook events, the `tab-alert-action` CSS class, and the phone overview NEEDS YOU section, each
re-deriving it. herdr makes `blocked` a real state that rolls up.

Add `blocked` (and possibly `done`) to `SessionStatus`, set it from the same hook events that
Part 2 uses as wait signals, and clear it on the next `working`/`stop`. Then the tab strip, the
mobile overview, the wait endpoints, and any external agent read one field.

Cost: `SessionStatus` is a widely-consumed union, so every exhaustive `switch` (the codebase has
`assertNever` and `noFallthroughCasesInSwitch`) will need a branch. That is a feature, it makes
the compiler find every site. This is a **minor** bump, not a patch: it widens a public type in
the HTTP contract.

### Part 4: `GET /api/schema`

herdr ships `herdr api schema`. Every Codeman route is already Zod-validated, so
`zod-to-json-schema` over `schemas.ts` gives a self-describing API almost free. Value: third-party
tools and the skill stop drifting from hand-written docs. Open question: whether to emit full
OpenAPI (`@fastify/swagger` would need per-route schema registration, which is a much larger
change) or just dump the Zod schemas keyed by name (cheap, 80% of the value).

### Part 5: detection manifests instead of hardcoded patterns

CLI-specific readiness, blocked and usage-limit patterns live in code across
`usage-limit-patterns.ts`, the respawn pattern helpers and `regex-patterns.ts`. Externalizing the
per-CLI ones into data files would make adding a sixth CLI a data change instead of a code change.

**Do not copy the remote-update part.** herdr auto-fetches manifest updates from herdr.dev.
Codeman auto-pulling behavioral rules from a vendor server contradicts its security posture.
Bundled manifests plus local override only, no network.

### Explicit non-goals

- **Plugin runtime and marketplace.** `docs/extending-codeman.md` already argues this: a plugin
  runtime means third-party code inside a process that spawns agents with your credentials, on a
  server people expose over a tunnel. The reasoning still holds. If the marketplace _pattern_ is
  wanted, apply it to data (web tabs, case templates, cron recipes), never to executable code.
- **Live PTY handoff on restart.** herdr needs it because it owns the terminals. Codeman
  delegates to tmux, so PTYs already survive a self-update restart.
- **Socket API.** HTTP plus SSE is the existing, documented, stable contract. A second transport
  would double the surface for no capability gain.

---

## 5. Sequencing

| Step | Work                                                                            | Gate                                                                                                                                                                                                                                                                                                                                         |
| ---- | ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 ✅ | `src/config/agent-wait.ts` + `session-wait-registry.ts` + unit tests            | 48 tests green                                                                                                                                                                                                                                                                                                                               |
| 2 ✅ | `GET .../wait` + wiring in listener-wiring, hook-event-routes, server teardown  | 15 route tests green; live-verified on an isolated `CODEMAN_INSTANCE=waittest` instance (immediate resolve, 400 on a bad signal, 200+`timedOut` on timeout, hook `stop` and `permission_prompt`→`blocked` waking an in-flight wait, delete delivering `exit`, SIGTERM not blocked); full `test:ci` sweep green                               |
| 3 ✅ | `GET .../wait-output`                                                           | 16 route tests green; live-verified on real PTY bytes (`echo MARKER` waking a blocked request in ~1s, `from=buffer` immediate hit, never-seen marker timing out at exactly 2001ms, nocase, `regex` refused with a 400); full `test:ci` sweep green                                                                                           |
| 4 ✅ | `wait` field on `POST .../input`, non-wait path proven unchanged                | 16 route tests green; live-verified (no-wait returns in 26ms with the historical bare body; an idle session did NOT satisfy a `wait` request, blocking the full 2001ms, which is the race the endpoint exists to close; the stop hook resolved a send-and-wait at 1510ms and the input was confirmed in the tmux pane; `wait:null` accepted) |
| 5 ✅ | `skills/codeman/SKILL.md` + reference files + `.claude/skills` symlink          | live dogfood: a real session orchestrates a worker end to end                                                                                                                                                                                                                                                                                |
| 6 ✅ | `codeman skill install` CLI + `applyAgentSkill()` + `agentSkillEnabled` setting | 10 unit tests (`test/agent-skill.test.ts`) + real-server case-creation tests (`test/quick-start.test.ts`, incl. the settings PUT accepting the key) green; CLI verified live (install/uninstall, global + `--case`, foreign/symlink refusals)                                                                                                 |
| 7 ✅ | Docs: api-reference, extending-codeman, README                                  | plus `architecture-invariants.md` (§agent-wait-primitives), `CLAUDE.md` and the API reference's per-mode signal table                                                                                                                                                                                                                        |
| 8 ✅ | COM (minor bump: new endpoints, new setting, new optional fields)               | released as 1.13.0 (wait primitives + skill); step 6 followed in 1.14.1 and was republished as 1.14.2 after live-testing the packaged skill                                                                                                                                                                                                  |

Parts 1 and 2 are independent enough to land separately, but the skill is much less useful
without the wait endpoints, so the wait work goes first.

## 6. Open questions for the owner

1. ✅ `skills/` at the repo root: accepted (built that way; the install one-liner depends on it).
2. ✅ `agentSkillEnabled` default: **OFF** for the first release, per §2.2's rationale (skills
   cost context on every turn; measure before defaulting on). Flip later if dogfooding earns it.
3. ✅ Both: global install via `npx skills add` / `codeman skill install`, AND per-case
   auto-injection behind the (default-off) setting. Injection is add-only at session create and
   marker-guarded, so a user-authored copy is never touched.
4. Is `X-Codeman-Caller-Session` self-protection worth the 10 lines, given it is a footgun guard
   and not a security boundary? (Still open, not built with step 6.)
5. ✅ Regex support in `wait-output`: literal-only shipped, and a `regex` query param is
   rejected with a 400 rather than ignored, so an agent that assumed otherwise cannot
   silently wait on the wrong thing.

---

## 7. Build log: what actually happened

Written at the end of the build so the next person inherits the reasoning, not just the
diff. Process artifacts (per-agent briefs, findings, reports) live in the gitignored
`tmp/agent-wait-review/`; this section is the part worth keeping.

### What shipped

| Piece                                                                           | Files                                                                                                                              |
| ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Bounds + clamping                                                               | `src/config/agent-wait.ts` (new)                                                                                                   |
| Blocking-wait registry                                                          | `src/web/session-wait-registry.ts` (new, IO-free, unit-tested)                                                                     |
| `GET .../wait`, `GET .../wait-output`, `wait`/`waitTimeout` on `POST .../input` | `src/web/routes/session-routes.ts`                                                                                                 |
| Signal wiring                                                                   | `session-listener-wiring.ts` (idle/working/exit + output), `hook-event-routes.ts` (stop/blocked), `server.ts` (teardown, shutdown) |
| Agent skill                                                                     | `skills/codeman/SKILL.md` + `reference/`, `.claude/skills/codeman` symlink, `package.json` `files`                                 |
| Docs                                                                            | `api-reference.md`, `extending-codeman.md`, `architecture-invariants.md`, `README.md`, `CLAUDE.md`                                 |
| Tests                                                                           | `test/session-wait-registry.test.ts`, three `test/routes/session-*wait*.test.ts`, `http-contract.test.ts`, `mock-session.ts`       |

### Bugs found in ADJACENT code, not in the new feature

These are the highest-value output of the exercise and none were on the plan:

1. **Every Codeman hook was dead on HTTPS installs.** `hooks-config.ts` built the hook
   curl as `curl -s` with no `-k` while the statusline exporter 300 lines below used
   `curl -sk` and documented why. Proven with the real hook command: `curl exit=60`
   without the flag, success with it, and the failure swallowed by the hook's own
   `2>/dev/null || true`. This silently killed `stop`, `permission_prompt`,
   `elicitation_dialog`, `idle_prompt`, `teammate_idle` and `task_completed`, taking
   respawn's definitive idle signals with them. Fixed, **plus** a staleness detector in
   `refreshStaleCodemanHooks` that regenerates the on-disk config of already-created
   cases (23 of 26 local cases carried the broken form; fixing the generator alone would
   have left every one of them broken).
2. **`buildEnvExports()` exported a wrong-scheme `CODEMAN_API_URL`** (`http://` fallback
   on an HTTPS install). Now omitted rather than guessed, so in-session guards fail closed.
3. **Programmatic input is only submitted when it contains `\r`.** `sendInput` sends Enter
   only if the payload has a carriage return; without it the text sits in the composer
   forever. Bit this build repeatedly before it was diagnosed, and had leaked into the
   docs' own examples.

### Design decisions worth not re-litigating

- **A timeout is HTTP 200** with `wait.timedOut`, never a 4xx: callers loop over short
  waits because tunnels cut idle connections, and every poll boundary would otherwise be
  indistinguishable from failure.
- **Send-and-wait must be one endpoint.** A separate POST-then-wait races: between the
  write and the flip to `working`, a wait sees the stale `idle` and reports the PREVIOUS
  turn as this one. The waiter is registered before the write.
- **`stop`/`blocked` exist for `claude` mode only.** They come from Claude Code hooks;
  `shell` installs none either, so keying off `isExternalCliMode()` was wrong.
- **Literal matching only, never regex.** JS `RegExp` backtracks; herdr can offer
  `--regex` because Rust's regex crate is linear-time.
- **Client-hangup abort listens on `reply.raw` guarded by `writableFinished`.** On
  `req.raw`, `close` fires when the request BODY ends, which on a POST killed every
  send-and-wait instantly, and no `app.inject()` test can see it (inject never emits
  `close`).
- **Liveness cannot come from `session.pid`.** For a tmux session that is the local
  `tmux attach` client, not the worker: a worker exiting inside its pane leaves
  `pane_dead=1` with the client alive, so `pid` never goes null. Liveness is probed at
  the mux layer, cached (~750 ms) and only on blocking waits, never on the input hot path.

### Verification rounds

Six agents across three rounds, each verifying the previous round's work rather than its
own. Findings that mattered, in order of severity, were: the dead-pane liveness gap; the
`reply.raw` abort regression; abandoned long-polls leaking waiter slots; a crashed session
reporting `idle`; `shell` accepting `until=stop`; and a documented recipe that reported
success without running its task. Two traps recurred often enough to name:

- **Vacuous passes.** `app.inject()` never emits `close`; a latched `cancelEverything()`
  in `afterEach` silently killed the registry for every later test in a file; three test
  files sharing one session id against the process-wide registry let one file's leftover
  waiter fail another's assertion. Any new wait test needs care on all three.
- **HTTP-only test instances.** Every isolated instance used during the build was plain
  HTTP, which is exactly why the HTTPS hook bug survived so long. Test the transport the
  user actually runs.

### Resolved at wrap-up (2026-08-08, conclusion pass)

- **R2-A**: the fire-and-forget-then-gather-sequentially pattern was **removed from
  the skill** rather than patched. Signals are edge-triggered with no history, so a
  `stop` that fires before its waiter registers is unobservable afterwards; a
  `fresh=0` gather was rejected because the only `until` set that current state can
  satisfy answers `idle` for a prompt that never submitted, resurrecting the exact
  false-success failure R2-B had just closed. Flow 3b's pattern B now gathers on
  latched `wait-output` markers (`from=buffer`), the same mechanism that makes the
  shell flows reliable; the limitation is recorded in
  `architecture-invariants#agent-wait-primitives` and `endpoints.md`. The durable
  fix, a latched last-signal-per-turn on the server, stays with deferred Part 3.
- Docs F7/F8, F4 and the false-`idle` attribution: `api-reference.md`,
  `extending-codeman.md` and `architecture-invariants.md` rewritten to the post-fix
  matcher (one normalized stream, chunk-straddling found, snippet as a rendering of
  the matched window), the real no-PTY answer (`ended:true`, `aborted:false`,
  `delivered:false`), and the startup-idle mechanism (a session parked on the trust
  dialog emits no further `idle`; the false success is the startup transition).
- Orchestrate #12, #5/R2-B, #6, and R2-C..R2-E: fire-and-forget's empty `data`
  documented; every send-and-wait retry loop now treats `duplicate:true` +
  `immediate:true` as "no new turn ran" and reads the terminal before believing it;
  claude fan-out is pattern A (backgrounded send-and-waits) or the marker gather;
  readiness budgets rebalanced (5 s stage 1, 45 s stage 3) with the virgin-case
  floor named; the auth fallback now also reads the supervisor definition
  (`codeman-web.service` / launchd plist) and accepts `export`-prefixed `.env`
  lines; `pid != null` is documented as startup-only, never liveness.
- Both public readiness recipes (extending-codeman.md, README) are bypass-first with
  the trust probe as the bounded fallback; the worked recipe carries `-k` and fails
  loudly on an empty SID; the hook `-k`/self-heal fix appears in every
  "hooks go missing" list; the multi-word-TUI claim is "unreliable", not "never".

### Still open

Both release-checklist items that used to sit here are done: `skills/` is tracked and
ships through `package.json` `files` (published with 1.13.0, republished with 1.14.2),
and the changeset was consumed, committed and deployed. What is left:

- Deferred with Part 3: the latched last-signal-per-turn. Nice-to-haves from the
  reviews: N2 (create the death-watcher inside its `try`, still built one line above
  it in `GET .../wait`) and converting timeout-shaped test detections into fast
  assertions.
- §2.4's `X-Codeman-Caller-Session` footgun guard: still not built (open question 4).

### Step 6 (2026-08-09): install command, per-case injection, the setting

Built to the §2.6 file list, mirroring the statusLine mechanism throughout:

| Piece | Where |
| ----- | ----- |
| `applyAgentSkill(casePath, enabled)` + `installAgentSkillInto` / `removeAgentSkillFrom` | `src/hooks-config.ts` |
| `codeman skill install` / `skill uninstall` (`--global` default, `--case <name>`) | `src/cli.ts` |
| `agentSkillEnabled` (SYNCED, default OFF) | `schemas.ts` (`SettingsUpdateSchema`), `getAgentSkillEnabled()` on `ConfigPort`/`server.ts`, checkbox in `index.html` + `settings-ui.js` |
| Injection call sites (Claude mode only) | `POST /api/sessions` next to `refreshStaleCodemanHooks`; `POST /api/quick-start` after the case-create/self-heal blocks (local + docker cases; remote skipped, its path lives on another host) |
| Tests | `test/agent-skill.test.ts` (10 unit), `test/quick-start.test.ts` (real server: default-off, PUT accepts key, injection on create, shell-mode skipped) |

Decisions worth keeping:

- **Ownership marker, prefix-matched.** The injected SKILL.md ends with
  `<!-- codeman-managed-agent-skill: … -->`; install/refresh/remove all refuse a copy
  without the marker (a user's own skill) and match on the PREFIX so a wording change
  cannot disown older injected copies (the `BACKGROUND_WAKE_MARKER_PREFIX` pattern).
- **Symlink refusal.** This repo's own dogfooding layout
  (`.claude/skills/codeman -> ../../skills/codeman`) means the injector must `lstat`
  the skill dir AND its `skills/` parent and bail on a symlink, or enabling the
  setting in the Codeman repo itself would overwrite the skill source through the link.
- **ADD-ONLY at session create**, same shared-`.claude` rationale as the statusLine:
  a create while the setting is off must not yank the skill out from under other live
  sessions in the repo. The remove path exists (CLI `skill uninstall`, tests); no
  automatic sweep removes on toggle-off.
- **Removal is manifest-based, never `rm -rf`**: only files the packaged source would
  have written are deleted, directories are pruned bottom-up only if they emptied, so
  a user's extra notes in `reference/` survive an uninstall.
- **Source resolution**: `join(moduleDir, '..', 'skills', 'codeman')` works from
  `src/` (tsx), `dist/` (tsc build), and the npm tarball alike, because all three sit
  one level below the package root and `files` ships `skills/`.
- **Nothing acts on the setting at PUT time**: injection reads the merged persisted
  settings at session create (`readSettings`, ~2s cache), so the partial-PUT invariant
  (`toggleService` reading `merged`) is untouched by construction.

### 2026-08-09 addendum: cross-session messaging folded into the skill

Claude Code 2.1.224+ ships cross-session messaging: `ListAgents`/`SendMessage`
tools, a per-session Unix inbox socket, and a registry in
`~/.claude/sessions/<pid>.json`. Codeman's claude workers are ordinary local Claude
Code sessions, so the skill now routes task delivery and result collection over it
when available, while the HTTP primitives keep spawn, readiness, synchronization,
liveness and delete. New `skills/codeman/reference/messaging.md` (ships with zero
installer changes: `readAgentSkillSource()` enumerates `reference/*.md` from disk),
Flow 5 in recipes.md, and §4 in SKILL.md.

Verified live (claude-cli 2.1.226, Linux):

- A message to an idle worker starts a turn and that turn fires the normal `stop`
  hook (8.3 s send-to-stop measured), so the HTTP wait primitives compose with
  messaging unchanged; delivery to a busy session lands between tool calls.
- First contact needs the `name [ref]` form; the bare name errors with the exact
  string to resend. The `uds:` reply address of an inbound message works as a `to`.
- The `tmux codeman-<id8>` column in `ListAgents` (and the registry's `tmux` field)
  is the join key to Codeman session ids. The registry's `sessionId` field starts as
  the Codeman id (we spawn `claude --session-id <id>`) but drifts after `/clear` or
  resume, so it must never be the join key.
- The feature is flag-gated beyond the version: two 2.1.226 sessions on one machine,
  one with an inbox socket and one without. Absence is a fallback case, not an error.
- Codeman's default `--dangerously-skip-permissions` spawn puts both ends in the
  bypassing class, which delivers; mixed classes hold behind an approval dialog that
  expires unattended (upstream default 5 min), which on a headless worker means the
  message silently dies. The skill's backstop covers it.

Follow-up, landed in the same PR: local claude spawns now pass
`--name <session name>` so peers carry Codeman session names. The gate is
`buildNameCliArgs()` (session-cli-builder.ts), fail-closed at
`CLAUDE_NAME_FLAG_MIN_VERSION = 2.1.224`: that is the messaging release, the flag's
presence there was verified against the installed 2.1.224 binary, and the version
comes from `getClaudeCliVersion()` (null on probe failure and under vitest), so an
older or unknown CLI gets a command byte-identical to before. That matters because
claude aborts startup on an unknown option, which would kill every session spawn.
The value is allowlist-sanitized (Unicode letters/digits plus ` ._:-`, leading
dashes stripped so it cannot parse as another option, 64-char cap, empty result =
flag omitted) before the double-quoted interpolation in `buildSpawnCommand`, and
only the LOCAL command carries it: the docker/remote builders never see it, since
their CLI is not the binary the probe measured. E2E on an isolated instance
(`CODEMAN_INSTANCE`): process cmdline `claude ... --name w9-msgtest`, registry
`name: "w9-msgtest"`, `ListAgents` lists it under that name, a message round-trip
works, and its replies arrive tagged `from-name="w9-msgtest"` (a derived-name
worker's replies carry no `from-name`). A quick-start without `sessionName` has an
empty Codeman name, so the peer name stays derived: agents should name their
workers. Tests: `test/name-flag-injection.test.ts`.

Later narrowing: `--name` is not only the peer name but also the `/resume` picker
entry and the terminal title, and a pinned title stops Claude generating its own, so
pinning the `w1-myapp` placeholder listed every conversation of a case under the same
name in `/resume`. Only a manual name is pinned now (`Session.cliPinnedName`,
`nameSource === 'manual'`, carried to the builders as `cliName`); placeholder and auto
names leave Claude to title the conversation. A rename in Codeman appends a
`custom-title` row to the conversation's transcript (`claude-session-title.ts`), the
row `/rename` writes. Tests: `test/claude-resume-title.test.ts`,
`test/routes/session-name-routes.test.ts`.
