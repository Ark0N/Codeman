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

**Requirements**: Node.js 18+, Claude CLI (`claude`) in PATH, GNU Screen (`apt install screen` / `brew install screen`)

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
# Unit tests (no port needed): respawn-controller, ralph-tracker, pty-interactive, task-queue, task, ralph-loop, session-manager, state-store, types, templates, ralph-config, spawn-detector, spawn-types, spawn-orchestrator, hooks-config
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

1. **Session** spawns `claude -p --dangerously-skip-permissions` via `node-pty`
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

**Step confirmation**: After sending each step (update, clear, init, kickstart), the controller waits for `completionConfirmMs` (5s) of output silence before proceeding to the next step. This prevents sending commands while Claude is still processing.

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

**Legacy Tag Patterns** (detected by `SpawnDetector`, still functional but superseded by MCP):
- `<spawn1337>path/to/task.md</spawn1337>` - Spawn request
- `<spawn1337-status agentId="id"/>` - Status query
- `<spawn1337-cancel agentId="id"/>` - Cancel request
- `<spawn1337-message agentId="id">content</spawn1337-message>` - Message to child

**Agent Communication Directory:**
```
~/claudeman-cases/spawn-<agentId>/
├── CLAUDE.md              # Auto-generated agent instructions
├── spawn-comms/
│   ├── task.md            # Copy of original task spec
│   ├── progress.json      # Agent updates periodically
│   ├── result.md          # Final result (YAML frontmatter + body)
│   └── messages/          # Bidirectional message files (NNN-parent.md, NNN-agent.md)
└── workspace/             # Symlinked context files
```

**Task Spec Format** (YAML frontmatter in .md file):
```yaml
---
agentId: my-agent-001
name: My Agent
type: explore          # explore|implement|test|review|refactor|research|generate|fix|general
priority: high         # low|normal|high|critical
maxTokens: 150000
maxCost: 0.50
timeoutMinutes: 15
canModifyParentFiles: false
contextFiles: [src/auth.ts, src/types.ts]
dependsOn: [other-agent-id]
completionPhrase: MY_AGENT_DONE
outputFormat: structured  # markdown|json|code|structured|freeform
---
Task instructions here...
```

**Resource Governance:**
- Budget warning at 80% of token/cost limit
- Graceful shutdown message at 100%
- Force kill at 110% (or timeout + 60s grace)
- Max concurrent agents: 5 (configurable)
- Max spawn depth: 3 (prevents infinite recursion)
- Default timeout: 30 minutes (max: 120)

**Session Integration:** The MCP server communicates with the Claudeman API over HTTP. Legacy SpawnDetector (alongside RalphTracker) can still forward terminal data for tag-based spawning. Spawn events (`spawnRequested`, `spawnStatusRequested`, `spawnCancelRequested`, `spawnMessageToChild`) are emitted on the session and wired to the orchestrator in server.ts.

**Agent Tree:** Agents can spawn children (up to `maxSpawnDepth`). Sessions track `parentAgentId` and `childAgentIds`. Cancelling a parent cascades to all children.

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

**RespawnController (Claude Code 2024+)**: Multi-layer detection with confidence scoring:
1. **Completion message**: Primary signal - detects "for Xm Xs" time patterns (e.g., "Worked for 2m 46s")
2. **Output silence**: Confirms idle after `completionConfirmMs` (5s) of no new output
3. **Token stability**: Tokens haven't changed
4. **Working patterns absent**: No `Thinking`, `Writing`, spinner chars

Uses `confirming_idle` state to prevent false positives. Fallback: `noOutputTimeoutMs` (30s) if no output at all.

**Step Confirmation**: After sending each respawn step (update, init, kickstart), the controller waits for the same `completionConfirmMs` silence before proceeding. This ensures Claude finishes processing each prompt before the next command is sent.

**Session**: emits `idle`/`working` events on prompt detection + 2s activity timeout.

**Auto-Accept Plan Mode** (enabled by default): When Claude enters plan mode and presents a plan for approval, output stops without a completion message. After `autoAcceptDelayMs` (8s) of silence with no completion message and no `elicitation_dialog` hook signal detected, sends Enter to accept the plan. Does NOT auto-accept AskUserQuestion prompts — those are blocked via the `elicitation_dialog` notification hook which signals the respawn controller to skip auto-accept. Safety: only fires once per silence period, requires prior output, won't fire during active respawn cycles.

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

Event prefixes: `session:`, `task:`, `respawn:`, `spawn:`, `hook:`, `scheduled:`, `case:`, `screen:`, `init`.

Key events for frontend handling (see `app.js:handleSSEEvent()`):
- `session:idle`, `session:working` - Status indicator updates
- `session:terminal`, `session:clearTerminal` - Terminal content
- `session:completion`, `session:autoClear`, `session:autoCompact` - Lifecycle events
- `session:ralphLoopUpdate`, `session:ralphTodoUpdate`, `session:ralphCompletionDetected` - Ralph tracking
- `respawn:detectionUpdate` - Multi-layer idle detection status (confidence level, waiting state)
- `spawn:queued`, `spawn:started`, `spawn:completed`, `spawn:failed`, `spawn:timeout`, `spawn:cancelled` - Agent lifecycle
- `spawn:progress`, `spawn:message`, `spawn:budgetWarning`, `spawn:stateUpdate` - Agent monitoring
- `hook:idle_prompt`, `hook:permission_prompt`, `hook:elicitation_dialog`, `hook:stop` - Claude Code hooks (notifications + tab alerts, includes forwarded data fields)

### Frontend (app.js)

Vanilla JS + xterm.js. Key functions:
- `handleSSEEvent()` - Dispatches events to appropriate handlers
- `selectSession()` - Tab switching, terminal buffer load, and focus
- `NotificationManager` - Multi-layer notifications with click-to-navigate
- `tabAlerts` Map - Tracks blinking state per session (`'action'` | `'idle'`)

**60fps Rendering Pipeline**:
- Server batches terminal data every 16ms before broadcasting via SSE
- Client uses `requestAnimationFrame` to batch xterm.js writes
- Prevents UI jank during high-throughput Claude output

### HTTPS & Browser Notifications

**HTTPS**: The `--https` flag generates/reuses self-signed certificates in `~/.claudeman/certs/` (`server.key`, `server.crt`). Required for the Web Notification API in browsers.

**Notification Layers** (in `app.js`, `NotificationManager` class):
1. In-app drawer with notification list (click to navigate to session)
2. Tab title flashing with unread count (when tab unfocused)
3. Web Notification API (browser push notifications, click navigates to session)
4. Audio alerts (critical level only)
5. Tab blinking alerts (red for action-required, yellow for idle)

**Browser Notification Behavior:**
- Enabled by default (`browserNotifications: true`, prefs version 2)
- Auto-requests permission on first notification attempt
- Critical/warning notifications fire regardless of tab visibility
- Info notifications only fire when tab is hidden
- Rate limited: max 1 browser notification per 3 seconds
- Click navigates to the affected session

**Tab Alert Blinking:**
- `hook:permission_prompt` / `hook:elicitation_dialog` → red blink (2.5s cycle, `tab-alert-action`)
- `hook:idle_prompt` → yellow blink (3.5s cycle, `tab-alert-idle`)
- Only blinks non-active tabs (active tab is already visible)
- Clears when: user clicks the tab, or `session:working` event fires

**Hook Event Data Forwarding:**
The `/api/hook-event` endpoint forwards the `data` field from the request body into the SSE broadcast. Notifications display actual details:
- permission_prompt: tool name + command/file (e.g., "Bash: docker push prod:latest")
- elicitation_dialog: question text (e.g., "Merge PR #42 to main?")
- idle_prompt: custom message if provided
- stop: reason if provided

Notifications triggered for: session events, respawn updates, spawn agent lifecycle, hook events. Preferences persist to server-side `state.json` per session.

### State Store

Writes debounced (500ms) to `~/.claudeman/state.json`. The web server persists full session state via `persistSessionState()` on every meaningful change:

**Persistence triggers**: session create, delete, rename, settings change (auto-compact, auto-clear, Ralph config), respawn start/stop/update/expire, completion, exit.

**Per-session fields stored** (`SessionState` in `types.ts`):

| Field | Description |
|-------|-------------|
| `id`, `pid`, `status` | Core session identity |
| `name`, `mode` | Display name, 'claude' or 'shell' |
| `workingDir`, `createdAt`, `lastActivityAt` | Location and timestamps |
| `autoClearEnabled`, `autoClearThreshold` | Auto-clear settings |
| `autoCompactEnabled`, `autoCompactThreshold`, `autoCompactPrompt` | Auto-compact settings |
| `ralphEnabled`, `ralphCompletionPhrase` | Ralph / Todo tracker state |
| `respawnEnabled` | Whether respawn controller is currently running |
| `respawnConfig` | Full respawn config including `durationMinutes` |
| `totalCost`, `inputTokens`, `outputTokens` | Token and cost tracking |
| `parentAgentId`, `childAgentIds` | Spawn agent tree relationships |

**CLI visibility**: The `claudeman status` and `claudeman session list` commands read from `state.json` to display web server-managed sessions, even though they run in a separate process.

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
| Respawn idle timeout | 10s default | `RespawnConfig.idleTimeoutMs` |
| Respawn completion confirm | 5s | `RespawnConfig.completionConfirmMs` |
| Respawn auto-accept delay | 8s | `RespawnConfig.autoAcceptDelayMs` |
| Respawn no-output fallback | 30s | `RespawnConfig.noOutputTimeoutMs` |
| Spawn event debounce | 50ms | `spawn-detector.ts` |
| Spawn line buffer max | 64KB | `spawn-detector.ts` |
| Spawn progress poll | 5s | `spawn-orchestrator.ts` |
| Spawn default timeout | 30 min | `spawn-orchestrator.ts` |
| Spawn max timeout | 120 min | `spawn-orchestrator.ts` |
| Spawn max concurrent | 5 agents | `spawn-orchestrator.ts` |
| Spawn max depth | 3 levels | `spawn-orchestrator.ts` |
| Spawn budget warning | 80% | `spawn-orchestrator.ts` |
| Spawn budget grace | 60s | `spawn-orchestrator.ts` |
| Browser notif rate limit | 3s | `app.js` (NotificationManager) |
| Tab blink red (action) | 2.5s cycle | `styles.css` (tab-alert-action) |
| Tab blink yellow (idle) | 3.5s cycle | `styles.css` (tab-alert-idle) |
| Systemd restart delay | 5s | `claudeman-web.service` |

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

## TUI Architecture (Ink/React)

The TUI (`claudeman tui`) is built with [Ink](https://github.com/vadimdemedes/ink) (React for terminals).

**Component Hierarchy:**
```
App.tsx
├── StartScreen.tsx         # Session/case list, navigation
│   ├── List navigation (↑/↓, Enter, a/d/D)
│   ├── Case creation flow
│   └── Tab switcher menu
├── DirectAttach.ts         # Full-screen console attach with tab switching
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
| POST | `/api/sessions/:id/respawn/start` | Start respawn controller (merges pre-saved config) |
| POST | `/api/sessions/:id/respawn/stop` | Stop respawn controller |
| POST | `/api/sessions/:id/respawn/enable` | Enable respawn with config + optional timer |
| GET | `/api/sessions/:id/respawn/config` | Get current or pre-saved respawn config |
| PUT | `/api/sessions/:id/respawn/config` | Update config (works with or without running controller) |
| POST | `/api/sessions/:id/ralph-config` | Configure Ralph / Todo Tracker settings |
| GET | `/api/sessions/:id/ralph-state` | Get Ralph loop state + todos |
| POST | `/api/sessions/:id/auto-compact` | Configure auto-compact threshold |
| POST | `/api/sessions/:id/auto-clear` | Configure auto-clear threshold |
| POST | `/api/quick-start` | Create case + start session. Body: `{mode?: 'claude'\|'shell'}` |
| GET | `/api/cases` | List available cases |
| POST | `/api/cases` | Create new case |
| GET | `/api/screens` | List screen sessions with stats |
| GET | `/api/spawn/agents` | List all spawn agents (active + completed + queued) |
| GET | `/api/spawn/agents/:agentId` | Detailed agent status + progress |
| GET | `/api/spawn/agents/:agentId/result` | Read agent's result.md |
| GET | `/api/spawn/agents/:agentId/messages` | List messages in channel |
| POST | `/api/spawn/agents/:agentId/message` | Send message to agent |
| POST | `/api/spawn/agents/:agentId/cancel` | Cancel agent (graceful stop) |
| DELETE | `/api/spawn/agents/:agentId` | Force kill + cleanup |
| GET | `/api/spawn/status` | Orchestrator status (counts, config) |
| PUT | `/api/spawn/config` | Update orchestrator config |
| POST | `/api/spawn/trigger` | Programmatic spawn (bypass terminal detection) |
| POST | `/api/hook-event` | Receive Claude Code hook callbacks. Body: `{event, sessionId, data?}`. Data fields forwarded to SSE broadcast |

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
| `~/.claudeman/state.json` | Full session state (all settings, tokens, respawn config, Ralph state), tasks, app config |
| `~/.claudeman/state-inner.json` | Ralph loop/todo state per session (separate to reduce writes) |
| `~/.claudeman/screens.json` | Screen session metadata (for recovery after restart) |
| `~/.claudeman/settings.json` | User preferences (lastUsedCase, custom template path) |
| `~/.claudeman/certs/` | Self-signed TLS certificates for `--https` mode |

**State lifecycle**:
- Web server creates → session added to `state.json` + `screens.json`
- Settings change → `state.json` updated (debounced 500ms)
- Session deleted → removed from `state.json` (screen may survive if `killScreen: false`)
- Server shutdown → sessions preserved in `state.json` (not wiped), screens preserved in `screens.json`
- Server restart → sessions restored from `state.json` (primary) with `screens.json` as fallback

**Recovery strategy** (double redundancy):
1. **Primary**: `state.json` retains full session state across restarts (settings, tokens, respawn config)
2. **Fallback**: `screens.json` provides screen metadata if `state.json` is missing a session
3. After restoration, all settings (auto-compact, auto-clear, respawn, Ralph) are re-applied to live sessions
4. `persistSessionState()` called after all restorations complete to sync final state

Cases created in `~/claudeman-cases/` by default.

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
