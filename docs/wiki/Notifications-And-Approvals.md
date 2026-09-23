# Notifications and Approvals

An agent that stops to ask a question, with nobody watching, is a run that quietly wasted an
hour. This page covers every way Codeman tells you it needs you, and how to answer without
opening the session.

## The signals, cheapest first

| Surface                | Reaches you                                       | Default |
| ---------------------- | ------------------------------------------------- | ------- |
| Tab alert              | While the dashboard is open                        | On      |
| Browser title flash    | Another tab in the same browser                    | On      |
| Desktop notification   | Another window on the same machine                 | Opt-in  |
| Push notification      | Anywhere, even with no tab open                    | Opt-in  |
| Approvals Inbox        | One queue across every session                     | Opt-in  |
| Phone overview         | Phone home screen, NEEDS YOU section               | On      |
| Away Digest            | Afterwards, as a summary                           | Opt-in  |

## Tab alerts

The tab itself changes state:

| State                | Meaning                                                    |
| -------------------- | ---------------------------------------------------------- |
| Yellow, blinking     | The agent is waiting for input from you.                    |
| Red, blinking        | A question or permission prompt is blocking the session.    |

These are a steady colour with a pulse layered on top, not a blink to transparent, so a tab
needing attention looks that way at every point in the cycle.

They survive a reload. The alert state is re-seeded from the server on page load, so
reloading the dashboard while a permission dialog is blocking a session does not leave you
with a normal-looking tab.

For Claude sessions, these come from Claude Code's hooks and are precise about *why* the
session stopped; DeepSeek Harness sessions report the same states themselves. For the other
CLIs there are no hooks, so you get the coarser output-based signal.

## Window title and OS notifications

The browser tab title is prefixed `codeman:<host>`, so several Codeman instances across
several machines stay distinguishable at a glance. Override the hostname with
`codeman web --title-hostname <name>`.

Desktop notifications use the same prefix. Enable them in **App Settings → Notifications**.

## Push notifications

Push reaches your phone with **no Codeman tab open at all**, which is the only option that
works while you are actually away.

Setup:

1. Open Codeman over **HTTPS**. Web push requires a secure context. Tailscale gives you real
   HTTPS; `--https` gives you a self-signed certificate; plain HTTP over a LAN address will
   not work.
2. **App Settings → Notifications → Subscribe**, and accept the browser prompt.
3. On **iOS**, add Codeman to your home screen first. Safari only delivers web push to
   installed web apps, not to tabs.

Once subscribed, a blocking prompt reaches your phone even from a locked screen.

## The Approvals Inbox

**Opt-in, off by default. Claude sessions, plus DeepSeek Harness sessions, whose terminal
front door reports its prompts to Codeman.**

One queue of every prompt currently waiting on a human, across all your sessions, answerable
in place. When you have eight workers running, this is the difference between checking eight
tabs and checking one list.

Turn it on in **App Settings**. Surfaces:

- **A header bell** with a count, hidden entirely while the count is zero. Never shown on
  phones.
- **A drawer** listing each waiting card.
- **NEEDS YOU strips** at the top of the phone overview home screen.

Each card shows the session, the case, and the captured prompt with its options. Answering
sends the keystroke into the session for you: a digit for a menu choice, Escape to decline,
or free text for an idle prompt.

Behaviour worth knowing:

- **One item per session.** A newer prompt supersedes the older one, because the older one
  is no longer on screen.
- **Menu answers are validated against the live screen.** Codeman re-captures the pane before
  sending, and refuses with a conflict if the dialog is no longer there. Otherwise your
  keystroke would land in the composer as stray text.
- **Permission and question items clear only on definitive signals**: the turn ending, the
  dialog completing, an answer, a supersede, the session exiting, or a 12 hour timeout. They
  do not clear on a heuristic "looks busy again" signal, because that signal is wrong often
  enough to lose a real prompt.
- **In memory only.** Restarting the server clears the queue; the prompts themselves are
  still sitting in the sessions.

### Approve and Deny from the notification

With the inbox enabled, push notifications carry **Approve** and **Deny** buttons. Those are
handled by the service worker directly, so they work with no tab open: tap Approve on a
locked phone and the agent continues.

With the inbox off, the buttons are stripped from the notification payload entirely rather
than being shown and failing.

## When a session is watching its own work

An agent that starts a monitor, puts a shell in the background or hands a task to a cloud
session is told by its CLI to end the turn and wait to be notified. The pane then goes
quiet, and the CLI's idle notification arrives about a minute later — for a session that
wants nothing from you.

Codeman reads what the CLI prints about its own background work and treats that prompt
differently. It raises no tab alert, no desktop notification and no push, the session stays
out of NEEDS YOU on every surface, and the row wears a blue **watching** badge instead. Hover
it, or read it on a phone through your screen reader, and it says what is running: "1
monitor", "2 shells", "1 background terminal".

The prompt itself is not thrown away. It sits in the Approvals drawer as an ordinary card,
still answerable, with a line reading "quiet, watching 1 monitor" where a card you had
already looked at would say nothing. The next time that session goes quiet for an ordinary
reason, it alerts you exactly as before.

Two limits are worth knowing. A permission prompt or a question dialog still goes red
whatever else the agent started, because that one blocks it outright. A question asked in
plain prose is not a dialog, so an agent that starts a monitor and then writes "which branch
should I target?" is quiet along with the rest — check a watching session yourself if it has
been quiet longer than the work it is waiting for should take.

## The phone overview

On phones, tapping the "C" logo gives a session overview with **NEEDS YOU** first, then
current sessions, then past ones. Rows use the same language as the tab strip: a green dot
when fine, pulsing while working, yellow when waiting for input, red when a question is
pending.

Answer strips let you resolve a prompt straight from the home screen without opening the
session.

## The Away Digest

Retrospective rather than live: what happened while you were gone, aggregated from the
lifecycle log, run summaries, live sessions, token statistics, and recent subagents.

It is the morning-after view for an overnight run. Enable its header button in
**App Settings → Header & Panels**.

## Recommended setup for unattended runs

1. HTTPS access, ideally Tailscale. See [Remote Access](Remote-Access).
2. Push notifications subscribed, with Codeman installed to the home screen on iOS.
3. Approvals Inbox on.
4. Auto-resume on usage limit on, for each session you leave running. See
   [Keeping Agents Running](Keeping-Agents-Running).

That combination means a blocking question wakes your phone and can be answered in two taps
from the lock screen.

## Gotchas

- **No push over plain HTTP.** It is a browser requirement, not a Codeman one.
- **iOS needs the home screen install.** A Safari tab will never receive push.
- **The bell is invisible at zero.** That is deliberate, not a broken setting.
- **Approvals need real signals.** They are built on hook events, which Claude emits and
  DeepSeek Harness reports itself; the other CLIs do neither.
- **A stale menu answer is refused, not sent.** If you answer a card for a dialog that has
  since gone away, Codeman declines rather than typing a digit into the composer.

## Read next

- [Keeping Agents Running](Keeping-Agents-Running) - what to configure before walking away.
- [Mobile Guide](Mobile-Guide) - the phone surfaces in full.
- [Settings Reference](Settings-Reference) - where each of these toggles lives.
