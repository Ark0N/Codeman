# Troubleshooting

Symptom first. Find the line that matches what you are seeing.

Before anything else, check what version you are on and whether the problem is already
fixed:

```bash
codeman --version
codeman doctor
```

## Installing and starting

### `Failed to start claude: error: posix_spawnp failed` on macOS

node-pty ships its macOS `spawn-helper` without the executable bit, and macOS launches
every PTY through it. Codeman detects this and repairs it on the first failure, so updating
usually fixes it outright. To repair by hand on a clone install:

```bash
npm run fix:node-pty
```

It is a `chmod`, not a rebuild, so it does not need Xcode command line tools. The helper
lives in `prebuilds/darwin-<arch>/`, not `build/Release/`, which does not exist on macOS.
Linux never sees this.

### `tmux: command not found`

The installer asks before installing packages and remembers a declined answer. Install tmux
and start again. There is no tmux-free mode: sessions live in tmux.

### The port is already in use

```bash
codeman web --port 8080     # or set CODEMAN_PORT
```

If you believe nothing is on 3000, check for a Codeman you already started:

```bash
codeman web --status
```

### The terminal area is blank, and the console mentions a missing vendor file

Clone installs build the vendored xterm addon bundles in `postinstall`. If `npm install`
was interrupted or run with `--ignore-scripts`, those bundles are missing:

```bash
npm install
```

They are intentionally not committed to the repository.

### `Case path not found` when clicking Run

The case points at a directory that no longer exists, usually because it was deleted or
moved outside Codeman. Re-link the case, or create it again.

### The server starts but nothing is reachable

That is the default behaviour, not a failure. Codeman binds `127.0.0.1`. See
[Remote Access](Remote-Access).

## Reaching the interface

### The dashboard will not load from another device

Check, in order: the bind (loopback by default), a firewall, and then
[Remote Access](Remote-Access) for a supported way to expose it.

### `403 host not allowed`

The Host header is not in the allowlist, which is the DNS-rebinding guard doing its job. Add
your domain:

```bash
CODEMAN_ALLOWED_HOSTS='codeman.example.com,.internal.example.com'
```

A leading dot matches subdomains.

### The page loads but the terminal never connects

The terminal is a WebSocket. Behind a reverse proxy, the upgrade must be forwarded. The
upgrade also runs the Host and Origin checks and closes with code `4003` when they fail.

### The UI looks stale after updating

The app shell is cached by a service worker, and static assets are served with a long cache
lifetime. `index.html` is not cached, and every asset reference is version-stamped, so a
normal reload picks up a new build.

Two exceptions worth knowing:

- **iOS Safari** can keep serving old JavaScript until the tab is fully closed, not just
  reloaded. Close the tab and reopen it.
- If you edit files in dev, changes to `index.html` need a server restart. Changes to `.js`
  and `.css` do not.

### A full-screen "cannot reach the server" overlay appears

The server is genuinely unreachable, or the connection dropped. Codeman waits about 2.5
seconds before showing it, so a quick restart does not flash it. Retry re-arms both the
event stream and the terminal socket.

## Sessions

### A session shows idle while it is clearly working

Update. Claude redraws its prompt roughly once a second throughout a turn, and older idle
detection treated that as the end of the turn, flipping working sessions to idle a couple of
seconds in. Current versions confirm against the actual screen before believing it.

### A session is stuck showing busy

For non-Claude CLIs, idle detection is output-based and coarser by necessity: those CLIs
expose no hooks. A session that has genuinely gone quiet will settle. If it never does,
interrupt it (`Ctrl+C` with nothing selected).

### The agent asks about bypass permissions every time

That prompt comes from Claude Code, not Codeman. Codeman's default is to start with
permission prompts skipped, which is what the security model is built around. If you would
rather it prompted, change **App Settings → Agents & CLIs → Claude → Startup Mode**.

### Sessions vanished after a reboot

Expected. tmux does not survive a reboot, so the sessions are gone. Conversations are not:
Claude transcripts persist, so the welcome screen's **Resume Conversation** list can pick
them back up.

### A session restarts, then refuses to restart again

That is the PTY-exit circuit breaker. Repeated rapid PTY exits trip it, and it blocks
automatic restarts so a broken configuration does not spin forever. Reset it explicitly from
the session's controls. Reattaching does not clear it, deliberately.

### Typed prompts are silently ignored after restoring a tab

Update. A browser whose input sequence counter fell behind the server's (a restored tab,
cleared site data) used to have every prompt deduplicated away. Since 1.29.0 the duplicate
acknowledgement carries the watermark and the client re-sends.

### Sessions I did not create appeared, or my session resized itself

Two Codeman servers are running against the same data directory and tmux socket. The second
one discovers and attaches the first one's sessions. Give each instance its own scope:

```bash
CODEMAN_INSTANCE=beta CODEMAN_PORT=5000 codeman web
```

`codeman web -d` and `codeman service install` both refuse to start a second server on one
data directory for exactly this reason.

## The terminal

### I cannot scroll back through history

Scrollback behaviour depends on the CLI, and Codeman adjusts what it strips per mode.
Things to try:

- `Shift+Wheel` always scrolls the local buffer, whatever else is going on.
- On Claude sessions running fullscreen (recent CLI with mouse tracking on), the wheel is
  forwarded into Claude's own transcript, so it scrolls the conversation rather than the
  terminal buffer. That is intended. Claude's default inline view scrolls locally.
- Scrolling to the very top pulls the full tmux scrollback again on demand.

### The wheel does nothing in a Codex session

Codex ignores the mouse reports that forwarding would send, so Codeman does not forward
there. Scrolling is local, and `Shift+Wheel` behaves the same way.

### Selected text is invisible on a light skin

Update. Every skin named its selection colour under a key xterm renamed in v5, so the four
light skins painted white at 30% over near-white. Fixed in 1.29.0.

### `Ctrl+Z` suspended my agent

Update. Since 1.28.0 `Ctrl+Z` is swallowed in agent sessions, so a running CLI cannot be
stopped by job control. Shell sessions keep it.

### `Ctrl+C` copies when I wanted to interrupt

With a selection, `Ctrl+C` copies. With no selection, it interrupts. Clear the selection
first, or use the **Stop** button. `Ctrl+Shift+C` always copies and never interrupts.

### I typed a prompt but nothing was sent

On touch devices, keystrokes are painted locally and flushed when you press Enter, so text
on screen has not necessarily reached the agent yet. Press Enter, or the phone toolbar's
**Enter** button.

If you are sending input over the API instead, your payload must end with `\r` or no Enter
is ever sent. The request still succeeds and the text sits unsubmitted in the composer. See
[Driving Codeman From An Agent](Driving-Codeman-From-An-Agent).

## Mobile

### The keyboard covers the terminal, or scroll position jumps

Update first; several rounds of fixes have gone into keyboard resize and scroll restoration.

### I cannot reach the rightmost tabs

The strip scrolls horizontally on phones and the active tab is scrolled into view
automatically. Swipe the strip itself. If a background render snaps you back, update.

### The space key does nothing on Android

A long-standing Android keyboard bug, fixed some time ago. Update.

### The keyboard will not close

Tap outside the terminal, or tap twice on inert terminal content. Tapping a control does not
dismiss it, by design.

## Agents and CLIs

### A CLI is installed but Codeman does not offer it

Codeman resolves binaries from the environment the **server** runs in.

```bash
codeman doctor
```

If it runs as a service, launchd gives the job a minimal PATH. `codeman service install`
bakes your PATH into the unit; a hand-written plist does not. Restart the server after
installing a new CLI.

### Hooks stopped working after switching to HTTPS

Hook callbacks have to accept the self-signed certificate. Recent versions self-heal
existing cases; if yours predates that, recreate the case so its hooks are rewritten.

### The model or effort I chose is not being used

Both are **soft defaults**, on purpose. The model is written into the case's
`.claude/settings.local.json` and effort is passed on the command line at start, so `/model`
and `/effort` inside the session override them at any time. Effort is deliberately never
passed as an environment variable, because that hard-locks it.

### Tab alerts and approvals never fire in one of my repos

That case is missing its hooks block. Recreating the case rewrites it.

## Docker and remote

### Docker sessions do not detect idle

On a loopback-only bind, a container cannot reach `127.0.0.1` on the host, so in-container
hooks have nothing to call. Set `CODEMAN_DOCKER_BRIDGE_HOOKS=1` to open a hooks-only
listener on the docker bridge gateway. Without it, idle detection falls back to output
watching.

### A rebuilt agent image still has old CLI versions

Always rebuild with `--no-cache`:

```bash
node scripts/build-agent-image.mjs --no-cache
```

A plain rebuild reuses the cached `npm install -g` layer and keeps the CLIs frozen at their
original versions while reporting success.

### Every file in a remote case says "File not found"

Update. Before 1.29.0 the file routes resolved every path on the Codeman host, so in a
remote case every click failed while the file plainly existed on the other machine. Reads
now go over ssh; see [Working With Files](Working-With-Files). Editing and Office previews
stay unavailable remotely and say so with a 400.

### Compose: the server crash-loops with `EACCES` on first start

Start the stack with `bash docker/Start-Codeman.sh` rather than a plain `docker compose up`,
and update: since 1.29.0 the entrypoint corrects a root-owned bind mount before dropping
privileges. See [Running As A Service](Running-As-A-Service).

### A remote SSH session dropped and did not come back

A bounded-backoff watcher reattaches dropped sessions, and it is on by default. Intentional
kills are never revived, and neither is a clean exit inside the pane (Ctrl-D, `exit`): only
a transport drop is reconnected. Check the host is reachable and that the remote tmux server
is still running.

## Gathering diagnostics

```bash
codeman doctor                                # dependency check
curl -s localhost:3000/api/status | jq        # full app state
tmux -L codeman list-sessions                 # what tmux thinks is alive
journalctl --user -u codeman-web -f           # service logs (Linux)
tail -f ~/.codeman/web.log                    # detached mode logs
```

On an HTTPS install, add `-k` to the curl commands and use the `https://` URL.

## Filing a good bug report

Open an [issue](https://github.com/Ark0N/Codeman/issues) with:

- OS and version.
- Install method: installer, npm, or git clone.
- `codeman --version`.
- Browser and version, if the problem is in the UI.
- Which CLI the session was running, and its version.
- What you did, what happened, what you expected.

Reports usually get a response within a day, and every release credits its reporters by
name.

Questions and setup help fit better in
[Discussions](https://github.com/Ark0N/Codeman/discussions). Security problems never go in a
public issue; see
[SECURITY.md](https://github.com/Ark0N/Codeman/blob/master/.github/SECURITY.md).
