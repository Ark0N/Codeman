# Codeman Desktop

A small native app that opens Codeman in its own window. Double-click it, and
it runs Codeman on this Mac (installing it first if it is not there) or
connects to Codeman on another machine (installing it there over SSH if
needed), and Codeman fills the window. `⌃⌘F` puts it in full screen.

macOS first: the app runs on 11.3 or later, and Codeman's own page needs the
WebKit of Safari 16.4 (see Known limits). The same code is meant to build for
Windows and Linux later.

- **Size:** 5.3 MB for the universal `Codeman.app` (Apple Silicon + Intel), 3.5 MB as a `.dmg` (measured 2026-11-09).
- **Stack:** Rust with [tao](https://crates.io/crates/tao) (window and event loop),
  [wry](https://crates.io/crates/wry) (the system web view: WKWebView on macOS) and
  [muda](https://crates.io/crates/muda) (native menus), plus [objc2](https://crates.io/crates/objc2)
  for what wry leaves out on macOS (JavaScript dialogs, HTTP Basic login) and for
  the lid logo. No bundled browser and no Node in the app.
- **Server:** unchanged. The app is a client of Codeman's web UI, like a browser tab.

## Why it is cheap

Codeman is already a web app, so the desktop app is a native window around the
operating system's own web view. An Electron build of the same thing would ship
a whole Chromium (around 150 MB). The native side only adds what a browser tab
cannot do.

## What it does

| | |
| --- | --- |
| **This Mac** | The connect screen's first tab looks for Codeman on this Mac and offers what fits: *Open Codeman* when it runs, *Start Codeman* when it is installed but stopped, *Install Codeman on this Mac* when it is not there. The address comes from Codeman's LaunchAgent (port, sub-path, HTTPS). The tab also finds every Codeman server of yours that already runs on this Mac (with `ps` and `lsof`: a `codeman web --port 4000` in a terminal, a beta instance beside the installed one) and recommends connecting to it. Each one's address is worked out from its listening socket and its command line (`127.0.0.1` for a bind to loopback or to every interface, its own address for a bind to one, `https` with `--https`, the path of `--base-url`), and each is asked once whether Codeman answers there. When nothing answers at the usual address (the LaunchAgent's, or `http://127.0.0.1:3000` without one), *Open Codeman* is for the first found server that does; when none of them can be opened, the tab says *Codeman is already running on this Mac* and lists them. Next to a Codeman that answers, the others are listed under *Also running on this Mac*. A row shows the address, the version, and a *Connect* button, or the reason the app cannot open that one (HTTPS with Codeman's own certificate, no answer). *Connect* is the connect of the Another machine tab with that address filled in: the same check, the login saved for it, the same entry under recent servers. Finding a server connects to nothing by itself. The tab never offers to start a second server, which would take over the first one's sessions, and Start refuses while one runs. A server that runs but listens nowhere yet (the first seconds after login, a restart) shows as *starting*: the tab looks again every second and, when a connect to this Mac had just been refused, opens Codeman once it is up. Start asks launchd to run the LaunchAgent (`kickstart`, or `bootstrap` when it is not loaded), so the server keeps its own settings and supervision; without a LaunchAgent it runs `codeman web -d`. The login comes from where Codeman keeps it: the LaunchAgent's `CODEMAN_USERNAME`/`CODEMAN_PASSWORD`, else `~/.codeman/.env` (what Codeman's command-line clients read), `admin` by default. It goes only to `127.0.0.1` on that Codeman's port, only while one of your own Codeman processes holds that port, is never saved to the Keychain, and never reaches the page. Whether Codeman is installed is looked up in its files and processes, then the login shell; the interactive profile (nvm in `.zshrc`, say) only on *Check again*. Install sets Codeman up from the app itself, with no Terminal and no password (see Decisions). It fetches the installer, asks it what is on this Mac, then asks two things: which coding agent to install, only when this Mac has none (the list comes from the installer, and *Skip for now* is there), and who can reach Codeman (this Mac only, or the local network with a password). A checklist follows the install, the installer's output is one click away, and Cancel stops it; installing again picks up where it stopped. Codeman runs as a LaunchAgent, so it keeps running when the app quits and starts at login. Port 3000 is used unless something else answers there, then the next free one. Closing the app does not stop an install: it runs on its own, and the app picks it up when it opens again. When it is done the app looks every 3 seconds and opens Codeman as soon as it answers; it stops looking after the first answer, after 30 minutes, or 90 seconds after a finished install whose server never answered (then it offers Start). *Install in Terminal instead* runs the installer in a Terminal window, for what the app cannot do (see Known limits): it may ask for the Mac password (Homebrew) and asks its own questions there. The app offers it by itself on a Mac where the graphical install cannot finish. An install still running in Terminal is recognized by its process, so the tab waits for it instead of offering Install twice. *Add a coding agent*, on this tab and in the app menu whenever Codeman is on this Mac, is the same chooser after the install: pick one agent, watch it install, open Codeman. It needs no password, leaves a running Codeman alone, and can be cancelled or left running like an install. After *Skip for now* the app says Codeman has no agent yet and offers this before it opens Codeman. |
| **Another machine** | The second tab connects to a server by address (below). *Codeman is not installed there yet?* opens Terminal, connects with `ssh -t` and runs Codeman's installer on that machine, which asks its questions there; the app then suggests `http://<host>:3000` and the installer prints the real address at the end. The SSH login is checked to the characters of a user and host name (no option can be slipped in) and may carry a `:port`. The remote command runs under `bash -o pipefail`, so a failed download fails the install instead of reporting success. The same tab shows the one-line install command, with a Copy button, to run on a machine by hand. |
| **Connect screen** | Server address, recent servers, a login for password-protected servers (password kept in the macOS Keychain), auto-connect at launch. An address typed without `http://` or `https://` gets `http://`, except a tailnet name with no port (`machine.tailnet.ts.net`, which is `tailscale serve`), which gets `https://`. It explains each failure: nothing listening; wrong password; too many failed logins (the password field stays open, since a single-user Codeman accepts the right password even then); unknown host name; an address this Mac cannot reach (with a pointer to the Local Network setting); an `http://` address on a port that only speaks HTTPS; an untrusted certificate; a redirect, with a button for the suggested `https://` address; not a Codeman server. A multi-user account that must change its password connects, and Codeman's own dialog asks for the new one. If the server page has not started showing within 15 seconds, or you press Cancel while it opens, the connect screen comes back with a notice. A login that would cross the network over plain `http://` to another machine says so. Return opens or starts the Codeman on this Mac (or connects to the one found here, when that is the tab's main button) and Esc cancels a connect, as in a Mac dialog (Install always takes a click). On a Mac whose WebKit is too old for Codeman it says so and Connect stays off (see Known limits). |
| **Start Codeman** | On the This Mac tab, and when `http://127.0.0.1:<port>` or `http://localhost:<port>` answers nothing, one click runs `codeman web -d` (or `~/.codeman/app`) with your login shell's environment, so the server gets your real PATH (Homebrew, nvm) for the agents it spawns. zsh, bash and other POSIX shells run the start themselves; fish, nu, xonsh, tcsh and other shells only report their environment, and the start runs under `/bin/sh` with it. Offered for those two addresses only: `codeman web -d` listens on 127.0.0.1. |
| **Login** | The app answers the server's HTTP Basic login requests itself, with the login you connected with, so the page keeps working after the server restarts (a restart forgets every session cookie). It answers only for Codeman's own pages under the server's base path: a web tab or a rendered HTML file that asks for a Basic login of its own is left to WebKit and never gets your Codeman password. WebKit keeps no copy of the login, so every request for it gets the current one. Each connect first clears the app's cookies, so connecting to the same server as another user really switches users (local storage, where Codeman keeps its per-device settings, stays; a dashboard in a web tab that keeps its own login in a cookie may ask for it again). A page that still gets a 401 reloads once. If the server refuses the login (the password was changed, say), the app does not keep sending it: it checks it with a single probe, and only if the server refuses that too does the connect screen come back with a notice. That does not take focus from the app you are in: if Codeman is in the background, its Dock icon bounces. |
| **Dialogs** | Codeman's `confirm()`, `prompt()` and `alert()` (Delete case, Kill all sessions, Update Codeman, discarding unsaved edits, ...) show as native macOS dialogs. wry implements none of them, and without them WKWebView answers Cancel without showing anything. Each dialog's first line names the page it comes from, and says so when that is an embedded frame (a web tab, a rendered HTML preview), so a frame cannot pass its text off as Codeman's. |
| **Full screen** | `⌃⌘F` or the green button. The last state is restored at launch; *Always Open in Full Screen* forces it. Leaving full screen returns to the saved window size and position. |
| **Menus** | A real Edit menu (without one, `⌘C`/`⌘V` do nothing in a WKWebView), Reload `⌘R`, Switch Server `⇧⌘O`, Developer Tools `⌥⌘I`. The page sees every key first, so Codeman's own shortcuts keep working. If the main window ends up showing a raw file instead of Codeman, `⌘R` takes it back to Codeman. |
| **Pop-outs** | Implements Codeman's existing native-wrapper bridge, `window.CodemanHost` (`openInHostWindow` in `src/web/public/app.js`), so popping out a session or a file preview opens a real app window, and the pop-out icon is on by default. Session and rendered-HTML pop-outs come only from Codeman's own pop-out button. A `window.open` from page script opens only Codeman's file and download windows, without taking keyboard focus, at most 3 at once and then 1 per second. Only Codeman's own pop-out pages become app windows (see Decisions); when the app refuses one, Codeman shows a toast. Each pop-out opens a step down and to the right of the window in use, never exactly on top of another one. A web tab's *Open in new tab* opens the dashboard in your default browser, as it would from a browser tab. |
| **Links** | On Codeman's own pages (the dashboard and session windows), a link to another site opens in your default browser, also on `⌘`-click or a middle click. Pages can send at most 3 links to the browser at once, then 1 per second. Inside a rendered HTML preview or a web tab, a plain link to another site does nothing, while one that asks for a new window (`target="_blank"`, `window.open`) opens in your default browser within the same budget (see Known limits). |
| **Downloads** | Codeman's Download links, and downloads Codeman opens in a new window, save the file to `~/Downloads` whatever its type, and a toast in Codeman names the file. Files the web view cannot display are saved the same way. |
| **A page that stops** | When the web content process of a window ends (a WebKit crash, or macOS taking the process back under memory pressure), the window loads its page again instead of staying blank. A second time within 30 seconds, the main window goes back to the connect screen and a pop-out closes, so a page that cannot stay up never becomes a reload loop. |
| **Apple logo** | On a MacBook Pro with a PROLED XDR display, the lit Apple logo on the lid says what the agents are doing. **View > Blink Apple Logo** is the one switch, off until you turn it on. The more the logo moves, the more it needs you: it breathes (a slow fade out and back in) while agents work, blinks every two seconds for a yellow tab and flashes three times, then rests, for a red one. Each state can take another style under **View > Apple Logo Blink Styles**: Off, Breathe, Calm, Slow, Wink, Heartbeat, Fast, or Alarm. Picking a style turns the switch on, and turning the switch on with every state off brings back the recommended three (Breathe, Calm, Alarm). When several states hold, the most urgent one with a style shows: red, then yellow, then work. Styles chosen in 1.50.0 are kept, with the switch on if any of them was. The menu only exists on a Mac with that logo. No password is needed. Shell tabs do not count. The app asks the server every two seconds, and a change has to hold for three seconds before the logo follows it, so an agent between two turns does not flicker it. It keeps working while the window is hidden, and with any Codeman server. The logo moves on its own hardware fades, the ones [LogoLight](https://github.com/Ark0N/LogoLight) uses, so a blink writes no setting, and a logo you switched off yourself stays off. LogoLight (1.3 or later) steps aside while Codeman shows its agents on the logo, and takes the logo back afterwards, with whatever it showed before; while an older LogoLight runs, Codeman leaves the logo to it. While the app is closed nothing blinks. With the lid closed it just goes on while the Mac stays awake on its power adapter (**Keep This Mac Awake > With the Lid Closed**, or an external display): macOS keeps the logo dark under a closed lid, so the app tells the logo the lid is open and the keyboard that it is closed, which stays dark, as LogoLight's *Lit with Lid Closed* does. The light sensor is covered then, so the logo glows as it would in a dark room. The line under **Apple Logo Blink Styles** says what the closed lid did last (blinking, or why not). On battery, and while the display only sleeps with the lid open, the blink pauses and writes nothing. |
| **Keep awake** | **Codeman > Keep This Mac Awake** keeps the Mac from going to sleep while Codeman's agents work on it: **While Agents Work** (an agent at work, and for 5 minutes after the last one stopped, so the gap between two turns or a reply from your phone does not let it drop off), or **Always** (while the app is open). Off until you choose. Only for a Codeman on this Mac (`127.0.0.1`, `localhost`, or one of this Mac's own addresses); for a server on another machine the menu says so. The display still sleeps. No password is needed anywhere: the app holds a power assertion of its own, which macOS shows in Activity Monitor and in `pmset -g assertions` as *Codeman keeps this Mac awake while its agents work*, and which ends with the app, a crash or a Force Quit included. On a MacBook, **Only When Plugged In** (on by default) pauses it on battery, and **With the Lid Closed** keeps a closed MacBook awake as well: while it holds, the app has macOS's sleep-on-lid-close turned off (see Decisions), and turns it back on when it lets go, quits or crashes. The lid is never kept awake on battery, whatever the settings: unplugged with the lid closed, the Mac goes to sleep. A line at the bottom of the menu says what it does right now: whether the lid is covered, that it is left to macOS while an external display is connected (a docked MacBook stays awake with its lid closed by macOS's own doing), and if the Mac slept under the lid all the same, until when. Codeman 1.50.1 kept the lid awake through a small root helper, behind the administrator password. Nothing uses that helper any more, and where it is still installed the menu has **Remove the Old Lid Helper…** (the one item that asks for the password). It lives in the app, so it ends when the app quits: Codeman keeps running as a LaunchAgent, but nothing keeps the Mac awake then. That is why, while it watches a Codeman on this Mac, closing the Codeman window hides the app instead of quitting it, as Cmd+H does, also while it is paused (on battery, say), since it carries on by itself: a click on its Dock icon brings it back, and only Cmd+Q (or Quit from the Dock) ends it. With no server open, or one on another machine, closing the window quits. |
| **Window** | Size, position and full-screen state are remembered. A saved window that hangs off the screen it opens on (it was last on a larger display that is gone, say) is pulled back on and shrunk to fit; one whose title bar is on no screen at all opens at the default size instead. Clicking the Dock icon brings back a minimized window. |

## Build (on a Mac)

Needs Rust 1.90 or newer ([rustup](https://rustup.rs); `rustup update` for an older
toolchain) and the Xcode Command Line Tools (`xcode-select --install`).

```bash
cd packages/desktop
cargo test                                  # unit tests
./scripts/bundle-macos.sh                   # dist/Codeman.app for this Mac's architecture
./scripts/bundle-macos.sh --universal --dmg # Apple Silicon + Intel, plus dist/Codeman-<version>.dmg
open dist/Codeman.app
```

The connect page has its own test, which needs no Mac: from the repository
root, `npm run test:browser -- test/desktop-connect-page.browser.test.ts` drives
`assets/connect.html` in Chromium through every state of both tabs, under the
Content-Security-Policy the app serves it with. It is part of the nightly
browser suite, not of `npm test`.

To try a change to `install.sh` before it is merged, build with
`CODEMAN_DESKTOP_INSTALLER_URL` (where to get the installer) and
`CODEMAN_DESKTOP_INSTALL_BRANCH` (the branch it installs from) set. Both are
read at compile time: a shipped app cannot be pointed at another installer.

The script builds with `--locked` against the committed `Cargo.lock`, targets
the macOS version in `macos/Info.plist` (`LSMinimumSystemVersion`, 11.3), and
takes the binary from where cargo says it wrote it, so `CARGO_TARGET_DIR` and a
cargo config's `build.target-dir` work.

Settings live in `~/Library/Application Support/Codeman/desktop.json`; passwords
in the Keychain under *Codeman Desktop*, one item per username and server. A
`desktop.json` the app cannot read or parse is moved aside, never overwritten:
to `desktop.json.corrupt`, or to the first free name of `desktop.json.corrupt.1`
to `.corrupt.9` when that one is taken, so an earlier copy is kept. If all ten
names are taken, or the file cannot be moved, the app starts with default
settings and saves nothing, which leaves the file where it is. When a server's
username changes (a change of letter case counts), or a server drops off the
recent list (it keeps 8), the Keychain item of the old username is deleted.

## Decisions, and why

**tao + wry + muda directly, not Tauri.** Tauri is built on the same three crates.
The deciding detail is login: Codeman's password protection is HTTP Basic, and
a WKWebView shows no login dialog of its own (wry 0.57 implements no
authentication-challenge handler). So the app sends the `Authorization` header
itself on the first load, with wry's `load_url_with_headers` (Tauri 2.12's
`navigate()` takes only a URL), and from then on answers the HTTP Basic
challenges of Codeman's own pages with the current login. Codeman keeps its
session cookies in memory, so after a server restart that answer is what keeps
the page logged in. Using the crates directly is also smaller.

**What wry leaves out is added at runtime, not patched in.** `src/macos.rs` adds
the JavaScript dialog methods and the authentication-challenge method to the
classes of wry's own delegates, so wry stays an unmodified crates.io dependency.

**What a page may ask of the app** (all in `src/policy.rs`, unit-tested):

- Codeman shows content it did not write on its own origin: rendered HTML files
  (`/html-view/`) and proxied dashboards (`/webview/`). Only Codeman's own app
  shell (the dashboard and a session pop-out) may use `window.CodemanHost`.
  That is an allowlist on the raw path, and a path holding any `%` fails it, so
  an encoded spelling or a route Codeman adds later stays out.
- An app window opens only for Codeman's own pop-out pages under the server's
  base path, checked after decoding the path once, and which ones depends on
  who asks. `window.CodemanHost` (the app shell only) may open sessions,
  rendered HTML views, the raw, preview, attachment and folder file routes, the
  path picker's preview and `api/download`. A `window.open` or `target=_blank`
  link, which WebKit passes on from any frame without saying which, gets only
  the file routes and
  `api/download`, the pages Codeman itself opens that way; otherwise a rendered
  HTML file could open copies of itself as top-level windows that pass for the
  app's own. Such a window does not take keyboard focus, and these windows
  have a budget of their own (3 at once, then 1 per second), apart from the
  one links draw on. Any other page on the server's origin is refused rather
  than sent to the browser: a top-level `/webview/` load would escape the web
  tab's iframe sandbox in either place, so it never opens anywhere.
  `window.open('')` is refused too, since WebKit's blank window carries none of
  the app's handlers.
- wry's navigation handler sees every frame and does not say which one. So a
  navigation to another site is blocked rather than opened in the browser;
  otherwise a page full of external iframes could open browser tabs. A real
  link click is sent out by the injected script in the main frame only.
- Only `http(s)` URLs ever reach the default browser, at most 3 at once and
  then 1 per second. macOS lets a page call `window.open` without a click, so
  this keeps a script from opening a browser tab for every call.
- The `Authorization` header is only sent to URLs under the server's base path.
  The login answers a Basic challenge only when it is Codeman's own: the
  server's scheme, host and port (never a proxy's), a URL below the base path,
  and not a web tab (`webview/`) or a rendered HTML file (`html-view/`), which
  relay 401s from content Codeman did not write. Only such a challenge can
  send the user back to the connect screen. WebKit is handed the login without
  persistence, so it keeps no copy: every challenge gets the current login,
  and one from before a Switch Server is never replayed.
- Each connect starts by clearing the app's cookies (never local storage).
  Codeman checks its session cookie before the `Authorization` header, so an
  earlier user's cookie would otherwise win over the new login.
- Microphone and camera requests prompt per page. wry's default without a
  handler is to grant them to every frame, sandboxed previews included.
- The bundled connect page keeps working until a server page commits in the
  main window (it is still the live page while the server loads), and only
  the main window may talk to it.
- `codeman web -d` gets the port and base path as separate arguments, never as
  shell text.

**Keeping a closed MacBook awake is one kernel switch, held by a child process.**
macOS sleeps on lid close whatever an app asks: `caffeinate` and every power
assertion stop idle sleep only, and an assertion against system sleep turns the
lid's sleep into a dark wake. What decides is the power management root's
lid-sleep switch (`kPMSetClamshellSleepState` on `IOPMrootDomain`), which any
process may set through the root domain's user client, with no entitlement and
no password. With it set a closed lid changes nothing and the Mac stays at full
wake. It is the method LogoLight ships as *Lit with Lid Closed*; 1.50.1 used
`pmset -a disablesleep 1` through a root LaunchDaemon instead.

The switch has no owner (read from Apple's open sources of the kernel and of
its power daemon, `IOPMrootDomain.cpp` and `PMAssertions.c`). The kernel keeps
it after the process that set it has gone, and honours it on battery. It is a
single bit that the power daemon also writes when its own reasons change, and
that LogoLight writes for its feature. On an Apple silicon Mac it is also what
keeps a docked MacBook awake with its lid closed: the window server tells the
power daemon about the external display, and the daemon sets the bit once, when
that changes, so a zero written by anyone else stays until the display or the
adapter next changes. Clearing it under a closed lid puts the Mac to sleep at
once. So the app never writes it itself. A child process (`src/lid_awake.rs`, this binary with
`--keep-awake-lid`) holds it together with two assertions, against system sleep
and idle sleep (LogoLight measured the three together), and:

- sets the switch again every second, so a write by anyone else is undone
  within a second;
- reads the power source itself and holds nothing on battery, whatever the app
  says;
- writes nothing at all while an external display is connected: macOS's own
  closed-lid mode has the switch then, and a zero from Codeman would put a
  docked Mac to sleep, or leave it without that mode until the display is
  plugged in again. The assertions keep the Mac awake meanwhile. What the child
  set before the display came is cleared once the display has been gone for five
  seconds (the display list is short for a moment while displays are
  rearranged), and for that the child outlives the app if it has to;
- lets go when the pipe from the app closes (a quit, a crash, a Force Quit) or
  when the app has not written to it for a minute (a hang): the assertions
  first, then the switch, so a closed Mac goes straight to sleep;
- ignores SIGHUP, SIGINT and SIGTERM, which arrive together with the app's own
  end, so the pipe is its one way out;
- leaves the switch alone on its way out while LogoLight holds it for its own
  feature (LogoLight's power assertions say so): LogoLight sets it once and
  would not notice it gone.

One child at a time holds a lock on `lid-awake` next to `desktop.json`, and
that file is non-empty while the switch may be set. A child that was killed
leaves it marked and unlocked, and the app turns lid sleep back on when it sees
a child end and at its next launch. The child tells the app what it did (the
kernel took the call, a display is connected so nothing was written, on
battery, refused, or that the Mac slept all the same, which it sees as
wall-clock time that passed while its monotonic clock stood still), and the
menu's status line says it.

The helper of 1.50.1 gets nothing to act on: its request file is never written
and is deleted at launch. It stays installed until the user removes it from
the menu, the one thing left behind macOS's administrator prompt (`do shell
script ... with administrator privileges` through `osascript`, so the event
loop keeps running while the prompt is open). The idle-sleep part needs none of
this: an `NSProcessInfo` activity with `IdleSystemSleepDisabled`, released by
the kernel with the process. While the app watches for work but holds nothing,
a second kind of activity keeps App Nap from slowing its look at the server,
and still allows sleep.

**The app runs the installer itself; Terminal is the fallback.** `install.sh
--no-admin` puts Node.js and tmux in the home folder, so a This Mac install needs
no password and therefore no terminal, and the two questions only a person can
answer arrive as flags (`src/gui_install.rs`). The app downloads the installer
once to a private folder, asks it what is on this Mac (`install.sh preflight`,
which prints JSON and changes nothing) and draws its choices from that answer.
So the app has no list of coding agents of its own: a new one appears without a
new app, and the list always matches what the installer can really install
here. The installer runs with the login shell's environment, so it finds what
this person already has. The page sends only the agent's id, whether other
devices may reach Codeman, and that password; the password reaches the
installer through its environment, never its command line, where `ps` shows it.

**The install outlives the app.** Its output goes to a file, never a pipe, and
it runs in a process group of its own. With a pipe, quitting the app would kill
the installer at its next write; in the app's group, launchd would kill it with
the app. The file holds the whole run, so a page that was reloaded, or an app
that was opened again, finds the process in `ps` and replays the file from the
first line. That is why the app keeps no state about a run. A run that ends
without the installer's last `done` line failed, and the first error it reported
is the one shown: the ones after it are consequences.

**Adding an agent is a run of its own.** `install.sh agent <id>` installs one
agent and touches neither Codeman nor its service, so it may run next to a live
server, which an install must refuse: the installer's service step would replace
that server under its sessions. It has its own temporary folder, so `ps` tells the
two apart: everything that reads a running install takes it to mean "Codeman is
being installed", which an agent run does not. One run goes at a time, since both
can write to the runtime folder. It asks `preflight` for the list like an install
does, and both pass `--no-admin`: that flag decides which agents count as
installable, so without it on both the page could offer one the run refuses. The
menu item is on the connect page because that is where the app may run things:
from a Codeman page it leaves the page the way *Switch Server* does.

**Terminal stays for what the app cannot do.** The route with Homebrew asks for
the administrator password on a terminal, the Xcode tools arrive as a system
dialog, and ssh asks about host keys and passwords on a terminal too. The app
writes a short script to the per-user temporary folder (mode 0700, created
fresh, deleted by the script as it starts) and opens it with `open -b
com.apple.Terminal`, which needs no permission; scripting Terminal with
osascript would ask for Automation access. The script prints what it runs. A
This Mac install downloads the installer to a temporary file and runs it from
there, so the installer's input is the terminal. Everything in the scripts is
built and unit-tested in `src/setup.rs`; the page sends only which install it
wants, whether other devices should reach it, and the SSH login, which is
checked before it is quoted.

**This Mac's own login comes from where Codeman keeps it.** A Codeman
installed with a password keeps it in its LaunchAgent (`install.sh`) or in
`~/.codeman/.env` (what `codeman attach`, `codeman tui` and `codeman agent`
read). The app reads the same places, so a password-protected Codeman on this
Mac opens without typing the password. The username and password always come
from the same place, since the server reads its username from its own
environment. The login goes only to `127.0.0.1` on that Codeman's port, and
only while `lsof` shows one of your own Codeman processes holding that port:
with Codeman stopped, whatever else listens there never gets it.

**Never a second server on the same sessions.** Two Codeman servers on one
data directory and tmux socket attach to each other's live sessions, and
`codeman web -d` only notices a server it started itself or one at the same
address. So the app looks for running Codeman servers of this user (`ps`)
before it offers or runs a start, and offers to connect to the ones it finds
instead (`found_addresses` in `src/setup.rs`, unit-tested).

**Closing the main window quits the app.** Codeman's sessions keep running on
the server, so nothing is lost, and reopening takes about a second.

**One reachability probe per user action, and one to check a refused login.**
Codeman counts a request without valid credentials against its login rate
limit (10 per IP, 15 minutes; a successful login resets the count), so the app
never retries in a loop. A look at this Mac asks each Codeman server found
here once; the app has a login only for the one at the usual address, so the
others are asked without one. Once the server refuses the login in a challenge,
the app sends it only once more, in the single probe that checks the refusal.
If that probe is refused or rate limited, the connect screen comes back; the
app does not send the refused login again. Keeping no copy of the login in
WebKit has a cost here: after a server restart, each request that arrives
without a cookie gets a 401 before the
login goes out, and those count until on**The logo moves on its own hardware fades, from a child process, through CoreBrightness.**
Apple documents one control for the logo ([support.apple.com/en-us/149248](https://support.apple.com/en-us/149248)):
`sudo defaults write com.apple.CoreBrightness LEBacklightMode -int 0`, an on/off setting that
`corebrightnessd` keeps in root's preferences. A process of the logged-in user can reach the
daemon without an administrator through `BrightnessSystemClient` in the private CoreBrightness
framework, and 1.50.0 blinked by switching that setting there. The blink now uses two other
properties of the same client, which [LogoLight](https://github.com/Ark0N/LogoLight) (MIT, its
`docs/corebrightnessd.md`) measured on the real logo and `src/logo.rs` reimplements:
`LEPWMFactorFadeDuration` sets how long the next fade takes, and `DisplayLogicalState` 1
(Blank) fades the logo to dark and 2 (Unblank) back to lit, on the LED's own spring curve.
Nothing of that is saved, so a blink writes no setting and leaves nothing behind a restart;
`LEBacklightMode` is only read.

The daemon decides the rest. Writing the direction the logo already heads in is ignored, and
the state cannot be read back, so the child keeps track of it and, when it does not know,
first turns the logo round with a fade too slow to see. The keyboard backlight follows
`DisplayLogicalState` too, so after every Blank the keyboards alone are told Unblank
(`setProperty:withKey:keyboardID:`), only while the built-in display is awake
(`CGDisplayIsAsleep`); when it sleeps they are told Blank, and Unblank when it wakes. A rise
from exactly dark waits for the display to show a frame, up to half a second with nothing
changing on screen. So the short dark beats (Alarm's, Heartbeat's, Wink's, Fast's) turn round
while their fall is still under way and never quite reach dark, and a long one (Calm's,
Slow's, the breath's rest) times its light from when the rise starts.

With the lid closed the daemon tells every module so (`ClamshellUpdate` 1), and the logo's
target is then 0 whatever `DisplayLogicalState` says. A client's `ClamshellUpdate` reaches the
same modules, and LogoLight measured on the real MacBook what follows from that, first with an
external display and, for its 1.3.1, on a Mac kept awake with none:
- Kept awake with the lid closed and no other display, the built-in display stays online and
  `CGDisplayIsAsleep` says 0. So the lid sensor (`AppleClamshellState` on `IOPMrootDomain`)
  decides that the logo is out of sight, not the display list.
- Once the daemon has handled the lid (`CBClamshellState` reads 1, a moment after the sensor),
  `ClamshellUpdate` 0 relights the logo and fades work as with the lid open. The child then
  writes `ClamshellUpdate` 1 to each keyboard alone, which stays dark, and to each display in
  `CBDisplayList` alone (`setProperty:withKey:andDisplay:`): told the lid is open, True Tone
  adapts an external display to the covered light sensor and tints it warm and dim.
- The daemon sends the real lid state again when a display or a keyboard comes up. Every beat
  ends lit, so a logo found dark at the start of the next one is told again.
- `DisplayPowerStateEvent` is never written. A client's DidSleep keeps the logo dark, with the
  lid open too, until someone writes DidWake.

The child does this only on the power adapter (on battery a closed MacBook sleeps, and a dark
wake must not light the logo in a bag) and only with every keyboard reachable. The first rise
has to move the logo within 1.5 s. If it does not, the logo is told again, three times in a
row and then every half minute, and the menu line says it stayed dark. Ending a blink with the
lid closed hands the logo back to normal (the automatic duration, then Unblank, which a held
level needs) and then writes `ClamshellUpdate` 1, since normal for a closed lid is dark; the
marker covers a child killed in between. When the lid opens, the daemon tells every module
itself and nothing is written. What the closed lid did last (blinking, stayed dark, nothing to
show with no agent at work, not tried and why, or that the Mac went to sleep under it, which
the child sees as wall-clock time that passed while its monotonic clock stood still) goes to a
file next to `desktop.json` (`logo-lid`, with the readings behind it on its second line), and
the app shows its first line as **Lid Closed: …** under View > Apple Logo Blink Styles, or
says nothing watches the lid while no child runs.

Whether the Mac stays awake under the lid is not the logo's business: Keep This Mac Awake's
lid keeper does that (lid sleep off in the kernel, which holds the Mac at full wake), or
LogoLight's own Lit with Lid Closed, which is the same switch, or an external display. An assertion against system sleep alone would
not do: LogoLight saw the Mac enter a dark wake with it, where the logo stays dark.

LogoLight drives the logo the same way, so the two would fight over every fade. The marker the
child keeps next to the app's settings while it moves the logo (`logo-fade`, which also lets the
next launch put back a logo a killed child left dark) holds the child's process ID, goes down
right before the first write and comes off once the logo is back to normal. A LogoLight that says
`LogoLightStepsAsideForCodeman` in its Info.plist (read from the running app's bundle, by its
process ID) looks at that file every second and pauses while it names a running
`codeman-desktop`, so the child waits two seconds after writing it before its first fade.
LogoLight takes the logo back only once the file has been gone for a second and a half, so a
blink that starts within a second of the last one's end (work, then a permission) does not
wait again. An older LogoLight is left the logo, as before. LogoLight ships its side since
1.3.0. With the lid closed, the two tell the logo the same thing (the lid is open), so a
LogoLight that lights the logo under the lid and a blink do not undo each other; when a blink
ends there the logo goes dark, and LogoLight lights it again as it takes it back.

The app must not end with the logo dark, and the release profile has `panic = "abort"`, so no
cleanup code of the app can be relied on. So all of it runs as this same binary with
`--logo-blink`, for as long as the switch is on and a server is open, tied to the app by
nothing but a pipe: when the pipe closes, however the app ended, it puts the logo back (lit,
with the daemon's automatic fade duration) and exits. Switching it off closes the same pipe,
so the path a crash takes is the one used every day. A marker file (`logo-fade`, next to
`desktop.json`) covers what the child cannot survive itself: at the next launch the app puts
back a logo a blink left dark, and with 1.50.0's marker (`logo-blink`) it switches back on a
logo that version left off. The framework is loaded at run time and never linked, and
`LEBacklightMode` reading nil (a Mac mini answers nil) is what hides the option, so a macOS
that drops it loses this feature and nothing else.

e child cannot survive itself:
at the next launch the app puts back a logo a blink left dark. The framework is
loaded at run time and never linked, and `LEBacklightMode` reading nil (a Mac mini
answers nil) is what hides the option, so a macOS that drops it loses this feature
and nothing else.

**Red and yellow come from the server's approvals list.** `GET /api/approvals` is what the
page reads to rebuild its red and yellow tabs after a reload, and it follows the same rules:
`permission` and `question` items are red, an `idle` item is yellow until someone has looked
at it (`acknowledgedAt`). So the logo stops when the tab's colour goes. The request is skipped
when neither alert has a style, and a server from before the list reads as no alerts. Each
poll with a dialog on screen costs that server one tmux capture, because the list re-checks
the dialog, which also clears red soon after a dialog is answered in the terminal.

**The agent count is asked for natively, because the page cannot be trusted with it.**
The first version read the page's own event stream, which needs no second connection
and no login. On a real Mac it failed in both directions as soon as the window was
covered, because WebKit stalls the stream of a hidden page: a turn that started while
it was stalled was never seen and the logo stayed still, and in another run the logo
kept blinking 39 seconds after the agent finished, until the page's watchdog reopened
the stream. A hidden window is the normal case for a signal meant to be read from
across the room, so `src/agents.rs` asks `api/sessions` itself, from the child process,
every two seconds. That needs care with the login. A request with a good password and
no session cookie makes Codeman create a login session, it keeps 100 of them, and the
oldest goes first, so polling with the password alone would log every browser out
within minutes. The poller therefore sends the cookie of the first answer with every
request, which Codeman reads first, so one session is created per server start. A
refused login ends the polling for good, because Codeman counts each refusal against
the login rate limit. The app and the child share nothing but the pipe the login
crosses, so the login is never on a command line.

## Known limits

- **A new agent can take a few minutes to show up in an older Codeman.** The server
  remembers that a CLI is missing, for up to 5 minutes after it last looked
  (`cliResolveRetryDelayMs`), so that a status poll never spawns a login shell. The
  installer's `cli-installed` marker ends that at once, but only for a server that
  knows the marker, so the screen after *Add a coding agent* still mentions it. An
  open Codeman page always needs a reload, because the list of installed agents is
  part of the page.
- **Agents the app can add are the ones `--no-admin` can install.** OMP's macOS
  install is Homebrew, so it is not offered, also on a Mac that has Homebrew.
- **Agents that install with npm use whichever Node.js the login shell finds.**
  With the Node.js the installer downloaded, or Homebrew's, that folder is yours.
  The nodejs.org installer leaves `/usr/local/lib/node_modules` to root, so those
  agents would be expected to fail there, with npm's permission error shown, while
  the ones with their own installer still work. This has not been tried.
- **Only your own Codeman servers on this Mac are found, by their command
  line.** A server another macOS user runs, or one in a container or a virtual
  machine, is not listed: connect to it by address under Another machine. A
  base path that a server started by hand has only in its environment
  (`CODEMAN_BASE_URL`) is not visible either, so its row has the address
  without the path; the LaunchAgent's base path is read from its job.
- **A found server that is slow to answer shows as not answering.** Next to a
  Codeman that answers, each other server gets two seconds (five when nothing
  answers at the usual address). A password-protected one counts the
  look as a failed login, like any look at a server the app has no login for.
  *Check again* asks again.
- **The logo blink rests on a private macOS interface.** Apple documents the
  on/off setting, not the fades the app uses, so a macOS update can take them
  away. The menu disappears if `LEBacklightMode` goes; if only the fade keys
  change, the logo stops moving. A long dark beat (*Calm*, *Slow*, the rest in
  *Breathe*) can be up to half a second longer than its style says, while the
  display waits for a frame before the logo rises. Every Blank dims the
  keyboard backlight a little before it is told to stay lit. A child killed
  outright (SIGKILL) leaves the logo where it was, perhaps dark, until the
  display next sleeps and wakes or the app next starts. Another app that drives
  the logo the same way and is not LogoLight is not recognised, and the two
  fight. The handover with a LogoLight that steps aside was checked against a
  stand-in process carrying LogoLight 1.3.1's Info.plist and against LogoLight's
  own tests, and ran in that release candidate next to LogoLight 1.3.1; its
  timing on a real logo was not measured. `api/sessions` does not say which turns are Codeman's own, so with
  prompt-cache keep-warm on, a keep-alive turn blinks too.
- **Keeping the lid awake without a password has not been seen on a real closed
  MacBook yet.** The method is LogoLight's, which its author saw work on a
  MacBook Pro (macOS 27.2, LogoLight 1.3.1). Codeman's own code ran on a Mac
  mini, which has no lid (macOS 27.2): the kernel took the call from an
  unprivileged process, the child held its two assertions under its name, let
  go when its pipe closed and after a minute of silence, ignored SIGTERM, and
  waited for a child before it; a child killed with SIGKILL was replaced by the
  app, and its mark undone; told that a display is connected, it held its
  assertions and wrote nothing. Not checked: *Sleep* in the Apple menu while the lid
  is held, a run of many hours, and pulling the adapter with the lid closed.
  Read from Apple's sources and not measured: when an external display is
  unplugged under a closed lid, macOS's power daemon turns lid sleep back on
  itself, and the Mac sleeps or drops to a dark wake (logo dark), although the
  child sets the switch again a second later. Docked is read as "a display other
  than the built-in one is connected", the nearest an app gets to what the
  window server tells the power daemon: with a display macOS does not use for
  its closed-lid mode (Sidecar and AirPlay were not checked), nobody holds the
  lid, and the Mac sleeps or drops to a dark wake when it closes; the status
  line then reads "lid left to macOS at a display", and after such a sleep
  until when the Mac slept. A child that
  set the switch and was then let go of at a display stays, without the app,
  until the display has gone. A SIGKILL of the app together with its child
  leaves lid sleep off until Codeman next starts or the Mac restarts. With two
  copies of the app open, the lid is released for a second when the copy that
  held it lets go.
- **Blinking with the lid closed was seen on one MacBook Pro so far** (macOS
  27.2, on power, a release candidate of 1.50.1 on 2026-11-10; the method is
  LogoLight's, which its author measured for LogoLight 1.3.1). Nothing was
  measured in that run, it was watched. Not checked, by LogoLight or here: the
  built-in display's brightness when the lid opens again, and an Apple display
  with its own light sensor. If the logo does not move under a closed lid, the
  menu line says "stayed dark".
- **Self-signed HTTPS is refused.** A server started with `codeman web --https`
  uses a self-signed certificate, and WKWebView rejects it (wry has no trust
  override). Use `http://127.0.0.1:3000` for a server on this Mac. For another
  machine, serve Codeman through `tailscale serve`
  (`https://<machine>.<tailnet>.ts.net` has a real certificate) or a reverse
  proxy with a real certificate. Marking the certificate as trusted in
  Keychain Access can only help at `https://localhost` or `https://127.0.0.1`,
  the only names Codeman's certificate carries, and may not work even there.
  The connect screen says so when it happens.
- **Keychain prompt after every rebuild of an ad-hoc build.** The Keychain
  knows the app that saved a password by its code signature, and an ad-hoc
  signature changes with every build and update. So each new build asks once
  for access to the saved passwords: choose *Always Allow*. All Keychain work
  runs on one background thread, so the prompt does not freeze the window
  while it waits for an answer. To keep one identity across builds, sign with
  `SIGN_IDENTITY` (a self-made code-signing certificate from Keychain Access
  is enough). Microphone and camera permissions are asked again for the same
  reason.
- **Gatekeeper, for a build of your own.** The `Codeman.dmg` on each GitHub
  release is signed with a Developer ID and notarized by CI
  (`.github/workflows/desktop-dmg.yml`), so it opens like any downloaded app.
  A build without a Developer ID is signed ad hoc: it opens normally on the Mac
  that built it, while a copy that arrived by download or AirDrop is
  quarantined. On macOS 15 and later, try to open it once, then click *Open
  Anyway* in System Settings > Privacy & Security (it asks for an administrator
  password). On macOS 14 and earlier, right-click it and choose *Open* once.
  Either way, `xattr -dr com.apple.quarantine /Applications/Codeman.app` on the
  copy in Applications works too. To sign and notarize by hand:
  `SIGN_IDENTITY="Developer ID Application: ..." NOTARY_PROFILE=<profile> ./scripts/bundle-macos.sh --universal --notarize`,
  where `scripts/sign-macos.sh` lists what it needs.
- **Local Network permission (macOS 15 and later).** The first connection to an
  address on the local network (a LAN IP, a `.local` name) makes macOS ask
  whether Codeman may use the local network, and that first attempt can fail
  while the question is open: connect again after answering. If it was denied,
  turn Codeman on in System Settings > Privacy & Security > Local Network. A
  server started with *Start Codeman on this Mac* counts as part of the app
  here, so the same answer covers what it reaches on the local network (ssh to
  LAN hosts, Wake-on-LAN, web tabs pointing at LAN dashboards), also after the
  app quits.
- **Subagent transcript windows do not open in the app.** Codeman writes that
  view into a blank `window.open('')` window, which the app refuses (see
  Decisions), and shows a toast instead. A Codeman without the null check in
  `viewSubagentTranscript` (`src/web/public/panels-ui.js`) reports *Failed to
  load transcript* there. Open the transcript from a browser tab.
- **Dialogs are app-modal.** While a JavaScript dialog is open, every Codeman
  window waits for it. A page that calls `alert()` in a loop (a rendered HTML
  preview or a web tab can) leaves no way out but Force Quit (`⌥⌘⎋`).
- **Codeman needs the WebKit of Safari 16.4.** The app itself runs on macOS
  11.3 or later (downloads go through WKDownload, which arrived in 11.3), but
  Codeman's terminal (xterm.js 6 uses class static blocks) needs the WebKit
  that came with Safari 16.4: macOS 13.3, or macOS 11 or 12 with Safari 16.4
  or later installed. On an older WebKit the connect screen says so and does
  not connect. Session pop-outs also need BroadcastChannel (Safari 15.4),
  which the same requirement covers.
- **Plain links in rendered HTML and web tabs do not open.** A link to another
  site inside a rendered HTML preview or a web tab does nothing, in the
  preview overlay, and for a rendered HTML file in its pop-out window too: the
  app blocks navigation to other sites in every frame (see Decisions). A link
  there that asks for a new window (`target="_blank"`, or a script's
  `window.open`) does open, in your default browser, within the budget of 3 at
  once and then 1 per second.
- **No login dialog for a web tab's own HTTP Basic login.** The app answers
  only Codeman's own login, and WebKit shows no dialog for any other, so a
  dashboard in a web tab that asks for HTTP Basic shows its 401 page.
- **Downloads from previews and web tabs are saved without asking.** Rendered
  HTML files and web tabs are allowed to start downloads, and the app saves
  every download to `~/Downloads` without a prompt. Asking first for those
  frames is not done yet.
- **No desktop notifications yet.** WKWebView has no Web Notification API.
  Native notifications are the first item on the list below.
- **No service worker.** Codeman works without it; it is only an offline cache.
- **The graphical install needs macOS 15, or a tmux that is already there.**
  tmux comes from the tmux project's own builds, which need macOS 15. On an
  older Mac without tmux the app says so and offers Terminal, where Homebrew
  installs it (that takes an administrator once).
- **Who can reach it stops at the local network.** Tailscale needs its own
  login and setup, which the installer does at a terminal. Choose *Install in
  Terminal instead*, or run `install.sh tailscale` later.
- **An agent is chosen during the install, or added later.** With Codeman
  already installed, or after *Skip for now*, *Add a coding agent* on the This
  Mac tab (*Add a Coding Agent to This Mac…* in the app menu) installs one. The
  commands are also in [Installing an agent CLI](../../docs/wiki/Installation.md#installing-an-agent-cli).
- **An agent only your interactive profile finds counts as missing.** The app
  reads the login shell's environment, without `.zshrc`, so a CLI on an nvm
  PATH set up there is offered again as if it were not installed. Installing
  it again is harmless; *Skip for now* leaves it as it is.
- **Installing from the app is macOS only so far**, and installing on another
  machine needs ssh access to it and `curl` or `wget` there. The app does not
  know when a remote install is done or which address it chose: the installer
  prints the address, and you connect to it under Another machine.
- **A This Mac install always sets Codeman up as a LaunchAgent** that starts
  at login. To stop it: `launchctl unload ~/Library/LaunchAgents/com.codeman.web.plist`;
  to remove Codeman: `curl -fsSL https://getcodeman.com/install | bash -s -- uninstall`.
- **Windows and Linux** need their menu hookup (`init_for_hwnd`, GTK), a
  credential store (Credential Manager, Secret Service) and installers. The
  rest of the code is platform-neutral.

## Ideas for next

- Native notifications and a Dock badge with the number of sessions waiting
  for you (tao has `set_badge_label`; Codeman already tracks which sessions need input).
- A global hotkey that brings Codeman to the front from anywhere.
- A menu bar icon showing session states.
- Trusting a self-signed server certificate by its fingerprint.
- Asking before a download that a rendered HTML file or a web tab starts.
- A way out of a page that keeps opening dialogs (a "block further dialogs" option).
- Windows and Linux builds, auto-update.
