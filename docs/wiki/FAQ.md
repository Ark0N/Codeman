# FAQ

The questions that keep arriving in
[Discussions](https://github.com/Ark0N/Codeman/discussions) and issues. For "why is it
doing that", go to [Troubleshooting](Troubleshooting) instead.

## The basics

### What is Codeman, in one sentence?

A self-hosted dashboard that runs AI coding agents in persistent tmux sessions on your own
machine and lets you drive them from any browser, including a phone.

### Is it free? What is the licence?

MIT, free, and open source. There is no paid tier and no account.

### Do I need an API key?

No. Codeman drives agent CLIs you have already installed and logged in yourself. Whatever
subscription or key that CLI uses is what pays for the tokens. Codeman never collects,
stores, or refreshes your credentials.

### Which agent CLIs does it support?

Claude Code, OpenCode, Codex, Gemini, Antigravity, Pi, Grok Build, DeepSeek Harness,
OMP and GitHub Copilot CLI, plus a plain shell, chosen per session. Claude is the reference mode and a few features
are Claude-only; [Agent CLIs](Agent-CLIs) has the table.

### Does Codeman send my code or prompts anywhere?

No. There is no telemetry, no analytics, and no phone-home. The only network traffic
Codeman itself makes is between your browser and your server.

Your agent CLI is a separate matter: Claude Code talks to Anthropic, Codex talks to OpenAI,
and so on. That traffic is the CLI's, on your own account, exactly as it would be in a
terminal.

Two features do send data outward, both off by default and both stated where they appear:
voice dictation through your own Claude login, and the Read My Mind prediction call.

### Does it work on Windows?

Through WSL2. Codeman requires tmux. Install it inside WSL, run your agent CLI inside WSL,
and `http://localhost:3000` works from your Windows browser. Work in the Linux filesystem
rather than `/mnt/c/...`, which is dramatically slower for file watching and git.

### Is there a mobile app?

The web UI is built for phones and installs as a PWA. There is no App Store or Play Store
app.

## Sessions and persistence

### Do my agents keep running when I close the browser?

Yes. Agents run in tmux on the server, not in your browser. Close the tab, close the laptop,
lose the network. When you come back, the session is still there with its scrollback.

The same holds when the Codeman server itself restarts. What does end a session is killing
the tmux server or rebooting the machine.

### What happens after a reboot?

tmux dies with the machine, so the sessions are gone. Conversations are not: Claude
transcripts persist on disk, and the welcome screen's **Resume Conversation** list picks
them back up. Install Codeman as a service and the server itself comes back on boot.

### How many sessions can I run at once?

The design target is 20 sessions and 50 agent windows at 60fps. The hard cap is higher, and
what you will actually hit first is the CPU and memory of the machine running the agents.

### Can I run Claude Code and Codex side by side?

Yes, that is a normal setup. The run mode is per session, so one case can have a Claude tab,
a Codex tab, and a shell tab open at the same time, each with its own colour. Some Codeman
features are Claude-only; [Agent CLIs](Agent-CLIs) lists exactly which.

### Can I attach to a session from a terminal instead of the browser?

Yes. `codeman tui` is a full-screen dashboard of your sessions, with the same
NEEDS YOU / WORKING / IDLE grouping the web UI uses. `codeman tui --list` prints the
numbered list and exits, and `codeman tui 2` attaches straight to session 2. `Enter`
attaches, `F1` comes back. You can also use tmux directly on the `codeman` socket.

## Running unattended

### I hit my Claude usage limit overnight. Can Codeman resume automatically?

Yes, and it is the reason the feature exists. Turn on auto-resume at the top of the Respawn
tab for that session. When Claude halts on a subscription limit, Codeman parses the reset
time from the message, waits until two minutes past it, and continues the conversation.

Respawn cycles are blocked while a session is limit-paused, which is what stops a `/clear`
from wiping the conversation you are waiting to resume. Claude-only.

### Will it keep prompting my agent forever?

Only if you configure it to. Respawn cycling is per session and off unless you turn it on,
and it has presets ranging from a 60 minute solo session to an 8 hour overnight run. There
are circuit breakers to stop a thrashing session from spinning indefinitely. See
[Keeping Agents Running](Keeping-Agents-Running).

### Does an idle session cost tokens?

No. An idle agent is a process waiting for input. Tokens are spent when a turn runs, so what
costs money is the re-prompting you configured, not the session sitting there.

### Can I schedule work for a specific time?

Yes. [Cron Jobs](Cron-Jobs) saves named jobs on a `once`, `interval`, `daily`, or `weekly`
schedule; each spins up a session and sends a prompt when due, with per-job run history.

## Access

### How do I reach Codeman from my phone when I am away from home?

Tailscale is the recommended answer: your devices join a private network, Codeman keeps its
loopback bind, and you get real HTTPS. The installer sets it up, and `install.sh tailscale`
retrofits it onto an existing install.

A Cloudflare tunnel gives a public URL faster, and requires `CODEMAN_PASSWORD`. Full
comparison in [Remote Access](Remote-Access).

### Why can't other devices reach Codeman?

Because the default bind is `127.0.0.1`, on purpose. Codeman starts agents with permission
prompts skipped, so whoever reaches the dashboard can run code on your machine. Exposing it
is a deliberate step, and [Remote Access](Remote-Access) covers the safe ways.

### My reverse proxy domain is rejected with `403 host not allowed`

The always-on Host-header allowlist blocks DNS rebinding, and it does not know your domain.
Add it:

```bash
CODEMAN_ALLOWED_HOSTS='codeman.example.com,.internal.example.com'
```

A leading dot matches subdomains. Also make sure the proxy forwards WebSocket upgrades.

### Do I have to type a password on my phone?

No. Scan the QR code shown on the desktop dashboard. Tokens are single use and rotate every
60 seconds. The password remains the fallback.

## Multiple people, multiple instances

### Can several people share one Codeman?

Yes, with `codeman web --multiuser`. Each person gets a login and their own case space, and
sessions, cases, search, and events are scoped to their owner.

Be clear about what that is: it separates **workspaces**, not operating system accounts.
Every session still runs as the same OS user, so a determined user's agent can reach another
user's files. For real isolation, pair users with Docker cases or run separate instances
under separate OS accounts. See [Multi-User Mode](Multi-User-Mode).

### How do I run a second instance, a beta beside my main one?

Give it its own instance name, which scopes the data directory and the tmux socket together:

```bash
CODEMAN_INSTANCE=beta CODEMAN_PORT=5000 codeman web
```

Do not skip this. The data directory and tmux socket are process wide, so a second server on
the defaults discovers and attaches your live sessions.

## Updating and maintenance

### What is the right way to update Codeman?

| Install route | Update with                                                                 |
| ------------- | --------------------------------------------------------------------------- |
| Installer     | Re-run the install one-liner, or **App Settings → System → Updates**.         |
| npm           | `npm update -g aicodeman`                                                     |
| git clone     | `git pull && npm install && npm run build`, then restart the service.         |

The in-app updater covers git-clone installs supervised by systemd or launchd. It stashes a
dirty tree rather than discarding it, and streams progress across the restart. npm installs
report as non-updatable.

### Will updating kill my running sessions?

No. Sessions live in tmux, so restarting the server reattaches to them.

### Where is my data?

Everything under `~/.codeman/`, with cases created from scratch in `~/codeman-cases/`.
Nothing needs root and nothing leaves the machine. Uninstalling does not delete either
directory.

## Features

### What is the difference between respawn, Ralph, and the orchestrator?

- **Respawn** restarts a session's CLI when it goes idle, to keep a long run going. It is the
  one most people want.
- **Ralph loop** is an autonomous single-session task loop with its own tracker.
- **Orchestrator** turns one goal into a phased plan and drives it across agents.

[Keeping Agents Running](Keeping-Agents-Running) and [Autonomous Loops](Autonomous-Loops)
cover them properly.

### Can agents start and supervise other agents?

Yes. Codeman ships an agent skill that lets an agent inside a session drive the HTTP API:
list sessions, spawn workers in any installed CLI, send prompts, and block until a worker's
turn finishes. Install it once with `codeman skill install` or the Claude Code plugin, then
ask in plain English, for example *"use codeman to start 5 claude workers, one per TODO
item"*. The web UI setting that injects it into every new session's case is off by default.

See [The Codeman Skill](Codeman-Skill), with recordings of real runs, and
[Driving Codeman From An Agent](Driving-Codeman-From-An-Agent) for the other routes.

### Can I run a case in a container?

Yes. One container per case, shared by all its sessions, non-root and capability-dropped by
default, with your host CLI logins seeded in so nothing asks you to log in again. You can
export a container plus its workspace and move it to another machine. See
[Docker Cases](Docker-Cases).

### Can the agent run on a different machine?

Yes. Point a case at a remote host over SSH and the agent runs there, inside a durable
remote tmux, so a dropped connection does not kill the run. See
[Remote SSH Sessions](Remote-SSH-Sessions).

### Can I put my Grafana or other dashboards in here?

Yes. Saved URLs render as tabs beside your sessions, proxied through Codeman's own origin so
that mixed content and frame-blocking headers do not break them. See [Web Tabs](Web-Tabs).

### Why is a feature I read about not on screen?

Most of Codeman's UI is opt-in and defaults to off, so a stock install stays small. Check
**App Settings → Header & Panels**. [Settings Reference](Settings-Reference) lists the
defaults.

## Contributing

### How do I request a feature?

Open an [Idea](https://github.com/Ark0N/Codeman/discussions/categories/ideas) and it gets
voted on. Roadmap decisions happen there.

### How do I contribute code?

[CONTRIBUTING.md](https://github.com/Ark0N/Codeman/blob/master/.github/CONTRIBUTING.md) has
the full map. Small fixes can go straight to a PR; anything larger starts as an issue or
Discussion so the design gets a nod first. Skins, translations, and docs are good first
contributions.

### How do I fix a mistake in this wiki?

These pages are generated from
[`docs/wiki/`](https://github.com/Ark0N/Codeman/tree/master/docs/wiki) in the main
repository. Editing a page in the browser gets overwritten on the next sync, so send a PR
against that directory instead.
