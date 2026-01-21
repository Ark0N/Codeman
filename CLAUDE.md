# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## ⚠️ CRITICAL: Screen Session Safety

**You may be running inside a Claudeman-managed screen session.** Before killing ANY screen or Claude process:

1. **Check environment**: `echo $CLAUDEMAN_SCREEN` - if it returns `1`, you're in a managed session
2. **NEVER run** `screen -X quit`, `pkill screen`, or `pkill claude` without first confirming you're not killing yourself
3. **Safe debugging**: Use `screen -ls` to LIST sessions, but don't kill them blindly
4. **If you need to kill screens**: Use the web UI or `./scripts/screen-manager.sh` instead of direct commands

**Why this matters**: Killing your own screen terminates your session mid-work, losing context and potentially corrupting state.

## Project Overview

Claudeman is a Claude Code session manager with a web interface and autonomous Ralph Loop. It spawns Claude CLI processes via PTY, streams output in real-time via SSE, and supports scheduled/timed runs.

**Tech Stack**: TypeScript (ES2022/NodeNext, strict mode), Node.js, Fastify, Server-Sent Events, node-pty

**Key Dependencies**: fastify (REST API), node-pty (PTY spawning), ink/react (TUI), xterm.js (web terminal)

**Requirements**: Node.js 18+, Claude CLI (`claude`) in PATH, GNU Screen (`apt install screen` / `brew install screen`)

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
npm run web                        # After npm run build (shorthand)
node dist/index.js web             # After npm run build
claudeman web                      # After npm link

# Start TUI (terminal user interface):
npx tsx src/index.ts tui           # Dev mode - prompts to start web if not running
claudeman tui                      # After npm link
claudeman tui --with-web           # Auto-start web server if not running (no prompt)
claudeman tui --no-web             # Skip web server check entirely
claudeman tui -p 8080              # Specify web server port

# Testing (vitest)
# Note: globals: true configured - no imports needed for describe/it/expect
npm run test                              # Run all tests once
npm run test:watch                        # Watch mode
npm run test:coverage                     # With coverage report
npx vitest run test/session.test.ts       # Single file
npx vitest run -t "should create session" # By pattern

# Test port allocation (integration tests spawn servers):
# 3099: quick-start.test.ts
# 3102: session.test.ts
# 3105: scheduled-runs.test.ts
# 3107: sse-events.test.ts
# 3110: edge-cases.test.ts
# 3115: integration-flows.test.ts
# 3120: session-cleanup.test.ts
# 3125: ralph-integration.test.ts
# Unit tests (no port needed): respawn-controller, ralph-tracker, pty-interactive, task-queue, task, ralph-loop, session-manager, state-store, types, templates, ralph-config
# Next available: 3127+

# Tests mock PTY - no real Claude CLI spawned
# Test timeout: 30s (configured in vitest.config.ts)
# Global test utilities (describe/it/expect) available without imports (globals: true)

# TypeScript checking
npm run typecheck                         # Type check without building (or: npx tsc --noEmit)
# Note: No ESLint/Prettier configured - rely on TypeScript strict mode

# Debugging
screen -ls                                # List GNU screen sessions
screen -r <name>                          # Attach to screen session (Ctrl+A D to detach)
curl localhost:3000/api/sessions          # Check active sessions
curl localhost:3000/api/status | jq .     # Full app state including respawn
cat ~/.claudeman/state.json | jq .        # View main state
cat ~/.claudeman/state-inner.json | jq .  # View Ralph loop state

# Kill stuck screen sessions
screen -X -S <name> quit                  # Graceful quit
pkill -f "SCREEN.*claudeman"              # Force kill all claudeman screens
```

## CLI Commands

```bash
claudeman session [s]              # Manage Claude sessions
  start                            # Start new session
  stop <id>                        # Stop session
  list [ls]                        # List all
  logs <id>                        # View output

claudeman task [t]                 # Manage tasks
  add <prompt>                     # Add task
  list [ls]                        # List tasks
  status <id>                      # Task details
  remove [rm] <id>                 # Remove task
  clear                            # Clear completed/failed

claudeman ralph [r]                # Control Ralph loop
  start                            # Start loop
  stop                             # Stop loop
  status                           # Show status

claudeman web                      # Start web interface
claudeman tui                      # Start TUI
claudeman status                   # Overall status
claudeman reset                    # Reset all state
```

## Architecture

### Key Files

| File | Purpose |
|------|---------|
| `src/session.ts` | Core PTY wrapper for Claude CLI. Modes: `runPrompt()`, `startInteractive()`, `startShell()` |
| `src/respawn-controller.ts` | State machine for autonomous session cycling |
| `src/screen-manager.ts` | GNU screen persistence, ghost discovery, 4-strategy kill |
| `src/ralph-tracker.ts` | Detects `<promise>PHRASE</promise>`, todos, loop status in output |
| `src/ralph-config.ts` | Parses `.claude/ralph-loop.local.md` and CLAUDE.md for Ralph config |
| `src/task-tracker.ts` | Parses background task output (agent IDs, status) from Claude CLI |
| `src/session-manager.ts` | Manages session lifecycle, task assignment, and cleanup |
| `src/state-store.ts` | JSON persistence to `~/.claudeman/` with debounced writes |
| `src/web/server.ts` | Fastify REST API + SSE at `/api/events` |
| `src/web/public/app.js` | Frontend: SSE handling, xterm.js, tab management |
| `src/tui/App.tsx` | TUI main component: tabs, terminal viewport, status bar (Ink/React) |
| `src/tui/components/*.tsx` | TUI components: StartScreen, TabBar, TerminalView, StatusBar, RalphPanel, HelpOverlay |
| `src/tui/hooks/useSessionManager.ts` | TUI session state, screen polling, input handling |
| `src/types.ts` | All TypeScript interfaces |
| `src/templates/claude-md.ts` | CLAUDE.md template generation with placeholder support |

### Data Flow

1. **Session** spawns `claude -p --dangerously-skip-permissions` via `node-pty`
2. PTY output is buffered, ANSI stripped, and parsed for JSON messages
3. **WebServer** broadcasts events to SSE clients at `/api/events`
4. State persists to `~/.claudeman/state.json` via **StateStore**

### Respawn State Machine

```
┌─────────────────────────────────────────────────────────────────────────────────────────────────┐
│                                                                                                 │
▼                                                                                                 │
WATCHING → SENDING_UPDATE → WAITING_UPDATE → SENDING_CLEAR → WAITING_CLEAR                       │
                                                    │                                             │
                                                    ▼                                             │
                              SENDING_INIT → WAITING_INIT → MONITORING_INIT ──┬──────────────────┘
                                                                              │
                                                                              ▼ (if no work triggered)
                                                            SENDING_KICKSTART → WAITING_KICKSTART
```

**States**: `watching`, `sending_update`, `waiting_update`, `sending_clear`, `waiting_clear`, `sending_init`, `waiting_init`, `monitoring_init`, `sending_kickstart`, `waiting_kickstart`, `stopped`

Steps can be skipped via config (`sendClear: false`, `sendInit: false`). Optional `kickstartPrompt` triggers if `/init` doesn't start work. Idle detection triggers state transitions.

### Session Modes

Sessions have a `mode` property (`SessionMode` type):
- **`'claude'`**: Runs Claude CLI for AI interactions (default)
- **`'shell'`**: Runs a plain bash shell for debugging/testing

### Screen-Aware Sessions

All Claude sessions spawned by Claudeman receive environment variables indicating they're running in a managed screen:

| Variable | Value | Purpose |
|----------|-------|---------|
| `CLAUDEMAN_SCREEN` | `1` | Indicates session is managed by Claudeman |
| `CLAUDEMAN_SESSION_ID` | `<uuid>` | Unique session identifier |
| `CLAUDEMAN_SCREEN_NAME` | `claudeman-<name>` | GNU screen session name |

This prevents Claude from accidentally killing its own screen session. The default CLAUDE.md template includes guidance about this.

**Implementation**: Set in `screen-manager.ts:createScreen()` for screen-based sessions and `session.ts:startInteractive()`/`startShell()` for PTY-only sessions.

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

**Why separate commands?** Claude CLI uses [Ink](https://github.com/vadimdemedes/ink) (React for terminals) which requires text and Enter as separate `screen -X stuff` commands. Combining them doesn't work. This is a critical implementation detail when debugging input issues.

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

### Ralph / Todo Tracking

Detects Ralph loops and todos inside Claude sessions. **Disabled by default** but auto-enables when any of these patterns are detected in terminal output:
- `/ralph-loop:ralph-loop` command
- `<promise>PHRASE</promise>` completion phrases (supports hyphens: `TESTS-PASS`, underscores: `ALL_DONE`, numbers: `TASK_123`)
- `TodoWrite` tool usage
- Iteration patterns (`Iteration 5/50`, `[5/50]`)
- Todo checkboxes (`- [ ]`/`- [x]`) or indicator icons (`☐`/`◐`/`✓`)
- "All tasks complete" messages
- Individual task completion signals (`Task 8 is done`)

See `ralph-tracker.ts:shouldAutoEnable()` for detection logic.

**Auto-Configuration from Ralph Plugin State**: When a session starts, Claudeman reads `.claude/ralph-loop.local.md` (the official Ralph Wiggum plugin state file) to auto-configure the tracker:

```yaml
---
enabled: true
iteration: 5
max-iterations: 50
completion-promise: "COMPLETE"
---
```

Priority order for configuration:
1. `.claude/ralph-loop.local.md` (official Ralph plugin state)
2. `CLAUDE.md` `<promise>` tags (fallback)

See `src/ralph-config.ts` for parsing logic.

**Completion Detection**: Uses multi-strategy detection:
- 1st occurrence of `<promise>PHRASE</promise>`: Stores as expected phrase (likely in prompt)
- 2nd occurrence: Emits `completionDetected` event (actual completion)
- **Bare phrase detection**: Also detects phrase without tags once expected phrase is known
- **All complete detection**: When "All X files/tasks created/completed" detected, marks all todos complete and emits completion
- If loop is already active (via `/ralph-loop:ralph-loop`): Emits immediately on first occurrence

**Session Lifecycle**: Each session has its own independent tracker:
- New session → Fresh tracker (no carryover)
- Close tab → Tracker state cleared, UI panel hides
- Switch tabs → Panel shows tracker for active session
- `tracker.reset()` → Clears todos/state, keeps enabled status
- `tracker.fullReset()` → Complete reset to initial state

**API**:
- `GET /api/sessions/:id/ralph-state` - Get loop state and todos
- `POST /api/sessions/:id/ralph-config` - Configure tracker:
  - `{ enabled: boolean }` - Enable/disable
  - `{ reset: true }` - Soft reset (keep enabled)
  - `{ reset: "full" }` - Full reset

UI: Collapsible panel below tabs, shows progress ring and todo list.

### Terminal Display Fix

Tab switch/new session fix: clear xterm → write buffer → resize PTY → Ctrl+L redraw. Uses `pendingCtrlL` Set, triggered on `session:idle`/`session:working` events.

### SSE Events

All events broadcast to `/api/events` with format: `{ type: string, sessionId?: string, data: any }`.

Event prefixes: `session:`, `task:`, `respawn:`, `scheduled:`, `case:`, `screen:`, `init`.

Key events for frontend handling (see `app.js:handleSSEEvent()`):
- `session:idle`, `session:working` - Status indicator updates
- `session:terminal`, `session:clearTerminal` - Terminal content
- `session:completion`, `session:autoClear`, `session:autoCompact` - Lifecycle events
- `session:ralphLoopUpdate`, `session:ralphTodoUpdate`, `session:ralphCompletionDetected` - Ralph tracking

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

Writes debounced to `~/.claudeman/state.json`. Batches rapid changes.

### Timing Constants

| Constant | Value | Location |
|----------|-------|----------|
| State save debounce | 500ms | `state-store.ts` |
| State update debounce | 500ms | `server.ts` |
| Line buffer flush | 100ms | `session.ts` |
| Terminal batch interval | 16ms | `server.ts` (60fps) |
| Output batch interval | 50ms | `server.ts` |
| Task update batch interval | 100ms | `server.ts` |
| Ralph loop event debounce | 50ms | `ralph-tracker.ts` |
| Session tabs render debounce | 100ms | `app.js` |
| Ralph panel render debounce | 50ms | `app.js` |
| Task panel render debounce | 100ms | `app.js` |
| Input batch interval | 16ms | `app.js` (60fps) |
| Idle activity timeout | 2s | `session.ts` |
| Respawn idle timeout | 5s default | `RespawnConfig.idleTimeoutMs` |

### TypeScript Config

Module resolution: NodeNext. Target: ES2022. Strict mode with additional checks:

| Setting | Effect |
|---------|--------|
| `noUnusedLocals` | Error on unused local variables |
| `noUnusedParameters` | Error on unused function parameters |
| `noImplicitReturns` | All code paths must return a value |
| `noImplicitOverride` | Require `override` keyword for overridden methods |
| `noFallthroughCasesInSwitch` | Require break/return in switch cases |
| `allowUnreachableCode: false` | Error on unreachable code |
| `allowUnusedLabels: false` | Error on unused labels |

TUI uses React JSX (`jsxImportSource: react`) for Ink components.

## Adding New Features

- **API endpoint**: Add types in `types.ts`, route in `server.ts:buildServer()`, use `createErrorResponse()` for errors
- **SSE event**: Emit via `broadcast()` in server.ts, handle in `app.js:handleSSEEvent()` switch
- **Session event**: Add to `SessionEvents` interface in `session.ts`, emit via `this.emit()`, subscribe in server.ts, handle in frontend
- **New test file**: Create `test/<name>.test.ts`, pick unique port (next available: 3127+), add to port allocation comment above

### API Error Codes

Use `createErrorResponse(code, details?)` from `types.ts`:

| Code | Use Case |
|------|----------|
| `NOT_FOUND` | Session/resource doesn't exist |
| `INVALID_INPUT` | Bad request parameters |
| `SESSION_BUSY` | Session is currently processing |
| `OPERATION_FAILED` | Action couldn't complete |
| `ALREADY_EXISTS` | Duplicate resource |
| `INTERNAL_ERROR` | Unexpected server error |

## Session Lifecycle & Cleanup

- **Limit**: Web server: `MAX_CONCURRENT_SESSIONS = 50` (`server.ts:56`), UI tab limit: 20, CLI default: 5 (`types.ts:DEFAULT_CONFIG`)
- **Kill** (`killScreen()`): child PIDs → process group → screen quit → SIGKILL
- **Ghost discovery**: `reconcileScreens()` finds orphaned screens on startup
- **Cleanup** (`cleanupSession()`): stops respawn, clears buffers/timers, kills screen

## TUI Architecture (Ink/React)

The TUI (`claudeman tui`) is built with [Ink](https://github.com/vadimdemedes/ink) (React for terminals).

**Component Hierarchy:**
```
App.tsx
├── StartScreen.tsx         # Session/case list, navigation
│   ├── List navigation (↑/↓, Enter, a/d/D)
│   ├── Case creation flow
│   └── Tab switcher menu
├── TabBar.tsx              # Session tabs (when attached)
├── TerminalView.tsx        # Viewport into screen session
├── StatusBar.tsx           # Bottom bar with status/tokens
├── RalphPanel.tsx          # Ralph loop progress display
└── HelpOverlay.tsx         # Keyboard shortcuts modal
```

**Key Hook:** `useSessionManager.ts` handles:
- API polling for sessions/screens
- Screen attach/detach flow
- Keyboard input routing
- State synchronization with web server

**TUI ↔ Web Server:** The TUI is a client to the web server. It doesn't manage sessions directly - it uses `/api/*` endpoints and attaches to screens via GNU screen commands.

## Buffer Limits

Long-running sessions are supported with automatic trimming:

| Buffer | Max Size | Trim To |
|--------|----------|---------|
| Terminal | 2MB | 1.5MB |
| Text output | 1MB | 768KB |
| Messages | 1000 | 800 |
| Line buffer | 64KB | (flushed every 100ms) |
| Respawn buffer | 1MB | 512KB |

**Performance optimizations:**
- Tab switch uses `tail=256KB` for fast initial load, then chunked writes
- Large buffers written in 64KB chunks via `requestAnimationFrame` to avoid UI jank
- Truncation indicator shown when earlier output is cut

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
| POST | `/api/sessions/:id/ralph-config` | Configure Ralph / Todo Tracker settings |
| GET | `/api/sessions/:id/ralph-state` | Get Ralph loop state + todos |
| POST | `/api/sessions/:id/auto-compact` | Configure auto-compact threshold |
| POST | `/api/sessions/:id/auto-clear` | Configure auto-clear threshold |
| POST | `/api/quick-start` | Create case + start session. Body: `{mode?: 'claude'\|'shell'}` |
| GET | `/api/cases` | List available cases |
| POST | `/api/cases` | Create new case |
| GET | `/api/screens` | List screen sessions with stats |

## Keyboard Shortcuts (Web UI)

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

## TUI Keyboard Shortcuts

**Start Screen - Sessions:**
| Key | Action |
|-----|--------|
| `↑`/`↓` | Navigate list |
| `Enter` | Open tab switcher menu, then full-screen attach |
| `a` | Direct attach (skip tab menu, Ctrl+A D returns to TUI) |
| `d` | Delete/kill selected session |
| `D` (Shift+d) | Delete ALL screens & Claude processes |
| `c` | Switch to cases view |
| `n` | Quick-start new session |
| `r` | Refresh list |
| `q` | Quit TUI |

**Start Screen - Cases:**
| Key | Action |
|-----|--------|
| `↑`/`↓` | Navigate list |
| `Enter` | Start Claude session with selected case |
| `h` | Start Shell session with selected case |
| `m` | Multi-start (1-20 sessions at once) |
| `n` | Create new case |
| `s` | Switch to sessions view |
| `r` | Refresh list |

**Tab Switcher Menu (between attaches):**
| Key | Action |
|-----|--------|
| `1-9` | Select and attach to session N |
| `Enter` | Attach to current session |
| `q` / `Esc` | Return to TUI start screen |

**While attached to screen:**
| Key | Action |
|-----|--------|
| `Ctrl+A D` | Detach and return to tab switcher |

## State Files

| File | Purpose |
|------|---------|
| `~/.claudeman/state.json` | Sessions, tasks, config |
| `~/.claudeman/state-inner.json` | Ralph loop/todo state per session (separate to reduce writes) |
| `~/.claudeman/screens.json` | Screen session metadata |

Cases created in `~/claudeman-cases/` by default.

### Custom CLAUDE.md Templates

New cases can use custom CLAUDE.md templates via `generateClaudeMd()` in `src/templates/claude-md.ts`. Placeholders:
- `[PROJECT_NAME]` → Case name
- `[PROJECT_DESCRIPTION]` → Description
- `[DATE]` → Current date (YYYY-MM-DD)

## Screen Session Manager (CLI Tool)

Interactive bash tool for managing claudeman screen sessions directly from the terminal.

```bash
./scripts/screen-manager.sh          # Interactive mode
./scripts/screen-manager.sh list     # List all sessions
./scripts/screen-manager.sh attach 1 # Attach to session #1
./scripts/screen-manager.sh kill 2,3 # Kill sessions 2 and 3
./scripts/screen-manager.sh kill-all # Kill all sessions
./scripts/screen-manager.sh info 1   # Show session #1 details
```

**Interactive Controls:**

| Key | Action |
|-----|--------|
| `↑`/`↓` or `j`/`k` | Navigate sessions |
| `Enter` | Attach to selected session |
| `d` | Delete selected session |
| `D` | Delete ALL sessions |
| `i` | Show session info |
| `q`/`Esc` | Quit |

**Features:**
- Reads from `~/.claudeman/screens.json` (claudeman's authoritative source)
- Shows session name, running time, alive/dead status, mode
- Flicker-free navigation (only updates changed rows)
- Requires `jq` and `screen` to be installed

## Documentation

Extended documentation is available in the `docs/` directory:

| Document | Description |
|----------|-------------|
| [`docs/ralph-wiggum-guide.md`](docs/ralph-wiggum-guide.md) | Complete Ralph Wiggum loop guide: official plugin reference, best practices, prompt templates, troubleshooting |
| [`docs/claude-code-hooks-reference.md`](docs/claude-code-hooks-reference.md) | Official Claude Code hooks documentation: all events, configuration, examples |

### Quick Reference: Ralph Wiggum Loops

**Core Pattern**: `<promise>PHRASE</promise>` - The completion signal that tells the loop to stop.

**Skill Commands**:
```bash
/ralph-loop:ralph-loop    # Start Ralph Loop in current session
/ralph-loop:cancel-ralph  # Cancel active Ralph Loop
/ralph-loop:help          # Show help and usage
```

**Claudeman Implementation**: The `RalphTracker` class (`src/ralph-tracker.ts`) detects Ralph patterns in Claude output and tracks loop state, todos, and completion phrases. It auto-enables when Ralph-related patterns are detected.

See [`docs/ralph-wiggum-guide.md`](docs/ralph-wiggum-guide.md) for full documentation on best practices, prompt templates, and troubleshooting.
