export function generateClaudeMd(caseName: string, description: string = ''): string {
  const date = new Date().toISOString().split('T')[0];

  return `# CLAUDE.md - Project Configuration

## Project Overview

- **Project Name**: ${caseName}
- **Description**: ${description || 'A new project'}
- **Tech Stack**: [TECHNOLOGIES_USED]
- **Last Updated**: ${date}

---

## Work Principles

### Autonomy
Full permissions granted. Act decisively without asking - read, write, edit, execute freely.

### Git Discipline
- **Commit after every meaningful change** - never batch unrelated work
- Use conventional commits: \`feat:\`, \`fix:\`, \`docs:\`, \`refactor:\`, \`test:\`, \`chore:\`
- Commit message = what changed + why (not how)

### Documentation
- Update README.md when adding features or changing setup
- Update this file's session log after work sessions
- Keep docs in sync with code changes

### Thinking
Extended thinking is enabled. Use deep reasoning for complex architectural decisions, difficult bugs, and multi-file changes.

---

## When to Use Agents

**Explore agent**: Codebase investigation, finding files, understanding architecture
\`\`\`
"Use explore agent to find all authentication-related code"
\`\`\`

**Parallel agents**: Independent tasks that don't conflict
\`\`\`
"Research auth, database, and API modules in parallel using separate agents"
\`\`\`

**Background execution**: Long-running operations (tests, builds)
\`\`\`
"Run the test suite in the background while I continue"
\`\`\`

**Sequential chaining**: When second task depends on first
\`\`\`
"Use code-reviewer to find issues, then use fixer to resolve them"
\`\`\`

---

## Planning Mode (Automatic)

**Automatically enter planning mode** when ANY of these conditions apply:
- Multi-file changes (3+ files affected)
- Architectural decisions
- Unclear or evolving requirements
- Risk mitigation on core systems
- New feature implementation
- Refactoring existing functionality

**Do NOT ask** whether to enter planning mode - just enter it when conditions are met.

Planning mode flow: read-only exploration → create plan → get approval → execute.

**Skip planning mode** only for:
- Single-file bug fixes
- Typo corrections
- Simple config changes
- Tasks with explicit step-by-step instructions from user

---

## Ralph Wiggum Loop (Autonomous Work Mode)

Ralph loops enable persistent, autonomous work on large tasks. When active, you continue iterating until completion criteria are met or the loop is cancelled.

### Starting a Ralph Loop
- Start: \`/ralph-loop\`
- Cancel: \`/cancel-ralph\`
- Help: \`/ralph-loop:help\`

### Time-Aware Loops

When the user specifies a **minimum duration** (e.g., "optimize for 8 hours", "work on this for 2 hours"), the loop becomes time-aware:

**At loop start:**
\`\`\`bash
# Record start time
date +%s > /tmp/ralph_start_time
echo "Loop started at $(date)"
\`\`\`

**Check elapsed time periodically:**
\`\`\`bash
START=$(cat /tmp/ralph_start_time)
NOW=$(date +%s)
ELAPSED_HOURS=$(echo "scale=2; ($NOW - $START) / 3600" | bc)
echo "Elapsed: $ELAPSED_HOURS hours"
\`\`\`

**Time-aware behavior:**
1. Complete all primary tasks from the user's prompt
2. After primary tasks done, check elapsed time
3. If minimum duration NOT reached:
   - **Do NOT output completion phrase**
   - Self-generate additional related tasks
   - Continue working until minimum time elapsed
4. Only output completion phrase when:
   - ALL primary tasks complete AND
   - Minimum duration reached (or exceeded)

**Self-generating additional tasks when time remains:**
- Code optimization (performance, readability, DRY)
- Test coverage improvements
- Edge case handling
- Error message improvements
- Documentation gaps
- Security hardening
- Accessibility improvements
- Code cleanup and dead code removal
- Dependency updates
- Type safety improvements

### How You Know You're in a Ralph Loop

The user started the loop with a prompt containing:
- Clear task requirements
- A **completion phrase** (e.g., \`<promise>COMPLETE</promise>\`)
- **Optional: minimum duration** (e.g., "for the next 4 hours")
- Iteration limits (handled by the system)

Your job: Keep working until ALL requirements are verifiably done AND minimum time reached (if specified), then output the exact completion phrase.

### Core Behaviors During Ralph Loop

**1. Work Incrementally**
- Complete one sub-task at a time
- Verify it works before moving to the next
- Don't try to do everything in one pass

**2. Commit Frequently**
- Commit after each meaningful completion
- Creates recovery points if something breaks
- Shows progress in git history
\`\`\`
git add . && git commit -m "feat(auth): add token refresh endpoint"
\`\`\`

**3. Self-Correct Relentlessly**
\`\`\`
Loop:
  1. Implement/fix
  2. Run tests
  3. If tests fail → read error, fix, go to 1
  4. Run linter
  5. If lint errors → fix, go to 1
  6. Commit
  7. Continue to next task
\`\`\`

**4. Track Progress**
Update the session log in this file as you complete tasks:
\`\`\`markdown
| Date | Tasks Completed | Files Changed | Notes |
|------|-----------------|---------------|-------|
| YYYY-MM-DD | Add auth endpoint | auth.ts, routes.ts | Tests passing |
\`\`\`

**5. Use Git History When Stuck**
If something isn't working:
\`\`\`bash
git log --oneline -10
git diff HEAD~1
\`\`\`
See what you already tried. Don't repeat failed approaches.

**6. Completion Phrase = Contract**
Only output the completion phrase (e.g., \`<promise>COMPLETE</promise>\`) when:
- ALL requirements from the original prompt are done
- ALL tests pass
- ALL linting passes
- Changes are committed

**Never output the completion phrase early.** The loop only ends when you say it's done.

### What Makes Good Completion Criteria

The user should provide criteria that are:
- **Verifiable**: Tests pass, lint clean, build succeeds
- **Measurable**: "5 endpoints", "all files in src/", "zero errors"
- **Binary**: Done or not done, no ambiguity

If the original prompt has vague criteria, ask clarifying questions before starting heavy work.

### Self-Correction Pattern (Include in Your Work)

\`\`\`
FOR EACH TASK:
1. Implement the change
2. Run tests (npm test, pytest, go test, cargo test, etc.)
   - If fail → read error, fix, retry
3. Run linter (npm run lint, ruff, golangci-lint, etc.)
   - If fail → fix, go to step 2
4. Verify manually if needed
5. Commit with descriptive message
6. Update session log
7. Move to next task

WHEN ALL TASKS DONE:
1. Run full test suite
2. Run full lint
3. Verify build succeeds
4. Review all changes: git diff main
5. Only then output completion phrase
\`\`\`

### When to NOT Output Completion Phrase

- Tests are failing (even one)
- Lint errors exist
- Build is broken
- You skipped a requirement
- You're unsure if something works
- **Minimum duration not reached** (for time-aware loops)

Instead: Fix the issue, verify, then complete. For time-aware loops: generate more tasks and keep improving until minimum time elapsed.

---

## Code Standards

### Before Writing
- Read existing code in the area you're modifying
- Follow existing patterns and conventions
- Check for similar implementations to reference

### During Implementation
- Keep changes focused and minimal
- Don't over-engineer
- Write tests for new functionality

### After Implementation
- Run tests
- Update docs if needed
- Commit with descriptive message

---

## Hooks Awareness

This project may have hooks that auto-format code after writes or validate operations. If a tool call behaves unexpectedly, hooks are likely the cause. Continue working - they're intentional.

---

## Session Log

| Date | Tasks Completed | Files Changed | Notes |
|------|-----------------|---------------|-------|
| ${date} | Project created | CLAUDE.md | Initial setup |

---

## Current Task Queue

### Active Ralph Loop
**Status**: Not Active
**Completion Phrase**: -

### Pending Tasks
- [ ] <!-- Add tasks here -->

---

## Implementation Plans

<!-- Document plans before major implementations -->

---

## Notes & Decisions

<!-- Track important decisions and context -->
`;
}
