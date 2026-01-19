# Claudeman

A Claude Code session manager with an autonomous Ralph Loop for task assignment and monitoring.

## Features

- **Web Interface**: Beautiful, responsive web UI with interactive terminal powered by xterm.js and modern gradient styling
- **Session Management**: Spawn and manage multiple Claude CLI sessions as PTY subprocesses with one-click kill
- **Interactive Terminal**: Full terminal access with resize support, buffer persistence, and 60fps batched rendering
- **Respawn Controller**: Autonomous state machine that cycles sessions (update docs → /clear → /init) with configurable prompts
- **Enable Respawn on Existing Sessions**: Start respawn on already-running sessions without restarting
- **Timed Respawn**: Set duration limits for respawn loops with countdown timer display
- **Auto-Clear Context**: Automatically send /clear when token count exceeds threshold (default 100k)
- **Token Tracking**: Real-time input/output token tracking per session
- **Background Task Tracking**: Detect and display Claude's background tasks in a tree view
- **Timed Runs**: Schedule Claude to work for a specific duration with animated live countdown
- **Real-time Output**: Stream Claude's responses in real-time via Server-Sent Events (30 event types)
- **Task Queue**: Priority-based task queue with dependency support
- **Ralph Loop**: Autonomous control loop that assigns tasks to idle sessions and monitors completion
- **Time-Aware Loops**: Extended work sessions with auto-generated follow-up tasks when minimum duration not reached
- **Case Management**: Create project workspaces with auto-generated CLAUDE.md templates
- **Cost Tracking**: Track total API costs across all sessions
- **State Persistence**: All state persisted to `~/.claudeman/state.json`
- **Long-Running Support**: Optimized for 12-24+ hour sessions with automatic buffer trimming
- **Resource Monitoring**: Real-time memory/message usage display for each session
- **Multi-Tab Sessions**: Open 1-10 Claude sessions at once for the same project
- **Session Restoration**: Automatically restore screen sessions when server restarts
- **Monitor Panel**: Combined view of screen sessions and background tasks

## Installation

```bash
npm install
npm run build
npm link  # Optional: make 'claudeman' available globally
```

## Quick Start

### Web Interface (Recommended)

```bash
# Start the web interface
claudeman web

# Open http://localhost:3000 in your browser
```

The web interface provides:
- **Quick Start Button**: One-click to create a case and start an interactive Claude session
- **Interactive Terminal**: Full xterm.js terminal with resize support and 60fps rendering
- **Prompt Input**: Enter prompts and optionally set a working directory
- **Duration Timer**: Set duration in minutes for timed runs (0 = single run)
- **Live Output**: See Claude's response in real-time as it streams
- **Countdown**: Animated timer display with shimmer progress bar
- **Session Monitoring**: View all active sessions with status, resource usage, and cost
- **Kill All Button**: One-click to terminate all running sessions and their child processes
- **Resource Display**: Real-time memory usage and message count per session
- **Respawn Controls**: Start/stop respawn controller with configurable settings
- **Case Management**: Create new project workspaces with CLAUDE.md templates
- **Keyboard Shortcuts**: Quick access to common actions (Ctrl+Enter, Ctrl+K, Ctrl+L)
- **Toast Notifications**: Non-intrusive status updates and alerts
- **Mobile Support**: Responsive design optimized for tablets and phones
- **Modern UI**: Gradient backgrounds, smooth animations, and polished styling

#### Quick Start Button

The Quick Start feature reduces the typical 5-step workflow to just 1-2 steps:

**Before (5 steps):**
1. Go to Cases tab
2. Create a case
3. Click the case
4. Switch to Run tab
5. Click Interactive

**After (1-2 steps):**
1. (Optional) Select a case from dropdown
2. Click "Quick Start"

The Quick Start button will:
- Create a case folder in `~/claudeman-cases/` if it doesn't exist
- Generate a CLAUDE.md file for the case
- Create a new session pointed to that case directory
- Start an interactive Claude terminal
- Focus the terminal so you can start working immediately

#### Keyboard Shortcuts

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

#### Additional Features

- **Multi-Tab Sessions**: Number input (1-10) next to "Run Claude" opens multiple sessions at once, named `1-projectname`, `2-projectname`, etc.
- **Monitor Panel**: Combined view of Screen Sessions and Background Tasks in one panel
- **Session Restoration**: Screen sessions are automatically restored when the server restarts
- **Terminal Font Controls**: Adjust font size with A+/A- buttons in header or Ctrl++/-
- **Copy Terminal Output**: Copy all terminal content to clipboard
- **Session Duration**: View how long each session has been running
- **Working Directory Display**: See the project folder for each session
- **Session Count**: Header displays total active sessions
- **Toast Notifications**: Non-intrusive status updates and alerts
- **Mobile Support**: Responsive design optimized for tablets and phones
- **Help Modal**: Press ? button or Ctrl+? for keyboard shortcuts reference
- **Reconnect Button**: Manually reconnect if connection is lost
- **Confirmation Dialogs**: Warns before starting long timed runs (30+ minutes)

### CLI Usage

```bash
# Start a Claude session
claudeman start --dir /path/to/project

# Add tasks to the queue
claudeman task add "Fix the bug in auth.ts"
claudeman task add "Add tests for the API" --priority 5

# Start the Ralph loop to process tasks
claudeman ralph start

# Check status
claudeman status
```

## Commands

### Web Interface

```bash
# Start web interface on default port (3000)
claudeman web

# Use a different port
claudeman web --port 8080
```

### Session Management

```bash
# Start a new session
claudeman session start [--dir <path>]
claudeman start [--dir <path>]  # shorthand

# Stop a session
claudeman session stop <session-id>

# List sessions
claudeman session list
claudeman list  # shorthand

# View session output
claudeman session logs <session-id>
claudeman session logs <session-id> --errors  # stderr
```

### Task Management

```bash
# Add a task
claudeman task add "<prompt>" [options]
  --dir <path>           Working directory
  --priority <n>         Priority (higher = processed first)
  --completion <phrase>  Custom completion phrase to detect
  --timeout <ms>         Task timeout in milliseconds

# List tasks
claudeman task list
claudeman task list --status pending

# View task details
claudeman task status <task-id>

# Remove a task
claudeman task remove <task-id>

# Clear tasks
claudeman task clear              # completed tasks
claudeman task clear --failed     # failed tasks
claudeman task clear --all        # all tasks
```

### Ralph Loop

```bash
# Start the autonomous loop
claudeman ralph start
claudeman ralph start --min-hours 4      # run for at least 4 hours
claudeman ralph start --no-auto-generate # disable auto task generation

# Stop the loop
claudeman ralph stop

# Check loop status
claudeman ralph status
```

### Respawn Controller (Web Interface)

The respawn controller keeps interactive sessions productive by automatically cycling through update prompts:

1. Detects when session goes idle (prompt character visible, no activity)
2. Sends configured update prompt (default: "update all the docs and CLAUDE.md")
3. Optionally sends `/clear` command to reset context
4. Optionally sends `/init` to reinitialize
5. Repeats

**New Features:**
- **Enable on Existing Sessions**: Start respawn on already-running sessions
- **Timed Duration**: Set a duration limit (e.g., 30 minutes) after which respawn automatically stops
- **Auto-Clear**: Automatically send /clear when token count exceeds threshold (default 100k)
- **Configurable Steps**: Toggle /clear and /init steps independently

**Configuration via API:**
```bash
# Start respawn with custom config
curl -X POST localhost:3000/api/sessions/:id/respawn/start \
  -H "Content-Type: application/json" \
  -d '{"config": {"idleTimeoutMs": 10000, "updatePrompt": "run tests and fix issues"}}'

# Enable respawn on an existing running session with duration
curl -X POST localhost:3000/api/sessions/:id/respawn/enable \
  -H "Content-Type: application/json" \
  -d '{"config": {"updatePrompt": "continue working"}, "durationMinutes": 60}'

# Enable auto-clear at 100k tokens
curl -X POST localhost:3000/api/sessions/:id/auto-clear \
  -H "Content-Type: application/json" \
  -d '{"enabled": true, "threshold": 100000}'

# Update config on running respawn
curl -X PUT localhost:3000/api/sessions/:id/respawn/config \
  -H "Content-Type: application/json" \
  -d '{"updatePrompt": "refactor the API layer", "sendClear": true, "sendInit": false}'
```

**State Machine:**
```
WATCHING → SENDING_UPDATE → WAITING_UPDATE → SENDING_CLEAR → WAITING_CLEAR → SENDING_INIT → WAITING_INIT → WATCHING
```

**Respawn Config Options:**
| Option | Default | Description |
|--------|---------|-------------|
| `idleTimeoutMs` | 5000 | Time to wait after idle before sending update |
| `updatePrompt` | "update all docs..." | Prompt to send when idle |
| `interStepDelayMs` | 1000 | Delay between respawn steps |
| `sendClear` | true | Send /clear after update prompt |
| `sendInit` | true | Send /init after /clear |

### Utility

```bash
# Overall status
claudeman status

# Reset all state (stops sessions, clears tasks)
claudeman reset --force
```

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    Claudeman CLI                        │
├─────────────────────────────────────────────────────────┤
│  Ralph Loop Controller                                  │
│  - Monitors all sessions                                │
│  - Assigns tasks from queue                             │
│  - Detects completion/failure                           │
│  - Self-generates follow-up tasks                       │
├─────────────────────────────────────────────────────────┤
│  Session Manager              │  Task Queue             │
│  - Spawn claude processes     │  - Priority queue       │
│  - Track stdin/stdout/stderr  │  - Task definitions     │
│  - Health monitoring          │  - Dependencies         │
│  - Graceful shutdown          │  - Status tracking      │
├─────────────────────────────────────────────────────────┤
│  State Store (JSON file persistence)                    │
│  - Sessions, tasks, logs                                │
└─────────────────────────────────────────────────────────┘
```

## Completion Detection

The Ralph Loop detects task completion by looking for:

1. **Promise tags**: `<promise>COMPLETE</promise>` or custom phrases
2. **Common indicators**: "Task completed successfully", "All tasks done", "✓ Complete"

When creating tasks, you can specify a custom completion phrase:

```bash
claudeman task add "Refactor the auth module" --completion "AUTH_REFACTOR_DONE"
```

The session output will be scanned for `<promise>AUTH_REFACTOR_DONE</promise>`.

## Time-Aware Loops

For extended autonomous work sessions:

```bash
claudeman ralph start --min-hours 8
```

When the minimum duration hasn't been reached and all tasks are complete, the Ralph Loop will auto-generate follow-up tasks like:

- Review and optimize recently changed code
- Add tests for uncovered code paths
- Update documentation
- Check for security vulnerabilities
- Run linting and fix issues

## Long-Running Sessions

Claudeman is optimized for extended autonomous sessions (12-24+ hours):

### Buffer Management

To prevent memory issues during long runs, buffers are automatically managed:
- **Terminal buffer**: Max 5MB, trims to 4MB when exceeded
- **Text output**: Max 2MB, trims to 1.5MB when exceeded
- **Messages**: Max 1000, keeps most recent 800 when exceeded

### Performance Optimizations

- **Server-side batching**: Terminal data batched at 60fps (16ms intervals)
- **Client-side batching**: requestAnimationFrame for smooth rendering
- **Aggressive process cleanup**: SIGKILL with process group termination

### Resource Monitoring

Each session displays real-time resource usage:
- Memory usage (terminal + text buffers)
- Message count
- Color-coded warnings (green/yellow/red based on usage)

### Kill Sessions

- Click `✕` on individual session cards to terminate
- Click `Kill All` button in sessions panel to terminate all at once
- Sessions are forcefully killed with SIGKILL after SIGTERM timeout

## State File

All state is persisted to `~/.claudeman/state.json`:

```json
{
  "sessions": { ... },
  "tasks": { ... },
  "ralphLoop": {
    "status": "running",
    "startedAt": 1234567890,
    "minDurationMs": 14400000,
    "tasksCompleted": 5,
    "tasksGenerated": 2
  },
  "config": {
    "pollIntervalMs": 1000,
    "defaultTimeoutMs": 300000,
    "maxConcurrentSessions": 5
  }
}
```

## Development

```bash
# Run in development mode
npm run dev -- start

# Build
npm run build

# Clean build artifacts
npm run clean
```

## Requirements

- Node.js 18+
- Claude CLI (`claude`) installed and available in PATH
