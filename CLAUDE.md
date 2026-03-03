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

**Version**: 0.3.0 (must match `package.json`)

## Project Overview

Codeman is a Claude Code session manager with web interface and autonomous Ralph Loop. Spawns Claude CLI via PTY, streams via SSE, supports respawn cycling for 24+ hour autonomous runs.

**Tech Stack**: TypeScript (ES2022/NodeNext, strict mode), Node.js, Fastify, node-pty, xterm.js. Supports both Claude Code and OpenCode AI CLIs via pluggable CLI resolvers.

**TypeScript Strictness** (see `tsconfig.json`): `noUnusedLocals`, `noUnusedParameters`, `noImplicitReturns`, `noImplicitOverride`, `noFallthroughCasesInSwitch`, `allowUnreachableCode: false`, `allowUnusedLabels: false`.

**Requirements**: Node.js 18+, Claude CLI, tmux

**Git**: Main branch is `master`. SSH session chooser: `sc` (interactive), `sc 2` (quick attach), `sc -l` (list).

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

**CI**: `.github/workflows/ci.yml` runs `typecheck`, `lint`, and `format:check` on push to master (Node 22). Tests are intentionally excluded from CI (they spawn tmux).

**Code style**: Prettier with `singleQuote: true`, `printWidth: 120`, `trailingComma: "es5"`. ESLint allows `no-console`, warns on `@typescript-eslint/no-explicit-any`. ESLint does not lint `app.js` or `scripts/**/*.mjs`.

## Common Gotchas

- **Single-line prompts only** — `writeViaMux()` sends text and Enter separately; multi-line breaks Ink
- **Don't kill tmux sessions blindly** — Check `$CODEMAN_MUX` first; you might be inside one
- **Global regex `lastIndex` sharing** — `ANSI_ESCAPE_PATTERN_FULL/SIMPLE` have `g` flag; use `createAnsiPatternFull/Simple()` factory functions for fresh instances in loops
- **DEC 2026 sync blocks** — Never discard incomplete sync blocks (START without END); buffer up to 50ms then flush. See `app.js:extractSyncSegments()`
- **Terminal writes during buffer load** — Live SSE writes are queued while `_isLoadingBuffer` is true to prevent interleaving with historical data
- **Local echo prompt scanning** — Does NOT use `buffer.cursorY` (Ink moves it); scans buffer bottom-up for visible `>` prompt marker
- **ESM dynamic imports** — Never use `require()` in this codebase; it breaks in production ESM builds. Use `await import()` for dynamic imports. (`tsx` masks this in dev by shimming CJS/ESM)
- **Package name vs product name** — npm package is `aicodeman`, product is **Codeman**. Release workflow renames `aicodeman@X.Y.Z` tags to `codeman@X.Y.Z`

## Import Conventions

- **Utilities**: Import from `./utils` (re-exports all): `import { LRUMap, stripAnsi } from './utils'`
- **Types**: Use type imports from barrel: `import type { SessionState } from './types'` (re-exports from `src/types/` domain files)
- **Config**: Import from specific files: `import { MAX_TERMINAL_BUFFER_SIZE } from './config/buffer-limits'`

## Architecture

### Core Files (by domain)

| Domain | Key files | Notes |
|--------|-----------|-------|
| **Entry** | `src/index.ts`, `src/cli.ts` | CLI entry point, global error recovery |
| **Session** | `src/session.ts` ★, `src/session-manager.ts`, `src/session-auto-ops.ts`, `src/session-cli-builder.ts` | PTY wrapper, lifecycle, auto-compact |
| **Mux** | `src/mux-interface.ts`, `src/mux-factory.ts`, `src/tmux-manager.ts` | tmux abstraction layer |
| **Respawn** | `src/respawn-controller.ts` ★ + 4 helpers (`-adaptive-timing`, `-health`, `-metrics`, `-patterns`) | Autonomous cycling state machine |
| **Ralph** | `src/ralph-tracker.ts` ★, `src/ralph-loop.ts` + 5 helpers (`-config`, `-fix-plan-watcher`, `-plan-tracker`, `-stall-detector`, `-status-parser`) | Completion tracking, autonomous task loop |
| **Agents** | `src/subagent-watcher.ts` ★, `src/team-watcher.ts`, `src/bash-tool-parser.ts`, `src/transcript-watcher.ts` | Background agent monitoring |
| **AI** | `src/ai-checker-base.ts`, `src/ai-idle-checker.ts`, `src/ai-plan-checker.ts` | AI-powered idle/plan detection |
| **Tasks** | `src/task.ts`, `src/task-queue.ts`, `src/task-tracker.ts` | Task model, priority queue |
| **State** | `src/state-store.ts`, `src/run-summary.ts`, `src/session-lifecycle-log.ts` | Persistence, timeline, audit log |
| **Infra** | `src/hooks-config.ts`, `src/push-store.ts`, `src/tunnel-manager.ts`, `src/image-watcher.ts`, `src/file-stream-manager.ts` | Hooks, push, tunnel, file watching |
| **Plan** | `src/plan-orchestrator.ts`, `src/prompts/*.ts`, `src/templates/claude-md.ts` | 2-agent plan generation |
| **Web** | `src/web/server.ts`, `src/web/sse-events.ts`, `src/web/routes/*.ts` (13 modules), `src/web/ports/*.ts`, `src/web/middleware/auth.ts`, `src/web/schemas.ts` | Fastify server, SSE event registry, REST API |
| **Frontend** | `src/web/public/app.js` ★ (~11.5K lines) + 8 JS modules | xterm.js UI, tabs, settings |
| **Types** | `src/types/index.ts` → 13 domain files | Barrel re-export, see `@fileoverview` in index.ts |

★ = Large file (>50KB), contains complex state machines. Read `docs/respawn-state-machine.md` before modifying respawn/ralph.

### Local Packages

| Package | Purpose |
|---------|---------|
| `packages/xterm-zerolag-input/` | Instant keystroke feedback overlay for xterm.js — eliminates perceived input latency over high-RTT connections. Source of truth for `LocalEchoOverlay`; a copy is embedded in `app.js`. Build: `npm run build` (tsup). |

**Config**: `src/config/` — 9 files for buffer limits, map limits, timeouts, SSE timing, auth, tunnel, terminal, AI, and teams. Import from specific files.

**Utilities**: `src/utils/` — re-exported via `src/utils/index.ts`. Key: `CleanupManager`, `LRUMap`, `StaleExpirationMap`, `BufferAccumulator`, `stripAnsi`, `createAnsiPatternFull/Simple()`, `assertNever`, `Debouncer`.

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

**Frontend files** are in `src/web/public/`. Each JS module has a `@fileoverview` JSDoc with `@dependency` and `@loadorder` tags. **Script loading order** (global scope, order matters): `constants.js`(1) → `mobile-handlers.js`(2) → `voice-input.js`(3) → `notification-manager.js`(4) → `keyboard-accessory.js`(5) → `app.js`(6) → `ralph-wizard.js`(7) → `api-client.js`(8) → `subagent-windows.js`(9).

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

- **Environment variables**: `CODEMAN_USERNAME`/`CODEMAN_PASSWORD` (auth), `CODEMAN_MUX` (set if inside managed session), `CODEMAN_API_URL` (auto-set by server at startup, injected into spawned sessions for hook callbacks), `CODEMAN_MUX_NAME` (set by tmux-manager for session identification)
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

### SSE Event Registry

~100 event types defined in `src/web/sse-events.ts` (backend) and `SSE_EVENTS` in `constants.js` (frontend). Both must be kept in sync. Categories: Session lifecycle, Terminal output, Respawn state machine, Subagent monitoring, Ralph tracking, Hook events, Plan orchestration, Mux management, Tunnel/QR, Image detection.

### API Route Categories

~111 route handlers split across `src/web/routes/` domain modules. Key groups:

| Group | Prefix | Count | Key endpoints |
|-------|--------|-------|---------------|
| System | `/api/status`, `/api/stats`, `/api/config`, `/api/settings`, `/api/subagents` | 35 | App state, config, subagents |
| Sessions | `/api/sessions` | 24 | CRUD, input, resize, interactive, shell |
| Ralph | `/api/sessions/:id/ralph-*` | 9 | state, status, config, circuit-breaker |
| Plan | `/api/sessions/:id/plan/*` | 8 | task CRUD, checkpoint, history, rollback |
| Respawn | `/api/sessions/:id/respawn` | 7 | start, stop, enable, config |
| Cases | `/api/cases` | 7 | CRUD, link, fix-plan |
| Files | `/api/sessions/:id/file*`, `tail-file` | 5 | Browser, preview, raw, tail stream |
| Mux | `/api/mux-sessions` | 5 | tmux management, stats |
| Scheduled | `/api/scheduled` | 4 | CRUD for scheduled runs |
| Push | `/api/push` | 4 | VAPID key, subscribe, update prefs, unsubscribe |
| Teams | `/api/teams` | 2 | list teams, get team tasks |
| Hooks | `/api/hook-event` | 1 | Hook event ingestion |

## Adding Features

- **API endpoint**: Types in `src/types/` (domain file), route in the appropriate `src/web/routes/*-routes.ts` module, use `createErrorResponse()`. Validate request bodies with Zod schemas in `schemas.ts`.
- **SSE event**: Add constant to `src/web/sse-events.ts`, add to `SSE_EVENTS` in `constants.js`, emit via `broadcast()`, handle in `app.js` (search `addListener(`)
- **Session setting**: Add to `SessionState` in `types.ts`, include in `session.toState()`, call `persistSessionState()`
- **Hook event**: Add to `HookEventType` in `types.ts`, add hook command in `hooks-config.ts:generateHooksConfig()`, update `HookEventSchema` in `schemas.ts`
- **Mobile feature**: Add to relevant mobile singleton (`KeyboardHandler`, `KeyboardAccessoryBar`, etc.), test with `MobileDetection.isMobile()` guard
- **New test**: Pick unique port (search `const PORT =` across `test/`), add port comment to test file header. Integration tests use ports 3099-3211. Route tests in `test/routes/` use `app.inject()` (no real port needed) — see `test/routes/_route-test-utils.ts`.

**Validation**: Uses Zod v4 for request validation. Define schemas in `schemas.ts` and use `.parse()` or `.safeParse()`. Note: Zod v4 has different API from v3 (e.g., `z.object()` options changed, error formatting differs).

## State Files

| File | Purpose |
|------|---------|
| `~/.codeman/state.json` | Sessions, settings, tokens, respawn config |
| `~/.codeman/mux-sessions.json` | Tmux session metadata for recovery |
| `~/.codeman/settings.json` | User preferences |
| `~/.codeman/push-keys.json` | VAPID key pair for Web Push (auto-generated) |
| `~/.codeman/push-subscriptions.json` | Registered push notification subscriptions |
| `~/.codeman/session-lifecycle.jsonl` | Append-only JSONL audit log (QR auth, session events) |

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

**Config**: Vitest with `globals: true`, `fileParallelism: false`. Unit timeout 30s, teardown timeout 60s.

**Safety**: `test/setup.ts` snapshots pre-existing tmux sessions at load time and never kills them. Only sessions registered via `registerTestTmuxSession()` get cleaned up.

**Respawn tests**: Use MockSession from `test/respawn-test-utils.ts` to avoid spawning real Claude processes.

**Route tests**: `test/routes/` uses Fastify's `app.inject()` for fast in-process testing (no real ports). See `test/routes/_route-test-utils.ts` for the shared setup helper.

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

**Anti-flicker pipeline**: `PTY → Server Batching (16-50ms) → DEC 2026 Wrap → SSE → Client rAF → xterm.js`. Key functions: `server.ts:batchTerminalData()`, `app.js:batchTerminalWrite()`, `app.js:extractSyncSegments()`. Optional per-session flicker filter adds ~50ms. See `docs/terminal-anti-flicker.md`.

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
| **Agent Teams** | `agent-teams/README.md`, `agent-teams/design.md` |
| **OpenCode integration** | `docs/opencode-integration.md` |
| **QR auth design** | `docs/qr-auth-plan.md` |
| **SSE events** | `src/web/sse-events.ts` (registry) + `src/web/public/constants.js` (frontend) |
| **Types architecture** | `src/types/index.ts` `@fileoverview` (domain map + cross-references) |
| **API routes** | `src/web/routes/` — each file has `@fileoverview` with route listing |

Additional docs in `docs/` directory: refactoring phases (1-7), performance reports, improvement roadmaps, mobile/browser testing guides.

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

For persistent tunnel: `systemctl --user enable --now codeman-tunnel` (after copying `scripts/codeman-tunnel.service` to `~/.config/systemd/user/`).

**Always set `CODEMAN_PASSWORD`** before exposing via tunnel — without it, anyone with the URL has full access. See the Security section above for full auth flow details (Basic Auth, QR Auth, session cookies, rate limiting).
