# Ralph Loop Improvements Plan

## Overview

This plan details improvements to Claudeman's Ralph Loop system based on best practices from the Ralph Claude Code repository (https://github.com/frankbria/ralph-claude-code).

## Key Concepts to Implement

### RALPH_STATUS Block Format

Claude outputs this structured block at the end of every response for better tracking:

```
---RALPH_STATUS---
STATUS: IN_PROGRESS | COMPLETE | BLOCKED
TASKS_COMPLETED_THIS_LOOP: <number>
FILES_MODIFIED: <number>
TESTS_STATUS: PASSING | FAILING | NOT_RUN
WORK_TYPE: IMPLEMENTATION | TESTING | DOCUMENTATION | REFACTORING
EXIT_SIGNAL: false | true
RECOMMENDATION: <one line summary of what to do next>
---END_RALPH_STATUS---
```

### Dual-Condition Exit Gate

Exit requires BOTH conditions:
1. `completion_indicators >= 2` (heuristic detection from natural language patterns)
2. Claude's explicit `EXIT_SIGNAL: true` in the RALPH_STATUS block

### Circuit Breaker Pattern

Three states: CLOSED → HALF_OPEN → OPEN

| From State | Condition | To State |
|------------|-----------|----------|
| CLOSED | consecutive_no_progress >= 2 | HALF_OPEN |
| CLOSED | consecutive_no_progress >= 3 | OPEN |
| CLOSED | consecutive_same_error >= 5 | OPEN |
| HALF_OPEN | progress detected | CLOSED |
| HALF_OPEN | consecutive_no_progress >= 3 | OPEN |
| OPEN | Manual reset | CLOSED |

### @fix_plan.md Structure

```markdown
# Fix Plan

## High Priority (P0)
- [ ] Critical: Fix authentication bug
- [ ] Blocker: Database connection timeout

## Standard (P1)
- [ ] Feature: Add user profile page

## Nice to Have (P2)
- [ ] Improvement: Add dark mode

## Completed
- [x] Setup: Initialize project structure
```

---

## Phase 1: Quick Wins (1-2 days)

### 1.1 RALPH_STATUS Block Parsing

**What**: Add parsing support for the structured RALPH_STATUS block format in RalphTracker.

**Implementation**:
- Add regex pattern to detect `---RALPH_STATUS---` blocks
- Parse fields: STATUS, TASKS_COMPLETED_THIS_LOOP, FILES_MODIFIED, TESTS_STATUS, WORK_TYPE, EXIT_SIGNAL, RECOMMENDATION
- Store in extended `RalphTrackerState` type
- Emit new events: `ralphStatusUpdate`

**Files**: `ralph-tracker.ts`, `types.ts`

### 1.2 Enhanced Status Display in UI

**What**: Display RALPH_STATUS fields in the Ralph State Panel.

**Implementation**:
- Add UI elements: WORK_TYPE indicator, TESTS_STATUS badge, FILES_MODIFIED count
- Show RECOMMENDATION text in expanded view
- Color-code status (IN_PROGRESS=blue, COMPLETE=green, BLOCKED=red)

**Files**: `app.js`, `styles.css`, `index.html`

### 1.3 Prompt Template Improvements

**What**: Add specification-by-example exit scenarios to prompts.

**Implementation**:
- Add "Exit Scenarios" section to case-template.md
- Document when to continue vs. when to output completion
- Include testing limits guidance (max 20% effort on tests)
- Add RALPH_STATUS block instructions

**Files**: `case-template.md`

### 1.4 Better Wizard Validation

**What**: Add client-side validation and helpful warnings.

**Implementation**:
- Warn if task description < 50 chars
- Warn if no success criteria mentioned
- Suggest adding test requirements if none detected
- Validate completion phrase is uppercase alphanumeric

**Files**: `app.js`

---

## Phase 2: Core Improvements (3-5 days)

### 2.1 Circuit Breaker Pattern

**What**: Implement three-state circuit breaker to detect stuck loops.

**Implementation**:
- Create `CircuitBreaker` class with CLOSED, HALF_OPEN, OPEN states
- Track: files_modified, tasks_completed, error_patterns per iteration
- Triggers: N consecutive no-progress, same error M times, tests failing K iterations
- Emit events: `circuitBreakerStateChange`

**Files**: New `circuit-breaker.ts`, integrate into `ralph-tracker.ts`

### 2.2 Circuit Breaker UI

**What**: Visual indicator in Ralph panel.

**Implementation**:
- Badge: green (CLOSED), yellow (HALF_OPEN), red (OPEN)
- Warning before tripping
- Notification when circuit opens
- Manual reset button

**Files**: `app.js`, `styles.css`, `index.html`

### 2.3 @fix_plan.md Integration

**What**: Generate and track structured task plan file.

**Implementation**:
- Generate `@fix_plan.md` in working directory when loop starts
- Watch file for changes and sync with RalphTracker todos
- Parse priority levels (P0, P1, P2)
- Show priority in UI

**Files**: New `fix-plan.ts`, `ralph-tracker.ts`, `server.ts`

### 2.4 Wizard Plan Generation Step

**What**: Add third wizard step for AI-assisted plan generation.

**Implementation**:
- Step 2: "Plan Generation" between Task Setup and Launch
- Use Claude to break down task into fix plan items
- Allow edit/reorder before launch
- Generate @fix_plan.md with selected items

**Files**: `app.js`, `index.html`, `server.ts`

### 2.5 Smart Respawn Integration

**What**: Use RALPH_STATUS for respawn decisions.

**Implementation**:
- Use EXIT_SIGNAL field for respawn decisions
- If STATUS=BLOCKED, trigger circuit breaker instead of respawn
- Pass RECOMMENDATION to respawn update prompt

**Files**: `respawn-controller.ts`, `ralph-tracker.ts`

---

## Phase 3: Advanced Features (5+ days)

### 3.1 Template Library
- Bug Fix, Feature, Refactoring, Test Coverage, Documentation templates
- Template selector in wizard
- Custom templates in `~/.claudeman/templates/`

### 3.2 Tool Permissions
- Configure allowed Claude tools per loop
- Generate hook configuration
- Store in session config

### 3.3 Per-Iteration Timeout
- Max time per iteration (5-60 min)
- Auto-continue on timeout
- Log timeout events

### 3.4 Rate Limiting
- Max tokens per iteration
- Max API calls per minute
- Cooldown between iterations

### 3.5 Metrics Dashboard
- Time-series charts (files modified, tasks completed, tokens)
- Aggregate statistics
- Export to JSON/CSV

---

## Priority Matrix

| Item | Effort | Impact | Priority |
|------|--------|--------|----------|
| 1.1 RALPH_STATUS Parsing | Low | High | P0 |
| 1.2 Status Display UI | Low | Medium | P0 |
| 1.3 Prompt Templates | Low | High | P0 |
| 1.4 Wizard Validation | Low | Medium | P1 |
| 2.1 Circuit Breaker | Medium | High | P1 |
| 2.2 Circuit Breaker UI | Medium | Medium | P1 |
| 2.3 Fix Plan Integration | Medium | High | P1 |
| 2.4 Plan Generation Step | Medium | Medium | P2 |
| 2.5 Respawn Integration | Medium | High | P1 |
| 3.1 Template Selection | High | Medium | P2 |
| 3.2 Tool Permissions | High | Medium | P3 |
| 3.3 Per-Iteration Timeout | High | Medium | P2 |
| 3.4 Rate Limiting | High | Low | P3 |
| 3.5 Metrics Dashboard | High | Medium | P3 |

---

## Reference: Ralph Claude Code Best Practices

### Testing Guidelines
- LIMIT testing to ~20% of total effort per loop
- PRIORITIZE: Implementation > Documentation > Tests
- Only write tests for NEW functionality
- Do NOT refactor existing tests unless broken

### What NOT to Do
- Do NOT continue with busy work when EXIT_SIGNAL should be true
- Do NOT run tests repeatedly without implementing new features
- Do NOT refactor code that is already working
- Do NOT add features not in specifications
- Do NOT forget the status block

### Exit Scenarios (Specification by Example)

1. **Successful Completion**: All tasks done → EXIT_SIGNAL=true
2. **Test-Only Loop**: No implementation, only testing → continue but warn
3. **Stuck on Error**: Same error 5 times → circuit breaker opens
4. **No Work Remaining**: All specs done → EXIT_SIGNAL=true
5. **Making Progress**: Normal flow → continue
6. **Blocked**: Needs human intervention → STATUS=BLOCKED
