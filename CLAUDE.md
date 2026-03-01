# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Quick Reference

| Task | Command |
|------|---------|
| Dev server | `npx tsx src/index.ts web` |
| Type check | `tsc --noEmit` |
| Lint | `npm run lint` (fix: `npm run lint:fix`) |
| Format | `npm run format` (check: `npm run format:check`) |
| Single test | `npx vitest run test/<file>.test.ts` |
| Production | `npm run build && systemctl --user restart codeman-web` |

## CRITICAL: Session Safety

**You may be running inside a Codeman-managed tmux session.** Before killing ANY tmux or Claude process:

1. Check: `echo $CODEMAN_MUX` - if `1`, you're in a managed session
2. **NEVER** run `tmux kill-session`, `pkill tmux`, or `pkill claude` without confirming
3. Use the web UI or `./scripts/tmux-manager.sh` instead of direct kill commands

## CRITICAL: Always Test Before Deploying

**NEVER COM without verifying your changes actually work.** For every fix:

1. **Backend changes**: Hit the API endpoint with `curl` and verify the response
2. **Frontend changes**: Use Playwright to load the page and assert the UI renders correctly. Use `waitUntil: 'domcontentloaded'` (not `networkidle` — SSE keeps the connection open). Wait 3-4s for polling/async data to populate, then check element visibility, text content, and CSS values
3. **Only after verification passes**, proceed with COM

The production server caches static files for 1 year (`maxAge: '1y'` in `server.ts`). After deploying frontend changes, users may need a hard refresh (Ctrl+Shift+R) to see updates.

## COM Shorthand (Deployment)

Uses [Semantic Versioning](https://semver.org/) (`MAJOR.MINOR.PATCH`) via `@changesets/cli`.

When user says "COM":
1. **Determine bump type**: `COM` = patch (default), `COM minor` = minor, `COM major` = major
2. **Create a changeset file** (no interactive prompts). Write a `.md` file in `.changeset/` with a random filename:
   ```bash
   cat > .changeset/$(openssl rand -hex 4).md << 'CHANGESET'
   ---
   "aicodeman": patch
   ---

   Description of changes
   CHANGESET
   ```
   Replace `patch` with `minor` or `major` as needed. Include `"xterm-zerolag-input": patch` on a separate line if that package changed too.
3. **Consume the changeset**: `npm run version-packages` (bumps versions in `package.json` files and updates `CHANGELOG.md`)
4. **Sync CLAUDE.md version**: Update the `**Version**` line below to match the new version from `package.json`
5. **Commit and deploy**: `git add -A && git commit -m "chore: version packages" && git push && npm run build && systemctl --user restart codeman-web`

**Version**: 0.2.9 (must match `package.json`)

## Project Overview

Codeman is a Claude Code session manager with web interface and autonomous Ralph Loop. Spawns Claude CLI via PTY, streams via SSE, supports respawn cycling for 24+ hour autonomous runs.

**Tech Stack**: TypeScript (ES2022/NodeNext, strict mode), Node.js, Fastify, node-pty, xterm.js. Supports both Claude Code and OpenCode AI CLIs via pluggable CLI resolvers.

**TypeScript Strictness** (see `tsconfig.json`): `noUnusedLocals`, `noUnusedParameters`, `noImplicitReturns`, `noImplicitOverride`, `noFallthroughCasesInSwitch`, `allowUnreachableCode: false`, `allowUnusedLabels: false`.

**Requirements**: Node.js 18+, Claude CLI, tmux

## Commands

**Note**: `npm run dev` starts the web server (equivalent to `npx tsx src/index.ts web`).

**Default port**: `3000` (web UI at `http://localhost:3000`)

```bash
# Setup
npm install                        # Install dependencies

# Development
npx tsx src/index.ts web           # Dev server (RECOMMENDED)
npx tsx src/index.ts web --https   # With TLS (only needed for remote access)
npm run typecheck                  # Type check
tsc --noEmit --watch               # Continuous type checking
npm run lint                       # ESLint
npm run lint:fix                   # ESLint with auto-fix
npm run format                     # Prettier format
npm run format:check               # Prettier check only

# Testing (see "Testing" section for CRITICAL safety warnings)
npx vitest run test/<file>.test.ts # Single file (SAFE)
npx vitest run -t "pattern"        # Tests matching name
npm run test:coverage              # With coverage report

# Production
npm run build                      # esbuild via scripts/build.mjs (not tsc)
npm run start                      # node dist/index.js (production)
systemctl --user restart codeman-web
journalctl --user -u codeman-web -f
```

**CI**: `.github/workflows/ci.yml` runs `typecheck`, `lint`, and `format:check` on push to master. Tests are intentionally excluded from CI (they spawn tmux).

## Common Gotchas

- **Single-line prompts only** — `writeViaMux()` sends text and Enter separately; multi-line breaks Ink
- **Don't kill tmux sessions blindly** — Check `$CODEMAN_MUX` first; you might be inside one
- **Global regex `lastIndex` sharing** — `ANSI_ESCAPE_PATTERN_FULL/SIMPLE` have `g` flag; use `createAnsiPatternFull/Simple()` factory functions for fresh instances in loops
- **DEC 2026 sync blocks** — Never discard incomplete sync blocks (START without END); buffer up to 50ms then flush. See `app.js:extractSyncSegments()`
- **Terminal writes during buffer load** — Live SSE writes are queued while `_isLoadingBuffer` is true to prevent interleaving with historical data
- **Local echo prompt scanning** — Does NOT use `buffer.cursorY` (Ink moves it); scans buffer bottom-up for visible `>` prompt marker

## Import Conventions

- **Utilities**: Import from `./utils` (re-exports all): `import { LRUMap, stripAnsi } from './utils'`
- **Types**: Use type imports from barrel: `import type { SessionState } from './types'` (re-exports from `src/types/` domain files)
- **Config**: Import from specific files: `import { MAX_TERMINAL_BUFFER_SIZE } from './config/buffer-limits'`

## Architecture

### Core Files

| File | Purpose |
|------|---------|
| `src/index.ts` | CLI entry point: global error recovery, uncaught exception guard, `MAX_CONSECUTIVE_ERRORS` auto-restart |
| `src/session.ts` | PTY wrapper: `runPrompt()`, `startInteractive()`, `startShell()` |
| `src/mux-interface.ts` | `TerminalMultiplexer` interface + `MuxSession` type |
| `src/mux-factory.ts` | Create tmux multiplexer instance |
| `src/tmux-manager.ts` | tmux session management |
| `src/session-manager.ts` | Session lifecycle, cleanup |
| `src/session-auto-ops.ts` | Automatic session operations (auto-compact, etc.) |
| `src/session-cli-builder.ts` | CLI argument construction for session spawning |
| `src/session-task-cache.ts` | Task description caching for subagent correlation |
| `src/state-store.ts` | State persistence to `~/.codeman/state.json` |
| `src/respawn-controller.ts` | State machine for autonomous cycling |
| `src/respawn-adaptive-timing.ts` | Adaptive idle timing calculation |
| `src/respawn-health.ts` | Health scoring (0-100) for respawn loops |
| `src/respawn-metrics.ts` | Per-cycle outcome metrics tracking |
| `src/respawn-patterns.ts` | Pattern matching for stuck/error states |
| `src/ralph-tracker.ts` | Detects `<promise>PHRASE</promise>`, todos |
| `src/ralph-loop.ts` | Autonomous task execution loop (polls queue, assigns tasks) |
| `src/ralph-config.ts` | Parses `.claude/ralph-loop.local.md` plugin config |
| `src/ralph-fix-plan-watcher.ts` | Watches `@fix_plan.md` for changes |
| `src/ralph-plan-tracker.ts` | Plan iteration tracking |
| `src/ralph-stall-detector.ts` | Detects stuck Ralph loops |
| `src/ralph-status-parser.ts` | Parses Ralph status messages |
| `src/task.ts` | Task model for prompt execution |
| `src/task-queue.ts` | Priority queue for tasks with dependencies |
| `src/task-tracker.ts` | Background task tracker for subagent detection |
| `src/subagent-watcher.ts` | Monitors Claude Code's Task tool (background agents) |
| `src/team-watcher.ts` | Polls `~/.claude/teams/` for agent team activity; matches teams to sessions via `leadSessionId` |
| `src/run-summary.ts` | Timeline events for "what happened while away" |
| `src/ai-checker-base.ts` | Base class for AI-powered checkers (shared by idle + plan checkers) |
| `src/ai-idle-checker.ts` | AI-powered idle detection |
| `src/ai-plan-checker.ts` | AI-powered plan completion checker |
| `src/bash-tool-parser.ts` | Parses Claude's bash tool invocations from output |
| `src/transcript-watcher.ts` | Watches Claude's transcript files for changes |
| `src/hooks-config.ts` | Manages `.claude/settings.local.json` hook configuration |
| `src/push-store.ts` | VAPID key auto-gen + push subscription CRUD for Web Push |
| `src/session-lifecycle-log.ts` | Append-only JSONL audit log at `~/.codeman/session-lifecycle.jsonl` |
| `src/image-watcher.ts` | Watches for image file creation (screenshots, etc.) |
| `src/file-stream-manager.ts` | Manages `tail -f` processes for live log viewing |
| `src/plan-orchestrator.ts` | 2-agent plan generation: optional research agent → planner agent |
| `src/prompts/index.ts` | Barrel export for all agent prompts |
| `src/prompts/*.ts` | Agent prompts (research-agent, planner) |
| `src/templates/claude-md.ts` | CLAUDE.md generation for new cases |
| `src/tunnel-manager.ts` | Manages cloudflared child process for Cloudflare tunnel + QR auth token rotation |
| `src/cli.ts` | Command-line interface handlers |
| `src/web/server.ts` | Fastify server setup, SSE at `/api/events`, delegates to route modules |
| `src/web/routes/*.ts` | 12 domain route modules (session, respawn, ralph, plan, etc.) — each exports `register*Routes()` |
| `src/web/ports/*.ts` | Port interfaces (SessionPort, EventPort, etc.) — route modules declare dependencies via intersection types |
| `src/web/middleware/auth.ts` | Auth middleware: Basic Auth, session cookies, rate limiting, security headers, CORS |
| `src/web/route-helpers.ts` | Shared helper utilities for route modules |
| `src/web/schemas.ts` | Zod v4 validation schemas with path/env security allowlists |
| `src/web/public/app.js` | Frontend: xterm.js, tab management, subagent windows, mobile support (~12K lines) |
| `src/types.ts` | Barrel re-export from `src/types/` — 13 domain files (session, task, respawn, ralph, api, etc.) |

**Large files** (>50KB): `app.js`, `ralph-tracker.ts`, `respawn-controller.ts`, `session.ts`, `subagent-watcher.ts` — these contain complex state machines; read `docs/respawn-state-machine.md` before modifying.

### Local Packages

| Package | Purpose |
|---------|---------|
| `packages/xterm-zerolag-input/` | Instant keystroke feedback overlay for xterm.js — eliminates perceived input latency over high-RTT connections. Source of truth for `LocalEchoOverlay`; a copy is embedded in `app.js`. Build: `npm run build` (tsup). |

### Config Files (`src/config/`)

| File | Purpose |
|------|---------|
| `buffer-limits.ts` | Terminal/text buffer size limits |
| `map-limits.ts` | Global limits for Maps, sessions, watchers |
| `exec-timeout.ts` | Execution timeout configuration |
| `server-timing.ts` | Web server batching, SSE, scheduled run timing |
| `auth-config.ts` | Auth session TTL, rate limits, hook timeout |
| `tunnel-config.ts` | QR token rotation, tunnel process lifecycle |
| `terminal-limits.ts` | Terminal dimension and input validation limits |
| `ai-defaults.ts` | AI checker model and context limits |
| `team-config.ts` | Agent Teams polling and cache sizes |

### Utilities (`src/utils/`)

Re-exported via `src/utils/index.ts`. Key exports:

| File | Exports |
|------|---------|
| `cleanup-manager.ts` | `CleanupManager` — centralized disposal for timers, intervals, watchers, listeners, streams |
| `lru-map.ts` | `LRUMap` — bounded cache with eviction |
| `stale-expiration-map.ts` | `StaleExpirationMap` — TTL-based map with automatic cleanup |
| `regex-patterns.ts` | `ANSI_ESCAPE_PATTERN_FULL/SIMPLE`, `createAnsiPatternFull/Simple()`, `stripAnsi`, `TOKEN_PATTERN`, `SPINNER_PATTERN` |
| `buffer-accumulator.ts` | `BufferAccumulator` — batches rapid writes into single flushes |
| `claude-cli-resolver.ts` | `findClaudeDir`, `getAugmentedPath` — resolves Claude CLI paths |
| `opencode-cli-resolver.ts` | `resolveOpenCodeDir`, `isOpenCodeAvailable` — OpenCode CLI support |
| `string-similarity.ts` | `stringSimilarity`, `fuzzyPhraseMatch`, `todoContentHash` |
| `token-validation.ts` | `validateTokenCounts`, `validateTokensAndCost` |
| `nice-wrapper.ts` | `wrapWithNice` — wraps commands with `nice`/`ionice` for lower priority |
| `type-safety.ts` | `assertNever` — exhaustive switch/case guard |
| `debouncer.ts` | `Debouncer` — reusable debounce utility |

### Data Flow

1. Session spawns `claude --dangerously-skip-permissions` via node-pty
2. PTY output buffered, ANSI stripped, parsed for JSON messages
3. WebServer broadcasts to SSE clients at `/api/events`
4. State persists to `~/.codeman/state.json` via StateStore

### Key Patterns

**Input to sessions**: Use `session.writeViaMux()` for programmatic input (respawn, auto-compact). Uses tmux `send-keys -l` (literal text) + `send-keys Enter`. All prompts must be single-line.

**Terminal multiplexer**: `TerminalMultiplexer` interface (`src/mux-interface.ts`) abstracts the backend. `createMultiplexer()` from `src/mux-factory.ts` creates the tmux backend.

**Idle detection**: Multi-layer (completion message → AI check → output silence → token stability). See `docs/respawn-state-machine.md`.

**Token tracking**: Interactive mode parses status line ("123.4k tokens"), estimates 60/40 input/output split.

**Hook events**: Claude Code hooks trigger notifications via `/api/hook-event`. Key events: `permission_prompt` (tool approval needed), `elicitation_dialog` (Claude asking question), `idle_prompt` (waiting for input), `stop` (response complete), `teammate_idle` (Agent Teams), `task_completed` (Agent Teams). See `src/hooks-config.ts`.

**Web Push**: Layer 5 of the notification system. Service worker (`sw.js`) receives push events and shows OS-level notifications even when the browser tab is closed. VAPID keys auto-generated on first use and persisted to `~/.codeman/push-keys.json`. Per-subscription per-event preferences stored in `~/.codeman/push-subscriptions.json`. Expired subscriptions (410/404) auto-cleaned. Requires HTTPS or localhost. iOS requires PWA installed to home screen. See `src/push-store.ts`.

**Agent Teams (experimental)**: `TeamWatcher` polls `~/.claude/teams/` for team configs and matches teams to sessions via `leadSessionId`. Teammates are in-process threads (not separate OS processes) and appear as standard subagents. RespawnController checks `TeamWatcher.hasActiveTeammates()` before triggering respawn. Enable via `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` env var in `settings.local.json`. See `agent-teams/` for full docs.

**Circuit breaker**: Prevents respawn thrashing when Claude is stuck. States: `CLOSED` (normal) → `HALF_OPEN` (testing) → `OPEN` (blocked). Tracks consecutive no-progress, same-error-repeated, and tests-failing-too-long. Reset via API at `/api/sessions/:id/ralph-circuit-breaker/reset`.

**Respawn cycle metrics & health scoring**: `RespawnCycleMetrics` tracks per-cycle outcomes (success, stuck_recovery, blocked, error). `RalphLoopHealthScore` computes 0-100 health with component scores (cycleSuccess, circuitBreaker, iterationProgress, aiChecker, stuckRecovery). Available via respawn status API.

**Subagent-session correlation**: Session parses Task tool output via `BashToolParser` → `SubagentWatcher` discovers new agent → calls `session.findTaskDescriptionNear()` to match description for window title.

**Port interfaces**: Route modules declare their dependencies via port interfaces (`src/web/ports/`). `WebServer` implements all ports; routes use TypeScript intersection types (e.g., `SessionPort & EventPort`) to specify only what they need. This enables loose coupling between routes and the server.

### Frontend Files

| File | Purpose |
|------|---------|
| `src/web/public/index.html` | HTML entry point with inline critical CSS and async vendor loading |
| `src/web/public/constants.js` | Shared constants, timing values, Z-index layers, Web Push utilities |
| `src/web/public/api-client.js` | API fetch wrapper (`_api`, `_apiJson`, `_apiPost`, `_apiPut`) |
| `src/web/public/mobile-handlers.js` | `MobileDetection`, `KeyboardHandler`, `SwipeHandler` objects |
| `src/web/public/voice-input.js` | `DeepgramProvider`, `VoiceInput` objects for speech-to-text |
| `src/web/public/notification-manager.js` | `NotificationManager` class (5-layer notification system) |
| `src/web/public/keyboard-accessory.js` | `KeyboardAccessoryBar` and `FocusTrap` classes |
| `src/web/public/subagent-windows.js` | Subagent window management (open, close, drag, connection lines) |
| `src/web/public/app.js` | Core UI: xterm.js, tab management, settings |
| `src/web/public/ralph-wizard.js` | Ralph Loop wizard UI |
| `src/web/public/styles.css` | Main styling (dark theme, layout, components) |
| `src/web/public/mobile.css` | Responsive overrides for screens <1024px (loaded conditionally via `media` attribute) |
| `src/web/public/upload.html` | Screenshot upload page served at `/upload.html` |
| `src/web/public/sw.js` | Service worker for Web Push notifications |
| `src/web/public/manifest.json` | Minimal PWA manifest (required for push on Android) |
| `src/web/public/vendor/` | Self-hosted xterm.js + addons (eliminates CDN latency) |

**Script loading order** (index.html): `constants.js` → `mobile-handlers.js` → `voice-input.js` → `notification-manager.js` → `keyboard-accessory.js` → `app.js` → `ralph-wizard.js` → `api-client.js` → `subagent-windows.js`. All modules share global scope — order matters for dependencies.

### Frontend Architecture

The frontend is split across multiple vanilla JS modules (extracted from the original monolithic `app.js`). Key systems:

| System | Module | Key Classes/Functions | Purpose |
|--------|--------|----------------------|---------|
| **Terminal rendering** | `app.js` | `batchTerminalWrite()`, `flushPendingWrites()`, `chunkedTerminalWrite()` | 60fps batched writes with DEC 2026 sync |
| **Local echo overlay** | `app.js` | `LocalEchoOverlay` class | DOM overlay for instant mobile keystroke feedback |
| **Mobile support** | `mobile-handlers.js` | `MobileDetection`, `KeyboardHandler`, `SwipeHandler` | Touch input, viewport adaptation, swipe navigation |
| **Keyboard accessory** | `keyboard-accessory.js` | `KeyboardAccessoryBar`, `FocusTrap` | Mobile keyboard toolbar, modal focus management |
| **Subagent windows** | `subagent-windows.js` | `openSubagentWindow()`, `closeSubagentWindow()`, `updateConnectionLines()` | Floating terminal windows with parent connection lines |
| **Notifications** | `notification-manager.js` | `NotificationManager` class | 5-layer: in-app drawer, tab flash, browser API, web push, audio beep |
| **Voice input** | `voice-input.js` | `DeepgramProvider`, `VoiceInput` | Speech-to-text via Deepgram WebSocket |
| **SSE connection** | `app.js` | `connectSSE()`, `addListener()` | EventSource with exponential backoff (1-30s), offline queue (64KB) |
| **Settings** | `app.js` | `openAppSettings()`, `apply*Visibility()` | Server-backed + localStorage persistence |

**Z-index layers**: subagent windows (1000), plan agents (1100), log viewers (2000), image popups (3000), local echo overlay (7).

**Built-in respawn presets**: `solo-work` (3s idle, 60min), `subagent-workflow` (45s idle, 240min), `team-lead` (90s idle, 480min), `ralph-todo` (8s idle, 480min, works through @fix_plan.md tasks), `overnight-autonomous` (10s idle, 480min, full reset).

**Keyboard shortcuts**: Escape (close panels), Ctrl+? (help), Ctrl+Enter (quick start), Ctrl+W (kill session), Ctrl+Tab (next session), Ctrl+K (kill all), Ctrl+L (clear), Ctrl+Shift+R (restore size), Ctrl/Cmd +/- (font size).

### Security

- **HTTP Basic Auth**: Optional via `CODEMAN_USERNAME`/`CODEMAN_PASSWORD` env vars
- **QR Auth**: Single-use ephemeral 6-char tokens (60s TTL, 90s grace) for tunnel login without typing passwords. `TunnelManager` rotates tokens, serves cached SVG at `GET /api/tunnel/qr`, validates at `GET /q/:code`. Separate per-IP rate limit (10/15min) + global path limit (30/min). Desktop notification on consumption (QRLjacking detection). Audit logged as `qr_auth` in `session-lifecycle.jsonl`. See `docs/qr-auth-plan.md`.
- **Session cookies**: After Basic Auth or QR Auth, a 24h session cookie (`codeman_session`) is issued so credentials aren't re-sent on every request. Active sessions auto-extend. SSE works via same-origin cookie (`EventSource` can't send custom headers). Sessions store device context (IP + User-Agent) for audit via `AuthSessionRecord`.
- **Session revocation**: `POST /api/auth/revoke` revokes individual sessions or all sessions.
- **Rate limiting**: 10 failed auth attempts per IP triggers 429 rejection (15-minute decay window). Manual `StaleExpirationMap` counter — no `@fastify/rate-limit` needed. QR auth has its own separate rate limiter.
- **Hook bypass**: `/api/hook-event` POST is exempt from auth — Claude Code hooks curl this from localhost and can't present credentials. Safe: validated by `HookEventSchema`, only triggers broadcasts.
- **CORS**: Restricted to localhost only
- **Security headers**: X-Content-Type-Options, X-Frame-Options, CSP; HSTS if HTTPS
- **Path validation** (`schemas.ts`): Strict allowlist regex, no shell metacharacters, no traversal, must be absolute
- **Env var allowlist**: Only `CLAUDE_CODE_*` prefixes allowed; blocks `PATH`, `LD_PRELOAD`, `NODE_OPTIONS`, `CODEMAN_*` keys
- **File streaming TOCTOU protection**: `FileStreamManager` calls `realpathSync()` twice (at validation and before spawn) to catch symlink swaps

### SSE Event Categories

~100 event types broadcast via `broadcast()`. Key categories:

| Category | Events | Purpose |
|----------|--------|---------|
| Session | `session:created/updated/deleted/working/idle/exit/error/completion` | Lifecycle |
| Terminal | `session:terminal`, `session:clearTerminal`, `session:needsRefresh` | Output streaming |
| Respawn | `respawn:stateChanged/cycleStarted/blocked/aiCheck*/planCheck*/timer*` | Respawn state machine |
| Subagent | `subagent:discovered/updated/completed/tool_call/progress` | Background agents |
| Ralph | `session:ralphLoopUpdate/ralphTodoUpdate/ralphCompletionDetected` | Ralph tracking |
| Hooks | `hook:{eventName}` (dynamic) | Claude Code hook events |
| Plan | `plan:started/progress/completed/cancelled/subagent` | Plan orchestration |
| Mux | `mux:created/killed/died/statsUpdated` | tmux process monitor |
| Tunnel | `tunnel:qrRotated/qrRegenerated/qrAuthUsed` | QR token lifecycle |
| Image | `image:detected` | Screenshot detection |

### API Route Categories

~113 route handlers split across `src/web/routes/` domain modules. Key groups:

| Group | Prefix | Count | Key endpoints |
|-------|--------|-------|---------------|
| Sessions | `/api/sessions` | 43 | CRUD, input, resize, interactive, shell |
| System | `/api/status`, `/api/stats`, `/api/config`, `/api/settings`, `/api/subagents` | 38 | App state, config, subagents |
| Ralph | `/api/sessions/:id/ralph-*` | 19 | state, status, config, circuit-breaker |
| Respawn | `/api/sessions/:id/respawn` | 17 | start, stop, enable, config |
| Plan | `/api/sessions/:id/plan/*` | 12 | task CRUD, checkpoint, history, rollback |
| Cases | `/api/cases` | 7 | CRUD, link, fix-plan |
| Scheduled | `/api/scheduled` | 6 | CRUD for scheduled runs |
| Files | `/api/sessions/:id/file*`, `tail-file` | 5 | Browser, preview, raw, tail stream |
| Mux | `/api/mux-sessions` | 5 | tmux management, stats |
| Push | `/api/push` | 4 | VAPID key, subscribe, update prefs, unsubscribe |
| Hooks | `/api/hook-event` | 4 | Hook event ingestion |
| Teams | `/api/teams` | 2 | list teams, get team tasks |

## Adding Features

- **API endpoint**: Types in `src/types/` (domain file), route in the appropriate `src/web/routes/*-routes.ts` module, use `createErrorResponse()`. Validate request bodies with Zod schemas in `schemas.ts`.
- **SSE event**: Emit via `broadcast()`, handle in `app.js` SSE listener section (search `addListener(`)
- **Session setting**: Add to `SessionState` in `types.ts`, include in `session.toState()`, call `persistSessionState()`
- **Hook event**: Add to `HookEventType` in `types.ts`, add hook command in `hooks-config.ts:generateHooksConfig()`, update `HookEventSchema` in `schemas.ts`
- **Mobile feature**: Add to relevant mobile singleton (`KeyboardHandler`, `KeyboardAccessoryBar`, etc.), test with `MobileDetection.isMobile()` guard
- **New test**: Pick unique port (search `const PORT =`), add port comment to test file header. Tests use ports 3150+.

**Validation**: Uses Zod v4 for request validation. Define schemas in `schemas.ts` and use `.parse()` or `.safeParse()`. Note: Zod v4 has different API from v3 (e.g., `z.object()` options changed, error formatting differs).

## State Files

| File | Purpose |
|------|---------|
| `~/.codeman/state.json` | Sessions, settings, tokens, respawn config |
| `~/.codeman/mux-sessions.json` | Tmux session metadata for recovery |
| `~/.codeman/settings.json` | User preferences |
| `~/.codeman/push-keys.json` | VAPID key pair for Web Push (auto-generated) |
| `~/.codeman/push-subscriptions.json` | Registered push notification subscriptions |

## Default Settings

UI defaults are set in `src/web/public/app.js` using `??` fallbacks. To change defaults, edit `openAppSettings()` and `apply*Visibility()` functions.

**Key defaults:** Most panels hidden (monitor, subagents shown), notifications enabled (audio disabled), subagent tracking on, Ralph tracking off.

## Testing

**CRITICAL: You are running inside a Codeman-managed tmux session.** Never run `npx vitest run` (full suite) — it spawns/kills tmux sessions and will crash your own session. Instead:

```bash
# Safe: run individual test files
npx vitest run test/<specific-file>.test.ts

# Safe: run tests matching a pattern
npx vitest run -t "pattern"

# DANGEROUS from inside Codeman — will kill your tmux session:
# npx vitest run          ← DON'T DO THIS
```

**Ports**: Unit tests pick unique ports manually. Search `const PORT =` before adding new tests.

**Config**: Vitest with `globals: true`, `fileParallelism: false`. Unit timeout 30s.

**Safety**: `test/setup.ts` snapshots pre-existing tmux sessions at load time and never kills them. Only sessions registered via `registerTestTmuxSession()` get cleaned up.

**Respawn tests**: Use MockSession from `test/respawn-test-utils.ts` to avoid spawning real Claude processes.

**Mobile tests**: Separate Playwright-based suite in `mobile-test/` with 135 device profiles. Run via `npx vitest run --config mobile-test/vitest.config.ts`. See `mobile-test/README.md`.

## Screenshots ("sc")

When the user says "check the sc", "screenshot", or "sc", they mean uploaded screenshots from their mobile device. Screenshots are saved to `~/.codeman/screenshots/` and uploaded via `/upload.html` on the Codeman web UI. To view them, use the Read tool on the image files:

```bash
ls ~/.codeman/screenshots/        # List uploaded screenshots
# Then use Read tool on individual files — Claude Code can view images natively
```

API: `GET /api/screenshots` (list), `GET /api/screenshots/:name` (serve), `POST /api/screenshots` (upload multipart/form-data). Source: `src/web/public/upload.html`.

## Debugging

```bash
tmux list-sessions                  # List tmux sessions
tmux attach-session -t <name>       # Attach (Ctrl+B D to detach)
curl localhost:3000/api/sessions    # Check sessions
curl localhost:3000/api/status | jq # Full app state
cat ~/.codeman/state.json | jq    # View persisted state
curl localhost:3000/api/subagents   # List background agents
curl localhost:3000/api/sessions/:id/run-summary | jq  # Session timeline
```

## Troubleshooting

| Problem | Check | Fix |
|---------|-------|-----|
| Session won't start | `tmux list-sessions` for orphans | Kill orphaned sessions, check Claude CLI installed |
| Port 3000 in use | `lsof -i :3000` | Kill conflicting process or use `--port` flag |
| SSE not connecting | Browser console for errors | Check CORS, ensure server running |
| Respawn not triggering | Session settings → Respawn enabled? | Enable respawn, check idle timeout config |
| Terminal blank on tab switch | Network tab for `/api/sessions/:id/buffer` | Check session exists, restart server |
| Tests failing on session limits | `tmux list-sessions \| wc -l` | Clean up: `tmux list-sessions \| grep test \| awk -F: '{print $1}' \| xargs -I{} tmux kill-session -t {}` |
| State not persisting | `cat ~/.codeman/state.json` | Check file permissions, disk space |

## Performance Constraints

The app must stay fast with 20 sessions and 50 agent windows:
- 60fps terminal (16ms batching + `requestAnimationFrame`)
- Auto-trimming buffers (2MB terminal max)
- Debounced state persistence (500ms)
- SSE adaptive batching: 16ms (normal), 32ms (moderate), 50ms (rapid); immediate flush at 32KB
- SSE backpressure handling: skip writes to backpressured clients, recover via `session:needsRefresh` on drain
- Cached endpoints: `/api/sessions` and `/api/status` use 1s TTL caches to avoid expensive serialization
- Frontend buffer loads: 128KB chunks via `requestAnimationFrame` to prevent UI jank

## Terminal Anti-Flicker System

Claude Code uses Ink (React for terminals), which redraws the screen on every state change. Codeman implements a 6-layer anti-flicker pipeline for smooth 60fps output:

```
PTY Output → Server Batching (16-50ms) → DEC 2026 Wrap → SSE → Client rAF → xterm.js
```

**Key functions:** `server.ts:batchTerminalData()`, `server.ts:flushTerminalBatches()`, `app.js:batchTerminalWrite()`, `app.js:extractSyncSegments()`

**Typical latency:** 16-32ms. Optional per-session flicker filter adds ~50ms for problematic terminals.

See `docs/terminal-anti-flicker.md` for full implementation details (adaptive batching, DEC 2026 markers, edge cases).

## Resource Limits

Limits are centralized in `src/config/` — see `buffer-limits.ts`, `map-limits.ts`, `server-timing.ts`, `auth-config.ts`, `tunnel-config.ts`, `terminal-limits.ts`, `ai-defaults.ts`, `team-config.ts`.

**Buffer limits** (per session):
| Buffer | Max | Trim To |
|--------|-----|---------|
| Terminal | 2MB | 1.5MB |
| Text output | 1MB | 768KB |
| Messages | 1000 | 800 |

**Map limits** (global):
| Resource | Max |
|----------|-----|
| Tracked agents | 500 |
| Concurrent sessions | 50 |
| SSE clients total | 100 |
| File watchers | 500 |

Use `LRUMap` for bounded caches with eviction, `StaleExpirationMap` for TTL-based cleanup.

## Where to Find More Information

| Topic | Location |
|-------|----------|
| **Respawn state machine** | `docs/respawn-state-machine.md` |
| **Ralph Loop guide** | `docs/ralph-wiggum-guide.md` |
| **Claude Code hooks** | `docs/claude-code-hooks-reference.md` |
| **Terminal anti-flicker** | `docs/terminal-anti-flicker.md` |
| **Agent Teams (experimental)** | `agent-teams/README.md`, `agent-teams/design.md` |
| **API routes** | `src/web/routes/` domain modules, or README.md |
| **SSE events** | Search `broadcast(` in `server.ts` and route modules |
| **Session statuses** | `SessionStatus` in `src/types/session.ts` |
| **Error codes** | `createErrorResponse()` in `src/types/api.ts` |
| **Refactoring phases** | `docs/phase1-implementation-plan.md` through `docs/phase5-frontend-modularization-plan.md` |
| **Test utilities** | `test/respawn-test-utils.ts` |
| **Mobile test suite** | `mobile-test/README.md` |
| **OpenCode integration** | `docs/opencode-integration.md` |
| **Local echo overlay** | `docs/local-echo-overlay-plan.md` |
| **Performance investigation** | `docs/performance-investigation-report.md` |
| **First-load optimization** | `docs/first-load-optimization-plan.md`, `docs/perf-audit-first-load.md` |
| **Dead code audit** | `docs/cleanup-findings.md` |
| **TypeScript improvements** | `docs/typescript-improvement-suggestions.md` |
| **Browser testing** | `docs/browser-testing-guide.md` |
| **Mobile testing report** | `docs/mobile-testing-report.md` |
| **Voice input** | `docs/voice-input-plan.md` |
| **Improvement roadmaps** | `docs/respawn-improvement-plan.md`, `docs/ralph-improvement-plan.md`, `docs/plan-improvement-roadmap.md` |
| **Background keystroke forwarding** | `docs/background-keystroke-forwarding-merged-plan.md` |
| **QR auth design** | `docs/qr-auth-plan.md` |
| **Run summary** | `docs/run-summary-plan.md` |

Additional design docs and investigation reports are in the `docs/` directory.

## Scripts

| Script | Purpose |
|--------|---------|
| `scripts/tmux-manager.sh` | Safe tmux session management (use instead of direct kill commands) |
| `scripts/monitor-respawn.sh` | Monitor respawn state machine in real-time |
| `scripts/watch-subagents.ts` | Real-time subagent transcript watcher (list, follow by session/agent ID) |
| `scripts/codeman-web.service` | systemd service file for production deployment |
| `scripts/codeman-tunnel.service` | systemd service file for persistent Cloudflare tunnel |
| `scripts/tunnel.sh` | Start/stop/check Cloudflare quick tunnel (`./scripts/tunnel.sh start\|stop\|url`) |
| `scripts/build.mjs` | esbuild-based production build (called by `npm run build`) |
| `scripts/postinstall.js` | npm postinstall hook for setup |

Additional scripts in `scripts/` for screenshots, demos, Ralph wizards, and browser testing.

## Memory Leak Prevention

Frontend runs long (24+ hour sessions); all Maps/timers must be cleaned up.

### Cleanup Patterns
When adding new event listeners or timers:
1. Store handler references for later removal
2. Add cleanup to appropriate `stop()` or `cleanup*()` method
3. For singleton watchers, store refs in class properties and remove in server `stop()`

**Backend**: Clear Maps in `stop()`, null promise callbacks on error, remove watcher listeners on shutdown. Use `CleanupManager` for centralized disposal — supports timers, intervals, watchers, listeners, streams. Guard async callbacks with `if (this.cleanup.isStopped) return`.

**Frontend**: Store drag/resize handlers on elements, clean up in `close*()` functions. SSE reconnect calls `handleInit()` which resets state. SSE listeners are tracked in an array and removed on reconnect to prevent accumulation.

Run `npx vitest run test/memory-leak-prevention.test.ts` to verify patterns.

## Common Workflows

**Investigating a bug**: Start dev server (`npx tsx src/index.ts web`), reproduce in browser, check terminal output and `~/.codeman/state.json` for clues.

**Adding a new API endpoint**: Define types in the appropriate `src/types/*.ts` domain file, add route in the matching `src/web/routes/*-routes.ts` module, broadcast SSE events if needed, handle in `app.js:handleSSEEvent()`.

**Modifying respawn behavior**: Study `docs/respawn-state-machine.md` first. The state machine is in `respawn-controller.ts`. Use MockSession from `test/respawn-test-utils.ts` for testing.

**Modifying mobile behavior**: Mobile singletons (`MobileDetection`, `KeyboardHandler`, `SwipeHandler`, `KeyboardAccessoryBar`) all have `init()`/`cleanup()` lifecycle. KeyboardHandler uses `visualViewport` API for iOS keyboard detection (100px threshold for address bar drift). All mobile handlers are re-initialized after SSE reconnect to prevent stale closures.

**Adding a file watcher**: Use `ImageWatcher` as a template pattern — chokidar with `awaitWriteFinish`, burst throttling (max 20/10s), debouncing (200ms), and auto-ignore of `node_modules/.git/dist/`.

## Tunnel Setup (Remote Access)

Access Codeman from mobile/remote devices via Cloudflare quick tunnel.

```
Browser → Cloudflare Edge (HTTPS) → cloudflared → localhost:3000
```

**Prerequisites**: `cloudflared` installed (`cloudflared --version`), `CODEMAN_PASSWORD` set in environment.

### Quick Start

```bash
# Via CLI
./scripts/tunnel.sh start      # Start tunnel, prints public URL
./scripts/tunnel.sh url        # Show current URL
./scripts/tunnel.sh stop       # Stop tunnel

# Via web UI: Settings → Tunnel → Toggle On
```

### systemd Service (Persistent)

```bash
# Install and enable
cp scripts/codeman-tunnel.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now codeman-tunnel

# Check logs
journalctl --user -u codeman-tunnel -f
```

### Auth Flow

1. First request → browser shows Basic Auth prompt (username: `admin` or `CODEMAN_USERNAME`), or scan QR code from tunnel settings panel
2. On success → server issues `codeman_session` HttpOnly cookie (24h TTL, auto-extends on activity)
3. Subsequent requests → cookie authenticates silently (no more prompts)
4. SSE works automatically — `EventSource` sends same-origin cookies
5. 10 failed attempts per IP → 429 rate limit (15-minute decay)

### Security Requirements

- **Always set `CODEMAN_PASSWORD`** before exposing via tunnel — without it, anyone with the URL has full access
- Session cookies are `Secure` when using `--https` flag; through Cloudflare tunnel without `--https`, cookies are non-Secure but traffic is still encrypted end-to-end via Cloudflare
- `/api/hook-event` bypasses auth (localhost-only Claude Code hooks need unauthenticated access)
