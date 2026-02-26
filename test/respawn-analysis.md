# Respawn Controller Test Analysis

**Date**: 2026-01-25
**Analyzed Files**:
- `/home/arkon/default/codeman/src/respawn-controller.ts`
- `/home/arkon/default/codeman/src/ai-idle-checker.ts`
- `/home/arkon/default/codeman/src/ai-plan-checker.ts`
- `/home/arkon/default/codeman/test/respawn-controller.test.ts`

---

## 1. Test Execution Results

### Summary
- **Total Tests**: 91
- **Passed**: 91
- **Failed**: 0
- **Duration**: ~10 seconds

### Type Check Results
- **Type Errors**: 0

All tests pass and the codebase is type-safe.

---

## 2. Code Coverage Analysis

### Coverage Summary

| File | Statements | Branches | Functions | Lines |
|------|------------|----------|-----------|-------|
| respawn-controller.ts | 62.51% | 59.85% | 74.48% | 62.37% |
| ai-idle-checker.ts | 68.91% | 46.57% | 75% | 69.31% |
| ai-plan-checker.ts | 57.52% | 37.68% | 58.33% | 57.69% |

### Uncovered Code in respawn-controller.ts

The following areas lack test coverage:

1. **Lines 2077-2151**: `sendClear()`, `sendInit()`, `completeCycle()`
   - These functions execute during the full respawn cycle
   - Tests trigger cycles but don't mock session responses to complete them

2. **Line 2162**: `checkIdleAndMaybeStart()`
   - Called when resuming from pause while already idle
   - Only tested superficially with `resume()` call

3. **Lines 2100-2103**: Clear fallback timer path when `sendInit` is false
   - Edge case where `/clear` completes via fallback but init is disabled

---

## 3. Potential Bugs and Issues

### Issue 1: E2BIG Error in ai-plan-checker.ts (HIGH)

**File**: `/home/arkon/default/codeman/src/ai-plan-checker.ts`
**Lines**: 341-346
**Severity**: HIGH

**Description**: Unlike `ai-idle-checker.ts`, the plan checker passes the prompt directly as a shell argument rather than via a temp file. This can cause `E2BIG` (argument list too long) errors when the terminal buffer is large.

**Code**:
```typescript
// ai-plan-checker.ts - PROBLEMATIC
const escapedPrompt = prompt.replace(/'/g, "'\\''");
const claudeCmd = `claude -p ${modelArg} --output-format text '${escapedPrompt}'`;

// ai-idle-checker.ts - CORRECT
writeFileSync(this.checkPromptFile, prompt);
const claudeCmd = `cat "${this.checkPromptFile}" | claude -p ${modelArg} --output-format text`;
```

**Impact**: With `maxContextChars: 8000`, the prompt can easily exceed shell argument limits (~128KB on most systems), causing the AI plan check to fail with a cryptic error.

**Suggested Fix**: Modify `ai-plan-checker.ts` to use the same temp file approach as `ai-idle-checker.ts`:
1. Add `checkPromptFile` instance variable
2. Write prompt to temp file
3. Use `cat | claude -p` pattern
4. Clean up temp file in `cleanupCheck()`

---

### Issue 2: Missing Prompt File Cleanup on Timeout (MEDIUM)

**File**: `/home/arkon/default/codeman/src/ai-idle-checker.ts`
**Lines**: 392-398
**Severity**: MEDIUM

**Description**: When the AI check times out, the `cleanupCheck()` function is called via `finally`. However, the prompt file deletion in `cleanupCheck()` may fail silently if the file is still being read by the `cat` command in the spawned screen.

**Impact**: Temp files may accumulate in `/tmp` if checks frequently timeout.

**Suggested Fix**: Add a small delay before file deletion or use a unique timestamp-based naming scheme that guarantees no collisions (already partially implemented but the shell command `rm -f` in the fullCmd also handles this).

---

### Issue 3: Race Condition in cancel() with Promise Resolution (MEDIUM)

**File**: `/home/arkon/default/codeman/src/ai-idle-checker.ts`
**Lines**: 265-279
**Severity**: MEDIUM

**Description**: The `cancel()` method resolves the pending promise and then calls `cleanupCheck()`. However, the interval poll timer might fire between these two operations and attempt to resolve an already-resolved promise.

**Code**:
```typescript
cancel(): void {
  if (this._status !== 'checking') return;
  this.checkCancelled = true;
  // Race: poll timer might fire here
  if (this.checkResolve) {
    this.checkResolve({ verdict: 'ERROR', ... });
    this.checkResolve = null;
  }
  this.cleanupCheck(); // This clears the poll timer
  this._status = 'ready';
}
```

**Impact**: Could theoretically cause a double-resolve, though the guard `if (this.checkCancelled)` in the poll handler mitigates this.

**Suggested Fix**: Set `checkCancelled = true` and call `cleanupCheck()` (which clears the poll timer) before resolving the promise.

---

### Issue 4: Stale Screen Name Collision (LOW)

**File**: `/home/arkon/default/codeman/src/ai-idle-checker.ts`, `ai-plan-checker.ts`
**Lines**: 326-329 (idle), 333-336 (plan)
**Severity**: LOW

**Description**: Screen names are generated using only `sessionId.slice(0, 8)`, without a unique suffix. While there's a `screen -X quit` to kill leftover screens, two rapid checks could conflict.

**Code**:
```typescript
this.checkScreenName = `codeman-aicheck-${shortId}`;
```

**Impact**: Very unlikely in practice since checks have cooldowns, but theoretically possible.

**Suggested Fix**: Already partially mitigated by the `timestamp` in temp file names. Could add timestamp to screen name too:
```typescript
this.checkScreenName = `codeman-aicheck-${shortId}-${timestamp}`;
```

---

### Issue 5: DetectionStatus Calculation During ai_checking State (LOW)

**File**: `/home/arkon/default/codeman/src/respawn-controller.ts`
**Lines**: 759-762
**Severity**: LOW

**Description**: The `outputSilent` calculation uses `config.completionConfirmMs`, but when in `ai_checking` state, the output silence threshold should conceptually be the AI check timeout, not the completion confirm time.

**Impact**: UI display may show incorrect "silence" status during AI check.

---

## 4. Coverage Gaps

### Functions Not Fully Tested

1. **`sendClear()`** - Never reaches execution in tests because the cycle is cut short
2. **`sendInit()`** - Same as above
3. **`completeCycle()`** - Tests don't allow cycles to complete fully
4. **`checkClearComplete()`** - Requires mocking prompt detection after /clear
5. **`checkInitComplete()`** - Requires mocking init completion flow
6. **`sendKickstart()`** - Not tested at all
7. **`checkKickstartComplete()`** - Not tested
8. **`startMonitoringInit()`** - Not tested
9. **`checkMonitoringInitIdle()`** - Not tested

### Branches Not Tested

1. `/clear` fallback timer completing (line 2095-2105)
2. `sendInit: false` branch in various locations
3. Kickstart prompt flow when `/init` doesn't trigger work
4. AI checker returning `WORKING` verdict (only test with timeout)
5. AI plan checker `PLAN_MODE` verdict (real check, not just pre-filter)

### Edge Cases Not Tested

1. Multiple rapid AI checks before cooldown
2. AI checker disabled mid-check
3. Session terminal buffer being `undefined` on start
4. Buffer trimming behavior at MAX_RESPAWN_BUFFER_SIZE
5. `signalElicitation()` called multiple times

---

## 5. Timing and Race Condition Analysis

### Potential Timing Issues

1. **Pre-filter timer vs AI check**: If pre-filter fires while an AI check is already running, it correctly skips (line 1613).

2. **Completion confirm during AI check**: Output during AI check cancels it (line 1173-1188), which is correct.

3. **Auto-accept during respawn cycle**: Correctly guards against non-watching state (line 1741).

4. **Step confirm timer**: Uses same `completionConfirmMs` as idle confirm, which may be too short for complex operations.

### Timer Cleanup

All timers appear to be properly cleaned up in `clearTimers()`:
- `idleTimer`
- `stepTimer`
- `clearFallbackTimer`
- `completionConfirmTimer`
- `stepConfirmTimer`
- `autoAcceptTimer`
- `preFilterTimer`
- `noOutputTimer`
- `detectionUpdateTimer` (interval)

---

## 6. Recommendations (Prioritized)

### Critical (Should Fix)

1. **Fix E2BIG vulnerability in ai-plan-checker.ts**
   - Use temp file for prompt like ai-idle-checker.ts does
   - Add `checkPromptFile` instance variable
   - Update `cleanupCheck()` to delete prompt file

### High Priority

2. **Add integration tests for full respawn cycle**
   - Mock session to simulate prompt detection after each step
   - Test: update -> clear -> init -> back to watching
   - Test: kickstart prompt when init doesn't trigger work

3. **Fix cancel() race condition in AI checkers**
   - Clear poll timer before resolving promise
   - Or use a mutex/flag check in poll handler

### Medium Priority

4. **Add tests for AI checker WORKING verdict**
   - Mock the screen process to return WORKING
   - Verify cooldown is started
   - Verify controller returns to watching

5. **Add tests for plan checker PLAN_MODE verdict**
   - Mock the screen process to return PLAN_MODE
   - Verify Enter is sent
   - Verify state transitions

6. **Add timestamp to screen session names**
   - Prevents potential collisions during rapid operations

### Low Priority

7. **Improve coverage of edge cases**
   - Test `sendInit: false` and `sendClear: false` combinations
   - Test buffer trimming behavior
   - Test pause/resume with activity detection

8. **Consider reducing step confirm timeout**
   - Currently uses `completionConfirmMs` (10s default)
   - May want separate config for step confirmation

---

## 7. MockSession Limitations

The current `MockSession` class in tests is simplified and doesn't accurately simulate:

1. **Delayed responses**: Real sessions have processing time between input and output
2. **State persistence**: Real sessions maintain state between commands
3. **Screen integration**: Real sessions use GNU screen for persistence
4. **Token tracking**: Real sessions parse and track token usage

Consider adding a more sophisticated mock that can:
- Queue delayed responses
- Simulate multi-step workflows
- Return realistic completion messages with timing

---

## 8. Conclusion

The respawn controller tests are comprehensive for basic functionality but lack coverage for:
- Full respawn cycle completion
- AI checker verdicts (IDLE/WORKING/PLAN_MODE)
- Kickstart functionality
- Edge cases and error handling

The main bug found is in `ai-plan-checker.ts` which can fail with E2BIG errors on large terminal buffers. This should be fixed by using the temp file approach already implemented in `ai-idle-checker.ts`.

All 91 tests pass, and there are no type errors, indicating a stable codebase but with room for deeper integration testing.
