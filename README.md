<p align="center">
  <img src="docs/images/claudeman-title.svg" alt="Claudeman" height="60">
</p>

<h2 align="center">Manage Claude Code sessions better than ever</h2>

<p align="center">
  Autonomous Claude Code work while you sleep<br>
  <em>Persistent sessions, Ralph Loop tracking, Respawn Controller, Agent Visualization, Multi-Session Dashboards</em>
</p>

<p align="center">
  <a href="https://opensource.org/licenses/MIT"><img src="https://img.shields.io/badge/License-MIT-1e3a5f?style=flat-square" alt="License: MIT"></a>
  <a href="https://nodejs.org/"><img src="https://img.shields.io/badge/Node.js-18%2B-22c55e?style=flat-square&logo=node.js&logoColor=white" alt="Node.js 18+"></a>
  <a href="https://www.typescriptlang.org/"><img src="https://img.shields.io/badge/TypeScript-5.5-3b82f6?style=flat-square&logo=typescript&logoColor=white" alt="TypeScript 5.5"></a>
  <a href="https://fastify.dev/"><img src="https://img.shields.io/badge/Fastify-5.x-1e3a5f?style=flat-square&logo=fastify&logoColor=white" alt="Fastify"></a>
  <img src="https://img.shields.io/badge/Tests-1435%20total-22c55e?style=flat-square" alt="Tests">
</p>

---

<p align="center">
  <img src="docs/images/claude-overview.png" alt="Claudeman Dashboard" width="900">
</p>

<p align="center">
  <img src="docs/images/claudeman-demo.gif" alt="Claudeman Demo" width="900">
</p>

---

## What Claudeman Does

### 🔔 Notification System

Real-time desktop notifications when sessions need attention — never miss a permission prompt or idle session again:

| Hook Event | Urgency | Tab Alert | Meaning |
|------------|---------|-----------|---------|
| `permission_prompt` | Critical | Red blink | Claude needs tool approval |
| `elicitation_dialog` | Critical | Red blink | Claude is asking a question |
| `idle_prompt` | Warning | Yellow blink | Session idle, waiting for input |
| `stop` | Info | — | Response complete |

**Features:**
- Browser notifications enabled by default (auto-requests permission)
- Click any notification to jump directly to the affected session
- Tab blinking alerts: red for action-required, yellow for idle
- Notifications include actual context (tool name, command, question text)
- Hooks are auto-configured per case directory (`.claude/settings.local.json`)
- Works on HTTP for local use (localhost is a secure context)

---

### 💾 Persistent Sessions

Every Claude session runs inside **tmux** — sessions survive server restarts, network drops, and machine sleep.

```bash
# Your sessions are always recoverable
CLAUDEMAN_MUX=1
CLAUDEMAN_SESSION_ID=abc-123-def
CLAUDEMAN_MUX_NAME=claudeman-myproject
```

- Sessions auto-recover on startup (dual redundancy: `state.json` + `mux-sessions.json`)
- All settings (respawn, auto-compact, tokens) survive server restarts
- Ghost session discovery finds orphaned mux sessions
- Claude knows it's managed (won't kill its own session)

---

### 🔄 Respawn Controller

**The core of autonomous work.** When Claude becomes idle, the Respawn Controller kicks in:

| State | Action | Next |
|:-----:|:------:|:----:|
| **WATCHING** | Monitor for idle | IDLE DETECTED |
| **IDLE DETECTED** | Confirm silence | SEND UPDATE |
| **SEND UPDATE** | Push continue prompt | CLEAR |
| **CLEAR** | Run `/clear` | INIT |
| **INIT** | Run `/init` | CONTINUE |
| **CONTINUE** | Resume work | WATCHING |

- Multi-layer idle detection (completion messages, output silence, token stability)
- Sends configurable update prompts to continue work
- Auto-cycles `/clear` → `/init` for fresh context
- Step confirmation (5s silence) between each command
- **Keeps working even when Ralph loops stop**
- Run for **24+ hours** completely unattended

```bash
# Enable respawn with 8-hour timer
curl -X POST localhost:3000/api/sessions/:id/respawn/enable \
  -H "Content-Type: application/json" \
  -d '{
    "config": {
      "updatePrompt": "continue improving the codebase",
      "idleTimeoutMs": 5000
    },
    "durationMinutes": 480
  }'
```

---

### 🎯 Ralph / Todo Tracking

Claudeman detects and tracks Ralph Loops and Todos inside Claude Code:

<p align="center">
  <img src="docs/images/ralph-tracker-8tasks-44percent.png" alt="Ralph Loop Tracking" width="800">
</p>

**Auto-detects:**
| Pattern | Example |
|---------|---------|
| Promise tags | `<promise>COMPLETE</promise>` |
| Custom phrases | `<promise>ALL_TASKS_DONE</promise>` |
| TodoWrite | `- [ ] Task`, `- [x] Done` |
| Iterations | `[5/50]`, `Iteration 5 of 50` |

**Tracks in real-time:**
- Completion phrase detection
- Todo progress (`4/9 complete`)
- Progress percentage ring
- Elapsed time

---

### 👁️ Live Agent Visualization

**Watch your agents work in real-time.** Claudeman monitors Claude Code's background agents (the `Task` tool) and displays them in draggable floating windows with Matrix-style connection lines.

<p align="center">
  <img src="docs/images/subagent-spawn.png" alt="Subagent Visualization" width="900">
</p>

<p align="center">
  <img src="docs/images/subagent-demo.gif" alt="Subagent Demo" width="900">
</p>

**Features:**
- **Floating windows** — Draggable, resizable panels for each agent
- **Connection lines** — Animated green lines linking parent sessions to agent windows
- **Live activity log** — See every tool call, progress update, and message in real-time
- **Status indicators** — Green (active), yellow (idle), blue (completed)
- **Model badges** — Shows Haiku/Sonnet/Opus with color coding
- **Auto-behavior** — Windows auto-open on spawn, auto-minimize on completion
- **Tab badge** — Shows "AGENT" or "AGENTS (n)" count on session tabs

**Subagent API:**
| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/subagents` | List all background agents |
| `GET` | `/api/subagents/:id` | Agent info and status |
| `GET` | `/api/subagents/:id/transcript` | Full activity transcript |
| `DELETE` | `/api/subagents/:id` | Kill agent process |

---

### 🔍 Project Insights Panel

Real-time visibility into what Claude is reading and searching:

- **Active Bash tools** displayed as they run (file viewers, grep, find)
- **Clickable file paths** — Jump directly to files in Claude Code
- **Timeout indicators** — See how long tools have been running
- **Smart deduplication** — Overlapping file ranges collapsed

Toggle via App Settings → Display → "Show Project Insights Panel"

---

### 📊 Smart Token Management

Never hit token limits unexpectedly:

| Threshold | Action | Result |
|-----------|--------|--------|
| **110k tokens** | Auto `/compact` | Context summarized, work continues |
| **140k tokens** | Auto `/clear` | Fresh start with `/init` |

```bash
# Configure per-session
curl -X POST localhost:3000/api/sessions/:id/auto-compact \
  -d '{"enabled": true, "threshold": 100000}'
```

---

### 🖥️ Multi-Session Dashboard

Run **20 parallel sessions** with full visibility:

- Real-time xterm.js terminals (60fps streaming)
- Per-session token and cost tracking
- Tab-based navigation
- One-click session management

<p align="center">
  <img src="docs/screenshots/multi-session-dashboard.png" alt="Multi-Session Dashboard" width="800">
</p>

**Monitor Panel** — Real-time session monitoring with memory, CPU, and process info:

<p align="center">
  <img src="docs/screenshots/multi-session-monitor.png" alt="Monitor Panel" width="800">
</p>

---

### ⚡ Zero-Flicker Terminal Rendering

**The problem:** Claude Code uses [Ink](https://github.com/vadimdemedes/ink) (React for terminals), which redraws the entire screen on every state change. Without special handling, you'd see constant flickering — unusable for monitoring multiple sessions.

**The solution:** Claudeman implements a 6-layer antiflicker system that delivers butter-smooth 60fps terminal output:

| PTY Output | **→** | 16ms Batch | **→** | DEC 2026 Wrap | **→** | SSE | **→** | rAF Batch | **→** | xterm.js | **→** | 60fps Canvas |
|:----------:|:-----:|:----------:|:-----:|:-------------:|:-----:|:---:|:-----:|:---------:|:-----:|:--------:|:-----:|:------------:|

#### How Each Layer Works

| Layer | Location | Technique | Purpose |
|-------|----------|-----------|---------|
| **1. Server Batching** | server.ts | 16ms collection window | Combines rapid PTY writes into single packets |
| **2. DEC Mode 2026** | server.ts | `\x1b[?2026h`...`\x1b[?2026l` | Marks atomic update boundaries (terminal standard) |
| **3. Client rAF** | app.js | `requestAnimationFrame` | Syncs writes to 60Hz display refresh |
| **4. Sync Block Parser** | app.js | DEC 2026 extraction | Parses atomic segments for xterm.js |
| **5. Flicker Filter** | app.js | Ink pattern detection | Buffers screen-clear sequences (optional) |
| **6. Chunked Loading** | app.js | 64KB/frame writes | Large buffers don't freeze UI |

#### Technical Implementation

**Server-side (16ms batching + DEC 2026):**
```typescript
// Accumulate PTY output per-session
const newBatch = existing + data;
terminalBatches.set(sessionId, newBatch);

// Flush every 16ms (60fps) or immediately if >1KB
if (!terminalBatchTimer) {
  terminalBatchTimer = setTimeout(() => {
    for (const [id, data] of terminalBatches) {
      // Wrap with synchronized output markers
      const syncData = '\x1b[?2026h' + data + '\x1b[?2026l';
      broadcast('session:terminal', { id, data: syncData });
    }
    terminalBatches.clear();
  }, 16);
}
```

**Client-side (rAF batching + sync block handling):**
```javascript
batchTerminalWrite(data) {
  pendingWrites += data;

  if (!writeFrameScheduled) {
    writeFrameScheduled = true;
    requestAnimationFrame(() => {
      // Wait up to 50ms for incomplete sync blocks
      if (hasStartMarker && !hasEndMarker) {
        setTimeout(flushPendingWrites, 50);
        return;
      }

      // Extract atomic segments, strip markers, write to xterm
      const segments = extractSyncSegments(pendingWrites);
      for (const segment of segments) {
        terminal.write(segment);
      }
    });
  }
}
```

**Optional flicker filter** detects Ink's screen-clear patterns (`ESC[2J`, `ESC[H ESC[J`) and buffers 50ms of subsequent output for extra smoothness on problematic terminals.

**Result:** Watch 20 Claude sessions simultaneously without any visual artifacts, even during heavy tool use.

---

### 📈 Run Summary ("What Happened While You Were Away")

Click the chart icon on any session tab to see a complete timeline of what happened:

**Tracked Events:**
- Session start/stop and respawn cycles
- Idle/working transitions with durations
- Token milestones (every 50k tokens)
- Auto-compact and auto-clear triggers
- Ralph Loop completions
- AI check results (idle detection verdicts)
- Hook events (permissions, questions, stops)
- Errors, warnings, and stuck-state alerts

**Stats at a glance:**
- Total respawn cycles
- Peak token usage
- Active vs idle time
- Error/warning counts

---

## Installation

### macOS & Linux

```bash
curl -fsSL https://raw.githubusercontent.com/Ark0N/claudeman/master/install.sh | bash
```

### npm (alternative)

```bash
npm install -g claudeman
```

### Requirements

- Node.js 18+
- [Claude CLI](https://docs.anthropic.com/en/docs/claude-code/getting-started) installed
- tmux (`apt install tmux` / `brew install tmux`)

## Getting Started

```bash
claudeman web
# Open http://localhost:3000
# Press Ctrl+Enter to start your first session
```

> **Note:** HTTP works fine for local use since `localhost` is treated as a secure context by browsers. Use `--https` only when accessing from another machine on your network.

---

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl+Enter` | Quick-start session |
| `Ctrl+W` | Close session |
| `Ctrl+Tab` | Next session |
| `Ctrl+K` | Kill all sessions |
| `Ctrl+L` | Clear terminal |

---

## Mobile — The Best Way to Use Claude Code on Your Phone

**Forget terminal apps.** Claudeman's web UI gives you a full Claude Code dashboard on your phone — real-time terminals, swipe navigation, smart keyboard handling, and quick commands. Just open your browser.

<p align="center">
  <img src="docs/screenshots/mobile-main.png" alt="Mobile Dashboard" width="280">
  &nbsp;&nbsp;
  <img src="docs/screenshots/mobile-toolbar-above-keyboard.png" alt="Mobile Toolbar" width="280">
</p>

### Why It's Better Than Any Terminal App

| Terminal Apps | Claudeman Mobile |
|:--------------|:-----------------|
| Tiny text, no context | Full xterm.js terminal, responsive layout |
| No session management | Swipe between sessions, tab badges show status |
| No notifications | Push alerts when Claude needs approval or goes idle |
| Manual reconnect after drops | tmux persistence — sessions survive anything |
| No agent visibility | See background agents working in real-time |
| No token/cost tracking | Live token counts and cost per session |
| Copy-paste slash commands | One-tap `/init`, `/clear`, `/compact` buttons |

### Setup

```bash
# Start with HTTPS for mobile access over your network
claudeman web --https

# Open on your phone: https://<your-ip>:3000
```

> **Tip:** Local access on `localhost` works over plain HTTP. Use `--https` when accessing from another device on your network.

### Touch-Optimized Interface

| Feature | How It Works |
|---------|-------------|
| **Swipe Navigation** | Swipe left/right on the terminal to switch sessions (80px threshold, 300ms) |
| **Keyboard Accessory Bar** | `/init`, `/clear`, `/compact` quick-action buttons appear above the virtual keyboard |
| **Smart Keyboard Handling** | Toolbar and terminal shift up when the keyboard opens (uses `visualViewport` API) |
| **Safe Area Support** | Respects iPhone notch and home indicator via `env(safe-area-inset-*)` |
| **44px Touch Targets** | All buttons meet iOS Human Interface Guidelines minimum sizes |
| **Confirmation Dialogs** | Destructive commands require a tap to confirm — no accidental `/clear` |
| **Bottom Sheet Case Picker** | Slide-up modal replaces the desktop dropdown for case selection |
| **Native Momentum Scrolling** | Terminal uses `-webkit-overflow-scrolling: touch` for buttery scroll |

### Keyboard Accessory Bar

When the virtual keyboard is open, a quick-action bar appears above the toolbar:

| Button | Action | Confirmation |
|--------|--------|--------------|
| `/init` | Reinitialize context | "Run /init command?" |
| `/clear` | Clear conversation | "Clear conversation history?" |
| `/compact` | Summarize context | "Compact context?" |
| `⌄` | Dismiss keyboard | — |

### Mobile-Optimized Layout

The mobile UI strips away desktop complexity to keep things fast and focused:

- **Full-width terminal** with scrollable session tabs
- Case management via bottom sheet (not desktop dropdown)
- Monitor/subagent panels hidden by default (toggle in settings)
- Full-screen modals for settings
- Compact typography and spacing

---

### Claudeman Sessions (`sc`) — Mobile SSH Alternative

If you prefer SSH (via Termius, Blink, etc.), the `sc` command is a thumb-friendly session chooser:

```bash
sc              # Interactive chooser
sc 2            # Quick attach to session 2
sc -l           # List sessions
```

- **Single-digit selection** (1-9) — fast thumb typing on phone keyboards
- **Color-coded status** — green for attached, gray for detached, `R` for respawn
- **Token counts** displayed per session
- **Pagination** for many sessions, auto-refresh every 60s

| Symbol | Meaning |
|--------|---------|
| `●` / `*` | Attached (someone connected) |
| `○` / `-` | Detached (available) |
| `R` | Respawn enabled |
| `45k` | Token count |

**Detach:** `Ctrl+A D`

---

## API

### Sessions
| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/sessions` | List all |
| `POST` | `/api/quick-start` | Create case + start session |
| `DELETE` | `/api/sessions/:id` | Delete session |
| `POST` | `/api/sessions/:id/input` | Send input |

### Respawn
| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/sessions/:id/respawn/enable` | Enable with config + timer |
| `POST` | `/api/sessions/:id/respawn/stop` | Stop controller |
| `PUT` | `/api/sessions/:id/respawn/config` | Update config |

### Ralph / Todo Tracking
| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/sessions/:id/ralph-state` | Get loop state + todos |
| `POST` | `/api/sessions/:id/ralph-config` | Configure tracking |

### Subagents (Claude Code Background Agents)
| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/subagents` | List all background agents |
| `GET` | `/api/subagents/:id` | Agent info and status |
| `GET` | `/api/subagents/:id/transcript` | Full activity transcript |
| `DELETE` | `/api/subagents/:id` | Kill agent process |
| `GET` | `/api/sessions/:id/subagents` | Subagents for session's working dir |

### Hooks & Notifications
| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/hook-event` | Hook callbacks `{event, sessionId, data?}` → notifications + tab alerts |

### Run Summary
| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/sessions/:id/run-summary` | Timeline + stats for "what happened" |

### Real-Time
| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/events` | SSE stream |
| `GET` | `/api/status` | Full app state |

---

## Architecture

```mermaid
flowchart TB
    subgraph Claudeman["🖥️ CLAUDEMAN"]
        subgraph Frontend["Frontend Layer"]
            UI["Web UI<br/><small>xterm.js + Agent Windows</small>"]
            API["REST API<br/><small>Fastify</small>"]
            SSE["SSE Events<br/><small>/api/events</small>"]
        end

        subgraph Core["Core Layer"]
            SM["Session Manager"]
            S1["Session (PTY)"]
            S2["Session (PTY)"]
            RC["Respawn Controller"]
        end

        subgraph Detection["Detection Layer"]
            RT["Ralph Tracker"]
            SW["Subagent Watcher<br/><small>~/.claude/projects/*/subagents</small>"]
        end

        subgraph Persistence["Persistence Layer"]
            SCR["Mux Manager<br/><small>(tmux)</small>"]
            SS["State Store<br/><small>state.json</small>"]
        end

        subgraph External["External"]
            CLI["Claude CLI"]
            BG["Background Agents<br/><small>(Task tool)</small>"]
        end
    end

    UI <--> API
    API <--> SSE
    API --> SM
    SM --> S1
    SM --> S2
    SM --> RC
    SM --> SS
    S1 --> RT
    S1 --> SCR
    S2 --> SCR
    RC --> SCR
    SCR --> CLI
    SW --> BG
    SW --> SSE
```

---

## Performance

Optimized for long-running autonomous sessions:

| Feature | Implementation |
|---------|----------------|
| **60fps terminal** | 16ms server batching, `requestAnimationFrame` client |
| **Memory management** | Auto-trimming buffers (2MB terminal, 1MB text) |
| **Event debouncing** | 50-500ms on rapid state changes |
| **State persistence** | Debounced writes, dual-redundancy recovery |

---

## Development

```bash
npm install
npx tsx src/index.ts web    # Dev mode
npm run build               # Production build
npm test                    # Run tests
```

See [CLAUDE.md](./CLAUDE.md) for full documentation.

---

## License

MIT — see [LICENSE](LICENSE)

---

<p align="center">
  <strong>Track sessions. Visualize agents. Control respawn. Let it run while you sleep.</strong>
</p>
