// Codeman — Shared constants and utility functions for frontend modules

// ============================================================================
// Web Push Utilities
// ============================================================================

/** Convert a base64-encoded VAPID key to Uint8Array for pushManager.subscribe() */
function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

// ============================================================================
// Constants
// ============================================================================

// Default terminal scrollback (can be changed via settings)
const DEFAULT_SCROLLBACK = 5000;

// Timing constants
const STUCK_THRESHOLD_DEFAULT_MS = 600000;  // 10 minutes - default for stuck detection
const GROUPING_TIMEOUT_MS = 5000;           // 5 seconds - notification grouping window
const NOTIFICATION_LIST_CAP = 100;          // Max notifications in list
const TITLE_FLASH_INTERVAL_MS = 1500;       // Title flash rate
const BROWSER_NOTIF_RATE_LIMIT_MS = 3000;   // Rate limit for browser notifications
const AUTO_CLOSE_NOTIFICATION_MS = 8000;    // Auto-close browser notifications
const THROTTLE_DELAY_MS = 100;              // General UI throttle delay
const TERMINAL_CHUNK_SIZE = 128 * 1024;     // 128KB chunks for terminal data
const TERMINAL_TAIL_SIZE = 256 * 1024;      // 256KB tail for initial load
const SYNC_WAIT_TIMEOUT_MS = 50;            // Wait timeout for terminal sync
const STATS_POLLING_INTERVAL_MS = 2000;     // System stats polling

// Z-index base values for layered floating windows
const ZINDEX_SUBAGENT_BASE = 1000;
const ZINDEX_PLAN_SUBAGENT_BASE = 1100;
const ZINDEX_LOG_VIEWER_BASE = 2000;
const ZINDEX_IMAGE_POPUP_BASE = 3000;

// Subagent/floating window layout
const WINDOW_INITIAL_TOP_PX = 120;
const WINDOW_CASCADE_OFFSET_PX = 30;
const WINDOW_MIN_WIDTH_PX = 200;
const WINDOW_MIN_HEIGHT_PX = 200;
const WINDOW_DEFAULT_WIDTH_PX = 300;

// Scheduler API — prioritize terminal writes over background UI updates.
// scheduler.postTask('background') defers non-critical work (connection lines, panel renders)
// so the main thread stays free for terminal rendering at 60fps.
const _hasScheduler = typeof globalThis.scheduler?.postTask === 'function';
function scheduleBackground(fn) {
  if (_hasScheduler) { scheduler.postTask(fn, { priority: 'background' }); }
  else { requestAnimationFrame(fn); }
}

// DEC mode 2026 - Synchronized Output
// Wrap terminal writes with these markers to prevent partial-frame flicker.
// Terminal buffers all output between markers and renders atomically.
// Supported by: WezTerm, Kitty, Ghostty, iTerm2 3.5+, Windows Terminal, VSCode terminal
// xterm.js doesn't support DEC 2026 natively, so we implement buffering ourselves.
const DEC_SYNC_START = '\x1b[?2026h';
const DEC_SYNC_END = '\x1b[?2026l';
// Pre-compiled regex for stripping DEC 2026 markers (single pass instead of two replaceAll calls)
const DEC_SYNC_STRIP_RE = /\x1b\[\?2026[hl]/g;

// Built-in respawn configuration presets
const BUILTIN_RESPAWN_PRESETS = [
  {
    id: 'solo-work',
    name: 'Solo',
    description: 'Claude working alone — fast respawn cycles with context reset',
    config: {
      idleTimeoutMs: 3000,
      updatePrompt: 'summarize your progress so far before the context reset.',
      interStepDelayMs: 2000,
      sendClear: true,
      sendInit: true,
      kickstartPrompt: 'continue working. Pick up where you left off based on the context above.',
      autoAcceptPrompts: true,
    },
    durationMinutes: 60,
    builtIn: true,
    createdAt: 0,
  },
  {
    id: 'subagent-workflow',
    name: 'Subagents',
    description: 'Lead session with Task tool subagents — longer idle tolerance',
    config: {
      idleTimeoutMs: 45000,
      updatePrompt: 'check on your running subagents and summarize their results before the context reset. If all subagents have finished, note what was completed and what remains.',
      interStepDelayMs: 3000,
      sendClear: true,
      sendInit: true,
      kickstartPrompt: 'check on your running subagents and continue coordinating their work. If all subagents have finished, summarize their results and proceed with the next step.',
      autoAcceptPrompts: true,
    },
    durationMinutes: 240,
    builtIn: true,
    createdAt: 0,
  },
  {
    id: 'team-lead',
    name: 'Team',
    description: 'Leading an agent team via TeamCreate — tolerates long silences',
    config: {
      idleTimeoutMs: 90000,
      updatePrompt: 'review the task list and teammate progress. Summarize the current state before the context reset.',
      interStepDelayMs: 5000,
      sendClear: true,
      sendInit: true,
      kickstartPrompt: 'check on your teammates by reviewing the task list and any messages in your inbox. Assign new tasks if teammates are idle, or continue coordinating the team effort.',
      autoAcceptPrompts: true,
    },
    durationMinutes: 480,
    builtIn: true,
    createdAt: 0,
  },
  {
    id: 'ralph-todo',
    name: 'Ralph/Todo',
    description: 'Ralph Loop task list — works through todos with progress tracking',
    config: {
      idleTimeoutMs: 8000,
      updatePrompt: 'update CLAUDE.md with discoveries and progress notes, mark completed tasks in @fix_plan.md, write a brief summary so the next cycle can continue seamlessly.',
      interStepDelayMs: 3000,
      sendClear: true,
      sendInit: true,
      kickstartPrompt: 'read @fix_plan.md for task status, continue on the next uncompleted task. When ALL tasks are complete, output <promise>COMPLETE</promise>.',
      autoAcceptPrompts: true,
    },
    durationMinutes: 480,
    builtIn: true,
    createdAt: 0,
  },
  {
    id: 'overnight-autonomous',
    name: 'Overnight',
    description: 'Unattended overnight runs with full context reset between cycles',
    config: {
      idleTimeoutMs: 10000,
      updatePrompt: 'summarize what you accomplished so far and write key progress notes to CLAUDE.md so the next cycle can pick up where you left off.',
      interStepDelayMs: 3000,
      sendClear: true,
      sendInit: true,
      kickstartPrompt: 'continue working on the task. Pick up where you left off based on the context above.',
      autoAcceptPrompts: true,
    },
    durationMinutes: 480,
    builtIn: true,
    createdAt: 0,
  },
];

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Get unified coordinates from mouse or touch event.
 * @param {MouseEvent|TouchEvent} e - The event
 * @returns {{ clientX: number, clientY: number }} Coordinates
 */
function getEventCoords(e) {
  if (e.touches && e.touches.length > 0) {
    return { clientX: e.touches[0].clientX, clientY: e.touches[0].clientY };
  }
  if (e.changedTouches && e.changedTouches.length > 0) {
    return { clientX: e.changedTouches[0].clientX, clientY: e.changedTouches[0].clientY };
  }
  return { clientX: e.clientX, clientY: e.clientY };
}

/**
 * Process data containing DEC 2026 sync markers.
 * Strips markers and returns segments that should be written atomically.
 * Each returned segment represents content between SYNC_START and SYNC_END.
 * Content outside sync blocks is returned as-is.
 *
 * @param {string} data - Raw terminal data with potential sync markers
 * @returns {string[]} - Array of content segments to write (markers stripped)
 */
function extractSyncSegments(data) {
  const segments = [];
  let remaining = data;

  while (remaining.length > 0) {
    const startIdx = remaining.indexOf(DEC_SYNC_START);

    if (startIdx === -1) {
      // No more sync blocks, return rest as-is
      if (remaining.length > 0) {
        segments.push(remaining);
      }
      break;
    }

    // Content before sync block (if any)
    if (startIdx > 0) {
      segments.push(remaining.slice(0, startIdx));
    }

    // Find matching end marker
    const afterStart = remaining.slice(startIdx + DEC_SYNC_START.length);
    const endIdx = afterStart.indexOf(DEC_SYNC_END);

    if (endIdx === -1) {
      // No end marker found - sync block continues in next chunk
      // Include the start marker so it can be handled when more data arrives
      segments.push(remaining.slice(startIdx));
      break;
    }

    // Extract synchronized content (without markers)
    const syncContent = afterStart.slice(0, endIdx);
    if (syncContent.length > 0) {
      segments.push(syncContent);
    }

    // Continue with content after end marker
    remaining = afterStart.slice(endIdx + DEC_SYNC_END.length);
  }

  return segments;
}

// HTML escape utility (shared by NotificationManager, CodemanApp, and ralph-wizard.js)
const _htmlEscapeMap = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const _htmlEscapePattern = /[&<>"']/g;
function escapeHtml(text) {
  if (typeof text !== 'string') return '';
  return text.replace(_htmlEscapePattern, (ch) => _htmlEscapeMap[ch]);
}
