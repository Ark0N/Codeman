# Grok Build (xAI) sessions

Codeman can drive [Grok Build](https://github.com/xai-org/grok-build) (xAI's `grok`
CLI, the agent behind docs.x.ai/build) as a session backend, alongside Claude Code,
OpenCode, Codex, Gemini, Antigravity and Pi. `grok` is a seventh **run mode**: its own
PTY, its own tmux session, its own tab identity (monochrome charcoal, `gk` badge). It
is not a location overlay like Docker or remote-SSH cases, and it is not a web tab.

The design rationale behind each decision below lives in
[`grok-integration-plan.md`](./grok-integration-plan.md). Everything here was verified
against grok 1.0.5.

## Install

```bash
curl -fsSL https://x.ai/cli/install.sh | bash
```

The installer places the binary in `~/.grok/bin` and symlinks it into `~/.local/bin`
(it also installs an `agent` alias Codeman ignores). `grok update` self-updates.

Codeman resolves the binary via the server PATH and then the usual install locations,
`~/.grok/bin` first. **`grok` is a name with known squatters** (the unrelated
`@vibe-kit/grok-cli` npm package also installs a `grok` bin), so like `pi` the
resolver does not trust a PATH hit on its own: it runs `grok --version` once and
requires version-shaped output (`grok 1.0.5 (5115b46bc9)`). Check what it resolved:

```bash
curl -s localhost:3000/api/grok/status | jq
# { "available": true, "path": "/home/you/.grok/bin", "version": "1.0.5" }
```

The endpoint carries `version` on top of the sibling `/api/*/status` shape precisely
so a misresolution is visible rather than presenting as "the mode just doesn't work".

## Authenticate

- **Browser OAuth (default)**: the first `grok` run opens a sign-in flow; in a
  Codeman pane you get the device-code screen with a URL to open elsewhere.
  Credentials land in `~/.grok/auth.json` (0600) and refresh automatically.
- **Device code**: `grok login --device-auth`, made for SSH boxes and headless hosts.
- **API key**: `export XAI_API_KEY="xai-..."` (console.x.ai). Used as a fallback when
  no session token exists. As a per-session Codeman `envOverride` it flows through
  socket-scoped `tmux setenv`, never the spawn command line.
- **Enterprise OIDC**: `GROK_OIDC_ISSUER` / `GROK_OIDC_CLIENT_ID`.

## What Codeman wires up

`GrokConfig` (per session, persisted in `state.json`, round-trips through respawn):

| Field             | Flag                        | Notes                                                                 |
| ----------------- | --------------------------- | --------------------------------------------------------------------- |
| `model`           | `--model <v>`               | e.g. `grok-4.5`, or a custom `[model.<name>]` from `config.toml`      |
| `alwaysApprove`   | `--always-approve`          | Grok's `bypassPermissions` mode; deny rules still apply on top        |
| `continueSession` | `--continue`                | Most recent session for the working directory; skipped when resuming  |
| `resumeSessionId` | `--resume <v>`              | Ids only, never titles (grok's own `--resume` also matches titles)    |

Every value is regex-validated and **dropped** (not escaped) if it fails, because the
result is interpolated into the pane's `bash -c "..."` command.

The Run button sends `grokConfig: { alwaysApprove: true }`, the same product decision
as Claude's `--dangerously-skip-permissions` default and Antigravity's
`--dangerously-skip-permissions`: Codeman sessions exist for autonomous work. Keep
hard limits as `deny` rules in `~/.grok/config.toml` (they apply in every mode), and
in **multi-user mode** a non-granted owner's `alwaysApprove` is forced off
server-side; a bare `grok` spawn is grok's own ask-mode default.

Env overrides: the `GROK_*` prefix (`GROK_HOME`, `GROK_CONFIG`, `GROK_MEMORY`,
`GROK_WORKFLOWS`, `GROK_SANDBOX`, `GROK_OIDC_*`, ...) plus the `XAI_*` vendor
namespace (`XAI_API_KEY`) are allowlisted. Foreign provider keys are not, as ever.

## What Codeman deliberately does NOT wire up

- **`--permission-mode`, `--allow`/`--deny`.** The boolean covers the autonomous
  case; the full rule surface is a follow-up with UI.
- **`-p`/headless, `--output-format`, `--json-schema`.** Codeman drives the TUI.
- **`--worktree`, `--sandbox`, `--reasoning-effort`, `-s/--session-id`,
  `--fork-session`, `--agent`/`--agents`.** Tracked as follow-ups in the plan doc.

## Terminal behavior

Grok renders a **fullscreen alternate-screen TUI** (scrollback pane + prompt, mouse
supported). Under Codeman it runs inside tmux like every external CLI, so the
fullscreen rendering stays inside the pane and the browser terminal shows tmux's
repaints; grok stays out of the alt-screen strip list on purpose (the opencode case,
not the Ink case). If a pane renders oddly, `grok doctor` checks terminal, color and
input support without starting a session, and `~/.grok/pager.toml` can force
`alt_screen = "inline"`.

On touch devices grok currently gets the buffered local-echo overlay like Claude,
Gemini, OpenCode and Pi. This is the fallthrough default and has not been measured
against an authenticated grok composer; if grok turns out per-keystroke reactive the
way codex was (issues #218/#219/#220/#222), the fix is the `'off'` branch in
`_updateLocalEchoState` (terminal-ui.js).

## Docker cases

The agent image installs grok in its own Dockerfile step (not npm; xAI's installer
targets `$HOME/.grok/bin` with no `--dir` override, so the binary is copied to
`/usr/local/bin`). Rebuild with the mandatory `--no-cache`:

```bash
node scripts/build-agent-image.mjs --no-cache
```

Credentials are **seeded**, not shared: `auth.json`, `config.toml` and `pager.toml`
are copied into the container's own `~/.grok`, so an in-container grok never writes
refreshed OAuth tokens back to the host and `docker commit` exports stay secret-free.
Only those three files, because `~/.grok` also holds `sessions/`, `memory/` and the
~160MB binary under `downloads/`. Trade-off, same as pi: in-container sessions are
invisible host-side, so `grok -c` inside a Docker case only sees that container's own
history.

## Remote SSH cases

`grok` mode is routed through an interactive login shell
(`exec "$SHELL" -i -l -c 'grok'`), because sshd's remote-command PATH does not include
`~/.grok/bin`. Per-session config and `envOverrides` do not cross ssh and are rejected
rather than silently ignored; use the per-host command override instead. For auth on
the remote host, `grok login --device-auth` exists for exactly this.

## Known gaps

- **No idle/completion hook yet.** The registry entry declares no `workDetect` prompt
  marker or working line, which is what gives Codex, OpenCode, Gemini, Pi, OMP and
  Antigravity a screen check. So Codeman calls a new grok pane idle 3 seconds after launch, and after
  that it has only generic cues: Claude's `❯` marker, which grok does not print (see the
  cron item below), and a braille spinner glyph. Working and idle are unreliable for
  grok. Grok has a hooks system, so a Codeman hook POSTing to
  `/api/hook-event` is the highest-value follow-up.
- **No response viewer.** Grok writes ACP JSONL sessions under
  `~/.grok/sessions/<encoded-cwd>/<session-id>/updates.jsonl`; nothing reads them yet.
- **Cron jobs mis-detect readiness.** The readiness poll looks for `❯` or a token
  count, neither of which grok prints, so a grok cron job burns its poll budget and
  then sends the prompt anyway. It works; it is just slower to start.
- **Ralph, respawn heuristics, token/CLI-info parsing and the `❯` readiness probe are
  off** for grok, as for every external CLI.
