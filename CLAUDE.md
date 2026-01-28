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

**Version**: 0.1409 (must match `package.json`)

## Project Overview

Claudeman is a Claude Code session manager with web interface and autonomous Ralph Loop. Spawns Claude CLI via PTY, streams via SSE, supports respawn cycling for 24+ hour autonomous runs.

**Tech Stack**: TypeScript (ES2022/NodeNext, strict mode), Node.js, Fastify, node-pty, xterm.js

**TypeScript Strictness** (see `tsconfig.json`): `noUnusedLocals`, `noUnusedParameters`, `noImplicitReturns`, `noImplicitOverride`, `noFallthroughCasesInSwitch`, `allowUnreachableCode: false`, `allowUnusedLabels: false`

**Requirements**: Node.js 18+, Claude CLI, GNU Screen

## Commands

**CRITICAL**: `npm run dev` shows CLI help, NOT the web server.

```bash
# Development
npx tsx src/index.ts web           # Dev server (RECOMMENDED)
npx tsx src/index.ts web --https   # With TLS for notifications
npm run typecheck                  # Type check

# Testing
npx vitest run                     # All tests
npx vitest run test/<file>.test.ts # Single file
npm run test:coverage              # With coverage report
npm run test:e2e                   # Browser E2E (run `npx playwright install chromium` first)

# Production
npm run build
systemctl --user restart claudeman-web
journalctl --user -u claudeman-web -f
```

## Binaries

| Binary | Purpose |
|--------|---------|
| `claudeman` | Main CLI and web server |
| `claudeman-mcp` | MCP server for Claude Desktop integration |

## Architecture

### Core Files

| File | Purpose |
|------|---------|
| `src/session.ts` | PTY wrapper: `runPrompt()`, `startInteractive()`, `startShell()` |
| `src/screen-manager.ts` | GNU screen persistence, ghost discovery |
| `src/session-manager.ts` | Session lifecycle, cleanup |
| `src/respawn-controller.ts` | State machine for autonomous cycling |
| `src/ralph-tracker.ts` | Detects `<promise>PHRASE</promise>`, todos |
| `src/plan-orchestrator.ts` | Multi-agent plan generation |
| `src/web/server.ts` | Fastify REST API + SSE at `/api/events` |
| `src/web/public/app.js` | Frontend: xterm.js, tab management, subagent windows |
| `src/types.ts` | All TypeScript interfaces |

### Data Flow

1. Session spawns `claude --dangerously-skip-permissions` via node-pty
2. PTY output buffered, ANSI stripped, parsed for JSON messages
3. WebServer broadcasts to SSE clients at `/api/events`
4. State persists to `~/.claudeman/state.json` via StateStore

### Key Patterns

**Input to sessions**: Use `session.writeViaScreen()` for programmatic input (respawn, auto-compact). Text and Enter sent as separate `screen -X stuff` commands due to Ink's requirements. All prompts must be single-line.

**Idle detection**: Multi-layer (completion message → AI check → output silence → token stability). See `docs/respawn-state-machine.md`.

**Token tracking**: Interactive mode parses status line ("123.4k tokens"), estimates 60/40 input/output split.

**Memory leak prevention**: Frontend runs long; clear all Maps/timers on SSE reconnect in `handleInit()`.

## Adding Features

- **API endpoint**: Types in `types.ts`, route in `server.ts:buildServer()`, use `createErrorResponse()`
- **SSE event**: Emit via `broadcast()`, handle in `app.js:handleSSEEvent()`
- **Session setting**: Add to `SessionState` in `types.ts`, include in `session.toState()`, call `persistSessionState()`
- **New test**: Pick unique port (see below), add port comment to test file header

## State Files

| File | Purpose |
|------|---------|
| `~/.claudeman/state.json` | Sessions, settings, tokens, respawn config |
| `~/.claudeman/screens.json` | Screen metadata for recovery |
| `~/.claudeman/settings.json` | User preferences |

## Testing

**Port allocation**: E2E tests use centralized ports in `test/e2e/e2e.config.ts` (E2E_PORTS: 3183-3190). Unit/integration tests pick unique ports manually (3099-3157). Search `const PORT =` or `TEST_PORT` in test files to see used ports. **Next available: 3192**

**E2E tests**: Use Playwright. Run `npx playwright install chromium` first. See `test/e2e/fixtures/` for helpers. E2E config provides ports, timeouts, and helpers.

**Test config**: Vitest runs with `globals: true` (no imports needed for `describe`/`it`/`expect`) and `fileParallelism: false` (files run sequentially to respect screen limits). Unit test timeout is 30s, teardown timeout is 60s. E2E tests have longer timeouts defined in `test/e2e/e2e.config.ts` (90s test, 30s session creation).

**Test safety**: `test/setup.ts` provides:
- Screen concurrency limiter (max 10)
- Pre-existing screen protection (never kills screens present before tests)
- Tracked resource cleanup (only kills screens/processes tests register)
- Safe to run from within Claudeman-managed sessions

Respawn tests use MockSession to avoid spawning real Claude processes.

## Debugging

```bash
screen -ls                          # List screens
screen -r <name>                    # Attach (Ctrl+A D to detach)
curl localhost:3000/api/sessions    # Check sessions
curl localhost:3000/api/status | jq # Full app state
cat ~/.claudeman/state.json | jq    # View persisted state
```

## Performance Constraints

The app must stay fast with 20 sessions and 50 agent windows:
- 60fps terminal (16ms batching + `requestAnimationFrame`)
- Auto-trimming buffers (2MB terminal max)
- Debounced state persistence (500ms)
- SSE batching (16ms)

## Buffer Limits

| Buffer | Max | Trim To |
|--------|-----|---------|
| Terminal | 2MB | 1.5MB |
| Text output | 1MB | 768KB |
| Messages | 1000 | 800 |

## Where to Find More Information

| Topic | Location |
|-------|----------|
| **Respawn state machine** | `docs/respawn-state-machine.md` |
| **Spawn agent protocol** | `docs/spawn-protocol.md` |
| **Ralph Loop guide** | `docs/ralph-wiggum-guide.md` |
| **Claude Code hooks** | `docs/claude-code-hooks-reference.md` |
| **Browser/E2E testing** | `docs/browser-testing-guide.md` |
| **API routes** | `src/web/server.ts:buildServer()` or README.md |
| **SSE events** | Search `broadcast(` in `server.ts` |
| **CLI commands** | `claudeman --help` |
| **Frontend patterns** | `src/web/public/app.js` (subagent windows, notifications) |
| **Session modes** | `SessionMode` type in `src/types.ts` |
| **Error codes** | `createErrorResponse()` in `src/types.ts` |
| **Test fixtures** | `test/e2e/fixtures/` |
| **Test utilities** | `test/respawn-test-utils.ts` |
| **Keyboard shortcuts** | README.md or App Settings in web UI |
