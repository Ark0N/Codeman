/**
 * @fileoverview Core UI controller for Codeman — tab-based terminal manager with xterm.js.
 *
 * Defines the CodemanApp class (constructor, init, SSE connection, session lifecycle, tabs,
 * navigation). Domain-specific methods are mixed in from separate modules via Object.assign:
 *
 *   terminal-ui.js   — Terminal setup, rendering pipeline, controls
 *   respawn-ui.js    — Respawn banner, countdown timers, presets, run summary
 *   ralph-panel.js   — Ralph state panel, fix_plan, plan versioning
 *   settings-ui.js   — App settings, visibility, web push, lifecycle log, tunnel/QR, help
 *   panels-ui.js     — Subagent panel, agent teams, project insights, file browser, log viewer,
 *                       image popups, monitor, token stats, toast, system stats
 *   session-ui.js    — Quick start, session options modal, case settings, mobile case picker
 *   ralph-wizard.js  — Ralph Loop wizard modal
 *   api-client.js    — API helper methods (fetch wrappers)
 *   subagent-windows.js — Floating subagent terminal windows
 *
 * ═══ Sections in this file ═══
 *
 *   SSE Handler Map            — Event-to-method routing table (resolves at runtime via `this`)
 *   CodemanApp Class           — Constructor and all state initialization (~80 properties)
 *   Pending Hooks              — Hook state machine for tab alerts
 *   Init                       — App bootstrap, mobile setup, WebGL init
 *   Event Listeners            — Keyboard shortcuts, resize, beforeunload
 *   SSE Connection             — connectSSE with exponential backoff (1-30s)
 *   Core SSE Event Handlers    — Session lifecycle, scheduled runs (~20 handlers)
 *   Connection Status          — Online detection, input queuing, state sync
 *   WebSocket Terminal I/O     — Low-latency WS bypass for terminal input
 *   Session Tabs               — Tab rendering, selection, drag-and-drop reordering
 *   Tab Order & Drag-and-Drop  — Persistent ordering with localStorage sync
 *   Session Lifecycle          — Select, close, navigate, rename, cleanup
 *   Navigation                 — goHome
 *   Kill Sessions              — Kill active/all sessions
 *   Timer / Tokens             — Session timer, token/cost display
 *   Module Init                — localStorage migration, app instantiation
 *
 * @class CodemanApp
 * @globals {CodemanApp} app - Singleton instance (also on window.app)
 *
 * @dependency constants.js (SSE_EVENTS, timing constants, escapeHtml, DEC_SYNC_STRIP_RE)
 * @dependency mobile-handlers.js (MobileDetection, KeyboardHandler, SwipeHandler)
 * @dependency voice-input.js (VoiceInput, DeepgramProvider)
 * @dependency notification-manager.js (NotificationManager class)
 * @dependency keyboard-accessory.js (KeyboardAccessoryBar, FocusTrap)
 * @dependency vendor/xterm.js, vendor/xterm-addon-fit.js, vendor/xterm-addon-webgl.js
 * @dependency vendor/xterm-zerolag-input.iife.js (LocalEchoOverlay)
 * @loadorder 6 of 15 — loaded after keyboard-accessory.js, before terminal-ui.js
 */

// Codeman App - Tab-based Terminal UI
// Constants, utilities, and escapeHtml() are in constants.js (loaded before this file)
// MobileDetection, KeyboardHandler, SwipeHandler are in mobile-handlers.js
// DeepgramProvider, VoiceInput are in voice-input.js

// ═══════════════════════════════════════════════════════════════
// Global Error & Performance Diagnostics
// ═══════════════════════════════════════════════════════════════
// Writes breadcrumbs to localStorage so they survive tab freezes.
// After a crash, check: localStorage.getItem('codeman-crash-diag')

const _crashDiag = {
  _entries: [],
  _maxEntries: 50,
  // Per-page-load id: the server keys beacons by it, so a reload (fresh id)
  // archives the previous page's trail instead of overwriting it, and
  // concurrent clients (desktop + phone) don't clobber each other.
  _pageId: Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8),
  log(msg) {
    const entry = `${new Date().toISOString().slice(11,23)} ${msg}`;
    this._entries.push(entry);
    if (this._entries.length > this._maxEntries) this._entries.shift();
    try { localStorage.setItem('codeman-crash-diag', this._entries.join('\n')); } catch {}
  }
};

// Log previous crash breadcrumbs on startup, and re-beacon them under a
// distinct page id — an iOS PWA reload wipes the in-memory trail, and without
// this the fresh page's first beacon would be all the server ever sees.
try {
  const prev = localStorage.getItem('codeman-crash-diag');
  if (prev) {
    console.log('[CRASH-DIAG] Previous session breadcrumbs:\n' + prev);
    navigator.sendBeacon(CodemanBase.url('/api/crash-diag'), JSON.stringify({ data: prev, id: _crashDiag._pageId + '-prev' }));
  }
} catch {}
_crashDiag.log('PAGE LOAD');

// Heartbeat: send breadcrumbs to server every 2s so they survive tab freezes.
function _crashDiagBeacon() {
  try {
    if (_crashDiag._entries.length > 0) {
      navigator.sendBeacon(CodemanBase.url('/api/crash-diag'), JSON.stringify({ data: _crashDiag._entries.join('\n'), id: _crashDiag._pageId }));
    }
  } catch {}
}
setInterval(() => {
  try { localStorage.setItem('codeman-crash-heartbeat', String(Date.now())); } catch {}
  _crashDiagBeacon();
}, 2000);
// iOS suspends JS the instant the app is backgrounded — entries logged since
// the last 2s tick would sit unsent until (if ever) the page resumes. Flush
// immediately on hide so a repro right before an app switch is never lost.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') _crashDiagBeacon();
});

window.addEventListener('error', (e) => {
  _crashDiag.log(`ERROR: ${e.message} at ${e.filename}:${e.lineno}`);
  console.error('[CRASH-DIAG] Uncaught error:', e.message, '\n  File:', e.filename, ':', e.lineno, ':', e.colno, '\n  Stack:', e.error?.stack);
});

window.addEventListener('unhandledrejection', (e) => {
  _crashDiag.log(`UNHANDLED: ${e.reason?.message || e.reason}`);
  console.error('[CRASH-DIAG] Unhandled promise rejection:', e.reason?.message || e.reason, '\n  Stack:', e.reason?.stack);
});

// Detect long tasks (>50ms main thread blocks) — these cause "page unresponsive"
if (typeof PerformanceObserver !== 'undefined') {
  try {
    const longTaskObserver = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (entry.duration > 200) {
          _crashDiag.log(`LONG_TASK: ${entry.duration.toFixed(0)}ms`);
          console.warn(`[CRASH-DIAG] Long task: ${entry.duration.toFixed(0)}ms (type: ${entry.entryType}, name: ${entry.name})`);
        }
      }
    });
    longTaskObserver.observe({ type: 'longtask', buffered: true });
  } catch { /* longtask not supported */ }
}

// Track WebGL context loss/restore events on all canvases
const _origGetContext = HTMLCanvasElement.prototype.getContext;
HTMLCanvasElement.prototype.getContext = function(type, ...args) {
  const ctx = _origGetContext.call(this, type, ...args);
  if (type === 'webgl2' || type === 'webgl') {
    this.addEventListener('webglcontextlost', (e) => {
      _crashDiag.log(`WEBGL_LOST: ${this.width}x${this.height}`);
      console.error('[CRASH-DIAG] WebGL context LOST on canvas', this.width, 'x', this.height, '— prevented:', e.defaultPrevented);
    });
    this.addEventListener('webglcontextrestored', () => {
      _crashDiag.log('WEBGL_RESTORED');
      console.warn('[CRASH-DIAG] WebGL context restored');
    });
  }
  return ctx;
};


// ═══════════════════════════════════════════════════════════════
// SSE Handler Map — event-to-method routing table
// ═══════════════════════════════════════════════════════════════
// connectSSE() iterates this array to register all listeners in a single loop.
// Omitted no-op events (registered by server but unused in UI):
//   respawn:stepSent, respawn:aiCheckStarted, respawn:aiCheckCompleted,
//   respawn:aiCheckFailed, respawn:aiCheckCooldown
const _SSE_HANDLER_MAP = [
  // Core
  [SSE_EVENTS.INIT, '_onInit'],

  // Session lifecycle
  [SSE_EVENTS.SESSION_CREATED, '_onSessionCreated'],
  [SSE_EVENTS.SESSION_UPDATED, '_onSessionUpdated'],
  [SSE_EVENTS.SESSION_DELETED, '_onSessionDeleted'],
  [SSE_EVENTS.SESSION_TERMINAL, '_onSSETerminal'],
  [SSE_EVENTS.SESSION_NEEDS_REFRESH, '_onSSENeedsRefresh'],
  [SSE_EVENTS.SESSION_CLEAR_TERMINAL, '_onSSEClearTerminal'],
  [SSE_EVENTS.SESSION_COMPLETION, '_onSessionCompletion'],
  [SSE_EVENTS.SESSION_ERROR, '_onSessionError'],
  [SSE_EVENTS.SESSION_EXIT, '_onSessionExit'],
  [SSE_EVENTS.SESSION_IDLE, '_onSessionIdle'],
  [SSE_EVENTS.SESSION_WORKING, '_onSessionWorking'],
  [SSE_EVENTS.SESSION_AUTO_CLEAR, '_onSessionAutoClear'],
  [SSE_EVENTS.SESSION_LIMIT_PAUSE_SCHEDULED, '_onSessionLimitPauseScheduled'],
  [SSE_EVENTS.SESSION_LIMIT_RESUME, '_onSessionLimitResume'],
  [SSE_EVENTS.SESSION_LIMIT_RESUME_CANCELLED, '_onSessionLimitResumeCancelled'],
  [SSE_EVENTS.SESSION_RESPAWN_BREAKER_TRIPPED, '_onSessionRespawnBreakerTripped'],
  [SSE_EVENTS.SESSION_CLI_INFO, '_onSessionCliInfo'],
  [SSE_EVENTS.SESSION_STATUS_TELEMETRY, '_onSessionStatusTelemetry'],

  // Scheduled runs
  [SSE_EVENTS.SCHEDULED_CREATED, '_onScheduledCreated'],
  [SSE_EVENTS.SCHEDULED_UPDATED, '_onScheduledUpdated'],
  [SSE_EVENTS.SCHEDULED_COMPLETED, '_onScheduledCompleted'],
  [SSE_EVENTS.SCHEDULED_STOPPED, '_onScheduledStopped'],

  // Scheduled jobs (cron-style scheduler)
  [SSE_EVENTS.CRON_JOBS_CHANGED, '_onCronJobsChanged'],
  [SSE_EVENTS.CRON_JOB_DELETED, '_onCronJobsChanged'],
  [SSE_EVENTS.CRON_RUN_CREATED, '_onCronRunChanged'],
  [SSE_EVENTS.CRON_RUN_UPDATED, '_onCronRunChanged'],

  // Respawn
  [SSE_EVENTS.RESPAWN_STARTED, '_onRespawnStarted'],
  [SSE_EVENTS.RESPAWN_STOPPED, '_onRespawnStopped'],
  [SSE_EVENTS.RESPAWN_STATE_CHANGED, '_onRespawnStateChanged'],
  [SSE_EVENTS.RESPAWN_CYCLE_STARTED, '_onRespawnCycleStarted'],
  [SSE_EVENTS.RESPAWN_BLOCKED, '_onRespawnBlocked'],
  [SSE_EVENTS.RESPAWN_AUTO_ACCEPT_SENT, '_onRespawnAutoAcceptSent'],
  [SSE_EVENTS.RESPAWN_DETECTION_UPDATE, '_onRespawnDetectionUpdate'],
  [SSE_EVENTS.RESPAWN_TIMER_STARTED, '_onRespawnTimerStarted'],
  [SSE_EVENTS.RESPAWN_TIMER_CANCELLED, '_onRespawnTimerCancelled'],
  [SSE_EVENTS.RESPAWN_TIMER_COMPLETED, '_onRespawnTimerCompleted'],
  [SSE_EVENTS.RESPAWN_ERROR, '_onRespawnError'],
  [SSE_EVENTS.RESPAWN_ACTION_LOG, '_onRespawnActionLog'],

  // Tasks
  [SSE_EVENTS.TASK_CREATED, '_onTaskCreated'],
  [SSE_EVENTS.TASK_COMPLETED, '_onTaskCompleted'],
  [SSE_EVENTS.TASK_FAILED, '_onTaskFailed'],
  [SSE_EVENTS.TASK_UPDATED, '_onTaskUpdated'],

  // Mux (tmux)
  [SSE_EVENTS.MUX_CREATED, '_onMuxCreated'],
  [SSE_EVENTS.MUX_KILLED, '_onMuxKilled'],
  [SSE_EVENTS.MUX_DIED, '_onMuxDied'],
  [SSE_EVENTS.MUX_STATS_UPDATED, '_onMuxStatsUpdated'],

  // Remote auto-reconnect (COD-108)
  [SSE_EVENTS.REMOTE_SESSION_RECONNECTED, '_onRemoteSessionReconnected'],
  [SSE_EVENTS.REMOTE_RECONNECT_EXHAUSTED, '_onRemoteReconnectExhausted'],

  // Ralph
  [SSE_EVENTS.SESSION_RALPH_LOOP_UPDATE, '_onRalphLoopUpdate'],
  [SSE_EVENTS.SESSION_RALPH_TODO_UPDATE, '_onRalphTodoUpdate'],
  [SSE_EVENTS.SESSION_RALPH_COMPLETION_DETECTED, '_onRalphCompletionDetected'],
  [SSE_EVENTS.SESSION_RALPH_STATUS_UPDATE, '_onRalphStatusUpdate'],
  [SSE_EVENTS.SESSION_CIRCUIT_BREAKER_UPDATE, '_onCircuitBreakerUpdate'],
  [SSE_EVENTS.SESSION_EXIT_GATE_MET, '_onExitGateMet'],

  // Bash tools
  [SSE_EVENTS.SESSION_BASH_TOOL_START, '_onBashToolStart'],
  [SSE_EVENTS.SESSION_BASH_TOOL_END, '_onBashToolEnd'],
  [SSE_EVENTS.SESSION_BASH_TOOLS_UPDATE, '_onBashToolsUpdate'],

  // Hooks (Claude Code hook events)
  [SSE_EVENTS.HOOK_IDLE_PROMPT, '_onHookIdlePrompt'],
  [SSE_EVENTS.HOOK_PERMISSION_PROMPT, '_onHookPermissionPrompt'],
  [SSE_EVENTS.HOOK_ELICITATION_DIALOG, '_onHookElicitationDialog'],
  [SSE_EVENTS.HOOK_ELICITATION_COMPLETE, '_onHookElicitationComplete'],
  [SSE_EVENTS.HOOK_ELICITATION_RESPONSE, '_onHookElicitationResponse'],
  [SSE_EVENTS.HOOK_STOP, '_onHookStop'],
  [SSE_EVENTS.HOOK_AGENT_WORKING, '_onHookAgentWorking'],
  [SSE_EVENTS.HOOK_TEAMMATE_IDLE, '_onHookTeammateIdle'],
  [SSE_EVENTS.HOOK_TASK_COMPLETED, '_onHookTaskCompleted'],

  // Approvals Inbox (handlers in approvals-ui.js)
  [SSE_EVENTS.APPROVAL_PENDING, '_onApprovalPending'],
  [SSE_EVENTS.APPROVAL_UPDATED, '_onApprovalUpdated'],
  [SSE_EVENTS.APPROVAL_RESOLVED, '_onApprovalResolved'],

  // Subagents (Claude Code background agents)
  [SSE_EVENTS.SUBAGENT_DISCOVERED, '_onSubagentDiscovered'],
  [SSE_EVENTS.SUBAGENT_UPDATED, '_onSubagentUpdated'],
  [SSE_EVENTS.SUBAGENT_TOOL_CALL, '_onSubagentToolCall'],
  [SSE_EVENTS.SUBAGENT_PROGRESS, '_onSubagentProgress'],
  [SSE_EVENTS.SUBAGENT_MESSAGE, '_onSubagentMessage'],
  [SSE_EVENTS.SUBAGENT_TOOL_RESULT, '_onSubagentToolResult'],
  [SSE_EVENTS.SUBAGENT_COMPLETED, '_onSubagentCompleted'],

  // Workflow runs (ultracode)
  [SSE_EVENTS.WORKFLOW_RUN_DISCOVERED, '_onWorkflowRunDiscovered'],
  [SSE_EVENTS.WORKFLOW_RUN_UPDATED, '_onWorkflowRunUpdated'],
  [SSE_EVENTS.WORKFLOW_RUN_REMOVED, '_onWorkflowRunRemoved'],

  // Images
  [SSE_EVENTS.IMAGE_DETECTED, '_onImageDetected'],
  [SSE_EVENTS.ATTACHMENT_DETECTED, '_onAttachmentDetected'],

  // Tunnel
  [SSE_EVENTS.TUNNEL_STARTED, '_onTunnelStarted'],
  [SSE_EVENTS.TUNNEL_STOPPED, '_onTunnelStopped'],
  [SSE_EVENTS.TUNNEL_PROGRESS, '_onTunnelProgress'],
  [SSE_EVENTS.TUNNEL_ERROR, '_onTunnelError'],
  [SSE_EVENTS.TUNNEL_QR_ROTATED, '_onTunnelQrRotated'],
  [SSE_EVENTS.TUNNEL_QR_REGENERATED, '_onTunnelQrRegenerated'],
  [SSE_EVENTS.TUNNEL_QR_AUTH_USED, '_onTunnelQrAuthUsed'],

  // Plan orchestration
  [SSE_EVENTS.PLAN_SUBAGENT, '_onPlanSubagent'],
  [SSE_EVENTS.PLAN_PROGRESS, '_onPlanProgress'],
  [SSE_EVENTS.PLAN_STARTED, '_onPlanStarted'],
  [SSE_EVENTS.PLAN_CANCELLED, '_onPlanCancelled'],
  [SSE_EVENTS.PLAN_COMPLETED, '_onPlanCompleted'],

  // Orchestrator loop
  [SSE_EVENTS.ORCHESTRATOR_STATE_CHANGED, '_onOrchestratorStateChanged'],
  [SSE_EVENTS.ORCHESTRATOR_PLAN_PROGRESS, '_onOrchestratorPlanProgress'],
  [SSE_EVENTS.ORCHESTRATOR_PLAN_READY, '_onOrchestratorPlanReady'],
  [SSE_EVENTS.ORCHESTRATOR_PHASE_STARTED, '_onOrchestratorPhaseStarted'],
  [SSE_EVENTS.ORCHESTRATOR_PHASE_COMPLETED, '_onOrchestratorPhaseCompleted'],
  [SSE_EVENTS.ORCHESTRATOR_PHASE_FAILED, '_onOrchestratorPhaseFailed'],
  [SSE_EVENTS.ORCHESTRATOR_VERIFICATION, '_onOrchestratorVerification'],
  [SSE_EVENTS.ORCHESTRATOR_TASK_ASSIGNED, '_onOrchestratorTaskAssigned'],
  [SSE_EVENTS.ORCHESTRATOR_TASK_COMPLETED, '_onOrchestratorTaskCompleted'],
  [SSE_EVENTS.ORCHESTRATOR_TASK_FAILED, '_onOrchestratorTaskFailed'],
  [SSE_EVENTS.ORCHESTRATOR_COMPLETED, '_onOrchestratorCompleted'],
  [SSE_EVENTS.ORCHESTRATOR_ERROR, '_onOrchestratorError'],

  // Clipboard
  [SSE_EVENTS.CLIPBOARD_WRITE, '_onClipboardWrite'],

  // Session order (global tab order sync, COD-131)
  [SSE_EVENTS.SESSION_ORDER_CHANGED, '_onSessionOrderChanged'],

  // Web tabs (dashboard URLs)
  [SSE_EVENTS.WEBVIEW_CHANGED, '_onWebviewChanged'],
];


// ═══════════════════════════════════════════════════════════════
// Session Name Prefix Parser
// ═══════════════════════════════════════════════════════════════
// Parses w<N>-<caseName> or s<N>-<caseName> prefix from session names.
// Returns { prefix, suffix } or null if name does not match the pattern.
function parseSessionPrefix(name) {
  if (!name) return null;
  const m = name.match(/^(w\d+-[a-zA-Z0-9_-]+|s\d+-[a-zA-Z0-9_-]+)/);
  if (!m) return null;
  const prefix = m[1];
  const rest = name.slice(prefix.length);
  if (rest === "") return { prefix, suffix: "" };
  if (rest.startsWith(": ")) return { prefix, suffix: rest.slice(2) };
  return null;
}

const DEFAULT_SHORTCUTS = [
  {
    id: 'show-shortcuts',
    group: 'Panels',
    label: 'Show Shortcuts',
    bindings: [
      { modifiers: ['ctrl'], key: '?', code: 'Slash' },
      { modifiers: ['ctrl', 'shift'], key: '?' },
      { modifiers: ['alt'], key: '?', code: 'Slash' },
    ],
    action: 'showShortcutOverlay',
  },
  {
    id: 'close-session',
    group: 'Session',
    label: 'Close Session',
    bindings: [{ modifiers: ['ctrl'], key: 'w' }],
    action: 'killActiveSession',
  },
  {
    id: 'next-session',
    group: 'Session',
    label: 'Next Session',
    bindings: [{ modifiers: ['ctrl'], key: 'Tab' }],
    action: 'nextSession',
  },
  {
    id: 'clear-terminal',
    group: 'Terminal',
    label: 'Clear Terminal',
    bindings: [{ modifiers: ['ctrl'], key: 'l' }],
    action: 'clearTerminal',
  },
  {
    id: 'copy-selection',
    group: 'Terminal',
    label: 'Copy Selection',
    // Bindings match on `key`, not `code`: xterm decides which byte to emit from the
    // PRODUCED character, so intercepting a physical KeyC that doesn't produce "c"
    // would diverge from the chord that actually sends ^C.
    bindings: [
      { modifiers: ['ctrl'], key: 'c' },
      { modifiers: ['ctrl', 'shift'], key: 'C' },
    ],
    // Dispatched by shouldCopyTerminalSelectionFromShortcut() in terminal-ui.js and
    // deliberately absent from SHORTCUT_ACTIONS: the generic capture loop always
    // preventDefaults on a match, which would cost the user the interrupt key.
    action: 'copyTerminalSelection',
  },
  {
    id: 'increase-font',
    group: 'Terminal',
    label: 'Increase Font',
    bindings: [
      { modifiers: ['ctrl'], key: '=', code: 'Equal' },
      { modifiers: ['ctrl'], key: '+', code: 'Equal' },
    ],
    action: 'increaseFontSize',
  },
  {
    id: 'decrease-font',
    group: 'Terminal',
    label: 'Decrease Font',
    bindings: [{ modifiers: ['ctrl'], key: '-', code: 'Minus' }],
    action: 'decreaseFontSize',
  },
  {
    id: 'voice-input',
    group: 'Terminal',
    label: 'Voice Input',
    bindings: [{ modifiers: ['ctrl', 'shift'], key: 'V' }],
    action: 'toggleVoiceInput',
  },
  {
    id: 'restore-terminal-size',
    group: 'Terminal',
    label: 'Restore Terminal Size',
    bindings: [{ modifiers: ['ctrl', 'shift'], key: 'R' }],
    action: 'restoreTerminalSize',
  },
  {
    id: 'move-tab-left',
    group: 'Tabs',
    label: 'Move Active Tab Left',
    bindings: [{ modifiers: ['ctrl', 'shift'], key: '{', code: 'BracketLeft' }],
    action: 'moveActiveTabLeft',
  },
  {
    id: 'move-tab-right',
    group: 'Tabs',
    label: 'Move Active Tab Right',
    bindings: [{ modifiers: ['ctrl', 'shift'], key: '}', code: 'BracketRight' }],
    action: 'moveActiveTabRight',
  },
  {
    id: 'command-palette',
    group: 'Session',
    label: 'Find Open Session',
    bindings: [
      { modifiers: ['ctrl'], key: 'k', code: 'KeyK' },
      { modifiers: ['meta'], key: 'k', code: 'KeyK' },
      { modifiers: ['alt'], key: 'k', code: 'KeyK' },
    ],
    action: 'openCommandPalette',
  },
  {
    id: 'toggle-session-sidebar',
    group: 'Session',
    label: 'Toggle Session Sidebar',
    // Alt+B, not Ctrl+B: Ctrl+B must reach the terminal (tmux prefix,
    // readline backward-char). The Alt block below claims only Digit1-9 and
    // the brackets, and the registry claims Alt for KeyK and Slash only.
    bindings: [{ modifiers: ['alt'], key: 'b', code: 'KeyB' }],
    action: 'toggleSessionSidebar',
  },
  {
    id: 'previous-next-session',
    group: 'Session',
    label: 'Previous / Next Session',
    displayBindings: ['Alt/Option+[', 'Alt/Option+]'],
  },
  {
    id: 'switch-tab-n',
    group: 'Session',
    label: 'Switch to Tab N',
    displayBindings: ['Alt/Option+1-9'],
  },
  {
    id: 'focus-tabs',
    group: 'Tabs',
    label: 'Focus Tabs',
    displayBindings: ['ArrowLeft', 'ArrowRight', 'Home', 'End'],
  },
  {
    id: 'activate-focused-tab',
    group: 'Tabs',
    label: 'Activate Focused Tab',
    displayBindings: ['Enter', 'Space'],
  },
  {
    id: 'insert-newline',
    group: 'Terminal',
    label: 'Insert Newline',
    displayBindings: ['Shift+Enter', 'Ctrl+Enter'],
  },
  {
    id: 'close-panels',
    group: 'Panels',
    label: 'Close Panels',
    displayBindings: ['Escape'],
  },
];


// ═══════════════════════════════════════════════════════════════
// CodemanApp Class — constructor and global state
// ═══════════════════════════════════════════════════════════════

/**
 * How often the rich sidebar rewrites its relative stamps in place. Matches the
 * two home screens (mobile-overview.js, home-sessions.js). Deliberately a local
 * const and not a constants.js export: an undefined interval would make
 * setInterval fire on every frame, and constants.js is cached independently.
 */
const SIDEBAR_RICH_CLOCK_MS = 20000;

class CodemanApp {
  constructor() {
    this.sessions = new Map();
    this._shortIdCache = new Map(); // Cache session ID .slice(0, 8) results
    this.sessionOrder = []; // Track tab order for drag-and-drop reordering
    this.draggedTabId = null; // Currently dragged tab session ID
    this.cases = [];
    this.currentRun = null;
    this.totalTokens = 0;
    this.globalStats = null; // Global token/cost stats across all sessions
    this.eventSource = null;
    // Stable per-page client ID — lets the server target this connection
    // for live filter updates (POST /api/events/subscribe) without forcing
    // an SSE reconnect on session switches.
    this._clientId = (typeof crypto !== 'undefined' && crypto.randomUUID)
      ? crypto.randomUUID()
      : 'c-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
    // Per-TAB nonce for the WS registry key (COD-137). _loadReliableState()
    // later replaces _clientId with the browser-wide localStorage identity
    // (shared by every tab/window of this profile), so the WS upgrade sends
    // `clientId:nonce` instead — a same-tab reconnect still supersedes its own
    // socket, but two tabs on one session coexist instead of evicting each
    // other in a 4010 ping-pong. Input frames keep the bare clientId for seq
    // dedup.
    this._wsTabNonce = this._clientId;
    this.terminal = null;
    this.fitAddon = null;
    this.activeSessionId = null;

    // ── Session detach / undock (beta) ───────────────────────────────────
    // A "solo window" is a popped-out browser window showing exactly one
    // session. Detected from the /session/:id URL path (robust even if a cached
    // service-worker shell loads), with the server-injected global as a fallback.
    this.soloSessionId = this._detectSoloSessionId();
    this.isSoloWindow = !!this.soloSessionId;
    this.detachedSessions = new Set();   // dashboard-side: ids currently popped out
    this.detachedWindows = new Map();    // dashboard-side: id -> WindowProxy
    this._detachWatchTimers = new Map(); // dashboard-side: id -> setInterval handle
    this.windowChannel = null;           // BroadcastChannel for cross-window sync
    this._redockGrace = new Map();       // id -> timer: deferred redock (debounces popup reloads)
    this._detachPingPending = null;      // Set of ids awaiting a liveness answer
    this._detachLivenessTimer = null;    // periodic reconcile of channel-only detached windows
    this._detachOrphanStrikes = new Map(); // id -> consecutive unanswered roll-calls (redock at 2)

    this._initGeneration = 0;     // dedup concurrent handleInit calls
    this._initFallbackTimer = null; // fallback timer if SSE init doesn't arrive
    this._selectGeneration = 0;   // cancel stale selectSession loads
    // Non-shell sessions whose full tmux scrollback has already been replayed this
    // page load (COD-47). Shells deliberately start from a bounded tail because
    // their scrollback can be very large; full history stays available on demand.
    // Tracked PER SESSION rather than as a single "first load" flag (issue #205).
    this._fullHistoryLoaded = new Set();
    // Cooldown per session for the scroll-to-top "load more history" re-pull.
    this._fullHistoryRepullAt = new Map(); // Map<sessionId, timestamp>
    this._fullHistoryRepullInFlight = false;
    // Sessions whose last re-pull came back THINNER than the live buffer (a
    // repaint-mode CLI pane, where tmux keeps no history of its own). The pull is
    // refused for those and retried far more slowly — see _maybeRefetchFullHistory.
    this._fullHistoryRepullUseless = new Set();
    this.terminalLoadStates = new Map(); // Map<sessionId, { generation, phase }>
    this.respawnStatus = {};
    this.respawnTimers = {}; // Track timed respawn timers
    this.respawnCountdownTimers = {}; // { sessionId: { timerName: { endsAt, totalMs, reason } } }
    this.respawnActionLogs = {};      // { sessionId: [action, action, ...] } (max 20)
    this.timerCountdownInterval = null; // Interval for updating countdown display
    this.terminalBuffers = new Map(); // Store terminal content per session
    this.editingSessionId = null; // Session being edited in options modal
    this.pendingCloseSessionId = null; // Session pending close confirmation
    this.muxSessions = []; // Screen sessions for process monitor

    // Ralph loop/todo state per session
    this.ralphStates = new Map(); // Map<sessionId, { loop, todos }>

    // Subagent (Claude Code background agent) tracking
    this.subagents = new Map(); // Map<agentId, SubagentInfo>
    this.subagentActivity = new Map(); // Map<agentId, activity[]> - recent tool calls/progress
    this.subagentToolResults = new Map(); // Map<agentId, Map<toolUseId, result>> - tool results by toolUseId
    this.activeSubagentId = null; // Currently selected subagent for detail view
    this.subagentPanelVisible = false;

    // Ultracode / Workflow run visualization (master-detail tab)
    this.workflowRuns = new Map(); // runId -> run summary (LEFT list)
    this.workflowRunDetails = new Map(); // runId -> full run with agents[] (RIGHT pane)
    this.activeWorkflowRunId = null;
    this.activeWorkflowPhaseIndex = null;
    // Ultracode floating run windows (additional to the dock panel — ultracode-windows.js)
    this.ultracodeWindows = new Map(); // runId -> { element, parentSessionId, dragListeners, collapsed }
    this.ultracodeWindowsClosed = new Set(); // runIds the user explicitly dismissed (don't re-pop)
    this.ultracodeWindowCloseTimers = new Map(); // runId -> auto-close timeout
    this.ultracodeWindowZIndex = 1000;
    this.subagentWindows = new Map(); // Map<agentId, { element, position }>
    this.subagentWindowZIndex = ZINDEX_SUBAGENT_BASE;
    this.minimizedSubagents = new Map(); // Map<sessionId, Set<agentId>> - minimized to tab
    this._subagentHideTimeout = null; // Timeout for hover-based dropdown hide

    // PERSISTENT parent associations - agentId -> sessionId
    // This is the SINGLE SOURCE OF TRUTH for which tab an agent window connects to.
    // Once set, never recalculated. Persisted to localStorage and server.
    this.subagentParentMap = new Map();

    // Agent Teams tracking
    this.teams = new Map(); // Map<teamName, TeamConfig>
    this.teamTasks = new Map(); // Map<teamName, TeamTask[]>
    this.teammateMap = new Map(); // Map<agentId-prefix, {name, color, teamName}> for quick lookup

    // Teammate tmux pane terminals (Agent Teams feature)
    this.teammatePanesByName = new Map(); // Map<name, { paneTarget, sessionId, color }>
    this.teammateTerminals = new Map(); // Map<agentId, { terminal, fitAddon, paneTarget, sessionId, resizeObserver }>

    this.terminalBufferCache = new Map(); // Map<sessionId, string> — client-side cache for instant tab re-visits (max 20)

    this.ralphStatePanelCollapsed = true; // Default to collapsed
    this.ralphClosedSessions = new Set(); // Sessions where user explicitly closed Ralph panel

    // Plan subagent windows (visible agents during plan generation)
    this.planSubagents = new Map(); // Map<agentId, { type, model, status, startTime, element, relativePos }>
    this.planSubagentWindowZIndex = ZINDEX_PLAN_SUBAGENT_BASE;
    this.planGenerationStopped = false; // Flag to ignore SSE events after Stop
    this.planAgentsMinimized = false; // Whether agent windows are minimized to tab

    // Wizard dragging state
    this.wizardDragState = null; // { startX, startY, startLeft, startTop, isDragging }
    this.wizardDragListeners = null; // { move, up } for cleanup
    this.wizardPosition = null; // { left, top } - null means centered

    // Project Insights tracking (active Bash tools with clickable file paths)
    this.projectInsights = new Map(); // Map<sessionId, ActiveBashTool[]>
    this.logViewerWindows = new Map(); // Map<windowId, { element, eventSource, filePath }>
    this.logViewerWindowZIndex = ZINDEX_LOG_VIEWER_BASE;
    this.projectInsightsPanelVisible = false;

    // Orchestrator loop state
    this.orchestratorState = null; // { state, plan, currentPhaseIndex, stats }
    this.orchestratorPanelVisible = false;
    this.currentSessionWorkingDir = null; // Track current session's working dir for path normalization

    // Image popup windows (auto-open for detected screenshots/images)
    this.imagePopups = new Map(); // Map<imageId, { element, sessionId, filePath }>
    this.imagePopupZIndex = ZINDEX_IMAGE_POPUP_BASE;
    this.attachmentCards = new Map(); // Map<attachmentId, { element, sessionId, filePath }>
    this.attachmentCardStack = null;
    this.attachmentHistoryCounts = new Map(); // Map<sessionId, count>
    this.attachmentHistoryItems = [];
    this.attachmentHistoryDrawerOpen = false;

    // File browser state (methods in panels-ui.js)
    this.fileBrowserData = null;
    this.fileBrowserExpandedDirs = new Set();
    this.fileBrowserFilter = '';
    this.fileBrowserAllExpanded = false;
    this.fileBrowserDragListeners = null;
    // Show hidden (dot-prefixed) files and folders in the File Viewer tree.
    // Per-device, persisted to its own localStorage key by panels-ui.js. Safe to
    // call a mixin method here: instantiation is deferred to DOMContentLoaded,
    // so every module's Object.assign has already run.
    this.fileBrowserShowHidden = this._loadFileBrowserShowHidden?.() ?? false;
    this.filePreviewContent = '';

    // Toast container cache (methods in panels-ui.js)
    this._toastContainer = null;

    // Tunnel indicator state
    this._tunnelUrl = null;

    // Tab alert states: Map<sessionId, 'action' | 'idle'>
    this.tabAlerts = new Map();

    // Pending hooks per session: Map<sessionId, Set<hookType>>
    // Tracks pending hook events that need resolution (permission_prompt, elicitation_dialog, idle_prompt)
    this.pendingHooks = new Map();

    // Sessions THIS tab is closing right now. closeSession() owns the follow-up
    // selection, so _onSessionDeleted must not race its own delete's SSE
    // broadcast to the welcome screen. Set<sessionId>, cleared in a finally.
    this._closingSessions = new Set();

    // Approvals Inbox: Map<approvalId, ApprovalItem> (methods in approvals-ui.js)
    this.approvals = new Map();

    // WebSocket terminal I/O (low-latency bypass of HTTP POST + SSE)
    this._ws = null;            // WebSocket instance for active session
    this._wsSessionId = null;   // Session ID the WS is connected to
    this._wsReady = false;      // True when WS is open and ready for I/O
    this._wsState = 'disconnected'; // connecting | connected | reconnecting | fallback | disconnected
    this._wsLastRecvAt = 0;     // ms timestamp of the last frame received on the active WS

    // Terminal write batching with DEC 2026 sync support
    this.pendingWrites = [];
    this.writeFrameScheduled = false;
    // xterm.write() parses asynchronously. Keep at most one live-output chunk
    // inside xterm so its private WriteBuffer cannot bypass our 128KB cap.
    this._terminalWriteInFlight = false;
    this._terminalWriteInFlightBytes = 0;
    this._wasAtBottomBeforeWrite = true; // Default to true for sticky scroll
    this.syncWaitTimeout = null; // Timeout for incomplete sync blocks
    this._isLoadingBuffer = false; // true during chunkedTerminalWrite — blocks live SSE writes
    this._loadBufferQueue = null;  // queued SSE events during buffer load
    this._bufferLoadSeq = 0;
    this._bufferLoadOwner = null;
    // Single-flight token for terminal buffer recovery. The identity check also
    // lets a session switch invalidate an older fetch without blocking the new tab.
    this._terminalRefreshOwner = null;

    // Flicker filter state (buffers output after screen clears)
    this.flickerFilterBuffer = '';
    this.flickerFilterActive = false;
    this.flickerFilterTimeout = null;

    // Render debounce timers (managed by _debouncedCall)
    this._debounceTimers = Object.create(null);

    // System stats polling
    this.systemStatsInterval = null;

    // SSE reconnect timeout (to prevent orphaned timeouts)
    this.sseReconnectTimeout = null;

    // SSE event listener cleanup function (to prevent listener accumulation on reconnect)
    this._sseListenerCleanup = null;

    // SSE connection status tracking
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 10;
    this.isOnline = navigator.onLine;

    // SSE staleness watchdog. An EventSource that stops delivering does not
    // always error (a proxy that idle-closed it, a resumed laptop), so
    // `onerror` never fires and every SSE-driven surface freezes silently.
    // The server heartbeats every 15s; going quiet for three of them means the
    // stream is a zombie and has to be rebuilt. The decision is pure
    // (computeSseStale in constants.js); these are its inputs. The threshold
    // is an instance field so a browser test can shrink it.
    this._sseLastMessageAt = 0;
    this._sseStaleTimeoutMs = window.CodemanSseStale?.TIMEOUT_MS ?? 45000;
    this._sseStaleWatchdog = null;

    // Connection-loss UI (banner + full-screen overlay). The decision itself is
    // pure and lives in constants.js (computeConnectionLossUi); these are just
    // its inputs. `_connDownSince` is the timestamp the transport LEFT the
    // connected state, which is what the grace window is measured from.
    this._connDownSince = null;
    this._nextSseRetryAt = null;      // when the scheduled SSE retry fires (countdown)
    this._offlineOverlayDismissed = false;
    this._offlineRetryPending = false; // a user-triggered retry is in flight
    this._offlineUiTicker = null;
    this._lastOfflineUiKey = '';

    // Reliable, durable input delivery (replaces the old best-effort queue).
    // Every input byte is recorded with a stable clientId + a monotonic
    // per-session seq, persisted to localStorage, and only dropped once the
    // server ACKs that exact seq — so a half-open socket silently dropping a
    // frame, a reconnect, or a page reload can never lose a typed prompt.
    // Exactly-once: the server applies each (clientId, seq) at most once.
    this._connectionStatus = 'connected';
    this._clientId = '';
    this._seqCounters = new Map(); // sessionId -> last issued seq
    this._pendingDeliveries = new Map(); // sessionId -> [{seq,data,useMux,ts,tries,sentAt}]
    // Last rendered connection-indicator tuple; the hot input path skips DOM
    // writes when the freshly computed descriptor is identical (COD-136).
    this._lastIndicatorDescriptor = null;
    this._postDraining = new Set(); // sessionIds with an in-flight POST drainer
    this._persistReliableTimer = null;
    this._reliableAckTimeoutMs = 4000; // unacked WS frame older than this ⇒ socket likely dead
    this._reliableMaxBytes = 256 * 1024; // cap on the persisted backlog
    this._loadReliableState();
    this._reliableSweepTimer = setInterval(() => this._redeliverSweep(), 2000);
    // Flush the durable queue synchronously when the page is hidden/closed —
    // debounced persistence may have a pending write we mustn't lose on reload.
    window.addEventListener('pagehide', () => this._persistReliableNow());
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') this._persistReliableNow();
      // A background tab's timers are throttled, so the 5s watchdog may not
      // have run for minutes, and a wake/unlock is exactly when a stream
      // comes back zombie. Checking here is what makes recovery feel instant
      // instead of up to a full timeout late.
      else this._checkSseStale();
    });

    // Local echo overlay — DOM overlay positioned at the visible ❯ prompt
    // (not at buffer.cursorY, which reflects Ink's internal cursor position)
    this._localEchoOverlay = null;  // created after terminal.open()
    this._localEchoEnabled = false; // true when setting on + session active
    // Predictive write-through echo (codex) — created after terminal.open()
    // from the separate vendor/xterm-predictive-echo.js bundle (may stay null)
    this._predictiveEcho = null;
    this._localEchoPolicy = 'off';  // 'buffer' | 'predict' | 'off' (per active session)
    this._restoringFlushedState = false; // true during selectSession buffer load — protects flushed Maps

    // Accessibility: Focus trap for modals
    this.activeFocusTrap = null;

    // Notification system
    this.notificationManager = new NotificationManager(this);
    this.idleTimers = new Map(); // Map<sessionId, timeout> for stuck detection

    // DOM element cache for performance (avoid repeated getElementById calls)
    this._elemCache = {};

    this.init();
  }

  // Cached element getter - avoids repeated DOM queries
  $(id) {
    if (!this._elemCache[id]) {
      this._elemCache[id] = document.getElementById(id);
    }
    return this._elemCache[id];
  }

  // Clear a named timeout property: if (this[name]) { clearTimeout(this[name]); this[name] = null; }
  _clearTimer(timerName) {
    if (this[timerName]) {
      clearTimeout(this[timerName]);
      this[timerName] = null;
    }
  }

  // Check if a selectSession generation is stale (a newer tab switch has started).
  // If stale, cleans up buffer-loading state and returns true.
  _isStaleSelect(selectGen) {
    if (selectGen !== this._selectGeneration) {
      if (this._isLoadingBuffer) this._finishBufferLoad(selectGen);
      this._restoringFlushedState = false;
      return true;
    }
    return false;
  }

  // Format token count: 1000k -> 1m, 1450k -> 1.45m, 500 -> 500
  formatTokens(count) {
    if (count >= 1000000) {
      const m = count / 1000000;
      return m >= 10 ? `${m.toFixed(1)}m` : `${m.toFixed(2)}m`;
    } else if (count >= 1000) {
      const k = count / 1000;
      return k >= 100 ? `${k.toFixed(0)}k` : `${k.toFixed(1)}k`;
    }
    return String(count);
  }

  // Estimate cost from tokens using Claude Opus pricing
  // Input: $15/M tokens, Output: $75/M tokens
  estimateCost(inputTokens, outputTokens) {
    const inputCost = (inputTokens / 1000000) * 15;
    const outputCost = (outputTokens / 1000000) * 75;
    return inputCost + outputCost;
  }

  // ═══════════════════════════════════════════════════════════════
  // Pending Hooks State Machine
  // ═══════════════════════════════════════════════════════════════
  // Track pending hook events per session to determine tab alerts.
  // Action hooks (permission_prompt, elicitation_dialog) take priority over idle_prompt.

  setPendingHook(sessionId, hookType) {
    if (!this.pendingHooks.has(sessionId)) {
      this.pendingHooks.set(sessionId, new Set());
    }
    this.pendingHooks.get(sessionId).add(hookType);
    this.updateTabAlertFromHooks(sessionId);
  }

  clearPendingHooks(sessionId, hookType = null) {
    const hooks = this.pendingHooks.get(sessionId);
    if (!hooks) return;
    if (hookType) {
      hooks.delete(hookType);
    } else {
      hooks.clear();
    }
    if (hooks.size === 0) {
      this.pendingHooks.delete(sessionId);
    }
    this.updateTabAlertFromHooks(sessionId);
  }

  /**
   * "I looked at this session": spend its pending IDLE tab alert (the yellow
   * one), locally AND server-side. The clear used to live only in this tab's
   * memory, so `seedApprovals()` re-armed it from `GET /api/approvals` on the
   * next reload (a tab you had already checked went yellow again), and the
   * user's other devices never heard about it. The server marks the approval
   * item acknowledged (it stays pending and answerable) and broadcasts
   * `approval:updated`, which is what clears the alert everywhere else.
   *
   * ⚠️ Idle only: action alerts (permission/question) mean an unanswered dialog
   * is on screen, and looking at one does not answer it.
   */
  markIdleAlertSeen(sessionId) {
    // `pendingHooks?` because _ackDelivery calls this from the input hot path,
    // which partial app instances (the vm-loaded delivery tests) also drive.
    if (!this.pendingHooks?.get(sessionId)?.has('idle_prompt')) return;
    this.clearPendingHooks(sessionId, 'idle_prompt');
    this.acknowledgeIdleApprovalOnView?.(sessionId);
  }

  updateTabAlertFromHooks(sessionId) {
    const hooks = this.pendingHooks.get(sessionId);
    if (!hooks || hooks.size === 0) {
      this.tabAlerts.delete(sessionId);
    } else if (hooks.has('permission_prompt') || hooks.has('elicitation_dialog')) {
      this.tabAlerts.set(sessionId, 'action');
    } else if (hooks.has('idle_prompt')) {
      this.tabAlerts.set(sessionId, 'idle');
    }
    this.renderSessionTabs();
  }

  // ═══════════════════════════════════════════════════════════════
  // Init — app bootstrap and mobile setup
  // ═══════════════════════════════════════════════════════════════

  init() {
    // Initialize mobile detection first (adds device classes to body)
    MobileDetection.init();
    // Detach/undock: open the cross-window sync channel; if this is a solo
    // (popped-out) window, apply its minimal chrome immediately so the tab
    // strip never flashes before handleInit selects the target session.
    this._initWindowChannel();
    if (this.isSoloWindow) document.body.classList.add('solo-mode');
    // Initialize mobile handlers
    KeyboardHandler.init();
    SwipeHandler.init();
    VoiceInput.init();
    KeyboardAccessoryBar.init();
    // Apply keyboard bar mode from settings. Always set it (not only when the
    // extended bar is on) so the bar's remembered agent-session layout matches
    // the setting before the first shell session swaps in the terminal bar.
    const _kbSettings = this.loadAppSettingsFromStorage();
    KeyboardAccessoryBar.setMode(_kbSettings.extendedKeyboardBar ? 'extended' : 'simple');
    this.applyHeaderVisibilitySettings();
    this.restorePlanUsageChip();
    this.applySkin();
    this.applyLocalization();
    // Calls applyTabWrapSettings() itself (it owns tabs-two-rows / tabs-show-folder)
    // and then applies the sidebar variant on top — do not call both.
    this.applySessionListLayout();
    this.applyTabOrientation();
    this.initTabRailResize?.();
    this.applyMonitorVisibility();
    this.applyLineageLineSettings?.();
    this._installLineageStripScrollListener?.();
    this._setupTabMiddleClickClose();
    // Must run before the first session:created can arrive: markSessionTabEntering()
    // ignores ids until this sets up its state, which is what keeps the tabs
    // restored on page load from animating.
    this.initEntranceAnimations?.();
    // Remove mobile-init class now that JS has applied visibility settings.
    // The inline <script> in <head> added this to prevent flash-of-content on mobile.
    document.documentElement.classList.remove('mobile-init');
    // Defer heavy terminal canvas creation to next frame — lets browser paint header/skeleton first.
    // IMPORTANT: connectSSE must run AFTER initTerminal to prevent a race where SSE data
    // arrives before the terminal exists, orphaning data in pendingWrites and corrupting
    // escape sequence boundaries when later concatenated with fresh data.
    requestAnimationFrame(() => {
      this.initTerminal();
      this.loadFontSize();
      this.connectSSE();
      // Only fetch state if SSE init event hasn't arrived within 3s (avoids duplicate handleInit)
      this._initFallbackTimer = setTimeout(() => {
        if (this._initGeneration === 0) this.loadState();
      }, 3000);
    });
    // Register service worker for push notifications
    this.registerServiceWorker();
    // Fetch tunnel status for header indicator (desktop only)
    this.loadTunnelStatus();
    // Share a single settings fetch between both consumers
    const settingsPromise = fetch('/api/settings').then(r => r.ok ? r.json() : null).then(env => env?.data ?? null).catch(() => null);
    this.loadQuickStartCases(null, settingsPromise);
    this._initRunMode();
    this.initWebviews?.();
    this.setupEventListeners();
    // Mobile: ensure button taps register even when keyboard is visible.
    // On mobile, tapping a button while the soft keyboard is up causes the
    // browser to dismiss the keyboard first (blur event), swallowing the tap.
    // The button only receives the click on a second tap. Fix: intercept
    // touchstart on buttons while keyboard is visible, preventDefault to stop
    // the dismiss-swallows-tap behavior, and trigger the click programmatically.
    if (MobileDetection.isTouchDevice()) {
      const addKeyboardTapFix = (container) => {
        if (!container) return;
        container.addEventListener('touchstart', (e) => {
          if (!KeyboardHandler.keyboardVisible) return;
          const btn = e.target.closest('button');
          if (!btn) return;
          e.preventDefault();
          btn.click();
          // Refocus terminal so keyboard stays open (e.g. voice input button)
          if (typeof app !== 'undefined' && app.terminal) {
            app.terminal.focus();
          }
        }, { passive: false });
      };
      addKeyboardTapFix(document.querySelector('.toolbar'));
      addKeyboardTapFix(document.querySelector('.welcome-overlay'));
    }
    // System stats polling deferred until sessions exist (started in handleInit/session:created)
    // Setup online/offline detection
    this.setupOnlineDetection();
    // Load server-stored settings (async, re-applies visibility after load)
    this.loadAppSettingsFromServer(settingsPromise).then(() => {
      this.applyHeaderVisibilitySettings();
      this.applySkin();
      this.applyLocalization();
      this.applySessionListLayout();
      // A fresh device seeding tabOrientation from the server would otherwise
      // show no rail until a resize or a settings save: the boot-time call ran
      // before this async load resolved. Must stay AFTER applySessionListLayout
      // (same ordering rule as the settings-save path).
      this.applyTabOrientation?.();
      this.applyMonitorVisibility();
      this.applyLineageLineSettings?.();
      // ultracodeFloatingWindows syncs from the server (non-display key), but on a
      // FRESH device the getLightState run snapshot can seed workflowRuns BEFORE this
      // async settings load resolves — so the floating-window gate read false then and
      // skipped any already-active run. Re-sync now that the real setting is loaded so
      // an in-flight run pops its window immediately instead of waiting for the next
      // ~10s SSE tick. Idempotent: open windows are left as-is; if the setting is off
      // it tears any premature windows down.
      if (typeof this.syncAllUltracodeFloatingWindows === 'function') {
        this.syncAllUltracodeFloatingWindows();
      }
    });
    // Hide loading skeleton now that the app shell is ready
    document.body.classList.add('app-loaded');
  }

  _initWebGL() {
    if (typeof WebglAddon === 'undefined') return;
    try {
      this._webglAddon = new WebglAddon.WebglAddon();
      this._webglAddon.onContextLoss(() => {
        console.error('[CRASH-DIAG] WebGL context LOST — falling back to canvas renderer');
        _crashDiag.log('WEBGL_LOST');
        this._disableWebGLSticky('context-lost');
        this._disposeWebGLObserver();
        this._webglAddon?.dispose();
        this._webglAddon = null;
        this._scheduleTerminalRepaint();
      });
      this.terminal.loadAddon(this._webglAddon);
      console.log('[CRASH-DIAG] WebGL renderer enabled');
      this._installWebGLLongTaskGuard();
    } catch (_e) { /* WebGL2 unavailable — canvas renderer used */ }
  }

  /**
   * Watch for sustained main-thread stalls that indicate WebGL/GPU trouble.
   * After WEBGL_FALLBACK.LONGTASK_COUNT long tasks (>=LONGTASK_MS each) within
   * WINDOW_MS, dispose the WebGL addon and persist a sticky disable so
   * subsequent reloads also use the DOM renderer. GRACE_MS skips initial-load
   * stalls. Force-re-enable: ?webgl=force.
   */
  _installWebGLLongTaskGuard() {
    if (typeof PerformanceObserver === 'undefined' || this._webglLongTaskObserver) return;
    const installedAt = performance.now();
    const recent = [];
    try {
      this._webglLongTaskObserver = new PerformanceObserver((list) => {
        if (!this._webglAddon) return;
        const now = performance.now();
        if (now - installedAt < WEBGL_FALLBACK.GRACE_MS) return;
        if (evaluateWebGLLongTaskTrip(recent, list.getEntries(), now)) {
          console.warn(`[CRASH-DIAG] WebGL long-task threshold (${recent.length} stalls/${WEBGL_FALLBACK.WINDOW_MS}ms) — falling back to canvas renderer`);
          _crashDiag.log(`WEBGL_FALLBACK: ${recent.length}`);
          this._disableWebGLSticky('long-tasks');
          this._disposeWebGLObserver();
          this._webglAddon?.dispose();
          this._webglAddon = null;
          this._scheduleTerminalRepaint();
        }
      });
      this._webglLongTaskObserver.observe({ type: 'longtask', buffered: false });
    } catch { /* longtask not supported */ }
  }

  /**
   * Disconnect the WebGL longtask observer. Idempotent. Called from the trip
   * path, the onContextLoss handler, and any future terminal-teardown path —
   * the observer outlives its addon otherwise, holding a closure reference
   * over `this` for every long task the page emits.
   */
  _disposeWebGLObserver() {
    if (!this._webglLongTaskObserver) return;
    try { this._webglLongTaskObserver.disconnect(); } catch {}
    this._webglLongTaskObserver = null;
  }

  /**
   * Repaint the full terminal viewport after a renderer swap (WebGL → canvas/DOM).
   * Scheduled on the next frame so it lands after the addon teardown settles, and
   * debounced so the context-loss and long-task fallback paths can't double-fire.
   * No-ops safely if the terminal isn't ready.
   */
  _scheduleTerminalRepaint() {
    if (this._terminalRepaintScheduled) return;
    this._terminalRepaintScheduled = true;
    const raf = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : (cb) => setTimeout(cb, 0);
    raf(() => {
      this._terminalRepaintScheduled = false;
      try { this.terminal?.refresh(0, this.terminal.rows - 1); } catch {}
    });
  }

  _disableWebGLSticky(reason) {
    try {
      localStorage.setItem('codeman-webgl-disabled', JSON.stringify({ reason, at: Date.now() }));
    } catch {}
  }

  // ═══════════════════════════════════════════════════════════════
  // Event Listeners (Keyboard Shortcuts, Resize, Beforeunload)
  // ═══════════════════════════════════════════════════════════════

  setupEventListeners() {
    // Action name → handler map for the shortcut registry (DEFAULT_SHORTCUTS +
    // user overrides from settings.shortcutOverrides, merged by
    // getShortcutRegistry()). The command palette chord is deliberately NOT in
    // this map — shouldOpenCommandPaletteFromShortcut() dispatches it above with
    // focus-target awareness (it must fire from the terminal but not from inputs).
    const SHORTCUT_ACTIONS = {
      showShortcutOverlay: () => this.showShortcutOverlay(),
      killActiveSession: () => this.killActiveSession(),
      nextSession: () => this.nextSession(),
      clearTerminal: () => this.clearTerminal(),
      restoreTerminalSize: () => this.restoreTerminalSize(),
      increaseFontSize: () => this.increaseFontSize(),
      decreaseFontSize: () => this.decreaseFontSize(),
      toggleVoiceInput: () => VoiceInput.toggle(),
      moveActiveTabLeft: () => this.moveActiveTabLeft(),
      moveActiveTabRight: () => this.moveActiveTabRight(),
      toggleSessionSidebar: () => this.toggleSessionSidebar(),
    };

    // Use capture to handle before terminal
    document.addEventListener('keydown', (e) => {
      // Don't intercept keys during CJK IME composition
      if (e.isComposing || e.keyCode === 229) return;

      if (this.shouldOpenCommandPaletteFromShortcut?.(e)) {
        e.preventDefault();
        this.openCommandPalette();
        return;
      }

      // Escape - close panels and modals (different logic: no preventDefault, no return)
      if (e.key === 'Escape') {
        this.closeAllPanels();
        this.closeHelp();
        if (this.attachmentHistoryDrawerOpen) this.closeAttachmentHistory();
        this.closeSessionManager();
        this.closeCommandPalette?.();
        this.closeShortcutOverlay?.();
        // Overlay layouts only: below 1024px the sidebar is a modal off-canvas
        // drawer over the terminal, so Escape must close it. The docked desktop
        // sidebar is chrome, not a dialog — collapsing it would be a surprise.
        if (this._isSessionSidebarOverlay() &&
            this.isSessionSidebarActive() && !this.isSessionSidebarCollapsed()) {
          this.toggleSessionSidebar();
          document.getElementById('sidebarToggleBtn')?.focus();
        }
      }

      // Option/Alt session navigation uses physical key CODES, not e.key, so macOS
      // keyboard layouts that emit special characters under Option (Option+1 -> ¡,
      // Option+[ -> "“") still switch sessions. e.code is the physical key regardless
      // of layout. Option+1-9 = switch by index; Option+[ / Option+] = prev / next.
      if (e.altKey && !e.ctrlKey && !e.shiftKey) {
        const code = e.code || '';
        const digitMatch = code.match(/^Digit([1-9])$/);
        if (digitMatch) {
          const idx = parseInt(digitMatch[1], 10) - 1;
          // Sessions occupy 1..N and web tabs continue from N+1, matching the
          // numbers actually painted on the tabs. Resolve through the same
          // live-session projection the render paints: sessionOrder can
          // transiently hold a dead id (delete raced against the order sync),
          // and raw indexing then names the wrong tab for every key to its
          // right, web tabs included.
          const live = this.sessionOrder.filter((id) => this.sessions.has(id));
          if (idx < live.length) {
            e.preventDefault();
            this.selectSession(live[idx]);
          } else {
            const webIdx = idx - live.length;
            const webId = (this.webviewOrder || [])[webIdx];
            if (webId) {
              e.preventDefault();
              this.openWebview(webId);
            }
          }
          return;
        }
        if (e.code === 'BracketLeft') {
          e.preventDefault();
          this.prevSession();
          return;
        }
        if (e.code === 'BracketRight') {
          e.preventDefault();
          this.nextSession();
          return;
        }
      }

      // Match against the shortcut registry so user rebinds and per-shortcut
      // disables (App Settings → Shortcuts) take effect. Every dispatchable
      // binding requires Ctrl/Cmd/Alt (capture enforces the same), so plain
      // typing exits early without touching the registry.
      if (!e.ctrlKey && !e.metaKey && !e.altKey) return;
      for (const shortcut of this.getShortcutRegistry()) {
        if (shortcut.disabled || !shortcut.action) continue;
        const action = SHORTCUT_ACTIONS[shortcut.action];
        if (!action) continue;
        if (this.matchesShortcutEvent(e, shortcut)) {
          e.preventDefault();
          action();
          return;
        }
      }
    }, true); // Use capture phase to handle before terminal

    // Token stats click handler (with guard to prevent duplicate handlers on reconnect)
    const tokenEl = this.$('headerTokens');
    if (tokenEl && !tokenEl._statsHandlerAttached) {
      tokenEl.classList.add('clickable');
      tokenEl._statsHandlerAttached = true;
      tokenEl.addEventListener('click', () => this.openTokenStats());
    }

    // Color picker for session customization
    this.setupColorPicker();
  }

  // ═══════════════════════════════════════════════════════════════
  // SSE Connection
  // ═══════════════════════════════════════════════════════════════

  /**
   * POST a live subscription update so the server filters terminal events
   * to the given session(s) for this client. Fire-and-forget — failures
   * are non-fatal because we'll still get every event we don't want
   * (just at higher cost), and the next reconnect carries the filter via
   * the SSE query string.
   */
  _updateSseSubscription(sessionId) {
    try {
      const body = JSON.stringify({
        clientId: this._clientId,
        sessions: sessionId ? [sessionId] : null,
      });
      fetch('/api/events/subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        keepalive: true,
      }).catch(() => { /* non-fatal */ });
    } catch { /* non-fatal */ }
  }

  // ══════════════════════════════════════════════════════════════════════
  // Session detach / undock (beta/session-detach)
  //
  // Each detached window is just another normal client of the same session:
  // the server already fans one PTY's output out to N SSE/WS clients and merges
  // input from all of them, so a popped-out window is live with no extra server
  // plumbing. The dashboard tracks which sessions are out, marks their tabs, and
  // re-docks when the window closes. A BroadcastChannel keeps state in sync
  // across windows (and survives a dashboard reload via roll-call).
  // ══════════════════════════════════════════════════════════════════════

  /** Resolve the solo session id from the URL path (preferred) or the
   *  server-injected global (fallback). Returns null for the normal dashboard. */
  _detectSoloSessionId() {
    try {
      if (typeof window !== 'undefined' && typeof window.__CODEMAN_SOLO__ === 'string' && window.__CODEMAN_SOLO__) {
        return window.__CODEMAN_SOLO__;
      }
      // Strip the reverse-proxy base so the match works under a sub-path mount.
      const base = window.CodemanBase?.base || '';
      let path = location.pathname;
      if (base && path.startsWith(base)) path = path.slice(base.length) || '/';
      const m = path.match(/^\/session\/([^/]+)\/?$/);
      return m ? decodeURIComponent(m[1]) : null;
    } catch { return null; }
  }

  /**
   * Pop a session out into its own browser window. SINGLE, idempotent entry
   * point: the tab's pop-out icon calls this, and a future gesture layer
   * ("pinch to drop") calls the exact same method — so keep it cheap and
   * side-effect-light. Calling it again for an already-open window just raises
   * that window.
   * @param {string} id session id
   */
  detachSession(id) {
    if (this.isSoloWindow) return;            // a solo window can't spawn more
    if (!this.sessions.has(id)) return;
    // Already detached → raise the existing popup instead of opening (or
    // reloading) another. Mirrors the tab-click path: after a dashboard reload
    // we hold no WindowProxy ref, so this raises via the channel rather than
    // re-running window.open (which would reload the popup's terminal). Returns
    // false only when we owned a now-closed window (re-dock + fall through to
    // genuinely re-open below).
    if (this.detachedSessions.has(id) && this._raiseDetached(id)) return;
    const features = 'width=960,height=680,menubar=no,toolbar=no,location=no,status=no';
    let win = null;
    try { win = window.open(CodemanBase.url('/session/' + encodeURIComponent(id)), 'codeman-session-' + id, features); } catch {}
    if (!win) {
      this.showToast?.('Pop-out blocked — allow popups for this site to detach a session', 'error');
      return;
    }
    this.detachedWindows.set(id, win);
    this._markDetached(id, true);
    this._watchDetachedWindow(id, win);
    this._postWindowMessage({ type: 'detached', id });
    try { win.focus(); } catch {}
  }

  /** Raise the popup for an already-detached session. Returns true if the raise
   *  was handled (caller should stop); false if we owned a now-closed window and
   *  re-docked it (caller should fall through to inline / re-open). Unifies the
   *  pop-out icon and tab-click paths so neither reloads a live popup. */
  _raiseDetached(id) {
    const win = this.detachedWindows.get(id);
    if (win && !win.closed) { try { win.focus(); } catch {} return true; }
    if (win && win.closed) { this._redock(id); return false; }   // owned ref dead → redock + fall through
    // No local ref (dashboard reloaded): assume alive and raise via the channel.
    // A liveness ping (or the popup's own unload) heals the badge if it's gone.
    this._postWindowMessage({ type: 'focus-request', id });
    return true;
  }

  /** Re-dock a session: close its window (which re-docks via its unload
   *  announcement) and clear dashboard state now. */
  redockSession(id) {
    const win = this.detachedWindows.get(id);
    if (win && !win.closed) { try { win.close(); } catch {} }
    this._postWindowMessage({ type: 'close-request', id });
    this._redock(id);
  }

  /** Clear all dashboard-side detached state/timers for a session, and take its
   *  sizing back: the popup owned the pane while it was open, so the dashboard's
   *  record of it is stale and the session it is showing needs re-measuring.
   *  ⚠️ Not idempotent — each call re-asserts, so a path that redocks twice for
   *  one close sends two SIGWINCHs. */
  _redock(id) {
    const t = this._detachWatchTimers.get(id);
    if (t) { clearInterval(t); this._detachWatchTimers.delete(id); }
    this._cancelPendingRedock(id);
    this._detachOrphanStrikes.delete(id);
    this.detachedWindows.delete(id);
    this._markDetached(id, false);
    // While the popup owned this session the dashboard sent no resizes, so
    // `_lastResizeDims` — one value for the whole window — no longer describes
    // the PTY, which the popup has been sizing. Clearing it makes the next
    // sendResize report truthfully, on every redock path rather than only the
    // active one: `selectSession` reads that answer to decide whether to wait
    // for the TUI's redraw, and a false "unchanged" makes it fetch the frame
    // before the redraw lands.
    this._lastResizeDims = null;
    // Sizing comes back with the session. `force` buys a guaranteed repaint for
    // the case where popup and dashboard happened to agree on a size; the server
    // already resizes on its own comparison against the real pane whenever the
    // two differ.
    if (this.sessions.has(id) && id === this.activeSessionId) {
      this.sendResize(id, { force: true })?.catch?.(() => {});
    }
  }

  /** Defer a channel-driven redock briefly. A popup *reload* emits 'redocked'
   *  then re-announces 'detached'; the grace window lets that re-announce cancel
   *  the redock, so a reload doesn't blip the dashboard badge. A real close
   *  leaves the redock unanswered and it fires. */
  _scheduleRedock(id) {
    if (this._redockGrace.has(id)) return;
    const timer = setTimeout(() => { this._redockGrace.delete(id); this._redock(id); }, 1500);
    this._redockGrace.set(id, timer);
  }

  _cancelPendingRedock(id) {
    const t = this._redockGrace.get(id);
    if (t) { clearTimeout(t); this._redockGrace.delete(id); }
  }

  /** Toggle the "detached" marker on a tab (immediate DOM update + state set).
   *  Full re-renders re-apply the class from this.detachedSessions. */
  _markDetached(id, on) {
    if (on) this.detachedSessions.add(id); else this.detachedSessions.delete(id);
    const container = this.$('sessionTabs');
    const tab = container && container.querySelector(`.session-tab[data-id="${id}"]`);
    if (tab) tab.classList.toggle('detached', on);
  }

  /** Poll a window we opened; when it closes, re-dock its tab. This is the
   *  primary (reliable) close-detection path for windows this tab opened. */
  _watchDetachedWindow(id, win) {
    const prev = this._detachWatchTimers.get(id);
    if (prev) clearInterval(prev);
    const timer = setInterval(() => {
      if (!win || win.closed) {
        clearInterval(timer);
        this._detachWatchTimers.delete(id);
        this._redock(id);
      }
    }, 800);
    this._detachWatchTimers.set(id, timer);
  }

  /** Open the cross-window BroadcastChannel and wire role-specific handlers. */
  _initWindowChannel() {
    if (typeof BroadcastChannel === 'undefined') return;
    try { this.windowChannel = new BroadcastChannel('codeman-windows'); }
    catch { this.windowChannel = null; return; }
    this.windowChannel.onmessage = (e) => this._onWindowMessage(e.data);
    if (this.isSoloWindow) {
      // Announce presence so the dashboard marks this session's tab detached —
      // even if this window was opened directly by URL rather than window.open.
      this._postWindowMessage({ type: 'detached', id: this.soloSessionId });
      // On close, tell the dashboard to re-dock. pagehide is the reliable signal
      // on modern browsers; beforeunload is a belt-and-suspenders fallback.
      const announceClose = () => this._postWindowMessage({ type: 'redocked', id: this.soloSessionId });
      window.addEventListener('pagehide', announceClose);
      window.addEventListener('beforeunload', announceClose);
    } else {
      // Dashboard: ask any already-open solo windows to re-announce themselves
      // (covers a dashboard reload while popups remain open), then keep
      // reconciling so a popup that died WITHOUT a 'redocked' (hard kill / crash)
      // eventually un-marks its tab.
      this._postWindowMessage({ type: 'roll-call' });
      this._startDetachLiveness();
    }
  }

  _postWindowMessage(msg) {
    try { if (this.windowChannel) this.windowChannel.postMessage(msg); } catch {}
  }

  _onWindowMessage(msg) {
    if (!msg || typeof msg !== 'object') return;
    if (this.isSoloWindow) {
      // Roll-call has no id (broadcast to all) — answer before the id filter.
      if (msg.type === 'roll-call') { this._postWindowMessage({ type: 'detached', id: this.soloSessionId }); return; }
      if (msg.id !== this.soloSessionId) return;
      if (msg.type === 'close-request') { try { window.close(); } catch {} }
      else if (msg.type === 'focus-request') { try { window.focus(); } catch {} }
      return;
    }
    // Dashboard side.
    if (msg.type === 'detached' && msg.id) {
      this._cancelPendingRedock(msg.id);    // a re-announce (e.g. popup reload) cancels a deferred redock
      this._detachPingPending?.delete(msg.id);  // and proves liveness for this tick
      this._detachOrphanStrikes.delete(msg.id); // any answer clears accumulated misses
      this._markDetached(msg.id, true);
    } else if (msg.type === 'redocked' && msg.id) {
      this._scheduleRedock(msg.id);         // defer: a popup reload fires redocked→detached; grace avoids a badge blip
    } else if (msg.type === 'detach-request' && msg.id) {
      // Future gesture hook: another window asks the dashboard to detach a tab.
      this.detachSession(msg.id);
    }
  }

  /** Dashboard: periodically reconcile detached tabs we hold no window ref for
   *  (e.g. after a dashboard reload). Owned windows are covered by the
   *  win.closed poll; channel-only ones can only be checked by asking them to
   *  re-announce and re-docking any that stay silent. */
  _startDetachLiveness() {
    if (this._detachLivenessTimer) return;
    this._detachLivenessTimer = setInterval(() => this._pingDetached(), 5000);
  }

  _pingDetached() {
    const orphans = [];
    for (const id of this.detachedSessions) {
      const win = this.detachedWindows.get(id);
      if (!win) orphans.push(id);            // channel-only — must verify via re-announce
      else if (win.closed) this._redock(id); // owned & closed — heal now
    }
    if (!orphans.length) return;
    this._detachPingPending = new Set(orphans);
    this._postWindowMessage({ type: 'roll-call' });
    // Live popups answer 'detached' (clearing themselves above); survivors stay in
    // the pending set. Redock only after TWO consecutive unanswered roll-calls — a
    // backgrounded popup is timer-throttled and may miss a single 1.2s window, and
    // we don't want to wrongly un-mark a still-open tab. A later answer resets the
    // strike count (see _onWindowMessage).
    setTimeout(() => {
      if (!this._detachPingPending) return;
      for (const id of this._detachPingPending) {
        const strikes = (this._detachOrphanStrikes.get(id) || 0) + 1;
        if (strikes >= 2) { this._detachOrphanStrikes.delete(id); this._redock(id); }
        else this._detachOrphanStrikes.set(id, strikes);
      }
      this._detachPingPending = null;
    }, 1200);
  }

  /** Solo window: select the target session and apply minimal single-session
   *  chrome. Called from handleInit once the session list has loaded. */
  _applySoloMode() {
    document.body.classList.add('solo-mode');
    const session = this.sessions.get(this.soloSessionId);
    if (!session) { this._showSoloSessionGone(); return; }
    // Force re-select (handleInit cleared terminal state above). `auto`: the
    // window is opening its own target, which is not a human checking on it.
    this.activeSessionId = null;
    this.selectSession(this.soloSessionId, { auto: true });
    const name = this.getSessionName(session) || 'Session';
    const titleEl = document.getElementById('soloSessionTitle');
    if (titleEl) { titleEl.textContent = name; titleEl.style.display = ''; }
    const redock = document.getElementById('soloRedockBtn');
    if (redock) redock.style.display = '';
    document.title = name + ' — ' + (window.CodemanI18n?.displayName || 'Codeman');
    if (this.notificationManager) this.notificationManager.originalTitle = document.title;
    // Neutralize the dashboard-only brand click in a solo window.
    const logo = document.querySelector('.header-brand .logo');
    if (logo) logo.onclick = (e) => { e.preventDefault(); };
  }

  /** Solo window: the target session is gone (never existed, or ended while
   *  this window was open). Show a friendly terminal state. */
  _showSoloSessionGone() {
    document.body.classList.add('solo-mode');
    if (document.querySelector('.solo-gone-overlay')) return;
    const el = document.createElement('div');
    el.className = 'solo-gone-overlay';
    el.innerHTML = '<h2>Session unavailable</h2>'
      + '<p>This session has ended or is no longer available.</p>'
      + '<button class="btn-primary" onclick="window.close()">Close window</button>';
    document.body.appendChild(el);
    document.title = (window.codemanT?.('Session ended') || 'Session ended')
      + ' — ' + (window.CodemanI18n?.displayName || 'Codeman');
  }

  connectSSE() {
    // Check if browser is offline
    if (!navigator.onLine) {
      this.setConnectionStatus('offline');
      return;
    }

    // Clear any pending reconnect timeout to prevent duplicate connections
    this._clearTimer('sseReconnectTimeout');

    // Same discipline for the staleness watchdog: connectSSE() runs on every
    // reconnect and is the only teardown path this page-lifetime interval has,
    // so clearing it anywhere else (or not at all) stacks intervals.
    if (this._sseStaleWatchdog) {
      clearInterval(this._sseStaleWatchdog);
      this._sseStaleWatchdog = null;
    }

    // Clean up existing SSE listeners before creating new connection (prevents listener accumulation)
    if (this._sseListenerCleanup) {
      this._sseListenerCleanup();
      this._sseListenerCleanup = null;
    }

    // Close existing EventSource before creating new one to prevent duplicate connections
    if (this.eventSource) {
      this.eventSource.close();
      this.eventSource = null;
    }

    // Show connecting state
    if (this.reconnectAttempts === 0) {
      this.setConnectionStatus('connecting');
    } else {
      this.setConnectionStatus('reconnecting');
    }

    // Build URL with stable client ID and (if known) the active-session
    // filter so the server only streams session:terminal events for the
    // session we're rendering. Lifecycle/metadata events are sent globally
    // regardless of filter (server side).
    const _sseParams = new URLSearchParams({ clientId: this._clientId });
    if (this.activeSessionId) _sseParams.set('sessions', this.activeSessionId);
    this.eventSource = new EventSource(CodemanBase.url(`/api/events?${_sseParams.toString()}`));

    // Store all event listeners for cleanup on reconnect.
    //
    // Every handler is wrapped so ANY frame that arrives stamps the liveness
    // clock the staleness watchdog reads. Doing it here (rather than at the
    // three separate registration sites below) is what keeps a future
    // addListener() call from silently opting out of it.
    const listeners = [];
    const addListener = (event, handler) => {
      const stamped = (e) => {
        this._sseLastMessageAt = Date.now();
        handler(e);
      };
      this.eventSource.addEventListener(event, stamped);
      listeners.push({ event, handler: stamped });
    };

    // Create cleanup function to remove all listeners
    this._sseListenerCleanup = () => {
      for (const { event, handler } of listeners) {
        if (this.eventSource) {
          this.eventSource.removeEventListener(event, handler);
        }
      }
      listeners.length = 0;
    };

    this.eventSource.onopen = () => {
      this.reconnectAttempts = 0;
      // Start the liveness clock here, not at the first frame: the watchdog
      // only ever fires while the status is 'connected', and this is the
      // moment that becomes true.
      this._sseLastMessageAt = Date.now();
      this.setConnectionStatus('connected');
    };
    this.eventSource.onerror = () => {
      this.reconnectAttempts++;
      if (this.reconnectAttempts >= this.maxReconnectAttempts) {
        this.setConnectionStatus('disconnected');
      } else {
        this.setConnectionStatus('reconnecting');
      }
      // Close the failed connection before scheduling reconnect
      if (this.eventSource) {
        this.eventSource.close();
        this.eventSource = null;
      }
      // Clear any existing reconnect timeout before setting new one (prevents orphaned timeouts)
      this._clearTimer('sseReconnectTimeout');
      // Exponential backoff: 200ms, 500ms, 1s, 2s, 4s, ... up to 30s
      // Fast first retry (200ms) for server-restart case (COM deploy),
      // then ramp up for real network issues.
      const delay = this.reconnectAttempts <= 1 ? 200
        : Math.min(500 * Math.pow(2, this.reconnectAttempts - 2), 30000);
      // Feeds the "Retrying in Ns" countdown. With a 30s cap on the backoff, a
      // silent wait that long is indistinguishable from a hung app.
      this._nextSseRetryAt = Date.now() + delay;
      this._updateConnectionLossUi();
      this.sseReconnectTimeout = setTimeout(() => this.connectSSE(), delay);
    };

    // Create stable handler wrappers once (reused across reconnects so
    // removeEventListener always matches the original reference)
    if (!this._sseHandlerWrappers) {
      this._sseHandlerWrappers = new Map();
      for (const [event, method] of _SSE_HANDLER_MAP) {
        const fn = this[method];
        const wsOwnsTerminal =
          method === '_onSSETerminal' ||
          method === '_onSSENeedsRefresh' ||
          method === '_onSSEClearTerminal';
        this._sseHandlerWrappers.set(event, (e) => {
          // While WS owns terminal I/O, the parallel SSE stream is redundant.
          // Drop it before JSON.parse so a busy terminal cannot turn duplicate
          // SSE traffic/backpressure into another expensive buffer replay.
          if (wsOwnsTerminal && this._wsReady) return;
          try {
            fn.call(this, e.data ? JSON.parse(e.data) : {});
          } catch (err) {
            console.error(`[SSE] Error handling ${event}:`, err);
          }
        });
      }
    }

    // Register all SSE event handlers via centralized map
    for (const [event] of _SSE_HANDLER_MAP) {
      addListener(event, this._sseHandlerWrappers.get(event));
    }

    // COD-121: live-refresh the unified session list (Session Manager modal +
    // visible welcome list) on session structural changes. Extra listeners on the
    // same EventSource — EventSource supports multiple listeners per event — so the
    // existing handlers above are untouched. Registered through addListener so they
    // are torn down with the rest on reconnect. Only structural events (created /
    // deleted) trigger a refetch: session:updated is batch-broadcast every ~500ms
    // per active session, which would otherwise turn an open modal / visible welcome
    // list into a sustained ~1 Hz full ~/.claude/projects rescan loop.
    for (const event of [SSE_EVENTS.SESSION_CREATED, SSE_EVENTS.SESSION_DELETED]) {
      addListener(event, () => this._onSessionListMaybeChanged());
    }

    // Docker export/import: toast + refresh the Manage-tab exports list on completion.
    addListener(SSE_EVENTS.DOCKER_EXPORT_COMPLETE, (e) => {
      try {
        const d = e.data ? JSON.parse(e.data) : {};
        this.showToast(`Docker export ready: ${d.bundle} (${Math.round((d.sizeBytes || 0) / 1e6)} MB)`, 'success');
        this.refreshDockerExports?.();
      } catch (err) {
        console.error('[SSE] docker export complete:', err);
      }
    });
    addListener(SSE_EVENTS.DOCKER_EXPORT_FAILED, (e) => {
      try {
        const d = e.data ? JSON.parse(e.data) : {};
        this.showToast(`Docker export failed: ${d.error || 'unknown error'}`, 'error');
      } catch (err) {
        console.error('[SSE] docker export failed:', err);
      }
    });
    // Import + drift-recreate completions: refresh case lists in EVERY open tab
    // (the initiating tab already refreshes via its own fetch response).
    addListener(SSE_EVENTS.DOCKER_IMPORT_COMPLETE, (e) => {
      try {
        const d = e.data ? JSON.parse(e.data) : {};
        this.showToast(`Docker bundle imported as case "${d.name}"`, 'success');
        this.loadQuickStartCases?.();
        this.refreshDockerExports?.();
      } catch (err) {
        console.error('[SSE] docker import complete:', err);
      }
    });
    addListener(SSE_EVENTS.DOCKER_CONTAINER_RECREATED, (e) => {
      try {
        const d = e.data ? JSON.parse(e.data) : {};
        this.showToast(`Container for "${d.name}" removed — next launch recreates it with the new config`, 'info');
      } catch (err) {
        console.error('[SSE] docker container recreated:', err);
      }
    });
    // Multi-user admin: live-refresh whichever admin views (panel/Users tab) are open.
    addListener(SSE_EVENTS.ADMIN_USERS_CHANGED, () => {
      window.codemanAdmin?.onUsersChanged?.();
    });
    // Base image auto-build on first Docker case (build-on-first-use). A single
    // multi-minute event; surface start/finish so the Run spinner is explained.
    addListener(SSE_EVENTS.DOCKER_IMAGE_BUILD_STARTED, () => {
      this.showToast('Building the Codeman agent image (first Docker case, a few minutes)...', 'info', {
        duration: 8000,
      });
    });
    addListener(SSE_EVENTS.DOCKER_IMAGE_BUILD_COMPLETE, (e) => {
      try {
        const d = e.data ? JSON.parse(e.data) : {};
        if (d.error) this.showToast(`Agent image build failed: ${d.error}`, 'error');
        else this.showToast('Agent image ready. Starting the container...', 'success');
      } catch (err) {
        console.error('[SSE] docker image build complete:', err);
      }
    });
    addListener(SSE_EVENTS.DOCKER_IMAGE_BUILD_FAILED, (e) => {
      try {
        const d = e.data ? JSON.parse(e.data) : {};
        this.showToast(`Agent image build failed: ${d.error || 'unknown error'}`, 'error');
      } catch (err) {
        console.error('[SSE] docker image build failed:', err);
      }
    });

    // COD-139: a session:pinned event updates the local live-session pin flag (so
    // a subsequent render is consistent) and re-sorts the open session manager /
    // welcome list so pinned sessions float to the top.
    addListener(SSE_EVENTS.SESSION_PINNED, (e) => {
      let data = null;
      try {
        data = JSON.parse(e.data);
      } catch {
        /* ignore malformed payload */
      }
      if (data && data.id) {
        const live = this.sessions.get(data.id);
        if (live) {
          live.pinned = data.pinned === true;
          live.pinnedAt = data.pinned ? data.pinnedAt : undefined;
        }
      }
      this._onSessionListMaybeChanged();
    });

    // Liveness heartbeat. The handler is deliberately empty: the whole point
    // is the stamp inherited from addListener's wrapper. It still has to be
    // REGISTERED: EventSource only dispatches named events that have a
    // listener, so without this the frame arrives on the wire and is dropped
    // before it can prove the stream is alive.
    addListener(SSE_EVENTS.HEARTBEAT, () => {});

    // Watchdog: a stream that goes quiet without erroring is invisible to
    // onerror, so poll the pure staleness policy and rebuild the connection
    // ourselves. 5s granularity against a 45s threshold: cheap, and it keeps
    // the worst-case detection lag well under a heartbeat interval.
    this._sseStaleWatchdog = setInterval(() => this._checkSseStale(), 5000);
  }

  /**
   * Force a reconnect if the SSE stream has gone quiet while still claiming to
   * be connected. Called by the 5s watchdog and on tab-visible.
   *
   * Recovery needs no new sync path: the reconnect re-runs `handleInit`, which
   * already calls `_resetAllAppState()` and rebuilds everything from the
   * server. The connection-loss UI needs nothing either: `connectSSE()` sets
   * status 'connecting' (reconnectAttempts was zeroed by onopen), and the 2.5s
   * grace in computeConnectionLossUi means a stream that heals in 200ms shows
   * nothing at all.
   */
  _checkSseStale() {
    const policy = window.CodemanSseStale;
    if (!policy) return;
    const now = Date.now();
    const stale = policy.compute({
      lastMessageAt: this._sseLastMessageAt,
      now,
      status: this._connectionStatus,
      isOnline: this.isOnline,
      timeoutMs: this._sseStaleTimeoutMs,
    });
    if (!stale) return;
    // If a middlebox ever strips or delays heartbeats, the failure mode is
    // "silently reconnects every 45s", and a field report of that would be
    // undebuggable without this line.
    console.log(
      `[SSE] stream stale: no frame for ${now - this._sseLastMessageAt}ms ` +
      `(threshold ${this._sseStaleTimeoutMs}ms), forcing reconnect`
    );
    this.connectSSE();
  }

  // ═══════════════════════════════════════════════════════════════
  // SSE Event Handlers
  // ═══════════════════════════════════════════════════════════════
  // Each _on* method receives pre-parsed SSE data (JSON.parse done in connectSSE loop).
  // Async handlers have their own internal try/catch for fetch errors.

  _onInit(data) {
    _crashDiag.log(`INIT: ${data.sessions?.length || 0} sessions`);
    this.handleInit(data);
  }

  _onSessionCreated(data) {
    this.sessions.set(data.id, data);
    // Add new session to end of tab order
    if (!this.sessionOrder.includes(data.id)) {
      this.sessionOrder.push(data.id);
      this.saveSessionOrder();
    }
    // Idempotent per id: the POST response and the session:created event both
    // land here, and a batch launched together cascades in creation order.
    this.markSessionTabEntering?.(data.id);
    // The pane is one shared element, so it is only marked here and played when
    // this session is actually selected (see selectSession).
    this.markTerminalEntering?.(data.id);
    // A spawned session's lineage arc draws in with the tab. Keyed the same way
    // session-lineage.js tags its paths; a no-op unless a line-entrance theme is on.
    if (data.parentSessionId) this.markConnectionLineEntering?.('lineage:' + data.id);
    this.renderSessionTabs();
    this.updateCost();
    // Start stats polling when first session appears
    if (this.sessions.size === 1) this.startSystemStatsPolling();
  }

  _onSessionUpdated(data) {
    const session = data.session || data;
    const oldSession = this.sessions.get(session.id);
    const claudeSessionIdJustSet = session.claudeSessionId && (!oldSession || !oldSession.claudeSessionId);
    this.sessions.set(session.id, session);
    this.renderSessionTabs();
    this.updateCost();
    // Update tokens display if this is the active session
    if (session.id === this.activeSessionId && session.tokens) {
      this.updateRespawnTokens(session.tokens);
    }
    // Update parentSessionName for any subagents belonging to this session
    // (fixes stale name display after session rename)
    this.updateSubagentParentNames(session.id);
    // If claudeSessionId was just set, re-check orphan subagents
    // This connects subagents that were waiting for the session to identify itself
    if (claudeSessionIdJustSet) {
      this.recheckOrphanSubagents();
      // Update connection lines after DOM settles (ensure tabs are rendered)
      requestAnimationFrame(() => {
        this.updateConnectionLines();
      });
    }
  }

  _onSessionDeleted(data) {
    if (this._wsSessionId === data.id) this._disconnectWs();
    // Solo window whose session just ended → show the "unavailable" state.
    if (this.isSoloWindow && data.id === this.soloSessionId) {
      this._showSoloSessionGone();
    }
    // Dashboard: a detached session ended → clear its detached state/timers.
    if (this.detachedSessions.has(data.id)) this._redock(data.id);
    this._cleanupSessionData(data.id);
    // ⚠️ Skip the whole active-session handoff while THIS tab is closing that
    // session: closeSession() owns the follow-up selection and moves you to the
    // next tab, so acting here would race it and flash the welcome screen (or
    // strand you on it) for a close the user initiated right here. A delete from
    // anywhere else still lands on the home screen, which is the honest answer
    // when the thing you were looking at was taken away.
    if (this.activeSessionId === data.id && !this._closingSessions.has(data.id)) {
      this.activeSessionId = null;
      try { localStorage.removeItem('codeman-active-session'); } catch {}
      this.terminal.clear();
      this.showWelcome();
    }
    this.renderSessionTabs();
    this.renderRalphStatePanel();  // Update ralph panel after session deleted
    this.renderProjectInsightsPanel();  // Update project insights panel after session deleted
    // Stop stats polling when no sessions remain
    if (this.sessions.size === 0) this.stopSystemStatsPolling();
  }

  // SSE wrappers — skip terminal events while WebSocket owns active terminal I/O.
  // WS handler calls the underlying _onSession* methods directly.
  _onSSETerminal(data) {
    if (this._wsReady) return;
    this._onSessionTerminal(data);
  }
  _onSSENeedsRefresh(data) {
    if (this._wsReady) return;
    this._onSessionNeedsRefresh(data);
  }
  _onSSEClearTerminal(data) {
    if (this._wsReady) return;
    this._onSessionClearTerminal(data);
  }

  _onSessionTerminal(data) {
    if (data.id === this.activeSessionId) {
      if (data.data.length > 32768) _crashDiag.log(`TERMINAL: ${(data.data.length/1024).toFixed(0)}KB`);

      // Hard cap all app-owned render queues plus the one xterm chunk currently
      // parsing. Check the incoming frame too; otherwise a single large frame can
      // jump over the cap. Dropped data is recovered from the canonical buffer.
      const queued = (this.pendingWrites?.reduce((s, w) => s + w.length, 0) || 0)
        + (this.flickerFilterBuffer?.length || 0)
        + (this._loadBufferQueue?.reduce((s, w) => s + w.length, 0) || 0)
        + (this._terminalWriteInFlightBytes || 0);
      if (queued + data.data.length > 131072) { // 128KB — drop to prevent accumulation
        // Schedule a self-recovery once the
        // queue drains (debounced to avoid hammering the API during sustained bursts).
        if (!this._clientDropRecoveryTimer) {
          this._clientDropRecoveryTimer = setTimeout(() => {
            this._clientDropRecoveryTimer = null;
            this._onSessionNeedsRefresh();
          }, 2000);
        }
        return;
      }

      this.batchTerminalWrite(data.data);
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // Response Viewer — native-scroll panel for reading full Claude responses
  // ═══════════════════════════════════════════════════════════════

  /** Strip dangerous elements and attributes from HTML (XSS prevention) */
  _sanitizeHtml(html) {
    if (typeof window !== 'undefined' && typeof window.sanitizeMarkdownHtml === 'function') {
      return window.sanitizeMarkdownHtml(html);
    }
    // Fail closed: DOMPurify unavailable — never return un-sanitized HTML.
    return String(html == null ? '' : html)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  /**
   * Strip ANSI escape sequences and Claude CLI chrome (status bar, hints,
   * spinner, progress bar) from a terminal buffer so the response viewer can
   * show just the conversational text when the JSONL transcript is missing.
   */
  _cleanTerminalBuffer(buf) {
    const stripped = buf
      // CSI sequences — params (0x30-0x3F includes digits, ?, ;, <, =, >),
      // intermediates (0x20-0x2F), final byte (0x40-0x7E). Catches \x1b[>c,
      // \x1b[>q, \x1b[?25l etc. that the previous regex missed.
      .replace(/\x1b\[[\x30-\x3F]*[\x20-\x2F]*[\x40-\x7E]/g, '')
      // OSC sequences (window titles etc.) terminated by BEL or ST
      .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
      // DCS / APC / PM / SOS sequences
      .replace(/\x1b[PX^_][^\x1b]*\x1b\\/g, '')
      // SS2/SS3 + charset selects + single-char escapes
      .replace(/\x1b[NO()][A-Z0-9]?/g, '')
      .replace(/\x1b[>=<78cDEHM]/g, '')
      // Stray control chars (except \t \n)
      .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
      .replace(/\r\n/g, '\n').replace(/\r/g, '\n');

    // Drop Claude CLI chrome lines that aren't part of the response.
    const CHROME_PATTERNS = [
      /^\s*❯\s*/,                                  // shell prompt
      /^\s*[⏵⏺⏸⏹]+\s*/,                           // status glyphs
      /^\s*✻\s*(Crunching|Crunched|Thinking)/i,   // spinner lines
      /bypass permissions/i,
      /\bshift\+tab to cycle\b/i,
      /^\s*focus\s*$/,
      /^\s*new task\?/i,
      /\/clear to save/i,
      /^\s*─{5,}\s*$/,                            // horizontal dividers
      /\[(Opus|Sonnet|Haiku|GPT|Claude)[\s\S]*(tokens?|\$|¥|%|↑|↓)/i, // status bar
      /^\s*\[\d+[km]?\/\d+[km]?\]/i,              // token counter
      /[█░▓▒]{3,}/,                              // progress bar
      /^\s*\(.*\s*(tokens?|context).*\)\s*$/i,
    ];

    const lines = stripped.split('\n');
    const kept = lines.filter((line) => {
      const trimmed = line.trim();
      if (!trimmed) return true; // keep blanks so paragraphs survive
      return !CHROME_PATTERNS.some((re) => re.test(line));
    });

    return kept
      .join('\n')
      .replace(/[ \t]+$/gm, '')
      .replace(/\n{4,}/g, '\n\n\n')
      .trim();
  }

  /**
   * Wrap ASCII/box diagrams in fenced code blocks so marked.js preserves whitespace.
   * Claude often emits box-drawing diagrams without triple-backticks; without this
   * step, HTML collapses the whitespace and the diagram becomes unreadable prose.
   */
  _preprocessAsciiArt(text) {
    // Only trigger on characters that rarely appear in prose:
    //   U+2500-U+257F  Box Drawing      (─│┌┐└┘├┤┬┴┼╔╗╚╝═║)
    //   U+2580-U+259F  Block Elements   (▀▄█▌▐░▒▓, progress bars)
    // Deliberately excluded:
    //   U+2190-U+21FF  Arrows           (→←↑↓⇒ — common rhetorical prose)
    //   U+25A0-U+25FF  Geometric Shapes (●○■□◆◇ — common bullets)
    // Triggering on those would wrap numbered lists / prose that merely uses
    // arrows in code blocks and break their markdown rendering.
    const BOX_PATTERN = /[─-╿▀-▟]/;

    // Preserve existing fenced code blocks as-is (hide them behind placeholders)
    const fenceRe = /```[\s\S]*?```/g;
    const placeholders = [];
    const masked = text.replace(fenceRe, (m) => {
      placeholders.push(m);
      return `__CODEMAN_FENCE_${placeholders.length - 1}__`;
    });

    // Split on blank-line paragraph boundaries; wrap any paragraph containing
    // box-drawing/arrow chars in its own fenced block.
    const processed = masked
      .split(/(\n{2,})/)
      .map((chunk) => {
        if (/^\n{2,}$/.test(chunk)) return chunk; // keep separators
        if (!chunk.trim()) return chunk;
        if (chunk.includes('__CODEMAN_FENCE_')) return chunk;
        if (BOX_PATTERN.test(chunk)) return '\n```\n' + chunk + '\n```\n';
        return chunk;
      })
      .join('');

    return processed.replace(/__CODEMAN_FENCE_(\d+)__/g, (_m, i) => placeholders[Number(i)]);
  }

  /** Render markdown to sanitized HTML, falling back to plain text if marked.js unavailable */
  _renderMarkdown(text) {
    const src = text || '';
    if (typeof marked !== 'undefined' && marked.parse) {
      try {
        const prepared = this._preprocessAsciiArt(src);
        let html = this._sanitizeHtml(marked.parse(prepared, { breaks: true, gfm: true }));
        // Wrap tables in a horizontal-scroll container so they overflow gracefully
        // on mobile without collapsing into block-level cells.
        html = html.replace(/<table>/g, '<div class="rv-table-wrap"><table>')
                   .replace(/<\/table>/g, '</table></div>');
        // Tag code blocks containing box-drawing glyphs as diagrams (same
        // narrow trigger as _preprocessAsciiArt — arrows/geometric shapes
        // don't count because they appear frequently in prose).
        // Default is wrap (readable on mobile); a toggle button lets the user
        // switch to horizontal-scroll mode when the original structure matters.
        // The button must live OUTSIDE the <pre> scroll container so it stays
        // pinned to the visual right edge when the user scrolls horizontally.
        const DIAGRAM_CHAR = /[─-╿▀-▟]/;
        const tmpl = document.createElement('template');
        tmpl.innerHTML = html;
        // Every fenced code block gets a positioned wrapper with an action
        // toolbar pinned to its top-right corner. The toolbar lives OUTSIDE the
        // <pre> scroll container so its buttons stay put during horizontal
        // scroll. All blocks get a one-click copy button; ASCII diagrams keep
        // the additional line-wrap toggle.
        tmpl.content.querySelectorAll('pre > code').forEach((code) => {
          const pre = code.parentElement;
          const isDiagram = DIAGRAM_CHAR.test(code.textContent || '');

          const wrap = document.createElement('div');
          wrap.className = isDiagram ? 'rv-code-wrap rv-diagram-wrap' : 'rv-code-wrap';

          const actions = document.createElement('div');
          actions.className = 'rv-code-actions';

          const copyBtn = document.createElement('button');
          copyBtn.className = 'rv-copy-btn';
          copyBtn.type = 'button';
          copyBtn.setAttribute('aria-label', 'Copy code');
          copyBtn.setAttribute('title', 'Copy code');
          actions.appendChild(copyBtn);

          if (isDiagram) {
            pre.classList.add('rv-diagram');
            const toggle = document.createElement('button');
            toggle.className = 'rv-wrap-toggle';
            toggle.type = 'button';
            toggle.setAttribute('aria-label', 'Toggle line wrapping');
            toggle.setAttribute('title', 'Toggle line wrapping');
            actions.appendChild(toggle);
          }

          pre.parentNode.insertBefore(wrap, pre);
          wrap.appendChild(actions);
          wrap.appendChild(pre);
        });
        // Links open in a NEW tab.
        //
        // marked emits a bare `<a href>` and the sanitizer's allowlist has no
        // `target`, so a tap in the chat NAVIGATED THE APP AWAY: on a phone that
        // unloads the whole dashboard — SSE, terminal buffers, unsent composer
        // text — and the OS back gesture reloads it from scratch, which is what
        // "links don't open" reads as on mobile, with no middle-click or
        // open-in-new-tab affordance to work around it.
        //
        // This pass runs AFTER sanitizing, so it is the only source of these two
        // attributes: whatever an agent wrote is already gone, and `rel` is set on
        // the same element in the same breath, so no page Codeman opens ever gets
        // a `window.opener` handle back (reverse tabnabbing).
        //
        // A fragment link stays in-page, and mailto:/tel: are handed to the OS —
        // giving those a target just strands an empty tab.
        tmpl.content.querySelectorAll('a[href]').forEach((a) => {
          const href = a.getAttribute('href') || '';
          if (!href || href.startsWith('#') || /^(?:mailto|tel):/i.test(href)) return;
          a.setAttribute('target', '_blank');
          a.setAttribute('rel', 'noopener noreferrer');
        });
        return tmpl.innerHTML;
      } catch { /* fall through */ }
    }
    // Fallback: escape HTML and preserve whitespace
    const escaped = src.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return `<pre style="white-space:pre-wrap;word-break:break-word">${escaped}</pre>`;
  }

  /**
   * Bind click handlers inside the response viewer body. Uses event delegation
   * so a single listener serves every diagram-toggle button, including those
   * added when the conversation is reloaded. Idempotent via a dataset flag.
   */
  _bindResponseViewerInteractions(body) {
    if (!body || body.dataset.rvBound === '1') return;
    body.dataset.rvBound = '1';
    body.addEventListener('click', async (ev) => {
      // File path (_linkifyFilePaths): open it in the preview overlay, which
      // resolves workspace and out-of-workspace paths alike.
      const pathLink = ev.target.closest('a.rv-path');
      if (pathLink) {
        ev.preventDefault();
        ev.stopPropagation();
        const filePath = pathLink.dataset.path;
        if (filePath) this.openFilePreview(filePath, this.activeSessionId);
        return;
      }

      // One-click copy: lift the raw source from the sibling <pre><code>.
      const copyBtn = ev.target.closest('.rv-copy-btn');
      if (copyBtn) {
        ev.preventDefault();
        ev.stopPropagation();
        const code = copyBtn.closest('.rv-code-wrap')?.querySelector('pre code');
        const ok = code ? await this._copyText(code.textContent || '') : false;
        copyBtn.classList.remove('rv-copied', 'rv-copy-failed');
        copyBtn.classList.add(ok ? 'rv-copied' : 'rv-copy-failed');
        clearTimeout(copyBtn._resetTimer);
        copyBtn._resetTimer = setTimeout(() => {
          copyBtn.classList.remove('rv-copied', 'rv-copy-failed');
        }, 1500);
        return;
      }

      const btn = ev.target.closest('.rv-wrap-toggle');
      if (!btn) return;
      ev.preventDefault();
      ev.stopPropagation();
      const wrap = btn.closest('.rv-diagram-wrap');
      const pre = wrap?.querySelector('pre.rv-diagram');
      if (!pre || !wrap) return;
      const nowrap = pre.classList.toggle('rv-nowrap');
      wrap.classList.toggle('rv-wrap-nowrap', nowrap);
    });
  }

  /**
   * Copy text to the clipboard. Prefers the async Clipboard API (secure
   * contexts); falls back to a hidden-textarea + execCommand path so copy
   * still works over plain HTTP. Returns true on success.
   */
  async _copyText(text) {
    if (!text) return false;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch { /* secure-context write failed — try the legacy path */ }
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch {
      return false;
    }
  }

  /** Build one response-viewer message so the brief and full views share markup and CSS. */
  _buildResponseViewerMessage(text, role, agentLabel, meta) {
    const div = document.createElement('div');
    const isUser = role === 'user';
    div.className = 'rv-message ' + (isUser ? 'rv-msg-user' : 'rv-msg-assistant');
    // Consecutive messages from one speaker inside one turn are segments of a
    // single utterance: one badge, a hairline seam. Claude emits a median of 3
    // messages per turn (p90 11, max 51), so a badge per message would be the
    // card spam the old concatenation was introduced to avoid. `meta` is
    // optional so the brief view's 3-argument call keeps its exact shape.
    const continuation = !!(meta && meta.continuation);
    if (continuation) div.classList.add('rv-msg-cont');
    if (meta && meta.kind) div.dataset.kind = meta.kind;
    if (meta && meta.queued) div.dataset.queued = '1';

    if (!continuation) {
      const roleBadge = document.createElement('div');
      roleBadge.className = 'rv-role ' + (isUser ? 'rv-role-user' : 'rv-role-assistant');
      roleBadge.textContent = isUser ? 'You' : agentLabel;
      div.appendChild(roleBadge);
    }

    const renderedText = document.createElement('div');
    renderedText.className = 'rv-text';
    renderedText.innerHTML = this._renderMarkdown(text);
    this._linkifyFilePaths(renderedText);
    div.appendChild(renderedText);
    return div;
  }

  /**
   * Make absolute file paths in a rendered message clickable.
   *
   * The terminal's link provider never sees these: the response viewer is
   * markdown, and a path the agent wrote as prose or inline code renders as
   * inert text — so the file it just produced (a screenshot, a report) was one
   * copy-paste away from being viewable instead of one click. Same pattern the
   * terminal uses (constants.js), same destination (the file-preview overlay).
   *
   * Walks TEXT NODES and builds anchors with DOM APIs — never innerHTML, and
   * never a string rebuild of already-sanitized markup: the source is model
   * output. Subtrees already inside an `<a>` are skipped so an autolinked URL
   * is never re-cut, and the anchor's textContent is the path verbatim, so
   * "copy code" still yields exactly what the agent printed.
   */
  _linkifyFilePaths(root) {
    if (!root || typeof document === 'undefined') return;
    // Guarded: a stale cached constants.js must degrade to plain text, not throw
    // out of the middle of rendering a message.
    if (typeof absoluteFilePathPattern !== 'function') return;
    const pattern = absoluteFilePathPattern();

    // Collect first: replacing a node while the walker is positioned on it
    // invalidates the traversal.
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const targets = [];
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (node.parentElement?.closest('a')) continue;
      pattern.lastIndex = 0;
      if (pattern.test(node.nodeValue || '')) targets.push(node);
    }

    for (const node of targets) {
      const value = node.nodeValue;
      const frag = document.createDocumentFragment();
      let cursor = 0;
      let match;
      pattern.lastIndex = 0;
      while ((match = pattern.exec(value)) !== null) {
        const path = match[1];
        if (match.index > cursor) frag.appendChild(document.createTextNode(value.slice(cursor, match.index)));
        const link = document.createElement('a');
        link.className = 'rv-path';
        link.href = '#';
        link.dataset.path = path;
        link.title = path;
        link.textContent = path;
        frag.appendChild(link);
        cursor = match.index + path.length;
      }
      if (cursor < value.length) frag.appendChild(document.createTextNode(value.slice(cursor)));
      node.parentNode?.replaceChild(frag, node);
    }
  }

  _getResponseViewerAgentLabel() {
    const mode = this.sessions.get(this.activeSessionId)?.mode;
    return mode === 'codex'
      ? 'Codex'
      : mode === 'gemini'
        ? 'Gemini'
        : mode === 'antigravity'
          ? 'Antigravity'
          : mode === 'pi'
            ? 'Pi'
            : mode === 'grok'
              ? 'Grok'
              : mode === 'deepseek'
                ? 'DeepSeek'
                : mode === 'omp'
                  ? 'OMP'
                  : mode === 'opencode'
                    ? 'OpenCode'
                    : 'Claude';
  }

  async toggleResponseViewer() {
    const viewer = document.getElementById('responseViewer');
    const backdrop = document.getElementById('responseViewerBackdrop');
    if (!viewer) return;

    const isOpen = viewer.classList.contains('visible');
    if (isOpen) {
      viewer.classList.remove('visible');
      backdrop.classList.remove('visible');
      return;
    }

    if (!this.activeSessionId) return;
    try {
      // Source 1: Transcript JSONL (best quality — clean structured text from Claude)
      const res = await fetch(`/api/sessions/${this.activeSessionId}/last-response`);
      const data = (await res.json())?.data ?? {};
      let lastResponse = data.text || '';

      // Source 2: Terminal buffer fallback — strip ANSI, drop Claude CLI chrome.
      // Claude + shell only: _cleanTerminalBuffer knows Claude CLI's output, and
      // shell sessions have no transcript source at all; for TUI modes
      // (codex/opencode/gemini/antigravity) it yields repaint garbage, so a clear
      // placeholder beats a messy screen dump there.
      const sessionMode = this.sessions.get(this.activeSessionId)?.mode || 'claude';
      if (!lastResponse && (sessionMode === 'claude' || sessionMode === 'shell')) {
        const termRes = await fetch(`/api/sessions/${this.activeSessionId}/terminal`);
        const termData = (await termRes.json())?.data ?? {};
        if (termData.terminalBuffer) {
          lastResponse = this._cleanTerminalBuffer(termData.terminalBuffer);
        }
      }

      const body = document.getElementById('responseViewerBody');
      if (lastResponse) {
        // Keep the brief view inside the same message wrapper as the full
        // conversation view. The wrapper supplies the card, role badge and
        // descendant markdown styles that direct body children do not get.
        body.innerHTML = '';
        body.appendChild(this._buildResponseViewerMessage(lastResponse, 'assistant', this._getResponseViewerAgentLabel()));
        this._bindResponseViewerInteractions(body);
      } else {
        body.textContent =
          window.codemanT?.('No response yet — send a message in this session first.') ||
          'No response yet — send a message in this session first.';
      }

      // Reset state for fresh open
      const title = document.getElementById('responseViewerTitle');
      const moreBtn = document.getElementById('responseViewerMore');
      if (title) title.textContent = 'Last Response';
      if (moreBtn) { moreBtn.style.display = ''; moreBtn.textContent = 'More'; }

      viewer.classList.add('visible');
      backdrop.classList.add('visible');
      body.scrollTop = 0;
    } catch (err) {
      console.error('Failed to load response:', err);
    }
  }

  async loadFullContext() {
    if (!this.activeSessionId) return;
    const moreBtn = document.getElementById('responseViewerMore');
    if (moreBtn) moreBtn.textContent = '...';
    try {
      const res = await fetch(`/api/sessions/${this.activeSessionId}/last-response?context=full`);
      const data = (await res.json())?.data ?? {};
      const messages = data.messages || [];
      const body = document.getElementById('responseViewerBody');
      const title = document.getElementById('responseViewerTitle');
      if (!body) return;

      if (messages.length === 0) {
        // Never destroy what the eye button already rendered: the brief view has
        // a terminal-buffer fallback (see toggleResponseViewer) that this
        // endpoint does not, so an empty full-context result must not wipe a
        // real answer the user is reading.
        // ⚠️ Idempotent, because More deliberately stays live here: the branch
        // returns before the button is hidden so a transcript that appears a
        // moment later can still be loaded, and appending would then stack a
        // second identical notice on every retry.
        // `:scope >` keeps the lookup off model-rendered markdown inside .rv-text.
        let notice = body.querySelector(':scope > .rv-notice');
        if (!notice) {
          notice = document.createElement('div');
          notice.className = 'rv-notice';
          body.appendChild(notice);
        }
        const emptyText = 'No full conversation history available for this session';
        notice.textContent = window.codemanT?.(emptyText) || emptyText;
        return;
      }

      // Render conversation thread
      const agentLabel = this._getResponseViewerAgentLabel();
      body.innerHTML = '';
      let previous = null;
      for (const msg of messages) {
        // ⚠️ A numeric `turn` is REQUIRED, never same-role adjacency alone.
        // Only the Claude reader emits turns; Codex and the external-CLI pane
        // parser emit adjacent assistant/response blocks with no turn at all, and
        // an older server emits none either — all three must keep rendering one
        // badged card per message exactly as they do today.
        const continuation =
          !!previous && previous.role === msg.role && typeof msg.turn === 'number' && previous.turn === msg.turn;
        body.appendChild(this._buildResponseViewerMessage(msg.text, msg.role, agentLabel, { ...msg, continuation }));
        previous = msg;
      }
      this._bindResponseViewerInteractions(body);

      const turns = new Set(messages.filter((msg) => typeof msg.turn === 'number').map((msg) => msg.turn)).size;
      if (title) {
        title.textContent = turns
          ? `Conversation (${messages.length} messages, ${turns} turns)`
          : `Conversation (${messages.length} messages)`;
      }
      if (moreBtn) moreBtn.style.display = 'none';
      // Scroll to bottom (latest message)
      body.scrollTop = body.scrollHeight;
    } catch (err) {
      console.error('Failed to load context:', err);
    } finally {
      if (moreBtn) moreBtn.textContent = 'More';
    }
  }

  async _onSessionNeedsRefresh(event = {}) {
    // Server sends this after SSE backpressure clears — terminal data was dropped,
    // so reload the buffer to recover from any display corruption.
    const sessionId = this.activeSessionId;
    if (event?.id && event.id !== sessionId) return;
    if (!sessionId || !this.terminal) return;
    // Skip if buffer load already in progress — avoids competing clear+rewrite cycles
    if (this._isLoadingBuffer) return;
    if (this._terminalRefreshOwner?.sessionId === sessionId) return;
    const refreshOwner = { sessionId };
    this._terminalRefreshOwner = refreshOwner;
    try {
      // A shell can retain a multi-megabyte/100k-line tmux history. Automatic
      // recovery stays bounded just like normal shell selection; only the
      // explicit "Load full history" action is allowed to pay for a full replay.
      // TUI modes still recover the whole picture, with the downgrade guard for
      // repaint-mode panes whose tmux capture can be smaller than xterm's buffer.
      const useFullHistory = this.sessions.get(sessionId)?.mode !== 'shell';
      let res = await fetch(
        useFullHistory
          ? `/api/sessions/${sessionId}/terminal?full=1`
          : `/api/sessions/${sessionId}/terminal?tail=${TERMINAL_TAIL_SIZE}`
      );
      let data = (await res.json())?.data ?? {};
      if (useFullHistory && data.terminalBuffer && this._replayWouldShrinkBuffer(data.terminalBuffer)) {
        res = await fetch(`/api/sessions/${sessionId}/terminal?tail=${TERMINAL_TAIL_SIZE}`);
        data = (await res.json())?.data ?? {};
      }
      // Bail on a tab switch mid-fetch: writing here would paint this session's
      // history into the terminal the user is now looking at. The window is two
      // fetches wide in the fallback case, so this guard is not optional.
      if (this.activeSessionId !== sessionId || this._terminalRefreshOwner !== refreshOwner) return;
      if (data.terminalBuffer) {
        // This refresh is SERVER-triggered, so a user quietly reading scrollback
        // did not ask for it and must not be dragged to the bottom by it (#259).
        // The rewrite replaces the buffer, so an absolute viewportY is
        // meaningless across it — distance from the bottom is what survives.
        const before = this.terminal.buffer?.active;
        const linesFromBottom = before ? Math.max(0, (before.baseY || 0) - (before.viewportY || 0)) : 0;
        this.terminal.clear();
        this.terminal.reset();
        await this.chunkedTerminalWrite(data.terminalBuffer);
        // A tail fetch can be partial, and the banner would otherwise keep
        // describing the pre-refresh buffer (#258).
        this._setHistoryTruncation(sessionId, data);
        const target = computeRewriteScrollLine({
          linesFromBottom,
          baseY: this.terminal.buffer?.active?.baseY ?? 0,
        });
        if (target === null || typeof this.terminal.scrollToLine !== 'function') this.terminal.scrollToBottom();
        else this.terminal.scrollToLine(target);
        // Re-position local echo overlay at new prompt location
        this._localEchoOverlay?.rerender();
        // Resize PTY to match actual browser dimensions (critical for OpenCode
        // TUI sessions that render at fixed 120x40 until told the real size)
        if (this.activeSessionId) {
          this.sendResize(this.activeSessionId);
        }
      }
    } catch (err) {
      console.error('needsRefresh reload failed:', err);
    } finally {
      if (this._terminalRefreshOwner === refreshOwner) this._terminalRefreshOwner = null;
    }
  }

  async _onSessionClearTerminal(data) {
    if (data.id === this.activeSessionId) {
      // Skip if selectSession is already loading the buffer — clearTerminal arriving
      // during buffer load would clear the terminal mid-write, causing visible flicker
      // and a race between two concurrent chunkedTerminalWrite calls (especially on mobile
      // where rAF is slower). selectSession will handle the final buffer state.
      if (this._isLoadingBuffer) return;

      // Fetch buffer, clear terminal, write buffer, resize (no Ctrl+L needed)
      try {
        const res = await fetch(`/api/sessions/${data.id}/terminal`);
        const termData = (await res.json())?.data ?? {};

        this.terminal.clear();
        this.terminal.reset();
        if (termData.terminalBuffer) {
          // Strip any DEC 2026 markers and write raw content
          // (markers don't help here - this is a static buffer reload, not live Ink redraws)
          const cleanBuffer = termData.terminalBuffer.replace(DEC_SYNC_STRIP_RE, '');
          // Use chunked write to avoid UI freeze with large buffers (can be 1-2MB)
          await this.chunkedTerminalWrite(cleanBuffer);
        }

        // Fire-and-forget resize — don't block on it
        this.sendResize(data.id);
        // Re-position local echo overlay at new prompt location
        this._localEchoOverlay?.rerender();
      } catch (err) {
        console.error('clearTerminal refresh failed:', err);
      }
    }
  }

  _onSessionCompletion(data) {
    this.totalCost += data.cost || 0;
    this.updateCost();
    if (data.id === this.activeSessionId) {
      this.terminal.writeln('');
      this.terminal.writeln(`\x1b[1;32m Done (Cost: $${(data.cost || 0).toFixed(4)})\x1b[0m`);
    }
  }

  _onSessionError(data) {
    if (data.id === this.activeSessionId) {
      this.terminal.writeln(`\x1b[1;31m Error: ${data.error}\x1b[0m`);
    }
    this._notifySession(data.id, 'critical', 'session-error', 'Session Error', data.error || 'Unknown error');
  }

  _onSessionExit(data) {
    if (this._wsSessionId === data.id) this._disconnectWs();
    const session = this.sessions.get(data.id);
    if (session) {
      session.status = 'stopped';
      this.renderSessionTabs();
      if (data.id === this.activeSessionId) this._updateLocalEchoState();
    }
    // Notify on unexpected exit (non-zero code)
    if (data.code && data.code !== 0) {
      this._notifySession(data.id, 'critical', 'session-crash', 'Session Crashed', `Exited with code ${data.code}`);
    }
  }

  _onSessionIdle(data) {
    const session = this.sessions.get(data.id);
    if (session) {
      session.status = 'idle';
      this.renderSessionTabs();
      this.sendPendingCtrlL(data.id);
      if (data.id === this.activeSessionId) this._updateLocalEchoState();
    }
    // Start stuck detection timer (only if no respawn running)
    if (!this.respawnStatus[data.id]?.enabled) {
      const threshold = this.notificationManager?.preferences?.stuckThresholdMs || 600000;
      clearTimeout(this.idleTimers.get(data.id));
      this.idleTimers.set(data.id, setTimeout(() => {
        this._notifySession(data.id, 'warning', 'session-stuck', 'Session Idle', `Idle for ${Math.round(threshold / 60000)}+ minutes`);
        this.idleTimers.delete(data.id);
      }, threshold));
    }
  }

  _onSessionWorking(data) {
    const session = this.sessions.get(data.id);
    if (session) {
      session.status = 'busy';
      // Only clear tab alert if no pending hooks (permission_prompt, elicitation_dialog, etc.)
      if (!this.pendingHooks.has(data.id)) {
        this.tabAlerts.delete(data.id);
      }
      this.renderSessionTabs();
      this.sendPendingCtrlL(data.id);
      if (data.id === this.activeSessionId) this._updateLocalEchoState();
    }
    // Clear stuck detection timer
    const timer = this.idleTimers.get(data.id);
    if (timer) {
      clearTimeout(timer);
      this.idleTimers.delete(data.id);
    }
  }

  _onSessionAutoClear(data) {
    if (data.sessionId === this.activeSessionId) {
      this.showToast(`Auto-cleared at ${data.tokens.toLocaleString()} tokens`, 'info');
      this.updateRespawnTokens(0);
    }
    this._notifySession(data.sessionId, 'info', 'auto-clear', 'Auto-Cleared', `Context reset at ${(data.tokens || 0).toLocaleString()} tokens`);
  }

  _onSessionLimitPauseScheduled(data) {
    const session = this.sessions.get(data.sessionId);
    if (session) session.autoResumeAt = data.resumeAt;
    const at = new Date(data.resumeAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    if (data.sessionId === this.activeSessionId) {
      this.showToast(`Usage limit reached — auto-resume at ${at}`, 'warning');
    }
    this._notifySession(data.sessionId, 'warning', 'limit-pause', 'Usage Limit Reached', `Auto-resume scheduled for ${at}`);
    this.updateAutoResumeStatus(data.sessionId);
  }

  _onSessionLimitResume(data) {
    const session = this.sessions.get(data.sessionId);
    if (session) session.autoResumeAt = undefined;
    if (data.sessionId === this.activeSessionId) {
      this.showToast('Usage limit reset — work resumed automatically', 'success');
    }
    this._notifySession(data.sessionId, 'info', 'limit-resume', 'Auto-Resumed', 'Usage limit reset — continuing work');
    this.updateAutoResumeStatus(data.sessionId);
  }

  _onSessionLimitResumeCancelled(data) {
    const session = this.sessions.get(data.sessionId);
    if (session) session.autoResumeAt = undefined;
    this.updateAutoResumeStatus(data.sessionId);
  }

  // COD-118: the interactive PTY exit circuit breaker tripped (repeated non-zero exits).
  // The errored status itself arrives via session:updated; this just surfaces a toast for
  // diagnostic clarity so a silently-looping session is obvious. Restart clears the breaker.
  _onSessionRespawnBreakerTripped(data) {
    const session = this.sessions.get(data.sessionId);
    const label = session?.name || 'Session';
    this.showToast?.(`${label} stopped: repeated crashes detected. Restart to retry.`, 'error');
  }

  _onSessionCliInfo(data) {
    const session = this.sessions.get(data.sessionId);
    if (session) {
      if (data.version) session.cliVersion = data.version;
      if (data.model) session.cliModel = data.model;
      if (data.accountType) session.cliAccountType = data.accountType;
      if (data.latestVersion) session.cliLatestVersion = data.latestVersion;
    }
    if (data.sessionId === this.activeSessionId) {
      this.updateCliInfoDisplay();
    }
  }

  // Claude + Codex plan usage limits — account-global, so the latest sample
  // drives the shared header chip.
  _onSessionStatusTelemetry(data) {
    this.updatePlanUsageChip(data);
    // Persist last-known so the chip shows immediately on the next page load /
    // SSE reconnect, instead of staying blank until a session next renders.
    try {
      localStorage.setItem('codeman:planUsage', JSON.stringify({ t: Date.now(), data }));
    } catch {}
  }

  // Repopulate the chip from the last-known value on page load (account-global,
  // slow-moving; ignored if older than 12h). Live events refresh it.
  restorePlanUsageChip() {
    try {
      const raw = localStorage.getItem('codeman:planUsage');
      if (!raw) return;
      const saved = JSON.parse(raw);
      if (saved?.data && Date.now() - (saved.t || 0) < 12 * 3600 * 1000) {
        this.updatePlanUsageChip(saved.data);
      }
    } catch {}
  }

  updatePlanUsageChip(data) {
    const chip = document.getElementById('planUsageChip');
    if (!chip || !data) return;
    const pct = (w) => (w && typeof w.usedPercentage === 'number' ? Math.round(w.usedPercentage) : null);
    // Per-window color by how much is used up: green < 60%, yellow 60–84%, red ≥ 85%.
    const colorClass = (p) => (p >= 85 ? 'pu-red' : p >= 60 ? 'pu-yellow' : 'pu-green');
    // innerHTML here is XSS-safe ONLY because every interpolated value is a
    // coerced finite number and the labels/classes are fixed literals. If a
    // string field (e.g. modelDisplayName, which the route also broadcasts) is
    // ever shown in this chip, render it via textContent — never interpolate an
    // untrusted string into this template.
    // `idle: true` keeps a missing window's SLOT with a dimmed em dash instead of
    // dropping it. Claude only: Claude Code documents `five_hour` as "present
    // only while the API reports it and its resets_at has not passed", so that
    // key leaves the statusline payload whenever no 5-hour session window is
    // open, and a chip that silently shrank from two windows to one read as a
    // broken feature rather than as an idle window (reported 2026-09-01). A
    // missing CODEX bucket means the opposite — that plan has no such limit —
    // so those stay omitted rather than showing a dash forever.
    const seg = (label, p, idle) => {
      if (p === null) {
        if (!idle) return '';
        return `<span class="pu-win pu-win-idle"><span class="pu-label">${label}</span><span class="pu-val">—</span></span>`;
      }
      const n = Math.round(Number(p));
      if (!Number.isFinite(n)) return '';
      return `<span class="pu-win"><span class="pu-label">${label}</span><span class="pu-val ${colorClass(n)}">${n}%</span></span>`;
    };
    // The provider label only earns its space when there is more than one
    // provider to tell apart: a machine with Claude alone shows bare windows.
    const hasWindows = (usage) => pct(usage?.fiveHour) !== null || pct(usage?.sevenDay) !== null;
    const labelled = hasWindows(data) && hasWindows(data.codex);
    const row = (provider, usage, idle) => {
      // hasWindows() gates the row, so a placeholder can only ever appear
      // ALONGSIDE a real reading — a provider reporting nothing still renders
      // nothing, never a row of em dashes.
      if (!hasWindows(usage)) return '';
      const windows = [seg('5h', pct(usage?.fiveHour), idle), seg('7d', pct(usage?.sevenDay), idle)].filter(Boolean);
      if (!windows.length) return '';
      const label = labelled ? `<span class="pu-provider">${provider}</span>` : '';
      return `<span class="pu-row">${label}<span class="pu-windows">${windows.join('<span class="pu-sep">·</span>')}</span></span>`;
    };
    const rows = [row('Claude', data, true), row('Codex', data.codex, false)].filter(Boolean);
    chip.innerHTML = rows.length ? rows.join('') : '—';
    const resetStr = (w) => (w && w.resetAt ? new Date(w.resetAt).toLocaleString() : '—');
    const details = (provider, usage, idle) => {
      const lines = [];
      const five = pct(usage?.fiveHour);
      const seven = pct(usage?.sevenDay);
      if (five !== null) lines.push(`5-hour limit: ${five}% used (resets ${resetStr(usage.fiveHour)})`);
      else if (idle && seven !== null) lines.push('5-hour limit: no active session window');
      if (seven !== null) lines.push(`Weekly limit: ${seven}% used (resets ${resetStr(usage.sevenDay)})`);
      return lines.length ? `${provider} plan usage\n${lines.join('\n')}` : '';
    };
    chip.title =
      [details('Claude', data, true), details('Codex', data.codex, false)].filter(Boolean).join('\n\n') ||
      'Plan usage limits';
  }

  // Scheduled runs
  _onScheduledCreated(data) {
    this.currentRun = data;
    this.showTimer();
  }

  _onScheduledUpdated(data) {
    this.currentRun = data;
    this.updateTimer();
  }

  _onScheduledCompleted(data) {
    this.currentRun = data;
    this.hideTimer();
    this.showToast('Scheduled run completed!', 'success');
  }

  _onScheduledStopped() {
    this.currentRun = null;
    this.hideTimer();
  }

  // ═══════════════════════════════════════════════════════════════
  // Connection Status, Input Queuing & State Initialization
  // ═══════════════════════════════════════════════════════════════

  setConnectionStatus(status) {
    this._connectionStatus = status;
    // Track when the transport left 'connected'. The connection-loss UI waits
    // out a deploy-length blip before showing anything (see constants.js).
    if (status === 'connected') {
      this._connDownSince = null;
      this._nextSseRetryAt = null;
      this._offlineOverlayDismissed = false;
    } else if (this._connDownSince === null) {
      this._connDownSince = Date.now();
    }
    this._updateConnectionIndicator();
    this._updateConnectionLossUi();
    if (status === 'connected') {
      // Reconnected (SSE) — push any durably-queued input out immediately
      // instead of waiting for the next 2s sweep.
      this._redeliverSweep();
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // WebSocket Terminal I/O
  // ═══════════════════════════════════════════════════════════════

  /**
   * Open a WebSocket for terminal I/O on the given session.
   * Replaces HTTP POST input and SSE terminal output with a single
   * bidirectional connection. Falls back to SSE+POST if WS fails.
   */
  _connectWs(sessionId) {
    this._disconnectWs();
    this._wsState = 'connecting';
    this._updateConnectionIndicator();

    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    // Pass a per-TAB identity on the upgrade URL so the server's connection
    // registry scopes the per-session limit by connection (COD-137): a same-tab
    // reconnect supersedes its own socket instead of consuming a new slot and
    // tripping a spurious 4008, while two tabs of the same browser (which share
    // the localStorage clientId) each keep their own socket. The bare clientId
    // still rides the input frames for seq dedup. Omitted if clientId is
    // unavailable (server then treats the upgrade as anonymous — still admitted
    // up to the limit).
    const cid = this._clientId ? `${this._clientId}:${this._wsTabNonce}` : '';
    const cidQuery = cid ? `?cid=${encodeURIComponent(cid)}` : '';
    const url = `${proto}//${location.host}${CodemanBase.base}/ws/sessions/${sessionId}/terminal${cidQuery}`;
    const ws = new WebSocket(url);
    this._ws = ws;
    this._wsSessionId = sessionId;

    ws.onopen = () => {
      // Only mark ready if this is still the intended session
      if (this._ws === ws) {
        this._wsReady = true;
        this._wsState = 'connected';
        this._wsReconnectAttempts = 0;
        this._updateConnectionIndicator();
        // Send a typed resize over the fresh socket: syncs PTY dims after
        // (re)connects AND registers the desktop sizing claim server-side —
        // selectSession's earlier resizes ran before this WS existed, so they
        // went over HTTP, which never claims (see ws-routes sizingToken).
        this.sendResize(sessionId)?.catch?.(() => {});
        this._startMobileResizeRetry(sessionId);
        // Flush any durably-queued input over the fresh socket (covers frames a
        // prior half-open socket silently dropped, and input typed while offline).
        this._onWsReady(sessionId);
      }
    };

    ws.onmessage = (event) => {
      if (this._ws !== ws) return;
      // Mark the socket as alive on every received frame (output, ACK, etc.) so
      // the redeliver sweep only force-closes a genuinely silent connection.
      this._wsLastRecvAt = Date.now();
      try {
        const msg = JSON.parse(event.data);
        if (msg.t === 'o') {
          // Terminal output — route through the same batching pipeline as SSE
          this._onSessionTerminal({ id: sessionId, data: msg.d });
        } else if (msg.t === 'c') {
          this._onSessionClearTerminal({ id: sessionId });
        } else if (msg.t === 'r') {
          this._onSessionNeedsRefresh({ id: sessionId });
        } else if (msg.t === 'ia') {
          // Input ACK — the server applied (or deduped) this seq; drop it from
          // the durable queue so it can never be re-delivered/lost.
          this._onWsInputAck(msg.seq);
        }
      } catch {
        // Ignore malformed messages
      }
    };

    ws.onclose = (event) => {
      if (this._ws !== ws) return;
      this._ws = null;
      this._wsSessionId = null;
      this._wsReady = false;
      this._stopMobileResizeRetry();

      // Decide what to do next from the close code + how many consecutive
      // reconnects we've already made (pure policy in constants.js):
      //   reconnect      → transient (server restart, network blip, ping timeout);
      //                    schedule a backoff retry while this session stays active.
      //   retry-fallback → too-many-connections / unknown rejection; show the HTTP
      //                    fallback but keep retrying so we return to WS when it clears.
      //   give-up        → 4004 (not found) / 4009 (terminated); the session is gone.
      // _disconnectWs() nulls onclose for intentional disconnects, so we never land here for those.
      const plan = window.CodemanWsReconnect.plan(event.code, this._wsReconnectAttempts || 0);
      _crashDiag.log(
        `WS CLOSE code=${event.code} reason=${event.reason || ''} action=${plan.action} attempts=${this._wsReconnectAttempts || 0}`
      );

      const stillActive = this.activeSessionId === sessionId;
      if (plan.action === 'give-up') {
        this._wsState = stillActive ? 'fallback' : 'disconnected';
        this._updateConnectionIndicator();
      } else if (plan.action === 'reconnect') {
        if (stillActive) {
          this._wsState = 'reconnecting';
          this._updateConnectionIndicator();
          const delay = plan.delayMs + Math.floor(Math.random() * 250); // jitter to de-sync herds
          this._wsReconnectAttempts = (this._wsReconnectAttempts || 0) + 1;
          this._wsReconnectTimer = setTimeout(() => {
            this._wsReconnectTimer = null;
            if (this.activeSessionId === sessionId) {
              this._connectWs(sessionId);
            }
          }, delay);
        } else {
          this._wsState = 'disconnected';
          this._updateConnectionIndicator();
        }
      } else {
        // retry-fallback: surface the HTTP fallback, but keep trying on a bounded
        // timer so the transport returns to WS once the transient condition clears.
        this._wsState = stillActive ? 'fallback' : 'disconnected';
        this._updateConnectionIndicator();
        if (stillActive) {
          this._wsReconnectAttempts = (this._wsReconnectAttempts || 0) + 1;
          this._wsReconnectTimer = setTimeout(() => {
            this._wsReconnectTimer = null;
            if (this.activeSessionId === sessionId) {
              this._connectWs(sessionId);
            }
          }, plan.delayMs);
        }
      }
    };

    ws.onerror = () => {
      // onclose will fire after onerror — cleanup happens there
    };
  }

  /** Close the active WebSocket connection (if any). */
  _disconnectWs() {
    this._clearTimer('_wsReconnectTimer');
    // Deliberately do NOT reset _wsReconnectAttempts here: _connectWs() calls
    // this first, so a reset would restart the exponential backoff ladder at
    // attempt 0 on every retry (≈0ms tight reconnect loop during an outage).
    // ws.onopen zeroes the counter once a connection actually succeeds.
    this._wsState = 'disconnected';
    this._stopMobileResizeRetry();
    if (this._ws) {
      this._ws.onclose = null; // Prevent re-entrant cleanup
      this._ws.close();
      this._ws = null;
      this._wsSessionId = null;
      this._wsReady = false;
    }
  }

  /**
   * Small-viewport claim-idle retry. While a desktop sizing claim is "hot",
   * the server ignores this device's resize (Session.DESKTOP_CLAIM_IDLE_MS),
   * and the single resize sent on attach is deduped client-side — without a
   * retry, a phone that attached under an active desktop would render a
   * desktop-width stream forever. Re-send the current dims periodically (a
   * server-side no-op once the pane already matches) so the pane reflows to
   * this device shortly after the desktop goes idle. Visible-tab only: a
   * phone in a pocket must not steal the pane from an active desktop.
   */
  _startMobileResizeRetry(sessionId) {
    this._stopMobileResizeRetry();
    const type =
      typeof MobileDetection !== 'undefined' && MobileDetection.getDeviceType
        ? MobileDetection.getDeviceType()
        : 'desktop';
    if (type === 'desktop') return;
    this._mobileResizeRetryTimer = setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      if (!this._wsReady || this._wsSessionId !== sessionId) return;
      // Same guard as throttledResize: while the virtual keyboard is up, a
      // fit()+SIGWINCH at the shrunken row count makes Ink re-render garbage
      // and shifts the accessory toolbar mid-typing. Retry after it closes.
      if (typeof KeyboardHandler !== 'undefined' && KeyboardHandler.keyboardVisible) return;
      this.sendResize(sessionId)?.catch?.(() => {});
    }, MOBILE_RESIZE_RETRY_MS);
  }

  _stopMobileResizeRetry() {
    if (this._mobileResizeRetryTimer) {
      clearInterval(this._mobileResizeRetryTimer);
      this._mobileResizeRetryTimer = null;
    }
  }

  /**
   * Public input entry point — name/signature kept for all call sites.
   * Records the input durably, then delivers it reliably (exactly-once). Never
   * blocks the keystroke flush; never silently drops on a half-open socket.
   * @param {string} sessionId
   * @param {string} input
   * @param {{useMux?: boolean}} [opts] - useMux only affects the POST fallback.
   */
  _sendInputAsync(sessionId, input, opts) {
    if (!sessionId || !input) return;
    this._reliableSend(sessionId, input, opts?.useMux === true);
  }

  /**
   * Fire-and-forget input for EPHEMERAL, loss-tolerant streams (e.g. wheel-scroll
   * reports). Unlike _sendInputAsync, this never enters the durable seq/ACK queue,
   * so it isn't persisted, retried, or counted in the pending-bytes connection
   * indicator (which was flickering "11b/22b queued" on every scroll tick). A
   * dropped scroll tick is harmless; keystrokes still go through _sendInputAsync.
   * The server applies a seq-less {t:'i'} frame / seq-less POST unconditionally
   * and sends no ACK (ws-routes.ts, session-routes input handler).
   */
  _sendInputEphemeral(sessionId, input) {
    if (!sessionId || !input) return;
    if (this._ws && this._ws.readyState === WebSocket.OPEN && this._wsSessionId === sessionId) {
      try {
        this._ws.send(JSON.stringify({ t: 'i', d: input }));
        return;
      } catch {
        // socket died mid-send — fall through to a best-effort POST
      }
    }
    // No usable WS for this session: best-effort POST, not queued. Dropped on
    // failure — a scroll tick lost while offline needs no recovery.
    try {
      fetch(`/api/sessions/${sessionId}/input`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input }),
        keepalive: true,
      }).catch(() => {});
    } catch {
      // ignore — loss-tolerant
    }
  }

  /** Record one input frame and kick delivery. The record lives until ACKed. */
  _reliableSend(sessionId, data, useMux) {
    const seq = this._nextSeq(sessionId);
    const rec = { seq, data, useMux: !!useMux, ts: Date.now(), tries: 0, sentAt: 0 };
    let list = this._pendingDeliveries.get(sessionId);
    if (!list) {
      list = [];
      this._pendingDeliveries.set(sessionId, list);
    }
    list.push(rec);
    this._persistReliableState();
    this._updateConnectionIndicator();
    this._drainSession(sessionId);
  }

  _nextSeq(sessionId) {
    const next = (this._seqCounters.get(sessionId) || 0) + 1;
    this._seqCounters.set(sessionId, next);
    return next;
  }

  /** Deliver all unacked records for a session, in seq order. */
  _drainSession(sessionId) {
    const list = this._pendingDeliveries.get(sessionId);
    if (!list || list.length === 0) return;

    // Fast path: WebSocket open for this session — fire each not-yet-sent record
    // over the single ordered stream. They stay pending until the server ACKs
    // them ({t:'ia'}); a frame swallowed by a half-open socket is re-sent after
    // the sweep force-reconnects (which resets sentAt=0 in _onWsReady).
    if (this._ws && this._ws.readyState === WebSocket.OPEN && this._wsSessionId === sessionId) {
      for (const rec of list) {
        if (rec.sentAt !== 0) continue;
        try {
          this._ws.send(JSON.stringify({ t: 'i', d: rec.data, seq: rec.seq, cid: this._clientId }));
          rec.sentAt = Date.now();
          rec.tries++;
        } catch {
          break; // socket died mid-send — reconnect/POST drainer retries
        }
      }
      return;
    }

    // Slow path: no WS — POST records in order, awaiting each (the HTTP 2xx is
    // the ACK). Serialized per session so seq order survives async fetches.
    if (this._postDraining.has(sessionId)) return;
    this._postDraining.add(sessionId);
    (async () => {
      try {
        for (;;) {
          const cur = this._pendingDeliveries.get(sessionId);
          if (!cur || cur.length === 0) break;
          // If the WebSocket came back mid-drain, yield to it (the acked stream)
          // so we don't redundantly re-POST what onopen is already re-sending.
          if (this._ws && this._ws.readyState === WebSocket.OPEN && this._wsSessionId === sessionId) {
            break;
          }
          const rec = cur[0];
          rec.tries++;
          rec.sentAt = Date.now();
          let resp = null;
          try {
            const body = { input: rec.data, seq: rec.seq, clientId: this._clientId };
            if (rec.useMux) body.useMux = true;
            resp = await fetch(`/api/sessions/${sessionId}/input`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(body),
              keepalive: rec.data.length < 65536,
            });
          } catch {
            resp = null;
          }
          if (resp && resp.ok) {
            this._ackDelivery(sessionId, rec.seq);
          } else if (resp && (resp.status === 404 || resp.status === 410)) {
            // Session no longer exists — the input can never land. Drop it
            // rather than retry forever (not a "lost" prompt: the target is gone).
            this._ackDelivery(sessionId, rec.seq);
          } else {
            break; // offline / 5xx — leave queued; sweep + reconnect retry later
          }
        }
      } finally {
        this._postDraining.delete(sessionId);
      }
    })();
  }

  /** Drop an ACKed record (by exact seq) and persist. */
  _ackDelivery(sessionId, seq) {
    const list = this._pendingDeliveries.get(sessionId);
    if (list) {
      const idx = list.findIndex((r) => r.seq === seq);
      if (idx !== -1) {
        list.splice(idx, 1);
        if (list.length === 0) this._pendingDeliveries.delete(sessionId);
        // When nothing is left pending anywhere, flush durable state immediately
        // (not debounced) so a reload in the next 250ms can't redeliver an
        // already-delivered frame — otherwise localStorage briefly still shows it.
        if (this._pendingDeliveries.size === 0) this._persistReliableNow();
        else this._persistReliableState();
        this._updateConnectionIndicator();
      }
    }
    // ⚠️ IDLE ONLY, and acknowledged server-side rather than cleared in memory.
    // Delivering input answers "Claude is waiting for a prompt" by definition,
    // so this is the same "I am on it" signal as opening the tab. It does NOT
    // answer a permission/question dialog: those ignore any keystroke that is
    // not one of their options, so the dialog is still up and still needs you.
    // Clearing action alerts here hid a LIVE alert on this device alone (the
    // other devices stayed red and a reload re-seeded it straight back).
    this.markIdleAlertSeen?.(sessionId);
  }

  /** Server input-ACK frame ({t:'ia',seq}) over the WebSocket. */
  _onWsInputAck(seq) {
    if (this._wsSessionId && Number.isInteger(seq)) this._ackDelivery(this._wsSessionId, seq);
  }

  /** Called from ws.onopen — flush everything pending over the fresh socket. */
  _onWsReady(sessionId) {
    const list = this._pendingDeliveries.get(sessionId);
    if (list) for (const r of list) r.sentAt = 0; // fresh socket ⇒ re-send all
    this._drainSession(sessionId);
  }

  /**
   * Periodic retry. For the active WS session, an oldest frame unacked past the
   * timeout means the socket is (half-)dead — close it to force a fast reconnect
   * (onclose → reconnect → onopen → _onWsReady re-sends). Other sessions just
   * (re)drain over POST.
   */
  _redeliverSweep() {
    if (this._pendingDeliveries.size === 0) return;
    for (const sessionId of [...this._pendingDeliveries.keys()]) {
      const list = this._pendingDeliveries.get(sessionId);
      if (!list || list.length === 0) continue;
      const isActiveWs =
        this._ws && this._ws.readyState === WebSocket.OPEN && this._wsSessionId === sessionId;
      if (isActiveWs) {
        const oldest = list[0];
        // Only tear the socket down when the oldest unacked frame is stale AND the
        // socket has been silent for the timeout: a connection still delivering
        // output/ACKs is alive (the ACK is just behind), so force-closing it would
        // cause needless WS↔HTTP flapping. A truly half-open socket goes quiet.
        const stale = oldest && oldest.sentAt && Date.now() - oldest.sentAt > this._reliableAckTimeoutMs;
        const silent = Date.now() - this._wsLastRecvAt > this._reliableAckTimeoutMs;
        if (stale && silent) {
          try {
            this._ws.close(); // half-open: never recovers on its own — force reconnect
          } catch {
            /* ignore */
          }
          continue;
        }
        if (stale) {
          // Stale but the socket is still delivering output: the ACK was lost,
          // not the connection. Force-closing isn't warranted (the link is fine),
          // but the fast path skips anything with sentAt!==0, so the stranded
          // frame would never re-send. Reset sentAt=0 on every stale unacked
          // frame so the _drainSession below re-drives them over the live socket
          // (server dedups by seq, so a re-sent lost-ACK frame is harmless).
          // Frames sent recently (not yet stale) are left untouched.
          for (const rec of list) {
            if (rec.sentAt && Date.now() - rec.sentAt > this._reliableAckTimeoutMs) rec.sentAt = 0;
          }
        }
      }
      this._drainSession(sessionId);
    }
  }

  /** Total bytes/count still awaiting ACK across all sessions (for the indicator). */
  _pendingBytes() {
    let bytes = 0;
    let count = 0;
    for (const list of this._pendingDeliveries.values()) {
      for (const r of list) {
        bytes += r.data.length;
        count++;
      }
    }
    return { bytes, count };
  }

  // ---- durable persistence (localStorage; quota- and disabled-storage-safe) --

  _loadReliableState() {
    // Stable client identity for server-side dedup across reconnects/reloads.
    try {
      this._clientId = localStorage.getItem('codeman:clientId') || '';
    } catch {
      this._clientId = '';
    }
    if (!this._clientId) {
      this._clientId = 'c-' + Math.random().toString(36).slice(2) + '-' + Date.now().toString(36);
      try {
        localStorage.setItem('codeman:clientId', this._clientId);
      } catch {
        /* storage disabled — dedup degrades to per-load, still no loss */
      }
    }
    try {
      const raw = localStorage.getItem('codeman:pendingInput');
      if (!raw) return;
      const saved = JSON.parse(raw);
      if (saved && saved.seqs) {
        for (const [s, n] of Object.entries(saved.seqs)) {
          if (Number.isFinite(n)) this._seqCounters.set(s, n);
        }
      }
      if (saved && saved.pending) {
        for (const [s, recs] of Object.entries(saved.pending)) {
          if (Array.isArray(recs) && recs.length) {
            // Reset sentAt so they re-deliver promptly on this fresh load.
            this._pendingDeliveries.set(
              s,
              recs
                .filter((r) => r && typeof r.data === 'string' && Number.isInteger(r.seq))
                .map((r) => ({
                  seq: r.seq,
                  data: r.data,
                  useMux: !!r.useMux,
                  ts: r.ts || Date.now(),
                  tries: 0,
                  sentAt: 0,
                }))
            );
          }
        }
      }
    } catch {
      /* corrupt/parse error — start clean rather than throw */
    }
  }

  _persistReliableState() {
    // Debounced — typing without local echo calls this per keystroke.
    if (this._persistReliableTimer) return;
    this._persistReliableTimer = setTimeout(() => {
      this._persistReliableTimer = null;
      this._persistReliableNow();
    }, 250);
  }

  _persistReliableNow() {
    if (this._persistReliableTimer) {
      clearTimeout(this._persistReliableTimer);
      this._persistReliableTimer = null;
    }
    try {
      const seqs = {};
      for (const [s, n] of this._seqCounters) seqs[s] = n;
      const pending = {};
      let bytes = 0;
      for (const [s, list] of this._pendingDeliveries) {
        if (!list.length) continue;
        pending[s] = list.map((r) => ({
          seq: r.seq,
          data: r.data,
          useMux: r.useMux,
          ts: r.ts,
          tries: r.tries,
        }));
        for (const r of list) bytes += r.data.length;
      }
      // Bound the persisted backlog. On extreme overflow keep the seq counters
      // (so future input stays monotonic and dedup-safe) but skip the payloads —
      // the in-memory queue still delivers; only cross-reload durability is lost.
      const payload =
        bytes > this._reliableMaxBytes ? { seqs } : { seqs, pending };
      localStorage.setItem('codeman:pendingInput', JSON.stringify(payload));
    } catch {
      /* QuotaExceeded or disabled storage — in-memory delivery is unaffected */
    }
  }

  // Pure render of the header connection indicator: reads only `this.*` state,
  // touches NO DOM. Returns the exact { display, dotClass, text, title } tuple the
  // writer applies. When hidden (display:'none') the other three are normalized to
  // '' so the cache compare in _updateConnectionIndicator() is well-defined.
  // Every branch/string here must stay byte-identical to what's rendered today.
  _computeConnectionDescriptor() {
    const { bytes: totalBytes, count } = this._pendingBytes();
    const hasQueue = count > 0;
    // Only surface a backlog once it's more than a few bytes. A single keystroke
    // (1B) ACKs in milliseconds, so without this the label flickered "sending 1B"
    // on every key press. Above this threshold means input is genuinely backing up.
    const BACKLOG_HINT_BYTES = 4;
    const showBacklog = totalBytes > BACKLOG_HINT_BYTES;
    const formatBytes = (b) => (b < 1024 ? `${b}B` : `${(b / 1024).toFixed(1)}KB`);
    const queuedSuffix = showBacklog ? ` · ${formatBytes(totalBytes)} queued` : '';

    // Hard offline (browser reports no network) dominates everything.
    if (!this.isOnline || this._connectionStatus === 'offline') {
      return {
        display: 'flex',
        dotClass: 'connection-dot offline',
        text: showBacklog ? `Offline (${formatBytes(totalBytes)} queued)` : 'Offline',
        title: 'No network connection',
      };
    }

    // With an active terminal, show its transport (WebSocket vs HTTP fallback).
    if (this.activeSessionId) {
      let cls, label, detail;
      switch (this._wsState) {
        case 'connected':
          cls = 'connected'; label = 'WS'; detail = 'Terminal connected over WebSocket';
          break;
        case 'fallback':
          cls = 'fallback'; label = 'HTTP'; detail = 'WebSocket unavailable — input sent over HTTP';
          break;
        case 'reconnecting':
          cls = 'reconnecting'; label = 'WS…'; detail = 'Reconnecting WebSocket';
          break;
        case 'connecting':
        default:
          cls = 'reconnecting'; label = 'WS…'; detail = 'Connecting WebSocket';
          break;
      }
      return {
        display: 'flex',
        dotClass: `connection-dot ${cls}`,
        text: `${label}${queuedSuffix}`,
        title: detail,
      };
    }

    // No active terminal — reflect the SSE event stream only when it needs attention.
    if (this._connectionStatus === 'reconnecting' || this._connectionStatus === 'disconnected') {
      return {
        display: 'flex',
        dotClass: 'connection-dot reconnecting',
        text: showBacklog ? `Reconnecting (${formatBytes(totalBytes)} queued)` : 'Reconnecting...',
        title: 'Reconnecting to server',
      };
    }

    // Idle dashboard, healthy stream — hide unless input is genuinely queued.
    if (!hasQueue) {
      return { display: 'none', dotClass: '', text: '', title: '' };
    }
    return {
      display: 'flex',
      dotClass: 'connection-dot draining',
      text: showBacklog ? `Sending ${formatBytes(totalBytes)}...` : 'Sending...',
      title: 'Delivering queued input',
    };
  }

  _updateConnectionIndicator() {
    const indicator = this.$('connectionIndicator');
    const dot = this.$('connectionDot');
    const text = this.$('connectionText');
    if (!indicator || !dot || !text) return;

    // Called on EVERY keystroke (_reliableSend) and EVERY ACK (_ackDelivery).
    // During fast typing the rendered tuple is usually identical, so skip the DOM
    // writes when nothing changed (COD-136) — the compute above is DOM-free.
    const next = this._computeConnectionDescriptor();
    const prev = this._lastIndicatorDescriptor;
    if (
      prev &&
      prev.display === next.display &&
      prev.dotClass === next.dotClass &&
      prev.text === next.text &&
      prev.title === next.title
    ) {
      return;
    }
    this._lastIndicatorDescriptor = next;

    indicator.style.display = next.display;
    if (next.display !== 'none') {
      dot.className = next.dotClass;
      text.textContent = next.text;
      indicator.title = next.title;
    }
  }

  setupOnlineDetection() {
    window.addEventListener('online', () => {
      this.isOnline = true;
      this.reconnectAttempts = 0;
      // Restart the grace window: the radio just came back, so the next couple
      // of seconds of "not connected" are expected, not a server problem.
      this._connDownSince = Date.now();
      this.connectSSE();
      // Network came back — drain durably-queued input right away.
      this._redeliverSweep();
    });
    window.addEventListener('offline', () => {
      this.isOnline = false;
      this.setConnectionStatus('offline');
    });
  }

  // ── Connection-loss UI ─────────────────────────────────────────────────────
  // Why this exists: the service worker serves the cached app shell, so opening
  // Codeman with the server unreachable (phone off the tailnet, VPN down,
  // server stopped) rendered a normal-looking but empty dashboard whose only
  // hint was an 8px red dot in the header corner. The decision of what to show
  // is pure (computeConnectionLossUi in constants.js); this is the writer.

  /** Apply the offline banner / overlay for the current connection state. */
  _updateConnectionLossUi() {
    const policy = window.CodemanConnectionLoss;
    const banner = this.$('offlineBanner');
    const overlay = this.$('offlineOverlay');
    if (!policy || !banner || !overlay) return;

    const state = policy.compute({
      isOnline: this.isOnline,
      status: this._connectionStatus,
      // Server state has landed at least once this page load (SSE `init`), so
      // there is a UI worth keeping visible behind a non-blocking banner.
      everLoaded: this._initGeneration > 0,
      downSince: this._connDownSince,
      now: Date.now(),
      nextRetryAt: this._nextSseRetryAt,
      overlayDismissed: this._offlineOverlayDismissed,
      retryPending: this._offlineRetryPending,
    });

    // The ticker drives both the countdown and the grace deadline; neither is
    // event-driven, so it must run whenever the transport is down, including
    // while the decision is still 'hidden' inside the grace window.
    if (this._connDownSince === null) this._stopOfflineTicker();
    else this._startOfflineTicker();

    const retryLabel = this._offlineRetryPending
      ? 'Reconnecting…'
      : state.retryInSec != null && state.retryInSec > 0
        ? `Retrying in ${state.retryInSec}s`
        : 'Retrying…';

    // Called every second by the ticker, so skip the DOM writes when the rendered
    // result is unchanged (same reasoning as _updateConnectionIndicator).
    const key = `${state.mode}|${state.kind}|${retryLabel}`;
    if (key === this._lastOfflineUiKey) return;
    this._lastOfflineUiKey = key;

    banner.hidden = state.mode !== 'banner';
    overlay.hidden = state.mode !== 'overlay';
    document.body.classList.toggle('connection-lost', state.mode !== 'hidden');

    if (state.mode === 'banner') {
      const text = this.$('offlineBannerText');
      const detail = this.$('offlineBannerDetail');
      if (text) text.textContent = state.title;
      if (detail) detail.textContent = retryLabel;
    } else if (state.mode === 'overlay') {
      const title = this.$('offlineOverlayTitle');
      const body = this.$('offlineOverlayBody');
      const host = this.$('offlineOverlayHost');
      const status = this.$('offlineOverlayStatus');
      if (title) title.textContent = state.title;
      if (body) body.textContent = state.detail;
      if (host) host.textContent = location.host;
      if (status) status.textContent = retryLabel;
    }
  }

  _startOfflineTicker() {
    if (this._offlineUiTicker) return;
    this._offlineUiTicker = setInterval(() => this._updateConnectionLossUi(), 1000);
  }

  _stopOfflineTicker() {
    if (!this._offlineUiTicker) return;
    clearInterval(this._offlineUiTicker);
    this._offlineUiTicker = null;
  }

  /** Retry button on the banner/overlay: reconnect now instead of waiting out
   *  the backoff (capped at 30s, and the WS plan can give up entirely). */
  retryConnection() {
    this._offlineRetryPending = true;
    this._nextSseRetryAt = null;
    this.reconnectAttempts = 0;
    this._clearTimer('sseReconnectTimeout');
    this.isOnline = navigator.onLine;
    this._lastOfflineUiKey = '';
    this._updateConnectionLossUi();
    this.connectSSE();
    // The terminal socket does not always come back on its own (planWsReconnect
    // 'give-up'), so the same button re-arms it.
    if (this.activeSessionId && this._wsState !== 'connected') {
      this._wsReconnectAttempts = 0;
      this._connectWs(this.activeSessionId);
    }
    this._clearTimer('_offlineRetryTimer');
    this._offlineRetryTimer = setTimeout(() => {
      this._offlineRetryPending = false;
      this._lastOfflineUiKey = '';
      this._updateConnectionLossUi();
    }, 1500);
  }

  /** "Show cached view": demote the blocking overlay to the banner for the rest
   *  of this outage, so the cached UI can be inspected offline. */
  dismissOfflineOverlay() {
    this._offlineOverlayDismissed = true;
    this._lastOfflineUiKey = '';
    this._updateConnectionLossUi();
  }

  /** Show/hide the CJK input textarea based on user setting or server override */
  _updateCjkInputState() {
    const cjkEl = document.getElementById('cjkInput');
    if (!cjkEl) return;
    const settings = this.loadAppSettingsFromStorage();
    const defaults = this.getDefaultSettings?.() || {};
    // Mobile defaults ship cjkInputEnabled: false (native terminal input by
    // default on touch), but an explicit user enable is honored everywhere —
    // the App Settings toggle must not be a silent no-op on phones.
    // The welcome/home screen (no active session) has nothing to type into.
    // Force-hide the CJK textarea there — otherwise the `position: fixed`
    // `.cjk-input-visible` rule floats it over the welcome overlay and blocks
    // content. Re-synced on session enter/leave via hideWelcome()/showWelcome().
    const cjkUserEnabled =
      this._serverCjkOverride || (settings.cjkInputEnabled ?? defaults.cjkInputEnabled ?? false);
    const showCjk = cjkUserEnabled && !!this.activeSessionId;
    cjkEl.classList.toggle('cjk-input-visible', !!showCjk);
    document.body.classList.toggle('cjk-input-visible', !!showCjk);
    cjkEl.style.display = showCjk ? 'block' : 'none';
    cjkEl.setAttribute('aria-hidden', showCjk ? 'false' : 'true');
    if (!showCjk) window.cjkActive = false;
    if (typeof KeyboardHandler !== 'undefined') KeyboardHandler.updateLayoutForKeyboard();
  }

  /**
   * Reset all app state maps, timers, and handlers to a clean baseline.
   * Called by handleInit() on SSE reconnect / page reload to prevent
   * memory leaks and stale data.
   */
  _resetAllAppState() {
    this.sessions.clear();
    this.ralphStates.clear();
    this.terminalBuffers.clear();
    this.terminalBufferCache.clear();
    this._xtermSnapshots?.clear();
    this.projectInsights.clear();
    this.teams.clear();
    this.teamTasks.clear();
    // Clear all idle timers to prevent stale timers from firing
    for (const timer of this.idleTimers.values()) {
      clearTimeout(timer);
    }
    this.idleTimers.clear();
    // Clear flicker filter state
    this._clearTimer('flickerFilterTimeout');
    this.flickerFilterBuffer = '';
    this.flickerFilterActive = false;
    // Clear pending terminal writes
    this._clearTimer('syncWaitTimeout');
    this._clearTimer('_clientDropRecoveryTimer');
    this.pendingWrites = [];
    this.writeFrameScheduled = false;
    // Release the one-chunk-in-flight gate with the rest of the write queue.
    // flushPendingWrites() early-returns while this is set, so a reset that
    // cleared everything EXCEPT this flag would leave live output permanently
    // stalled if xterm's parse callback never lands (disposed terminal, or a
    // throw inside the async parse). A late callback is harmless: it clears an
    // already-clear flag and schedules a flush.
    this._terminalWriteInFlight = false;
    this._terminalWriteInFlightBytes = 0;
    this._isLoadingBuffer = false;
    this._loadBufferQueue = null;
    this._bufferLoadOwner = null;
    this._terminalRefreshOwner = null;
    // Abort any in-flight chunkedTerminalWrite (SSE reconnect reloads buffers)
    this._chunkedWriteGen = (this._chunkedWriteGen || 0) + 1;
    // Preserve local echo overlay text across SSE reconnect — just hide until
    // terminal buffer reloads and prompt is visible again.  _render() re-scans
    // for the ❯ prompt on every call, so rerender() after buffer load repositions it.
    this._localEchoOverlay?.rerender();
    // Deliberate asymmetry: buffer-mode pending text SURVIVES reconnect (not
    // yet sent); predictions do not (their keystrokes were already delivered).
    this._predictiveEcho?.clearPredictions();
    // Clear pending hooks
    this.pendingHooks.clear();
    // Clear approvals (re-seeded from GET /api/approvals right after init)
    this.approvals?.clear();
    // Clear parent name cache (prevents stale session name entries accumulating)
    if (this._parentNameCache) this._parentNameCache.clear();
    // Clear subagent activity/results maps (prevents leaks if data.subagents is missing)
    this.subagentActivity.clear();
    this.subagentToolResults.clear();
    // Clear ultracode workflow run state (re-seeded from data.workflowRuns below)
    if (this.workflowRuns) this.workflowRuns.clear();
    if (this.workflowRunDetails) this.workflowRunDetails.clear();
    this.activeWorkflowRunId = null;
    this.activeWorkflowPhaseIndex = null;
    // Clean up mobile/keyboard handlers and re-init (prevents listener accumulation on reconnect)
    MobileDetection.cleanup();
    KeyboardHandler.cleanup();
    MobileDetection.init();
    KeyboardHandler.init();
    // Clear tab alerts
    this.tabAlerts.clear();
    this.attachmentHistoryCounts.clear();
    // Clear shown completions (used for duplicate notification prevention)
    if (this._shownCompletions) {
      this._shownCompletions.clear();
    }
    // Clear notification manager title flash interval to prevent memory leak
    if (this.notificationManager?.titleFlashInterval) {
      clearInterval(this.notificationManager.titleFlashInterval);
      this.notificationManager.titleFlashInterval = null;
    }
    // Clear notification manager grouping timeouts (prevents orphaned timers)
    if (this.notificationManager?.groupingMap) {
      for (const { timeout } of this.notificationManager.groupingMap.values()) {
        clearTimeout(timeout);
      }
      this.notificationManager.groupingMap.clear();
    }
    // Disconnect terminal resize observer (prevents memory leak on reconnect)
    if (this.terminalResizeObserver) {
      this.terminalResizeObserver.disconnect();
      this.terminalResizeObserver = null;
    }
    // Clear any other orphaned timers
    if (this.planLoadingTimer) {
      clearInterval(this.planLoadingTimer);
      this.planLoadingTimer = null;
    }
    if (this.timerCountdownInterval) {
      clearInterval(this.timerCountdownInterval);
      this.timerCountdownInterval = null;
    }
    if (this.runSummaryAutoRefreshTimer) {
      clearInterval(this.runSummaryAutoRefreshTimer);
      this.runSummaryAutoRefreshTimer = null;
    }
  }

  handleInit(data) {
    // Clear the init fallback timer since we got data
    this._clearTimer('_initFallbackTimer');
    const gen = ++this._initGeneration;

    // CJK input form: controlled by user setting (with server env as override)
    this._serverCjkOverride = data.inputCjkForm || false;
    this._updateCjkInputState();

    // Plan-usage chip: server's last-known telemetry, so it shows immediately on
    // a fresh load / reconnect (authoritative; wins over the localStorage restore).
    if (data.planUsage) this.updatePlanUsageChip(data.planUsage);

    // Update version displays (header and toolbar)
    if (data.version) {
      const versionEl = this.$('versionDisplay');
      const headerVersionEl = this.$('headerVersion');
      if (versionEl) {
        versionEl.textContent = `v${data.version}`;
        versionEl.title = `Codeman v${data.version}`;
      }
      if (headerVersionEl) {
        headerVersionEl.textContent = `v${data.version}`;
        headerVersionEl.title = `Codeman v${data.version}`;
      }
    }

    // Stop any active voice recording on reconnect
    VoiceInput.cleanup();

    this._resetAllAppState();

    data.sessions.forEach(s => {
      this.sessions.set(s.id, s);
      // Load ralph state from session data (only if not explicitly closed by user)
      if ((s.ralphLoop || s.ralphTodos) && !this.ralphClosedSessions.has(s.id)) {
        this.ralphStates.set(s.id, {
          loop: s.ralphLoop || null,
          todos: s.ralphTodos || []
        });
      }
    });

    // Server is source of truth for open sessions — don't resurrect stale tabs
    // from localStorage (would show phantom "ended" tabs when a session was closed
    // on another device).
    try { localStorage.removeItem('codeman-tab-meta'); } catch {}

    // COD-131: server is authoritative for global tab order. Seed localStorage
    // from the server snapshot (if present) so syncSessionOrder() reconciles
    // against the cross-device order rather than this device's stale local copy.
    if (Array.isArray(data.sessionOrder) && data.sessionOrder.length) {
      try { localStorage.setItem('codeman-session-order', JSON.stringify(data.sessionOrder)); } catch {}
    }

    // Sync sessionOrder with current sessions (preserve order, add new, remove stale)
    this.syncSessionOrder();

    if (data.respawnStatus) {
      this.respawnStatus = data.respawnStatus;
    } else {
      // Clear respawn status on init if not provided (prevents stale data)
      this.respawnStatus = {};
    }
    // Clean up respawn state for sessions that no longer exist
    this.respawnTimers = {};
    this.respawnCountdownTimers = {};
    this.respawnActionLogs = {};

    // Store global stats for aggregate tracking
    if (data.globalStats) {
      this.globalStats = data.globalStats;
    }

    this.totalCost = data.sessions.reduce((sum, s) => sum + (s.totalCost || 0), 0);
    this.totalCost += data.scheduledRuns.reduce((sum, r) => sum + (r.totalCost || 0), 0);

    const activeRun = data.scheduledRuns.find(r => r.status === 'running');
    if (activeRun) {
      this.currentRun = activeRun;
      this.showTimer();
    }

    this.updateCost();
    this.renderSessionTabs();

    // Approvals Inbox: re-seed pending prompts from the server so alerts
    // survive reloads and SSE reconnects (methods in approvals-ui.js).
    this.seedApprovals?.();

    // Start/stop system stats polling based on session count
    if (this.sessions.size > 0) {
      this.startSystemStatsPolling();
    } else {
      this.stopSystemStatsPolling();
    }

    // CRITICAL: Clean up all floating windows before loading new subagents
    // This prevents memory leaks from ResizeObservers, EventSources, and DOM elements
    this.cleanupAllFloatingWindows();

    // Load subagents - clear all related maps to prevent memory leaks on reconnect
    if (data.subagents) {
      this.subagents.clear();
      this.subagentActivity.clear();
      this.subagentToolResults.clear();
      data.subagents.forEach(s => {
        this.subagents.set(s.agentId, s);
      });
      this.renderSubagentPanel();

      // Load PERSISTENT parent associations FIRST, before restoring windows
      // This ensures connection lines are drawn to the correct tabs
      // Clear the in-memory map first to ensure fresh state from storage
      this.subagentParentMap.clear();
      this.loadSubagentParentMap().then(() => {
        // Apply stored parent associations to agents
        for (const [agentId, sessionId] of this.subagentParentMap) {
          const agent = this.subagents.get(agentId);
          if (agent && this.sessions.has(sessionId)) {
            agent.parentSessionId = sessionId;
            const session = this.sessions.get(sessionId);
            if (session) {
              agent.parentSessionName = this.getSessionName(session);
            }
            this.subagents.set(agentId, agent);
          }
        }

        // Now try to find parents for any agents that don't have one yet
        for (const [agentId] of this.subagents) {
          if (!this.subagentParentMap.has(agentId)) {
            this.findParentSessionForSubagent(agentId);
          }
        }

        // Finally, restore window states (this opens windows with correct parent info)
        this.restoreSubagentWindowStates();
      });
    }

    // Seed ultracode workflow runs (LEFT-pane summaries) from the snapshot
    if (data.workflowRuns) {
      this.seedWorkflowRuns(data.workflowRuns);
    }

    // Restore previously active session (survives page reload + SSE reconnect)
    // Must always re-select because handleInit clears terminal state above.
    // Reset activeSessionId so selectSession doesn't early-return.
    // Guard: skip if a newer handleInit has already started (race between loadState + SSE init).
    if (gen !== this._initGeneration) return;

    // Solo (detached) window: always show exactly the target session, ignoring
    // the dashboard's "restore last active" logic.
    if (this.isSoloWindow) {
      this._applySoloMode();
      return;
    }

    const previousActiveId = this.activeSessionId;
    this.activeSessionId = null;
    if (this.sessionOrder.length > 0) {
      // Priority: current active > localStorage > first session
      let restoreId = previousActiveId;
      if (!restoreId || !this.sessions.has(restoreId)) {
        try { restoreId = localStorage.getItem('codeman-active-session'); } catch {}
      }
      // `auto`: the app is restoring a session on load, not a human opening
      // one, so a pending idle alert on that tab stays armed until it is
      // actually tapped (see the userInitiated note in selectSession).
      if (restoreId && this.sessions.has(restoreId)) {
        this.selectSession(restoreId, { auto: true });
      } else {
        this.selectSession(this.sessionOrder[0], { auto: true });
      }
    }
  }

  async loadState() {
    try {
      const res = await fetch('/api/status');
      const data = await res.json();
      this.handleInit(data?.data ?? {});
    } catch (err) {
      console.error('Failed to load state:', err);
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // Debounce Utility
  // ═══════════════════════════════════════════════════════════════

  /** Debounce a method call using a named timer key. */
  _debouncedCall(timerKey, fn, delayMs = 100) {
    if (this._debounceTimers[timerKey]) {
      clearTimeout(this._debounceTimers[timerKey]);
    }
    this._debounceTimers[timerKey] = setTimeout(() => {
      this._debounceTimers[timerKey] = null;
      fn.call(this);
    }, delayMs);
  }

  // ═══════════════════════════════════════════════════════════════
  // Session List Layout (header strip ⟷ collapsible left sidebar)
  // ═══════════════════════════════════════════════════════════════

  /**
   * 'header' | 'sidebar' | 'sidebar-rich'. Solo (detached single-session) windows
   * are ALWAYS 'header': they show exactly one session, so a session list is
   * noise — and #sessionTabs must never be parked inside the display:none
   * <aside>, where updateTabOverflowMode() would measure 0/0 and the inline
   * rename input would get zero geometry.
   *
   * The two sidebar values are the SAME layout — same docked column, same
   * re-parented #sessionTabs, same filter box, same Alt+B toggle. They differ
   * only in how much each row says, which is why the split rides on a separate
   * attribute (see applySessionListLayout) instead of a third data-session-list
   * value: every one of the ~25 isSessionSidebarActive() call sites, and every
   * html[data-session-list="sidebar"] rule in styles.css and mobile.css, must
   * keep matching both without being touched.
   */
  getSessionListLayout() {
    if (this.soloSessionId) return 'header';
    const settings = this.loadAppSettingsFromStorage();
    const defaults = this.getDefaultSettings();
    const layout = settings.sessionListLayout ?? defaults.sessionListLayout ?? 'header';
    return layout === 'sidebar' || layout === 'sidebar-rich' ? layout : 'header';
  }

  resolveSessionSidebarFontSize(value) {
    const size = Number(value);
    // Default 12, matching the sidebar's historical 0.75rem name size: a user
    // who never touches the slider must not get silently restyled (14 here
    // bumped every existing sidebar install on the rail feature's release).
    return Number.isInteger(size) && size >= 11 && size <= 18 ? size : 12;
  }

  applySessionSidebarFontSize(settings = null) {
    const resolvedSettings = settings ?? this.loadAppSettingsFromStorage();
    const size = this.resolveSessionSidebarFontSize(resolvedSettings?.sessionSidebarFontSize);
    document.documentElement.style.setProperty('--session-sidebar-name-font-size', `${size}px`);
    return size;
  }

  /**
   * Reads the APPLIED layout off <html>, not the settings blob: this is called
   * per dragover event and per tab in render loops, and getSessionListLayout()
   * re-parses localStorage on every call. The attribute is written by the
   * pre-paint script in index.html and thereafter only by applySessionListLayout(),
   * so it is authoritative from the very first frame.
   */
  isSessionSidebarActive() {
    return document.documentElement.dataset.sessionList === 'sidebar';
  }

  _tabOrientation() {
    return document.documentElement.getAttribute('data-tab-orientation') === 'vertical' ? 'vertical' : 'horizontal';
  }

  /**
   * True when the session list renders as a vertical column: the sidebar layout
   * OR the vertical tab rail. Axis decisions (drag insertion side, active-tab
   * scroll-into-view, floating-window anchors) must use THIS, not
   * isSessionSidebarActive() alone — the rail leaves data-session-list at
   * 'header', so the sidebar predicate reads a vertical rail as horizontal.
   */
  _isVerticalTabList() {
    return this.isSessionSidebarActive() || this._tabOrientation() === 'vertical';
  }

  shouldInlineSessionActions() {
    if (this.isSessionSidebarActive()) return !this.isSessionSidebarCollapsed();
    return this._tabOrientation() === 'vertical' && !document.documentElement.classList.contains('tab-rail-compact');
  }

  /**
   * True when the sidebar is showing the DETAILED rows: the home screen's
   * per-session line ("created 3d ago · working 12m") plus a status pill.
   *
   * Read off <html> for the same reason as isSessionSidebarActive() — it is
   * called once per tab in the render loop, and getSessionListLayout()
   * re-parses localStorage on every call. Implies isSessionSidebarActive():
   * data-sidebar-detail is only ever 'rich' while data-session-list is
   * 'sidebar', both in applySessionListLayout() and in the pre-paint script.
   */
  isSessionSidebarRich() {
    const root = document.documentElement;
    return root.dataset.sessionList === 'sidebar' && root.dataset.sidebarDetail === 'rich';
  }

  /**
   * True when the VERTICAL TAB RAIL (tabOrientation 'vertical') is showing the
   * detailed rows: the same "created 3d ago · working 12m" line and status pill
   * the rich sidebar and both home screens carry.
   *
   * A docked column is not a tab strip — that was the argument for the rich
   * sidebar, and the rail is a docked column too, so it defaults to rich and
   * `tabRailDetail: 'simple'` is the opt-out.
   *
   * The compact carve-out is not cosmetic: below 240px the rail already drops
   * the row actions to a hover affordance, and three lines of stamps in a
   * ~208px column ellipsize into noise. `_setTabRailWidth()` re-renders the
   * tabs whenever that class flips, so this gate is re-read at the right moment.
   */
  isTabRailRich() {
    const root = document.documentElement;
    return (
      root.getAttribute('data-tab-orientation') === 'vertical' &&
      root.dataset.tabRailDetail === 'rich' &&
      !root.classList.contains('tab-rail-compact')
    );
  }

  /**
   * The one gate the render paths ask: does THIS list draw detailed rows?
   * Either vertical surface can, and neither can be on at once (the sidebar
   * owns the tabs whenever it is active, which forces the rail off).
   */
  isRichTabRows() {
    return this.isSessionSidebarRich() || this.isTabRailRich();
  }

  /**
   * True where the sidebar is a MODAL off-canvas drawer over the terminal
   * instead of a docked column.
   *
   * That behaviour is defined purely in mobile.css, which index.html loads with
   * media="(max-width: 1023px)" — so this must test the SAME breakpoint.
   * MobileDetection.getDeviceType() is NOT usable here: it calls anything
   * >= 768px 'desktop', which would leave 768-1023px (iPad portrait, a narrowed
   * desktop window) with overlay CSS but docked-sidebar logic — drawer opens
   * itself on load, tapping a session doesn't dismiss it, Escape does nothing.
   * Mirrored in the pre-paint script in index.html.
   */
  _isSessionSidebarOverlay() {
    return window.innerWidth < 1024;
  }

  /**
   * Collapse state is per-device and lives in its OWN localStorage key, not in
   * the app-settings blob: saveAppSettings() rebuilds that blob from the DOM
   * controls, so any key without a control is silently wiped on every Save.
   * Precedent: codeman:skin, codeman-session-order, codeman-active-session.
   */
  isSessionSidebarCollapsed() {
    // In-memory intent wins over storage: where localStorage throws (Safari
    // private mode, disabled storage, quota) the write in toggleSessionSidebar()
    // is a no-op, and re-reading here would return the OLD value — the sidebar
    // would refuse to collapse at all. Persistence degrades, the control does not.
    if (this._sidebarCollapsedOverride !== undefined) return this._sidebarCollapsedOverride;
    let raw = null;
    try {
      raw = localStorage.getItem('codeman-sidebar-collapsed');
    } catch {}
    // Never chosen yet: the docked desktop sidebar starts open, the overlay
    // drawer starts CLOSED — "expanded" there would mean a drawer covering the
    // terminal on every cold load.
    if (raw === null) return this._isSessionSidebarOverlay();
    return raw === '1';
  }

  /**
   * True when this keydown is the sidebar-toggle chord AND toggling would
   * actually do something. Used by terminal-ui.js's custom key handler to keep
   * the chord out of the PTY: the document CAPTURE handler has already toggled
   * the sidebar by the time xterm sees the event, but its preventDefault() does
   * NOT stop xterm — without this gate Alt+B would ALSO write ESC b into the
   * live session, which readline/Ink read as backward-word and which walks the
   * cursor back through whatever the user was typing (same trap as COD-153).
   *
   * Deliberately registry-aware and gated on the sidebar being active, so a
   * rebound/disabled shortcut — and the default header layout, where the toggle
   * is a no-op — leave Meta-b reaching the terminal exactly as before.
   */
  shouldToggleSessionSidebarFromShortcut(e) {
    if (!e) return false;
    // Every dispatchable binding requires Ctrl/Cmd/Alt, so plain typing exits
    // before any registry work — this runs on the xterm keydown hot path.
    if (!e.ctrlKey && !e.metaKey && !e.altKey) return false;
    if (!this.isSessionSidebarActive()) return false;
    if (typeof this.getShortcutRegistry !== 'function' || typeof this.matchesShortcutEvent !== 'function') {
      return false;
    }
    const shortcut = this.getShortcutRegistry().find((s) => s.id === 'toggle-session-sidebar');
    if (!shortcut || shortcut.disabled) return false;
    return this.matchesShortcutEvent(e, shortcut);
  }

  /**
   * Move the ONE #sessionTabs element between its two hosts and set the layout
   * attributes that all the sidebar CSS keys off.
   *
   * Never clones or recreates the node: this.$('sessionTabs') caches elements by
   * id and never invalidates, and settings-ui.js / webview-tabs.js resolve the
   * same id independently. A rebuilt container would leave every consumer
   * writing into a detached orphan — silently, with no error.
   */
  applySessionListLayout() {
    const mode = this.getSessionListLayout();
    this.applySessionSidebarFontSize();
    // 'sidebar' and 'sidebar-rich' are the same column; only row detail differs.
    const sidebar = mode === 'sidebar' || mode === 'sidebar-rich';
    const collapsed = this.isSessionSidebarCollapsed();
    const prevMode = document.documentElement.dataset.sessionList;
    const prevDetail = document.documentElement.dataset.sidebarDetail;
    const prevCollapsed = document.documentElement.dataset.sidebar;
    const tabsEl = document.getElementById('sessionTabs');
    const headerHost = document.getElementById('sessionTabsHost');
    const sidebarList = document.getElementById('sessionSidebarList');
    if (!tabsEl || !headerHost || !sidebarList) return;

    const rail = document.getElementById('tabRail');
    const railOwnsTabs =
      !sidebar && document.documentElement.getAttribute('data-tab-orientation') === 'vertical';
    const host = sidebar ? sidebarList : railOwnsTabs && rail ? rail : headerHost;
    if (tabsEl.parentElement !== host) host.appendChild(tabsEl);

    document.documentElement.dataset.sessionList = sidebar ? 'sidebar' : 'header';
    // Detail is meaningless outside the sidebar, and must not linger as 'rich'
    // there: the rows carry no meta line in the header strip, and a stale 'rich'
    // would let the sidebar CSS style a strip that has nothing to style.
    document.documentElement.dataset.sidebarDetail = mode === 'sidebar-rich' ? 'rich' : 'simple';
    document.documentElement.dataset.sidebar = collapsed ? 'collapsed' : 'expanded';
    tabsEl.setAttribute('aria-orientation', host === headerHost ? 'horizontal' : 'vertical');

    const btn = document.getElementById('sidebarToggleBtn');
    if (btn) {
      btn.classList.toggle('btn-sidebar-toggle--hidden', !sidebar);
      const label = collapsed ? 'Expand session sidebar' : 'Collapse session sidebar';
      btn.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
      btn.setAttribute('aria-label', label);
      btn.setAttribute('title', label);
    }

    // Handheld (mobile.css): the sidebar is an off-canvas overlay, and
    // "collapsed" means the drawer is closed.
    const aside = document.getElementById('sessionSidebar');
    if (aside) {
      aside.classList.toggle('open', sidebar && !collapsed);
      // A closed overlay drawer is only moved off screen by translateX(-100%);
      // it keeps display:flex, so without this its filter box and ~4 tab stops
      // per session stay in the Tab order and in the accessibility tree.
      // NOT applied to the docked desktop rail — its rows are still clickable.
      const hiddenDrawer = sidebar && collapsed && this._isSessionSidebarOverlay();
      aside.toggleAttribute('inert', hiddenDrawer);
      if (hiddenDrawer) aside.setAttribute('aria-hidden', 'true');
      else aside.removeAttribute('aria-hidden');
    }

    // The filter box only exists inside the sidebar; leaving a stale filter
    // applied when the layout goes back to the header strip would hide sessions
    // from the tab bar with no reachable control to clear it.
    if (!sidebar) {
      this._sidebarFilter = '';
      const filterInput = document.getElementById('sessionSidebarFilter');
      if (filterInput) filterInput.value = '';
    }

    // applyTabWrapSettings() (settings-ui.js) is the ONE owner of
    // tabs-two-rows / tabs-show-folder / _tallTabsEnabled and is itself
    // sidebar-aware — it reads the data-session-list attribute set just above,
    // so it must run AFTER it. It re-renders by itself when the folder row
    // appears or disappears.
    const prevTall = this._tallTabsEnabled;
    this.applyTabWrapSettings();
    // A layout flip alone still needs one render: the rows are rebuilt into the
    // new host with the drag/keyboard handlers re-bound. Skipped when
    // applyTabWrapSettings() already rendered for the folder-row change.
    //
    // The detail half of the test is not redundant: simple ⟷ rich leaves
    // data-session-list on 'sidebar' both times, so comparing only that would
    // flip the setting and repaint nothing until the next SSE tick — and the
    // meta line is emitted by the row template, not toggled by CSS.
    const layoutChanged =
      prevMode !== document.documentElement.dataset.sessionList ||
      prevDetail !== document.documentElement.dataset.sidebarDetail;
    const collapseChanged = prevCollapsed !== document.documentElement.dataset.sidebar;
    if ((layoutChanged || collapseChanged) && prevTall === this._tallTabsEnabled) {
      this._fullRenderSessionTabs();
    }
    // tabs-auto-wrap is measured, not derived from settings — updateTabOverflowMode()
    // drops it in sidebar mode, but drop it here too so nothing paints wrapped
    // for a frame before the next measure.
    if (sidebar) tabsEl.classList.remove('tabs-auto-wrap');
    // Collapse/expand changes whether the filter is reachable, so re-evaluate it
    // here too — not only at the render tails.
    this.applySidebarFilter(this._sidebarFilter);
    this.updateConnectionLines();
    // The desktop home rail defers to the sidebar (both dock the session list
    // flush left), so a layout flip while the welcome screen is up has to
    // re-evaluate it — showHomeSessions() self-gates on shouldShowHomeSessions().
    if (document.getElementById('welcomeOverlay')?.classList.contains('visible')) {
      this.showHomeSessions?.();
    }
    // Only the rich rows carry stamps that go stale with no event behind them.
    if (this.isRichTabRows()) this._startSidebarRichClock();
    else this._stopSidebarRichClock();
  }

  toggleSessionSidebar() {
    if (!this.isSessionSidebarActive()) return;
    const collapsed = !this.isSessionSidebarCollapsed();
    this._sidebarCollapsedOverride = collapsed;
    try {
      localStorage.setItem('codeman-sidebar-collapsed', collapsed ? '1' : '0');
    } catch {}
    // Collapsing hides the filter row. If focus is sitting in there it would be
    // reset to <body>, dropping the user back to the top of the tab order — so
    // hand it to the toggle, which is the control they just used.
    if (collapsed && this.$('sessionSidebar')?.contains(document.activeElement)) {
      document.getElementById('sidebarToggleBtn')?.focus();
    }
    this.applySessionListLayout();
    // Opening the MODAL drawer moves focus into it, as a dialog should. The
    // docked desktop sidebar is not modal: stealing focus there would pull the
    // caret out of the terminal mid-prompt, and .session-tab handles only
    // arrows/Home/End/Enter/Space, so everything typed after would be swallowed.
    if (!collapsed && this._isSessionSidebarOverlay()) {
      this.$('sessionTabs')?.querySelector('.session-tab.active')?.focus();
    }
  }

  /**
   * Overlay layouts only: below 1024px the sidebar is a modal drawer on top of
   * the terminal (mobile.css), so picking a session from it must get it out of
   * the way again. The docked desktop sidebar stays exactly where the user put
   * it. No-op unless the drawer is actually open.
   */
  closeSessionSidebarOnHandheld() {
    if (!this._isSessionSidebarOverlay()) return;
    if (!this.isSessionSidebarActive() || this.isSessionSidebarCollapsed()) return;
    this.toggleSessionSidebar();
  }

  /**
   * The count is what is actually ON the list: session rows plus web-tab rows,
   * minus whatever the sidebar filter is hiding. `this.sessions.size` was the
   * original source and disagreed with the screen twice over — web tabs render
   * in the same list but are not sessions (3 sessions + 2 dashboards read "3"
   * above 5 rows), and a filter hides rows without touching the map. Counting
   * the rendered rows keeps one source of truth: the list itself.
   */
  updateSidebarCount() {
    const el = document.getElementById('sessionSidebarCount');
    if (!el) return;
    const container = this.$('sessionTabs');
    const count = container
      ? container.querySelectorAll('.session-tab:not(.tab-filtered-out)').length
      : (this.sessions?.size ?? 0);
    el.textContent = String(count);
  }

  /**
   * Sidebar filter box. Pure DOM class toggling — no re-render, no state on the
   * sessions themselves. Matches the rendered aria-label (session name) and the
   * title (working directory).
   *
   * Re-applied at the tail of both render paths: _fullRenderSessionTabs() rebuilds
   * innerHTML wholesale, so without that the filtered-out rows flicker back in on
   * every SSE tick.
   *
   * The filter only takes effect while the box that produced it is on screen —
   * i.e. the expanded sidebar. In the header strip, the collapsed rail or a
   * closed drawer the classes come off, otherwise sessions would stay hidden
   * with no visible cause and no reachable control to clear them. The remembered
   * needle is restored when the box comes back.
   */
  applySidebarFilter(query) {
    this._sidebarFilter = (query ?? '').trim().toLowerCase();
    const container = this.$('sessionTabs');
    if (!container) return;
    const reachable =
      this.isSessionSidebarActive() && document.documentElement.dataset.sidebar !== 'collapsed';
    const needle = reachable ? this._sidebarFilter : '';
    for (const tab of container.querySelectorAll('.session-tab')) {
      if (!needle) {
        tab.classList.remove('tab-filtered-out');
        continue;
      }
      const haystack = `${tab.getAttribute('aria-label') || ''} ${tab.getAttribute('title') || ''}`.toLowerCase();
      tab.classList.toggle('tab-filtered-out', !haystack.includes(needle));
    }
    // The count shows visible rows, so it moves with every filter change —
    // including keystrokes in the filter box, which call this directly.
    this.updateSidebarCount();
  }

  // ═══════════════════════════════════════════════════════════════
  // Rich sidebar rows (sessionListLayout === 'sidebar-rich')
  // ═══════════════════════════════════════════════════════════════

  /**
   * Pill copy per state, matching the desktop home rail and the phone overview
   * word for word. Duplicated rather than imported for the same reason those two
   * duplicate it from each other: it is six words, and constants.js is served
   * from cache independently of app.js — a shared map there could arrive stale
   * or missing while this file is new. What is NOT duplicated is the part that
   * can actually disagree: which state a session is IN, and which stamp measures
   * it, both of which come from mobile-overview.js below.
   */
  _sidebarRichPillLabel(state) {
    return {
      needs: 'needs you',
      error: 'error',
      waiting: 'waiting',
      working: 'working',
      idle: 'idle',
      done: 'done',
    }[state] || state;
  }

  /**
   * The per-row model for a rich row (detailed sidebar or vertical tab rail):
   * which state the session is in, when it was first created, and how long it
   * has been in that state.
   *
   * Classification is `_mobileOverviewState()` and the state duration is
   * `_mobileOverviewSince()` (both mobile-overview.js), NOT re-derived here —
   * the sidebar, the rail, the desktop home rail and the phone overview must
   * never disagree about what "working" means or about which stamp measures it.
   *
   * Guarded like every other cross-file consumer in this app: a stale cached
   * mobile-overview.js must degrade to a row with no meta line, not throw and
   * take the whole tab strip down with it.
   */
  _sidebarRichRow(id, session) {
    if (typeof this._mobileOverviewState !== 'function') return null;
    const state = this._mobileOverviewState(session, this.pendingHooks?.get(id));
    return {
      state,
      pill: this._sidebarRichPillLabel(state),
      createdAt: Number(session.createdAt) || 0,
      since: this._mobileOverviewSince ? this._mobileOverviewSince(state, session) : null,
    };
  }

  /**
   * The "created 3d ago · working 12m" line plus the status pill, as the third
   * child of `.tab-info` (already a flex column, so no row-level wrapping is
   * needed — unlike the home rail, whose pill rides a wrapped full-width line).
   *
   * Both stamps keep their raw epoch-ms in `data-tab-ts` so
   * `_tickSidebarRichTimes()` can rewrite the text without rebuilding the row:
   * a rebuild would restart the load spinner and every alert animation in the
   * list, twice a minute, for nothing.
   *
   * Returns '' when there is no model, which is what keeps the header strip and
   * the simple sidebar byte-identical to before.
   */
  _sidebarRichMetaHTML(row) {
    if (!row) return '';
    const stamp = (key, ts, fmt, cls) => {
      const text = this._sidebarRichStampText(ts, fmt);
      const title = ts
        ? ` title="${escapeHtml(`${key === 'created' ? 'First created' : key}: ${new Date(ts).toLocaleString()}`)}"`
        : '';
      return `<span class="tab-meta-item ${cls}"${title}><span class="tab-meta-key">${escapeHtml(key)}</span><span data-tab-ts="${ts || 0}" data-tab-fmt="${fmt}">${escapeHtml(text)}</span></span>`;
    };
    // data-i18n-skip: relative times are generated text, and "created"/"idle"
    // are the same generic words that mean something else on other surfaces.
    const parts = [stamp('created', row.createdAt, 'ago', 'tab-meta-created')];
    if (row.since) {
      parts.push('<span class="tab-meta-sep" aria-hidden="true">\u00B7</span>');
      parts.push(stamp(row.since.key, row.since.at, 'for', 'tab-meta-since'));
    }
    parts.push(`<span class="tab-pill tab-pill--${escapeHtml(row.state)}">${escapeHtml(row.pill)}</span>`);
    // Both absolute stamps ALSO on the line itself, not only on the two items.
    // Below 288px the rail hides `.tab-meta-created` (the `tab-rail-tight`
    // rule), and a tooltip on a `display: none` element has no hover target —
    // so without this the created stamp is not merely shrunk, it is gone with
    // no way to ask for it. The pill and the gaps around the stamps are the
    // hover targets that remain; an item's own title still wins over this one
    // where the item is visible.
    const lineTitle = [
      row.createdAt ? `First created: ${new Date(row.createdAt).toLocaleString()}` : '',
      row.since && row.since.at ? `${row.since.key}: ${new Date(row.since.at).toLocaleString()}` : '',
    ]
      .filter(Boolean)
      .join('  \u00B7  ');
    const lineTitleAttr = lineTitle ? ` title="${escapeHtml(lineTitle)}"` : '';
    return `<span class="tab-meta"${lineTitleAttr} data-i18n-skip>${parts.join('')}</span>`;
  }

  /** Same formatter as both home screens, so a duration is written the same way everywhere. */
  _sidebarRichStampText(timestamp, format) {
    return this._mobileOverviewStampText ? this._mobileOverviewStampText(timestamp, format) : '\u2014';
  }

  /**
   * Incremental-render counterpart of `_sidebarRichMetaHTML()`. The stamps move
   * on the clock, but the STATE can change between renders (a session starts
   * working, a permission prompt lands), and that flips the pill, the accent
   * class and which stamp the second slot is even showing.
   *
   * Rebuilds the meta line only when something it displays actually changed,
   * because this runs for every session on every SSE tick.
   */
  _updateSidebarRichRow(tab, id, session) {
    const row = this._sidebarRichRow(id, session);
    if (!row) return;
    const prev = tab.dataset.tabState;
    // The since ANCHOR moves without the state changing (each new turn re-stamps
    // lastSubmitAt), so key the compare on both.
    const sig = `${row.state}:${row.since ? row.since.at : 0}:${row.createdAt}`;
    if (tab.dataset.tabMetaSig === sig) return;
    tab.dataset.tabMetaSig = sig;
    tab.dataset.tabState = row.state;
    if (prev) tab.classList.remove(`tab-state-${prev}`);
    tab.classList.add(`tab-state-${row.state}`);
    const info = tab.querySelector('.tab-info');
    if (!info) return;
    const html = this._sidebarRichMetaHTML(row);
    const existing = info.querySelector('.tab-meta');
    if (existing) existing.outerHTML = html;
    else info.insertAdjacentHTML('beforeend', html);
  }

  /**
   * Rewrites the relative stamps in place. A session that is just sitting there
   * emits no event at all, so without this its "idle 2m" would still read 2m an
   * hour later — the one number in the list that has to move on its own.
   */
  _startSidebarRichClock() {
    if (this._sidebarRichClock) return;
    this._sidebarRichClock = setInterval(() => {
      if (!this.isRichTabRows()) {
        this._stopSidebarRichClock();
        return;
      }
      this._tickSidebarRichTimes();
    }, SIDEBAR_RICH_CLOCK_MS);
  }

  _stopSidebarRichClock() {
    if (!this._sidebarRichClock) return;
    clearInterval(this._sidebarRichClock);
    this._sidebarRichClock = null;
  }

  _tickSidebarRichTimes() {
    const container = this.$('sessionTabs');
    if (!container) return;
    for (const node of container.querySelectorAll('[data-tab-ts]')) {
      const text = this._sidebarRichStampText(Number(node.dataset.tabTs) || 0, node.dataset.tabFmt);
      if (node.textContent !== text) node.textContent = text;
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // Session Tabs
  // ═══════════════════════════════════════════════════════════════

  renderSessionTabs() {
    // Don't re-render while user is typing in the inline rename input
    if (this._inlineRenameActive) return;
    this._debouncedCall('sessionTabs', this._renderSessionTabsImmediate);
  }

  /** Toggle .active class on tabs immediately (no debounce). Used by selectSession(). */
  _updateActiveTabImmediate(sessionId) {
    const container = this.$('sessionTabs');
    if (!container) return;
    const tabs = container.querySelectorAll('.session-tab[data-id]');
    for (const tab of tabs) {
      if (tab.dataset.id === sessionId) {
        tab.classList.add('active');
      } else {
        tab.classList.remove('active');
      }
    }
    // #257: selection used to stop at the class toggle. On phones/tablets the
    // strip scrolls horizontally, so a tab selected from the palette, a swipe,
    // Alt+N or a push notification could stay parked off-screen.
    this._scrollActiveTabIntoView(sessionId);
  }

  /**
   * Scroll the tab strip so the given (default: active) tab is visible.
   *
   * Only phones/tablets scroll the strip (desktop wraps to a second row), and
   * the pure policy no-ops whenever there is nothing to scroll, so this is a
   * cheap call on every device.
   *
   * Deliberately NOT scrollIntoView(): that also scrolls every scrollable
   * ANCESTOR, which on a phone is the document itself. With the header fixed
   * and the keyboard possibly open, a vertical nudge there shifts the whole
   * app. Rect math + scrollLeft touches exactly one scroller.
   */
  _scrollActiveTabIntoView(sessionId, behavior = 'smooth') {
    const container = this.$('sessionTabs');
    if (!container) return;
    const tab =
      (sessionId && container.querySelector(`.session-tab[data-id="${sessionId}"]`)) ||
      container.querySelector('.session-tab.active');
    if (!tab) return;

    // Sidebar layout AND the vertical rail: the list scrolls VERTICALLY in its
    // own scroller, so the horizontal computeTabScrollLeft math below would
    // always no-op (scrollLeft pinned at 0). With 25+ sessions the active row
    // is routinely below the fold; 'nearest' never scrolls when it is already
    // visible, and only the list's own scroller moves — drawer/rail and
    // document stay put.
    if (this._isVerticalTabList()) {
      tab.scrollIntoView({ block: 'nearest' });
      return;
    }

    const policy = window.CodemanTabOverflow?.computeTabScrollLeft;
    if (!policy) return;
    const containerRect = container.getBoundingClientRect();
    const tabRect = tab.getBoundingClientRect();
    const target = policy({
      scrollLeft: container.scrollLeft,
      clientWidth: container.clientWidth,
      scrollWidth: container.scrollWidth,
      // Offsets are relative to the SCROLL CONTENT, not the offsetParent: the
      // tabs' offsetParent is the positioned header, so offsetLeft would carry
      // the brand column's width into the math.
      tabLeft: tabRect.left - containerRect.left + container.scrollLeft,
      tabWidth: tabRect.width,
    });
    if (Math.abs(target - container.scrollLeft) < 1) return;

    const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
    if (typeof container.scrollTo === 'function') {
      container.scrollTo({ left: target, behavior: reduceMotion ? 'auto' : behavior });
    } else {
      container.scrollLeft = target;
    }
  }

  /**
   * Where a floating window (subagent / ultracode) attaches to its parent tab.
   * Header strip: below the tab, connector runs vertically. Sidebar AND the
   * vertical rail: to the RIGHT of the tab, connector runs horizontally —
   * otherwise the window spawns on top of the list and its bezier loops
   * backwards underneath it.
   */
  _tabAnchor(rect) {
    if (this._isVerticalTabList()) {
      return {
        x: rect.right,
        y: rect.top + rect.height / 2,
        spawnLeft: rect.right + 14,
        spawnTop: rect.top,
        vertical: false,
      };
    }
    return {
      x: rect.left + rect.width / 2,
      y: rect.bottom,
      spawnLeft: rect.left,
      spawnTop: rect.bottom,
      vertical: true,
    };
  }

  /** Bezier from a _tabAnchor() to a window rect, curving along the right axis. */
  _tabConnectorPath(anchor, winRect) {
    if (anchor.vertical) {
      const x2 = winRect.left + winRect.width / 2;
      const y2 = winRect.top;
      const midY = (anchor.y + y2) / 2;
      return `M ${anchor.x} ${anchor.y} C ${anchor.x} ${midY}, ${x2} ${midY}, ${x2} ${y2}`;
    }
    const x2 = winRect.left;
    const y2 = winRect.top + winRect.height / 2;
    const midX = (anchor.x + x2) / 2;
    return `M ${anchor.x} ${anchor.y} C ${midX} ${anchor.y}, ${midX} ${y2}, ${x2} ${y2}`;
  }

  _setTerminalLoadState(sessionId, selectGen, phase) {
    this.terminalLoadStates.set(sessionId, { generation: selectGen, phase });
    this._updateTerminalLoadTab(sessionId);
  }

  _clearTerminalLoadState(sessionId, selectGen) {
    const state = this.terminalLoadStates.get(sessionId);
    if (state && state.generation !== selectGen) return;
    this.terminalLoadStates.delete(sessionId);
    this._updateTerminalLoadTab(sessionId);
  }

  _updateTerminalLoadTab(sessionId) {
    const tab = this.$('sessionTabs')?.querySelector(`.session-tab[data-id="${sessionId}"]`);
    if (!tab) return;

    const loadState = this.terminalLoadStates.get(sessionId);
    tab.classList.toggle('tab-loading', !!loadState);
    if (loadState) {
      tab.setAttribute('aria-busy', 'true');
      tab.dataset.loadPhase = loadState.phase;
      if (!tab.querySelector('.tab-load-spinner')) {
        const spinner = document.createElement('span');
        spinner.className = 'tab-load-spinner';
        spinner.setAttribute('aria-hidden', 'true');
        const numberEl = tab.querySelector('.tab-number');
        if (numberEl) {
          numberEl.insertAdjacentElement('afterend', spinner);
        } else {
          tab.insertBefore(spinner, tab.firstChild);
        }
      }
    } else {
      tab.setAttribute('aria-busy', 'false');
      delete tab.dataset.loadPhase;
      tab.querySelector('.tab-load-spinner')?.remove();
    }
  }

  _renderSessionTabsImmediate() {
    // Same guard as renderSessionTabs()/_fullRenderSessionTabs(): the incremental
    // branch below rewrites .tab-name's innerHTML, which destroys the inline rename
    // <input> mid-keystroke. Guarding only the scheduler is not enough: a render
    // debounced just BEFORE the rename opened still fires ~100ms later and lands
    // here directly. finishRename() re-renders on both commit and cancel, so a
    // render dropped here is picked back up when the rename settles.
    if (this._inlineRenameActive) return;
    const container = this.$('sessionTabs');
    const existingTabs = container.querySelectorAll('.session-tab[data-id]');
    const existingIds = new Set([...existingTabs].map(t => t.dataset.id));
    const currentIds = new Set(this.sessions.keys());

    // Web tabs live in the same strip but are not in this.sessions, so they need
    // their own change check. Without it, the session-only comparison below is
    // vacuously "unchanged" whenever session count is stable — most visibly with
    // ZERO sessions (0 === 0), where opening a dashboard would never draw its tab.
    const existingWebIds = [...container.querySelectorAll('.session-tab[data-webview-id]')].map(
      t => t.dataset.webviewId
    );
    const wantedWebIds = (this.webviewOrder || []).filter(id => this.webviews?.has(id));
    const webTabsUnchanged =
      existingWebIds.length === wantedWebIds.length && existingWebIds.every((id, i) => id === wantedWebIds[i]);

    // Check if we can do incremental update (same session IDs and same web tabs)
    const canIncremental = existingIds.size === currentIds.size &&
      [...existingIds].every(id => currentIds.has(id)) &&
      webTabsUnchanged;

    if (canIncremental) {
      // Read once for the whole pass, like the full-rebuild path: this touches
      // the DOM and the loop below runs for every session on every SSE tick.
      const richRows = this.isRichTabRows();
      // Incremental update - only modify changed properties
      for (const [id, session] of this.sessions) {
        const tab = container.querySelector(`.session-tab[data-id="${id}"]`);
        if (!tab) continue;

        // A web tab owns the active state while one is open. activeSessionId stays
        // set (the terminal keeps streaming underneath, and switching back is
        // instant): only the highlight moves. Without this the debounced render
        // re-marks the session tab active moments after a web tab was selected,
        // leaving two tabs lit at once.
        const isActive = id === this.activeSessionId && !this.activeWebviewId;
        const status = session.status || 'idle';
        const name = this.getSessionName(session);
        const taskStats = session.taskStats || { running: 0, total: 0 };
        const hasRunningTasks = taskStats.running > 0;
        const loadState = this.terminalLoadStates.get(id);

        // Update active class
        if (isActive && !tab.classList.contains('active')) {
          tab.classList.add('active');
        } else if (!isActive && tab.classList.contains('active')) {
          tab.classList.remove('active');
        }

        tab.classList.toggle('tab-loading', !!loadState);
        if (loadState) {
          tab.setAttribute('aria-busy', 'true');
          tab.dataset.loadPhase = loadState.phase;
          if (!tab.querySelector('.tab-load-spinner')) {
            const spinner = document.createElement('span');
            spinner.className = 'tab-load-spinner';
            spinner.setAttribute('aria-hidden', 'true');
            const numberEl = tab.querySelector('.tab-number');
            if (numberEl) {
              numberEl.insertAdjacentElement('afterend', spinner);
            } else {
              tab.insertBefore(spinner, tab.firstChild);
            }
          }
        } else {
          tab.setAttribute('aria-busy', 'false');
          delete tab.dataset.loadPhase;
          tab.querySelector('.tab-load-spinner')?.remove();
        }

        // Update alert class
        const alertType = this.tabAlerts.get(id);
        const wantAction = alertType === 'action';
        const wantIdle = alertType === 'idle';
        const hasAction = tab.classList.contains('tab-alert-action');
        const hasIdle = tab.classList.contains('tab-alert-idle');
        if (wantAction && !hasAction) { tab.classList.add('tab-alert-action'); tab.classList.remove('tab-alert-idle'); }
        else if (wantIdle && !hasIdle) { tab.classList.add('tab-alert-idle'); tab.classList.remove('tab-alert-action'); }
        else if (!alertType && (hasAction || hasIdle)) { tab.classList.remove('tab-alert-action', 'tab-alert-idle'); }

        // Inject tab-number badge if missing (added after initial render)
        if (!tab.querySelector('.tab-number')) {
          const idx = this.sessionOrder.indexOf(id);
          if (idx >= 0 && idx < 9) {
            const numSpan = document.createElement('span');
            numSpan.className = 'tab-number';
            numSpan.textContent = String(idx + 1);
            tab.insertBefore(numSpan, tab.firstChild);
          }
        }

        // Update status indicator
        const statusEl = tab.querySelector('.tab-status');
        if (statusEl && !statusEl.classList.contains(status)) {
          statusEl.className = `tab-status ${status}`;
        }

        // Rich sidebar meta ("created 3d ago · working 12m" + pill). The stamps
        // themselves move on _tickSidebarRichTimes(); this is here for the parts
        // a tick cannot see — the state flipping, and with it the pill, the row
        // accent and which stamp the second slot is measuring at all.
        if (richRows) {
          this._updateSidebarRichRow(tab, id, session);
        } else if (tab.dataset.tabState) {
          // Layout flipped away from rich without a full rebuild reaching this
          // row yet: strip the line rather than leave a frozen stamp behind.
          tab.querySelector('.tab-meta')?.remove();
          tab.classList.remove(`tab-state-${tab.dataset.tabState}`);
          delete tab.dataset.tabState;
          delete tab.dataset.tabMetaSig;
        }

        // Update name if changed. #232: a description (the `: suffix` part of the
        // name) is the whole tab label; the generated id lives in the tooltip. The
        // compare targets the DISPLAY text, or a described tab would re-render on
        // every pass (textContent never equals the full name there).
        const nameEl = tab.querySelector('.tab-name');
        if (nameEl) {
          const _p = parseSessionPrefix(name);
          if (nameEl.dataset.fullName !== name) {
            nameEl.replaceChildren();
            if (_p && _p.suffix) {
              const prefix = document.createElement('span');
              prefix.className = 'tab-name-prefix';
              prefix.textContent = `${_p.prefix}: `;
              nameEl.append(prefix, document.createTextNode(_p.suffix));
            } else {
              nameEl.textContent = name;
            }
            nameEl.dataset.fullName = name;
            tab.title = _p && _p.suffix
              ? (session.workingDir ? `${_p.prefix} (${session.workingDir})` : _p.prefix)
              : (session.workingDir || '');
          }
        }

        // Update task badge
        const badgeEl = tab.querySelector('.tab-badge');
        if (hasRunningTasks) {
          if (badgeEl) {
            if (badgeEl.textContent !== String(taskStats.running)) {
              badgeEl.textContent = taskStats.running;
            }
          } else {
            // Need to add badge - do full rebuild
            this._fullRenderSessionTabs();
            return;
          }
        } else if (badgeEl) {
          // Need to remove badge - do full rebuild
          this._fullRenderSessionTabs();
          return;
        }

        // Update subagent badge - targeted update without full rebuild
        const subagentBadgeEl = tab.querySelector('.tab-subagent-badge');
        const minimizedAgents = this.minimizedSubagents.get(id);
        const minimizedCount = minimizedAgents?.size || 0;
        if (minimizedCount > 0 && subagentBadgeEl) {
          // Badge exists and still has agents - update label and dropdown in-place
          const labelEl = subagentBadgeEl.querySelector('.subagent-label');
          const newLabel = minimizedCount === 1 ? 'AGENT' : `AGENTS (${minimizedCount})`;
          if (labelEl && labelEl.textContent !== newLabel) {
            labelEl.textContent = newLabel;
          }
          // Rebuild dropdown items (agent list may have changed)
          const dropdownEl = subagentBadgeEl.querySelector('.subagent-dropdown');
          if (dropdownEl) {
            const newBadgeHtml = this.renderSubagentTabBadge(id, minimizedAgents);
            const temp = document.createElement('div');
            temp.innerHTML = newBadgeHtml;
            const newDropdown = temp.querySelector('.subagent-dropdown');
            if (newDropdown) {
              dropdownEl.innerHTML = newDropdown.innerHTML;
            }
          }
        } else if (minimizedCount > 0 && !subagentBadgeEl) {
          // Need to add badge - insert before the action-icon overlay so the
          // badge stays a direct child of the tab (outside .tab-actions)
          const badgeHtml = this.renderSubagentTabBadge(id, minimizedAgents);
          const actionsEl = tab.querySelector(':scope > .tab-actions');
          if (actionsEl) {
            actionsEl.insertAdjacentHTML('beforebegin', badgeHtml);
          } else {
            tab.insertAdjacentHTML('beforeend', badgeHtml);
          }
        } else if (minimizedCount === 0 && subagentBadgeEl) {
          // Count went to 0 - remove badge
          subagentBadgeEl.remove();
        }
      }
    } else {
      // Full rebuild needed (sessions added/removed)
      this._fullRenderSessionTabs();
    }

    // Keep the reveal-on-change bookkeeping honest when only the incremental
    // branch ran: _updateActiveTabImmediate has already scrolled the new active
    // tab into view, so the next full rebuild must not treat it as a change.
    this._lastRenderedActiveTabId = this.activeSessionId;

    this.updateTabOverflowMode();
    // After the wrap measurement: the `unroll` style starts tabs at max-width 0,
    // so measuring mid-animation would decide the wrap on collapsed widths.
    this._applyTabEntrances?.();
    // Phone overview rides on this one call: every state change it cares about
    // (create, delete, idle, working, exit, hook alerts via updateTabAlertFromHooks)
    // already funnels through here. No-ops unless that surface is showing.
    this._refreshMobileOverviewIfVisible?.();
    // Same deal for the desktop home screen's tab column.
    this._refreshHomeSessionsIfVisible?.();
    // The full-render path already redraws the connection SVG; this incremental
    // one does not, and a badge appearing widens a tab and shifts every tab after
    // it, sliding the lineage arcs off their anchors. Only pay for it when there
    // is something anchored to tab rects: lineage arcs, or — in a VERTICAL list
    // (sidebar, where lineage is skipped and the edge count stays 0, or the
    // rail, which can show connectors with zero lineage edges too) — the
    // subagent/ultracode connectors, whose rows a badge changes the HEIGHT of.
    // Same widening as the strip-scroll listener in session-lineage.js.
    if (this._lineageEdgeCount > 0 || this._isVerticalTabList()) this.updateConnectionLines();

    this.applySidebarFilter(this._sidebarFilter);
  }

  // Auto-wrap desktop session tabs to a second row when they overflow one row,
  // unless the user has pinned the manual two-row layout (tabTwoRows). Mobile/
  // tablet keep horizontal scroll. Policy lives in constants.js for unit testing.
  updateTabOverflowMode() {
    const container = this.$('sessionTabs');
    if (!container) return;

    // The sidebar list is a single vertical column with its own scroller —
    // there is no row to overflow, and measuring it would fight the CSS.
    if (this.isSessionSidebarActive()) {
      container.classList.remove('tabs-auto-wrap');
      return;
    }

    const deviceType = MobileDetection.getDeviceType();
    const settings = this.loadAppSettingsFromStorage();
    const defaults = this.getDefaultSettings();
    const manualTwoRows = deviceType === 'desktop' ? (settings.tabTwoRows ?? defaults.tabTwoRows ?? false) : false;

    const orientation = window.CodemanTabOverflow?.resolveTabOrientation
      ? window.CodemanTabOverflow.resolveTabOrientation({
          deviceType,
          setting: settings.tabOrientation ?? defaults.tabOrientation ?? 'horizontal',
        })
      : 'horizontal';
    if (orientation === 'vertical') {
      container.classList.remove('tabs-auto-wrap');
      return;
    }

    if (manualTwoRows || deviceType !== 'desktop') {
      container.classList.remove('tabs-auto-wrap');
      return;
    }

    // Measure the natural one-row overflow, then enable wrapping only if needed.
    container.classList.remove('tabs-auto-wrap');
    const shouldWrap = window.CodemanTabOverflow?.shouldAutoWrapTabs
      ? window.CodemanTabOverflow.shouldAutoWrapTabs({
          deviceType,
          manualTwoRows,
          tabCount: this.sessions.size,
          scrollWidth: container.scrollWidth,
          clientWidth: container.clientWidth,
        })
      : container.scrollWidth > container.clientWidth + 1;

    container.classList.toggle('tabs-auto-wrap', shouldWrap);
  }

  // Middle-click closes a tab, mirroring browser tab strips. Session tabs go
  // through requestCloseSession (the same confirm modal as the x button), web
  // tabs through closeWebviewTab (same as theirs). Delegated on the container:
  // tabs are re-rendered wholesale, the container is stable.
  _setupTabMiddleClickClose() {
    const container = this.$('sessionTabs');
    if (!container || this._tabAuxClickBound) return;
    this._tabAuxClickBound = true;
    container.addEventListener('auxclick', (e) => {
      if (e.button !== 1) return;
      const tab = e.target.closest?.('.session-tab');
      if (!tab) return;
      e.preventDefault();
      e.stopPropagation();
      if (tab.dataset.id) this.requestCloseSession(tab.dataset.id);
      else if (tab.dataset.webviewId) this.closeWebviewTab?.(tab.dataset.webviewId);
    });
  }

  _fullRenderSessionTabs() {
    this.closeTabRailActionMenu?.();
    if (this._inlineRenameActive) return;
    const container = this.$('sessionTabs');

    // Sidebar rows are always tall (name + folder) and never wrap. Re-assert it
    // here so a render triggered straight from applyTabWrapSettings() — which
    // only knows the header strip — cannot leave the sidebar folderless.
    if (this.isSessionSidebarActive()) {
      this._tallTabsEnabled = true;
      container.classList.add('tabs-show-folder');
      container.classList.remove('tabs-two-rows', 'tabs-auto-wrap');
    }

    // Clean up any orphaned dropdowns before re-rendering
    document.querySelectorAll('body > .subagent-dropdown').forEach(d => d.remove());
    this.cancelHideSubagentDropdown();

    // #257: replacing innerHTML below resets scrollLeft to 0. On phones the
    // strip scrolls, and ambient rebuilds (a task badge appearing, a session
    // created elsewhere) fire often enough that a user swiping toward the
    // right-hand tabs kept getting yanked back to the first one. Remember
    // where the strip was; the browser clamps the restore to the new content.
    const prevScrollLeft = container.scrollLeft;
    // Sidebar layout scrolls the same container VERTICALLY, so it needs the
    // same protection on the other axis.
    const prevScrollTop = container.scrollTop;
    const prevActiveTabId = this._lastRenderedActiveTabId;
    const isFirstRender = !container.querySelector('.session-tab');

    // Build tabs HTML using array for better string concatenation performance.
    // Iterate in sessionOrder to respect the user's custom tab arrangement, on
    // EVERY device: mobile used to hoist the active session to the front, from
    // when only one tab fit on screen. With five tabs it made the strip jump
    // under the user's finger (and renumbered the Alt+N badges) on every full
    // rebuild, while the incremental path left the order alone, so the order
    // depended on which render path happened to run. Scrolling the active tab
    // into view replaces it.
    const parts = [];
    const tabOrder = this.sessionOrder;
    // Read once, not per session: isRichTabRows() touches the DOM and
    // this loop runs for every tab on every full rebuild.
    const richRows = this.isRichTabRows();
    let _tabIdx = 0;
    for (const id of tabOrder) {
      const session = this.sessions.get(id);
      if (!session) continue; // Skip if session was removed

      // See the note in the incremental path: a web tab owns the active highlight
      // while one is open, even though activeSessionId stays set.
      const isActive = id === this.activeSessionId && !this.activeWebviewId;
      const status = session.status || 'idle';
      const name = this.getSessionName(session);
      const mode = session.mode || 'claude';
      const color = session.color || 'default';
      const taskStats = session.taskStats || { running: 0, total: 0 };
      const hasRunningTasks = taskStats.running > 0;
      const alertType = this.tabAlerts.get(id);
      const alertClass = alertType === 'action' ? ' tab-alert-action' : alertType === 'idle' ? ' tab-alert-idle' : '';
      const loadState = this.terminalLoadStates.get(id);

      // Get minimized subagents for this session
      const minimizedAgents = this.minimizedSubagents.get(id);
      const minimizedCount = minimizedAgents?.size || 0;
      const subagentBadge = minimizedCount > 0 ? this.renderSubagentTabBadge(id, minimizedAgents) : '';

      // Ultracode runs + agent transcripts minimized to this tab (ultracode-windows.js
      // renders one merged ULTRA badge; returns '' when nothing is minimized).
      const ultracodeBadge = this.renderUltracodeTabBadge ? this.renderUltracodeTabBadge(id) : '';

      // Show folder name if session has a custom name AND tall tabs setting is enabled
      const folderName = session.workingDir ? session.workingDir.split('/').pop() || '' : '';
      const tallTabsEnabled = this._tallTabsEnabled ?? false;
      const showFolder = tallTabsEnabled && session.name && folderName && folderName !== name;

      // #232: a session with a description (the `: suffix` part of its name) shows
      // JUST the description on the tab; the generated w<n>-<case> id moves to the
      // tooltip and stays visible in the session settings modal.
      const parsedName = parseSessionPrefix(name);
      const tabLabel = parsedName && parsedName.suffix
        ? `<span class="tab-name-prefix">${escapeHtml(parsedName.prefix)}: </span>${escapeHtml(parsedName.suffix)}`
        : escapeHtml(name);
      const tabTooltip = parsedName && parsedName.suffix
        ? (session.workingDir ? `${parsedName.prefix} (${session.workingDir})` : parsedName.prefix)
        : (session.workingDir || '');

      // Rich rows only (the detailed sidebar OR the vertical tab rail): the home
      // screen's created/state stamps and a status pill. richRow is null in every
      // other layout, and both helpers below collapse to '' — the header strip's
      // markup is unchanged.
      const richRow = richRows ? this._sidebarRichRow(id, session) : null;
      const richMeta = this._sidebarRichMetaHTML(richRow);
      const richClass = richRow ? ` tab-state-${richRow.state}` : '';
      const richData = richRow
        ? ` data-tab-state="${richRow.state}" data-tab-meta-sig="${richRow.state}:${richRow.since ? richRow.since.at : 0}:${richRow.createdAt}"`
        : '';

      const inlineSessionActions = this.shouldInlineSessionActions();
      const tabActionsHtml = `<span class="tab-actions"><span class="tab-gear" onclick="event.stopPropagation(); app.openSessionOptions(${escapeHtml(JSON.stringify(id))})" title="Session options" aria-label="Session options" tabindex="0">&#x2699;</span><span class="tab-detach" onclick="event.stopPropagation(); app.detachSession(${escapeHtml(JSON.stringify(id))})" title="Open in a new window" aria-label="Open session in a new window" tabindex="0">&#x29C9;</span><span class="tab-close" onclick="event.stopPropagation(); app.requestCloseSession(${escapeHtml(JSON.stringify(id))})" title="Close session" aria-label="Close session" tabindex="0">&times;</span><button type="button" class="tab-more" onclick="event.stopPropagation(); app.openTabRailActionMenu(event, ${escapeHtml(JSON.stringify(id))})" title="Session actions" aria-label="Session actions">&#x22EF;</button></span>`;

      parts.push(`<div class="session-tab ${isActive ? 'active' : ''}${alertClass}${richClass}${loadState ? ' tab-loading' : ''}${this.hasTabDetachOverride(id) ? ' tab-show-detach' : ''}"${richData} data-id="${id}" data-color="${color}" ${loadState ? `data-load-phase="${escapeHtml(loadState.phase)}"` : ''} onclick="app.handleSessionTabClick(event, ${escapeHtml(JSON.stringify(id))})" oncontextmenu="event.preventDefault(); app.startInlineRename(${escapeHtml(JSON.stringify(id))})" tabindex="0" role="tab" aria-selected="${isActive ? 'true' : 'false'}" aria-busy="${loadState ? 'true' : 'false'}" aria-label="${escapeHtml(name)} session" ${tabTooltip ? `title="${escapeHtml(tabTooltip)}"` : ''}>
          ${_tabIdx < 9 ? '<span class="tab-number">' + (_tabIdx + 1) + '</span>' : ''}
          ${loadState ? '<span class="tab-load-spinner" aria-hidden="true"></span>' : ''}
          <span class="tab-status ${status}" aria-hidden="true"></span>
          <span class="tab-info">
            <span class="tab-name-row">
              ${mode === 'shell' ? '<span class="tab-mode shell" aria-hidden="true">sh</span>' : mode === 'opencode' ? '<span class="tab-mode opencode" aria-hidden="true">oc</span>' : mode === 'codex' ? '<span class="tab-mode codex" aria-hidden="true">cx</span>' : mode === 'gemini' ? '<span class="tab-mode gemini" aria-hidden="true">gm</span>' : mode === 'antigravity' ? '<span class="tab-mode antigravity" aria-hidden="true">ag</span>' : mode === 'pi' ? '<span class="tab-mode pi" aria-hidden="true">pi</span>' : mode === 'grok' ? '<span class="tab-mode grok" aria-hidden="true">gk</span>' : mode === 'deepseek' ? '<span class="tab-mode deepseek" aria-hidden="true">ds</span>' : mode === 'omp' ? '<span class="tab-mode omp" aria-hidden="true">om</span>' : ''}
              <span class="tab-name" data-session-id="${id}" data-full-name="${escapeHtml(name)}">${tabLabel}</span>
              ${inlineSessionActions ? tabActionsHtml : ''}
              <span class="tab-detached-badge" aria-hidden="true">detached</span>
            </span>
            ${showFolder ? `<span class="tab-folder">\u{1F4C1} ${escapeHtml(folderName)}</span>` : ''}
            ${richMeta}
          </span>
          ${hasRunningTasks ? `<span class="tab-badge" onclick="event.stopPropagation(); app.toggleTaskPanel()" aria-label="${taskStats.running} running tasks">${taskStats.running}</span>` : ''}
          ${subagentBadge}
          ${ultracodeBadge}
          ${inlineSessionActions ? '' : tabActionsHtml}
        </div>`);
      _tabIdx++;
    }

    // Web tabs (dashboard URLs) render after the session tabs, continuing the
    // Alt+N numbering. They carry data-webview-id instead of data-id, so every
    // session-tab code path above (drag-and-drop, alerts, badges) skips them.
    parts.push(this.renderWebviewTabs ? this.renderWebviewTabs(_tabIdx) : '');

    container.innerHTML = parts.join('');

    // Put the strip back where the user left it, then reveal the active tab
    // only when it CHANGED (or on the first paint). Restoring unconditionally
    // and revealing conditionally is what lets someone browse the far end of
    // the strip while a background rebuild fires, without the active tab ever
    // being stranded off-screen after a switch.
    container.scrollLeft = prevScrollLeft;
    container.scrollTop = prevScrollTop;
    this._lastRenderedActiveTabId = this.activeSessionId;
    if (isFirstRender || prevActiveTabId !== this.activeSessionId) {
      this._scrollActiveTabIntoView(this.activeSessionId, isFirstRender ? 'auto' : 'smooth');
    }

    // Set up drag-and-drop handlers for tab reordering
    this.setupTabDragHandlers();

    // Set up keyboard navigation for tabs
    this.setupTabKeyboardNavigation(container);

    // Update connection lines after tabs change (positions may have shifted)
    this.updateConnectionLines();

    // Re-evaluate desktop auto-wrap for every full rebuild, including the incremental
    // branch's early `_fullRenderSessionTabs(); return;` paths and the manual two-rows
    // toggle (applyTabWrapSettings calls this) which would otherwise leave a stale
    // tabs-auto-wrap class until the next content render.
    this.updateTabOverflowMode();
    // Newly created tabs animate in; a re-render mid-cascade resumes them rather
    // than restarting, since this rebuild just destroyed the animating elements.
    this._applyTabEntrances?.();

    // innerHTML was rebuilt wholesale, so the sidebar filter classes are gone —
    // re-apply them or filtered-out sessions flicker back on every SSE tick.
    this.applySidebarFilter(this._sidebarFilter);

    // Rows that carry self-staling stamps need the clock; rows that don't must
    // not leave it running. Both directions matter — the layout can flip
    // underneath a render, and a solo window forces 'header' regardless.
    if (richRows) this._startSidebarRichClock();
    else this._stopSidebarRichClock();
  }

  // Set up arrow key navigation for session tabs (accessibility)
  setupTabKeyboardNavigation(container) {
    // Remove existing listener if any to avoid duplicates
    if (this._tabKeydownHandler) {
      container.removeEventListener('keydown', this._tabKeydownHandler);
    }

    this._tabKeydownHandler = (e) => {
      // Up/Down are aliases of Left/Right, not replacements: the strip stays
      // arrow-key navigable exactly as before, the vertical sidebar just gains
      // the axis a user reaches for there.
      if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'Enter', ' '].includes(e.key)) return;

      // Rows hidden by the sidebar filter must not be steppable.
      const tabs = [...container.querySelectorAll('.session-tab:not(.tab-filtered-out)')];
      const currentIndex = tabs.indexOf(document.activeElement);

      // Enter or Space activates the tab
      if ((e.key === 'Enter' || e.key === ' ') && currentIndex >= 0) {
        e.preventDefault();
        const sessionId = tabs[currentIndex].dataset.id;
        this.selectSession(sessionId, { forceReload: true });
        return;
      }

      if (currentIndex < 0) return;

      let newIndex;
      switch (e.key) {
        case 'ArrowLeft':
        case 'ArrowUp':
          newIndex = currentIndex > 0 ? currentIndex - 1 : tabs.length - 1;
          break;
        case 'ArrowRight':
        case 'ArrowDown':
          newIndex = currentIndex < tabs.length - 1 ? currentIndex + 1 : 0;
          break;
        case 'Home':
          newIndex = 0;
          break;
        case 'End':
          newIndex = tabs.length - 1;
          break;
        default:
          return;
      }

      e.preventDefault();
      tabs[newIndex]?.focus();
    };

    container.addEventListener('keydown', this._tabKeydownHandler);
  }

  handleSessionTabClick(event, sessionId) {
    event?.preventDefault?.();
    // On touch with the keyboard hidden, blur the tapped tab so switching
    // sessions doesn't pop the on-screen keyboard. Focus policy itself lives
    // in selectSession via _shouldFocusTerminalForTabSwitch().
    const keyboardOpen = typeof KeyboardHandler !== 'undefined' && KeyboardHandler.keyboardVisible === true;
    if (!keyboardOpen && MobileDetection.isTouchDevice()) {
      document.activeElement?.blur?.();
    }
    return this.selectSession(sessionId, { forceReload: true });
  }


  // ═══════════════════════════════════════════════════════════════
  // Tab Order and Drag-and-Drop
  // ═══════════════════════════════════════════════════════════════

  // Sync sessionOrder with current sessions (preserve order for existing, add new at end)
  syncSessionOrder() {
    const currentIds = new Set(this.sessions.keys());

    // Load saved order from localStorage
    const savedOrder = this.loadSessionOrder();

    // Start with saved order, keeping only sessions that still exist
    const preserved = savedOrder.filter(id => currentIds.has(id));
    const preservedSet = new Set(preserved);

    // Add any new sessions at the end
    const newSessions = [...currentIds].filter(id => !preservedSet.has(id));

    this.sessionOrder = [...preserved, ...newSessions];
  }

  // Load session order from localStorage
  loadSessionOrder() {
    try {
      const saved = localStorage.getItem('codeman-session-order');
      return saved ? JSON.parse(saved) : [];
    } catch {
      return [];
    }
  }

  // Save session order to localStorage and (debounced) sync to the server so it
  // follows the user across devices (COD-131). localStorage stays the offline
  // fallback; the server is authoritative and echoes back via SSE.
  saveSessionOrder() {
    try {
      localStorage.setItem('codeman-session-order', JSON.stringify(this.sessionOrder));
    } catch {
      // Ignore storage errors
    }
    const order = [...this.sessionOrder];
    this._debouncedCall('saveSessionOrderServer', () => {
      fetch('/api/session-order', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ order }),
      }).catch(() => {});
    }, 400);
  }

  // COD-131: another device (or our own debounced push) reordered tabs. Adopt the
  // server order as the new base and reconcile to our currently-open sessions.
  // Guard against no-op churn so an echo of our own push doesn't flicker the tabs.
  _onSessionOrderChanged(data) {
    if (!data || !Array.isArray(data.order)) return;
    try {
      localStorage.setItem('codeman-session-order', JSON.stringify(data.order));
    } catch {
      // Ignore storage errors
    }
    const before = JSON.stringify(this.sessionOrder);
    this.syncSessionOrder();
    // Only re-render when the reconciled order actually changed (avoids flicker
    // when the broadcast is just an echo of the order we already have).
    if (JSON.stringify(this.sessionOrder) !== before) {
      this._fullRenderSessionTabs();
    }
  }

  // Set up drag-and-drop handlers on tab elements
  setupTabDragHandlers() {
    const container = this.$('sessionTabs');
    const tabs = container.querySelectorAll('.session-tab[data-id]');

    tabs.forEach(tab => {
      tab.setAttribute('draggable', 'true');

      tab.addEventListener('dragstart', (e) => {
        this.draggedTabId = tab.dataset.id;
        tab.classList.add('dragging');
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', tab.dataset.id);
      });

      tab.addEventListener('dragend', () => {
        tab.classList.remove('dragging');
        this.draggedTabId = null;
        // Remove all drag-over indicators
        container.querySelectorAll('.session-tab').forEach(t => {
          t.classList.remove('drag-over-left', 'drag-over-right');
        });
      });

      tab.addEventListener('dragover', (e) => {
        e.preventDefault();
        if (!this.draggedTabId || this.draggedTabId === tab.dataset.id) return;

        e.dataTransfer.dropEffect = 'move';

        // Determine drop position based on mouse position. Read the layout here,
        // inside the handler — these listeners survive a layout flip between
        // renders, so capturing the axis at bind time would go stale.
        // drag-over-left/-right keep their names and now read as before/after;
        // the sidebar/rail CSS just draws them as top/bottom edges.
        const rect = tab.getBoundingClientRect();
        const insertBefore = this._isVerticalTabList()
          ? e.clientY < rect.top + rect.height / 2
          : e.clientX < rect.left + rect.width / 2;

        // Update visual indicator
        tab.classList.toggle('drag-over-left', insertBefore);
        tab.classList.toggle('drag-over-right', !insertBefore);
      });

      tab.addEventListener('dragleave', () => {
        tab.classList.remove('drag-over-left', 'drag-over-right');
      });

      tab.addEventListener('drop', (e) => {
        e.preventDefault();
        tab.classList.remove('drag-over-left', 'drag-over-right');

        if (!this.draggedTabId || this.draggedTabId === tab.dataset.id) return;

        const targetId = tab.dataset.id;
        const draggedId = this.draggedTabId;

        // Determine insertion position (same axis rule as the dragover handler)
        const rect = tab.getBoundingClientRect();
        const insertBefore = this._isVerticalTabList()
          ? e.clientY < rect.top + rect.height / 2
          : e.clientX < rect.left + rect.width / 2;

        // Reorder sessionOrder array
        const fromIndex = this.sessionOrder.indexOf(draggedId);
        let toIndex = this.sessionOrder.indexOf(targetId);

        if (fromIndex === -1 || toIndex === -1) return;

        // Remove dragged item
        this.sessionOrder.splice(fromIndex, 1);

        // Recalculate target index after removal
        toIndex = this.sessionOrder.indexOf(targetId);
        if (toIndex === -1) return;

        // Insert at correct position
        if (insertBefore) {
          this.sessionOrder.splice(toIndex, 0, draggedId);
        } else {
          this.sessionOrder.splice(toIndex + 1, 0, draggedId);
        }

        // Save and re-render
        this.saveSessionOrder();
        this._fullRenderSessionTabs();
      });
    });
  }

  moveActiveTabLeft() {
    if (!this.activeSessionId) return;
    const idx = this.sessionOrder.indexOf(this.activeSessionId);
    if (idx <= 0) return;
    [this.sessionOrder[idx - 1], this.sessionOrder[idx]] = [this.sessionOrder[idx], this.sessionOrder[idx - 1]];
    this.saveSessionOrder();
    this._fullRenderSessionTabs();
  }

  moveActiveTabRight() {
    if (!this.activeSessionId) return;
    const idx = this.sessionOrder.indexOf(this.activeSessionId);
    if (idx === -1 || idx >= this.sessionOrder.length - 1) return;
    [this.sessionOrder[idx], this.sessionOrder[idx + 1]] = [this.sessionOrder[idx + 1], this.sessionOrder[idx]];
    this.saveSessionOrder();
    this._fullRenderSessionTabs();
  }

  // ═══════════════════════════════════════════════════════════════
  // Session Lifecycle — select, close, navigate
  // ═══════════════════════════════════════════════════════════════

  getShortId(id) {
    if (!id) return '';
    let short = this._shortIdCache.get(id);
    if (!short) {
      short = id.slice(0, 8);
      this._shortIdCache.set(id, short);
    }
    return short;
  }

  getSessionName(session) {
    // Use custom name if set
    if (session.name) {
      return session.name;
    }
    // Fall back to directory name
    if (session.workingDir) {
      return session.workingDir.split('/').pop() || session.workingDir;
    }
    return this.getShortId(session.id);
  }

  _notifySession(sessionId, urgency, category, title, message) {
    const session = this.sessions.get(sessionId);
    this.notificationManager?.notify({
      urgency,
      category,
      sessionId,
      sessionName: session?.name || this.getShortId(sessionId),
      title,
      message,
    });
  }

  /**
   * Clean up state from the previous session before switching tabs.
   * Handles: WebSocket teardown, CJK clear, flicker filter, tab completion,
   * terminal write queue, IME composition, and local echo flush.
   * @param {string} newSessionId - The session being switched TO.
   */
  _isUsableXtermSnapshot(snapshot) {
    if (!snapshot || typeof snapshot !== 'string' || snapshot.length < 8) return false;
    const visibleText = snapshot
      .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
      .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
      .replace(/\x1b[()][0-2A-Z]/g, '')
      .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
      .trim();
    return visibleText.length >= 3;
  }

  /**
   * Persist one xterm snapshot to localStorage, bounded to a fixed key budget
   * regardless of how many sessions are live, and resilient to quota errors.
   * The previous inline version only pruned snapshots for sessions that no
   * longer existed AND pruned only after a successful setItem — so once the
   * quota filled (e.g. >10 live sessions at the 20-session target) the write
   * threw before the prune could run, permanently disabling persistence.
   */
  _persistXtermSnapshot(key, snapshot) {
    const PREFIX = 'codeman-xs-';
    const MAX_KEYS = 10;
    const others = () => Object.keys(localStorage).filter((k) => k.startsWith(PREFIX) && k !== key);
    try {
      // Evict down to the budget before writing a NEW key, dead sessions first
      // then oldest. (Overwriting an existing key doesn't grow the key count.)
      if (localStorage.getItem(key) === null) {
        const live = new Set(Array.from(this.sessions?.keys?.() || []));
        const pool = others().sort(
          (a, b) =>
            Number(live.has(a.slice(PREFIX.length))) - Number(live.has(b.slice(PREFIX.length)))
        );
        while (pool.length >= MAX_KEYS) localStorage.removeItem(pool.shift());
      }
      try {
        localStorage.setItem(key, snapshot);
      } catch (_quota) {
        // Quota exceeded: drop other snapshots one at a time and retry so a full
        // quota can't permanently disable persistence.
        for (const victim of others()) {
          localStorage.removeItem(victim);
          try {
            localStorage.setItem(key, snapshot);
            return;
          } catch (_again) {
            /* keep evicting */
          }
        }
        try { localStorage.removeItem(key); } catch {}
      }
    } catch (_unavailable) {
      /* localStorage unavailable (Safari private mode / disabled) — in-memory only */
    }
  }

  _cleanupPreviousSession(newSessionId) {
    // Snapshot the OUTGOING session's xterm rendered state (viewport + scrollback +
    // colors/attrs) before the terminal gets cleared/reset. Lets us restore the
    // exact view on switch-back rather than replaying codex's byte stream, which
    // drops earlier conversation from each TUI redraw and ends up showing only
    // the latest (idle) frame.
    // Shell sessions are never restored from a snapshot (restore is gated on
    // mode !== 'shell'), so skip the serialize() + cache slot + localStorage
    // quota for them. Unknown/undefined mode still snapshots, matching restore.
    const outgoingSession = this.activeSessionId ? this.sessions?.get?.(this.activeSessionId) : null;
    if (
      this.activeSessionId &&
      outgoingSession?.mode !== 'shell' &&
      this._serializeAddon &&
      this._xtermSnapshots
    ) {
      try {
        const snapshot = this._serializeAddon.serialize({ scrollback: 1000 });
        if (this._isUsableXtermSnapshot(snapshot)) {
          // Delete-before-set so re-touching a session moves it to the end of
          // the Map's insertion order — otherwise eviction is FIFO and can drop
          // the most-recently-used session instead of the least.
          this._xtermSnapshots.delete(this.activeSessionId);
          this._xtermSnapshots.set(this.activeSessionId, snapshot);
          // Cap in-memory snapshot cache at 20 entries; evict oldest on overflow.
          if (this._xtermSnapshots.size > 20) {
            const oldest = this._xtermSnapshots.keys().next().value;
            this._xtermSnapshots.delete(oldest);
          }
          // Persist to localStorage so the snapshot survives tab discard /
          // browser reload (Chrome discards inactive tabs after idle periods,
          // wiping in-memory state). Cap per-snapshot at 256KB; codex
          // buffer-replay produces a visual mess of stacked banner redraws when
          // no snapshot exists, so persistence matters more here than for claude.
          if (snapshot.length < 256 * 1024) {
            this._persistXtermSnapshot(`codeman-xs-${this.activeSessionId}`, snapshot);
          }
        } else {
          this._xtermSnapshots.delete(this.activeSessionId);
          try { localStorage.removeItem(`codeman-xs-${this.activeSessionId}`); } catch {}
        }
      } catch (_err) {
        /* Serialize failed — fall back to server buffer replay */
      }
    }

    // Close WebSocket for previous session (new one opens after buffer load)
    this._disconnectWs();

    // Clear CJK input to prevent sending stale text to the wrong session.
    // Must go through CjkInput.clear() — a raw value wipe leaves the module's
    // pending flush timers armed and drops the phantom char it relies on.
    if (typeof CjkInput !== 'undefined') {
      CjkInput.clear();
    } else {
      const cjkEl = document.getElementById('cjkInput');
      if (cjkEl) cjkEl.value = '';
    }

    // Clean up flicker filter state when switching sessions
    this._clearTimer('flickerFilterTimeout');
    this.flickerFilterBuffer = '';
    this.flickerFilterActive = false;

    // Clear tab completion detection flag — don't carry across sessions
    this._tabCompletionSessionId = null;
    this._tabCompletionRetries = 0;
    this._tabCompletionBaseText = null;
    this._clearTimer('_tabCompletionFallback');
    this._clearTimer('_clientDropRecoveryTimer');
    this._terminalRefreshOwner = null;

    // Clean up pending terminal writes to prevent old session data from appearing in new session
    this._clearTimer('syncWaitTimeout');
    this.pendingWrites = [];
    this.writeFrameScheduled = false;
    // Release the one-chunk-in-flight gate with the rest of the write queue.
    // flushPendingWrites() early-returns while this is set, so a reset that
    // cleared everything EXCEPT this flag would leave live output permanently
    // stalled if xterm's parse callback never lands (disposed terminal, or a
    // throw inside the async parse). A late callback is harmless: it clears an
    // already-clear flag and schedules a flush.
    this._terminalWriteInFlight = false;
    this._terminalWriteInFlightBytes = 0;
    this._isLoadingBuffer = false;
    this._loadBufferQueue = null;
    this._bufferLoadOwner = null;
    // Abort any in-flight chunkedTerminalWrite from the previous session.
    // Without this, old rAF-scheduled chunks continue writing stale data
    // into the terminal, interleaving with the new session's buffer.
    this._chunkedWriteGen = (this._chunkedWriteGen || 0) + 1;
    // End any in-flight IME composition.
    // iOS Safari keeps autocorrect composing; switching tabs without ending it
    // leaves xterm's _compositionHelper._isComposing stuck true, which blocks
    // keyboard input when the user returns to this tab.
    try {
      const ch = this.terminal?._core?._compositionHelper;
      if (ch?._isComposing) {
        ch._isComposing = false;
        // Also fire compositionend on the textarea so any other listeners reset
        const ta = this.terminal?.element?.querySelector('.xterm-helper-textarea');
        if (ta) ta.dispatchEvent(new CompositionEvent('compositionend', { data: '' }));
      }
    } catch {}
    // Flush local echo text to PTY before switching tabs.
    // Send as a single batch (no Enter) so it lands in the session's readline
    // input buffer — avoids "old text resent on Enter" and overlay render bugs.
    // Track flushed length so _render() offsets the overlay correctly even before
    // the PTY echo arrives in the terminal buffer.
    if (this.activeSessionId) {
      const echoText = this._localEchoOverlay?.pendingText || '';
      // Include buffer-detected flushed text (from Tab completion, etc.)
      // so it's preserved across tab switches.
      const existingFlushed = this._localEchoOverlay?.getFlushed()?.count || 0;
      const existingFlushedText = this._localEchoOverlay?.getFlushed()?.text || '';
      if (echoText) {
        this._sendInputAsync(this.activeSessionId, echoText);
      }
      const totalOffset = existingFlushed + echoText.length;
      if (totalOffset > 0) {
        if (!this._flushedOffsets) this._flushedOffsets = new Map();
        if (!this._flushedTexts) this._flushedTexts = new Map();
        this._flushedOffsets.set(this.activeSessionId, totalOffset);
        this._flushedTexts.set(this.activeSessionId, existingFlushedText + echoText);
      }
    }
    this._localEchoOverlay?.clear();
    // Predictions are ephemeral + already sent: nothing to save/restore
    // across a tab switch (unlike the buffer overlay's setFlushed machinery)
    this._predictiveEcho?.clearPredictions();
    // Prevent _detectBufferText() from picking up Claude's Ink UI text
    // (status bar, model info, etc.) as "user input" on fresh sessions.
    // Only sessions with prior flushed text (from tab-switch-away) need detection.
    // After the user's first Enter, clear() resets _bufferDetectDone = false,
    // re-enabling detection for tab completion and other legitimate cases.
    if (this._localEchoOverlay && !this._flushedOffsets?.has(newSessionId)) {
      this._localEchoOverlay.suppressBufferDetection();
    }
  }

  _resetTerminalForReplay() {
    this.terminal.reset();
    this.terminal.write('\x1b[3J\x1b[H\x1b[2J');
  }

  _recordTerminalLoadTiming(timing) {
    this._lastTerminalLoadTiming = timing;
    console.info('[TERMINAL-PERF]', timing);
    const resetAndParseMs =
      (timing.cacheResetAndParseMs || 0) +
      (timing.freshResetAndParseMs || 0) +
      (timing.resetAndParseMs || 0);
    const totalMs = timing.selectDoneMs ?? timing.totalMs ?? timing.selectToReplayCompleteMs ?? 0;
    _crashDiag.log(
      `TERMINAL_LOAD: ${timing.trigger} ${timing.full ? 'full' : 'tail'} ${timing.chars} chars ` +
      `ttfb=${timing.ttfbMs.toFixed(0)}ms body+json=${timing.bodyAndJsonMs.toFixed(0)}ms ` +
      `reset+parse=${resetAndParseMs.toFixed(0)}ms total=${totalMs.toFixed(0)}ms ` +
      `server="${timing.serverTiming}"${timing.refused ? ' refused-downgrade' : ''}`
    );
  }

  /**
   * "Load more history": re-pull the whole tmux scrollback when the user scrolls up
   * while already at the top of what the browser has.
   *
   * xterm's buffer is only ever a WINDOW onto tmux's real history, and two things
   * shrink it. tmux repaints the pane rectangle instead of emitting linefeeds
   * whenever output outpaces its flush interval, which OVERWRITES already-rendered
   * scrollback rather than pushing rows into it (measured: a 60-line burst added 1
   * row and destroyed 34, while the same 60 lines emitted slowly added all 60). And
   * a tab switch replays only the visible frame. Either way tmux still holds
   * everything (history-limit 100k by default), so the fix is to go ask for it with
   * the same `?full=1` capture a page reload uses (issue #205).
   *
   * On demand rather than automatic because that capture is unbounded-ish work: at
   * the default history limit it can be megabytes, which is fine to pay when the
   * user is explicitly reaching for history and not fine on every tab switch.
   *
   * NEVER a downgrade: for a repaint-mode CLI pane tmux keeps no history of its
   * own, so the capture can be THINNER than what xterm already holds and the
   * reset+rewrite below would delete history mid-scroll. `_replayWouldShrinkBuffer`
   * (terminal-ui.js) is the guard, and a session that produced one useless re-pull
   * gets a much longer cooldown so a hollow pane stops re-fetching megabytes on
   * every scroll-up (issue #205, round 2).
   */
  async _maybeRefetchFullHistory({ force = false } = {}) {
    const sessionId = this.activeSessionId;
    if (!sessionId || this._fullHistoryRepullInFlight || this._isLoadingBuffer) return;
    if (this.detachedSessions?.has(sessionId)) return;
    const session = this.sessions.get(sessionId);
    // A shell's full capture can be many megabytes. Replaying it from an
    // ordinary scroll gesture blocks xterm's main thread, so keep that cost
    // behind the explicit "Load full history" button.
    if (!force && session?.mode === 'shell') return;
    const now = Date.now();
    // Momentum scrolling fires this dozens of times per flick, and a burst of new
    // output is the normal reason to want a re-pull, so cooldown rather than latch.
    // `force` is the user pressing "Load full history" (#258): they asked once,
    // explicitly, so the scroll-gesture cooldown does not apply. The downgrade
    // guard below still does — a forced pull must not destroy history either.
    const cooldown = this._fullHistoryRepullUseless?.has(sessionId) ? 60000 : 4000;
    if (!force && now - (this._fullHistoryRepullAt.get(sessionId) || 0) < cooldown) return;
    this._fullHistoryRepullAt.set(sessionId, now);
    this._fullHistoryRepullInFlight = true;
    try {
      const requestStartedAt = performance.now();
      const res = await fetch(`/api/sessions/${sessionId}/terminal?full=1`);
      const headersReceivedAt = performance.now();
      const payload = (await res.json())?.data ?? {};
      const bodyParsedAt = performance.now();
      const buffer = payload.terminalBuffer;
      const timing = {
        trigger: force ? 'full-history-button' : 'full-history-scroll',
        mode: session?.mode || 'unknown',
        full: true,
        source: payload.source || 'unknown',
        chars: buffer?.length || 0,
        ttfbMs: headersReceivedAt - requestStartedAt,
        bodyAndJsonMs: bodyParsedAt - headersReceivedAt,
        resetAndParseMs: 0,
        totalMs: 0,
        serverTiming: res.headers?.get?.('server-timing') || '',
        refused: false,
      };
      // Bail on a tab switch mid-fetch: writing here would paint another session's
      // history into the terminal the user is now looking at.
      if (!buffer || this.activeSessionId !== sessionId) return;
      if (this._replayWouldShrinkBuffer(buffer)) {
        timing.refused = true;
        timing.totalMs = performance.now() - requestStartedAt;
        this._recordTerminalLoadTiming(timing);
        (this._fullHistoryRepullUseless ||= new Set()).add(sessionId);
        this._logScrollRouting?.('repull-refused-downgrade');
        // The browser already holds more than tmux can give back, so there is
        // nothing further to offer and the indicator must stop promising it.
        this._setHistoryTruncation(sessionId, { ...payload, exhausted: true });
        return;
      }
      this._setHistoryTruncation(sessionId, payload);
      this._fullHistoryRepullUseless?.delete(sessionId);
      const rowsBefore = this.terminal.buffer.active.length;
      const replayStartedAt = performance.now();
      this._resetTerminalForReplay();
      const {
        parsedAt,
        bufferLength: parsedBufferLength,
        completed,
      } = await this.chunkedTerminalWrite(buffer, TERMINAL_CHUNK_SIZE, sessionId);
      timing.resetAndParseMs = parsedAt - replayStartedAt;
      if (!completed || this.activeSessionId !== sessionId) return;
      // Keep shell tab restores bounded too. A user-triggered full-history pull
      // may be tens of MB; caching it would replay that whole payload again on
      // the next tab switch before the normal 1MB tail fetch replaces it.
      if (this.sessions.get(sessionId)?.mode !== 'shell') {
        this.terminalBufferCache.set(sessionId, buffer);
      } else {
        this.terminalBufferCache.delete(sessionId);
      }
      // Hold the user's place. The replay is a superset that grew the buffer
      // UPWARD, so what used to be row 0 (what they were looking at) is now `delta`
      // rows down; scrolling there reveals the recovered history above it instead
      // of teleporting them to the bottom the way a normal buffer load does.
      const delta = parsedBufferLength - rowsBefore;
      if (delta > 0) this.terminal.scrollToLine(delta);
      else this.terminal.scrollToTop();
      timing.totalMs = performance.now() - requestStartedAt;
      this._recordTerminalLoadTiming(timing);
    } catch {
      // Transient (offline, 5xx) — the next scroll-up past the cooldown retries.
    } finally {
      this._fullHistoryRepullInFlight = false;
    }
  }

  /**
   * Record how much history a replay actually carried, and refresh the banner.
   *
   * Called from every path that writes a fetched buffer into xterm. Keyed by
   * session because the banner describes the ACTIVE tab and a background fetch
   * must not relabel it.
   */
  _setHistoryTruncation(sessionId, payload = {}) {
    if (!sessionId) return;
    (this._historyTruncation ||= new Map()).set(sessionId, {
      truncated: !!payload.truncated,
      reason: payload.truncationReason ?? null,
      source: payload.source ?? null,
      fullSize: payload.fullSize ?? 0,
      retainedBytes: payload.retainedBytes ?? 0,
      // Set once a full-history pull has been refused as a downgrade: the
      // browser holds more than the server can return, so there is no more.
      exhausted: !!payload.exhausted,
    });
    if (sessionId === this.activeSessionId) this._renderHistoryTruncationBanner();
  }

  /** Drop banner state for a session that is going away. */
  _clearHistoryTruncation(sessionId) {
    this._historyTruncation?.delete(sessionId);
    if (sessionId === this.activeSessionId) this._renderHistoryTruncationBanner();
  }

  /**
   * Paint the partial-history banner for the active session.
   *
   * Three distinct states, because "we tailed for speed" and "the oldest output
   * is gone forever" are not the same message and the old single boolean could
   * not tell them apart:
   *   - recoverable  → offer to load the rest
   *   - exhausted    → say so plainly, offer nothing
   *   - at the limit → the full capture ITSELF hit the byte ceiling
   */
  _renderHistoryTruncationBanner() {
    const bar = document.getElementById('historyTruncationBar');
    if (!bar) return;
    const state = this.activeSessionId ? this._historyTruncation?.get(this.activeSessionId) : null;
    const notice = computeHistoryTruncationNotice(state || {});
    if (!notice.visible) {
      bar.hidden = true;
      return;
    }

    bar.textContent = '';
    const label = document.createElement('span');
    label.className = 'history-trunc-text';
    label.textContent = notice.message;
    bar.appendChild(label);

    if (notice.canLoadMore) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'history-trunc-load';
      btn.textContent = 'Load full history';
      btn.onclick = () => {
        btn.disabled = true;
        btn.textContent = 'Loading…';
        // Forced: the cooldown exists to throttle scroll gestures, not choices.
        this._maybeRefetchFullHistory({ force: true }).finally(() => {
          this._renderHistoryTruncationBanner();
        });
      };
      bar.appendChild(btn);
    }

    const dismiss = document.createElement('button');
    dismiss.type = 'button';
    dismiss.className = 'history-trunc-dismiss';
    dismiss.setAttribute('aria-label', 'Dismiss history notice');
    dismiss.textContent = '×';
    dismiss.onclick = () => {
      bar.hidden = true;
    };
    bar.appendChild(dismiss);

    bar.hidden = false;
  }

  _shouldFocusTerminalForTabSwitch() {
    if (typeof MobileDetection === 'undefined' || !MobileDetection.isTouchDevice()) {
      return true;
    }
    return typeof KeyboardHandler !== 'undefined' && KeyboardHandler.keyboardVisible;
  }

  async selectSession(sessionId, options = {}) {
    // If this session is popped out into its own window, raise that window
    // instead of showing it inline (focus-on-click for detached tabs). If we
    // owned a now-closed window, _raiseDetached re-docks and returns false so
    // we fall through and load it inline.
    if (!this.isSoloWindow && this.detachedSessions.has(sessionId)) {
      if (this._raiseDetached(sessionId)) return;
    }
    const forceReload = options?.forceReload === true;
    // ⚠️ `auto: true` marks a selection the APP made rather than the human:
    // the boot restore, a solo window opening its target, the fallback after
    // the active session is deleted. Those must NOT spend a pending idle alert
    // (the yellow survives until a real tap), because "the app put this on
    // screen" is not "I checked it". The DEFAULT is user-initiated, so a call
    // site nobody tagged fails toward acknowledging rather than toward an
    // alert that can never be cleared.
    const userInitiated = options?.auto !== true;
    if (this.activeSessionId === sessionId && !forceReload) {
      // Tapping the tab you are already on is still "I checked it". The alert
      // can be armed on the ACTIVE tab (a live idle_prompt fires regardless of
      // which tab is showing, and so does the reload seed), and every other
      // clear path runs on the switch this early return skips, leaving a
      // yellow tab that no tap could clear.
      if (userInitiated) this.markIdleAlertSeen(sessionId);
      return;
    }
    if (this.activeSessionId === sessionId && forceReload) {
      this.terminalBufferCache?.delete(sessionId);
      this._xtermSnapshots?.delete(sessionId);
      try { localStorage.removeItem(`codeman-xs-${sessionId}`); } catch {}
      this._clearTimer('syncWaitTimeout');
      this.pendingWrites = [];
      this.writeFrameScheduled = false;
      this._terminalWriteInFlight = false;
      this._terminalWriteInFlightBytes = 0;
      this._isLoadingBuffer = false;
      this._loadBufferQueue = null;
      this._terminalRefreshOwner = null;
      this._chunkedWriteGen = (this._chunkedWriteGen || 0) + 1;
      this.activeSessionId = null;
    }
    // Focus terminal SYNCHRONOUSLY before any await — iOS Safari only honors
    // programmatic focus() within the user-gesture call stack (e.g. tab click).
    // After the first await the gesture context is lost and focus() is silently
    // ignored, leaving the keyboard unable to send input to the terminal.
    // Desktop always focuses; touch focuses only while the on-screen keyboard
    // is already open (so a tab switch doesn't pop the keyboard).
    const shouldFocusTerminal = this._shouldFocusTerminalForTabSwitch();
    if (shouldFocusTerminal && this.terminal) this.terminal.focus();

    const _selStart = performance.now();
    const _selName = this.sessions.get(sessionId)?.name || sessionId.slice(0,8);
    _crashDiag.log(`SELECT: ${_selName}`);
    console.log(`[CRASH-DIAG] selectSession START: ${sessionId.slice(0,8)}`);

    const selectGen = ++this._selectGeneration;
    this._setTerminalLoadState(sessionId, selectGen, 'resizing');

    if (selectGen !== this._selectGeneration) {
      this._clearTerminalLoadState(sessionId, selectGen);
      return; // newer tab switch won
    }

    // A session tab takes the stage back from any active web tab.
    this._hideWebviewLayer?.();

    this._cleanupPreviousSession(sessionId);
    this.activeSessionId = sessionId;
    this._activateFileBrowserSession?.(sessionId);
    // Repaint the partial-history banner for the tab being switched TO. The
    // replay paths refresh it when their fetch lands; without this the previous
    // session's notice stays on screen until then (#258).
    this._renderHistoryTruncationBanner();
    try { localStorage.setItem('codeman-active-session', sessionId); } catch {}
    // Narrow SSE filter to the active session — server stops streaming
    // session:terminal events for other sessions to this client. Cuts
    // SSE traffic ~Nx for N concurrent sessions. Fire-and-forget; on the
    // rare race where server doesn't know our clientId yet, the next
    // selectSession or reconnect catches up.
    this._updateSseSubscription(sessionId);
    this.hideWelcome();
    // Terminal-pane entrance: plays for a freshly created session, and on every
    // switch when that option is on. Transform/opacity/clip-path only, xterm's
    // FitAddon reads the untransformed layout box, so this cannot reach the PTY.
    this.playTerminalEntrance?.(sessionId);
    // Clear idle hooks on view, but keep action hooks until user interacts.
    // Also acknowledged server-side, so the yellow does not come back on the
    // next reload and the user's other devices clear it too. Skipped for an
    // `auto` selection (see userInitiated above).
    if (userInitiated) this.markIdleAlertSeen(sessionId);
    // Instant active-class toggle (no 100ms debounce), then schedule full render for badges/status
    this._updateActiveTabImmediate(sessionId);
    // Handheld: the session drawer overlays the terminal, so slide it away now
    // that a session has been picked. No-op on desktop and in header layout.
    this.closeSessionSidebarOnHandheld();
    this.renderSessionTabs();
    this.updateAttachmentHistoryBadge?.();
    if (this.attachmentHistoryDrawerOpen) {
      this.loadAttachmentHistory?.(sessionId);
    }
    this._updateLocalEchoState();
    // Shell sessions get the terminal keyboard bar, agent sessions the command
    // bar (issue #262). Also disarms a one-shot Ctrl left over from the tab we
    // just left, so it can never fire against the session we just opened.
    if (typeof KeyboardAccessoryBar !== 'undefined') KeyboardAccessoryBar.refreshForActiveSession();

    // Restore flushed offset AND text IMMEDIATELY so backspace/typing work during
    // the async buffer load.  Without this, the offset is 0 during the
    // fetch() gap: backspace is swallowed, and typing a space covers the
    // canvas text with an opaque overlay showing only the new char.
    if (this._flushedOffsets?.has(sessionId) && this._localEchoOverlay) {
      this._localEchoOverlay.setFlushed(
        this._flushedOffsets.get(sessionId),
        this._flushedTexts?.get(sessionId) || '',
        false  // render=false: buffer not loaded yet
      );
    }

    // Glow the newly-active tab
    const activeTab = document.querySelector(`.session-tab.active[data-id="${sessionId}"]`);
    if (activeTab) {
      activeTab.classList.add('tab-glow');
      activeTab.addEventListener('animationend', () => activeTab.classList.remove('tab-glow'), { once: true });
    }

    // Check if this is a restored session that needs to be attached
    const session = this.sessions.get(sessionId);

    // Track working directory for path normalization in Project Insights
    this.currentSessionWorkingDir = session?.workingDir || null;
    if (session && session.pid === null) {
      if (session.respawnBlocked) {
        // COD-118: the PTY-exit circuit breaker tripped for this session — the
        // automatic re-attach must NOT silently clear it (that would re-arm the
        // crash loop on every tab click / page load). Restart only on explicit
        // user confirmation; the confirmed request carries clearBreaker:true.
        const label = session.name || 'Session';
        if (window.confirm(`${label} was stopped after crashing repeatedly. Restart it?`)) {
          try {
            await fetch(`/api/sessions/${sessionId}/interactive`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ clearBreaker: true }),
            });
            session.respawnBlocked = false;
            session.status = 'busy';
          } catch (err) {
            console.error('Failed to restart crash-looped session:', err);
          }
        }
      } else {
        // Session has no PTY attached — either restored after server restart
        // or detached for some other reason. Re-attach regardless of status.
        // Deliberately NO body: this automatic path must never clear a tripped
        // PTY-exit breaker (COD-118).
        try {
          const endpoint = session.mode === 'shell'
            ? `/api/sessions/${sessionId}/shell`
            : `/api/sessions/${sessionId}/interactive`;
          await fetch(endpoint, { method: 'POST' });
          // Update local session state
          session.status = 'busy';
        } catch (err) {
          console.error('Failed to attach to restored session:', err);
        }
      }
    }

    // Hold for the terminal font before measuring anything. A cell measured
    // against a fallback font gives the wrong column and row count, and the
    // correction would land after the replay, leaving the CLI drawing against a
    // frame the terminal no longer shows. Resolves immediately once the font is
    // in, so this costs a tab switch nothing after the first load, and it is
    // bounded, so a font that never arrives cannot strand the session.
    // ⚠️ BEFORE `_beginBufferLoad` on purpose: inside it, every live SSE event
    // for this session queues instead of painting, so a slow font would hold
    // output back rather than merely mis-measuring the grid.
    if (this._terminalFontReady) {
      await this._terminalFontReady;
      if (this._isStaleSelect(selectGen)) {
        this._clearTerminalLoadState(sessionId, selectGen);
        return;
      }
    }

    // Load terminal buffer for this session
    // Show cached content instantly while fetching fresh data in background.
    // Use tail mode for faster initial load (128KB is enough for recent visible content).
    //
    // Protect flushed state during buffer load: terminal.write() can trigger
    // xterm.js onData responses (DA, OSC, etc.) that would otherwise clear
    // the flushed Maps via the control char handler.  The multi-byte ESC
    // filter catches most cases, but _restoringFlushedState provides a
    // belt-and-suspenders guard for any edge cases.
    this._restoringFlushedState = true;
    // Gate live SSE terminal writes for the ENTIRE buffer load sequence.
    // Without this, SSE events arriving during the fetch() gap compete with
    // the buffer write, causing 70KB+ single-frame flushes that stall WebGL.
    // chunkedTerminalWrite also sets this, but we need it before the fetch too.
    const bufferLoadOwner = this._beginBufferLoad(selectGen);
    // COD-144: track whether the load painted nothing (empty fetch + no cache).
    // For that just-created-session case we flush (not discard) queued SSE events.
    let bufferWasEmpty = false;
    let cacheResetAndParseMs = 0;
    try {
      // Fit terminal to container BEFORE writing any buffer data.
      // If the browser was resized while viewing another session, the terminal
      // canvas may be at stale dimensions — content would render at wrong width.
      if (this.fitAddon) this.fitAddon.fit();

      // Also push the new dimensions to the PTY. Without this, codex/codeman
      // sees the size that was set the last time the throttled resize handler
      // fired (often the size of a different session's container, or the
      // initial tmux default). The visible symptom is codex rendering inside
      // a small region with empty rows below the status bar.
      // sendResize is a no-op on the server when dims haven't changed, so
      // calling it every tab switch is cheap.
      const dimsChanged = await this.sendResize(sessionId, { forceHttp: true }).catch(() => false);
      if (this._isStaleSelect(selectGen)) {
        this._clearTerminalLoadState(sessionId, selectGen);
        return;
      }

      // xterm snapshot restore: if we have a serialized xterm state from a
      // previous visit to this session, restore the user's exact prior view
      // (viewport + scrollback + colors) for an instant first paint. For codex
      // this is also a correctness fix — its byte-stream replay shows only the
      // latest TUI frame (the idle welcome banner) because codex doesn't include
      // earlier conversation in its current redraw. For claude/opencode/gemini/antigravity
      // the replay is already complete, so the snapshot is purely a faster,
      // scroll-preserving first paint before the canonical fetch reconciles.
      //
      // Try in-memory first (fast); fall back to localStorage so snapshots
      // survive tab discards / browser reloads.
      let snapshot = this._xtermSnapshots?.get(sessionId);
      if (snapshot && !this._isUsableXtermSnapshot(snapshot)) {
        this._xtermSnapshots?.delete(sessionId);
        snapshot = null;
      }
      if (!snapshot) {
        try {
          const persisted = localStorage.getItem(`codeman-xs-${sessionId}`);
          if (persisted && this._isUsableXtermSnapshot(persisted)) {
            snapshot = persisted;
            // Hoist into in-memory cache for next time (delete-before-set keeps
            // the Map in LRU order so the just-used session isn't evicted first).
            this._xtermSnapshots?.delete(sessionId);
            this._xtermSnapshots?.set(sessionId, persisted);
          } else if (persisted) {
            localStorage.removeItem(`codeman-xs-${sessionId}`);
          }
        } catch (_e) {
          /* localStorage unavailable — proceed without snapshot */
        }
      }
      const sessionIsBusy = session && (session.status === 'busy' || session.status === 'working');
      let restoredSnapshot = false;
      if (snapshot && !sessionIsBusy && session?.mode !== 'shell') {
        _crashDiag.log(`SNAPSHOT_RESTORE: ${(snapshot.length/1024).toFixed(0)}KB`);
        this._setTerminalLoadState(sessionId, selectGen, 'replaying');
        this._resetTerminalForReplay();
        await new Promise((resolve) => this.terminal.write(snapshot, resolve));
        if (this._isStaleSelect(selectGen)) {
          this._clearTerminalLoadState(sessionId, selectGen);
          return;
        }
        this.scrollToLastNonEmptyLine();
        _crashDiag.log('SNAPSHOT_RESTORE_DONE');
        // Snapshot restore is only first paint. Inactive tabs intentionally
        // unsubscribe from high-volume terminal output, so they can miss bytes
        // emitted while away. Keep going and replace the snapshot with the
        // canonical live tmux pane frame from /terminal.
        restoredSnapshot = true;
      }

      // Instant cache restore for IDLE sessions only.
      // For busy sessions, the cache is always stale — writing it first causes a
      // jarring double-render: stale content appears, then the terminal flashes
      // blank and rewrites with fresh data. Skip the cache and write the fresh
      // buffer once for a single clean transition.
      const cachedBuffer = this.terminalBufferCache.get(sessionId);
      let clearedBeforeFresh = false;
      if (cachedBuffer && !sessionIsBusy && !restoredSnapshot && session?.mode !== 'shell') {
        _crashDiag.log(`CACHE_WRITE: ${(cachedBuffer.length/1024).toFixed(0)}KB`);
        this._setTerminalLoadState(sessionId, selectGen, 'replaying');
        const cacheReplayStartedAt = performance.now();
        this._resetTerminalForReplay();
        const { parsedAt: cacheParsedAt } = await this.chunkedTerminalWrite(
          cachedBuffer,
          TERMINAL_CHUNK_SIZE,
          bufferLoadOwner
        );
        cacheResetAndParseMs = cacheParsedAt - cacheReplayStartedAt;
        if (this._isStaleSelect(selectGen)) {
          this._clearTerminalLoadState(sessionId, selectGen);
          return;
        }
        this.terminal.scrollToBottom();
        _crashDiag.log('CACHE_DONE');
      } else if (sessionIsBusy || session?.mode === 'shell') {
        // Busy sessions have stale caches. Shell sessions deliberately skip even
        // an idle cache so a changed 1MB tail cannot cause two back-to-back parses.
        this._resetTerminalForReplay();
        clearedBeforeFresh = true;
        _crashDiag.log(session?.mode === 'shell' ? 'CACHE_SKIP_SHELL' : 'CACHE_SKIP_BUSY');
      }

      // Give TUI sessions a short chance to redraw after resize before the
      // fresh buffer fetch. Only needed when the resize actually changed
      // dimensions (a real SIGWINCH → Ink redraw); a same-size tab switch sent
      // no resize, so waiting would just add latency. Shell sessions never need
      // it, so terminal content can appear immediately when switching shells.
      if (session?.mode !== 'shell' && dimsChanged) {
        await new Promise((resolve) => setTimeout(resolve, TUI_REDRAW_SETTLE_MS));
        if (this._isStaleSelect(selectGen)) {
          this._clearTerminalLoadState(sessionId, selectGen);
          return;
        }
      }

      this._setTerminalLoadState(sessionId, selectGen, 'fetching');
      _crashDiag.log('FETCH_START');
      // TUI sessions still get one canonical full replay per page (COD-47/#205).
      // A shell can retain hundreds of thousands of plain scrollback lines, so
      // automatically replaying all of them makes tab selection scale with the
      // entire session. Load its bounded 1MB tail first; the existing truncation
      // banner action fetches ?full=1 when the user explicitly asks for it.
      const useFullHistory = session?.mode !== 'shell' && !this._fullHistoryLoaded.has(sessionId);
      if (useFullHistory) this._fullHistoryLoaded.add(sessionId);
      const fetchStartedAt = performance.now();
      const res = await fetch(
        useFullHistory
          ? `/api/sessions/${sessionId}/terminal?full=1`
          : `/api/sessions/${sessionId}/terminal?tail=${TERMINAL_TAIL_SIZE}`
      );
      const headersReceivedAt = performance.now();
      if (this._isStaleSelect(selectGen)) {
        this._clearTerminalLoadState(sessionId, selectGen);
        return;
      }
      const data = (await res.json())?.data ?? {};
      const bodyParsedAt = performance.now();
      _crashDiag.log(`FETCH_DONE: ${data.terminalBuffer ? (data.terminalBuffer.length/1024).toFixed(0) + 'KB' : 'empty'} truncated=${data.truncated}`);

      let freshResetAndParseMs = 0;
      if (data.terminalBuffer) {
        // Skip rewrite if fresh buffer matches cache — avoids visible clear+rewrite flash.
        // On slow connections (mobile 5G), the gap between clear() and chunkedWrite() is
        // very visible, causing the terminal to flash blank then repaint.
        // A snapshot restore or a busy-clear leaves the terminal showing
        // something other than the cache, so the fetched buffer must be
        // replayed even when it byte-matches the cache.
        const needsRewrite =
          restoredSnapshot || clearedBeforeFresh || data.terminalBuffer !== cachedBuffer;
        if (needsRewrite) {
          _crashDiag.log(`REWRITE: ${(data.terminalBuffer.length/1024).toFixed(0)}KB`);
          this._setTerminalLoadState(sessionId, selectGen, 'replaying');
          const replayStartedAt = performance.now();
          this._resetTerminalForReplay();
          // Truncation is reported OUT OF BAND (#258). This used to write a grey
          // "... earlier output truncated ..." line into the
          // terminal itself, which scrolls away with the output it describes,
          // cannot be actioned, and is indistinguishable from real CLI output.
          this._setHistoryTruncation(sessionId, data);
          // Use chunked write for large buffers to avoid UI jank
          const { parsedAt: freshParsedAt } = await this.chunkedTerminalWrite(
            data.terminalBuffer,
            TERMINAL_CHUNK_SIZE,
            bufferLoadOwner
          );
          freshResetAndParseMs = freshParsedAt - replayStartedAt;
          if (this._isStaleSelect(selectGen)) {
            this._clearTerminalLoadState(sessionId, selectGen);
            return;
          }
          // Ensure terminal is scrolled to bottom after buffer load
          this.terminal.scrollToBottom();
        }

        // Shell selection always uses a fresh bounded tail, so retaining its
        // payload only wastes memory and can evict useful TUI caches.
        if (session?.mode === 'shell') {
          this.terminalBufferCache.delete(sessionId);
        } else {
          // Update cache (cap at 20 entries)
          this.terminalBufferCache.set(sessionId, data.terminalBuffer);
          if (this.terminalBufferCache.size > 20) {
            // Evict oldest entry (first key in Map iteration order)
            const oldest = this.terminalBufferCache.keys().next().value;
            this.terminalBufferCache.delete(oldest);
          }
        }
      } else if (!cachedBuffer || clearedBeforeFresh) {
        // Nothing was painted. If this path was not already cleared above,
        // clear stale content now; either way queued live output must be flushed.
        if (!clearedBeforeFresh) this._resetTerminalForReplay();
        bufferWasEmpty = true;
      }

      const terminalLoadTiming = {
        trigger: 'session-select',
        mode: session?.mode || 'unknown',
        full: useFullHistory,
        source: data.source || 'unknown',
        chars: data.terminalBuffer?.length || 0,
        ttfbMs: headersReceivedAt - fetchStartedAt,
        bodyAndJsonMs: bodyParsedAt - headersReceivedAt,
        cacheResetAndParseMs,
        freshResetAndParseMs,
        selectToReplayCompleteMs: performance.now() - _selStart,
        serverTiming: res.headers?.get?.('server-timing') || '',
      };
      // Buffer load complete — unblock live SSE writes. chunkedTerminalWrite calls
      // _finishBufferLoad after ordering the fetched snapshot in xterm; if we skipped
      // the write (cache hit or empty), call it here.
      // COD-144: when the load painted nothing, FLUSH the queued events instead of
      // discarding — a new session's prompt arrives only as a queued SSE event.
      if (this._isLoadingBuffer) {
        this._finishBufferLoad(bufferLoadOwner, { flushQueued: bufferWasEmpty });
      }
      // Drop the guard so user input clears state normally
      this._restoringFlushedState = false;

      // Restore flushed offset and text for this session so the overlay positions
      // correctly even before the PTY echo arrives in the terminal buffer.
      if (this._flushedOffsets?.has(sessionId) && this._localEchoOverlay) {
        this._localEchoOverlay.setFlushed(
          this._flushedOffsets.get(sessionId),
          this._flushedTexts?.get(sessionId) || '',
          false  // render=false: buffer just loaded, defer to rerender
        );
        // Trigger render after xterm.js finishes processing the buffer data.
        // terminal.write('', callback) fires the callback after ALL previously
        // queued writes have been parsed — so findPrompt() can find ❯ in the buffer.
        const zl = this._localEchoOverlay;
        this.terminal.write('', () => {
          if (zl.hasPending) zl.rerender();
        });
      }

      // Fire-and-forget resize to nudge Ink via SIGWINCH on real size changes.
      // Previously we also sent Ctrl+L (\x0c) here to force a full Ink redraw,
      // but Claude Code 2.x treats Ctrl+L as a two-step "clear conversation"
      // command — if a page refresh or SSE reconnect ran selectSession twice
      // within Claude's confirmation window, the second \x0c silently wiped the
      // conversation. Stale Ink frames in the tailed buffer are a cosmetic
      // annoyance that disappear on the user's next keypress; data loss is not
      // acceptable. Do NOT re-introduce Ctrl+L here.
      this.sendResize(sessionId);

      // Defer secondary panel updates so they don't block the main thread
      // after terminal content is already visible.
      const idleCb = typeof requestIdleCallback === 'function' ? requestIdleCallback : (cb) => setTimeout(cb, 16);
      idleCb(() => {
        // Guard against stale generation — user may have switched tabs again
        if (selectGen !== this._selectGeneration) return;

        // Update respawn banner
        if (this.respawnStatus[sessionId]) {
          this.showRespawnBanner();
          this.updateRespawnBanner(this.respawnStatus[sessionId].state);
          document.getElementById('respawnCycleCount').textContent = this.respawnStatus[sessionId].cycleCount || 0;
          this.updateCountdownTimerDisplay();
          this.updateActionLogDisplay();
          if (Object.keys(this.respawnCountdownTimers[sessionId] || {}).length > 0) {
            this.startCountdownInterval();
          }
        } else {
          this.hideRespawnBanner();
          this.stopCountdownInterval();
        }

        // Update task panel if open
        const taskPanel = document.getElementById('taskPanel');
        if (taskPanel && taskPanel.classList.contains('open')) {
          this.renderTaskPanel();
        }

        // Update ralph state panel for this session
        const curSession = this.sessions.get(sessionId);
        if (curSession && (curSession.ralphLoop || curSession.ralphTodos)) {
          this.updateRalphState(sessionId, {
            loop: curSession.ralphLoop,
            todos: curSession.ralphTodos
          });
        }
        this.renderRalphStatePanel();

        // Update CLI info bar (mobile - shows Claude version/model)
        this.updateCliInfoDisplay();

        // Update project insights panel for this session
        this.renderProjectInsightsPanel();

        // Update subagent window visibility for active session
        this.updateSubagentWindowVisibility();

        // Load file browser if enabled
        const settings = this.loadAppSettingsFromStorage();
        if (settings.showFileBrowser) {
          const fileBrowserPanel = this.$('fileBrowserPanel');
          if (fileBrowserPanel) {
            fileBrowserPanel.classList.add('visible');
            this.loadFileBrowser(sessionId);
            // Attach drag listeners if not already attached
            if (!this.fileBrowserDragListeners) {
              const header = fileBrowserPanel.querySelector('.file-browser-header');
              if (header) {
                const onFirstDrag = () => {
                  if (!fileBrowserPanel.style.left) {
                    const rect = fileBrowserPanel.getBoundingClientRect();
                    fileBrowserPanel.style.left = `${rect.left}px`;
                    fileBrowserPanel.style.top = `${rect.top}px`;
                    fileBrowserPanel.style.right = 'auto';
                  }
                };
                header.addEventListener('mousedown', onFirstDrag);
                header.addEventListener('touchstart', onFirstDrag, { passive: true });
                this.fileBrowserDragListeners = this.makeWindowDraggable(fileBrowserPanel, header);
                this.fileBrowserDragListeners._onFirstDrag = onFirstDrag;
              }
            }
          }
        }
      });

      // Open WebSocket for low-latency terminal I/O (after buffer load completes)
      this._connectWs(sessionId);

      _crashDiag.log('FOCUS');
      if (shouldFocusTerminal && this.terminal) this.terminal.focus();
      this.scrollToLastNonEmptyLine();
      // If we switched INTO this tab while the soft keyboard is already up, no
      // viewport-resize transition fires (handleViewportResize only runs
      // onKeyboardShow on a hidden→visible change), so the newly-active
      // session never gets that heal: fit() + scrollToBottom() + local-echo
      // overlay rerender() + one-shot SIGWINCH. Without it the overlay renders
      // against stale, off-bottom state and typed input stays INVISIBLE until
      // the user manually toggles the keyboard. Replicate the heal here so
      // local echo paints on the first keystroke after a keyboard-up tab switch.
      if (typeof KeyboardHandler !== 'undefined' && KeyboardHandler.keyboardVisible) {
        KeyboardHandler.onKeyboardShow();
      }
      const selectDoneMs = performance.now() - _selStart;
      terminalLoadTiming.selectDoneMs = selectDoneMs;
      this._recordTerminalLoadTiming(terminalLoadTiming);
      this._clearTerminalLoadState(sessionId, selectGen);
      _crashDiag.log(`SELECT_DONE: ${selectDoneMs.toFixed(0)}ms`);
      console.log(`[CRASH-DIAG] selectSession DONE: ${sessionId.slice(0,8)} in ${selectDoneMs.toFixed(0)}ms`);
    } catch (err) {
      if (this._isLoadingBuffer) this._finishBufferLoad(bufferLoadOwner);
      this._restoringFlushedState = false;
      this._setTerminalLoadState(sessionId, selectGen, 'failed');
      console.error('Failed to load session terminal:', err);
    }
  }

  // Shared cleanup for all session data — called from both closeSession() and session:deleted handler
  _cleanupSessionData(sessionId) {
    this.closeTabRailActionMenu?.();
    // If the deleted session is currently being renamed, abort the rename
    // so the inline <input> doesn't ghost as a stale tab on screen.
    if (this._activeRename?.sessionId === sessionId) {
      this._activeRename.cancel();
    }
    this.sessions.delete(sessionId);
    // Remove from tab order
    const orderIndex = this.sessionOrder.indexOf(sessionId);
    if (orderIndex !== -1) {
      this.sessionOrder.splice(orderIndex, 1);
      this.saveSessionOrder();
    }
    this.terminalBuffers.delete(sessionId);
    this.terminalBufferCache.delete(sessionId);
    this._clearHistoryTruncation(sessionId);
    this._xtermSnapshots?.delete(sessionId);
    try { localStorage.removeItem(`codeman-xs-${sessionId}`); } catch {}

    this._flushedOffsets?.delete(sessionId);
    this._flushedTexts?.delete(sessionId);
    // Drop any durably-queued input for a session that's actually gone (deleted/
    // exited). Not a lost prompt — the target no longer exists. Only reached on
    // real session removal, never on a tab switch.
    this._pendingDeliveries?.delete(sessionId);
    this._seqCounters?.delete(sessionId);
    this._postDraining?.delete(sessionId);
    this._persistReliableState();
    this.ralphStates.delete(sessionId);
    this.ralphClosedSessions.delete(sessionId);
    this.projectInsights.delete(sessionId);
    this.pendingHooks.delete(sessionId);
    this.tabAlerts.delete(sessionId);
    this.attachmentHistoryCounts.delete(sessionId);
    if (this.attachmentHistoryDrawerOpen && this.activeSessionId === sessionId) {
      this.closeAttachmentHistory?.();
    }
    this.terminalLoadStates.delete(sessionId);
    this.clearCountdownTimers(sessionId);
    this.closeSessionLogViewerWindows(sessionId);
    this.closeSessionImagePopups(sessionId);
    this.closeSessionAttachmentCards(sessionId);
    this.closeSessionSubagentWindows(sessionId, true);

    // Clean up idle timer
    const idleTimer = this.idleTimers.get(sessionId);
    if (idleTimer) {
      clearTimeout(idleTimer);
      this.idleTimers.delete(sessionId);
    }
    // Clean up respawn state
    delete this.respawnStatus[sessionId];
    delete this.respawnTimers[sessionId];
    delete this.respawnCountdownTimers[sessionId];
    delete this.respawnActionLogs[sessionId];
  }

  async closeSession(sessionId, killMux = true) {
    // ⚠️ Captured BEFORE the await, and the delete is announced to
    // _onSessionDeleted through _closingSessions. The `session_deleted` SSE
    // broadcast for THIS delete routinely lands while the request is still in
    // flight, and that handler nulls activeSessionId and shows the welcome
    // screen. Re-reading the field after the await therefore made the fallback
    // below a coin flip: closing the tab you were on either moved you to the
    // next session or dumped you on the home screen, depending on which path
    // won the race (both outcomes measured on one build, 2026-08-17).
    const wasActive = this.activeSessionId === sessionId;
    this._closingSessions.add(sessionId);
    try {
      await this._apiDelete(`/api/sessions/${sessionId}?killMux=${killMux}`);
      this._cleanupSessionData(sessionId);

      if (wasActive) {
        this.activeSessionId = null;
        try { localStorage.removeItem('codeman-active-session'); } catch {}
        // Next tab in the user's own order, skipping ids the cleanup has not
        // caught up with yet: sessionOrder can transiently hold a dead id
        // (delete racing the order sync), which is the same reason Alt+N
        // indexes a live-filtered list rather than sessionOrder directly.
        const nextSessionId = this.sessionOrder.find((id) => id !== sessionId && this.sessions.has(id));
        if (nextSessionId) {
          // `auto`: this tab was chosen by the app because the previous one
          // went away, so it must not spend that session's idle alert.
          this.selectSession(nextSessionId, { auto: true });
        } else {
          this.terminal.clear();
          this.showWelcome();
          this.renderRalphStatePanel();  // Clear ralph panel when no sessions
        }
      }

      this.renderSessionTabs();

      if (killMux) {
        this.showToast('Session closed and tmux killed', 'success');
      } else {
        this.showToast('Tab hidden, tmux still running', 'info');
      }
    } catch (err) {
      this.showToast('Failed to close session', 'error');
    } finally {
      this._closingSessions.delete(sessionId);
    }
  }

  // Request confirmation before closing a session
  requestCloseSession(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    this.pendingCloseSessionId = sessionId;

    // Show session name in confirmation dialog
    const name = this.getSessionName(session);
    const sessionNameEl = document.getElementById('closeConfirmSessionName');
    sessionNameEl.textContent = name;

    // Update kill button text based on session mode
    const killTitle = document.getElementById('closeConfirmKillTitle');
    if (killTitle) {
      killTitle.textContent = session.mode === 'opencode'
        ? 'Kill Tmux & OpenCode'
        : session.mode === 'codex'
          ? 'Kill Tmux & Codex'
          : session.mode === 'gemini'
            ? 'Kill Tmux & Gemini'
            : session.mode === 'antigravity'
              ? 'Kill Tmux & Antigravity'
              : session.mode === 'pi'
                ? 'Kill Tmux & Pi'
                : session.mode === 'grok'
                  ? 'Kill Tmux & Grok'
                  : session.mode === 'deepseek'
                    ? 'Kill Tmux & DeepSeek'
                    : session.mode === 'omp'
                      ? 'Kill Tmux & OMP'
                      : 'Kill Tmux & Claude Code';
    }

    document.getElementById('closeConfirmModal').classList.add('active');
  }

  cancelCloseSession() {
    this.pendingCloseSessionId = null;
    document.getElementById('closeConfirmModal').classList.remove('active');
  }

  async confirmCloseSession(killMux = true) {
    const sessionId = this.pendingCloseSessionId;
    this.cancelCloseSession();

    if (sessionId) {
      await this.closeSession(sessionId, killMux);
    }
  }

  nextSession() {
    if (this.sessionOrder.length <= 1) return;

    const currentIndex = this.sessionOrder.indexOf(this.activeSessionId);
    const nextIndex = (currentIndex + 1) % this.sessionOrder.length;
    this.selectSession(this.sessionOrder[nextIndex]);
  }

  prevSession() {
    if (this.sessionOrder.length <= 1) return;

    const currentIndex = this.sessionOrder.indexOf(this.activeSessionId);
    const prevIndex = (currentIndex - 1 + this.sessionOrder.length) % this.sessionOrder.length;
    this.selectSession(this.sessionOrder[prevIndex]);
  }

  // ═══════════════════════════════════════════════════════════════
  // Navigation
  // ═══════════════════════════════════════════════════════════════

  goHome() {
    // Deselect active session and show welcome screen
    this.activeSessionId = null;
    try { localStorage.removeItem('codeman-active-session'); } catch {}
    this.terminal.clear();
    this.showWelcome();
    this.renderSessionTabs();
    this.renderRalphStatePanel();
  }

  // ═══════════════════════════════════════════════════════════════
  // Ralph Loop Wizard (methods in ralph-wizard.js)
  // ═══════════════════════════════════════════════════════════════

  // Wizard state (initialized here, methods loaded from ralph-wizard.js)
  ralphWizardStep = 1;
  ralphWizardConfig = {
    taskDescription: '',
    completionPhrase: 'COMPLETE',
    maxIterations: 10,
    caseName: 'testcase',
    enableRespawn: false,
    generatedPlan: null,
    planGenerated: false,
    skipPlanGeneration: false,
    planDetailLevel: 'detailed',
    existingPlan: null,
    useExistingPlan: false,
  };
  planLoadingTimer = null;
  planLoadingStartTime = null;

  // ═══════════════════════════════════════════════════════════════
  // Kill Sessions
  // ═══════════════════════════════════════════════════════════════

  async killActiveSession() {
    if (!this.activeSessionId) {
      this.showToast('No active session', 'warning');
      return;
    }
    await this.closeSession(this.activeSessionId);
  }

  async killAllSessions() {
    if (this.sessions.size === 0) return;

    if (!confirm(`Kill all ${this.sessions.size} session(s)?`)) return;

    try {
      await this._apiDelete('/api/sessions');
      this.sessions.clear();
      this.terminalBuffers.clear();
      this.terminalBufferCache.clear();
      this.terminalLoadStates.clear();
      this._xtermSnapshots?.clear();
      try {
        for (const k of Object.keys(localStorage)) {
          if (k.startsWith('codeman-xs-')) localStorage.removeItem(k);
        }
      } catch {}
      this.activeSessionId = null;
      try { localStorage.removeItem('codeman-active-session'); } catch {}
      this.respawnStatus = {};
      this.respawnCountdownTimers = {};
      this.respawnActionLogs = {};
      this.stopCountdownInterval();
      this.hideRespawnBanner();
      this.renderSessionTabs();
      this.terminal.clear();
      this.showWelcome();
      this.showToast('All sessions killed', 'success');
    } catch (err) {
      this.showToast('Failed to kill sessions', 'error');
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // Timer
  // ═══════════════════════════════════════════════════════════════

  showTimer() {
    document.getElementById('timerBanner').style.display = 'flex';
    this.updateTimer();
    this.timerInterval = setInterval(() => this.updateTimer(), 1000);
  }

  hideTimer() {
    document.getElementById('timerBanner').style.display = 'none';
    if (this.timerInterval) {
      clearInterval(this.timerInterval);
      this.timerInterval = null;
    }
  }

  updateTimer() {
    if (!this.currentRun || this.currentRun.status !== 'running') return;

    const now = Date.now();
    const remaining = Math.max(0, this.currentRun.endAt - now);
    const total = this.currentRun.endAt - this.currentRun.startedAt;
    const elapsed = now - this.currentRun.startedAt;
    const percent = Math.min(100, (elapsed / total) * 100);

    document.getElementById('timerValue').textContent = this.formatTime(remaining);
    document.getElementById('timerProgress').style.width = `${percent}%`;
    document.getElementById('timerMeta').textContent =
      `${this.currentRun.completedTasks} tasks | $${this.currentRun.totalCost.toFixed(2)}`;
  }

  async stopCurrentRun() {
    if (!this.currentRun) return;
    try {
      await fetch(`/api/scheduled/${this.currentRun.id}`, { method: 'DELETE' });
    } catch (err) {
      this.showToast('Failed to stop run', 'error');
    }
  }

  formatTime(ms) {
    const s = Math.floor(ms / 1000);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${sec.toString().padStart(2, '0')}`;
  }

  // ═══════════════════════════════════════════════════════════════
  // Tokens
  // ═══════════════════════════════════════════════════════════════

  updateCost() {
    // Now updates tokens instead of cost
    this.updateTokens();
  }

  updateTokens() {
    // Debounce at 200ms — token display is non-critical and shouldn't
    // compete with input handling on the main thread
    this._clearTimer('_updateTokensTimeout');
    this._updateTokensTimeout = setTimeout(() => {
      this._updateTokensTimeout = null;
      this._updateTokensImmediate();
    }, 200);
  }

  _updateTokensImmediate() {
    // Use global stats if available (includes deleted sessions)
    let totalInput = 0;
    let totalOutput = 0;
    if (this.globalStats) {
      totalInput = this.globalStats.totalInputTokens || 0;
      totalOutput = this.globalStats.totalOutputTokens || 0;
    } else {
      // Fallback to active sessions only
      this.sessions.forEach(s => {
        if (s.tokens) {
          totalInput += s.tokens.input || 0;
          totalOutput += s.tokens.output || 0;
        }
      });
    }
    const total = totalInput + totalOutput;
    this.totalTokens = total;
    const display = this.formatTokens(total);

    // Estimate cost from tokens (more accurate than stored cost in interactive mode)
    const estimatedCost = this.estimateCost(totalInput, totalOutput);
    const tokenEl = this.$('headerTokens');
    if (tokenEl) {
      const settings = this.loadAppSettingsFromStorage();
      const showCost = settings.showCost ?? false;
      tokenEl.textContent = total > 0
        ? (showCost ? `${display} tokens · $${estimatedCost.toFixed(2)}` : `${display} tokens`)
        : '0 tokens';
      tokenEl.title = this.globalStats
        ? `Lifetime: ${this.globalStats.totalSessionsCreated} sessions created${showCost ? '\nEstimated cost based on Claude Opus pricing' : ''}`
        : `Token usage across active sessions${showCost ? '\nEstimated cost based on Claude Opus pricing' : ''}`;
    }
  }

  // ─── Shortcut Registry ───────────────────────────────────────────────────────
  // Returns the merged shortcut list: DEFAULT_SHORTCUTS with any per-shortcut
  // overrides from settings.shortcutOverrides applied on top.

  getShortcutRegistry() {
    const settings = this.loadAppSettingsFromStorage();
    const shortcutOverrides = settings.shortcutOverrides || {};
    return DEFAULT_SHORTCUTS.map((shortcut) => {
      const override = shortcutOverrides[shortcut.id];
      if (!override) return shortcut;
      // Only binding-shaped fields may come from storage — id/label/group/action
      // stay trusted so persisted data can never redirect a shortcut's action or
      // spoof another row in the settings/overlay renderers.
      const merged = { ...shortcut };
      if (Array.isArray(override.bindings)) {
        merged.bindings = override.bindings;
        delete merged.displayBindings; // show the override, not the stale default label
      }
      if (typeof override.disabled === 'boolean') merged.disabled = override.disabled;
      return merged;
    });
  }

  matchesShortcutEvent(e, shortcut) {
    if (!shortcut || !Array.isArray(shortcut.bindings)) return false;
    return shortcut.bindings.some((binding) => {
      const mods = binding.modifiers || [];
      // Ctrl and Cmd are interchangeable as the primary modifier (parity with
      // the legacy shortcut table), but every OTHER pressed modifier must be
      // declared by the binding — a plain Ctrl+K binding must not also swallow
      // Ctrl+Shift+K (the Firefox devtools chord).
      const wantsPrimary = mods.includes('ctrl') || mods.includes('meta');
      if (wantsPrimary !== !!(e.ctrlKey || e.metaKey)) return false;
      if (mods.includes('shift') !== !!e.shiftKey) return false;
      if (mods.includes('alt') !== !!e.altKey) return false;
      // Match the physical key when the binding pins one (layout-independent),
      // or the produced character otherwise (layout-dependent keys like '+').
      if (binding.code && e.code === binding.code) return true;
      if (binding.key && typeof e.key === 'string' && e.key.toLowerCase() === binding.key.toLowerCase()) return true;
      return false;
    });
  }

  // ─── Shortcut Overlay Modal ───────────────────────────────────────────────────
  // Ctrl/Alt+? opens a floating overlay listing all keyboard shortcuts, grouped
  // by category. Uses the merged registry so user overrides are reflected.

  showShortcutOverlay() {
    const modal = document.getElementById('shortcutOverlayModal');
    if (!modal) return;
    this.renderShortcutOverlay();
    modal.classList.add('active');
    modal.focus?.();
  }

  renderShortcutOverlay() {
    const list = document.getElementById('shortcutOverlayList');
    if (!list) return;
    const registry = this.getShortcutRegistry();
    const groups = {};
    for (const shortcut of registry) {
      const g = shortcut.group || 'General';
      if (!groups[g]) groups[g] = [];
      groups[g].push(shortcut);
    }
    const fmtBindings = (s) => {
      if (s.displayBindings) return s.displayBindings.map((b) => `<kbd>${escapeHtml(b)}</kbd>`).join(' / ');
      if (!s.bindings) return '';
      return s.bindings.map((b) => {
        const parts = [...(b.modifiers || []).map((m) => m.charAt(0).toUpperCase() + m.slice(1)), b.key || b.code || ''];
        return `<kbd>${escapeHtml(parts.join('+'))}</kbd>`;
      }).join(' / ');
    };
    list.innerHTML = Object.entries(groups).map(([group, items]) =>
      `<div class="shortcut-overlay-group"><div class="shortcut-overlay-group-label">${escapeHtml(group)}</div>` +
      items.map((s) => `<div class="shortcut-overlay-row"><span class="shortcut-overlay-label">${escapeHtml(s.label)}</span><span class="shortcut-overlay-keys">${fmtBindings(s)}</span></div>`).join('') +
      `</div>`
    ).join('');
  }

  closeShortcutOverlay() {
    const modal = document.getElementById('shortcutOverlayModal');
    if (modal) modal.classList.remove('active');
  }

}

// ═══════════════════════════════════════════════════════════════
// Module Init — localStorage migration and app start
// ═══════════════════════════════════════════════════════════════

// Migrate legacy localStorage keys (claudeman-* → codeman-*)
try {
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key && (key.startsWith('claudeman-') || key.startsWith('claudeman_'))) {
      const newKey = key.replace(/^claudeman[-_]/, (m) => 'codeman' + m.charAt(m.length - 1));
      if (localStorage.getItem(newKey) === null) {
        localStorage.setItem(newKey, localStorage.getItem(key));
      }
    }
  }
} catch {}

// Initialize — use DOMContentLoaded to ensure all defer'd mixin modules
// (terminal-ui.js, settings-ui.js, etc.) have executed their Object.assign
// onto CodemanApp.prototype before we instantiate.
let app;
document.addEventListener('DOMContentLoaded', () => {
  app = new CodemanApp();
  window.app = app;
});
window.MobileDetection = MobileDetection;
