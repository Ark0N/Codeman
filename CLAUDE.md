# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Claudeman is a Claude Code session manager with a web interface and autonomous Ralph Loop. It spawns Claude CLI processes via PTY, streams output in real-time via SSE, and supports scheduled/timed runs.

**Tech Stack**: TypeScript (ES2022/NodeNext), Node.js, Fastify, Server-Sent Events, node-pty

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

# NOTE: `npm run dev` runs the CLI (shows help), NOT the web server
# You must specify the `web` subcommand to start the server

# Testing
npm run test                              # Run all tests once
npm run test:watch                        # Watch mode
npm run test:coverage                     # With coverage report
npx vitest run test/session.test.ts       # Single file
npx vitest run -t "should create session" # By pattern
```

## Architecture

```
src/
├── index.ts              # CLI entry point (commander)
├── cli.ts                # CLI command implementations
├── session.ts            # Core: PTY wrapper for Claude CLI + token tracking
├── session-manager.ts    # Manages multiple sessions
├── screen-manager.ts     # GNU screen session persistence + process stats
├── respawn-controller.ts # Auto-respawn state machine
├── task-tracker.ts       # Background task detection and tree display
├── ralph-loop.ts         # Autonomous task assignment
├── task.ts / task-queue.ts # Priority queue with dependencies
├── state-store.ts        # Persistence to ~/.claudeman/state.json
├── types.ts              # All TypeScript interfaces
├── web/
│   ├── server.ts         # Fastify REST API + SSE + session restoration
│   └── public/           # Static frontend files
└── templates/
    └── claude-md.ts      # CLAUDE.md generator for new cases
```

### Data Flow

1. **Session** spawns `claude -p --dangerously-skip-permissions` via `node-pty`
2. PTY output is buffered, ANSI stripped, and parsed for JSON messages
3. **WebServer** broadcasts events to SSE clients at `/api/events`
4. State persists to `~/.claudeman/state.json` via **StateStore**

### Key Components

- **Session** (`src/session.ts`): Wraps Claude CLI as PTY subprocess. Two modes: `runPrompt(prompt)` for one-shot execution, `startInteractive()` for persistent terminal. Emits `output`, `terminal`, `message`, `completion`, `exit`, `idle`, `working`, `autoClear` events. Maintains terminal buffer for reconnections. Includes buffer management for long-running sessions (12-24+ hours) with automatic trimming. Tracks input/output tokens and supports auto-clear at configurable threshold.

- **TaskTracker** (`src/task-tracker.ts`): Detects Claude's background Task tool usage from JSON output. Builds a tree of parent-child task relationships. Emits `taskCreated`, `taskUpdated`, `taskCompleted`, `taskFailed` events. Used by Session to track background work.

- **RespawnController** (`src/respawn-controller.ts`): State machine that keeps interactive sessions productive. Detects idle → sends update prompt → optionally `/clear` → optionally `/init` → repeats. Configurable timeouts, prompts, and step toggles.

- **RalphLoop** (`src/ralph-loop.ts`): Autonomous task assignment controller. Monitors sessions for idle state, assigns tasks from queue, detects completion via `<promise>PHRASE</promise>` markers. Supports time-aware loops with minimum duration.

- **WebServer** (`src/web/server.ts`): Fastify server with REST API + SSE. Manages sessions, scheduled runs, respawn controllers, and case directories. Broadcasts all events to connected clients. Restores screen sessions on startup.

- **ScreenManager** (`src/screen-manager.ts`): Manages GNU screen sessions for persistent terminals. Tracks screens in `~/.claudeman/screens.json`. Provides process stats (memory, CPU, children) and reconciliation for dead screens. Screens survive server restarts.

### Type Definitions

All TypeScript interfaces are centralized in `src/types.ts`:
- `SessionState`, `TaskState`, `RalphLoopState` - Core state types
- `RespawnConfig`, `AppConfig` - Configuration types
- `ApiErrorCode`, `createErrorResponse()` - Consistent API error handling
- Request/Response types for API endpoints (`CreateSessionRequest`, `QuickStartResponse`, etc.)

### Session Modes

**One-Shot Mode** (`runPrompt(prompt)`):
- Execute a single prompt and receive completion event
- Used for scheduled runs and quick API calls
- Session exits after prompt completes

**Interactive Mode** (`startInteractive()`):
- Persistent PTY terminal with full Claude CLI access
- Supports terminal resize for proper formatting
- Terminal buffer persisted for client reconnections
- Works with RespawnController for autonomous cycling

**Shell Mode** (`startShell()`):
- Plain bash/zsh terminal without Claude
- Useful for running commands alongside Claude sessions
- Same PTY features (resize, buffer persistence)

## Code Patterns

### Claude Message Parsing

Claude CLI outputs newline-delimited JSON. Strip ANSI codes before parsing:

```typescript
const cleanLine = line.replace(/\x1b\[[0-9;]*m/g, '');
const msg = JSON.parse(cleanLine) as ClaudeMessage;
// msg.type: 'system' | 'assistant' | 'user' | 'result'
// msg.message?.content: Array<{ type: 'text', text: string }>
// msg.total_cost_usd: number (on result messages)
```

### PTY Spawn Modes

**One-shot mode** (prompt execution with JSON output for token tracking):
```typescript
pty.spawn('claude', ['-p', '--dangerously-skip-permissions', '--output-format', 'stream-json', prompt], { ... })
```

**Interactive mode** (persistent terminal, tokens parsed from status line):
```typescript
pty.spawn('claude', ['--dangerously-skip-permissions'], { ... })
```

### Idle Detection

Session detects idle by watching for prompt character (`❯` or `\u276f`) and waiting 2 seconds without activity. RespawnController uses the same patterns plus spinner characters to detect working state.

### Long-Running Session Support

Sessions are optimized for 12-24+ hour runs with automatic buffer management:

**Buffer Limits:**
- Terminal buffer: 5MB max, trims to 4MB when exceeded
- Text output: 2MB max, trims to 1.5MB when exceeded
- Messages: 1000 max, keeps most recent 800 when exceeded

**Performance Optimizations:**
- Server-side terminal batching at 60fps (16ms intervals)
- Client-side requestAnimationFrame batching for smooth rendering
- Buffer statistics available via session details for monitoring

**Buffer Stats Response:**
```typescript
{
  bufferStats: {
    terminalBufferSize: number;  // Current terminal buffer size in bytes
    textOutputSize: number;      // Current text output size in bytes
    messageCount: number;        // Number of parsed messages
    maxTerminalBuffer: number;   // Max allowed terminal buffer
    maxTextOutput: number;       // Max allowed text output
    maxMessages: number;         // Max allowed messages
  }
}
```

### Respawn Controller State Machine

```
WATCHING → SENDING_UPDATE → WAITING_UPDATE → SENDING_CLEAR → WAITING_CLEAR → SENDING_INIT → WAITING_INIT → WATCHING
```

Default config (`RespawnConfig` in `src/types.ts`):
- `idleTimeoutMs`: 5000 (5s after prompt)
- `updatePrompt`: "update all the docs and CLAUDE.md"
- `interStepDelayMs`: 1000 (1s between steps)
- `sendClear`: true (send /clear after update)
- `sendInit`: true (send /init after /clear)

### Token Tracking & Auto-Clear

Session tracks input/output tokens differently depending on mode:

**One-shot mode (`runPrompt`)**: Uses `--output-format stream-json` to get JSON output with detailed token usage from `msg.message.usage.input_tokens` and `output_tokens`.

**Interactive mode (`startInteractive`)**: Parses tokens from Claude's status line display (e.g., "123.4k tokens"). Since only total is shown, estimates 60/40 input/output split.

```typescript
{
  tokens: {
    input: number;   // Total input tokens used
    output: number;  // Total output tokens used
    total: number;   // Combined total
  },
  autoClear: {
    enabled: boolean;    // Whether auto-clear is active
    threshold: number;   // Token threshold (default 100000)
  }
}
```

When enabled, auto-clear waits for idle state, sends `/clear`, and resets token counts.

### SSE Events

All events broadcast to `/api/events` with format: `{ type: string, sessionId?: string, data: any }`.

Event categories (prefixes): `session:`, `task:`, `respawn:`, `scheduled:`, `case:`, `init`. Key events include `session:idle`, `session:working`, `session:terminal`, `session:completion`, `respawn:stateChanged`. See `src/web/server.ts` for the full event catalog.

## API Endpoints

REST API served by Fastify at `src/web/server.ts`. All endpoints are under `/api/`.

**Sessions:**
- `GET /api/sessions` - List all sessions
- `POST /api/sessions` - Create session `{ workingDir, mode?, name? }`
- `GET /api/sessions/:id` - Get session details (includes bufferStats)
- `GET /api/sessions/:id/output` - Get text output buffer
- `DELETE /api/sessions/:id` - Kill and remove session
- `DELETE /api/sessions` - Kill all sessions
- `PUT /api/sessions/:id/name` - Rename session `{ name }`
- `POST /api/sessions/:id/interactive` - Start interactive Claude terminal
- `POST /api/sessions/:id/shell` - Start shell terminal (no Claude)
- `POST /api/sessions/:id/input` - Send input to session `{ input }`
- `POST /api/sessions/:id/resize` - Resize terminal `{ cols, rows }`
- `POST /api/sessions/:id/run` - Run one-shot prompt `{ prompt }`
- `GET /api/sessions/:id/terminal` - Get terminal buffer

**Respawn Controller:**
- `GET /api/sessions/:id/respawn` - Get respawn state
- `POST /api/sessions/:id/respawn/start` - Start respawn `{ config? }`
- `POST /api/sessions/:id/respawn/stop` - Stop respawn
- `PUT /api/sessions/:id/respawn/config` - Update config
- `POST /api/sessions/:id/respawn/enable` - Enable on running session `{ config?, durationMinutes? }`
- `POST /api/sessions/:id/auto-clear` - Configure auto-clear `{ enabled, threshold? }`

**Cases & Quick Start:**
- `GET /api/cases` - List cases in `~/claudeman-cases/`
- `POST /api/cases` - Create case `{ name, description? }`
- `GET /api/cases/:name` - Get case info
- `POST /api/quick-start` - Create case + interactive session `{ caseName? }`

**Scheduled Runs:**
- `GET /api/scheduled` - List scheduled runs
- `POST /api/scheduled` - Create scheduled run `{ prompt, workingDir?, durationMinutes }`
- `GET /api/scheduled/:id` - Get run status
- `DELETE /api/scheduled/:id` - Cancel run

**Screen Management:**
- `GET /api/screens` - List screen sessions with stats
- `DELETE /api/screens/:sessionId` - Kill screen session
- `POST /api/screens/reconcile` - Clean up dead screens
- `POST /api/screens/stats/start` - Start resource monitoring
- `POST /api/screens/stats/stop` - Stop resource monitoring

**Other:**
- `GET /api/events` - SSE stream for real-time updates
- `GET /api/status` - Full state snapshot
- `GET /api/settings` - Get app settings
- `PUT /api/settings` - Update settings
- `POST /api/run` - Quick run prompt without creating persistent session `{ prompt, workingDir? }`

## E2E Testing with agent-browser

For UI testing, use [agent-browser](https://github.com/vercel-labs/agent-browser). A full E2E test plan is documented in `.claude/skills/e2e-test.md`.

```bash
# Setup
npx agent-browser install              # Download Chromium (one-time)
npx tsx src/index.ts web &             # Start server

# Basic test flow
npx agent-browser open http://localhost:3000
npx agent-browser snapshot             # Get accessibility tree with element refs
npx agent-browser click @e5            # Click by element ref
npx agent-browser find text "Run Claude" click  # Or use semantic locators
npx agent-browser screenshot /tmp/test.png
npx agent-browser close
```

## Frontend

The web UI (`src/web/public/`) uses vanilla JavaScript with:
- **xterm.js**: Terminal emulator with WebGL renderer for 60fps performance
- **xterm-addon-fit**: Auto-resize terminal to container
- **Server-Sent Events**: Real-time updates from `/api/events`
- **No build step**: Static files served directly by Fastify

Key files:
- `app.js` - Main application logic, SSE handling, session management
- `index.html` - Single page with embedded styles
- Libraries loaded from CDN (xterm.js, addons)

## Notes

- State persists to `~/.claudeman/state.json` and `~/.claudeman/screens.json`
- Cases are created in `~/claudeman-cases/` by default
- Sessions are wrapped in GNU screen for persistence across server restarts
