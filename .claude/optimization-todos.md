# Claudeman Code Optimization TODO List

> Generated: 2026-01-21
> Purpose: Comprehensive optimization roadmap for future sessions

## Overview

This document contains prioritized optimization tasks identified through codebase analysis.
Each item has specific file:line references and expected impact estimates.

---

## HIGH PRIORITY OPTIMIZATIONS

### 1. String Concatenation in Hot Paths
- **Files**: `src/session.ts:460, 677-686`, `src/respawn-controller.ts:469, 826`, `src/inner-loop-tracker.ts:408`
- **Issue**: String `+=` in terminal buffer accumulation creates GC pressure
- **Fix**: Use array-based accumulation with periodic joins
- **Impact**: 10-20% faster terminal streaming

### 2. Regex Pattern lastIndex Reset
- **Files**: `src/inner-loop-tracker.ts:464-479`, `src/screen-manager.ts:264`
- **Issue**: Global regex without lastIndex reset causes skip-every-other-match bug
- **Fix**: Always reset `pattern.lastIndex = 0` before use
- **Impact**: Correct pattern matching, eliminate intermittent bugs

### 3. Unbounded Buffer Growth
- **Files**: `src/respawn-controller.ts:268-269`, `src/inner-loop-tracker.ts:257-258`
- **Issue**: Buffers lack proper size limits or have loose limits
- **Fix**: Add hard limits with Ring Buffer pattern
- **Impact**: Bounded memory, prevent OOM in long sessions

### 4. Event Listener Management
- **Files**: `src/respawn-controller.ts:446-455`, `src/session.ts:481-501`, `src/web/server.ts:987-1084`
- **Issue**: Listeners created repeatedly without cleanup tracking
- **Fix**: Use debounce/throttle utilities, consolidate timeout management
- **Impact**: Fewer memory leaks, reduced GC sweeps

### 5. Task Lookup Optimization
- **Files**: `src/task-tracker.ts:214-220, 231-234`
- **Issue**: O(n) sequential iteration for task lookups
- **Fix**: Add secondary indices `runningTasksByType: Map<string, Set<string>>`
- **Impact**: O(1) lookups, faster with 1000+ tasks

---

## MEDIUM PRIORITY OPTIMIZATIONS

### 6. Pattern Test Result Caching
- **Files**: `src/inner-loop-tracker.ts:529-543`
- **Issue**: Multiple pattern tests on same data without caching
- **Fix**: Use `.exec()` once and reuse result
- **Impact**: 2-3x faster todo detection

### 7. Dynamic Terminal Batching
- **Files**: `src/web/server.ts:46, 1350-1360`
- **Issue**: 16ms flush interval is too long for interactive sessions
- **Fix**: Flush immediately if batch > 1KB OR timeout 16ms
- **Impact**: Snappier UI feel

### 8. Buffer Pagination
- **Files**: `src/session.ts:314-365`, `src/web/server.ts:219-224`
- **Issue**: Full buffer sent on every state update
- **Fix**: Add `/api/sessions/:id/history?offset=X&limit=Y`
- **Impact**: 10-100x faster reconnects

### 9. Remove Unused Regex Patterns
- **Files**: `src/respawn-controller.ts:52-59`
- **Issue**: ANSI_ESCAPE_PATTERN, WHITESPACE_PATTERN marked @deprecated but still compiled
- **Fix**: Remove unused patterns
- **Impact**: Cleaner code, slightly faster startup

### 10. State Serialization
- **Files**: `src/state-store.ts:80, 196`, `src/web/server.ts:1343`
- **Issue**: Full JSON.stringify on every save
- **Fix**: Incremental or selective serialization
- **Impact**: 5-10x faster state saves

---

## LOW PRIORITY OPTIMIZATIONS

### 11. Error Handling Consistency
- **Files**: `src/screen-manager.ts:101-104`, `src/session.ts:726-729`, `src/web/server.ts:838-845`
- **Issue**: Mix of try-catch and error codes
- **Fix**: Create ErrorRegistry, standardize responses
- **Impact**: Better debugging

### 12. TypeScript Strict Typing
- **Files**: `src/task-tracker.ts:179`, `src/web/server.ts:138, 174`
- **Issue**: Some implicit `any` types
- **Fix**: Strong typing for all messages and payloads
- **Impact**: Better IDE support, fewer runtime errors

### 13. Dead Code Removal
- **Files**: `src/task.ts`, `src/task-queue.ts`, `src/ralph-loop.ts`
- **Issue**: Potentially unused files
- **Fix**: Verify imports, remove unused
- **Impact**: Cleaner codebase

### 14. Console Logging
- **Files**: Throughout `src/session.ts`, `src/respawn-controller.ts`, `src/screen-manager.ts`
- **Issue**: Debug logs not disabled in production
- **Fix**: Use logger abstraction with levels
- **Impact**: Cleaner logs

### 15. Magic Numbers
- **Files**: `src/session.ts:397, 428`, `src/respawn-controller.ts:614, 619`
- **Issue**: Hardcoded timeout values
- **Fix**: Extract to named constants
- **Impact**: Easier tuning

---

## Implementation Phases

### Phase 1 (Critical) - Items #1-5
- Time: 8-12 hours
- Expected Gain: 30% performance

### Phase 2 (Important) - Items #6-10
- Time: 6-8 hours
- Expected Gain: 15% performance

### Phase 3 (Polish) - Items #11-15
- Time: 4-6 hours
- Expected Gain: 5% + code quality

---

## Progress Tracking

| Item | Status | Completed By | Notes |
|------|--------|--------------|-------|
| 1 | ☐ Pending | | |
| 2 | ☐ Pending | | |
| 3 | ☐ Pending | | |
| 4 | ☐ Pending | | |
| 5 | ☐ Pending | | |
| 6 | ☐ Pending | | |
| 7 | ☐ Pending | | |
| 8 | ☐ Pending | | |
| 9 | ☐ Pending | | |
| 10 | ☐ Pending | | |
| 11 | ☐ Pending | | |
| 12 | ☐ Pending | | |
| 13 | ☐ Pending | | |
| 14 | ☐ Pending | | |
| 15 | ☐ Pending | | |
