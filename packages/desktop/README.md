# Codeman Desktop

A small native app that opens Codeman in its own window. Double-click it, and
it runs Codeman on this Mac (installing it first if it is not there) or
connects to Codeman on another machine (installing it there over SSH if
needed), and Codeman fills the window. `⌃⌘F` puts it in full screen.

macOS first: the app runs on 11.3 or later, and Codeman's own page needs the
WebKit of Safari 16.4 (see Known limits). The same code is meant to build for
Windows and Linux later.

- **Size:** 4.6 MB for the universal `Codeman.app` (Apple Silicon + Intel), 3 MB as a `.dmg` (measured on the first build).
- **Stack:** Rust with [tao](https://crates.io/crates/tao) (window and event loop),
  [wry](https://crates.io/crates/wry) (the system web view: WKWebView on macOS) and
  [muda](https://crates.io/crates/muda) (native menus), plus [objc2](https://crates.io/crates/objc2)
  for the two things wry leaves out on macOS (JavaScript dialogs, HTTP Basic login).
  No bundled browser and no Node in the app.
- **Server:** unchanged. The app is a client of Codeman's web UI, like a browser tab.

## Why it is cheap

Codeman is already a web app, so the desktop app is a native window around the
operating system's own web view. An Electron build of the same thing would ship
a whole Chromium (around 150 MB). The native side only adds what a browser tab
cannot do.

## What it does (v0.1)

| | |
| --- | --- |
| **This Mac** | The connect screen's first tab looks for Codeman on this Mac and offers what fits: *Open Codeman* when it runs, *Start Codeman* when it is installed but stopped, *Install Codeman on this Mac* when it is not there. The address comes from Codeman's LaunchAgent (port, sub-path, HTTPS). When nothing answers there but one of your own Codeman servers runs (found with `ps` and `lsof`: a `codeman web --port 4000` in a terminal, say), the tab opens that one, or says where it listens; it never offers to start a second server, which would take over the first one's sessions, and Start refuses while one runs. Start asks launchd to run the LaunchAgent (`kickstart`, or `bootstrap` when it is not loaded), so the server keeps its own settings and supervision; without a LaunchAgent it runs `codeman web -d`. The login comes from where Codeman keeps it: the LaunchAgent's `CODEMAN_USERNAME`/`CODEMAN_PASSWORD`, else `~/.codeman/.env` (what Codeman's command-line clients read), `admin` by default. It goes only to `127.0.0.1` on that Codeman's port, only while one of your own Codeman processes holds that port, is never saved to the Keychain, and never reaches the page. Whether Codeman is installed is looked up in its files and processes, then the login shell; the interactive profile (nvm in `.zshrc`, say) only on *Check again*. Install sets Codeman up from the app itself, with no Terminal and no password (see Decisions). It fetches the installer, asks it what is on this Mac, then asks two things: which coding agent to install, only when this Mac has none (the list comes from the installer, and *Skip for now* is there), and who can reach Codeman (this Mac only, or the local network with a password). A checklist follows the install, the installer's output is one click away, and Cancel stops it; installing again picks up where it stopped. Codeman runs as a LaunchAgent, so it keeps running when the app quits and starts at login. Port 3000 is used unless something else answers there, then the next free one. Closing the app does not stop an install: it runs on its own, and the app picks it up when it opens again. When it is done the app looks every 3 seconds and opens Codeman as soon as it answers; it stops looking after the first answer, after 30 minutes, or 90 seconds after a finished install whose server never answered (then it offers Start). *Install in Terminal instead* runs the installer in a Terminal window, for what the app cannot do (see Known limits): it may ask for the Mac password (Homebrew) and asks its own questions there. The app offers it by itself on a Mac where the graphical install cannot finish. An install still running in Terminal is recognized by its process, so the tab waits for it instead of offering Install twice. *Add a coding agent*, on this tab and in the app menu whenever Codeman is on this Mac, is the same chooser after the install: pick one agent, watch it install, open Codeman. It needs no password, leaves a running Codeman alone, and can be cancelled or left running like an install. After *Skip for now* the app says Codeman has no agent yet and offers this before it opens Codeman. |
| **Another machine** | The second tab connects to a server by address (below). *Codeman is not installed there yet?* opens Terminal, connects with `ssh -t` and runs Codeman's installer on that machine, which asks its questions there; the app then suggests `http://<host>:3000` and the installer prints the real address at the end. The SSH login is checked to the characters of a user and host name (no option can be slipped in) and may carry a `:port`. The remote command runs under `bash -o pipefail`, so a failed download fails the install instead of reporting success. The same tab shows the one-line install command, with a Copy button, to run on a machine by hand. |
| **Connect screen** | Server address, recent servers, a login for password-protected servers (password kept in the macOS Keychain), auto-connect at launch. It explains each failure: nothing listening; wrong password; too many failed logins (the password field stays open, since a single-user Codeman accepts the right password even then); unknown host name; an address this Mac cannot reach (with a pointer to the Local Network setting); an `http://` address on a port that only speaks HTTPS; an untrusted certificate; a redirect, with a button for the suggested `https://` address; not a Codeman server. A multi-user account that must change its password connects, and Codeman's own dialog asks for the new one. If the server page has not started showing within 15 seconds, or you press Cancel while it opens, the connect screen comes back with a notice. On a Mac whose WebKit is too old for Codeman it says so and Connect stays off (see Known limits). |
| **Start Codeman** | On the This Mac tab, and when `http://127.0.0.1:<port>` or `http://localhost:<port>` answers nothing, one click runs `codeman web -d` (or `~/.codeman/app`) with your login shell's environment, so the server gets your real PATH (Homebrew, nvm) for the agents it spawns. zsh, bash and other POSIX shells run the start themselves; fish, nu, xonsh, tcsh and other shells only report their environment, and the start runs under `/bin/sh` with it. Offered for those two addresses only: `codeman web -d` listens on 127.0.0.1. |
| **Login** | The app answers the server's HTTP Basic login requests itself, with the login you connected with, so the page keeps working after the server restarts (a restart forgets every session cookie). It answers only for Codeman's own pages under the server's base path: a web tab or a rendered HTML file that asks for a Basic login of its own is left to WebKit and never gets your Codeman password. WebKit keeps no copy of the login, so every request for it gets the current one. Each connect first clears the app's cookies, so connecting to the same server as another user really switches users (local storage, where Codeman keeps its per-device settings, stays; a dashboard in a web tab that keeps its own login in a cookie may ask for it again). A page that still gets a 401 reloads once. If the server refuses the login (the password was changed, say), the app does not keep sending it: it checks it with a single probe, and only if the server refuses that too does the connect screen come back with a notice. That does not take focus from the app you are in: if Codeman is in the background, its Dock icon bounces. |
| **Dialogs** | Codeman's `confirm()`, `prompt()` and `alert()` (Delete case, Kill all sessions, Update Codeman, discarding unsaved edits, ...) show as native macOS dialogs. wry implements none of them, and without them WKWebView answers Cancel without showing anything. |
| **Full screen** | `⌃⌘F` or the green button. The last state is restored at launch; *Always Open in Full Screen* forces it. Leaving full screen returns to the saved window size and position. |
| **Menus** | A real Edit menu (without one, `⌘C`/`⌘V` do nothing in a WKWebView), Reload `⌘R`, Switch Server `⇧⌘O`, Developer Tools `⌥⌘I`. The page sees every key first, so Codeman's own shortcuts keep working. If the main window ends up showing a raw file instead of Codeman, `⌘R` takes it back to Codeman. |
| **Pop-outs** | Implements Codeman's existing native-wrapper bridge, `window.CodemanHost` (`openInHostWindow` in `src/web/public/app.js`), so popping out a session or a file preview opens a real app window, and the pop-out icon is on by default. Session and rendered-HTML pop-outs come only from Codeman's own pop-out button. A `window.open` from page script opens only Codeman's file and download windows, without taking keyboard focus, at most 3 at once and then 1 per second. Only Codeman's own pop-out pages become app windows (see Decisions); when the app refuses one, Codeman shows a toast. A web tab's *Open in new tab* opens the dashboard in your default browser, as it would from a browser tab. |
| **Links** | On Codeman's own pages (the dashboard and session windows), a link to another site opens in your default browser, also on `⌘`-click or a middle click. Pages can send at most 3 links to the browser at once, then 1 per second. Links to other sites inside rendered HTML previews and web tabs do not open (see Known limits). |
| **Downloads** | Codeman's Download links, and downloads Codeman opens in a new window, save the file to `~/Downloads` whatever its type, and a toast in Codeman names the file. Files the web view cannot display are saved the same way. |
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
  rendered HTML views, the raw, preview, attachment and folder file routes, and
  `api/download`. A `window.open` or `target=_blank` link, which WebKit passes
  on from any frame without saying which, gets only the file routes and
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
before it offers or runs a start, and opens the one it finds instead.

**Closing the main window quits the app.** Codeman's sessions keep running on
the server, so nothing is lost, and reopening takes about a second.

**One reachability probe per user action, and one to check a refused login.**
Codeman counts a request without valid credentials against its login rate
limit (10 per IP, 15 minutes; a successful login resets the count), so the app
never retries in a loop. Once the server refuses the login in a challenge, the
app sends it only once more, in the single probe that checks the refusal. If
that probe is refused or rate limited, the connect screen comes back; the
app does not send the refused login again. Keeping no copy of the login in WebKit has a cost here: after a server
restart, each request that arrives without a cookie gets a 401 before the
login goes out, and those count until one succeeds. Many windows reconnecting
at once can push a request past 10, and that request then fails with a 429
instead of being answered. A refusal that lands while you are in another app
does not bring Codeman forward: the connect screen loads where the window is,
and the Dock icon bounces.

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
- **Gatekeeper.** Without a Developer ID the app is signed ad hoc. A build you
  made yourself opens normally; a copy that arrived by download or AirDrop is
  quarantined. On macOS 15 and later, try to open it once, then click *Open
  Anyway* in System Settings > Privacy & Security (it asks for an administrator
  password). On macOS 14 and earlier, right-click it and choose *Open* once.
  Either way, `xattr -dr com.apple.quarantine /Applications/Codeman.app` on the
  copy in Applications works too. Shipping it to other people needs a Developer
  ID signature and notarization:
  `SIGN_IDENTITY="Developer ID Application: ..." ./scripts/bundle-macos.sh --dmg`,
  then `xcrun notarytool submit` and `xcrun stapler staple`.
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
- **Links in rendered HTML and web tabs do not open.** A link to another site
  inside a rendered HTML preview or a web tab does nothing, in the preview
  overlay, and for a rendered HTML file in its pop-out window too. The app
  sends links out only from Codeman's own pages, and blocks navigation to
  other sites in every frame (see Decisions).
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
- **The agent is chosen during the install.** With Codeman already installed,
  or after *Skip for now*, an agent is added by hand: its commands are in the
  installer's closing notes and in [Installing an agent CLI](../../docs/wiki/Installation.md#installing-an-agent-cli).
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
- Windows and Linux builds, a CI job that builds the `.dmg`, notarization, auto-update.
