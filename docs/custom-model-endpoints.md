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
> engine, the endpoint store + discovery route, the session restart route,
> a settings-panel CRUD surface, and the Run-menu picker described below.
> Antigravity has no known custom-endpoint mechanism and is not supported.
> The HTTP API (examples below) still works directly and is what the picker
> itself calls under the hood.

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

`defaultModelId` names which discovered model the Run-menu picker applies
for that endpoint with no further choice — the settings panel's Edit form
exposes it as a select populated from the endpoint's own discovered
`models`, and the route refuses a value that isn't one of them. Leaving it
unset falls back to the first discovered model; re-discovering drops a
default that no longer appears in the fresh list rather than carrying an
invalid one forward.

## The Run-menu picker

With the setting on and at least one endpoint carrying a usable default
model (either an explicit `defaultModelId` or just one discovered model),
the toolbar's Run dropdown grows a **Custom Endpoints** section: one entry
per (harness that can redirect to a custom endpoint, saved endpoint) pair,
e.g. "Claude Code (llama.cpp)". The harness list is read off the CLI
registry's own `capabilities.customModelInjection` at page render
(`window.__codemanCustomModelClis`, `server.ts`) — never a hardcoded id list
in the frontend — so a CLI whose injection recipe lands later shows up with
no frontend change, and Antigravity (`unsupported`) never does.

Picking an entry runs a single session on that harness exactly the way its
own Run-menu entry would (same case creation, env overrides, everything),
then immediately applies the endpoint's default model to it via the route
below. It is a one-off "try this endpoint" action, not a sticky mode: the
plain Run button still means "this harness, native cloud" afterward.
Entries are hidden entirely for a remote or Docker active case, since the
apply route refuses both (see the next section).

## Applying a model to a session

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
- **Codex** — the config is structurally correct, but Codex only speaks the
  Responses API since Feb 2026, which llama.cpp/llama-swap don't implement.
  This is a real protocol incompatibility, not a bug here; Codex support
  needs a Responses-API-compatible endpoint.
- **Gemini** — fails with `Invalid auth method selected`, traced to an
  undocumented `GATEWAY` auth path gemini-cli selects once
  `GOOGLE_GEMINI_BASE_URL` is set. Unresolved after real investigation
  (several auth workarounds were tried and ruled out); do not rely on
  Gemini support yet.
- **DeepSeek** — the request reaches the server (env vars are read) but
  gets a consistent `HTTP_404`. Root cause not identified; best-effort only.
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
