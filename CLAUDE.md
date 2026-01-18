# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Claudeman is a Claude Code session manager with a web interface and autonomous Ralph Loop. It spawns Claude CLI processes via PTY, streams output in real-time via SSE, and supports scheduled/timed runs.

**Tech Stack**: TypeScript, Node.js, Fastify, Server-Sent Events, node-pty

## Commands

```bash
# Development
npm run build          # Compile TypeScript + copy static files to dist/web/
npm run dev            # Run with tsx (no build needed)

# Production
npm link               # Make 'claudeman' globally available
claudeman web          # Start web interface on port 3000
claudeman web -p 8080  # Custom port

# CLI examples
claudeman status                           # Overall status
claudeman session start --dir /path        # Start Claude session
claudeman task add "Fix bug" --priority 5  # Add task to queue
claudeman ralph start --min-hours 4        # Start autonomous loop
```

## Architecture

### Core Data Flow

1. **Session** (`src/session.ts`) spawns Claude CLI via `node-pty` with `--dangerously-skip-permissions`
2. PTY output is buffered and parsed for JSON messages (types: `system`, `assistant`, `result`)
3. **WebServer** (`src/web/server.ts`) broadcasts events to connected SSE clients
4. State persists to `~/.claudeman/state.json` via **StateStore**

### Key Components

- **Session**: Wraps `claude -p --output-format stream-json` as PTY subprocess. Emits `output`, `terminal`, `message`, `completion`, `exit` events.
- **WebServer**: Fastify server exposing REST API + SSE endpoint at `/api/events`. Manages ScheduledRuns (timed loops that repeatedly run prompts).
- **RespawnController**: Manages automatic respawning of interactive Claude sessions. Detects idle state → sends update prompt → `/clear` → `/init` → repeats.
- **RalphLoop**: Autonomous controller that assigns tasks to idle sessions and detects completion via `<promise>PHRASE</promise>` markers.
- **TaskQueue**: Priority-based queue with dependency support.

### REST API Endpoints

```
GET  /api/status              # Full state (sessions + scheduled + respawn)
GET  /api/sessions            # List all sessions
POST /api/sessions            # Create session { workingDir }
POST /api/sessions/:id/run    # Run prompt { prompt }
POST /api/sessions/:id/input  # Send input to interactive session
POST /api/sessions/:id/interactive-respawn  # Start interactive + respawn

# Respawn control
GET  /api/sessions/:id/respawn        # Get respawn status
POST /api/sessions/:id/respawn/start  # Start respawn controller
POST /api/sessions/:id/respawn/stop   # Stop respawn controller
PUT  /api/sessions/:id/respawn/config # Update respawn config

GET  /api/scheduled           # List scheduled runs
POST /api/scheduled           # Create { prompt, workingDir, durationMinutes }
POST /api/cases               # Create case directory with CLAUDE.md template
```

### SSE Events

Events broadcast to `/api/events` clients:
- `session:output`, `session:terminal`, `session:message`
- `session:completion`, `session:exit`, `session:working`, `session:idle`
- `scheduled:created`, `scheduled:updated`, `scheduled:log`, `scheduled:completed`
- `respawn:started`, `respawn:stopped`, `respawn:stateChanged`
- `respawn:cycleStarted`, `respawn:cycleCompleted`, `respawn:stepSent`, `respawn:stepCompleted`, `respawn:log`

## Code Patterns

### Claude Message Parsing

Claude CLI outputs newline-delimited JSON. Strip ANSI codes before parsing:

```typescript
const cleanLine = line.replace(/\x1b\[[0-9;]*m/g, '');
const msg = JSON.parse(cleanLine) as ClaudeMessage;
// msg.type: 'system' | 'assistant' | 'result'
// msg.message?.content: Array<{ type: 'text', text: string }>
// msg.total_cost_usd: number (on result messages)
```

### Idle Detection

Session detects idle state by watching for prompt character (`❯` or `\u276f`) and waiting 2 seconds without activity.

### Respawn Controller State Machine

`RespawnController` (`src/respawn-controller.ts`) cycles through states to keep Claude productive:

```
WATCHING → SENDING_UPDATE → WAITING_UPDATE → SENDING_CLEAR → WAITING_CLEAR → SENDING_INIT → WAITING_INIT → WATCHING
```

**Default sequence:**
1. Detect idle (5s timeout after prompt with no activity)
2. Send: `update all the docs and CLAUDE.md`
3. Wait for completion (detects prompt after work stops)
4. Send: `/clear`
5. Send: `/init`
6. Return to watching

**Configuration options** (`RespawnConfig`):
- `idleTimeoutMs`: How long to wait after prompt (default: 5000)
- `updatePrompt`: Custom prompt to send (default: "update all the docs and CLAUDE.md")
- `interStepDelayMs`: Delay between steps (default: 1000)
- `enabled`: Toggle respawn on/off

### Template Generation

`src/templates/claude-md.ts` generates CLAUDE.md files for new cases via the `/api/cases` endpoint.

## Session Log

| Date | Tasks Completed | Files Changed | Notes |
|------|-----------------|---------------|-------|
| 2026-01-18 | Initial implementation | All files | Core CLI + web interface |
| 2026-01-18 | Add web interface | src/web/* | Fastify + SSE + responsive UI |
| 2026-01-18 | Add RespawnController | src/respawn-controller.ts, src/web/server.ts, src/types.ts | Auto-respawn loop with state machine |
