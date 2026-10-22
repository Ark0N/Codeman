# Terminal UI (`codeman tui`)

`codeman tui` is a full-screen dashboard for your Codeman sessions, in the terminal.
It shows every session grouped by whether it needs you, lets you answer a permission
dialog or send a prompt without switching anywhere, and puts you inside a session's
tmux pane with one keystroke.

It is **additional, not a replacement**: the web UI stays the primary surface and
gets every feature first. The TUI exists for the terminal workflow (SSH, Termius,
a tmux window you keep open all day), and it is a *client* of the running server,
so the two surfaces can never disagree about what a session is doing. It is also
not a multiplexer: tmux still owns every pane, and attaching hands the terminal to
tmux rather than proxying bytes.

## Starting it

```bash
codeman tui              # the dashboard
codeman tui --list       # print the numbered session list and exit
codeman tui 2            # attach straight to session 2 of that list
```

The two fast paths are the scriptable ones.
Neither sets up a screen, so both are as quick as the one API call they make, and
`--list` prints plain text when piped, so it composes with `grep`/`awk`.

What it needs:

| Needs | What you get |
| --- | --- |
| **Full features** | A running Codeman server (states, approvals, preview, prompts, search, digest). The TUI finds it the way `codeman attach` does: `CODEMAN_API_URL`, else loopback on `CODEMAN_PORT` for this `CODEMAN_INSTANCE`. The self-signed certificate an `--https` install generates is accepted, as it is everywhere else in the CLI. |
| **Server down** | It still starts, in **degraded mode**: sessions are enumerated straight from `tmux -L codeman` plus a read-only peek at `state.json`, and attach is the only verb. See [Troubleshooting](#troubleshooting). |
| **A terminal** | `codeman tui` refuses to run when stdin/stdout are not a TTY, and says to use `--list` instead. A cron job or a pipe therefore fails loudly rather than emitting escape codes into a log. |

## What it looks like

A real frame at 100x30 (`NO_COLOR`, trailing blank rows trimmed). The selected
session has a pending permission dialog, so the preview pane leads with the card:

```
 codeman  ⚠ 2  tnode · v1.19.0 · 5 sessions · 5h 32% · wk 61%                        ? help  q quit
 NEEDS YOU ─────────────────────────│ w4-api-refactor · claude · /home/you/dev/api · blocked
  1 w6-docs                   ✋ 11m│ ⚠ requests: Bash(git push origin main)
▶ 2 w4-api-refactor             ⚠ 2m│   1. Yes
 WORKING ───────────────────────────│   2. Yes, and do not ask again
  3 w1-codeman                  ∗ 1h│   3. No, tell Claude what to do
  4 w2-gallery                 ∗ 15m│ y approve · n deny · digit chooses
 IDLE ──────────────────────────────│
  5 w3-promo shell              ○ 2h│ > refactor the api routes onto the shared port interface
 RECENT ────────────────────────────│
  6 api-hotfix                  ✔ 3d│   Read src/web/ports/session-port.ts (48 lines)
                                    │   Read src/api/routes.ts (312 lines)
                                    │   Edit src/api/routes.ts
                                    │    1  -import { SessionManager } from "../session-manager.js";
                                    │    2  +import type { SessionPort } from "../web/ports/session-
                                    │
                                    │   Bash(npm run typecheck)
                                    │   └ tsc --noEmit: no errors
                                    │
                                    │ ✻ Actualizing… (2m 14s · ↓ 12.3k tokens)
 ↑↓ select · ⏎ attach · y approve · n deny · 1-9 option · p prompt · x kill · / search · g digest ·
```

- **Header**: the machine, the server version, how many sessions are live, and the
  plan-usage chip (the same statusLine telemetry that feeds the web chip, when the
  server has a snapshot). A `⚠ n` badge counts pending approvals.
- **Sidebar**: every session, grouped and numbered.
- **Preview**: a live tail of the selected session, its own colors preserved, with
  the parsed dialog card on top when that session is blocked.
- **Footer**: only the keys that work right now. `n` reads `n new` normally and
  `n deny` when the selected session has a dialog, because it cannot be both.

The same world through `--list`:

```
  1 waiting w6-docs         /home/you/dev/docs
  2 blocked w4-api-refactor /home/you/dev/api
  3 working w1-codeman      /home/you/dev/codeman
  4 working w2-gallery      /home/you/dev/gallery
  5 idle    w3-promo        /home/you/dev/promo
  6 done    api-hotfix      /home/you/dev/api
```

The numbers are the same on both surfaces, so `codeman tui --list` then
`codeman tui 4` is one thought.

## The four groups

Groups are always in this order, and a session is in exactly one of them:

| Group | Glyph | Means | Comes from |
| --- | --- | --- | --- |
| **NEEDS YOU** | `⚠` | A permission or question dialog is blocking the agent | The approvals inbox (`permission_prompt` hooks, with the on-screen options parsed; for Codex, a dialog read off its screen) |
| | `✋` | Waiting for your next instruction, or errored | `idle_prompt`, or an errored session (equally something only a human clears) |
| **WORKING** | `✻` animating | A turn is running | The same working classification the web dashboard uses |
| **IDLE** | `○` | Live, but sitting there | |
| **RECENT** | `✔` | A past session from the unified list | History rows, no live pane |

Ordering inside a group is "the one that has waited longest, first": blocked
sessions sort by how long the dialog has been up, working sessions by when their
turn started (the pane's last Enter, since a working pane repaints every second
and would otherwise always look freshly started), and quiet ones by last activity.
That is the ordering the web home screens already use.

The cursor sticks to a **session**, not a row number, so a session that jumps to
NEEDS YOU does not drag your selection with it. The number beside each row is what
`1-9` and `codeman tui <n>` mean, and it is renumbered on every re-sort.

When a new dialog appears, the terminal bell rings once, for that dialog only: the
same item announced twice does not ring twice.

## Keymap

| Key | Does |
| --- | --- |
| `↑` `↓` or `j` `k` | Move the cursor. PageUp/PageDown jump five rows. |
| `Enter` | Attach to the selected session (see [Attaching](#attaching)) |
| `1`-`9` | Jump to that row and attach. When a dialog is on screen, a digit answers it instead (see below). |
| `y` | Approve the selected session's dialog |
| `n` | Deny it, or **start a new session** when there is no dialog |
| `p` | Send one line to the selected session without attaching |
| `x` | Kill the selected session; `y` confirms, any other key cancels |
| `/` | Search sessions, events and files |
| `g` | Away digest: what happened while you were gone |
| `?` | Help overlay |
| `Esc` | Close whatever overlay is open |
| `q` or `Ctrl+C` | Quit, restoring the screen you started with |

Inside the `p` composer and the `/` query: `←` `→` `Home` `End` `Delete`
`Backspace` plus `Ctrl+A` / `Ctrl+E` / `Ctrl+U` / `Ctrl+W`, `Enter` to send or open,
`Esc` (or `Ctrl+C`) to cancel. In the kill confirmation you retype the session name;
anything else cancels. In the `n` pickers, type to filter, `Enter` chooses.

Verbs that need the server (`y`/`n`/`p`/`x`/`/`/`g`) say so in degraded mode
instead of failing silently; `Enter` and `1-9` keep working.

### `p` sends exactly one line

The composer is a single line by design, ending in a carriage return, because the
server's submit check cannot reliably recognise a multi-line paste: a prompt it cannot
see on the composer line is not re-submitted when the agent ignored the first Enter. Pasted newlines become spaces rather than being rejected, so
a paste cannot silently run a different command than the one you read.

## Answering approvals

This is the thing the terminal could not do before. Select a blocked session and:

- `y` approves.
- `n` picks the parsed "No" option, or sends Esc when the dialog did not parse one.
- A digit picks that numbered option, **but only a digit the dialog actually
  offers**. A digit with no matching option falls through to the list's own
  jump-and-attach binding, so it can never be typed at whatever has focus.

The answer goes through `POST /api/approvals/:id/answer`, which **re-captures the
pane before it types anything**. If the dialog is no longer on screen (you answered
it in tmux a moment ago, or the agent moved on), the server refuses with a 409 and
the TUI says `that dialog is no longer on screen` rather than pressing a key into a
live composer. The answer is scoped to the options the server parsed off the actual
frame, never to a guess.

Only a Claude dialog can be answered this way. A Codex or DeepSeek Harness item is an
alert: the server refuses the answer and the TUI shows its message saying to answer in
the terminal, so attach with `Enter` and answer it in the pane.

An idle prompt (`✋`) is not a dialog: there is nothing to approve, so `p` is the
reply path and the footer says `p reply` instead of `p prompt`.

## Attaching

`Enter` suspends the dashboard (main screen back, cooked mode back) and hands the
terminal to tmux with `stdio: inherit`. Colors, mouse and paste are tmux's, at full
fidelity.

**Press `F1` to come back.** One key, no modifier to hold or release, nothing to
type in a particular order. tmux's own way out is a chord — press the prefix, let
go, then a letter — and beta testing showed that is genuinely hard to convey: the
bar first named the wrong letter (tmux binds lowercase `d` to `detach-client` and
capital `D` to `choose-client`), and once corrected it still failed for anyone who
kept Ctrl held, because that sends `Ctrl+D`, which tmux leaves unbound. So the TUI
claims `F1` in tmux's prefix-less key table for the length of the attach and gives
it back afterwards. The held-Ctrl chord (`Ctrl+B Ctrl+D`) works too, as the TUI
claims it for the attach as well. Plain `Ctrl+B d` does not: on Codeman's socket
the prefix table holds nothing but `send-prefix`, because the browser's terminals
are tmux clients on the same server and must not be able to `switch-client` or
`detach-client` themselves (`src/tmux-prefix-table.ts`).

You do not have to remember any of it. For as long as the attach lasts the pane
wears a bar across the top:

```
 1 w3-codeman-…  2 w4-codeman-…  3 testcase …     alt+1-9 switch · F1 back to the codeman dashboard
```

That is the **session strip**: the other sessions stay visible from inside a pane,
numbered exactly as the dashboard numbers them, with the one you are in inverted.
`Alt+1`..`Alt+9` switch between them without going back to the dashboard first. With
more sessions than fit, the strip shows a window around the current one and marks
each cut end with `…`; the way-out hint is measured first and always keeps its space.

Codeman keeps the status bar off on its panes (the web UI carries that information
around the terminal instead), so the TUI turns it on for the attach and puts it back
exactly as it was on detach, along with each window's size. Every session the strip
can switch to is dressed and sized the same way, so switching is instant and lands
in a pane that already fills your terminal.

Detaching leaves the agent running; typing `exit` or pressing `Ctrl+D` would end it,
which is the difference the bar exists to make obvious. If an agent does exit, its
pane stays as a corpse: the TUI refuses to attach to a dead pane and offers `r` to
resume the conversation in a fresh one instead.

Three cases:

| Where you are | What happens |
| --- | --- |
| Not in tmux | `tmux -L codeman attach-session` |
| Already in tmux on Codeman's socket | `switch-client`, so you do not nest |
| In tmux on a **different** socket | Refused, with an explanation: detach from that tmux first, then run `codeman tui` again |

A direct-PTY session has no pane to attach to, and says so.

**`Enter` on a RECENT row resumes that conversation** instead: there is no pane to
attach to, so the TUI creates a new claude session carrying the old transcript
(`resumeSessionId`, exactly what the web UI's "Resume Conversation" list does), in
the directory it originally ran in and under its old name, then attaches to it. It
is claude-only, and a row with no working directory or no conversation id says why
rather than resuming something else.

`x` never bulk-kills: it kills one session, only after you retype its name, never a
history row, and never the session the TUI itself is running in.

## Over SSH, and on a phone

The TUI is an ordinary terminal program with no local dependencies beyond tmux, so
`ssh box` then `codeman tui` works exactly like running it locally. There is no
separate remote mode.

Below 72 columns (Termius, an iPhone in portrait) the preview pane is dropped and
rows take two lines each, keeping the cursor, the live states and the
answer/prompt/kill verbs. The switch is
width-driven at draw time, so unfolding a foldable or resizing a window re-lays out
immediately; there is no mode flag to set.

## Troubleshooting

**"The Codeman server rejected these credentials."** The server has
`CODEMAN_PASSWORD` set. Export `CODEMAN_PASSWORD` (and `CODEMAN_USERNAME` if it is
not `admin`), or put them in the data dir's `.env` (`~/.codeman/.env`), which is
where `codeman attach` already reads them from.

**`server not running: attach only`** in a yellow banner. Nothing answered on the
expected port, so the TUI fell back to enumerating tmux. You get names and attach;
you do not get states, approvals or previews, because those only exist on the
server. Start the server (`codeman web -d`, or `systemctl --user start codeman-web`)
and the banner clears on its own: the TUI keeps re-probing.

**It found the wrong server, or none.** Discovery is instance-scoped. A beta
instance (`CODEMAN_INSTANCE=beta`) has its own data dir *and* its own tmux socket,
so its TUI sees only its own sessions. Set `CODEMAN_PORT` or `CODEMAN_API_URL`
explicitly when you run more than one.

**"this terminal is already inside tmux on socket ..."** You are in a tmux session
on a socket that is not Codeman's, so attaching would nest two multiplexers whose
prefix keys collide. Detach from that tmux and run `codeman tui` from outside.

**Boxes and glyphs render as garbage.** The TUI picks a glyph tier from the
environment: no `TERM` (or `dumb`), or a non-UTF-8 locale, gets the ASCII set
(`[!] [w] [*] [-]`, `+`/`-`/`|` frames). Force it either way with
`CODEMAN_TUI_GLYPHS=ascii|unicode|nerd`.

**Colors.** Standard `NO_COLOR` / `FORCE_COLOR` handling (chalk's, the same as the
rest of the CLI). Under `NO_COLOR` the frame is cursor addressing and text only,
and the preview's own colors are stripped too, so a session's output cannot repaint
the dashboard.

**It refuses to open at all**, saying it needs an interactive terminal. stdout or
stdin is not a TTY. That is the guard: use `codeman tui --list`.

## Related

- [`docs/tui-plan.md`](tui-plan.md): the design record. Why hand-rolled ANSI, why a
  client and not a second brain, and what is deliberately deferred.
- [`docs/approvals-inbox-plan.md`](approvals-inbox-plan.md): where the parsed
  dialogs and the answer endpoint come from.
- [`docs/remote-sessions.md`](remote-sessions.md): remote-SSH cases, which the TUI
  lists like any other session.
