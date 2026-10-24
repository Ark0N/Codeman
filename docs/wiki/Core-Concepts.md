# Core Concepts

The five ideas the rest of the manual assumes: cases, sessions, run modes, location
overlays, and tmux. Plus what actually persists, and where it lives on disk.

## Case

A **case** is a named working directory that Codeman remembers. It is the unit you pick in
the toolbar before hitting Run, and every session belongs to exactly one.

A case is not a container or a sandbox. It is a folder plus a name plus a little
Codeman-side configuration:

- Which CLI the Run button should default to.
- Per-case toggles (Agent Teams, 1M Opus context).
- A **Default session group** (Case settings…): new sessions of the case land in that tab group of the
  vertical rail unless you start them from a group's own *New session* or they follow the session that
  spawned them. *Ungrouped* turns it off. It follows you across devices, never moves existing tabs, and a
  deleted group simply falls back to Ungrouped.
- Where it runs, if it is not the local filesystem: see [Location overlays](#location-overlays).

Three ways to get one, all under **New or link a case…** at the bottom of the case picker
(the case dropdown in the bottom toolbar; on a phone, the case sheet's **Create New Case**):

| How               | Result                                                                                                 |
| ----------------- | ------------------------------------------------------------------------------------------------------ |
| **Create New**    | A fresh `~/codeman-cases/<name>` with a scaffolded `CLAUDE.md`, or with **Create in a custom folder**, a new folder inside a parent you choose, scaffolded the same way and registered in place like a linked case. |
| **Clone Repo**    | A repo cloned into `~/codeman-cases/<name>` and registered as a case. Private repos need this machine's own git credentials (see below). |
| **Link Existing** | An existing folder anywhere on disk, registered in place. Nothing is copied or moved.                    |

Linked cases keep living where they are. Deleting a case in Codeman removes the
registration, and for a linked case that is all it removes.

**Clone Repo never asks for credentials.** It uses whatever the server's own git already has:
an ssh key, or a credential helper such as `gh auth setup-git`. The Docker image can include
helpers for GitHub (`gh`) and Azure DevOps (`az`), turned on in `docker-compose.override.yml`;
then signing those CLIs in once from a shell session is enough. See the private repositories
section of `docker/README.md`. Without credentials a private repo fails straight away with an
authentication error.

**Cases created from scratch are the only copy of that code.** Uninstalling Codeman does not
delete `~/codeman-cases/`, but treat that directory as real work, not scratch space.

## Session

A **session** is one CLI process running in one tmux session, streamed to your browser.

Sessions are named `w<n>-<case>`, so `w1-myproject` is the first worker in the `myproject`
case. Each has a stable id, and that id is what the API, the wait primitives, and every
event use.

Several sessions can share one case. That is the normal way to parallelize: three workers
in the same repo, three tabs, one case. They then also share one folder; when the workers
edit and commit in parallel, give each its own checkout with [Git Worktrees](Git-Worktrees).

A session carries state the case does not:

- Its run mode, model, effort level, and environment overrides.
- Its respawn configuration and Ralph loop state.
- Its terminal scrollback.
- Its owner, in [Multi-User Mode](Multi-User-Mode).

## Run mode

The **run mode** is which CLI the session runs: `claude`, `opencode`, `codex`, `gemini`,
`antigravity`, `pi`, `grok`, `deepseek`, `omp`, `copilot`, or `shell`. It is chosen at start and does not change afterwards; to
switch, start another session.

Claude is the reference mode. Nine of the ten are not Claude, and a number of Codeman
features are Claude-only for structural reasons rather than missing effort: they depend on
Claude Code's hook system or on parsing its terminal output. Every such feature is labelled
Claude-only where it appears, and [Agent CLIs](Agent-CLIs) lists them in one place.

## Location overlays

Where a case runs is **separate from** which CLI it runs. There are three locations:

| Location       | What happens                                                                                                 |
| -------------- | ------------------------------------------------------------------------------------------------------------ |
| **Local**      | The default. tmux and the CLI run on the Codeman host.                                                        |
| **Docker**     | One long-lived container per case; sessions `docker exec` into it. See [Docker Cases](Docker-Cases).           |
| **Remote SSH** | A durable tmux server on the remote host, fronted by a local pane running `ssh`. See [Remote SSH Sessions](Remote-SSH-Sessions). |

This matters because it is a common source of confusion: Docker is **not** an eleventh run
mode. All eleven run modes work in all three locations. A case is docker-backed or
ssh-backed; a session is claude or codex or shell.

**Web tabs** are the other thing that is not a session. A saved dashboard URL renders as a
tab beside your agents, but there is no PTY, no tmux, and no respawn behind it. See
[Web Tabs](Web-Tabs).

## Why tmux

tmux is a hard requirement, and it is the reason Codeman behaves the way it does.

The agent runs inside a tmux session. Codeman attaches to it, the same way your terminal
would. That indirection buys:

- **Survival.** The agent outlives your browser tab, your network, your laptop lid, and a
  restart of the Codeman server itself.
- **Real scrollback.** History is held by tmux, so reconnecting replays what happened while
  you were gone instead of starting from blank.
- **Attach from anywhere else.** The same session is reachable from a terminal over SSH
  with `codeman tui` (F1 detaches), `./scripts/tmux-manager.sh` (likewise F1), or plain
  `tmux -L codeman attach`. A plain attach has no detach key: Codeman keeps tmux's prefix
  table on its socket down to `send-prefix`, so `Ctrl+B d` does nothing there; leave it
  with `tmux -L codeman detach-client` from another shell, or bind a key yourself.
- **Secrets off the command line.** Environment overrides are injected with socket-scoped
  `tmux setenv` rather than being visible in the spawn command.

The socket is `tmux -L codeman`, separate from your personal tmux server, so Codeman
sessions never appear in a bare `tmux ls`.

## What persists

| Survives                                     | Does not survive                                    |
| -------------------------------------------- | --------------------------------------------------- |
| Closing the browser                          | `tmux -L codeman kill-server`                        |
| Losing the network                            | A machine reboot (tmux dies with it)                 |
| Restarting the Codeman server                 | Killing the session from the UI                      |
| `codeman web --stop`                          |                                                      |
| A dropped SSH link, for remote cases          |                                                      |
| A container restart, for docker cases         |                                                      |

Conversation history is a separate question: Claude transcripts live in `~/.claude/`, so a
conversation can be resumed even after the tmux session is gone. That is what the welcome
screen's **Resume Conversation** list offers.

## State on disk

Everything Codeman knows lives under `~/.codeman/`:

| File                                     | Holds                                                                |
| ---------------------------------------- | -------------------------------------------------------------------- |
| `state.json`                             | Sessions, settings, respawn config, orchestrator state, cron jobs.    |
| `settings.json`                          | User preferences that sync across your devices.                       |
| `mux-sessions.json`                      | tmux recovery data.                                                   |
| `session-lifecycle.jsonl`                | Append-only audit log of session starts, exits, and kills.            |
| `linked-cases.json`                      | Registered cases.                                                     |
| `remote-hosts.json`, `docker-hosts.json` | Location overlay configuration.                                       |
| `webviews.json`                          | Saved dashboard URLs.                                                 |
| `users.json`                             | Multi-user accounts, mode 0600.                                       |
| `push-*.json`                            | Web push keys and subscriptions.                                      |
| `certs/`                                 | Self-signed TLS for `--https`.                                        |
| `backups/config/`                        | Timestamped copies of the files above that you customized ([Config Backups](Config-Backups)). |

None of it needs root, none of it leaves the machine, and deleting `~/.codeman/` resets
Codeman to a fresh install without touching your code.

## Instances

The data directory and the tmux socket are both **process wide**. Two Codeman servers
started on one machine share them, which means the second one discovers the first one's
live sessions and attaches to them, resizing and mutating sessions you did not expect it to
touch.

To run two on purpose, give each its own instance name:

```bash
CODEMAN_INSTANCE=beta CODEMAN_PORT=5000 codeman web
```

That scopes the data directory and the tmux socket together, which is the only safe way to
do it. `CODEMAN_DATA_DIR` and `CODEMAN_TMUX_SOCKET` can be set individually if you need
them apart, but setting only one of the two reproduces exactly the problem you were trying
to avoid.

## Hooks

For Claude sessions, Codeman writes a hooks configuration into the case so Claude Code can
report events back: a permission prompt appeared, the turn finished, the agent went idle, a
task completed. Those events drive tab alerts, the Approvals Inbox, notifications, and the
wait primitives.

This is why some features are Claude-only. One partial exception is DeepSeek Harness,
whose terminal front door reports idle, working and blocked to Codeman over the harness's
own supervisor contract, so it gets the hook-driven signals without a hook file. Codex gets
one of them from its screen: Codeman reads its approval, question and trust dialogs off the
pane and raises the same red "needs you" alert a `permission_prompt` hook raises. The other
CLIs have no equivalent, so for them Codeman falls back to watching terminal output, which
is coarser: it can see that something happened, not what it was.

See [Hooks And Integrations](Hooks-And-Integrations).

## Vocabulary

| Term            | Means                                                                        |
| --------------- | ---------------------------------------------------------------------------- |
| **Case**        | Named working directory.                                                      |
| **Session**     | One CLI in one tmux session.                                                  |
| **Run mode**    | Which CLI: claude, opencode, codex, gemini, antigravity, pi, grok, deepseek, omp, copilot, shell. |
| **Respawn**     | Restarting the CLI on idle to keep an unattended run going.                   |
| **Ralph loop**  | An autonomous single-session task loop.                                       |
| **Orchestrator**| A phased plan driven across multiple agents.                                  |
| **Subagent**    | An agent the CLI spawned itself, shown live in its own window.                |
| **Web tab**     | A saved dashboard URL rendered as a tab. Not a session.                       |
| **Instance**    | One Codeman server with its own data directory and tmux socket.               |

## Read next

- [The Dashboard](The-Dashboard) - what the UI is showing you.
- [Agent CLIs](Agent-CLIs) - the eleven run modes in detail.
- [Keeping Agents Running](Keeping-Agents-Running) - respawn, idle detection, usage limits.
- [`docs/architecture-invariants.md`](https://github.com/Ark0N/Codeman/blob/master/docs/architecture-invariants.md) - the mechanisms behind all of this, for contributors.
