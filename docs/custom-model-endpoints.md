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
[`deployment_plan.md`](../deployment_plan.md).

> **Status**: backend is implemented and tested (registry capability, the
> injection engine, the endpoint store + discovery route, the session
> restart route). The toolbar picker / settings UI described below as the
> intended surface is **not yet built** — until it lands, use the HTTP API
> directly (examples below). Antigravity has no known custom-endpoint
> mechanism and is not supported.

## Turning it on

App Settings → Agents & CLIs → **Custom Model Endpoints** (synced setting
`customModelEndpointsEnabled`, default **OFF**). The API equivalent:

```bash
curl -sk -X PUT https://localhost:3000/api/settings \
  -H 'Content-Type: application/json' \
  -d '{"customModelEndpointsEnabled": true}'
```

## Adding an endpoint

```bash
curl -sk -X POST https://localhost:3000/api/model-endpoints \
  -H 'Content-Type: application/json' \
  -d '{"id": "llama-box", "label": "Home llama.cpp", "baseUrl": "http://192.168.1.50:8080"}'
```

`apiKey` is optional (most local servers don't check it). `authStyle`
(`bearer` | `api-key` | `both`, default `both`) controls which auth header
convention discovery uses — `both` works whether the endpoint is llama.cpp
(ignores the header) or a cloud gateway like Azure (wants `api-key`).

Discover its available models:

```bash
curl -sk -X POST https://localhost:3000/api/model-endpoints/llama-box/discover-models
```

This calls the endpoint's own `GET /v1/models` and stores the returned list
on the endpoint record; `GET /api/model-endpoints` lists everything
configured, `PUT`/`DELETE /api/model-endpoints/:id` update or remove one.
Endpoint management is admin-only in multi-user mode, same as remote/docker
hosts — these are machine-level infra, not per-user settings.

## Applying a model to a session

```bash
curl -sk -X POST https://localhost:3000/api/sessions/<sessionId>/custom-model \
  -H 'Content-Type: application/json' \
  -d '{"endpointId": "llama-box", "modelId": "qwen3"}'
```

This computes the CLI-specific env vars / config for that session's mode
(see the recipe table in `deployment_plan.md`) and **restarts the session's
CLI process in place** — same pane, same tmux session, fresh env. That
restart is necessary, not incidental: every supported harness reads its
endpoint config at process start, not per-turn, so there is no live
hot-swap. Clear back to the harness's native cloud default with:

```bash
curl -sk -X POST https://localhost:3000/api/sessions/<sessionId>/custom-model \
  -H 'Content-Type: application/json' -d '{"clear": true}'
```

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

See the confidence table in `deployment_plan.md` for the full detail behind
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
hardening" section of `deployment_plan.md` for the full reasoning; several
of these were reachable via the generic `envOverrides` field even before
this feature existed, and building this surfaced and closed that gap.
