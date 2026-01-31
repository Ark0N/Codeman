# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## CRITICAL: Screen Session Safety

**You may be running inside a Claudeman-managed screen session.** Before killing ANY screen or Claude process:

1. Check: `echo $CLAUDEMAN_SCREEN` - if `1`, you're in a managed session
2. **NEVER** run `screen -X quit`, `pkill screen`, or `pkill claude` without confirming
3. Use the web UI or `./scripts/screen-manager.sh` instead of direct kill commands

## COM Shorthand (Deployment)

When user says "COM":
1. Increment version in BOTH `package.json` AND `CLAUDE.md`
2. Run: `git add -A && git commit -m "chore: bump version to X.XXXX" && git push && npm run build && systemctl --user restart claudeman-web`

**Version**: 0.1460 (must match `package.json`)

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

## Binaries

| Binary | Purpose |
|--------|---------|
| `claudeman` | Main CLI and web server |

## Architecture

### Core Files

| File | Purpose |
|------|---------|
| `src/session.ts` | PTY wrapper: `runPrompt()`, `startInteractive()`, `startShell()` |
| `src/screen-manager.ts` | GNU screen persistence, ghost discovery |
| `src/session-manager.ts` | Session lifecycle, cleanup |
| `src/respawn-controller.ts` | State machine for autonomous cycling |
| `src/ralph-tracker.ts` | Detects `<promise>PHRASE</promise>`, todos |
| `src/subagent-watcher.ts` | Monitors Claude Code's Task tool (background agents) |
| `src/run-summary.ts` | Timeline events for "what happened while away" |
| `src/ai-idle-checker.ts` | AI-powered idle detection with `ai-checker-base.ts` |
| `src/bash-tool-parser.ts` | Parses Claude's bash tool invocations from output |
| `src/transcript-watcher.ts` | Watches Claude's transcript files for changes |
| `src/hooks-config.ts` | Manages `.claude/settings.local.json` hook configuration |
| `src/image-watcher.ts` | Watches for image file creation (screenshots, etc.) |
| `src/plan-orchestrator.ts` | Multi-agent plan generation with research and planning phases |
| `src/prompts/*.ts` | Agent prompts (research-agent, code-reviewer, planner) |
| `src/web/server.ts` | Fastify REST API + SSE at `/api/events` |
| `src/web/public/app.js` | Frontend: xterm.js, tab management, subagent windows |
| `src/types.ts` | All TypeScript interfaces |

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

**Validation**: Uses Zod v4 for request validation. Define schemas near route handlers and use `.parse()` or `.safeParse()`.

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

**E2E tests**: Use Playwright. Run `npx playwright install chromium` first. See `test/e2e/fixtures/` for helpers. E2E config (`test/e2e/e2e.config.ts`) provides ports (3183-3190), timeouts, and helpers.

**Test config**: Vitest runs with `globals: true` (no imports needed for `describe`/`it`/`expect`/`vi`) and `fileParallelism: false` (files run sequentially to respect screen limits). Unit test timeout is 30s, teardown timeout is 60s. E2E tests have longer timeouts defined in `test/e2e/e2e.config.ts` (90s test, 30s session creation).

**Test safety**: `test/setup.ts` provides:
- Screen concurrency limiter (max 10)
- Pre-existing screen protection (never kills screens present before tests)
- Tracked resource cleanup (only kills screens/processes tests register)
- Safe to run from within Claudeman-managed sessions

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

**Avoid port 3000 during E2E tests** - tests use ports 3183-3190 (see `test/e2e/e2e.config.ts`).

## Performance Constraints

The app must stay fast with 20 sessions and 50 agent windows:
- 60fps terminal (16ms batching + `requestAnimationFrame`)
- Auto-trimming buffers (2MB terminal max)
- Debounced state persistence (500ms)
- SSE batching (16ms)

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
