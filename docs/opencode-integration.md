# OpenCode Integration Plan for Claudeman

> **Author**: Claude Opus 4.6 | **Date**: 2026-02-26
> **Status**: Draft — Re-reviewed, MVP scope finalized. NOT pushed to GitHub
> **Saved at**: `docs/opencode-integration.md`
> **Related**: `plan.json` (48-task TDD breakdown, also not pushed)
> **Reviewed**: 2026-02-26 — 4-agent team review (arch, parsing, respawn, API). See [Section 21: Review Findings](#21-review-findings)
> **Re-reviewed**: 2026-02-26 — 4-agent team re-review (types, parsing, respawn, API). See [Section 22: Re-Review Findings](#22-re-review-findings)

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [What is OpenCode?](#2-what-is-opencode)
3. [Architecture Comparison: Claude Code vs OpenCode](#3-architecture-comparison-claude-code-vs-opencode)
4. [Integration Strategy Overview](#4-integration-strategy-overview)
5. [Phase 0: Prerequisites & Manual Validation](#5-phase-0-prerequisites--manual-validation)
6. [Phase 1: Type System & Backend Abstraction](#6-phase-1-type-system--backend-abstraction)
7. [Phase 2: OpenCode CLI Resolution](#7-phase-2-opencode-cli-resolution)
8. [Phase 3: Tmux Spawn Integration](#8-phase-3-tmux-spawn-integration)
9. [Phase 4: Output Parsing & Idle Detection](#9-phase-4-output-parsing--idle-detection)
10. [Phase 5: API Routes & Frontend UI](#10-phase-5-api-routes--frontend-ui)
11. [Phase 6: Hooks & Plugin Bridge](#11-phase-6-hooks--plugin-bridge) *(was Phase 7 — reordered, see review)*
12. [Phase 7: Respawn & Ralph Loop Adaptation](#12-phase-7-respawn--ralph-loop-adaptation) *(was Phase 6 — reordered, see review)*
13. [Phase 8: OpenCode Server API Integration (Advanced)](#13-phase-8-opencode-server-api-integration-advanced)
14. [Files to Modify](#14-files-to-modify)
15. [Files to Create](#15-files-to-create)
16. [Existing plan.json Task Breakdown](#16-existing-planjson-task-breakdown)
17. [Risk Assessment](#17-risk-assessment)
18. [Testing Strategy](#18-testing-strategy)
19. [Open Questions & Decisions](#19-open-questions--decisions)
20. [Implementation Order](#20-implementation-order)
21. [Review Findings](#21-review-findings)
22. [Re-Review Findings](#22-re-review-findings)
23. [Appendix A: OpenCode CLI Reference](#appendix-a-opencode-cli-reference)
24. [Appendix B: OpenCode Plugin Events](#appendix-b-opencode-plugin-events)
25. [Appendix C: OpenCode Permission Config](#appendix-c-opencode-permission-config)
26. [Appendix D: Current Claudeman Session Spawn Flow (Annotated)](#appendix-d-current-claudeman-session-spawn-flow-annotated)

---

## 1. Executive Summary

This plan details how to integrate [OpenCode](https://opencode.ai) — the popular open-source AI coding CLI (111k+ GitHub stars, 75+ model providers) — into Claudeman as a first-class session type alongside Claude Code and shell sessions.

### Core Approach

Extend the existing `SessionMode` type from `'claude' | 'shell'` to `'claude' | 'shell' | 'opencode'`, and propagate this new mode through the tmux manager, session class, API routes, and frontend UI. OpenCode will be spawned inside tmux exactly like Claude Code, with its TUI rendered in xterm.js.

### Two Integration Strategies (Incremental)

| Strategy | Approach | Complexity | Value |
|----------|----------|------------|-------|
| **A: TUI-in-tmux** | Spawn `opencode` CLI in tmux, render in xterm.js | Medium | Full visual parity with Claude Code |
| **B: Server API bridge** | Run `opencode serve` + proxy its API through Claudeman | High | Structured data, session control, token tracking |

**Recommended path**: Start with Strategy A (TUI-in-tmux) since it mirrors the existing Claude Code pattern exactly. Then layer Strategy B on top for advanced features like structured token tracking and model switching.

### Scope Decision: MVP First, Claude-Coupled Systems Later

> **Decision (2026-02-26)**: The first integration ships **spawn + render + basic UI only**. The following Claude-coupled systems are **explicitly out of scope** for the initial integration and should NOT be attempted until OpenCode sessions are stable and we have real PTY output data to calibrate against:
>
> | System | Why Excluded | Prerequisite |
> |--------|-------------|--------------|
> | **Token tracking** | Claude-specific status line format. OpenCode uses different format inside Bubble Tea TUI. 75+ model providers = different cost/token semantics per model. | Phase 8 server API or verified TUI regex |
> | **Respawn controller** | 3,500 lines, 13 states, deeply coupled to Claude's output patterns (`Worked for Xm Xs`, spinner chars, `❯` prompt, `/clear`/`/init` commands). Entire cycle logic is Claude-specific. | Plugin bridge `session.idle` event verified + Phase 0 PTY data |
> | **Ralph Loop** | Depends entirely on `<promise>PHRASE</promise>` tags and `---RALPH_STATUS---` blocks — custom Claude protocols that don't exist in OpenCode. Would be a broken timeout-based prompt repeater. | Alternative completion signaling mechanism |
> | **Ralph Tracker** | Parses Claude-specific output: `<promise>` tags, `TodoWrite` tool detection, `RALPH_STATUS` blocks, `@fix_plan.md` workflow. None exist in OpenCode. | OpenCode-native equivalent signals |
> | **Circuit breaker** | Signals (`consecutiveNoProgress`, `consecutiveTestsFailure`, `BLOCKED`) all come from `RALPH_STATUS` blocks. No OpenCode equivalent. | Ralph Tracker adaptation |
> | **Hooks plugin bridge** | Plugin event names are speculative/unverified. Requires Phase 0 validation that hasn't happened. | Phase 0 plugin verification |
> | **AI idle checker** | Spawns `claude -p` for analysis. Won't work if only OpenCode is installed. | Claude CLI availability or `opencode run` fallback |
>
> **What ships in the MVP**: Phases 0-3 (spawn in tmux, render in xterm.js) + Phase 5 (API routes, mode selector, tab badges, create/kill sessions). Users can interact with OpenCode manually — type prompts, see output, manage sessions from the Claudeman web UI. This alone is the core value: multi-model AI sessions in one management interface.

### Why OpenCode?

- **Multi-model**: Access Claude, GPT, Gemini, Ollama (local), and 75+ other models through one tool
- **Privacy-first**: Can run fully local via Ollama — no code ever leaves the machine
- **Open source**: MIT licensed, active community (700+ contributors)
- **Client/server**: Built-in `opencode serve` mode enables richer programmatic integration
- **Plugin system**: JS/TS plugins with rich event hooks (including `session.idle` — perfect for Claudeman)

---

## 2. What is OpenCode?

- **GitHub**: https://github.com/opencode-ai/opencode (originally `sst/opencode`, now `anomalyco/opencode`)
- **Website**: https://opencode.ai
- **License**: MIT
- **Language**: Go (binary), with TypeScript plugin/config system
- **TUI Framework**: Bubble Tea (Go) — *not* `@opentui/solid` as earlier versions used
- **Install**: `curl -fsSL https://raw.githubusercontent.com/opencode-ai/opencode/refs/heads/main/install | bash` or `brew install opencode-ai/tap/opencode` or `go install github.com/opencode-ai/opencode@latest`

### Key Differences from Claude Code

| Feature | Claude Code | OpenCode |
|---------|-------------|----------|
| **Models** | Anthropic only | 75+ providers (Anthropic, OpenAI, Google, Ollama, etc.) |
| **Architecture** | Single CLI process | Client/server (TUI + optional API server) |
| **TUI framework** | Ink (React for terminals) | Bubble Tea (Go) |
| **Headless mode** | `claude -p` | `opencode run` (JSON output) + `opencode serve` (HTTP API) |
| **Permissions** | `--dangerously-skip-permissions` CLI flag | Config-based `"permission": {"*": "allow"}` in `opencode.json` |
| **Hooks system** | `.claude/settings.local.json` with shell command hooks | JS/TS plugin system with 25+ event types |
| **Session ID** | `--session-id <id>` | `--session <id>` or `-s <id>` |
| **Continue** | `/resume` command | `--continue` or `-c` flag |
| **Config format** | CLAUDE.md (markdown) + settings.json | `opencode.json` (JSON/JSONC) |
| **Data storage** | File-based (transcripts, state) | SQLite database |
| **Leader key** | None (direct shortcuts) | `Ctrl+X` as leader key for TUI |
| **Token display** | Status bar: `123.4k tokens` | TUI status area: `~27s · 275.9k tokens` |

### OpenCode CLI Flags (Relevant for Spawning)

```bash
# Interactive TUI (default)
opencode [project-path]

# With specific model
opencode --model anthropic/claude-sonnet-4-5
opencode --model openai/gpt-5.2
opencode --model ollama/codellama

# Continue existing session
opencode --continue                  # Continue last session
opencode --session <id>              # Resume specific session
opencode --fork                      # Branch when continuing

# Non-interactive (pipe mode)
opencode run "prompt here"
opencode run --format json "prompt"  # Structured JSON output
opencode run --continue              # Continue last session in pipe mode
opencode run --file path.ts "prompt" # Attach file context
opencode run --attach http://host:4096 "prompt"  # Run against remote server

# Headless server
opencode serve --port 4096
opencode serve --cors "http://localhost:3000"
opencode serve --mdns                # Enable mDNS discovery

# Attach TUI to remote server
opencode attach http://host:4096

# Session management
opencode session list                # List all sessions
opencode export [sessionID]          # Export as JSON
opencode import <file>               # Import from file/URL

# Model management
opencode models [provider]           # List available models
opencode models --refresh            # Update model cache

# Global flags
--help, --version, --debug, --cwd <dir>, --log-level, --print-logs
```

### OpenCode Config File (`opencode.json`)

Located in project root (or `~/.config/opencode/opencode.json` for global), configures model, tools, agents:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "model": "anthropic/claude-sonnet-4-5",
  "small_model": "anthropic/claude-haiku-4-5",

  // Auto-approve all tool executions (like --dangerously-skip-permissions)
  "permission": {
    "*": "allow"
  },

  // Or granular permissions
  "permission": {
    "*": "ask",
    "bash": { "*": "ask", "git *": "allow", "rm *": "deny" },
    "edit": "allow"
  },

  "tools": { "bash": { "mode": "allow" } },

  "agents": {
    "build": { "model": "anthropic/claude-sonnet-4-5" }
  },

  "mcp": { "servers": {} },

  "server": {
    "port": 4096,
    "hostname": "0.0.0.0",
    "cors": ["http://localhost:3000"]
  },

  "compaction": { "auto": true },
  "autoupdate": false
}
```

### Config File Precedence

1. Remote config (`.well-known/opencode` endpoint)
2. Global config (`~/.config/opencode/opencode.json`)
3. Custom config (`OPENCODE_CONFIG` env var)
4. Project config (`opencode.json` in project root)
5. `.opencode/` directory (agents, commands, plugins)
6. Inline config (`OPENCODE_CONFIG_CONTENT` env var)

### OpenCode Environment Variables

```bash
ANTHROPIC_API_KEY=...          # For Anthropic models
OPENAI_API_KEY=...             # For OpenAI models
GOOGLE_API_KEY=...             # For Google AI models
OPENCODE_MODEL=...             # Default model override
OPENCODE_CONFIG=...            # Custom config file path
OPENCODE_CONFIG_DIR=...        # Custom config directory
OPENCODE_CONFIG_CONTENT=...    # Inline JSON config (highest priority)
OPENCODE_SERVER_PASSWORD=...   # Auth for serve mode (username: "opencode")
OPENCODE_PERMISSION=...        # Inline JSON permission config
OPENCODE_CLIENT=...            # Client identifier (default: "cli")
```

---

## 3. Architecture Comparison: Claude Code vs OpenCode

### Current Claudeman Session Flow (Claude Code)

```
POST /api/sessions           →  new Session({mode: 'claude', mux: TmuxManager})
POST /api/sessions/:id/interactive  →  session.startInteractive()
                                              ↓
                                    TmuxManager.createSession()
                                              ↓
                                    tmux new-session -ds "claudeman-<id>"
                                    tmux respawn-pane -k -t ... "claude --dangerously-skip-permissions --session-id <id>"
                                              ↓
                                    pty.spawn('tmux', ['attach-session', '-t', 'claudeman-<id>'])
                                              ↓
                                    ptyProcess.onData() → emit('terminal') → SSE broadcast → xterm.js
```

### Proposed OpenCode Session Flow (Strategy A: TUI-in-tmux)

```
POST /api/sessions           →  new Session({mode: 'opencode', mux: TmuxManager})
POST /api/sessions/:id/interactive  →  session.startInteractive()
                                              ↓
                                    TmuxManager.createSession()
                                              ↓
                                    tmux new-session -ds "claudeman-<id>"
                                    tmux respawn-pane -k -t ... "opencode --model <model>"
                                              ↓
                                    pty.spawn('tmux', ['attach-session', '-t', 'claudeman-<id>'])
                                              ↓
                                    ptyProcess.onData() → emit('terminal') → SSE broadcast → xterm.js
```

**Identical pipeline!** The only differences are:
1. The command spawned inside tmux (`opencode` vs `claude`)
2. The CLI arguments (`--model` vs `--dangerously-skip-permissions --session-id`)
3. The environment variables passed to the process
4. Output parsing patterns (idle detection, prompt character, token tracking)
5. Permission handling (config file vs CLI flag)

### Proposed OpenCode Session Flow (Strategy B: Server API Bridge)

```
Strategy A (TUI-in-tmux) for terminal rendering
     +
opencode serve (background, port 4096+N)
     ↓
Claudeman proxy routes → GET /session/current, POST /session/message, SSE /events
     ↓
Structured data for: token tracking, session management, model switching
```

---

## 4. Integration Strategy Overview

### Phase Breakdown

| Phase | Scope | Effort | Dependencies | MVP? |
|-------|-------|--------|-------------|------|
| **0** | Install OpenCode, manual tmux validation | 30 min | None | **YES** |
| **1** | Type system extension + (optional) backend abstraction | Small | None | **YES** |
| **2** | OpenCode CLI resolver | Small | Phase 1 | **YES** |
| **3** | TmuxManager: spawn `opencode` in tmux | Medium | Phase 2 | **YES** |
| **4** | Output parsing, idle detection, prompt detection | Medium | Phase 3 | **DEFERRED** — only basic ready detection needed for MVP |
| **5** | API routes + frontend UI (mode selector, badges) | Medium | Phase 3 | **YES** |
| **6** | Hooks & plugin bridge | Medium | Phase 5 | **DEFERRED** — unverified plugin API |
| **7** | Respawn controller + Ralph Loop adaptation | Medium | Phase 6 | **DEFERRED** — Claude-coupled, needs real PTY data |
| **8** | OpenCode server API bridge (optional, advanced) | Large | Phase 5 | **DEFERRED** — future enhancement |

> **MVP scope**: Phases 0, 1, 2, 3, 5 only. Phase 4 reduced to basic `waitForOpenCodeReady()` only (no idle/working/token detection). Phases 6-8 deferred until MVP is stable.

### What Stays Exactly the Same (Zero Changes)

These systems work identically for OpenCode sessions:
- tmux session creation/lifecycle mechanics
- PTY attachment via `tmux attach-session`
- Terminal data streaming via `ptyProcess.onData()`
- SSE event broadcasting via `broadcast()`
- xterm.js terminal rendering in the browser
- State persistence to `~/.claudeman/state.json`
- Session CRUD API routes (create, get, delete)
- Tab management in frontend
- Session kill/cleanup logic (`TmuxManager.killSession()`)
- Nice priority wrapping
- Terminal resize (SIGWINCH propagation through tmux)
- `writeViaMux()` — sending text input via tmux `send-keys`

### What Needs Adaptation

| System | Current (Claude-specific) | OpenCode Equivalent | MVP? |
|--------|---------------------------|---------------------|------|
| CLI binary | `claude` | `opencode` | **YES** |
| CLI args | `--dangerously-skip-permissions --session-id <id>` | `--model <m>` + `opencode.json` for permissions | **YES** |
| Prompt marker | `❯` (U+276F) | Bubble Tea TUI prompt (different rendering) | DEFERRED |
| Working indicator | Spinner + "Thinking...", "Writing..." keywords | Bubble Tea spinner (different characters) | DEFERRED |
| Completion message | `"Worked for Xm Xs"` | Different format (needs empirical testing) | DEFERRED |
| Token display | Status line: `123.4k tokens` | TUI status: `~27s · 275.9k tokens` | DEFERRED |
| Slash commands | `/clear`, `/compact`, `/init`, `/update` | `/clear`, `/model`, `/sessions`, `/compact` | DEFERRED |
| Hooks | `.claude/settings.local.json` shell commands | JS/TS plugin system in `.opencode/plugins/` | DEFERRED |
| Subagent detection | `BashToolParser` + `SubagentWatcher` | Different tool output format | DEFERRED |
| Ralph completion | `<promise>PHRASE</promise>` tags | Not applicable (needs alternative) | DEFERRED |
| Hooks events | `permission_prompt`, `idle_prompt`, `stop` | `permission.asked`, `session.idle`, `session.status` | DEFERRED |
| Auto-compact | Claudeman sends `/compact` at token threshold | OpenCode has built-in `compaction.auto: true` | DEFERRED |

---

## 5. Phase 0: Prerequisites & Manual Validation

### Goal
Install OpenCode and validate it works inside tmux before writing any code.

### Steps

```bash
# 1. Install OpenCode
curl -fsSL https://raw.githubusercontent.com/opencode-ai/opencode/refs/heads/main/install | bash

# 2. Verify installation
which opencode
opencode --version

# 3. Test interactive TUI
opencode

# 4. Test in tmux (simulating Claudeman's spawn pattern)
tmux new-session -ds "test-opencode" -c /tmp -x 120 -y 40
tmux set-option -t "test-opencode" remain-on-exit on
tmux respawn-pane -k -t "test-opencode" 'opencode --model anthropic/claude-sonnet-4-5'

# 5. Attach and verify rendering
tmux attach-session -t "test-opencode"
# → Verify: TUI renders, accepts input, produces output
# → Test: Ctrl+B D to detach, reattach — does TUI restore?
# → Test: Send keys via: tmux send-keys -t "test-opencode" -l "Hello" && tmux send-keys -t "test-opencode" Enter

# 6. Test with auto-allow permissions (via inline config)
tmux respawn-pane -k -t "test-opencode" 'OPENCODE_CONFIG_CONTENT='"'"'{"permission":{"*":"allow"}}'"'"' opencode --model anthropic/claude-sonnet-4-5'

# 7. Test non-interactive mode
opencode run -q --format json "What is 2+2?"

# 8. Cleanup
tmux kill-session -t "test-opencode"
```

### Validation Checklist

- [ ] OpenCode binary found and version verified
- [ ] TUI renders correctly inside tmux
- [ ] tmux `send-keys -l` sends text to OpenCode's TUI correctly
- [ ] Separate `send-keys Enter` triggers prompt submission
- [ ] TUI survives tmux detach/reattach
- [ ] `remain-on-exit` keeps session alive after OpenCode exits
- [ ] Terminal resize works (try different tmux dimensions)
- [ ] Permission auto-allow works via `OPENCODE_CONFIG_CONTENT`
- [ ] Non-interactive `opencode run` produces JSON output
- [ ] xterm.js renders the TUI (manually test by piping PTY output)

### Additional Validation Items (from review)

> **[REVIEW]** Multiple reviewers emphasized that Phase 0 findings are critical prerequisites for Phases 4-7. Do not write any code until these pass.

- [ ] **Capture raw PTY output** from an OpenCode session for idle detection calibration — record 5+ minutes of working vs idle output to measure actual patterns
- [ ] **Verify `writeViaMux()` input delivery** — Bubble Tea (Go) may handle `\r` (Enter) differently than Ink (React). Test `tmux send-keys -l "Hello"` followed by `tmux send-keys Enter` and confirm prompt submission works
- [ ] **Measure TUI redraw frequency** during idle state — does Bubble Tea emit cursor/timer redraws when the AI model is idle? This determines whether output-silence detection is viable at all
- [ ] **Test mouse protocol output** — Bubble Tea can enable mouse reporting (`CSI ?1000h`/`CSI ?1006h`), generating PTY output on mouse movements. This would defeat silence-based idle detection
- [ ] **Install a test OpenCode plugin** — write a minimal `.opencode/plugins/test.js` plugin, verify which events actually fire, confirm exact event names and callback signatures (the event names in Appendix B are speculative)
- [ ] **Test OpenCode auto-compaction behavior** — trigger compaction during a session, observe TUI output pattern (could appear as "working" to idle detector)
- [ ] **Check `opencode --version`** — record version for compatibility tracking. OpenCode is rapidly evolving; CLI flags and plugin API may change between versions

### Critical Finding: xterm.js Compatibility

OpenCode uses Bubble Tea (Go's charmbracelet framework), which renders using:
- Alternate screen buffer (`\x1b[?1049h`)
- Mouse events (`\x1b[?1000h`)
- Bracketed paste mode (`\x1b[?2004h`)
- True color (24-bit) sequences

These should all work with xterm.js, but **manual testing is essential** before coding.

---

## 6. Phase 1: Type System & Backend Abstraction

### Goal
Extend the type system to support `'opencode'` as a session mode.

### Approach Decision: Simple Extension vs. Backend Abstraction

There are two paths (both represented in the codebase):

**Option A: Simple mode extension** (recommended for Phase 1)
- Add `'opencode'` to existing `SessionMode` union type
- Use `if/else` branches in existing code
- Less refactoring, faster to ship

**Option B: Full backend abstraction** (from `plan.json`)
- Create `LLMBackend` interface + `ClaudeBackend` + `OpenCodeBackend` classes
- Dependency injection into Session class
- More elegant, but larger scope

**Recommendation**: Start with Option A, refactor to Option B later if a third backend is ever needed.

### Prerequisite Refactors (from review)

> **[REVIEW C5]** `SessionMode` is a named type export in `session.ts:204` (`export type SessionMode = 'claude' | 'shell'`). `types.ts:162` has an **inline anonymous union** (`mode?: 'claude' | 'shell'`) inside `SessionState` — NOT a named `SessionMode` type. Additionally, `mux-interface.ts` has 3 inline `'claude' | 'shell'` unions (MuxSession.mode, createSession param, respawnPane param). All 5 locations must stay in sync. **Fix**: Create `SessionMode` in `types.ts`, import and use it in `session.ts` and `mux-interface.ts`.

> **[REVIEW M6]** `createSession()` already has 8 positional parameters. Adding `openCodeConfig` as the 9th is a code smell. **Fix**: Refactor `createSession()` and `respawnPane()` in `TerminalMultiplexer` to accept an options object before adding OpenCode. This also eliminates the need to keep parameter order in sync.

```typescript
// BEFORE (8 positional params):
createSession(sessionId, workingDir, mode, name, niceConfig, model, claudeMode, allowedTools)

// AFTER (options object):
interface CreateSessionOptions {
  sessionId: string;
  workingDir: string;
  mode: SessionMode;
  name?: string;
  niceConfig?: NiceConfig;
  model?: string;
  claudeMode?: ClaudeMode;
  allowedTools?: string;
  openCodeConfig?: OpenCodeConfig;
}
createSession(options: CreateSessionOptions): Promise<MuxSession>;
```

### Changes

#### `src/types.ts` — Unify `SessionMode` and add `OpenCodeConfig`

```typescript
// Move SessionMode here (single source of truth):
export type SessionMode = 'claude' | 'shell' | 'opencode';
```

#### `src/session.ts` (line 204)

```typescript
// BEFORE (delete this):
export type SessionMode = 'claude' | 'shell';

// AFTER (import from types.ts):
import type { SessionMode } from './types.js';
```

#### `src/types.ts` — Add `OpenCodeConfig` interface

```typescript
/** OpenCode session configuration */
export interface OpenCodeConfig {
  /** Model identifier (e.g., "anthropic/claude-sonnet-4-5", "openai/gpt-5.2", "ollama/codellama") */
  model?: string;
  /** Whether to auto-allow all tool executions (sets permission.* = allow) */
  autoAllowTools?: boolean;
  /** Session ID to continue from */
  continueSession?: string;
  /** Whether to fork when continuing (branch the conversation) */
  forkSession?: boolean;
  /** Port for OpenCode's built-in server (Strategy B, Phase 8) */
  serverPort?: number;
  /** Custom inline config JSON (passed via OPENCODE_CONFIG_CONTENT) */
  configContent?: string;
}
```

Add `openCodeConfig` to `SessionState`:

```typescript
// In SessionState interface:
/** OpenCode-specific configuration (only for mode === 'opencode') */
openCodeConfig?: OpenCodeConfig;
```

#### `src/mux-interface.ts` — Update mode types and refactor to options object

```typescript
// Import unified SessionMode from types.ts:
import type { SessionMode, OpenCodeConfig } from './types.js';

// In MuxSession type (line 27):
mode: SessionMode;

// Refactor to options object (per review M6):
interface CreateSessionOptions {
  sessionId: string;
  workingDir: string;
  mode: SessionMode;
  name?: string;
  niceConfig?: NiceConfig;
  model?: string;
  claudeMode?: ClaudeMode;
  allowedTools?: string;
  openCodeConfig?: OpenCodeConfig;
}

interface RespawnPaneOptions {
  sessionId: string;
  workingDir: string;
  mode: SessionMode;
  niceConfig?: NiceConfig;
  model?: string;
  claudeMode?: ClaudeMode;
  allowedTools?: string;
  openCodeConfig?: OpenCodeConfig;
}

// In TerminalMultiplexer interface:
createSession(options: CreateSessionOptions): Promise<MuxSession>;
respawnPane(options: RespawnPaneOptions): Promise<number | null>;
```

> **Note**: `mux-factory.ts` does NOT need changes — it just instantiates `TmuxManager` with no parameters.

#### `src/web/schemas.ts` — Update Zod schemas

```typescript
// Session mode enum
mode: z.enum(['claude', 'shell', 'opencode']).optional(),

// Add OpenCode config schema
const OpenCodeConfigSchema = z.object({
  model: z.string().max(100).regex(/^[a-zA-Z0-9._\-/]+$/).optional(),
  autoAllowTools: z.boolean().optional(),
  continueSession: z.string().max(100).regex(/^[a-zA-Z0-9_-]+$/).optional(),
  forkSession: z.boolean().optional(),
  serverPort: z.number().int().min(1024).max(65535).optional(),
  configContent: z.string().max(10000).optional(),
}).optional();

// Add to CreateSessionSchema:
openCodeConfig: OpenCodeConfigSchema,
```

---

## 7. Phase 2: OpenCode CLI Resolution

### Goal
Create a resolver for the `opencode` binary, mirroring `claude-cli-resolver.ts`.

### New File: `src/utils/opencode-cli-resolver.ts`

```typescript
/**
 * @fileoverview Resolve the OpenCode CLI binary across common install paths.
 * Mirrors claude-cli-resolver.ts pattern.
 */

import { existsSync } from 'node:fs';
import { join, dirname, delimiter } from 'node:path';
import { execSync } from 'node:child_process';
import { homedir } from 'node:os';

let _openCodeDir: string | null = null;
let _resolved = false;

const COMMON_DIRS = [
  join(homedir(), '.local', 'bin'),       // Default install location
  '/usr/local/bin',                        // Homebrew / system
  join(homedir(), '.bun', 'bin'),          // Bun global
  join(homedir(), '.npm-global', 'bin'),   // npm global
  join(homedir(), 'go', 'bin'),            // Go install
  join(homedir(), 'bin'),                  // User bin
];

/**
 * Resolve the directory containing the `opencode` binary.
 * Result is cached after first call.
 */
export function resolveOpenCodeDir(): string | null {
  if (_resolved) return _openCodeDir;
  _resolved = true;

  // Try which first
  try {
    const path = execSync('which opencode', {
      encoding: 'utf8',
      timeout: 3000,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    if (path) {
      // [REVIEW] Use dirname() like claude-cli-resolver.ts, not regex
      _openCodeDir = dirname(path);
      return _openCodeDir;
    }
  } catch { /* not in PATH */ }

  // Check common directories
  for (const dir of COMMON_DIRS) {
    if (existsSync(join(dir, 'opencode'))) {
      _openCodeDir = dir;
      return _openCodeDir;
    }
  }

  return null;
}

/**
 * Check if OpenCode CLI is available on the system.
 */
export function isOpenCodeAvailable(): boolean {
  return resolveOpenCodeDir() !== null;
}

/**
 * Get augmented PATH with OpenCode directory prepended.
 */
export function getOpenCodeAugmentedPath(): string {
  const dir = resolveOpenCodeDir();
  if (!dir) return process.env.PATH || '';
  const current = process.env.PATH || '';
  if (current.includes(dir)) return current;
  // [REVIEW] Use delimiter from node:path, not hardcoded ':'
  return `${dir}${delimiter}${current}`;
}

/**
 * Reset cached resolution (for testing).
 */
export function resetOpenCodeCache(): void {
  _openCodeDir = null;
  _resolved = false;
}
```

### Update: `src/utils/index.ts`

```typescript
export { resolveOpenCodeDir, isOpenCodeAvailable, getOpenCodeAugmentedPath } from './opencode-cli-resolver.js';
```

---

## 8. Phase 3: Tmux Spawn Integration

### Goal
Make `TmuxManager.createSession()` and `respawnPane()` support `mode: 'opencode'`.

This is the **critical integration point** — once OpenCode runs in tmux, everything downstream (PTY attachment, SSE streaming, xterm.js rendering) works automatically.

### Prerequisite Refactor: Extract Shared Command Builder (from review)

> **[REVIEW]** `createSession()` and `respawnPane()` already duplicate Claude command construction (lines 261-311 vs 426-454). Adding OpenCode creates a 3rd branch in both. **Fix**: Extract a shared `buildSpawnCommand(mode, options)` helper that both methods call.

```typescript
// New shared helper in tmux-manager.ts:
interface SpawnCommandOptions {
  mode: SessionMode;
  sessionId: string;
  model?: string;
  claudeMode?: ClaudeMode;
  allowedTools?: string;
  openCodeConfig?: OpenCodeConfig;
}

function buildSpawnCommand(options: SpawnCommandOptions): string {
  if (options.mode === 'claude') {
    const modelFlag = options.model ? ` --model ${options.model}` : '';
    return `claude${buildClaudePermissionFlags(options.claudeMode, options.allowedTools)} --session-id "${options.sessionId}"${modelFlag}`;
  }
  if (options.mode === 'opencode') {
    return buildOpenCodeCommand(options.openCodeConfig);
  }
  return '$SHELL';
}
```

### Changes to `src/tmux-manager.ts`

#### New Helper: `buildOpenCodeCommand()`

```typescript
import { resolveOpenCodeDir } from './utils/opencode-cli-resolver.js';
import type { OpenCodeConfig } from './types.js';

/**
 * Build the opencode CLI command with appropriate flags.
 * Similar to buildClaudePermissionFlags() but for OpenCode.
 */
function buildOpenCodeCommand(config?: OpenCodeConfig): string {
  const parts = ['opencode'];

  // Model selection
  if (config?.model) {
    const safeModel = /^[a-zA-Z0-9._\-/]+$/.test(config.model) ? config.model : undefined;
    if (safeModel) parts.push('--model', safeModel);
  }

  // Continue existing session
  if (config?.continueSession) {
    const safeId = /^[a-zA-Z0-9_-]+$/.test(config.continueSession) ? config.continueSession : undefined;
    if (safeId) parts.push('--session', safeId);
    if (config.forkSession) parts.push('--fork');
  }

  return parts.join(' ');
}
```

#### `createSession()` — Extend command construction (around line 280)

```typescript
// CURRENT:
const modelFlag = (mode === 'claude' && safeModel) ? ` --model ${safeModel}` : '';
const baseCmd = mode === 'claude'
  ? `claude${buildClaudePermissionFlags(claudeMode, allowedTools)} --session-id "${sessionId}"${modelFlag}`
  : '$SHELL';

// PROPOSED:
let baseCmd: string;
if (mode === 'claude') {
  const modelFlag = safeModel ? ` --model ${safeModel}` : '';
  baseCmd = `claude${buildClaudePermissionFlags(claudeMode, allowedTools)} --session-id "${sessionId}"${modelFlag}`;
} else if (mode === 'opencode') {
  baseCmd = buildOpenCodeCommand(openCodeConfig);
} else {
  baseCmd = '$SHELL';
}
```

#### PATH Augmentation for OpenCode

```typescript
// In createSession(), where PATH is exported:
let pathExport: string;
if (mode === 'claude') {
  const claudeDir = findClaudeDir();
  if (!claudeDir) throw new Error('Claude CLI not found');
  pathExport = `export PATH="${claudeDir}:$PATH"`;
} else if (mode === 'opencode') {
  const openCodeDir = resolveOpenCodeDir();
  if (!openCodeDir) throw new Error('OpenCode CLI not found. Install with: curl -fsSL https://opencode.ai/install | bash');
  pathExport = `export PATH="${openCodeDir}:$PATH"`;
} else {
  pathExport = ''; // shell mode uses system PATH
}
```

#### Environment Variables for OpenCode

OpenCode needs different env vars than Claude Code:

```typescript
// Build environment exports based on mode
function buildEnvExports(mode: string, sessionId: string, muxName: string, openCodeConfig?: OpenCodeConfig): string {
  const common = [
    `export LANG=en_US.UTF-8`,
    `export LC_ALL=en_US.UTF-8`,
    `unset COLORTERM`,  // Prevent color issues in tmux
    `export CLAUDEMAN_MUX=1`,
    `export CLAUDEMAN_SESSION_ID=${sessionId}`,
    `export CLAUDEMAN_MUX_NAME=${muxName}`,
    `export CLAUDEMAN_API_URL=${process.env.CLAUDEMAN_API_URL || 'http://localhost:3000'}`,
  ];

  if (mode === 'opencode') {
    // [REVIEW M7] Use tmux setenv for API keys instead of inline export.
    // Inline `export KEY=val` in the tmux command is visible in `ps` output and tmux history.
    // tmux setenv sets environment variables on the session, inherited by all panes.
    // Call this BEFORE respawnPane():
    //   tmux setenv -t <session> ANTHROPIC_API_KEY <value>
    //   tmux setenv -t <session> OPENAI_API_KEY <value>
    //   etc.
    // See new helper: setOpenCodeEnvVars() below.

    const configExports: string[] = []; // Non-secret env vars only

    // [RE-REVIEW] SECURITY: configContent is user-supplied JSON. NEVER embed it
    // directly in a shell command string — shell metacharacters (;, &&, $()) execute.
    // Instead: (1) validate it is parseable JSON, (2) pass via tmux setenv, which
    // does NOT interpret shell metacharacters.
    // Inline config for permission auto-allow
    if (openCodeConfig?.autoAllowTools) {
      const permConfig = { permission: { '*': 'allow' } };
      let merged = permConfig;
      if (openCodeConfig.configContent) {
        try {
          const existing = JSON.parse(openCodeConfig.configContent);
          merged = { ...existing, permission: { '*': 'allow' } };
        } catch { /* invalid JSON, use default permConfig */ }
      }
      // Pass via tmux setenv (called BEFORE respawnPane), NOT inline export
      // setOpenCodeConfigContent(muxName, JSON.stringify(merged));
      configExports.push(`# OPENCODE_CONFIG_CONTENT set via tmux setenv — see setOpenCodeConfigContent()`);
    } else if (openCodeConfig?.configContent) {
      // Validate JSON first — reject if unparseable
      try {
        JSON.parse(openCodeConfig.configContent);
        // Pass via tmux setenv (called BEFORE respawnPane)
        // setOpenCodeConfigContent(muxName, openCodeConfig.configContent);
      } catch {
        throw new Error('Invalid JSON in openCodeConfig.configContent');
      }
      configExports.push(`# OPENCODE_CONFIG_CONTENT set via tmux setenv — see setOpenCodeConfigContent()`);
    }

    return [...common, ...configExports].join(' && ');
  }

  if (mode === 'claude') {
    return [...common, `unset CLAUDECODE`].join(' && ');
  }

  return common.join(' && ');
}
```

#### New Helper: `setOpenCodeEnvVars()` (from review)

> **[REVIEW M7]** API keys passed via inline `export` in the tmux command are visible in `ps` output and tmux history. Use `tmux setenv` to set sensitive vars on the session instead.

```typescript
/**
 * Set sensitive environment variables on a tmux session via setenv.
 * These are inherited by panes but not visible in ps or tmux history.
 *
 * [RE-REVIEW] API keys may contain ", $, or other shell metacharacters.
 * Use single-quote wrapping with escaped inner single quotes to prevent injection.
 */
function setOpenCodeEnvVars(muxName: string): void {
  const sensitiveVars = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GOOGLE_API_KEY'];
  for (const key of sensitiveVars) {
    const val = process.env[key];
    if (val) {
      // Shell-escape: wrap in single quotes, escape any inner single quotes
      const escaped = val.replace(/'/g, "'\\''");
      execSync(`tmux setenv -t '${muxName}' ${key} '${escaped}'`, {
        encoding: 'utf8',
        timeout: 3000,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    }
  }
}
```

#### New Helper: `setOpenCodeConfigContent()` (from re-review)

> **[RE-REVIEW]** `OPENCODE_CONFIG_CONTENT` must NEVER be embedded in a shell command string — user-supplied JSON can contain shell metacharacters (`$()`, `;`, `&&`). Use `tmux setenv` instead, which treats the value as a raw string.

```typescript
/**
 * Set OPENCODE_CONFIG_CONTENT on a tmux session via setenv.
 * Call BEFORE respawnPane().
 */
function setOpenCodeConfigContent(muxName: string, jsonContent: string): void {
  // Validate JSON to prevent garbage config
  JSON.parse(jsonContent); // throws if invalid

  // Shell-escape for the tmux command
  const escaped = jsonContent.replace(/'/g, "'\\''");
  execSync(`tmux setenv -t '${muxName}' OPENCODE_CONFIG_CONTENT '${escaped}'`, {
    encoding: 'utf8',
    timeout: 3000,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}
```

#### `respawnPane()` — Same Changes (around line 426)

Apply identical command construction logic in `respawnPane()`.

#### Session Discovery — Handle OpenCode sessions

In `reconcileSessions()` (line 700+), discovered unknown sessions currently default to `mode: 'claude'`. Need to detect OpenCode sessions:

```typescript
// In reconcileSessions(), when examining running process in tmux pane:
// Check what command is running: tmux display-message -p '#{pane_current_command}'
// If it's 'opencode', set mode accordingly
const cmd = execSync(`tmux display-message -t "${muxName}" -p '#{pane_current_command}'`, ...).trim();
const mode = cmd.includes('opencode') ? 'opencode' : 'claude';
// [REVIEW] For recovered sessions, prefer the persisted MuxSession.mode over command sniffing.
// #{pane_current_command} only shows the foreground binary name — if OpenCode spawns a child
// process (e.g., bash), it will show 'bash', not 'opencode'.
```

### Known Limitations (from review)

> **[REVIEW P1-6]** OpenCode does not have `--session-id <claudeman-id>` for initial session creation (only `--session <id>` for continuing existing sessions). This means:
> - `_claudeSessionId = this.id` correlation (session.ts:405) won't work for OpenCode
> - Subagent-session correlation via Session ID matching won't work
> - Transcript watching via Claude session ID path won't work
>
> **Mitigation**: Let OpenCode manage its own sessions. Store the OpenCode session ID mapping in `SessionState` after the first session is created.

> **[REVIEW P1-7]** The `toState()` method in `session.ts:782-816` must be updated to include `openCodeConfig` in the serialized state. Without this, state persistence silently drops the config and OpenCode sessions can't be restored after server restart.

---

## 9. Phase 4: Output Parsing & Idle Detection *(DEFERRED — not in MVP)*

> **DEFERRED**: This entire phase (except `waitForOpenCodeReady()`) is out of MVP scope. Idle detection, ANSI content filter, working/busy state tracking, and token parsing are all deferred until we have real PTY output data from stable OpenCode sessions. Only the basic TUI ready detection from `waitForOpenCodeReady()` is needed for the MVP and is included in Phase 3.

### Goal
Detect OpenCode's state from terminal output (idle, working, ready).

### Challenge: Bubble Tea TUI

Unlike Claude Code (Ink), OpenCode uses Bubble Tea (Go), which:
- Uses alternate screen buffer (`\x1b[?1049h`)
- Redraws the entire screen on each update — Bubble Tea does full `View()` redraws, not differential (cursor movements + clear sequences)
- Has a different visual structure (sidebar, message area, input area)
- May enable mouse event reporting (`CSI ?1000h`/`CSI ?1006h`), generating PTY output on mouse movements

**Key insight**: We don't need to parse the TUI visually. We just need to detect:
1. When the TUI is ready (initial render complete)
2. When OpenCode is working vs idle (for respawn)
3. When output has stopped changing (for completion detection)

### CRITICAL: ANSI Content Filter Required (from review)

> **[REVIEW C1]** Bubble Tea redraws the **entire screen** on every update. Even when the AI model is idle, Bubble Tea may emit cursor blinking/repositioning sequences, timer-based redraws (e.g., clock display updates), and mouse protocol output. This means `lastActivityAt` will be constantly reset by TUI maintenance redraws, and the silence threshold will **never trigger**.
>
> **Mandatory fix**: Add an ANSI content-change filter between the PTY and idle detection. Only treat actual text content changes (not cursor movements, screen redraws, or mouse protocol output) as "real output".

```typescript
// New utility: src/utils/ansi-content-filter.ts
// Strips non-content ANSI sequences so idle detection only sees real text changes

const CURSOR_MOVEMENT = /\x1b\[\??[\d;]*[HJKfABCDEFGnsurlm]/g;
const SCREEN_MODE = /\x1b\[\?[\d;]*[hlst]/g;      // alternate screen, mouse, etc.
const MOUSE_EVENT = /\x1b\[M.../g;                  // mouse button events
const MOUSE_SGR = /\x1b\[<[\d;]+[mM]/g;             // SGR mouse events
const ERASE_DISPLAY = /\x1b\[[\d]*J/g;              // clear screen variants
const ERASE_LINE = /\x1b\[[\d]*K/g;                 // clear line variants
const CURSOR_POSITION = /\x1b\[\d+;\d+H/g;          // absolute cursor positioning
const CURSOR_SAVE_RESTORE = /\x1b[78]/g;             // save/restore cursor

/**
 * Extract only meaningful text content changes from PTY output.
 * Returns empty string if the output was purely cosmetic (redraws, cursor moves).
 */
export function extractContentChanges(data: string): string {
  return data
    .replace(CURSOR_MOVEMENT, '')
    .replace(SCREEN_MODE, '')
    .replace(MOUSE_EVENT, '')
    .replace(MOUSE_SGR, '')
    .replace(ERASE_DISPLAY, '')
    .replace(ERASE_LINE, '')
    .replace(CURSOR_POSITION, '')
    .replace(CURSOR_SAVE_RESTORE, '')
    .replace(/\x1b\[[\d;]*m/g, '') // SGR color/style
    .trim();
}
```

```typescript
// In session.ts onData handler for OpenCode mode:
// Only update lastActivityAt when there are REAL content changes
if (this.mode === 'opencode') {
  const content = extractContentChanges(data);
  if (content.length > 0) {
    this._lastActivityAt = Date.now();
  }
  // Don't update for cosmetic-only redraws
}
```

### `_idleConfig` Property Initialization (from re-review)

> **[RE-REVIEW]** The code snippets below reference `this._idleConfig.silenceThresholdMs` but `_idleConfig` does not exist on `Session`. The `getIdleDetectionConfig()` helper's return value must be stored as a private property, initialized in the constructor:

```typescript
// In session.ts constructor:
private _idleConfig: ReturnType<Session['getIdleDetectionConfig']>;

constructor(options: SessionOptions) {
  // ...existing init...
  this._idleConfig = this.getIdleDetectionConfig();
}
```

### Gate `_processExpensiveParsers()` for OpenCode (from re-review)

> **[RE-REVIEW]** The 150ms-throttled `_processExpensiveParsers()` path in session.ts handles Ralph tracking, bash tool parsing, and token parsing — all Claude-specific. For OpenCode sessions, these must be gated:

```typescript
// In _processExpensiveParsers():
private _processExpensiveParsers(strippedData: string): void {
  if (this.mode === 'opencode') {
    // Skip Claude-specific parsers: Ralph tracker, BashToolParser, token parsing
    // These depend on Claude's output format and would produce false positives
    return;
  }
  // ...existing Claude parsing logic...
}
```

### Prompt Detection — `waitForOpenCodeReady()`

OpenCode's TUI takes longer to initialize than Claude's prompt:

> **[REVIEW M5]** 500ms silence threshold is too short — Bubble Tea may pause between component renders, triggering a false "ready" signal. Increased to 2000ms. Also: do NOT clear the terminal after ready detection — unlike Claude Code, the OpenCode TUI's initial render IS the useful content.

```typescript
// In session.ts, add OpenCode-specific ready detection
private async waitForOpenCodeReady(): Promise<void> {
  // OpenCode's Bubble Tea TUI renders asynchronously.
  // Wait for output to stabilize (no new data for 2s after initial burst).
  const maxWait = 15000; // OpenCode TUI can take up to 15s
  const stabilityThreshold = 2000; // [REVIEW] 2s stability, not 500ms — TUI pauses between component renders
  const checkInterval = 100;
  let elapsed = 0;
  let lastContentTime = Date.now();

  const onOutput = (_data: string) => {
    // [REVIEW C1] Only track content changes, not cosmetic redraws
    const content = extractContentChanges(_data);
    if (content.length > 0) {
      lastContentTime = Date.now();
    }
  };
  this.on('terminal', onOutput);

  try {
    while (elapsed < maxWait) {
      await new Promise(r => setTimeout(r, checkInterval));
      elapsed += checkInterval;

      const silentMs = Date.now() - lastContentTime;
      if (silentMs >= stabilityThreshold && this._terminalBuffer.length > 200) {
        // TUI has rendered and stabilized
        break;
      }
    }
  } finally {
    this.off('terminal', onOutput);
  }

  // [REVIEW] Do NOT clear the terminal — OpenCode's TUI initial render IS the useful content.
  // Unlike Claude Code where initialization junk should be cleared, the Bubble Tea TUI
  // continuously redraws, so clearing would just cause a flash.
}
```

### Idle Detection Strategy

**Multi-layer approach (matching Claude's pattern):**

1. **Output silence** (primary) — No terminal output for N seconds → likely idle
2. **OpenCode plugin** (advanced, Phase 7) — `session.idle` event fires → definitive signal
3. **AI checker** (fallback) — Same AI-powered idle check, but only if Claude CLI is also available

```typescript
// In session.ts, add mode-aware idle detection configuration
private getIdleDetectionConfig() {
  if (this.mode === 'opencode') {
    return {
      // OpenCode idle detection is primarily output-silence based
      silenceThresholdMs: 5000,     // 5s silence = likely idle
      promptPattern: null,           // No regex prompt detection for Bubble Tea TUI
      workingKeywords: null,         // Don't scan for Claude-specific keywords
      useAIChecker: false,           // AI checker requires Claude CLI (enable in Phase 7 if desired)
      completionPattern: null,       // OpenCode completion format TBD (needs empirical testing)
    };
  }
  // Existing Claude defaults
  // [RE-REVIEW] Corrected: actual Claude idle detection uses:
  //   - Prompt char ❯ detection → _awaitingIdleConfirmation → 2s debounce → emit 'idle'
  //   - Spinner chars (Braille ⠋⠙⠹⠸⠼⠴⠦⠧) → immediately sets _isWorking=true, _status='busy'
  //   - Keywords (Thinking, Writing, Reading, Running) in throttled 150ms parser
  //   - NO completionPattern in session.ts (that's in respawn-controller.ts)
  // This config object is for the NEW OpenCode-compatible detection system.
  return {
    silenceThresholdMs: 3000,
    promptPattern: /[❯\u276f]/,
    workingKeywords: ['Thinking', 'Writing', 'Reading', 'Running', 'Searching'],
    useAIChecker: true,
    completionPattern: null, // completion detection lives in respawn-controller, not session
  };
}
```

### Token Tracking

**Phase 1**: Skip token tracking for OpenCode sessions.
**Phase 8**: Use OpenCode's server API to poll session stats for structured token/cost data.

```typescript
// In session.ts, mode-aware token parsing
private parseTokens(data: string): void {
  if (this.mode === 'opencode') {
    // OpenCode displays tokens in format: "~27s · 275.9k tokens"
    // But this is inside the Bubble Tea TUI, making regex extraction unreliable
    // Skip for now — Phase 8 adds API-based tracking
    return;
  }
  // Existing Claude token parsing...
}
```

### Working/Idle State Tracking

For Claude, Claudeman uses spinner characters and keywords. For OpenCode:

> **[REVIEW]** The original logic had a bug: `Date.now() - this._lastActivityAt > 100` is checked AFTER setting `_lastActivityAt = Date.now()`, so the condition would never be true (0 > 100 = false). Fixed below.

> **[REVIEW M1]** The `session.isWorking` property is used by the respawn controller as a final safety check. For Claude, it's set by detecting JSON messages and working patterns. For OpenCode, `isWorking` must be driven by the ANSI content filter — mark working when real content appears after a period of silence.

```typescript
// In session.ts onData handler:
if (this.mode === 'opencode') {
  // [REVIEW C1] Only track content changes, not cosmetic TUI redraws
  const content = extractContentChanges(data);
  if (content.length === 0) return; // Cosmetic-only redraw, ignore

  const timeSinceLastOutput = Date.now() - this._lastActivityAt;
  this._lastActivityAt = Date.now();

  // If we had no real content for >silenceThreshold and now get content → mark busy
  if (this._status === 'idle' && timeSinceLastOutput > this._idleConfig.silenceThresholdMs) {
    this._status = 'busy';
    this._isWorking = true;
    this.emit('working');
  }
} else {
  // Existing Claude spinner/keyword detection
}
```

---

## 10. Phase 5: API Routes & Frontend UI

### API Changes

#### `src/web/server.ts`

**Session creation route** (around line 810):

```typescript
// In POST /api/sessions handler, add OpenCode check:
if (body.mode === 'opencode') {
  if (!isOpenCodeAvailable()) {
    return reply.status(400).send(
      createErrorResponse('OpenCode CLI not found. Install: curl -fsSL https://opencode.ai/install | bash')
    );
  }
}

// Pass openCodeConfig to Session constructor:
const session = new Session({
  workingDir,
  mode: body.mode || 'claude',
  name: body.name || '',
  mux: this.mux,
  useMux: true,
  niceConfig: globalNice,
  model: body.mode === 'opencode' ? body.openCodeConfig?.model : model,
  openCodeConfig: body.mode === 'opencode' ? body.openCodeConfig : undefined,
  // ...existing params
});
```

**New route — OpenCode availability check:**

```typescript
// GET /api/opencode/status
server.get('/api/opencode/status', async () => ({
  available: isOpenCodeAvailable(),
  path: resolveOpenCodeDir(),
}));
```

**Extend interactive start for OpenCode mode:**

```typescript
// POST /api/sessions/:id/interactive — already the generic start route
// Just need to ensure it works for all modes:
await session.startInteractive(); // mode determines what command spawns
getLifecycleLog().log({ event: 'started', sessionId: id, name: session.name, mode: session.mode });
this.broadcast('session:interactive', { id, mode: session.mode });
```

**Quick-start for OpenCode:**

> **[RE-REVIEW]** `writeHooksConfig(casePath)` is called unconditionally at line 2625 in quick-start. Must guard with `mode !== 'opencode'` — Claude hooks are irrelevant for OpenCode sessions.
> Also: lifecycle logs at lines 1657 and 2675 hardcode `mode: 'claude'` — should use `session.mode`.

```typescript
// POST /api/quick-start — extend to handle opencode mode:
if (mode === 'opencode') {
  // Skip Claude-specific setup (hooks, CLAUDE.md generation)
  // [RE-REVIEW] writeHooksConfig() must NOT be called for OpenCode sessions
  // But do set up opencode.json permission config if autoAllowTools
  await session.startInteractive();
} else if (mode === 'shell') {
  await session.startShell();
} else {
  // Claude mode — write hooks config as before
  writeHooksConfig(casePath);
  await session.startInteractive();
}

// [RE-REVIEW] Use session.mode in lifecycle log, NOT hardcoded 'claude':
getLifecycleLog().log({ event: 'started', sessionId: id, name: session.name, mode: session.mode });
```

#### `src/web/schemas.ts`

> **[REVIEW C4]** Also update `ALLOWED_ENV_PREFIXES` to include `'OPENCODE_'`, and add `OPENCODE_SERVER_PASSWORD` to `BLOCKED_ENV_KEYS` (security-sensitive). Also update `QuickStartSchema` to include `'opencode'` mode and `openCodeConfig` field.
>
> **[RE-REVIEW]** These MUST be an atomic change — shipping the `OPENCODE_` prefix addition without simultaneously blocking `OPENCODE_SERVER_PASSWORD` creates a security window where the server password can be set via API.

Update `CreateSessionSchema` and `QuickStartSchema`:

```typescript
export const CreateSessionSchema = z.object({
  prompt: z.string().optional(),
  workingDir: WorkingDirSchema.optional(),
  mode: z.enum(['claude', 'shell', 'opencode']).optional(),
  name: z.string().max(100).optional(),
  // ...existing fields...
  openCodeConfig: z.object({
    model: z.string().max(100).regex(/^[a-zA-Z0-9._\-/]+$/).optional(),
    autoAllowTools: z.boolean().optional(),
    continueSession: z.string().max(100).regex(/^[a-zA-Z0-9_-]+$/).optional(),
    forkSession: z.boolean().optional(),
    serverPort: z.number().int().min(1024).max(65535).optional(),
    configContent: z.string().max(10000).optional(),
  }).optional(),
});
```

### Frontend Changes

#### `src/web/public/app.js`

**Session creation UI** — Add OpenCode option:

```javascript
// In quick-start or new session dialog, add a mode selector:
// Three-way toggle: [Claude Code] [OpenCode] [Shell]

function createModeSelector(container, defaultMode) {
  const modes = [
    { value: 'claude', label: 'Claude Code', desc: 'Anthropic Claude AI' },
    { value: 'opencode', label: 'OpenCode', desc: 'Multi-model AI agent' },
    { value: 'shell', label: 'Shell', desc: 'Plain terminal' },
  ];

  // Check OpenCode availability
  fetch('/api/opencode/status').then(r => r.json()).then(status => {
    if (!status.available) {
      // Gray out OpenCode option, show install hint
      opencodeBtn.disabled = true;
      opencodeBtn.title = 'OpenCode not installed';
    }
  });

  // When OpenCode selected, show model input:
  // - Text input with datalist of common models
  // - Checkbox for "Auto-allow tools" (equivalent to --dangerously-skip-permissions)
}
```

**Model selector for OpenCode:**

```javascript
function createOpenCodeModelInput() {
  const commonModels = [
    'anthropic/claude-sonnet-4-5',
    'anthropic/claude-opus-4-5',
    'openai/gpt-5.2',
    'openai/gpt-5.2-mini',
    'google/gemini-3-pro',
    'ollama/codellama',
    'ollama/llama3',
    'ollama/deepseek-coder',
  ];

  // Render as <input> with <datalist> for autocomplete
  // Default to 'anthropic/claude-sonnet-4-5'
}
```

**Tab badge** — Show mode indicator:

```javascript
// In tab rendering (search for shell tab-mode class):
// CURRENT:
// ${mode === 'shell' ? '<span class="tab-mode shell" aria-hidden="true">sh</span>' : ''}

// PROPOSED:
function getModeBadge(mode) {
  if (mode === 'opencode') return '<span class="tab-mode opencode" aria-hidden="true">oc</span>';
  if (mode === 'shell') return '<span class="tab-mode shell" aria-hidden="true">sh</span>';
  return ''; // Claude = no badge (default)
}
```

**CSS for OpenCode badge:**

```css
.tab-mode.opencode {
  background: #10b981; /* Green - OpenCode brand */
  color: white;
}
```

**Feature gating** — Disable Claude-specific features for OpenCode (MVP):

```javascript
// Functions to check session capabilities:
function isClaudeSession(session) { return session.mode === 'claude'; }
function isOpenCodeSession(session) { return session.mode === 'opencode'; }
function isAgentSession(session) { return session.mode === 'claude' || session.mode === 'opencode'; }

// UI sections to gate for MVP:
// - Hooks panel: HIDE for OpenCode (no plugin bridge yet)
// - Auto-compact button: HIDE for OpenCode (has built-in compaction)
// - Ralph tracker settings: HIDE for OpenCode (no <promise> tags, no RALPH_STATUS)
// - Subagent panel: HIDE for OpenCode (no BashToolParser/SubagentWatcher integration)
// - Token display: HIDE for OpenCode (no token parsing)
// - Respawn: HIDE for OpenCode (respawn controller is deferred)
// - Circuit breaker: HIDE for OpenCode (depends on Ralph Tracker)
// - Input/resize/kill: SHOW for all modes ✓
// - Tab badges: SHOW for all modes ✓
// - Terminal rendering: SHOW for all modes ✓
```

**Respawn section visibility (MVP — hide for OpenCode):**

```javascript
// CURRENT (line ~10289):
if (session.mode === 'claude' && session.pid) {
  respawnSection.style.display = '';
}

// MVP: No change needed — already gated to 'claude' only.
// When respawn is eventually supported for OpenCode (Phase 7), update to:
// if ((session.mode === 'claude' || session.mode === 'opencode') && session.pid) {
//   respawnSection.style.display = '';
// }
```

---

## 11. Phase 6: Hooks & Plugin Bridge *(DEFERRED — not in MVP)*

> **DEFERRED**: Plugin event names are speculative and unverified. This phase requires Phase 0 plugin verification first. The entire hooks/plugin system is out of MVP scope — OpenCode sessions in the MVP are manual-interaction only.
>
> **[REVIEW C3] Phase reordered**: This was originally Phase 7 but has been moved before Respawn. The plugin bridge provides the reliable `session.idle` event that the respawn controller needs. Without it, respawn relies on output-silence-only detection, which is unreliable with Bubble Tea TUIs (see Review C1). **Do not implement respawn (Phase 7) until this phase is complete and tested.**

### Goal
Bridge Claudeman's hook system with OpenCode's plugin system for rich event forwarding.

### Background: Two Different Approaches

| Feature | Claude Code Hooks | OpenCode Plugins |
|---------|-------------------|------------------|
| Format | Shell commands in `settings.local.json` | JS/TS modules in `.opencode/plugins/` |
| Trigger | Hook name matches event type | Event name subscription |
| Key events | `stop`, `idle_prompt`, `permission_prompt`, `elicitation_dialog` | `session.idle`, `permission.asked`, `session.status` |
| Communication | Exit codes + environment variables | Function context + return values |
| Install | Auto-generated by Claudeman | Must be placed in `.opencode/plugins/` |

### Claudeman Plugin for OpenCode

Create a Claudeman plugin that OpenCode loads, which communicates back to Claudeman's API:

**File: `.opencode/plugins/claudeman-bridge.js`** (generated per session)

```javascript
// This plugin bridges OpenCode events to Claudeman's API
export const claudemanBridge = async ({ project, $ }) => {
  const apiUrl = process.env.CLAUDEMAN_API_URL || 'http://localhost:3000';
  const sessionId = process.env.CLAUDEMAN_SESSION_ID;

  if (!sessionId) return {};

  async function notifyClademan(event, data = {}) {
    try {
      await fetch(`${apiUrl}/api/hook-event`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, event, data }),
      });
    } catch { /* ignore errors */ }
  }

  return {
    'session.idle': async () => {
      await notifyClademan('idle_prompt', { timestamp: Date.now() });
    },
    'session.status': async (status) => {
      await notifyClademan('session_status', { status });
    },
    'permission.asked': async (permission) => {
      await notifyClademan('permission_prompt', { permission });
    },
    'permission.replied': async (reply) => {
      await notifyClademan('permission_reply', { reply });
    },
    'session.error': async (error) => {
      await notifyClademan('session_error', { error });
    },
    'tool.execute.before': async (tool) => {
      await notifyClademan('tool_start', { tool: tool.name });
    },
    'tool.execute.after': async (tool) => {
      await notifyClademan('tool_end', { tool: tool.name });
    },
    'todo.updated': async (todos) => {
      await notifyClademan('todo_update', { todos });
    },
  };
};
```

### Plugin Installation

When creating an OpenCode session, Claudeman generates this plugin in the project's `.opencode/plugins/` directory:

```typescript
// In session.ts or a new opencode-hooks.ts:
async function installOpenCodePlugin(workingDir: string, sessionId: string): Promise<void> {
  const pluginDir = join(workingDir, '.opencode', 'plugins');
  await mkdirp(pluginDir);

  const pluginContent = generateClaudemanBridgePlugin(sessionId);
  await writeFile(join(pluginDir, 'claudeman-bridge.js'), pluginContent);
}
```

### Additional Plugin Events (from review)

> **[REVIEW]** Add `session.compacted` to the plugin bridge — it's free and useful for tracking when OpenCode auto-compacts (relevant for token tracking and respawn timing).

```javascript
// Add to claudeman-bridge.js return object:
'session.compacted': async (info) => {
  await notifyClademan('session_compacted', { info });
},
```

### Plugin Event Verification Warning

> **[REVIEW M3]** The event names in this section and Appendix B are speculative — they have not been verified against OpenCode's actual plugin API. Event names, callback signatures, and firing timing may differ from what's documented here.
>
> **HARD PREREQUISITE**: Before implementing this phase, complete Phase 0's plugin verification checklist — install a test plugin and confirm which events actually fire and when. The `session.idle` event is particularly critical: does it fire when the model finishes generating, or when the TUI returns to the input prompt? This distinction matters enormously for idle detection timing.

### Benefits of the Plugin Bridge

Once installed, Claudeman receives structured events from OpenCode:
- **`session.idle`** → Definitive idle detection (replaces output-silence guessing)
- **`permission.asked`** → Show permission prompts in Claudeman UI
- **`tool.execute.*`** → Tool call tracking (similar to BashToolParser for Claude)
- **`todo.updated`** → OpenCode's built-in todo system → Claudeman can display it
- **`session.error`** → Error surfacing in Claudeman UI
- **`session.compacted`** → Track auto-compaction events

---

## 12. Phase 7: Respawn & Ralph Loop Adaptation *(DEFERRED — not in MVP)*

> **DEFERRED**: Respawn controller (3,500 lines, 13 states), Ralph Loop, and Ralph Tracker are all deeply coupled to Claude's output protocols (`Worked for Xm Xs`, `<promise>` tags, `---RALPH_STATUS---` blocks, spinner chars, `❯` prompt). With 75+ model providers in OpenCode producing different output formats, these systems will break in unpredictable ways. Deferring until we have: (1) stable OpenCode sessions with real PTY data, (2) verified plugin bridge from Phase 6, (3) empirical idle detection calibration.
>
> **[REVIEW C3] Phase reordered**: This was originally Phase 6 but has been moved after Plugin Bridge. The plugin bridge's `session.idle` event is the primary reliable idle signal for OpenCode sessions. Implementing respawn before the bridge exists means relying on output-silence-only detection, which is unreliable.
>
> **[REVIEW]** Respawn should ship **disabled by default** for OpenCode sessions. Enable only after the plugin bridge (Phase 6) is proven to work reliably.

### Architectural Change: CompletionDetector Interface (from review)

> **[REVIEW C2]** The RespawnController is ~3,500 lines with 13 states, `assertNever()` exhaustive switches in multiple places, and dozens of methods. Sprinkling `if (mode === 'opencode')` throughout would be unmaintainable. **Fix**: Create a `CompletionDetector` interface.

```typescript
// New interface in src/types.ts or src/completion-detector.ts:
interface CompletionDetector {
  /** Check if terminal output indicates the AI has finished */
  isCompletionMessage(data: string): boolean;
  /** Check if terminal output indicates the AI is currently working */
  hasWorkingPattern(data: string): boolean;
  /** Get the idle timeout for this backend */
  getIdleTimeoutMs(): number;
  /** Get the completion silence threshold */
  getCompletionSilenceMs(): number;
  /** Whether this detector supports AI-powered idle checking */
  supportsAIChecker(): boolean;
}

class ClaudeCompletionDetector implements CompletionDetector {
  isCompletionMessage(data: string): boolean {
    return /\bWorked\s+for\s+\d+[hms](\s*\d+[hms])*/i.test(data);
  }
  hasWorkingPattern(data: string): boolean {
    return /Thinking|Writing|Reading|Running|Searching|Editing|Creating/.test(data);
  }
  getIdleTimeoutMs(): number { return 3000; }
  getCompletionSilenceMs(): number { return 5000; }
  supportsAIChecker(): boolean { return true; }
}

class OpenCodeCompletionDetector implements CompletionDetector {
  isCompletionMessage(data: string): boolean {
    // OpenCode doesn't emit "Worked for Xm Xs" — rely on plugin bridge's session.idle event
    // or fall back to output silence (via ANSI content filter)
    return false; // Never matches — idle detection is event-driven
  }
  hasWorkingPattern(data: string): boolean {
    // OpenCode working patterns TBD — needs Phase 0 empirical data
    // Bubble Tea TUI uses different status indicators than Claude
    return false;
  }
  getIdleTimeoutMs(): number { return 8000; } // Conservative for TUI redraws
  getCompletionSilenceMs(): number { return 10000; }
  supportsAIChecker(): boolean { return false; } // AI checker requires Claude CLI
}
```

```typescript
// In RespawnController constructor:
this._completionDetector = session.mode === 'opencode'
  ? new OpenCodeCompletionDetector()
  : new ClaudeCompletionDetector();

// Then use throughout instead of mode checks:
if (this._completionDetector.isCompletionMessage(data)) { ... }
if (this._completionDetector.hasWorkingPattern(data)) { ... }
```

### Respawn Controller

The respawn controller sends Claude CLI commands (`/clear`, `/compact`, `/init`, `/update`) which are Claude-specific. For OpenCode, we need alternative commands.

#### Command Mapping

| Claude Code | OpenCode Equivalent | Notes |
|-------------|---------------------|-------|
| `/clear` | `/clear` | Same command! Clears conversation |
| `/compact` | `Ctrl+X c` | Or opencode handles auto-compaction |
| `/init` | N/A | OpenCode doesn't have this |
| `/update prompt` | Just type the prompt | Direct text input |
| `/resume` | `--continue` flag on restart | Handled at spawn time |

> **[REVIEW M4]** `writeViaMux()` sends `\r` for Enter — it is untested whether Bubble Tea handles this correctly. This is a Phase 0 validation item. If Bubble Tea requires a different key sequence, the entire respawn command delivery mechanism fails.

#### Changes to `src/respawn-controller.ts`

> **[REVIEW]** Use the `CompletionDetector` interface instead of inline mode checks.

```typescript
// In the respawn cycle method:
private async startRespawnCycle(): Promise<void> {
  if (this.session.mode === 'opencode') {
    // OpenCode respawn: simpler cycle
    // 1. Wait for idle (plugin bridge session.idle event OR output silence via content filter)
    // 2. Optionally compact: skip (OpenCode manages this internally via compaction.auto)
    // 3. Send new prompt via writeViaMux()
    // 4. Wait for completion (plugin bridge session.idle event again)

    // Send prompt directly — OpenCode TUI accepts typed text
    await this.session.writeViaMux(this.config.prompt);
    return;
  }

  // Existing Claude respawn logic...
}

// Completion detection — now uses CompletionDetector:
private isCompletionDetected(): boolean {
  if (this._completionDetector.isCompletionMessage(this._lastOutput)) {
    return true;
  }
  // Fallback: silence-based detection (for both backends)
  return Date.now() - this.session.lastActivityAt > this._completionDetector.getCompletionSilenceMs();
}
```

### Missing Respawn Items (from review)

> **[REVIEW]** These items are NOT addressed above and need design work:
>
> 1. **Circuit breaker signals for OpenCode**: The circuit breaker tracks `no-progress`, `same-error-repeated`, and `tests-failing-too-long`. These signals come from Ralph tracker's `RALPH_STATUS` blocks, which are Claude-specific output patterns. Need alternative signal sources for OpenCode (possibly via plugin bridge `session.error` events).
>
> 2. **`/compact` equivalent**: The plan says "OpenCode handles this internally via `compaction.auto`" — but the respawn controller may need to trigger compaction at specific points in the cycle. No programmatic compaction control is available without Phase 8's server API.
>
> 3. **`sendUpdateDocs()` equivalent**: The respawn cycle starts by sending a progress-summary prompt that writes to CLAUDE.md. For OpenCode, what prompt makes sense? OpenCode uses `opencode.json`, not CLAUDE.md.
>
> 4. **No `elicitation_dialog` equivalent**: Claude Code has hooks that signal when Claude asks the user a question. The respawn controller uses this to skip auto-accept. OpenCode may not have an equivalent — if auto-accept is enabled, it could accept prompts that are actually questions.

### Ralph Loop

> **[REVIEW]** Ralph Loop for OpenCode should be marked **experimental** and deferred to a later phase. Without `<promise>PHRASE</promise>` tags, Ralph loses its primary completion signal and becomes a timeout-based prompt repeater — a significantly degraded experience.

The Ralph Loop's polling/assignment mechanism is CLI-agnostic (it uses `session.sendInput()` and `writeViaMux()`). However, its completion signaling is Claude-specific: `sessionCompletion` events are only emitted when ralph-tracker detects `<promise>PHRASE</promise>` tags in output, which is a custom Claude protocol. The main adaptation needed:

```typescript
// In ralph-loop.ts:
// Completion detection for OpenCode:
if (session.mode === 'opencode') {
  // Use plugin bridge session.idle event (preferred) or silence-based detection (fallback)
  // OpenCode doesn't emit <promise>PHRASE</promise> tags
  // Ralph tracker's completion phrase detection is skipped
  // WARNING: This makes Ralph Loop significantly less reliable for OpenCode
}
```

### Respawn Presets for OpenCode *(DEFERRED)*

> These presets are deferred with the rest of Phase 7. Values below are speculative — they need calibration against real PTY output data from stable OpenCode sessions.

```javascript
// DEFERRED — add to app.js when Phase 7 ships:
const OPENCODE_RESPAWN_PRESETS = {
  'opencode-solo': {
    label: 'OpenCode Solo Work',
    idleTimeoutSec: 8,    // Longer than Claude (TUI rendering creates brief output bursts)
    maxDurationMin: 60,
    completionSilenceMs: 8000,
  },
  'opencode-autonomous': {
    label: 'OpenCode Autonomous',
    idleTimeoutSec: 15,
    maxDurationMin: 480,
    completionSilenceMs: 10000,
  },
};
```

---

## 13. Phase 8: OpenCode Server API Integration (Advanced) *(DEFERRED — not in MVP)*

> **DEFERRED**: Advanced feature. Requires stable MVP sessions first, plus resolution of shared SQLite state problem (TUI + serve dual-process).

### Goal
For each OpenCode session, optionally run `opencode serve` alongside the TUI for structured API access.

### Architecture

```
tmux session ─── opencode TUI (interactive, port N/A)
                     │
                     ├── xterm.js (terminal rendering, Strategy A)
                     │
Claudeman ──── opencode serve (port 4096+N, background process)
                     │
                     ├── GET  /session/*      → structured session data
                     ├── POST /session/message → send prompt programmatically
                     ├── GET  /session/messages → conversation history
                     ├── SSE  /global/event    → real-time events
                     └── GET  /config/*        → model/provider info
```

### Architecture Warning (from review)

> **[REVIEW M8]** Running both `opencode` (TUI) and `opencode serve` in the same project directory creates a **shared SQLite state problem**. The TUI creates sessions in SQLite; the server reads from the same SQLite. But they're separate processes — there's no guarantee of session ID consistency between them.
>
> **Consider alternatives**:
> - (a) Use `opencode serve` INSTEAD of the TUI (not alongside it) — server becomes the single backend, Claudeman renders its own UI
> - (b) Use `opencode attach` to connect the TUI to the server, making the server the single source of truth
> - (c) Accept the dual-process model with explicit documentation of limitations
>
> **Also**: In containerized/firewalled environments, `opencode serve` binding to ports may be blocked.

### Port Assignment

> **[REVIEW]** The original `Array.from(this.sessions.keys()).indexOf(this.id)` is fragile — session deletion creates gaps, concurrent creation can collide. Use an incrementing counter or port pool instead.

```typescript
// Each OpenCode session gets a unique port for its server
// Use a port pool with allocation/release
private static _nextPort = 4100;
private static _releasedPorts: number[] = [];

private allocateOpenCodePort(): number {
  if (OpenCodePortAllocator._releasedPorts.length > 0) {
    return OpenCodePortAllocator._releasedPorts.pop()!;
  }
  return OpenCodePortAllocator._nextPort++;
}
```

### Server Lifecycle

Start `opencode serve` when session starts, kill when session stops:

```typescript
// In session.startInteractive() for opencode mode:
if (this.mode === 'opencode' && this._openCodeConfig?.serverPort) {
  const { spawn } = require('child_process');
  this._openCodeServer = spawn('opencode', [
    'serve',
    '--port', String(this._openCodeConfig.serverPort),
    '--cors', `http://localhost:${process.env.PORT || 3000}`,
  ], {
    cwd: this.workingDir,
    env: {
      ...process.env,
      OPENCODE_SERVER_PASSWORD: crypto.randomUUID() /* generateSessionToken() does not exist — use crypto.randomUUID() */,
    },
    stdio: 'ignore',
    detached: true,
  });

  // [REVIEW] Register with CleanupManager for centralized disposal.
  // The once('exit') handler alone is insufficient — if the server crashes
  // without triggering exit, the opencode serve process becomes a zombie.
  // [RE-REVIEW] API is registerCleanup(type, fn, description), NOT addCustom().
  this.cleanup.registerCleanup('stream', () => {
    if (this._openCodeServer && !this._openCodeServer.killed) {
      this._openCodeServer.kill('SIGTERM');
    }
  }, 'opencode serve process');

  // Also add auth headers for proxy routes:
  // [REVIEW] OpenCode uses HTTP Basic Auth (username: "opencode").
  // The proxy needs to inject: Authorization: Basic base64("opencode:" + password)
  this._openCodeServerAuth = Buffer.from(`opencode:${crypto.randomUUID() /* generateSessionToken() does not exist — use crypto.randomUUID() */}`).toString('base64');
}
```

### Proxy Routes in `server.ts`

```typescript
// GET /api/sessions/:id/opencode/session → proxies to opencode serve
// GET /api/sessions/:id/opencode/messages → conversation history
// POST /api/sessions/:id/opencode/message → send message
// GET /api/sessions/:id/opencode/models → available models
```

### Benefits

- **Structured token/cost data** without TUI parsing
- **Conversation history** as structured messages
- **Model switching** mid-session via API
- **Session forking** — create conversation branches
- **Tool call visibility** — see what tools OpenCode is executing
- **Definitive idle/completion state** via API polling

---

## 14. Files to Modify

### MVP Files (Phases 0, 1, 2, 3, 5)

| File | Changes | Phase |
|------|---------|-------|
| `src/types.ts` | Add `SessionMode` (unified), `OpenCodeConfig`, extend `SessionState` | 1 |
| `src/session.ts` | Import `SessionMode` from types (remove duplicate), add OpenCode startup + basic `waitForOpenCodeReady()`, `toState()` update | 1, 3 |
| `src/mux-interface.ts` | Import `SessionMode`, refactor to options objects (`CreateSessionOptions`, `RespawnPaneOptions`) | 1 |
| `src/tmux-manager.ts` | Extract `buildSpawnCommand()`, add `buildOpenCodeCommand()`, `setOpenCodeEnvVars()`, `setOpenCodeConfigContent()`, env var exports, PATH resolution. Refactor `createSession()`/`respawnPane()` to match new options-object signatures. | 1, 3 |
| `src/web/schemas.ts` | Update mode enum, add `OpenCodeConfigSchema`, add `OPENCODE_` to `ALLOWED_ENV_PREFIXES` (atomic with `OPENCODE_SERVER_PASSWORD` block), update `QuickStartSchema` | 1, 5 |
| `src/web/server.ts` | New routes, mode checks, OpenCode availability endpoint, `writeHooksConfig` guard | 5 |
| `src/web/public/app.js` | Mode selector, tab badges, model picker, feature gating (hide respawn/Ralph for OpenCode) | 5 |
| `src/state-store.ts` | Persist `openCodeConfig` in session state | 1 |
| `src/utils/index.ts` | Re-export OpenCode resolver | 2 |
| `src/session-lifecycle-log.ts` | Log OpenCode-specific events, fix hardcoded `mode: 'claude'` | 3 |

### Deferred Files (Phases 4, 6, 7, 8)

| File | Changes | Phase | Status |
|------|---------|-------|--------|
| `src/respawn-controller.ts` | `CompletionDetector` interface, OpenCode respawn cycle | 7 | DEFERRED |
| `src/ralph-loop.ts` | Mode-aware completion detection | 7 | DEFERRED |
| `src/ralph-tracker.ts` | Skip Claude-specific patterns for OpenCode | 7 | DEFERRED |
| `src/hooks-config.ts` | Skip Claude hook generation for OpenCode | 6 | DEFERRED |

> **[REVIEW]** `mux-factory.ts` does NOT need changes — it just instantiates `TmuxManager` with no parameters.

## 15. Files to Create

### MVP Files

| File | Purpose | Phase |
|------|---------|-------|
| `src/utils/opencode-cli-resolver.ts` | Resolve `opencode` binary location | 2 |
| `test/opencode-resolver.test.ts` | Tests for binary resolution | 2 |
| `test/opencode-session.test.ts` | Tests for OpenCode session spawning (port 3155) | 3 |

### Deferred Files

| File | Purpose | Phase | Status |
|------|---------|-------|--------|
| `src/utils/ansi-content-filter.ts` | Strip cosmetic ANSI sequences for idle detection | 4 | DEFERRED |
| `src/completion-detector.ts` | `CompletionDetector` interface + implementations | 7 | DEFERRED |
| `src/opencode-plugin-generator.ts` | Generate `.opencode/plugins/claudeman-bridge.js` | 6 | DEFERRED |
| `src/opencode-api-client.ts` | Client for OpenCode's REST API (Strategy B) | 8 | DEFERRED |
| `test/opencode-respawn.test.ts` | Tests for OpenCode respawn cycle (port 3156) | 7 | DEFERRED |
| `test/ansi-content-filter.test.ts` | Tests for ANSI content filter | 4 | DEFERRED |

---

## 16. Existing plan.json Task Breakdown

The file `plan.json` at the project root contains a 48-task TDD breakdown for this integration, organized as:

- **P0** (14 tasks): Core backend abstraction — `LLMBackend` interface, `ClaudeBackend`, `OpenCodeBackend`, `BackendFactory`, Session refactoring
- **P1** (38 tasks): Full integration — CLI resolver, API routes, Zod schemas, config management, respawn adaptation, Ralph tracker, BashToolParser, hooks, frontend UI, subagent watcher, env vars, integration tests, documentation
- **P2** (8 tasks): Advanced — `opencode serve` integration, API client, Ollama model management, cost tracking, mixed-backend Ralph Loop

The `plan.json` approach is more heavyweight (full backend abstraction with DI), suitable if we plan to add more backends. This document recommends the simpler "mode extension" approach for initial implementation.

> **[REVIEW]** `plan.json` and this document are somewhat contradictory — plan.json recommends Option B (full DI abstraction with `LLMBackend`, `ClaudeBackend`, `OpenCodeBackend`, `BackendFactory`) while this document recommends Option A (simple mode extension). The P0 tasks in plan.json (14 tasks for backend abstraction) should be marked "skip for now" or removed. Some P1 tasks reference `BackendFactory` while others just extend `SessionMode`. **Reconcile before implementation begins.**

---

## 17. Risk Assessment

### Low Risk
- **Type system changes** (Phase 1) — Additive, no breaking changes, all defaults remain 'claude'
- **CLI resolver** (Phase 2) — Isolated utility, well-tested pattern from `claude-cli-resolver.ts`
- **Tab badges** (Phase 5) — Cosmetic only
- **Feature gating** (Phase 5) — Just `if` checks on `session.mode`

### Medium Risk
- **Tmux command construction** (Phase 3) — Must handle: missing binary, bad model string, env var escaping, shell metacharacter injection. Mitigated by following the exact Claude pattern and input validation.
- **Idle detection** (Phase 4) — Output silence is less precise than prompt detection. **[REVIEW C1]** Bubble Tea's continuous screen redraws mean raw output silence will never trigger — the ANSI content filter (mandatory) mitigates this but needs Phase 0 calibration.
- **`configContent` field** (Phase 3) — Arbitrary JSON passed as `OPENCODE_CONFIG_CONTENT`. A malicious client could inject any OpenCode config, including custom tool definitions or MCP servers. Mitigated by shell escaping, but consider validating JSON structure (whitelist allowed keys) or marking as admin-only.

### High Risk
- **OpenCode TUI in xterm.js** — Bubble Tea uses alternate screen buffer, mouse events, and complex cursor manipulation. **Must validate manually in Phase 0** before any coding.
- **Respawn for OpenCode** (Phase 7) — **[REVIEW C2, C3]** The respawn controller is 3,500 lines with 13 states. Without the plugin bridge's `session.idle` event, idle detection relies solely on output silence through the ANSI filter — the weakest possible detection. **Mitigated by**: shipping respawn disabled by default for OpenCode, requiring Phase 6 plugin bridge first, using `CompletionDetector` interface instead of mode-check spaghetti.
- **OpenCode server API** (Phase 8) — **[REVIEW M8]** Running TUI + serve alongside creates a shared SQLite state problem. Port allocation races, zombie processes, auth header injection needed. Mitigated by making it optional and considering serve-only alternative.
- **Plugin bridge reliability** (Phase 6) — **[REVIEW M3]** Plugin event names are speculative. The generated plugin depends on OpenCode loading it correctly and the fetch calls not failing silently. Need Phase 0 verification of actual event names and signatures.
- **Ralph Loop for OpenCode** — **[REVIEW]** Without `<promise>` tags, Ralph loses its primary completion signal. Becomes a timeout-based prompt repeater — significantly degraded experience. Should be marked experimental.

### Unknowns (Resolved by Phase 0 Manual Testing)
- OpenCode's TUI escape sequences — Does xterm.js render them correctly?
- OpenCode's SIGWINCH handling — Does resize work through tmux?
- OpenCode's stdin behavior — Does `tmux send-keys -l` work for typing? Does `send-keys Enter` trigger prompt submission?
- `remain-on-exit` behavior — Does the tmux session stay alive when OpenCode exits?
- `opencode.json` conflicts — If one exists in the project, do CLI flags override it?
- **[REVIEW]** Bubble Tea TUI redraw frequency during idle state — does it emit maintenance redraws?
- **[REVIEW]** Mouse protocol output — does Bubble Tea enable mouse reporting?
- **[REVIEW]** Plugin event names and callback signatures — are the names in Appendix B correct?
- **[REVIEW]** `writeViaMux()` `\r` handling — does Bubble Tea handle Enter the same way as Ink?
- **[REVIEW]** OpenCode auto-compaction behavior — what does TUI output look like during compaction?
- **[REVIEW]** OpenCode version compatibility — CLI flags and plugin API may change between versions

### Additional Risks (from review)

- **API key exposure** — **[REVIEW M7]** Passing API keys via inline `export` in tmux commands exposes them in `ps` output and tmux history. Mitigated by using `tmux setenv` instead.
- **Network firewall risk** — **[REVIEW]** OpenCode's `opencode serve` binds to ports — in containerized/firewalled environments, this may be blocked.
- **OpenCode version compatibility** — **[REVIEW]** No version pinning or check. OpenCode is rapidly evolving; CLI flags, plugin API, and serve endpoints could change between versions. Add version detection in CLI resolver and document minimum supported version.
- **No `elicitation_dialog` equivalent** — **[REVIEW]** Claude Code has hooks that signal when Claude asks a question. OpenCode may not have equivalent. If auto-accept is enabled for OpenCode, it could accept prompts that are actually questions to the user.

---

## 18. Testing Strategy

### Unit Tests

```bash
# Test OpenCode CLI resolver
npx vitest run test/opencode-resolver.test.ts

# Test session with mocked OpenCode
npx vitest run test/opencode-session.test.ts

# Test respawn with OpenCode backend
npx vitest run test/opencode-respawn.test.ts
```

### Test Ports (Following Convention)

- `opencode-resolver.test.ts` — No port needed (pure unit test)
- `opencode-session.test.ts` — Port **3155**
- `opencode-respawn.test.ts` — Port **3156**
- `opencode-integration.test.ts` — Port **3157** (future)

### Integration Tests

1. **Manual smoke test**: Install OpenCode → create session via API → verify TUI renders in xterm.js
2. **Playwright test**: Automate session creation → verify terminal has content → send input → verify response
3. **Respawn test**: Start respawn → verify prompt sending → verify completion detection

### Safety Rules

- **Never run OpenCode tests that spawn real tmux sessions inside Claudeman** (same safety rule as Claude tests)
- **Use MockSession** from `test/respawn-test-utils.ts` for respawn testing
- **Mock the opencode binary** for unit tests (`jest.mock` or stub)
- **Use unique test ports** (3155+) — never port 3000

---

## 19. Open Questions & Decisions

### Resolved

| Question | Decision |
|----------|----------|
| Simple extension vs. backend abstraction? | Simple extension first (add `'opencode'` to `SessionMode`), refactor later if needed |
| Should OpenCode sessions share same tab UI? | Yes, same UI with "oc" mode badge |
| How to handle permissions? | `OPENCODE_CONFIG_CONTENT` env var with `"permission": {"*": "allow"}` |
| How to handle model selection? | Pass via `--model` CLI flag + store in `openCodeConfig` |

### Open

1. **Should we support `opencode run` (non-interactive pipe mode)?**
   - Could be useful for one-shot prompts and AI checker. Lower priority than TUI mode.
   - Recommendation: Defer to Phase 8.

2. **Should Ralph Loop work with OpenCode?**
   - Technically possible (send prompts via tmux, detect completion by silence + plugin events)
   - **[REVIEW]** Without `<promise>` tags, Ralph becomes a timeout-based prompt repeater — significantly degraded
   - Recommendation: Mark as **experimental** for OpenCode. Support with longer timeouts but clearly warn users about reduced reliability

3. **What about OpenCode's built-in agent system?**
   - OpenCode has "build", "task", "title" agents plus custom agents
   - Recommendation: Ignore initially, add agent selection dropdown in Phase 8

4. **Should AI checkers use Claude or OpenCode for analysis?**
   - AI checkers currently always spawn `claude -p` for analysis
   - **[REVIEW]** If only OpenCode is installed (no Claude CLI), AI checkers silently fail — removing two important safety layers
   - **[REVIEW]** `opencode run --format json` could serve as an alternative AI checker backend
   - Recommendation: Always use Claude for AI checks if available. If Claude CLI is not available but OpenCode is, consider using `opencode run` as a fallback. Document this limitation.

5. **Should we auto-generate `opencode.json` in the working directory?**
   - Option A: Let OpenCode use existing project config (respect user settings)
   - Option B: Generate a temporary one with Claudeman's settings
   - Recommendation: Option A (use `OPENCODE_CONFIG_CONTENT` env var for Claudeman-specific overrides, don't modify project files)

6. **How should OpenCode session IDs map to Claudeman session IDs?**
   - OpenCode manages its own sessions (SQLite DB)
   - We could pass `--session <claudeman-id>` but OpenCode IDs have different format
   - Recommendation: Let OpenCode manage its own sessions, store the mapping in SessionState

---

## 20. Implementation Order

### Recommended Sequence (updated per re-review — MVP-first approach)

> **[SCOPE DECISION]** Token tracking, respawn controller, Ralph Loop/Tracker, circuit breaker, hooks plugin bridge, and AI idle checker are **all deferred**. These systems are deeply coupled to Claude's output format and protocols. With 75+ model providers in OpenCode, they will break in unpredictable ways. Ship spawn + render + basic UI first, then layer intelligence on top with real PTY data.

```
═══════════════════════════════════════════════════════
  MVP SCOPE (ship first)
═══════════════════════════════════════════════════════

Phase 0: Manual validation (1-2 hours)
  ↓
Phase 1: Type system + refactors (2-3 hours)
  ↓
Phase 2: CLI resolver (30 min)
  ↓
Phase 3: Tmux spawn (2-3 hours) ← CRITICAL INTEGRATION POINT
  ↓
Phase 5: API + frontend (2-3 hours) ← FIRST USER-VISIBLE RESULT
  ↓
  ✅ MVP COMPLETE — OpenCode sessions managed from Claudeman web UI

═══════════════════════════════════════════════════════
  DEFERRED (requires real PTY data + verified APIs)
═══════════════════════════════════════════════════════

Phase 4: Idle detection + ANSI filter — DEFERRED until PTY behavior characterized
  ↓
Phase 6: Plugin bridge — DEFERRED until plugin API verified in Phase 0
  ↓
Phase 7: Respawn adaptation — DEFERRED until Phase 6 proven reliable
  ↓
Phase 8: Server API — DEFERRED, optional advanced feature
```

> **Note on Phase 4**: Only `waitForOpenCodeReady()` (basic TUI ready detection) is needed for the MVP. The full idle detection, ANSI content filter, working/busy state tracking, and token parsing are all deferred. The MVP treats OpenCode sessions as "manual interaction only" — no automated idle/completion detection.

### Milestones

| Milestone | Phase | What You Can Do | Scope |
|-----------|-------|-----------------|-------|
| **M1: "It renders"** | 0-3 | OpenCode TUI visible in xterm.js via Claudeman | **MVP** |
| **M2: "It's usable"** | 5 | Create OpenCode sessions from web UI, type and interact, manage tabs | **MVP** |
| **M3: "It's observable"** | 4 | Idle/working state detection, ANSI content filter | Deferred |
| **M4: "It's smart"** | 6 | Plugin bridge provides definitive idle/permission/tool events | Deferred |
| **M5: "It's autonomous"** | 7 | Respawn works with OpenCode. Ralph Loop experimental. | Deferred |
| **M6: "It's rich"** | 8 | Token tracking, conversation history, model switching via API | Deferred |

### Total Effort Estimate

- **Phases 0-3, 5** (MVP): ~6-9 hours
- **Phase 4** (Idle detection): ~2-3 hours (deferred)
- **Phase 6** (Plugin bridge): ~2-3 hours (deferred)
- **Phase 7** (Respawn): ~3-4 hours (deferred)
- **Phase 8** (Server API): ~4-6 hours (deferred)
- **MVP total**: ~6-9 hours
- **Full integration total**: ~17-25 hours

---

## 21. Review Findings

> **Reviewed**: 2026-02-26 by a 4-agent team. Each agent reviewed a different area of the plan against the actual Claudeman codebase.

### Review Team

| Agent | Focus Area | Key Findings |
|-------|-----------|--------------|
| **arch-reviewer** | Type system, backend abstraction, CLI resolution (Phases 1-3) | Duplicate `SessionMode` types, parameter explosion, CLI resolver inconsistencies |
| **parsing-reviewer** | Output parsing, idle detection, OpenCode TUI behavior (Phase 4) | Alternate screen buffer breaks ALL silence-based detection, `waitForOpenCodeReady` too simplistic, working/idle logic bug |
| **respawn-reviewer** | Respawn state machine, Ralph Loop, hooks (Phases 6-7) | Respawn complexity massively underestimated, phase ordering wrong, CompletionDetector needed |
| **api-reviewer** | API routes, frontend, task breakdown, security (Phases 5, 8) | Env var allowlist blocks OpenCode, API key exposure, Phase 8 shared-state problem |

### Critical Issues (5)

| ID | Issue | Resolution |
|----|-------|------------|
| C1 | Bubble Tea alternate screen buffer redraws break output-silence idle detection | Added mandatory ANSI content filter (`ansi-content-filter.ts`) in Phase 4 |
| C2 | Respawn controller is ~3,500 lines with 13 states (`watching`, `confirming_idle`, `ai_checking`, `sending_update`, `waiting_update`, `sending_clear`, `waiting_clear`, `sending_init`, `waiting_init`, `monitoring_init`, `sending_kickstart`, `waiting_kickstart`, `stopped`) — can't just add `if (mode === 'opencode')` | Added `CompletionDetector` interface pattern in Phase 7 |
| C3 | Phase 6 (Respawn) depends on Phase 7 (Plugin Bridge) for reliable idle detection | Swapped phases: Plugin Bridge is now Phase 6, Respawn is Phase 7 |
| C4 | `schemas.ts` env var allowlist blocks `OPENCODE_*` vars | Added `OPENCODE_` to `ALLOWED_ENV_PREFIXES`, `OPENCODE_SERVER_PASSWORD` to `BLOCKED_ENV_KEYS` |
| C5 | `SessionMode` defined separately in `session.ts` and `types.ts` — will drift | Unified: move to `types.ts`, import in `session.ts` |

### Major Issues (8)

| ID | Issue | Resolution |
|----|-------|------------|
| M1 | No `session.isWorking` strategy for OpenCode | Added ANSI content filter-driven `isWorking` logic in Phase 4 |
| M2 | Working pattern detection is Claude-specific | Deferred to Phase 0 empirical data + OpenCodeCompletionDetector |
| M3 | Plugin event names are speculative / unverified | Added hard prerequisite: Phase 0 must verify events via test plugin |
| M4 | `writeViaMux()` `\r` handling untested with Bubble Tea | Added to Phase 0 validation checklist |
| M5 | `waitForOpenCodeReady()` 500ms threshold too short | Increased to 2000ms, added content-change-only tracking |
| M6 | `createSession()`/`respawnPane()` have 8 positional params | Refactored to options objects (`CreateSessionOptions`, `RespawnPaneOptions`) |
| M7 | API keys exposed in `ps` output via inline `export` | Use `tmux setenv` for sensitive vars instead |
| M8 | Phase 8 TUI + serve dual-process has shared SQLite problem | Documented alternatives (serve-only, attach pattern), port pool allocation |

### Key Design Decisions Made During Review

1. **Simple extension (Option A) confirmed** — correct YAGNI call over full DI abstraction
2. **`CompletionDetector` interface** — clean abstraction boundary between respawn controller and backend-specific detection
3. **ANSI content filter** — mandatory new component, not a nice-to-have
4. **Respawn disabled by default** for OpenCode — opt-in only after plugin bridge proven
5. **Ralph Loop marked experimental** for OpenCode — without `<promise>` tags, it's a degraded experience
6. **`tmux setenv`** for API keys — security improvement over inline exports
7. **Phase 0 expanded** — additional validation items make it 1-2 hours instead of 30 minutes
8. **plan.json needs reconciliation** — contradicts this document's approach (DI vs simple extension)

---

## 22. Re-Review Findings

> **Re-reviewed**: 2026-02-26 by a 4-agent team (types-reviewer, parsing-reviewer, respawn-reviewer, api-reviewer). Each agent cross-referenced specific plan sections against the actual codebase.

### Re-Review Team

| Agent | Focus Area | Key Findings |
|-------|-----------|--------------|
| **types-reviewer** | Types, CLI resolver, tmux spawn (Phases 1-3) | SessionMode duplicate claim imprecise, setOpenCodeEnvVars injection risk, mux-interface has 3 inline unions |
| **parsing-reviewer** | Output parsing, idle detection (Phase 4) | 6 bugs in code snippets: wrong property names, invalid status value, missing property init, misdescribed Claude detection |
| **respawn-reviewer** | Respawn, Ralph Loop, hooks (Phases 6-7) | 13 states not 11, Ralph Loop "agnostic" overstated, CompletionDetector feasible but scope underestimated |
| **api-reviewer** | API routes, frontend, schemas, security (Phases 5, 8) | configContent shell injection, missing writeHooksConfig guard, wrong CleanupManager API, missing generateSessionToken |

### Critical Issues (4)

| ID | Issue | Resolution |
|----|-------|------------|
| RC1 | `_lastOutputTime` property does not exist — actual is `_lastActivityAt`. All Phase 4 snippets used wrong name. | Find-and-replace applied throughout |
| RC2 | `_status = 'working'` is invalid — `SessionStatus` is `'idle' \| 'busy' \| 'stopped' \| 'error'`. Must be `'busy'`. | Fixed in code snippets |
| RC3 | `configContent` shell injection — user-supplied JSON embedded in `bash -c` string allows `;`, `&&`, `$()` execution | Replaced with `tmux setenv` approach + JSON validation. Added `setOpenCodeConfigContent()` helper |
| RC4 | `OPENCODE_SERVER_PASSWORD` must be blocked simultaneously with adding `OPENCODE_` to `ALLOWED_ENV_PREFIXES` | Added atomic-change note to schemas section |

### High Issues (7)

| ID | Issue | Resolution |
|----|-------|------------|
| RH1 | 13 respawn states, not 11 — plan undercounted by 2 (`monitoring_init`, `sending_kickstart`) | Fixed all references to 13 |
| RH2 | Missing `_idleConfig` property — referenced but never initialized | Added constructor initialization code |
| RH3 | `_processExpensiveParsers()` not addressed — Ralph/bash/token parsers fire for all modes | Added mode-gating section to Phase 4 |
| RH4 | `this.cleanup.addCustom()` doesn't exist — real API is `registerCleanup(type, fn, description)` | Fixed in Phase 8 code |
| RH5 | `generateSessionToken()` doesn't exist anywhere in codebase | Replaced with `crypto.randomUUID()` |
| RH6 | `setOpenCodeEnvVars()` — API keys with `"` or `$` break the tmux setenv command | Added single-quote escaping with inner quote escape |
| RH7 | `writeHooksConfig()` called unconditionally in quick-start — generates Claude hooks for OpenCode sessions | Added `mode !== 'opencode'` guard |

### Medium Issues (6)

| ID | Issue | Resolution |
|----|-------|------------|
| RM1 | "Duplicate SessionMode" (C5) imprecise — types.ts has inline union, not named export. mux-interface.ts has 3 locations, not 2. | Corrected description in C5 note |
| RM2 | Claude idle detection misdescribed — uses prompt char + debounce + spinner, NOT silence threshold. No `completionPattern` in session.ts. | Added correction comment to `getIdleDetectionConfig()` |
| RM3 | Ralph Loop "CLI-agnostic" overstated — polling is agnostic but completion signaling depends on Claude-specific `<promise>` tags | Reworded in Phase 7 |
| RM4 | Lifecycle logs hardcode `mode: 'claude'` at 2 locations in server.ts | Added note + fix in Phase 5 quick-start section |
| RM5 | Respawn section line number wrong (10254 → ~10289) | Fixed |
| RM6 | `completionPattern: /Worked for \d+[ms]/` shown in session.ts config but actually lives in respawn-controller.ts | Fixed — set to `null` in session config with comment |

### Confirmed Correct (from original review)

All items confirmed correct by the original review remain valid. Additionally confirmed:
- `createSession()` has 8 positional params, `respawnPane()` has 7 (no `name` param)
- `mux-factory.ts` needs no changes
- CLI resolver correctly mirrors `claude-cli-resolver.ts`
- `assertNever()` at 2 locations in respawn-controller (lines ~1461, ~1563)
- Plugin bridge approach is sound; Phase 0 plugin verification is essential prerequisite
- Phase ordering (plugin bridge before respawn) confirmed critical
- Circuit breaker signals are fully Claude-specific (RALPH_STATUS blocks)
- All schema additions (mode enum, OpenCodeConfigSchema, env prefix) necessary

---

## Appendix A: OpenCode CLI Reference

```
Usage: opencode [options] [path]

Commands:
  (default)          Start interactive TUI
  run <prompt>       Execute prompt non-interactively
  serve              Start headless API server
  web                Start server with web UI
  attach <url>       Connect TUI to remote server
  session list       List all sessions
  export [id]        Export session as JSON
  import <file>      Import session from file/URL
  models [provider]  List available models
  agent create       Create custom agent
  agent list         List agents

Global Flags:
  -m, --model <model>      Model (provider/model format)
  -c, --continue           Continue last session
  -s, --session <id>       Resume specific session
  --fork                   Branch when continuing
  --cwd <dir>              Working directory
  -d, --debug              Enable debug logging
  --log-level <level>      Set log level
  --print-logs             Print logs to stdout
  -v, --version            Show version
  -h, --help               Show help

Run Flags:
  --format <fmt>    Output format (default, json)
  --file <path>     Attach file(s) to prompt
  --title <name>    Custom session title
  --attach <url>    Use remote server
  --port <port>     Local server port
  --command <cmd>   Custom executable
  --share           Enable session sharing

Serve Flags:
  --port <port>        Listen port (default: auto)
  --hostname <host>    Bind hostname
  --mdns               Enable mDNS discovery
  --cors <origins>     CORS origins

Environment Variables:
  ANTHROPIC_API_KEY          Anthropic API key
  OPENAI_API_KEY             OpenAI API key
  GOOGLE_API_KEY             Google AI API key
  OPENCODE_MODEL             Default model
  OPENCODE_CONFIG            Custom config file path
  OPENCODE_CONFIG_DIR        Custom config directory
  OPENCODE_CONFIG_CONTENT    Inline JSON config
  OPENCODE_PERMISSION        Inline JSON permission config
  OPENCODE_SERVER_PASSWORD   Server auth password
  OPENCODE_CLIENT            Client identifier (default: "cli")
```

---

## Appendix B: OpenCode Plugin Events

Full list of subscribable events in OpenCode's plugin system:

| Category | Event | Description | Claudeman Relevance |
|----------|-------|-------------|---------------------|
| **Command** | `command.executed` | Slash command run | Low |
| **Files** | `file.edited` | File modified | Medium (track changes) |
| | `file.watcher.updated` | File watcher trigger | Low |
| **Installation** | `installation.updated` | Config/deps changed | Low |
| **LSP** | `lsp.client.diagnostics` | Lint/type errors | Medium (show in UI) |
| | `lsp.updated` | LSP state change | Low |
| **Messages** | `message.part.updated` | Streaming token | High (progress tracking) |
| | `message.updated` | Complete message | High (completion detection) |
| | `message.removed` | Message deleted | Low |
| | `message.part.removed` | Part deleted | Low |
| **Permissions** | `permission.asked` | Tool approval needed | **Critical** (show in Claudeman) |
| | `permission.replied` | User responded | High (track approvals) |
| **Server** | `server.connected` | Server started | Medium |
| **Sessions** | `session.idle` | Agent finished working | **Critical** (idle detection!) |
| | `session.status` | Status change | High (working/idle state) |
| | `session.created` | New session | Medium |
| | `session.updated` | Session modified | Medium |
| | `session.deleted` | Session removed | Medium |
| | `session.compacted` | Context compacted | Medium (track compactions) |
| | `session.diff` | Code changes | Medium |
| | `session.error` | Error occurred | **Critical** (error surfacing) |
| **Todo** | `todo.updated` | Todo list changed | High (Ralph integration) |
| **Shell** | `shell.env` | Env var injection | Low |
| **Tools** | `tool.execute.before` | Tool about to run | High (tool tracking) |
| | `tool.execute.after` | Tool completed | High (tool tracking) |
| **TUI** | `tui.prompt.append` | Text added to prompt | Low |
| | `tui.command.execute` | TUI command run | Low |
| | `tui.toast.show` | Notification shown | Low |
| **Experimental** | `experimental.session.compacting` | Custom compaction | Low |

---

## Appendix C: OpenCode Permission Config

### Auto-Allow Everything (Equivalent to `--dangerously-skip-permissions`)

```json
{
  "permission": {
    "*": "allow"
  }
}
```

### Granular Permissions

```json
{
  "permission": {
    "*": "ask",
    "bash": {
      "*": "ask",
      "git *": "allow",
      "npm *": "allow",
      "rm *": "deny",
      "sudo *": "deny"
    },
    "edit": "allow",
    "write": "allow",
    "read": "allow"
  }
}
```

### Permission Levels

- `"allow"` — Execute without approval
- `"ask"` — Prompt user for approval
- `"deny"` — Block the action

### Delivery Method for Claudeman

Use `OPENCODE_CONFIG_CONTENT` environment variable to inject permissions without modifying project files:

```bash
export OPENCODE_CONFIG_CONTENT='{"permission":{"*":"allow"}}'
opencode --model anthropic/claude-sonnet-4-5
```

---

## Appendix D: Current Claudeman Session Spawn Flow (Annotated)

### Exact Code Path (for reference during implementation)

```
1. POST /api/sessions (server.ts:810)
   → Validate body with Zod
   → new Session({mode, workingDir, mux: TmuxManager, ...})
   → sessions.set(id, session)
   → setupSessionListeners(session)
   → broadcast('session:created')

2. POST /api/sessions/:id/interactive (server.ts:1635)
   → session.startInteractive()

3. session.startInteractive() (session.ts:892)
   → Check for existing muxSession
   → If none: this._mux.createSession(id, workingDir, 'claude', ...)

4. TmuxManager.createSession() (tmux-manager.ts:225)
   → tmux new-session -ds "claudeman-<shortId>" -c <workingDir> -x 120 -y 40
   → tmux set-option -t "claudeman-<shortId>" remain-on-exit on
   → Build command: "export PATH=... && export LANG=... && claude --dangerously-skip-permissions --session-id <id>"
   → tmux respawn-pane -k -t "claudeman-<shortId>" '<command>'
   → Wait 100ms, configure tmux, get PID
   → Return MuxSession { muxName, pid, mode }

5. Back in startInteractive() (session.ts:~950)
   → pty.spawn('tmux', ['attach-session', '-t', 'claudeman-<shortId>'], {
       name: 'xterm-256color',
       cols: 120, rows: 40,
       env: { LANG, LC_ALL, TERM }
     })
   → ptyProcess.onData(rawData => {
       // Filter focus escape sequences
       // Append to terminal buffer
       // Emit 'terminal' event → SSE broadcast → xterm.js
       // Throttled: ANSI strip, Ralph tracker, bash parser, token parsing
     })
   → ptyProcess.onExit(...)
   → Wait for prompt (poll for ❯ character)

6. SSE Pipeline (server.ts)
   → setupSessionListeners.terminal handler
   → batchTerminalData(sessionId, data)
   → flushSessionTerminalBatch() (16-50ms timer)
   → DEC 2026 sync wrapping
   → broadcast('session:terminal', { id, data })
   → sendSSEPreformatted() to all clients

7. Frontend (app.js)
   → EventSource at /api/events
   → addListener('session:terminal', ...)
   → batchTerminalWrite() → requestAnimationFrame → terminal.write()
```

### What Changes for OpenCode

Only steps 3-5 change:
- **Step 3**: `session.startInteractive()` calls `createSession(..., 'opencode', ...)` instead of `'claude'`
- **Step 4**: `TmuxManager.createSession()` builds `opencode --model ...` instead of `claude --dangerously-skip-permissions ...`
- **Step 5**: `waitForOpenCodeReady()` instead of polling for `❯` prompt

Everything else (steps 1, 2, 6, 7) is **completely unchanged**.
