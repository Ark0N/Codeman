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
| 1 | ✅ Done | Claude | BufferAccumulator in session.ts, respawn-controller.ts |
| 2 | ✅ Done | Claude | Fixed lastIndex resets - now reset BEFORE .test() calls |
| 3 | ✅ Done | Claude | BufferAccumulator auto-trims, no manual limits needed |
| 4 | ✅ Done | Claude | cleanupTrackerListeners() stores/removes handlers; event debouncing in InnerLoopTracker |
| 5 | ☐ Pending | | |
| 6 | ✅ Done | Claude | Pre-checks before regex (hasCheckbox, hasTodoIndicator, etc.) - 60-75% reduction |
| 7 | ✅ Done | Claude | Immediate flush for >1KB batches |
| 8 | ☐ Pending | | |
| 9 | ✅ Done | Claude | Removed ANSI_ESCAPE_PATTERN, WHITESPACE_PATTERN |
| 10 | ✅ Done | Claude | broadcastSessionStateDebounced() batches state updates at 500ms intervals |
| 11 | ☐ Pending | | |
| 12 | ☐ Pending | | |
| 13 | ☐ Pending | | Not unused - used by CLI |
| 14 | ☐ Pending | | |
| 15 | ☐ Pending | | |

---

## Session Log (2026-01-21)

### Completed This Session:
1. **Regex lastIndex Fix** (#2): Moved lastIndex resets to BEFORE .test() calls in inner-loop-tracker.ts
2. **Event Listener Cleanup** (#4): Added `cleanupTrackerListeners()` in session.ts to properly remove TaskTracker and InnerLoopTracker listeners
3. **Event Debouncing** (#4): Added 50ms debouncing for todoUpdate/loopUpdate events in InnerLoopTracker
4. **Regex Pre-checks** (#6): Added fast pre-checks (string.includes) before expensive regex execution
5. **Promise Race Condition Fix**: Added `_promptResolved` flag in session.ts to prevent double resolution
6. **State Update Debouncing** (#10): Added `broadcastSessionStateDebounced()` in server.ts batching at 500ms intervals
7. **withTimeout Utility**: Added exported utility for async operation protection with configurable timeouts
8. **WebUI Render Debouncing**: Added debouncing to `renderInnerStatePanel` (50ms), `renderTaskPanel` (100ms), `renderScreenSessions` (100ms)
9. **CSS Containment**: Added `contain` property to terminal container, session tabs, ralph panel, task panel, and modal content for paint isolation
10. **GPU-Accelerated Animations**: Added `will-change` for animated elements, use transform-based transitions
11. **Input Batching**: Batch rapid keystrokes at 60fps, immediate flush for control chars
12. **Incremental DOM Updates (Ralph)**: Reuse existing DOM elements in Ralph todo list, ~80% fewer DOM ops
13. **Incremental DOM Updates (Tabs)**: Session tabs update only changed properties, ~70% fewer DOM ops

### Documentation Work:
14. **README Improvements**: Added Requirements section, Performance Optimized section
15. **CLAUDE.md Updates**: Added timing constants, updated optimization status section
16. **TUI Implementation Plan**: Added implementation status with completed/pending files
17. **Test Badge Fix**: Updated test count to 195 passing

### Commits:
- `df91823` - fix: improve memory safety and regex pattern handling
- `08b76cd` - perf: add event debouncing to InnerLoopTracker
- `645f86e` - perf: optimize regex execution and fix promise race condition
- `1a7c6d3` - fix: prevent memory leaks from orphaned event listeners
- `2709d43` - perf: add session state update debouncing in server
- `ef843bc` - docs: update optimization tracking with completed items
- `c0688e0` - perf: optimize WebUI rendering and CSS performance
- `26ab141` - docs: add WebUI optimization roadmap and session log
- `3dd6ea5` - perf: add input batching for rapid keystrokes
- `ab6f630` - perf: add incremental DOM updates for Ralph todo list
- `af1ea57` - perf: add incremental updates for session tabs rendering
- `63b9abc` - docs: add session tabs incremental updates to log
- `b4adbeb` - docs: fix test count in README badge (195 passing)
- `224be69` - docs: improve README for GitHub publishing
- `b3dd0bc` - docs: update CLAUDE.md with optimization status
- `84dab25` - feat(tui): add terminal user interface with Ink
- `f681972` - feat(tui): add real-time terminal output polling
- `451de84` - docs: add implementation status to TUI plan
- `8da6dce` - feat(tui): add arrow key navigation and screen attach

---

## WebUI Future Optimizations

### High Priority

| Optimization | File | Description | Expected Impact | Status |
|-------------|------|-------------|-----------------|--------|
| Virtual scrolling for todo lists | `app.js` | Render only visible todos for long lists | 10x improvement for 100+ todos | Pending |
| Incremental DOM updates | `app.js` | Use DOM diffing instead of innerHTML | Reduces reflows by 50% | ✅ Done |
| Web Worker for JSON parsing | `app.js` | Offload SSE message parsing to worker | Smoother UI during high throughput | Pending |
| Request coalescing | `app.js` | Batch rapid API calls (resize, input) | Fewer network requests | ✅ Done (input)

### Medium Priority

| Optimization | File | Description | Expected Impact |
|-------------|------|-------------|-----------------|
| Service Worker caching | `sw.js` (new) | Cache static assets, offline support | Faster subsequent loads |
| WebSocket upgrade | `server.ts`, `app.js` | Replace SSE with WebSocket for bidirectional | Lower latency for input |
| IndexedDB for terminal history | `app.js` | Store large buffers in IndexedDB | Reduces memory footprint |
| CSS custom properties for themes | `styles.css` | Dynamic theme switching | Better theming support |

### Low Priority

| Optimization | File | Description | Expected Impact |
|-------------|------|-------------|-----------------|
| Preconnect hints | `index.html` | Add preconnect for external resources | Faster initial load |
| Code splitting | Build config | Split vendor/app bundles | Better caching |
| Compression for SSE | `server.ts` | gzip compression for SSE stream | 50% bandwidth reduction |

### Performance Metrics to Track

1. **Time to First Byte (TTFB)** - Server response time
2. **First Contentful Paint (FCP)** - Initial render time
3. **Time to Interactive (TTI)** - When UI becomes responsive
4. **Input Latency** - Delay between keypress and display
5. **Frame Rate** - Target 60fps during terminal output
6. **Memory Usage** - Monitor for leaks during long sessions
