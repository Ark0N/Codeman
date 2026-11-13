# Installation

Getting Codeman onto a machine, verifying it works, updating it, and removing it.

## Requirements

| Requirement      | Notes                                                                                                                                  |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| **macOS or Linux** | Windows works through WSL2. See [Windows](#windows-wsl) below.                                                                        |
| **Node.js 22+**  | The installer offers to install it if missing.                                                                                          |
| **tmux**         | Not optional. Sessions live inside tmux, which is what makes them survive a server restart, a dropped connection, or a closed laptop.    |
| **An agent CLI** | At least one of [Claude Code](https://docs.anthropic.com/en/docs/claude-code), [OpenCode](https://opencode.ai), [Codex](https://developers.openai.com/codex/cli), [Antigravity](https://antigravity.google), [Gemini CLI](https://github.com/google-gemini/gemini-cli), [Pi](https://pi.dev), [Grok Build](https://github.com/xai-org/grok-build), [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness), [OMP](https://github.com/can1357/oh-my-pi), [jcode](https://jcode.sh). Plain shell sessions need none. See [Agent CLIs](Agent-CLIs). |

Codeman itself sends no telemetry and phones no home. The only network traffic is your
browser to your server, and whatever the agent CLI you chose does on its own, plus the
server's own few requests (Codex usage, web push, webhooks) and, on by default while Copilot
CLI is installed and signed in, a read of your own GitHub Copilot quota every 10 minutes
(Plan Usage Limits in App Settings turns it off; see [Agent CLIs](Agent-CLIs)).

## Route A: the installer (recommended)

```bash
curl -fsSL https://getcodeman.com/install | bash
```

This installs Node.js, tmux and a build toolchain if they are missing (node-pty ships no
Linux prebuild, so it compiles from source), clones Codeman into `~/.codeman/app`, and
builds it. On a Mac, the [Codeman app](#on-a-mac-the-codeman-app) can run this installer
for you, with no Terminal.

It starts by printing what it found (git, Node, tmux, build tools, agent CLIs, Tailscale,
an existing install), then asks everything it needs up front, then does the work
unattended. You can leave while it builds. What it asks you:

1. **One consent for the missing packages.** Git, Node.js, tmux and (on Linux) the build
   toolchain are installed after a single yes, and sudo asks for your password once for
   the whole run. Nothing is installed silently. If no agent CLI is found, a menu offers
   to install any of them (DeepSeek excepted: its npm package installs only a launcher
   with no runnable profile), or you skip and install one yourself later.
2. **How the dashboard should be reachable.** Three choices:
   - **Tailscale** (recommended for phone access): keeps the loopback bind, installs
     Tailscale if needed, logs in, enables the tailnet HTTPS toggle (it opens the admin
     page for you and waits; Ctrl+C there skips Tailscale for this run), then configures `tailscale serve` after the build and
     verifies the result end to end. If another app already owns `:443` on your node,
     you choose between a sub-path (`https://<machine>.<tailnet>.ts.net/codeman`, the
     default), a second port, replacing the other mapping, or skipping.
   - **Your local network** (`0.0.0.0`): prompts for a password. Skipping the password takes
     an explicit confirmation and ends on a loud warning.
   - **This machine only** (`127.0.0.1`): the safest option, and the default for a bare
     `codeman web` regardless of what you pick here.

   Which one is preselected depends on what the installer finds. A fresh install defaults to
   the local network, unless Tailscale is already connected, in which case it defaults to
   Tailscale. An existing loopback install defaults to keeping loopback, or to Tailscale when
   a serve mapping for Codeman is already there. A bare Enter never pulls in new software,
   and a non-interactive run always keeps the safe loopback default.
3. **What to call this machine on your tailnet** (Tailscale route only). By default the URL
   uses the machine's existing name. Answer yes to rename it `codeman-<hostname>`; the
   default is no, because the tailnet name is also what SSH and everything else on that
   machine are reached by.
4. **Whether to run Codeman in the background.** Enter installs a systemd user service or a
   macOS LaunchAgent that starts on boot; answering no offers to start it in this terminal
   instead, or not at all.

It ends on a screen with the URL (your tailnet, your network, or this machine), a QR code to
scan with your phone, and the two commands you need to manage the service.

Re-running the same one-liner **updates an existing install in place**. Local changes in
`~/.codeman/app` are stashed rather than discarded, a running service is restarted and
verified, and your existing network binding is preserved. An interrupted first install
resumes instead of restarting.

Other entry points:

```bash
install.sh status       # print the URLs, the QR code and the manage commands again
install.sh update       # update only
install.sh uninstall    # remove (offers to undo a rename it performed)
install.sh tailscale    # retrofit Tailscale access onto an existing install
install.sh name [<n>]   # rename this machine on your tailnet (default codeman-<hostname>)
install.sh cloudflared  # install cloudflared for the in-app Cloudflare tunnel
install.sh preflight    # print what is on this machine as JSON; changes nothing
install.sh agent <id>   # install one agent CLI and nothing else, also next to a running Codeman
```

**Flags** answer the questions from the command line and pipe through `bash -s --`:

```bash
curl -fsSL https://getcodeman.com/install | bash -s -- --tailscale --service
curl -fsSL https://getcodeman.com/install | bash -s -- --lan --password 'x' --service
curl -fsSL https://getcodeman.com/install | bash -s -- --local --run
```

`--tailscale` / `--lan` / `--local` answer the access question, `--name <n>` / `--no-rename`
the name, `--service` / `--run` / `--no-start` the last one. `--yes` takes every default
(it still waits on a Tailscale login URL, and a network bind still asks for a password).
`--port <n>` moves Codeman off 3000; the service file and the serve mapping follow it. On an
existing install, `--port` and `--password` re-run the setup so the service file picks them up,
and a re-run with `--lan` or `--tailscale` keeps the password the service already has.
`--ai-cli <id>` answers the agent menu that appears when no agent CLI is found, with no
terminal needed (`--ai-cli claude`, `--ai-cli codex`, ...), and `--ai-cli none` skips it.
To add an agent later, `install.sh agent codex` installs that one and changes nothing else:
it does not touch Codeman or its service, and an agent that is already there is left alone.
Codeman Desktop does the same from *Add a coding agent*. A running Codeman notices the new
agent at once; reload an open page to see it.

**Automation and CI**: with no terminal attached, any step that would change the system
aborts with instructions instead of running silently. Set `CODEMAN_NONINTERACTIVE=1` to
approve those steps. With nothing else said, that also installs the first agent CLI of the
catalogue when none is found; `--ai-cli` (or `CODEMAN_AI_CLI`) says which one, or none.
`CODEMAN_TAILSCALE=1` preselects the Tailscale answer, and never
installs Tailscale itself non-interactively; a non-interactive run never renames the
machine and never starts a service. Everything the unattended steps print goes to
`~/.codeman/install.log`, and the last lines of it are shown when a step fails.

### Without administrator rights

Codeman itself always lived in your home directory. What used `sudo` (or Homebrew on a
Mac) were the things it needs first. On an account that has no administrator rights the
installer says so in its summary (`Admin  not used (...)`) and gets those another way:

| Needed                  | With administrator rights    | Without                                                                                                                             |
| ----------------------- | ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Node.js 22              | system package or Homebrew   | The official tarball from nodejs.org, checked against the `SHASUMS256.txt` published beside it, unpacked to `~/.codeman/runtime/node`. |
| tmux                    | system package or Homebrew   | The tmux project's own build ([tmux-builds](https://github.com/tmux/tmux-builds)), checked against a SHA-256 pinned in the installer, in `~/.codeman/runtime/bin`. |
| git                     | system package or Xcode tools | Not installed. Without a working git, the source is downloaded as an archive instead of cloned.                                     |
| Build toolchain (Linux) | system package               | Cannot be supplied. See below.                                                                                                      |

This route is taken by itself when `sudo` is not installed, when the account is outside the
`sudo`, `wheel` and `admin` groups and `sudo` will not run without a password, when the
`sudo` password is refused, and on a Mac for an account that is not an administrator and
has no Homebrew it can write to.
`--no-admin` (or `CODEMAN_NO_ADMIN=1`) forces it on an account that does have the rights;
`CODEMAN_NO_ADMIN=0` switches the detection off. Nothing on this route runs `sudo`,
Homebrew or the Xcode tools installer.

The group check cannot see a sudoers entry, so an account that sudoers lists by name, with
a password, takes this route too. The summary then reads `could not confirm that this
account may use sudo`, and to use `sudo` anyway:

```bash
curl -fsSL https://getcodeman.com/install | CODEMAN_NO_ADMIN=0 bash
```

What to know about it:

- **Linux needs make, a C++ compiler and python3 to be there already.** node-pty compiles
  from source on Linux, and a compiler is a system package. The installer checks this
  before it downloads anything and names what is missing. macOS needs no compiler.
- **The tmux download needs macOS 15 or newer** (and x86_64 or arm64 on either system).
  On an older Mac an administrator has to install tmux once (`brew install tmux`); the
  rest then works without one.
- **An install without git updates by re-running the install line**, not from App
  Settings. The re-run builds the new version beside the old one and swaps it in only
  after the build succeeded, so a failed download or build leaves the install as it was.
  Once the machine has a working git, the next re-run turns the install into a normal
  clone and in-app updates work again. On a Mac, "a working git" means the Xcode Command
  Line Tools are installed: without them `/usr/bin/git` only opens Apple's install dialog,
  and the installer never runs it.
- **Tailscale works where it is already installed and your account may configure it.** On
  Linux, installing it, logging in and granting serve rights each need an administrator
  (`sudo tailscale set --operator=$USER`, once). Local network and this-machine access
  need nothing, and `install.sh cloudflared` puts `cloudflared` in `~/.local/bin`.
- `node`, `npm`, `npx` and `tmux` are linked from `~/.local/bin`, and
  `~/.codeman/runtime/node/bin` is added to your PATH, so a CLI installed with
  `npm install -g` is found as well.

## Route B: npm

```bash
npm install -g aicodeman
codeman web
```

The npm package is named `aicodeman`; the product is Codeman. Both `codeman` and
`aicodeman` are installed as commands.

The trade-off against Route A: no guided network setup, and the in-app self-updater does
not apply. npm installs report as non-updatable in **App Settings → System → Updates**, and
you update with `npm update -g aicodeman`.

## Route C: git clone

For contributing, or for running unreleased code.

```bash
git clone https://github.com/Ark0N/Codeman.git
cd Codeman
npm install            # postinstall builds the vendored xterm addon bundles
npm run dev            # dev server on http://localhost:3000
```

For a production run from a clone:

```bash
npm run build
npm run start
```

`npm run dev` runs TypeScript directly through `tsx` with no build step. The frontend is
plain JavaScript served from `src/web/public/` with no bundler, so editing a `.js` or `.css`
file and reloading the page is enough. The one exception is `index.html`, which is read once
at server start, so markup changes need a restart.

See [Contributing](Contributing) for the rest of the development loop.

## Route D: Docker Compose

Codeman itself can run in a container and spawn Docker cases as sibling containers through
the host's Docker socket. You need Docker with the Compose v2 plugin (2.27.2 or newer), and
an account that can use Docker without sudo (on Linux, the `docker` group). Then, on Linux:

```bash
git clone https://github.com/Ark0N/Codeman.git && cd Codeman
bash docker/Start-Codeman.sh
```

The first run asks for a data folder, a port and a password. Enter takes each default,
including a generated password, shown on your terminal and kept in `docker/.env`. It then
writes that file, builds the image (a few minutes the first time) and ends on the URL once
Codeman answers. The image
already includes Claude Code, Codex, Gemini CLI and OpenCode: start a session and log the CLI
in once, and the login is kept in the data folder.

Run the script again after updating rather than a plain `docker compose up`, so the rebuilt
image, the refreshed volumes and the entrypoint arrive together. The full guide, including
Unraid, storage and networking options, is
[`docker/README.md`](https://github.com/Ark0N/Codeman/blob/master/docker/README.md).

## On a Mac: the Codeman app

[Download Codeman.dmg](https://github.com/Ark0N/Codeman/releases/latest/download/Codeman.dmg):
one universal app for Apple Silicon and Intel, macOS 11.3 or later.

A small native app that opens Codeman in its own window. Its first screen has two tabs:

- **This Mac** looks for Codeman here and offers what fits: *Open Codeman* when it runs,
  *Start Codeman* when it is installed but stopped, *Install Codeman on this Mac* when it is
  not there. It also lists the Codeman servers of yours that already run on this Mac (one
  started by hand in a terminal, say) and offers to connect to those; it never starts a
  second one next to them. Install runs [the installer](#route-a-the-installer-recommended)
  for you, with no Terminal and no administrator password: it asks which coding agent to
  install (only when the Mac has none, and *Skip for now* is there) and who may reach
  Codeman (this Mac only, or the local network with a password), then shows the install as
  a checklist. *Add a coding agent* on this tab (*Add a Coding Agent to This Mac…* in the app menu) installs one later.
- **Another machine** connects to Codeman by address, a tailnet name included, and keeps
  the password in the Keychain. *Codeman is not installed there yet?* opens Terminal and
  runs the installer on that machine over SSH.

On a MacBook Pro with a PROLED XDR display, whose lid logo lights up,
**View > Blink Apple Logo** makes the logo show what your agents are doing: it breathes while
they work, blinks when one waits for you and flashes three times when one needs permission.
Each state can take another style under **View > Apple Logo Blink Styles**. It is off until
you turn it on, and the menu only exists on such a Mac.

**Codeman > Keep This Mac Awake** stops the Mac from going to sleep while your agents work
on it (**While Agents Work**, plus 5 minutes after the last one stops), or for as long as
the app is open (**Always**). It is off until you choose, only acts for a Codeman running
on this Mac, needs no password, and ends when the app quits. On a MacBook it pauses on
battery unless you untick **Only When Plugged In**, and **With the Lid Closed** keeps a
closed MacBook awake too, with no password and never on battery. Codeman 1.50.1 installed
a small helper for this behind your administrator password. It is no longer used:
**Remove the Old Lid Helper…** in the same menu takes it away.

### First launch

1. Open `Codeman.dmg` and drag Codeman into Applications.
2. Open Codeman from Applications. macOS asks once whether to open an app downloaded from
   the internet: click **Open**.
3. On macOS 15 and later, the first connection to an address on your local network (a LAN
   IP, a `.local` name) makes macOS ask whether Codeman may use the local network, and that
   first attempt can fail while the question is open: connect again after answering. If
   you denied it, turn Codeman on in **System Settings > Privacy & Security > Local
   Network**.

What to know about it:

- **Quitting the app does not stop Codeman.** An install from the app runs Codeman as a
  LaunchAgent that starts at login, so agents keep working with the window closed, and a
  browser or phone reaches it as before.
- **Codeman's page needs the WebKit of Safari 16.4.** The app starts on macOS 11.3, but
  Codeman itself needs macOS 13.3 or later, or macOS 11 or 12 with Safari 16.4 or later
  installed. On an older WebKit the app says so and does not connect.
- **The install from the app needs macOS 15, or a tmux that is already there.** tmux comes
  from the tmux project's own builds, which need macOS 15. On an older Mac without tmux the
  app offers Terminal instead, where Homebrew installs it (that takes an administrator once).
- **The install from the app reaches as far as the local network.** Tailscale needs its own
  login and setup, which the installer does at a terminal: choose *Install in Terminal
  instead*, or run `install.sh tailscale` afterwards.
- **Self-signed HTTPS is refused.** A server started with `codeman web --https` uses a
  self-signed certificate, which macOS's WebKit rejects. Use `http://127.0.0.1:3000` for a
  server on this Mac. For another machine, serve Codeman through `tailscale serve`
  (`https://<machine>.<tailnet>.ts.net` has a real certificate) or a reverse proxy with a
  real certificate.
- **The Codeman it installs is an ordinary installer install,** made on the
  [route without administrator rights](#without-administrator-rights), so
  [Updating](#updating) and [Uninstalling](#uninstalling) below apply to it.
- **The app does not update itself yet.** Download the new `Codeman.dmg` and drag it over
  the old copy.
- **Deleting the app leaves Codeman running.** The app's own settings are in
  `~/Library/Application Support/Codeman/`, and its saved passwords in the Keychain under
  *Codeman Desktop*.

Everything else, including how to build it yourself:
[`packages/desktop/README.md`](https://github.com/Ark0N/Codeman/blob/master/packages/desktop/README.md).

## Installing an agent CLI

Codeman drives CLIs, it does not bundle them. Install at least one:

| CLI             | Install                                                            | Notes                                                                      |
| --------------- | ------------------------------------------------------------------ | -------------------------------------------------------------------------- |
| **Claude Code** | `npm i -g @anthropic-ai/claude-code`                               | The primary target. Some Codeman features are Claude-only: see [Agent CLIs](Agent-CLIs). |
| **OpenCode**    | See [opencode.ai](https://opencode.ai)                             |                                                                            |
| **Codex**       | See [developers.openai.com/codex/cli](https://developers.openai.com/codex/cli) |                                                                |
| **Antigravity** | See [antigravity.google](https://antigravity.google)               | Google's successor to the consumer Gemini CLI.                             |
| **Gemini CLI**  | See [github.com/google-gemini/gemini-cli](https://github.com/google-gemini/gemini-cli) | Enterprise only since Google's June 2026 consumer cutover.  |
| **Pi**          | See [pi.dev](https://pi.dev)                                       | No permission prompts and no sandbox by design. Read [Agent CLIs](Agent-CLIs) before using it on a repo you care about. |
| **Grok Build**  | `curl -fsSL https://x.ai/cli/install.sh \| bash`                   | xAI. Lands in `~/.grok/bin`; `grok login --device-auth` for headless hosts.  |
| **DeepSeek Harness** | `npm i -g @deepseek-ai/dsh pnpm`, then a terminal profile      | The npm package is only a launcher. Codeman's Run menu installs the community terminal profile for you. See [Agent CLIs](Agent-CLIs). |
| **OMP**         | `curl -fsSL https://omp.sh/install \| sh`                          | Oh My Pi. Run it once by hand to finish its own onboarding.                |
| **jcode**       | `curl -fsSL https://jcode.sh/install \| bash`                      | Run it once by hand to finish (or skip) its onboarding wizard.             |

Log each CLI in once, by hand, before pointing Codeman at it. Codeman never collects or
stores your CLI credentials.

## Verify the install

```bash
codeman doctor          # checks Node, tmux, the agent CLIs, document converters
codeman --version
codeman web             # then open http://localhost:3000
```

`codeman doctor --json` gives machine-readable output, and `--category core` narrows it to
the things a session cannot start without.

If the dashboard loads and **+ New Session** opens, you are done. Continue to
[Quick Start](Quick-Start).

## Where things live

| Path                    | What                                                                                             |
| ----------------------- | ------------------------------------------------------------------------------------------------ |
| `~/.codeman/app`        | The installed code (installer route only).                                                        |
| `~/.codeman/runtime`    | Node.js and tmux, when the installer downloaded them instead of using system packages ([no administrator rights](#without-administrator-rights)). |
| `~/.codeman/`           | All state: `state.json`, settings, session history, push keys, TLS certs. See [Core Concepts](Core-Concepts). |
| `~/codeman-cases/`      | Cases created from scratch. Linked cases stay wherever they already are.                          |
| `~/.codeman/web.log`    | Log for a detached (`-d`) server.                                                                 |

Everything is under your home directory, and nothing needs root.

## Keeping it running

A bare `codeman web` dies with the shell that started it. Two ways to outlive that:

```bash
codeman web -d          # detached; --status and --stop manage it
codeman service install # systemd user unit or macOS LaunchAgent; survives reboots
```

Full detail, including logs and the self-updater, is in
[Running As A Service](Running-As-A-Service).

## Updating

| Install route | How to update                                                     |
| ------------- | ----------------------------------------------------------------- |
| Installer     | Re-run the one-liner, or **App Settings → System → Updates** in the UI. |
| Installer, without git | Re-run the one-liner. The in-app updater says so instead of offering an update. |
| npm           | `npm update -g aicodeman`                                          |
| git clone     | `git pull && npm install && npm run build`, then restart.          |
| Docker Compose | `git pull`, then re-run `Start-Codeman.sh`. The in-app updater works too, and refuses a release that changes the container definition until you re-run the script. |

The in-app updater covers git-clone installs supervised by systemd or launchd. It restarts
the process that is running it, so the actual work happens in a detached script and the
browser polls across the restart. Progress appears in the UI.

## Uninstalling

```bash
install.sh uninstall            # installer route
npm uninstall -g aicodeman      # npm route
```

The installer route asks before it removes `~/.codeman/runtime` (the Node.js and tmux it
downloaded, if any), and keeps it by default when you installed CLIs there with
`npm install -g`. That folder is inside `~/.codeman/`, so saying yes to the data directory
question that follows removes it even if you kept it a step earlier, and the question says
so. By default neither route removes `~/.codeman/` or `~/codeman-cases/`. Delete those by hand
if you want the state and your case folders gone as well, and check `~/codeman-cases/` first: linked cases
point at directories you already had, but cases created from scratch have their only copy
there.

Running tmux sessions are not killed by an uninstall. `tmux -L codeman kill-server` ends
them.

## Windows (WSL)

```powershell
wsl bash -c "curl -fsSL https://getcodeman.com/install | bash"
```

Codeman requires tmux, so Windows runs it inside
[WSL2](https://learn.microsoft.com/en-us/windows/wsl/install). If you do not have WSL yet:
run `wsl --install` in an admin PowerShell, reboot, open Ubuntu, and install your agent CLI
*inside* WSL. `http://localhost:3000` then works from your Windows browser.

Work inside the Linux filesystem (`~/project`), not `/mnt/c/...`. Filesystem watching and
git are both dramatically slower across the Windows mount, and agents notice.

## macOS notes

**`Error: posix_spawnp failed.` on every session start.** node-pty publishes its macOS
`spawn-helper` without the executable bit, and macOS launches every PTY through it. Codeman
detects this and repairs it automatically on the first failure. If you hit it on a clone
install and want to fix it by hand:

```bash
npm run fix:node-pty
```

This is a `chmod`, not a rebuild. Look in `prebuilds/darwin-<arch>/`, not
`build/Release/`, which does not exist on macOS. Linux cannot reproduce this.

**launchd and PATH.** A LaunchAgent gets `/usr/bin:/bin:/usr/sbin:/sbin`, which finds
neither a Homebrew or nvm `node` nor `tmux` or `claude`. `codeman service install` bakes
your current PATH into the unit for exactly this reason, so prefer it over a hand-written
plist.

## Gotchas

- **`tmux: command not found` after a successful install.** The installer asks before
  installing packages, and a declined prompt is a valid answer it remembers. Install tmux
  and re-run.
- **Port 3000 in use.** `codeman web --port 8080`, or set `CODEMAN_PORT`.
- **Two Codemans on one machine.** The data directory and the tmux socket are both process
  wide, so a second instance discovers and attaches the first one's live sessions. Give each
  a distinct `CODEMAN_INSTANCE` before starting a second. See [Core Concepts](Core-Concepts).
- **The dashboard is not reachable from your phone.** That is the default, not a fault. The
  server binds `127.0.0.1`. See [Remote Access](Remote-Access).

## Read next

- [Quick Start](Quick-Start) - your first working session.
- [Agent CLIs](Agent-CLIs) - picking and setting up a run mode.
- [Remote Access](Remote-Access) - reaching it from another device.
- [Troubleshooting](Troubleshooting) - when the above did not go as written.
