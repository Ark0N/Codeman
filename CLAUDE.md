# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Claudeman is a Claude Code session manager with a web interface and autonomous Ralph Loop. It spawns Claude CLI processes via PTY, streams output in real-time via SSE, and supports scheduled/timed runs.

**Tech Stack**: TypeScript (ES2022/NodeNext, strict mode), Node.js, Fastify, Server-Sent Events, node-pty

**Requirements**: Node.js 18+, Claude CLI (`claude`) installed and available in PATH

## First-Time Setup

```bash
npm install
```

## Commands

**CRITICAL**: `npm run dev` runs CLI help, NOT the web server. Use `npx tsx src/index.ts web` for development.

```bash
npm run build          # Compile TypeScript + copy static files to dist/web/
npm run clean          # Remove dist/

# Start web server (pick one):
npx tsx src/index.ts web           # Dev mode - no build needed (RECOMMENDED)
npx tsx src/index.ts web -p 8080   # Dev mode with custom port
node dist/index.js web             # After npm run build
claudeman web                      # After npm link

# Testing (vitest)
# Note: globals: true configured - no imports needed for describe/it/expect
npm run test                              # Run all tests once
npm run test:watch                        # Watch mode
npm run test:coverage                     # With coverage report
npx vitest run test/session.test.ts       # Single file
npx vitest run -t "should create session" # By pattern

# Test port allocation (add new tests in next available range):
# 3099-3101: quick-start.test.ts
# 3102: session.test.ts
# 3105-3106: scheduled-runs.test.ts
# 3107-3108: sse-events.test.ts
# 3110-3112: edge-cases.test.ts
# 3115-3116: integration-flows.test.ts
# 3120-3121: session-cleanup.test.ts
# (no port): respawn-controller.test.ts, inner-loop-tracker.test.ts, pty-interactive.test.ts (unit tests)
# Next available: 3122+

# Tests mock PTY - no real Claude CLI spawned
# Test timeout: 30s (configured in vitest.config.ts)

# TypeScript checking (no linter configured)
npx tsc --noEmit                          # Type check without building

# Debugging
screen -ls                                # List GNU screen sessions
screen -r <name>                          # Attach to screen session
curl localhost:3000/api/sessions          # Check active sessions
cat ~/.claudeman/state.json | jq .        # View main state
cat ~/.claudeman/state-inner.json | jq .  # View inner loop state
```

## Architecture

### Key Files

| File | Purpose |
|------|---------|
| `src/session.ts` | Core PTY wrapper for Claude CLI. Modes: `runPrompt()`, `startInteractive()`, `startShell()` |
| `src/respawn-controller.ts` | State machine for autonomous session cycling |
| `src/screen-manager.ts` | GNU screen persistence, ghost discovery, 4-strategy kill |
| `src/inner-loop-tracker.ts` | Detects `<promise>PHRASE</promise>`, todos, loop status in output |
| `src/task-tracker.ts` | Parses background task output (agent IDs, status) from Claude CLI |
| `src/state-store.ts` | JSON persistence to `~/.claudeman/` with debounced (100ms) writes |
| `src/web/server.ts` | Fastify REST API + SSE at `/api/events` |
| `src/web/public/app.js` | Frontend: SSE handling, xterm.js, tab management |
| `src/types.ts` | All TypeScript interfaces |

### Data Flow

1. **Session** spawns `claude -p --dangerously-skip-permissions` via `node-pty`
2. PTY output is buffered, ANSI stripped, and parsed for JSON messages
3. **WebServer** broadcasts events to SSE clients at `/api/events`
4. State persists to `~/.claudeman/state.json` via **StateStore**

### Respawn State Machine

```
WATCHING → SENDING_UPDATE → WAITING_UPDATE → SENDING_CLEAR → WAITING_CLEAR → SENDING_INIT → WAITING_INIT → WATCHING
    ↑                                                                                                          |
    └──────────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

Steps can be skipped via config (`sendClear: false`, `sendInit: false`). Idle detection triggers state transitions.

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

// Shell mode (debugging/testing - no Claude CLI)
pty.spawn('bash', [], { ... })
```

### Sending Input to Sessions

There are two methods for sending input to Claude sessions:

#### 1. `session.write(data)` - Direct PTY write
Used by the `/api/sessions/:id/input` API endpoint. Writes directly to PTY.
```typescript
session.write('hello world');  // Text only, no Enter
session.write('\r');           // Enter key separately
```

#### 2. `session.writeViaScreen(data)` - Via GNU screen (RECOMMENDED for programmatic input)
Used by RespawnController, auto-compact, auto-clear. More reliable for Ink/Claude CLI.
```typescript
// Append \r to include Enter - the method handles splitting automatically
session.writeViaScreen('your command here\r');
session.writeViaScreen('/clear\r');
session.writeViaScreen('/init\r');
```

**How `writeViaScreen` works internally** (in `screen-manager.ts:sendInput`):
1. Splits input into text and `\r` (carriage return)
2. Sends text first: `screen -S name -p 0 -X stuff "text"`
3. Sends Enter separately: `screen -S name -p 0 -X stuff "$(printf '\015')"`

**Why separate commands?** Claude CLI uses Ink (React for terminals) which requires text and Enter as separate `screen -X stuff` commands. Combining them doesn't work.

#### API Usage
```bash
# Send text (won't submit until Enter is sent)
curl -X POST localhost:3000/api/sessions/:id/input \
  -H "Content-Type: application/json" \
  -d '{"input": "your prompt here"}'

# Send Enter separately to submit
curl -X POST localhost:3000/api/sessions/:id/input \
  -H "Content-Type: application/json" \
  -d '{"input": "\r"}'
```

**Note**: The API uses `session.write()` which goes to PTY directly. For reliability with Ink, consider using the respawn controller pattern or adding an API endpoint that uses `writeViaScreen()`.

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

Detects Ralph loops and todos inside Claude sessions. **Disabled by default** but auto-enables when any of these patterns are detected in terminal output:
- `/ralph-loop` command
- `<promise>PHRASE</promise>` completion phrases
- `TodoWrite` tool usage
- Iteration patterns (`Iteration 5/50`, `[5/50]`)
- Todo checkboxes (`- [ ]`/`- [x]`) or indicator icons (`☐`/`◐`/`✓`)

See `inner-loop-tracker.ts:shouldAutoEnable()` for detection logic.

API: `GET /api/sessions/:id/inner-state`. UI: collapsible panel below tabs. Use `tracker.enable()` / `tracker.disable()` for programmatic control, or `POST /api/sessions/:id/inner-config` with `{ enabled: boolean }` via API.

### Terminal Display Fix

Tab switch/new session fix: clear xterm → write buffer → resize PTY → Ctrl+L redraw. Uses `pendingCtrlL` Set, triggered on `session:idle`/`session:working` events.

### SSE Events

All events broadcast to `/api/events` with format: `{ type: string, sessionId?: string, data: any }`.

Event prefixes: `session:`, `task:`, `respawn:`, `scheduled:`, `case:`, `screen:`, `init`.

Key events for frontend handling (see `app.js:handleSSEEvent()`):
- `session:idle`, `session:working` - Status indicator updates
- `session:terminal`, `session:clearTerminal` - Terminal content
- `session:completion`, `session:autoClear`, `session:autoCompact` - Lifecycle events
- `session:innerLoopUpdate`, `session:innerTodoUpdate`, `session:innerCompletionDetected` - Ralph tracking

### Frontend (app.js)

Vanilla JS + xterm.js. Key functions:
- `handleSSEEvent()` - Dispatches events to appropriate handlers
- `switchToSession()` - Tab management and terminal focus
- `createSessionTab()` - Tab creation and xterm setup

**60fps Rendering Pipeline**:
- Server batches terminal data every 16ms before broadcasting via SSE
- Client uses `requestAnimationFrame` to batch xterm.js writes
- Prevents UI jank during high-throughput Claude output

### State Store

Writes debounced (100ms) to `~/.claudeman/state.json`. Batches rapid changes.

### TypeScript Config

Module resolution: NodeNext. Target: ES2022. Strict mode enabled. See `tsconfig.json` for full settings.

## Adding New Features

- **API endpoint**: Add types in `types.ts`, route in `server.ts:buildServer()`, use `createErrorResponse()` for errors
- **SSE event**: Emit via `broadcast()` in server.ts, handle in `app.js:handleSSEEvent()` switch
- **Session event**: Add to `SessionEvents` interface in `session.ts`, emit via `this.emit()`, subscribe in server.ts, handle in frontend

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
npx agent-browser open http://localhost:3000
npx agent-browser wait --load networkidle
npx agent-browser snapshot
npx agent-browser find text "Run Claude" click
npx agent-browser close
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
| POST | `/api/sessions/:id/respawn/enable` | Enable respawn with config + optional timer |
| PUT | `/api/sessions/:id/respawn/config` | Update config on running respawn |
| POST | `/api/sessions/:id/inner-config` | Configure Ralph Wiggum loop settings |
| GET | `/api/sessions/:id/inner-state` | Get Ralph loop state + todos |
| POST | `/api/sessions/:id/auto-compact` | Configure auto-compact threshold |
| POST | `/api/sessions/:id/auto-clear` | Configure auto-clear threshold |
| POST | `/api/quick-start` | Create case + start interactive session |
| GET | `/api/cases` | List available cases |
| POST | `/api/cases` | Create new case |
| GET | `/api/screens` | List screen sessions with stats |

## CLI Commands (when using `claudeman` globally)

```bash
claudeman web [-p PORT]              # Start web interface
claudeman start [--dir PATH]         # Start Claude session
claudeman list                       # List sessions
claudeman task add "PROMPT"          # Add task to queue
claudeman ralph start [--min-hours N] # Start autonomous loop
claudeman status                     # Overall status
```

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl+Enter` | Run Claude (create case + interactive session) |
| `Ctrl+W` | Close current session |
| `Ctrl+Tab` | Switch to next session |
| `Ctrl+K` | Kill all sessions |
| `Ctrl+L` | Clear terminal |
| `Ctrl++/-` | Increase/decrease font size |
| `Ctrl+?` | Show keyboard shortcuts help |
| `Escape` | Close panels and modals |

## State Files

| File | Purpose |
|------|---------|
| `~/.claudeman/state.json` | Sessions, tasks, config |
| `~/.claudeman/state-inner.json` | Inner loop/todo state (separate to reduce writes) |
| `~/.claudeman/screens.json` | Screen session metadata |

Cases created in `~/claudeman-cases/` by default.

## Documentation

Extended documentation is available in the `docs/` directory:

| Document | Description |
|----------|-------------|
| [`docs/ralph-wiggum-guide.md`](docs/ralph-wiggum-guide.md) | Complete Ralph Wiggum loop guide: official plugin reference, best practices, prompt templates, troubleshooting |
| [`docs/claude-code-hooks-reference.md`](docs/claude-code-hooks-reference.md) | Official Claude Code hooks documentation: all events, configuration, examples |

### Quick Reference: Ralph Wiggum Loops

Ralph Wiggum is an autonomous loop technique that lets Claude work iteratively until completion criteria are met.

**Core Pattern**: `<promise>PHRASE</promise>` - The completion signal that tells the loop to stop.

**Official Plugin Commands**:
```bash
/ralph-loop "<prompt>" --max-iterations 50 --completion-promise "COMPLETE"
/cancel-ralph
```

**Best Practices** (see full guide for details):
1. **Always set `--max-iterations`** - Safety limit to prevent runaway costs
2. **Define clear success criteria** - Tests pass, lint clean, specific outputs
3. **Use test-driven verification** - Built-in feedback loop
4. **Include escape hatches** - "If stuck after N iterations, document and stop"
5. **Commit frequently** - Recovery points in git history

**Claudeman Implementation**: The `InnerLoopTracker` class (`src/inner-loop-tracker.ts`) detects Ralph patterns in Claude output and tracks loop state, todos, and completion phrases. It auto-enables when Ralph-related patterns are detected.

**API**:
- `GET /api/sessions/:id/inner-state` - Loop state and todos
- `POST /api/sessions/:id/inner-config` - Configure tracker

**SSE Events**:
- `session:innerLoopUpdate` - Loop state changes
- `session:innerTodoUpdate` - Todo list updates
- `session:innerCompletionDetected` - Completion phrase detected

### External References

**Official Anthropic Documentation**:
- [Claude Code Hooks](https://code.claude.com/docs/en/hooks)
- [Claude Code Best Practices](https://www.anthropic.com/engineering/claude-code-best-practices)
- [Ralph Wiggum Plugin](https://github.com/anthropics/claude-code/tree/main/plugins/ralph-wiggum)

**Community Resources**:
- [Awesome Claude - Ralph Wiggum](https://awesomeclaude.ai/ralph-wiggum)
- [Claude Fast - Autonomous Loops](https://claudefa.st/blog/guide/mechanics/autonomous-agent-loops)
