# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Claudeman is a Claude Code session manager with a web interface and autonomous Ralph Loop. It spawns Claude CLI processes via PTY, streams output in real-time via SSE, and supports scheduled/timed runs.

**Tech Stack**: TypeScript, Node.js, Fastify, Server-Sent Events, node-pty

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

**One-shot mode** (prompt execution):
```typescript
pty.spawn('claude', ['-p', '--dangerously-skip-permissions', prompt], { ... })
```

**Interactive mode** (persistent terminal):
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

Session tracks input/output tokens from Claude's JSON messages:

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

### SSE Event Catalog

All events are broadcast to clients connected to `/api/events`. Event format: `{ type: string, sessionId?: string, data: any }`.

**Session Events:**
| Event | Data | Description |
|-------|------|-------------|
| `session:created` | `{ session }` | New session created |
| `session:deleted` | `{ id }` | Session removed |
| `session:output` | `{ id, data }` | Parsed output line (ANSI stripped) |
| `session:terminal` | `{ id, data }` | Raw terminal data with ANSI codes |
| `session:message` | `{ id, message }` | Parsed Claude JSON message |
| `session:running` | `{ id, prompt }` | Prompt execution started |
| `session:interactive` | `{ id }` | Interactive mode started |
| `session:completion` | `{ id, result, cost }` | Prompt completed, includes cost |
| `session:exit` | `{ id, code }` | Session process exited |
| `session:idle` | `{ id }` | Session is idle (prompt detected) |
| `session:working` | `{ id }` | Session is working (activity detected) |
| `session:updated` | `{ session }` | Session state updated |
| `session:error` | `{ id, error }` | Session error occurred |
| `session:autoClear` | `{ sessionId, tokens, threshold }` | Auto-clear triggered |

**Task Events:**
| Event | Data | Description |
|-------|------|-------------|
| `task:created` | `{ sessionId, task }` | Background task started |
| `task:updated` | `{ sessionId, task }` | Task status updated |
| `task:completed` | `{ sessionId, task }` | Task finished successfully |
| `task:failed` | `{ sessionId, task, error }` | Task failed |

**Respawn Controller Events:**
| Event | Data | Description |
|-------|------|-------------|
| `respawn:started` | `{ sessionId, status }` | Respawn controller started |
| `respawn:stopped` | `{ sessionId }` | Respawn controller stopped |
| `respawn:stateChanged` | `{ sessionId, state, prevState }` | State machine transition |
| `respawn:cycleStarted` | `{ sessionId, cycleNumber }` | New update cycle starting |
| `respawn:cycleCompleted` | `{ sessionId, cycleNumber }` | Update cycle finished |
| `respawn:stepSent` | `{ sessionId, step, input }` | Command sent (update/clear/init) |
| `respawn:stepCompleted` | `{ sessionId, step }` | Command completed |
| `respawn:configUpdated` | `{ sessionId, config }` | Configuration changed |
| `respawn:timerStarted` | `{ sessionId, durationMinutes, endAt, startedAt }` | Timed respawn started |
| `respawn:log` | `{ sessionId, message }` | Debug/info log message |
| `respawn:error` | `{ sessionId, error }` | Error occurred |

**Scheduled Run Events:**
| Event | Data | Description |
|-------|------|-------------|
| `scheduled:created` | `{ run }` | New scheduled run created |
| `scheduled:updated` | `{ run }` | Status/timer update |
| `scheduled:log` | `{ id, log }` | Scheduled run log entry |
| `scheduled:completed` | `{ run }` | Scheduled run finished |
| `scheduled:stopped` | `{ run }` | Scheduled run stopped by user |

**Case Events:**
| Event | Data | Description |
|-------|------|-------------|
| `case:created` | `{ name, path }` | New case directory created |

**Init Event:**
| Event | Data | Description |
|-------|------|-------------|
| `init` | `{ sessions, scheduledRuns, respawnStatus, timestamp }` | Full state sent on SSE connection |

## API Endpoints

### Session Management

```
GET  /api/sessions                    # List all sessions (includes buffer stats)
POST /api/sessions                    # Create session { workingDir, mode?, name? }
GET  /api/sessions/:id                # Get single session details
PUT  /api/sessions/:id/name           # Rename session { name }
DELETE /api/sessions/:id              # Stop and remove a session (kills process + children)
DELETE /api/sessions                  # Kill all sessions at once
GET  /api/sessions/:id/output         # Get session output buffer
GET  /api/sessions/:id/terminal       # Get terminal buffer (raw ANSI)
```

### Session Operations

```
POST /api/sessions/:id/run            # Run prompt { prompt } (one-shot mode)
POST /api/sessions/:id/interactive    # Start interactive Claude terminal mode
POST /api/sessions/:id/shell          # Start plain shell (bash/zsh, no Claude)
POST /api/sessions/:id/input          # Send input to interactive session { input }
POST /api/sessions/:id/resize         # Resize terminal { cols, rows }
POST /api/sessions/:id/interactive-respawn  # Start interactive + respawn controller
```

### Respawn Controller

```
GET  /api/sessions/:id/respawn        # Get respawn controller state
POST /api/sessions/:id/respawn/start  # Start respawn controller { config? }
POST /api/sessions/:id/respawn/stop   # Stop respawn controller
POST /api/sessions/:id/respawn/enable # Enable respawn on existing session { config?, durationMinutes? }
PUT  /api/sessions/:id/respawn/config # Update config { idleTimeoutMs, updatePrompt, interStepDelayMs, sendClear, sendInit }
POST /api/sessions/:id/auto-clear     # Set auto-clear { enabled, threshold? }
```

### Scheduled Runs

```
GET  /api/scheduled                   # List all scheduled runs
POST /api/scheduled                   # Create { prompt, workingDir, durationMinutes }
GET  /api/scheduled/:id               # Get scheduled run details
DELETE /api/scheduled/:id             # Cancel scheduled run
```

### Cases & Quick Start

```
GET  /api/cases                       # List case directories
POST /api/cases                       # Create case { name, description }
GET  /api/cases/:name                 # Get case details
POST /api/quick-start                 # Quick start { caseName? } - creates case + interactive session
POST /api/run                         # Quick run { prompt, workingDir } (no session management)
```

**Quick Start Response:**
```typescript
{
  success: boolean;
  sessionId?: string;    // ID of the created session
  casePath?: string;     // Full path to the case directory
  caseName?: string;     // Name of the case
  error?: string;        // Error message if success is false
}
```

### Events

```
GET  /api/events                      # SSE stream (real-time events)
GET  /api/status                      # Full state snapshot (sessions + scheduled + respawn)
```

## Testing

### Unit Tests

Tests use Vitest and auto-discover `*.test.ts` files in the `test/` directory:

```bash
npm run test                              # Run all tests once
npm run test:watch                        # Watch mode
npm run test:coverage                     # With coverage report
npx vitest run test/session.test.ts       # Single file
npx vitest run -t "should create session" # By pattern
```

### E2E Testing with agent-browser

For UI testing, we use [agent-browser](https://github.com/vercel-labs/agent-browser) - a fast CLI for browser automation optimized for AI agents.

**Installation:**
```bash
npm install agent-browser --save-dev
npx agent-browser install  # Download Chromium
```

**Basic E2E Test Flow:**
```bash
# Start the server
npx tsx src/index.ts web &

# Open browser
npx agent-browser open http://localhost:3000

# Get page snapshot (shows accessibility tree with element refs)
npx agent-browser snapshot

# Click elements by reference
npx agent-browser click @e5  # Click element with ref=e5

# Or use semantic locators
npx agent-browser find text "Run Claude" click
npx agent-browser find role button click --name "Monitor"

# Fill inputs
npx agent-browser fill @e32 "my-session-name"

# Execute JavaScript in page context
npx agent-browser eval "app.sessions.get(app.activeSessionId)"

# Take screenshots
npx agent-browser screenshot /tmp/test-result.png

# Close browser
npx agent-browser close
```

**E2E Test Skill (`.claude/skills/e2e-test.md`):**

A skill file exists that documents the full E2E test plan. Key tests include:

1. **Initial Load**: Verify header layout (font controls, connection status, tokens)
2. **Font Controls**: Test A-/A+ buttons change font size
3. **Tab Count Stepper**: Test −/+ buttons increment/decrement
4. **Session Creation**: Create session, verify screen wrapping
5. **Session Options Modal**: Open gear icon, verify respawn settings visible
6. **Monitor Panel**: Test Screen Sessions and Background Tasks display

**Example Test Session:**
```bash
# Clean up previous screens
screen -ls | grep -oP '\d+\.claudeman-[a-z0-9]+' | while read s; do
  screen -S "$s" -X quit
done

# Start fresh server
rm -f ~/.claudeman/screens.json
npx tsx src/index.ts web &
sleep 4

# Run tests
npx agent-browser open http://localhost:3000
npx agent-browser snapshot | head -30  # Check initial state
npx agent-browser click @e5            # Run Claude
sleep 4
npx agent-browser snapshot             # Verify session created

# Check screen wrapping
screen -ls | grep claudeman            # Should show screen session

# Check session has PID
npx agent-browser eval "app.sessions.get(app.activeSessionId).pid"

# Test session options
npx agent-browser eval "document.querySelector('[title=\"Session options\"]').click()"
npx agent-browser snapshot | grep -E "Respawn|Enable"  # Should show respawn settings

npx agent-browser screenshot /tmp/test-final.png
npx agent-browser close
```

**Key Commands:**
| Command | Description |
|---------|-------------|
| `open <url>` | Navigate to URL |
| `snapshot` | Get accessibility tree with element refs |
| `snapshot -i` | Interactive elements only |
| `click @ref` | Click element by ref |
| `fill @ref "text"` | Fill input field |
| `eval "js code"` | Execute JavaScript |
| `screenshot path` | Save screenshot |
| `find text/role/label "x" click` | Semantic element location |
| `wait 1000` | Wait milliseconds |
| `close` | Close browser |

## Frontend

The web UI (`src/web/public/`) uses vanilla JavaScript with:
- **xterm.js**: Terminal emulator with WebGL renderer for 60fps performance
- **xterm-addon-fit**: Auto-resize terminal to container
- **Server-Sent Events**: Real-time updates from `/api/events`
- **No build step**: Static files served directly by Fastify

## Pending Tasks

**Note to Claude: Do NOT remove or modify this section during /init. These tasks may be actively worked on by other sessions.**

<!-- Add pending tasks here -->
