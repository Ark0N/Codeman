# Quick Start

From an installed Codeman to a working agent, in about five minutes. If you have not
installed yet, start at [Installation](Installation).

## 1. Start the server

```bash
codeman web
```

It prints a URL, `http://localhost:3000` by default. Open it.

The server binds `127.0.0.1` only, so this URL works from the machine running it and
nowhere else. That is deliberate: Codeman starts agents with permission prompts skipped by
default, so anyone who can reach the dashboard can run code on this machine. Reaching it
from your phone is a separate, deliberate step covered in [Remote Access](Remote-Access).

To keep it alive after you close the terminal, use `codeman web -d` instead, or install it
as a service. See [Running As A Service](Running-As-A-Service).

## 2. Meet the welcome screen

With no sessions running you get the welcome screen:

- **Run buttons** for each agent CLI Codeman found on your PATH. If you expected one and it
  is missing, its binary is not visible to the server; see [Agent CLIs](Agent-CLIs).
- **A QR code**, if a password is set. Scanning it logs a phone in without typing anything.
- **Resume Conversation**, a list of past sessions, including Claude conversations started
  outside Codeman. Empty on a fresh install.
- **Search**, across sessions, events, and files.

You can click a Run button right now and get a working agent in your current case. The rest
of this page is the deliberate version.

## 3. Pick or create a case

A **case** is a named working directory that Codeman remembers. Every session runs inside
one. The case picker is in the bottom toolbar.

To make a new one, click **+** next to the picker. The Add Case dialog has three tabs:

| Tab               | Use it when                                                                                                        |
| ----------------- | ------------------------------------------------------------------------------------------------------------------ |
| **Create New**    | Starting a fresh project. Creates `~/codeman-cases/<name>` and scaffolds a `CLAUDE.md` into it.                     |
| **Clone Repo**    | Working on an existing repo: public, or private once this machine's git can authenticate (the Docker image can include `gh`/`az` helpers for this). Paste the URL; Codeman preflights it as you type, offers the repo's real branches and tags, and fills in the case name. |
| **Link Existing** | The code is already on disk. Point at the folder, with **Browse** if you would rather click than type.               |

The gear next to the picker holds two per-case toggles: **Agent Teams** and
**1M Opus Context**. Both are off by default and both are safe to ignore for now.

**Create New** also has a checkbox for running the case inside a Docker container, and a
**Remote** panel for running it over SSH on another machine. Those are
[Docker Cases](Docker-Cases) and [Remote SSH Sessions](Remote-SSH-Sessions); skip them for
your first session.

## 4. Pick a run mode and hit Run

The **Run** button starts an agent in the selected case. The arrow next to it picks which
one:

| Mode                 | What starts                                                    |
| -------------------- | -------------------------------------------------------------- |
| **Claude Code**      | The default, and the mode every Codeman feature supports.       |
| **OpenCode**         |                                                                 |
| **Codex**            | OpenAI's CLI.                                                   |
| **Gemini**           | Enterprise only since Google's consumer cutover.                |
| **Antigravity**      | Google's successor to the consumer Gemini CLI.                  |
| **Pi**               | No permission prompts and no sandbox by design.                 |
| **Grok Build**       | xAI's CLI.                                                      |
| **DeepSeek Harness** | Needs a terminal profile; the menu offers to install one.       |
| **OMP**              | Oh My Pi, configured entirely through its own `~/.omp`.          |
| **Terminal / Shell** | A plain shell, no agent. Also the **Run Shell** button.          |

The dropdown also lists any saved dashboard URLs ([Web Tabs](Web-Tabs)) and your recent
sessions. Those do not change the run mode: Run always means "start an agent".

Click **Run**. A tab appears, and Codeman spawns the CLI on a real PTY inside a tmux
session and streams it to your browser.

The number spinner beside the button starts several sessions at once, up to 20. Useful for
fanning the same case out across parallel workers; unnecessary for a first run.

## 5. Talk to the agent

Click into the terminal and type. It is a real terminal (xterm.js over a real PTY), so full
TUIs render properly and everything the CLI supports works, slash commands included.

| Key                          | Effect                                        |
| ---------------------------- | --------------------------------------------- |
| `Enter`                      | Send.                                          |
| `Shift+Enter` / `Ctrl+Enter` | Newline without sending.                       |
| `Ctrl+C`                     | Copy if text is selected, otherwise interrupt. |
| `Ctrl+Shift+V`               | Voice input.                                   |

You can also paste or drag an image straight into the session, and register external files
as attachments. See [Working With Files](Working-With-Files) and
[Input And Voice](Input-And-Voice).

Input is delivered **exactly once**, even if your connection drops mid-prompt. A dropped
link never loses a prompt and never sends it twice.

## 6. Read the tab

The tab tells you what the session is doing without opening it:

| Signal                | Meaning                                                    |
| --------------------- | ---------------------------------------------------------- |
| Green dot             | Alive and idle.                                             |
| Pulsing green dot     | Working on a turn.                                          |
| Yellow, blinking      | Waiting for you to type something.                          |
| Red, blinking         | A question or permission prompt is blocking the agent.      |

Full tour in [The Dashboard](The-Dashboard). If you want a phone notification when an agent
needs you, that is [Notifications And Approvals](Notifications-And-Approvals).

## 7. Leave, and come back

Close the browser tab. Close the laptop. The agent keeps running, because it lives in tmux
and not in your browser.

Reopen the dashboard and the session is still there with its scrollback intact. First load
of a session pulls the full tmux scrollback, so you get the history, not just what arrived
after you reconnected.

This also survives restarting the Codeman server itself. What does not survive is killing
the tmux server or rebooting the machine.

## 8. Stop things

| To do this                | Do that                                                             |
| ------------------------- | ------------------------------------------------------------------- |
| Interrupt the current turn | `Ctrl+C` with nothing selected, or the **Stop** button.            |
| Close one session          | `Ctrl+W`, or the tab's close control.                              |
| Stop the server, keep agents | `codeman web --stop`. The tmux sessions stay alive.              |
| Stop everything            | `tmux -L codeman kill-server`.                                     |

If you are working *inside* a Codeman-managed session (`echo $CODEMAN_MUX` prints `1`),
never run `tmux kill-session` or `pkill claude` by hand. You will kill the session you are
sitting in, along with its siblings.

## Where to go next

**Make it run without you.** [Keeping Agents Running](Keeping-Agents-Running) covers idle
detection, respawn cycling, and auto-resume when a subscription limit resets. That is the
feature Codeman exists for.

**Get it on your phone.** [Remote Access](Remote-Access), then
[Mobile Guide](Mobile-Guide).

**Understand what you just used.** [Core Concepts](Core-Concepts) explains cases, sessions,
run modes, and what state lives where.

**Automate it.** [Cron Jobs](Cron-Jobs) for scheduled work,
[Driving Codeman From An Agent](Driving-Codeman-From-An-Agent) for agents that spawn and
supervise other agents.
