# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Claudeman is a Claude Code session manager with a web interface and autonomous Ralph Loop. It spawns Claude CLI processes via PTY, streams output in real-time via SSE, and supports scheduled/timed runs.

**Tech Stack**: TypeScript (ES2022/NodeNext, strict mode), Node.js, Fastify, Server-Sent Events, node-pty

**Requirements**: Node.js 18+, Claude CLI (`claude`) installed and available in PATH

## Commands

**GOTCHA**: `npm run dev` runs CLI help, NOT the web server. Always use `npx tsx src/index.ts web` for development.

```bash
npm run build          # Compile TypeScript + copy static files to dist/web/
npm run clean          # Remove dist/

# Start web server (pick one):
npx tsx src/index.ts web           # Dev mode - no build needed (RECOMMENDED)
npx tsx src/index.ts web -p 8080   # Dev mode with custom port
node dist/index.js web             # After npm run build
claudeman web                      # After npm link

# Testing (vitest - tests run against WebServer, no real Claude CLI spawned)
npm run test                              # Run all tests once
npm run test:watch                        # Watch mode
npm run test:coverage                     # With coverage report
npx vitest run test/session.test.ts       # Single file
npx vitest run -t "should create session" # By pattern
# Tests use ports 3101-3108 to avoid conflicts with dev server (3000)

# TypeScript checking (no linter configured)
npx tsc --noEmit                          # Type check without building

# Debugging
screen -ls                                # List GNU screen sessions
screen -r <name>                          # Attach to screen session
curl localhost:3000/api/sessions          # Check active sessions
```

## Architecture

```
src/
├── index.ts              # CLI entry (commander)
├── cli.ts                # CLI commands
├── session.ts            # Core: PTY wrapper for Claude CLI + token tracking
├── session-manager.ts    # Manages multiple sessions
├── screen-manager.ts     # GNU screen persistence + process stats
├── respawn-controller.ts # Auto-respawn state machine
├── ralph-loop.ts         # Autonomous task assignment
├── task.ts               # Task class implementation
├── task-queue.ts         # Priority queue with dependencies
├── task-tracker.ts       # Background task detection from terminal output
├── inner-loop-tracker.ts # Detect Ralph loops and todos inside Claude sessions
├── state-store.ts        # Persistence to ~/.claudeman/state.json
├── types.ts              # All TypeScript interfaces
├── web/
│   ├── server.ts         # Fastify REST API + SSE + session restoration
│   └── public/           # Vanilla JS frontend (xterm.js, no bundler)
│       ├── app.js        # Main app logic, SSE handling, tab management
│       ├── styles.css    # All styles including responsive/mobile
│       └── index.html    # Single page with modal templates
└── templates/
    └── claude-md.ts      # CLAUDE.md generator for new cases

test/
├── session.test.ts           # Core session creation, lifecycle, PTY behavior
├── pty-interactive.test.ts   # Interactive mode, terminal input/output
├── respawn-controller.test.ts # Respawn state machine, idle detection
├── inner-loop-tracker.test.ts # Ralph loop and todo detection parsing
├── quick-start.test.ts       # Quick-start API endpoint
├── scheduled-runs.test.ts    # Timed/scheduled session runs
├── sse-events.test.ts        # Server-Sent Events broadcasting
├── integration-flows.test.ts # Multi-step workflow tests
├── session-cleanup.test.ts   # Resource cleanup, buffer trimming
└── edge-cases.test.ts        # Error handling, boundary conditions
```

### Data Flow

1. **Session** spawns `claude -p --dangerously-skip-permissions` via `node-pty`
2. PTY output is buffered, ANSI stripped, and parsed for JSON messages
3. **WebServer** broadcasts events to SSE clients at `/api/events`
4. State persists to `~/.claudeman/state.json` via **StateStore**

### Key Components

| Component | File | Purpose |
|-----------|------|---------|
| Session | `session.ts` | PTY wrapper for Claude CLI. Modes: `runPrompt()`, `startInteractive()`, `startShell()` |
| RespawnController | `respawn-controller.ts` | State machine: watching → update → clear → init → monitor → kickstart → repeat |
| ScreenManager | `screen-manager.ts` | GNU screen persistence, ghost discovery, 4-strategy kill |
| WebServer | `web/server.ts` | Fastify REST + SSE at `/api/events` |
| InnerLoopTracker | `inner-loop-tracker.ts` | Detects `<promise>PHRASE</promise>`, todos, loop status in output |

### Session Modes

Sessions have a `mode` property (`SessionMode` type):
- **`'claude'`**: Runs Claude CLI for AI interactions (default)
- **`'shell'`**: Runs a plain bash shell for debugging/testing

## Code Patterns

### Pre-compiled Regex Patterns

For performance, regex patterns that are used frequently should be compiled once at module level:

```typescript
// Good - compile once
const ANSI_ESCAPE_PATTERN = /\x1b\[[0-9;]*m/g;
const TOKEN_PATTERN = /(\d+(?:\.\d+)?)\s*([kKmM])?\s*tokens/;

// Bad - recompiles on each call
function parse(line: string) {
  return line.replace(/\x1b\[[0-9;]*m/g, '');
}
```

### Claude Message Parsing

Claude CLI outputs newline-delimited JSON. Strip ANSI codes before parsing:

```typescript
const cleanLine = line.replace(ANSI_ESCAPE_PATTERN, '');
const msg = JSON.parse(cleanLine) as ClaudeMessage;
// msg.type: 'system' | 'assistant' | 'user' | 'result'
// msg.message?.content: Array<{ type: 'text', text: string }>
// msg.total_cost_usd: number (on result messages)
```

### PTY Spawn Modes

```typescript
// One-shot mode (JSON output for token tracking)
pty.spawn('claude', ['-p', '--dangerously-skip-permissions', '--output-format', 'stream-json', prompt], { ... })

// Interactive mode (tokens parsed from status line)
pty.spawn('claude', ['--dangerously-skip-permissions'], { ... })
```

### Screen Input for Ink/Claude CLI

Claude CLI uses Ink (React for terminals) which has specific input handling. When sending programmatic input via `screen -X stuff`:

**IMPORTANT**: Text and Enter key MUST be sent as separate commands:
```bash
# Correct - two separate commands
screen -S claudeman-xxx -p 0 -X stuff "hello world"
screen -S claudeman-xxx -p 0 -X stuff "$(printf '\015')"

# Wrong - doesn't work with Ink
screen -S claudeman-xxx -p 0 -X stuff "$(printf 'hello world\015')"
```

The `\015` (octal) is carriage return (ASCII 13), which Ink interprets as `key.return` for submission. Use `writeViaScreen()` method for programmatic input that needs Enter key.

### Idle Detection

**RespawnController**: Primary `↵ send` indicator, fallback prompt chars (`❯`, `⏵`) + 10s timeout. Working patterns: `Thinking`, `Writing`, `Running`.
**Session**: emits `idle`/`working` events on prompt detection + 2s activity timeout.

### Token Tracking

- **One-shot mode**: Uses `--output-format stream-json` for detailed token usage from JSON
- **Interactive mode**: Parses tokens from Claude's status line (e.g., "123.4k tokens"), estimates 60/40 input/output split

### Auto-Compact & Auto-Clear

| Feature | Default Threshold | Action |
|---------|------------------|--------|
| Auto-Compact | 110k tokens | `/compact` with optional prompt |
| Auto-Clear | 140k tokens | `/clear` to reset context |

Both wait for idle. Configure via `session.setAutoCompact()` / `session.setAutoClear()`.

### Inner Loop Tracking

Detects Ralph loops and todos inside Claude sessions. Patterns: `<promise>PHRASE</promise>`, checkbox todos (`- [ ]`/`- [x]`), icons (`☐`/`◐`/`✓`), cycle counts. API: `GET /api/sessions/:id/inner-state`. UI: collapsible panel below tabs, auto-hides when empty.

### Terminal Display Fix

Tab switch/new session fix: clear xterm → write buffer → resize PTY → Ctrl+L redraw. Uses `pendingCtrlL` Set, triggered on `session:idle`/`session:working` events.

### SSE Events

All events broadcast to `/api/events` with format: `{ type: string, sessionId?: string, data: any }`.

Event prefixes: `session:`, `task:`, `respawn:`, `scheduled:`, `case:`, `screen:`, `init`. Key events: `session:idle`, `session:working`, `session:terminal`, `session:clearTerminal`, `session:completion`, `session:autoClear`, `session:autoCompact`, `session:innerLoopUpdate`, `session:innerTodoUpdate`, `session:innerCompletionDetected`.

### Frontend (app.js)

Vanilla JS + xterm.js. `handleSSEEvent()` dispatches events, `switchToSession()` manages tabs. 60fps: server batches 16ms, client uses `requestAnimationFrame`.

### State Store

Writes debounced (100ms) to `~/.claudeman/state.json`. Batches rapid changes.

## Adding New Features

### New API Endpoint
1. Add types to `src/types.ts`
2. Add route in `src/web/server.ts` within `buildServer()`
3. Use `createErrorResponse()` for errors

### New SSE Event
1. Emit from component via `broadcast()` in server.ts
2. Handle in `src/web/public/app.js` `handleSSEEvent()` switch

### New Session Event
1. Add to `SessionEvents` interface in `src/session.ts`
2. Emit via `this.emit()`
3. Subscribe in `src/web/server.ts` when wiring session to SSE
4. Handle in frontend SSE listener

## Session Lifecycle & Cleanup

- **Limit**: `MAX_CONCURRENT_SESSIONS = 50`
- **Kill** (`killScreen()`): child PIDs → process group → screen quit → SIGKILL
- **Ghost discovery**: `reconcileScreens()` finds orphaned screens on startup
- **Cleanup** (`cleanupSession()`): stops respawn, clears buffers/timers, kills screen

## Buffer Limits

Long-running sessions are supported with automatic trimming:

| Buffer | Max Size | Trim To |
|--------|----------|---------|
| Terminal | 5MB | 4MB |
| Text output | 2MB | 1.5MB |
| Messages | 1000 | 800 |
| Line buffer | 64KB | (flushed every 100ms) |
| Respawn buffer | 1MB | 512KB |

## E2E Testing

Uses `agent-browser` for web UI automation. Full test plan: `.claude/skills/e2e-test.md`

```bash
npx agent-browser open http://localhost:3000 && npx agent-browser snapshot
```

## API Routes Quick Reference

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/events` | SSE stream for real-time updates |
| GET | `/api/status` | Full application state |
| GET/POST/DELETE | `/api/sessions` | List/create/kill-all sessions |
| GET/DELETE | `/api/sessions/:id` | Get/delete specific session |
| POST | `/api/sessions/:id/input` | Send input to session PTY |
| POST | `/api/sessions/:id/resize` | Resize terminal (cols, rows) |
| POST | `/api/sessions/:id/interactive` | Start interactive mode |
| POST | `/api/sessions/:id/respawn/start` | Start respawn controller |
| POST | `/api/sessions/:id/respawn/stop` | Stop respawn controller |
| POST | `/api/quick-start` | Create case + start interactive session |
| GET | `/api/cases` | List available cases |
| POST | `/api/cases` | Create new case |
| GET | `/api/screens` | List screen sessions with stats |

## Notes

- State persists to `~/.claudeman/state.json`, `~/.claudeman/state-inner.json`, and `~/.claudeman/screens.json`
- Inner loop/todo state persists separately in `state-inner.json` to reduce write frequency
- Cases created in `~/claudeman-cases/` by default
