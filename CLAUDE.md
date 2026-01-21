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
# Unit tests (no port needed): respawn-controller, inner-loop-tracker, pty-interactive, task-queue, task, ralph-loop, session-manager, state-store, types, templates
# Next available: 3122+

# Tests mock PTY - no real Claude CLI spawned
# Test timeout: 30s (configured in vitest.config.ts)

# TypeScript checking
npm run typecheck                         # Type check without building (or: npx tsc --noEmit)
# Note: No ESLint/Prettier configured - rely on TypeScript strict mode

# Debugging
screen -ls                                # List GNU screen sessions
screen -r <name>                          # Attach to screen session (Ctrl+A D to detach)
curl localhost:3000/api/sessions          # Check active sessions
curl localhost:3000/api/status | jq .     # Full app state including respawn
cat ~/.claudeman/state.json | jq .        # View main state
cat ~/.claudeman/state-inner.json | jq .  # View inner loop state

# Kill stuck screen sessions
screen -X -S <name> quit                  # Graceful quit
pkill -f "SCREEN.*claudeman"              # Force kill all claudeman screens
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
| `src/session-manager.ts` | Manages session lifecycle, task assignment, and cleanup |
| `src/state-store.ts` | JSON persistence to `~/.claudeman/` with debounced writes |
| `src/web/server.ts` | Fastify REST API + SSE at `/api/events` |
| `src/web/public/app.js` | Frontend: SSE handling, xterm.js, tab management |
| `src/tui/App.tsx` | TUI main component: tabs, terminal viewport, status bar (Ink/React) |
| `src/tui/components/*.tsx` | TUI components: StartScreen, TabBar, TerminalView, StatusBar, RalphPanel, HelpOverlay |
| `src/tui/hooks/useSessionManager.ts` | TUI session state, screen polling, input handling |
| `src/types.ts` | All TypeScript interfaces |

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

### Inner Loop Tracking

Detects Ralph loops and todos inside Claude sessions. **Disabled by default** but auto-enables when any of these patterns are detected in terminal output:
- `/ralph-loop:ralph-loop` command
- `<promise>PHRASE</promise>` completion phrases
- `TodoWrite` tool usage
- Iteration patterns (`Iteration 5/50`, `[5/50]`)
- Todo checkboxes (`- [ ]`/`- [x]`) or indicator icons (`☐`/`◐`/`✓`)
- "All tasks complete" messages
- Individual task completion signals (`Task 8 is done`)

See `inner-loop-tracker.ts:shouldAutoEnable()` for detection logic.

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
- `GET /api/sessions/:id/inner-state` - Get loop state and todos
- `POST /api/sessions/:id/inner-config` - Configure tracker:
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
| Inner loop event debounce | 50ms | `inner-loop-tracker.ts` |
| Session tabs render debounce | 100ms | `app.js` |
| Inner panel render debounce | 50ms | `app.js` |
| Task panel render debounce | 100ms | `app.js` |
| Input batch interval | 16ms | `app.js` (60fps) |
| Idle activity timeout | 2s | `session.ts` |
| Respawn idle timeout | 5s default | `RespawnConfig.idleTimeoutMs` |

### TypeScript Config

Module resolution: NodeNext. Target: ES2022. Strict mode enabled. See `tsconfig.json` for full settings.

## Adding New Features

- **API endpoint**: Add types in `types.ts`, route in `server.ts:buildServer()`, use `createErrorResponse()` for errors
- **SSE event**: Emit via `broadcast()` in server.ts, handle in `app.js:handleSSEEvent()` switch
- **Session event**: Add to `SessionEvents` interface in `session.ts`, emit via `this.emit()`, subscribe in server.ts, handle in frontend
- **New test file**: Create `test/<name>.test.ts`, pick unique port (next available: 3122+), add to port allocation comment above

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
| POST | `/api/quick-start` | Create case + start session (claude or shell mode) |
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
| `Enter` | View session in TUI |
| `a` | Attach directly to screen (full terminal) |
| `d` | Delete/kill selected session |
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

**Main View (Session Active):**
| Key | Action |
|-----|--------|
| `Tab`/`Shift+Tab` | Next/previous session tab |
| `Ctrl+1-9` | Go to session N |
| `[`/`]` | Previous/next session (vim-style) |
| `Ctrl+N` | New session |
| `Ctrl+W` | Close current session |
| `Ctrl+K` | Kill all sessions |
| `Ctrl+R` | Toggle respawn (Claude sessions only) |
| `Escape` | Back to start screen |
| `?` | Toggle help overlay |

## State Files

| File | Purpose |
|------|---------|
| `~/.claudeman/state.json` | Sessions, tasks, config |
| `~/.claudeman/state-inner.json` | Inner loop/todo state (separate to reduce writes) |
| `~/.claudeman/screens.json` | Screen session metadata |

Cases created in `~/claudeman-cases/` by default.

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

**Claudeman Implementation**: The `InnerLoopTracker` class (`src/inner-loop-tracker.ts`) detects Ralph patterns in Claude output and tracks loop state, todos, and completion phrases. It auto-enables when Ralph-related patterns are detected.

See [`docs/ralph-wiggum-guide.md`](docs/ralph-wiggum-guide.md) for full documentation on best practices, prompt templates, and troubleshooting.

## Optimization Status

Most critical optimizations have been implemented. See `.claude/optimization-todos.md` for details.

**Completed:**
| Area | Implementation |
|------|----------------|
| Buffer management | `BufferAccumulator` with auto-trimming |
| Pre-compiled regex | Module-level patterns with lastIndex resets |
| Event listener cleanup | `cleanupTrackerListeners()` in session.ts |
| Event debouncing | 50ms debounce in `inner-loop-tracker.ts` |
| State update debouncing | 500ms batching in `server.ts` |
| Regex pre-checks | String.includes() before pattern.test() |
| Frontend render debouncing | 50-100ms for panels, tabs |
| CSS containment | `contain` property on terminal, panels, modals |
| Input batching | 60fps keystroke coalescing |
| Incremental DOM updates | Session tabs and Ralph todos |

**Remaining:**
| Priority | Area | Files |
|----------|------|-------|
| Low | Task lookup optimization | `task-tracker.ts` |
| Low | Buffer pagination API | `server.ts` |

Run `cat .claude/optimization-todos.md` for the full list with file:line references.
