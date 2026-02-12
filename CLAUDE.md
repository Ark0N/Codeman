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

## CRITICAL: Session Safety

**You may be running inside a Claudeman-managed tmux/screen session.** Before killing ANY tmux, screen, or Claude process:

1. Check: `echo $CLAUDEMAN_SCREEN` - if `1`, you're in a managed session
2. **NEVER** run `tmux kill-session`, `screen -X quit`, `pkill tmux`, `pkill screen`, or `pkill claude` without confirming
3. Use the web UI or `./scripts/tmux-manager.sh` instead of direct kill commands

## COM Shorthand (Deployment)

When user says "COM":
1. Increment version in BOTH `package.json` AND `CLAUDE.md` (verify they match with `grep version package.json && grep Version CLAUDE.md`)
2. Run: `git add -A && git commit -m "chore: bump version to X.XXXX" && git push && npm run build && systemctl --user restart claudeman-web`

**Version**: 0.1481 (must match `package.json` for npm publish)

## Project Overview

Claudeman is a Claude Code session manager with web interface and autonomous Ralph Loop. Spawns Claude CLI via PTY, streams via SSE, supports respawn cycling for 24+ hour autonomous runs.

**Tech Stack**: TypeScript (ES2022/NodeNext, strict mode), Node.js, Fastify, node-pty, xterm.js

**TypeScript Strictness** (see `tsconfig.json`): `noUnusedLocals`, `noUnusedParameters`, `noImplicitReturns`, `noImplicitOverride`, `noFallthroughCasesInSwitch`, `allowUnreachableCode: false`, `allowUnusedLabels: false`. Note: `src/tui` is excluded from compilation (legacy/deprecated code path).

**Requirements**: Node.js 18+, Claude CLI, tmux (preferred) or GNU Screen (deprecated fallback via `CLAUDEMAN_MUX=screen`)

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

- **Utilities**: Import from `./utils` (re-exports all): `import { LRUMap, stripAnsi } from './utils'`
- **Types**: Use type imports: `import type { SessionState } from './types'`
- **Config**: Import from specific files: `import { MAX_TERMINAL_BUFFER_SIZE } from './config/buffer-limits'`

## Architecture

### Core Files

| File | Purpose |
|------|---------|
| `src/session.ts` | PTY wrapper: `runPrompt()`, `startInteractive()`, `startShell()` |
| `src/mux-interface.ts` | `TerminalMultiplexer` interface + `MuxSession` type |
| `src/mux-factory.ts` | Auto-detect tmux/screen, create multiplexer (`CLAUDEMAN_MUX` override) |
| `src/tmux-manager.ts` | tmux session management (preferred backend) |
| `src/screen-manager.ts` | GNU screen persistence, ghost discovery (deprecated fallback) |
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
| `src/team-watcher.ts` | Polls `~/.claude/teams/` for agent team activity; matches teams to sessions via `leadSessionId` |
| `src/run-summary.ts` | Timeline events for "what happened while away" |
| `src/ai-checker-base.ts` | Base class for AI-powered checkers (shared by idle + plan checkers) |
| `src/ai-idle-checker.ts` | AI-powered idle detection |
| `src/ai-plan-checker.ts` | AI-powered plan completion checker |
| `src/bash-tool-parser.ts` | Parses Claude's bash tool invocations from output |
| `src/transcript-watcher.ts` | Watches Claude's transcript files for changes |
| `src/hooks-config.ts` | Manages `.claude/settings.local.json` hook configuration |
| `src/image-watcher.ts` | Watches for image file creation (screenshots, etc.) |
| `src/file-stream-manager.ts` | Manages `tail -f` processes for live log viewing |
| `src/plan-orchestrator.ts` | Multi-agent plan generation with research and planning phases |
| `src/prompts/index.ts` | Barrel export for all agent prompts |
| `src/prompts/*.ts` | Agent prompts (research-agent, code-reviewer, planner) |
| `src/templates/claude-md.ts` | CLAUDE.md generation for new cases |
| `src/cli.ts` | Command-line interface handlers |
| `src/web/server.ts` | Fastify REST API + SSE at `/api/events` |
| `src/web/schemas.ts` | Zod v4 validation schemas for API request bodies |
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
| `type-safety.ts` | `assertNever()` for exhaustive switch/case type checking |

### Data Flow

1. Session spawns `claude --dangerously-skip-permissions` via node-pty
2. PTY output buffered, ANSI stripped, parsed for JSON messages
3. WebServer broadcasts to SSE clients at `/api/events`
4. State persists to `~/.claudeman/state.json` via StateStore

### Key Patterns

**Input to sessions**: Use `session.writeViaScreen()` for programmatic input (respawn, auto-compact). With tmux, uses `send-keys -l` (literal text) + `send-keys Enter` — single command, no delay. With screen (deprecated), text and Enter sent as separate `screen -X stuff` commands with 100ms delay. All prompts must be single-line.

**Terminal multiplexer abstraction**: `TerminalMultiplexer` interface (`src/mux-interface.ts`) abstracts tmux vs screen. `createMultiplexer()` from `src/mux-factory.ts` auto-detects tmux (preferred) or falls back to screen. Set `CLAUDEMAN_MUX=screen` env var to force screen backend.

**Idle detection**: Multi-layer (completion message → AI check → output silence → token stability). See `docs/respawn-state-machine.md`.

**Token tracking**: Interactive mode parses status line ("123.4k tokens"), estimates 60/40 input/output split.

**Hook events**: Claude Code hooks trigger notifications via `/api/hook-event`. Key events: `permission_prompt` (tool approval needed), `elicitation_dialog` (Claude asking question), `idle_prompt` (waiting for input), `stop` (response complete). See `src/hooks-config.ts`.

**Agent Teams (experimental)**: `TeamWatcher` polls `~/.claude/teams/` for team configs and matches teams to sessions via `leadSessionId`. Teammates are in-process threads (not separate OS processes) and appear as standard subagents. RespawnController checks `TeamWatcher.hasActiveTeammates()` before triggering respawn. Enable via `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` env var in `settings.local.json`. See `agent-teams/` for full docs.

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
| `~/.claudeman/mux-sessions.json` | Tmux session metadata for recovery |
| `~/.claudeman/screens.json` | Legacy screen metadata (auto-migrated to mux-sessions.json) |
| `~/.claudeman/settings.json` | User preferences |

## Default Settings

UI defaults are set in `src/web/public/app.js` using `??` fallbacks. To change defaults, edit `openAppSettings()` and `apply*Visibility()` functions.

**Key defaults:** Most panels hidden (monitor, subagents shown), notifications enabled (audio disabled), subagent tracking on, Ralph tracking off.

## Testing

**Port allocation**: E2E tests use centralized ports in `test/e2e/e2e.config.ts` (3183-3193). Unit/integration tests pick unique ports manually (team tests: 3150-3151). Search `const PORT =` or `TEST_PORT` in test files to find used ports before adding new tests.

**E2E tests**: Use Playwright. Run `npx playwright install chromium` first. See `test/e2e/fixtures/` for helpers. E2E config (`test/e2e/e2e.config.ts`) provides ports (3183-3193), timeouts, and helpers.

**Test config**: Vitest runs with `globals: true` (no imports needed for `describe`/`it`/`expect`/`vi`) and `fileParallelism: false` (files run sequentially to respect screen limits). Unit test timeout is 30s, teardown timeout is 60s. E2E tests have longer timeouts defined in `test/e2e/e2e.config.ts` (90s test, 30s session creation). Mock helpers in `test/setup.ts` auto-run before all tests.

**Test safety**: `test/setup.ts` provides:
- Screen concurrency limiter (max 10)
- Pre-existing screen protection (never kills screens present before tests)
- Tracked resource cleanup (only kills screens/processes tests register)
- Safe to run from within Claudeman-managed sessions
- Exported helpers: `acquireScreenSlot()`, `releaseScreenSlot()`, `registerTestScreen()`, `unregisterTestScreen()`

Respawn tests use MockSession to avoid spawning real Claude processes. See `test/respawn-test-utils.ts` for MockSession, MockAiIdleChecker, MockAiPlanChecker, state trackers, and terminal output generators.

## Debugging

```bash
tmux list-sessions                  # List tmux sessions
tmux attach-session -t <name>       # Attach (Ctrl+B D to detach)
curl localhost:3000/api/sessions    # Check sessions
curl localhost:3000/api/status | jq # Full app state
cat ~/.claudeman/state.json | jq    # View persisted state
curl localhost:3000/api/subagents   # List background agents
curl localhost:3000/api/sessions/:id/run-summary | jq  # Session timeline
```

**Avoid port 3000 during E2E tests** — tests use ports 3183-3193 (see `test/e2e/e2e.config.ts`).

## Troubleshooting

| Problem | Check | Fix |
|---------|-------|-----|
| Session won't start | `tmux list-sessions` for orphans | Kill orphaned sessions, check Claude CLI installed |
| Port 3000 in use | `lsof -i :3000` | Kill conflicting process or use `--port` flag |
| SSE not connecting | Browser console for errors | Check CORS, ensure server running |
| Respawn not triggering | Session settings → Respawn enabled? | Enable respawn, check idle timeout config |
| Terminal blank on tab switch | Network tab for `/api/sessions/:id/buffer` | Check session exists, restart server |
| Tests failing on session limits | `tmux list-sessions \| wc -l` | Clean up test sessions: `tmux list-sessions \| grep test \| awk -F: '{print $1}' \| xargs -I{} tmux kill-session -t {}` |
| State not persisting | `cat ~/.claudeman/state.json` | Check file permissions, disk space |

## Performance Constraints

The app must stay fast with 20 sessions and 50 agent windows:
- 60fps terminal (16ms batching + `requestAnimationFrame`)
- Auto-trimming buffers (2MB terminal max)
- Debounced state persistence (500ms)
- SSE batching (16ms)

## Terminal Anti-Flicker System

Claude Code uses Ink (React for terminals), which redraws the screen on every state change. Claudeman implements a 6-layer anti-flicker pipeline for smooth 60fps output:

```
PTY Output → Server Batching (16-50ms) → DEC 2026 Wrap → SSE → Client rAF → xterm.js
```

**Key functions:** `server.ts:batchTerminalData()`, `server.ts:flushTerminalBatches()`, `app.js:batchTerminalWrite()`, `app.js:extractSyncSegments()`

**Typical latency:** 16-32ms. Optional per-session flicker filter adds ~50ms for problematic terminals.

See `docs/terminal-anti-flicker.md` for full implementation details (adaptive batching, DEC 2026 markers, edge cases).

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
| **Terminal anti-flicker** | `docs/terminal-anti-flicker.md` |
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
| **Agent Teams (experimental)** | `agent-teams/README.md`, `agent-teams/design.md` |

## Scripts

| Script | Purpose |
|--------|---------|
| `scripts/tmux-manager.sh` | Safe tmux session management (use instead of direct kill commands) |
| `scripts/tmux-chooser.sh` | Mobile-friendly tmux session picker (`sc` alias) |
| `scripts/screen-manager.sh` | Legacy screen management (deprecated, use tmux-manager.sh) |
| `scripts/screen-chooser.sh` | Legacy screen session picker (deprecated, use tmux-chooser.sh) |
| `scripts/monitor-respawn.sh` | Monitor respawn state machine in real-time |
| `scripts/postinstall.js` | npm postinstall hook for setup |
| `scripts/data-generator.sh` | Generate test data for development |
| `scripts/test-tail-links.sh` | Test clickable file links in tail output |
| `scripts/capture-subagent-screenshots.mjs` | Capture subagent screenshots/GIFs for README (uses real Claude sessions) |
| `scripts/mobile-screenshot.mjs` | Capture mobile UI screenshots |
| `scripts/ralph-wizard-start.mjs` | Automate Ralph Loop startup via headless browser |
| `scripts/ralph-wizard-prod.mjs` | Production Ralph wizard with HTTPS support |
| `scripts/watch-subagents.ts` | Real-time subagent transcript watcher (list, follow by session/agent ID) |
| `scripts/claudeman-web.service` | systemd service file for production deployment |

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
