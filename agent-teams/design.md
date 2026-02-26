# Codeman Agent Teams Integration — Design (Approach C: Hybrid)

> Updated 2026-02-12 with experiment findings. See `experiment-log.md` for raw data.

## Overview

Approach C combines filesystem monitoring (for team/task discovery and inbox watching) with the existing subagent-watcher (for live transcript tailing) and adjusted idle detection (to account for active teammates). The key finding from our experiment is that **teammates already appear as standard subagents**, so most infrastructure exists — we mainly need team awareness and idle detection fixes.

## Components

### 1. TeamWatcher (`src/team-watcher.ts`)

Monitors `~/.claude/teams/` for team creation/removal and tracks active teams.

**Discovery mechanism:**
- Poll `~/.claude/teams/` for directories (team names) every 3-5 seconds
- When found: parse `config.json` to get:
  - `leadSessionId` → map to Codeman session
  - `members` array → teammate names, agentIds, colors, models
- Watch for directory deletion (cleanup signal)

**CORRECTED from pre-experiment design:**
- ~~Each teammate has a separate Claude Code process~~ → Teammates are **in-process threads**, not separate processes
- ~~Find via `ps aux` + `/proc` PID matching~~ → Not needed, no separate PIDs
- Teammate transcripts are at `subagents/agent-{id}.jsonl` (standard subagent path), NOT separate session transcripts

**Association:**
- `config.json.leadSessionId` → Codeman session ID (direct match!)
- Each member's `agentId` (e.g., `fs-researcher@research-watchers`) → links to subagent files
- `agentType: "team-lead"` vs `"general-purpose"` distinguishes lead from teammates

**Inbox monitoring:**
- Watch `~/.claude/teams/{name}/inboxes/` for new messages
- Each teammate has a JSON file with message array
- Messages are double-encoded JSON with `from`, `text`, `timestamp`, `read` fields
- Message types: `task_assignment`, `shutdown_request`, `shutdown_response`

### 2. Team-Aware Idle Detection (HIGHEST PRIORITY)

**Problem (confirmed by experiment):** Lead session shows status "idle" in Codeman while teammates are actively working. Token count continues climbing but Codeman thinks the session is inactive.

**Solution:**
- Before declaring a session idle, check if it's a team lead
- If team lead: check `~/.claude/teams/*/config.json` for this session's `leadSessionId`
- If active team exists: check task files in `~/.claude/tasks/{team-name}/`
  - Any task with `status: "in_progress"` → suppress idle detection
  - All tasks `completed` AND no non-`_internal` tasks pending → allow idle
- Fallback: check subagent-watcher for active subagents on this session

**Integration points:**
- `src/ai-idle-checker.ts` — add team-awareness check before AI idle analysis
- `src/respawn-controller.ts` — consult TeamWatcher before transitioning to idle states
- `src/session.ts` — expose `hasActiveTeam()` method

**Liveness check (simplified from pre-experiment):**
- ~~Check `/proc/{pid}` existence~~ → Not needed (no separate processes)
- Check task file status instead (filesystem-based)
- Check subagent-watcher for active subagents under this session

### 3. Shared Task List UI

**Display:** New panel in web UI showing the team's shared task list.

**Data source:** Poll `~/.claude/tasks/{team-name}/` for task JSON files.

**Task file structure (verified):**
```json
{
    "id": "1",
    "subject": "Research Node.js fs.watch",
    "description": "Full description...",
    "activeForm": "Researching Node.js fs.watch",
    "status": "in_progress",     // pending | in_progress | completed
    "blocks": [],
    "blockedBy": [],
    "owner": "fs-researcher"     // Empty string = unassigned
}
```

Internal tracking tasks: `{ "metadata": { "_internal": true } }` — filter these from display.

**UI elements:**
- Task subject, status badge (color-coded), owner (teammate name with color)
- Dependency visualization (blockedBy indicators)
- Progress bar (completed / total non-internal tasks)
- Real-time updates via SSE

**API endpoint:** `GET /api/sessions/:id/team-tasks` → returns parsed task files

**Locking:** Respect `.lock.lock` directory lock when reading (skip if locked, retry next poll).

### 4. Teammate Display

**Decision: Option A — Enhanced subagent floating windows.**

Since teammates already appear as subagents in the existing infrastructure, we enhance rather than replace:

- **Badge:** Add "Teammate" badge to subagent windows for agents matching team config
- **Color:** Use teammate's `color` field from config.json (blue, green, yellow)
- **Name:** Show teammate name instead of agent ID
- **Persistence:** Teammate windows should stay open longer (they're longer-lived than regular subagents)
- **Status:** Show task assignment and progress from task files

**Detection logic:**
```
For each subagent detected by subagent-watcher:
  1. Check if description starts with "<teammate-message"
  2. OR cross-reference agentId with active team config members
  3. If match → apply teammate badge, color, name
```

### 5. Inbox/Message Display

**CORRECTED: Inboxes ARE filesystem-based.**

Communication uses filesystem inbox files at `~/.claude/teams/{name}/inboxes/{teammate}.json`. We can:

1. **Watch inbox files** for real-time message monitoring
2. **Parse message types** for display:
   - `task_assignment` → "Lead assigned Task #1 to fs-researcher"
   - `shutdown_request` → "Lead requested shutdown"
   - `shutdown_response` → "Teammate confirmed shutdown"
3. **Display as timeline** in team panel

**Potential for interaction (not tested, future work):**
- Write to teammate inbox files to inject messages
- Must respect `.json.lock` directory locking protocol
- Could enable "nudge" or "redirect" functionality from Codeman UI

## Answered Questions (from experiment)

| # | Question | Answer |
|---|----------|--------|
| 1 | Teammates in subagents dir? | **YES** — standard `subagents/agent-{id}.jsonl` path |
| 2 | subagent-watcher detects them? | **YES** — automatically, no changes needed |
| 3 | Task file structure? | Numbered JSON files with subject, status, owner, dependencies |
| 4 | Env var inheritance? | **YES** — in-process threads share parent's env |
| 5 | Processes per teammate? | **ZERO** — threads, not processes |
| 6 | config.json format? | Rich: name, agentId, agentType, model, prompt, color, backendType |
| 7 | Interact via stdin? | N/A (threads) — can interact via inbox files instead |
| 8 | In-process under Screen? | Works fine — single claude process, threads handle teammates |
| 9 | Hook events from teammates? | TeammateIdle + TaskCompleted hooks available in settings schema |
| 10 | Process tree? | Single process with threads — no child processes |

## Existing Infrastructure to Leverage

| Component | Reuse for | Status |
|-----------|-----------|--------|
| `subagent-watcher.ts` | Teammate transcript tailing | **Already works** |
| Subagent floating windows (`app.js`) | Teammate activity display | **Already works** (needs badges) |
| `task-tracker.ts` | Background task tracking patterns | Reuse patterns |
| LRUMap, StaleExpirationMap | Bounded caches for team state | Available |
| SSE broadcast | Real-time UI updates | Available |
| ~~`/proc` PID checking~~ | ~~Teammate liveness~~ | **Not needed** (threads) |
| `file-stream-manager.ts` | Watch inbox/task files | Available |

## Implementation Order (Revised)

1. **Team-aware idle detection** — prevent premature respawn/auto-compact (CRITICAL)
2. **TeamWatcher** — poll `~/.claude/teams/`, parse config.json, track active teams
3. **Teammate badge in subagent windows** — mark teammate subagents with name/color
4. **Team tasks API + UI** — `GET /api/sessions/:id/team-tasks` + task list panel
5. **Inbox monitoring** — watch inbox files, display message timeline
6. **TeammateIdle/TaskCompleted hooks** — add to Codeman's hooks config generator

## What We DON'T Need to Build

- ~~Process discovery for teammates~~ (they're threads)
- ~~Custom transcript tailing~~ (subagent-watcher handles it)
- ~~Separate teammate window infrastructure~~ (subagent windows work)
- ~~Message interception via transcript parsing~~ (inbox files are simpler)
