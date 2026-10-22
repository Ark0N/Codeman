# GitHub Copilot CLI sessions

Codeman can drive [GitHub Copilot CLI](https://github.com/github/copilot-cli) (`copilot`,
npm `@github/copilot`) as a session backend, alongside Claude Code, OpenCode, Codex, Gemini,
Antigravity, Pi, Grok, DeepSeek Harness and OMP. `copilot` is a run mode: its own PTY, its
own tmux session, its own tab identity (purple, a drawn mark rather than GitHub's logo). It is
not a location overlay like Docker or remote-SSH cases, and it is not a web tab.

Everything here was measured against Copilot CLI 1.0.94 and 1.0.95 inside tmux. The entry
itself is registry data (`src/config/cli-registry/stock.ts`); see
[`cli-registry.md`](./cli-registry.md#github-copilot-cli) for the field-by-field reference.

## Install

```bash
npm install -g @github/copilot
```

CLI management (Settings → Agents & CLIs) can run exactly that for you. Codeman resolves the
binary from the server's PATH and the usual npm/nvm prefixes, then runs `copilot --version`
and accepts it only if the output says `GitHub Copilot CLI <x.y.z>`. A bare `copilot` on PATH
that answers anything else is ignored. Check what it resolved:

```bash
curl -s localhost:3000/api/copilot/status | jq
# { "available": true, "path": "/home/you/.local/bin", "version": "1.0.95" }
```

## Authenticate

Codeman never logs Copilot in or stores its credentials.

- **Interactive.** Run `copilot` once and use `/login` (or `copilot login`), or do it inside a
  Codeman tab. The token goes to the OS keychain when one is available.
- **Headless server.** There is no keychain on a service, so Copilot offers to keep the token
  as **plain text in `~/.copilot/config.json`** (`authTokens`). That is where it ends up when you
  accept. To keep a token out of a file, set `COPILOT_GITHUB_TOKEN` in the service environment;
  Copilot reads it first, then `GH_TOKEN`, then `GITHUB_TOKEN`.
- **Per-session override.** `COPILOT_*` is the only prefix the env allowlist admits for
  Copilot. `GH_TOKEN` and `GITHUB_TOKEN` are deliberately **not** accepted as per-session
  overrides: the allowlist is one global list with no mode context, so admitting them would
  make them settable on every session. Use `COPILOT_GITHUB_TOKEN`.
- **No GitHub sign-in is needed** when a session points at your own endpoint (below).

## What Codeman wires up

| Thing | Behaviour |
| --- | --- |
| Launch | `copilot`, in Copilot's own Manual Approval mode. |
| Run button | `copilot --yolo` (allow every tool, path and URL), like the other CLIs' bypass switches, so an unattended session never stops on an approval. |
| Permission clamp | `allowAll` is a `privilegedParam`. A multi-user owner without the bypass grant has it forced back to `false`; an absent config is never materialized (a bare `copilot` is already safe). `COPILOT_HOME`, `COPILOT_ALLOW_ALL`, `COPILOT_PROVIDER_*` and `COPILOT_MODEL` are privileged env keys, and so is every other `COPILOT_*` variable the CLI reads that switches approvals (`COPILOT_PLAN_THEN_AUTOPILOT`), runs code with no approval row (`COPILOT_CLI_DIST_DIR`, the package caches, `COPILOT_EDITOR`, `COPILOT_PROVIDER_API_KEY_COMMAND`, skills, hooks) or sends the sign-in token to another host (`COPILOT_API_URL`, `COPILOT_GH_HOST`, ...): the list is in `stock.ts`, read from the 1.0.98 bundle. A variable a later Copilot release adds is not covered until it is listed there. |
| Model | `--model <id>`, sent only by an API caller that sets `copilotConfig.model` (the value must start with a letter or digit, like `resumeSessionId`). Nothing in the UI sets it: a saved custom endpoint sets `COPILOT_MODEL` instead (see below). |
| Resume | `--resume <value>`, sent only by an API caller that sets `copilotConfig.resumeSessionId` (Past Sessions does not). The value (an id, an id prefix or a session name) must be one plain word starting with a letter or digit: `--resume`'s value is optional, so `--resume --yolo` would otherwise make `--yolo` its own flag and bypass the clamp. |
| Continue | `--continue`, from **Past Sessions**: it resumes the most recent conversation Copilot has for that directory. Nothing sets it on a respawn. Skipped when a resume value is set. |
| Name | A tab name **you set yourself** is passed as `--name <tab name>`, so Copilot's own session list reads like that tab. An automatic name (`w1-myapp`, or an auto-named title) is not pinned. Copilot refuses `--name` with `--resume`/`--continue`, so it is dropped there and a continued session keeps the name it had. |
| Working / idle | The footer. A turn shows `◉ Working esc edit prompt` (the dot alternates `◉`/`◎`); the composer is the `❯` between two rules. A tool waiting for approval replaces the composer and reads as idle. |
| Model detection | The right-hand field of the footer's last row, at rest and mid-turn. |
| Status probe | `GET /api/copilot/status`, plus an entry in the CLI-installed probes and `codeman doctor`. |
| MCP | The entry declares `mcpConfig` (`~/.copilot/mcp-config.json`, dialect `copilot-json`, relocated by `COPILOT_HOME`), so [MCP server sync](./cli-registry.md) treats it as a target and a source. `copilot mcp disable` is honoured (read from `settings.json`, never written). |
| Plan usage | The header chip's **Copilot** row: the monthly premium-request quota from `GET https://api.github.com/copilot_internal/user`, read at startup and every 10 minutes with Copilot's own sign-in token (`COPILOT_GITHUB_TOKEN`, `GH_TOKEN` or `GITHUB_TOKEN`, else the plain-text token in `<COPILOT_HOME or ~/.copilot>/config.json`; a sign-in kept in the OS keychain shows no row). On by default, like the Codex usage poll: it rides Plan Usage Limits (`showPlanUsageLimits`), and turning that off stops the request. Read-only, redirects refused, the token never logged or stored; any failure leaves the row out. |
| Docker | The agent image installs `@github/copilot`. No credential directory is seeded (see below). |

### Your own endpoint (BYOK)

With custom model endpoints on, a saved endpoint is offered in the Run menu for Copilot and
launches straight onto it (no restart; the env is applied before the process starts):

| Codeman field | Variable |
| --- | --- |
| base URL (+ `/v1`) | `COPILOT_PROVIDER_BASE_URL` |
| key | `COPILOT_PROVIDER_API_KEY` |
| model | `COPILOT_MODEL` |

`COPILOT_PROVIDER_TYPE` is not set: it defaults to `openai`, which is what a Codeman custom
endpoint is (llama.cpp, vLLM, Ollama). All of these are privileged env keys.

Checked at the CLI level against a local OpenAI-compatible endpoint (1.0.95): it posted to
`/v1/chat/completions` with the key and the model name, needed no GitHub sign-in, and
`--resume <id> --model <m>` / `--continue --model <m>` resumed earlier sessions. Tool calls
through a custom endpoint were not exercised. Only keys are persisted (never values).

## Terminal behavior

Copilot is an alternate-screen TUI with mouse tracking on, so it needed one non-default
decision, the same one OpenCode needed:

- **Selection.** Left in, xterm reports a plain drag to the TUI instead of selecting, so
  Auto Copy and copy-on-select silently did nothing (only Shift+drag selected). The entry is
  `altScreen: 'strip-mux-and-mouse'`: the tracking DECSETs are stripped under tmux, a drag is
  a local selection, and clicks still reach Copilot through the browser's hand-encoded tap
  (`cliMouseTracking` is published as the server strips).
- **Wheel and touch.** Stripping the DECSETs also stops xterm encoding the wheel, so
  `_shouldForwardWheelToApp` forwards it by hand as SGR reports while Copilot is tracking the
  mouse; a phone swipe goes through the same gate. Shift+wheel scrolls Codeman's local
  history. If the tracking flag is stale after a server restart, the gesture falls back to
  PageUp/PageDown rather than going dead (Copilot pages its own transcript on those keys: three
  PageUp moved a 140-line answer from lines 109-140 to 010-042).
- **Keys.** Keystrokes from `tmux send-keys` and `POST /api/sessions/:id/input` reach the
  composer; Shift+Enter inserts a newline; shell tool calls complete inside tmux
  (github/copilot-cli#4180 and #4223 report both failing on 1.0.70 to 1.0.74; neither
  reproduces on 1.0.94).
- **Scrollbar.** Copilot draws a `┃` gutter at the right edge of every row; the response
  reader strips it.

## `codeman agent` verbs

The three `CODEMAN_*` variables are exported into every pane, so the
[session-to-session verbs](../README.md#codeman-agent--session-to-session-verbs-in-every-cli-mode)
work from inside a Copilot tab and against Copilot workers:

- `spawn` waits for the composer. The ready mark is the footer hint `/ commands · ? help`, **not**
  `❯`: the folder-trust dialog draws `❯ 1. Yes`, so the glyph would call a worker ready while it
  is still asking whether to trust the folder. An untrusted folder therefore makes `spawn`
  warn that the composer was not seen instead of claiming ready.
- `send --wait` resolves on `idle`. `--until stop` is refused (`400`, "no Claude Code hooks")
  like every hook-less mode; use `idle`, `exit` or a `--match` marker.
- `read` returns the last answer. Copilot's output stream is absolute cursor moves rather
  than lines, so the route reads the pane's **visible screen** (tmux `capture-pane`) and cuts it
  with a per-CLI pane dialect (`src/web/response-viewer-transcript.ts`): `❯ <prompt>   HH:MM`,
  `● <answer>` with indented continuation, and the cwd / `Session: N AIC used` row, composer,
  footer and scrollbar as chrome. Everything before the first prompt (banner, trust dialog) is
  dropped, so a session that has not been asked anything answers nothing.
- `interrupt` sends a bare ESC; `rm` refuses itself.

## Docker cases

The agent image installs `@github/copilot`, and a docker case runs Copilot like any mode. **No
credential directory is seeded**: without a keyring the sign-in token is plain text in
`config.json`, and `CRED_STORES` (`src/docker-hosts.ts`) deliberately has no `.copilot` row.
Sign in inside the container (`copilot login`). Setting `COPILOT_GITHUB_TOKEN` for the session does
not reach it: a docker quick-start refuses `envOverrides`, and Copilot's `dockerExecEnvNames` is
empty, so a token in the server environment is not forwarded either.

## Remote SSH cases

A remote or Docker pane runs a bare `copilot` (`defaultRemoteCommandForMode`, pinned in
`test/location-overlay-commands.test.ts`), in Copilot's own Manual Approval mode. The
`copilotConfig` flags (`--yolo`, `--model`, `--resume`, `--continue`) are a local-session feature
and are not sent there, so there is nothing for the privileged-param clamp to do. A remote host
needs its own `copilot` on its own PATH and its own sign-in. This path has unit coverage for the
built command but was not exercised against a real remote host.

## What Codeman deliberately does NOT wire up

- **No login or token storage.** See Authenticate.
- **No bypass inferred.** `--yolo` is sent only by the Run button's `allowAll`, never
  guessed from anything else, and is clamped for non-granted owners.
- **No `--api-key`-style flag on the command line.** Secrets travel as environment variables
  through `tmux setenv`.
- **No Claude-only features.** Auto-resume on a usage limit, the Approvals Inbox, Read My Mind,
  the Ralph tracker, subagent windows and the bundled agent skill are Claude-shaped.

## Known gaps

- `agent read` does not model tool-call rows: they open with the same `●` bullet and read as
  part of the answer.
- `agent read` sees the visible screen, so an answer longer than one screen is its tail.
- Custom endpoints: tool calls through a BYOK endpoint were not exercised.
- Remote SSH was not exercised against a real remote host.
