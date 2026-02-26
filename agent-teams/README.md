# Claude Code Agent Teams — Reference

> Experimental feature (Feb 2026). Enable per-session via env var.
> Updated with experiment findings from 2026-02-12.

## Enabling

```bash
# Environment variable (set before starting Claude Code)
CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1

# In .claude/settings.local.json (case-scoped)
{
  "env": {
    "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS": "1"
  }
}
# Note: "teammateMode" is NOT a valid settings key (validation rejects it).
# Display mode defaults to "in-process". For tmux, pass --teammate-mode flag via CLI.
```

## Filesystem Paths (Verified)

| Resource | Path |
|----------|------|
| Team config | `~/.claude/teams/{team-name}/config.json` |
| Teammate inboxes | `~/.claude/teams/{team-name}/inboxes/{name}.json` |
| Shared tasks | `~/.claude/tasks/{team-name}/` |
| Teammate transcripts | `~/.claude/projects/{hash}/{leadSessionId}/subagents/agent-{id}.jsonl` |

Note: Teammate transcripts appear in the **standard subagent directory** under the lead's session, NOT as separate top-level sessions.

### config.json format (verified)

```json
{
    "name": "research-watchers",
    "description": "Team description...",
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
            "cwd": "/path/to/project",
            "subscriptions": []
        },
        {
            "agentId": "fs-researcher@research-watchers",
            "name": "fs-researcher",
            "agentType": "general-purpose",
            "model": "claude-opus-4-6",
            "prompt": "Full spawn prompt...",
            "color": "blue",
            "planModeRequired": false,
            "joinedAt": 1770875126680,
            "tmuxPaneId": "in-process",
            "cwd": "/path/to/project",
            "subscriptions": [],
            "backendType": "in-process"
        }
    ]
}
```

Key fields: `agentId` format is `{name}@{teamName}`, `leadSessionId` links to Codeman session, `backendType` indicates display mode, `color` for UI theming.

### Task file format (verified)

```json
{
    "id": "1",
    "subject": "Research Node.js fs.watch on Linux vs macOS",
    "description": "Full description...",
    "activeForm": "Researching Node.js fs.watch Linux vs macOS",
    "status": "in_progress",
    "blocks": [],
    "blockedBy": [],
    "owner": "fs-researcher"
}
```

Internal teammate tracking tasks have `"metadata": { "_internal": true }`.

Task states: `pending` → `in_progress` → `completed`. File locking via `.lock.lock` directory (mkdir-based atomic lock).

### Inbox message format (verified)

```json
[
    {
        "from": "team-lead",
        "text": "{\"type\":\"task_assignment\",\"taskId\":\"1\",\"subject\":\"...\",\"assignedBy\":\"team-lead\",\"timestamp\":\"...\"}",
        "timestamp": "2026-02-12T05:45:18.176Z",
        "read": false
    }
]
```

`text` is double-encoded JSON. Message types: `task_assignment`, `shutdown_request`, `shutdown_response`. File locking via `.json.lock` directory.

## Communication Model (CORRECTED)

**Hybrid: tool + filesystem.** The `SendMessage` tool writes to filesystem inbox files at `~/.claude/teams/{name}/inboxes/{teammate}.json`.

Each teammate AND the lead has an inbox JSON file. Messages are JSON arrays with `from`, `text` (double-encoded JSON), `timestamp`, `read` fields.

Message types observed:
- **task_assignment**: Lead assigns task to teammate
- **shutdown_request**: Lead asks teammate to shut down
- **shutdown_response**: Teammate confirms shutdown
- (Also: `message`, `broadcast`, `plan_approval_response` per docs)

**Implication:** We can intercept messages by watching inbox files AND potentially inject messages by writing to them (respecting `.json.lock` directory locking).

## Process Model (CORRECTED)

**Teammates are IN-PROCESS THREADS, not separate OS processes.**

In `in-process` mode (the default), all teammates run as threads within the single `claude` process. Only 1 claude process exists per Codeman session, regardless of team size.

This means:
- No separate PIDs to track per teammate
- All teammates share the lead's environment variables
- Lower resource overhead than separate processes
- Subagent transcript files still created (for progress tracking)

## Display Modes

| Mode | Trigger | UI | Requirement |
|------|---------|-----|------------|
| **in-process** (default) | Default | Shift+Up/Down to switch, Ctrl+T for tasks | Any terminal |
| **tmux** | `--teammate-mode tmux` | Split panes | tmux installed |
| **iTerm2** | Auto-detected | Native split panes | iTerm2 + `it2` CLI |

**For Codeman: use `in-process` only.** Codeman manages its own tmux sessions externally.

**In-process UI elements:**
- Status bar: `@main @teammate1 @teammate2 ...` with `shift+↑ to expand`
- Task list: Checkboxes with assignments `(@teammate-name)`
- Hint: `ctrl+t to show teammates`

## Hooks

Two new hook types for quality gates (verified in settings schema):

### TeammateIdle
Fires when a teammate is about to go idle.
- Exit code 0: Allow idle (normal)
- Exit code 2: Send feedback back, keep teammate working

### TaskCompleted
Fires when a task is being marked complete.
- Exit code 0: Allow completion
- Exit code 2: Prevent completion, send feedback

These are configured in `.claude/settings.local.json` alongside existing Codeman hooks.

## Subagent-Watcher Compatibility (Verified)

**Teammates appear as standard subagents.** They create transcript files at:
```
~/.claude/projects/{hash}/{leadSessionId}/subagents/agent-{id}.jsonl
```

Codeman's existing `subagent-watcher.ts` discovers them automatically. They appear in `/api/subagents` with status "active".

**Distinguishing teammates from regular subagents:**
- Description field starts with `<teammate-message teammate_id= team`
- Cross-reference with `~/.claude/teams/{name}/config.json` members

**Sub-subagents:** Teammates can spawn their own Task tool subagents, creating a 3-level hierarchy.

## Cleanup Behavior (Verified)

When the lead runs cleanup:
1. Shutdown requests sent to all teammate inboxes
2. Teammates shut down gracefully
3. ALL filesystem artifacts deleted:
   - Inbox files and directory
   - Config.json
   - Team directory
   - All task files
   - Task directory
4. Cleanup is atomic — all files removed in the same second

## Comparison with Subagents (Task tool)

| Aspect | Subagents (Task tool) | Agent Teams |
|--------|----------------------|-------------|
| Spawn method | Claude's built-in Task tool | Explicit team creation |
| Process model | In-process threads | In-process threads (same!) |
| Discovery | `subagents/agent-{id}.jsonl` only | BOTH subagent dir + `~/.claude/teams/` |
| Communication | None (fire-and-forget) | Filesystem inboxes + SendMessage tool |
| Shared state | None | Shared task list + inboxes |
| Task tracking | Per-agent, no coordination | Shared with dependencies & ownership |
| Lifecycle | Auto-cleanup on completion | Lead cleanup (deletes all artifacts) |
| Sub-nesting | Can spawn sub-subagents | Teammates can spawn subagents too |
| Cost | Lower (single context) | Higher (N context windows) |
| Duration | Short-lived (seconds-minutes) | Longer-lived (minutes-hours) |

## Limitations

- No session resumption with in-process teammates (`/resume` doesn't restore them)
- One team per session, no nested teams
- Lead is fixed (cannot promote teammate)
- Permissions set at spawn (change individually after)
- Split panes require tmux or iTerm2 (not Screen)
- Task status can lag (teammates may fail to mark complete)
- Shutdown can be slow (waits for current tool call)

## Useful Commands

```bash
# Check if teams exist
ls ~/.claude/teams/

# Check team config
cat ~/.claude/teams/{name}/config.json | jq .

# Check teammate inboxes
cat ~/.claude/teams/{name}/inboxes/{teammate}.json | jq .

# Check team tasks
ls ~/.claude/tasks/{name}/
for f in ~/.claude/tasks/{name}/*.json; do cat "$f" | jq .; done

# Count Claude processes (teammates are threads, not processes)
ps aux | grep '[c]laude' | grep -v grep

# Check subagent detection of teammates
curl -s http://localhost:3000/api/subagents | jq '.data[] | select(.description | startswith("<teammate"))'

# Team interaction (in-process mode)
# Shift+Up/Down: Switch between teammates
# Enter: View teammate session
# Escape: Interrupt teammate's turn
# Ctrl+T: Toggle task list
```
