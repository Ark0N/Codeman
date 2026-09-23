# Custom Model Endpoint Profiles

Point any Codeman-supported harness — Claude, opencode, Codex, Gemini, Pi,
Grok, DeepSeek, or OMP — at a custom OpenAI-compatible endpoint instead of
its native cloud backend, for a given session. "Custom endpoint" covers both
**local** hardware (llama.cpp, Ollama, vLLM, a home GPU rig, or purpose-built
boxes like NVIDIA DGX Spark or AMD Strix Halo mini-PCs) and **cloud**
services (Azure AI Foundry's OpenAI-compatible endpoint, OpenRouter, a
company gateway) — anything answering `GET /v1/models` and
`POST /v1/chat/completions` in the standard shape. Design doc, per-CLI
recipe confidence table, and security reasoning:
[`custom-model-endpoints-plan.md`](custom-model-endpoints-plan.md).

> **Status**: fully wired end to end — registry capability, the injection
> engine, the endpoint store + discovery route, both the restart-in-place
> apply route (Claude) and the one-shot quick-start launch path (every
> other supported harness), a settings-panel CRUD surface, and the Run-menu
> picker described below. Antigravity has no known custom-endpoint
> mechanism and is not supported. The HTTP API (examples below) still works
> directly and is what the picker itself calls under the hood.

## Turning it on

App Settings → Models → **Custom model endpoints** (synced setting
`customModelEndpointsEnabled`, default **OFF**). Turning it on does two
things: it reveals the endpoint list/add/edit/discover panel in that same
settings section, and it makes the Run menu offer a generated entry per
(harness, endpoint) pair — see "The Run-menu picker" below. The API
equivalent:

```bash
curl -sk -X PUT https://localhost:3000/api/settings \
  -H 'Content-Type: application/json' \
  -d '{"customModelEndpointsEnabled": true}'
```

## Adding an endpoint

Via App Settings → Models → Custom model endpoints → **+ Add endpoint**, or
directly:

```bash
curl -sk -X POST https://localhost:3000/api/model-endpoints \
  -H 'Content-Type: application/json' \
  -d '{"id": "llama-box", "label": "Home llama.cpp", "baseUrl": "http://192.168.1.50:8080"}'
```

`apiKey` is optional (most local servers don't check it). `authStyle`
(`bearer` | `api-key`, default `bearer`) controls which auth header
convention discovery uses: `bearer` is `Authorization: Bearer <key>`
(llama.cpp, OpenAI-compatible servers, most gateways), `api-key` is the
`api-key: <key>` header Azure AI Foundry wants. There is deliberately no
"send both" option: measured against a real llama-swap server, a request
carrying both headers hung indefinitely. `baseUrl` must be `http(s)`, carry
no embedded credentials, and may not point at a link-local or cloud-metadata
address; discovery re-checks the address the name actually resolves to.

Discover its available models:

```bash
curl -sk -X POST https://localhost:3000/api/model-endpoints/llama-box/discover-models
```

This calls the endpoint's own `GET /v1/models` and stores the returned list
on the endpoint record; `GET /api/model-endpoints` lists everything
configured, `PUT`/`DELETE /api/model-endpoints/:id` update or remove one.
Endpoint management is admin-only in multi-user mode, same as remote/docker
hosts — these are machine-level infra, not per-user settings.

**Context length is discovered too, opportunistically and safely.** The plain
`GET /v1/models` response has no context-window field. Discovery only ever
looks for one for a model llama-swap's own response already reports
`status.value === "loaded"` for — never for an unloaded one, because
llama-swap treats `?model=` as a routing hint and asking about a model that
isn't loaded risks triggering an actual (slow, GPU-swapping) load as a side
effect of what should be read-only discovery. A server with no `status` field
on any entry at all (not llama-swap) gets no context-length enrichment,
rather than guessing. A model's previously-learned context length survives a
later cycle where it wasn't the loaded one; it's dropped only once the model
disappears from the endpoint's list entirely. Stored per model in
`modelContextLengths` and applied automatically (see "Applying a model to a
session" below) so a CLI that would otherwise assume a large default context
window for an unrecognized model id stops silently overflowing a much
smaller real one.

**Where that number actually comes from matters, and got this wrong once
already.** The first cut read it from llama.cpp's own
`GET /props?model=<id>` (`n_ctx`) — plausible, and it worked in testing, but
confirmed live to be actively WRONG for a `--fit-ctx`-launched llama-swap
backend: `/props` reported `n_ctx: 154112` for a model llama-swap itself had
launched with `--fit-ctx 16384`, and the real server then refused a request
right at that real 16384-token limit — `/props`'s `n_ctx` appears to report
the model's theoretical/trained maximum there, not the runtime-configured
one. Discovery now parses the REAL configured size straight out of
llama-swap's own launch command instead (`GET /running`'s `cmd` field —
`--fit-ctx <N>` first, then the plain llama.cpp `-c`/`--ctx-size` a
hand-written command might use), and only falls back to the `/props` probe
when `cmd` states no recognizable flag at all.

**File size is discovered too, when the server states one.** llama-swap
writes a GB figure into an auto-discovered model's own `description`
(`"Auto-discovered 16.35 GB - parameters auto-fitted by llama.cpp"`), parsed
into `modelSizesGB` — unlike context length, this needs no `/props` probe
(the figure is right there in the `/v1/models` response) and so is populated
for every model regardless of loaded state. A hand-configured profile's own
description has no such figure and correctly gets no entry, never a guess.
Used only to label the Run-menu picker's "loading model" banner (e.g.
"Loading qwen3.8-27b-ud-q4_k_xl (16.4 GB) on llama-swap..."); never anything
a server-side check relies on.

**The loading banner is unbounded by design, and says so — no countdown, no
automatic give-up.** An earlier version scaled an expected-time estimate and
a timeout off the model's file size and auto-closed the session once that
elapsed, but a real load's actual duration depends on hardware this feature
has no way to know (VRAM, storage speed, whatever else is contending for the
GPU) — any fixed number was a guess dressed up as a fact, and a model that
genuinely takes 10+ minutes on slower hardware would just get killed
mid-load by its own display. The banner now says outright that it can take a
while depending on hardware and model size, polls
`GET /api/model-endpoints/:id/running-status` every second for as long as it
takes, and carries a **Cancel** button (rendered on the banner itself) that
ends the wait and closes the session the load was for — the user's own call
on when it's taking too long, not a fixed number baked into the client.

**The banner's second line is the real backend log line, not a guess.**
llama-swap's `GET /api/events` SSE stream carries the actual `llama-server`
process's own stdout — `load_model: loading model '<path>'`,
`llama_server: model loaded`, tokenizer warnings, all of it — tagged
`source: "upstream"`, distinct from llama-swap's own `source: "proxy"`
request-access lines. `running-status`'s response now includes `logLine`
(via `getLatestLlamaSwapLogLine`), and the banner shows it on its own line
under the disclaimer, e.g. "llama.cpp: load_model: loading model '...'" —
confirmed live end-to-end through a real forced swap, sequentially showing
the model path, a tokenizer warning, then staying on whatever llama.cpp last
printed once the load goes quiet (never cleared back to blank). ⚠️
**`GET /logs` — the endpoint this feature's own first cut was built
against — turns out to carry ONLY llama-swap's own proxy request-access
log.** Confirmed live it never showed a single backend line, even seconds
after a real, verified model swap; `/api/events`'s `logData` frames are the
only source that actually has it, and its own `source` field (`upstream` vs
`proxy`) is what `getLatestLlamaSwapLogLine` filters on. One `/api/events`
connection is held open per endpoint and reused across every session
watching a load on it (confirmed live to stay open indefinitely, unlike
`/logs`, which closes after a fixed ~100KB), idle-closed after 30s of nobody
polling it (`pruneIdleLlamaSwapLogTails`, same 20s sweep as the
swap-displacement check below).

`defaultModelId` names which discovered model the picker pre-marks for that
endpoint — the settings panel's Edit form exposes it as a select populated
from the endpoint's own discovered `models`, and the route refuses a value
that isn't one of them. It is applied automatically only when the endpoint
has exactly one discovered model (nothing to choose); with two or more it
is a pre-selection in the model-picker dialog below, never a silent default.
Re-discovering drops a default that no longer appears in the fresh list
rather than carrying an invalid one forward.

**Model lists refresh themselves.** A background sweep (`server.ts`,
`CUSTOM_MODEL_REDISCOVER_INTERVAL_MS`, every 5 minutes) re-discovers every
saved endpoint the same way the manual `POST .../discover-models` route
does, best-effort per endpoint — one being unreachable on a given cycle
never blocks the others. Off under `npm test`, same reasoning as the Codex
plan-usage poll it sits beside: no real network to hit, no server instance
to keep the timer alive for.

## The Run-menu picker

With the setting on and at least one endpoint carrying a discovered model,
the toolbar's Run dropdown grows a **Custom Endpoints** section: one entry
per (harness that can redirect to a custom endpoint, saved endpoint) pair,
e.g. "Claude Code (llama.cpp)". The harness list is read off the CLI
registry's own `capabilities.customModelInjection` at page render
(`window.__codemanCustomModelClis`, `server.ts`) — never a hardcoded id list
in the frontend — so a CLI whose injection recipe lands later shows up with
no frontend change, and Antigravity (`unsupported`) never does.

Picking an entry re-fetches the endpoint (`selectCustomModelEntry()`,
`session-ui.js`) rather than trusting anything cached from the dropdown's
own render — the model list can have changed via the 5-minute sweep above
or a settings-panel edit since the menu opened. With exactly one discovered
model it runs straight away; with two or more, a small modal
(`#customModelPickModal`) lists them and asks which one to use for this
launch, with the endpoint's `defaultModelId` marked but not auto-chosen —
the point of asking is letting one launch deliberately differ from the
saved default, not just confirming it.

The modal promotes exactly one row to the top of the list rather than
always showing raw discovery order, so the zero-wait choice is the one
under your thumb:

- **"Currently loaded"** — a model from this host's own list that
  llama-swap reports `ready` right now, queried via
  `GET /api/model-endpoints/:id/running-status`. Bounded client-side to
  ~800ms (`Promise.race`), on top of the route's own 5s server-side
  timeout, so an endpoint that is asleep or firewalled cannot leave the
  modal invisible for the full 5s after the Run menu has already closed.
- **"Last used"** — shown only when nothing is currently loaded: the model
  actually launched last for this exact (harness, endpoint) pair, read
  from the per-device `codeman:customModelLastUsed:<mode>:<endpointId>`
  localStorage key. Written by `_runCustomModelEntryViaRestart` (claude)
  and `_quickStartWithCustomModelConfirm` (every one-shot launch; the
  `runCustomModelEntry` entry point itself only dispatches between the
  two) only once the model is actually applied, never on the mere click —
  declining the context-window warning means this exact model cannot work
  with this CLI at all, so promoting it next time would be actively wrong,
  not just premature.

Neither tag reorders anything past that one promoted row. The "Default"
pill is a separate span, not a third value of the same slot: a promoted
row that is also the endpoint's `defaultModelId` shows both tags (on a
single-purpose GPU box that is the common case, and an exclusive slot
silently dropped the Default marking for exactly that row), and a row
with neither promotion nor default shows no tag at all.

**How the launch itself applies the endpoint depends on the harness.** For
opencode, Codex, Gemini, Pi, Grok, DeepSeek and OMP (`runCustomModelEntry` →
`_runCustomModelEntryOneShot`), the endpoint/model is folded into the SAME
`POST /api/quick-start` call that creates the session (`customModel` field),
so the session launches directly on the endpoint — no restart, no visible
relaunch. Claude (`_runCustomModelEntryViaRestart`) still uses the original
two-step design: the launch runs a single native session exactly the way its
own Run-menu entry would, then **waits for the new session to go idle**
(`GET .../wait?until=idle`, bounded at 20s — a normal 200 either way, never
an error, per the wait endpoint's own contract) before applying the endpoint
via the restart route below. That wait exists because a freshly launched CLI
reports itself as `busy` for its own startup (a boot spinner, a
workspace-trust check) well before the apply call would otherwise reach it,
and the apply route correctly refuses to restart a session mid-turn — a
fresh boot looks exactly like one from the outside. A session still busy
after the wait reaches the apply call anyway and gets that route's own
honest `SESSION_BUSY` error, now visible as a sticky toast with a close
button rather than a generic message that vanished in three seconds. Claude
stays on this path because its own restart (`--resume`-based, keeping the
conversation) is far less jarring than the other seven's, and `runClaude()`'s
multi-tab launch and docker-config-drift confirm/retry loop make folding it
into the one-shot path separate work. It is a
one-off "try this endpoint" action, not a sticky mode: the plain Run button
still means "this harness, native cloud" afterward. Entries are hidden
entirely for a remote or Docker active case, since the apply route refuses
both (see the next section).

## Launching directly on an endpoint (no restart)

```bash
curl -sk -X POST https://localhost:3000/api/quick-start \
  -H 'Content-Type: application/json' \
  -d '{"caseName": "myapp", "mode": "codex", "customModel": {"endpointId": "llama-box", "modelId": "qwen3"}}'
```

`POST /api/quick-start`'s `customModel` field (`{endpointId, modelId,
confirmed?}`) computes the same injection the restart route below does, but
BEFORE the session exists — the session is minted its own id up front
(`crypto.randomUUID()`), the injection (env vars, and for a `configDir`-kind
CLI, the written config file) targets that real id, and the session launches
already pointed at the endpoint. No restart, because there was never a
native-backend launch to restart away from. Runs the same llama-swap
conflict check as the restart route (below) — a `409`-shaped
`{requiresConfirmation, currentlyLoadedModel, affectedSessions}` response
with no session created, resolved by retrying with `confirmedSwap: true` — and
is refused the same way for a remote or Docker case. This is what the
Run-menu picker uses for opencode, Codex, Gemini, Pi, Grok, DeepSeek and OMP;
Claude still uses the restart route below (see "The Run-menu picker" above
for why).

## Applying a model to an ALREADY-RUNNING session

```bash
curl -sk -X POST https://localhost:3000/api/sessions/<sessionId>/custom-model \
  -H 'Content-Type: application/json' \
  -d '{"endpointId": "llama-box", "modelId": "qwen3"}'
```

This computes the CLI-specific env vars / config for that session's mode
(see the recipe table in `custom-model-endpoints-plan.md`) and **restarts the session's
CLI process in place** — same pane, same tmux session, fresh env. That
restart is necessary, not incidental: every supported harness reads its
endpoint config at process start, not per-turn, so there is no live
hot-swap. A Claude session is relaunched with `--resume <conversation> ||
--session-id <id>`, so it continues the conversation it was on; pi, omp and
grok are relaunched with the `--model` value that selects the injected
provider (`custom/<modelId>` for pi and omp, `codeman-custom` for grok),
since for those three the config file alone does not switch the model.
**Remote (SSH) and Docker sessions are refused** (400) for now: their restart
reattaches the durable remote/in-container tmux rather than relaunching the
agent, so the selection would report success and change nothing.

**Claude gets two more env vars when known/applicable, both declared on its
registry entry (`contextLengthVar`/`configDirVar`), not hardcoded here:**

- `CLAUDE_CODE_MAX_CONTEXT_TOKENS` is set to `modelId`'s discovered context
  length (see the discovery section above) whenever one is known. Without
  it, Claude Code assumes a large (200k) window for any unrecognized custom
  model id and never compacts, which reliably overflows a much smaller real
  local context — confirmed live: a stock ~33.7K-token system prompt against
  a 16384-token llama-swap model failed with `exceeds the available context
size`. No entry for the model in `modelContextLengths` means the var is
  simply omitted, never a guess. ⚠️ **This var only affects when Claude
  Code compacts conversation _history_ — it cannot fix a model whose real
  context is smaller than Claude Code's own fixed per-turn overhead**
  (system prompt + tool schemas, empirically ~36.4K tokens, confirmed live
  via an `in:0 out:0` failure on the very first message, before any
  history exists to compact). No context-length declaration changes that
  fixed overhead, so a model below the safe floor fails outright on
  message one regardless of what this var says. See "Context-window floor
  warning" below for how Codeman catches this case before launching
  instead of after.
- `CLAUDE_CONFIG_DIR` is pointed at the same isolated per-session directory
  the `configDir`-kind CLIs use (empty, no files written into it), so the
  injected `ANTHROPIC_API_KEY` never shares a directory with a stored
  claude.ai OAuth login. Claude Code still prints "Both claude.ai and
  ANTHROPIC_API_KEY set" when the two coexist in the same config directory —
  cosmetic (confirmed live: the API key wins for actual requests either way,
  visible in the terminal's own `API Usage Billing` line) but worth
  eliminating rather than living with. The directory's `projects`
  subdirectory is symlinked (a junction on Windows) back to the real
  `~/.claude/projects` so the response viewer, subagent windows and Read My
  Mind keep working for that session — the same trade-off and fix documented
  for a manually-set `CLAUDE_CONFIG_DIR` in
  [`docs/wiki/Agent-CLIs.md`](wiki/Agent-CLIs.md), just applied
  automatically here. Best-effort: a platform that refuses the symlink keeps
  the pre-existing blind-response-viewer side effect rather than failing the
  whole custom-model apply over it. ⚠️ **This relocates the whole `.claude`
  tree, not just transcripts**: a custom-model Claude session also loses the
  user's global `settings.json`, user-level skills (the codeman agent skill
  included), user-level agents and commands, and the MCP servers configured
  in `~/.claude.json` — none of those are symlinked back, only `projects` is.
  A fine trade for "point this session at my local llama.cpp," but worth
  knowing before it surprises you mid-session.

**That isolated directory needed one more fix to actually be usable
non-interactively.** An otherwise-empty `CLAUDE_CONFIG_DIR` has none of a
real profile's prior "Detected a custom API key — use it?" approvals, so
without more, Claude Code stops and asks that on _every single launch_ —
confirmed live, and with nobody at a TTY to answer, its own default answer
("No") silently refuses the very key this feature just injected, which
looks like the endpoint being ignored entirely. `customModelInjection`'s
`apiKeyTrustFile` (`{ relPath: '.claude.json', shape:
'claude-api-key-responses' }` on claude's entry) pre-seeds that exact
approval: the apply step merges `customApiKeyResponses.approved: [apiKey]`
into `<configDir>/.claude.json`, the same field a real answered prompt
itself writes to (confirmed against a real file after answering by hand
once) — this answers the prompt in advance rather than bypassing it. The
merge preserves whatever else the CLI already wrote into that file on an
earlier launch in the same isolated directory (`userID`, `numStartups`,
earlier approved keys), and a missing or corrupt file is treated as empty
rather than failing the apply.

**A fresh `CLAUDE_CONFIG_DIR` isn't just missing that one approval — Claude
Code treats it as a brand-new profile and replays its ENTIRE first-run
sequence on every launch: the theme picker, the security-notes screen, the
per-project "trust this folder?" dialog, and (running with
`--dangerously-skip-permissions`) a one-time warning about bypassing
permissions.** Confirmed live: none of these show up again for a real,
already-onboarded profile, but every custom-model session gets a fresh,
otherwise-empty isolated directory, so it saw all four every single time.
`customModelInjection`'s `skipFirstRunPrompts` (`true` on claude's entry,
requires `apiKeyTrustFile` since it reuses the same file) pre-seeds the
state a real profile accumulates from answering all of that once:
`hasCompletedOnboarding: true` and the launching session's own
`projects[workingDir].hasTrustDialogAccepted: true` go into the same
`<configDir>/.claude.json` the API-key approval above already merges into
(other projects, and other fields on this session's own project entry, are
left untouched), and `skipDangerousModePermissionPrompt: true` goes into
`<configDir>/settings.json` — a different file, merged the same
corrupt-tolerant way. `workingDir` is used exactly as the session was
launched with as its cwd, never realpath'd or slash-normalized, since
that's the literal string Claude Code itself uses as the project key.

**llama-swap gets two more fixes on top of the context-length/config-dir
ones above, both from watching a real switch live.** llama.cpp only ever
runs one model at a time; llama-swap swaps the backing process on demand,
which can take anywhere from a few seconds to well over a minute:

- **The conflict check.** Both apply routes (the restart one here and the
  one-shot `POST /api/quick-start` above) call llama-swap's own
  `GET /running` first — feature-detected, so a plain llama.cpp/OpenAI-
  compatible server (no such endpoint) is simply never checked. If a
  _different_ model is currently loaded and ready, and another **live
  session's own selection** is using it, the apply returns
  `{requiresConfirmation: true, currentlyLoadedModel, affectedSessions}`
  instead of silently switching — nothing is applied or created yet.
  Retrying with `confirmedSwap: true` skips the check (the legacy `confirmed: true`
  still means both questions). Switching with nothing
  else affected proceeds immediately; this is a warning about disrupting
  another session, never a gate on the switch itself.
- **Actually starting the load.** llama-swap has no "switch model" admin
  call — the only thing that starts a swap is a real inference request
  naming the model, and confirmed live: applying a selection alone never
  reached llama-swap at all (nothing in its own server logs), since nothing
  had actually asked it to load anything yet. Both apply routes now also
  send the smallest real request that will —
  `POST <baseUrl>/v1/chat/completions` with `max_tokens: 1` and one
  throwaway message — whenever the
  target model isn't already the one loaded and ready, fire-and-forget (its
  response is never read; `GET /api/model-endpoints/:id/running-status`,
  polled client-side, is what actually confirms readiness). The response
  also carries `modelSwapInProgress: true` in that case, which is what
  drives the Run-menu picker's own "loading model" status banner.

## Catching a swap after the fact

The conflict check above only runs at the moment a session is created or a
model is applied — it has no way to catch a swap that happens **later**.
Confirmed live: a session created while nothing else conflicted at that
exact instant can still get silently displaced afterward, once a
_different_ session's own normal use (or its own create-time load trigger)
asks llama-swap to load something else. llama-swap has no push
notification of its own for this, so a background sweep
(`detectCustomModelSwapDisplacements`, `CUSTOM_MODEL_SWAP_CHECK_INTERVAL_MS`
= 20s in `server.ts`) polls `GET /running` once per distinct endpoint that
has at least one live custom-model session, and compares each such
session's own `modelId` against what is actually loaded. A session whose
model is no longer in that list gets a `custom-model:swapped-out` SSE event
(`{sessionId, sessionName, endpointId, previousModel, currentlyLoadedModel}`),
shown as a global toast — global rather than tied to that session's tab,
since the whole point is telling the user before they type into it
expecting the model they picked. Notifies **once per displacement**: the
same de-dupe `Set` clears a session's flag once its own model is loaded and
ready again, so a later, genuinely new displacement notifies again rather
than the session staying silently un-notified forever after the first one.

## Context-window floor warning

Claude Code's own fixed per-turn overhead (system prompt + tool schemas,
empirically ~36.4K tokens) can exceed a small local model's _entire_ real
context on its own, before any conversation history exists to fill it —
confirmed live twice, both as an `in:0 out:0` failure on the very first
message sent. `CLAUDE_CODE_MAX_CONTEXT_TOKENS` (above) cannot fix this: it
only governs when Claude Code compacts conversation history, and there is
no history yet on message one. Applying such a model would look like the
endpoint being ignored, or the wrong model being used, when in fact the
endpoint applied correctly and the model is simply too small for this CLI.

Both apply routes (the restart route and the one-shot `POST
/api/quick-start`) now check for this **before** launching or restarting
anything, gated on the CLI's registry entry declaring a `contextLengthVar`
(currently only claude — the check is a no-op for every other CLI by
construction, never a hardcoded mode check). If the model's discovered
context (`modelContextLengths`, from discovery above) is below
`CLAUDE_MIN_SAFE_CONTEXT_TOKENS` (40000, comfortably above the measured
~36.4K overhead), the response is `{requiresContextWarning: true, modelId,
contextLength, minSafeContextTokens}` instead of applying — nothing is
restarted or created yet. A context length that was never discovered at
all skips the check entirely (nothing to compare, so it fails open rather
than warning on every model an endpoint hasn't reported a size for).
Retrying with `confirmedContext: true` launches anyway (the legacy `confirmed: true` still means both questions).

The Run-menu picker shows this as an in-app modal
(`#customModelContextWarningModal`, matching the llama-swap conflict
modal's look) naming the model, its discovered context, and the safe
floor, and explaining the fix: reconfigure llama-swap to give that model
(or a smaller one) an explicit larger context instead of relying on
auto-fit (`--fit-ctx`), which optimizes for the biggest _model_ that fits
rather than the biggest _context_ — e.g. adding `-c 65536` (or as large a
`--ctx-size` as the hardware holds) to that model's llama-swap config
entry. A smaller model at a much larger explicit context often fits in
the same VRAM a bigger model's auto-fit context gets shrunk to make room
for.

Clear back to the harness's native cloud default with:

```bash
curl -sk -X POST https://localhost:3000/api/sessions/<sessionId>/custom-model \
  -H 'Content-Type: application/json' -d '{"clear": true}'
```

Clearing also removes the env vars the selection injected from the tmux
session (they persist there and would otherwise be inherited by the
relaunched CLI) and deletes the per-session config directory
(`~/.codeman/custom-model-configs/<sessionId>`, written 0600 because pi and
omp embed the API key in it). That directory is also removed when the
session is deleted. The selection survives a Codeman restart: the endpoint
id, model and injected key NAMES are persisted, the values are re-derived
from the endpoint store on recovery, and the pane keeps running against the
endpoint in between because tmux retains its environment.

⚠️ Clearing removes injected keys **by name**, and `CLAUDE_CONFIG_DIR` is one
of the names claude's selection injects — so a session that ALSO had
`CLAUDE_CONFIG_DIR` set through the generic `envOverrides` field (the
per-client-account case) loses that override on clear too, and silently
falls back to the server's default Claude account. If you route a session
to a specific account this way, re-apply the override after clearing a
custom-model selection from it.

**New sessions always default back to the harness's native backend.** A
custom-endpoint selection is a per-session choice, never a sticky global
default — starting a fresh session doesn't inherit whatever the last one was
pointed at.

## Confidence per harness

Every harness except Antigravity has now been run end-to-end against a real
llama-swap server via `scripts/test-local-llm-harnesses.ts` (a dynamic
script that reads the live CLI registry, so a registry change is picked up
automatically). Results:

- **Claude, opencode, Pi, Grok, OMP** — verified: a real "hello world" reply
  came back through the endpoint.
- **Codex** — the config is structurally correct, and against a llama-swap
  server that DOES answer `/v1/responses` (confirmed live: a plain,
  no-tool-call chat turn returned a real reply), the picture is more
  nuanced than a flat failure. A real tool-call attempt (`run the shell
command: echo hello`) came back as `agent_message` TEXT — literally the
  tool-call JSON printed as the model's answer — instead of a
  `function_call` item Codex would actually execute (confirmed via `codex
exec --json`'s raw event stream). So plain chat can work while the thing
  that makes Codex a coding agent — actually running commands and editing
  files — does not; treat Codex as still unreliable for real work against a
  llama.cpp/llama-swap endpoint, tool-calling gap included, not just the
  earlier-documented `wire_api` mismatch (which not every deployment hits
  the same way — some legitimately have no `/v1/responses` route at all).
  Separately, EVERY custom-endpoint Codex session prints `Model metadata
for '<id>' not found. Defaulting to fallback metadata...` on launch —
  confirmed harmless (the reply above still came back correctly): Codex's
  model metadata (reasoning-tier options, per-model system-prompt
  templates, context-window figures) comes from `models_cache.json`, a
  local cache of OpenAI's own hosted model catalog that a custom local
  model can never appear in by construction, since it isn't one of
  OpenAI's models. There's no config.toml override for a model's metadata,
  and fabricating a fake catalog entry would mean copying the _shape_ of
  OpenAI's own proprietary schema (their per-model system-prompt content
  included) for a warning that doesn't otherwise affect behavior — not
  something to build into discovery.
- **Gemini** — fails with `Invalid auth method selected`, traced to an
  undocumented `GATEWAY` auth path gemini-cli selects once
  `GOOGLE_GEMINI_BASE_URL` is set. Unresolved after real investigation
  (several auth workarounds were tried and ruled out); do not rely on
  Gemini support yet.
- **DeepSeek** — root cause of the `HTTP_404` found and fixed. DeepSeek
  Harness's own bundled provider module (`@deepseek-ai/dsh-llm-deepseek`)
  builds its request URL as `${DEEPSEEK_BASE_URL}/chat/completions` with no
  `/v1` insertion of its own (its real public API, `https://api.deepseek.com`,
  expects the caller's base URL to already carry any needed prefix) —
  confirmed by reading its own source and, live, that
  `POST <baseUrl>/chat/completions` 404s against llama-swap while
  `POST <baseUrl>/v1/chat/completions` succeeds; the harness's own error
  template (`DeepSeek API error (HTTP ${status})`) matches the originally
  reported symptom exactly. `customModelInjection`'s new `appendV1Suffix`
  (deepseek's entry only — claude/gemini must NOT get it, since claude was
  already confirmed working against the raw `baseUrl`) fixes it by writing
  `DEEPSEEK_BASE_URL` with `/v1` appended. Not yet re-run end-to-end with a
  real `dsh` binary (no install available in this environment) — the fix
  is source-confirmed and live-verified at the HTTP level, but a real
  "hello world" reply through `dsh` itself is still outstanding before
  calling this fully verified like the harnesses above.
- **Antigravity** — no known custom-endpoint mechanism at all; unsupported.

See the confidence table in `custom-model-endpoints-plan.md` for the full detail behind
each result. `scripts/test-local-llm-harnesses.ts` is the standalone script
used to check a harness against a real endpoint outside the web UI
entirely; see its own `--help` for usage.

## Security note

Every env var this feature can set that redirects a session's traffic
(`ANTHROPIC_BASE_URL`, `GOOGLE_GEMINI_BASE_URL`, `CODEX_HOME`, etc.) is
listed in that CLI's `privilegedEnvKeys` in the CLI registry, so a
non-granted multi-user owner cannot set one directly via the generic
`envOverrides` API field — only through this feature's own route, which
computes the value from an admin-configured, SSRF-guarded endpoint rather
than trusting arbitrary client input. See the "Multi-user security
hardening" section of `custom-model-endpoints-plan.md` for the full reasoning; several
of these were reachable via the generic `envOverrides` field even before
this feature existed, and building this surfaced and closed that gap.
