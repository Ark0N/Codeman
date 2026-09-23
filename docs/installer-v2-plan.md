# Installer v2: three questions, then a URL you can open on your phone (Plan)

Status: **Phase 1 IMPLEMENTED (2026-09-20)**, phases 2 and 3 open. It builds on
`docs/tailscale-installer-plan.md` (implemented 2026-08-04), which made Tailscale a
guided option; this round makes it the thing the install ENDS on, and makes the whole
installer shorter to sit through. Owner decisions taken before implementation: rename
is opt-in and **defaults to no everywhere** (the machine name is used for other things);
the URL keeps the node name unless asked; `codeman-<hostname>` is the suggested name;
sub-path is the default for an occupied `:443`.

Verification record for phase 1 (all on the maintainer's box, 2026-09-20):

- `test/install-sh-invariants.test.ts` (28 tests, incl. the new Tailscale safety pins)
  and the detection-parity test pass; `bash -n` passes.
- Every new decision function driven with stubbed tailscale state under **bash 5.2 and
  bash 3.2** (the `bash:3.2` container CI uses): flags, the launch default, the serve
  shape for free / ours / occupied `:443` (all four answers plus the non-interactive
  default), the three serve commands, the rename question (Enter keeps the name; `--yes`
  and non-interactive never rename; `codeman-*` nodes are skipped; `--name` is
  sanitized), `run_step` success/failure/stdin, the unit round-trip of
  `CODEMAN_BASE_URL`/`CODEMAN_PORT`/an escaped password, and the done screen.
- A full non-interactive install into a sandboxed `HOME` with `CODEMAN_TAILSCALE=1`:
  preflight summary, kept the existing prod mapping (no serve mutation), clone 2 s,
  `npm install` 18 s, build 23 s, symlink, done screen; `install.sh status` on a pty
  renders the QR code. Nothing on the real system changed.
- **Sub-path mode end to end over the real tailnet**: an isolated Codeman
  (`CODEMAN_INSTANCE`, port 3999, `--base-url /codeman`) behind
  `tailscale serve --https=8445 --set-path /codeman 3999` answered `/codeman/api/status`,
  `/codeman/` (with `<base href="/codeman/">` and `__CODEMAN_BASE__="/codeman"`), the
  hashed CSS/JS, `/codeman` without a slash, and the SSE stream; mapping and server
  removed afterwards. **Correction to section 2**: serve STRIPS the mount prefix
  before proxying (a direct `/codeman/api/status` on the server is 404 while the same
  path through serve is 200). That is fine because Codeman's ingress tolerates
  unprefixed requests; `--base-url` is needed for the URLs Codeman EMITS, not for
  what it receives.
- Not yet exercised on a fresh machine (unchanged from the previous plan): Tailscale
  absent / logged out / HTTPS toggle off, the rename against a real node (the
  off-rename-re-add order is implemented but only unit-driven), macOS, uninstall. The
  Mac mini and a throwaway VM are the venues; see section 8.
- **Review fixes (2026-09-21)**, from the two reviews on PR #460 (DeepSeek Harness, then
  Claude): the done screen's Start line is composed from every non-default value
  (`start_command_hint`, shared with the exec branch as `export_bind_env`), so "do not
  start" under a sub-path or a custom port no longer prints a bare `codeman web`; the
  `--lan`/`--tailscale`/env preset paths keep an existing password instead of rewriting
  the unit open; `--password`/`--port` flip `RECONFIGURE` so they reach the unit;
  `install.sh name` re-syncs the unit's base URL after a rename; the sudo keepalive is
  ended before the `exec` into the foreground server; Ctrl+C in the HTTPS-toggle poll
  skips Tailscale instead of killing the run; `uninstall` asks before removing a
  LaunchDaemon it never wrote; a foreign LaunchDaemon gets a restart hint and the done
  screen stops claiming the new build is running; the preflight summary reads the
  Tailscale state without node; the LAN security notice uses the configured port; a
  bare re-run ends on the done screen; a build failure after a rename names the
  `install.sh tailscale` recovery; `TS_JOINED_HERE` is gone.

Goal, in one sentence: a user runs the one-liner, answers at most three questions, walks
away during the build, and comes back to `https://<name>.<tailnet>.ts.net` printed with a
QR code, already answering, on every device in their tailnet. That is exactly the
maintainer's own production setup (`tnode.tailf80371.ts.net` fronting `127.0.0.1:3000`),
and the installer should produce it without the user knowing what `tailscale serve` is.

## 1. Where the installer is today

Facts from reading `install.sh` (2886 lines, 19 `prompt_yes_no` sites) and the live
Tailscale state on the maintainer's box (tailscale 1.102.2, user-owned node, MagicDNS +
HTTPS certs on, serve mapping `443 -> https+insecure://localhost:3000`).

**The order is backwards for a human.** The flow is: detect -> ask about git -> ask about
node -> ask about tmux -> ask about build tools -> AI CLI menu -> ask about cloudflared ->
clone -> `npm install` -> build (minutes) -> **then** the network-access question -> the
Tailscale sub-steps (install? login URL, sudo for operator, admin-console toggle loop) ->
the launch menu (no default; a bare Enter re-prompts) -> tunnel-service question. A fresh
Ubuntu server taking the Tailscale route answers roughly ten prompts plus two to four sudo
password prompts, split around a multi-minute build. The user cannot walk away at any
point, and the question that matters most (how do I reach it) comes last.

**The Tailscale flow works but was never exercised on a fresh machine.** The previous
plan's manual matrix still lists items 1-4, 7 and 10-12 (Tailscale absent, logged out,
HTTPS toggle off, port 443 occupied, macOS, uninstall, phone PWA) as untested. The
maintainer's own verification was the idempotent "kept as-is" path.

**The URL is the machine's name, full stop.** `setup_tailscale_serve` derives it from
`.Self.DNSName`, and nothing lets the user influence it. A second Codeman on the same
tailnet is `macminis-mac-mini.tailf80371.ts.net`, which tells you nothing about Codeman.

**Port 443 taken means give up or clobber.** If another app already owns the root of
`:443`, the only offer is "replace it?" (default no), and declining falls back to
local-only. Codeman already supports running under a sub-path (`--base-url`), and
Tailscale serve supports mounting a path (`--set-path`), so there is a third answer nobody
is offered.

**The result is invisible afterwards.** Once the terminal scrolls away, nothing in the app
or the CLI tells the user their Tailscale URL again. `codeman doctor` does not probe
Tailscale; App Settings -> Remote access shows only the Cloudflare tunnel.

**Two service writers exist.** `install.sh` carries its own plist/unit generator (~180
lines) next to `codeman service install` (`src/service-installer.ts`). They agree on the
job name by design, but the bash copy is the one that writes `CODEMAN_PASSWORD` into the
unit, so they cannot simply be merged. Left as-is in this plan (see section 9).

## 2. What Tailscale makes possible for the name (researched 2026-09-20)

| Option | Resulting URL | What it needs | Side effects | Verdict |
| ------ | ------------- | ------------- | ------------ | ------- |
| **A. Node name** (today) | `https://tnode.tailf80371.ts.net` | `tailscale serve --bg 3000` | none | **Default.** Zero admin-console work, matches the maintainer's prod. |
| **B. Rename the node** | `https://codeman-tnode.tailf80371.ts.net` | `tailscale set --hostname codeman-<host>` (operator or root) | Renames the machine tailnet-wide: ssh targets, other serve URLs, the admin console entry. Tailscale de-dups a clash as `-1`. The cert follows the new name. | **Opt-in, default NO everywhere** (owner decision 2026-09-20: the machine is used for other things, so a bare Enter never renames it). The proposal was YES when the installer itself had just joined the tailnet; rejected. |
| **C. Tailscale Service** | `https://codeman.tailf80371.ts.net` | tailscale >= 1.86 on the host; the host must have a **tag-based identity** ("You cannot use a device authenticated with a user account as a Service host"); the service is defined in the admin console first; the host is then approved there (or via `autoApprovers.services`). Public beta since 2025-10-28, all plans. | Re-authenticating a personal machine as a tagged node changes its identity (SSH ACLs, user attribution). Known daemon quirk: approval is not picked up until `serve clear` + re-advertise (tailscale/tailscale#18821). | **Detect and hint only** in this round. The maintainer's own node has `Self.Tags: null`, so it could not host one without re-tagging. Worth a real flow once someone with a tagged fleet asks. |
| **D. Sub-path** | `https://tnode.tailf80371.ts.net/codeman` | `tailscale serve --bg --set-path /codeman 3000` plus `--base-url /codeman` on the server | Codeman runs under a prefix. Hooks are unaffected (they hit the raw port with no prefix, which `rewriteUrl` already tolerates). Serve forwards the prefix unchanged, which is exactly the shape `--base-url` was built for. | **The answer when `:443` root is already taken.** Replaces today's replace-or-nothing prompt. |
| **E. Second port** | `https://tnode.tailf80371.ts.net:8443` | `tailscale serve --bg --https=8443 3000` | Port in the URL; the beta-preview recipe already uses this. | Fallback when the user rejects D. |
| Funnel (public internet) | `https://tnode.tailf80371.ts.net` from anywhere | `tailscale funnel` | Public exposure; different risk class. | **Out of scope**, as before. Docs only, with the password warning. |

Sources: Tailscale Services docs (`tailscale.com/docs/features/tailscale-services`), the
Services beta announcement (`tailscale.com/blog/services-beta`), machine names
(`tailscale.com/kb/1098/machine-names`), the serve CLI reference
(`tailscale.com/docs/reference/tailscale-cli/serve`), the macOS variants page
(`tailscale.com/docs/concepts/macos-variants`), and `tailscale serve --help` on 1.102.2
(which lists `--service`, `--set-path`, `--yes`, `advertise`, `get-config`/`set-config`).

**Trap for option B (verify on the Mac mini before shipping):** the serve config is keyed
by `host:port` using the DNS name at configuration time (`"Web": {"tnode.tailf80371.ts.net:443": ...}`
in `serve status --json`). Renaming a node after serve is configured most likely orphans that
entry: the handler lookup uses the current name and never matches the old key, and the only
tool that removes a stale key is `serve reset`, which this installer must never run. So the
order is **rename first, then configure serve** on a fresh install, and on a retrofit
(`install.sh name`) **turn our mapping off, rename, wait for `.Self.DNSName` to change,
re-add**.

## 3. Target UX

### 3.1 Three questions, then walk away

```
  Codeman installer

  Found:      git, Node 22.14, tmux 3.4, build tools     Missing: nothing
  AI CLIs:    Claude Code (~/.local/bin/claude)
  Tailscale:  connected as tnode (tailf80371.ts.net)
  Existing:   none

  1/3  How should the dashboard be reachable?
         1) Tailscale  https://tnode.tailf80371.ts.net  (recommended, already connected)
         2) Any device on your network (0.0.0.0, password required)
         3) This machine only (127.0.0.1)
       Choose [1/2/3] (default 1):

  2/3  Name this machine "codeman-tnode" on your tailnet? [y/N]
       (only shown for option 1; default no, always)

  3/3  Run Codeman as a background service that starts on boot? [Y/n]

  Installing… this takes a few minutes. You can leave this running.
    ✓ dependencies    ✓ clone    ✓ build (2m 41s)    ✓ service    ✓ tailscale serve
```

Rules that make this work:

- **Every step that needs a human runs BEFORE the build.** The dependency consent, the
  AI CLI menu, the Tailscale install consent, the `tailscale up` login URL, the operator
  grant, and the tailnet HTTPS toggle all move into the question phase. The build, the
  service, `tailscale serve` and the verification are unattended.
- **One consent for all missing system packages.** "Install git, Node 22 and build tools
  now? [Y/n]" replaces four separate prompts. Each package still runs its own
  distro-specific installer.
- **One sudo prompt.** When anything needs root (packages, the Tailscale installer,
  `tailscale up`, the operator grant), the installer says so once, runs `sudo -v`, and keeps
  the timestamp alive in a background loop until it exits. macOS needs no sudo for the
  Tailscale GUI-app CLI and the pattern still holds for Homebrew packages.
- **Service is the default.** Enter on the last question installs the service; "run in
  this terminal" and "don't start" stay reachable by answering, and by flag.
- **The cloudflared question is gone from the main flow.** It is optional, defaults to
  no, and has an in-app toggle (App Settings -> Remote access). The done screen mentions it
  only when `cloudflared` is already installed. The Linux tunnel-service prompt goes with it.
- **The HTTPS-certificates toggle no longer asks "re-check now?"** The installer prints the
  admin URL, opens it in a browser when one is available (`xdg-open` / `open`, never on a
  headless box), and polls `tailscale status --json` every 5 s for up to 5 minutes. Ctrl+C or
  the timeout falls back exactly as today.
- **Progress, not silence.** `npm install` and `npm run build` run behind one line each
  with elapsed time; their output goes to `~/.codeman/install.log` and is printed only on
  failure, with the exact retry command.

### 3.2 The done screen

One block, the URL first, a QR code the phone can scan, and nothing the user does not need
right now.

```
  ✓ Codeman 1.31.0 is running

    Your tailnet:    https://codeman-tnode.tailf80371.ts.net    (HTTPS, any of your devices)
    This machine:    http://localhost:3000

    ▄▄▄▄▄▄▄ ▄ ▄▄  ▄▄▄▄▄▄▄
    █ ▄▄▄ █ ▄▄▀ ▄ █ ▄▄▄ █      scan with your phone
    █ ███ █ ███▀▀ █ ███ █
    █▄▄▄▄▄█ █ ▄ █ █▄▄▄▄▄█

    Manage   systemctl --user restart codeman-web  ·  journalctl --user -u codeman-web -f
    Update   re-run the install line, or App Settings → System → Updates
    Docs     https://github.com/Ark0N/Codeman/wiki

  Security: Codeman binds 127.0.0.1. Tailscale authenticates every device before a
  packet reaches it. Details: docs/security-architecture.md
```

The QR comes from the `qrcode` package Codeman already depends on
(`node -e "require('qrcode').toString(url, {type:'terminal', small:true}, …)"` from
`$INSTALL_DIR`, verified locally: 17 rows by 45 columns). Skipped when the terminal has no
color support or fewer than 50 columns. The QR encodes the plain URL, not an auth token:
the tailnet is the login.

### 3.3 Express mode and flags

Env vars stay (`CODEMAN_TAILSCALE=1`, `CODEMAN_HOST`, `CODEMAN_PASSWORD`,
`CODEMAN_NONINTERACTIVE=1`, `CODEMAN_PORT`). Flags are added because they are
discoverable from the one-liner and pipe through `bash -s --`:

```bash
curl -fsSL https://getcodeman.com/install | bash -s -- --tailscale --service
curl -fsSL https://getcodeman.com/install | bash -s -- --lan --password 'x' --service
curl -fsSL https://getcodeman.com/install | bash -s -- --local --run
curl -fsSL https://getcodeman.com/install | bash -s -- --tailscale --name codeman-build --yes
```

| Flag | Meaning |
| ---- | ------- |
| `--tailscale` / `--lan` / `--local` | Answer 1/3 (same semantics as `CODEMAN_TAILSCALE=1`, `CODEMAN_HOST=0.0.0.0`, `CODEMAN_HOST=127.0.0.1`) |
| `--name <n>` / `--no-rename` | Answer 2/3: rename the node to `<n>`, or never ask |
| `--service` / `--run` / `--no-start` | Answer 3/3 |
| `--yes` | Accept every default, still prompt for a login URL (a human must open it) |
| `--password <p>` | Same as `CODEMAN_PASSWORD` |
| `--port <n>` | Same as `CODEMAN_PORT`; the serve target follows it |

`--yes` differs from `CODEMAN_NONINTERACTIVE=1`: it is the interactive user saying "I trust
the defaults", so it may install software and may wait on a login URL. Non-interactive stays
the CI contract and never installs Tailscale.

## 4. The Tailscale flow, v2

The state machine from the previous plan stays; these are the changes.

1. **Preflight, before the build** (`tailscale_preflight`): installed? -> install
   (Linux: official script; macOS: brew cask, else download link and wait). Logged in? ->
   `tailscale up` with the URL printed prominently and a 5-minute poll. Operator (Linux):
   grant once under the single sudo session. HTTPS certs: poll instead of ask (Ctrl+C
   during the poll skips Tailscale for this run rather than ending the installer). The
   rename default does not depend on whether this run performed the login (decided NO
   everywhere), so nothing records it.
2. **Name** (`tailscale_choose_name`, question 2/3): shown only on the Tailscale route.
   Default `codeman-<oshostname>` sanitized to `[a-z0-9-]`, max 63. Applied with
   `ts_cmd_serve set --hostname`, then poll `.Self.DNSName` until it carries the new name
   (up to 60 s). Order matters: this runs before any serve mutation (section 2 trap).
   Declining keeps the node name. On a re-run against a node already named `codeman-*`,
   the question is skipped.
3. **Serve, after the service is up** (`setup_tailscale_serve`): unchanged idempotent
   "kept as-is" path first. When `:443` root belongs to another target, the new prompt is:

   ```
   tailscale serve already sends https://tnode.tailf80371.ts.net to port 8080.
     1) Add Codeman under a path:  https://tnode.tailf80371.ts.net/codeman   (default)
     2) Use another port:          https://tnode.tailf80371.ts.net:8443
     3) Replace the existing mapping with Codeman
     4) Skip Tailscale for now
   ```

   Option 1 writes `--base-url /codeman` into the service unit (it is a `WebLaunchOptions`
   field already, and `buildWebArgs` carries it) and runs
   `tailscale serve --bg --set-path /codeman <port>`. Option 2 runs `--https=8443`.
   `detect_tailscale_serve_url` learns to recognize all three shapes (root, path, port) so
   uninstall, the security notice and the re-run default keep working.
4. **Warm the certificate.** Right after serve is configured, fire one background
   `curl -sk https://<url>/api/status` so Let's Encrypt issuance overlaps the rest of the
   install instead of adding 30 s to the verify step.
5. **Verify** as today (200 or 401 on `/api/status`), with the path-aware URL.
6. **Services hint** (option C): when `.Self.Tags` is non-empty and `serve --help`
   lists `--service`, the done screen adds one line: "This is a tagged node, so it can also
   host `https://codeman.<tailnet>.ts.net` as a Tailscale Service: see Remote Access in the
   wiki." No flow, no prompt.
7. **macOS**: the App Store and Standalone variants cannot run before login, so a
   LaunchAgent plus serve only comes back after someone logs in. The done screen says so on
   macOS. The Mac mini (`arbbot`, headless, system LaunchDaemon) is the reference for the
   "headless Mac" caveat, and `install.sh` must keep refusing to replace a LaunchDaemon it
   did not write (today it removes one; that is a bug for the Mac mini and is fixed here:
   detect `UserName` in the daemon plist and leave it alone with a message).
8. **Uninstall** additionally offers to restore the original node name when this installer
   renamed it (the original is recorded in `~/.codeman/install.json`, the one marker file
   this feature adds, because tailscaled does not remember previous names).
9. **Subcommands**: `install.sh tailscale` (unchanged purpose, now runs the v2 flow),
   `install.sh name [<n>]` (rename with the off/rename/re-add dance), `install.sh status`
   (prints the done screen again, URL and QR included, for the "what was my URL" moment).

## 5. In-app: the URL stays discoverable

Small, read-only, and the first server-side code this feature has ever needed.

- **`GET /api/system/remote-access`** returns
  `{ tailscale: { installed, connected, dnsName, url, mode: 'root'|'path'|'port'|null } }`
  by running `tailscale status --json` and `tailscale serve status --json` through
  `execFile` with the existing exec timeout, cached 30 s, resolved through the same
  `get_tailscale_path` search as the installer (PATH, then the macOS app bundle), and a
  no-op under `VITEST` like every other IO probe. Never mutates serve config.
- **App Settings -> Remote access** gains a **Tailscale** row above the Cloudflare toggle:
  the URL as a copy chip, a QR button reusing `showTunnelQR`'s modal, and when nothing is
  configured a one-line hint with `bash ~/.codeman/app/install.sh tailscale`. The welcome
  screen's "open on your phone" affordance shows the same QR.
- **`codeman doctor`** grows a `tailscale` entry under `other` in
  `config/dependency-registry.ts`: installed, connected, serving Codeman (URL). Pure
  engine, injectable probe host, like the existing rows.
- No new SSE event, no settings key, no state.json change.

## 6. Security posture

Nothing widens. The bind stays loopback; the tailnet is the authentication boundary;
`.ts.net` is already in `DEFAULT_TRUSTED_HOST_SUFFIXES`. New surfaces are read-only
probes. `install.sh` still never runs `tailscale serve reset`, still touches only the
mapping it created, and gains one more never: it never advertises a Tailscale Service or
runs `tailscale funnel`. The sudo keep-alive loop is killed by the existing `cleanup` trap.
The rename records the previous name locally and offers the reversal at uninstall.

## 7. Implementation inventory

| File | Change |
| ---- | ------ |
| `install.sh` | New `parse_flags`, `preflight_summary`, `ask_everything` (the three questions), `sudo_session`, `run_step` (spinner + log), `tailscale_preflight`, `tailscale_choose_name`, `tailscale_rename_node`, `print_done_screen`, `print_qr`, `status` subcommand, `name` subcommand. Modified: `main` (reordered into ask -> work -> done), `choose_network_binding` (question 1/3, same defaults), `setup_tailscale_serve` (path/port options), `detect_tailscale_serve_url` (three shapes), `setup_systemd_service`/`setup_launchd_service` (`--base-url`, LaunchDaemon guard), `uninstall` (rename reversal), header docs (flags). Removed from the main flow: the cloudflared prompt, the tunnel-service prompt. bash 3.2 rules unchanged. |
| `src/web/routes/system-routes.ts` | `GET /api/system/remote-access` |
| `src/tailscale-status.ts` (new) | Pure parser for the two JSON shapes + the IO wrapper; unit-tested against captured `serve status --json` fixtures (root, path, port, foreign target, none) |
| `src/config/dependency-registry.ts`, `src/utils/dependency-checker.ts` | `tailscale` doctor row |
| `src/web/public/index.html`, `settings-ui.js`, `panels-ui.js` | Tailscale row + QR, welcome-screen QR |
| `test/install-sh-invariants.test.ts` | Extend: flags documented in the header, no `serve reset`, no `funnel`, no `--service` advertise, every serve mutation goes through `ts_cmd_serve`, rename happens before serve in `main` (static order check) |
| `.github/workflows/ci.yml` | The bash 3.2 step additionally sources the script with stubbed `ts_cmd`/`ts_cmd_serve`/`read_reply` and drives `ask_everything` through all three answers and the 443-occupied menu |
| `test/tailscale-status.test.ts`, `test/routes/system-routes-remote-access.test.ts` | Parser + route |
| Docs | README install + remote-access sections, `docs/wiki/Installation.md`, `Remote-Access.md` (naming options table, Services caveat, path/port variants), `Mobile-Guide.md`, `Running-As-A-Service.md` (macOS login caveat), `FAQ.md`, `docs/security-architecture.md` §A, CLAUDE.md Scripts & Tunnel paragraph, `docs/tailscale-installer-plan.md` gets a pointer here. getcodeman.com copy lives outside the repo (maintainer handbook). |

Changeset: `minor` (new flags, new subcommands, new API route).

## 8. Test plan

Automated (the gate): the static invariants above, the bash 3.2 container drive of the
question phase, the JSON parser fixtures, the route test.

Manual matrix, on a fresh Ubuntu 24 VM and on the Mac mini, since the previous plan's
items never ran on a fresh machine:

1. Tailscale absent, declined -> local-only, done screen shows the retrofit command.
2. Tailscale absent, accepted -> install, login URL, operator, certs toggle polled, rename
   question shown (default no), service, serve, URL verified, QR scans on a phone, PWA installs.
3. Tailscale present and logged in on a pre-existing node -> rename default NO, URL is the
   node name, `serve status` gains exactly one entry.
4. `:443` root occupied -> path option -> `https://<node>/codeman` answers, hooks still
   fire (raw port), `install.sh status` prints the path URL.
5. Rename on a node that already has our serve mapping (`install.sh name`) -> off, rename,
   re-add, `serve status` has no stale key.
6. Re-run the one-liner -> quiet update, binding and name preserved, no prompts.
7. `--yes` end to end; `CODEMAN_NONINTERACTIVE=1` end to end (no software installed).
8. Uninstall -> mapping removed, other mappings intact, rename reversal offered.
9. Mac mini: LaunchDaemon left alone with the message; done screen carries the login caveat.

## 9. Phasing and open decisions

**Phase 1 (this round):** the reorder, the three questions, one consent + one sudo, flags,
the done screen with QR, Tailscale preflight-before-build, the path/port answer for an
occupied 443, the rename step, `status` and `name` subcommands, docs.

**Phase 2:** the in-app Tailscale row + QR, `codeman doctor` row, the `remote-access`
route. Independent of phase 1 and useful on its own for existing installs.

**Phase 3 (optional):** replace the bash service writers with `codeman service install`
once that command can carry `CODEMAN_PASSWORD` behind an explicit flag; and a Tailscale
Services flow if a tagged-fleet user asks for `codeman.<tailnet>.ts.net`.

Decisions for the maintainer:

1. **Rename default.** Decided 2026-09-20: always NO; the yes answer, `--name` and
   `install.sh name` are the ways in. (The proposal was YES only when this run had joined
   the tailnet, NO otherwise; rejected because the host is used for other things.)
2. **Name pattern.** `codeman-<hostname>` (proposed; unique per machine, and two Codemans
   on one tailnet stay distinguishable) versus plain `codeman` (nicer once, collides on the
   second install, Tailscale silently appends `-1`).
3. **Path versus port** as the default answer for an occupied 443. Proposed: path, because
   the URL has no port and `--base-url` already exists for exactly this proxy shape.
4. **Whether Phase 2 ships in the same release.** It is the part that helps people who
   installed months ago.
