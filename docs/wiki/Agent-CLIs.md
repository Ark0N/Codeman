# Agent CLIs

Codeman drives eleven run modes: ten agent CLIs plus a plain shell. This page covers picking
one, setting it up, and the differences that actually change how you work.

## The eleven modes

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
| **GitHub Copilot**   | `copilot`                    | [github.com/github/copilot-cli](https://github.com/github/copilot-cli) |
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

`pi`, `grok`, `omp`, `copilot` and `dsh` are additionally identity-probed rather than trusted by name:
`pi` and `omp` are generic enough that something else on your PATH may answer to them,
`grok` has npm squatters, and Debian ships an unrelated `dsh` (dancer's shell). Each has a
status endpoint (`/api/grok/status`, `/api/deepseek/status`, `/api/omp/status`, `/api/copilot/status`) that reports
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
| Precise idle detection                            | Yes    | Codex, Pi, OpenCode, OMP, Copilot, Gemini and Antigravity: same screen check, via their own prompt and working line. DeepSeek: reports its end of turn itself. Grok: generic cues only, unreliable |
| Auto-resume when a usage limit resets             | Yes    | No                                                   |
| Plan usage chip                                   | Yes    | Codex (limits) and Copilot (monthly premium requests); the others no |
| Approvals Inbox                                   | Yes    | DeepSeek and Codex as alerts (answer in the terminal); others no |
| Read My Mind                                      | Yes    | No                                                   |
| Ralph loop and its task tracker                   | Yes    | No                                                   |
| Subagent and team windows                         | Yes    | No                                                   |
| Model, effort, advisor, and ultracode controls    | Yes    | No                                                   |
| `stop` and `blocked` wait signals                 | Yes    | DeepSeek yes; Codex `blocked` only; elsewhere 400 if you ask for them explicitly |
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
- **Advisor** (Sonnet, Opus or Fable): a stronger model Claude consults at decision points,
  via Claude Code's [advisor tool](https://code.claude.com/docs/en/advisor). Also a soft
  default: `/advisor` switches it or turns it off inside the session.
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

Working and idle come from the screen: while a turn runs, OpenCode draws a small spinner at
the start of its footer (`⬝■■■■■■⬝  esc interrupt`), and Codeman reads that to tell a working
session from an idle one. A pending permission prompt shows as idle, since it is waiting on
you. Before 1.40.0 an OpenCode session that had run a tool showed as working for good.

Integration detail: [`docs/opencode-integration.md`](https://github.com/Ark0N/Codeman/blob/master/docs/opencode-integration.md).

### Codex

App Settings has synced **Default Codex model** and **Default Codex reasoning effort**
controls. Enter a model ID supported by your Codex provider; available reasoning levels
depend on the model and CLI version. Empty defaults use Codex's own configuration.
The defaults apply to local Codex sessions started from the Run menu, from Resume, and through
`POST /api/sessions` or `/api/quick-start`; scheduled (cron) jobs do not use them.
Explicit `codexConfig.model` / `codexConfig.reasoningEffort` values take precedence.
Custom model endpoints, Docker containers and remote host command overrides keep their own settings.
Changing a default affects new sessions and does not edit Codex configuration files.

Two behaviours that are deliberate and worth knowing:

- **Predictive echo instead of buffered echo.** Codex's composer reacts to every keystroke,
  a `/` opens a live-filtering picker, arrows edit server-side state. Buffering keystrokes
  until Enter starved it, so Codex paints each keystroke at the predicted cell while the
  bytes on the wire stay byte-identical to what you typed.
- **Wheel forwarding follows mouse tracking.** Codex with mouse tracking on gets the wheel
  forwarded like fullscreen Claude; otherwise it pages its own transcript when local history
  is empty, or scrolls locally.
- **Work detection is Codex's own.** Codex declares its `›` composer glyph and its
  `esc to interrupt` working line, so it gets the same screen-checked idle detection Claude
  does; before 1.26.1 every Codex session reported idle for its whole life. Codex
  conversations also appear in Past Sessions and can be resumed, and on phones the keyboard
  bar grows `⇧←` / `⇧→` for Codex's queued-message editing and prompt stack.
- **A dialog waiting for you turns the tab red.** Codex is launched with its approvals on
  unless you tick the bypass option, and it has no hooks to say it stopped, so Codeman reads
  its dialogs off the screen: a command, edit or network approval, a question it asks you
  (Plan mode), and the "Trust this folder?" prompt when it starts in a new folder. Each one
  raises the same red "needs you" alert a Claude permission prompt does, with the desktop
  notification, web push, webhook, the phone overview's NEEDS YOU row and an Approvals Inbox
  card, and the alert clears a few seconds after you answer. Answer in the terminal: Codeman
  never answers a Codex dialog for you, so the inbox card and the push carry no Approve or
  Deny buttons. While such a dialog is up the session shows as idle (a question used to show
  as working), and agents can wait on it with the `blocked` signal. "Implement this plan?"
  at the end of a plan is not counted, since the turn has ended there.

### Gemini

Enterprise only, since Google's June 2026 consumer cutover. Its environment allowlist
includes the broad `GOOGLE_*` namespace, deliberately, because Vertex AI authentication
needs `GOOGLE_CLOUD_PROJECT`, `GOOGLE_APPLICATION_CREDENTIALS`, and
`GOOGLE_GENAI_USE_VERTEXAI`. That is the loosest allowlist entry in Codeman and it affects
only the CLI you spawned yourself.

Working and idle come from the screen: while a turn runs, Gemini CLI draws a spinner line
(`⠦ Thinking... (esc to cancel, 6s)`) above its composer, and Codeman reads that. A tool
confirmation that waits for you shows as idle. Before 1.40.0 a Gemini session showed as
working for good after its first turn.

### Antigravity

Google's successor to the consumer Gemini CLI, invoked as `agy`. It keeps all of its state
in `~/.gemini/antigravity-cli/`, so the credential handling that applies to Gemini applies
to it as well.

- **Work detection reads its spinner row.** While a turn runs, `agy` animates an 8-dot braille
  frame and a label one row above the composer (`⣯  Generating...`; `Working...` and
  `Loading...` too), and its footer reads `esc to cancel`. Codeman matches that row, which is
  what puts the activity indicator on the tab. The frames are not the braille set Claude and
  Gemini use, which is why the tab used to look idle through a whole turn.
- **At rest the footer hint is the idle mark.** The composer's `>` is no good for that, since
  the submitted prompt is echoed as `> <text>` as well. `? for shortcuts` is drawn only at
  rest, and the turn's last repaint carries it. A shell call that waits for approval replaces
  the composer and the footer hint is not drawn there, so the tab keeps reading as working
  until you answer.

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
- **Work detection reads Pi's composer rule.** Pi has no prompt glyph; while a turn runs it
  puts a spinner into the rule above the composer (`── ⠏ Working ───`), and Codeman reads
  that to tell working from idle. Before 1.40.0 a Pi session that had started a turn showed
  as working for good.

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
same conversation with `--continue`. Codeman tells working from idle by reading OMP's status
bar, where a spinner and the elapsed time replace the `π` while a turn runs. Before 1.40.0
an OMP session that had started a turn showed as working for good.

Guide: [`docs/omp-integration.md`](https://github.com/Ark0N/Codeman/blob/master/docs/omp-integration.md).

### GitHub Copilot CLI

GitHub's `copilot`, installed with `npm install -g @github/copilot` (CLI management can run
that for you). Codeman recognises it only when `--version` answers `GitHub Copilot CLI`, and
`GET /api/copilot/status` reports the path and version that resolved.

**Quota in the plan usage chip.** While Copilot CLI is installed and signed in, the chip gains
a **Copilot** row with the calendar-month premium-request quota (requests used and the reset in
the tooltip). This is **on by default**, like the Codex usage poll: every 10 minutes the server
asks `api.github.com` for the quota with Copilot's own sign-in token (read-only, redirects
refused, the token never logged or stored). The token is read from `COPILOT_GITHUB_TOKEN`,
`GH_TOKEN` or `GITHUB_TOKEN`, or from the plain-text `~/.copilot/config.json`, so a sign-in kept
in the OS keychain (a macOS or desktop Linux keyring) shows no row. Any failure just leaves the row out. Turn off
**Plan Usage Limits** in App Settings to stop the request.

**Signing in.** Codeman does not log it in: run `copilot` once and use `/login`, or sign in
inside a Codeman tab. Copilot keeps the token in the OS keychain when there is one; a headless
server has none, so it offers to save it as **plain text in `~/.copilot/config.json`**, which is
what a service ends up with. To keep a token out of a file, give the service
`COPILOT_GITHUB_TOKEN` (Copilot reads it first, then `GH_TOKEN`, `GITHUB_TOKEN`). The token is
never copied into a [Docker case](Docker-Cases): sign in inside the container.

**Run button and permissions.** Run starts `copilot --yolo` (allow every tool, path and URL),
the same bypass switch the other agent CLIs get, so an unattended session never stops on an
approval. A multi-user user without the bypass grant gets a plain `copilot`, which is
Copilot's own Manual Approval mode. Model, permission mode and the rest are also changeable
inside its TUI.

**Options and resume.** `--model` is sent only by an API caller that sets `copilotConfig.model`; the Run menu has no Copilot model picker (a saved custom endpoint sets `COPILOT_MODEL` instead). A session from
Past Sessions continues with `--continue`, which resumes the most recent Copilot conversation
in that directory. A tab name you set yourself is passed as `--name`, so Copilot's own session
list reads like that tab (an automatic `w1-myapp` name is not pinned); Copilot refuses `--name`
together with `--resume`/`--continue`, so a continued session keeps the name it had.

**Your own endpoint.** With [custom model endpoints](Custom-Model-Endpoints) on, a saved
endpoint appears in the Run menu for Copilot. It is launched with Copilot's BYOK variables
(`COPILOT_PROVIDER_BASE_URL` with the `/v1` an OpenAI route needs, `COPILOT_PROVIDER_API_KEY`,
`COPILOT_MODEL`), needs no GitHub sign-in, and applies at launch with no restart.

**Working and idle.** A turn shows `◉ Working` in the footer, which is what Codeman reads;
a tool waiting for your approval replaces the composer and reads as idle. The model name is
read from the footer too. Copilot has no hooks, so the `stop` and `blocked` wait signals are
not available: wait on `idle`, `exit` or an output marker.

**Selecting and scrolling.** Copilot turns mouse tracking on itself. Codeman strips that, so a
plain drag selects text (and Auto Copy works) and clicks still reach Copilot. The wheel, and a
swipe on a phone, scroll Copilot's own transcript; Shift+wheel scrolls Codeman's local history.

**MCP servers.** [MCP server sync](Settings-Reference) includes Copilot's
`~/.copilot/mcp-config.json` (relocated by `COPILOT_HOME`), as a target and a source.

**From another agent.** The `codeman agent` verbs work from inside a Copilot tab and against
Copilot workers: `spawn` waits for the composer (not the folder-trust dialog), `send --wait`
resolves on `idle`, and `read` returns the last answer from the pane's visible screen. Tool-call
rows are not modelled and read as part of the answer, and `--until stop` is refused as for
every hook-less mode.

**Not available.** Auto-resume on a usage limit, the Approvals Inbox, Read My Mind and the
Ralph tracker, as for the other non-Claude CLIs.

Guide: [`docs/copilot-integration.md`](https://github.com/Ark0N/Codeman/blob/master/docs/copilot-integration.md).

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
| Copilot     | `COPILOT_*` (a token goes in `COPILOT_GITHUB_TOKEN`; `GH_TOKEN` and `GITHUB_TOKEN` are not accepted as per-session overrides) |

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
- **Codex, OpenCode, Gemini, Antigravity, Grok, OMP, GitHub Copilot** when you prefer that agent or that
  model. You get the session layer, respawn, cron, Docker, and remote SSH; you do not get the
  hook-driven features (Codex dialogs still raise the red alert and an alert-only inbox card,
  see [Codex](#codex) above).
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
