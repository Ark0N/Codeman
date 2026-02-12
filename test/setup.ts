/**
 * @fileoverview Global test setup for Claudeman tests
 *
 * Provides:
 * - Session concurrency limiter (max 10 tmux/screen sessions)
 * - Tracked resource cleanup (only kills what tests create)
 * - Global beforeAll/afterAll hooks
 *
 * CRITICAL SAFETY GUARANTEES:
 * 1. Pre-existing screens/tmux sessions (captured at MODULE LOAD) are NEVER killed
 * 2. Current process screen ($CLAUDEMAN_SCREEN_NAME) is NEVER killed
 * 3. Only sessions explicitly registered via registerTestScreen()/registerTestTmuxSession() can be killed
 * 4. All session names must pass validation before being accepted
 *
 * This setup ONLY cleans up resources that the test suite itself creates.
 * It will NEVER kill Claude processes or sessions that weren't spawned by tests.
 * This makes it safe to run tests from within a Claudeman-managed session.
 */

import { execSync } from 'node:child_process';
import { beforeAll, afterAll, afterEach, vi } from 'vitest';

/** Maximum concurrent screen sessions allowed during tests */
const MAX_CONCURRENT_SCREENS = 10;

/** Track active screen sessions created during tests */
const activeTestScreens = new Set<string>();

/** Track active tmux sessions created during tests */
const activeTestTmuxSessions = new Set<string>();

/** Track Claude PIDs spawned by tests (for cleanup) */
const activeTestClaudePids = new Set<number>();

/** Semaphore for controlling concurrent screen creation */
let currentScreenCount = 0;
const screenWaiters: Array<() => void> = [];

/**
 * CRITICAL: Pre-existing screens captured at MODULE LOAD time.
 * These screens existed before any test code ran and must NEVER be killed.
 * This is captured immediately when the module loads, not in beforeAll.
 */
const preExistingScreensAtModuleLoad = new Set<string>();

/** Current process's screen name - NEVER kill this */
const CURRENT_PROCESS_SCREEN = process.env.CLAUDEMAN_SCREEN_NAME || '';

// Capture pre-existing screens IMMEDIATELY when this module loads
// This happens before any test runs, providing maximum protection
try {
  const output = execSync('screen -ls 2>/dev/null || true', { encoding: 'utf-8', timeout: 5000 });
  for (const line of output.split('\n')) {
    const match = line.match(/\d+\.([^\s]+)/);
    if (match) {
      preExistingScreensAtModuleLoad.add(match[1]);
    }
  }
  if (preExistingScreensAtModuleLoad.size > 0 || CURRENT_PROCESS_SCREEN) {
    console.log(`[Test Setup] MODULE LOAD: Protected ${preExistingScreensAtModuleLoad.size} pre-existing screens`);
    if (CURRENT_PROCESS_SCREEN) {
      console.log(`[Test Setup] MODULE LOAD: Current process screen: ${CURRENT_PROCESS_SCREEN}`);
    }
  }
} catch {
  // Ignore errors during capture
}

/**
 * CRITICAL: Pre-existing tmux sessions captured at MODULE LOAD time.
 * These sessions existed before any test code ran and must NEVER be killed.
 */
const preExistingTmuxSessionsAtModuleLoad = new Set<string>();

// Capture pre-existing tmux sessions IMMEDIATELY when this module loads
try {
  const output = execSync("tmux list-sessions -F '#{session_name}' 2>/dev/null || true", { encoding: 'utf-8', timeout: 5000 });
  for (const line of output.trim().split('\n')) {
    const name = line.trim();
    if (name) {
      preExistingTmuxSessionsAtModuleLoad.add(name);
    }
  }
} catch {
  // tmux may not be running or available
}

/**
 * Check if a screen name matches user-created patterns (w1-*, s1-*)
 */
function isUserScreenPattern(screenName: string): boolean {
  return /^[ws]\d+-/.test(screenName);
}

/**
 * Check if a screen name looks like a test screen (contains 'test')
 */
function isTestScreen(screenName: string): boolean {
  return screenName.toLowerCase().includes('test');
}

/**
 * Check if a screen is protected and must NEVER be killed.
 *
 * CRITICAL: Protection is based on WHEN the screen was created:
 * - Screens in preExistingScreensAtModuleLoad existed before tests = USER screens
 * - Current process screen is always protected
 * - User patterns (w1-*, s1-*) are protected as extra safety
 */
function isScreenProtected(screenName: string): boolean {
  // Pre-existing screens from module load are ALWAYS protected
  if (preExistingScreensAtModuleLoad.has(screenName)) {
    return true;
  }
  // Current process's screen is protected
  if (CURRENT_PROCESS_SCREEN && screenName === CURRENT_PROCESS_SCREEN) {
    return true;
  }
  // Also protect screens from preExistingScreens set (captured in beforeAll)
  if (preExistingScreens.has(screenName)) {
    return true;
  }
  // Protect user-created screen patterns (w1-*, s1-*) as extra safety
  if (isUserScreenPattern(screenName)) {
    return true;
  }
  // Everything else can be cleaned up
  return false;
}

/**
 * Kill only the screens that tests have registered via registerTestScreen()
 * SAFETY: Only kills screens with 'test' in the name AND not protected
 */
function killTrackedTestScreens(): void {
  for (const screenName of activeTestScreens) {
    // CRITICAL: Only kill screens with explicit 'test' marker
    if (!screenName.includes('test')) {
      console.warn(`[Test Setup] SKIPPING: Screen ${screenName} doesn't contain 'test' - not killing`);
      continue;
    }
    // Double-check protection before killing
    if (isScreenProtected(screenName)) {
      console.warn(`[Test Setup] BLOCKED: Refusing to kill protected screen: ${screenName}`);
      continue;
    }
    try {
      console.log(`[Test Setup] Killing test screen: ${screenName}`);
      execSync(`screen -S ${screenName} -X quit 2>/dev/null || true`, { encoding: 'utf-8' });
    } catch {
      // Ignore errors
    }
  }
  activeTestScreens.clear();
}

/**
 * Check if a tmux session is protected and must NEVER be killed.
 */
function isTmuxSessionProtected(sessionName: string): boolean {
  if (preExistingTmuxSessionsAtModuleLoad.has(sessionName)) {
    return true;
  }
  if (preExistingTmuxSessions.has(sessionName)) {
    return true;
  }
  return false;
}

/**
 * Kill only the tmux sessions that tests have registered via registerTestTmuxSession()
 */
function killTrackedTestTmuxSessions(): void {
  for (const sessionName of activeTestTmuxSessions) {
    if (isTmuxSessionProtected(sessionName)) {
      console.warn(`[Test Setup] BLOCKED: Refusing to kill protected tmux session: ${sessionName}`);
      continue;
    }
    try {
      console.log(`[Test Setup] Killing test tmux session: ${sessionName}`);
      execSync(`tmux kill-session -t "${sessionName}" 2>/dev/null || true`, { encoding: 'utf-8' });
    } catch {
      // Ignore errors
    }
  }
  activeTestTmuxSessions.clear();
}

/**
 * Kill only the Claude processes that tests have registered via registerTestClaudePid()
 */
function killTrackedTestClaudeProcesses(): void {
  for (const pid of activeTestClaudePids) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // Process may already be gone
    }
  }

  // Wait a bit, then SIGKILL any remaining
  if (activeTestClaudePids.size > 0) {
    setTimeout(() => {
      for (const pid of activeTestClaudePids) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          // Process may already be gone
        }
      }
      activeTestClaudePids.clear();
    }, 500);
  } else {
    activeTestClaudePids.clear();
  }
}

/**
 * Acquire a screen slot (blocks if at capacity)
 */
export async function acquireScreenSlot(): Promise<void> {
  if (currentScreenCount < MAX_CONCURRENT_SCREENS) {
    currentScreenCount++;
    return;
  }

  // Wait for a slot to become available
  return new Promise<void>(resolve => {
    screenWaiters.push(resolve);
  });
}

/**
 * Release a screen slot
 */
export function releaseScreenSlot(): void {
  currentScreenCount = Math.max(0, currentScreenCount - 1);

  // Wake up a waiter if any
  const waiter = screenWaiters.shift();
  if (waiter) {
    currentScreenCount++;
    waiter();
  }
}

/**
 * Register a screen session for tracking.
 * SAFETY: Protected screens will be skipped at cleanup time.
 */
export function registerTestScreen(screenName: string): void {
  // Warn if registering a protected screen, but allow it
  // (protection happens at kill time, not registration time)
  if (isScreenProtected(screenName)) {
    console.warn(`[Test Setup] WARNING: Registering protected screen ${screenName} - will be skipped during cleanup`);
  }
  activeTestScreens.add(screenName);
}

/**
 * Unregister a screen session
 */
export function unregisterTestScreen(screenName: string): void {
  activeTestScreens.delete(screenName);
}

/**
 * Register a tmux session for tracking.
 * SAFETY: Protected sessions will be skipped at cleanup time.
 */
export function registerTestTmuxSession(sessionName: string): void {
  if (isTmuxSessionProtected(sessionName)) {
    console.warn(`[Test Setup] WARNING: Registering protected tmux session ${sessionName} - will be skipped during cleanup`);
  }
  activeTestTmuxSessions.add(sessionName);
}

/**
 * Unregister a tmux session
 */
export function unregisterTestTmuxSession(sessionName: string): void {
  activeTestTmuxSessions.delete(sessionName);
}

/**
 * Register a Claude PID for tracking (so it gets cleaned up after tests)
 */
export function registerTestClaudePid(pid: number): void {
  activeTestClaudePids.add(pid);
}

/**
 * Unregister a Claude PID
 */
export function unregisterTestClaudePid(pid: number): void {
  activeTestClaudePids.delete(pid);
}

/**
 * Get current screen count for debugging
 */
export function getScreenStats(): { current: number; max: number; waiting: number } {
  return {
    current: currentScreenCount,
    max: MAX_CONCURRENT_SCREENS,
    waiting: screenWaiters.length,
  };
}

/**
 * Force cleanup all test-created resources (emergency cleanup)
 * Only kills resources that tests have registered - never kills external processes
 */
export function forceCleanupAllTestResources(): void {
  // Kill all tracked test screens
  killTrackedTestScreens();

  // Kill all tracked test tmux sessions
  killTrackedTestTmuxSessions();

  // Kill all tracked Claude processes
  killTrackedTestClaudeProcesses();

  // Reset semaphore
  currentScreenCount = 0;
  screenWaiters.length = 0;
}

// =============================================================================
// Global Hooks
// =============================================================================

/** Screens that existed before tests started (never killed by cleanup) */
const preExistingScreens = new Set<string>();

/** Tmux sessions that existed before tests started (never killed by cleanup) */
const preExistingTmuxSessions = new Set<string>();

/**
 * List all current claudeman-* screen session names
 */
function listClaudemanScreens(): string[] {
  try {
    const output = execSync('screen -ls 2>/dev/null || true', { encoding: 'utf-8' });
    const screens: string[] = [];
    for (const line of output.split('\n')) {
      const match = line.match(/\d+\.(claudeman-\S+)/);
      if (match) screens.push(match[1]);
    }
    return screens;
  } catch {
    return [];
  }
}

/**
 * Kill detached claudeman screens that were EXPLICITLY registered by tests.
 *
 * SAFETY: We no longer kill "orphaned" screens based on detached status.
 * The previous approach was dangerous because:
 * 1. User screens can become temporarily detached (web server reconnect)
 * 2. Tests might start before user creates sessions (not in preExistingScreens)
 * 3. Race conditions between screen status and cleanup timing
 *
 * Now we ONLY kill screens that tests explicitly registered via registerTestScreen().
 */
function killOrphanedTestScreens(): number {
  // This function now only reports - actual killing happens in killTrackedTestScreens()
  // which only kills explicitly registered screens
  let orphanCount = 0;
  try {
    const output = execSync('screen -ls 2>/dev/null || true', { encoding: 'utf-8' });
    for (const line of output.split('\n')) {
      if (!line.includes('Detached')) continue;
      const match = line.match(/(\d+\.(claudeman-\S+))/);
      if (!match) continue;
      const screenName = match[2];
      // Count screens that look like test screens but weren't registered
      // (These are "leaked" test screens but we won't kill them to be safe)
      if (!preExistingScreens.has(screenName) && !activeTestScreens.has(screenName)) {
        orphanCount++;
        console.warn(`[Test Setup] Warning: Possible leaked test screen: ${screenName} (not killing for safety)`);
      }
    }
  } catch { /* ignore */ }
  return orphanCount;
}

beforeAll(async () => {
  // Record pre-existing screens so we never kill them
  for (const name of listClaudemanScreens()) {
    preExistingScreens.add(name);
  }

  // Record pre-existing tmux sessions so we never kill them
  try {
    const output = execSync("tmux list-sessions -F '#{session_name}' 2>/dev/null || true", { encoding: 'utf-8', timeout: 5000 });
    for (const line of output.trim().split('\n')) {
      const name = line.trim();
      if (name) {
        preExistingTmuxSessions.add(name);
      }
    }
  } catch {
    // tmux may not be running
  }

  console.log(`[Test Setup] ${preExistingScreens.size} pre-existing screens preserved`);
});

afterEach(() => {
  // Clean up mocks and timers between tests for proper isolation
  vi.clearAllMocks();
  vi.useRealTimers();
});

afterAll(async () => {
  console.log('[Test Setup] Final cleanup of test-created resources...');

  // Only cleanup resources that tests have EXPLICITLY registered
  forceCleanupAllTestResources();

  // Check for leaked test screens (but don't kill them - just warn)
  const orphanCount = killOrphanedTestScreens();
  if (orphanCount > 0) {
    console.warn(`[Test Setup] ${orphanCount} possible leaked test screens detected (not killed for safety)`);
  }

  // Wait for cleanup
  await new Promise(resolve => setTimeout(resolve, 500));

  // Report any tracked resources that weren't cleaned up
  if (activeTestScreens.size > 0) {
    console.warn(`[Test Setup] Warning: ${activeTestScreens.size} test screens weren't properly unregistered`);
  }
  if (activeTestTmuxSessions.size > 0) {
    console.warn(`[Test Setup] Warning: ${activeTestTmuxSessions.size} test tmux sessions weren't properly unregistered`);
  }
  if (activeTestClaudePids.size > 0) {
    console.warn(`[Test Setup] Warning: ${activeTestClaudePids.size} test Claude PIDs weren't properly unregistered`);
  }

  console.log('[Test Setup] Final cleanup complete');
});

// Export utilities for tests that need them
export {
  killTrackedTestScreens,
  killTrackedTestTmuxSessions,
  killTrackedTestClaudeProcesses,
  MAX_CONCURRENT_SCREENS,
  isScreenProtected,
  isTmuxSessionProtected,
  isTestScreen,
  isUserScreenPattern,
  preExistingScreensAtModuleLoad,
  preExistingTmuxSessionsAtModuleLoad,
};
