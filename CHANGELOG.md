# aicodeman

## 1.26.2

### Patch Changes

- Terminal rendering fixes, a Ctrl+V paste fix, an iOS Safari toolbar fix, a 2GB download cap, and a Blur entrance animation.

  ### Terminal rendering

  Three independent causes behind #398, where opening a session rendered a frame with characters spliced into each other and left the caret on the composer's border instead of its input line, until the CLI next wrote anything:
  - **The full-history replay now keeps row alignment** (#395). The linear capture path never restored the cursor, so every cursor-relative update the CLI sent afterwards was measured from the status line instead of the pane's real position, and four transforms that each can delete a line (trailing-blank stripping, redraw-bloat stripping, the pre-banner trim, leading-whitespace removal) shifted the frame out from under it. The full-history path now appends the pane's own cursor position and keeps every row, so row N of the reply is row N of the pane. The visible-frame and tail paths are untouched.
  - **The first fit waits for the terminal font** (#396). A cell measured against a fallback font gives the wrong column and row count, so the pane was sized twice and the CLI repainted for a shape that no longer matched the frame on screen. `selectSession` now holds for the font before measuring, bounded at 2s so a font that never arrives cannot strand a session, and it ends by re-measuring explicitly — `FitAddon.proposeDimensions()` divides by a cached cell size and nothing in it listens for font loading, so waiting alone would still divide by the fallback cell.
  - **A detached session's own window owns its pane size** (#397). Popping a session out left both windows sizing one PTY, and the dashboard's terminal is narrower than the popup because the session rail takes width the popup does not have, so the CLI drew frames that fit neither. The dashboard now withholds the resize send (never the local reflow) for a session showing in its own window, and takes sizing back on redock.

  ### Other fixes
  - **Ctrl+V no longer pastes twice** (#394). One keypress delivered two paste events to the clipboard trap: Firefox dispatches a trusted event for `document.execCommand('paste')` and then returns `false`, and the key's own default action fires another, because xterm's custom key handler returns false without cancelling the keydown. Right-click → Paste has no keydown, which is why only the keyboard duplicated. The trap now consumes exactly one event per keypress.
  - **iOS Safari: the phone toolbar sits on Safari's bottom bar** (#391, #392). The toolbar was lifted by `100vh - --app-height`, which on iPhone Safari measures the bar's collapsible height rather than an overlap — fixed elements there already stop above the bar — leaving an empty ~40px band and padding the terminal by the same amount. The lift is now `--chrome-overlap` (`innerHeight` minus the visual viewport height), which is 0 on iPhone Safari and equals the real overlap anywhere fixed elements do land behind the chrome.

  ### Downloads

  `file-raw`, the attachment `/raw` route and `GET /api/download` now cap at **2GB** instead of 50MB, configurable via `CODEMAN_MAX_DOWNLOAD_BYTES` (`0` = unlimited). The old cap was memory protection for a `readFile()` that no longer exists: those bodies stream and answer `Range` requests, so size costs a read stream rather than RSS (measured: a 600MB download moved peak RSS by ~37MB), and all the cap still did was refuse legitimate downloads of build artifacts, videos and archives. `/api/download` was the last route that really did buffer the whole file; it now streams, advertises `Accept-Ranges` and is resumable. Refusals move from `400` to `413`, the correct status for the case.

  ### Blur entrance animation

  A new opt-in `Blur` style on all four entrance surfaces (tabs, agent windows, the terminal pane, connection lines), plus a `Soft focus` theme that sets all four: an iOS-style focus pull where the thing arrives out of focus and the blur fades off it as the opacity comes up. App Settings → Appearance → Entrance Animations, or mix per surface at `?animlab=1`. Entrance animations stay off by default, so an untouched install is unchanged.

  ### Maintainer tooling

  The PR bot now fails fast when the review model's budget is spent, instead of hanging a review for the full 40-minute timeout and burning its retry cap.

  ### Thanks
  - @irisitymichaelgrundberg for #394, #395, #396 and #397, and for the #398 investigation that separated three causes behind one symptom
  - @JDProfresh for reporting #391 and fixing it in #392

## 1.26.1

### Patch Changes

- Codex sessions no longer report idle for their entire life, and Codex conversations now appear in Past Sessions and can be resumed.

  **Per-CLI work detection (#385, irisitymichaelgrundberg).** The composer glyph and the working status line are now registry data (`capabilities.workDetect`) rather than Claude constants. Claude keeps its exact current pair, Codex declares `›` plus its `esc to interrupt` footer, and any CLI that declares neither falls back to Claude's, which is what every session used before. Work detection had been gated Claude-mode-only on the reasoning that an external CLI has no `❯`, which was true and still left every Codex session reporting `idle` from the moment it started. `workingLine` is config-supplied and its compiled pattern runs on the PTY hot path, so it goes through `compileVersionRegex()` in both the schema refine and the runtime compile: a nested quantifier there would backtrack on the event loop for the whole server. The Codex footer is matched case-insensitively on the E, so a future version capitalising it cannot make the fix silently inert.

  **Codex conversations in Past Sessions (#386, irisitymichaelgrundberg).** A bounded scanner reads codex's `~/.codex/sessions` rollout store, so the unified session list now merges three transcript stores rather than one (Claude's `~/.claude/projects`, omp's `~/.omp/agent/sessions`, codex's `~/.codex/sessions`). A scanned row carries a `resumeId`, the rollout's own thread id, which lets it resume through `codexConfig.resumeSessionId`; a live session never carries one, so a row without it stays a genuinely fresh session. Live and resumed Codex sessions fold into their rollout row through the existing alias map, including a `session_meta.originator` match for fresh panes, so a conversation never shows up twice. The phone overview carries `resumeId` through its own row projection, without which a tapped Codex past row started a fresh session on a thread already on disk.

  ### Thanks
  - @irisitymichaelgrundberg for both PRs (#385, #386), and for turning a full review round on #386 in a day.

## 1.26.0

### Minor Changes

- Tag the case directories agent workers create, and clean up what they leave behind.

  A long agent orchestration creates one case directory per worker, and deleting the
  sessions never removed them, so `~/codeman-cases` filled with scratch folders that
  looked exactly like real projects.
  - A case directory `POST /api/quick-start` **creates** for an agent-driven spawn now
    carries a `.codeman-agent-case.json` marker recording when it was made, by whom,
    from which session, and in which mode. Only the branch that creates the directory
    writes it, so a linked case, a cloned repo or any pre-existing path is never
    labelled, and deleting the marker file adopts a scratch case as a real one.
  - The label comes from the new `X-Codeman-Agent-Origin` header that the packaged agent
    skill sets on its shared curl invocation (preamble 1.22.0), or an `agentOrigin` body
    field, falling back to a resolved `parentSessionId` so workers spawned by an older
    skill copy are still labelled.
  - `GET /api/cases` publishes it as `agentCreated`, and the new read-only
    `GET /api/cases/agent-created` lists the scratch cases with `inUse` (a live session
    is still working in it) and `modifiedAt`.
  - Add Case -> Manage badges every agent-created case and adds a sticky **Clean up**
    entry point that names each directory in its confirmation and skips any case a
    running session is using. Removal still goes through `DELETE /api/cases/:name`.
  - The agent skill's per-session preamble cache (`~/.cache/codeman-agent-<id>.sh`) is
    now removed with the session and swept at boot. One was written per Claude session
    and nothing ever deleted them (236 orphans on a working machine); the sweep keeps
    every live session's file and only takes orphans older than seven days.

## 1.25.0

### Minor Changes

- Codeman can be mounted under a sub-path behind a reverse proxy (#381, @mtiller). `--base-url /codeman` (or `CODEMAN_BASE_URL`) makes the server strip the prefix on the way in, rebase redirects on the way out, inject `<base>` and `window.__CODEMAN_BASE__` into the shell, and route web-tab proxying and WebSocket upgrades under the mount, so one TLS name can front several apps. A root install is byte-identical to before. Applied on top: the crash-diag beacon stays under the mount (sendBeacon is not fetch, so the base-aware wrapper never saw it), the test suite strips `CODEMAN_BASE_URL`, and a wiring test boots a real server under a prefix.

  A case can attach to a container that is already running (#357, @dignfei). `DockerCase.owned:false` mirrors the remote-SSH attach contract: Codeman only execs into such a container, never creates, starts, stops, removes, pauses or commits it, with the refusal enforced at string-construction time so no caller bug can reach `docker stop`. The Add Case dialog gets an attach panel with a container picker, the run menu takes its mode availability from the CLIs actually present in the container, and adoption is admin-only in multi-user mode. Three gaps closed after review: export no longer pauses or commits an adopted container, a freshly linked owned case no longer hides every agent mode behind a probe of a container that does not exist yet, and multi-user gating is explicit.

  The Claude response viewer renders one message per model message (#369, @shenlvkang-collab). The reader used to fuse every assistant row between two human prompts into one card and never read the attachment rows that hold a prompt typed mid-turn; measured over 57 real transcripts it now shows 1,806 messages instead of 356 and recovers 162 absorbed user prompts, with the assistant text unchanged row for row.

  A Claude pane learns its live conversation from the CLI's own `UserPromptSubmit` hook (#367, @shenlvkang-collab). The conversation id used to be re-derived by correlating `~/.claude/history.jsonl` against a stamp only Codeman's own input path set, so a pane driven straight from tmux stayed pinned to its launch conversation forever. The hook reports the id first-hand, addressed by the pane's own `$CODEMAN_SESSION_ID`, and the chain of conversations is persisted so a restart re-pins the right one. The new `hook:prompt_submitted` SSE event is registered (158 = 158), and it lands in the run summary only when the conversation actually moved.

  The Add Case modal can be submitted from a phone again (#368, @shenlvkang-collab). Since 1.16.4 the layout below 860px hid the modal footer, which held the only Create/Clone/Link button. A header submit button now sits beside the close button, dims while a submit is pending, and a static test pins the contract so it cannot silently disappear again.

  The Link Existing case picker opens in the Codeman Cases directory instead of Home (#383, @opticon454). Under Docker the two are unrelated trees and Home holds nothing but dot directories, so the picker showed no cases at all. The fallback chain is now Current Folder, then Codeman Cases, then `/mnt/d`, then the first root.

  A PR review bot for the maintainer (`scripts/pr-bot/`, guide in `docs/pr-bot.md`). It reviews every open pull request in its own Codeman session inside a private clone and reports the verdict, ranked findings and a recommendation to Telegram with action buttons; merge, close, post-comment and approve-CI happen only from a confirmed tap. Maintainer tooling, not part of the server or the CLI.

  ### Thanks
  - @mtiller for the reverse-proxy base URL (#381).
  - @dignfei for attaching cases to running containers (#357).
  - @shenlvkang-collab for the response viewer fix (#369), the first-hand conversation hook (#367) and the phone Add Case fix (#368).
  - @opticon454 for the case picker default (#383).

## 1.24.7

### Patch Changes

- The web-tab proxy refuses link-local and cloud-metadata targets. Its Test probe, the proxy itself and the WebSocket relay accepted any http(s) host, so a saved dashboard URL could reach `169.254.169.254` (in decimal, hex, IPv6-mapped or DNS-name form) through a capability and no cookie. Loopback and RFC1918 addresses stay allowed on purpose, since a localhost Grafana is the feature; only link-local and the fixed cloud-metadata addresses are refused, at the schema, at every connect site, and through a DNS lookup hook that judges the resolved addresses, which is what closes DNS rebinding. Adds `undici` so the proxy runs its fetch through its own agent.

  Proxy capabilities are revoked on logout. `revokeOwner()` had shipped with no caller, so a leaked proxy URL stayed valid for as long as anything kept polling it. `POST /api/logout`, the admin forced logout and user deletion now revoke the capabilities they should, and proxied responses carry `Referrer-Policy: same-origin` with the upstream's own policy dropped, so a dashboard on a loose referrer policy cannot hand the capability to a third-party host it links to.

  The Docker Compose deployment updates itself from App Settings again (#373, @opticon454). The checkout Compose builds from is bind-mounted at `/opt/codeman`, so an update's `git checkout` and rebuild land on the host and survive container recreation; build artefacts live in named volumes so container-compiled native modules never enter the host checkout; the image keeps devDependencies and a build toolchain; and the restart is the server exiting under `restart: unless-stopped`. An in-place update applies code only, so the updater refuses a release that changes `server.Dockerfile` or `docker-compose.yaml`, or that adds keys to `.env.example` the user's `.env` has no value for (Compose interpolates an unset variable to the empty string and starts anyway), and points at `docker/Start-Codeman.sh` on the host instead. The four global agent CLIs in the image are pinned. A follow-up makes the final step fail safe: the server exits only when the Compose file declares `CODEMAN_RESTART_BY_EXIT=1` or the daemon confirms an auto-restart policy, and otherwise the build is staged for a manual restart, so a container nothing would restart is never taken down. Details in `docs/docker-self-update.md`.

  The test suite strips `CODEMAN_INSTANCE`, `CODEMAN_DATA_DIR` and `CODEMAN_TMUX_SOCKET` before any application module loads (#371, @opticon454), with a two-half test whose static half reads `test/setup.ts` so a dropped line fails everywhere. This replaces the throwaway data dir #356 had set for the same variable.

  ### Thanks
  - @opticon454 for the Compose self-update (#373) and the test isolation fix (#371).

## 1.24.6

### Patch Changes

- CLI backends are now a data-driven registry (#347, @opticon454). Every run mode (Claude Code, Terminal/Shell, OpenCode, Codex, Gemini, Antigravity, Pi, Grok, DeepSeek Harness and OMP) is a `CliEntry` in `src/config/cli-registry/`: binary discovery (search dirs, version and identity probes), the launch argv template, environment handling, the multi-user privileged-parameter and privileged-env-key clamps, the remote and Docker pane commands, and the capability flags the rest of the app reads instead of branching on a CLI's name. `~/.codeman/clis.json` can override any stock entry or add a custom CLI; it is read-only in this release, must be mode 0600, and every reason it was ignored is now logged once on first load (`docs/cli-registry.md`). Config never contains shell text: entries declare typed argv tokens, literals are validated at load time, and values resolve through patterns named in code. Registry data resolves at call time rather than at module import, so a CLI enabled while the server runs moves every surface at once, and a guard test fails the build if per-CLI-id branching reappears outside the stock catalog.

  This is an internal refactor. The spawn command every CLI receives is byte-identical to the previous hand-written builders, verified by pinned golden strings in the test suite and by diffing both implementations across 11,602 option combinations for all ten modes. Five small deliberate changes ride along: the in-container version probe derives the binary from the registry (`antigravity` runs `agy`), the remote version probe now covers Grok and DeepSeek, `codeman doctor`'s CLI rows are generated from the registry (Claude's install hint is the install command, five CLIs gain hints, the row order follows the catalog), OMP now requires tmux like its siblings instead of silently falling back to a direct PTY, and an OMP session's attach client now receives `COLORTERM=truecolor` like the other truecolor CLIs.

  Remote sessions are no longer auto-revived after a clean agent exit (#355, @timkjr). The reconnect watcher could not tell a transport drop from a Ctrl-C, Ctrl-D or `exit` inside the remote CLI, so a clean exit relaunched a fresh agent (OpenCode and OMP started a new conversation every time; Claude only looked fine because its `--resume` fallback masked it). The watcher now revives a dead pane only when the durable remote tmux session is verifiably still alive, via a `has-session` probe over ssh, and an unreachable host means do not revive. A follow-up classifies that probe by exit status, since `tmux has-session` prints nothing on success and reading its stdout had marked every live session as gone, forgets the cached answer whenever the pane is seen alive again so a stale result cannot revive a later clean exit, and caps the probe at one in flight per session.

  The test suite can no longer reach the production `~/.codeman` data dir (#356, @timkjr). `test/setup.ts` now points `CODEMAN_DATA_DIR` at a throwaway directory, which is the absolute override that bypasses the suite's temporary HOME when inherited from the shell, and every test that deletes a case tree goes through a containment gate that refuses paths outside the temporary HOME. A bare suite run had overwritten a real `remote-hosts.json` with a route test's fixture. The comments around it and CLAUDE.md's testing section now name that variable as the cause; `os.homedir()` itself does follow `$HOME`.

  ### Thanks
  - @opticon454 for the CLI registry (#347), the phased resubmission of #343, and the review rounds that hardened it.
  - @timkjr for the remote auto-revive fix (#355) and the test-isolation sweep (#356).

## 1.24.5

### Patch Changes

- Fable 5.1 is selectable in App Settings.

  `claude-fable-5-1` is in Claude Code's model catalog (display name "Fable 5.1", June 2026 knowledge cutoff), but the model picker only went up to Fable 5, so pinning it meant hand-editing a case's `.claude/settings.local.json`. It now appears as a card under **App Settings -> Models -> New Claude sessions**, and as an option in **Task routing** (Default for tasks, plus the Explore / Implement / Test / Review overrides).

  It is offered exactly the way Fable 5 already is: the "1M capable" badge, the 1M context window switch stays live for it, and base + switch compose into `claude-fable-5-1[1m]`. Both strings are accepted by the CLI.

  Deliberately not claimed: that a 1M window is what sets Fable 5.1 apart. The CLI's model catalog marks both fable entries as natively 1M with the same window, so an always-on window for 5.1 next to a switchable one for 5 would encode a difference the models do not have.

  ### Thanks
  - @shenlvkang-collab for #370, which surfaced that Fable 5.1 was missing from the picker.

## 1.24.4

### Patch Changes

- The Compose deployment image ships the Docker CLI instead of the whole Docker engine.

  `docker/server.Dockerfile` installed Debian's `docker.io` to get a client for the mounted
  host socket. That package is the full **engine**: even with `--no-install-recommends` it
  pulls 15 packages including containerd, runc, dmsetup and iptables, none of which a
  container that only talks to a socket can use. It also ships Docker 20.10.24, from 2023.

  The CLI and the buildx plugin are now copied from the official `docker:29-cli` image
  instead. Measured on the same `node:22-bookworm-slim` base: **266 MB → 108 MB**, a 158 MB
  saving, with the current CLI (29.7.2) in place of a two-year-old one.

  Verified by building the real image and running it: the binaries are static Go builds, so
  they work on this glibc image even though they come from an Alpine one, and `docker
--version`, `docker ps` and `docker build` all succeed against a mounted host socket as
  the unprivileged runtime user. buildx is copied deliberately — `scripts/build-agent-image.mjs`
  shells out to `docker build` and Codeman auto-builds the agent image on the first Docker
  case, which without the plugin falls back to the classic builder Docker has deprecated.
  `docker-compose` is not copied; Codeman never shells out to it.

## 1.24.3

### Patch Changes

- Docker Compose deployment, and the plan-usage chip stops losing its 5-hour window.

  **Run Codeman itself in a container** (#349, @opticon454). `docker/` now carries a
  local-image Compose deployment: copy `docker/.env.example` to `docker/.env`, set
  `CODEMAN_PASSWORD`, run `bash docker/Start-Codeman.sh`. Docker cases then start as
  **sibling** containers through the mounted host socket rather than nested ones, which
  inverts an assumption the bare-host path takes for granted: the daemon no longer shares
  Codeman's filesystem, so a bind source that is valid inside Codeman means nothing to it.
  `CODEMAN_DOCKER_HOST_HOME` translates sources under HOME into the daemon's namespace and
  `CODEMAN_CASES_PATH` points the cases dir at a host-absolute bind mount, so a workspace
  resolves to the same absolute path on both sides. `CODEMAN_DOCKER_DISABLE_SWAP_LIMIT=1`
  drops `--memory-swap` for hosts without swap accounting (`--memory` still applies) and
  filters only that one kernel warning. Guides: `docs/docker-compose.md`, `docker/README.md`.

  Three things were fixed while landing it:
  - **`docker/.env` was being baked into the image.** A `.dockerignore` pattern matches the
    whole context-relative path, so the bare `.env` line excluded only the root file while
    `COPY . .` picked up `docker/.env` — the file the deployment's own README tells you to
    fill with `CODEMAN_PASSWORD` and provider API keys — and left it at
    `/opt/codeman/docker/.env`. Now excluded via `**/.env`, verified in both directions
    against a real build context with a canary secret.
  - **`codeman skill install --case <name>` could not find a case under Compose.**
    `CODEMAN_CASES_PATH` moved the server's cases dir but not the CLI's, which still
    hardcoded `~/codeman-cases`. Both now resolve through one place.
  - **A Docker case handed its Claude conversation id to every other CLI.** `resumeOnStart`
    seeded `dockerResumeId` from `lastClaudeSessionId` regardless of mode, and
    `appendResumeFlag()` maps a resume id onto codex/gemini/pi/grok/deepseek/omp/antigravity.
    This one is a plain master bug, unrelated to Compose.

  **The plan-usage chip keeps its 5-hour slot.** It silently shrank from `5h 4% · 7d 52%`
  to a lone `7d 52%`, which reads as half the feature breaking. Nothing was broken: Claude
  Code ships `rate_limits.five_hour` "only while the API reports it and its resets_at has
  not passed", so between 5-hour session windows the key simply leaves the statusline
  payload. The slot now stays with a dimmed em dash and the tooltip says "no active session
  window". Claude only — a missing Codex bucket means that plan has no such limit, so those
  stay omitted.

  ### Thanks
  - @opticon454 for #349, and for a write-up that made an infrastructure PR quick to review

## 1.24.2

### Patch Changes

- Fix every new claude session dying on Claude Code 2.1.252's rewritten folder-trust dialog.

  That dialog used to offer `❯ 1. Yes, I trust this folder` / `2. No, exit`, so Codeman
  answered it by pressing Enter on the highlighted default. 2.1.252 dropped the numbers,
  reversed the options and highlights `No, exit`, so the same Enter now answers _exit_: a
  session in any directory claude had not seen before died (`Pane is dead (status 1)`)
  about six seconds after it started, before the agent ever drew a composer.
  - `trustDialogNextKey()` (`src/session-trust-dialog.ts`) now reads the `❯` marker off
    the rendered pane and returns ONE keystroke at a time: an arrow while the cursor is on
    the wrong option, Enter only once the screen shows it on the trust option. A frame it
    cannot read presses nothing. Both the 2.1.252 and the older numbered layout are
    handled, and the direction is derived from the frame rather than assumed, so a further
    reordering costs a repaint instead of a session.
  - The scan schedules its own follow-up read. It had only ever run from the PTY data
    handler, which was enough while one Enter answered the dialog; the arrow that moves the
    cursor is the last output the pane produces, so a two-keystroke answer would otherwise
    stall with the cursor sitting on the right option forever. The keystroke cap goes from
    3 to 6 for the same reason.
  - The bundled `codeman` agent skill gets the same treatment (preamble 1.21.0): its
    `_accept_trust` fallback reads `terminal?full=1`, steers onto the trust option and
    confirms only after re-reading, instead of posting a blind `\r`. It sends those
    keystrokes under its own `clientId`, because input sequence numbers are monotonic per
    client and spending prompt numbers on dialog keys would make the next send-and-wait
    look like a stale duplicate and vanish silently.
  - Readiness recipes in `docs/extending-codeman.md`, `docs/api-reference.md` and the
    skill's own reference carry the corrected answer and a new symptom-table entry for a
    worker whose pane is dead seconds after the spawn.

  Also included: a CLAUDE.md audit against the tree, correcting counted drift (route
  modules, handler counts, frontend module count and app.js size, install.sh size) and
  documenting several subsystems that had no entry.

## 1.24.1

### Patch Changes

- The Docker agent base image builds again.

  **`docker/agent.Dockerfile` could not be built from a fresh checkout** (#352, fix in #350): the DeepSeek Harness step died with `dsh: pnpm not found on PATH` and exit 127, which took the whole image with it and, because Codeman auto-builds this image on the first Docker case, left Docker mode unusable on a clean host. `dsh plugin` does not bundle a package manager; it spawns a literal `pnpm` with no npm fallback, so pnpm is now installed alongside `dsh` and the layer proves it with `pnpm --version`.

  The profile install also passes `--config.dangerouslyAllowAllBuilds=true`, because pnpm, unlike npm, refuses dependency lifecycle scripts by default and fails the install over it (`ERR_PNPM_IGNORED_BUILDS`, exit 1). Which packages that hits moves between rebuilds, since the terminal profile is resolved by dist-tag rather than pinned: the tree that broke the build in August pulled `@google/genai`, today's does not. An allowlist of those names would have gone stale rather than prevented the next break, and running those scripts is the same exposure the image already accepts three layers up, where `npm install -g` runs the install scripts of every transitive dependency of the five CLIs above it with no gate at all.

  Documentation caught up with two things it had wrong: the image smoke test in `docs/docker-cases.md` now covers `dsh` and `omp`, and checks the dsh **profile** rather than only the binary (`dsh` is a launcher, so `dsh --version` says nothing about whether a session can start), and `docs/deepseek-integration.md` names pnpm as a prerequisite for installing a terminal profile at all, by hand or through the UI button. A comment in the `/api/deepseek/install-profile` route claimed the opposite of what this bug proved, and is corrected; the route's behaviour was already right, surfacing dsh's own "pnpm not found on PATH" line as the install error.

  ### Thanks
  - @opticon454 for #350, with a reproduction that made this a confirmation rather than a hunt
  - @timkjr for reporting #352, and for finding it while verifying Docker support for someone else's PR

## 1.24.0

### Minor Changes

- OMP (Oh My Pi) as a tenth run mode, mode-faithful Resume for external CLIs, and a cleaner plan-usage chip.

  **OMP (`omp`) run mode** (#353): Oh My Pi joins Claude Code, shell, OpenCode, Codex, Gemini, Antigravity, Pi, Grok Build and DeepSeek Harness as a run mode, in local, Docker and remote-SSH sessions: toolbar dropdown, welcome button, phone overview, command palette, clone-repo brain picker, cron agent types, tab badges and per-mode colours, plus `GET /api/omp/status`, a `codeman doctor` entry, install.sh detection and the docker agent image. The resolver leads with `~/.local/bin` (the upstream installer's real target) and demands `omp/<semver>` from `--version`, so an unrelated binary with the same three-letter name is never spawned. Past omp conversations appear in Past Sessions, read from omp's own session files (the header line carries the real working directory, so nothing has to reverse-engineer omp's directory mangling), and a respawned or resumed omp session is pinned to an exact conversation with `--resume <id>` instead of omp's newest-file `--continue`. Review hardening before merge: the pin is resolved only at the moment a respawn is actually confirmed (an eager resolve on boot recovery used to alias two omp tabs in one case directory onto one conversation), candidates are verified against their own header `cwd` and claimed process-wide so siblings cannot double-pin; `OMP_*` joins the env-override allowlist and `OMP_AUTH_BROKER_URL`/`OMP_AUTH_BROKER_TOKEN` are clamped for non-granted owners in multi-user mode, the same shape as `DEEPSEEK_BASE_URL`. Known and documented: omp's own knobs are mostly `PI_*` (it is a pi fork), its default `tools.approvalMode` is `yolo`, and in-container `--resume` pinning does not reach a Docker omp pane.

  **Resume keeps the row's own CLI** (#353): clicking Resume on an OpenCode, Pi, Grok, DeepSeek or OMP row used to create a plain Claude session, since the create request never carried the row's mode. Resume now relaunches in the row's own mode with that CLI's continue flag, and retires the stale row it came from so three clicks no longer leave three copies of the same name. Codex, Gemini and Antigravity rows have no continuation wired yet, so their rows are deliberately left in place. `DELETE /api/sessions/:id` accepts a persisted-only session (ownership enforced through the same helper as live lookups, 404 rather than 403 so nothing leaks) and broadcasts `session_deleted` so other tabs drop the row too.

  **Plan-usage chip drops the provider label when there is only one**: a machine with only Claude limits rendered `CLAUDE 5H 60% 7D 23%`, a 46px label naming the only thing it could be. The name exists to tell two rows apart, so it now appears only when both Claude and Codex have windows; the tooltip still names the provider either way.

  ### Thanks
  - @timkjr for #353, and for turning every review finding around within a day

## 1.23.2

### Patch Changes

- Codex plan usage in the header chip, a visible inline rename in the session sidebar, and an installer that no longer loses Tailscale access on a re-run.

  **Codex plan usage in the header chip** (#346): the plan-usage chip used to show Claude's 5-hour and weekly limits without saying they were Claude's, which stops being a detail the moment you run more than one CLI. It now renders one compact row per provider, Claude above Codex, each labelled and colour-coded by how much is used up. Claude's numbers still come from Codeman's marked `statusLine.command` exporter; Codex's come from the signed-in host CLI's read-only `account/rateLimits/read` app-server request at startup and every five minutes, so credentials stay inside the CLI and no auth material reaches the browser. Only the main `codex` bucket is read (model-specific buckets such as Spark are separate limits and are deliberately excluded), and the Codex row is omitted entirely when no 5-hour or weekly window is available, rather than inventing one.

  **Inline rename is visible in the session sidebar** (#345): starting a rename on a sidebar row opened a focused input you could not see. The row's ellipsis clamp was still painting over the live editor, so text and caret went in blind. The sidebar now gets the same unclamped editor layout the vertical tab rail already had. Covered by a Chromium regression test that asserts the painted `overflow` and the input's measured width, not just the class name.

  **install.sh keeps Tailscale access on a re-run**: a re-run whose build failed could drop a working Tailscale binding instead of preserving it. The installer now offers Tailscale setup again on re-run rather than losing it, and the README describes the three-way network-access prompt (Tailscale / LAN / local-only) as it actually behaves.

  ### Thanks
  - @JackStuart for #346
  - @fibr for #345
  - @tailong-wu for #342, whose analysis of the terminal refresh replay loop matched a fix that had landed on master a few hours earlier

## 1.23.1

### Patch Changes

- Fix a fresh-Linux install failure, and bound the browser terminal's live write queue.

  **install.sh now installs a build toolchain.** Reported against a stock Ubuntu 24 server: node-pty publishes prebuilt binaries for darwin and win32 only, so on Linux it is always compiled from source during `npm install`. The installer set up Node, tmux and git but never a compiler, so a machine without `build-essential` died deep inside node-gyp with `not found: make` — which reads like an npm bug rather than a missing system package. `make`, a C++ compiler and `python3` are now checked up front exactly like git and tmux, installed per distro (apt / dnf / pacman / apk / zypper) behind the same consent prompt, and re-verified afterwards rather than assumed. If `npm install` fails anyway — including on `install.sh update` — it now names the missing tools and the command that installs them instead of leaving a node-gyp stack trace as the last word.

  **Bounded live xterm backpressure** (#339): live output is now one chunk in flight at a time, released by xterm's own parse callback, so xterm's private WriteBuffer can no longer hide an unbounded backlog behind the browser's 128 KiB render cap; queued, loading and incoming bytes all count against that cap. Automatic drop recovery for a shell stays on the bounded 1 MiB tail — a 100k-line shell capture is tens of MiB, and parsing it on the main thread is the freeze the cap exists to prevent — while TUI modes still recover full history behind the existing downgrade guard. Duplicate SSE terminal events are dropped before JSON parsing while WebSocket owns terminal I/O, and recovery is single-flight per active session. Follow-up hardening: the three write-queue reset paths now also release the in-flight gate, so a parse callback that never lands cannot leave live output permanently stalled.

  **File Viewer searches the workspace** (#340): the File Viewer search box now queries the server-side file search endpoint with a 250 ms debounce and strict response validation, instead of filtering only the part of the tree already loaded. Tree and search state are scoped to the active session, the hidden-file preference and independent request epochs, so a stale response cannot repaint the panel; cached-tree restoration, directory results and reset behaviour survive session switches and both panel-hide paths.

  ### Thanks
  - @dignfei for #339
  - @aakhter for #340

- 858b15e: Search the full session workspace from File Viewer while keeping results scoped to the active session and hidden-file preference.

## 1.23.0

### Minor Changes

- DeepSeek Harness as a ninth run mode, DeepSeek agent workers, and detailed rows for the vertical tab rail.

  **DeepSeek Harness (`dsh`) run mode** (#337): DeepSeek's plugin-native agent framework joins Claude Code, shell, OpenCode, Codex, Gemini, Antigravity, Pi and Grok as a run mode. The harness is a profile launcher rather than an agent, so availability is two questions (binary AND a pane-capable profile): the Run button gates on both, a missing terminal profile is offered as a one-click install (`POST /api/deepseek/install-profile`, the only endpoint in Codeman that installs third-party code, fenced accordingly), and the resolver demands the harness's own help banner so Debian's unrelated `dsh` (dancer's shell) can never be spawned. Its permission switch is the `DSH_PERMISSION_MODE` env export (the harness has no bypass flag), injected via tmux setenv and clamped for non-granted owners in multi-user mode, including the env-override path. The community TUI's supervisor-reporting contract makes deepseek the first non-Claude mode with REAL lifecycle signals: a generated status shim turns its idle/working/blocked reports into definitive `stop`/`permission_prompt`/`agent_working` hook events, so dsh sessions get real respawn triggers, real wait signals and red "needs you" alerts instead of output-stabilization guesswork. The vendor's browser UI opens as a managed web tab through a background `dsh web` fenced to Codeman's origin. Docker image support included.

  **DeepSeek agent workers** (#341): the codeman agent skill can spawn and drive dsh workers like claude ones — tasked, waited on and read with the same calls. `GET /api/sessions/:id/last-response` reads the harness's real zstd transcript (one frame per append; the reader walks frame boundaries itself, since a naive decode silently truncates to the first frame), distinguishes real prompts from plugin-injected context, and reports a failed turn's provider error instead of an empty answer.

  **Vertical tab rail: detailed rows** (#338): the vertical rail can now show the home screen's per-session line (created stamp, state duration, status pill) via the new per-device `tabRailDetail` setting (default detailed; `simple` restores the 1.22.0 rows). One shared row model and one gate (`isRichTabRows()`) keep the rail, the rich sidebar and both home screens in agreement about what "working" means. A never-sized rail opens at the 320px Wide preset; below 288px the created stamp is dropped, below 240px rows fall back to simple. Also fixes Escape during an inline tab rename committing an empty name (the session then displayed its folder name).

  **Review hardening across all three** (post-review commits on each PR): multi-user owners without the bypass grant can no longer redirect the server's forwarded `DEEPSEEK_API_KEY` via a `DEEPSEEK_BASE_URL` override; waits on `stop`/`blocked` are refused for docker/remote dsh sessions (their status bridge cannot reach the harness) and docker/remote dsh sessions keep the pane reader (their transcripts are not local); dsh approvals are alerts answered in the terminal, never blind keystrokes into a third-party TUI; the status shim forwards the contract's `--seq` token (stale retried reports are dropped server-side) and treats 4xx as permanent so a misconfigured session cannot rate-limit the hook endpoint for the whole instance; concurrent DeepSeek web-UI starts are serialized; cron deepseek jobs run the same launch gate as the HTTP paths; the installer's dsh identity probe is stdin-closed, bounded and memoized; transcript reads are memoized per (path, mtime, size) so 1s polling stops decoding unchanged files; the rail's width dialog, compact-threshold folder rows and reset affordances are rich-aware.

### Patch Changes

- b330f1d: Vertical tab rail: detailed rows, and a rename cancel that no longer wipes the name.

  The vertical rail (Tab Orientation → Vertical) now draws the same per-session
  line the home screen and the rich sidebar draw — when the session was created,
  how long it has been in the state it is in, the folder it runs in, and a status
  pill — instead of just the name. New per-device setting **Vertical Rail Rows**
  (`tabRailDetail`, App Settings → Appearance → Tabs) with `Detailed` as the
  default and `Simple (name only)` as the opt-out. A rail that has never been
  sized now opens at 320px (the existing Wide preset) so the line fits; a narrower
  rail sheds the created stamp below 288px and falls back to simple rows below
  240px.

  Also fixes a data-loss bug in the inline tab rename that predates the rail:
  pressing Escape cleared the input and blurred it, and the blur handler commits —
  so cancelling a rename stored an EMPTY session name and the tab fell back to its
  folder label. Escape now cancels without a request, in every layout.

## 1.22.0

### Minor Changes

- 3f8c8e9: Add Grok Build (xAI `grok`) as a seventh CLI run mode. SessionMode gains 'grok', with its own resolver (version-probed, since the name has npm squatters; GET /api/grok/status surfaces path + version), GrokConfig (model, alwaysApprove -> --always-approve, resume/continue), GROK*\*/XAI*\* env allowlist entries, the multi-user only-if-sent bypass clamp, Docker (own image step + per-file credential seeding) and remote-SSH command defaults, cron agentType, run-mode/welcome/tab UI with a charcoal identity, and docs (grok-integration.md + plan). Verified end to end against grok 1.0.5 on an isolated instance.
- 74194e4: Add the owner-scoped tab-layout model, persistence, API, lifecycle repair, and synchronized legacy ordering foundation.
- e3a2fb7: Add an optional resizable vertical session rail with responsive layout, complete labels, accessible controls, and stable inline rename.

### Patch Changes

- Fix the file preview's dead pop-out control: a real detach button now opens the previewed file in a browser tab (raw route for PDFs/images/media/text, converted-PDF preview for docx/pptx) and the copy button reports when a preview has no text to copy instead of silently doing nothing. Review-driven hardening for the new tab features: PUT /api/session-order drops unknown ids again instead of rejecting the whole write (a session deleted inside the browser's debounce window could silently lose the user's reorder), a failed mux restore no longer blocks explicit session/webview deletion for the process lifetime (the automated stale sweep stays fail-closed), and the vertical rail gains the axis-awareness the sidebar-only predicates missed: correct drag-reorder insertion, active-tab scroll-into-view, floating windows anchored beside rail tabs, connector redraws on rail scroll, server-seeded orientation applied on first load, a pre-paint stamp so vertical mode no longer flashes through the header strip, and a 12px session-name default matching the sidebar's historical size so untouched installs are not restyled.

## 1.21.0

### Minor Changes

- **`codeman tui`: a terminal dashboard for your sessions.** For the times you are in SSH or Termius instead of a browser. The web UI remains the primary surface and bare `codeman` still prints help, so the dashboard itself is strictly additive.

  Sessions are grouped NEEDS YOU / WORKING / IDLE / RECENT in the same status language as the web tabs and the phone overview, and the states come from the server (hooks, idle confirmation, the approvals inbox) over the existing HTTP/SSE API rather than being screen-scraped. That is what lets the dashboard answer a permission dialog instead of only reporting one.
  - `↑↓`/`j`/`k` select; `1`-`9`, `[`/`]` and `Tab` switch between sessions
  - `Enter` attaches and hands the terminal to tmux; **`F1` comes back**, one key, no modifier. Inside the pane a bar across the top carries the session strip and `Alt+1`..`Alt+9` switch without returning to the dashboard first
  - `Enter` on a RECENT row resumes that conversation; on a session whose pane has died it refuses and offers `r` to resume it in a fresh pane
  - `y`/`n`/digits answer the selected session's pending permission or question card (the server re-captures the pane first, so a keystroke can never land in the composer)
  - `p` sends a one-line prompt without attaching, `x` kills (`y` confirms), `n` starts a session and opens straight into it
  - `/` cross-session search, `g` away digest, `?` help, live preview pane, plan-usage chip in the header, a terminal bell when a new approval arrives
  - `codeman tui --list` and `codeman tui <n>` are scriptable fast paths; with no server running it lists panes straight from the instance's tmux socket, attach-only, and upgrades live when the server comes back

  Narrow terminals (under 72 columns, a phone SSH client) drop the preview and get a single-column layout. `NO_COLOR`, non-UTF-8 glyph fallback and a non-TTY refusal are all handled. Zero new dependencies: hand-rolled ANSI over chalk and commander. User guide: `docs/tui.md`.

  **Breaking: the `sc` tmux chooser is retired.** `scripts/tmux-chooser.sh` is deleted and `install.sh` no longer creates the `tmux-chooser` symlink or the `sc` alias; it sweeps both up instead, on update and on uninstall. `codeman tui` replaces it and does the job better: `sc` numbered its entries globally but only accepted a single `[1-9]` keypress, so sessions 10+ were listed and could not be selected, and it inferred nothing about what an agent was doing. The alias cleanup is marker-owned, matching the exact line the installer wrote, so a user's own `alias sc=` for another tool is untouched.

  **CLI polish that came with it.**
  - New shared style kit (`src/cli-style.ts`) used across the CLI: semantic palette, glyphs, width-aware table, spinner, confirm.
  - `codeman doctor` is colorized and its table is measured, so the "Antigravity CLI" label no longer pushes its row out of column. `--json` output is unchanged.
  - `codeman web` no longer prints its "running at" line twice, and the server's non-loopback security warning is painted like the CLI's (chalk degrades off a TTY, so journald and `web.log` stay free of escape codes).
  - Spinners on the silent up-to-30s waits in `codeman web -d`, `codeman web --stop` and `codeman service install`.
  - `codeman reset` asks a real y/N confirmation on a TTY; non-interactive callers keep the old `--force` refusal.
  - `codeman list` and `codeman session list` share one renderer instead of drifting copies.
  - `codeman attach` is described correctly in the README (it shows an attachment card for a local file).
  - `test/cli-commands.test.ts` now derives its inventory from the real commander program instead of a hand-written fixture that had drifted.

  **Internal.** New `tmux -L` callers resolve the socket through `resolveTmuxSocketName()`, now exported from `config/instance.ts`, so a second process can never point a beta instance at prod's panes. CLAUDE.md and `docs/architecture-invariants.md` both record the rule.

  ### Thanks

  The TUI went through seven rounds of beta testing over PuTTY/SSH by **@Ark0N**, which is where the way out of an attach, the session strip, the preview repaint handling and the glyph set all came from.

## 1.20.1

### Patch Changes

- Terminal input and scrollback fixes (PRs #327, #331):
  - IME punctuation preserved (#327): keyCode 229 / `Process` key events are now delegated to xterm's CompositionHelper instead of being suppressed, so an active Chinese IME committing numbers and full-width punctuation (，。！？ and friends) reaches the terminal correctly. The CJK input field sends the browser's committed text instead of guessing from `KeyboardEvent.key`, and the redundant Android orphan-input fallback is removed so xterm is the single input owner.
  - Shell history replay bounded (#331): selecting a Shell session loads a bounded 1 MiB tail instead of replaying the entire multi-megabyte tmux scrollback on xterm's main thread; full history stays available via the explicit "Load full history" action. tmux history limits now apply correctly on both legacy tmux (global default set in the same command queue before pane creation) and tmux 3.7+ (per-pane targeting that never resizes or trims unrelated live panes). Also adds `Server-Timing` and `[TERMINAL-PERF]` timing stages for terminal loads, fixes `scrollToLastNonEmptyLine` double-counting scrollback rows, and keeps live output ordered behind snapshot replays.

  ### Thanks
  - @dignfei for both fixes: the IME punctuation root-cause fix (#327) and the bounded shell history replay with the tmux history-limit correctness work (#331).

## 1.20.0

### Minor Changes

- Response viewer for OpenCode, Gemini, Antigravity and Pi sessions (#326). External CLIs render their own TUIs, so the viewer used to come up empty for them; a new transcript parser (`response-viewer-transcript.ts`) reconstructs the conversation from the pane text instead, and the `?context=full` view now tags every block with a role so prompts render as "You" and agent output as the assistant. The divider normalizer was rewritten as a linear scan after review found catastrophic backtracking on agent-controlled input (minutes of stall on a long dash run), with an equivalence corpus pinning the old accept set.

  CLIs installed via nvm or Homebrew are now found when Codeman runs as a service (#329). A shared resolver falls back to a login-shell probe when the direct PATH lookup misses, so systemd and LaunchAgent installs no longer report every CLI as missing. Review hardening on top: a failed resolution is negative-cached with doubling backoff instead of re-spawning a login shell on every request, all probes pass `killSignal: 'SIGKILL'` (interactive bash shrugs off SIGTERM, and a blocking `.bash_profile` could have hung the server indefinitely), the resolvers are inert under vitest again so test suites cannot execute binaries found on the dev box, and the improved not-found guidance is wired into both the session-create errors and the per-CLI status endpoints.

  `GET /api/system/repo-status` reports branch, upstream, ahead/behind and remote reachability for git-clone installs (#328). Review hardening: the git network calls moved off the synchronous path onto a single-flight 45s cache (one slow remote could previously freeze the whole server for up to a minute per request), remote URLs and git stderr are credential-redacted before they leave the server, the spawns use the same non-interactive git env as the clone path, and a local-branch upstream no longer parses into garbage.

  Auto Copy for the terminal (#325, opt-in, per-device): a finished selection (mouse drag, double or triple click, or a phone long-press) lands on the clipboard by itself, so select-then-copy becomes select. Alongside it, hand-encoded tap reports are now gated on the server-observed `cliMouseTracking` state, so a pane that has fallen back to a plain shell no longer receives `[<0;88;20M` junk on tap.

  The Ralph loop no longer stops polling after two ticks (#330): the reschedule guard read a stale timer handle that the timer callback never cleared, so the loop silently died while its status stayed `running`. The handle is now nulled as the callback's first statement, and a regression test pins the bug.

  The red "needs you" tab alert clears when a dialog is answered in the terminal instead of surviving until the end of the turn: the post-hook re-capture could erase the parsed dialog options that the staleness sweep relies on (`applyCapture` is now add-only for options), and a delayed staleness pass now runs while a page is open. The unreachable `copyTerminal()` was removed, closing out #322.

  ### Thanks
  - @aakhter contributed the external-CLI response viewer (#326), the repo-status endpoint (#328), the login-shell CLI resolution (#329) and the Ralph reschedule fix (#330)
  - @rounakdatta reported the mobile copy gap (#322) closed out in this release

## 1.19.7

### Patch Changes

- Mobile catches up: links open from a tap, terminal text can be selected and copied, long prompts stay visible while you type. Plus Files panel search, a bundled Nerd Font symbols fallback, and a per-device terminal font setting.
  - **Terminal and chat links work on phones** (#321): tapping a URL or file path in terminal output now opens it (new tab, file preview, or log viewer), resolved through the same provider desktop hover uses, so tap and click can never disagree about what is a link. Dialog rows and the composer keep their existing meaning. Response-viewer links open in a new tab with `rel="noopener noreferrer"` instead of navigating the dashboard away. Wrapped links open whole: the logical-line reconstruction now stitches hard wraps through the indent their continuation carries, which also fixes desktop hover-click truncating wrapped URLs.
  - **Terminal text can be copied on touch devices** (#321): long-press selects the token under the finger, drag or tap the other end to extend, and a small bar offers Copy, Line (the whole logical line, wraps included) and dismiss. Copy works on plain-HTTP installs too. Three guards keep the keyboard down and the selection alive through the browser's own long-press handling.
  - **A long prompt stays visible on phones** (#321): the local-echo overlay grows upward once it would run past the last visible row (a prompt taller than the screen keeps its tail, where the cursor is), and the keyboard-driven padding shrink can no longer reclaim the space the fixed toolbar and accessory bar stand in.
  - **Files panel search** (#324): `GET /api/sessions/:id/files?q=...` answers a flat match list (name or path substring, `*`/`?` globs), recursing past non-matching directories with its own match cap on top of the existing bounds; without `q` the response is byte-identical to before. Glob queries are matched without regex so a pathological pattern cannot stall the server.
  - **Nerd Font prompt glyphs out of the box, custom terminal font** (#320): a bundled icons-only Symbols Nerd Font Mono fallback renders powerlevel10k/starship/oh-my-posh glyphs on every device with no font install, and App Settings gains a per-device terminal font family that is prepended to the built-in stack.

  ### Thanks

  Three contributor PRs in one release: thanks to @rounakdatta (#321), @aakhter (#324) and @comzine (#320).

- 8a54b33: Clear every production-reachable npm advisory, and fix a service-worker caching regression the upgrade exposed.

  `npm audit` reported 20 advisories, but 16 were devDependencies-only (Remotion, Puppeteer, postcss, the eslint/tsx toolchain) and never reached anyone installing the package. Four reached production and are now resolved:
  - **`@fastify/static` 9.1.3 to 10.1.3** — GHSA-8pvw-jcv7-9cmj, authorization bypass via non-canonical URL paths. The advisory covers `<=10.1.1`, so the entire 9.x line is affected and the fix only exists on 10.x.
  - **`find-my-way` 9.6.0 to 9.8.0** — GHSA-c96f-x56v-gq3h (HTTP/2 DDoS). Not exploitable here since Codeman does not enable HTTP/2, fixed anyway.
  - **`fast-uri` 3.1.2 to 3.1.5** — GHSA-v2hh-gcrm-f6hx, host confusion via a literal backslash authority delimiter.
  - **`brace-expansion` to 5.0.9 / 1.1.18** — GHSA-3jxr-9vmj-r5cp, exponential-time expansion DoS.

  The last three were transitive and only needed a lockfile re-resolve; no `overrides` were added.

  The `@fastify/static` major changes the `setHeaders` callback's first argument from a Node `ServerResponse` to a `FastifyReply`, which required two fixes:
  - `res.setHeader()` became `reply.header()`. A v9-style body throws `TypeError: res.setHeader is not a function` from inside the plugin on every static request.
  - **That change also flips precedence, silently.** The callback used to write to the raw response and be overwritten by the route's staged reply headers; it now writes to the reply and wins instead. That handed `/sw.js` a year of `immutable` in place of the `no-cache, no-store` its route sets, which would pin a service worker on every client with no server-side way to recover. A route that already set `Cache-Control` now keeps it.

  `ws` also appears in `npm audit` but production is already on 8.21.0, outside the vulnerable range; the only affected copy is bundled under `@remotion/renderer` and is dev-only.

  Adds `test/static-cache-headers.test.ts`, which drives a real server and covers the caching contract that had no test at all, and moves the floors in `test/dependency-security.test.ts` up to the patched versions.

## 1.19.6

### Patch Changes

- Wiki user manual, a phone tab tap-zone fix, per-parent lineage colours, and two robustness fixes.
  - **Wiki**: `docs/wiki/` is now a 30-page user manual (installation, quick start, the dashboard, agent CLIs, remote/Docker cases, hooks, security, HTTP API, troubleshooting and more), published to the GitHub wiki by a sync workflow on every push that touches it.
  - **Phone tabs**: on a narrow phone the active tab's geometric centre could land on its gear icon, so a thumb aiming at the tab opened Session Options instead of switching. The active tab's name now reserves a minimum width, and a static test recomputes the clearance from the stylesheet so widening the icons fails there rather than on a phone.
  - **Lineage lines**: the arcs between a tab and the tabs it spawned are now coloured per SPAWNING tab, so every arc leaving one tab shares a colour and the strip reads as "these came from w1, those from w2". A child that spawns in turn gets its own colour, so a chain changes colour at each generation.
  - **File access**: `validateSessionFilePath()` now canonicalizes the workspace as well as the candidate path before comparing them. Resolving only the candidate made a workspace reached through a symlink (`/tmp` on macOS, symlinked project dirs, bind-mounted case paths) report a spurious escape and refuse every read and write in that session. Escapes are still refused.
  - **Respawn**: a cycle step that is stopped mid-write no longer revives the state machine. `stop()` could land during the `await` on the kickstart / update / clear / init write, after which the controller set itself back to a waiting state and kept running.

  ### Thanks
  - @aakhter for the symlink-safe workspace confinement fix (#314) and the respawn stop-race fix (#315).

- 98e37bf: Session List Layout gains a third option, "Left sidebar", whose rows carry the same per-session detail the home screen shows.

  The sidebar previously had one row style: a name and a folder. That is the whole story a tab can tell, but a docked column is not a tab strip — it has width to spare and a row per session either way, and the information that was missing is exactly the information the desktop home rail and the phone overview already put on screen. So the new option lifts it onto the rows: when the session was first created, how long it has been in the state it is in, and a status pill naming that state.
  - The old "Left sidebar" is now **"Left sidebar simple"** and is unchanged, down to the byte — the stored value stays `sidebar`, so anyone already using it keeps exactly the layout they chose. The new option is `sidebar-rich`.
  - Both sidebar values are the SAME layout and both set `data-session-list="sidebar"`; row detail rides on a separate `data-sidebar-detail` attribute. That is deliberate: every `isSessionSidebarActive()` call site and every `html[data-session-list="sidebar"]` rule in styles.css and mobile.css keeps matching both, untouched.
  - Which state a session is in, and which stamp measures it, come from `_mobileOverviewState()` / `_mobileOverviewSince()` rather than being re-derived — the sidebar, the home rail and the phone overview cannot disagree about what "working" means. A working row is measured from the turn's last Enter, not from its last repaint, so a running turn reads `working 12m` instead of `0m`.
  - The stamps refresh in place on a 20s clock instead of re-rendering: a rebuild would restart every load spinner and alert animation in the list, twice a minute. The clock only runs while rich rows are on screen.
  - The column widens to 300px for the extra line, and the collapsed 44px rail and the handheld drawer are explicitly held back from that width.

- 947ff6f: `npm test` is now the CI gate and is safe to run bare; the suites it cannot run each got their own command.

  `npm test` ran the everything-config, which fails ~87 tests on a clean master on any machine without chromium, a free port and per-machine PNG baselines. That made the repo's most obvious command useless as a pass/fail signal, and the docs had accumulated "never run bare `npm test`" warnings in four files to work around it. It now runs `config/vitest.ci.config.ts` — exactly what CI runs — so local green means CI green.
  - New: `test:browser` (5 Playwright files), `test:perf` (2 wall-clock benchmarks), `test:all` (the old everything-behaviour, kept reachable). `test:ci` and `test:mobile` are unchanged; `test:watch` and `test:coverage` follow `test` onto the gate's config.
  - The exclusion list moved to `config/test-suites.ts`, with the reason each suite cannot run in CI. Every config derives from it, so the gate's excludes and the runners' includes cannot drift.
  - That drift was a silent hole, not a tidiness problem: a file excluded from CI and added to no runner is tested by NOTHING, and every command stays green, because vitest counts "no files matched" as success. `test/test-suite-partition.test.ts` now fails if any test file is reachable by no runner or by two.
  - ⚠️ A file filter must match its runner: `npm test -- test/mobile/keyboard.test.ts` matches nothing and exits green having run zero tests, because the gate excludes that path. Use `npm run test:mobile -- <file>`. Documented in CLAUDE.md, and the one place that recommended the old form was corrected.
  - Docs synced: CLAUDE.md, AGENTS.md, .github/CONTRIBUTING.md, both READMEs, and two ci.yml comments that claimed only `test/mobile/**` was excluded (it is three suites, and 5 Playwright files rather than 3).

## 1.19.5

### Patch Changes

- Closing the session you are looking at now always moves you to the next tab.

  The delete request and its own `session_deleted` broadcast raced each other: the close path selected the next tab, while the broadcast handler cleared the active session and showed the home screen, and whichever ran first decided what you saw. On one build, closing a tab either switched sessions or dumped you on the welcome screen depending on timing. The close now owns that handoff from beginning to end, and the broadcast handler stays out of the way for a close started in that tab. A session deleted from somewhere else still returns you to the home screen, which is the honest answer when what you were looking at was taken away.

  The next tab is also picked from sessions that still exist, so a stale entry in the tab order can no longer name a tab that is already gone.

## 1.19.4

### Patch Changes

- Only a human opening a session clears its yellow "waiting for input" tab alert.

  1.19.2 made that clear durable and cross-device, which also meant the app itself could spend it: restoring your last session on page load, a popped-out window opening its target, and the fallback to another tab after you close the active one all counted as "I checked it", so a yellow tab could clear itself before you ever saw it. Those three app-driven selections are now marked and skip the acknowledgement, so the alert survives until you actually open the session.

  Everything a human does still clears it, on every surface: tapping a tab, tapping a row on the phone home screen, the keyboard tab shortcuts, and submitting a prompt into the session. The flag defaults to user-initiated, so a selection path nobody marked keeps acknowledging rather than leaving an alert nothing can clear.

## 1.19.3

### Patch Changes

- Red "needs you" tab alerts now follow the dialog instead of the keyboard.

  Typing in the terminal no longer clears a red alert. It used to clear every pending alert on the device you typed on, but a permission or question dialog ignores keystrokes that are not one of its options, so the dialog was still open and still blocking: the other devices stayed red and a reload brought the red back on the first one. Input now spends the yellow idle alert only, and it does that through the server-side acknowledgement added in 1.19.2, so the clear is durable and reaches every device.

  A dialog answered in the terminal now clears by itself. Claude Code fires no "permission answered" hook, so the item stayed pending until the whole turn ended, and any page load in between re-armed a red alert for a dialog that was long gone. Listing approvals now re-captures the pane and resolves items whose dialog is no longer on screen, using the same conservative check the answer path already uses: only an item whose original frame parsed numbered options can be dropped this way, so an unreadable capture keeps the alert rather than losing a live one. Measured against a real AskUserQuestion dialog: the stale item cleared 5 seconds ahead of the stop hook that used to be the only signal, while a dialog still on screen survived 11 consecutive listings over 55 seconds untouched.

## 1.19.2

### Patch Changes

- Yellow "waiting for input" tab alerts now stay cleared once you have checked them, on every device.

  Viewing a session used to clear its idle alert in that browser's memory only. The server-side approval store still held the prompt, so the next page load seeded the alert straight back and a tab you had already checked went yellow again, while your other devices never heard about the click at all. Opening a session now acknowledges its pending idle prompt server-side (`POST /api/approvals/session/:sessionId/viewed`, a new `acknowledgedAt` field on approval items, broadcast as `approval:updated`), so the clear survives reloads and reaches every connected client.

  Acknowledgement is deliberately not resolution: the prompt is still unanswered, so the item stays in the Approvals Inbox, stays answerable, and stays available as Read My Mind context, it just stops arming the tab alert. Permission and question dialogs are never acknowledged this way, since looking at a dialog does not answer it, so the red "needs you" alert survives being viewed. Clicking the tab you are already on now clears the alert as well; that path returned early before, so an alert armed on the active tab could not be cleared by clicking at all.

## 1.19.1

### Patch Changes

- Follow-up hardening from the 1.19.0 reviews, across all three of that release's areas (#309, #310, #311).

  Home screens: the activity ordering introduced in 1.19.0 now stays truthful. Hook events push a session state broadcast, so a blocked session ranks by a fresh stamp instead of whatever the page loaded with; a working row with no recorded submit shows the same stamp it sorts by; Alt+1..9 resolves through the live sessions the tabs actually paint, so a stale id in the saved order can no longer shift every number off its target; and the "most recently quiet" ordering survives restarts, since recovery now restores each session's previous activity stamp from state.json instead of restamping everything at boot (previously every deploy flattened the ordering to tab order).

  Files and sidebar: playable media extensions are pinned to the attachment registry by a parity test, so an in-workspace .m4a/.flac/.opus opens the preview player instead of the log viewer; /etc paths no longer render as links that can only 403; the sidebar session count counts the rows actually on screen (web tabs included, filtered rows excluded) and follows the filter box; connectors re-anchor on incremental renders in sidebar layout; and ~/.claude.json plus ~/.claude/settings(.local).json are blocked from file serving, home-anchored only, so case-level .claude files stay viewable.

  Workspace hooks: the install-vs-refresh decision is one shared core that every claude create path routes through, so the workspaceHooksEnabled setting now also applies to cron jobs, legacy scheduled runs, and plan-orchestrator one-shots; a shell session in a docker case no longer authors a hooks block; the boot sweep no longer resurrects a deleted workspace as an empty directory; and the statusLine exporter got the same remote-attach and cwd-fallback guards as the hooks install.

## 1.19.0

### Minor Changes

- c01edcb: Add an optional collapsible left session sidebar as an alternative to the header tab strip.

  With many concurrent sessions the horizontal strip wraps into several rows and stops being scannable. The new layout puts the session list in a vertical `<aside>` with a filter box and a live session count, collapsible to a 44px rail that keeps the status dots and task badges visible.

  Opt-in via Settings → Layout → Tabs → Session List Layout; the default stays the header strip, so nothing changes unless you switch. Both layouts share one `#sessionTabs` element that is re-parented between mount points, so every existing affordance (status, mode badge, alerts, drag-reorder, keyboard navigation, web tabs, subagent windows) behaves identically in both. Below 1024px the sidebar is an off-canvas drawer that overlays the terminal instead of shrinking it. Collapse state persists per device; `Alt+B` toggles it.

- Codeman hooks now install into every claude workspace at session create, not just cases Codeman created (#304). Linked cases and cloned repos previously ran hook-blind: tab alerts, the Approvals Inbox, and the agent skill's stop/blocked wait signals were silently dead there. The install is an add-only merge that preserves user-authored hooks and leaves malformed files untouched, and a boot sweep heals sessions recovered from a restart. Opt out with the new synced `workspaceHooksEnabled` setting. Note: a `.claude/settings.local.json` can now appear in repos you link as cases; it contains no secrets. Remote SSH attaches and creates without a `workingDir` never write hooks.

  File paths an agent prints are now clickable in both the terminal and the response viewer, opening the file preview overlay, including paths outside the session workspace (#306). Out-of-workspace paths are served through the attachment routes' extension allowlist, realpath confinement, and sensitive-path blocklist; Codeman's own credential-bearing files (`settings.json`, `push-keys.json`, `intents.json`, `state*.json`) are blocked from serving.

  Both home screens (the desktop home tab rail and the phone overview) sort sessions by activity instead of tab order (#303): blocked sessions first with the longest-blocked on top, then running sessions longest-running first, then quiet sessions most recently active first. A turn starting now pushes a session state broadcast so the ordering stays live after page load.

  The codeman agent skill docs teach hook presence as a setting to check rather than a consequence of who created the workspace, and the §0 preamble stamp is bumped to 1.19.0 (#305).

  ### Thanks
  - @christianhaberl designed and built the collapsible left session sidebar (#307)

## 1.18.4

### Patch Changes

- Faster agent-skill workers, retuned multi-color lineage arcs, a per-tab pop-out option, reliable tab alerts, and the community launch.
  - Agent skill: SKILL.md now forbids the standalone preamble check and the pre-spawn reconnaissance turns that were costing whole model turns; the same two-worker spawn measured at 28.6s end to end now runs 20.2s cold and 12.8s warm, with the spawn machinery itself unchanged.
  - Session lineage lines: arcs now hang from the tab strip's bottom edge (dip cap 104px to 64px, no stacked row offsets), fixing the deep bow on wrapped tab strips and keeping same-row arcs off the second row's tab labels; each spawned worker's arc gets its own color (skin blue first, then matrix green, pink, violet, red, turquoise, orange), assigned per child and stable across re-renders.
  - Session Options > Session: new "Pop-out button on this tab" per-tab override on top of the general App Settings toggle (per-device).
  - Tab alerts: pending permission/question alerts now survive page reloads regardless of the Approvals Inbox setting (the alert state machine seeds from the server-side approval store on every load), stay visible on the selected tab until the prompt is actually resolved (the alert paints on a ::before overlay the active tab's styling cannot bury), and render as a steady red/yellow ring with glow and a colored status dot instead of a blink that spent half of every cycle looking like a normal tab. The README carries a live capture of the new alerts.
  - Community launch: README Community section, .github/CONTRIBUTING.md (dev setup, test safety, great first contributions, PR expectations), and GitHub Discussions.
  - docs: worker warm-pool design sketch with the measured baselines.

## 1.18.3

### Patch Changes

- Fix skill-spawned workers losing their lineage arcs and spawning slowly: a stale user-level agent skill copy (`~/.claude/skills/codeman`, written once by `codeman skill install`) shadowed the fresh per-case injections, so agents ran old recipes (serial spawns with pid polls, no `X-Codeman-Parent-Session` header). Session create now refreshes a marker-owned user-level copy (refresh-only, never installs, foreign/symlink copies untouched) and pre-seeds the skill's preamble into `${XDG_CACHE_HOME:-~/.cache}/codeman-agent-<id>.sh` (0600, local claude sessions only), single-sourced from the new `skills/codeman/preamble.sh` and pinned byte-identical to the SKILL.md heredoc by test. The skill's bootstrap is now a two-line loader with the full block as fallback, cutting measured prompt-to-workers-spawned time from 35s to 10.6s; `spawn_worker` also sends `parentSessionId` in the request body as defense in depth, and the preamble stamp is bumped to 1.18.3 so pre-fix cached preambles self-heal.

## 1.18.2

### Patch Changes

- Draw session lineage lines in blue for contrast. The violet arcs sat close to the
  terminal's own dim foreground, so they lost contrast exactly where they cross text;
  the colour now comes from each skin's own `--session-blue` token, and the layer is
  separated from subagent lines by shape, weight and dash pattern rather than hue.
- f18097c: Make the `codeman` agent skill spawn workers fast instead of deliberating first.

  Measured against a live server, the API does the whole job (spawn two claude workers,
  task them, read both answers) in about 10 seconds, so the delay users saw was
  agent-side: the skill taught serial spawning, made the happy path something to
  reassemble from five sections on every run, and cost ~16k tokens of mostly failure
  modes before the first call.
  - The §0 preamble now defines the verbs instead of describing them: `spawn_worker`,
    `spawn_workers` (concurrent), `sendwait` and `last_text`. §1 composes them into the
    whole job in one Bash call, and says to stop reading there.
  - Dropped two ceremonies the measurements retired: the pid-poll loop (`wait-output`
    already blocks on the composer) and the agent-driven hooks check, which is now folded
    into `spawn_worker` itself as a single local grep of the resolved `casePath`, so a
    name that resolves to a linked case or a hook-less pre-existing directory is refused
    instead of silently running the job there. Linked cases and raw paths still require
    the by-hand check, where its absence silently breaks send-and-wait.
  - The bootstrap's write condition now greps the version stamp, so a stale or truncated
    preamble file self-heals instead of failing and asking you to `rm` it by hand.
  - `sendwait` picks a fresh `seq` per call (a fixed default made every second prompt to
    the same worker a silently-swallowed duplicate) and self-heals stranded delivery: an
    Ink repaint occasionally eats the Enter, leaving the prompt typed but unsubmitted
    (observed live), so a timed-out first wait sends one bare `\r` and re-waits by
    resending the identical frame as a tagged duplicate.
  - §5 moved to `reference/verbs.md`, leaving an index. SKILL.md is the only part paid on
    every load and drops from ~16.4k to roughly 9k tokens (~35KB); section numbers and
    anchors are unchanged, so existing `§5.x` references still resolve.

## 1.18.1

### Patch Changes

- Terminal history and scroll position fixes, a seekable file-viewer video player, and clearer session lineage lines.

  **Terminal scroll position (#259).** Three paths dragged the terminal to the bottom while the user was reading scrollback. Opening or closing the mobile keyboard forced it unconditionally; scroll intent is now captured before the keyboard reflow and restored afterwards. Live writes preserved the viewport only inside a 1500ms window, so a user who scrolled up and then actually read for longer was dragged along by the next repaint; that is now based on position rather than recency. The backpressure refresh, which is server-triggered and so has no gesture to blame, now holds the reader's place too.

  **Terminal history loss (#259 follow-on).** The backpressure refresh rebuilt the terminal from a 1MB tail, which measured as an 869-row buffer coming back with 158 rows: the routine meant to repair the display was discarding most of the scrollback every time SSE backpressure cleared. It now restores full history, falling back to the tail only when the capture would shrink the buffer, so repaint-mode panes are unaffected. It also bails if the user switches tabs mid-fetch, which would otherwise paint one session's history into another's terminal.

  **History truncation is now visible and recoverable (#258).** Truncation was reported by a grey line written into the terminal, which scrolled away with the output it described and read the same whether the rest was one click away or gone forever. `GET /api/sessions/:id/terminal` now reports `truncationReason` (`tail` for an intentional partial replay whose remainder is still retained, `capped` for the byte ceiling) plus `retainedBytes`, and the browser shows a dismissible banner outside terminal output with three honest states: recoverable, which offers a Load full history button, at-ceiling, and exhausted. The button bypasses the scroll cooldown but not the downgrade guard, so it cannot destroy history on a repaint-mode pane.

  **File viewer video (#284).** Closing the preview left the video playing with audible audio and no visible player, since hiding the overlay does not stop a media element and detaching one does not either. Media is now paused, unsourced and reloaded on close and on re-open, which also aborts the in-flight download. The scrub bar was inert because raw file bodies were served as a single `200` with no `Accept-Ranges`, so Chrome reported `video.seekable` as `[0, 0]` and Safari refused to start the media at all. Raw bodies are now streamed and range-aware (`Accept-Ranges` on every response, `206` with `Content-Range` for a range request, `416` past EOF, malformed specs ignored per RFC 9110), with pure, unit-tested parsing in `src/web/http-range.ts`. The attachments raw route gets the same treatment.

  **Session lineage lines (#285).** The arcs joining a tab to the workers it spawned were tuned for two adjacent tabs and flattened into a straight thread across the terminal at the 800-1500px spans they are actually used at, drew a flat overprinted line inside the row gap on a wrapped strip, and were too faint to see at 1:1. Every pair now uses one U-bridge shape anchored on both tabs' bottom edges, with a deeper span-scaled dip and heavier, higher-contrast strokes.

  **Docs.** The pi run mode is now listed in the mode lists that the sixth-backend sweep missed.

## 1.18.0

### Minor Changes

- Heal a stalled SSE stream with a heartbeat and a client-side staleness watchdog, and make a tab rename apply immediately.

  An `EventSource` that stops delivering does not always error. A proxy that idle-closed the connection, a laptop resumed from sleep, a tailnet reconnect: `onerror` never fires, the header dot stays green, and every SSE-driven surface (tab status dots, sessions created on another device, renames) freezes until the user reloads. Nothing on the client tracked stream liveness at all.
  - **`sse:heartbeat` is a new named event** under a new Transport category in the registry (155 constants now, both the backend list and the frontend `SSE_EVENTS` copy updated). The server already wrote a keepalive every 15s, but as an SSE `:keepalive` **comment**, and comments are invisible to `EventSource` by spec, so there was nothing a client could observe. `cleanupDeadClients()` now writes the named frame (`{"t":<epoch ms>}`) instead; interval, tunnel padding and dead-socket eviction are unchanged, and the write stays per-client rather than going through `broadcast()` because the frame carries no session data and so needs no multi-user owner routing.
  - **Client watchdog.** `computeSseStale()` in `constants.js` is a pure policy beside `computeConnectionLossUi`: stale only when the transport believes it is `connected`, the device is online, and no frame has arrived for 45s (three missed heartbeats). That `connected`-only guard doubles as the loop breaker, since a forced reconnect leaves the state immediately and the watchdog cannot re-fire while one is in flight. The liveness stamp is applied inside `addListener` itself so every registered listener feeds it from one place instead of three that can drift, and the heartbeat's own listener is a deliberate no-op that exists only to be registered (`EventSource` drops named events nobody listens for). A 5s watchdog forces `connectSSE()`, `visibilitychange` to visible checks too (a background tab's timers are throttled, and a wake is exactly when a stream comes back zombie), and the forced reconnect logs one diagnostic line so a middlebox that strips or delays heartbeats does not present as an undebuggable "silently reconnects every 45s".
  - **Renaming a tab appeared to do nothing** until a full page reload. The `PUT` always succeeded; what was broken is how the tab strip learned the result. `finishRename()` re-renders from the client-side `app.sessions` map and nothing wrote the new name into it, so the rename depended on the `session:updated` SSE frame to carry its own write back, which is precisely what a quiet stream never delivers. `_applyLocalSessionName()` now writes the confirmed name locally and refreshes cached subagent parent names. A rejected rename also used to read as success and silently drop the edit, because `_apiPut` turns a network error into a null Response so the old `try`/`catch` could never fire; a failure now restores the old label and toasts.

  Tests: `test/sse-staleness.test.ts` (node VM over `constants.js`, threshold boundaries and every not-stale guard), `test/sse-heartbeat.test.ts` (drives `cleanupDeadClients()` with fake replies: named frame not a comment, parseable payload, padding only with a tunnel, dead clients still evicted), and `test/inline-rename.test.ts` (the name applies with no SSE frame dispatched, and a 500 leaves the map untouched).

  Event names are part of the stable `/api/v1` contract, so this is a minor bump.

- c5b5963: Add Pi (pi.dev) as a sixth CLI run mode (#206).

  `SessionMode` gains `'pi'`, a first-class backend alongside Claude Code, OpenCode, Codex, Gemini and Antigravity: its own PTY, tmux session, rose tab identity, welcome button, run-mode entry, cron `agentType`, Docker and remote-SSH command defaults, and clone-repo Brain option.
  - **New resolver** `src/utils/pi-cli-resolver.ts`. Unlike the sibling resolvers it sanity-probes `pi --version` and requires semver-shaped output, because `pi` is a short generic name that a stray binary on `$PATH` can shadow; the rejected path is logged. `GET /api/pi/status` returns `{ available, path, version }` so a misresolution is diagnosable.
  - **`PiConfig`** maps to `--model` (accepts `provider/id` and a `:thinking` suffix), `--provider`, `--thinking`, `--session`/`-c`, and the tri-state `--approve` / `--no-approve`. Every value is regex-allowlisted and dropped on failure. `--api-key` is deliberately never wired: it would put a provider secret on the spawn command line.
  - **No bypass flag.** Pi has no permission prompts and no sandbox, so there is no `--dangerously-skip-permissions` analog. Its privilege-shaped knob is `approveProjectTrust`, which makes pi load and execute repo-local `.pi/extensions` TypeScript and install missing project packages. `clampExternalCliBypassForOwner()` therefore puts pi in the **materialize** branch: a non-granted multi-user owner gets `--no-approve` even when no config was sent, because pi's own default is an interactive prompt the session user could answer themselves. The same materialization applies to cron-fired jobs (`clampCronExternalCliConfigs`), which carry no per-CLI config and would otherwise launch on pi's own default. Both helpers had no test coverage at all; they now do, for every CLI.
  - **Env allowlist gains only the `PI_*` prefix.** Pi's ~34 provider key vars share no prefix and `ALLOWED_ENV_PREFIXES` is one global list with no mode context, so admitting them would widen the allowlist for every mode at once. Users authenticate via pi's `/login` or the server process's own environment.
  - **Pi stays out of `isAltScreenStripMode()`.** Its default TUI renders into the main screen with terminal-owned scrollback and is mouse-aware, so it consumes `\x1b[3J` and the mouse DECSETs that the full strip removes, unlike an Ink TUI repainting in place. Note what exclusion does NOT do: pi is tmux-backed, so it still falls through to the narrow `isMuxAltScreenOnlyStripMode()` strip and its alt-screen toggles are dropped either way. Pi's runtime-switchable fullscreen TUI therefore paints into the main buffer, exactly like vim inside a tmux `shell` session.
  - **Docker**: pi installs in its own `--ignore-scripts` step so that flag cannot affect the other four CLIs, and its credentials are seeded per-file (`auth.json`, `settings.json`, `trust.json`, `models.json`, `models-store.json`) rather than whole-dir, since `~/.pi/agent` also holds sessions, extensions and installed package trees.
  - **Local echo**: pi lands on the buffer overlay. Verified that codex's per-keystroke starvation does not reproduce: pi's slash picker re-filters on the whole composer content, so a one-shot flush behaves identically to per-keystroke typing.
  - **Mode-list parity**: pi is excluded from the Ralph tracker auto-enable on `POST /api/sessions/:id/interactive` (like every other external CLI, whose output the tracker never parses), carries a `REMOTE_CLI_BIN` entry so a remote-SSH pi session reports its CLI version, and gets its own badge in the desktop home rail instead of rendering like Claude. The packaged agent skill's mode enumerations list pi too, and it now documents the per-CLI availability probes (`GET /api/<mode>/status`) that agents should check before spawning a worker on a backend the server may not have installed. Both are pinned by a new guard that derives the mode set from the Zod schema instead of restating it.
  - **`codeman doctor` and the run mode agree about pi.** The registry entry resolved a bare `which pi` while `pi-cli-resolver` demanded semver output, so the Dependencies panel could report an installed Pi CLI that sessions refuse to launch. Both now share one exported regex, and the registry's new `requireVersionMatch` reports a non-semver `pi` as missing rather than installed. Only pi sets it; every other tool keeps its existing behaviour.
  - Installer detection, docs (`docs/pi-integration.md`), READMEs, and the architecture invariants are updated. Tests: `test/pi-mode.test.ts` and `test/routes/external-cli-bypass-clamp.test.ts`, plus extensions to the run-mode, mobile-overview, render-index-html, system-routes and local-echo suites.

## 1.17.0

### Minor Changes

- Agent skill rework, session lineage lines, and a sharper endpoint drift guard.

  **The packaged agent skill is rewritten around learning it, not just being correct** (`skills/codeman/`, ~2000 lines changed across four files). It previously opened with about fifty lines of credential archaeology before a single working call, and interleaved every recipe with the rationale for its own warnings.
  - `SKILL.md` is restructured into: a 12-line "Hello, worker" that runs as written, a verb table an agent can act correctly from without reading anything else, a ten-line rules digest, the safety rules, the recipes, and setup/credentials last.
  - **The preamble is no longer re-pasted.** A bootstrap writes it once to a `$HOME`-derived 0600 file and later calls source it and check a version stamp. Shell state does not survive between tool calls, but the filesystem does. The stamp is the last line written, so a truncated file leaves it unset and the guard aborts instead of running a half-written preamble.
  - **New: where to spawn.** The only documented spawn used to create a scratch case, so "spin up workers on this repo" led an agent to do correct-looking work in the wrong directory. The rule is now explicit: hooks (and therefore `stop`/`blocked`) exist only where Codeman created the directory, so a linked case or a raw `workingDir` must synchronize on output markers. `wait:true` is still accepted there and silently degrades to a heuristic `idle`, which is documented as its own trap.
  - **New verbs**: interrupt a runaway worker with ESC instead of deleting it, `active-tools` and `run-summary` as structured liveness signals, `auto-resume` for usage limits, the workspace as a high-bandwidth channel, and `GET /api/events` as a fleet watcher.
  - `reference/messaging.md` gains a fleet protocol for Claude Code cross-session messaging: peer refs are injected and never discovered (a worker calling `ListAgents` sees the user's real sessions), every message costs a billed turn in both sessions, plus review pairs, mid-task questions, relay chains, mixed fleets, and their failure modes.
  - `reference/recipes.md` is renumbered to a flat Flow 1-7 and gains Flow 7, one whole job start to finish: worktree fleet, tasks, gather, a review pass, report, cleanup.
  - `reference/endpoints.md` gains an auth section, a symptom gallery keyed on what you actually see in the JSON, and a consolidated limits table.
  - **Corrections found by auditing the old text against source**: the input cap is 65536 characters and not 100000 (65537-100000 passes Zod then 400s at the route); `wait.ended` is returned by a _live_ session whose write did not land, so "the session is gone" was wrong recovery advice and `delivered:false` is the discriminator; `DELETE /api/subagents` clears the map rather than killing anything; the trust-dialog auto-accept reads the rendered pane, not the output stream; `claudeMode` is readable globally though not per session; `run-summary` is envelope-wrapped (`.data.summary`); `active-tools` is not empty for `shell` mode; and a session does inherit the server's `CODEMAN_PASSWORD`.

  **Session lineage lines** (`sessionLineageLines`, per-device, desktop default on). A create request may name the session that spawned it, as a `parentSessionId` body field on `POST /api/sessions` and `POST /api/quick-start`, or as an `X-Codeman-Parent-Session` header, and the web UI draws an arc from the parent's tab to each child's. The skill's preamble sets the header once, so every spawn recipe carries it. The value is **resolved rather than trusted**: exact id or a unique prefix of at least eight characters (ids reach agents truncated), it must be a live session the caller can see with the same owner, and anything unresolvable is dropped rather than returning a 400, so a cosmetic field can never fail a worker spawn. It confers no permission and no lifecycle meaning. Rendering is an additional layer on the existing connection-line pass, sharing one batched reflow; desktop only, because the mobile header would bury the overlay.

  **The endpoint drift guard now covers routes it silently could not see.** `test/agent-skill-endpoints-doc.test.ts` matched only bare `app.<method>('path')` registrations under `src/web/routes/`, so routes registered on the server itself (`/api/events`, `/api/events/subscribe`) and any registered with Fastify generics (the approvals routes) were unverifiable. It now scans `server.ts` too and tolerates generics, taking it from about 200 to 216 recognized routes.

## 1.16.6

### Patch Changes

- Phone home screen now shows session ages, plus three mobile input fixes.

  **Phone overview: started / how long stamps.** Every live session row on the "C" home screen carries a third line: when the session first started, and how long it has been in the state it is in ("started 3d ago · idle 12m"). Idle, waiting, error and ended states measure from the pane's last output, which for a Claude pane sitting at its composer is exactly when the turn ended; a WORKING session measures from its last Enter instead, because a running pane repaints about once a second and would otherwise report every turn as 0m. A 20s clock rewrites the values in place rather than re-rendering, so no row's blink or pulse restarts.

  **Fix: a recovered session was restamped as new on every restart.** Boot recovery never passed `createdAt`, so each server start reset it to `Date.now()` and a week-old pane reported "created 2m ago" (and sorted as the newest thing in the unified session list). It now comes from the tmux session's own birth time, which mux-sessions.json already carried. The desktop home rail's "created" stamp is fixed by the same change.

  **Fix: a selection dialog locked the on-screen keyboard out of the terminal (regression in 1.16.5).** The check that decides whether a tap belongs to the TUI scanned the whole viewport for a numbered menu, so while a Claude question or permission dialog was on screen EVERY tap in the terminal counted as actionable and blurred the input. The keyboard could not be opened at all until the dialog was answered, which left tapping an option, the one gesture that commits an answer, as the only interaction a phone had. The menu test is now row-local: the dialog's own rows still report the tap and keep the keyboard down, while the question title, the transcript and blank space summon the keyboard so a digit can be typed at the dialog instead of aimed at it.

  **Fix: the accessory bar's arrow keys bypassed the local-echo overlay.** On a phone the text you type is buffered in the browser and has never reached the PTY, so an arrow tapped on the bar arrived at a composer the CLI still considered empty: Up recalled a history entry into it while the overlay went on painting the draft over the same row and still believed it was pending, and the next Enter submitted the two mixed together. The four arrows now flush the draft first and hand the session to plain PTY echo, the same contract a nav key typed on a hardware keyboard has had since #218. The CLI stashes the flushed draft, so Down brings it back. Tab now shares that one flush helper instead of its own copy.

## 1.16.5

### Patch Changes

- Mobile keyboard dismissal, and a tidier Save/Close pair in the phone settings sheet.

  **The on-screen keyboard can finally be closed from inside the app.** The terminal
  keeps focus on a hidden textarea and nothing ever released it, so once the keyboard
  was up it covered roughly half the screen with no way out but the OS back gesture.
  Two gestures now dismiss it:
  - **A tap outside the terminal** (header, tab strip, empty page chrome). Deliberately
    narrow: it only fires while the terminal input actually holds focus, never inside
    the terminal (tap classification owns that decision), and never on a control, since
    anything focusable is about to take focus itself and the keyboard accessory bar
    exists to be used _while_ the keyboard is open. A scroll ends in `touchend` too, so
    finger travel is tracked from `touchstart` and only a near-stationary gesture counts
    as a tap, sharing the terminal's own 8px threshold so both agree on tap-vs-scroll.
    Scrolling to read something mid-compose no longer drops the composer.
  - **A second tap on inert transcript content.** Every terminal tap used to re-focus,
    which left the accessory bar's chevron as the only way out. Scoped to inert rows on
    purpose: the prompt row keeps focus-then-position, so a second tap there still
    places the caret, and actionable rows (readbacks, `esc to interrupt` status rows,
    menu selections) still blur as before.

  **Settings sheet header on phones.** Below 860px Save moves into the header, which
  left the two ways out of the sheet as a fat accent pill beside a bare glyph. Save and
  Close now share a recessed tray with matching 36px pill geometry, reading as one
  44px cluster the height of the phone header. Tray colors come from skin tokens, so
  the light skins keep their look, and the tray stays off the sheets that carry a lone
  close button.

  Also fixes a test that could never have caught a regression: the case asserting that
  tapping a control does _not_ dismiss the keyboard was picking a button from the
  hidden welcome overlay, whose rect still measures while the hit-test lands on the
  terminal underneath, so it passed for the wrong reason and stayed green even with the
  exemption deleted. All four guards in the dismiss handler are now individually
  pinned.

## 1.16.4

### Patch Changes

- **Voice dictation through your Claude Code login (no API key).** The mic button can now transcribe using this machine's existing Claude Code subscription, via the same speech-to-text service the CLI's own `/voice` mode uses. Off by default (`claudeVoiceEnabled`, synced): turning it on spends the server owner's Claude subscription on transcription for anyone who can reach the UI. The OAuth token never leaves the server process, credentials are read-only (Codeman never refreshes them, which would rotate the refresh token out from under the CLI), streams are capped at 5 minutes and 4 concurrent, and the WebSocket carries the same allowed-Host + same-site Origin guard as the terminal socket. A new Speech engine picker (Auto / Claude / Deepgram / Browser) sits alongside the existing Deepgram and Web Speech paths, which are untouched.

  **One settings surface.** Session Options and Add Case now use the same `set-*` chrome as App Settings instead of the old modal-tab chrome, with a left rail, grouped rows, per-group device/synced scope badges and a search box. App Settings leads with version + update; the Session Options rail stays a real switcher (one section at a time) because Summary and Respawn are each long enough to bury the other. Collapsed Add Case blocks gained a disclosure chevron.

  **Read My Mind: rethink steer note (phase 3 part 2).** Rethink now carries an optional free-text note ("no, I meant the mobile bug") sent as `steer`, the highest-authority signal the predictor gets. It stays in the field across re-runs, clears on each open, and the empty-result copy points at it. The modal footer moved to the styled `btn-toolbar` convention; the bare `btn btn-*` classes it shipped with match no CSS in this codebase and rendered as unstyled browser buttons.

  **Mobile terminal taps no longer fight the keyboard.** Taps on TUI-owned rows (expandable readbacks, tool results, decision menus, the working/status row) now act on the CLI without popping the keyboard, while a tap on inert transcript text keeps the keyboard reachable. Rows are told apart by the affordance the CLI prints (`ctrl+r to expand`, `tap to collapse`, `esc to interrupt`) rather than by row titles, which vary per CLI and per version. A tap with the viewport scrolled up sends no mouse report at all but still restores focus, so the keyboard is reachable after every tab switch. Thanks to @Lint111.

  **Path labels abbreviate `$HOME` on both platforms.** The "show `~/project`" rule had three implementations and two were platform-specific in opposite directions: the Run menu's matched `/home/<user>/` only, so on macOS every Recent Sessions row spent its first ~19 characters on an identical `/Users/<user>/` prefix and ellipsized away the tail that identifies it (#273); the case-manage list's matched `/Users/<user>` only, so no Linux case path was ever abbreviated. Both now route through one helper, with a static guard against a fourth copy appearing.

  **Run menu Recent Sessions rows are legible.** Rows now read as folder, worktree pill, dimmed parent path, timestamp, with only the parent path allowed to shrink, so truncation can never hide which project (or which worktree) a row refers to. `<repo>/.claude/worktrees` is dropped from the parent path as noise. Thanks to @jordan8037310. Follow-up fix: the widened menu was not actually usable by its rows, since `.run-mode-history` is a block scroller and its `<button>` rows stayed shrink-to-fit at ~250px inside a full-window-width menu; rows now fill the menu and it is capped at the 760px one full row costs.

  **Desktop home screen** no longer clips, and shows full tab names.

## 1.16.3

### Patch Changes

- Session rows that name their worktree, a shell keyboard bar for phones, App Settings as one scrolling document, and the Read My Mind modal on phones.
  - **#265 / #266**: a past session whose directory no longer exists used to report
    `$HOME` as its working directory, because history rows reconstructed a path by
    stat-walking the filesystem and fell back to `$HOME` when nothing resolved.
    Deleting a worktree is the normal end of its life, so every past worktree
    session collapsed onto the same indistinguishable row. History rows now read
    the literal `cwd` Claude Code stamps on its own records, out of buffers the
    scanner had already loaded, so it costs no extra file reads and survives the
    directory being removed. Sessions that ran in a worktree also carry a
    `⑂ name · branch` pill in the Resume list and the Cmd+K session manager, and
    both are searchable by worktree name and branch. Measured on a real install:
    the cwd was recoverable for 215 of 216 transcripts, 212 of them from the first
    16KB, and 28 rows that previously read `$HOME` now report their real path.
    Reported and implemented by @jordan8037310.
  - **#262**: a shell session now gets its own mobile accessory bar
    (`Ctrl · Esc · Tab · ↑ · ↓ · ← · → · Paste · ⌄`), with Ctrl as a one-shot
    modifier: tap it, and the next character goes out as its control byte. That
    puts Ctrl+C/D/Z/R/L/A/E/W/U/K on a nine-button bar without a button per chord.
    The modifier is applied on the CJK input path too, where the textarea owns the
    keyboard and an armed modifier could previously neither fire nor be spent, so
    it survived until a later keystroke and turned that one into a control byte.
    Agent sessions keep the existing bar unchanged. Proposed by @DodgyBadger.
  - **#257**: with several tabs open on a phone, the rightmost ones could not be
    reached. Selecting a tab never scrolled the strip, and every ambient rebuild
    reset `scrollLeft` to 0, so a strip the user had just swiped snapped back a
    moment later. Reported by @DodgyBadger.
  - **App Settings** is now a left rail acting as a table of contents over one
    scrolling document instead of 8 tabs that wrapped onto two rows. Nine sections,
    all mounted at once, so find-in-page works across the whole thing. The model
    controls stop contradicting each other: the base model lives on cards and "1M
    context window" is a switch that composes onto it, retiring the old pair of
    settings that each claimed precedence over the other.
  - **Read My Mind** suggestions beyond the first are no longer discarded. The
    alternates render as tappable rows with their kind badge, tapping one swaps it
    into the editable field without losing an in-progress edit, and Rethink now
    records the whole shown set as rejected. The modal is sized for phones and
    reachable from the phone keyboard bar.
  - The desktop welcome screen carries the open tabs as a rail docked to the left
    edge, with created and last-active stamps refreshed in place.
  - The README now documents cloning a GitHub repository straight into a case
    (**Add Case → Clone Repo**), which shipped in 1.16.2 but was only described in
    the architecture docs.

- 5d42f64: Home screen: make the past-conversation list usable, and let search find past sessions.
  - **#260**: "Resume Conversation" showed 4 rows and then dumped every remaining
    one into a fixed 240px box, with no ordering or filtering. The list now opens
    with 10 rows, "Show more"/"Show less" grows and shrinks the box itself (the
    height cap is class-driven instead of fixed), and the header carries a filter
    box (matches name, folder, `#case` label and the conversation's prompts), a
    sort control (recent / name A–Z / folder A–Z, pinned rows still first) and a
    shown-of-total count. Filtering implies expansion, so every match is visible.
  - **#261**: the search box could not match a past project by folder name: its
    session corpus was the live in-memory map, while past sessions come from
    `/api/sessions/unified`. Search now also harvests a bounded snapshot of that
    unified list, refreshed OUTSIDE the request path (published by
    `/api/sessions/unified`, plus a fire-and-forget rebuild when stale), so the
    search path keeps its no-filesystem-reads property. Results for a closed
    session resume the conversation instead of trying to select a tab that no
    longer exists, and are badged `RESUME`. In multi-user mode the snapshot is
    re-scoped per row on read, matching what `/api/sessions/unified` exposes.

  Reported by @jordan8037310.

## 1.16.2

### Patch Changes

- Clone a Git repository straight into a case, predict the prompt you were about to type, and point a session at a separate Claude account.

  **Clone Repo (#251, proposed by @DodgyBadger in #236)**: Add Case gains a **Clone Repo** tab that clones a repository into `codeman-cases/<name>` and registers it as a normal local case. A live verdict under the URL field answers, while you type, whether the URL is cloneable without credentials, what its default branch is, and which branches and tags exist (`POST /api/cases/clone-preflight` behind `git ls-remote --symref`). The case name fills in from the parsed repo, refs come from the remote as a datalist, shallow clone is optional, and a Brain picker (installed CLIs only) points the Run button at the agent you chose. Starting a session stays opt-in, and the tab hides itself when the server has no `git`.

  **Every settings writer now refuses to write through a symlink (from the #251 review, affects existing cases too)**: case contents can be foreign, and a repository can ship `.claude` or `.claude/settings.local.json` as a symlink pointing anywhere on this machine. Since `writeFile` follows links, a scaffold write could land outside the case, up to and including replacing your own `~/.claude/settings.json`. All seven writers that touch a case's `settings.local.json` (`writeHooksConfig`, `ensureCodemanHooks`, `refreshStaleCodemanHooks`, `updateCaseModel`, `updateCaseEnvVars`, `stripCaseEnvKeys`, `applyStatusLineConfig`) now go through one `withSafeSettingsWrite()` gate that runs the symlink check inside the per-path settings lock. A refusal is a warning rather than a throw, so hooks degrade to output-based idle detection instead of failing the operation. If you have deliberately symlinked a case's `.claude` or its `settings.local.json`, Codeman will now decline to write there and say so; replace the link with a real file or directory to get hooks, model and statusLine writes back.

  The clone endpoint (`POST /api/cases/clone`) is synchronous by design: no job store, no polling, bounded by `GIT_CLONE_TIMEOUT_MS` (default 5 minutes). Security decisions live in a pure half of `src/git-clone.ts` so each is unit-testable without spawning anything: `<name>::<payload>` transports are refused as a family (any of them dispatches to a `git-remote-<name>` helper, which turns a clone into arbitrary command execution), a leading `-` is refused and `--` precedes every operand, argv arrays are used rather than a shell, URLs carrying credentials are refused, and non-interactive means more than `GIT_TERMINAL_PROMPT=0` (empty `GIT_ASKPASS`/`SSH_ASKPASS`, `SSH_ASKPASS_REQUIRE=never`, empty `DISPLAY`, `GCM_INTERACTIVE=never`, `ssh -oBatchMode=yes`), since with the request held open any one of those left open is a hang instead of an error. Timeouts signal the process group, because `git clone` fans out into `git-remote-https`/`index-pack` and SIGTERM to the parent alone can leave the fetch running. Repository contents beat scaffolding: an existing `CLAUDE.md` is kept, hooks merge into whatever `.claude/settings.local.json` the repo shipped, and a repo shipping its own `.claude/settings*` is reported back as a warning, because those hooks run locally as soon as a session starts.

  **Read My Mind phase 2 (#256)**: phase 1 (1.16.1) gave each case an intent profile; this turns it into the feature as pitched. Press 🧠 on a Claude session and Codeman predicts the prompt you were about to type, from your stated goals, your recent prompts in your own voice, the last assistant reply, tool activity, git state, away context, sibling sessions, and any dialog the session is waiting on. The context assembler is pure and budgeted with trust tiers, so user-stated intent outranks observed content and terminal output alone can never justify a suggestion. One shot at opus (`readMyMindModel` overrides), a strict JSON contract, and 1 to 3 suggestions typed continue / verify / redirect. The modal keeps the suggestion editable: Send, Insert (drops it on the composer without Enter), Rethink (rejections feed back into the next attempt), Dismiss. Nothing is ever auto-sent, the click is the boundary. Opt-in via App Settings, Panels (synced, default OFF), desktop header only. Agents get the same verb through the Codeman skill (`POST /api/sessions/:id/readmymind`).

  **Per-session `CLAUDE_CONFIG_DIR` (#255, designed and specified by @jordan8037310)**: `schemas.ts` gains an exact-key tier (`ALLOWED_ENV_KEYS`) beside `ALLOWED_ENV_PREFIXES`, admitting `CLAUDE_CONFIG_DIR` so a case can run on a separate Claude subscription (client-billed accounts). Exact match only: other `CLAUDE_*` keys and near misses like `CLAUDE_CONFIG_DIR_EXTRA` stay rejected, blocked keys stay blocked. The key survives `getEnvOverridesForPersist()` because it is a path rather than a secret, and dropping it would silently switch a rebuilt session back to the default account after a reboot. Caveat worth knowing: a relocated config dir writes transcripts outside `~/.claude/projects`, so the response viewer, subagent windows, ultracode panel and Read My Mind go blind for that session unless `projects` is symlinked back into the shared tree.

## 1.16.1

### Patch Changes

- 161f1da: Read My Mind phase 1: per-case intent profiles (docs/readmymind-plan.md). Codeman can now capture the prompts a user actually submits (from the Claude session transcript, opt-in via the new synced readMyMindEnabled setting, default OFF) into a per-case intent profile alongside user-stated goals, stored in ~/.codeman/intents.json (mode 0600, never searched). New endpoints GET/PUT/DELETE /api/sessions/:id/intent (ownership-scoped, strict schemas), a transcript:user_prompt event on TranscriptWatcher, and agent-skill coverage (SKILL.md recipe + endpoints.md rows) so agents can read and record the user's intent. Groundwork for the phase-2 predictor button: nothing is ever auto-sent.
- Home screen and phone touch targets.

  The desktop welcome screen now lists your open tabs as a vertical column down its left gutter, which was previously dead space: one row per live session plus any saved web tabs, in tab order so the row badges match Alt+1..9, with case, backend and state on each row. Clicking a row enters that session. The column is width-gated (1180px and up) and never moves the centered welcome content.

  Working state now reads the same everywhere it appears. A busy session shows a pulsing green dot ringed by the same spinner a tab draws while it loads, with a green halo, on the desktop home column, the phone home screen and the tab strip alike. Phone tabs got the bigger 9px glowing dot for the same reason.

  Phone touch targets: the brand "C" that returns you to the home screen was roughly a 12x13px hit area, well under the 44px minimum. It is now a real 44x44 button, and the phone header grew from 36px to 44px to make that possible, which gives every other header control the same 8px. The simple keyboard accessory bar also swaps /clear for Tab (/clear and /compact stay in the extended bar), flushing locally buffered text to the terminal first so completion applies to what you just typed.

## 1.16.0

### Minor Changes

- Approvals Inbox, truthful idle detection, a revived trust-dialog auto-accept, and an unmistakable offline state.

  **Approvals Inbox (#245, opt-in, default OFF)**: one cross-session inbox for every prompt that is waiting on a human (permission dialogs, AskUserQuestion questions, idle prompts). Enable "Approvals Inbox" in App Settings -> Panels (synced setting `approvalsInboxEnabled`); until then no new UI renders anywhere. Desktop gets a header bell (visible only while something is pending, with a count badge) opening a drawer of cards answerable in place: session, tool/message summary, the captured dialog frame, and one button per parsed dialog option (fallback: Approve / Deny-Esc). The phone overview's NEEDS YOU rows gain compact answer strips, and push notification action buttons were fixed along the way.

  **Sessions no longer report idle while working (#246)**: every working Claude session flipped to `status: "idle"` about two seconds into its turn, and tabs, notifications, respawn and the phone overview all read that bad value. The `❯` prompt redraws throughout a turn, so readiness now requires a sustained repaint streak plus a capture-pane probe that recognizes the live working line (`✻ ... (Xs)`), and the UI shows a working state you can actually see.

  **Workspace trust dialog auto-accept has been dead and now works (#249)**: a session started in a directory Claude had not seen before sat on the workspace-trust dialog until a human pressed Enter, because tmux delivers cursor-forward sequences rather than spaces. Detection now goes through the capture-pane text added in #246 and the dialog is answered reliably.

  **A dead connection is unmistakable instead of a red dot (#248)**: the service worker serves the cached app shell, so opening Codeman with nothing reachable rendered a normal-looking empty dashboard with only an 8px red header dot as a clue. Now a connection-loss overlay (retry button, server host, actionable hints) plus a persistent banner make the state obvious on desktop and phone, and clear the moment the server answers again.

- 1e1db94: Cross-session messaging integration, two halves. **Workers now carry their Codeman session names as messaging peer names**: local claude spawns pass `--name <session name>` when the installed CLI is 2.1.224+ (the cross-session-messaging release). The gate is fail-closed, since an older claude aborts startup on an unknown option: an unknown or older version yields a spawn command byte-identical to before, the value is allowlist-sanitized before shell interpolation, and docker/remote spawns never carry the flag (their CLI is not the probed binary). Verified end to end on an isolated instance: the worker lists as its session name in `ListAgents`, and its replies arrive tagged `from-name="<session name>"`.

  **The Codeman agent skill teaches cross-session messaging**: drive claude workers over `ListAgents`/`SendMessage` where available, map rows to Codeman sessions via the `tmux codeman-<id8>` column, deliver multi-line exactly-once task messages (including mid-turn steering), collect results as latched replies instead of polling, and fall back to the HTTP recipes whenever the feature is absent (version, feature flag, telemetry-disabling env vars, Docker/remote cases, non-claude modes). Adds `reference/messaging.md` (ships automatically, the installer enumerates `reference/*.md`), fan-out Flow 5 in `reference/recipes.md`, troubleshooting rows in `reference/endpoints.md`, and safety rules for the shared peer namespace (message only workers you created, no permission laundering in either direction). All mechanics verified live against claude-cli 2.1.226.

### Patch Changes

- c50bb02: The File Viewer can show hidden files and folders.

  `GET /api/sessions/:id/files` has always accepted `showHidden=true`, but the panel
  hardcoded `showHidden=false`, so dot-prefixed entries were unreachable from the
  tree: no `.gitignore`, no `.github/`, no `.env.example`, and nothing under them.
  Opening one meant guessing its path.

  The panel header gains a `.*` toggle. It re-fetches rather than re-rendering the
  cached tree, because the filtering happens server-side, and it keeps the expanded
  directories so toggling does not collapse the tree you just navigated. The state
  is per-device (its own `codeman:fileBrowserShowHidden` key rather than the
  app-settings object, which is rebuilt from the settings-modal DOM on save and
  would drop a key toggled from outside it), defaults to OFF, and survives a reload.

  Generated and version-control directories (`.git`, `node_modules`, `.next`,
  `.venv`, ...) stay excluded either way: that list is about tree size, not about
  hiding dotfiles.

  Closes #221.

- ce22c2a: The filesystem path picker can show hidden files and folders, and the shared secret blocklist grew to make that safe.

  The picker behind Link Existing's "Browse" and the mobile keyboard's `Path` key
  refused every path with a dot-prefixed segment, so `.github/workflows/ci.yml`
  could not be selected and a hidden folder could not even be opened. It now has
  the same `.*` toggle as the File Viewer, default OFF, per-device, and it applies
  to both the listing and the preview endpoint (which re-resolves the path
  independently).

  That filter was quietly doing security work. With every hidden path unreachable,
  `isSensitivePath` never had to name the credentials that live in dot-directories,
  because the picker's roots include Home. Lifting the filter removes that
  accident, so the blocklist now covers them explicitly: SSH keys at any depth (not
  only under `$HOME`), GPG keyrings, AWS/GCloud/Azure/Docker/Kubernetes
  credentials, npm, Yarn, git, `gh`, netrc, PyPI, RubyGems, Cargo and Terraform
  tokens, `.pgpass` and `.my.cnf`, and the Claude and Codeman agent credentials.
  `~/.codeman/` and `~/.claude/` stay attachable as trees, since the publish skill
  and the review-card loop read from them; only their secret-bearing members are
  named.

  Blocked trees, sensitive files, root confinement and symlink-escape checks are
  all unchanged and still apply with the toggle on: a hidden entry that resolves
  to a secret is dropped from the listing, and opening it is refused.

  Follows #221.

## 1.15.0

### Minor Changes

- 55bff4a: Zero-lag predictive echo for Codex sessions (mosh-style write-through prediction).

  Codex's per-keystroke composer forced 1.12.2 to disable the local-echo overlay (issues #218/#219/#220/#222), leaving Codex typing at full round-trip latency on remote links. This release adds a second echo mode instead of re-enabling the first: every keystroke still goes to the PTY exactly as before (byte-identical wire behavior, pinned by vm-level and end-to-end trace-equality tests), while the new `PredictiveEchoAddon` in `xterm-zerolag-input` 0.2.0 paints the predicted glyph at the predicted cell. When the real echo lands, the prediction is confirmed and its span removed (an invisible swap); mispredictions self-heal via a two-pass mismatch cascade and a TTL.
  - Reconciliation reads the parsed terminal buffer, never the raw stream: full-line redraws, ECH gap painting and tmux's in-place deltas all converge to the same cells. Confirmation requires the cell match PLUS a cursor advance, so placeholder glyphs and identical repaints never false-confirm; blank cells are neutral (codex clears its placeholder on the first echo).
  - Predictions paint only while the cursor sits on the measured Codex composer row (`/^› /`, codex-cli 0.147): trust/approval modals and wrapped continuation rows get no ghosts, deliberately falling back to real echo.
  - Ships as a SEPARATE `vendor/xterm-predictive-echo.js` bundle: the existing zerolag bundle is byte-identical (sha256-verified), and a missing or broken bundle degrades Codex to exact 1.12.2 behavior. The per-device `localEchoEnabled` toggle is the kill switch.
  - Claude/Gemini/OpenCode/Antigravity keep buffer mode untouched; shell stays off.
  - A post-build adversarial review added the anchor-hold rule: after an unpredicted wire edit (backspace into echoed text, cleared input, IME text commits) new predictions hold until the next parsed write, so a stale displayed cursor can never mis-anchor a run.
  - Tests: 55 new package tests including replay suites driven by fixtures recorded from a real codex TUI through the production tmux+strip pipeline (`scripts/dev/record-codex-frames.mjs`) and a 500-iteration seeded fuzz; new vm policy/wire-neutrality suites; a 10-scenario Playwright E2E against real codex covering the #218/#219/#220/#222 retests, byte-identity, and a simulated 300ms-RTT run. The package test suite now runs in CI.

### Patch Changes

- Agent-skill hardening, plus a fix for the mobile browser suite.

  ## The Codeman agent skill

  Twelve issues found by auditing the skill against a live instance, and fixing them meant measuring things rather than reasoning about them.

  **Readiness now works in every permission mode.** The ladder matched `bypass`, which is the status bar of only ONE mode. Measured one pane per mode against claude-cli 2.1.226:

  | how Codeman spawned it                     | statusline              | `shift+tab` | `bypass` |
  | ------------------------------------------ | ----------------------- | ----------- | -------- |
  | `--dangerously-skip-permissions` (default) | `bypass permissions on` | yes         | yes      |
  | `--permission-mode auto`                   | `auto mode on`          | yes         | no       |
  | `--allowedTools …`                         | `don't ask on`          | yes         | no       |
  | neither (`normal`)                         | `don't ask on`          | yes         | no       |
  | `--permission-mode plan`                   | `plan mode on`          | yes         | no       |

  Every mode ends `(shift+tab to cycle)`, and the `claudeMode` setting is not exposed on `GET /api/v1/sessions/:id`, so there was nothing to branch on. The ladder matches `shift+tab` now: universal, and space-free, which is what makes it survive the TUI stream. A non-default worker used to be reported broken after burning the full budget. ⚠️ The `+` means it only works through `--data-urlencode`; a hand-built query silently searches for `shift tab`.

  **`.status` is documented as unreliable in both directions.** Measured on a live worker reading `idle` while mid-turn and actively producing output, with `lastActivityAt` equal to the moment of the call. A worker that dies inside its pane also reads `idle`. Synchronize on `stop` or an output marker; to judge from outside, sample `terminal?tail=` twice and compare.

  **The self-delete guard is fail-closed.** Documented in 1.14.2; the reference files and every recipe now route through it consistently.

  **Reads work on macOS.** The ANSI-strip pipelines used `sed 's/\x1b…'`, and BSD sed has no `\xHH` escape, so on macOS they silently stripped nothing and handed the agent raw ANSI.

  **Injection is atomic and no longer silent.** `installAgentSkillInto()` wrote each file with a bare `writeFile`, so two sessions created concurrently in one repo could leave a reader observing a truncated SKILL.md; writes now go through temp+rename under the same lock every sibling mutator uses. And both server call sites discarded the outcome, so a `foreign` refusal (a user-authored skill is present) or a `symlink` refusal was invisible: turning the setting on, seeing nothing, and having no way to find out why. Refusals are logged now; injection stays best-effort and still cannot fail session creation.

  **Reference corrections**: the `FORBIDDEN` 403 row and which auth responses are plain text rather than the JSON envelope, the input size cap, the undocumented `killMux` parameter on DELETE, and the fact that zero, negative and non-integer timeouts are rejected with a 400 rather than clamped.

  **README.zh-CN.md taught a recipe that could not work**: its input example had no trailing `\r`, so Enter was never sent and the prompt sat unsubmitted, and its read step used `/output`, whose `textOutput` is always empty for interactive sessions. Its agent section is now in line with the English one. CLAUDE.md's single-line gotcha also gained the `\r` rule.

  **Tests**: the `codeman skill install`/`uninstall` CLI had none, including the linked-case resolution shipped in 1.14.2; the `POST /api/sessions` injection call site was never exercised because the shared route mock hardcoded the gate off; and nothing guarded `reference/endpoints.md` against drifting from the routes it documents. All three covered now.

  ## Mobile browser suite

  The suite drives a real browser against a server started from TypeScript source, so it serves `src/web/public`, while `npm run build` puts the xterm vendor bundles in `dist/web/public`. Without them every `/vendor/xterm*` request 404s, `Terminal` is never defined, and every test touching `app.terminal` dies on a null. A `pretest:mobile` step now prepares them.

  Hardened after two review rounds, each defect reproduced: the freshness cache trusted mtime alone, so a bundle left without its alias tail (or truncated by an interrupted `npm install`) was reported "up to date" forever while the suite died on `LocalEchoOverlay is not defined`; it now verifies content and size, and repairs what an earlier run poisoned. Builds go to a temp file private to the run and rename into place, so a partial write can never be published and two concurrent runs cannot corrupt each other. Temps whose owning process is gone are reclaimed, and only those. Freshness tracks every input the bundle derives from, not just the entry, so editing a sibling of the addon no longer leaves the suite testing a stale overlay. `npx` runs with the repo as cwd, so it uses the pinned esbuild instead of fetching an unpinned one.

## 1.14.2

### Patch Changes

- Four reported bugs fixed, and the Codeman agent skill from 1.14.1 gets its first published build with the fixes below alongside it.

  ## The Codeman agent skill

  Introduced in 1.14.1 and the headline of this line. `skills/codeman` is a Claude Code skill that lets an agent running **inside** a Codeman session drive the HTTP API: start worker sessions, send them prompts, block until they finish, read their answers and clean up. It ships in the npm package and self-gates, so outside a Codeman session (`CODEMAN_MUX` unset) it refuses to act and costs unrelated sessions nothing.

  ### Installing it

  ```bash
  codeman skill install                  # ~/.claude/skills/codeman, every new Claude Code session sees it
  codeman skill install --case myproject # just that case; linked cases resolve by name too
  codeman skill uninstall                # reverses either one
  ```

  Or turn on **App Settings > Agent Skill** (`agentSkillEnabled`, synced, default off) and Codeman injects the skill into each case when a Claude session is created there.

  Installs are marker-owned: a `skills/codeman` that Codeman did not write is never touched, a stale managed copy is refreshed in place, and a symlinked skill directory is refused rather than written through. Re-run `codeman skill install` after upgrading to refresh the copy. Turning `agentSkillEnabled` back off does **not** remove already-injected copies, because a create-time sweep would yank the skill out from under other live sessions sharing that `.claude/` directory; remove them per case with `codeman skill uninstall --case <name>`.

  ### Using it

  Ask for orchestration in plain language ("spin up three workers, have them lint, typecheck and test in parallel, then report back") and the skill supplies the guard, the safety rules and the recipes. The flow it runs:
  1. **Guard.** Re-runs a preamble on every shell call that refuses outside `CODEMAN_MUX=1`, reads `CODEMAN_API_URL` and `CODEMAN_SESSION_ID`, recovers a password from the data dir `.env` or the install's service definition if one is set, and defines a fail-closed `delete_session`. It re-runs it every call because shell state does not survive between an agent's tool calls.
  2. **Start a worker** with `POST /api/v1/quick-start` (`mode` is any of `claude`, `shell`, `opencode`, `codex`, `gemini`, `antigravity`), checking `.success` before reading `.data.sessionId`.
  3. **Wait until it is really ready.** A new session reports `idle` before its CLI has spawned, and a brand-new case shows a trust dialog first, so the skill waits for the composer's own status bar and treats the dialog as a bounded fallback.
  4. **Send and wait in one call**: `wait`/`waitTimeout` on `POST /api/v1/sessions/:id/input`. It registers the waiter before typing, closing the race where a separate wait reports the previous turn's idle state as this turn's answer. For `claude` workers it resolves on the `stop` hook, usually within seconds.
  5. **Read the answer** from `GET /api/v1/sessions/:id/last-response`, which returns clean transcript text rather than a screen scrape.
  6. **Clean up** with `delete_session`, for ids it created and nothing else.

  Hook-less modes (`shell` and the external CLIs) have no `stop` signal and coarse lifecycle transitions, so the skill synchronizes those with a unique split marker and `wait-output ... from=buffer`. Worked fan-out flows, the per-mode signal table, error codes and the Docker/remote caveats live in the skill's `reference/` files, loaded on demand.

  ### The rules it encodes

  Each of these silently wastes a run, which is why they are written down: every input must end with `\r` or Enter is never sent; input is single-line; a wait timeout is HTTP 200 with `wait.timedOut`, not an error; `stop` and `blocked` are `claude`-only; signals are edge-triggered with no history, so never fire-and-forget N prompts and then gather signal-waits one by one; a typed command echoes into the output stream, so markers must be split; a full-screen TUI stream is space-less, so match single tokens; and `pid != null` proves startup, not life, so `wait?until=exit` is the death check.

  ## Bug fixes
  - **Web tabs: long-running proxied requests were aborted after 30 seconds with no server log (#237).** The proxy wrapped each upstream fetch in a 30s `AbortSignal.timeout`, which bounds the entire exchange rather than the wait for response headers, so a dashboard endpoint doing model inference and any actively streaming response both died at 30s as a generic unlogged 502 that read as an intermittent network error. The timeout now bounds time-to-headers only and is cleared the moment headers arrive, with the default raised to 300s (`CODEMAN_WEBVIEW_TIMEOUT_MS`). Header timeouts are logged with a sanitized identity (method plus origin plus path, never the query string, which can carry the dashboard's tokens). A browser that navigates away mid-request now aborts the upstream fetch, guarded by `writableFinished` so a completed response never triggers it. The WebSocket handshake keeps its own 30s budget via the new `CODEMAN_WEBVIEW_WS_HANDSHAKE_TIMEOUT_MS`, since a handshake is connection establishment and waiting minutes on one only delays the browser's reconnect logic.
  - **Web tabs: sandbox incompatibility with cookie-authenticated reverse proxies documented (#238).** `docs/web-tabs.md` now covers cookie auth in front of Codeman itself (Cloudflare Access and similar), where a sandboxed frame's asset and API requests carry no auth cookie, bounce to the login provider, and leave the embedded app apparently unstyled while trusted mode works. The Test button's result now states its own scope: it verifies server-to-upstream reachability, not how the page behaves in a sandboxed frame.
  - **A described session tab now shows just the description (#232).** A session named `w2-foo-bar: some description` rendered both halves, so the generated id ate the width the chosen part needed. The tab shows the description alone, the `w<n>-<case>` id moves to the tooltip and stays in the session settings modal, and `aria-label` deliberately keeps the full name so screen readers still get the id. Undescribed tabs are unchanged. Right-click a tab to rename it inline. This also fixed a re-render loop: the incremental update compared against the full name, which a described tab never matched, so those tabs re-rendered on every pass.
  - **`codeman status` now probes the running server (#230).** The command runs in its own fresh process and reported that process's always-stopped Ralph loop under a bare "Status:", which reads as "the server is down" while the service is running fine and agents are reachable. It now probes the real server (`CODEMAN_API_URL`, else https then http on the local port, overridable with `--url`) and reports reachability, version and live session state; any HTTP answer proves the server is up, including a 401 from a password-protected install. The Ralph loop keeps its own `codeman ralph status`. This complements `codeman web --status` from the daemon work: that answers "did I start a daemon", this answers "is a server running at all".

## 1.14.1

### Patch Changes

- The Codeman agent skill is now installable, so an agent running inside a Codeman session can drive the API without you pasting docs into its prompt. Plus six fixes to the packaged skill, each found by running it live against a real instance.

  ## What the skill is

  `skills/codeman` is a Claude Code skill that teaches an agent inside a Codeman session how to start worker sessions, send them prompts, block until they finish, read their answers and clean up. It ships in the npm package. It self-gates: outside a Codeman session (`CODEMAN_MUX` unset) it refuses to act, so installing it globally costs unrelated sessions nothing.

  ## Installing it

  Three ways, pick one:

  ```bash
  codeman skill install                  # ~/.claude/skills/codeman, every new Claude Code session sees it
  codeman skill install --case myproject # just that case; linked cases resolve by name too
  codeman skill uninstall                # reverses either one
  ```

  Or turn on **App Settings > Agent Skill** (`agentSkillEnabled`, synced, default off) and Codeman injects the skill into each case when a Claude session is created there.

  Installs are marker-owned: a `skills/codeman` that Codeman did not write is never touched, a stale managed copy is refreshed in place, and a symlinked skill directory is refused rather than written through. Re-run `codeman skill install` after upgrading Codeman to refresh the copy.

  Note that turning `agentSkillEnabled` back off does **not** remove already-injected copies, because a create-time sweep would yank the skill out from under other live sessions sharing that `.claude/` directory. Remove them per case with `codeman skill uninstall --case <name>`.

  ## Using it

  Once installed, just ask: "spin up three workers and have them lint, typecheck and test in parallel, then report back". The skill supplies the guard, the safety rules and the recipes. What it does under the hood:

  **1. Guard.** Every Bash call re-runs a preamble that refuses outside `CODEMAN_MUX=1`, reads `CODEMAN_API_URL` and `CODEMAN_SESSION_ID`, recovers a password from the data dir `.env` or the install's service definition if one is set, and defines a fail-closed `delete_session`. It re-runs it every call because shell state does not survive between an agent's tool calls.

  **2. Start a worker.**

  ```bash
  Q=$("${CURL[@]}" -X POST "$API/api/v1/quick-start" -H 'Content-Type: application/json' \
    -d '{"caseName":"worker-1","mode":"claude"}')
  SID=$(jq -r 'if .success then .data.sessionId else empty end' <<<"$Q")
  ```

  `mode` is any of `claude`, `shell`, `opencode`, `codex`, `gemini`, `antigravity`.

  **3. Wait until it is actually ready.** A new session reports `idle` before its CLI has spawned, and a brand-new case shows a trust dialog first, so the skill waits for the composer's own status bar and treats the dialog as a bounded fallback.

  **4. Send a prompt and wait for the turn to end.**

  ```bash
  BODY=$(jq -n --arg p "$PROMPT" '{input:($p+"\r"),useMux:true,clientId:"codeman-agent-1",seq:1,wait:true,waitTimeout:60000}')
  "${CURL[@]}" -X POST "$API/api/v1/sessions/$SID/input" -H 'Content-Type: application/json' --data-binary "$BODY"
  ```

  Send-and-wait registers the waiter before typing, which closes the race where a separate wait reports the previous turn's idle state as this turn's answer. For `claude` workers it resolves on the `stop` hook, typically within seconds.

  **5. Read the answer.**

  ```bash
  "${CURL[@]}" "$API/api/v1/sessions/$SID/last-response" | jq -r '.data.text'
  ```

  **6. Clean up.** `delete_session "$SID"`, for ids you created and nothing else.

  Hook-less modes (`shell` and the external CLIs) have no `stop` signal and coarse lifecycle transitions, so the skill synchronizes those with a unique split marker and `wait-output ... from=buffer` instead. Worked fan-out flows, the per-mode signal table, error codes and the Docker/remote caveats live in the skill's `reference/` files, loaded on demand.

  ## The rules that bite

  The skill documents these because each one silently wastes a run:
  - **Every input must end with `\r`** or Enter is never sent and the text sits unsubmitted on the worker's prompt. `delivered:true` means "written to the pane", not "submitted".
  - **Input is single-line.** Newlines are stripped.
  - **A wait timeout is HTTP 200** with `wait.timedOut:true`, not an error. Loop over short waits; timeouts clamp to [1s, 600s] and the applied value comes back as `wait.timeoutMs`.
  - **`stop` and `blocked` are `claude`-only.** Requesting them elsewhere is a 400.
  - **Signals are edge-triggered with no history.** One that fires while no waiter is registered is unobservable afterwards, so never fire-and-forget N prompts and then gather signal-waits worker by worker.
  - **Your typed command echoes into the output stream**, so a marker that appears verbatim in the input line matches before the command runs. Split it.
  - **A full-screen TUI stream is space-less**, so match a single space-free token, never a phrase.
  - **`pid != null` proves startup, not life.** A worker that dies inside its pane keeps `status:"idle"` and a pid. `wait?until=exit` is the death check.

  ## Fixes to the packaged skill
  - **The self-delete guard failed open.** The old `is_self "$SID" || curl -X DELETE ...` shape meant an undefined `is_self` exited 127, the `||` branch fired, and the agent deleted its own session with the one guard bypassed. That is reachable because shell state does not survive between tool calls, so a partially re-pasted preamble was enough. The DELETE now lives inside a fail-closed `delete_session`, which also refuses an empty id and refuses when `$SELF` is unset or too short to prove the target is not the caller.
  - **`clientId` was built from `$$`.** The pid changes between tool calls, so the documented "resend the identical request" loop stopped being recognized as a duplicate and retyped the prompt, submitting the turn twice. It is a fixed literal now.
  - **`GET /api/v1/sessions/:id/last-response` was undocumented.** It returns the agent's final message as clean transcript text; the terminal scrape the skill previously recommended returns a wall of TUI repaint noise with the answer buried in it. It is now the documented read path for `claude` and `codex`, with the terminal buffer demoted to diagnosis and hook-less modes. Because the transcript flush lags the `stop` signal, the recipes poll it instead of reading once.
  - **`quick-start` responses were never checked for `.success`.** On failure `.data.sessionId` is absent, `jq -r` prints the string `null`, and the flow burned its full readiness budget against `/api/v1/sessions/null` before reporting jq noise instead of the cause.
  - **`codeman skill install --case <name>` could not resolve a linked case.** It hardcoded `~/codeman-cases/<name>` while the server resolves through `linked-cases.json` first, so it failed with "Case not found" for a case the web UI handled fine.
  - **Documentation corrections**: `SESSION_BUSY` on `quick-start` is the 50-session cap rather than the waiter cap; `caseName` resolves linked cases, so a generic name can land a worker in a real repo; and the claim that a toggle-off sweep exists was wrong, so the per-case `skill uninstall` cleanup is now stated in both the README and the code.

  ## Also in this release
  - **Terminal**: the wheel is no longer forwarded to codex, which ignores SGR mouse reports.

## 1.14.0

### Minor Changes

- Daemon mode and service install, plus subagent hook hardening and terminal/idle-checker fixes.

  **New: run Codeman in the background without a terminal (#239, closes #231)**
  - `codeman web -d` starts the server detached: it survives closing the shell, logs to `~/.codeman/web.log`, records a pidfile, and only reports success after the server actually answers `/api/status` (a port clash or missing dependency can never read as a clean start). `codeman web --status` and `codeman web --stop` manage it; `--stop` verifies the pid still looks like a Codeman server before signalling, so a recycled pid is never SIGTERMed.
  - `codeman service install` / `status` / `uninstall`: installs a systemd user unit (Linux) or LaunchAgent (macOS) so the server comes back after reboots. The unit carries the installing shell's PATH (launchd's default PATH finds neither an nvm/Homebrew `node` nor `tmux`/`claude`), never contains `CODEMAN_PASSWORD`, and uses the same instance-scoped unit names as `install.sh` and the self-updater so no second copy can end up supervised.
  - Both refuse to start a second server on one data dir (pidfile check plus a live probe): two servers on the shared tmux socket would attach to each other's sessions.
  - Why `-d` exists at all: `nohup` does not protect a Node process, Node re-arms SIGHUP even when it inherits "ignore", so `nohup codeman web &` still dies on HUP. The detached relaunch (setsid) removes the controlling terminal instead.

  **Subagent background-work hooks (#233, thanks @Lint111)**
  - The background Bash rewake helper now also watches the top-level parent transcript when the hook fires inside a subagent: Claude records a subagent's Bash result in its own `subagents/agent-*.jsonl` but queues the completion in the lead session transcript, so subagents previously never woke. It can also inline a `CODEMAN_RESULT_BEGIN/END` marked report (up to 64 KiB) from the task output file into the wake feedback.
  - New SubagentStop guard: a subagent that still owns live Monitor or background Bash processes is kept working instead of publishing an intermediate progress line as its final report. Ownership is verified against live process descriptors on `tasks/<id>.output`, so stale transcript text alone never blocks, and the guard fails open on systems without `/proc`.
  - Existing cases self-heal to the new hooks on next launch.

  **AI idle checker: stderr kept out of the verdict (#234, thanks @Lint111)**

  The `claude -p` verdict command no longer merges stderr into the verdict file, where CLI warnings could turn a valid verdict into a parse error. On failures, the first 200 chars of stderr are attached to the diagnostic instead.

  **Terminal: large final batches drain fully (#235, thanks @Lint111)**

  A render-scheduling flag was cleared after the flush instead of before it, so when a large batch left a remainder behind, the remainder stayed unrendered until unrelated output arrived. This looked like truncated responses or shell commands that never finish. The flush now reschedules itself until the queue is empty.

  **Docs and tests**
  - README documents daemon mode and service install.
  - Unique test port for the daemon-control suite.

## 1.13.0

### Minor Changes

- Agent wait primitives, the Codeman agent skill, a fix for hooks dying silently on HTTPS installs, and the tab-strip UX improvements from the previous batch.

  **Agent wait primitives (new API surface, the reason this is a minor).** Three bounded long-polls let an agent driving Codeman from a shell block instead of poll:
  - `GET /api/v1/sessions/:id/wait` blocks until a lifecycle signal fires (`until=stop,idle,working,blocked,exit`, `fresh=1` to require a new transition).
  - `GET /api/v1/sessions/:id/wait-output` blocks until a literal substring appears in the session's output (`match=`, `nocase=`, `from=now|buffer`; never regex, by design).
  - `wait`/`waitTimeout` on `POST /api/v1/sessions/:id/input` (send-and-wait) registers the waiter before typing, closing the race where a separate wait reports the previous turn's idle state as this turn's answer.

  Shared semantics: a timeout is HTTP 200 with `wait.timedOut: true` (callers loop over short waits; tunnels cut idle connections), timeouts are clamped to [1s, 600s] and echoed back as `wait.timeoutMs`, all three nest the result under `data.wait`, and `status`/`limitPaused` ride along. `stop`/`blocked` exist for `claude` mode only: requesting them explicitly elsewhere is a 400, the default set silently narrows and echoes what it waited on. Capacity caps (16 waiters per session, 128 process-wide) answer 409/429, waiter slots release on client hang-up, and shutdown resolves parked waiters instead of stranding them. Bounds are operator-tunable via `CODEMAN_WAIT_*` env vars.

  Reliability details that came out of three verification rounds: a worker that dies inside its tmux pane is now detected at the mux layer (pane-death probe, ~750ms cache, a 3s watcher for waits already parked), so a corpse answers `exit` instead of `idle` and send-and-wait rolls back its dedup seq when the write went nowhere; output matching normalizes charset-designation escapes (a stock bash prompt's `ESC ( B` no longer breaks `match=tnode:`) and holds back partial escapes at chunk boundaries, so matches straddling PTY chunks are found.

  **Codeman agent skill (`skills/codeman`).** A packaged skill that teaches an agent running inside a Codeman session to drive the API safely: guard preamble (refuses outside `CODEMAN_MUX=1`, resolves credentials from the data dir `.env` or the install's service definition), self-protection (`is_self` prefix check in both directions), readiness for claude workers (composer-first, trust dialog as bounded fallback), send-and-wait loops that cannot report a never-submitted prompt as success, marker-synchronized shell flows, fan-out patterns, and cleanup discipline. Ships in the npm package via the `files` entry.

  **Hooks were dying silently on every HTTPS install (bug fix).** The generated hook curls lacked `-k`, so on `--https` installs (self-signed cert) every hook event (`stop`, `permission_prompt`, `elicitation_dialog`, `idle_prompt`, `teammate_idle`, `task_completed`) failed TLS verification and the failure was swallowed, taking respawn's definitive idle signals with it. Hooks are now generated with `curl -sk`, and a staleness detector regenerates the on-disk hook config of already-created cases the next time a session starts in them. Relatedly, `CODEMAN_API_URL` is no longer exported with a guessed `http://localhost:3000` fallback (wrong scheme on HTTPS installs); it is omitted unless the server has stamped the real URL, so in-session guards fail closed.

  **Tab strip (from the previous batch, reported by christianhaberl):** action icons (kill/pop-out) now appear on the active tab only, middle-click closes a tab, tab hover uses a fixed width with a sliding title instead of resizing the strip, and the pop-out button is opt-in (default off).

  **Docs.** `docs/api-reference.md` gained the full long-polling contract (signals by mode, readiness, what the matcher sees, response discriminators); `docs/extending-codeman.md` and the README carry verified copy-paste orchestration recipes; `docs/architecture-invariants.md` records the load-bearing ordering, liveness, and edge-triggered-signal invariants. Net +163 tests (4300 passing in the CI sweep).

## 1.12.2

### Patch Changes

- Codex input fixes: all four bugs reported by @DodgyBadger traced to one root cause (the zero-lag local-echo overlay buffering keystrokes until Enter, which starves codex's per-keystroke composer) and fixed in terminal-ui.js:
  - Slash command picker never appeared in codex sessions (#222): the "/" sat in the overlay until Enter, so codex never saw it. Codex-mode sessions now use plain PTY echo (same branch as shell), so the picker pops and live-filters as you type.
  - Arrow keys dead while typing, backspace dead after Ctrl+Backspace (#218): arrows were forwarded to a still-empty composer while typed text sat pending, and after a control-char flush the overlay swallowed every backspace. Codex bypasses the overlay entirely now; the shared overlay branch (claude/gemini/opencode) additionally flushes pending text on composer nav keys, then hands the session to pass-through until Enter/Ctrl+C, and forwards backspace instead of swallowing it when the overlay has no state.
  - Pasting displaced the typed prompt (#219): bracketed pastes (xterm terminal.paste with DECSET 2004 active) were forwarded without flushing pending typed text, so the paste landed first. The shared branch now flushes typed text first and delays the paste sequence by 80ms, because codex's paste-burst handling drops keystrokes that arrive in the same PTY read as a bracketed paste (verified against codex 0.147.0 at the byte level).
  - Long prompts overflowed the bottom of the screen (#220): long typed prompts existed only in the overlay DOM so codex never grew its composer; with plain PTY echo the composer grows and rewraps normally.

  Verified end to end against a real codex 0.147.0 TUI driven by a headless browser: the pre-fix build reproduces all four bugs, the fixed build passes 17/17 assertions. New CI test file test/local-echo-codex-gating.test.ts (41 tests) pins the nav-key classifier, per-mode overlay gating, the flush helper, and pass-through routing. Known upstream limitation: Ctrl+Backspace deletes one character, not a word (xterm.js sends 0x08; word-delete needs kitty CSI-u encoding that xterm.js 6.0.0 cannot emit).

  Mobile keyboard viewport settling fixes by @Lint111 (#229): coalesce keyboard viewport settling so rapid visualViewport resize events during keyboard show/hide no longer thrash the terminal fit, and only arm the settle logic on a real keyboard transition instead of every viewport resize.

## 1.12.1

### Patch Changes

- Terminal scrollback fixes, round 2 of issue #205. A Claude pane's local buffer is hollow (tmux keeps no history for a repaint-mode pane), and both retest reports traced back to that fact. The scroll-to-top full-history re-pull now refuses to rewrite the terminal when the capture holds less than the browser already does, so it can no longer delete history mid-scroll on iPhone (a refused session also re-fetches far less often). When wheel-forwarding is unavailable on a Claude session (version probe failed, CLI older than 2.1.187, or the "Wheel Scrolls Local History" opt-out) and there is no local scrollback to scroll, wheel and touch now page the CLI's own transcript via coalesced PageUp/PageDown instead of doing nothing. The `claude --version` probe no longer caches a failed run for the server's lifetime (one timed-out probe used to silently disable wheel-forwarding on every device until restart); failures retry with backoff. Every scroll gesture now logs a one-line `[scroll]` routing decision to the browser console for direct diagnosis, and the opt-out setting's tooltip explains that the paging fallback is Claude-only (Codex has none).
- 2e69e28: Bound the process-tree walk that could take a machine down.

  `getChildPids` ran `pgrep -P <pid>` per node and recursed with no visited set, no
  depth limit and no node cap. Across ~28 adopted tmux trees the fan-out exploded,
  and because each `pgrep` blocks in the kernel while reading `/proc/<pid>/cgroup`
  under WSL, none returned while the walk kept spawning more — ~13,000 `pgrep`
  processes stuck in D-state out of ~39,000 total, load average above 13,000,
  recoverable only by restarting WSL.

  Now: one `ps` snapshot, breadth-first with a visited set, a depth cap and a node
  cap, in a pure module (`proc-tree.ts`) that the regression tests exercise
  directly. The snapshot is refreshed asynchronously, and the kill path forces a
  fresh one so the SIGKILL escalation cannot re-read pre-SIGTERM state.

- ebfcac6: An input whose delivery fails can be retried instead of being lost for good.

  Both input paths recorded the `(clientId, seq)` pair as applied and acknowledged
  the frame _before_ knowing whether the write had landed — the POST route because
  its mux write is fire-and-forget, the WebSocket handler because it ACKed
  unconditionally. When the write then failed, the client dropped the frame from its
  durable queue and the server rejected the retry as a duplicate: the reliable
  delivery layer was guaranteeing exactly-once delivery of something that had never
  been delivered.

  The bookkeeping is now rolled back on failure and the WebSocket ACK withheld, so
  the client redelivers. `Session.write()` reports whether it reached a PTY at all
  instead of silently swallowing the data.

  Response codes are unchanged: a session can legitimately have no PTY yet (created
  but not started), so turning that into a failure status would be a contract change
  of its own.

  Note this does not remove the root cause: the POST still answers 200 before the
  mux write is attempted, so a client that treats any 2xx as final still cannot
  learn about that failure. Closing that would mean awaiting the tmux child in the
  request path.

- 1a32e63: Routes that answer with `reply.raw.writeHead()` no longer drop the headers the
  security hook set.

  `writeHead` writes straight to the Node response and bypasses Fastify's header
  store, so everything the `onRequest` hook granted was silently lost — including the
  `Access-Control-Allow-Origin` it emits for localhost origins, and the
  `X-Content-Type-Options` / `X-Frame-Options` / CSP headers. A localhost page could
  therefore call every other `/api` endpoint cross-origin while its EventSource
  failed CORS.

  Affects `GET /api/events` and the three raw-writing routes in `file-routes.ts`
  (`file-raw`, `tail-file`, `download`).

## 1.12.0

### Minor Changes

- Terminal scrollback overhaul (issue #205), fixing every reported scroll failure across shell and CLI sessions, desktop and mobile:
  - Shell, OpenCode and Antigravity sessions finally have working scrollback: tmux's own client-side alternate-screen switch is stripped for tmux-backed sessions (narrow strip: alt-screen toggles only, keeping `clear`'s 3J and mouse DECSETs), so xterm stays in the normal buffer instead of a scrollback-less alt buffer where the wheel turned into shell history cycling and touch scrolling did nothing. Direct-PTY fallback sessions are untouched so fullscreen apps (vim/less/htop) keep the alt screen there.
  - The wheel listener now runs in capture phase and owns the scroll: xterm's internal vscode-style viewport scroller consumed wheel events whenever local scrollback existed (and goes deaf entirely after a tab switch or replay resets the terminal), which silently killed wheel forwarding, made scrolling break after reload/tab switches, and let the CLI's input box scroll away. Local scrolling goes through buffer-level scrollLines and keeps working after resets; mouse-tracking apps and alternate-buffer sessions are passed through untouched.
  - Wheel AND touch scrolling now forward to the CLI's own transcript for Codex and Claude 2.1.187+, at any scroll position (the viewport snaps home first), so the input box stays pinned on desktop and phones alike. Shift+wheel and the "Wheel scrolls local history" setting still pin local scrollback.
  - Smooth scrolling: local wheel scrolling glides with an ease-out animation (fractional line accumulation, so slow trackpad drags track the finger instead of running ahead).
  - Full tmux history on demand: the full-scrollback replay is now per session instead of once per page load, and scrolling up at the top of the buffer re-pulls the complete tmux history, recovering everything tmux's repaint bursts or tab switches removed from the browser's copy.
  - Firefox wheel speed: wheel deltas are normalized by deltaMode (Firefox reports line units, previously read as pixels and slowed ~4x).
  - Remote SSH Claude sessions now probe the CLI version over ssh (same connection options and login-shell wrapper as the real launch), so wheel forwarding works for them too instead of silently staying off.

  Docs: scrollback analysis and fix plan recorded in docs/, architecture invariants updated (strip flavors, capture-phase wheel ownership, per-session full-history replay); docker agent-image rebuild warning and integration-guide link fixes from the preceding docs commits.

## 1.11.2

### Patch Changes

- Make Antigravity (`agy`) a first-class CLI everywhere, and stop presenting Gemini CLI as a consumer product now that it is enterprise-only.

  Antigravity was already wired into the session layer, schemas, run-mode menu and remote/Docker command maps, but the surfaces around it were never updated. Gemini keeps full support; Antigravity now sits beside it.

  Fixes:
  - **Docker cases with `mode: 'antigravity'` were broken.** `docker/agent.Dockerfile` installs its CLIs from npm, and `agy` is not an npm package, so the binary was never in the image and the container died on command-not-found. It now gets its own installer step. The `--dir /usr/local/bin` flag is load-bearing: the installer's default `$HOME/.local/bin` resolves to root's home at build time and would be unreachable by the `agent` user the container runs as. Note the binary is roughly 190MB, making it the largest layer in the image, so rebuild with `node scripts/build-agent-image.mjs` when convenient.
  - **Welcome screen** gained a "Run Antigravity" action, gated on `agy` being present like the other CLI buttons, styled with the same cyan identity as the toolbar run button and run-mode dot.
  - **`install.sh`** now detects `agy` (search paths mirroring `antigravity-cli-resolver.ts`), counts it as a satisfying AI CLI so an Antigravity-only box is not told it has none, and recommends it instead of Gemini in the install hints.

  Documentation corrections where it had become factually wrong: `architecture-invariants.md` described `isExternalCliMode()` as opencode/codex/gemini when the code has included antigravity for some time, said "all three modes", and omitted `ANTIGRAVITY_*` from the env-prefix allowlist row; the `agentType` enum in `cron-guide.md`, `SessionMode` in `cron-discovery.md`, and `RemoteCommandMode` in `remote-sessions.md` were all stale.

  Also updated both READMEs (five CLIs, Gemini marked enterprise-only), the `antigravity` npm keyword, and comment drift in eight places. Test coverage added for the new welcome button.

  Antigravity stores its state under `~/.gemini/antigravity-cli/` rather than a `~/.antigravity` directory, so the existing `.gemini` Docker credential seed already covers it. That is now recorded in a code comment so no dead configuration gets added later.

- b982c5d: Keep the brief Response Viewer output inside the same message card and Markdown wrapper used by the full conversation view, so opening the viewer without clicking More preserves the same readable formatting.

## 1.11.1

### Patch Changes

- fix(history): Past Sessions data quality, and gate the phone run picker on CLI availability

  **Past Sessions data quality (#215).** Three bugs in the transcript scanner behind
  the Cmd+K Session Manager and the phone overview's PAST SESSIONS list:
  - Automated/SDK-driven transcripts (CI review bots and other tooling, which Claude
    Code stamps with a non-`cli` `entrypoint`) were listed alongside real interactive
    sessions even though they were never resumable. They are now excluded. Detection
    scans every entrypoint-bearing message rather than stopping at the first, so a
    transcript that began under an older Claude Code build and only later picked up a
    non-`cli` entrypoint is no longer wrongly hidden.
  - A resumed session could show a same-directory sibling's preview text as its own.
    The `workingDir` backfill in `mergeUnifiedSessions()` now only ever applies to rows
    that have no history entry of their own, so it can no longer overwrite a row's real
    content with another conversation's.
  - Sessions restarted many times accumulated enough bookkeeping lines to push the real
    first prompt past the scanner's 16KB head-read window, leaving a blank row. The read
    is now two-tier: 16KB first, escalating to 128KB only when that was not enough, which
    is both correct and cheaper than reading 128KB unconditionally (measured on a real
    transcript tree: 36% fewer bytes read, roughly 17.5% faster than the unconditional
    version). Also restores the tail-read fallback for a file whose head read failed
    outright (for example `EMFILE` while scanning hundreds of files), which had been
    silently dropping the session from history.

  Follow-up hardening on top of the above: the automated-transcript exclusion now
  blocklists the SDK entrypoint shape (`sdk`, `sdk-cli`, `sdk-py`) instead of allowlisting
  the exact value `cli`. Because the check hides rows, an allowlist failed closed on any
  value Claude Code has not shipped yet: a future rename of the interactive entrypoint,
  or a second interactive host, would have blanked the entire Past Sessions list with
  nothing in the UI to explain it. An unrecognized automated entrypoint now costs a few
  noisy rows instead, which is the annoyance this filter set out to fix rather than a
  broken feature.

  **Phone overview run picker (#214).** The "C" logo home screen's Run picker listed all
  six backends regardless of what was installed, so tapping an uninstalled one produced a
  failed launch instead of the entry simply not being offered. It is now gated on
  `isCliAvailable()` exactly like the desktop toolbar's run-mode dropdown (shell exempt,
  since it has no external CLI dependency and keeps the menu from ever being empty). The
  picker is a hardcoded duplicate of the toolbar menu rather than a shared render, which
  is why it never picked up the earlier gating work; a test now asserts that every mode
  the picker offers is gated, so a newly added backend cannot silently drift again.

- 73315bc: fix(web): stop the Claude response viewer from following another session's conversation

  The viewer re-derived a pane's live conversation by taking the newest
  `~/.claude/history.jsonl` entry for the pane's cwd. A cwd is shared with every
  other Codeman tab on it, with tabs long since closed, and with any plain
  `claude` run in the user's own terminal, so the eye followed whichever of those
  was typed into last — and the adoption was written back to the session, so the
  mispin persisted. Entries are now credited to a pane only when they land within
  10s of that pane's own Enter and no other pane on the cwd submitted closer, the
  same last-submit correlation the Codex locator already uses.

  That correlation also has to survive a restart. `start()` resets
  `claudeSessionId` to the launch id even when re-attaching to a mux session whose
  CLI has since moved on via `/clear`, so a recovered pane pointed the viewer at
  its pre-`/clear` transcript — and with the anchor itself living only in memory,
  nothing corrected it until the user happened to type again. `lastSubmitAt` is
  now persisted in `SessionState` and restored on boot recovery, so the viewer
  re-derives the live conversation on its first poll.

## 1.11.0

### Minor Changes

- Two user-facing features since 1.10.0.

  **Terminal: Ctrl+C copies the selection, interrupts when nothing is selected** (#211). Copying from the terminal previously worked only through the browser context menu: xterm turns Ctrl+C into 0x03 and cancels the keydown, so the muscle-memory copy failed silently and read as "no copy-paste at all". With a selection, Ctrl+C now copies it, shows the "Copied to clipboard" toast, clears the selection and sends nothing to the PTY; with no selection it falls through unchanged, so the interrupt is intact. Ctrl+Shift+C is an explicit copy chord that never interrupts. The shortcut is a normal registry entry (`copy-selection`), so it can be rebound or disabled in App Settings, and disabling it restores plain always-interrupt Ctrl+C. Copy goes through the Clipboard API with a hidden-textarea fallback, so it also works on plain-HTTP LAN installs.

  **File Viewer: edit mode for text files** (#212). The file-preview overlay can now edit workspace text files in place, phone-first: `GET /api/sessions/:id/file-content?edit=1` reads for edit without the 500-line preview truncation (saving a truncated buffer would silently delete the rest) and returns a sha256 hash plus the detected EOL; `PUT /api/sessions/:id/file-content` saves. Edit-in-place only: there is no O_CREAT anywhere in the handler, so "never create, never delete" is structural. Confinement inherits the read path (realpath plus workspace boundary, ownership scoping) and adds sensitive-path and attachment-guard blocklists, a `.git/` subtree deny, and an extension allowlist (`svg` and `env` deliberately excluded). Optimistic concurrency is by content hash, so a file changed on disk mid-edit returns 409 with an overwrite option rather than clobbering. Writes are atomic (`wx` temp, fchmod, fsync, rename) which closes the validate-then-write TOCTOU window and cannot follow a pre-existing symlink. Binary and latin-1 content are refused via a NUL sniff plus a UTF-8 round-trip compare, and EOL is re-applied server-side so a textarea's LF normalization cannot turn a two-line edit of a CRLF file into a whole-file diff.

## 1.10.0

### Minor Changes

- Codeman 1.10.0.

  **Every surface that offers a CLI now checks the CLI is actually there** (#200, #201). The welcome-screen run buttons, the run-mode dropdown and the App Settings "Codex CLI" tab used to be shown unconditionally, so picking one on a box without the binary spawned a session that errored out immediately. All of them now gate on a single server-injected availability object covering Claude, OpenCode, Codex, Gemini, Antigravity and cloudflared, so nothing flickers in after paint and the dropdown costs no round trips to open. Shell is never gated, which is what keeps the menu non-empty on a box with nothing installed, and unknown availability reads as available so a stale page can never leave a working install with nothing to click. Adds `isClaudeAvailable()` and `GET /api/claude/status`, the one CLI that had no availability check despite being the default. The Cloudflare Tunnel welcome button and its scan-to-connect QR are gated on `cloudflared` rather than shown regardless.

  **Shell and remote-SSH sessions now launch a real login shell** (#209, #210). Local shell tabs match what tmux itself does for a pane with no `default-command`, picking up the `/etc/profile` and `/etc/profile.d/*` entries a systemd `--user` service never sourced. On remote SSH, `claude`/`opencode`/`codex`/`gemini`/`agy` are routed through the remote user's interactive login shell, fixing agent CLIs that silently failed with "command not found" because ssh's remote-command execution sees only sshd's minimal default PATH and not the `~/.local/bin` or `~/.opencode/bin` entries where those CLIs actually live. Shell mode uses the remote user's real shell instead of hardcoded bash. The login flags are applied only to shells verified to accept them, so an exotic passwd entry (nushell, elvish, xonsh) cannot produce a dead pane on arrival.

  **A crashed remote pane is kept for diagnosis** (#210), which is how the PATH failure above was found: it previously destroyed the pane, the window and the whole remote session on exit, tearing the local ssh attach down with it and leaving a flap loop with no evidence. Scoped to `remain-on-exit failed`, so a clean `exit` still tears the session down and only a non-zero exit strands anything, and applied last in the tmux command chain so a remote tmux older than 3.2 cannot drop the other session options with it.

  **Resumed sessions under a hidden directory get the right working directory** (#202). Claude Code's project-key encoder maps both `/` and `.` to `-`, and the decoder could not reconstruct a dot-prefixed component, so every session under `~/.codeman` (or any project nested beneath any dotdir) silently resolved to bare `$HOME`. The wrong `workingDir` then propagated into `state.json` and everything trusting it: CLAUDE.md lookup, paste-image directory, subagent and image watchers. A same-named non-dot sibling could also produce a doubled-slash path that failed every later string comparison.

  **Launching a session no longer wipes the terminal you are looking at** (#180). All six run modes route through the shared ownership helpers instead of clearing and writing into whatever session happened to be active, Antigravity included.

  **Codex terminal animations are configurable** (#181), and the App Settings "Codex CLI" tab appears only where the `codex` binary resolves, since both settings on it are handed to `codex` at launch.

## 1.9.9

### Patch Changes

- Two bug fixes.

  **Plain shell sessions could not start when the server process had no `SHELL` (#208).** The tmux pane command for `mode: 'shell'` was the literal string `$SHELL`. That string is embedded in the `bash -c "..."` argument of the `respawn-pane` line, which is run through `/bin/sh -c`, so it was expanded by the _server_ process's shell against the _server_ process's environment rather than inside the pane. Containers and system-level systemd units do not set `SHELL`, so it expanded to nothing and the pane command ended in a dangling `&&`, giving `bash: -c: line 1: syntax error: unexpected end of file` and a pane that died instantly (status 2) while tmux session creation still reported success. The shell is now resolved in Node (`$SHELL`, then the passwd entry, then `/bin/bash`, `/bin/zsh`, `/bin/sh`), requiring an absolute path to an executable and skipping `nologin`-style stubs, then shell-quoted. Only local shell sessions were affected: agent CLI modes emit a real command, and Docker/remote-SSH cases already used a literal `exec bash -l`.

  **A session name typed into the tab options could be silently dropped.** Two independent paths. In the Session Options modal, the Session Name input saves on blur while every autosave handler bails on a null `editingSessionId`, and `closeSessionOptions()` cleared that id before hiding the modal (hiding is what blurs the input), so the save always ran too late; Escape and backdrop-click lost the name with no PUT at all, and only the X button worked because mousedown blurs first. The focused modal field is now blurred before the id is cleared, which also covers the auto-compact prompt. Separately, the right-click inline rename could be destroyed mid-keystroke: the `_inlineRenameActive` guard was missing from `_renderSessionTabsImmediate()`, so a render queued just before the rename opened still rewrote the tab name's innerHTML, committing a truncated name or closing the rename outright. The debounced executor is now guarded too.

## 1.9.8

### Patch Changes

- **Fixed: sessions failed to start on macOS with `Error: posix_spawnp failed.`** (issues #6 and #204)

  `node-pty@1.1.0` publishes its macOS prebuilt helper as `prebuilds/darwin-<arch>/spawn-helper` with mode 0644, i.e. no execute bit. macOS launches every PTY through that helper, so a stock install failed on every session start. The bug is macOS-only: `spawn-helper` is a mac-only gyp target and node-pty ships no Linux prebuild, so Linux always compiles a correctly-permissioned helper from source.

  The previous fix chmodded only `build/Release/spawn-helper`, which on macOS does not exist (the prebuild is used, so node-gyp never runs), and it derived that path from `require.resolve('node-pty')`, landing on `<pkg>/lib/build/Release/...`. It was a no-op on every platform.
  - New `scripts/fix-node-pty.mjs` (also `npm run fix:node-pty`) chmods every `spawn-helper` it finds, in `build/Release`, `build/Debug` and each `prebuilds/*/`, then verifies the result by actually opening a PTY. A `require()` alone passes on a broken install, because the helper is only touched at spawn time.
  - `postinstall` no longer force-rebuilds node-pty from source on Node 22+. That step needed Xcode command line tools, cost 30-120s on every install, and deleted the `prebuilds/` tree before compiling, so a Mac without a compiler was left with no working binary at all. A rebuild now happens only when the chmod plus spawn probe still fails, and the prebuilds tree is backed up and restored around it.
  - New `spawnPtyWithHelperRepair()` (`src/utils/node-pty-repair.ts`) wraps every `pty.spawn()` in `session.ts`, so an install that is already broken repairs itself on the first failed spawn and retries in-process instead of showing a dead session. Unrelated spawn errors are rethrown untouched; a second failure carries the `npm run fix:node-pty` hint.
  - `scripts/fix-node-pty.mjs` is now in the published `files` list, so global npm installs get the repair too.
  - Direct-PTY Claude spawns use the resolved absolute binary path (new `getClaudeBinaryPath()`) instead of the bare name `claude`, so a CLI installed outside the server's PATH still launches.

  Verified end to end on macOS 26.4 arm64: a stock `npm i` reproduces `posix_spawnp failed.`, and after the fix the same install spawns a PTY successfully with the prebuilds preserved.

  **Added: phone home screen (session overview)**

  Under 430px the "C" logo now opens a session overview (current sessions, past sessions, spaces) instead of the welcome overlay: on a small screen "which session needs me" beats "how do I start one". Rows resume a session in place, and "New session here" goes through the normal quick-start path so remote and Docker cases keep their routing. Per-device setting `mobileOverviewEnabled` (phones only, default ON) in App Settings. Tablet and desktop are unchanged.

  **Added: guided Tailscale setup in `install.sh`**

  The network-access prompt is now 3-way: Tailscale, LAN, or local-only. The Tailscale path binds loopback and walks through installing Tailscale, logging in, the operator grant, the tailnet HTTPS-certificates toggle, and `tailscale serve --bg <port>`, then verifies the result end to end with curl. That gives HTTPS on a real certificate with no app password and no `0.0.0.0` bind, which is also what PWA install and web push need. `install.sh tailscale` retrofits it onto an existing install, and `CODEMAN_TAILSCALE=1` presets the choice. Serve state is detected from `tailscale serve status --json`; the installer never runs `tailscale serve reset` and never touches serve mappings other than 443 to Codeman's port. README and `docs/security-architecture.md` updated to match.

  **Docs**: replaced a real tailnet hostname with placeholders in `docs/web-tabs-fixes-plan.md`.

  **xterm-zerolag-input**: npm description and keywords only, no code change.

## 1.9.7

### Patch Changes

- Antigravity run mode, plus opt-in entrance animations.

  **Antigravity CLI backend (#207).** Antigravity (`agy`) joins Claude Code, shell, OpenCode, Codex and Gemini as a sixth session backend, following the same pluggable-resolver pattern: `utils/antigravity-cli-resolver.ts` resolves the CLI and `GET /api/antigravity/status` reports availability and path. `ANTIGRAVITY_*` is added to the `ALLOWED_ENV_PREFIXES` allowlist so env overrides stay CLI-scoped rather than blanket-forwarded. Like the other external CLIs it requires tmux with no direct PTY fallback, because secrets are injected through socket-scoped `tmux setenv` and never on the spawn command line. The UI gains a Run-dropdown entry, an agent-type option, an `ag` tab badge and toolbar colours; `runAntigravity()` routes remote and docker cases through `POST /api/quick-start` and skips the local status probe for them.

  **Entrance animations (opt-in, OFF by default).** Optional animations for the four things that appear when work starts: session tabs, the terminal pane a session's CLI runs in, floating agent windows, and the connection lines tying a window back to its parent tab. Defaults are the `legacy` theme, so an untouched install behaves exactly as before and every hook short-circuits on its first line. Choose a look in App Settings > Appearance > Entrance Animations (per-device, stored in localStorage rather than the settings payload); `?animlab=1` opens a per-surface picker with a live preview that fakes tabs, a pane, a window and a line so styles can be compared without spawning sessions.

  Three implementation notes worth knowing if you touch this: tabs and connection lines are destroyed mid-animation on every re-render (`_fullRenderSessionTabs()` replaces the strip's innerHTML, `_updateConnectionLinesImmediate()` clears the SVG), so both are tracked by id and re-applied to the fresh element with a negative `animation-delay` that resumes rather than restarts them; terminal-pane styles animate transform, opacity and clip-path only, because xterm's FitAddon derives rows and columns from the untransformed layout box and animating width or height there would resize the PTY; and window styles that transform also move the rect their connection line aims at, which is why the `beam` style animates opacity and filter only.

  Also fixes an agent window spawning hidden (its agent belongs to a background tab): being `display:none` it never ran its animation, so `animationend` never fired and the entrance class plus its inline custom property stuck to the window permanently. Hidden windows now skip the entrance entirely.

## 1.9.6

### Patch Changes

- Two fixes from community PRs (thanks @Lint111):
  - fix(transcripts): complete tools from user-entry results (#177). Claude transcripts record tool requests in assistant entries but commonly carry their results in user-role entries; the transcript watcher only completed tools from the older assistant-entry path, so Codeman could keep showing a tool as running after it had finished. The watcher now recognizes `tool_result` blocks in user entries, ends the active tool state, and emits `transcript:tool_end` with the correct tool name and error status. Watcher tests also moved from fixed sleeps to condition-based `vi.waitFor` assertions.
  - fix(notifications): quiet lifecycle hook noise (#178). Notification preferences move to schema version 5: the drawer-only "Response complete" (stop) default is now off, and the migration disables only the legacy drawer-only shape, preserving any explicit browser, audio, or push delivery the user opted into. Teammate-idle and task-completed hooks now map to the existing opt-in subagent categories instead of the broadly enabled idle/stop alerts, so normal agent activity no longer floods the drawer. Local and server-hydrated preferences are normalized through the same migration path (server hydration used to revive the retired default on fresh browsers), and the notification storage key now uses the stable handheld identity so an unfolded foldable keeps its mobile defaults and storage key (tablets and desktops unaffected).

## 1.9.5

### Patch Changes

- Background-Bash rewake hook, hooks self-heal that preserves user hooks, and test-harness isolation.
  - New `PostToolUse(Bash)` hook (PR #176): a self-contained `node -e` helper watches the session transcript for a background command's completion notification and uses Claude Code's `asyncRewake` to wake an idle agent (exit code 2), without injecting terminal input that could submit a user's draft. Works on Claude Code 2.1.207+; older CLIs strip the fields harmlessly.
  - Hooks self-heal (`refreshStaleHookSecret` renamed to `refreshStaleCodemanHooks`) now replaces only Codeman-owned handlers, preserving user events, matchers, and sibling handlers in mixed configurations; `writeHooksConfig` merges instead of clobbering the hooks key at case creation (PR #176).
  - Rewake helper hardening: self-terminates on its own 6h deadline and when orphaned; the marker is versioned (V2) with a version-agnostic ownership prefix so future script updates replace older handlers instead of duplicating them.
  - Hook timeout units fixed: the hook `timeout` field is seconds (the CLI multiplies by 1000), so `HOOK_TIMEOUT_MS = 10000` gave curl hooks a ~2.8-hour effective timeout; now `HOOK_TIMEOUT_SECONDS = 10`.
  - Test-harness isolation (PR #175): every test file gets a temporary `HOME`/`USERPROFILE` so tests cannot touch real Codeman state or delete real case directories, and `Session` attaches a raw-mode echo PTY instead of a real tmux client under Vitest. Fixes the quick-start suite deleting the real `~/codeman-cases/testcase`.
  - CI stability: drain console-log rpc forwards before worker teardown (fixes a run-failing `EnvironmentTeardownError` with all tests passing); `test/webview-proxy.test.ts` no longer accidentally runs under the jsdom environment via a directive named in a comment.
  - Release workflow pins the GitHub "Latest" badge to the Codeman release.

## 1.9.4

### Patch Changes

- Fix a latent bug where a partial settings PUT silently reset live service state, and trim the `xterm-zerolag-input` README callout.
  - **`PUT /api/settings` no longer resets watchers on a partial body.** The three `toggleService` calls (subagent watcher, workflow-run watcher, image watcher) read the raw request body with `??` defaults, so every key a caller omitted was treated as "apply the default". A body of just `{statusLineTelemetry:true}` would START the subagent watcher and STOP the workflow and image watchers, undoing the persisted config. They now resolve from `merged` (persisted settings + incoming), the same convention the `tmuxHistoryLimit` branch in that handler already used, so any PUT reconciles services to the effective stored state. Nothing triggered this in practice because every shipped client sends a full settings payload rebuilt from the DOM, but it was a trap for the next partial-update caller.
  - **Regression test**: `test/routes/system-routes-settings-partial-put.test.ts` (4 cases) pins both directions, omitted keys preserve state and explicit keys still take effect. Verified to fail against the pre-fix handler.
  - **CLAUDE.md** records the rule under "Adding Features → App setting": anything acting on a setting in that handler must resolve from `merged`, never the request body.
  - **`xterm-zerolag-input` README**: removed the links line (getcodeman.com / install one-liner / star link) from the Codeman callout above the demo GIF. The callout keeps its links in the heading and body.

## 1.9.3

### Patch Changes

- Plan-usage chip now defaults ON on desktop, plus the reworked `xterm-zerolag-input` README.
  - **Plan-usage chip defaults ON (desktop).** The `showPlanUsageLimits` chip (live 5-hour and weekly plan usage from the Claude statusline) used to be opt-in and default OFF, so most users never saw it. Desktop now defaults ON; handhelds still default OFF so the phone header stays minimal and the `mobile-header-buttons-policy` guard keeps passing. Devices with an explicitly stored preference keep whatever they chose, so nobody's OFF gets overridden.
  - **One resolver behind the chip.** Added `planUsageChipEnabled()` in settings-ui.js and routed all three call sites through it: the App Settings checkbox, the chip's visibility, and the create-time `statusLineTelemetry` flag in session-ui.js. Those three had independent `?? false` / `=== true` defaults, and a chip revealed without the telemetry flag renders `—` forever, so a default flip on one site alone would have shipped a permanently empty chip.
  - **Cron button comment corrected.** The App Settings comment claimed "Cron button defaults ON" while the code, the template (`btn-cron--hidden`) and the CSS all default it OFF. Verified against a fresh browser profile: the button is hidden and its checkbox unchecked out of the box. Comment now matches, and states why the two halves stay consistent.
  - **Docs.** CLAUDE.md, `docs/architecture-invariants.md` and `docs/usage-limits-display-plan.md` updated for the new default and the single-resolver rule; the stale `styles.css` comment claiming the server strips the chip's hidden class at render was corrected (display is per-device, so the client reveals it).
  - **`xterm-zerolag-input` README rework** (0.1.5 shipped the content; this republishes with the graphic and promo changes): replaced the misaligned 8-line keystroke-flow diagram with a two-line stock-vs-zerolag contrast, added a Codeman callout above the demo GIF with links to getcodeman.com and the repo, and rewrote the Origin section so it argues the extraction story instead of repeating the promo.

## 1.9.2

### Patch Changes

- Rewrite the `xterm-zerolag-input` package README as a value-first document and correct the drift that had accumulated against the source.
  - Added the side-by-side phone demo GIF (`docs/images/zerolag-demo-20260728.gif`) as the hero image, referenced by absolute raw URL so it renders on npmjs.com as well as GitHub. The two-phone comparison shows 0ms local echo next to a 600ms-2.7s server echo on the same session.
  - New "Why this one" comparison table, an explicit list of target use cases (SSH web clients, cloud IDEs, mobile terminals, container consoles), and a bundle-size badge (6.1 kB gzipped, measured from the ESM build).
  - Corrected the test-count badge from 78 to the actual 175 tests across 5 files, in both the package README and the Published Packages section of the root README.
  - Removed the stale "Unicode/emoji rendered at single-cell width" limitation. CJK, fullwidth forms and emoji have had double-width rendering and visual-column positioning since the wide-character fix; the honest remaining caveat (per-code-point width summing over-counts ZWJ grapheme clusters) replaces it.
  - Documented the previously undocumented public `setPrompt()` method for switching prompt strategies at runtime, and the new "Wide characters (CJK, emoji)" integration section covering the optional `Unicode11Addon` path and the built-in range-table fallback.
  - Documented `backgroundColor: 'transparent'`, corrected the `foregroundColor` default, and updated the grid-alignment math to reflect visual-column positioning rather than character index.

  No source changes, docs only.

## 1.9.1

### Patch Changes

- Narrow the Run dropdown, and close the last two gaps in web-tab asset rewriting.

  **The Run dropdown was pinned at its full width.** It capped at 300px, and the recent-session rows wanted 326px, so it always rendered at the cap and reached further across the terminal than it needed to. Now 250px, chosen as the width at which a `~/<dir>/<repo>` + timestamp row still fits whole, since identifying a session to resume is what that list is for. Three fixes were needed to make the narrower menu degrade instead of clip: the saved-URL label now has its own element, because `text-overflow` on the row button did nothing (a bare text node inside a flex container becomes an anonymous flex item that ellipsis cannot reach); `.hist-dir` got `min-width: 0`, without which a flex item refuses to shrink below its own text and pushes the date out of the box; and history rows are held to the container width, because the list's `overflow-y: auto` implicitly makes `overflow-x: auto` and let each row size to its own content and scroll sideways. Phone and tablet widths are unchanged, being set separately in `mobile.css`.

  **A dashboard's own `/api/...` assets are relayed again.** The `Referer`-keyed 404 fallback, which rescues a root-absolute asset that no rewrite layer could reach, refused everything under `/api` outright. Dashboards commonly serve their assets from exactly that namespace, so those requests had no rescue at all. The refusal is now precise: the relay runs before the API-shaped 404, and the auth exemption refuses only paths that resolve to a REAL Codeman route, with `/ws/` and `/q/` still refused by prefix.

  Two findings shaped that fence, both from probing Fastify rather than reading it. `hasRoute()` matches the registered PATTERN literally, so `/api/sessions/abc` reports no match against a registered `/api/sessions/:id` and would have granted an unauthenticated exemption on a live session-scoped route; `findRoute()` performs the real lookup and is what the fence uses. And `@fastify/static` is mounted at `/`, so it registers a root catch-all matching every path, which has to count as "no real route" or the fence would refuse every referer-form request and break the rescue that already worked. A root catch-all is distinguishable because it is the only route whose wildcard param comes back equal to the whole request path. The fence fails closed, and both edges are pinned in `test/webview-auth-exemption.test.ts`.

  **`url()` inside runtime CSS is rewritten.** Measuring the fallback against a purpose-built dashboard showed one sink no relay can reach: a `<style>` element built by page script has no URL of its own, so the browser sends an EMPTY `Referer` with the image request it triggers. The injected URL shim now rewrites root-absolute `url()` in `<style>` blocks, both as markup and when a `<style>` node is inserted. Verified in Chromium: a stylesheet-only `/api/hero.png` and a runtime `<style>` `/api/late.png` both load, where both previously failed. The remaining known gap is self-navigation via `location.href`, which cannot be patched because `Location.href` is unforgeable.

## 1.9.0

### Minor Changes

- 2667150: feat(mobile): browse and insert local file and folder paths

  Add a root-confined filesystem picker to Link Existing and the extended mobile
  keyboard bar. Selected paths remain editable at the active prompt, supported
  images/documents/text files open in a safe inline preview, and a new one-tap
  action clears only the current unsent input without invoking `/clear`.

### Patch Changes

- 3cff98f: Fix two multi-user scoping holes in the new filesystem path picker. `GET /api/filesystem/browse` and `GET /api/filesystem/preview` accept an optional `sessionId` that contributes the session's working directory as a browse root, but they resolved it straight off the session map without an ownership check, unlike the nine other session-scoped handlers in the same route file. A non-admin could therefore pin another user's working directory as a root simply by passing their session id, then list and preview files under it. Both endpoints now run `canAccessOwned` and report 404, which also avoids confirming that a session id exists.

  Separately, `Home` and `CASES_DIR` were unconditional browse roots for every caller. Per-user spaces live at `<USER_SPACES_DIR>/<username>`, which is inside `homedir()`, so the `Home` root alone exposed every other user's workspace to any authenticated user. In multi-user mode a non-admin now gets only their own space plus anything explicitly listed in `CODEMAN_FILE_PICKER_ROOTS`; `/mnt/d` is no longer offered by default, since a broad host mount should be an explicit operator decision in a multi-user deployment. Admins keep the host-wide roots, and single-user mode is unchanged.

  Both holes are regression-guarded in `test/routes/file-routes.test.ts`, verified to fail against the previous code. Multi-user mode is opt-in and off by default, so single-user installs were never affected.

- Web tabs: delete saved URLs from the Run dropdown, and fix images in proxied dashboards.

  **Saved URLs are now manageable from the dropdown.** Each row under "Web / URL" gains a gear and an `x`, so a URL can be edited or deleted without first opening it as a tab. Previously the only delete path ran through the gear on an open tab, which was a dead end for a URL you no longer wanted open at all. Both controls stay permanently visible rather than hover-revealed, because the same menu is used on touch, and they get a larger hit box there. Deleting leaves the dropdown open on the remaining rows, and deleting the dashboard that is currently open also closes its tab and unmounts its frame.

  **Runtime-injected images no longer 404.** A dashboard that renders its own markup from script (`card.innerHTML = '<img src="/api/hero?slug=x">'`, `img.src = '/api/slide'`) escaped every rewrite layer at once: `<base href>` never applies to a root-absolute URL, the server-side attribute rewrite only ever sees the initial document, and `runtimeUrlShim()` patched only `fetch`, `XMLHttpRequest`, `WebSocket` and `EventSource`. Those requests landed on Codeman's own root and 404'd, with a symptom that reads as an upstream fault: the dashboard's data loaded while every image stayed broken.

  The shim now also covers the DOM URL sinks, so the request is never emitted in the first place and neither the `/api` fence in the 404 fallback nor the one in the auth middleware had to move. It wraps `innerHTML`, `outerHTML`, `insertAdjacentHTML` (including on `ShadowRoot`), `setAttribute`/`setAttributeNS`, and the `src`/`srcset`/`href`/`poster`/`data`/`action` property setters on img, source, media, video poster, script, iframe, embed, track, link, anchor, area, object and form, with a `MutationObserver` as a last net for sinks not patched above. Every rewrite routes through the same idempotent helper, which matters because unlike the server-side rewrite this one sees markup that may already be proxied, and a page re-injecting its own `outerHTML` would otherwise double-prefix. Everything is defensively guarded and marked so a double injection cannot wrap an already-wrapped setter.

  Measured against a real dashboard: 693 image elements, 0 of them under the proxy prefix and 0 of 23 in-viewport images decoded before, 693 and 23 of 23 after. Covered by a new jsdom suite over the shim's DOM half and a new frontend suite over the dropdown rows. Known remaining gaps are documented in `docs/web-tabs.md`: a root-absolute `url()` inside a stylesheet injected at runtime, and self-navigation via `location.href`, which cannot be patched because `Location.href` is unforgeable.

  Also in this release: a value-first README overhaul pointing at getcodeman.com, and the QR-auth distribution test now uses a chi-square check instead of a max-deviation threshold that failed on random variance.

- bca56b4: Normalize Claude conversations in the response viewer. A Claude transcript is an append-only event log, so one logical exchange spans many JSONL rows: tool-result rows, meta/image/skill rows, compact summaries, task and team notifications, sidechains, replayed assistant snapshots, and multi-block assistant output. The viewer rendered a card per row, which produced duplicate and truncated cards that read as lost responses. Cards are now built at real human-turn boundaries, replayed assistant snapshots are deduplicated, and sidechain rows (which belong to subagents, not the main conversation) no longer leak in. An identical prompt that legitimately recurs after an assistant reply is still kept as its own turn.

  Measured over 40 real transcripts: 3108 cards became 621, duplicate cards dropped from 74 to 8 (all of them genuinely repeated turns), no assistant text was lost, and the non-`context=full` last-response text was byte-identical on every file.

  Also rebinds recovered sessions to their transcript. `reconcileSessions()` can recover a lost mux session as a `restored-<uuid8>` placeholder with a stale working directory, which made transcript lookup by cwd find nothing. The placeholder still carries the first eight characters of the conversation UUID, so the viewer now rebinds to the matching top-level transcript when exactly one candidate matches.

## 1.8.3

### Patch Changes

- 8c089a4: Add four light UI and terminal skins: Paper Gray, Solarized Light, Catppuccin Latte, and Rosé Pine Dawn. The Skin picker now groups Light and Dark options, and each light skin ships a matching xterm ANSI palette plus `color-scheme: light` so native selects, date pickers and scrollbars stop rendering as dark OS widgets on a light page. Terminals set `minimumContrastRatio: 4.5` under a light skin (main terminal and teammate terminals both), which keeps CLI output that assumes a dark background readable, and `applyTerminalSkin()` now refreshes the zero-lag input overlay so typed-but-unflushed text does not keep the previous theme's colors.

  Elevated surfaces (modals, command palette, dropdowns, subagent and ultracode windows, file preview, attachment tray, mobile sheets) now resolve through shared `--floating-bg` / `--control-*` / `--banner-bg-*` / `--modal-backdrop` / `--elevated-shadow` tokens instead of hardcoded near-black rgba, so they follow whichever skin is active. On the Daylight skins this lifts modals slightly off the page background; OG Codeman pins its own near-black value to keep that palette neutral.

  Also defines twelve CSS compatibility aliases (`--bg-primary`, `--bg-secondary`, `--bg-tertiary`, `--text-primary`, `--text-secondary`, `--border-color`, `--accent-color`, `--success`, `--error`, `--danger`, `--font-mono`, `--shadow-lg`) that panels and overlays already referenced in about 79 places but which were never actually declared, so those rules silently resolved to nothing. Status badges and accent-tinted pills (search filter chips and result badges, session tab mode pills, respawn state, Ralph priority and circuit-breaker badges, tunnel and voice status, mobile case picker) no longer keep their pale light-on-dark ink under a light skin, where it measured 1.0 to 1.9:1 and made the search filter chips invisible.

  New static regression `test/skin-themes.test.ts` guards the four-way parity between the CSS token block, the xterm palette, the pre-paint allowlist and the Settings picker.

## 1.8.2

### Patch Changes

- Web tabs: open dashboard URLs as tabs beside agent sessions, plus terminal link fixes.

  **Web tabs.** The Run dropdown gains a "Web / URL" section. A saved URL renders as a tab in the same strip as Claude/Codex/Gemini sessions, with the same Alt+1-9 numbering, an icon picker, and per-device tab order. Frames stay mounted while hidden (LRU-bounded), so switching tabs never reloads a dashboard.

  Dashboards are proxied through Codeman's own origin, because a direct iframe fails three ways at once: an HTTPS Codeman cannot embed a plain-HTTP target (mixed content, with no override at all on iOS Safari), many dashboards send `X-Frame-Options: DENY`, and Codeman's own `default-src 'self'` CSP blocks cross-origin frames. Proxying dissolves all three and leaves the production CSP unchanged. The fetch happens server-side, so a tailnet-only or localhost-only dashboard is reachable from any device that can reach Codeman.

  The proxy is not an API surface: it authenticates on a 192-bit capability in the path (memory-only, rolling TTL, bound to the minting user, revoked on edit or delete) and is exempt from the cookie and Origin checks, because a sandboxed iframe is opaque-origin and sends neither. The Host allowlist is never bypassed. Iframes omit `allow-same-origin` unless a URL is explicitly marked trusted, and `Authorization` plus the session cookie are stripped upstream in both modes so `CODEMAN_PASSWORD` cannot leak into a dashboard. Includes an HTTP and WebSocket proxy, redirect/cookie/`<base>` rewriting, a runtime URL shim for requests built by dashboard JavaScript, and CORS handling for the opaque-origin frame. New endpoints under `/api/webviews`, storage in `~/.codeman/webviews.json`, user guide in `docs/web-tabs.md`.

  **Terminal links no longer truncate.** Three separate cuts, each producing a link that opened the wrong target or none at all:
  - A single `&` ended the match, so every query string was cut. A WordPress edit link resolved to `?post=1479` and Claude Code's own `/login` URL was unusable. `&` is now part of a URL while `&&` remains a boundary.
  - Links wider than the terminal were cut at the row boundary. The link provider now stitches continuation rows into one logical line and maps offsets back across rows. Handles both soft wraps (emulator, `isWrapped`) and hard wraps (a program wrapping its own output and emitting a newline, as Ink does), the latter being why the `/login` URL grew longer as the window was widened.
  - Image and PDF paths were not matched at all, so pasted-screenshot paths rendered as plain text. They now link and open the file preview, which renders images inline.

  **Also fixes** a pre-existing bug where `.toolbar`'s `backdrop-filter` created a stacking context that trapped the Run menu's z-index, letting the welcome overlay cover it: with no session open, every item in that menu (Claude Code included) was unclickable.

## 1.8.1

### Patch Changes

- Mobile toolbar: a dedicated Enter button, and Shell moves into the Run dropdown.

  Submitting is a constant need on a touch keyboard, so on phones (≤430px) the toolbar slot that held "Shell" now holds a dark blue **Enter** button. Starting a shell, the far rarer action, moves into the expandable Run dropdown as `Terminal / Shell` (the Run button then reads "Run SH"). Desktop and tablet are unchanged: the green Run Shell button stays exactly where it was.

  Enter is replayed through the terminal's own input path rather than posted to the input API. This matters because local echo is on by default on touch devices: the characters you type are buffered client-side and have not yet reached the PTY, so sending a bare carriage return would submit an empty line and leave your text stranded on screen. Replaying the keypress flushes the buffered text first, then submits.

  Installer: re-runs and updates now preserve the existing network binding instead of silently reverting it, so upgrading no longer changes how the dashboard is reachable.

  Default desktop header is cleaner: the file viewer is shown by default and the plan-usage chip is unchanged, while the token-count chip and lifecycle-log button now default off. Stored preferences are still honored.

  Docs and repo housekeeping: fresh phone screenshots and a new hero GIF in both READMEs, contributor and total-commit badges, and a much shorter repo root. `SECURITY.md` moved to `.github/` (GitHub resolves it there, so the Security policy tab is unaffected), `SPEEDRUN.md` to `docs/`, the knip config to `config/`, and Prettier's config into the `"prettier"` key of `package.json`. `CLAUDE.md` was split so the always-loaded guidance is roughly half its former size, with the deep implementation detail preserved verbatim in `docs/architecture-invariants.md`.

## 1.8.0

### Minor Changes

- Installer: choose your network binding, with LAN access as the new guided default.

  The install script now asks at the end of setup how the dashboard should be reachable:
  1. Any device on your network (0.0.0.0), the default. The installer prompts for a dashboard password (hidden input, confirmed twice); declining a password requires an explicit confirmation and the install ends with a prominent warning explaining the exposure.
  2. This machine only (127.0.0.1), the safer option for tunnel/Tailscale setups.

  The choice is wired into the generated systemd unit and launchd plist (values escaped for each format), the run-now launch path, and the printed URLs, which now include the detected LAN IP for instant phone access. Non-interactive installs keep the safe loopback default unless CODEMAN_HOST is preset, and the server binary's own default binding (127.0.0.1) is unchanged, so npm and manual installs behave exactly as before. New installer env presets: CODEMAN_HOST and CODEMAN_PASSWORD skip the prompts for automation.

## 1.7.1

### Patch Changes

- Mobile and UI polish plus docs refresh.
  - Mobile: the header brand collapses to a single "C" home button on phones (<430px), freeing header space for session tabs while keeping the same tap target. The compact letter lives in its own span so i18n custom branding keeps rewriting only the full wordmark.
  - UI fix: the absolutely-centered toolbar voice button no longer overlaps the case picker's chevron and "+" button. Below ~1500px (or with long case names widening the left toolbar group) it now falls back into normal flex flow where overlap is impossible; wide viewports keep the centered layout.
  - Docs: README gains a hero pitch block with deep links, npm version + GitHub stars badges, and a star CTA; CLAUDE.md core-files table synced (Infra docker modules, app.js line count); blog article images added under docs/images/blog/.

## 1.7.0

### Minor Changes

- Community release (thanks @shenlvkang-collab for all four PRs) plus documentation fixes.
  - fix(mobile): per-device settings now key off a stable handheld classification (`MobileDetection.isHandheldDevice()`: touch plus UA form-factor tokens, with User-Agent Client Hints fallback) instead of the instantaneous viewport width, so an Android foldable that unfolds past the desktop breakpoint keeps `codeman-app-settings-mobile` and opt-ins such as the Response Viewer and Extended Keyboard Bar. Responsive layout stays width-driven. Adds an OPPO Find N5 (unfolded) device profile and a fold/unfold/reload Playwright regression test (mobile suite now 136 devices). (#162)
  - fix(paths): `SAFE_PATH_PATTERN` now accepts Unicode letters and numbers (`\p{L}\p{N}` with the `u` flag), so working directories like `/mnt/d/AI/中文项目` validate in Create Session, Quick Run, and Scheduled Run. All shell-metacharacter, traversal, and absolute-path protections are unchanged. (#163)
  - fix(ui): newly created run sessions render their tab immediately instead of waiting for the `session:created` SSE event (idempotent upsert from the POST response, with a `GET /api/sessions/:id` fallback for quick-start modes), and the Run button holds an in-flight lock (min 500 ms) so a double click cannot create duplicate sessions. (#164)
  - feat(ui): the synced custom display name and per-device English/Simplified Chinese UI language are described in their own entry (#165); on top of that PR, `renderIndexHtml` no longer recomputes `windowTitle` on solo-session renders, so a detached window cannot reset the push-notification `hostTitle` prefix to the default name.
  - docs: corrected the `sse-events.ts` fileoverview breakdown (148 event constants, was stale at 120; per-category counts refreshed, including Cron, Docker, Remote auto-reconnect, and Multi-user) and the CLAUDE.md SSE registry count; READMEs synced with the 1.6.2 installer behavior.

### Patch Changes

- 8d9fc41: Add a synced custom display name and a per-device English/Simplified Chinese browser UI language picker under App Settings → Display.

## 1.6.2

### Patch Changes

- Installer (install.sh) reliability and safety overhaul, prompted by a review of the Linux flow:
  - Install-completion marker (`.install-complete`): a bare re-run only takes the quiet update path when a previous install actually finished. Previously, a first install that failed during npm install/build (or was interrupted) left `.git` behind, so the retry silently became an "update" and the user never got the launch menu, the `codeman`/`tmux-chooser` symlinks, the PATH entry, or the `sc` alias. The marker is refreshed by updates and cleared by uninstall when the app dir is kept; added to .gitignore for end-user clones.
  - `update` no longer runs an unconditional `git reset --hard` over local changes: interactive runs are asked to stash (declining keeps everything and skips the update), headless runs auto-stash with a dated message (same policy as scripts/self-update.sh).
  - Service setup is verified instead of asserted: after starting codeman-web, the installer polls `systemctl --user is-active` (up to 6s) and only then prints "Codeman is running now!"; failures print an honest warning plus status/journalctl hints. Uses `restart` instead of `start` so re-running the installer over an already-running service actually loads the new build. A missing user D-Bus session (e.g. bare `ssh host 'curl | bash'`) is detected up front with copy-paste recovery commands instead of dying mid-setup via `set -e`. macOS gets the equivalent `launchctl list` verification, and the update path verifies its service restart too. The Cloudflare tunnel-service offer is skipped when service setup failed.
  - Headless consent guard: with no interactive terminal AND no explicit `CODEMAN_NONINTERACTIVE=1`, the installer now refuses (with instructions) to run sudo package installs (git/node/tmux) or third-party `curl | bash` AI CLI installers, instead of silently taking the default-yes prompts. Explicit `CODEMAN_NONINTERACTIVE=1` keeps the previous full-auto behavior for CI/automation.
  - AI CLI gate now recognizes Codex and Gemini (search paths mirrored from the CLI resolvers), so a box with only Codex or Gemini installed is no longer forced to install Claude Code/OpenCode. The install menu gains a "Skip" option (with npm install hints for Codex/Gemini), and the final reminder lists all four CLIs.

  Docs: CLAUDE.md documents `src/remote-reconnect.ts` (pure COD-108 auto-reconnect backoff/eligibility logic) in the Infra table and the remote-sessions pattern.

## 1.6.1

### Patch Changes

- **Admin Panel for multi-user mode.** Admins in multi-user mode now get a prominent Admin Panel button at the top of the page (header, admin-only; the template ships it hidden and `admin-ui.js` reveals it after identity boot; hidden on phones per the mobile header policy, where user management stays reachable via App Settings > Users). It opens a full Admin Panel modal: a users table with role, enabled/disabled status, bypass-permissions grant, live sessions, active logins, case count, and last login; per-user actions for Promote/Demote, Enable/Disable, Grant/Revoke bypass, Reset password (copyable one-time password), Force logout, and Delete (with an optional "also delete their files" step); and a proper add-user form (role, optional password, bypass checkbox) replacing the old prompt() flow. Each user's cases open in a drawer listing their case folders (modified date, live-session badge) with per-folder delete. Two new admin endpoints back this: `GET /api/admin/users/:username/cases` and `DELETE /api/admin/users/:username/cases/:caseName`, guarded like `deleteUserSpace` (symlinks refused, realpath confined to the user's space, folders in use by a live session refused with 409, audit-logged). The panel and the App Settings Users tab live-refresh on the SSE `admin:usersChanged` event (now wired in app.js). New coverage in `test/admin-routes.test.ts` (list/delete, traversal + symlink refusal, non-admin 403) and `test/admin-ui.test.ts` (button reveal gating, panel render, case drawer); verified end to end against a live multi-user instance with curl and Playwright.

  **Also in this release:** README/docs synced with 1.6.0 (remote SSH cases, session manager, permissions) and fixed installer prompts when run via `curl | bash`.

  **Recap of the recent feature line, for readers catching up:**
  - **Multi-user mode (shipped 1.5.0, opt-in `--multiuser` / `CODEMAN_MULTIUSER=1`).** Named users with scrypt-hashed passwords, per-user case spaces under `~/codeman-users/<name>/cases`, and full ownership scoping of sessions, cases, cron jobs, scheduled runs, search, file previews, and SSE/WS streams. Non-admin users default to Claude's classifier-guarded `--permission-mode auto`; shell mode, cron `launchCommand`, and skip-permissions bypass switches require the per-user `canBypassPermissions` grant (now toggleable from the Admin Panel). Admin API with one-time passwords, last-admin invariants, and an append-only audit log; self-service `/api/me` password change; `codeman users add|passwd|list|rm` CLI. Off by default is byte-identical to single-user. Note: multi-user separates workspaces for a trusted team; it is not a security boundary (all sessions share the host OS account), so pair it with Docker cases for real isolation.
  - **Docker cases (shipped 1.4.0/1.4.1).** A case can run inside an isolated per-case container (any of the five CLI backends), with one-click "Run in Docker" quick-create, durable in-container tmux that survives Codeman restarts and resumes conversations after container stops, hardened container creation (cap-drop ALL, no-new-privileges, non-root, memory/pid limits, never privileged, never the docker socket), commit-safe seeded credentials, config-drift detection, GPU passthrough, and portable export/import bundles to move a whole case between machines.
  - **1.6.0 highlights.** Remote SSH cases with durable remote tmux (survives SSH drops, auto-reconnect, shared multi-client attach, discover + attach with detach-not-kill); the Cmd+K session palette and unified Session Manager with pinning, cross-device tab order, and first/last prompt search; full-scrollback replay; and the multi-user permission downgrade now threading through to remote launch/attach.

## 1.6.0

### Minor Changes

- Remote tmux durability, Session Manager polish, and an opt-in Cron button.

  **Remote sessions: durability, discovery, and auto-reconnect** (PR #156 by @aakhter, COD-104 to COD-109)
  - Durable remote launches survive an SSH drop: the agent runs inside `tmux -L codeman-remote new-session -A` on the remote host, and reconnecting lands back in the same session.
  - Discover + attach: a "Discover existing sessions" action per remote host lists `codeman-*` tmux sessions on the host's canonical socket (started by the remote's own Codeman or another instance) and attaches to one. Attached (non-owned) sessions detach on tab close, never kill; a structural early-return in `killSession()` guarantees no remote `kill-session` can ever be issued for a session Codeman doesn't own (COD-105).
  - Shared/collaborative sessions: per-session `window-size latest` so concurrent clients at different viewports don't clamp each other, plus a "shared - N clients" badge in discovery results (COD-106).
  - Auto-reconnect watcher: a bounded-backoff (5s to 5m, ~6 attempts) watcher detects a dead remote pane and reattaches the still-running remote tmux session; intentional kills/detaches are guarded and never revived. Kill-switch setting `remoteAutoReconnect` (default on). SSE `remote:sessionDropped`/`sessionReconnected`/`reconnectExhausted`, with a manual Reconnect toast after exhaustion (COD-108).
  - Owned durable sessions propagate `kill-session` to the remote on close (COD-109); the remote tmux prereq probe is skipped under the test runner (COD-104).
  - All ssh command lines continue to flow through the single shell-safe `buildSshConnectionArgs()` (COD-107). New design doc: `docs/remote-sessions.md`.
  - Maintainer additions: the discovery endpoint is admin-gated in multi-user mode, and the remote launch/attach chooser threads the multi-user permission downgrade (`claudeMode`/`allowedTools`) through to the remote agent.

  **Session Manager: pinning, cross-device ordering, name/prompt retention** (PR #157 by @aakhter, COD-131/139/140/142/143/145)
  - Session pinning: pin a session to the top of the Session Manager list (`POST /api/sessions/:id/pin`, `session:pinned` SSE, amber highlight + pin glyph). Pinned group orders most-recently-pinned first (COD-139).
  - Pinned sessions survive kill: killing a pinned session demotes its record to a lightweight stopped entry instead of removing it, so it stays visible and resumable; cleanup skips pinned records (COD-142). The pin route also works on these persisted-only records, so a pinned-then-killed session can always be unpinned.
  - Cross-device tab order: tab order syncs via server state (`PUT /api/session-order`, `session:orderChanged` SSE, persisted in `state.json`); the pushing device wins and server-only ids fall to the end, never dropped (COD-131).
  - Resuming from the Session Manager keeps the session's original name instead of always synthesizing a fresh `w<N>-<dir>` one (COD-143).
  - firstPrompt backfill for sessions whose Codeman id is not the transcript UUID (claudeSessionId join, then newest transcript in the same workingDir), and the most recent prompt is shown alongside the first and included in search (COD-140/145).

  **Cron button now opt-in** (hidden by default)
  - The Cron footer-toolbar button follows the same opt-in pattern as the Session Manager / Away Digest / File Viewer buttons: hidden by default, enable per device under App Settings -> Display -> Header Displays. Cron jobs themselves are unchanged.

  Also: `docs/remote-sessions.md` synced with the shipped `-L codeman-remote` / `codeman-ssh-<id8>` naming.

## 1.5.1

### Patch Changes

- Docker session-mode deep-review fixes — the work intended for the skipped **1.4.2**, now merged onto the 1.5.x line — plus a recap of the multi-user mode shipped in 1.5.0.

  **Docker resume actually works now.** `DockerCase.lastClaudeSessionId` was read at quick-start but never written, so the documented resume-after-container-stop never fired. Claude-mode docker panes now pin a deterministic conversation id (`claudeDockerPaneCommand()`): a fresh launch runs `claude --session-id <id> || claude --resume <id>` (a duplicate `--session-id` exits 1 "already in use", so the fallback resumes after a container stop/reboot — verified CLI behavior), an explicit resume runs `--resume <rid> || --session-id <sid>` so a stale id never dead-panes. The id is persisted at launch and again on hook / last-response conversation-id adoption. Verified end-to-end across a `docker stop` + relaunch and a full container recreate.

  **Config-drift detection + recreate (was documented but entirely missing).** The `codeman.confighash` label was stamped but never read, so docker-host config edits silently never applied. Quick-start now compares via `checkDockerConfigDrift()` and refuses a drifted launch with `CONFLICT`; the UI confirms and calls the new `POST /api/docker-cases/:name/recreate` (refused while the case has live sessions), then relaunches with the new config. New SSE event `docker:containerRecreated`.

  **Model picker now applies to docker sessions.** `modelOverride` was absent from `QuickStartSchema`, so the App Settings Claude Model choice was silently inert for docker runs. It is now accepted and applied via `updateCaseModel` for local and docker quick-starts (still rejected for remote, where the settings file would land on the wrong machine).

  **Import hardening.** `importDockerBundle` validates the untrusted cross-machine manifest before trusting any field (`validateImportManifest`: engine/image/containerWorkdir/network/caseName/schemaVersion — a hostile `engine` could previously select the probe binary); the outer bundle tar gets the same member-traversal guard as the inner workspace tar; the quarantine image tag derives from the schema-validated case name.

  **Remote-daemon correctness.** All docker probes and the base-image auto-build now honor a host's `context`/`daemonHost` (`dockerEngineArgv`) instead of always probing the local daemon.

  **Smaller fixes:** commas are rejected in docker workspace/workdir/destination paths (a comma corrupts the `--mount type=bind,src=…` CSV spec, which shell escaping cannot protect); a dead `this.escapeHtml` reference in the exports refresh is fixed; `docker:importComplete` / `docker:containerRecreated` get frontend SSE listeners so other open tabs refresh; the File Viewer header button is hidden on phone headers like its siblings.

  **Docs.** CLAUDE.md + READMEs synced with the current feature set, including a full zh-CN README re-translation.

  **Multi-user mode (recap — shipped in 1.5.0).** Opt-in named users (`--multiuser` / `CODEMAN_MULTIUSER=1`, off by default) with per-user case spaces and full ownership scoping of sessions, cases, cron jobs, scheduled runs, search, file previews, and real-time SSE/WS streams. Non-admin users default to Claude's classifier-guarded `--permission-mode auto`; raw shell mode, cron `launchCommand`, skip-permissions, and the Codex/Gemini bypass switches require an explicit per-user `canBypassPermissions` grant. Machine-level resources are admin-only. Admin API (`/api/admin/users*`) with one-time passwords, last-admin invariants, and an append-only audit log; self-service `/api/me` + password change; and a `codeman users add|passwd|list|rm` CLI. Off by default is byte-identical to single-user. Note: multi-user separates workspaces for a trusted team; it is not a security boundary between mutually-distrusting users (all sessions share the host OS account) — pair with Docker cases for real isolation.

## 1.5.0

### Minor Changes

- 0ab2416: Opt-in multi-user mode (`--multiuser` / `CODEMAN_MULTIUSER=1`, off by default).

  Named users with individually scrypt-hashed passwords in `~/.codeman/users.json`, per-user case spaces under `~/codeman-users/<name>/cases`, and ownership scoping of sessions (create/list/delete/mutate, incl. bulk delete), cases, cron jobs + run history, scheduled runs, search, file previews, session history, away digest, subagent/workflow monitors, and real-time SSE/WS streams (including the debounced session/task update path, clipboard, and push notifications). A non-admin's `workingDir` is realpath-confined to their own space at every spawn/link path (session create, quick-start, cron create/fire, scheduled runs, case link/docker-link, docker import). Non-admin users default to Claude's classifier-guarded `--permission-mode auto`; raw shell mode, cron `launchCommand`, skip-permissions, and the Codex/Gemini bypass switches require an explicit per-user `canBypassPermissions` grant (enforced at every spawn site incl. one-shots, plan generation, scheduled runs, and remote launches). Machine-level resources (remote/Docker hosts + host reads, mux sessions, orchestrator, tunnel, self-update, settings) are admin-only. Admin API (`/api/admin/users*`) with one-time passwords, last-admin invariants (validated before any teardown), and an append-only audit log; self-service `/api/me` + password change; a frontend admin Users tab + change-password modal; and `codeman users add|passwd|list|rm` CLI. Also adds a global `auto` Claude startup permission mode. When off, behavior is byte-identical to single-user.

  Auth hardening: the login throttle verifies the password before consulting the per-account failure bucket (a correct password can never be locked out); the `mustChangePassword` lockbox covers the WebSocket terminal; the cookie fast-path re-validates identity against the store each request (so a CLI/admin delete/disable/demote takes effect promptly); a role/grant change revokes the target's sessions. (Known limitation: a bare CLI `codeman users passwd` reset — no delete — does not by itself revoke an already-active cookie until it expires; use `codeman users rm`, the admin API, or a restart to force-revoke.) Data-integrity hardening: the store distinguishes a missing users file from a corrupt/unreadable one (so a transient read error can't overwrite all accounts) and writes via a unique per-process temp file; the earlier fire-and-forget `touchLastLogin` corruption race is serialized.

  Note: multi-user mode separates workspaces for a trusted team; it is not a security boundary between users (all sessions share the host OS account). Pair with Docker cases for real isolation.

## 1.4.1

### Patch Changes

- **Docker session mode** hardening + fixes, plus a File Viewer header button.

  **What Docker session mode is** (recap): a case can run inside an isolated, hardened Docker container instead of on the host, and any of the CLI backends (Claude, Codex, Gemini, OpenCode, or a plain shell) runs inside it. It is a location overlay on cases — not a new session mode — and the container analog of remote-SSH cases: a local tmux pane `docker exec`s into a durable in-container tmux, with exactly one long-lived container per case that multiple sessions share. The workspace, credentials, and conversation transcripts are bind-mounted so the agent is authenticated and resumable; containers are hardened by default (`--cap-drop ALL`, `--security-opt no-new-privileges`, non-root, pids/memory caps, `--init`, never `--privileged` or the docker socket) and export-safe. Start one with the one-click "Run in Docker" checkbox on Create Case, or the Docker tab for full control.

  This release fixes the rough edges found running it for real:

  Docker cases:
  - **Seamless Claude auth in containers**: `~/.claude.json` is no longer bind-mounted as a single file (a mount point that broke Claude's atomic-rename config writes — forcing re-auth and, via failed in-place writes, corrupting the host `~/.claude.json`). It is now seeded as a writable, onboarding-complete copy, so a docker session boots straight to the prompt (no theme picker, login, or folder-trust prompt).
  - **Claude-state isolation**: containers no longer bind-mount the whole `~/.claude` directory (which wrote backups/tasks/teams/settings back into the host). Only `~/.claude/projects` transcripts are shared (host watchers + `--resume`); credentials, settings, and stats-cache are seeded as writable copies; everything else stays container-local.
  - **Codex/Gemini/gcloud/opencode isolation**: same treatment — codex shares `sessions/` + `history.jsonl` (response-viewer + resume) and seeds `auth.json`/`config.toml`; gemini/gcloud/opencode are whole seed-copies. Containers never write their credential state back into the host dirs.
  - **Base image auto-builds on first use**: a missing `codeman/agent:base` no longer blocks case creation or launch; it builds locally on first use (concurrency-safe, with SSE progress toasts).
  - **UTF-8 locale**: containers set `LANG`/`LC_ALL=C.UTF-8` so tmux renders Claude's box-drawing correctly (fixes `qqqq` line artifacts).
  - **Create Case UI**: larger, collapsed-by-default "Run in Docker" settings with a shorter hint; dockerized cases show a short `(docker)` tag (or the custom host id) in the case menus.
  - **Tab naming**: docker/remote (and codex/gemini/opencode) sessions now follow the `w<n>-<case>` convention instead of `codeman-<id>`.

  Other:
  - **File Viewer header button** (opt-in via App Settings, Header Displays): toggle the file browser panel from the header.
  - Fixed a timezone-boundary flaky test in the away-digest route suite.

## 1.4.0

### Minor Changes

- Add **Docker session mode**: a case can now run inside an isolated Docker container instead of on the host, with configurable network / resource / credential settings, multiple sessions sharing one per-case container, and one-click export to move a container (toolchain + workspace) to another machine.
  - Docker is a location overlay on cases (not a new session mode), mirroring the remote-SSH feature: a local tmux pane runs `docker exec -it` into a durable in-container tmux server. The container is scoped to the case (`codeman-case-<name>`), so multiple sessions share it; killing one session never stops the shared container.
  - New `/api/docker-hosts` CRUD, `/api/cases/docker-link`, and a `/api/quick-start` docker branch. Create Case gains a **Docker** tab. Base image is built locally via `scripts/build-agent-image.mjs` (node + claude/codex/gemini/opencode + tmux, secret-free, arbitrary-uid-writable HOME).
  - Hardened by default: `--cap-drop ALL`, `--security-opt no-new-privileges`, non-root, `--pids-limit`, `--memory`==`--memory-swap`, `--init`; never `--privileged` or the docker socket. Convenient credential default bind-mounts host `~/.claude` etc. read-write (never captured by `docker commit`); a sealed profile is opt-in.
  - Two-layer durability: reconnect after a Codeman restart reattaches the same live agent; a container stop/reboot resumes the conversation from the bind-mounted transcript via `--resume`.
  - Export / import: full-image (`docker commit` + `save` + workspace tar + manifest) or workspace-only, to one portable `.codeman-container.tgz`; import validates checksums, guards path traversal, and re-tags the loaded image into a quarantined namespace. Instance-scoped boot reaper cleans orphaned containers. New `docker:*` SSE events. Docs in `docs/docker-cases.md`.
  - Robustness: sets `CLAUDE_CODE_TMPDIR` in the container so claude launches regardless of workspace path. In-container hooks require the server to be reachable from the container (documented); on a loopback-only bind, idle detection falls back to output-based.

  Also wire session, away-digest, and cron header-button visibility toggles in App Settings.

## 1.3.5

### Patch Changes

- a842f2d: fix(auth): slide the session cookie so active users aren't logged out

  Re-issue the `codeman_session` cookie on every authenticated request so the
  browser cookie lifetime tracks the server-side sliding TTL (the session store
  already uses `refreshOnGet`). Previously the cookie was only set on the Basic
  Auth path with a fixed 24h lifetime from login, so the browser dropped it
  mid-use; the next request arrived cookie-less, fell through to Basic Auth and
  popped the native username/password dialog, perceived as a random logout while
  actively working.

## 1.3.4

### Patch Changes

- Fix "Run Shell" not switching the terminal to the newly created shell session. Clicking Run Shell created the shell tab but left the previous session's terminal on screen, so you had to manually click the new tab to actually enter it. Root cause: `runShell()` pre-set `activeSessionId` to the new session's id right before calling `selectSession()`, and `selectSession()` early-returns when the requested id already matches the active one, so it skipped the terminal buffer load, tab activation, and focus. Removed the premature assignment in both the local and remote-SSH shell branches so `selectSession()` runs to completion (matching `runClaude`/`runCodex`/`runGemini`/`runOpenCode`, which already avoid this). Verified end-to-end in a real browser with a negative/positive control.

## 1.3.3

### Patch Changes

- Fix terminal scroll-back in Claude sessions, especially on macOS trackpads (#154).
  - **Deterministic CLI version detection.** `cliVersion` was often `undefined` because it was scraped from the `Claude Code vX.Y.Z` startup banner, which newer Claude Code builds (2.1.187+) don't reliably print and resumed sessions never show. With the version unknown, wheel-forwarding to Claude's transcript was silently disabled — and since repaint-mode Claude keeps no local terminal scrollback, scrolling up reached nothing. A new `getClaudeCliVersion()` probe (`claude --version`, cached, local-only) seeds the version at session start so forwarding engages. Restored sessions pick it up on restart.
  - **Trackpad Shift+scroll.** The wheel handler now reads the dominant axis, so a macOS trackpad's Shift+two-finger scroll — which the browser reports as horizontal `deltaX` — reaches xterm's local scrollback instead of collapsing to a fixed one line per tick.
  - **Opt-out setting.** New per-device App Settings → Input → "Wheel Scrolls Local History" (default off) pins the plain wheel to local scrollback (the pre-#144 behavior) for shell and other non-repaint sessions.
  - **No more "queued bytes" flicker on scroll.** Wheel-scroll reports now use a fire-and-forget send path (seq-less input frame) instead of the durable exactly-once input queue, so they no longer appear in the pending-bytes connection indicator or churn localStorage. Keystrokes, taps, and clicks still use the durable queue.

## 1.3.2

### Patch Changes

- Make the Cron Jobs modal fully skin-aware and consistent with App Settings' design language.
  - **Fix white dropdowns:** `.form-select` had no `appearance` reset and the app set no `color-scheme`, so native `<select>` fields rendered as white OS widgets that ignored the active skin. Selects now use `appearance: none` with an opaque `var(--bg-input)` fill, a `var(--border)` outline, and a custom chevron, so they follow the skin (daylight `#202833`, OG `#1a1a1f`). This is on the shared `.form-select` class, so App Settings, Cron, and every other select match and are fixed together.
  - Set `color-scheme: dark` on `:root` so native select option popups, date/time pickers, and scrollbars render dark across all three (dark) skins instead of flashing white.
  - Themed the Cron date/time inputs with `var(--bg-input)` / `var(--border)` instead of hardcoded values.
  - Fixed the Cron toolbar: "+ New Job" / "Refresh" and the footer Save / Cancel now use the full `btn-toolbar` size (matching the App Settings footer), with a wider gap and a divider under the toolbar for better spacing.

## 1.3.1

### Patch Changes

- Redesign the Cron Jobs modal to match the App Settings styling, and fix a bug that left its create form fully expanded.
  - **Fix:** the cron modal's "New Cron Job" form and all of its conditional rows (Launch Command, Prompt File Path, and the once/interval/daily/weekly schedule fields) never actually collapsed — there is no global `.hidden` utility in the stylesheet and the cron modal never scoped its own, so the form opened fully expanded with every field visible at once. Added a scoped `#cronModal .hidden` rule; the form now stays collapsed until "+ New Job" and only shows the fields relevant to the selected agent type, prompt source, and schedule type.
  - Sectioned the create/edit form into Basics / Prompt / Schedule / Options with the same section-header dividers used in App Settings, and increased row spacing.
  - Styled the agent-type / prompt-source / input-mode / schedule-type dropdowns and the datetime-local / time inputs to share the bordered, rounded, focus-ringed field look.
  - Converted the "Auto-close previous run's session" and "Enabled" toggles into App-Settings-style cards (label + description on the left, compact switch on the right).
  - Replaced the raw weekday checkboxes with pill toggles that fill with the accent color when selected.
  - Restyled the job list rows as hover-highlighted cards with pill badges (agent type, schedule, disabled) and right-aligned actions, and gave the modal a divider-topped Cancel / Save footer.

## 1.3.0

### Minor Changes

- Community release: 16 contributor PRs reviewed (multi-agent adversarial review), fixed, and merged. Thanks to @aakhter, @TeigenZhang, @chatgptkrylor, @kvncrw, and @pirronewantlux529-coder!

  **New features**
  - **Cron jobs** (#141, @chatgptkrylor): recurring scheduled jobs (once/interval/daily/weekly) that spawn a session and send a prompt when due — CRUD + run history (`/api/cron/*`), ⏰ modal UI, per-job concurrency policy and `autoClosePreviousSession` lifecycle, pure unit-tested next-run math. Distinct from the legacy `ScheduledRun`.
  - **Remote host SSH cases** (#145, @aakhter): link cases on remote hosts (`remote-hosts.json`/`remote-cases.json`), launch sessions over ssh into a durable remote tmux (dedicated `-L codeman-remote` socket; adoption-safe naming), per-host command overrides, injection-guarded schemas, remote tmux probe + ConnectTimeout, remote kill on delete, recovery-safe persistence.
  - **Command-K session palette + searchable case picker + shortcut registry** (#146, @aakhter): Ctrl/Cmd/Alt+K fuzzy session palette with "Browse all sessions" Session Manager; searchable quick-start case picker (remote-aware labels); rebindable shortcut registry with App Settings → Shortcuts tab and Ctrl+? overlay.
  - **Unified session list** (#139, @aakhter): `GET /api/sessions/unified` merges live/persisted/lifecycle/transcript sessions into one deduped list (resumed sessions fold via claudeSessionId alias map).
  - **Unified Session Manager UX** (#153, @aakhter): unified welcome list with mode/LIVE badges + per-row kebab menu, `projectKey` plumbing for "View all in this folder", SSE-driven live list refresh, desktop Session Manager header button.
  - **Full-scrollback replay** (#148, @aakhter): page reload replays the entire tmux scrollback (`?full=1`, bounded capture with proper maxBuffer) with CRLF normalization for shell panes.
  - **WebSocket resilience** (#149, @aakhter): reconnect with preserved exponential backoff, per-tab connection identity (multi-tab safe), ACK re-drive, and a truthful connection chip (WS/HTTP/reconnecting states).
  - **PTY-exit circuit breaker + TMUX scrub** (#147, @aakhter): rapid PTY crash-loops trip a breaker (SSE + critical push notification; explicit-restart-only reset); inherited TMUX vars are scrubbed so Codeman-in-tmux doesn't nest.
  - **Codex generated-artifact attachments** (#150, @aakhter): codex sessions surface `Saved to: file://…` outputs as attachment cards (realpath-anchored trust, codex-mode-gated, jpg/gif/webp thumbnails).
  - **Codex response viewer** (#152, @pirronewantlux529-coder): the eye button now works for Codex sessions via 4-layer rollout resolution (history pin → originator → resume-UUID → cwd) with dedup + injected-context filtering.
  - **HEIC paste conversion** (#151, @aakhter): iPhone HEIC pastes convert to JPEG server-side in a worker thread (concurrency-capped, 64MP decompression-bomb guard, magic-byte detection for mislabeled Android HEIFs). Deps: heic-decode + jpeg-js.
  - **WebGL renderer toggle** (#140, @kvncrw): per-device setting to switch xterm between WebGL and DOM renderers, cooperating with the GPU-stall auto-fallback marker.
  - **Raised terminal history defaults** (#138, @aakhter): tmux history-limit 50k→100k lines, PTY buffer 2MB/1.5MB→32MB/24MB (env-clamped so trim always stays below max).

  **Mobile & input fixes**
  - CJK input loss fixes: IME state machine, focus routing, Android InputConnection recovery — with content-free diagnostics (#143, @TeigenZhang).
  - Tap/click/wheel restored when the server strips mouse DECSETs — version-gated wheel passthrough (claude ≥ 2.1.187), link-click double-fire fix, Shift+wheel documented (#144, @TeigenZhang).
  - Response-viewer readability on phones + iOS dvh viewport fix (#142, @TeigenZhang).

  **Docs**: CLAUDE.md accuracy audit (18 verified fixes: security hook-bypass description, env-prefix allowlist, state-file inventory, watcher/function names, counts) + documentation for all new subsystems. README gains a user walkthrough (#141).

  All PRs went through adversarial multi-agent review; ~60 verified findings (including 12 blockers) were fixed on the contributors' branches before merge. Full test suite green: 3,400+ tests.

### Patch Changes

- bf36eb0: Add a **WebGL Renderer** toggle to Settings → Appearance (desktop). WebGL stays on by default; turning it off forces the DOM renderer for users who hit GPU glitches, without needing the `?nowebgl` URL param. Turning it back on (or `?webgl=force`) clears any stale auto-fallback marker. The existing mobile skip and long-task auto-fallback safety net are unchanged. The skip decision is factored into a pure, unit-tested `shouldSkipWebGL()` helper.

## 1.2.2

### Patch Changes

- Centralize terminal history/scrollback/buffer retention limits into config (PR #137, COD-80).

  New `src/config/terminal-history.ts` is now the single source of truth for the terminal scrollback lines, tmux `history-limit`, and server PTY buffer byte caps that were previously scattered as hardcoded literals across `buffer-limits.ts`, `tmux-manager.ts`, and `session.ts`. Each value is overridable (env var or the settings object) and bounds-clamped via a pure `resolveTerminalHistoryConfig()`.

  This change is behavior-neutral: the defaults intentionally match the prior hardcoded values (tmux history-limit 50,000; terminal scrollback 50,000; PTY buffer max 2 MB; trim 1.5 MB) and the existing `CODEMAN_MAX_TERMINAL_BUFFER` / `CODEMAN_TRIM_TERMINAL_TO` env overrides are preserved, so runtime behavior is unchanged on its own. It is the mechanism half of a stacked change; a follow-up raises the defaults.
  - `buffer-limits.ts` sources `MAX_TERMINAL_BUFFER_SIZE` / `TRIM_TERMINAL_TO` from the resolver.
  - `tmux-manager.ts` uses `DEFAULT_TMUX_HISTORY_LIMIT` in place of the hardcoded `history-limit 50000`, gains `setHistoryLimit()` (mux-interface + impl) so a settings change applies to live sessions, and re-applies the limit on `respawnPane` so it survives a respawn.
  - `session.ts` threads a per-session `tmuxHistoryLimit` into the tmux spawn calls; `server.ts` exposes `getTerminalHistoryConfig()` on the route ctx and `system-routes.ts` applies a changed `tmuxHistoryLimit` to live sessions immediately.
  - `schemas.ts` adds four optional, bounds-clamped settings keys (`terminalScrollbackLines`, `tmuxHistoryLimit`, `terminalBufferMaxBytes`, `terminalBufferTrimBytes`) with a `trim <= max` cross-field check.
  - New tests: `test/terminal-history.test.ts` (resolver defaults / clamping / trim<=max / non-number fallback) and `test/terminal-history-schema.test.ts` (settings-schema validation).

## 1.2.1

### Patch Changes

- Fix local echo on iOS Safari when switching into a tab whose session already has output. The on-screen-keyboard "heal" (refit + scroll-to-bottom + overlay re-render + one-shot resize) only ran on a keyboard visibility transition, so switching into a tab while the keyboard was already up never triggered it — leaving the local-echo overlay rendering against stale, off-bottom terminal state. Typed characters were invisible (or mispositioned at the cursor row, far below the actual `❯` prompt) until the user manually hid and re-showed the keyboard. `selectSession` now replicates that heal when the keyboard is already visible, so local echo paints correctly on the first keystroke after a keyboard-up tab switch.

## 1.2.0

### Minor Changes

- Merge four feature PRs and harden them for release.

  **Gemini run mode (PR #134, COD-36)** — a third external-CLI backend alongside Codex and OpenCode (`SessionMode` adds `'gemini'`). New `gemini-cli-resolver.ts`, `buildGeminiCommand()` (`--skip-trust`, `--approval-mode {default|auto_edit|yolo|plan}` defaulting to `yolo`, `--model`, `--resume`), `setGeminiEnvVars()` (socket-scoped `tmux setenv` of `GEMINI_*`/`GOOGLE_*` auth incl. Vertex AI), `GET /api/gemini/status` with an install hint (`npm install -g @google/gemini-cli`), run-mode dropdown + welcome "Run Gemini" button + "Run GM" label, `GeminiConfigSchema`, and `GEMINI_*`/`GOOGLE_*` added to the env-override allowlist. Requires tmux (no PTY fallback), like Codex.

  **Cross-session search (PR #133, COD-113)** — `GET /api/search?q=&types=&limit=` federates an in-memory search across session metadata, run-summary events, and attachment-history file entries (substring match, hard caps, no FS reads); history-panel search box in the frontend.

  **Away digest (PR #136, COD-41)** — `GET /api/away-digest` aggregates "what happened while you were away" (lifecycle log, run summaries, live sessions, daily token stats, recent subagents) into categorized sections behind a header-button modal (hidden on phones).

  **Ralph todo-config (PR #135, COD-79)** — per-session `maxTodos` and `todoExpirationMinutes` via `POST /api/sessions/:id/ralph-config`; now persisted in `RalphTrackerState` and read back into the Session Options modal (mirrors `maxIterations` round-trip).

  **Review fixes applied on merge:**
  - Gemini: fixed two `{success,data}` envelope bugs in `runGemini()` (status check and new-session selection) that made the Run-Gemini button non-functional; fixed `setGeminiEnvVars()` to use the socket-scoped tmux command so Google-auth env injection actually reaches the session.
  - Gemini parity: tab-mode badge, kill-dialog label, `codeman doctor` registry entry, `isGeminiAvailable` barrel export, `COLORTERM=truecolor`, and alt-screen/scrollback stripping (Ink TUI, like Codex/Claude).
  - Restored four envelope-shape test assertions weakened during the Gemini PR; added a `runGemini()` regression test covering the envelope path.
  - Ralph todo-config values now persist across restart and read back correctly instead of always reverting to defaults.

## 1.1.17

### Patch Changes

- Fix the connection indicator flashing "Sending 1B…" on every keystroke. The reliable input-delivery layer (1.1.16) marks each keystroke as briefly pending until its ACK arrives a few milliseconds later, which made the indicator flash on every character while typing on a healthy connection. The indicator is now hidden whenever the connection is healthy and only appears for an actual problem (reconnecting/offline), where it still shows the queued byte count so you know buffered input will be sent.

## 1.1.16

### Patch Changes

- Mobile image uploads, reliable input delivery, and gesture window dragging.

  **Mobile image uploads (camera-roll picker / drag-drop / paste).** The "🖼 Image" button now handles real photo batches: up to 20 images per batch uploaded with bounded concurrency and a live "Uploading N/M…" progress toast (with a summary of successes, failures, and whether the 20-cap trimmed the selection). The per-file limit is raised from 10MB to 50MB (`MAX_PASTE_IMAGE_BYTES`, env-overridable via `CODEMAN_MAX_PASTE_IMAGE_BYTES`) so full-resolution phone photos and large screenshots are accepted. Very large images are downscaled to ≤4096px on the longest edge before upload, fixing iOS Safari's ~16.7M-px `<canvas>` limit that previously made huge photos fail to re-encode. Also fixes a latent concurrency bug the batch path exposed where the first parallel uploads to a session raced on creating `.claude-images/` and failed with EEXIST.

  **Reliable, exactly-once input delivery.** A "sent" prompt could be silently lost on a flaky connection (e.g. a train): a half-open WebSocket accepts `ws.send()` without error while discarding the frame, and nothing was queued or resent. Input is now recorded durably (localStorage) with a stable clientId + monotonic per-session sequence before delivery, and only dropped once the server ACKs it — delivered over the WebSocket (acked via `{t:'ia',seq}`) or, when the socket is down, over POST in order. A 2s sweep force-reconnects a half-open socket; pending input survives reconnects and page reloads. The server applies each `(clientId, seq)` at most once (`Session.shouldApplyInput`), so an at-least-once resend can never type the prompt twice. Untagged input (curl/legacy) is unchanged. See `docs/reliable-input-delivery.md`.

  **Gesture beta: drag agent windows.** With the camera hand-tracking overlay, you can now pinch and move the floating subagent and ultracode run/transcript windows. They keep their glowing connector line to the session tab while moving and can travel across a multi-monitor seam.

## 1.1.15

### Patch Changes

- Security: harden all frontend inline `onclick`/`ondblclick` handlers against a stored-XSS double-context bug.

  Many inline handlers interpolated values as `'${escapeHtml(value)}'` — a JavaScript string literal sitting inside an HTML attribute. The browser HTML-decodes the attribute value _before_ parsing the handler source, so `escapeHtml`'s `&#39;` reverts to a literal `'` and a quote-bearing id/name/path/URL breaks out of the JS string into executable code. `escapeHtml` alone is insufficient for this JS-string-within-HTML-attribute context.

  All affected handlers now use `escapeHtml(JSON.stringify(value))`: `JSON.stringify` JS-encodes and quote-wraps the value, then `escapeHtml` handles the HTML-attribute layer, so the value round-trips as a single inert string argument.
  - ultracode run/agent cards and minimized-tab badges (`ultracode-panel.js`, `ultracode-windows.js`) — PR #132.
  - Session tabs (click/rename/gear/detach/close), notifications, subagent windows + dropdowns, the agents/tools/log-viewer/image-popup panels, mux-session monitor rows, and case-management buttons (`app.js`, `notification-manager.js`, `subagent-windows.js`, `panels-ui.js`, `session-ui.js`).
  - Two non-`escapeHtml` variants of the same class: a pre-escaped mux-session id in `panels-ui.js` (`selectSession`/`killMuxSession`) and a fully raw, unescaped `phase.id` in `orchestrator-panel.js` (`orchestratorSkipPhase`/`orchestratorRetryPhase`).

  The most realistic exploitation vector was file paths in the project-insights log-viewer link, since filenames can legally contain a single quote. Purely numeric interpolations and developer-literal handler strings were left unchanged.

## 1.1.14

### Patch Changes

- Ultracode (Workflow-tool) floating windows — agent transcripts in-page, and minimize-to-tab.
  - **Agent transcripts open in-page, connected, instead of a detached browser popup.** Clicking an agent card (in a run window or the dock panel) now opens the agent's live transcript as its own draggable floating window, tied by a connector line to its parent run window (falling back to the run's session tab if that window has since closed) — the same line idiom the run windows use. Re-clicking a card focuses the existing window; closing it removes the window and its line. (Previously this spawned a separate `window.open` browser popup.)
  - **The window "−" button now minimizes into the originating session tab**, mirroring the subagent-window idiom. The window genie-animates into its tab and is tracked there; the tab shows an `ULTRA` badge whose hover/click dropdown lists each minimized item (🧬 run windows, 📄 agent transcripts). Click an item to restore its floating window, or dismiss it with ×. A run minimized while still active keeps tracking in the background and its badge auto-clears shortly after the run finishes. Both run windows and agent-transcript windows minimize into the same merged badge.
  - Removed the old collapse-to-header behavior that the "−" button previously triggered (now superseded by minimize-to-tab).

## 1.1.13

### Patch Changes

- Keep the `/compact` button in the extended (full) mobile keyboard accessory bar; only the simple bar drops it. (1.1.12 had removed it from both.)

## 1.1.12

### Patch Changes

- Remove the `/compact` button from the mobile keyboard accessory bar. It had been reintroduced in 1.1.10; this removes the button from both the simple and full accessory-bar layouts (the underlying command handler is left in place as inert plumbing).

## 1.1.11

### Patch Changes

- Ultracode (Workflow-tool) run visualization — much better live tracking.

  While a run is in flight, the watcher previously showed empty agent slots ("agent N", 0 tokens, raw `wf_…` id as the title) because the detailed completion JSON only lands when the run finishes. The live path now enriches in-flight runs directly from the on-disk transcript tree:
  - **Real per-agent stats mid-run** — tokens and tool-call counts are parsed from each `agent-<id>.jsonl` transcript (tool counts match the final accounting exactly; token totals land within ~1% of the completion value), with model and a prompt preview. All mtime-cached (transcripts, journal, and script meta) so idle polls do no extra reads.
  - **Readable window/run title** — workflow name, summary, and phases are derived from the persisted `workflows/scripts/<name>-<runId>.js` instead of showing the raw run id.
  - **Agent status colors** — done agents show green, working agents show yellow (this also fixes the run/agent status badges, which referenced undefined `--success`/`--warning` CSS variables and were rendering with no color).
  - **Connector line** — the floating-window → session-tab line now uses the session-tab accent blue (was purple).
  - **Click a run to open its floating window** — clicking a workflow in the dock panel opens (or focuses) its floating window with the connector line, in addition to the auto-popped windows.
  - Agents are ordered by journal launch order; concurrent run-detail fetches are de-duplicated.

## 1.1.10

### Patch Changes

- Mobile CJK input, iPad keyboard accessory bar, and terminal touch interaction fixes (PRs #130, #131).

  Mobile / CJK (#130):
  - Restore reliable real-time CJK (e.g. Pinyin) composition in the always-visible textarea, and refocus input when the terminal is tapped.
  - Stop clearing the textarea during `compositionstart` — some IMEs include existing text in the composition region, and clearing it mid-composition corrupted input.
  - iPad-specific fixes: `#cjkInput` positioning, paste-dialog placement, and duplicated voice-dictation output.
  - Split CJK keyboard positioning by device size (phones vs iPad use different keyboard offsets).
  - iPad accessory-bar styling/positioning: moved the accessory-bar and paste-overlay base styles out of the `max-width:1023px`-gated mobile stylesheet so iPad landscape (≥1024px) renders them correctly.
  - Raise the toolbar stacking context while the case-settings popover is open so the popover is no longer hidden behind the toolbar.
  - Restore the `/compact` button to the keyboard accessory bar (with double-tap confirmation, like `/clear`); the paste dialog now submits pasted text on "Send".

  Terminal touch + forced redraw (#131):
  - Enable terminal touch interaction on all touch devices and show the stop button on touch devices.
  - Add an 8px tap threshold so micro-drift is treated as a tap, not a scroll, fixing cases where a tap failed to register.
  - Tap-to-position the cursor via a synthesized mouse report, gated on the live mouse-tracking mode so it never triggers local text selection when tracking is off; let SGR mouse reports through to the PTY even while the CJK input field owns focus.
  - Suppress the cursor/momentum side effects of a sub-threshold tap so a jittery tap no longer both positions the cursor and starts a momentum fling.
  - New opt-in, per-device "Redraw Terminal" header button (`showRedrawButton`, default off) that forces an xterm redraw via a resize jitter to clear occasional rendering glitches; the resize path now accepts a `force` flag (threaded through the session, HTTP, and WebSocket resize routes) that guarantees a SIGWINCH/redraw at the current device's size without bypassing multi-client resize arbitration.

## 1.1.9

### Patch Changes

- Two welcome-screen tunnel changes:
  - **UI (Daylight Blue skin):** the **Cloudflare Tunnel** button is now purple (was orange/yellow), keeping the three welcome buttons visually distinct — Claude blue, Tunnel purple, OpenCode green.
  - **Enable a tunnel without `CODEMAN_PASSWORD`, with a warning.** Previously enabling the Cloudflare tunnel with no password set was hard-refused unless you set `CODEMAN_ALLOW_UNAUTHENTICATED_NETWORK=1`. Now you can opt in straight from the browser: clicking the tunnel toggle without a password pops a **security confirm dialog** ("publishes this machine to a public URL with no login — effectively remote code execution; set CODEMAN_PASSWORD instead"), and only on confirm does it enable, sending an explicit per-request `acknowledgeUnauthTunnel:true`. The server logs a loud warning whenever a passwordless public tunnel starts. curl/API/CLI callers are unchanged — still refused unless they set a password, set the env var, or pass `acknowledgeUnauthTunnel:true` — so nothing gets exposed accidentally. The acknowledgment is an action field and is never persisted to settings.json.

## 1.1.8

### Patch Changes

- UI (Daylight Blue skin): give the welcome-screen action buttons distinct colors instead of all reading blue. **Run Claude Code** keeps the blue accent, **Cloudflare Tunnel** now uses Cloudflare's brand orange, and **Run OpenCode** uses an emerald green — so the three are visually distinguishable at a glance. Scoped to the default `daylight-blue` skin only (daylight-green and OG are unchanged), with matching hover/active states and dark ink for contrast. Verified in a real browser: the three buttons compute to blue / orange / green gradients on the welcome overlay.

## 1.1.7

### Patch Changes

- Fix: terminal scroll-up (scrollback) intermittently breaking for **Claude** sessions — most visible on iPhone, where you suddenly "can't scroll up the Claude console."

  Root cause: Claude Code periodically emits alternate-screen switches (`\x1b[?1049h`/`\x1b[?47h`/`\x1b[?1047h`), scrollback-erase (`\x1b[3J`), and mouse-tracking enables — typically when it draws a full-screen UI (pickers/dialogs, the boot welcome). xterm.js obeys these by moving to the scrollback-less alternate buffer (or wiping saved lines / hijacking the wheel), so the conversation history becomes unreachable until Claude returns to its normal view. Codeman already stripped these sequences so history stays scrollable, but the strip was gated to **Codex mode only** — Claude (and the equivalent buffer-replay path) let them through.

  The strip is now shared via a single `isAltScreenStripMode(mode)` predicate (`codex || claude`) applied at BOTH sites that were Codex-only: the live PTY stream (`Session._handleTerminalOutput`, including the split-across-chunks carry reassembly) and the `/terminal` buffer replay used on tab-switch/reconnect. `shell` is deliberately excluded so full-screen TUIs run from a shell (vim/less/htop) keep their alternate screen; `opencode` is also unchanged.

  Verified end-to-end on an isolated instance against a real Claude session: the replayed buffer and live stream now carry zero alt-screen/scrollback-erase/mouse sequences, the terminal stays in the normal buffer with scrollback intact, and touch swipe-up scrolls correctly. Covered by new unit tests (`test/claude-scrollback-strip.test.ts`); the existing Codex strip tests are unchanged.

## 1.1.6

### Patch Changes

- Fix: ultracode floating run windows now pop on a fresh device/browser that loads while a run is already active.

  `ultracodeFloatingWindows` syncs from the server (it's a non-display setting), but on a first-time device the SSE `getLightState` run snapshot can seed the run list BEFORE the async settings load resolves — so the floating-window gate read `false` at that instant and skipped any already-active run, leaving the window un-popped until the next ~10s watcher tick. The app now re-runs `syncAllUltracodeFloatingWindows()` once server settings finish loading (in the `loadAppSettingsFromServer().then()` callback), so an in-flight run pops its window immediately. Idempotent: open windows are left as-is, and if the setting is off any premature windows are torn down. Verified end-to-end against a real in-flight run on an isolated instance — a pristine browser (empty localStorage) seeds the setting from the server and pops the active run's window ~0.4s after first paint.

  Also corrected a stale `@fileoverview` comment in `ultracode-windows.js` that claimed the floating windows are gated on `showUltracodeAgents`; they are gated on the dedicated `ultracodeFloatingWindows` toggle (only the docked "Ultracode Agents" panel uses `showUltracodeAgents`).

## 1.1.5

### Patch Changes

- Fix: the Ultracode Agents panel's (×) Close button now fully hides the panel.

  `closeUltracodeAgentsPanel()` only removed the `open` class, which drops the bottom-docked drawer to its collapsed _peek_ state (the 36px header strip stays visible) rather than closing it — so clicking (×) looked like it did nothing. It now also adds the `hidden` class (`display:none`), mirroring `closeSubagentsPanel()`. It deliberately does NOT flip the `showUltracodeAgents` setting (that also gates the run watcher and floating windows); the header launcher button reopens the panel. Verified in a real browser: after (×) the panel computes `display:none`.

## 1.1.4

### Patch Changes

- Fix: ultracode floating run windows (and the live dock panel) now appear DURING an in-flight Workflow/ultracode run, not only after it finishes.

  The Workflow runtime writes the run-state file `…/workflows/wf_<id>.json` only at completion (always a terminal status); while a run is live, its only on-disk state is the sibling `…/subagents/workflows/wf_<id>/` transcript tree. `workflow-run-watcher` previously scanned only the completion file, so it never observed a run until it was already terminal — and the floating-window auto-pop is gated on an ACTIVE run, so it never fired for a live run (the feature was effectively dead for in-flight runs).

  The watcher now ALSO scans the `subagents/workflows/wf_<id>/` transcript tree and synthesizes a minimal ACTIVE run (status `running`, agent slots keyed by their `agentId` so the agent-card → live-transcript click still works, `lastActivityAt` from the newest agent/journal mtime, per-agent done/running derived from the run journal's `result` events) when no completion file exists yet. When the run finishes, the real `wf_<id>.json` supersedes the synthesized record (same runId), restoring full phase/token detail and the normal finish → 8s-grace auto-close flow. The watcher stays standalone (it never imports subagent-watcher). Verified end-to-end against a real in-flight run; adds unit coverage for live synthesis, agentId preservation, journal-derived state, empty-dir skipping, and completion-file precedence.

## 1.1.3

### Patch Changes

- Ultracode floating run windows + a dedicated toggle to control them.
  - **New: floating ultracode run windows.** When enabled, each active ultracode / Workflow run pops a small draggable window (like the file browser) connected by a glowing line to its originating session tab — the same connector-line idiom as subagent windows. The tab is resolved by matching the run's `sessionUuid` to a session's `claudeSessionId`. The window mirrors the live agent grid (phases, per-agent model / tokens burned / tool calls / state), auto-closes a few seconds after its run finishes, and remembers windows you explicitly dismiss so they don't re-pop. These windows are **additional to** the existing docked "Ultracode Agents" master-detail panel, which is unchanged.
  - **New setting "Ultracode Floating Windows"** (App Settings → Display), **default OFF**, independent of the "Ultracode Agents" panel toggle. Either toggle now starts the server-side workflow-run watcher (at boot and on live settings change), so the floating windows work even with the docked panel off.
  - Internals: new frontend module `ultracode-windows.js` (load order 15.5); ultracode connector lines are appended into the shared `#connectionLines` SVG within the existing batched read/write reflow pass in `subagent-windows.js`; new `ultracodeFloatingWindows` app-settings key in `schemas.ts`; watcher gating in `server.ts` + `system-routes.ts` now ORs both ultracode toggles.
  - Docs: `CLAUDE.md` brought up to date for the 1.1.2 ultracode/workflow-run subsystem (Agents / Frontend / Types / Config inventories, JS load order, a Key Patterns entry) and the new floating-windows feature.

## 1.1.2

### Patch Changes

- Ultracode/Workflow run visualization + subagent discovery fixes.
  - **Ultracode / Workflow run visualization** (new, opt-in): App Settings → Display → "Ultracode Agents" (`showUltracodeAgents`, default OFF) adds a master-detail tab that shows ultracode / Workflow-tool runs like Claude Code's "working agents" view — the LEFT pane lists runs and their phases (selectable tasks), the RIGHT pane shows each run's agents with model, live state, tokens burned, and tool calls. Clicking an agent opens its live transcript. Backed by a new standalone workflow-run watcher that reads the per-run state JSON (stripping the heavy embedded script/result/logs so payloads stay small), exposes `GET /api/workflows` and `GET /api/workflows/:runId`, and broadcasts `workflow:run_discovered/updated/removed` SSE events. The header launcher and panel stay hidden until the setting is enabled (the setting is synced across devices, not per-device).
  - **Subagent tracking discovery fix**: restored subagent tracking after Claude Code changed the on-disk format from `agent-*.jsonl` to `agent-*.meta.json` (background agents were showing 0). Also discovers workflow-nested subagents under `subagents/workflows/<wf>/` and hardens the meta→transcript upgrade path so an agent re-points to its `.jsonl` transcript once it appears.
  - **File viewer**: opens audio, SVG, and other binary files the same way the attachments viewer does.
  - **Tooling**: hardened the real-overview screenshot capture script and documented the `deviceScaleFactor` / static-cache gotchas.

## 1.1.1

### Patch Changes

- Six reviewed contributor PRs (all adversarially reviewed and fixed before merge):
  - **Markdown sanitizer hardened against mutation-XSS (#126).** The denylist `_sanitizeHtml` is replaced with vendored DOMPurify 3.4.8 (authentic, byte-matched to the official dist) wired via a new `sanitize-html.js` allowlist, with a fail-closed escape fallback. The curated allowlist is genuinely enforced (no `USE_PROFILES` override) so non-markdown tags and svg/math/style/script/event-handler/`javascript:` vectors are stripped while legitimate markdown survives.
  - **Hook-event secret now required unconditionally (#127).** The `/api/hook-event` + `/api/status-telemetry` localhost bypass requires the per-instance hook secret whether or not a managed tunnel is running, closing the own-loopback-reverse-proxy gap. A self-heal refreshes pre-secret hook configs in existing cases on spawn so password-protected installs don't silently 401 their hooks. No-password loopback installs are unaffected.
  - **`codeman doctor` dependency checker (#125).** New `doctor`/`check-deps` command probes Node, the agent CLIs, tmux, and document converters per environment (linux/darwin/win32/wsl), with grouped or `--json` output and a non-zero exit when a required tool is missing. Requires Node 22+, reports `pdftoppm` (used for PDF/Office thumbnails), and validates `--category`.
  - **macOS Option / physical-key session shortcuts (#129).** Tab switching matches physical key codes (`e.code`) so Option+1–9 works on macOS layouts that remap Option, plus Option/Alt+`[`/`]` for previous/next session — without leaking escape sequences into the focused terminal.
  - **Desktop session tabs auto-wrap to a second row on overflow (#128)** instead of horizontal scrolling (off when the manual two-row layout is pinned; mobile/tablet unchanged), re-evaluated on window resize.
  - **CJK input textarea hidden on the welcome screen (#123)** so it no longer floats over the welcome overlay, and re-shown on session entry; vertical centering fixed.

## 1.1.0

### Minor Changes

- **Plan Usage Limits chip (new).** A header chip now shows your live Claude plan usage — the 5-hour and weekly windows as a percentage — parsed from Claude Code's statusLine telemetry (CLI v2.1.80+). It's opt-in via **App Settings → Display → "Plan Usage Limits"** (default OFF). The toggle is **per-device**: turn it on at your desk without it appearing on your phone. Telemetry collection is decoupled from display, so one device's preference never affects another's, and the last-known value replays instantly on reconnect. Distinct from auto-resume (which reacts to the limit _message_) — this proactively shows the live %.

  **Attachments.** New attachment history drawer to browse files referenced by a session (COD-39), plus document previews and thumbnails on attachment cards (COD-38). The header **Attachments button is now opt-in** (default OFF) via **App Settings → Display → "Attachments Button"**, per-device like the Response Viewer button.

  **Settings & models.** Added Opus 4.6 options to the Claude Model picker. Removed the legacy Token Count / Show Cost header toggles and moved Plan Usage Limits to the top of the Display settings. Slimmed the Skin picker control to match its row.

  **Mobile & header polish.** Restored the response-viewer (eye) button on phones; kept the phone header minimal (settings gear + lifecycle log stay in the toolbar). Added two regression guards so header controls can't silently leak onto the mobile header again — a CI-runnable static policy check plus a real-browser E2E test.

## 1.0.0

### Major Changes

- # Codeman 1.0.0 🎉

  The first stable release of Codeman — and it comes with a fresh new look.

  **New: theme skins.** Codeman now ships a built-in skin switcher (App Settings → Display → Appearance):
  - **OG Codeman** — the original look, preserved exactly.
  - **Daylight Green** — a fresh emerald-on-slate theme.
  - **Daylight Blue** — bright sky-blue on lifted slate (the new default).

  Skins apply instantly, persist per device (with a pre-paint script so there's no flash on load), and re-theme any open terminals live. The system is built on `html[data-skin]` design tokens and self-hosted Manrope (UI) + JetBrains Mono (terminal) fonts — no external CDN, CSP-safe.

  **1.0.0 milestone.** This marks the start of the stable 1.x line: the CLI, documented environment variables, and the `{ success, data }` HTTP/SSE API envelope follow semantic versioning (see `docs/versioning-policy.md`).

  **Thank you to everyone who helped build Codeman.** This release is dedicated to all of our contributors for their work on the project: Ark0N, Aamer Akhter (@aakhter), Tenggan Zhang (@TeigenZhang), zhouyuan / @sunnyzhouy, jaypark, Marco Migozzi, Skúli Arnlaugsson, Aaron Fields, Loïc Sculier, and Noah Waldner (@noahwaldner). 💙

## 0.9.14

### Patch Changes

- Security hardening for the tunnel exposure path, Codex terminal rendering fixes, and a mobile modal fix.

  **Security (PR #115, COD-54/COD-55):**
  - `/api/hook-event` localhost bypass is now gated while the managed Cloudflare tunnel is running: tunneled traffic arrives with a loopback source IP, so the bypass additionally requires a per-instance shared secret (`X-Codeman-Hook-Secret`, 256-bit, `~/.codeman/hook-secret`, mode 0600). Locally generated hook commands read the secret file at execution time via `$CODEMAN_HOOK_SECRET_FILE` (exported into every managed session's environment), so the value never lands on command lines or in case configs, and running sessions pick up a new secret without respawn. Failed presentations rate-limit in a dedicated per-IP bucket so misfiring legacy hooks can never lock out the Basic-Auth login path. With no tunnel running, behavior is unchanged.
  - Enabling the Cloudflare tunnel now **refuses with 403** when no `CODEMAN_PASSWORD` is set (a public tunnel URL with no auth is effectively public RCE), unless `CODEMAN_ALLOW_UNAUTHENTICATED_NETWORK=1` explicitly acknowledges the exposure. The settings UI surfaces the refusal as an error toast and reverts the toggle.

  **Codex rendering (PRs #116, #117):**
  - Alt-screen toggles (`?47/?1047/?1049`), scrollback-erase (`CSI 3 J`), and mouse-tracking enables (`?1000`–`?1007`) are stripped from the Codex byte stream (live + replay), so conversation history survives tab switches and the scroll wheel scrolls the viewport instead of being hijacked. Sequences split across PTY chunk boundaries are reassembled via a small carry before stripping, so a split `?1049h` can no longer trap xterm in the scrollback-less alt buffer.
  - Smaller 32KB first-frame write budget for Codex sessions keeps dense synchronized redraws from stalling the renderer; a 1.5s grace window after a manual scroll-up suppresses sticky-scroll so high-frequency `• Working (Ns)` status ticks no longer snap the viewport back to the bottom while reading earlier output.

  **Mobile:** session-options modal raised above the fixed mobile/tablet header (z-index 1300 vs 1200) so the close button is reachable on phones; Respawn tab controls regrouped.

  **Docs:** security-architecture.md updated for the secret-gated hook bypass (including the external-proxy caveat) and the tunnel password guard; README documents auto-resume on usage limit.

## 0.9.13

### Patch Changes

- Auto-resume on usage limit ("token pause" control) plus a set of mobile-view fixes for regressions introduced in 0.9.8.

  **Auto-resume on usage limit** — new opt-in checkbox at the top of the session Respawn tab (off by default). When Claude stops because a usage limit was reached, Codeman parses the reset time from the limit message, waits until the limit lifts (plus a 2-minute safety buffer), then dismisses the rate-limit dialog (Esc) and sends "continue" so the session picks its work back up automatically. All Claude Code message formats from 1.0.x through 2.1.x are recognized ("5-hour limit reached ∙ resets 8pm", "Limit reached · resets 1pm (America/Chicago) · /upgrade…", "You've hit your weekly limit · resets Mon 12:00am", weekly date forms, and the raw API `usage limit reached|<epoch>` form). Still-limited responses re-arm the scheduler (5-minute retry loop); a pending schedule persists across Codeman restarts and re-arms on boot; respawn cycles are blocked while a limit pause is active so the cycle's `/clear` cannot wipe the paused conversation. New endpoint `POST /api/sessions/:id/auto-resume`; new SSE events `session:limitPauseScheduled`, `session:limitResume`, `session:limitResumeCancelled`; toast/notification on pause and resume, plus a live "resumes at HH:MM" status line in the modal. The Respawn tab layout was also tidied: compact single-row Update/Kickstart prompt fields and a merged options row.

  **Mobile fixes (0.9.8 regressions)**:
  - **Activity-based resize arbitration** — a desktop sizing claim now only blocks a phone's resize while that desktop has actually typed within the last 90 seconds. Previously any connected desktop tab (even one abandoned hours ago) silently discarded the phone's resize with no fallback, leaving the phone rendering a desktop-width stream in a narrow terminal: mid-word wraps, tmux dot-fill rows, overdrawn garbled text, and misplaced keyboard echo. Now an idle desktop yields the pane to the phone, and the next desktop keystroke automatically restores the desktop layout ("whoever is actively using the session wins"). Phones also re-send their dimensions every 30 seconds (visible tab only, skipped while the virtual keyboard is open) so attaching under a momentarily-active desktop self-corrects.
  - **Keyboard accessory bar and toolbar restored on iOS** — the lift offset is measured against the layout viewport (`window.innerHeight`) again instead of the keyboard-shrunken app element; on iOS the offset computed to 0, leaving both bars hidden behind the OS keyboard with a dead black gap above it.
  - **Removed the mobile header utility ("three dots") toggle** — the header-utilities tray stays collapsed on small viewports.

## 0.9.12

### Patch Changes

- Documentation refresh — README catches up with the Codex run mode, plus a CLAUDE.md correction.

  **README (en + zh-CN)**: Codex is now listed as a third supported AI coding CLI everywhere the docs previously said "Claude Code or OpenCode": the install requirement in Quick Start (now "any combination works", linking to the official Codex CLI docs), the Windows/WSL setup note, the renamed **Multi-CLI** feature bullet (env-prefix gating now reads `CLAUDE_CODE_*` vs `OPENCODE_*` vs `CODEX_*`), the Zod schema-validation security bullet, and the architecture mermaid diagram. The header tagline was also finalized to "Claude Code • OpenCode • Codex — One Dashboard • Any Device" in both languages.

  **CLAUDE.md**: fixed a stale "Local packages" line that claimed the xterm-zerolag-input local-echo overlay had a copy embedded in `app.js` — it is single-source in `packages/xterm-zerolag-input/`, bundled to the gitignored vendor file, and only consumed by `app.js`, matching the existing single-source gotcha.

## 0.9.11

### Patch Changes

- Fix a terminal freeze on hover (catastrophic regex backtracking) and a CSP violation that disabled the terminal's anti-throttling worker.

  **Tab-freezing hover bug**: the terminal link provider's `cmdPattern` (which turns `tail -f /path`-style text into clickable links) used an empty-matchable, unbounded arg group — `(?:[^\s\/]*\s+)*` — that backtracks exponentially on real Claude output, e.g. wrapped `git commit -m "$(cat <<'EOF'` heredoc lines or aligned table rows. Hovering the mouse over such a line hung the page's main thread for minutes ("page unresponsive"). The pattern now uses non-empty tokens with bounded repetition (linear time); all intended command+path link forms still match. New `test/link-provider-regex.test.ts` extracts the shipped patterns from source and pins linear-time behavior on the killer line shapes.

  **Blob worker CSP fix**: `worker-src 'self' blob:` is now always present in the CSP (previously only with `CODEMAN_GESTURE=1`). The terminal's `_safeYield` anti-throttling tick worker is created from a Blob URL and was silently blocked on every install, logging a CSP violation on each page load and disabling the worker leg of the render-yield fallback chain.

## 0.9.10

### Patch Changes

- Self-update now restarts automatically on headless Macs supervised by a system LaunchDaemon.

  New `launchd-daemon` supervisor kind: when Codeman runs under a bootstrapped, KeepAlive system-level LaunchDaemon (`/Library/LaunchDaemons/com.codeman.web.plist` — the right setup for headless Macs, where LaunchAgents never start because there is no GUI login), the updater no longer ends with "Update staged — restart Codeman to apply". It restarts rootlessly: the update script kills the server PID (passed via `--server-pid`) and launchd respawns it on the freshly built `dist/`. Detection is conservative — the daemon must be bootstrapped in the system domain AND have `KeepAlive` enabled.

  Also fixed: a lingering "restart Codeman to apply" status. After a manual restart of a staged update, boot reconciliation now flips `completed-needs-manual-restart` to `completed` once the running version matches the staged target, so the Updates tab stops showing the stale instruction.

## 0.9.9

### Patch Changes

- Codex (OpenAI CLI) run mode, Claude Model picker, and response-viewer button now opt-in.

  **Codex (OpenAI CLI) run mode** (#114): new `codex` session mode alongside Claude Code and OpenCode. Sessions launch the Codex CLI via tmux with secrets injected through `tmux setenv` (`OPENAI_API_KEY`/`CODEX_API_KEY`/`CODEX_HOME` — never on the command line). Supports `--model`, `resume <id>`, and `--dangerously-bypass-approvals-and-sandbox` via the `codexConfig` payload or the new App Settings → Codex CLI tab (`codexDangerouslyBypassApprovals`). Availability surfaced at `GET /api/codex/status` with an install hint when the binary is missing. Frontend gets a "Run CX" run-mode option; Respawn/Ralph options stay Claude-only (session options open on the Summary tab for external-CLI sessions). `CODEX_*` env prefix added to the env-override allowlist.

  **Claude Model picker**: App Settings → Claude CLI gains a "Claude Model" select (`claudeModel` setting) that pins the model for new Claude sessions via the case's `.claude/settings.local.json` — e.g. Fable 5 (1M context), Fable 5, Opus (1M), Opus, Sonnet, Haiku. It takes precedence over the legacy 1M Opus Context toggle. Fable 5 also added to the orchestrator default/phase model dropdowns.

  **Response-viewer (eye) header button is now hidden by default** — existing users who relied on it can re-enable it under App Settings → Display → Response Viewer (`showResponseViewer`, per-device setting). A new Display toggle controls its visibility.

  Also: tests made immune to a set `CODEMAN_GESTURE` env var; CLAUDE.md documents the Codex run mode and the eye-button toggle.

## 0.9.8

### Patch Changes

- Stable HTTP contract, terminal pane-buffer rework, mobile/touch fixes, and fresh-install default cleanups.

  **API / v1 readiness (PR #113)**
  - Stable HTTP contract: uniform `{success, data}` / `{success: false, error, errorCode}` response envelope across all ~134 handlers, correct HTTP status codes, and a versioned `/api/v1/*` alias of `/api/*`
  - Post-merge adversarial audit closed 9 contract gaps (envelope/status-code stragglers), incl. `loadQuickStartCases` double-unwrap
  - Node.js floor raised to >=22; `codeman` bin alias installed alongside `aicodeman`
  - Security hardening: SSRF guard on the push endpoint, tmux session-name validation, documented tail-file roots
  - Governance: SECURITY.md and a SemVer versioning policy (docs/versioning-policy.md)
  - CI now runs the full unit/integration suite (vitest.ci.config.ts) plus a frontend JS syntax gate

  **Terminal (PR #112)**
  - tmux pane-buffer primitives and session/render reliability fixes for the terminal pipeline, with re-review findings addressed

  **Mobile / touch (PR #111)**
  - Terminal and layout fixes for touch devices: desktop focus handling, WS resize-claim wiring, CJK setting, ESC passthrough
  - New: Esc button in the simple (default) keyboard accessory bar, next to paste — sends a real ESC to the session

  **Defaults & UI**
  - Monitor panel is now disabled by default on fresh installs (desktop previously slid it open at startup; mobile was already off). Opt in via App Settings -> Show Monitor
  - Fixed the session-tab task badge silently failing to open the Monitor panel when it was hidden by the setting (long-broken on mobile)
  - Local echo defaults audited and confirmed per-device: off on desktop, on for touch devices, never server-synced

## 0.9.7

### Patch Changes

- Fix installer failure on corrupt puppeteer cache + add Simplified Chinese README.
  - **Installer / self-update reliability**: The universal installer (`install.sh`) and the in-app self-updater (`scripts/self-update.sh`) now set `PUPPETEER_SKIP_DOWNLOAD=1` before `npm install`. `puppeteer` is a devDependency used only by `scripts/browser-comparison.mjs`; its ~150MB `chrome-headless-shell` download is never needed to build or run Codeman. Previously, a partially-downloaded browser cache (folder present, executable missing) made puppeteer refuse to re-download and abort `npm install`, which failed the entire install/update — most visibly on macOS (`mac_arm`). The download is now skipped on both paths; callers can still opt back in with `PUPPETEER_SKIP_DOWNLOAD=0`.
  - **Docs**: Added a Simplified Chinese translation of the README (`README.zh-CN.md`) with an English/中文 language switcher in `README.md`. Refreshed the README and documented the v0.9.5 security hardening (Host-header/DNS-rebinding guard, cross-site Origin/CSRF guard, anti-CSWSH WebSocket validation).

## 0.9.6

### Patch Changes

- Self-updater: show live progress during the slow steps so an update no longer looks frozen.
  - The detached update runner (`scripts/self-update.sh`) now emits a heartbeat every few seconds during `npm install` and `npm run build`, refreshing the update status with the latest output line (full output is still written to the update log).
  - App Settings → Updates now shows the live status message plus a ticking elapsed-time counter during non-terminal phases, instead of only a static phase label.

  This takes effect when updating _from_ a build that includes it — the detached runner script and the polling UI are both the from-version's copies.

## 0.9.5

### Patch Changes

- Security hardening from the 2026-06-09 adversarial review — close the remote-exploit paths that affected the default (loopback + no-password) configuration. Full report: `docs/reports/security-review-2026-06-09.md`.
  - **Anti-DNS-rebinding Host allowlist (always on).** A new request guard rejects requests whose `Host` is a custom domain rebound to a loopback/LAN address — previously a website the operator merely visited could DNS-rebind to `127.0.0.1` and drive the entire API (arbitrary command execution, since sessions run `--dangerously-skip-permissions`). The allowlist accepts `localhost`, any bare IP literal, the bind host, `*.ts.net` / `*.trycloudflare.com` / `*.cfargotunnel.com`, the active managed tunnel, and anything in the new `CODEMAN_ALLOWED_HOSTS` env var (comma-separated; `host` or leading-dot `.suffix`).
  - **Cross-site (CSRF) Origin guard on all state-changing requests.** Forged cross-site requests are rejected; a missing `Origin` is allowed so `curl`/CLI automation and Claude Code hooks keep working. This closes the previously CSRF-triggerable self-update, session create/input, and settings/tunnel-toggle endpoints.
  - **`text/plain` body parser no longer JSON-parses every request body** (which let a cross-site "simple request" submit JSON with no CORS preflight). The crash-diagnostics beacon now parses its own body.
  - **WebSocket terminal upgrade now validates `Origin`/`Host`** (blocks cross-site WebSocket hijacking that could inject keystrokes into a running agent).
  - **Stored-XSS fix:** AI-/transcript-derived fields (tool name, tool detail, tool id, hook text) in the subagent activity panel are now HTML-escaped.

  Operational note: if you front Codeman with a custom reverse-proxy domain, allow it via `CODEMAN_ALLOWED_HOSTS=host,.suffix`. Setting `CODEMAN_PASSWORD` also fully mitigates these via the existing auth hook.

## 0.9.4

### Patch Changes

- In-app self-updater, plus the SSE-registry and security-doc changes since 0.9.3.

  **New: update Codeman from the web UI (App Settings → Updates).** A "Check for updates" button asks the server to query GitHub for the latest tagged release (falling back to `git ls-remote`) and shows its release notes; "Update now" then runs the full `git checkout <tag>` → `npm install` → `npm run build` → restart cycle and streams live progress that survives the service restart (the browser polls a status file across the connection drop).
  - **Channel:** latest tagged release (e.g. `codeman@0.9.4`), not bleeding-edge master.
  - **Dirty working trees are auto-stashed** (`git stash`, left for you to `git stash pop`) instead of discarded.
  - **Cross-platform restart**, detected from the running process: systemd (`systemctl --user restart codeman-web`) on Linux, launchd (`launchctl kickstart`) on macOS, or a printed manual command otherwise.
  - **Survives its own restart:** the updater runs detached in a transient `systemd-run --user --scope` (Linux) or `setsid` session (macOS), so the restart it triggers cannot kill the build mid-flight.
  - **Safety:** build failure rolls back to the pre-update commit (never restarts into a half-built `dist/`); the pre-restart status marker is reconciled on boot with an update-id + freshness guard so a normal reboot is not misreported as a completed update; concurrent updates are rejected (409); the runner script is staged outside the repo so `git checkout` cannot corrupt it mid-run; release tags are strictly validated before reaching the shell; `CODEMAN_DISABLE_SELF_UPDATE=1` disables the feature; non-git (npm-global) installs are detected and pointed at `npm i -g aicodeman@latest`.
  - New endpoints: `GET /api/system/update/check`, `POST /api/system/update`, `GET /api/system/update/status`.

  **Also in this release:**
  - Sync the frontend `SSE_EVENTS` registry (`constants.js`) with the backend `sse-events.ts` so every broadcast event has a matching frontend entry.
  - Expand `docs/security-architecture.md` with the trust model, CSP detail, and a source-file map.

## 0.9.3

### Patch Changes

- Installer security notice + clarify gesture control stays opt-in and default-off.
  - **Installer:** `install.sh` now prints the network-security notice as the final block of both the fresh install (one-line `curl … | bash`) and the update flow, so it stays visible to the user: Codeman binds `127.0.0.1` by default (no password needed), and the safe ways to reach it remotely (`tailscale serve` / tunnel, or `--host 0.0.0.0` + `CODEMAN_PASSWORD`), noting a non-loopback bind without a password still starts but warns loudly.
  - **Gesture control** is **disabled by default** and is enabled only by the per-user toggle at App Settings → Display → Input → Gesture Control (`gestureControlEnabled`, default `false`). Setting `CODEMAN_GESTURE=1` on the server only makes the feature _available_ (CSP widening + same-origin `/gesture/` assets); it does **not** turn the overlay on. There is no default-on path — the bundle is injected only when a user explicitly enables the setting.

## 0.9.2

### Patch Changes

- Vendor the gesture-control source into the repo for in-tree development.

  The hand-tracking overlay's source (previously the standalone `Ark0N/codeman-gesture-control` repo) now lives at `packages/gesture-control/` as the `codeman-gesture-control` workspace package: the transport-agnostic gesture core (`src/gesture/*` — MediaPipe GestureRecognizer → One-Euro-filtered cursor → pinch state machine), the Codeman consumer entry (`src/codeman/entry.ts`, maps grab/drag/drop onto real session tabs + toolbar buttons), and a standalone vite playground for iterating on gesture feel.
  - New `npm run build:gesture` (`scripts/build-gesture-bundle.mjs`) esbuild-bundles `entry.ts` into the served `src/web/public/gesture/gesture-codeman.js`; `scripts/build.mjs` now reruns it on every production build so the served bundle always reflects current source. The MediaPipe wasm + model stay runtime-loaded from same-origin `/gesture/` (unchanged).
  - Added `@mediapipe/tasks-vision@0.10.21` as the package dependency (kept in sync with `fetch-gesture-assets.mjs`). The playground uses vite 7 (no known advisories).

  No change to the shipped app behavior — gesture control remains opt-in (`CODEMAN_GESTURE=1` + the App Settings → Input toggle). This release just makes the overlay developable inside the Codeman repo.

## 0.9.1

### Patch Changes

- Multi-monitor & settings UX fixes.
  - **Multi-monitor button (remote servers):** the "span displays" button spawns `scripts/span-codeman.sh` server-side, so on a non-macOS Codeman server it can't open a window on your machine. The non-macOS API error now explains this and points to running the script locally on your Mac with the remote server URL; the script header documents the same remote-client workflow.
  - **App Settings modal:** stop the modal overflowing horizontally on narrow viewports.
  - **systemd:** sync the `codeman-web.service` template with the deployed unit.

## 0.9.0

### Minor Changes

- Security hardening release: network-bind policy, auth lockout recovery, download/SVG hardening, dependency & supply-chain fixes, tmux launch reliability, and a full security-architecture doc.

  **Network binding (COD-29, #107):**
  - The web server now defaults to binding `127.0.0.1` (loopback) instead of `0.0.0.0`, so a fresh install is reachable only from the same machine and needs no password. New `--host` / `-H` / `CODEMAN_HOST` flag to choose the bind host.
  - Binding a non-loopback host **without** `CODEMAN_PASSWORD` no longer refuses to start — it **starts and prints a loud warning** with the three ways to secure it (set `CODEMAN_PASSWORD`, bind loopback + an authenticated tunnel / `tailscale serve`, or acknowledge with `--allow-unauthenticated-network` / `CODEMAN_ALLOW_UNAUTHENTICATED_NETWORK=1`). This keeps Codeman "just working" for new users while making remote exposure a guided, explicit choice. Host classification lives in the new `src/web/network-auth-policy.ts` (handles `127.0.0.0/8`, `::1`, `::ffff:127.*`, bracketed IPv6).
  - A post-install security note now explains the loopback default and how to expose safely.

  **Authentication (COD-29, #107):**
  - Auth lockout now recovers gracefully: the per-IP rate-limit (`429`) check runs **after** the cookie/credential checks, so a valid session cookie or correct password is never locked out by a prior attacker's failures from the same IP (important behind a shared-IP tunnel). Wrong credentials are still counted and still hit the limit, and a `Retry-After` header is returned.

  **Downloads & content-type hardening (COD-29, #107):**
  - New session-scoped `POST /api/download` route: realpath-bounded to the session working dir, a sensitive-path blocklist (`/etc/shadow`, `~/.ssh/`, `.env`, `*credentials*`, …), `isFile()` + 50 MB cap, forced `attachment`.
  - Workspace `.svg` files are served as `application/octet-stream` + `attachment` + `nosniff` (closes a stored-XSS-via-SVG vector); `nosniff` now applies to all `file-raw` responses.

  **Dependencies & supply chain (COD-28, #106):**
  - Bumped security-sensitive deps to patched versions (`@fastify/static` 9, `fastify` 5.8, `uuid` 14, `vitest` 4.1, …) and added `overrides` for patched transitives (`picomatch`, `basic-ftp`, `fast-uri`, `flatted`); `npm audit` goes from 7 advisories to 0.
  - New `npm run check:public-assets` (`scripts/check-public-assets.mjs`): scans `src/web/public/**` for literal NUL bytes and runs `node --check` on every `.js` file, plus a Prettier pass on maintained files. Removed literal NUL placeholders from `app.js`. Added `test/dependency-security.test.ts` and `test/frontend-public-tooling.test.ts`.

  **tmux launch reliability (COD-31, #110):**
  - New tmux sessions and respawns launch from a stable `/tmp` and `cd` into the workspace inside the pane, avoiding `new-session` crashes when a FUSE/rclone-mounted workspace has a transient mount blip at launch. The `cd "<dir>" && <cmd>` form is fail-safe (the CLI never runs in `/tmp`) and the path is validated + double-quoted.

  **Test stability (COD-30, #108):**
  - Cleared leaked auth env in the Vitest setup, corrected stale route status-code / SSE-lifecycle expectations to match shipped behavior, updated the mobile keyboard accessory expectations, and measured DOMContentLoaded via browser navigation timing. Also fixed the `WebServer` title tests for the new `host` constructor arg + async `renderIndexHtml`.

  **Docs:**
  - New `docs/security-architecture.md` documenting the full model (network binding, auth pipeline, the tunnel `req.ip` caveat, file-serving hardening, supply-chain, multi-instance isolation, security headers, and recommended secure setups). CLAUDE.md updated accordingly.

## 0.8.2

### Patch Changes

- Session detach/undock, opt-in gesture-control overlay, multi-monitor spanning, new App-Settings toggles, and asset cache-busting.
  - **Session detach/undock + instance isolation (#103):** Detach a session into its own solo (popup) window from the tab strip. Adds multi-instance isolation primitives in `src/config/instance.ts` (`getDataDir()`/`dataPath()`/`DEFAULT_TMUX_SOCKET`) keyed off `CODEMAN_INSTANCE`, so a beta can run side-by-side with prod without discovering/attaching to prod's live tmux sessions or clobbering its `state.json`. `CODEMAN_INSTANCE` defaults to the production layout (`~/.codeman`, `-L codeman`, port 3000), so master installs are unaffected. Adds `scripts/run-beta.sh` (`CODEMAN_INSTANCE=beta` + `CODEMAN_PORT=5000`). The legacy `~/.claudeman` migration is now scoped to the default instance only. Hardened detach edge cases. Tests: `test/config/instance.test.ts`.
  - **Gesture-control overlay (Phase 5, opt-in via `CODEMAN_GESTURE=1`):** Camera hand-tracking overlay (self-hosted MediaPipe — wasm + model fetched at install/build via `scripts/fetch-gesture-assets.mjs` rather than committed). `CODEMAN_GESTURE=1` makes the feature _available_ (CSP widening + `/gesture/` assets + `window.__codemanGestureAvailable`); the per-user **Gesture Control (beta)** toggle (App Settings → Display → Input, default OFF) is the actual on/off and reloads the page to inject/remove the bundle. Dashboard-only (not solo popups). Labeled "(beta)" (#109).
  - **Multi-monitor button:** Header button (opt-in via App Settings → Display → Header Displays) that POSTs `/api/system/span-displays` to spawn `scripts/span-codeman.sh` — a maximized browser `--app` window sized to the union of all displays, so the gesture layer's floating panels can drag across the physical monitor seam. Tests: `test/routes/system-span-displays.test.ts`.
  - **New App-Settings toggles (#105):** Gesture control and the multi-monitor button are both opt-in (default OFF), with live show/hide on save.
  - **Asset cache-busting:** `renderIndexHtml` appends `?v=<mtime>` to every same-origin `.js`/`.css` reference; `index.html` is served `no-cache`, so a normal reload picks up edited modules/styles without a hard refresh. Tests: `test/render-index-html.test.ts`.
  - **Gesture Control toggle placement:** the toggle now lives inside the existing **Input** settings section (alongside Local Echo / CJK Input / Extended Keyboard Bar) instead of a duplicate "Input" section; only the toggle itself is hidden when `CODEMAN_GESTURE=1` is unset, leaving the rest of the section intact.
  - **Service env:** `scripts/codeman-web.service` now sets `CODEMAN_GESTURE=1` so the gesture feature is available on the local install (still gated behind the default-OFF per-user toggle).
  - **Docs:** CLAUDE.md updated for the orchestrator loop, multi-monitor/span-displays, cache-busting, gesture/multi-monitor toggles, and structural-count fixes.

## 0.8.1

### Patch Changes

- Thinking Effort now flows as a soft default the user can override in-session (PR #104, by @TeigenZhang).

  Previously Codeman carried the effort setting as the `CLAUDE_CODE_EFFORT_LEVEL` env var, which Claude Code treats as a hard override — it locked effort for the whole session and rejected in-session `/effort` switching (including switching to `ultracode`). Effort is now injected at spawn time as a CLI soft default that `/effort` can still change freely in either direction:
  - Regular levels (`low`/`medium`/`high`/`xhigh`/`max`) are passed via `claude --effort <level>` (the settings `effortLevel` key silently drops `max`, so the flag is used instead).
  - `ultracode` (xhigh effort + standing dynamic-workflow orchestration) is passed via `claude --settings '{"ultracode":true}'`, since the `--effort` flag rejects it.

  Details:
  - New `effort` field on the create-session, quick-start, and Ralph-loop request schemas; threaded through `Session._effort` to both spawn paths (tmux `buildSpawnCommand` and direct-PTY `buildInteractiveArgs`), persisted in `SessionState.effort`, and restored on reboot recovery.
  - `buildEffortCliArgs()` is the single, allowlist-validated source for both carriers (injection-safe).
  - Settings UI adds an "Ultracode (multi-agent workflows)" option to the Thinking Effort dropdown; the frontend no longer emits `CLAUDE_CODE_EFFORT_LEVEL`.
  - Legacy migration: sessions persisted with the old env var are auto-migrated into the new `effort` field, and the stale tmux env var is unset so respawned panes are no longer locked.
  - Adds `test/effort-injection.test.ts` (13 cases) covering carrier mapping, injection guards, args building, and constructor migration.

## 0.8.0

### Minor Changes

- Event-loop responsiveness fix, mobile image upload, response-viewer polish, and a mobile-UI trim.
  - **fix: avoid event-loop stalls from synchronous tmux/ps calls (#100):** The session manager ran `execSync` for tmux mouse-mode toggles, `list-panes`, and `ps`/`pgrep` resource-stat queries on the main thread. Under multi-session / many-pane load these blocking spawns froze Node's single event loop, stalling SSE broadcasts and PTY I/O (the ":3000 briefly unreachable, process never restarts" class of incident). Converted those calls to async `execAsync` and updated all callers to `await`. Added a lightweight `utils/event-loop-monitor.ts` that samples loop-delay and logs when a stall threshold is exceeded, started on web-server boot and stopped on shutdown — so future regressions leave a timestamped, quantified log line instead of vanishing silently.
  - **feat(web): mobile image upload to active session via paste dialog (#101):** The mobile keyboard-accessory paste dialog now attaches images, not just text — via a native picker (`accept=image/*` → camera / photo library / files) plus best-effort capture of images pasted into the textarea. Both paths reuse the existing `_uploadAndInsertImages()` → `POST /api/sessions/:id/paste-image` pipeline. Images are re-encoded client-side before upload (PNG→PNG to preserve transparency, everything else→JPEG, animated GIFs passed through untouched) so the bytes always match their declared extension — fixing the Android/MIUI case where a WebP/HEIF mislabeled as `image/jpeg` passed the extension allowlist but failed the server's magic-byte check. The server logs a precise diagnostic on any remaining magic-byte mismatch.
  - **feat(web): response-viewer transcript fallback + code-block rendering (#102):** A substantial response-viewer styling overhaul — proportional prose font (monospace kept for code), refined heading/code/blockquote/list styling, readable max content width, and a smoother slide-in animation; the `.rv-text` rules now also apply to `.response-viewer-body` so transcript-missing fallback content gets the same typography. Plus a `_renderMarkdown` null-safety fix (`text` → `src = text || ''`).
  - **feat(web): remove /compact button from the mobile keyboard accessory bar:** Dropped `/compact` from both the simple and extended accessory-bar layouts and the associated action handling. `/clear` retains its double-tap confirmation. Verified on a touch-emulated viewport that neither layout renders a compact action.

## 0.7.1

### Patch Changes

- **fix(respawn): auto-accept now fires on plan approvals after `Worked for X` line, and on AskUserQuestion menus**

  Two related blockers in the respawn controller's auto-accept path:
  - Modern Claude Code emits `✻ Worked for Xm Ys` immediately before a plan-approval menu. `_detectCompletionMessage()` cancelled the auto-accept timer and `canAutoAccept()` then rejected on `completionMessageTime !== null`, so plan approvals **never** auto-accepted — the 10 s completion-confirm timer instead started a respawn cycle while the menu sat unanswered.
  - The same logic in `signalElicitation()` set a hard flag that blocked auto-accept whenever Claude Code fired the `elicitation_dialog` hook, contradicting the in-UI hint ("Auto-accept presses Enter for plan approvals **and default question options**"). AskUserQuestion menus were therefore never auto-accepted either.

  Fix:
  - `_detectCompletionMessage()` no longer cancels the auto-accept timer; the auto-accept pre-filter is now the authoritative "is there a numbered selection menu?" gate.
  - `canAutoAccept()` and the AI-plan-check callback both accept `'watching'` AND `'confirming_idle'` states (covers the single-PTY-burst case where `Worked for` and the menu arrive together — `_detectCompletionMessage` returns early before the substantial-output check can demote state back to watching). `sendAutoAcceptEnter()` self-transitions back to `'watching'` before sending Enter.
  - `signalElicitation()` is now an affirmative hint that primes the auto-accept timer instead of blocking. Still gated on `config.autoAcceptPrompts` AND state ∈ {`watching`, `confirming_idle`} — never fires Enter when respawn is off or auto-accept is disabled.
  - AI plan-check prompt broadened to recognize AskUserQuestion / elicitation menus as valid for auto-accept (the verdict name `PLAN_MODE` is preserved for compatibility but now means "auto-accept this selection menu").
  - Removed the now-unused `elicitationDetected` field and its assignments.

  Two new regression tests cover both the separate-PTY-chunk and single-PTY-chunk cases; the previously misleading "should NOT send Enter when completion message was detected" test was renamed and re-scoped to clarify it tests the **no-menu** path (which still correctly rejects via the pre-filter).

  **docs(web): correct `sendPendingCtrlL` comment** — removed the stale "called by foo/bar" note from the dead-call-graph helper after #99.

## 0.7.0

### Minor Changes

- Response viewer & terminal-stability improvements, plus test/error-handling hardening.
  - **Copy button on code blocks (#98):** Every fenced code block in the response viewer now has a one-click copy button pinned to its top-right, outside the `<pre>` scroll container so it stays put during horizontal scroll. ASCII diagrams keep their line-wrap toggle alongside it. Copy prefers the async Clipboard API and falls back to a hidden-textarea + `execCommand` path, so it works over plain HTTP (tunnel) too, with a brief ✓/✕ feedback state.
  - **Fix: stop auto-sending Ctrl+L from session-selection paths (#99):** A fast page refresh or SSE reconnect could fire two programmatic Ctrl+L (`\x0c`) sends within Claude Code 2.x's "clear conversation" confirmation window, silently wiping the active conversation. Removed the automatic Ctrl+L sends from `selectSession()`, `restoreTerminalSize()`, and the dead `sendPendingCtrlL()` path; redraws now rely on resize/SIGWINCH. User-initiated Ctrl+L still works. Trade-off: an occasional transient stale Ink frame right after refresh that self-heals on the next keypress — far preferable to silent data loss.
  - **Test & error-handling hardening (#97):** Repaired route-test harness error rendering via a dedicated `route-error-handler.ts`, and stopped the AI idle/plan checkers from spawning real processes during tests.

## 0.6.12

### Patch Changes

- Fix new-session crash after a tmux upgrade and isolate Codeman sessions on a dedicated tmux socket.
  - **Pane file-descriptor limit**: raise `ulimit -Sn` before launching the CLI (in both the spawn and respawn paths) so the newer tmux + macOS launchd combination — which hands panes a low soft `nofile` limit (256) that recent Claude Code refuses to start under — no longer kills every freshly spawned session on startup.
  - **Single-socket isolation**: all Codeman-owned tmux sessions now live on a dedicated socket (`tmux -L codeman`, overridable via `CODEMAN_TMUX_SOCKET`), fully separated from the user's default tmux server. The socket name is validated and shell-escaped at every call site.
  - **Drop the drift-prone per-session `tmuxSocket` field**: session reconciliation collapses to a single `list-panes` query against the one socket, eliminating live sessions being wrongly marked dead ("session not found") and duplicate "Restored:" tabs. Stale per-session socket tags and duplicate records are cleaned from disk on load (dedup by `muxName`, keeping the real entry over `restored-` placeholders).
  - **Route remaining bare-`tmux` call sites through the socket**: the window-size query on re-attach (previously fell back to 120×40 and lost scrollback) and the send-key route (Shift+Enter / Ctrl+Enter newline).
  - **SSH chooser scripts** (`tmux-manager.sh`, `tmux-chooser.sh`) route every tmux call through the dedicated socket.

## 0.6.11

### Patch Changes

- Resume Conversation: fixes and folder drill-down.
  - **fix(history)**: `decodeProjectKey()` now uses longest-join-first backtracking with on-disk validation, so sibling directories sharing a prefix (e.g. `diary/` vs `diary-app/`) resolve to the correct path. Previously the greedy shortest-match decoder picked the shorter name and bailed, surfacing `$HOME` in the Resume Conversation list and resuming into the wrong folder. Greedy decode is kept as a fallback so history for deleted projects still resolves. (#92)
  - **fix(tabs)**: Drop the client-side resurrection of ended-session tabs. The old code cached open tabs in `localStorage` and rebuilt them as grayed-out stubs whenever the server no longer knew them, which left phantom tabs after closing a session on another device. The server is now the single source of truth; legacy `localStorage` keys are purged on init. Net -44 / +6 lines. (#93)
  - **feat(history)**: New "View all in this folder" drill-down on Resume Conversation. `GET /api/history/sessions` accepts `projectKey` (validated against `^[A-Za-z0-9_-]+$` before any filesystem access), `offset`, and `limit`; single-folder mode bypasses the 50-cap and returns `{ sessions, total }`. Frontend adds a modal listing 20 sessions per page with a "Show more" pagination button. Modal items omit their own "View all" button to prevent recursive entry points. (#94)

## 0.6.10

### Patch Changes

- ## Security: paste-image endpoint hardening (#90)

  Addresses seven findings from the dismissed review of #84. Most exposed in tunneled deployments where `CODEMAN_PASSWORD` is set but the server is reachable beyond localhost.
  - **CSRF protection** on `POST /api/sessions/:id/paste-image`. Requires `Origin`/`Referer` to match `req.host`; non-browser clients (no `Origin` and no `Referer`) must send `X-Codeman-CSRF`. Defeats cross-origin `<form enctype="multipart/form-data">` submits that would otherwise plant arbitrary bytes into the victim's `.claude-images/` while their session cookie is live.
  - **Magic-byte validation** on uploaded images. Sniffs the first 12 bytes against PNG/JPEG/GIF/WebP/BMP signatures and rejects 415 on mismatch. Polyglot HTML-or-SVG-with-image-MIME no longer round-trips through the endpoint.
  - **Symlink-safe writes** on `.claude-images/`. `lstat` before the write, non-recursive `mkdir`, `O_EXCL|O_NOFOLLOW` on file open. A `node_modules` postinstall (or the agent itself) planting `.claude-images -> ~/.ssh/` no longer redirects pastes outside `workingDir`.
  - **Multipart parser swap** to `@fastify/multipart` with `limits: { fileSize: 10MB, files: 1, fields: 4 }`. Replaces a hand-rolled boundary scanner that matched the literal boundary anywhere in the body, hard-coded `\r\n` (silently corrupting LF-only clients), and had no part-count cap.
  - **Rate limit + GC**: token-bucket (30/min per IP+session) and hourly GC of `paste-*` files older than 7 days from each live session's `.claude-images/`. New `paste-image-gc.ts` started/stopped from `WebServer.start/stop`.
  - **Collision-free filenames**: `paste-${Date.now()}-${randomBytes(4)}${ext}`. Two tabs pasting in the same millisecond no longer silently last-write-wins.
  - **Bracketed-paste preservation**: text-only paste in `image-input.js` now goes through `terminal.paste(text)` instead of `sendInput(text)`, so xterm preserves `CSI 200~ ... CSI 201~` markers — Claude Code uses them as part of its prompt-injection defenses.

  ## Fix: duplicate multipart parser conflict

  Removed a duplicate multipart content-type parser left behind after the swap above. The duplicate registration conflicted with `@fastify/multipart`'s own parser; uploads now flow through the plugin exclusively.

  ## WebGL renderer auto-fallback hardening (#91)

  Follow-ups on the longtask auto-fallback shipped in #83.
  - `PerformanceObserver` is now disconnected on `onContextLoss` as well as on the trip path. Previously the observer outlived its disposed addon after a context loss, holding a closure reference over every longtask the page emitted.
  - Thresholds (`200ms / 3 longtasks / 30s window / 5s grace / 7d sticky-disable`) are hoisted to `WEBGL_FALLBACK` in `constants.js`. No more inline literals.
  - New `evaluateWebGLLongTaskTrip()` pure helper splits the rolling-window arithmetic from the `PerformanceObserver` callback so the trip math is unit-testable. New `test/webgl-fallback.test.ts` (9 tests, port 3166): trip inside window, no-trip when spread, sub-threshold filtering, stale-entry pruning, cumulative counting across batches, observer-dispose idempotency.

  ## CI: server boot smoke test

  GitHub Actions now boots the server as a final step after typecheck/lint/format. Catches production-only ESM/CJS regressions that `tsx` masks in dev.

  ## Docs

  `CLAUDE.md` frontend-module table updated to include `image-input.js` (overlooked when #84 landed).

## 0.6.9

### Patch Changes

- Terminal renderer hardening, SSE bandwidth cut, image paste, and a security tightening on the new live filter:
  - **Multi-primitive yield for write pacing** (#85): replaces six raw `requestAnimationFrame` callsites in the xterm.js write pipeline with a yielding helper that races `requestAnimationFrame`, `setTimeout(50)`, and a tick Worker. Keeps the terminal responsive when the tab is backgrounded or occluded — Chrome's intensive-throttling no longer stalls long writes.
  - **WebGL longtask auto-fallback** (#83): a `PerformanceObserver` watches for ≥200ms WebGL frames; three within a 30s window disposes the WebGL addon and falls back to the canvas renderer. Decision is persisted in localStorage for 7 days, and `?webgl=force` clears it.
  - **Per-client live SSE subscription filter** (#86): each connected client gets a stable UUID and can narrow its terminal stream to one session via `POST /api/events/subscribe` — no EventSource reconnect on tab switches. Cuts SSE bandwidth roughly N× when N sessions are open. Lifecycle/metadata events (`session:*`, `case:*`, `ralph:*`, `hook:*`) now broadcast to every client so sidebars stay in sync.
  - **Image paste and drag-and-drop into the terminal** (#84): `Ctrl+V` and dropped images upload to `POST /api/sessions/:id/paste-image`, save under `${workingDir}/.claude-images/paste-${ts}.${ext}` and type the path into the terminal. Hard 10MB cap, server-generated filename (no traversal), `.svg` deliberately excluded from the allowlist to avoid a same-origin XSS path through `file-raw`.
  - **SSE clientId validation**: the per-client identifier introduced in #86 is now constrained to `[A-Za-z0-9_-]{8,64}` at both ingress points. Without this, an authenticated attacker could send another tab's clientId to silently evict it from broadcasts, mutate any clientId's session filter to blackhole the victim's terminal stream, or grow `sseClientsById` unboundedly via long IDs. The subscribe payload is also capped at 64 session entries of ≤128 chars each.

## 0.6.8

### Patch Changes

- Finish the hostname-aware notification plumbing started in 0.6.7 and lock down the recent UI/runtime fixes with regression tests.
  - Browser Notification API (OS-level desktop pop-ups, layer 3 of the 5-layer notification system) now uses `${originalTitle}: ${title}` instead of the hardcoded `Codeman:` literal — so multi-host users running Codeman on laptop / dev box / NAS see `codeman:<host>: <event>` consistently across tab title, tab-flash, Web Push, and OS notifications.
  - Inline session rename hardened against three corner cases: IME composition commits (Chinese pinyin Enter no longer ships half-composed text as the session name), mid-rename SSE deletion (orphaned `<input>` no longer 404s on blur), and double-fire on stuck settle-once flag (closure-local `settled` boolean replaces the boolean instance flag).
  - Test coverage backfilled for two prior shipped fixes:
    - `<title>codeman:<host></title>` server-side templating (#82): 8 tests covering default `os.hostname()`, `--title-hostname` override, HTML-escape against `<script>`-style breakout, ampersand non-double-encoding, and template-tail byte-identical invariance.
    - tmux size-query helper (#80): 15 tests covering the browser-resize-between-attaches happy path, the query-then-die race, zero/negative/empty/non-numeric output fallbacks, and argv-form/timeout assertions that lock down the no-shell-interpolation guarantee. Inline 14-line query block extracted into a named `queryTmuxWindowSize()` export in `session.ts` so the test surface is a pure function.
  - Regression coverage added for `stripInkRedrawBloat` route helper.
  - CLAUDE.md and README.md updated to document dual-CLI env-prefix discipline (`CLAUDE_CODE_*` vs `OPENCODE_*`), the `xterm-zerolag-input` published-package side-effect of overlay edits, and the unified hostname prefix across tab title / tab-flash / OS notifications.

## 0.6.7

### Patch Changes

- - **fix(client): preserve inline rename input across tab re-renders** (#81) — Right-click → rename on a session tab no longer loses keystrokes when SSE traffic from sibling sessions triggers a tab re-render. Adds an `_inlineRenameActive` guard at the top of `renderSessionTabs()` and `_fullRenameSessionTabs()` so the in-progress input isn't destroyed mid-typing. Also fixes a latent double-fire of `finishRename` (blur + Enter could both invoke it). Drive-by: safer DOM child clearing in place of `innerHTML = ''`.
  - **feat: hostname-aware window title** (#82) — The browser tab title is now `codeman:<hostname>` instead of the bare `Codeman` literal, so users running Codeman on multiple hosts (laptop, dev box, NAS) can tell at a glance which tab points at which backend. New `--title-hostname <name>` CLI flag overrides the detected `os.hostname()` when it's noisy or you want a cosmetic name. The title is templated into the served HTML on first byte (with narrow HTML escaping), so it's correct from the first paint and works without JavaScript. Title-flash logic now respects the per-host title.
  - **perf: larger terminal tail on tab switch** — `TERMINAL_TAIL_SIZE` raised from 128KB to 1MB. When switching back to a busy session tab you now get ~8× more scrollback restored immediately.
  - **fix: preserve response text in Ink redraw stripping** — `stripInkRedrawBloat()` rewritten from a first-VPA approach to cluster-based detection. The previous algorithm assumed all VPA escapes after the first one belonged to a single redraw region and discarded everything in between, which silently lost 100KB+ of legitimate Claude response text once a render had occurred. The new approach groups VPAs into clusters separated by ≥8KB gaps and only collapses clusters spanning ≥32KB, so streamed response content between redraw bursts is preserved.
  - **docs**: `CLAUDE.md` Additional Commands gains the `--title-hostname` row; `README.md` gets a "Hostname-Aware Window Title" subsection under Multi-Session Dashboard.

## 0.6.6

### Patch Changes

- **Terminal scrollback significantly increased** — both the xterm.js viewport and the tmux backing buffer were bottlenecking how far back you could scroll. Three changes:
  - `DEFAULT_SCROLLBACK` raised from 20000 → 50000 lines (xterm.js, main terminal). The previous bump from 5000 only helped users with empty localStorage; existing users were stuck on whatever value they first picked up. The loader now treats `DEFAULT_SCROLLBACK` as a floor — if your stored value is below the new minimum, you're raised to it automatically.
  - Subagent / teammate terminals (`panels-ui.js`) were stuck at 5000; now use the same `DEFAULT_SCROLLBACK` constant (50000).
  - New tmux sessions now run with `history-limit 50000` (tmux defaults to 2000). This matters for hard-reload / re-attach — without it, only the last ~2000 lines survive the round-trip back into a fresh xterm.

  **Tmux flicker on session re-attach fixed (PR #80 by @aakhter)**: the PTY now queries the existing tmux window size via `tmux display -p` before spawning, instead of hardcoding 120x40. Previously, every re-attach forced tmux to resize down to 120x40, causing a visible flicker and one frame of scrollback loss. The `-x 120 -y 40` flag was also dropped from `tmux new-session` so the initial size matches the first attaching client. Uses `execFileSync` (not shell) for safety and falls back to 120x40 on any error.

  **Docs**: CLAUDE.md now documents two recurring foot-guns — the `xterm-zerolag-input` overlay code is duplicated between `packages/xterm-zerolag-input/src/` and inline inside `src/web/public/app.js`, so any overlay change must touch both; and the COM workflow explicitly includes a post-push `gh run watch` step to confirm CI before considering the release done.

## 0.6.5

### Patch Changes

- **Mobile fix**
  - Android virtual keyboard: space character was silently dropped on touch devices using GBoard / SwiftKey / similar IMEs. Root cause: the input-event handler in `terminal-ui.js` treated any whitespace-only textarea value as proof that xterm had already processed the input. A lone space (`' '.trim() === ''`) tripped this guard, so the space was consumed but never forwarded. Now skips only when the textarea is truly empty (or whitespace from a non-space key). Reported and diagnosed by @coolk8 in #79.

  **Docs**
  - `CLAUDE.md`: added Zod `.optional()`-vs-`null` gotcha (recurring trap from 0.6.3 / 0.6.4 incidents) and a more visible warning against running bare `npm test` (kills the host tmux session).
  - `docs/local-echo-overlay-plan.md`: marked SHIPPED, corrected xterm version reference (v5.3.0 → `@xterm/xterm` ^6.0.0).

## 0.6.4

### Patch Changes

- Fix "Failed to enable respawn: Invalid request body" error when selecting infinity duration (∞) in the respawn modal. Frontend was sending `durationMinutes: null`, which Zod's `.optional()` schema rejected (it accepts `undefined` only). The body now omits the field when no duration is selected.

## 0.6.3

### Patch Changes

- **Fix**
  - Allowlist `opusContext1mEnabled` in `SettingsUpdateSchema`. Without this entry, the strict schema rejected `PUT /api/settings {"opusContext1mEnabled":...}` with `INVALID_INPUT`, so the toggle's value never persisted across reloads. The frontend was already reading and writing this key (`settings-ui.js:336/1137`, `session-ui.js:340`), so saves were silently failing — users never noticed because the load path falls back to `false` on missing keys, hiding the bug. (#78)

## 0.6.2

### Patch Changes

- **Mobile UX**
  - Resume Conversation list (welcome page) reworked for narrow screens: 2-line title clamp so more of the first prompt is visible; case-aware subtitle that renders `#caseName` (or `#caseName/sub`) when `workingDir` matches a known case, otherwise falls back to the directory basename; inline `⋯` toggle that expands a detail panel with full prompt, full path, timestamp, size, and short session id; `/Users/<user>/` now collapses to `~/` alongside `/home/<user>/`. (#77)
  - Response viewer: ASCII diagram wrap toggle, dedicated mobile code-block layout, and chrome-stripping fallback when the model wraps its reply in extra markup. (#75)
  - Mobile keyboard accessory bar no longer triggers vertical scroll. (#72)

  **Sessions & settings**
  - New `thinkingEffort` setting on session creation, with `xhigh` option and `/effort max` mobile shortcut. (#73)
  - `thinkingEffort` is now allowlisted in `SettingsUpdateSchema` so it round-trips through PATCH /api/settings.
  - `envOverrides` (`CLAUDE_CODE_*` / `OPENCODE_*`) are now passed to Claude via tmux env exports at spawn time instead of being written to `<case>/.claude/settings.local.json`. Eliminates UI/disk drift; the value lives on `Session._envOverrides`, is exported by `tmux-manager.buildEnvExports()`, and is persisted in `SessionState.envOverrides`. (#74)

  **Fixes**
  - Eye icon (active-session indicator) now follows `/clear` to the new Claude conversation instead of getting stuck on the previous transcript. (#76)
  - `tmux-manager.reconcileSessions` now uses `|` as the field separator, fixing parsing when session names contain other delimiters. (#71)

  **Docs**
  - CLAUDE.md: added `npm run knip` to the dead-code sweep table and a `Common Gotchas` entry documenting the `envOverrides` → tmux export flow.

## 0.6.1

### Patch Changes

- Internal cleanup and release hygiene:
  - **Dead-code sweep via knip**: added `knip.json` for dead-code detection and ran a full sweep — removed unused test files, unused scripts, and narrowed internal module exports to the minimum surface area actually consumed.
  - **Lockfile drift prevention**: `version-packages` now runs `npm install --package-lock-only` and verifies the lockfile is in sync via `scripts/check-lockfile-sync.mjs`; CI runs the same check on every push/PR so version drift fails the build instead of reaching production. Resolves the `package-lock.json` / `package.json` version mismatch that shipped in 0.6.0.
  - **Docs tightening**: archived 22 completed plan docs from `docs/`, corrected file/handler counts in `CLAUDE.md`, documented the lockfile step in the COM workflow, and removed footer redundancy.

## 0.6.0

### Minor Changes

- Community contributions from @aakhter:
  - **feat (#66): Tab reorder shortcuts** — `Ctrl+Shift+{` and `Ctrl+Shift+}` move the active session tab left/right, matching WezTerm convention. Order persists across reloads via `saveSessionOrder()`.
  - **feat (#67): Active tab visibility + Alt+N badges** — active tab now has a bright green border with color-matched glow, and the first 9 tabs display number badges hinting at the `Alt+N` switch shortcut. Badges update on reorder/rerender.
  - **feat (#68): Clipboard API** — new `POST /api/clipboard` accepting `{text}` broadcasts a `clipboard:write` SSE event; connected browsers attempt `navigator.clipboard.writeText()` with a manual-copy modal fallback when the page isn't focused. Auth-protected via the standard middleware. Useful for pushing snippets from remote sessions to the user's local clipboard.
  - **fix (#65): Android Shift+key double character** — pressing `Shift+A` on attached Android keyboards no longer produces "AA". Tracks xterm-handled keydown timestamps and skips the orphaned-input listener for 50ms after a real keydown, while still catching Gboard symbol-keyboard inputs (keyCode 229).

## 0.5.13

### Patch Changes

- Fix "Case path not found" error in Quick Start when `~/codeman-cases/` does not exist (issue #64). Two bugs in `session-ui.js`:
  - `runClaude()` auto-create read `createCaseData.case`, but `POST /api/cases` returns `{ success, data: { case } }` — corrected to `createCaseData.data.case`.
  - `runShell()` had no auto-create logic and would immediately throw on a missing case directory — now mirrors `runClaude()`'s create-on-demand flow.

## 0.5.12

### Patch Changes

- Fix quick-start to resolve linked cases before codeman-cases fallback. `/api/quick-start` was always resolving `caseName` against `CASES_DIR`, ignoring entries in `~/.codeman/linked-cases.json`. Sessions started via quick-start now correctly honour linked external project directories, consistent with regular case routes.

## 0.5.11

### Patch Changes

- Community contributions and security hardening:
  - Mobile response viewer: native-scroll panel for reading full Claude responses with markdown rendering via marked.js (PR #62)
  - PWA support: service worker caching, web app manifest, and Android home screen install (PR #59)
  - Named Cloudflare tunnel support (PR #58)
  - Markdown rendering for response viewer with HTML sanitization (XSS prevention) — strips dangerous elements, event handlers, and javascript: URIs
  - Service worker switched from stale-while-revalidate to network-first caching so deploys take effect immediately
  - Content-Disposition filename sanitization to prevent header injection in file downloads
  - Expose session.muxName public getter, replace unsafe `as any` cast in session-routes
  - Static import for execFile in session-routes
  - Keyboard shortcut updates: Alt+1-9 tab switching, Shift+Enter newline
  - Repo restructure for cleaner GitHub landing page
  - Mobile logo, expandable history, session resume fixes

## 0.5.10

### Patch Changes

- fix: allow bracket characters in model validation regex so models like opus[1m] (1M context window) are accepted instead of silently dropped. Quote the model flag value in tmux spawn commands to prevent bash glob expansion of bracket patterns.

  docs: update macOS launchd instructions to use `launchctl bootstrap` instead of deprecated `load`. Clean up README install and service sections.

## 0.5.9

### Patch Changes

- Mobile keyboard accessory bar: add configurable "Extended Keyboard Bar" setting (Settings > Display > Input) that toggles between simple mode (up/down arrows, /init, /clear, /compact, paste, dismiss) and extended mode (adds left/right arrows, Tab, Shift+Tab, Ctrl+O, Alt+Enter, Esc). Default is simple mode. Setting is device-specific (not synced to server).

  Restyle dismiss button: muted steel-blue tone, fills remaining bar space via flex, larger tap target. Arrow buttons now blue.

  Fix paste overlay visibility on mobile: dialog repositioned to top of screen (15vh from top) so the virtual keyboard doesn't cover it. Textarea enlarged for better usability.

  (Also includes all v0.5.8 changes: case reorder/delete, XSS sanitization, auto-attach PTY on restart, mobile keyboard buttons, macOS installer fixes, terminal flicker fix, state store collision fix.)

## 0.5.8

### Patch Changes

- Case management: add Manage tab with reorder (up/down arrows) and delete for cases; linked cases are unlinked (folder preserved), CASES_DIR cases are permanently deleted. New endpoints: DELETE /api/cases/:name, PUT /api/cases/order. SSE events: case:deleted, case:order-changed.

  Security: sanitize case names from filesystem with /^[a-zA-Z0-9_-]+$/ regex before returning from GET /api/cases to prevent XSS via maliciously-named directories reaching frontend inline onclick handlers.

  Auto-attach PTY: server now calls startInteractive() for recovered tmux sessions during startup so all sessions resume capturing output immediately after deploy, instead of waiting for client selection. Frontend auto-attach condition relaxed from (pid===null && status==='idle') to (pid===null && !\_ended).

  Mobile keyboard accessory: add Shift+Tab, Tab, Esc, Alt+Enter, Left/Right arrow, and Ctrl+O buttons.

  Terminal: fix flicker regression by moving viewport clear inside dimension guard.

  State store: fix temp file collisions on concurrent writes.

  macOS: fix installer failures when piped via curl | bash, add HTML cache support, launchd service template, and trust dialog handling.

  Housekeeping: remove accidentally committed dist/state-store.js build artifact.

## 0.5.7

### Patch Changes

- feat: support "Default (CLI default)" option for model selection. Adds a new empty-value option to the model dropdown that defers to the CLI's own default model instead of forcing a specific model. Ensures empty defaultModel values are treated as undefined when passed to session creation and Ralph loop start, preventing empty strings from being sent as model flags.

## 0.5.6

### Patch Changes

- fix: default new sessions to opus[1m] (1M context window) instead of plain opus (200k context)

## 0.5.5

### Patch Changes

- Add 1M Opus context quick setting — per-case and global toggle that writes `model: "opus[1m]"` to `.claude/settings.local.json` when creating new sessions. Fix mobile layout: banners (respawn, timer, orchestrator) between header and main content now visible by switching from margin-top on `.main` to padding-top on `.app`. Add tablet-optimized respawn banner styles and mobile phone banner refinements.

## 0.5.4

### Patch Changes

- Fix terminal flicker regression — re-add server-side DEC 2026 synchronized output wrapping around batched terminal data. Ink spinner frames (cursor-up + redraw cycles) do not emit their own DEC 2026 markers, so without the server wrapper each partial cursor update rendered individually causing visible flicker. Also: extract SSE stream management, session listener wiring, and respawn event wiring from server.ts into dedicated modules; deduplicate error message extraction across 7 files with shared getErrorMessage() helper; update SSE event count in CLAUDE.md (106 → 117).

## 0.5.3

### Patch Changes

- Readability refactor across 12 core files, extracting ~35 helper methods to reduce duplication:
  - state-store: extract serializeState(), split assembleStateJson() into focused sub-methods
  - session: extract \_resetBuffers() (3x dedup), \_clearAllTimers() (10 timer cleanups), \_handleJsonMessage()
  - ralph-tracker: extract completeAllTodos() (4x dedup), emitValidationWarning(), named similarity constants
  - subagent-watcher: extract markSubagentAsCompleted(), extractFirstTextContent(), emitToolResult(), findOldestInactiveAgent()
  - respawn-controller: extract recoveryResetToWatching(), canAutoAccept(), formatRemainingSeconds(), validatePositiveTimeout()
  - tmux-manager: replace 15 path.includes() with UNSAFE_PATH_CHARS regex, extract buildEnvExports/buildPathExport/\_configureOpenCode helpers
  - session-auto-ops: extract executeWhenIdle() shared retry helper, convert to options object, add validateThreshold()
  - app.js: add \_clearTimer() (11 call sites), \_isStaleSelect(), keyboard shortcut lookup table, \_cleanupPreviousSession(), \_resetAllAppState()
  - route-helpers: add readJsonConfig() (5 inline patterns replaced), validateSessionFilePath() (2 duplicated blocks replaced)

## 0.5.2

### Patch Changes

- Make buffer size limits configurable via CODEMAN\_\* environment variables (MAX_TERMINAL_BUFFER, TRIM_TERMINAL_TO, MAX_TEXT_OUTPUT, TRIM_TEXT_TO, MAX_MESSAGES), falling back to existing defaults. Allows users with fewer sessions or more RAM to tune buffer sizes without patching source.

  Fix duplicate terminal output on tab switch to busy sessions by clearing the terminal before writing the new buffer.

  Fix stale Ink CUP frames after tab switch by sending Ctrl+L to force a clean redraw.

  Fix mobile CJK input handling: resolve textarea positioning, terminal flicker during composition, and layout overflow on small screens. Improve CJK composition lifecycle with better event handling and fallback flush timers.

## 0.5.1

### Patch Changes

- refactor: codebase cleanup — extract route helpers, eliminate boilerplate, optimize hot paths
  - Add `parseBody()` helper to route-helpers.ts: validates request body against Zod schema with structured 400 error on failure, replacing 37 identical safeParse + error-check blocks across 10 route files
  - Add `persistAndBroadcastSession()` helper: combines persist + SessionUpdated broadcast into one call, replacing 5 repeated 2-line pairs
  - Migrate session-routes.ts to use `findSessionOrFail()` consistently (17 inline session lookups replaced) and `parseBody()` (12 patterns)
  - Migrate ralph-routes.ts to use `findSessionOrFail()` (9 lookups) and `parseBody()` (4 patterns)
  - Migrate 8 remaining route files to use `parseBody()` (21 patterns total)
  - Fix O(n log n) eviction in bash-tool-parser.ts: replace `Array.from().sort()[0]` with O(n) min-scan for oldest active tool
  - Extract `_debouncedCall()` utility in frontend: replaces 4 manual debounce patterns (7 lines each → 1 line) in app.js, panels-ui.js, ralph-panel.js
  - Net reduction: 208 lines removed across 16 files

## 0.5.0

### Minor Changes

- Visual redesign with glass morphism, refined colors, and polished UI. Optimize history endpoint with buffer reuse and line iterator. Fix Ink frame search window (4KB→64KB) to prevent partial frames. Fix stale terminal data on tab switch via chunkedTerminalWrite cancellation. Improve history prompt extraction with expanded command filtering and tail scan fallback. Align case select group height to match dropdown. Fix no-control-regex lint error for ANSI strip pattern. Add browser-testing-guide to CLAUDE.md references.

## 0.4.7

### Patch Changes

- feat: improve session navigability in history and monitor panel (closes #45)
  - History items now show the first user prompt as the title with the project path as a subtitle, making it much easier to distinguish sessions from the same project
  - The `/api/history/sessions` endpoint extracts the first user message from each transcript JSONL, stripping system-injected XML tags and command artifacts, truncating to 120 chars
  - Monitor panel session rows are now clickable — clicking navigates directly to that session's tab via `selectSession()`; Kill button retains independent behavior via `stopPropagation()`
  - Updated CLAUDE.md architecture tables to reflect Orchestrator Loop additions (14 route modules, 15 type files, orchestrator domain files, orchestrator-panel.js frontend module)
  - fix: stop subagent monitor windows from auto-opening on discovery
  - feat: add Orchestrator Loop with phased plan execution, live progress during plan generation, and toolbar button (hidden until fully tested)
  - fix: patch 3 production bugs found during deep audit
  - fix: restore mobile terminal scrollback using JS scrollLines() instead of broken native scroll

## 0.4.6

### Patch Changes

- Fix mobile keyboard scroll and layout issues:
  - Prevent iOS Safari from scrolling the page when typing with the keyboard open (position:fixed on .app + window.scroll reset)
  - Eliminate dead space between terminal and keyboard accessory bar by removing redundant CSS padding, tightening JS padding constant, and adding row quantization gap compensation
  - Fix toolbar overlapping terminal content when keyboard is hidden by adding proper padding-bottom to .main, including iOS Safari bottom bar offset
  - Strip Ink spinner bloat from terminal buffer before tailing
  - Fix resolveCasePath priority order and suppress JSON parse warnings

## 0.4.5

### Patch Changes

- Fix mobile keyboard toolbar positioning on iOS Safari: toolbar (Run/Stop/Run Shell) was hidden behind the accessory bar when virtual keyboard was active due to overlapping CSS positions. Remove the aggressive safety check in `updateLayoutForKeyboard()` that incorrectly dismissed keyboard state when iOS scrolled the visual viewport during typing. Add Safari-bar CSS offset to accessory bar so it properly stacks above the toolbar. Remove the double-counted Safari-bar offset when keyboard is visible since the JS transform already covers the full distance.

## 0.4.4

### Patch Changes

- fix: mobile keyboard hides terminal content on iPhone

  Fixed a bug where opening the virtual keyboard on iPhone left zero visible terminal space. Two independent mechanisms were both accounting for the keyboard height: `MobileDetection.updateAppHeight()` shrunk `--app-height` to the visual viewport height, while `KeyboardHandler.updateLayoutForKeyboard()` added a large `paddingBottom`. These double-counted, leaving negative space for the terminal (user saw accessory bar + toolbar but no terminal content).

  Fix: `updateAppHeight()` now skips when the keyboard is visible, and `handleViewportResize()` restores `--app-height` to the pre-keyboard value on first detection (since MobileDetection's listener fires before KeyboardHandler's). On keyboard close, `--app-height` is re-synced to the current visual viewport.

## 0.4.3

### Patch Changes

- Refactor case routes: extract readLinkedCases() and resolveCasePath() helpers to eliminate 6x duplicated linked-cases.json path construction and 5x duplicated file read/parse logic. Replace O(n) .some() duplicate check with O(1) Set.has() in case listing. Un-export unused isError() type guard. Standardize reply.status() to reply.code() in system routes. Update CLAUDE.md frontend module listing and SSE event count.

## 0.4.2

### Patch Changes

- Extract monolithic app.js (~12.5K lines) into 6 focused domain modules that extend CodemanApp.prototype via Object.assign: terminal-ui.js (terminal setup, rendering pipeline, controls), respawn-ui.js (respawn banner, countdown, presets, run summary), ralph-panel.js (Ralph state panel, fix_plan, plan versioning), settings-ui.js (app settings, visibility, web push, tunnel/QR, help), panels-ui.js (subagent panel, teams, insights, file browser, log viewer), session-ui.js (quick start, session options, case settings). Fix critical deferred script init ordering bug: wrap CodemanApp instantiation in DOMContentLoaded so all defer'd mixin modules execute their Object.assign before the constructor runs. Guard missing cleanupWizardDragging() call in subagent-windows.js. Update build.mjs to minify/hash all new modules.

## 0.4.1

### Patch Changes

- Performance optimizations: V8 compile cache for 10-20% faster cold starts, lazy-load WebGL addon (244KB saved on mobile), preload hints for critical scripts, batch tmux reconciliation (N subprocess calls → 1). Also: WebSocket session lifecycle fixes, CJK IME input support, CI upgrade to Node 24/actions v6, install.sh fork support, and CLAUDE.md/README documentation refresh.

## 0.4.0

### Minor Changes

- Add CJK IME input textarea for xterm.js terminal (env toggle INPUT_CJK_FORM=ON). Always-visible textarea below terminal handles native browser IME composition, forwarding completed text to PTY on Enter. Supports arrow keys, Ctrl combos, backspace passthrough, and Escape to clear.

  Add fork installation support to install.sh with CODEMAN_REPO_URL and CODEMAN_BRANCH env vars, allowing custom repository and branch for git clone/update operations. README updated with fork installation instructions.

  Fix WebSocket session lifecycle: close WS connections when session exits (prevents orphaned listeners and stale writes to dead PTY), add readyState guard in onTerminal to stop buffering after socket closes, simplify heartbeat by removing redundant alive flag.

  Add WebSocket reconnection with exponential backoff (1s-10s) on unexpected close, skipping server rejection codes (4004/4008/4009). Falls back gracefully to SSE+POST during reconnection.

  Clear CJK textarea on session switch to prevent sending stale text to wrong session.

## 0.3.12

### Patch Changes

- Add WebSocket terminal I/O with server-side DEC 2026 synchronized update markers. Replaces per-keystroke HTTP POST + SSE terminal output with a single bidirectional WebSocket connection for dramatically lower input latency. Server-side 8ms micro-batching with 16KB flush threshold groups rapid PTY events into single WS frames wrapped in DEC 2026 markers for flicker-free atomic rendering. Includes 30s ping/pong heartbeat with 10s timeout for stale connection detection through tunnels. Existing SSE + HTTP POST paths remain fully functional as transparent fallback. Resize messages validated to match HTTP route bounds (cols 1-500, rows 1-200, integers only). 16 automated route tests added for WS endpoint. Also patches 5 dependency vulnerabilities (basic-ftp, fastify, minimatch, serialize-javascript).

## 0.3.11

### Patch Changes

- ### Session Resume & History
  - Add `resumeSessionId` support for conversation resume after reboot
  - Add history session resume UI and API with route shell sessions routing fix
  - Improve session resume reliability and persist user settings across refresh
  - Correct `claudeSessionId` for resumed sessions

  ### Terminal & Frontend
  - Upgrade xterm.js 5.3 → 6.0 with native DEC 2026 synchronized output
  - Increase terminal scrollback from 5,000 to 20,000 lines
  - Reduce default font size and persist tab state across refresh
  - Resolve terminal resize scrollback ghost renders
  - Hide subagent monitor panel by default

  ### Installer
  - Auto-detect existing install and run update instead of fresh install
  - Auto-restart codeman-web service after update if running
  - Show restart command when codeman-web is not a systemd service
  - Fix one-liner restart command for background processes

  ### Codebase Quality
  - Remove dead code, consolidate imports, extract constants
  - Repair 15 pre-existing subagent-watcher test failures
  - Clean up DEC sync dead code

## 0.3.10

### Patch Changes

- - feat: upgrade xterm.js from 5.3 to 6.0 with native DEC 2026 synchronized output support
  - feat: add history session resume UI and API — resume Claude conversations after reboot
  - feat: add resumeSessionId support for conversation resume across session restarts
  - feat: persist active tabs across page refresh
  - feat: improve session resume reliability and persist user settings
  - perf: increase terminal scrollback from 5,000 to 20,000 lines
  - fix: resolve terminal resize scrollback ghost renders
  - fix: route shell sessions to correct endpoint on tab click
  - fix: correct claudeSessionId for resumed sessions (use original Claude conversation ID)
  - fix: increase default desktop font size from 12 to 14
  - refactor: extract shared \_fetchHistorySessions() method to eliminate duplication
  - refactor: remove dead DEC 2026 sync code (extractSyncSegments, DEC_SYNC_START/END constants)

## 0.3.9

### Patch Changes

- Add content-hash cache busting for static assets — build step now renames JS/CSS files with MD5 content hashes (e.g. app.js → app.94b71235.js) and rewrites index.html references. HTML served with Cache-Control: no-cache so browsers always revalidate and pick up new hashed filenames after deploys. Hashed assets keep immutable 1-year cache. Eliminates the need for manual hard refresh (Ctrl+Shift+R) after deployments.

  Refactor path traversal validation into shared validatePathWithinBase() helper in route-helpers.ts, replacing 6 duplicate inline checks across case-routes, plan-routes, and session-routes.

  Deduplicate stripAnsi in bash-tool-parser.ts — use shared utility from utils/index.ts instead of private method.

## 0.3.8

### Patch Changes

- Add tunnel status indicator with control panel — green pulsing dot in header when Cloudflare tunnel is active, dropdown with URL, remote clients, auth sessions, and start/stop/QR/revoke controls

## 0.3.7

### Patch Changes

- Operation Lightspeed: 5 parallel performance optimizations — multi-layer backpressure to prevent terminal write freezes, TERMINAL_TAIL_SIZE constant with client-drop recovery, tab switching SSE gating, and local echo improvements
- Codebase cleanup: remove dead code (unused token validation exports, PlanPhase alias), add execPattern() regex helper to eliminate repetitive .lastIndex resets, centralize 11 magic number constants into config files, fix CLAUDE.md inaccuracies, and add 316 new tests for utilities, respawn helpers, and system-routes

## 0.3.6

### Patch Changes

- Re-enable WebGL renderer with 48KB/frame flush cap protection against GPU stalls

## 0.3.5

### Patch Changes

- Fix Chrome "page unresponsive" crashes caused by xterm.js WebGL renderer GPU stalls during heavy terminal output. Disable WebGL by default (canvas renderer used instead), gate SSE terminal writes during tab switches, and add crash diagnostics with server-side breadcrumb collection.

## 0.3.4

### Patch Changes

- Fix Chrome tab freeze from flicker filter buffer accumulation during active sessions, and fix shell mode feedback delay by excluding shell sessions from cursor-up filter

## 0.3.3

### Patch Changes

- fix: eliminate WebGL re-render flicker during tab switch by keeping renderer active instead of toggling it off/on around large buffer writes

## 0.3.2

### Patch Changes

- Make file browser panel draggable by its header

## 0.3.1

### Patch Changes

- LLM context optimization and performance improvements: compress CLAUDE.md 21%, MEMORY.md 61%; SSE broadcast early return, cached tunnel state, cache invalidation fix, ralph todo cleanup timer; frontend SSE listener leak fix, short ID caching, subagent window handle cleanup; 100% @fileoverview coverage

## 0.3.0

### Minor Changes

- QR code authentication for tunnel access, 7-phase codebase refactor (route extraction, type domain modules, frontend module split, config consolidation, managed timers, test infrastructure), overlay rendering fixes, and security hardening

## 0.2.9

### Patch Changes

- System-level performance optimizations (Phase 4): stream parent transcripts instead of full reads, consolidate subagent file watchers from 500 to ~50 using directory-level inotify, incremental state persistence with per-session JSON caching, and replace team watcher polling with chokidar fs events

## 0.2.8

### Patch Changes

- Remove 159 lines of dead code: unused interfaces, functions, config constants, legacy no-op timer, and stale barrel re-exports

## 0.2.7

### Patch Changes

- Fix race condition in StateStore where dirty flag was overwritten after async write, silently discarding mutations
- Fix PlanOrchestrator session leak by adding session.stop() in finally blocks and centralizing cleanup
- Fix symlink path traversal in file-content and file-raw endpoints by adding realpathSync validation
- Fix PTY exit handler to clean up sessionListenerRefs, transcriptWatchers, runSummaryTrackers, and terminal batching state
- Fix sendInput() fire-and-forget by propagating runPrompt errors to task queue via taskError event
- Fix Ralph Loop tick() race condition by running checkTimeouts/assignTasks sequentially with per-iteration error handling
- Fix shell injection in hook scripts by piping HOOK_DATA via printf to curl stdin instead of inline embedding
- Narrow tail-file allowlist to remove ~/.cache and ~/.local/share paths that exposed credentials
- Fix stored XSS in quick-start dropdown by escaping case names with escapeHtml()

## 0.2.6

### Patch Changes

- Disable tunnel auto-start on boot; tunnel now only starts when user clicks the UI toggle

## 0.2.5

### Patch Changes

- Fix 3 minor memory leaks: clear respawn timers in stop(), clean up persistDebounceTimers on session cleanup, reset \_parentNameCache on SSE reconnect

## 0.2.4

### Patch Changes

- Fix tunnel button not working: settings PUT was rejected by strict Zod validation when sending full settings blob; now sends only `{tunnelEnabled}`. Added polling fallback for tunnel status in case SSE events are missed.

## 0.2.3

### Patch Changes

- Fix tunnel button stuck on "Connecting..." when tunnel is already running on the server

## 0.2.2

### Patch Changes

- Update CLAUDE.md app.js line count references

## 0.2.1

### Patch Changes

- Integrate @changesets/cli for automated releases with changelogs, GitHub Releases, and npm publishing

## 0.2.0

### Minor Changes

- Initial public release with changesets-based versioning
