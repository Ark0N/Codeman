<p align="center">
  <img src="https://raw.githubusercontent.com/Ark0N/Codeman/master/docs/images/codeman-title.svg" alt="Codeman" height="56">
</p>

<h3 align="center">Mission control for AI coding agents</h3>

Codeman runs your coding agents on your own machine and puts them behind one dashboard you
can open from any device. It spawns Claude Code, OpenCode, Codex, Antigravity, Gemini, Pi,
Grok, DeepSeek Harness, or OMP inside persistent tmux sessions, streams the real terminal to the browser, and keeps
working while you are away from the keyboard: it re-prompts idle agents, resumes when a
subscription limit resets, runs jobs on a schedule, and shows every background subagent
live.

This wiki is the manual. The [README](https://github.com/Ark0N/Codeman) is the overview,
and the deep internals live in
[`docs/`](https://github.com/Ark0N/Codeman/tree/master/docs).

```bash
curl -fsSL https://getcodeman.com/install | bash
codeman web    # then open http://localhost:3000
```

---

## Start here

**New to Codeman**

1. [Installation](Installation) - requirements, the installer, npm and git clone routes, updating.
2. [Quick Start](Quick-Start) - from a running server to a working agent in five minutes.
3. [Core Concepts](Core-Concepts) - cases, sessions, run modes, and what survives a restart.
4. [The Dashboard](The-Dashboard) - reading the tab strip, the status dots, and the alerts.

**Already running it**

- [Agent CLIs](Agent-CLIs) - the ten run modes, their setup, and which features are Claude-only.
- [Mobile Guide](Mobile-Guide) - phone and tablet use, QR login, the touch keyboard bar.
- [Remote Access](Remote-Access) - Tailscale, Cloudflare tunnel, LAN plus password, QR login.
- [Keeping Agents Running](Keeping-Agents-Running) - idle detection, respawn cycling, auto-resume on usage limits.
- [Troubleshooting](Troubleshooting) - symptom-first index of things that actually break.

**Driving it from code**

- [Driving Codeman From An Agent](Driving-Codeman-From-An-Agent) - the bundled skill, worker sessions, wait primitives.
- [HTTP API](HTTP-API) - the envelope, auth, the endpoint map, SSE events.
- [Hooks And Integrations](Hooks-And-Integrations) - events flowing back into Codeman.

---

## Everything in the manual

### Getting started

| Page                            | What it answers                                     |
| ------------------------------- | --------------------------------------------------- |
| [Installation](Installation)    | How do I install it, update it, and remove it?      |
| [Quick Start](Quick-Start)      | How do I get one agent working right now?           |
| [Core Concepts](Core-Concepts)  | What is a case, a session, a run mode?              |

### Using it

| Page                                       | What it answers                                            |
| ------------------------------------------ | ---------------------------------------------------------- |
| [The Dashboard](The-Dashboard)             | What is the UI telling me?                                 |
| [Tile Grid](Tile-Grid)                     | How do I watch and drive several sessions side by side?    |
| [Agent CLIs](Agent-CLIs)                   | Which agent should this session run, and how do I set it up? |
| [Custom Model Endpoints](Custom-Model-Endpoints) | How do I point a session at my own OpenAI-compatible endpoint? |
| [Working With Files](Working-With-Files)   | How do I read, edit, and attach files?                     |
| [Input And Voice](Input-And-Voice)         | How do I talk to an agent, including by voice?             |
| [Mobile Guide](Mobile-Guide)               | How well does this work on a phone?                        |
| [Keyboard Shortcuts](Keyboard-Shortcuts)   | What can I drive from the keyboard?                        |
| [Settings Reference](Settings-Reference)   | What does this setting do, and why did it not follow me to my phone? |

### Keeping agents running

| Page                                                          | What it answers                                     |
| ------------------------------------------------------------- | --------------------------------------------------- |
| [Keeping Agents Running](Keeping-Agents-Running)              | How does it run unattended overnight?               |
| [Notifications And Approvals](Notifications-And-Approvals)    | How do I know an agent needs me, and answer from my phone? |
| [Cron Jobs](Cron-Jobs)                                        | How do I run an agent on a schedule?                |
| [Autonomous Loops](Autonomous-Loops)                          | What are the Ralph and Orchestrator loops for?      |
| [Watching Agents Work](Watching-Agents-Work)                  | How do I see what the subagents are doing?          |

### Where it runs

| Page                                          | What it answers                              |
| --------------------------------------------- | -------------------------------------------- |
| [Docker Cases](Docker-Cases)                  | How do I sandbox a project in a container?   |
| [Remote SSH Sessions](Remote-SSH-Sessions)    | How do I run the agent on another machine?   |
| [Web Tabs](Web-Tabs)                          | Can my Grafana live in here too?             |
| [Multi-User Mode](Multi-User-Mode)            | Can several people share one Codeman?        |

### Access and security

| Page                            | What it answers                                            |
| ------------------------------- | ---------------------------------------------------------- |
| [Remote Access](Remote-Access)  | How do I reach it from outside this machine, safely?       |
| [Security](Security)            | What is exposed, what protects it, what do I have to do?   |

### Automation and integration

| Page                                                              | What it answers                              |
| ----------------------------------------------------------------- | -------------------------------------------- |
| [Driving Codeman From An Agent](Driving-Codeman-From-An-Agent)    | How does an agent spawn and drive workers?   |
| [HTTP API](HTTP-API)                                              | What can I call, and what comes back?        |
| [Hooks And Integrations](Hooks-And-Integrations)                  | How do I wire Codeman into something else?   |

### Operating it

| Page                                          | What it answers                                    |
| --------------------------------------------- | -------------------------------------------------- |
| [Running As A Service](Running-As-A-Service)  | How do I keep it up across reboots, and update it? |
| [Troubleshooting](Troubleshooting)            | Why is it doing that?                              |
| [FAQ](FAQ)                                    | The questions that keep coming up.                 |
| [Contributing](Contributing)                  | How do I send a fix?                               |
| [Versioning](Versioning)                      | What does the version number promise?              |

---

## Requirements at a glance

| Thing        | Needed                                                                      |
| ------------ | --------------------------------------------------------------------------- |
| OS           | macOS or Linux. Windows works through WSL2.                                 |
| Node.js      | 22 or newer.                                                                |
| tmux         | Required. Sessions live in tmux, which is what makes them survive restarts.  |
| An agent CLI | At least one of Claude Code, OpenCode, Codex, Gemini, Antigravity, Pi, Grok Build, DeepSeek Harness, OMP. Plain shell sessions need none. |
| Network      | Binds to `127.0.0.1` by default. Reaching it from another device is a deliberate step: see [Remote Access](Remote-Access). |

Codeman is MIT licensed, self-hosted, and sends no telemetry. Everything runs on your
machine.

## Getting help

- **Questions and setup help**: [Discussions](https://github.com/Ark0N/Codeman/discussions), especially [Q&A](https://github.com/Ark0N/Codeman/discussions/categories/q-a).
- **Bugs**: [Issues](https://github.com/Ark0N/Codeman/issues). Include your OS, install method, browser, and which CLI the session was running.
- **Ideas and roadmap**: [Ideas](https://github.com/Ark0N/Codeman/discussions/categories/ideas).
- **Security**: never a public issue. See [SECURITY.md](https://github.com/Ark0N/Codeman/blob/master/.github/SECURITY.md).
