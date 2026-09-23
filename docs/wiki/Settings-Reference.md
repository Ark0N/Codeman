# Settings Reference

Two settings surfaces, and the rule that explains why a setting you changed on your laptop
did not follow you to your phone.

| Surface             | Scope                          | Opened from                  |
| ------------------- | ------------------------------ | ---------------------------- |
| **App Settings**    | Global, this Codeman install.  | The header gear.             |
| **Session Options** | One session.                   | The session's tab.           |

App Settings is a single scrolling document with a rail acting as a table of contents;
clicking a rail entry scrolls rather than switching. Session Options genuinely switches
panels.

## Per-device versus synced

Some settings live on the server and follow you to every device. Others are stored in the
browser and stay put. This is deliberate, not an oversight: your phone wants a different
font size, a different keyboard bar, and a different set of header buttons than your
desktop.

| Category                | Examples                                                                        |
| ----------------------- | ------------------------------------------------------------------------------- |
| **Per-device, local**   | Skin, WebGL renderer, local echo, CJK input, extended keyboard bar, File Viewer and Cron header buttons. Never sent to the server at all. |
| **Per-device policy**   | Most `show*` toggles, plan usage chip, language. Stored server-side, but a device only takes the server value when it has no local one of its own. |
| **Synced**              | Models, effort, CLI options, notification preferences, voice settings, display name, the agent skill and approvals toggles. |

The practical rule: **appearance and input are per device, behaviour is shared.** If a change
did not follow you, it is in one of the first two rows, and you change it again on that
device.

## App Settings

### Updates

Current version, a manual check, and the in-app updater. Covers git-clone installs
supervised by systemd or launchd; npm installs report as non-updatable. See
[Running As A Service](Running-As-A-Service).

### Terminal & Input

| Setting                       | Default              | Notes                                                                 |
| ----------------------------- | -------------------- | --------------------------------------------------------------------- |
| Local Echo                    | On for touch devices | Paints keystrokes locally and flushes on Enter. See [Input And Voice](Input-And-Voice). |
| CJK Input                     | Off                  | IME composition through a dedicated text field.                        |
| Extended Keyboard Bar         | Per device           | Which accessory bar phones get. Shell sessions override it while they are active. |
| Wheel Scrolls Local History   | Off                  | Keeps the wheel on the local buffer instead of forwarding it to the CLI. |
| Auto Copy Selection           | Off                  | Copies highlighted terminal text to the clipboard the moment you finish selecting it. Ctrl+C still copies on demand. |
| Trim The Pane Margin On Copy  | On                   | Takes the left margin a full-screen agent CLI paints down its own edge off a copy, so the text pastes flush. Each CLI declares its own width, and the strip never exceeds the indent every selected line shares, so nesting is kept. Claude Code and Codex declare a margin; a shell does not. |
| Normal / Bold font weight     | xterm defaults       | Per device, each slot from 100 to 900. The bundled JetBrains Mono renders every step, so a lighter normal weight makes Claude's bold headings stand out. Applies live to the terminal, both echo overlays and open team panes. |
| WebGL Renderer                | On                   | With a GPU-stall watchdog that falls back to DOM rendering.            |
| Gesture Control               | Off                  | Camera hand tracking. Also needs `CODEMAN_GESTURE=1` on the server.    |

### Header & Panels

Chips for every optional header control, with a live preview of the resulting header:

Run, Font Size, System Stats, Redraw Terminal, Response Viewer, Away Digest, Session
Manager, Attachments, File Viewer, Multi-monitor, Split, Plan Usage, Lifecycle Log, Monitor,
Project Insights, File Browser, Subagents, Approvals Inbox, Read My Mind, Ultracode Agents,
Ultracode Windows, Cron.

Most default to off. The stock desktop header is system stats, File Viewer, and the gear.
New header controls never appear on phones. Split is desktop-only regardless of this
setting — the button and the feature both stay off below a ~1180px viewport, where two
resizable panes plus their divider have nowhere to go.

This section also holds background-agent tracking, including whether to track agents for
every session or only the active tab.

### Appearance

| Setting                | Notes                                                                                     |
| ---------------------- | ----------------------------------------------------------------------------------------- |
| Skin                   | Theme palettes, light ones included. Applied before first paint, so no flash of the wrong theme. |
| Entrance Animations     | Per-surface animation styles for tabs, terminals, windows, and lineage lines. All default to the legacy no-animation behaviour. |
| Display Name           | Your name in the UI. Cosmetic only; it never renames the package, CLI, API, or storage.    |
| Interface Language     | English or Simplified Chinese. Per device.                                                 |
| Session List Layout    | Header tab strip (default), a collapsible left sidebar, or the sidebar with detailed rows. See [The Dashboard](The-Dashboard#session-list-layout). |
| Tab Orientation        | Keeps the header list but turns the strip vertical beside the terminal, resizable, with detailed rows by default. Desktop and tablet only. |
| Vertical Rail Order    | *By activity* (default) sorts the rail the way the home screens are sorted; *Manual* keeps your tab order and drag-reordering. |
| Tall Tabs              | Taller tab strip.                                                                          |
| Pop-out Button on Tabs | Adds the detach control to tabs, with a per-tab override.                                  |
| Spawn Lineage Lines    | Arcs from a parent tab to sessions it spawned. Desktop only, on by default.                |
| Auto-name Sessions     | Titles a new tab after its first prompt, keeping the case prefix (`w3-myapp: fix the login redirect`). Synced, off by default. See [The Dashboard](The-Dashboard#automatic-session-names). |
| Overview Home Screen   | The phone home screen. On by default.                                                      |

### Models

Claude model cards, the 1M context window switch, and the thinking effort segment. The cards
and the switch compose into one model choice, so there is no separate "which one wins"
question.

Model and effort are both **soft defaults**: the model is written into the case's
`.claude/settings.local.json` and effort is passed at start, so `/model` and `/effort`
inside a session override them at any time.

**Custom model endpoints** (off by default) adds a saved-endpoint list plus a matching
section to the Run dropdown, for pointing a harness at your own OpenAI-compatible server
instead of its native cloud backend. See [Custom Model Endpoints](Custom-Model-Endpoints).

### Agents & CLIs

| Setting                          | Notes                                                                                        |
| -------------------------------- | -------------------------------------------------------------------------------------------- |
| Startup Mode                     | Claude's permission mode for new sessions. Default skips prompts; `auto` uses Anthropic's classifier-guarded mode; `normal` prompts; or give an explicit allowed-tools list. |
| Allowed Tools                    | The list used by the explicit mode.                                                            |
| Ralph / Todo Tracker             | Enables the Ralph loop surfaces.                                                               |
| Agent Teams                      | Experimental teams. Also needs the CLI's own environment flag.                                 |
| Codeman Agent Skill              | Injects the agent skill into new Claude sessions per case. Off by default. See [Driving Codeman From An Agent](Driving-Codeman-From-An-Agent). |
| Remote auto-reconnect            | Reattaches dropped remote SSH sessions. On by default.                                         |
| Nice priority / value            | Runs agent processes at a lower CPU priority.                                                  |
| Bypass approvals and sandbox     | Pi's project trust. Read [Agent CLIs](Agent-CLIs) before enabling.                             |
| Animated status effects          | Cosmetic.                                                                                      |

### Notifications

Master toggle, browser notifications, push subscription, audio alerts, and the idle
threshold that decides when a quiet session counts as needing you. See
[Notifications And Approvals](Notifications-And-Approvals).

### Voice

Active provider and the engine behind it, insert mode, language, domain keywords to bias
recognition, the Deepgram API key, and the opt-in switch for transcribing through this
server's Claude login, with its live credential status. See
[Input And Voice](Input-And-Voice).

### Shortcuts

Rebinding for the shortcut registry. See [Keyboard Shortcuts](Keyboard-Shortcuts).

### System

`CLAUDE.md` template for new cases, default working directory, the image watcher, and
Cloudflare tunnel controls including the tunnel and upload URLs. In multi-user mode, the
**Users** administration entry is injected here.

## Session Options

Per session, from the tab.

| Panel            | Contains                                                                                   |
| ---------------- | ------------------------------------------------------------------------------------------- |
| **Respawn**      | Auto-resume on usage limit, the respawn cycle configuration, presets, duration. See [Keeping Agents Running](Keeping-Agents-Running). |
| **Session**      | Name, working directory, environment overrides, per-tab pop-out override.                    |
| **Ralph / Todo** | Loop configuration, iteration and todo caps, circuit breaker reset. See [Autonomous Loops](Autonomous-Loops). |
| **Summary**      | What this session has done: tokens, activity, run summary.                                   |

Panels that only make sense for Claude are hidden for other run modes rather than shown and
failing.

## Environment variables

Some things are configured before the server starts, not in the UI:

| Variable                            | Effect                                                                 |
| ----------------------------------- | ---------------------------------------------------------------------- |
| `CODEMAN_PORT`                      | Listen port.                                                            |
| `CODEMAN_HOST`                      | Bind address. Loopback by default.                                      |
| `CODEMAN_PASSWORD` / `CODEMAN_USERNAME` | HTTP Basic credentials. Username defaults to `admin`.               |
| `CODEMAN_ALLOWED_HOSTS`             | Extra Host and Origin allowlist entries for a reverse proxy.            |
| `CODEMAN_INSTANCE`                  | Scopes the data directory and tmux socket together. Required for a second instance. |
| `CODEMAN_MULTIUSER`                 | Enables multi-user mode.                                                |
| `CODEMAN_GESTURE`                   | Makes gesture control available to be enabled.                          |
| `CODEMAN_DOCKER_BRIDGE_HOOKS`       | Lets in-container hooks reach the host on a loopback bind.              |
| `CODEMAN_FILE_PICKER_ROOTS`         | Extra roots for the path picker.                                        |
| `CODEMAN_ALLOW_UNAUTHENTICATED_NETWORK` | Acknowledges exposing the server with no password.                  |
| `CODEMAN_BASE_URL`                  | Mounts Codeman under a sub-path behind a reverse proxy that forwards the prefix unchanged. See [Remote Access](Remote-Access). |
| `CODEMAN_MAX_DOWNLOAD_BYTES`        | Cap on raw file bodies and downloads. 2 GB by default, `0` for none.    |
| `CODEMAN_MAX_REMOTE_FILE_SSH`       | Concurrent ssh reads for files in remote cases. 4 by default.           |

## Gotchas

- **A setting that did not sync is per device.** Change it again on that device.
- **The plan usage chip and its telemetry exporter are one setting.** Enabling the chip
  without the exporter would leave it blank forever, so it is deliberately not separable.
- **Toggling a header button does nothing on a phone.** Phones deliberately ignore most of
  the header chips.
- **Enabling a feature does not retroactively configure existing sessions.** The agent skill
  injection, for instance, applies at session creation.

## Read next

- [The Dashboard](The-Dashboard) - what each control does once visible.
- [Keeping Agents Running](Keeping-Agents-Running) - the Respawn panel in depth.
- [Agent CLIs](Agent-CLIs) - model, effort, and permission modes.
