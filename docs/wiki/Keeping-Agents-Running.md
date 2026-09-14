# Keeping Agents Running

Codeman exists for the hours you are not at the keyboard. This page covers how it notices an
agent has stopped, what it does about it, and how to run a session overnight without
babysitting it.

Everything here is **per session and off by default**. A session you never configure just
sits there when it finishes, which is usually what you want.

## How Codeman knows an agent is idle

Harder than it sounds, and worth understanding, because it is what every other feature here
is built on.

**For Claude sessions**, the naive signal does not work. Claude redraws its prompt marker
roughly once a second all the way through a turn, so "saw a prompt, waited two seconds,
called it idle" flipped working sessions to idle a couple of seconds into every turn. Its
real working indicator is an animated line whose glyph and wording both change, and terminal
repaints arrive in partial fragments, so matching it in the output stream does not work
either.

So Codeman waits for the pane to go quiet, then **asks the screen** what is on it before
believing the session is idle. Turn-start detection works the same way in reverse: a
sustained run of repaints marks a turn as started, with the same screen check vetoing mere
keystroke echo. Idle now lands a few seconds after a turn genuinely ends.

There are several layers stacked on that: a completion message from the CLI, an AI check,
output silence, and token stability.

**For every other CLI**, there are no hooks to lean on, so detection is output
stabilization: the session is idle when output stops changing. Coarser, and it is why the
features further down this page are Claude-only.

## The Respawn Controller

Respawn keeps a session working past the point where the agent would otherwise stop. When
the session goes idle, Codeman runs a cycle and starts it again.

A cycle is up to four steps, each optional:

1. **Update prompt.** Ask the agent to write down where it got to, so the next round can pick
   it up.
2. **`/clear`.** Reset the context window.
3. **`/init`.** Re-read the project's `CLAUDE.md`.
4. **Kickstart prompt.** Tell it to continue.

Steps 2 and 3 are what make long runs possible: without a context reset, a multi-hour
session eventually spends its whole window on its own history.

Configure it in **Session Options → Respawn**, then press **Enable**. It repeats until the
duration you set runs out.

| Setting                | What it controls                                                        |
| ---------------------- | ----------------------------------------------------------------------- |
| **Idle timeout**       | How long the session must be quiet before a cycle starts.                |
| **Duration**           | How long the whole arrangement stays armed.                              |
| **Inter-step delay**   | Pause between the steps above, so a step is not sent into a busy pane.    |
| **`/clear` + `/init`** | Whether the context reset happens at all.                                |
| **Update prompt**      | What the agent is asked to record before the reset.                      |
| **Kickstart prompt**   | What starts the next round.                                              |
| **Auto-accept prompts**| Answer routine confirmation dialogs automatically.                        |

### Presets

Five built-ins, and the numbers matter more than the names. The idle timeout is the main
difference: a lead session coordinating subagents is legitimately silent for a minute at a
time, and a three second timeout would interrupt it constantly.

| Preset         | Idle timeout | Duration | Built for                                                       |
| -------------- | ------------ | -------- | --------------------------------------------------------------- |
| **Solo**       | 3s           | 60 min   | One agent working alone, fast cycles with a context reset.       |
| **Subagents**  | 45s          | 240 min  | A lead session running Task subagents; tolerates their silences. |
| **Team**       | 90s          | 480 min  | Leading an agent team; tolerates long silences.                  |
| **Ralph/Todo** | 8s           | 480 min  | Working through a task list with progress tracking.              |
| **Overnight**  | 10s          | 480 min  | Unattended overnight runs with a full reset between cycles.      |

Start from the preset that matches your shape of work and adjust the idle timeout first.
Presets you build yourself can be saved alongside these.

### What it costs

Every cycle is real tokens: the update prompt, the reset, and the kickstart, plus whatever
work follows. An overnight run is a deliberate spend, not a background nicety. The duration
setting is the ceiling, and it is worth setting honestly.

## Auto-resume when a usage limit resets

**Claude only.** At the top of the Respawn tab.

When Claude halts on a subscription limit, the message names the time the limit resets.
Codeman parses it, arms a timer for two minutes after that, then sends Escape followed by
`continue`.

The important part is what it does **not** do: respawn cycles are blocked while a session is
limit-paused. Without that, the next cycle would fire `/clear` and wipe the conversation you
are waiting to resume. This is the single most useful setting for overnight runs on a
subscription plan.

## The plan usage chip

**Claude only.** A header chip showing live subscription usage, on by default on desktop and
off on phones.

It works by installing a status line exporter into each managed repo's
`.claude/settings.local.json`, which posts Claude's own rate limit data back to Codeman. The
exporter is marker-identified, so it only ever touches a status line Codeman installed, never
one you wrote yourself. A repo's status line outranks the one in `~/.claude/settings.json`,
so the exporter also runs the status line it shadows and prints that instead of its own
footer: your global status line keeps rendering in managed repos, and in a repo with no
status line of your own you get Codeman's compact session footer. Turning the chip off takes
the exporter back out of the repos of your live sessions.

The chip and the exporter are the same setting. Turning the chip on without the exporter
would leave it showing a dash forever, so resolve it in one place: **App Settings**.

## Circuit breakers

Two, and they are unrelated:

- **The Ralph breaker** stops respawn thrashing. It moves from closed to half-open to open,
  and is reset from the session's Ralph controls.
- **The PTY-exit breaker** trips when a session's process exits repeatedly and quickly, and
  blocks automatic restarts so a broken configuration cannot spin forever.

The PTY-exit breaker resets **only** on an explicit clear. Reattaching to the session does
not clear it, deliberately, so a UI reconnect cannot paper over a session that is genuinely
failing to start.

## A working overnight setup

1. Start a Claude session in the case you want worked on.
2. Give it a clear goal and let it start. Respawn continues work, it does not invent it.
3. **Session Options → Respawn → Overnight preset.**
4. Turn on **auto-resume on usage limit**.
5. Set the duration to how long you actually want it running.
6. Press **Enable**.
7. Optionally turn on push notifications so a blocking question reaches your phone: see
   [Notifications And Approvals](Notifications-And-Approvals).

In the morning, the **Away Digest** summarizes what happened while you were gone, and the
run summary and lifecycle log carry the detail.

## Gotchas

- **Respawn without a context reset stalls eventually.** The window fills with history and
  the agent gets less useful every cycle.
- **An idle timeout that is too short interrupts real work.** If the agent runs long tool
  calls or coordinates subagents, raise it. That is what the Subagents and Team presets are.
- **The update prompt is what makes a reset survivable.** After `/clear`, everything the
  agent knows comes from that summary and the project files. A vague update prompt produces
  a vague next cycle.
- **Non-Claude sessions can respawn**, but with output-based idle detection and no
  usage-limit auto-resume.
- **Do not run respawn on a session you are actively typing in.** It will send prompts
  underneath you.

## Read next

- [Autonomous Loops](Autonomous-Loops) - Ralph and the orchestrator, for structured
  autonomous work rather than "keep going".
- [Cron Jobs](Cron-Jobs) - starting work on a schedule instead of continuing it.
- [Notifications And Approvals](Notifications-And-Approvals) - being told when it needs you.
- [`docs/respawn-state-machine.md`](https://github.com/Ark0N/Codeman/blob/master/docs/respawn-state-machine.md) - the state machine itself.
