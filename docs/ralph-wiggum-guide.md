# Ralph Wiggum Loop: Complete Guide

> This document consolidates official Anthropic documentation, community best practices, and implementation details for autonomous Claude Code loops.

**Last Updated**: 2026-01-20
**Sources**: [Official Anthropic Plugin](https://github.com/anthropics/claude-code/tree/main/plugins/ralph-wiggum), [Claude Code Docs](https://code.claude.com/docs/en/hooks), [Claude Code Best Practices](https://www.anthropic.com/engineering/claude-code-best-practices)

---

## Table of Contents

1. [Overview](#overview)
2. [Core Concept](#core-concept)
3. [Official Plugin Reference](#official-plugin-reference)
4. [The Promise Tag Contract](#the-promise-tag-contract)
5. [TodoWrite Tool Integration](#todowrite-tool-integration)
6. [Hooks System](#hooks-system)
7. [Best Practices](#best-practices)
8. [Prompt Templates](#prompt-templates)
9. [When to Use (and Not Use)](#when-to-use-and-not-use)
10. [Real-World Examples](#real-world-examples)
11. [Claudeman Implementation](#claudeman-implementation)
12. [Troubleshooting](#troubleshooting)

---

## Overview

Ralph Wiggum is an autonomous loop technique for Claude Code, named after The Simpsons character. It enables Claude to work iteratively on tasks for hours without human intervention, self-correcting until completion criteria are met.

**Core Philosophy**:
- **Iteration > Perfection**: Don't aim for perfect on first try; let the loop refine
- **Failures Are Data**: "Deterministically bad" means failures are predictable and informative
- **Operator Skill Matters**: Success depends on writing good prompts, not just having a good model
- **Persistence Wins**: Keep trying until success; the loop handles retry logic

**Origin**: Created by Geoffrey Huntley, formalized into an official Anthropic plugin by Boris Cherny (Head of Claude Code) in late 2025.

---

## Core Concept

The simplest form of a Ralph loop:

```bash
while :; do cat PROMPT.md | claude ; done
```

**How It Works**:
1. Claude processes a task prompt
2. Attempts to exit when "done"
3. A **Stop hook** intercepts the exit
4. Checks for **completion promise** (e.g., `<promise>COMPLETE</promise>`)
5. If not found, re-feeds the same prompt
6. Files from previous iteration persist, so Claude sees its own work
7. Cycle repeats until completion or max iterations reached

**Key insight**: The prompt never changes between iterations, but Claude's previous work persists in files, allowing autonomous improvement by reading past work.

---

## Official Plugin Reference

### Installation

```bash
# Add Anthropic's official plugin marketplace
/plugin marketplace add anthropics/claude-plugins-official

# Install Ralph Wiggum plugin
/plugin install ralph-wiggum@claude-plugins-official
```

### Commands

#### `/ralph-loop`

Start an autonomous loop.

```bash
/ralph-loop "<prompt>" --max-iterations <n> --completion-promise "<text>"
```

**Parameters**:

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `<prompt>` | string | required | Task description (persists across all iterations) |
| `--max-iterations` | integer | unlimited | Safety limit on iterations |
| `--completion-promise` | string | none | Exact string that signals completion |

**Example**:
```bash
/ralph-loop "Build a REST API for todos. Requirements: CRUD operations, input validation, tests. Output <promise>COMPLETE</promise> when done." --completion-promise "COMPLETE" --max-iterations 50
```

#### `/cancel-ralph`

Cancel the active Ralph loop.

```bash
/cancel-ralph
```

### State File

The plugin persists state to `.claude/ralph-loop.local.md`:

```yaml
---
enabled: true
iteration: 5
max-iterations: 50
completion-promise: "COMPLETE"
---
# Original Prompt

Build a REST API for todos...
```

**YAML Fields**:
- `enabled` (boolean): Controls hook activation
- `iteration` (integer): Current iteration count (0-indexed)
- `max-iterations` (integer): Optional maximum
- `completion-promise` (string): Optional completion text

---

## The Promise Tag Contract

The completion phrase pattern is the core contract between Claude and the loop system:

```
<promise>PHRASE</promise>
```

**Examples**:
- `<promise>COMPLETE</promise>` - Generic completion
- `<promise>TESTS_PASS</promise>` - Test-specific completion
- `<promise>TIME_COMPLETE</promise>` - Time-aware loop completion
- `<promise>FIXED</promise>` - Bug fix completion

### How Completion Detection Works

1. **Exact String Matching**: The `--completion-promise` uses case-sensitive exact matching
2. **Output Scanning**: The Stop hook scans Claude's final output for the promise tag
3. **Exit Control**: If found, exit is allowed. If not, loop continues.

### False Positive Prevention

The official implementation (and Claudeman) prevents false positives when completion phrases appear in:
- Initial prompts
- Documentation or examples
- Comments

**Solution**: Only mark as complete if the loop was already `active` when the phrase is detected.

```typescript
// From claudeman/src/inner-loop-tracker.ts
if (!this._loopState.active) {
  // Just record the expected completion phrase without marking as complete
  if (!this._loopState.completionPhrase) {
    this._loopState.completionPhrase = phrase;
  }
  return;
}

// Loop was active, this is a real completion
this._loopState.completionPhrase = phrase;
this._loopState.active = false;
this.emit('completionDetected', phrase);
```

---

## TodoWrite Tool Integration

The **TodoWrite tool** is Claude Code's built-in task management system that integrates with Ralph loops.

### How It Works

Claude uses TodoWrite to:
1. Break complex tasks into subtasks
2. Track progress through iterations
3. Provide visibility into current state
4. Resume work after context resets

### Todo Formats Detected

**Format 1: Markdown Checkboxes**
```markdown
- [ ] Pending task
- [x] Completed task
- [X] Completed task (uppercase)
```

**Format 2: Status Indicators**
```
Todo: ☐ Pending task
Todo: ◐ In progress task
Todo: ✓ Completed task
```

**Format 3: Parenthetical Status**
```
- Task name (pending)
- Task name (in_progress)
- Task name (completed)
```

### System Reminder Integration

From official Claude Code documentation:

> After commands like an ls -la run via bash tool, system-reminder tags are injected to remind the model to use the TodoWrite tool if it hasn't been using it so far.

The system prompt includes:
> "IMPORTANT: Always use the TodoWrite tool to plan and track tasks throughout the conversation."

### Checklists for Complex Workflows

From [Anthropic Best Practices](https://www.anthropic.com/engineering/claude-code-best-practices):

> For large tasks with multiple steps or requiring exhaustive solutions—like code migrations, fixing numerous lint errors, or running complex build scripts—improve performance by having Claude use a Markdown file (or even a GitHub issue!) as a checklist and working scratchpad.

---

## Hooks System

Ralph loops are powered by Claude Code's hooks system. Understanding hooks is essential for customization.

### Hook Events Reference

| Event | When | Use Case |
|-------|------|----------|
| `PreToolUse` | Before tool execution | Validate, modify, or block tool calls |
| `PostToolUse` | After tool completes | Provide feedback, run formatters/linters |
| `Stop` | When Claude finishes | **Ralph loop control** - block exit, refeed prompt |
| `SubagentStop` | When subagent finishes | Control nested loops |
| `UserPromptSubmit` | User submits prompt | Add context, validate input |
| `SessionStart` | Session begins | Load environment, context |
| `SessionEnd` | Session ends | Cleanup, logging |
| `PermissionRequest` | Permission dialog shown | Auto-approve/deny |
| `PreCompact` | Before compact | Backup, preprocessing |

### Stop Hook for Ralph Loops

The Stop hook is the key mechanism:

```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "./scripts/ralph-stop-hook.sh"
          }
        ]
      }
    ]
  }
}
```

**Stop Hook Logic**:
1. Check if `.claude/ralph-loop.local.md` exists
2. Read `enabled` flag from YAML frontmatter
3. Check for `completion-promise` in output
4. Check if `iteration >= max-iterations`
5. If none match, block exit and refeed prompt

### Hook Output for Stop Events

```json
{
  "decision": "block",
  "reason": "Completion promise not found. Restarting iteration."
}
```

Or to allow exit:
```json
{
  "continue": true,
  "stopReason": "Completion promise detected"
}
```

### Prompt-Based Hooks

For more sophisticated evaluation, use LLM-based hooks:

```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "prompt",
            "prompt": "Check if the task is complete. Context: $ARGUMENTS\n\nRespond with {\"ok\": true} if done, {\"ok\": false, \"reason\": \"...\"} if not.",
            "timeout": 30
          }
        ]
      }
    ]
  }
}
```

---

## Best Practices

### 1. Always Set `--max-iterations`

> This cannot be overstated: always set `--max-iterations`. Autonomous loops consume tokens rapidly. A typical 50-iteration loop on a medium-sized codebase can cost $50-100+ in API usage.

```bash
/ralph-loop "..." --max-iterations 30 --completion-promise "DONE"
```

### 2. Define Clear, Measurable Success Criteria

**Bad**:
```
Build a todo API and make it good.
```

**Good**:
```
Build a REST API for todos.

Completion criteria:
- All CRUD endpoints working (GET, POST, PUT, DELETE)
- Input validation with error messages
- Tests passing with >80% coverage
- README with API documentation

Output <promise>COMPLETE</promise> when ALL criteria are met.
```

### 3. Use Test-Driven Verification

> The most effective Ralph Loop tasks include built-in verification. This creates a natural feedback loop within the loop.

```
Implement user authentication using TDD:

1. Write failing tests for each requirement
2. Implement feature to make tests pass
3. Run tests after each change
4. If any fail, debug and fix
5. Refactor if needed
6. Output <promise>TESTS_PASS</promise> when all tests green
```

### 4. Include Escape Hatches

```
Primary task: Implement feature X

If stuck after 10 iterations:
- Document what's blocking progress
- List approaches that were attempted
- Suggest alternative approaches
- Output <promise>BLOCKED</promise>
```

### 5. Incremental Goals for Large Tasks

**Bad**:
```
Create a complete e-commerce platform.
```

**Good**:
```
Build e-commerce platform in phases:

Phase 1: User authentication
- JWT-based auth
- Tests passing
- Commit: "feat: add user auth"

Phase 2: Product catalog
- CRUD for products
- Search functionality
- Tests passing
- Commit: "feat: add product catalog"

Phase 3: Shopping cart
- Add/remove items
- Persist cart state
- Tests passing
- Commit: "feat: add shopping cart"

Output <promise>COMPLETE</promise> when all phases done.
```

### 6. Commit Frequently

```
After each meaningful completion:
1. git add .
2. git commit -m "descriptive message"

This creates recovery points and shows progress in git history.
```

### 7. Test Before Long Runs

> Pro tip: Test manually with one iteration before running 50-iteration loops.

```bash
# Test with 1 iteration first
/ralph-loop "..." --max-iterations 1

# Then run full loop
/ralph-loop "..." --max-iterations 50
```

### 8. Use Git for Safety

> Always run Ralph loops in a git-tracked directory. If something goes wrong, you can revert. Each iteration adds to git history, giving you a clear trail of what changed.

---

## Prompt Templates

### Template 1: Test-Driven Development

```markdown
# Task: [FEATURE_NAME]

## Requirements
- [Requirement 1]
- [Requirement 2]
- [Requirement 3]

## Approach
Follow TDD methodology:
1. Write failing tests for each requirement
2. Implement minimal code to pass tests
3. Run tests: `npm test`
4. If tests fail, read error, fix, repeat
5. When all tests pass, refactor if needed
6. Commit: `git add . && git commit -m "feat: [feature]"`

## Completion
Output <promise>TESTS_PASS</promise> when:
- All tests pass
- Code is committed
- No lint errors
```

### Template 2: Migration/Refactor

```markdown
# Task: Migrate from [OLD] to [NEW]

## Scope
Files to migrate: `src/**/*.ts`

## Migration Steps
For each file:
1. Update imports
2. Replace deprecated patterns
3. Run type check: `npx tsc --noEmit`
4. If errors, fix them
5. Run tests: `npm test`
6. Commit: `git commit -m "refactor: migrate [file]"`

## Completion
Output <promise>MIGRATION_COMPLETE</promise> when:
- All files migrated
- Type check passes
- All tests pass
- All changes committed
```

### Template 3: Bug Fix

```markdown
# Bug: [BUG_DESCRIPTION]

## Reproduction
[Steps to reproduce]

## Investigation
1. Find the root cause
2. Document findings

## Fix
1. Write a failing test that reproduces the bug
2. Implement the fix
3. Verify test passes
4. Check for regressions: `npm test`
5. Commit: `git commit -m "fix: [description]"`

## Completion
Output <promise>FIXED</promise> when:
- Bug is fixed
- Test added to prevent regression
- All tests pass
```

### Template 4: Time-Aware Loop

```markdown
# Task: Optimize API performance

## Primary Goals
1. Profile existing endpoints
2. Identify bottlenecks
3. Implement optimizations
4. Verify improvements

## Duration
Minimum runtime: 4 hours

## Self-Generated Tasks
If primary goals complete before 4 hours:
- Add caching layers
- Optimize database queries
- Add request batching
- Improve error handling
- Add performance tests

## Completion
Output <promise>TIME_COMPLETE</promise> when:
- All primary goals achieved
- Minimum 4 hours elapsed
- All tests pass
```

---

## When to Use (and Not Use)

### Good Use Cases

| Use Case | Why It Works |
|----------|--------------|
| **Large refactors** | Clear mechanical steps, verifiable via tests |
| **Framework migrations** | Repetitive patterns, type checking validates |
| **Test coverage** | "Add tests for uncovered functions" is measurable |
| **Greenfield projects** | Can run overnight, tests verify correctness |
| **Batch operations** | Same operation across many files |
| **Dependency upgrades** | API changes are well-documented |

### Poor Use Cases

| Use Case | Why It Fails |
|----------|--------------|
| **Ambiguous requirements** | Can't define success criteria |
| **Architectural decisions** | Requires human judgment |
| **Security-critical code** | Needs human review |
| **Production debugging** | Often requires context not in code |
| **UX/design decisions** | Subjective, not automatable |
| **Exploratory work** | "Figure out why it's slow" has no clear endpoint |

### Decision Framework

Ask yourself:
1. **Can I define "done" objectively?** (tests pass, lint clean, etc.)
2. **Is there automatic verification?** (tests, type checking, linting)
3. **Is the task mechanical or creative?** (mechanical = good for Ralph)
4. **What's the cost of failure?** (high cost = needs human review)

---

## Real-World Examples

### Example 1: Y Combinator Hackathon
- **Task**: Generate multiple repositories overnight
- **Result**: 6 repositories generated autonomously
- **Key**: Each repo had clear completion criteria

### Example 2: $50K Contract
- **Task**: Large codebase migration
- **Result**: Completed for $297 in API costs
- **Key**: Well-defined migration patterns, comprehensive tests

### Example 3: Programming Language (Cursed)
- **Task**: "Make me a programming language like Golang but with Gen Z slang keywords"
- **Result**: Functional compiler with LLVM backend, standard library, editor support
- **Duration**: 3 months of autonomous iteration
- **Keywords**: `slay` (function), `sus` (variable), `based` (true)

### Example 4: React Migration
- **Task**: Upgrade from React v16 to v19
- **Result**: 14-hour autonomous session, complete migration
- **Key**: Clear deprecation warnings, comprehensive test suite

---

## Claudeman Implementation

Claudeman implements Ralph Wiggum tracking via the `InnerLoopTracker` class in `src/inner-loop-tracker.ts`.

### Auto-Detection Patterns

The tracker automatically enables when detecting:

| Pattern | Example | Regex |
|---------|---------|-------|
| Ralph command | `/ralph-loop` | `/\/ralph-loop\|starting ralph/i` |
| Promise tag | `<promise>COMPLETE</promise>` | `/<promise>([^<]+)<\/promise>/` |
| TodoWrite | `Todos have been modified` | `/TodoWrite\|todos?\s*(?:updated\|written)/i` |
| Iteration | `Iteration 5/50` or `[5/50]` | `/(?:iteration)\s*#?(\d+)(?:\s*[\/of]\s*(\d+))?/i` |
| Todo checkbox | `- [ ] Task` | `/^[-*]\s*\[([xX ])\]\s+(.+)$/gm` |
| Todo indicator | `Todo: ☐ Task` | `/Todo:\s*(☐\|◐\|✓)/g` |

### State Structure

```typescript
interface InnerLoopState {
  enabled: boolean;           // Tracker active?
  active: boolean;            // Loop running?
  completionPhrase: string | null;
  startedAt: number | null;
  cycleCount: number;
  maxIterations: number | null;
  lastActivity: number;
  elapsedHours: number | null;
}

interface InnerTodoItem {
  id: string;
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
  detectedAt: number;
}
```

### API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/sessions/:id/inner-state` | Get loop state and todos |
| POST | `/api/sessions/:id/inner-config` | Configure tracker settings |

**GET Response**:
```json
{
  "success": true,
  "data": {
    "loop": {
      "enabled": true,
      "active": true,
      "completionPhrase": "COMPLETE",
      "cycleCount": 5,
      "maxIterations": 50,
      "elapsedHours": 2.5
    },
    "todos": [
      { "id": "todo-abc", "content": "Fix auth", "status": "completed" },
      { "id": "todo-def", "content": "Add tests", "status": "in_progress" }
    ],
    "todoStats": { "total": 5, "pending": 2, "inProgress": 1, "completed": 2 }
  }
}
```

### SSE Events

| Event | Data | When |
|-------|------|------|
| `session:innerLoopUpdate` | `InnerLoopState` | Loop state changes |
| `session:innerTodoUpdate` | `InnerTodoItem[]` | Todos detected/updated |
| `session:innerCompletionDetected` | `{ phrase: string }` | Completion phrase found |

### Skill Commands

```bash
/ralph-loop          # Start Ralph loop in current session
/cancel-ralph        # Cancel active Ralph loop
/ralph-loop:help     # Show help for Ralph loop
```

---

## Troubleshooting

### Loop Never Completes

**Cause**: Completion criteria aren't clear enough.

**Solution**: Be more specific about what "done" means. Include testable criteria:
```
Output <promise>DONE</promise> when:
- `npm test` exits with code 0
- `npm run lint` exits with code 0
- All files committed
```

### Same Error Every Iteration

**Cause**: Claude is stuck in a failure loop.

**Solution**: Add escape hatch to prompt:
```
If stuck after 10 iterations with the same error:
1. Document the error and what was tried
2. Suggest alternative approaches
3. Output <promise>STUCK</promise>
```

### High API Costs

**Cause**: Too many iterations, large context.

**Solutions**:
1. Always set `--max-iterations`
2. Use `/clear` between major phases
3. Keep files small and focused
4. Test with 1 iteration first

### False Completion Detection

**Cause**: Completion phrase appears in prompt or documentation.

**Solution**: Use unique, unlikely phrases:
```
# Bad (might appear in docs)
<promise>COMPLETE</promise>

# Good (unique)
<promise>TASK_XYZ_VERIFIED_DONE</promise>
```

### Tracker Not Enabling

**Cause**: No Ralph patterns detected in output.

**Solution**:
1. Manually enable: `POST /api/sessions/:id/inner-config { "enabled": true }`
2. Or ensure Claude outputs recognizable patterns

### Context Window Exhaustion

**Cause**: Long-running loops accumulate context.

**Solution**: Configure auto-clear:
```bash
POST /api/sessions/:id/auto-clear
{ "enabled": true, "threshold": 140000 }
```

---

## References

### Official Documentation
- [Anthropic Ralph Wiggum Plugin](https://github.com/anthropics/claude-code/tree/main/plugins/ralph-wiggum)
- [Claude Code Hooks Reference](https://code.claude.com/docs/en/hooks)
- [Claude Code Best Practices](https://www.anthropic.com/engineering/claude-code-best-practices)
- [Claude Code Overview](https://code.claude.com/docs/en/overview)

### Community Resources
- [Awesome Claude - Ralph Wiggum](https://awesomeclaude.ai/ralph-wiggum)
- [Claude Fast - Autonomous Agent Loops](https://claudefa.st/blog/guide/mechanics/autonomous-agent-loops)
- [DeepWiki - Ralph Loop](https://deepwiki.com/anthropics/claude-plugins-official/5.2.2-ralph-loop)

### Related Claudeman Files
- `src/inner-loop-tracker.ts` - Core detection engine
- `src/ralph-loop.ts` - Task orchestration
- `src/respawn-controller.ts` - Session cycling
- `src/types.ts` - Type definitions

---

*This documentation is maintained as part of the Claudeman project. For updates, see the main [CLAUDE.md](../CLAUDE.md).*
