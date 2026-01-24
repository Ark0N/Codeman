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

**Key Dependencies**: fastify (REST API), node-pty (PTY spawning), ink/react (TUI), xterm.js (web terminal), @modelcontextprotocol/sdk (MCP server for spawn protocol)

**Requirements**: Node.js 18+, Claude CLI (`claude`) installed, GNU Screen (`apt install screen` / `brew install screen`)

> **Note**: `claude` does not need to be in the server process's PATH. Claudeman auto-discovers the binary from common install locations (`~/.local/bin`, `~/.claude/local`, `/usr/local/bin`, etc.) and augments PATH for spawned sessions.

> **Runtime**: The web server runs as a systemd user service (`claudeman-web.service`) on HTTPS port 3000 with a self-signed certificate. It auto-restarts and survives logout.

## First-Time Setup

```bash
npm install
```

## Commands

**CRITICAL**: `npm run dev` runs CLI help, NOT the web server. Use `npx tsx src/index.ts web` for development.

```bash
npm run build          # Compile TS + copy static files + templates + make bins executable
npm run clean          # Remove dist/

# Start web server (pick one):
npx tsx src/index.ts web           # Dev mode - no build needed (RECOMMENDED)
npx tsx src/index.ts web -p 8080   # Dev mode with custom port
npx tsx src/index.ts web --https   # Dev mode with self-signed TLS (enables browser notifications)
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
# Unit tests (no port needed): respawn-controller, ralph-tracker, pty-interactive, task-queue, task, ralph-loop, session-manager, state-store, types, templates, ralph-config, spawn-detector, spawn-types, spawn-orchestrator, hooks-config, ai-idle-checker
# Next available: 3127+

# Tests mock PTY - no real Claude CLI spawned
# Test timeout: 30s (configured in vitest.config.ts)
# Global test utilities (describe/it/expect) available without imports (globals: true)
# Tests run sequentially (fileParallelism: false) to respect screen session limits
# Global setup (test/setup.ts) enforces max 10 concurrent screens + orphan cleanup
#
# ✅ TEST SAFETY: test/setup.ts protects its own process tree during cleanup.
# You can safely run tests from within a Claudeman-managed session - the cleanup
# will not kill your own Claude instance. The respawn-controller tests use
# MockSession (not real screens).

# TypeScript checking
npm run typecheck                         # Type check without building (or: npx tsc --noEmit)
# Note: No ESLint/Prettier configured - rely on TypeScript strict mode

# MCP Server (for Claude Code to call spawn tools directly):
# Configure in Claude Code's MCP settings:
#   command: "node", args: ["dist/mcp-server.js"]
#   env: { CLAUDEMAN_API_URL: "http://localhost:3000", CLAUDEMAN_SESSION_ID: "<id>" }
npx tsx src/mcp-server.ts                 # Dev mode (stdio transport)

# Debugging
screen -ls                                # List GNU screen sessions
screen -r <name>                          # Attach to screen session (Ctrl+A D to detach)
curl localhost:3000/api/sessions          # Check active sessions
curl localhost:3000/api/status | jq .     # Full app state including respawn
cat ~/.claudeman/state.json | jq .        # View main state
cat ~/.claudeman/state-inner.json | jq .  # View Ralph loop state

# Systemd service (respawning, survives logout):
systemctl --user status claudeman-web     # Check status
systemctl --user restart claudeman-web    # Restart
systemctl --user stop claudeman-web       # Stop
journalctl --user -u claudeman-web -f     # Stream logs
# Install: ln -sf scripts/claudeman-web.service ~/.config/systemd/user/
# Enable: systemctl --user enable claudeman-web && loginctl enable-linger $USER

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
| `src/ai-idle-checker.ts` | Spawns fresh Claude session to analyze terminal output for IDLE/WORKING verdict |
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
| `src/hooks-config.ts` | Generates .claude/settings.local.json with Claude Code hooks for desktop notifications |
| `src/types.ts` | All TypeScript interfaces |
| `src/templates/claude-md.ts` | CLAUDE.md template generation with placeholder support |
| `src/templates/case-template.md` | Default CLAUDE.md template for new cases (with placeholders) |
| `src/spawn-types.ts` | Types, YAML parser, factory functions for spawn1337 protocol |
| `src/spawn-detector.ts` | Detects `<spawn1337>` tags in terminal output (legacy, replaced by MCP) |
| `src/spawn-orchestrator.ts` | Full agent lifecycle: spawn, monitor, budget, queue, cleanup |
| `src/spawn-claude-md.ts` | Generates CLAUDE.md for spawned agent sessions |
| `src/mcp-server.ts` | MCP server binary (`claudeman-mcp`) exposing spawn tools to Claude Code |
| `src/tui/DirectAttach.ts` | Full-screen console attach with tab switching between sessions |
| `scripts/claudeman-web.service` | Systemd user service for `claudeman web --https` (Restart=always) |

### Data Flow

1. **Session** spawns `claude -p --dangerously-skip-permissions` via `node-pty` (PATH augmented to include claude's install directory)
2. PTY output is buffered, ANSI stripped, and parsed for JSON messages
3. **WebServer** broadcasts events to SSE clients at `/api/events`
4. Full session state (settings, tokens, respawn config, Ralph state) persists to `~/.claudeman/state.json` via **StateStore**
5. Screen metadata persists separately to `~/.claudeman/screens.json` for session recovery

### Respawn State Machine

```
WATCHING → CONFIRMING_IDLE → SENDING_UPDATE → WAITING_UPDATE → SENDING_CLEAR → WAITING_CLEAR
    ↑         │ (new output)                                                         │
    │         ↓                                                                      ▼
    │       (reset)                         SENDING_INIT → WAITING_INIT → MONITORING_INIT
    │                                                                              │
    │                                                         (if no work triggered) ▼
    └────────────────────────────────────── SENDING_KICKSTART ← WAITING_KICKSTART ◄┘
```

**States**: `watching`, `confirming_idle`, `sending_update`, `waiting_update`, `sending_clear`, `waiting_clear`, `sending_init`, `waiting_init`, `monitoring_init`, `sending_kickstart`, `waiting_kickstart`, `stopped`

Steps can be skipped via config (`sendClear: false`, `sendInit: false`). Optional `kickstartPrompt` triggers if `/init` doesn't start work. Multi-layer idle detection triggers state transitions.

**Step confirmation**: After sending each step (update, clear, init, kickstart), the controller waits for `completionConfirmMs` (10s) of output silence before proceeding to the next step. This prevents sending commands while Claude is still processing.

### Spawn1337 Protocol (Autonomous Agents)

Spawned agents are full-power Claude sessions running in their own screen sessions. They communicate via a filesystem-based message bus and signal completion via RalphTracker's `<promise>` mechanism.

**Primary Interface: MCP Server** (`claudeman-mcp` binary). Claude Code calls spawn tools directly via MCP protocol, replacing the legacy terminal-tag-parsing approach (SpawnDetector).

**MCP Tools:**
- `spawn_agent` - Spawn a new autonomous agent (builds task spec from parameters)
- `list_agents` - List all agents (active + completed + queued)
- `get_agent_status` - Get detailed agent status + progress
- `get_agent_result` - Read a completed agent's result
- `send_agent_message` - Send a message to a running agent
- `cancel_agent` - Cancel a running agent

**MCP Environment Variables:**
- `CLAUDEMAN_API_URL` - Base URL for the Claudeman API (default: `http://localhost:3000`)
- `CLAUDEMAN_SESSION_ID` - Session ID of the calling Claude session

**Protocol Flow (via MCP):**
```
Claude calls spawn_agent MCP tool
  → MCP server builds task spec YAML
  → POST /api/spawn/trigger with task spec
  → SpawnOrchestrator creates agent directory: ~/claudeman-cases/spawn-<agentId>/
  → Spawns interactive Claude session in screen
  → Injects initial prompt via writeViaScreen()
  → Agent works autonomously, writes progress to spawn-comms/
  → RalphTracker detects <promise>PHRASE</promise> on child
  → Orchestrator reads result.md, notifies parent via SSE
```

**Agent Directory:** `~/claudeman-cases/spawn-<agentId>/` with `CLAUDE.md`, `spawn-comms/` (task.md, progress.json, result.md, messages/), and `workspace/` (symlinked context files).

**Resource Governance:** Max 5 concurrent agents, max depth 3, default timeout 30min (max 120). Budget warning at 80%, graceful shutdown at 100%, force kill at 110%.

**Agent Tree:** Agents can spawn children. Sessions track `parentAgentId` and `childAgentIds`. Cancelling a parent cascades to all children.

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

**Implementation**: Set in `screen-manager.ts:createScreen()` for screen-based sessions and `session.ts:startInteractive()`/`startShell()` for PTY-only sessions. Both paths also augment `PATH` with the claude binary's directory to ensure discovery in restricted environments (systemd, non-login shells).

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

All PTY spawns pass `PATH: getAugmentedPath()` in the env to ensure `claude` is discoverable even when the server runs in a restricted environment (e.g., systemd). The `getAugmentedPath()` function (in `session.ts`) resolves the claude binary's directory once at startup and prepends it to PATH. The `screen-manager.ts` equivalent (`findClaudeDir()`) does the same for screen-based spawns via `export PATH="<dir>:$PATH"` in the bash command.

```typescript
// One-shot mode (JSON output for token tracking)
pty.spawn('claude', ['-p', '--dangerously-skip-permissions', '--output-format', 'stream-json', prompt], {
  env: { ...process.env, PATH: getAugmentedPath(), ... }
})

// Interactive mode (tokens parsed from status line)
pty.spawn('claude', ['--dangerously-skip-permissions'], {
  env: { ...process.env, PATH: getAugmentedPath(), ... }
})

// Shell mode (debugging/testing - no Claude CLI)
pty.spawn('bash', [], { ... })
```

**PATH resolution search order** (both `session.ts` and `screen-manager.ts`):
1. `which claude` (respects current PATH)
2. `~/.local/bin/claude`
3. `~/.claude/local/claude`
4. `/usr/local/bin/claude`
5. `~/.npm-global/bin/claude`
6. `~/bin/claude`

### Sending Input to Sessions

Two methods:
1. **`session.write(data)`** - Direct PTY write (used by `/api/sessions/:id/input` endpoint)
2. **`session.writeViaScreen(data)`** - Via GNU screen (RECOMMENDED for programmatic input). Used by RespawnController, auto-compact, auto-clear.

**How `writeViaScreen` works internally** (in `screen-manager.ts:sendInput`):
1. Splits input into text and `\r` (carriage return)
2. Sends text first: `screen -S name -p 0 -X stuff "text"`
3. Sends Enter separately: `screen -S name -p 0 -X stuff "$(printf '\015')"`

**Why separate commands?** Claude CLI uses Ink (React for terminals) which requires text and Enter as separate `screen -X stuff` commands. Combining them doesn't work. This is a critical implementation detail when debugging input issues.

### Idle Detection

**RespawnController**: Multi-layer detection with confidence scoring:
1. **Completion message**: Primary signal - detects "Worked for Xm Xs" time patterns (requires "Worked" prefix to avoid false positives)
2. **AI Idle Check** (enabled by default): Spawns a fresh Claude session in a screen to analyze terminal output and provide IDLE/WORKING verdict. Uses `claude-opus-4-5-20251101` by default, sends last 16k chars of terminal buffer. Timeout 90s, cooldown 3min after WORKING. Auto-disables after 3 consecutive errors.
3. **Output silence**: Confirms idle after `completionConfirmMs` (10s) of no new output
4. **Token stability**: Tokens haven't changed
5. **Working patterns absent**: No `Thinking`, `Writing`, spinner chars

Uses `confirming_idle` state to prevent false positives. Cancels idle confirmation if substantial output (>2 chars after ANSI stripping) arrives during the wait. Fallback: `noOutputTimeoutMs` (30s) if no output at all. AI check is triggered after the no-output fallback; if AI check is disabled/errored, falls back to direct idle confirmation.

**Step Confirmation**: After sending each respawn step (update, init, kickstart), waits for `completionConfirmMs` silence before proceeding. Ensures Claude finishes processing before the next command is sent.

**Session**: emits `idle`/`working` events on prompt detection + 2s activity timeout.

**Auto-Accept Plan Mode** (enabled by default): After `autoAcceptDelayMs` (8s) of silence with no completion message and no `elicitation_dialog` hook signal detected, sends Enter to accept the plan. Does NOT auto-accept AskUserQuestion prompts — those are blocked via the `elicitation_dialog` notification hook which signals the respawn controller to skip auto-accept.

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
- `TodoWrite` tool usage (including checkmark format: `✔ Task #N created:`, `✔ Task #N updated: status →`)
- Iteration patterns (`Iteration 5/50`, `[5/50]`)
- Todo checkboxes (`- [ ]`/`- [x]`) or indicator icons (`☐`/`◐`/`✓`)
- "All tasks complete" messages
- Individual task completion signals (`Task 8 is done`)

See `ralph-tracker.ts:shouldAutoEnable()` for detection logic.

**Auto-Configuration from Ralph Plugin State**: When a session starts, Claudeman reads `.claude/ralph-loop.local.md` to auto-configure:

```yaml
---
enabled: true
iteration: 5
max-iterations: 50
completion-promise: "COMPLETE"
---
```

Priority: 1) `.claude/ralph-loop.local.md` (official Ralph plugin state), 2) `CLAUDE.md` `<promise>` tags (fallback). See `src/ralph-config.ts`.

**Completion Detection** (multi-strategy):
- 1st occurrence of `<promise>PHRASE</promise>`: Stores as expected phrase (likely in prompt)
- 2nd occurrence: Emits `completionDetected` event (actual completion)
- **Bare phrase detection**: Also detects phrase without tags once expected phrase is known
- **All complete detection**: When "All X files/tasks created/completed" detected, marks all todos complete and emits completion
- If loop is already active (via `/ralph-loop:ralph-loop`): Emits immediately on first occurrence

**Session Lifecycle**: Each session has its own independent tracker:
- New session → Fresh tracker (no carryover)
- Close tab → Tracker state cleared, UI panel hides
- `tracker.reset()` → Clears todos/state, keeps enabled status
- `tracker.fullReset()` → Complete reset to initial state
- `tracker.configure({ enabled?, completionPhrase?, maxIterations? })` → Partial config update

**API**:
- `GET /api/sessions/:id/ralph-state` - Get loop state and todos
- `POST /api/sessions/:id/ralph-config` - Configure tracker:
  - `{ enabled: boolean }` - Enable/disable
  - `{ reset: true }` - Soft reset (keep enabled)
  - `{ reset: "full" }` - Full reset

### Terminal Display Fix

Tab switch/new session fix: clear xterm → write buffer → resize PTY → Ctrl+L redraw. Uses `pendingCtrlL` Set, triggered on `session:idle`/`session:working` events.

### SSE Events

All events broadcast to `/api/events` with format: `{ type: string, sessionId?: string, data: any }`.

Event prefixes: `session:`, `task:`, `respawn:`, `spawn:`, `hook:`, `scheduled:`, `case:`, `screen:`, `init`.

Key events (see `app.js:handleSSEEvent()`):
- `session:idle`, `session:working` - Status indicators
- `session:terminal`, `session:clearTerminal` - Terminal content
- `session:ralphLoopUpdate`, `session:ralphTodoUpdate`, `session:ralphCompletionDetected` - Ralph tracking
- `respawn:detectionUpdate` - Idle detection status
- `spawn:queued`, `spawn:started`, `spawn:completed`, `spawn:failed` - Agent lifecycle
- `hook:idle_prompt`, `hook:permission_prompt`, `hook:elicitation_dialog`, `hook:stop` - Claude Code hooks

### Frontend (app.js)

Vanilla JS + xterm.js. 60fps rendering: server batches terminal data every 16ms, client uses `requestAnimationFrame` to batch xterm.js writes.

### HTTPS & Browser Notifications

**HTTPS**: The `--https` flag generates/reuses self-signed certificates in `~/.claudeman/certs/`. Required for the Web Notification API.

**Notifications** (`NotificationManager` in `app.js`): In-app drawer, tab title flashing, Web Notification API (rate limited 3s), audio alerts (critical only), tab blinking (red=action, yellow=idle).

**Hook Event Data**: `/api/hook-event` forwards `data` field into SSE broadcast. Hook events: `permission_prompt`, `elicitation_dialog`, `idle_prompt`, `stop`.

### State Store

Writes debounced (500ms) to `~/.claudeman/state.json` via `persistSessionState()` on every meaningful change.

**Per-session fields stored** (`SessionState` in `types.ts`):
- `id`, `pid`, `status`, `name`, `mode` - Core identity
- `workingDir`, `createdAt`, `lastActivityAt` - Location and timestamps
- `autoClearEnabled/Threshold`, `autoCompactEnabled/Threshold/Prompt` - Context management
- `ralphEnabled`, `ralphCompletionPhrase` - Ralph tracker state
- `respawnEnabled`, `respawnConfig` - Respawn controller state
- `totalCost`, `inputTokens`, `outputTokens` - Token tracking
- `parentAgentId`, `childAgentIds` - Spawn agent tree

CLI commands (`claudeman status/session list`) read from `state.json` to display web-managed sessions.

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
- **Session setting**: Add field to `SessionState` in `types.ts`, include in `session.toState()`, call `this.persistSessionState(session)` in server.ts after the change
- **MCP tool**: Add tool definition in `mcp-server.ts` using `server.tool()`, use `apiRequest()` to call Claudeman REST API
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
- **Cleanup** (`cleanupSession()`): stops respawn, clears buffers/timers, kills screen, removes from `state.json`
- **State sync**: Every session create/delete/update calls `persistSessionState()` which writes full state (including respawn config from controller) to `state.json`
- **Recovery on restart**: Server reads `state.json` first (has all settings), falls back to `screens.json` for any sessions not found. Settings (auto-compact, auto-clear, respawn config, Ralph state) restored to live session objects after screen reattachment.

## TUI (WIP)

Ink/React-based TUI in `src/tui/`. Client to the web server, uses `/api/*` endpoints and attaches to screens via GNU screen. Not fully implemented yet.

## Buffer Limits

| Buffer | Max Size | Trim To |
|--------|----------|---------|
| Terminal | 2MB | 1.5MB |
| Text output | 1MB | 768KB |
| Messages | 1000 | 800 |
| Line buffer | 64KB | (flushed every 100ms) |
| Respawn buffer | 1MB | 512KB |

Tab switch uses `tail=256KB` for fast initial load, then chunked 64KB writes via `requestAnimationFrame`.

## API Routes

All routes defined in `server.ts:buildServer()`. Key endpoint groups:
- `/api/events` - SSE stream | `/api/status` - Full app state
- `/api/sessions` - CRUD + `/input`, `/resize`, `/interactive`
- `/api/sessions/:id/respawn/*` - Start/stop/enable/config respawn controller
- `/api/sessions/:id/ralph-*` - Ralph tracker config and state
- `/api/sessions/:id/auto-compact`, `/auto-clear` - Token threshold settings
- `/api/quick-start` - Create case + start session (`{mode?: 'claude'|'shell'}`)
- `/api/cases`, `/api/screens` - Case and screen management
- `/api/spawn/*` - Agent lifecycle (list, status, result, messages, cancel, trigger)
- `/api/hook-event` - Claude Code hook callbacks (`{event, sessionId, data?}`)


## State Files

| File | Purpose |
|------|---------|
| `~/.claudeman/state.json` | Full session state (all settings, tokens, respawn config, Ralph state), tasks, app config |
| `~/.claudeman/state-inner.json` | Ralph loop/todo state per session (separate to reduce writes) |
| `~/.claudeman/screens.json` | Screen session metadata (for recovery after restart) |
| `~/.claudeman/settings.json` | User preferences (lastUsedCase, custom template path) |
| `~/.claudeman/certs/` | Self-signed TLS certificates for `--https` mode |

**Recovery**: On restart, sessions restored from `state.json` (primary) with `screens.json` as fallback. All settings re-applied to live sessions. Cases created in `~/claudeman-cases/` by default.

### CLAUDE.md Templates

New cases get a CLAUDE.md generated from `src/templates/case-template.md` (bundled with the project). Template resolution order:
1. Custom path from `~/.claudeman/settings.json` (`defaultClaudeMdPath` field)
2. Bundled `case-template.md` (copied to `dist/templates/` during build)
3. Minimal fallback (if bundled template is missing)

Placeholders replaced:
- `[PROJECT_NAME]` → Case name
- `[PROJECT_DESCRIPTION]` → Description
- `[DATE]` → Current date (YYYY-MM-DD)

## Screen Session Manager (CLI Tool)

`./scripts/screen-manager.sh` - Interactive bash tool for managing screen sessions. Commands: `list`, `attach N`, `kill N,M`, `kill-all`, `info N`. Requires `jq` and `screen`.

## Documentation

- `docs/ralph-wiggum-guide.md` - Ralph Wiggum loop guide (plugin reference, prompt templates)
- `docs/claude-code-hooks-reference.md` - Claude Code hooks documentation

### Ralph Wiggum Loops

**Core Pattern**: `<promise>PHRASE</promise>` - The completion signal that tells the loop to stop.

**Skill Commands**:
```bash
/ralph-loop:ralph-loop    # Start Ralph Loop in current session
/ralph-loop:cancel-ralph  # Cancel active Ralph Loop
/ralph-loop:help          # Show help and usage
```

The `RalphTracker` class (`src/ralph-tracker.ts`) detects Ralph patterns in Claude output and tracks loop state, todos, and completion phrases. It auto-enables when Ralph-related patterns are detected.
