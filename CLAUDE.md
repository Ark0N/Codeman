# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## ⚠️ CRITICAL: Screen Session Safety

**You may be running inside a Claudeman-managed screen session.** Before killing ANY screen or Claude process:

1. **Check environment**: `echo $CLAUDEMAN_SCREEN` - if it returns `1`, you're in a managed session
2. **NEVER run** `screen -X quit`, `pkill screen`, or `pkill claude` without first confirming you're not killing yourself
3. **Safe debugging**: Use `screen -ls` to LIST sessions, but don't kill them blindly
4. **If you need to kill screens**: Use the web UI or `./scripts/screen-manager.sh` instead of direct commands

**Why this matters**: Killing your own screen terminates your session mid-work, losing context and potentially corrupting state.

## ⚡ COM Shorthand (Deployment)

When user says "COM": 1) Increment version in BOTH `package.json` AND `CLAUDE.md`, 2) `git add && git commit && git push && npm run build && systemctl --user restart claudeman-web`. Always bump version on every COM.

## Project Overview

Claudeman is a Claude Code session manager with a web interface and autonomous Ralph Loop. It spawns Claude CLI processes via PTY, streams output in real-time via SSE, and supports scheduled/timed runs.

**Version**: 0.1365 (must match `package.json`)

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

### Build & Clean

```bash
npm run build          # Compile TS + copy static files + templates + make bins executable
npm run clean          # Remove dist/
npm run typecheck      # Type check without building (or: npx tsc --noEmit)
```

### Web Server

```bash
npx tsx src/index.ts web           # Dev mode - no build needed (RECOMMENDED)
npx tsx src/index.ts web -p 8080   # Dev mode with custom port
npx tsx src/index.ts web --https   # Dev mode with self-signed TLS (enables browser notifications)
npm run web                        # After npm run build (shorthand)
node dist/index.js web             # After npm run build
claudeman web                      # After npm link
```

### TUI (Terminal User Interface)

```bash
npx tsx src/index.ts tui           # Dev mode - prompts to start web if not running
claudeman tui                      # After npm link
claudeman tui --with-web           # Auto-start web server if not running (no prompt)
claudeman tui --no-web             # Skip web server check entirely
claudeman tui -p 8080              # Specify web server port
```

### Testing

```bash
npm run test                              # Run all tests once
npm run test:watch                        # Watch mode
npm run test:coverage                     # With coverage report
npx vitest run test/session.test.ts       # Single file
npx vitest run -t "should create session" # By pattern
```

**Test Configuration** (vitest.config.ts):
- `globals: true` - no imports needed for `describe`/`it`/`expect`
- `testTimeout: 30000` - 30s for integration tests
- `teardownTimeout: 60000` - 60s ensures cleanup runs even on failures
- `fileParallelism: false` - sequential file execution to respect screen session limits
- Coverage excludes entry points: `src/index.ts`, `src/cli.ts`

**Test Port Allocation** (integration tests spawn servers):

| Port | Test File |
|------|-----------|
| 3099 | quick-start.test.ts |
| 3102 | session.test.ts |
| 3105 | scheduled-runs.test.ts |
| 3107 | sse-events.test.ts |
| 3110 | edge-cases.test.ts |
| 3115 | integration-flows.test.ts |
| 3120 | session-cleanup.test.ts |
| 3125 | ralph-integration.test.ts |
| 3127 | respawn-integration.test.ts (reserved) |
| 3130 | hooks-config.test.ts (Hook Event API) |
| 3131 | hooks-config.test.ts (Hook Data Sanitization) |
| 3150 | browser-e2e.test.ts (main browser tests) |
| 3151 | browser-e2e.test.ts (SSE events tests) |
| 3152 | browser-e2e.test.ts (hook events tests) |
| 3153 | browser-e2e.test.ts (Ralph panel tests) |

**Next available port**: 3154

Unit tests (no port needed): respawn-controller, ralph-tracker, pty-interactive, task-queue, task, ralph-loop, session-manager, state-store, types, templates, ralph-config, spawn-detector, spawn-types, spawn-orchestrator, ai-idle-checker, ai-plan-checker

**Test Utilities**: `test/respawn-test-utils.ts` provides MockSession, MockAiIdleChecker, MockAiPlanChecker, time controller, state tracker, and event recorder for respawn controller testing. See `test/respawn-test-plan.md` for architecture and `test/respawn-scenarios.md` for comprehensive test scenarios.

**Test Safety**: `test/setup.ts` enforces max 10 concurrent screens, performs orphan cleanup, and protects its own process tree. You can safely run tests from within a Claudeman-managed session - the cleanup will not kill your own Claude instance. The respawn-controller tests use MockSession (not real screens).

**Test Cleanup Patterns**: Integration tests track resources in `createdSessions` and `createdCases` arrays, cleaned up by `afterAll`/`afterEach` hooks. However, some tests perform cleanup in the test body itself (e.g., `edge-cases.test.ts:273-302` creates 5 sessions and cleans them in a loop). If assertions fail before cleanup code runs, resources leak.

**Known Cleanup Issues**:
- `pty-interactive.test.ts`: Uses `await session.stop()` at end of each test, not in `afterEach`. Test failures leave sessions running.
- `edge-cases.test.ts`: Multiple sessions created in test body with cleanup at end; failures leak sessions.
- Test cases (`~/claudeman-cases/`): Cases named `flow-test-*`, `ralph-track-loop-*`, `session-detail-*` may persist after test failures.

**Manual Cleanup**:
```bash
# Remove orphaned test cases
rm -rf ~/claudeman-cases/flow-test-* ~/claudeman-cases/ralph-track-loop-* ~/claudeman-cases/session-detail-*

# Kill orphaned test screens (only detached claudeman screens)
screen -ls | grep -E 'Detached.*claudeman' | cut -d. -f1 | xargs -I{} screen -S {} -X quit
```

### MCP Server

```bash
npx tsx src/mcp-server.ts                 # Dev mode (stdio transport)
```

Configure in Claude Code's MCP settings:
```json
{ "command": "node", "args": ["dist/mcp-server.js"], "env": { "CLAUDEMAN_API_URL": "http://localhost:3000", "CLAUDEMAN_SESSION_ID": "<id>" } }
```

### Debugging

```bash
screen -ls                                # List GNU screen sessions
screen -r <name>                          # Attach to screen session (Ctrl+A D to detach)
curl localhost:3000/api/sessions          # Check active sessions
curl localhost:3000/api/status | jq .     # Full app state including respawn
cat ~/.claudeman/state.json | jq .        # View main state
cat ~/.claudeman/state-inner.json | jq .  # View Ralph loop state
```

### Systemd Service

```bash
systemctl --user status claudeman-web     # Check status
systemctl --user restart claudeman-web    # Restart
systemctl --user stop claudeman-web       # Stop
journalctl --user -u claudeman-web -f     # Stream logs
```

Install: `ln -sf scripts/claudeman-web.service ~/.config/systemd/user/`
Enable: `systemctl --user enable claudeman-web && loginctl enable-linger $USER`

### Kill Stuck Screens

```bash
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

**Core Session Management:**
| File | Purpose |
|------|---------|
| `src/session.ts` | Core PTY wrapper for Claude CLI. Modes: `runPrompt()`, `startInteractive()`, `startShell()` |
| `src/screen-manager.ts` | GNU screen persistence, ghost discovery, 4-strategy kill |
| `src/session-manager.ts` | Session lifecycle, task assignment, cleanup |
| `src/state-store.ts` | JSON persistence to `~/.claudeman/` with debounced writes |
| `src/types.ts` | All TypeScript interfaces |

**Autonomous Features:**
| File | Purpose |
|------|---------|
| `src/respawn-controller.ts` | State machine for autonomous session cycling |
| `src/ai-idle-checker.ts` | Spawns Claude to analyze terminal output for IDLE/WORKING verdict |
| `src/ai-plan-checker.ts` | Spawns Claude to detect plan mode prompts for auto-accept |
| `src/ralph-tracker.ts` | Detects `<promise>PHRASE</promise>`, todos, loop status |
| `src/ralph-config.ts` | Parses `.claude/ralph-loop.local.md` and CLAUDE.md for Ralph config |

**Spawn Protocol (Autonomous Agents):**
| File | Purpose |
|------|---------|
| `src/spawn-orchestrator.ts` | Full agent lifecycle: spawn, monitor, budget, queue, cleanup |
| `src/mcp-server.ts` | MCP server binary exposing spawn tools to Claude Code |
| `src/subagent-watcher.ts` | Monitors Claude Code background agents in `~/.claude/projects/*/subagents/*.jsonl` |

**Web & TUI:**
| File | Purpose |
|------|---------|
| `src/web/server.ts` | Fastify REST API + SSE at `/api/events` |
| `src/web/public/app.js` | Frontend: SSE handling, xterm.js, tab management |
| `src/tui/App.tsx` | TUI main component (Ink/React) |
| `src/tui/DirectAttach.ts` | Full-screen console attach with tab switching |

### Data Flow

1. **Session** spawns `claude -p --dangerously-skip-permissions` via `node-pty` (PATH augmented to include claude's install directory)
2. PTY output is buffered, ANSI stripped, and parsed for JSON messages
3. **WebServer** broadcasts events to SSE clients at `/api/events`
4. Full session state (settings, tokens, respawn config, Ralph state) persists to `~/.claudeman/state.json` via **StateStore**
5. Screen metadata persists separately to `~/.claudeman/screens.json` for session recovery

### Respawn State Machine

State machine for autonomous session cycling: `watching` → `confirming_idle` → `ai_checking` → `sending_update` → `waiting_update` → `sending_clear` → `waiting_clear` → `sending_init` → `waiting_init` → `monitoring_init` → (optionally) `sending_kickstart`. Steps can be skipped via config (`sendClear: false`, `sendInit: false`). After each step, waits for `completionConfirmMs` (10s) of output silence before proceeding. AI idle check uses a fresh Claude session to analyze terminal output for IDLE/WORKING verdict.

See `docs/respawn-state-machine.md` for the full state diagram, idle detection layers, and auto-accept behavior.

### Spawn1337 Protocol (Autonomous Agents)

Spawned agents are full-power Claude sessions in their own screen sessions, managed via MCP tools (`spawn_agent`, `list_agents`, `get_agent_status`, `get_agent_result`, `send_agent_message`, `cancel_agent`). Max 5 concurrent, max depth 3, default timeout 30min. Agents communicate via filesystem (`spawn-comms/`) and signal completion via `<promise>PHRASE</promise>`.

See `docs/spawn-protocol.md` for the full protocol flow, directory structure, resource governance, and MCP configuration.

### Subagent Watcher (Claude Code Background Agents)

Monitors Claude Code's internal background agents (the `Task` tool) in real-time. Watches `~/.claude/projects/{project}/{session}/subagents/agent-{id}.jsonl` files and emits structured events.

**Events**: `subagent:discovered`, `subagent:tool_call`, `subagent:progress`, `subagent:message`, `subagent:completed`

**API**:
- `GET /api/subagents` - List all known subagents (optional `?minutes=60` for recent only)
- `GET /api/subagents/:agentId` - Get subagent info
- `GET /api/subagents/:agentId/transcript` - Get transcript (`?limit=N`, `?format=formatted`)
- `DELETE /api/subagents/:agentId` - Kill subagent process
- `GET /api/sessions/:id/subagents` - Get subagents for session's working directory

**Status lifecycle**: `active` → `idle` (30s no activity) → `completed` (process exited or file stale)

**Settings**: Can be disabled via App Settings → Display → "Enable Subagent Tracking" (default: enabled). Setting is stored in `~/.claudeman/settings.json` as `subagentTrackingEnabled`.

Implementation: `src/subagent-watcher.ts` - singleton `subagentWatcher` started on server boot (if enabled).

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

**Session**: emits `idle`/`working` events on prompt detection + 2s activity timeout.

**RespawnController**: Multi-layer detection (completion message → AI idle check → output silence → token stability → working pattern absence). See `docs/respawn-state-machine.md` for full details.

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

Detects Ralph loops and todos inside Claude sessions. **Disabled by default** but auto-enables when Ralph-related patterns are detected (promise tags, TodoWrite, iteration patterns, etc.). See `ralph-tracker.ts:shouldAutoEnable()` for the full pattern list.

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

Event prefixes: `session:`, `task:`, `respawn:`, `spawn:`, `subagent:`, `hook:`, `scheduled:`, `case:`, `screen:`, `init`.

Key events (see `app.js:handleSSEEvent()`):
- `session:idle`, `session:working` - Status indicators
- `session:terminal`, `session:clearTerminal` - Terminal content
- `session:ralphLoopUpdate`, `session:ralphTodoUpdate`, `session:ralphCompletionDetected` - Ralph tracking
- `respawn:detectionUpdate` - Idle detection status
- `spawn:queued`, `spawn:started`, `spawn:completed`, `spawn:failed` - Agent lifecycle
- `subagent:discovered`, `subagent:tool_call`, `subagent:progress`, `subagent:message`, `subagent:completed` - Claude Code background agents
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

Module resolution: NodeNext. Target: ES2022. Strict mode enabled with all additional strictness flags (`noUnusedLocals`, `noUnusedParameters`, `noImplicitReturns`, `noFallthroughCasesInSwitch`, etc.). No ESLint/Prettier configured - rely on TypeScript strict mode.

TUI uses React JSX (`jsx: react-jsx`, `jsxImportSource: react`) for Ink components.

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
- `/api/subagents` - List/get/kill Claude Code background agents, get transcripts
- `/api/sessions/:id/subagents` - Get subagents for a specific session's working directory
- `/api/hook-event` - Claude Code hook callbacks (`{event, sessionId, data?}`)


## State Files

| File | Purpose |
|------|---------|
| `~/.claudeman/state.json` | Full session state (all settings, tokens, respawn config, Ralph state), tasks, app config |
| `~/.claudeman/state-inner.json` | Ralph loop/todo state per session (separate to reduce writes) |
| `~/.claudeman/screens.json` | Screen session metadata (for recovery after restart) |
| `~/.claudeman/settings.json` | User preferences (lastUsedCase, custom template path, subagentTrackingEnabled) |
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

- `docs/respawn-state-machine.md` - Respawn controller states, idle detection, auto-accept
- `docs/spawn-protocol.md` - Spawn1337 agent protocol, MCP tools, resource governance
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
