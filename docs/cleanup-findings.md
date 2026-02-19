# Codebase Cleanup Findings

Compiled from parallel analysis of the entire Claudeman codebase by 3 research agents (2026-02-19).

## P0 — Bug Fix

### 1. `{WORKING_DIR}` placeholder never replaced in plan-orchestrator.ts
- **File:** `src/plan-orchestrator.ts:409`
- `RESEARCH_AGENT_PROMPT` has `{WORKING_DIR}` placeholder but only `{TASK}` is replaced
- The literal string `{WORKING_DIR}` gets sent to the AI model
- **Fix:** Add `.replace('{WORKING_DIR}', this.workingDir)` after the `{TASK}` replacement

## P1 — Dead Code Removal (High Impact)

### 2. ~66 dead functions in app.js
- Functions never called: `clearAll()`, `toggleSubagentDropdown()`, `goHome()`, `showRalphWizard()`, `minimizeRalphWizard()`, `restoreRalphWizard()`, `ralphWizardNext()`, `ralphWizardBack()`, `skipPlanGeneration()`, `regeneratePlan()`, `incrementTabCount()`, `decrementTabCount()`, `incrementShellCount()`, `decrementShellCount()`, `stopClaude()`, and ~50 more
- Many are remnants of abandoned features (Ralph wizard, plan version history)
- **Estimated savings:** 300-500 lines

### 3. ~74 dead CSS selectors in styles.css
- Major dead blocks: Task Panel System (`.task-panel`), Process Panel System (`.process-panel`), Monitor Tabs (`.monitor-tabs`), Ralph Metadata (`.ralph-progress-section`, `.ralph-meta`), Plan Editor Toolbar, Plan Version History
- Plus ~30 minor unused utility/component selectors
- **Estimated savings:** ~400 lines

### 4. 13 dead type definitions in types.ts (~150 lines)
- Dead request interfaces (superseded by Zod schemas): `CreateSessionRequest`, `RunPromptRequest`, `SessionInputRequest`, `ResizeRequest`, `CreateCaseRequest`, `QuickStartRequest`, `CreateScheduledRunRequest`, `QuickRunRequest`, `HookEventRequest`
- Other dead types: `TaskAssignment`, `MemoryMetrics`, `RalphStateRecord`
- Dead function: `createSuccessResponse` (exported, never imported)
- **Estimated savings:** ~150 lines

### 5. 9 unused constants in map-limits.ts
- `MAX_PENDING_HOOKS`, `MAX_SESSION_HISTORY`, `MAX_SSE_CLIENTS_PER_SESSION`, `MAX_TOTAL_SSE_CLIENTS`, `FILE_WATCHER_WARNING_THRESHOLD`, `MAX_QUEUED_TASKS`, `MAX_COMPLETED_TASKS_HISTORY`, `COMPLETED_TODO_TTL_MS`, `MAX_CONCURRENT_SESSIONS`
- 9 of 14 exports are dead — only 5 are actually imported

### 6. Dead `SessionInputSchema` in schemas.ts
- `SessionInputSchema` (line 87) is defined/exported but never imported
- `SessionInputWithLimitSchema` is the one actually used

### 7. Dead `code-reviewer.ts` prompt file
- `src/prompts/code-reviewer.ts` — entire file is dead, `CODE_REVIEWER_PROMPT` never imported
- Re-exported in `src/prompts/index.ts` but no consumer

### 8. Dead utility exports
- **Default exports** (4 files): `lru-map.ts`, `cleanup-manager.ts`, `stale-expiration-map.ts`, `buffer-accumulator.ts` — all have `export default` that's never used
- **`stripAnsiSimple`** in `regex-patterns.ts` — exported, never imported (only `stripAnsi` used)
- **String similarity**: `isSimilar`, `isSimilarByDistance`, `stringSimilarity`, `levenshteinDistance` — none imported externally
- **LRUMap methods**: `oldest()`, `newest()`, `peek()`, `expireOlderThan()`, `valuesInOrder()`, `maxEntries`, `freeSlots` — never called
- **StaleExpirationMap methods**: `touch()`, `getAge()`, `getRemainingTtl()`, `peek()` — never called
- **CleanupManager methods**: `registerWatcher()`, `registerListener()`, `registerStream()`, `getRegistrations()`, `resourceCounts` — never called

### 9. Dead backend functions
- `resetSessionManager()` in session-manager.ts:300 — never imported
- `getStoredTasks()` in task-queue.ts:264 — never called
- `start()` in session.ts:1918 — no-op legacy method
- Empty `updateStatsFromEvent()` in run-summary.ts:397 — called every event, does nothing

### 10. Dead TS type exports
- `AiCheckerEvents<R>`, `AiIdleCheckerEvents`, `AiPlanCheckerEvents` — never imported
- `AiCheckStatus`, `AiPlanCheckStatus` — backwards compat aliases, never imported

## P2 — Performance & Efficiency

### 11. task-queue.ts `getCount()` iterates all tasks 5 times
- Called every Ralph Loop tick — creates array from Map, then filters 4 times
- **Fix:** Single-pass counting like `TaskTracker.getStats()` does

### 12. transcript-watcher.ts double file read
- `readNewEntries()` reads the file twice: once for CRLF detection, once for parsing
- `crlfDelay: Infinity` already handles both line endings
- **Fix:** Remove the raw buffer CRLF check, read once

### 13. tmux-manager.ts `saveSessions()` no debounce
- Rapid calls can overlap; no in-flight guard unlike `StateStore`
- **Fix:** Add debouncing or in-flight tracking

## P3 — Consolidation & Consistency

### 14. Duplicate `SAFE_PATH_PATTERN` regex
- `schemas.ts:15` and `tmux-manager.ts:81` — identical regex
- **Fix:** Share from one location

### 15. Duplicate `MAX_CONCURRENT_SESSIONS`
- `map-limits.ts:57` (dead) vs `server.ts:131` (used, hardcoded)
- **Fix:** server.ts should import from map-limits

### 16. Duplicate cache TTLs in server.ts
- `SESSIONS_LIST_CACHE_TTL` and `LIGHT_STATE_CACHE_TTL_MS` — both 1000ms
- **Fix:** Consolidate into one constant

### 17. Inconsistent path import in server.ts
- Imports both `path` default and destructured `{ join, dirname, resolve, relative, isAbsolute }`
- 3 lines use `path.join()` while everywhere else uses `join()`
- **Fix:** Remove default import, use `join()` consistently

### 18. Re-export indirection for `getAugmentedPath`
- `session.ts:89` re-exports from `claude-cli-resolver.ts` for backwards compat
- `ai-checker-base.ts` should import directly from source

### 19. `cliInfoUpdated` event missing from SessionEvents interface
- Emitted in `session.ts:1742`, handled in `server.ts:4214`, but not in the interface
- Type safety gap — handlers aren't type-checked

### 20. Array instead of Set for `_childAgentIds` in session.ts
- Uses `includes()`/`indexOf()` for lookups (O(n))
- Small lists in practice, but Set is more appropriate
