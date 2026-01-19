# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Claudeman is a Claude Code session manager with a web interface and autonomous Ralph Loop. It spawns Claude CLI processes via PTY, streams output in real-time via SSE, and supports scheduled/timed runs.

**Tech Stack**: TypeScript (ES2022/NodeNext, strict mode), Node.js, Fastify, Server-Sent Events, node-pty

**Requirements**: Node.js 18+, Claude CLI (`claude`) installed and available in PATH

## Commands

```bash
npm run build          # Compile TypeScript + copy static files to dist/web/
npm run clean          # Remove dist/

# Start web server (pick one):
npx tsx src/index.ts web           # Dev mode - no build needed (RECOMMENDED)
npx tsx src/index.ts web -p 8080   # Dev mode with custom port
node dist/index.js web             # After npm run build
claudeman web                      # After npm link

# ⚠️  GOTCHA: `npm run dev` runs CLI help, NOT the web server!
#     Always use `npx tsx src/index.ts web` for development

# Testing (vitest - tests run against WebServer, no real Claude CLI spawned)
npm run test                              # Run all tests once
npm run test:watch                        # Watch mode
npm run test:coverage                     # With coverage report
npx vitest run test/session.test.ts       # Single file
npx vitest run -t "should create session" # By pattern
# Tests use different ports (3101-3108) to avoid conflicts

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
```

### Data Flow

1. **Session** spawns `claude -p --dangerously-skip-permissions` via `node-pty`
2. PTY output is buffered, ANSI stripped, and parsed for JSON messages
3. **WebServer** broadcasts events to SSE clients at `/api/events`
4. State persists to `~/.claudeman/state.json` via **StateStore**

### Key Components

- **Session** (`src/session.ts`): Wraps Claude CLI as PTY subprocess. Two modes: `runPrompt(prompt)` for one-shot, `startInteractive()` for persistent terminal. Emits events: `output`, `terminal`, `message`, `completion`, `exit`, `idle`, `working`, `autoClear`, `autoCompact`, `clearTerminal`, `innerLoopUpdate`, `innerTodoUpdate`, `innerCompletionDetected`.

- **RespawnController** (`src/respawn-controller.ts`): State machine that keeps sessions productive. Detects idle → sends update prompt → optionally `/clear` → optionally `/init` → optionally kickstart prompt → repeats. State flow: `WATCHING → SENDING_UPDATE → WAITING_UPDATE → SENDING_CLEAR → WAITING_CLEAR → SENDING_INIT → WAITING_INIT → MONITORING_INIT → (optional) SENDING_KICKSTART → WAITING_KICKSTART → WATCHING`

- **ScreenManager** (`src/screen-manager.ts`): Wraps sessions in GNU screen for persistence across server restarts. On startup, reconciles with `screen -ls` to restore sessions and discovers unknown "ghost" screens. Uses 4-strategy kill process to prevent orphaned claude processes.

- **WebServer** (`src/web/server.ts`): Fastify server with REST API (`/api/*`) + SSE (`/api/events`). Wires session events to SSE broadcast.

- **InnerLoopTracker** (`src/inner-loop-tracker.ts`): Detects Ralph Wiggum loops and todo lists running inside Claude Code sessions by parsing terminal output. Emits `loopUpdate`, `todoUpdate`, `completionDetected` events. Detection patterns:
  - Completion phrases: `<promise>PHRASE</promise>`
  - Todo items: checkbox format (`- [ ]`/`- [x]`), indicator icons (`☐`/`◐`/`✓`), status parentheses
  - Loop status: cycle counts, elapsed time, start/completion indicators

### Session Modes

- **One-Shot** (`runPrompt(prompt)`): Single prompt execution, emits completion, exits
- **Interactive** (`startInteractive()`): Persistent PTY terminal with resize support
- **Shell** (`startShell()`): Plain bash/zsh terminal without Claude

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

### Idle Detection

**RespawnController** uses a hybrid approach:
1. Primary: Looks for `↵ send` indicator (Claude's suggestion prompt)
2. Fallback: Prompt characters (`❯`, `\u276f`, `⏵`) + timeout (10s default)
3. Working detection: Patterns like `Thinking`, `Writing`, `Running`, etc.

**Session** emits `idle` and `working` events based on prompt detection and activity timeout (2s after prompt character).

### Token Tracking

- **One-shot mode**: Uses `--output-format stream-json` for detailed token usage from JSON
- **Interactive mode**: Parses tokens from Claude's status line (e.g., "123.4k tokens"), estimates 60/40 input/output split

### Auto-Compact & Auto-Clear

Sessions support automatic context management when token thresholds are reached:

- **Auto-Compact** (default: 110k tokens): Sends `/compact` command with optional prompt to summarize context
- **Auto-Clear** (default: 140k tokens): Sends `/clear` to reset context entirely

Both wait for Claude to be idle before executing. Auto-compact runs first if both are enabled. Configured via `session.setAutoCompact(enabled, threshold?, prompt?)` and `session.setAutoClear(enabled, threshold?)`.

### Inner Loop Tracking

When Claude Code runs inside a claudeman session, it may run its own Ralph Wiggum loops or use the TodoWrite tool. The **InnerLoopTracker** parses terminal output to detect:

**Completion Phrases:**
```
<promise>COMPLETE</promise>
<promise>TIME_COMPLETE</promise>
<promise>CUSTOM_PHRASE</promise>
```

**Todo Items (multiple formats):**
```
- [ ] Pending task          # Checkbox format
- [x] Completed task
Todo: ☐ Pending task        # Indicator format
Todo: ◐ In progress task
Todo: ✓ Completed task
- Task name (in_progress)   # Status parentheses
```

**Loop Status:**
```
Loop started at 2024-01-15
Elapsed: 2.5 hours
cycle #5
```

**API Endpoint:**
```bash
curl localhost:3000/api/sessions/:id/inner-state
# Returns: { loop: InnerLoopState, todos: InnerTodoItem[], todoStats: {...} }
```

**UI:** Collapsible panel below session tabs shows loop status and todo progress. Auto-hides when no inner state is detected.

### Terminal Display Fix (Tab Switch & New Session)

When switching tabs or creating new sessions, terminal may be rendered at wrong size. Fix sequence:
1. Clear and reset xterm
2. Write terminal buffer
3. Send resize to update PTY dimensions
4. Send Ctrl+L (`\x0c`) to trigger Claude CLI redraw

Uses `pendingCtrlL` Set to track sessions needing the fix. Waits for `session:idle` or `session:working` SSE event before sending resize + Ctrl+L.

### SSE Events

All events broadcast to `/api/events` with format: `{ type: string, sessionId?: string, data: any }`.

Event prefixes: `session:`, `task:`, `respawn:`, `scheduled:`, `case:`, `screen:`, `init`. Key events: `session:idle`, `session:working`, `session:terminal`, `session:clearTerminal`, `session:completion`, `session:autoClear`, `session:autoCompact`, `session:innerLoopUpdate`, `session:innerTodoUpdate`, `session:innerCompletionDetected`.

### Frontend (app.js)

The frontend uses vanilla JS with xterm.js. Key patterns:
- **SSE handling**: `handleSSEEvent()` switch statement dispatches all event types
- **Tab management**: `switchToSession()` handles terminal buffer restore + resize
- **60fps rendering**: Server batches at 16ms intervals, client uses `requestAnimationFrame`

### State Store Debouncing

State writes to `~/.claudeman/state.json` are debounced (100ms) to prevent excessive disk I/O during rapid updates. The `StateStore` class batches rapid state changes and writes once after activity settles.

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

### Session Limits
- `MAX_CONCURRENT_SESSIONS = 50` prevents unbounded session creation
- Limit enforced on `/api/sessions`, `/api/run`, `/api/quick-start`, and scheduled runs

### Kill Process (4 Strategies)
When killing a screen session, `killScreen()` uses multiple strategies to ensure no orphaned processes:
1. **Child PIDs**: Recursively find and kill all child processes (SIGTERM then SIGKILL)
2. **Process Group**: Kill entire process group (`kill -TERM -$PID`) to catch orphans
3. **Screen Name**: `screen -S <name> -X quit` to cleanly terminate screen
4. **Direct Kill**: SIGKILL the screen PID as final fallback

### Ghost Screen Discovery
On server startup, `reconcileScreens()` discovers unknown claudeman screens from `screen -ls` output. This prevents "ghost" screens that persist if `screens.json` is lost or corrupted.

### Cleanup Function
`cleanupSession()` in server.ts provides comprehensive cleanup:
- Stops and removes respawn controller + listeners
- Clears respawn timers
- Clears terminal/output/task batches
- Removes session event listeners
- Stops session and kills screen

## Buffer Limits

Long-running sessions are supported with automatic trimming:

| Buffer | Max Size | Trim To |
|--------|----------|---------|
| Terminal | 5MB | 4MB |
| Text output | 2MB | 1.5MB |
| Messages | 1000 | 800 |
| Line buffer | 64KB | (flushed every 100ms) |
| Respawn buffer | 1MB | 512KB |

## E2E Testing (agent-browser)

Browser automation for testing the web UI. See README.md for full setup.

```bash
# Quick test sequence
npx agent-browser open http://localhost:3000
npx agent-browser wait --load networkidle
npx agent-browser snapshot
npx agent-browser find text "Run Claude" click
npx agent-browser wait 2000
npx agent-browser snapshot
npx agent-browser close
```

Full test plan available at `.claude/skills/e2e-test.md`.

## Notes

- State persists to `~/.claudeman/state.json`, `~/.claudeman/state-inner.json`, and `~/.claudeman/screens.json`
- Inner loop/todo state persists separately in `state-inner.json` to reduce write frequency
- Cases created in `~/claudeman-cases/` by default
