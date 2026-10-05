# xterm-zerolag-input

## 0.4.0

### Minor Changes

- 6aecc3b: ### Thanks
  - @opticon454 for four PRs in one batch: webhook notifications (#523), MCP server sync (#521), the Shift+Enter keypress fix (#520) and the newline chord plus Key tester (#522). Every review item was answered in one round, and the merge-order map across all four made landing them together easy.
  - @aakhter for the grouped vertical rail (#517) and its ARIA tree and full-row activation (#519), which give the owner tab-layout API its first frontend, and for the iOS IME composition preview (#499), carried through three careful review rounds including the overlay rework in the zerolag package.
  - @irisitymichaelgrundberg for per-session Claude models on `POST /api/sessions` (#514) and Codex reasoning effort per session (#515), both kept registry-driven with no CLI id branching.
  - @timkjr for keeping Pane B painting during a history pull and its "disconnected" marker last in every interleaving (#524), with an old-versus-new table measured in real Chrome.

  **Webhook notifications (#523).** Settings → Notifications → Webhook posts the same events as Web Push (permission prompts, questions, errors, idle) to ntfy, Slack, Discord or any JSON URL, so a headless server can reach a phone with no browser open. Off by default. The URL is a bearer secret: it lives in its own 0600 file (`~/.codeman/webhook.json`), is never returned by the API, and the routes (`GET`/`PUT /api/webhook`, `POST /api/webhook/test`) are admin only in multi-user mode. Delivery goes through the web-tab egress guard (link-local and cloud-metadata targets refused), does not follow redirects, times out after 5 s, dedupes repeats, and neutralises `@everyone`/Slack control characters in agent-supplied text.

  **MCP server sync (#521).** Opt-in (`mcpSyncEnabled`, synced, off by default; `GET`/`POST /api/mcp-sync` answer 403 until it is on). Settings → Agents & CLIs → MCP servers previews or copies each installed, enabled CLI's MCP servers into the others' own config files (Claude, Gemini, Codex, OpenCode, Antigravity). It only adds missing servers, never edits or removes one, skips servers you switched off, keeps a `.codeman-bak` of every file it changes, re-parses the result before writing, writes through symlinked dotfiles, leaves files that receive env values or headers readable by you only, and reports same-name conflicts instead of overwriting. CLIs with no known MCP config (Pi, Grok, OMP, DeepSeek) are listed as unsupported. Adds the `smol-toml` dependency to read Codex's `config.toml` safely.

  **Claude advisor tool.** Claude Code's experimental advisor (a stronger model the session's main model consults at decision points) can now be set per session: an `advisorModel` field on `POST /api/sessions`, `POST /api/quick-start` and `POST /api/ralph-loop/start` (`fable`, `opus`, `sonnet`, or a full id in those families), and a synced App Settings default under Models → Advisor. It rides the launch's one `--settings` JSON rather than the `--advisor` flag, because the flag exits at launch on any pairing the CLI refuses and would leave a dead pane on every respawn. It is persisted, so respawns and both restore paths keep it, and `/advisor` still switches it in-session. Agents using the codeman skill can give their claude workers one with `CODEMAN_WORKER_ADVISOR=opus`.

  **Per-session Claude model (#514) and Codex reasoning effort (#515).** `POST /api/sessions` takes an optional `model` that launches that one Claude session with `claude --model <id>` and writes nothing to disk (`modelOverride` still writes the case default). It is persisted, so both recovery paths relaunch on it. `codexConfig.reasoningEffort` starts a codex session at a chosen effort (`--config model_reasoning_effort=<level>`), and it survives respawn and resume.

  **Grouped vertical rail (#517, #519).** When the owner has tab groups (`/api/tab-layout`), the vertical rail draws them as collapsible sections, with collapse remembered per device, the active row always visible, and lineage arcs anchored to a collapsed group's header. The grouped rail is an ARIA tree with one tab stop and the standard arrow-key model. With no groups, the rail is unchanged byte for byte. Editing groups from the browser comes in a follow-up.

  **iOS IME composition preview (#499).** On iOS Safari, the text an IME is composing (Japanese, Chinese, Korean, and the predictive composition on English keyboards) is now drawn in the terminal before it commits, inside the local-echo overlay when local echo is on. Inert on every other platform. The `xterm-zerolag-input` package gains `setComposition()`.

  **Key tester and newline chord (#522).** Settings → Terminal & Input has a Key tester that shows the keydown/keypress/keyup events the browser reports, to diagnose a device where a shortcut behaves differently. Keys pressed in it never trigger app shortcuts. Shift+Enter's newline chord is now CLI registry data (`capabilities.newline`, line feed by default); no stock CLI changes.

  **Fixes.** Shift+Enter no longer submits the prompt after inserting the newline: the key handler swallowed only `keydown`, so xterm's `keypress` still sent a bare `\r` (#520). Claude sessions created at the same moment (`spawn_workers`, a multi-tab Run) no longer fall out of tmux onto the direct-PTY fallback: the statusLine exporter's temp file name collided within one millisecond (#531). Pane B of the split view keeps painting during a history pull, and its "disconnected" marker stays the last line however a close, a pull and a refresh interleave (#524).

  **Fixes applied while landing.** Webhooks: the App Settings Save button now saves webhook edits too (a refused URL keeps the dialog open with a warning), Send test saves pending edits first, and a Remove URL button clears a saved URL. MCP sync: a config file that fails to parse is reported by line and column only, never by quoting its content, which can hold API keys; the sync follows `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `XDG_CONFIG_HOME` and `GEMINI_CLI_HOME` from the server's environment and skips a target it cannot place instead of writing a file the CLI never reads; Preview before saving says to save first; and the MCP group is hidden from non-admins in multi-user mode. Grouped rail: a collapsed group's header shows the red or yellow ring of a hidden row that needs you; layout reads rebuild the rail only when something it draws changed, and failed reads back off (5, 10, 20, 40 s) instead of retrying every 5 s forever; a corrupted collapse preference resets instead of disabling collapse; Ctrl+Shift+{ / } only moves a tab within its own group; tapping a group header or row no longer dismisses the phone keyboard; keys pressed on a row's own buttons no longer move tree focus; and screen-reader positions stay correct after a re-sort. Sessions: `model` on `POST /api/sessions` refuses a value starting with a dash, and `model` or `advisorModel` together with `attachRemoteSession` is now a 400 instead of being ignored; non-Claude sessions no longer report or persist Claude's default model. Split view: a refresh queued behind a history pull no longer leaves a second, stale "disconnected" marker above its replay. iOS IME: a composition on an empty prompt now follows the prompt when output or a resize moves it, and the `xterm-zerolag-input` README documents `setComposition()`. The Shift+Enter and Key tester browser tests now drive the shipped handlers instead of copies.

## 0.3.1

### Patch Changes

- Mobile catches up: links open from a tap, terminal text can be selected and copied, long prompts stay visible while you type. Plus Files panel search, a bundled Nerd Font symbols fallback, and a per-device terminal font setting.
  - **Terminal and chat links work on phones** (#321): tapping a URL or file path in terminal output now opens it (new tab, file preview, or log viewer), resolved through the same provider desktop hover uses, so tap and click can never disagree about what is a link. Dialog rows and the composer keep their existing meaning. Response-viewer links open in a new tab with `rel="noopener noreferrer"` instead of navigating the dashboard away. Wrapped links open whole: the logical-line reconstruction now stitches hard wraps through the indent their continuation carries, which also fixes desktop hover-click truncating wrapped URLs.
  - **Terminal text can be copied on touch devices** (#321): long-press selects the token under the finger, drag or tap the other end to extend, and a small bar offers Copy, Line (the whole logical line, wraps included) and dismiss. Copy works on plain-HTTP installs too. Three guards keep the keyboard down and the selection alive through the browser's own long-press handling.
  - **A long prompt stays visible on phones** (#321): the local-echo overlay grows upward once it would run past the last visible row (a prompt taller than the screen keeps its tail, where the cursor is), and the keyboard-driven padding shrink can no longer reclaim the space the fixed toolbar and accessory bar stand in.
  - **Files panel search** (#324): `GET /api/sessions/:id/files?q=...` answers a flat match list (name or path substring, `*`/`?` globs), recursing past non-matching directories with its own match cap on top of the existing bounds; without `q` the response is byte-identical to before. Glob queries are matched without regex so a pathological pattern cannot stall the server.
  - **Nerd Font prompt glyphs out of the box, custom terminal font** (#320): a bundled icons-only Symbols Nerd Font Mono fallback renders powerlevel10k/starship/oh-my-posh glyphs on every device with no font install, and App Settings gains a per-device terminal font family that is prepended to the built-in stack.

  ### Thanks

  Three contributor PRs in one release: thanks to @rounakdatta (#321), @aakhter (#324) and @comzine (#320).

## 0.3.0

### Minor Changes

- 55bff4a: Zero-lag predictive echo for Codex sessions (mosh-style write-through prediction).

  Codex's per-keystroke composer forced 1.12.2 to disable the local-echo overlay (issues #218/#219/#220/#222), leaving Codex typing at full round-trip latency on remote links. This release adds a second echo mode instead of re-enabling the first: every keystroke still goes to the PTY exactly as before (byte-identical wire behavior, pinned by vm-level and end-to-end trace-equality tests), while the new `PredictiveEchoAddon` in `xterm-zerolag-input` 0.2.0 paints the predicted glyph at the predicted cell. When the real echo lands, the prediction is confirmed and its span removed (an invisible swap); mispredictions self-heal via a two-pass mismatch cascade and a TTL.
  - Reconciliation reads the parsed terminal buffer, never the raw stream: full-line redraws, ECH gap painting and tmux's in-place deltas all converge to the same cells. Confirmation requires the cell match PLUS a cursor advance, so placeholder glyphs and identical repaints never false-confirm; blank cells are neutral (codex clears its placeholder on the first echo).
  - Predictions paint only while the cursor sits on the measured Codex composer row (`/^› /`, codex-cli 0.147): trust/approval modals and wrapped continuation rows get no ghosts, deliberately falling back to real echo.
  - Ships as a SEPARATE `vendor/xterm-predictive-echo.js` bundle: the existing zerolag bundle is byte-identical (sha256-verified), and a missing or broken bundle degrades Codex to exact 1.12.2 behavior. The per-device `localEchoEnabled` toggle is the kill switch.
  - Claude/Gemini/OpenCode/Antigravity keep buffer mode untouched; shell stays off.
  - A post-build adversarial review added the anchor-hold rule: after an unpredicted wire edit (backspace into echoed text, cleared input, IME text commits) new predictions hold until the next parsed write, so a stale displayed cursor can never mis-anchor a run.
  - Tests: 55 new package tests including replay suites driven by fixtures recorded from a real codex TUI through the production tmux+strip pipeline (`scripts/dev/record-codex-frames.mjs`) and a 500-iteration seeded fuzz; new vm policy/wire-neutrality suites; a 10-scenario Playwright E2E against real codex covering the #218/#219/#220/#222 retests, byte-identity, and a simulated 300ms-RTT run. The package test suite now runs in CI.

## 0.2.0

### Minor Changes

- **New addon: `PredictiveEchoAddon`, mosh-style write-through prediction.** The second echo mode for per-keystroke TUIs (OpenAI Codex's composer, live pickers) that buffer-until-Enter starves. Every keystroke is sent by the consumer immediately and unchanged; the addon paints the predicted glyph at the predicted cell and reconciles against the PARSED terminal buffer: confirmation requires the cell match plus a cursor advance past the record, foreign non-blank content on two consecutive passes cascades a drop, blank cells are neutral, a TTL bounds everything, and scroll/resize/sustained cursor moves clear the run. Visual-only by construction; it cannot gate, delay or rewrite input.
  - Anchor-hold rule: after an unpredicted wire edit (backspace into echoed text, cleared input, an IME text commit) new predictions hold until the next parsed write, so a stale displayed cursor can never mis-anchor a run (worst case: exactly one unpredicted keystroke).
  - New exports: `PredictiveEchoAddon`, `PredictiveEchoOptions`, `PredictionState`, plus the long-intended `charCellWidth` / `stringCellWidth` helpers.
  - `XtermTerminal` type gains OPTIONAL members (`buffer.active.cursorX/cursorY`, `getLine().getCell?`, `onWriteParsed?`, `onResize?`). Additive only: existing consumers and mocks are unaffected.
  - IIFE build exposes `window.PredictiveEchoAddon` and a self-activating `window.PredictiveEchoOverlay`, alongside the unchanged `ZerolagInputAddon` / `LocalEchoOverlay` globals.
  - Tests: 52 new (30 addon-law specs, renderer geometry, 6 replay suites driven by fixtures recorded from real codex 0.147 through tmux + the production strip, and a 500-iteration seeded fuzz with per-op invariants). `@xterm/headless` as a devDependency; runtime dependencies remain zero.

## 0.1.8

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

## 0.1.7

### Patch Changes

- Fix a latent bug where a partial settings PUT silently reset live service state, and trim the `xterm-zerolag-input` README callout.
  - **`PUT /api/settings` no longer resets watchers on a partial body.** The three `toggleService` calls (subagent watcher, workflow-run watcher, image watcher) read the raw request body with `??` defaults, so every key a caller omitted was treated as "apply the default". A body of just `{statusLineTelemetry:true}` would START the subagent watcher and STOP the workflow and image watchers, undoing the persisted config. They now resolve from `merged` (persisted settings + incoming), the same convention the `tmuxHistoryLimit` branch in that handler already used, so any PUT reconciles services to the effective stored state. Nothing triggered this in practice because every shipped client sends a full settings payload rebuilt from the DOM, but it was a trap for the next partial-update caller.
  - **Regression test**: `test/routes/system-routes-settings-partial-put.test.ts` (4 cases) pins both directions, omitted keys preserve state and explicit keys still take effect. Verified to fail against the pre-fix handler.
  - **CLAUDE.md** records the rule under "Adding Features → App setting": anything acting on a setting in that handler must resolve from `merged`, never the request body.
  - **`xterm-zerolag-input` README**: removed the links line (getcodeman.com / install one-liner / star link) from the Codeman callout above the demo GIF. The callout keeps its links in the heading and body.

## 0.1.6

### Patch Changes

- Plan-usage chip now defaults ON on desktop, plus the reworked `xterm-zerolag-input` README.
  - **Plan-usage chip defaults ON (desktop).** The `showPlanUsageLimits` chip (live 5-hour and weekly plan usage from the Claude statusline) used to be opt-in and default OFF, so most users never saw it. Desktop now defaults ON; handhelds still default OFF so the phone header stays minimal and the `mobile-header-buttons-policy` guard keeps passing. Devices with an explicitly stored preference keep whatever they chose, so nobody's OFF gets overridden.
  - **One resolver behind the chip.** Added `planUsageChipEnabled()` in settings-ui.js and routed all three call sites through it: the App Settings checkbox, the chip's visibility, and the create-time `statusLineTelemetry` flag in session-ui.js. Those three had independent `?? false` / `=== true` defaults, and a chip revealed without the telemetry flag renders `—` forever, so a default flip on one site alone would have shipped a permanently empty chip.
  - **Cron button comment corrected.** The App Settings comment claimed "Cron button defaults ON" while the code, the template (`btn-cron--hidden`) and the CSS all default it OFF. Verified against a fresh browser profile: the button is hidden and its checkbox unchecked out of the box. Comment now matches, and states why the two halves stay consistent.
  - **Docs.** CLAUDE.md, `docs/architecture-invariants.md` and `docs/usage-limits-display-plan.md` updated for the new default and the single-resolver rule; the stale `styles.css` comment claiming the server strips the chip's hidden class at render was corrected (display is per-device, so the client reveals it).
  - **`xterm-zerolag-input` README rework** (0.1.5 shipped the content; this republishes with the graphic and promo changes): replaced the misaligned 8-line keystroke-flow diagram with a two-line stock-vs-zerolag contrast, added a Codeman callout above the demo GIF with links to getcodeman.com and the repo, and rewrote the Origin section so it argues the extraction story instead of repeating the promo.

## 0.1.5

### Patch Changes

- Rewrite the `xterm-zerolag-input` package README as a value-first document and correct the drift that had accumulated against the source.
  - Added the side-by-side phone demo GIF (`docs/images/zerolag-demo-20260728.gif`) as the hero image, referenced by absolute raw URL so it renders on npmjs.com as well as GitHub. The two-phone comparison shows 0ms local echo next to a 600ms-2.7s server echo on the same session.
  - New "Why this one" comparison table, an explicit list of target use cases (SSH web clients, cloud IDEs, mobile terminals, container consoles), and a bundle-size badge (6.1 kB gzipped, measured from the ESM build).
  - Corrected the test-count badge from 78 to the actual 175 tests across 5 files, in both the package README and the Published Packages section of the root README.
  - Removed the stale "Unicode/emoji rendered at single-cell width" limitation. CJK, fullwidth forms and emoji have had double-width rendering and visual-column positioning since the wide-character fix; the honest remaining caveat (per-code-point width summing over-counts ZWJ grapheme clusters) replaces it.
  - Documented the previously undocumented public `setPrompt()` method for switching prompt strategies at runtime, and the new "Wide characters (CJK, emoji)" integration section covering the optional `Unicode11Addon` path and the built-in range-table fallback.
  - Documented `backgroundColor: 'transparent'`, corrected the `foregroundColor` default, and updated the grid-alignment math to reflect visual-column positioning rather than character index.

  No source changes, docs only.

## 0.1.4

### Patch Changes

- Initial changelog entry for changesets-based versioning
