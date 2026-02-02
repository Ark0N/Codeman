# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Quick Reference

| Task | Command |
|------|---------|
| Dev server | `npx tsx src/index.ts web` |
| Type check | `tsc --noEmit` |
| Single test | `npx vitest run test/<file>.test.ts` |
| E2E tests | `npm run test:e2e` |
| Production | `npm run build && systemctl --user restart claudeman-web` |

## CRITICAL: Screen Session Safety

**You may be running inside a Claudeman-managed screen session.** Before killing ANY screen or Claude process:

1. Check: `echo $CLAUDEMAN_SCREEN` - if `1`, you're in a managed session
2. **NEVER** run `screen -X quit`, `pkill screen`, or `pkill claude` without confirming
3. Use the web UI or `./scripts/screen-manager.sh` instead of direct kill commands

## COM Shorthand (Deployment)

When user says "COM":
1. Increment version in BOTH `package.json` AND `CLAUDE.md` (verify they match with `grep version package.json && grep Version CLAUDE.md`)
2. Run: `git add -A && git commit -m "chore: bump version to X.XXXX" && git push && npm run build && systemctl --user restart claudeman-web`

**Version**: 0.1476 (must match `package.json` for npm publish)

## Project Overview

Claudeman is a Claude Code session manager with web interface and autonomous Ralph Loop. Spawns Claude CLI via PTY, streams via SSE, supports respawn cycling for 24+ hour autonomous runs.

**Tech Stack**: TypeScript (ES2022/NodeNext, strict mode), Node.js, Fastify, node-pty, xterm.js

**TypeScript Strictness** (see `tsconfig.json`): `noUnusedLocals`, `noUnusedParameters`, `noImplicitReturns`, `noImplicitOverride`, `noFallthroughCasesInSwitch`, `allowUnreachableCode: false`, `allowUnusedLabels: false`. Note: `src/tui` is excluded from compilation (legacy/deprecated code path).

**Requirements**: Node.js 18+, Claude CLI, GNU Screen

## Commands

**CRITICAL**: `npm run dev` shows CLI help, NOT the web server.

**Default port**: `3000` (web UI at `http://localhost:3000`)

```bash
# Setup
npm install                        # Install dependencies

# Development
npx tsx src/index.ts web           # Dev server (RECOMMENDED)
npx tsx src/index.ts web --https   # With TLS (only needed for remote access)
npm run typecheck                  # Type check
tsc --noEmit --watch               # Continuous type checking

# Testing
npx vitest run                     # All tests
npx vitest run test/<file>.test.ts # Single file
npx vitest run -t "pattern"        # Tests matching name
npm run test:coverage              # With coverage report
npm run test:e2e                   # Browser E2E (requires: npx playwright install chromium)
npm run test:e2e:quick             # Quick E2E (just quick-start workflow)

# Production
npm run build
systemctl --user restart claudeman-web
journalctl --user -u claudeman-web -f
```

## Common Gotchas

- **`npm run dev` is NOT the web server** — it shows CLI help. Use `npx tsx src/index.ts web`
- **Single-line prompts only** — `writeViaScreen()` sends text and Enter separately; multi-line breaks Ink
- **Test screens need 'test' in name** — The cleanup system only kills screens containing 'test'
- **Don't kill screens blindly** — Check `$CLAUDEMAN_SCREEN` first; you might be inside one
- **Port 3000 during E2E** — Tests use ports 3183-3193; don't run dev server on 3000 while testing

## Import Conventions

- **Utilities**: Import from `./utils` (re-exports all): `import { LRUMap, debounce } from './utils'`
- **Types**: Use type imports: `import type { SessionState } from './types'`
- **Config**: Import from specific files: `import { BUFFER_LIMITS } from './config/buffer-limits'`

## Architecture

### Core Files

| File | Purpose |
|------|---------|
| `src/session.ts` | PTY wrapper: `runPrompt()`, `startInteractive()`, `startShell()` |
| `src/screen-manager.ts` | GNU screen persistence, ghost discovery |
| `src/session-manager.ts` | Session lifecycle, cleanup |
| `src/state-store.ts` | State persistence to `~/.claudeman/state.json` |
| `src/respawn-controller.ts` | State machine for autonomous cycling |
| `src/ralph-tracker.ts` | Detects `<promise>PHRASE</promise>`, todos |
| `src/ralph-loop.ts` | Autonomous task execution loop (polls queue, assigns tasks) |
| `src/ralph-config.ts` | Parses `.claude/ralph-loop.local.md` plugin config |
| `src/task.ts` | Task model for prompt execution |
| `src/task-queue.ts` | Priority queue for tasks with dependencies |
| `src/task-tracker.ts` | Background task tracker for subagent detection |
| `src/subagent-watcher.ts` | Monitors Claude Code's Task tool (background agents) |
| `src/run-summary.ts` | Timeline events for "what happened while away" |
| `src/ai-idle-checker.ts` | AI-powered idle detection with `ai-checker-base.ts` |
| `src/ai-plan-checker.ts` | AI-powered plan completion checker |
| `src/bash-tool-parser.ts` | Parses Claude's bash tool invocations from output |
| `src/transcript-watcher.ts` | Watches Claude's transcript files for changes |
| `src/hooks-config.ts` | Manages `.claude/settings.local.json` hook configuration |
| `src/image-watcher.ts` | Watches for image file creation (screenshots, etc.) |
| `src/file-stream-manager.ts` | Manages `tail -f` processes for live log viewing |
| `src/plan-orchestrator.ts` | Multi-agent plan generation with research and planning phases |
| `src/prompts/*.ts` | Agent prompts (research-agent, code-reviewer, planner) |
| `src/templates/claude-md.ts` | CLAUDE.md generation for new cases |
| `src/cli.ts` | Command-line interface handlers |
| `src/web/server.ts` | Fastify REST API + SSE at `/api/events` |
| `src/web/public/app.js` | Frontend: xterm.js, tab management, subagent windows |
| `src/types.ts` | All TypeScript interfaces |

**Large files** (>50KB): `ralph-tracker.ts`, `respawn-controller.ts`, `session.ts`, `subagent-watcher.ts` — these contain complex state machines; read `docs/respawn-state-machine.md` before modifying.

### Config Files (`src/config/`)

| File | Purpose |
|------|---------|
| `buffer-limits.ts` | Terminal/text buffer size limits |
| `map-limits.ts` | Global limits for Maps, sessions, watchers |

### Utility Files (`src/utils/`)

| File | Purpose |
|------|---------|
| `index.ts` | Re-exports all utilities (standard import point) |
| `lru-map.ts` | LRU eviction Map for bounded caches |
| `stale-expiration-map.ts` | TTL-based Map with lazy expiration |
| `cleanup-manager.ts` | Centralized resource disposal |
| `buffer-accumulator.ts` | Chunk accumulator with size limits |
| `string-similarity.ts` | String matching utilities (fuzzy matching) |
| `token-validation.ts` | Token count parsing and validation |
| `regex-patterns.ts` | Shared regex patterns for parsing |

### Data Flow

1. Session spawns `claude --dangerously-skip-permissions` via node-pty
2. PTY output buffered, ANSI stripped, parsed for JSON messages
3. WebServer broadcasts to SSE clients at `/api/events`
4. State persists to `~/.claudeman/state.json` via StateStore

### Key Patterns

**Input to sessions**: Use `session.writeViaScreen()` for programmatic input (respawn, auto-compact). Text and Enter sent as separate `screen -X stuff` commands due to Ink's requirements. All prompts must be single-line.

**Idle detection**: Multi-layer (completion message → AI check → output silence → token stability). See `docs/respawn-state-machine.md`.

**Token tracking**: Interactive mode parses status line ("123.4k tokens"), estimates 60/40 input/output split.

**Hook events**: Claude Code hooks trigger notifications via `/api/hook-event`. Key events: `permission_prompt` (tool approval needed), `elicitation_dialog` (Claude asking question), `idle_prompt` (waiting for input), `stop` (response complete). See `src/hooks-config.ts`.

## Adding Features

- **API endpoint**: Types in `types.ts`, route in `server.ts:buildServer()`, use `createErrorResponse()`. Validate request bodies with Zod schemas.
- **SSE event**: Emit via `broadcast()`, handle in `app.js:handleSSEEvent()`
- **Session setting**: Add to `SessionState` in `types.ts`, include in `session.toState()`, call `persistSessionState()`
- **New test**: Pick unique port (see below), add port comment to test file header

**Validation**: Uses Zod v4 for request validation. Define schemas near route handlers and use `.parse()` or `.safeParse()`. Note: Zod v4 has different API from v3 (e.g., `z.object()` options changed, error formatting differs).

## State Files

| File | Purpose |
|------|---------|
| `~/.claudeman/state.json` | Sessions, settings, tokens, respawn config |
| `~/.claudeman/screens.json` | Screen metadata for recovery |
| `~/.claudeman/settings.json` | User preferences |

## Default Settings

UI defaults are optimized for minimal distraction. Set in `src/web/public/app.js` (using `??` operator).

**Display Settings** (default values):
| Setting | Default | Description |
|---------|---------|-------------|
| `showFontControls` | `false` | Font size controls in header |
| `showSystemStats` | `true` | CPU/memory stats in header |
| `showTokenCount` | `true` | Token counter in header |
| `showCost` | `false` | Cost display |
| `showMonitor` | `true` | Monitor panel |
| `showProjectInsights` | `false` | Project insights panel |
| `showFileBrowser` | `false` | File browser panel |
| `showSubagents` | `false` | Subagent windows panel |

**Tracking Settings**:
| Setting | Default | Description |
|---------|---------|-------------|
| `ralphTrackerEnabled` | `false` | Ralph/Todo loop tracking |
| `subagentTrackingEnabled` | `true` | Background agent monitoring |
| `subagentActiveTabOnly` | `true` | Show subagents only for active session |
| `imageWatcherEnabled` | `false` | Watch for image file creation |

**Notification Defaults**: Browser notifications enabled, audio alerts disabled. Critical events (permission prompts, questions) notify by default; info events (respawn cycles, token milestones) are silent.

To change defaults, edit the `??` fallback values in `openAppSettings()` and `apply*Visibility()` functions.

## Testing

**Port allocation**: E2E tests use centralized ports in `test/e2e/e2e.config.ts`. Unit/integration tests pick unique ports manually. Search `const PORT =` or `TEST_PORT` in test files to find used ports before adding new tests.

**E2E tests**: Use Playwright. Run `npx playwright install chromium` first. See `test/e2e/fixtures/` for helpers. E2E config (`test/e2e/e2e.config.ts`) provides ports (3183-3193), timeouts, and helpers.

**Test config**: Vitest runs with `globals: true` (no imports needed for `describe`/`it`/`expect`/`vi`) and `fileParallelism: false` (files run sequentially to respect screen limits). Unit test timeout is 30s, teardown timeout is 60s. E2E tests have longer timeouts defined in `test/e2e/e2e.config.ts` (90s test, 30s session creation). Mock helpers in `vitest.setup.ts` auto-run before all tests.

**Test safety**: `test/setup.ts` provides:
- Screen concurrency limiter (max 10)
- Pre-existing screen protection (never kills screens present before tests)
- Tracked resource cleanup (only kills screens/processes tests register)
- Safe to run from within Claudeman-managed sessions
- Exported helpers: `acquireScreenSlot()`, `releaseScreenSlot()`, `registerTestScreen()`, `unregisterTestScreen()`

Respawn tests use MockSession to avoid spawning real Claude processes. See `test/respawn-test-utils.ts` for MockSession, MockAiIdleChecker, MockAiPlanChecker, state trackers, and terminal output generators.

## Debugging

```bash
screen -ls                          # List screens
screen -r <name>                    # Attach (Ctrl+A D to detach)
curl localhost:3000/api/sessions    # Check sessions
curl localhost:3000/api/status | jq # Full app state
cat ~/.claudeman/state.json | jq    # View persisted state
curl localhost:3000/api/subagents   # List background agents
curl localhost:3000/api/sessions/:id/run-summary | jq  # Session timeline
```

**Avoid port 3000 during E2E tests** — tests use ports 3183-3193 (see `test/e2e/e2e.config.ts`).

## Performance Constraints

The app must stay fast with 20 sessions and 50 agent windows:
- 60fps terminal (16ms batching + `requestAnimationFrame`)
- Auto-trimming buffers (2MB terminal max)
- Debounced state persistence (500ms)
- SSE batching (16ms)

## Terminal Anti-Flicker System

Claude Code uses [Ink](https://github.com/vadimdemedes/ink) (React for terminals), which redraws the entire screen on every state change. Without special handling, users see constant flickering. Claudeman implements a 6-layer anti-flicker pipeline:

```
PTY Output → Server Batching → DEC 2026 Wrap → SSE → Client rAF → Sync Parser → xterm.js
```

### Layer Details

| Layer | Location | Technique | Latency |
|-------|----------|-----------|---------|
| **1. Server Batching** | `server.ts:batchTerminalData()` | Adaptive 16-50ms collection window | 16-50ms |
| **2. DEC Mode 2026** | `server.ts:flushTerminalBatches()` | Wraps with `\x1b[?2026h`...`\x1b[?2026l` | 0ms |
| **3. SSE Broadcast** | `server.ts:broadcast()` | JSON serialize once, send to all clients | 0ms |
| **4. Client rAF** | `app.js:batchTerminalWrite()` | `requestAnimationFrame` batching | 0-16ms |
| **5. Sync Block Parser** | `app.js:extractSyncSegments()` | Strips DEC 2026 markers, waits for complete blocks | 0-50ms |
| **6. Chunked Loading** | `app.js:chunkedTerminalWrite()` | 64KB/frame for large buffers | variable |

### Server-Side Implementation (`server.ts`)

**Constants:**
```typescript
const TERMINAL_BATCH_INTERVAL = 16;      // Base: 60fps
const BATCH_FLUSH_THRESHOLD = 32 * 1024; // Flush immediately if >32KB
const DEC_SYNC_START = '\x1b[?2026h';    // Begin synchronized update
const DEC_SYNC_END = '\x1b[?2026l';      // End synchronized update
```

**Adaptive Batching** (`batchTerminalData()`):
- Tracks event frequency per session via `lastTerminalEventTime` Map
- Event gap <10ms → 50ms batch window (rapid-fire Ink redraws)
- Event gap <20ms → 32ms batch window
- Otherwise → 16ms (60fps)
- Flushes immediately if batch exceeds 32KB for responsiveness

**Flush Logic** (`flushTerminalBatches()`):
```typescript
const syncData = DEC_SYNC_START + data + DEC_SYNC_END;
this.broadcast('session:terminal', { id: sessionId, data: syncData });
```

### Client-Side Implementation (`app.js`)

**batchTerminalWrite(data):**
1. Checks if flicker filter is enabled (optional, per-session)
2. If flicker filter active: buffers screen-clear patterns (`ESC[2J`, `ESC[H ESC[J`, `ESC[nA`)
3. Accumulates data in `pendingWrites`
4. Schedules `requestAnimationFrame` if not already scheduled
5. On rAF callback: checks for incomplete sync blocks (start without end)
6. If incomplete: waits up to 50ms via `syncWaitTimeout`
7. Calls `flushPendingWrites()` when complete

**extractSyncSegments(data):**
- Parses DEC 2026 markers, returns array of content segments
- Content before sync blocks returned as-is
- Content inside sync blocks returned without markers
- Incomplete blocks (start without end) returned with marker for next chunk

**flushPendingWrites():**
```javascript
const segments = extractSyncSegments(this.pendingWrites);
this.pendingWrites = '';  // Clear before writing
for (const segment of segments) {
  if (segment && !segment.startsWith(DEC_SYNC_START)) {
    this.terminal.write(segment);  // Skip incomplete blocks (start with marker)
  }
}
```
Note: Segments starting with `DEC_SYNC_START` are incomplete blocks awaiting more data. These are skipped (discarded if timeout forces flush).

**chunkedTerminalWrite(buffer, chunkSize=128KB):**
- For large buffer restoration (session switch, reconnect)
- Writes 128KB per `requestAnimationFrame` to avoid UI jank
- Strips any embedded DEC 2026 markers from historical data

**selectSession() optimizations:**
- Starts buffer fetch immediately before other setup
- Shows "Loading session..." indicator while fetching
- Parallelizes session attach with buffer fetch
- Fire-and-forget resize (doesn't block tab switch)

### Optional Flicker Filter

Per-session toggle via Session Settings. Adds ~50ms latency but eliminates remaining flicker on problematic terminals.

**Detection patterns:**
- `ESC[2J` — Clear entire screen
- `ESC[H ESC[J` — Cursor home + clear to end
- `ESC[?25l ESC[H` — Hide cursor + home (Ink pattern)
- `ESC[nA` (n≥1) — Cursor up (Ink line redraw)

When detected, buffers 50ms of subsequent output before flushing atomically.

### Responsiveness Considerations

**Latency sources:**
| Source | Best Case | Worst Case | Notes |
|--------|-----------|------------|-------|
| Server batching | 0ms (flush) | 50ms (rapid events) | Immediate flush if >32KB |
| Sync block wait | 0ms | 50ms | Only if marker split across packets |
| Flicker filter | 0ms (disabled) | 50ms (enabled) | Optional per-session |
| rAF scheduling | 0ms | 16ms | Display refresh sync |
| **Total** | **0ms** | **~115ms** | Worst case rare in practice |

**Typical latency:** 16-32ms (server batch + rAF)

**Edge cases handled:**
- Incomplete sync blocks: 50ms timeout forces flush (content discarded to prevent freeze)
- Large buffers: Chunked writing prevents UI freeze
- Server shutdown: Skips batching via `_isStopping` flag
- Session switch: Clears flicker filter state, pending writes, and sync timeout (prevents cross-session data bleed)
- SSE reconnect: `handleInit()` clears all pending write state

**Trade-off:** If a sync block is split across SSE packets and the end marker doesn't arrive within 50ms, the incomplete content is discarded. This prioritizes responsiveness over completeness. In practice this is rare since the server always sends complete `SYNC_START...SYNC_END` pairs and SSE typically delivers them atomically.

### Files Involved

| File | Key Functions |
|------|---------------|
| `src/web/server.ts` | `batchTerminalData()`, `flushTerminalBatches()`, `broadcast()` |
| `src/web/public/app.js` | `batchTerminalWrite()`, `extractSyncSegments()`, `flushPendingWrites()`, `flushFlickerBuffer()`, `chunkedTerminalWrite()` |

### DEC Mode 2026 Compatibility

Terminals that natively support DEC 2026 will buffer and render atomically. Terminals that don't support it ignore the escape sequences harmlessly. xterm.js doesn't support DEC 2026 natively, so the client implements its own buffering by parsing the markers.

**Supporting terminals:** WezTerm, Kitty, Ghostty, iTerm2 3.5+, Windows Terminal, VSCode terminal

## Resource Limits

Limits are centralized in `src/config/buffer-limits.ts` and `src/config/map-limits.ts`.

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
| **Browser/E2E testing** | `docs/browser-testing-guide.md` |
| **API routes** | `src/web/server.ts:buildServer()` or README.md (full endpoint tables) |
| **SSE events** | Search `broadcast(` in `server.ts` |
| **CLI commands** | `claudeman --help` |
| **Frontend patterns** | `src/web/public/app.js` (subagent windows, notifications) |
| **Session modes** | `SessionMode` type in `src/types.ts` |
| **Error codes** | `createErrorResponse()` in `src/types.ts` |
| **Test fixtures** | `test/e2e/fixtures/` |
| **Test utilities** | `test/respawn-test-utils.ts` |
| **Memory leak patterns** | `test/memory-leak-prevention.test.ts` |
| **Keyboard shortcuts** | README.md or App Settings in web UI |
| **Mobile/SSH access** | README.md (Claudeman Screens / `sc` command) |
| **Plan orchestrator** | `src/plan-orchestrator.ts` file header |
| **Agent prompts** | `src/prompts/` directory |

## Scripts

| Script | Purpose |
|--------|---------|
| `scripts/screen-manager.sh` | Safe screen management (use instead of direct kill commands) |
| `scripts/screen-chooser.sh` | Claudeman Screens - mobile-friendly session picker (`sc` alias, see README for usage) |
| `scripts/monitor-respawn.sh` | Monitor respawn state machine in real-time |
| `scripts/postinstall.js` | npm postinstall hook for setup |
| `scripts/data-generator.sh` | Generate test data for development |
| `scripts/test-tail-links.sh` | Test clickable file links in tail output |
| `scripts/capture-subagent-screenshots.mjs` | Capture subagent screenshots/GIFs for README (uses real Claude sessions) |
| `scripts/mobile-screenshot.mjs` | Capture mobile UI screenshots |

## Memory Leak Prevention

Frontend runs long (24+ hour sessions); all Maps/timers must be cleaned up.

### Cleanup Patterns
When adding new event listeners or timers:
1. Store handler references for later removal
2. Add cleanup to appropriate `stop()` or `cleanup*()` method
3. For singleton watchers, store refs in class properties and remove in server `stop()`

**Backend**: Clear Maps in `stop()`, null promise callbacks on error, remove watcher listeners on shutdown.

**Frontend**: Store drag/resize handlers on elements, clean up in `close*()` functions. SSE reconnect calls `handleInit()` which resets state.

Run `npx vitest run test/memory-leak-prevention.test.ts` to verify patterns.

## Common Workflows

**Investigating a bug**: Start dev server (`npx tsx src/index.ts web`), reproduce in browser, check terminal output and `~/.claudeman/state.json` for clues.

**Adding a new API endpoint**: Define types in `types.ts`, add route in `server.ts:buildServer()`, broadcast SSE events if needed, handle in `app.js:handleSSEEvent()`.

**Modifying respawn behavior**: Study `docs/respawn-state-machine.md` first. The state machine is in `respawn-controller.ts`. Use MockSession from `test/respawn-test-utils.ts` for testing.
