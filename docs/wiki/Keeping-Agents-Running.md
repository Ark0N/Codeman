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

**For the other CLIs** it depends on what the CLI tells Codeman. Codex, OpenCode, Gemini
CLI, Pi, OMP and Antigravity each declare their own prompt marker and working line, so they
get the same screen check Claude does (before 1.26.1 every Codex session reported idle for
its whole life). DeepSeek Harness reports its end of turn and its dialogs to Codeman itself,
which is as precise as hooks; its working and idle display still comes from its output.
Grok Build declares neither. Codeman calls a new grok pane idle 3 seconds after launch, and
after that it has only generic cues to go on (Claude's `❯` prompt marker, a braille spinner
glyph), which grok may not draw, so its working and idle status is unreliable.

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

## The prompt cache: readout and keep-warm

**Claude only.** On the Respawn tab, above the loop controls.

Claude Code bills a turn against the cached conversation while that cache is warm, and lets the cache expire after a fixed idle time: one hour on a subscription within plan usage, five minutes on an API key, a cloud provider or extra-usage credits. The first turn after a longer break re-processes the whole context at the cache-write rate, which is why coming back to a big session after lunch costs more than the turns around it.

Claude Code 2.1.251 and newer reports the cache state on the statusline after every response, and Codeman's statusline exporter keeps it per session. The row shows **Warm until HH:MM** with the lifetime and the tokens that would be re-cached if it went cold, or **Cold** with the size of the re-cache the next turn pays. When Claude reports them it also shows the session's cache hit rate and the cause of the last cache miss (for example `ttl_expired_1h` or `tools_changed`), so a surprise miss has a reason next to it. If the conversation is compacted while it stays warm (Claude Code now does this on its own on large idle sessions, a manual `/compact` does it too, and so does a clearing of old tool results), the row notes **Context compacted at HH:MM** until the next turn: Claude Code reports no re-cache size until then. None of this raises an alert. The row refreshes live and flips to cold on its own when the lifetime passes, and the last state is kept across a Codeman restart so it is not blank until the session's next turn. Sessions without a statusline of their own also get a short `cache:until HH:MM` or `cache:cold` group in the terminal footer. The readout rides the plan usage chip's telemetry collection, which is on by default on desktop.

**Keep the cache warm while idle** is the switch under the readout. With it on, Codeman sends a one-line keep-alive turn (`Codeman cache keep-alive: no action needed, reply with just "ok".`) about five minutes before the cache would expire. Claude answers `ok`, the request refreshes the cache for another hour, and your next real prompt reads the conversation from cache instead of re-processing it. Measured on sessions of about 110k tokens, the keep-alive cost a cache read plus a one-word reply, a small fraction of the re-write it prevented.

It only fires when there is nothing else going on: the session is idle with an empty prompt (Claude Code's greyed-out prompt suggestion counts as empty), no permission or question dialog is open, nobody has typed in the last few minutes, no respawn loop, Ralph loop or waiting agent is driving the session, and the session is not paused on a usage limit. If any of those hold it waits a minute and looks again, and gives up a minute before the expiry rather than race it; a keep-alive that could not be sent is retried the same way. It also stops by itself a few hours after your last prompt (**Keep warm for at most**, under App Settings → System → Automation, default 2 hours), because the saving is concentrated in gaps of one to four hours and an overnight run of hourly keep-alives would cost more than the single cold turn in the morning. It stands down for the rest of a gap once the context has been compacted. The readout's Status line gains a `Keep-alive:` line that says what it is doing: the next keep-alive and when the window closes, waiting and why, sent at a time with a count, or stopped and why. A session started without the cache readout (Plan Usage off at launch, a workspace with its own statusLine, a remote or Docker session) cannot be kept warm: the switch is greyed out and cannot be switched on (one that is already on can still be switched off), and the Status line says why.

Recent Claude Code builds can compact a large idle session on their own shortly before the cache expires, which would leave only a summary to keep warm. So a session **started** with keep-warm on also launches with Claude Code's idle compaction switched off (Claude Code 2.1.290 or newer); Codeman then owns the idle policy for it. A session you switch on after it started is still kept warm, but Claude Code may compact it first until its next launch, and the Status line says so; one you switch off keeps Claude Code's idle compaction off until its next launch, and the Status line says that too. Sessions with keep-warm off launch exactly as before.

**Keep prompt caches warm** in the same Automation group is the default for sessions that have not chosen on their Respawn tab; the per-session switch always wins. A session another agent started (a worker) does not follow the default: most workers are never prompted again once they report done, so turn it on for one by hand if you will come back to it. The keep-alive turn is Codeman's, not yours: it does not restart the **Keep warm for at most** window, does not rename a tab, Read My Mind ignores it, and the response it ends with raises no alert, toast, push or webhook, nor a row in the Away digest or the session's Summary. It never clears an alert that was already waiting for you. It is refused on the five-minute cache lifetime, which is what an API key, a cloud provider or extra-usage credits get; a session on an API key can ask Claude Code for the hour with `CLAUDE_CODE_PROMPT_CACHE_TTL=1h` in its environment overrides.

## The plan usage chip

A header chip showing live subscription usage: Claude (the 5-hour and weekly windows), Codex
(its limits) and, while Copilot CLI is installed and signed in, Copilot's monthly premium-request
quota. On by default on desktop and off on phones.

It works through a status line exporter that Codeman hands to `claude` as an ephemeral
setting when it spawns the session, never written to disk, which posts Claude's own rate
limit data back to Codeman. Your own status line (project-local, project, then
`~/.claude/settings.json`) is wrapped and printed through, and a `claude` you run by hand
outside Codeman sees nothing of it. Workspaces an older Codeman wrote the exporter into are
cleaned up the first time a session starts there. Codex limits come from a read-only poll of
its own app-server, and the Copilot quota from a read-only request to `api.github.com` every
10 minutes with Copilot's own token (on by default; Plan Usage Limits off stops it). Known limit: sessions inside a Docker case do not feed the chip yet.

The chip and the exporter are the same setting. Turning the chip on without the exporter
would leave it showing a dash forever, so resolve it in one place: **App Settings**. A
device writes the switch only when it flips the chip, so a phone (chip off by default)
saving its font size cannot switch collection off for your desktop.

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
- **Non-Claude sessions can respawn**, but with no usage-limit auto-resume, and with
  output-based idle detection except on DeepSeek Harness, whose own end-of-turn report
  reaches the respawn controller the way Claude's `stop` hook does while its status bridge
  is on (a local session, by default).
- **Do not run respawn on a session you are actively typing in.** It will send prompts
  underneath you.

## Read next

- [Autonomous Loops](Autonomous-Loops) - Ralph and the orchestrator, for structured
  autonomous work rather than "keep going".
- [Cron Jobs](Cron-Jobs) - starting work on a schedule instead of continuing it.
- [Notifications And Approvals](Notifications-And-Approvals) - being told when it needs you.
- [`docs/respawn-state-machine.md`](https://github.com/Ark0N/Codeman/blob/master/docs/respawn-state-machine.md) - the state machine itself.
