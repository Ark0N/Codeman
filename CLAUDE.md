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

# GOTCHA: `npm run dev` runs CLI help, NOT the web server
# Always use `npx tsx src/index.ts web` for development

# Testing (vitest with vi.mock() - no real Claude CLI spawned)
npm run test                              # Run all tests once
npm run test:watch                        # Watch mode
npm run test:coverage                     # With coverage report
npx vitest run test/session.test.ts       # Single file
npx vitest run -t "should create session" # By pattern

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

- **Session** (`src/session.ts`): Wraps Claude CLI as PTY subprocess. Two modes: `runPrompt(prompt)` for one-shot, `startInteractive()` for persistent terminal. Emits events: `output`, `terminal`, `message`, `completion`, `exit`, `idle`, `working`, `autoClear`, `clearTerminal`.

- **RespawnController** (`src/respawn-controller.ts`): State machine that keeps sessions productive. Detects idle → sends update prompt → optionally `/clear` → optionally `/init` → repeats. State flow: `WATCHING → SENDING_UPDATE → WAITING_UPDATE → SENDING_CLEAR → WAITING_CLEAR → SENDING_INIT → WAITING_INIT → WATCHING`

- **ScreenManager** (`src/screen-manager.ts`): Wraps sessions in GNU screen for persistence across server restarts. On startup, reconciles with `screen -ls` to restore sessions.

- **WebServer** (`src/web/server.ts`): Fastify server with REST API (`/api/*`) + SSE (`/api/events`). Wires session events to SSE broadcast.

### Session Modes

- **One-Shot** (`runPrompt(prompt)`): Single prompt execution, emits completion, exits
- **Interactive** (`startInteractive()`): Persistent PTY terminal with resize support
- **Shell** (`startShell()`): Plain bash/zsh terminal without Claude

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

```typescript
// One-shot mode (JSON output for token tracking)
pty.spawn('claude', ['-p', '--dangerously-skip-permissions', '--output-format', 'stream-json', prompt], { ... })

// Interactive mode (tokens parsed from status line)
pty.spawn('claude', ['--dangerously-skip-permissions'], { ... })
```

### Idle Detection

Session detects idle by watching for prompt character (`❯` or `\u276f`) and waiting 2 seconds without activity.

### Token Tracking

- **One-shot mode**: Uses `--output-format stream-json` for detailed token usage from JSON
- **Interactive mode**: Parses tokens from Claude's status line (e.g., "123.4k tokens"), estimates 60/40 input/output split

### Terminal Display Fix (Tab Switch & New Session)

When switching tabs or creating new sessions, terminal may be rendered at wrong size. Fix sequence:
1. Clear and reset xterm
2. Write terminal buffer
3. Send resize to update PTY dimensions
4. Send Ctrl+L (`\x0c`) to trigger Claude CLI redraw

Uses `pendingCtrlL` Set to track sessions needing the fix. Waits for `session:idle` or `session:working` SSE event before sending resize + Ctrl+L.

### SSE Events

All events broadcast to `/api/events` with format: `{ type: string, sessionId?: string, data: any }`.

Event prefixes: `session:`, `task:`, `respawn:`, `scheduled:`, `case:`, `init`. Key events: `session:idle`, `session:working`, `session:terminal`, `session:clearTerminal`, `session:completion`.

### Frontend (app.js)

The frontend uses vanilla JS with xterm.js. Key patterns:
- **SSE handling**: `handleSSEEvent()` switch statement dispatches all event types
- **Tab management**: `switchToSession()` handles terminal buffer restore + resize
- **60fps rendering**: Server batches at 16ms intervals, client uses `requestAnimationFrame`

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

## Notes

- State persists to `~/.claudeman/state.json` and `~/.claudeman/screens.json`
- Cases created in `~/claudeman-cases/` by default
- Kill All works on restored sessions: `Session.stop()` checks screenManager directly by session ID
- Long-running sessions (12-24+ hours) supported with automatic buffer trimming (5MB terminal, 2MB text, 1000 messages max)
- E2E testing available via agent-browser (see `.claude/skills/e2e-test.md`)
