# Agent CLIs

Codeman drives ten run modes: nine agent CLIs plus a plain shell. This page covers picking
one, setting it up, and the differences that actually change how you work.

## The ten modes

| Mode                 | CLI                          | Get it                                                                 |
| -------------------- | ---------------------------- | ---------------------------------------------------------------------- |
| **Claude Code**      | `claude`                     | [docs.anthropic.com](https://docs.anthropic.com/en/docs/claude-code)   |
| **OpenCode**         | `opencode`                   | [opencode.ai](https://opencode.ai)                                     |
| **Codex**            | `codex`                      | [developers.openai.com/codex/cli](https://developers.openai.com/codex/cli) |
| **Gemini**           | `gemini`                     | [github.com/google-gemini/gemini-cli](https://github.com/google-gemini/gemini-cli) |
| **Antigravity**      | `agy`                        | [antigravity.google](https://antigravity.google)                       |
| **Pi**               | `pi`                         | [pi.dev](https://pi.dev)                                               |
| **Grok Build**       | `grok`                       | [github.com/xai-org/grok-build](https://github.com/xai-org/grok-build) |
| **DeepSeek Harness** | `dsh`                        | [github.com/deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) |
| **OMP**              | `omp`                        | [github.com/can1357/oh-my-pi](https://github.com/can1357/oh-my-pi)     |
| **Terminal / Shell** | your `$SHELL`                | Already installed.                                                     |

Any combination works, including all of them. The run mode is chosen per session from the
arrow beside the **Run** button, so one case can have a Claude session and a Codex session
open side by side.

## Codeman does not manage your logins

Install each CLI yourself and log it in once by hand. Codeman never collects, stores, or
refreshes your CLI credentials. It launches the binary and attaches to the result.

The one place credentials are touched is [Docker Cases](Docker-Cases), where host
credentials are copied into a container read-only at launch so you do not have to log in
again inside it. Even there, the container keeps its own copies and never writes back to
your host credential stores.

## Making a CLI visible to Codeman

Codeman resolves each binary from the environment the **server** runs in, which is not
necessarily the shell you tested in.

```bash
codeman doctor          # what Codeman can actually see
codeman doctor --json
```

If a CLI is installed but a Run button for it never appears:

1. Check `which <cli>` in a plain login shell, not just your interactive one.
2. If Codeman runs as a service, remember that launchd hands a job
   `/usr/bin:/bin:/usr/sbin:/sbin`. `codeman service install` bakes your PATH into the unit
   precisely to avoid this; a hand-written plist or unit will not.
3. Restart the server after installing a new CLI.

`pi`, `grok`, `omp` and `dsh` are additionally identity-probed rather than trusted by name:
`pi` and `omp` are generic enough that something else on your PATH may answer to them,
`grok` has npm squatters, and Debian ships an unrelated `dsh` (dancer's shell). Each has a
status endpoint (`/api/grok/status`, `/api/deepseek/status`, `/api/omp/status`) that reports
the path and version that actually resolved, so a misresolution is visible rather than
presenting as "the mode just does not work".

## Claude is the reference mode

A number of Codeman features exist only for Claude sessions. This is structural, not a
backlog: they depend on Claude Code's hook system, or on parsing Claude's specific terminal
output. The other CLIs expose no equivalent.

| Feature                                          | Claude | Other CLIs                                          |
| ------------------------------------------------ | ------ | --------------------------------------------------- |
| Sessions, tabs, scrollback, exactly-once input    | Yes    | Yes                                                  |
| Respawn cycling and unattended runs               | Yes    | Yes                                                  |
| Cron jobs                                         | Yes    | Yes                                                  |
| Docker cases, remote SSH cases                    | Yes    | Yes                                                  |
| Precise idle detection                            | Yes    | Codex: same screen check, via its own prompt and working line. DeepSeek: reports its state itself. Others: output stabilization, coarser |
| Auto-resume when a usage limit resets             | Yes    | No                                                   |
| Plan usage chip                                   | Yes    | No                                                   |
| Approvals Inbox                                   | Yes    | DeepSeek yes; others no                              |
| Read My Mind                                      | Yes    | No                                                   |
| Ralph loop and its task tracker                   | Yes    | No                                                   |
| Subagent and team windows                         | Yes    | No                                                   |
| Model, effort, and ultracode controls             | Yes    | No                                                   |
| `stop` and `blocked` wait signals                 | Yes    | DeepSeek yes; elsewhere 400 if you ask for them explicitly |
| The bundled agent skill                           | Yes    | No                                                   |

Everything that makes a session a session works everywhere. What is Claude-only is mostly
the machinery that needs to know *what* the agent is doing rather than *that* it is doing
something.

## Per-CLI notes

### Claude Code

The defaults you will care about, all under **App Settings**:

- **Model** (Models section). Written into the case's `.claude/settings.local.json` as a
  soft default, so `/model` still works mid-session. The 1M-context Opus variant is a
  switch on the model card rather than a separate model.
- **Effort** (`low` through `max`) or **ultracode** for dynamic multi-agent workflows. Also
  a soft default: `/effort` overrides it any time. Effort is deliberately not passed as an
  environment variable, because that would hard-lock it and block in-session switching.
- **Startup permission mode** (Agents & CLIs section). The default is
  `--dangerously-skip-permissions`, which is why the security model matters. You can switch
  new sessions to Anthropic's classifier-guarded `auto` mode, normal prompting, or an
  explicit allowed-tools list.

**Separate Claude accounts per session.** Set `CLAUDE_CONFIG_DIR` in a session's environment
overrides to point it at a different Claude config directory, which is how you run one
session on a client's subscription and another on your own. One caveat: a relocated config
directory writes transcripts outside `~/.claude/projects`, which blinds the response viewer,
subagent windows, ultracode panel, and Read My Mind for that session. Symlink `projects`
back into the shared tree to keep them working:

```bash
ln -s ~/.claude/projects <configDir>/projects
```

### OpenCode

Renders its own TUI, so Codeman treats readiness as output stabilization rather than
watching for a prompt marker. Requires tmux, with no direct-PTY fallback, because its
environment is injected through socket-scoped `tmux setenv` rather than the command line.

Integration detail: [`docs/opencode-integration.md`](https://github.com/Ark0N/Codeman/blob/master/docs/opencode-integration.md).

### Codex

Two behaviours that are deliberate and worth knowing:

- **Predictive echo instead of buffered echo.** Codex's composer reacts to every keystroke,
  a `/` opens a live-filtering picker, arrows edit server-side state. Buffering keystrokes
  until Enter starved it, so Codex paints each keystroke at the predicted cell while the
  bytes on the wire stay byte-identical to what you typed.
- **The wheel is not forwarded** into its transcript. Codex ignores the mouse reports
  Codeman would send, so forwarding produced a dead wheel. Scrolling in a Codex session is
  local scrollback.
- **Work detection is Codex's own.** Codex declares its `›` composer glyph and its
  `esc to interrupt` working line, so it gets the same screen-checked idle detection Claude
  does; before 1.26.1 every Codex session reported idle for its whole life. Codex
  conversations also appear in Past Sessions and can be resumed, and on phones the keyboard
  bar grows `⇧←` / `⇧→` for Codex's queued-message editing and prompt stack.

### Gemini

Enterprise only, since Google's June 2026 consumer cutover. Its environment allowlist
includes the broad `GOOGLE_*` namespace, deliberately, because Vertex AI authentication
needs `GOOGLE_CLOUD_PROJECT`, `GOOGLE_APPLICATION_CREDENTIALS`, and
`GOOGLE_GENAI_USE_VERTEXAI`. That is the loosest allowlist entry in Codeman and it affects
only the CLI you spawned yourself.

### Antigravity

Google's successor to the consumer Gemini CLI, invoked as `agy`. It keeps all of its state
in `~/.gemini/antigravity-cli/`, so the credential handling that applies to Gemini applies
to it as well.

### Pi

Pi needs the opposite instincts from every other CLI here.

- **It has no permission prompts and no sandbox.** There is no bypass flag to send, and
  Codeman does not invent one.
- **Its privileged setting is project trust**, a three-way `--approve` / `--no-approve` /
  unset. Approving trust makes Pi **execute repo-local `.pi/extensions` TypeScript**, so
  point it at a repository you trust. In multi-user mode, a user without an explicit grant
  gets `--no-approve` even when no configuration exists.
- **Authentication is `/login` inside the session**, or the server process's own
  environment. Pi's roughly 34 provider keys (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`,
  `HF_TOKEN`, and so on) share no common prefix, and the environment allowlist is global
  rather than per mode, so admitting them for Pi would widen the allowlist for every mode at
  once. They stay out.

Guide: [`docs/pi-integration.md`](https://github.com/Ark0N/Codeman/blob/master/docs/pi-integration.md).

### Grok Build

xAI's `grok`, installed with `curl -fsSL https://x.ai/cli/install.sh | bash` into
`~/.grok/bin`. Codex-shaped on permissions and OpenCode-shaped on rendering:

- **Its bypass switch is `--always-approve`**, Grok's own `bypassPermissions` mode, and the
  Run button sends it the way it sends Codex's. In multi-user mode a user without a grant
  has it stripped.
- **Authentication is Grok's own**: browser OAuth on first run (a device-code screen inside
  a Codeman pane), `grok login --device-auth` for headless hosts, or `XAI_API_KEY` as a
  per-session environment override.
- It renders a full-screen TUI, so scrolling is local scrollback.

Guide: [`docs/grok-integration.md`](https://github.com/Ark0N/Codeman/blob/master/docs/grok-integration.md).

### DeepSeek Harness

The mode wired least like the others, for two reasons worth knowing before you use it.

**`dsh` is a launcher, not an agent.** It boots a *profile*, and the three DeepSeek ships
(`web`, `headless`, `base`) cannot drive a terminal pane. So "installed" and "runnable" are
different questions: the Run menu offers **DeepSeek** only once a pane-capable profile
exists, and until then shows **DeepSeek — add a terminal profile…**, which installs the
community `dsh-tui` with one click (`pnpm` must be on PATH, because the launcher spawns it
directly).

**Permissions are an environment variable, not a flag.** The harness has no
skip-permissions switch. `DSH_PERMISSION_MODE` (`read-only`, `workspace-write`,
`danger-full-access`) is the whole control, and it is the one setting Codeman deliberately
carries as an environment variable, because the harness reads it as a soft boot-time
default. In multi-user mode a user without a grant is clamped to `workspace-write`.

The reward for the odd wiring: **DeepSeek is the one non-Claude mode with real signals.**
Its terminal front door reports idle, working and blocked to Codeman, so a DeepSeek
session gets precise idle detection, the `stop` and `blocked` wait signals, and Approvals
Inbox items. Answers are read from the harness's own transcript on disk rather than
scraped off the pane. The model is not a session setting; it is part of the profile.

Guide: [`docs/deepseek-integration.md`](https://github.com/Ark0N/Codeman/blob/master/docs/deepseek-integration.md).

### OMP

Oh My Pi, installed with `curl -fsSL https://omp.sh/install | sh` into `~/.local/bin`.
OMP owns its auth, provider routing and approval mode entirely in `~/.omp`: there is no
Codeman-side login, key field, or bypass switch. Run `omp` once outside Codeman to finish
its own onboarding, and every session started through Codeman inherits that config. Its
documented default approval mode is `yolo`, so an OMP pane auto-approves tool use with no
flag from Codeman; change that in OMP's own config, not here.

OMP conversations appear in Past Sessions and can be resumed, and a respawn continues the
same conversation with `--continue`.

Guide: [`docs/omp-integration.md`](https://github.com/Ark0N/Codeman/blob/master/docs/omp-integration.md).

### Terminal / Shell

A plain shell in a tmux session. No agent, no hooks, no idle detection.

On phones a shell session automatically swaps the keyboard accessory bar for terminal
controls: Ctrl, Esc, Tab, arrows, paste. **Ctrl is a one-shot modifier**: tap it, then tap a
letter, and the control byte is sent. It disarms on use, on a second tap, on any other
accessory key, on a session switch, and when the keyboard closes. Details in
[Mobile Guide](Mobile-Guide).

## Environment overrides

Per-session environment variables are set when creating a session and persist across
respawns. Which variables are accepted depends on the mode:

| Mode        | Allowed prefixes                  |
| ----------- | --------------------------------- |
| Claude      | `CLAUDE_CODE_*`, plus the exact key `CLAUDE_CONFIG_DIR` |
| OpenCode    | `OPENCODE_*`                      |
| Codex       | `CODEX_*`                         |
| Gemini      | `GEMINI_*`, `GOOGLE_*`            |
| Antigravity | `ANTIGRAVITY_*`                   |
| Pi          | `PI_*`                            |
| Grok        | `GROK_*`, `XAI_*`                 |
| DeepSeek    | `DSH_*`, `DEEPSEEK_*`             |
| OMP         | `OMP_*`                           |

Anything outside the allowlist is rejected at the schema. This is intentional: the allowlist
is one global list, so widening it for one CLI widens it for all of them. In multi-user mode
the keys that could redirect a CLI's traffic or move its config home (`DSH_PERMISSION_MODE`,
`DSH_HOME`, `DEEPSEEK_BASE_URL`, `OMP_AUTH_BROKER_URL`, and the base URLs and config
directories of the others) are dropped for a user without the bypass grant.

Two things that deliberately do **not** travel as environment variables: **effort**, because
an environment variable hard-locks it and blocks `/effort`, and **model**, which is written
into the case's `.claude/settings.local.json` so that `/model` keeps working.

## Choosing a mode

- **Claude Code** if you want every Codeman feature. Unattended overnight runs, usage-limit
  auto-resume, the Approvals Inbox, and subagent visualization all assume it.
- **Codex, OpenCode, Gemini, Antigravity, Grok, OMP** when you prefer that agent or that
  model. You get the session layer, respawn, cron, Docker, and remote SSH; you do not get the
  hook-driven features.
- **DeepSeek Harness** if you want DeepSeek's models with real status signals. It is the one
  non-Claude mode that reports idle, working and blocked to Codeman itself.
- **Pi** if you want a fast, unsandboxed agent and you understand what project trust does.
- **Shell** for the times you want a terminal on your phone with no agent at all. It is a
  genuinely useful mode, not a fallback.

## Pointing one at your own server

Most of these harnesses can also run against a custom OpenAI-compatible endpoint instead of
their native cloud backend, for one session at a time, an opt-in feature covered in full on
[Custom Model Endpoints](Custom-Model-Endpoints).

## Read next

- [Core Concepts](Core-Concepts) - run modes versus location overlays.
- [Custom Model Endpoints](Custom-Model-Endpoints) - run a harness against your own server.
- [Settings Reference](Settings-Reference) - model, effort, and permission-mode settings.
- [Keeping Agents Running](Keeping-Agents-Running) - what idle detection does per mode.
- [Security](Security) - what skipping permission prompts actually means.
