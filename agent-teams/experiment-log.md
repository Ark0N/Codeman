# Agent Teams Experiment Log

> Experiment date: 2026-02-12
> Test case: `~/codeman-cases/agent-teams-test/`
> Team name: `research-watchers`
> Teammates: 3 (fs-researcher, perf-researcher, api-researcher)
> Lead session: `461daa80-94ec-4e5e-a1bb-0518f78311bc`
> Duration: ~3 minutes (06:45:01 → 06:48:07)

## Pre-Experiment State

```
~/.claude/teams/     — did NOT exist
~/.claude/tasks/     — 75 UUID-named directories (from regular Task tool subagents)
Claude processes     — 7 (including watchers)
settings.local.json  — edited to add CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1
```

## Experiment Prompt

```
Create an agent team with 3 teammates to research the following topics in parallel:
Teammate 1 fs-researcher researches how Node.js fs.watch works on Linux vs macOS.
Teammate 2 perf-researcher researches inotify performance limits and alternatives.
Teammate 3 api-researcher researches the inotifywait command-line API.
Have each teammate write a brief summary of their findings in a separate file.
Name the team research-watchers.
```

---

## Question 1: What exact filesystem artifacts do agent teams create?

**Expected:** `~/.claude/teams/research-watchers/config.json` and `~/.claude/tasks/research-watchers/`

**Actual: CONFIRMED + SURPRISE inboxes/ directory**

```
~/.claude/teams/research-watchers/
├── config.json                          # Team config (members, lead, metadata)
└── inboxes/                             # Filesystem-based messaging!
    ├── api-researcher.json              # Per-teammate inbox
    ├── fs-researcher.json
    ├── perf-researcher.json
    └── team-lead.json                   # Lead also has an inbox

~/.claude/tasks/research-watchers/
├── .lock                                # Empty file (presence = lock indicator?)
├── 1.json                               # Task: Research Node.js fs.watch
├── 2.json                               # Task: Research inotify performance
├── 3.json                               # Task: Research inotifywait CLI
├── 4.json                               # Internal: fs-researcher spawn tracking
├── 5.json                               # Internal: perf-researcher spawn tracking
└── 6.json                               # Internal: api-researcher spawn tracking
```

Subagent transcripts also appear in the standard subagent directory:
```
~/.claude/projects/-home-arkon-codeman-cases-agent-teams-test/
└── 461daa80.../
    ├── 461daa80...jsonl                 # Lead session transcript
    └── subagents/
        ├── agent-ae50544.jsonl          # Teammate: fs-researcher
        ├── agent-aa20c65.jsonl          # Teammate: perf-researcher
        ├── agent-a29de32.jsonl          # Teammate: api-researcher
        ├── agent-a04968e.jsonl          # Sub-subagent (teammate's Task tool)
        ├── agent-a0d372e.jsonl          # Sub-subagent
        ├── agent-a2ff939.jsonl          # Sub-subagent
        ├── agent-a89ad82.jsonl          # Sub-subagent
        ├── agent-aa1efc7.jsonl          # Sub-subagent
        └── agent-ab0ef07.jsonl          # Sub-subagent
```

**Cleanup:** At 06:48:02, the lead deleted ALL artifacts — inboxes, config, tasks, the team directory itself. Clean removal.

---

## Question 2: Is the mailbox/communication filesystem-based or tool-based?

**Expected:** Tool-based (SendMessage tool), NOT filesystem

**Actual: BOTH! Hybrid — tool triggers filesystem writes.**

Communication uses the `SendMessage` tool internally, but the actual message delivery is via **filesystem inbox files**. Each teammate has `~/.claude/teams/{name}/inboxes/{teammate}.json` containing a JSON array of messages.

**Inbox message format:**
```json
[
  {
    "from": "team-lead",
    "text": "{\"type\":\"task_assignment\",\"taskId\":\"1\",\"subject\":\"Research Node.js fs.watch...\",\"assignedBy\":\"team-lead\",\"timestamp\":\"...\"}",
    "timestamp": "2026-02-12T05:45:18.176Z",
    "read": false
  }
]
```

Key observations:
- `text` field is a **JSON string** (double-encoded) containing a typed message object
- Message types observed: `task_assignment`, `shutdown_request`, `shutdown_response`
- `read` field tracks whether teammate has processed the message (false → true)
- **File locking** via `.json.lock` directories (mkdir-based atomic lock, created then deleted)
- Lead also has an inbox (`team-lead.json`) for receiving messages FROM teammates

**Implication for Codeman:** We CAN intercept messages by watching inbox JSON files! We can also potentially inject messages by writing to inbox files.

---

## Question 3: Do teammates appear in the subagents directory?

**Expected:** Unclear

**Actual: YES! Teammates appear as standard subagents.**

Teammates create transcript files at:
```
~/.claude/projects/{hash}/{leadSessionId}/subagents/agent-{agentId}.jsonl
```

This is the **exact same path pattern** that regular Task tool subagents use. The existing `subagent-watcher.ts` successfully discovers them.

Codeman's `/api/subagents` endpoint returned them with status "active":
```
Agent: ae50544  Status: active  Tools: 8   Model: claude-opus-4-6
  Desc: <teammate-message teammate_id= team
Agent: aa20c65  Status: active  Tools: 9   Model: claude-opus-4-6
  Desc: <teammate-message teammate_id= team
Agent: a29de32  Status: active  Tools: 7   Model: claude-opus-4-6
  Desc: <teammate-message teammate_id= team
```

**Distinguishing teammates from regular subagents:**
- Description starts with `<teammate-message teammate_id= team` (a unique marker)
- We can also cross-reference with `~/.claude/teams/{name}/config.json` members list

**Sub-subagents:** Teammates can spawn their own Task tool subagents. 3 teammates spawned 6 additional subagent files (9 total in the subagents directory).

---

## Question 4: What does config.json actually look like?

**Actual config.json (with all 3 teammates):**

```json
{
    "name": "research-watchers",
    "description": "Research team investigating file watching mechanisms...",
    "createdAt": 1770875105373,
    "leadAgentId": "team-lead@research-watchers",
    "leadSessionId": "461daa80-94ec-4e5e-a1bb-0518f78311bc",
    "members": [
        {
            "agentId": "team-lead@research-watchers",
            "name": "team-lead",
            "agentType": "team-lead",
            "model": "claude-opus-4-6",
            "joinedAt": 1770875105373,
            "tmuxPaneId": "",
            "cwd": "/home/arkon/codeman-cases/agent-teams-test",
            "subscriptions": []
        },
        {
            "agentId": "fs-researcher@research-watchers",
            "name": "fs-researcher",
            "agentType": "general-purpose",
            "model": "claude-opus-4-6",
            "prompt": "You are \"fs-researcher\" on the \"research-watchers\" team...",
            "color": "blue",
            "planModeRequired": false,
            "joinedAt": 1770875126680,
            "tmuxPaneId": "in-process",
            "cwd": "/home/arkon/codeman-cases/agent-teams-test",
            "subscriptions": [],
            "backendType": "in-process"
        },
        {
            "agentId": "perf-researcher@research-watchers",
            "name": "perf-researcher",
            "agentType": "general-purpose",
            "model": "claude-opus-4-6",
            "prompt": "...",
            "color": "green",
            "planModeRequired": false,
            "joinedAt": 1770875130344,
            "tmuxPaneId": "in-process",
            "cwd": "/home/arkon/codeman-cases/agent-teams-test",
            "subscriptions": [],
            "backendType": "in-process"
        },
        {
            "agentId": "api-researcher@research-watchers",
            "name": "api-researcher",
            "agentType": "general-purpose",
            "model": "claude-opus-4-6",
            "prompt": "...",
            "color": "yellow",
            "planModeRequired": false,
            "joinedAt": 1770875134997,
            "tmuxPaneId": "in-process",
            "cwd": "/home/arkon/codeman-cases/agent-teams-test",
            "subscriptions": [],
            "backendType": "in-process"
        }
    ]
}
```

**Key fields per member:**
- `agentId`: `{name}@{teamName}` format
- `agentType`: `"team-lead"` for lead, `"general-purpose"` for teammates
- `model`: Model used (inherits from lead)
- `prompt`: Full spawn prompt (only for teammates)
- `color`: UI color assignment (blue, green, yellow)
- `backendType`: `"in-process"` for in-process mode
- `tmuxPaneId`: `"in-process"` or actual pane ID for tmux mode
- `subscriptions`: Empty array (possibly for message routing)

**Config grows incrementally** — starts with just lead member (620 bytes), grows as teammates are added (→ 1886 → 3188 → 4551 bytes).

---

## Question 5: How do shared tasks differ from regular tasks?

**Expected:** Team name directory vs UUID, richer task format

**Actual: CONFIRMED**

**Team tasks (`~/.claude/tasks/research-watchers/`):**
```json
{
    "id": "1",
    "subject": "Research Node.js fs.watch on Linux vs macOS",
    "description": "Research how Node.js fs.watch works differently...",
    "activeForm": "Researching Node.js fs.watch Linux vs macOS",
    "status": "in_progress",
    "blocks": [],
    "blockedBy": [],
    "owner": "fs-researcher"
}
```

**Internal teammate tracking tasks (4.json, 5.json, 6.json):**
```json
{
    "id": "4",
    "subject": "fs-researcher",
    "description": "You are \"fs-researcher\" on the \"research-watchers\" team...",
    "status": "in_progress",
    "blocks": [],
    "blockedBy": [],
    "metadata": { "_internal": true }
}
```

**Key differences from regular subagent tasks (`~/.claude/tasks/{UUID}/`):**
| Feature | Regular tasks | Team tasks |
|---------|--------------|------------|
| Directory name | UUID | Human-readable team name |
| File names | `.lock`, `.highwatermark` only | Numbered JSON files (1.json, 2.json...) |
| Content | Lock files only (no task JSON) | Full task JSON with metadata |
| Owner field | N/A | Teammate name |
| Locking | `.lock` file | `.lock.lock` directory (mkdir atomic) |
| Internal tasks | None | `_internal: true` for teammate spawn tracking |

---

## Question 6: Can we write to task/mailbox files to interact with teammates?

**Expected:** Possibly for tasks, no for messages

**Actual: LIKELY YES for both**

Evidence supporting external writes:
1. **Inbox files** are plain JSON arrays — we could append messages
2. **Task files** are plain JSON — we could modify status, add new tasks
3. **File locking** uses `.json.lock` directories — we'd need to respect the locking protocol
4. **Lock protocol**: Create directory `{file}.lock` → write → delete directory. Simple mkdir-based atomic lock.

**Not tested in this experiment** — would need a follow-up test to verify teammates actually pick up externally-added messages/tasks. But the format is clear and the locking is simple.

---

## Question 7: What happens to Codeman's idle detection with active teammates?

**Expected:** Lead may appear idle while teammates work

**Actual: Lead stays "idle" in Codeman's view, but terminal shows active status**

Observations:
- Codeman session status showed `"idle"` throughout the experiment
- The terminal output continued updating (task list checkboxes, teammate progress messages)
- Lead displayed "Befuddling..." spinner while waiting for teammates
- Token count climbed from 27k → 33k during the experiment
- The `stop` hook DID fire at the end when the team was cleaned up

**Implication:** Current idle detection may trigger prematurely if:
- It only checks Codeman's session status (which stays "idle")
- It doesn't account for active teammates

**What we need:** Check `~/.claude/teams/*/config.json` for active members before declaring idle.

---

## Question 8: How many Claude processes spawn per teammate?

**Expected:** 1 claude process per teammate

**Actual: ZERO separate processes! Teammates are in-process threads.**

```
# Only 2 claude processes (both Codeman sessions, none for teammates):
25405 claude --dangerously-skip-permissions --session-id 236f004f...  (our main session)
383633 claude --dangerously-skip-permissions --session-id 461daa80... (test session + 3 teammates)

# Process tree for test session:
claude(383633)─┬─{claude}(383635)
               ├─{claude}(383636)
               ├─... (22 threads total)
               └─{claude}(399252)
```

**In-process mode = threads, not processes.** All 3 teammates run as threads within the single `claude` process (PID 383633). This explains:
- No separate PIDs to track
- No `/proc/{pid}/environ` for individual teammates
- Lower resource overhead
- Shared env vars automatically

---

## Question 9: Do teammates inherit Codeman env vars (hook events)?

**Expected:** Yes, if child processes

**Actual: YES, trivially — they're in-process threads**

Since teammates are threads in the lead's process (PID 383633), they share the exact same environment:
```
CODEMAN_SCREEN=1
CODEMAN_SESSION_ID=461daa80-94ec-4e5e-a1bb-0518f78311bc
CODEMAN_SCREEN_NAME=codeman-461daa80
CODEMAN_API_URL=http://localhost:3000
```

The `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` env var was set via `settings.local.json`'s `env` key, which Claude Code reads at startup and sets on its process.

**Hook events:** The lead session's hooks (Notification, Stop) apply to the whole process. Teammate-specific hooks (`TeammateIdle`, `TaskCompleted`) are defined in the same `settings.local.json` and would fire for the lead's session.

---

## Question 10: Does subagent-watcher pick up teammates automatically?

**Expected:** Probably not

**Actual: YES! subagent-watcher detects teammates automatically.**

Teammates create transcript files in the standard subagent path:
```
~/.claude/projects/{hash}/{leadSessionId}/subagents/agent-{id}.jsonl
```

Codeman's `/api/subagents` endpoint returned all 3 teammates as active subagents. They're indistinguishable from regular Task tool subagents except:
1. Their `description` field starts with `<teammate-message teammate_id= team`
2. They can be cross-referenced with `~/.claude/teams/{name}/config.json`
3. They tend to be longer-lived than regular subagents

**Sub-subagents:** Teammates also spawn their own Task tool subagents (6 additional agents detected), creating a 3-level hierarchy: Lead → Teammates → Sub-subagents.

---

## Filesystem Event Timeline

```
06:45:01  Session transcript created
06:45:05  ~/.claude/teams/ created
06:45:05  ~/.claude/teams/research-watchers/ created
06:45:05  config.json created (lead member only, 620 bytes)
06:45:05  ~/.claude/tasks/research-watchers/ created with .lock
06:45:11  Task 1.json created (via .lock.lock directory lock)
06:45:13  Task 2.json created
06:45:15  Task 3.json created
06:45:18  inboxes/ directory created
06:45:18  fs-researcher.json inbox created (task_assignment message)
06:45:18  perf-researcher.json inbox created
06:45:19  api-researcher.json inbox created
06:45:26  config.json updated (fs-researcher added, 1886 bytes)
06:45:26  Subagent agent-ae50544.jsonl created (fs-researcher)
06:45:26  Task 4.json created (internal: fs-researcher tracking)
06:45:30  config.json updated (perf-researcher added, 3188 bytes)
06:45:30  Subagent agent-aa20c65.jsonl created (perf-researcher)
06:45:30  Task 5.json created (internal: perf-researcher tracking)
06:45:34  config.json updated (api-researcher added, 4551 bytes)
06:45:34  Task 6.json created (internal: api-researcher tracking)
06:45:35  Subagent agent-a29de32.jsonl created (api-researcher)
06:45:35+ Teammates working, additional subagent transcripts appearing
06:47:xx  Tasks completed, shutdown_requests sent to teammate inboxes
06:47:56  team-lead.json inbox created (teammates reporting back)
06:47:57  config.json updated multiple times (member removal?)
06:48:02  CLEANUP: all inbox files deleted
06:48:02  CLEANUP: inboxes/ directory deleted
06:48:02  CLEANUP: config.json deleted
06:48:02  CLEANUP: research-watchers team directory deleted
06:48:02  CLEANUP: all task files deleted (1-6.json + .lock)
06:48:02  CLEANUP: research-watchers task directory deleted
```

---

## Web UI Observations

**Terminal output:**
- Task list appears with checkboxes: `☐ Research Node.js fs.watch on Linux vs macOS`
- Checkboxes fill in as tasks complete: `☑ Research Node.js fs.watch...`
- Each task shows assigned teammate: `(@fs-researcher)`
- Spinner shows active teammate with progress

**Status bar:**
- Shows team member selector: `@main @api-researcher @fs-researcher @perf-researcher`
- Hint: `shift+↑ to expand` and `ctrl+t to show teammates`
- Standard bypass permissions and token count still visible

**Subagent floating windows:**
- Teammates DID appear as subagent floating windows in Codeman's web UI
- They show the standard subagent info (model, tool calls, description)
- Sub-subagents (teammates' own Task tool usage) also appear

**In-process mode specifics:**
- No new terminal windows or panes
- Everything renders in the single terminal session
- Shift+Up/Down would switch between teammate views (not tested interactively)

---

## Conclusions & Key Surprises

### Surprises vs expectations

1. **Inboxes ARE filesystem-based** — contrary to docs saying "SendMessage tool". It's a hybrid: the tool writes to filesystem inboxes.
2. **Teammates are threads, not processes** — no new OS processes, just threads within the lead's claude process.
3. **Teammates appear as standard subagents** — existing subagent-watcher infrastructure works out of the box!
4. **Config grows incrementally** — members are added one-by-one, not all at once.
5. **Internal tracking tasks** — tasks 4-6 with `_internal: true` track teammate spawn state.
6. **Auto-cleanup** — lead automatically cleaned up ALL artifacts after shutdown.
7. **Sub-subagents** — teammates can spawn their own Task tool subagents (3-level hierarchy).
8. **`teammateMode` is NOT a valid settings key** — display mode defaults to `in-process`.

### Design implications for Codeman

1. **TeamWatcher can be simple** — just poll `~/.claude/teams/` for directories + parse config.json
2. **Subagent-watcher already works** — no new infrastructure needed for teammate transcript tailing
3. **Idle detection needs team awareness** — check config.json members before declaring idle
4. **Message interception is possible** — watch inbox JSON files for real-time message tracking
5. **Task visualization is straightforward** — parse numbered JSON files in task directory
6. **No process tracking needed** — teammates are threads, not separate processes
7. **Distinguish teammates from subagents** — use description prefix `<teammate-message` or cross-reference config.json

### What to build first

1. **Team-aware idle detection** — highest priority, prevents premature respawn
2. **TeamWatcher** — poll `~/.claude/teams/` for team creation/removal
3. **Team tasks API** — parse task JSON files for UI display
4. **Teammate badge in subagent windows** — mark teammate subagents differently from regular ones
5. **Message timeline** — parse inbox files for inter-teammate communication display

### What we DON'T need to build

- Process discovery for teammates (they're threads)
- Custom transcript tailing (subagent-watcher handles it)
- Separate teammate window infrastructure (subagent windows work)
