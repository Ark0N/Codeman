// Claudeman App - Tab-based Terminal UI

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
    id: 'quick-iteration',
    name: 'Quick Iteration',
    description: 'Fast cycles for active development',
    config: {
      idleTimeoutMs: 3000,
      updatePrompt: 'continue',
      interStepDelayMs: 2000,
      sendClear: false,
      sendInit: false,
    },
    durationMinutes: 60,
    builtIn: true,
    createdAt: 0,
  },
  {
    id: 'autonomous-long',
    name: 'Autonomous (Long)',
    description: 'Full refresh cycles for overnight work',
    config: {
      idleTimeoutMs: 5000,
      updatePrompt: 'continue working on the task',
      interStepDelayMs: 3000,
      sendClear: true,
      sendInit: true,
      kickstartPrompt: 'pick up where you left off',
    },
    durationMinutes: 480,
    builtIn: true,
    createdAt: 0,
  },
  {
    id: 'careful-review',
    name: 'Careful Review',
    description: 'Longer pauses for human review between cycles',
    config: {
      idleTimeoutMs: 30000,
      updatePrompt: 'continue if there is more work to do',
      interStepDelayMs: 5000,
      sendClear: false,
      sendInit: false,
    },
    durationMinutes: 120,
    builtIn: true,
    createdAt: 0,
  },
];

// ============================================================================
// Mobile Detection
// ============================================================================

/**
 * MobileDetection - Detects device type and touch capability.
 * Updates body classes for CSS targeting.
 */
const MobileDetection = {
  /** Check if device supports touch input */
  isTouchDevice() {
    return 'ontouchstart' in window ||
      navigator.maxTouchPoints > 0 ||
      (window.matchMedia && window.matchMedia('(pointer: coarse)').matches);
  },

  /** Check if device is iOS (iPhone, iPad, iPod) */
  isIOS() {
    return /iPad|iPhone|iPod/.test(navigator.userAgent) ||
      (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  },

  /** Check if browser is Safari */
  isSafari() {
    return /^((?!chrome|android).)*safari/i.test(navigator.userAgent);
  },

  /** Check if screen is small (phone-sized, <430px) */
  isSmallScreen() {
    return window.innerWidth < 430;
  },

  /** Check if screen is medium (tablet-sized, 430-768px) */
  isMediumScreen() {
    return window.innerWidth >= 430 && window.innerWidth < 768;
  },

  /** Get device type based on screen width */
  getDeviceType() {
    const width = window.innerWidth;
    if (width < 430) return 'mobile';
    if (width < 768) return 'tablet';
    return 'desktop';
  },

  /** Update body classes based on device detection */
  updateBodyClass() {
    const body = document.body;
    const deviceType = this.getDeviceType();
    const isTouch = this.isTouchDevice();

    // Remove existing device classes
    body.classList.remove('device-mobile', 'device-tablet', 'device-desktop', 'touch-device', 'ios-device', 'safari-browser');

    // Add current device class
    body.classList.add(`device-${deviceType}`);

    // Add touch device class if applicable
    if (isTouch) {
      body.classList.add('touch-device');
    }

    // Add iOS-specific class for safe area handling
    if (this.isIOS()) {
      body.classList.add('ios-device');
    }

    // Add Safari class for browser-specific fixes
    if (this.isSafari()) {
      body.classList.add('safari-browser');
    }
  },

  /** Initialize mobile detection and set up resize listener */
  init() {
    this.updateBodyClass();
    // Debounced resize handler
    let resizeTimeout;
    window.addEventListener('resize', () => {
      clearTimeout(resizeTimeout);
      resizeTimeout = setTimeout(() => this.updateBodyClass(), 100);
    });
  }
};

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

// ============================================================================
// Mobile Keyboard Handler
// ============================================================================

/**
 * KeyboardHandler - Simple handler to scroll inputs into view when keyboard appears.
 * Uses focusin event and scrollIntoView - keeps it simple and reliable.
 * Also handles terminal scrolling and toolbar repositioning via visualViewport API.
 */
const KeyboardHandler = {
  lastViewportHeight: 0,
  keyboardVisible: false,
  initialViewportHeight: 0,

  /** Initialize keyboard handling */
  init() {
    // Only initialize on touch devices
    if (!MobileDetection.isTouchDevice()) return;

    this.initialViewportHeight = window.visualViewport?.height || window.innerHeight;
    this.lastViewportHeight = this.initialViewportHeight;

    // Simple focus handler - scroll input into view after keyboard appears
    document.addEventListener('focusin', (e) => {
      const target = e.target;
      if (!this.isInputElement(target)) return;

      // Wait for keyboard animation, then scroll input into view
      setTimeout(() => {
        this.scrollInputIntoView(target);
      }, 400);
    });

    // Use visualViewport to detect keyboard and reposition toolbar
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', () => {
        this.handleViewportResize();
      });
      // Also handle scroll (iOS scrolls viewport when keyboard appears)
      window.visualViewport.addEventListener('scroll', () => {
        this.updateLayoutForKeyboard();
      });
    }
  },

  /** Handle viewport resize (keyboard show/hide) */
  handleViewportResize() {
    const currentHeight = window.visualViewport?.height || window.innerHeight;
    const heightDiff = this.initialViewportHeight - currentHeight;

    // Keyboard appeared (viewport shrunk by more than 150px)
    if (heightDiff > 150 && !this.keyboardVisible) {
      this.keyboardVisible = true;
      document.body.classList.add('keyboard-visible');
      this.onKeyboardShow();
    }
    // Keyboard hidden (viewport grew back close to initial)
    // Use 100px threshold (not 50) to handle iOS address bar drift,
    // iOS 26's persistent 24px discrepancy, and Safari bottom bar changes
    else if (heightDiff < 100 && this.keyboardVisible) {
      this.keyboardVisible = false;
      document.body.classList.remove('keyboard-visible');
      this.onKeyboardHide();
    }

    // Update baseline when keyboard is not visible — adapts to address bar
    // state changes, orientation changes, and other viewport shifts
    if (!this.keyboardVisible) {
      this.initialViewportHeight = currentHeight;
    }

    this.updateLayoutForKeyboard();
    this.lastViewportHeight = currentHeight;
  },

  /** Update layout when keyboard shows/hides */
  updateLayoutForKeyboard() {
    if (!window.visualViewport) return;

    // Only adjust on mobile
    if (!MobileDetection.isSmallScreen() && !MobileDetection.isMediumScreen()) {
      this.resetLayout();
      return;
    }

    const toolbar = document.querySelector('.toolbar');
    const accessoryBar = document.querySelector('.keyboard-accessory-bar');
    const main = document.querySelector('.main');

    if (this.keyboardVisible) {
      // Calculate keyboard offset
      const layoutHeight = window.innerHeight;
      const visualBottom = window.visualViewport.offsetTop + window.visualViewport.height;
      const keyboardOffset = layoutHeight - visualBottom;

      // Safety: if keyboard is supposedly visible but offset is 0 or negative,
      // the keyboard is actually gone — force dismiss. This catches cases where
      // visualViewport.resize fires late or with intermediate values on iOS.
      if (keyboardOffset <= 0) {
        this.keyboardVisible = false;
        document.body.classList.remove('keyboard-visible');
        this.onKeyboardHide();
        return;
      }

      // Move toolbar up above keyboard
      if (toolbar) {
        toolbar.style.transform = `translateY(${-keyboardOffset}px)`;
      }

      // Move accessory bar up (it sits above toolbar)
      if (accessoryBar) {
        accessoryBar.style.transform = `translateY(${-keyboardOffset}px)`;
      }

      // Shrink main content area so terminal doesn't extend behind keyboard
      // Account for keyboard height + toolbar height (40px) + accessory bar (44px)
      if (main) {
        main.style.paddingBottom = `${keyboardOffset + 94}px`;
      }
    } else {
      this.resetLayout();
    }
  },

  /** Reset layout to normal (no keyboard) */
  resetLayout() {
    const toolbar = document.querySelector('.toolbar');
    const accessoryBar = document.querySelector('.keyboard-accessory-bar');
    const main = document.querySelector('.main');

    if (toolbar) {
      toolbar.style.transform = '';
    }
    if (accessoryBar) {
      accessoryBar.style.transform = '';
    }
    if (main) {
      main.style.paddingBottom = '';
    }
  },

  /** Called when keyboard appears */
  onKeyboardShow() {
    // Show keyboard accessory bar
    if (typeof KeyboardAccessoryBar !== 'undefined') {
      KeyboardAccessoryBar.show();
    }

    // Refit terminal locally AND send resize to server so Claude Code (Ink)
    // knows the actual terminal dimensions. Without this, Ink redraws at the
    // old (larger) row count when the user types, causing content to scroll
    // off the visible area with each keystroke.
    // Note: the throttledResize handler still suppresses ongoing resize events
    // while keyboard is up — this one-shot resize on open/close is sufficient.
    setTimeout(() => {
      if (typeof app !== 'undefined' && app.terminal) {
        if (app.fitAddon) try { app.fitAddon.fit(); } catch {}
        app.terminal.scrollToBottom();
        // Send resize to server so PTY dimensions match xterm
        this._sendTerminalResize();
      }
    }, 150);
  },

  /** Called when keyboard hides */
  onKeyboardHide() {
    // Hide keyboard accessory bar
    if (typeof KeyboardAccessoryBar !== 'undefined') {
      KeyboardAccessoryBar.hide();
    }

    this.resetLayout();

    // Refit terminal, scroll to bottom, and send resize to restore original dimensions
    setTimeout(() => {
      if (typeof app !== 'undefined' && app.fitAddon) {
        try { app.fitAddon.fit(); } catch {}
        if (app.terminal) app.terminal.scrollToBottom();
        // Send resize to server to restore full terminal size
        this._sendTerminalResize();
      }
    }, 100);
  },

  /** Send current terminal dimensions to the server (one-shot, for keyboard open/close) */
  _sendTerminalResize() {
    if (typeof app === 'undefined' || !app.activeSessionId || !app.fitAddon) return;
    try {
      const dims = app.fitAddon.proposeDimensions();
      if (dims) {
        const cols = Math.max(dims.cols, 40);
        const rows = Math.max(dims.rows, 10);
        app._lastResizeDims = { cols, rows };
        fetch(`/api/sessions/${app.activeSessionId}/resize`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ cols, rows })
        });
      }
    } catch {}
  },

  /** Check if element is an input that triggers keyboard (excludes terminal) */
  isInputElement(el) {
    if (!el) return false;

    // Exclude xterm.js terminal inputs (they handle their own scroll)
    if (el.closest('.xterm') || el.closest('.terminal-container')) {
      return false;
    }

    const tagName = el.tagName?.toLowerCase();
    // Exclude type=range, type=checkbox, type=radio (don't trigger keyboard)
    if (tagName === 'input') {
      const type = el.type?.toLowerCase();
      if (type === 'checkbox' || type === 'radio' || type === 'range' || type === 'file') {
        return false;
      }
    }
    return (
      tagName === 'input' ||
      tagName === 'textarea' ||
      el.isContentEditable
    );
  },

  /** Scroll input into view above the keyboard */
  scrollInputIntoView(input) {
    // Check if input is still focused (user might have tapped away)
    if (document.activeElement !== input) return;

    // Find if we're in a modal
    const modal = input.closest('.modal.active');
    const modalBody = modal?.querySelector('.modal-body');

    if (modalBody) {
      // For modals - scroll within the modal body
      const inputRect = input.getBoundingClientRect();
      const modalRect = modalBody.getBoundingClientRect();

      // If input is below middle of modal, scroll it up
      if (inputRect.top > modalRect.top + modalRect.height * 0.4) {
        const scrollAmount = inputRect.top - modalRect.top - 100;
        modalBody.scrollBy({ top: scrollAmount, behavior: 'smooth' });
      }
    } else {
      // For page-level - use scrollIntoView
      input.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  }
};

// ============================================================================
// Mobile Swipe Handler
// ============================================================================

/**
 * SwipeHandler - Detects horizontal swipes on terminal to switch sessions.
 * Only active on mobile/touch devices.
 */
const SwipeHandler = {
  startX: 0,
  startY: 0,
  startTime: 0,
  minSwipeDistance: 80,  // Minimum pixels for a valid swipe
  maxSwipeTime: 300,     // Maximum ms for a swipe gesture
  maxVerticalDrift: 100, // Max vertical movement allowed

  /** Initialize swipe handling */
  init() {
    // Only on touch devices
    if (!MobileDetection.isTouchDevice()) return;

    const terminal = document.querySelector('.main');
    if (!terminal) return;

    terminal.addEventListener('touchstart', (e) => this.onTouchStart(e), { passive: true });
    terminal.addEventListener('touchend', (e) => this.onTouchEnd(e), { passive: true });
  },

  onTouchStart(e) {
    if (!e.touches || e.touches.length !== 1) return;
    this.startX = e.touches[0].clientX;
    this.startY = e.touches[0].clientY;
    this.startTime = Date.now();
  },

  onTouchEnd(e) {
    if (!e.changedTouches || e.changedTouches.length !== 1) return;

    const endX = e.changedTouches[0].clientX;
    const endY = e.changedTouches[0].clientY;
    const elapsed = Date.now() - this.startTime;

    // Check if it's a valid swipe
    const deltaX = endX - this.startX;
    const deltaY = Math.abs(endY - this.startY);

    if (elapsed > this.maxSwipeTime) return;  // Too slow
    if (deltaY > this.maxVerticalDrift) return;  // Too much vertical movement
    if (Math.abs(deltaX) < this.minSwipeDistance) return;  // Too short

    // Valid swipe detected
    if (deltaX > 0) {
      // Swipe right -> previous session
      if (typeof app !== 'undefined') app.prevSession();
    } else {
      // Swipe left -> next session
      if (typeof app !== 'undefined') app.nextSession();
    }
  }
};

// ============================================================================
// Mobile Keyboard Accessory Bar
// ============================================================================

/**
 * KeyboardAccessoryBar - Quick action buttons shown above keyboard when typing.
 */
const KeyboardAccessoryBar = {
  element: null,

  /** Create and inject the accessory bar */
  init() {
    // Only on mobile
    if (!MobileDetection.isTouchDevice()) return;

    // Create accessory bar element
    this.element = document.createElement('div');
    this.element.className = 'keyboard-accessory-bar';
    this.element.innerHTML = `
      <button class="accessory-btn accessory-btn-arrow" data-action="scroll-up" title="Arrow up">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
          <path d="M5 15l7-7 7 7"/>
        </svg>
      </button>
      <button class="accessory-btn accessory-btn-arrow" data-action="scroll-down" title="Arrow down">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
          <path d="M19 9l-7 7-7-7"/>
        </svg>
      </button>
      <button class="accessory-btn" data-action="init" title="/init">/init</button>
      <button class="accessory-btn" data-action="clear" title="/clear">/clear</button>
      <button class="accessory-btn" data-action="compact" title="/compact">/compact</button>
      <button class="accessory-btn" data-action="paste" title="Paste from clipboard">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/>
          <rect x="8" y="2" width="8" height="4" rx="1" ry="1"/>
        </svg>
      </button>
      <button class="accessory-btn accessory-btn-dismiss" data-action="dismiss" title="Dismiss keyboard">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3">
          <path d="M19 9l-7 7-7-7"/>
        </svg>
      </button>
    `;

    // Add click handlers — preventDefault stops event from reaching terminal
    this.element.addEventListener('click', (e) => {
      const btn = e.target.closest('.accessory-btn');
      if (!btn) return;
      e.preventDefault();
      e.stopPropagation();

      const action = btn.dataset.action;
      this.handleAction(action, btn);

      // Refocus terminal so keyboard stays open (tap blurs terminal → keyboard dismisses → toolbar shifts)
      if ((action === 'scroll-up' || action === 'scroll-down') ||
          ((action === 'clear' || action === 'compact') && this._confirmAction)) {
        if (typeof app !== 'undefined' && app.terminal) {
          app.terminal.focus();
        }
      }
    });

    // Insert before toolbar
    const toolbar = document.querySelector('.toolbar');
    if (toolbar && toolbar.parentNode) {
      toolbar.parentNode.insertBefore(this.element, toolbar);
    }
  },

  _confirmTimer: null,
  _confirmAction: null,

  /** Handle accessory button actions */
  handleAction(action, btn) {
    if (typeof app === 'undefined' || !app.activeSessionId) return;

    switch (action) {
      case 'scroll-up':
        this.sendKey('\x1b[A');
        break;
      case 'scroll-down':
        this.sendKey('\x1b[B');
        break;
      case 'init':
        this.sendCommand('/init');
        break;
      case 'clear':
      case 'compact': {
        // Require double-tap: first tap turns amber, second tap within 2s sends
        const cmd = action === 'clear' ? '/clear' : '/compact';
        if (this._confirmAction === action && this._confirmTimer) {
          this.clearConfirm();
          this.sendCommand(cmd);
        } else {
          this.setConfirm(action, btn);
        }
        break;
      }
      case 'paste':
        this.pasteFromClipboard();
        break;
      case 'dismiss':
        // Blur active element to dismiss keyboard
        document.activeElement?.blur();
        break;
    }
  },

  /** Enter confirm state: button turns amber for 2s waiting for second tap */
  setConfirm(action, btn) {
    this.clearConfirm();
    this._confirmAction = action;
    if (btn) {
      btn.classList.add('confirming');
      btn.dataset.origText = btn.textContent;
      btn.textContent = 'Tap again';
    }
    this._confirmTimer = setTimeout(() => this.clearConfirm(), 2000);
  },

  /** Reset confirm state */
  clearConfirm() {
    if (this._confirmTimer) {
      clearTimeout(this._confirmTimer);
      this._confirmTimer = null;
    }
    if (this._confirmAction && this.element) {
      const btn = this.element.querySelector(`[data-action="${this._confirmAction}"]`);
      if (btn && btn.dataset.origText) {
        btn.textContent = btn.dataset.origText;
        delete btn.dataset.origText;
      }
      if (btn) btn.classList.remove('confirming');
    }
    this._confirmAction = null;
  },

  /** Send a slash command to the active session.
   *  Sends text and Enter separately so Ink processes them as distinct events. */
  sendCommand(command) {
    if (!app.activeSessionId) return;
    // Send command text first (without Enter)
    app.sendInput(command);
    // Send Enter separately after a brief delay so Ink has time to process the text.
    setTimeout(() => app.sendInput('\r'), 120);
  },

  /** Send a special key (arrow, escape, etc.) directly to the PTY.
   *  Bypasses tmux send-keys -l (literal mode) since escape sequences
   *  must be written raw to be interpreted as key presses by Ink. */
  sendKey(escapeSequence) {
    if (!app.activeSessionId) return;
    fetch(`/api/sessions/${app.activeSessionId}/input`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: escapeSequence })
    });
  },

  /** Read clipboard and send contents as input */
  /** Show a paste overlay with a textarea for iOS compatibility */
  pasteFromClipboard() {
    if (typeof app === 'undefined' || !app.activeSessionId) return;

    // Create overlay
    const overlay = document.createElement('div');
    overlay.className = 'paste-overlay';
    overlay.innerHTML = `
      <div class="paste-dialog">
        <textarea class="paste-textarea" placeholder="Long-press here and tap Paste"></textarea>
        <div class="paste-actions">
          <button class="paste-cancel">Cancel</button>
          <button class="paste-send">Send</button>
        </div>
      </div>
    `;

    const textarea = overlay.querySelector('.paste-textarea');
    const send = () => {
      const text = textarea.value;
      overlay.remove();
      if (text) app.sendInput(text);
    };
    overlay.querySelector('.paste-cancel').addEventListener('click', () => overlay.remove());
    overlay.querySelector('.paste-send').addEventListener('click', send);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });

    document.body.appendChild(overlay);
    textarea.focus();
  },

  /** Show the accessory bar */
  show() {
    if (this.element) {
      this.element.classList.add('visible');
    }
  },

  /** Hide the accessory bar */
  hide() {
    if (this.element) {
      this.element.classList.remove('visible');
    }
  }
};

// ============================================================================
// Accessibility: Focus Trap for Modals
// ============================================================================

/**
 * FocusTrap - Traps keyboard focus within an element (typically a modal).
 * Saves the previously focused element and restores focus when deactivated.
 */
class FocusTrap {
  constructor(element) {
    this.element = element;
    this.previouslyFocused = null;
    this.boundHandleKeydown = this.handleKeydown.bind(this);
  }

  activate() {
    this.previouslyFocused = document.activeElement;
    this.element.addEventListener('keydown', this.boundHandleKeydown);

    // Focus first focusable element after a brief delay (for CSS transitions)
    requestAnimationFrame(() => {
      const focusable = this.getFocusableElements();
      if (focusable.length) {
        focusable[0].focus();
      }
    });
  }

  deactivate() {
    this.element.removeEventListener('keydown', this.boundHandleKeydown);
    if (this.previouslyFocused && typeof this.previouslyFocused.focus === 'function') {
      this.previouslyFocused.focus();
    }
  }

  getFocusableElements() {
    const selector = [
      'button:not([disabled]):not([tabindex="-1"])',
      'input:not([disabled]):not([tabindex="-1"])',
      'select:not([disabled]):not([tabindex="-1"])',
      'textarea:not([disabled]):not([tabindex="-1"])',
      'a[href]:not([tabindex="-1"])',
      '[tabindex]:not([tabindex="-1"]):not([disabled])'
    ].join(', ');

    return [...this.element.querySelectorAll(selector)].filter(
      el => el.offsetParent !== null // Exclude hidden elements
    );
  }

  handleKeydown(e) {
    if (e.key !== 'Tab') return;

    const focusable = this.getFocusableElements();
    if (focusable.length === 0) return;

    const first = focusable[0];
    const last = focusable[focusable.length - 1];

    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }
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

// Notification Manager - Multi-layer browser notification system
class NotificationManager {
  constructor(app) {
    this.app = app;
    this.notifications = [];
    this.unreadCount = 0;
    this.isTabVisible = !document.hidden;
    this.isDrawerOpen = false;
    this.originalTitle = document.title;
    this.titleFlashInterval = null;
    this.titleFlashState = false;
    this.lastBrowserNotifTime = 0;
    this.audioCtx = null;
    this.renderScheduled = false;

    // Debounce grouping: Map<key, {notification, timeout}>
    this.groupingMap = new Map();

    // Load preferences
    this.preferences = this.loadPreferences();

    // Visibility tracking
    document.addEventListener('visibilitychange', () => {
      this.isTabVisible = !document.hidden;
      if (this.isTabVisible) {
        this.onTabVisible();
      }
    });
    // iOS Safari: pageshow fires on back-forward cache restore (bfcache)
    window.addEventListener('pageshow', (e) => {
      if (e.persisted) {
        this.isTabVisible = true;
        this.onTabVisible();
      }
    });
  }

  loadPreferences() {
    const defaultEventTypes = {
      permission_prompt: { enabled: true, browser: true, audio: true },
      elicitation_dialog: { enabled: true, browser: true, audio: true },
      idle_prompt: { enabled: true, browser: true, audio: false },
      stop: { enabled: true, browser: false, audio: false },
      session_error: { enabled: true, browser: true, audio: false },
      respawn_cycle: { enabled: true, browser: false, audio: false },
      token_milestone: { enabled: true, browser: false, audio: false },
      ralph_complete: { enabled: true, browser: true, audio: true },
      subagent_spawn: { enabled: false, browser: false, audio: false },
      subagent_complete: { enabled: false, browser: false, audio: false },
    };

    // Device-specific defaults: mobile has notifications disabled by default
    const isMobile = MobileDetection.getDeviceType() === 'mobile';
    const defaults = {
      enabled: !isMobile, // Disabled on mobile by default
      browserNotifications: !isMobile,
      audioAlerts: false,
      stuckThresholdMs: STUCK_THRESHOLD_DEFAULT_MS,
      // Legacy urgency muting (keep for backwards compat)
      muteCritical: false,
      muteWarning: false,
      muteInfo: false,
      // Per-event-type preferences
      eventTypes: defaultEventTypes,
      _version: 3,
    };
    try {
      const storageKey = this.getStorageKey();
      const saved = localStorage.getItem(storageKey);
      if (saved) {
        const prefs = JSON.parse(saved);
        // Migrate: v1 had browserNotifications defaulting to false
        if (!prefs._version || prefs._version < 2) {
          prefs.browserNotifications = true;
          prefs._version = 2;
        }
        // Migrate: v2 -> v3 adds eventTypes
        if (prefs._version < 3) {
          prefs.eventTypes = defaultEventTypes;
          prefs._version = 3;
          localStorage.setItem(storageKey, JSON.stringify(prefs));
        }
        // Merge with defaults to ensure all eventTypes exist
        return {
          ...defaults,
          ...prefs,
          eventTypes: { ...defaultEventTypes, ...prefs.eventTypes },
        };
      }
    } catch (_e) { /* ignore */ }
    return defaults;
  }

  // Get storage key for notification prefs (device-specific)
  getStorageKey() {
    const isMobile = MobileDetection.getDeviceType() === 'mobile';
    return isMobile ? 'claudeman-notification-prefs-mobile' : 'claudeman-notification-prefs';
  }

  savePreferences() {
    localStorage.setItem(this.getStorageKey(), JSON.stringify(this.preferences));
  }

  notify({ urgency, category, sessionId, sessionName, title, message }) {
    if (!this.preferences.enabled) return;

    // Check per-event-type preferences first
    const eventPref = this.preferences.eventTypes?.[category];
    let shouldBrowserNotify = false;
    let shouldAudioAlert = false;

    if (eventPref) {
      // Event type found - use its specific preferences
      if (!eventPref.enabled) return;
      shouldBrowserNotify = eventPref.browser && this.preferences.browserNotifications;
      shouldAudioAlert = eventPref.audio && this.preferences.audioAlerts;
    } else {
      // Fall back to urgency-based muting for unknown categories
      if (urgency === 'critical' && this.preferences.muteCritical) return;
      if (urgency === 'warning' && this.preferences.muteWarning) return;
      if (urgency === 'info' && this.preferences.muteInfo) return;
      // Default browser/audio behavior based on urgency
      shouldBrowserNotify = this.preferences.browserNotifications &&
        (urgency === 'critical' || urgency === 'warning' || !this.isTabVisible);
      shouldAudioAlert = urgency === 'critical' && this.preferences.audioAlerts;
    }

    // Grouping: same category+session within 5s updates count instead of new entry
    const groupKey = `${category}:${sessionId || 'global'}`;
    const existing = this.groupingMap.get(groupKey);
    if (existing) {
      existing.notification.count = (existing.notification.count || 1) + 1;
      existing.notification.message = message;
      existing.notification.timestamp = Date.now();
      clearTimeout(existing.timeout);
      existing.timeout = setTimeout(() => this.groupingMap.delete(groupKey), GROUPING_TIMEOUT_MS);
      this.scheduleRender();
      return;
    }

    const notification = {
      id: Date.now() + '-' + Math.random().toString(36).slice(2, 7),
      urgency,
      category,
      sessionId,
      sessionName,
      title,
      message,
      timestamp: Date.now(),
      read: false,
      count: 1,
    };

    // Add to log (cap at 100)
    this.notifications.unshift(notification);
    if (this.notifications.length > 100) this.notifications.pop();

    // Track for grouping
    const timeout = setTimeout(() => this.groupingMap.delete(groupKey), GROUPING_TIMEOUT_MS);
    this.groupingMap.set(groupKey, { notification, timeout });

    // Update unread
    this.unreadCount++;
    this.updateBadge();
    this.scheduleRender();

    // Layer 2: Tab title (when tab unfocused)
    if (!this.isTabVisible) {
      this.updateTabTitle();
    }

    // Layer 3: Browser notification
    if (shouldBrowserNotify) {
      this.sendBrowserNotif(title, message, category, sessionId);
    }

    // Layer 4: Audio alert
    if (shouldAudioAlert) {
      this.playAudioAlert();
    }
  }

  // Layer 1: Drawer rendering
  scheduleRender() {
    if (this.renderScheduled) return;
    this.renderScheduled = true;
    requestAnimationFrame(() => {
      this.renderScheduled = false;
      this.renderDrawer();
    });
  }

  renderDrawer() {
    const list = document.getElementById('notifList');
    const empty = document.getElementById('notifEmpty');
    if (!list || !empty) return;

    if (this.notifications.length === 0) {
      list.style.display = 'none';
      empty.style.display = 'flex';
      return;
    }

    list.style.display = 'block';
    empty.style.display = 'none';

    list.innerHTML = this.notifications.map(n => {
      const urgencyClass = `notif-item-${n.urgency}`;
      const readClass = n.read ? '' : ' unread';
      const countLabel = n.count > 1 ? `<span class="notif-item-count">&times;${n.count}</span>` : '';
      const sessionChip = n.sessionName ? `<span class="notif-item-session">${this.escapeHtml(n.sessionName)}</span>` : '';
      return `<div class="notif-item ${urgencyClass}${readClass}" data-notif-id="${n.id}" data-session-id="${n.sessionId || ''}" onclick="app.notificationManager.clickNotification('${n.id}')">
        <div class="notif-item-header">
          <span class="notif-item-title">${this.escapeHtml(n.title)}${countLabel}</span>
          <span class="notif-item-time">${this.relativeTime(n.timestamp)}</span>
        </div>
        <div class="notif-item-message">${this.escapeHtml(n.message)}</div>
        ${sessionChip}
      </div>`;
    }).join('');
  }

  // Layer 2: Tab title with unread count
  updateTabTitle() {
    if (this.unreadCount > 0 && !this.isTabVisible) {
      if (!this.titleFlashInterval) {
        this.titleFlashInterval = setInterval(() => {
          this.titleFlashState = !this.titleFlashState;
          document.title = this.titleFlashState
            ? `\u26A0\uFE0F (${this.unreadCount}) Claudeman`
            : this.originalTitle;
        }, TITLE_FLASH_INTERVAL_MS);
        // Set immediately
        document.title = `\u26A0\uFE0F (${this.unreadCount}) Claudeman`;
      }
    }
  }

  stopTitleFlash() {
    if (this.titleFlashInterval) {
      clearInterval(this.titleFlashInterval);
      this.titleFlashInterval = null;
      this.titleFlashState = false;
      document.title = this.originalTitle;
    }
  }

  // Layer 3: Web Notification API
  sendBrowserNotif(title, body, tag, sessionId) {
    if (!this.preferences.browserNotifications) return;
    if (typeof Notification === 'undefined') return;
    if (Notification.permission === 'default') {
      // Auto-request on first notification attempt
      Notification.requestPermission().then(result => {
        if (result === 'granted') {
          // Re-send this notification now that we have permission
          this.sendBrowserNotif(title, body, tag, sessionId);
        }
      });
      return;
    }
    if (Notification.permission !== 'granted') return;

    // Rate limit: max 1 per 3 seconds
    const now = Date.now();
    if (now - this.lastBrowserNotifTime < 3000) return;
    this.lastBrowserNotifTime = now;

    const notif = new Notification(`Claudeman: ${title}`, {
      body,
      tag, // Groups same-tag notifications
      icon: '/favicon.ico',
      silent: true, // We handle audio ourselves
    });

    notif.onclick = () => {
      window.focus();
      if (sessionId && this.app.sessions.has(sessionId)) {
        this.app.selectSession(sessionId);
      }
      notif.close();
    };

    // Auto-close after 8s
    setTimeout(() => notif.close(), 8000);
  }

  async requestPermission() {
    if (typeof Notification === 'undefined') {
      this.app.showToast('Browser notifications not supported', 'warning');
      return;
    }
    const result = await Notification.requestPermission();
    const statusEl = document.getElementById('notifPermissionStatus');
    if (statusEl) statusEl.textContent = `Status: ${result}`;
    if (result === 'granted') {
      this.preferences.browserNotifications = true;
      this.savePreferences();
      this.app.showToast('Notifications enabled', 'success');
    } else {
      this.app.showToast(`Permission ${result}`, 'warning');
    }
  }

  // Layer 4: Audio alert via Web Audio API
  playAudioAlert() {
    try {
      if (!this.audioCtx) {
        this.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      }
      const ctx = this.audioCtx;
      const oscillator = ctx.createOscillator();
      const gain = ctx.createGain();
      oscillator.connect(gain);
      gain.connect(ctx.destination);
      oscillator.type = 'sine';
      oscillator.frequency.setValueAtTime(660, ctx.currentTime);
      gain.gain.setValueAtTime(0.15, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.15);
      oscillator.start(ctx.currentTime);
      oscillator.stop(ctx.currentTime + 0.15);
    } catch (_e) { /* Audio not available */ }
  }

  // UI interactions
  toggleDrawer() {
    const drawer = document.getElementById('notifDrawer');
    if (!drawer) return;
    this.isDrawerOpen = !this.isDrawerOpen;
    drawer.classList.toggle('open', this.isDrawerOpen);
    if (this.isDrawerOpen) {
      this.renderDrawer();
    }
  }

  clickNotification(notifId) {
    const notif = this.notifications.find(n => n.id === notifId);
    if (!notif) return;

    // Mark as read
    if (!notif.read) {
      notif.read = true;
      this.unreadCount = Math.max(0, this.unreadCount - 1);
      this.updateBadge();
    }

    // Switch to session if available
    if (notif.sessionId && this.app.sessions.has(notif.sessionId)) {
      this.app.selectSession(notif.sessionId);
      this.toggleDrawer();
    }

    this.scheduleRender();
  }

  markAllRead() {
    this.notifications.forEach(n => { n.read = true; });
    this.unreadCount = 0;
    this.updateBadge();
    this.stopTitleFlash();
    this.scheduleRender();
  }

  clearAll() {
    this.notifications = [];
    this.unreadCount = 0;
    this.updateBadge();
    this.stopTitleFlash();
    this.scheduleRender();
  }

  updateBadge() {
    const badge = document.getElementById('notifBadge');
    if (!badge) return;
    if (this.unreadCount > 0) {
      badge.style.display = 'flex';
      badge.textContent = this.unreadCount > 99 ? '99+' : String(this.unreadCount);
    } else {
      badge.style.display = 'none';
    }
  }

  onTabVisible() {
    this.stopTitleFlash();
    // If drawer is open, mark all as read
    if (this.isDrawerOpen) {
      this.markAllRead();
    }
    // Re-fit terminal and send resize to PTY so this client's dimensions win.
    // Fixes broken layout when switching between desktop and mobile on the same session.
    if (this.app?.fitAddon && this.app?.activeSessionId) {
      this.app.fitAddon.fit();
      this.app.sendResize(this.app.activeSessionId);
    }
  }

  // Utilities
  relativeTime(ts) {
    const diff = Math.floor((Date.now() - ts) / 1000);
    if (diff < 60) return 'now';
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
    return `${Math.floor(diff / 86400)}d ago`;
  }

  escapeHtml(text) {
    if (!text) return '';
    return text.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  }
}

class ClaudemanApp {
  constructor() {
    this.sessions = new Map();
    this.sessionOrder = []; // Track tab order for drag-and-drop reordering
    this.draggedTabId = null; // Currently dragged tab session ID
    this.cases = [];
    this.currentRun = null;
    this.totalTokens = 0;
    this.globalStats = null; // Global token/cost stats across all sessions
    this.eventSource = null;
    this.terminal = null;
    this.fitAddon = null;
    this.activeSessionId = null;
    this._initGeneration = 0;     // dedup concurrent handleInit calls
    this._selectGeneration = 0;   // cancel stale selectSession loads
    this.respawnStatus = {};
    this.respawnTimers = {}; // Track timed respawn timers
    this.respawnCountdownTimers = {}; // { sessionId: { timerName: { endsAt, totalMs, reason } } }
    this.respawnActionLogs = {};      // { sessionId: [action, action, ...] } (max 20)
    this.timerCountdownInterval = null; // Interval for updating countdown display
    this.terminalBuffers = new Map(); // Store terminal content per session
    this.editingSessionId = null; // Session being edited in options modal
    this.pendingCloseSessionId = null; // Session pending close confirmation
    this.screenSessions = []; // Screen sessions for process monitor

    // Ralph loop/todo state per session
    this.ralphStates = new Map(); // Map<sessionId, { loop, todos }>

    // Subagent (Claude Code background agent) tracking
    this.subagents = new Map(); // Map<agentId, SubagentInfo>
    this.subagentActivity = new Map(); // Map<agentId, activity[]> - recent tool calls/progress
    this.subagentToolResults = new Map(); // Map<agentId, Map<toolUseId, result>> - tool results by toolUseId
    this.activeSubagentId = null; // Currently selected subagent for detail view
    this.subagentPanelVisible = false;
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
    this.currentSessionWorkingDir = null; // Track current session's working dir for path normalization

    // Image popup windows (auto-open for detected screenshots/images)
    this.imagePopups = new Map(); // Map<imageId, { element, sessionId, filePath }>
    this.imagePopupZIndex = ZINDEX_IMAGE_POPUP_BASE;

    // Tab alert states: Map<sessionId, 'action' | 'idle'>
    this.tabAlerts = new Map();

    // Pending hooks per session: Map<sessionId, Set<hookType>>
    // Tracks pending hook events that need resolution (permission_prompt, elicitation_dialog, idle_prompt)
    this.pendingHooks = new Map();

    // Terminal write batching with DEC 2026 sync support
    this.pendingWrites = [];
    this.writeFrameScheduled = false;
    this._wasAtBottomBeforeWrite = true; // Default to true for sticky scroll
    this.syncWaitTimeout = null; // Timeout for incomplete sync blocks

    // Flicker filter state (buffers output after screen clears)
    this.flickerFilterBuffer = '';
    this.flickerFilterActive = false;
    this.flickerFilterTimeout = null;

    // Render debouncing
    this.renderSessionTabsTimeout = null;
    this.renderRalphStatePanelTimeout = null;
    this.renderTaskPanelTimeout = null;
    this.renderScreenSessionsTimeout = null;

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

    // Offline input queue
    this._inputQueue = new Map(); // Map<sessionId, string>
    this._inputQueueMaxBytes = 64 * 1024; // 64KB cap per session
    this._connectionStatus = 'connected';

    // Sequential input send chain — ensures keystroke ordering across async fetches
    this._inputSendChain = Promise.resolve();

    // No local echo — let PTY/Ink handle all character echoing.
    // Local echo was removed because it's fundamentally incompatible with Ink's
    // terminal management (caused "typing visible below" bug where locally-echoed
    // chars leaked onto Ink's status bar rows).

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

  // ========== Pending Hooks State Machine ==========
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

  init() {
    // Initialize mobile detection first (adds device classes to body)
    MobileDetection.init();
    // Initialize mobile handlers
    KeyboardHandler.init();
    SwipeHandler.init();
    KeyboardAccessoryBar.init();
    this.initTerminal();
    this.loadFontSize();
    this.applyHeaderVisibilitySettings();
    this.applyMonitorVisibility();
    // Remove mobile-init class now that JS has applied visibility settings.
    // The inline <script> in <head> added this to prevent flash-of-content on mobile.
    document.documentElement.classList.remove('mobile-init');
    this.connectSSE();
    this.loadState();
    this.loadQuickStartCases();
    this.setupEventListeners();
    // Mobile settings gear: non-passive touchstart to prevent keyboard dismiss
    const settingsBtn = document.querySelector('.btn-settings-mobile');
    if (settingsBtn) {
      settingsBtn.addEventListener('touchstart', (e) => {
        e.preventDefault();
        e.stopPropagation();
        app.openAppSettings();
      }, { passive: false });
    }
    // Start system stats polling
    this.startSystemStatsPolling();
    // Setup online/offline detection
    this.setupOnlineDetection();
    // Load server-stored settings (async, re-applies visibility after load)
    this.loadAppSettingsFromServer().then(() => {
      this.applyHeaderVisibilitySettings();
      this.applyMonitorVisibility();
    });
  }

  initTerminal() {
    // Load scrollback setting from localStorage (default 5000)
    const scrollback = parseInt(localStorage.getItem('claudeman-scrollback')) || DEFAULT_SCROLLBACK;

    this.terminal = new Terminal({
      theme: {
        background: '#0d0d0d',
        foreground: '#e0e0e0',
        cursor: '#e0e0e0',
        cursorAccent: '#0d0d0d',
        selection: 'rgba(255, 255, 255, 0.3)',
        black: '#0d0d0d',
        red: '#ff6b6b',
        green: '#51cf66',
        yellow: '#ffd43b',
        blue: '#339af0',
        magenta: '#cc5de8',
        cyan: '#22b8cf',
        white: '#e0e0e0',
        brightBlack: '#495057',
        brightRed: '#ff8787',
        brightGreen: '#69db7c',
        brightYellow: '#ffe066',
        brightBlue: '#5c7cfa',
        brightMagenta: '#da77f2',
        brightCyan: '#66d9e8',
        brightWhite: '#ffffff',
      },
      fontFamily: '"Fira Code", "Cascadia Code", "JetBrains Mono", "SF Mono", Monaco, monospace',
      // Use smaller font on mobile to fit more columns (prevents wrapping of Claude's status line)
      fontSize: MobileDetection.getDeviceType() === 'mobile' ? 10 : 14,
      lineHeight: 1.2,
      cursorBlink: false,
      cursorStyle: 'block',
      scrollback: scrollback,
      allowTransparency: true,
    });

    this.fitAddon = new FitAddon.FitAddon();
    this.terminal.loadAddon(this.fitAddon);

    const container = document.getElementById('terminalContainer');
    this.terminal.open(container);

    // On mobile Safari, delay initial fit() to allow layout to settle
    // This prevents 0-column terminals caused by fit() running before container is sized
    const isMobileSafari = MobileDetection.getDeviceType() === 'mobile' &&
                           document.body.classList.contains('safari-browser');
    if (isMobileSafari) {
      // Wait for layout, then fit multiple times to ensure proper sizing
      requestAnimationFrame(() => {
        this.fitAddon.fit();
        // Double-check after another frame
        requestAnimationFrame(() => this.fitAddon.fit());
      });
    } else {
      this.fitAddon.fit();
    }

    // Register link provider for clickable file paths in Bash tool output
    this.registerFilePathLinkProvider();

    // Always use mouse wheel for terminal scrollback, never forward to application.
    // Prevents Claude's Ink UI (plan mode selector) from capturing scroll as option navigation.
    container.addEventListener('wheel', (ev) => {
      ev.preventDefault();
      const lines = Math.round(ev.deltaY / 25) || (ev.deltaY > 0 ? 1 : -1);
      this.terminal.scrollLines(lines);
    }, { passive: false });

    // Touch scrolling - only use custom JS scrolling on desktop
    // Mobile uses native browser scrolling via CSS touch-action: pan-y
    const isMobileDevice = MobileDetection.isTouchDevice() && window.innerWidth < 1024;

    if (!isMobileDevice) {
      // Desktop touch scrolling with custom momentum
      let touchLastY = 0;
      let pendingDelta = 0;
      let velocity = 0;
      let lastTime = 0;
      let scrollFrame = null;
      let isTouching = false;

      const viewport = container.querySelector('.xterm-viewport');

      // Single RAF loop handles both touch and momentum
      const scrollLoop = (timestamp) => {
        if (!viewport) return;

        const dt = lastTime ? (timestamp - lastTime) / 16.67 : 1; // Normalize to 60fps
        lastTime = timestamp;

        if (isTouching) {
          // During touch: apply pending delta
          if (pendingDelta !== 0) {
            viewport.scrollTop += pendingDelta;
            pendingDelta = 0;
          }
          scrollFrame = requestAnimationFrame(scrollLoop);
        } else if (Math.abs(velocity) > 0.1) {
          // Momentum phase
          viewport.scrollTop += velocity * dt;
          velocity *= 0.94; // Smooth deceleration
          scrollFrame = requestAnimationFrame(scrollLoop);
        } else {
          scrollFrame = null;
          velocity = 0;
        }
      };

      container.addEventListener('touchstart', (ev) => {
        if (ev.touches.length === 1) {
          touchLastY = ev.touches[0].clientY;
          pendingDelta = 0;
          velocity = 0;
          isTouching = true;
          lastTime = 0;
          if (!scrollFrame) {
            scrollFrame = requestAnimationFrame(scrollLoop);
          }
        }
      }, { passive: true });

      container.addEventListener('touchmove', (ev) => {
        if (ev.touches.length === 1 && isTouching) {
          const touchY = ev.touches[0].clientY;
          const delta = touchLastY - touchY;
          pendingDelta += delta;
          velocity = delta * 1.2; // Track for momentum
          touchLastY = touchY;
        }
      }, { passive: true });

      container.addEventListener('touchend', () => {
        isTouching = false;
        // Momentum continues in scrollLoop
      }, { passive: true });

      container.addEventListener('touchcancel', () => {
        isTouching = false;
        velocity = 0;
      }, { passive: true });
    }
    // Mobile: native scrolling handles touch via CSS

    // Welcome message
    this.showWelcome();

    // Handle resize with throttling for performance
    this._resizeTimeout = null;
    this._lastResizeDims = null;

    // Minimum terminal dimensions to prevent vertical text wrapping
    const MIN_COLS = 40;
    const MIN_ROWS = 10;

    const throttledResize = () => {
      if (this._resizeTimeout) return;
      this._resizeTimeout = setTimeout(() => {
        this._resizeTimeout = null;
        if (this.fitAddon) {
          this.fitAddon.fit();
          // Skip server resize while mobile keyboard is visible — sending SIGWINCH
          // causes Ink to re-render at the new row count, garbling terminal output.
          // Local fit() still runs so xterm knows the viewport size for scrolling.
          const keyboardUp = typeof KeyboardHandler !== 'undefined' && KeyboardHandler.keyboardVisible;
          if (this.activeSessionId && !keyboardUp) {
            const dims = this.fitAddon.proposeDimensions();
            // Enforce minimum dimensions to prevent layout issues
            const cols = dims ? Math.max(dims.cols, MIN_COLS) : MIN_COLS;
            const rows = dims ? Math.max(dims.rows, MIN_ROWS) : MIN_ROWS;
            // Only send resize if dimensions actually changed
            if (!this._lastResizeDims ||
                cols !== this._lastResizeDims.cols ||
                rows !== this._lastResizeDims.rows) {
              this._lastResizeDims = { cols, rows };
              fetch(`/api/sessions/${this.activeSessionId}/resize`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ cols, rows })
              });
            }
          }
        }
        // Update subagent connection lines when viewport resizes
        this.updateConnectionLines();
      }, 100); // Throttle to 100ms
    };

    window.addEventListener('resize', throttledResize);
    // Store resize observer for cleanup (prevents memory leak on terminal re-init)
    if (this.terminalResizeObserver) {
      this.terminalResizeObserver.disconnect();
    }
    this.terminalResizeObserver = new ResizeObserver(throttledResize);
    this.terminalResizeObserver.observe(container);

    // Handle keyboard input — send to PTY immediately, no local echo.
    // PTY/Ink handles all character echoing to avoid desync ("typing visible below" bug).
    this._pendingInput = '';
    this._inputFlushTimeout = null;
    this._lastKeystrokeTime = 0;

    const flushInput = () => {
      this._inputFlushTimeout = null;
      if (this._pendingInput && this.activeSessionId) {
        const input = this._pendingInput;
        const sessionId = this.activeSessionId;
        this._pendingInput = '';
        this._sendInputAsync(sessionId, input);
      }
    };

    this.terminal.onData((data) => {
      if (this.activeSessionId) {
        // Filter out terminal query responses that xterm.js generates automatically.
        // These are responses to DA (Device Attributes), DSR (Device Status Report), etc.
        // sent by tmux when attaching. Without this filter, they appear as typed text.
        // Patterns: \x1b[?...c (DA1), \x1b[>...c (DA2), \x1b[...R (CPR), \x1b[...n (DSR)
        if (/^\x1b\[[\?>=]?[\d;]*[cnR]$/.test(data)) return;

        this._pendingInput += data;

        // Control chars (Enter, Ctrl+C, escape sequences) — flush immediately
        if (data.charCodeAt(0) < 32 || data.length > 1) {
          if (this._inputFlushTimeout) {
            clearTimeout(this._inputFlushTimeout);
            this._inputFlushTimeout = null;
          }
          flushInput();
          return;
        }

        // Regular chars — flush immediately if typed after a gap (>50ms),
        // otherwise batch via microtask to coalesce rapid keystrokes (paste).
        const now = performance.now();
        if (now - this._lastKeystrokeTime > 50) {
          // Single char after a gap — send immediately, no setTimeout latency
          if (this._inputFlushTimeout) {
            clearTimeout(this._inputFlushTimeout);
            this._inputFlushTimeout = null;
          }
          this._lastKeystrokeTime = now;
          flushInput();
        } else {
          // Rapid sequence (paste or fast typing) — coalesce via microtask
          this._lastKeystrokeTime = now;
          if (!this._inputFlushTimeout) {
            this._inputFlushTimeout = setTimeout(flushInput, 0);
          }
        }
      }
    });
  }

  /**
   * Register a custom link provider for xterm.js that detects file paths
   * in terminal output and makes them clickable.
   * When clicked, opens a floating log viewer window with live streaming.
   */
  registerFilePathLinkProvider() {
    const self = this;

    // Debug: Track if provider is being invoked
    let lastInvokedLine = -1;

    this.terminal.registerLinkProvider({
      provideLinks(bufferLineNumber, callback) {
        // Debug logging - only log if line changed to avoid spam
        if (bufferLineNumber !== lastInvokedLine) {
          lastInvokedLine = bufferLineNumber;
          console.debug('[LinkProvider] Checking line:', bufferLineNumber);
        }

        const buffer = self.terminal.buffer.active;
        const line = buffer.getLine(bufferLineNumber);

        if (!line) {
          callback(undefined);
          return;
        }

        // Get line text - translateToString handles wrapped lines
        const lineText = line.translateToString(true);

        if (!lineText || !lineText.includes('/')) {
          callback(undefined);
          return;
        }

        const links = [];

        // Pattern 1: Commands with file paths (tail -f, cat, head, grep pattern, etc.)
        // Handles: tail -f /path, grep pattern /path, cat -n /path
        const cmdPattern = /(tail|cat|head|less|grep|watch|vim|nano)\s+(?:[^\s\/]*\s+)*(\/[^\s"'<>|;&\n\x00-\x1f]+)/g;

        // Pattern 2: Paths with common extensions
        const extPattern = /(\/(?:home|tmp|var|etc|opt)[^\s"'<>|;&\n\x00-\x1f]*\.(?:log|txt|json|md|yaml|yml|csv|xml|sh|py|ts|js))\b/g;

        // Pattern 3: Bash() tool output
        const bashPattern = /Bash\([^)]*?(\/(?:home|tmp|var|etc|opt)[^\s"'<>|;&\)\n\x00-\x1f]+)/g;

        const addLink = (filePath, matchIndex) => {
          const startCol = lineText.indexOf(filePath, matchIndex);
          if (startCol === -1) return;

          // Skip if already have link at this position
          if (links.some(l => l.range.start.x === startCol + 1)) return;

          links.push({
            text: filePath,
            range: {
              start: { x: startCol + 1, y: bufferLineNumber },      // 1-based
              end: { x: startCol + filePath.length + 1, y: bufferLineNumber }
            },
            decorations: {
              pointerCursor: true,
              underline: true
            },
            activate(event, text) {
              self.openLogViewerWindow(text, self.activeSessionId);
            }
          });
        };

        // Match all patterns
        let match;

        cmdPattern.lastIndex = 0;
        while ((match = cmdPattern.exec(lineText)) !== null) {
          addLink(match[2], match.index);
        }

        extPattern.lastIndex = 0;
        while ((match = extPattern.exec(lineText)) !== null) {
          addLink(match[1], match.index);
        }

        bashPattern.lastIndex = 0;
        while ((match = bashPattern.exec(lineText)) !== null) {
          addLink(match[1], match.index);
        }

        if (links.length > 0) {
          console.debug('[LinkProvider] Found links:', links.map(l => l.text));
        }
        callback(links.length > 0 ? links : undefined);
      }
    });

    console.log('[LinkProvider] File path link provider registered');
  }

  showWelcome() {
    const overlay = document.getElementById('welcomeOverlay');
    if (overlay) {
      overlay.classList.add('visible');
    }
  }

  hideWelcome() {
    const overlay = document.getElementById('welcomeOverlay');
    if (overlay) {
      overlay.classList.remove('visible');
    }
  }

  /**
   * Check if terminal viewport is at or near the bottom.
   * Used to implement "sticky scroll" behavior - keep user at bottom if they were there.
   */
  isTerminalAtBottom() {
    if (!this.terminal) return true;
    const buffer = this.terminal.buffer.active;
    // viewportY is the top line of the viewport, baseY is where scrollback starts
    // If viewportY >= baseY, we're showing the latest content (at bottom)
    // Allow 2 lines tolerance for edge cases
    return buffer.viewportY >= buffer.baseY - 2;
  }

  batchTerminalWrite(data) {
    // Check if at bottom BEFORE adding data (captures user's scroll position)
    // Only update if not already scheduled (preserve the first check's result)
    if (!this.writeFrameScheduled) {
      this._wasAtBottomBeforeWrite = this.isTerminalAtBottom();
    }

    // Check if flicker filter is enabled for current session
    const session = this.activeSessionId ? this.sessions.get(this.activeSessionId) : null;
    const flickerFilterEnabled = session?.flickerFilterEnabled ?? false;

    // Flicker filter: detect screen clear and cursor-up patterns and buffer output
    if (flickerFilterEnabled) {
      // Detect Ink's redraw patterns:
      // - ESC[2J (clear entire screen)
      // - ESC[H ESC[J (cursor home + clear to end)
      // - ESC[?25l ESC[H (hide cursor + home - common Ink pattern)
      // - ESC[nA (cursor up n lines - Ink's line redraw pattern)
      const hasScreenClear = data.includes('\x1b[2J') ||
                             data.includes('\x1b[H\x1b[J') ||
                             (data.includes('\x1b[H') && data.includes('\x1b[?25l'));

      // Detect cursor-up patterns (ESC[nA where n >= 2) - indicates Ink redrawing multiple lines
      // Use regex to find ESC[nA where n is 2 or more digits
      const hasCursorUpRedraw = /\x1b\[\d{1,2}A/.test(data);

      if (hasScreenClear || hasCursorUpRedraw) {
        // Redraw pattern detected - activate flicker filter
        this.flickerFilterActive = true;
        this.flickerFilterBuffer += data;

        // Clear any existing timeout and set a new one
        if (this.flickerFilterTimeout) {
          clearTimeout(this.flickerFilterTimeout);
        }
        this.flickerFilterTimeout = setTimeout(() => {
          this.flickerFilterTimeout = null;
          this.flushFlickerBuffer();
        }, SYNC_WAIT_TIMEOUT_MS); // 50ms buffer window

        return; // Don't process normally, wait for buffer window
      }

      if (this.flickerFilterActive) {
        // Filter is active, accumulate data
        this.flickerFilterBuffer += data;
        return; // Continue buffering
      }
    }

    // Accumulate raw data (may contain DEC 2026 markers)
    this.pendingWrites.push(data);

    if (!this.writeFrameScheduled) {
      this.writeFrameScheduled = true;
      requestAnimationFrame(() => {
        if (this.pendingWrites.length > 0 && this.terminal) {
          // Join chunks for sync marker detection
          const pending = this.pendingWrites.join('');
          // Check if we have an incomplete sync block (SYNC_START without SYNC_END)
          const hasStart = pending.includes(DEC_SYNC_START);
          const hasEnd = pending.includes(DEC_SYNC_END);

          if (hasStart && !hasEnd) {
            // Incomplete sync block - wait for more data (up to 50ms max)
            if (!this.syncWaitTimeout) {
              this.syncWaitTimeout = setTimeout(() => {
                this.syncWaitTimeout = null;
                // Force flush after timeout to prevent stuck state
                this.flushPendingWrites();
              }, 50);
            }
            this.writeFrameScheduled = false;
            return;
          }

          // Clear any pending sync wait timeout
          if (this.syncWaitTimeout) {
            clearTimeout(this.syncWaitTimeout);
            this.syncWaitTimeout = null;
          }

          this.flushPendingWrites();
        }
        this.writeFrameScheduled = false;
      });
    }
  }

  /**
   * Flush the flicker filter buffer to the terminal.
   * Called after the buffer window expires.
   */
  flushFlickerBuffer() {
    if (!this.flickerFilterBuffer) return;

    // Transfer buffered data to normal pending writes
    this.pendingWrites.push(this.flickerFilterBuffer);
    this.flickerFilterBuffer = '';
    this.flickerFilterActive = false;

    // Trigger a normal flush
    if (!this.writeFrameScheduled) {
      this.writeFrameScheduled = true;
      requestAnimationFrame(() => {
        this.flushPendingWrites();
        this.writeFrameScheduled = false;
      });
    }
  }

  /**
   * Flush pending writes to terminal, processing DEC 2026 sync markers.
   * Strips markers and writes content atomically within a single frame.
   */
  flushPendingWrites() {
    if (this.pendingWrites.length === 0 || !this.terminal) return;

    // Extract segments, stripping DEC 2026 markers
    // This implements synchronized output for xterm.js which doesn't support DEC 2026 natively
    const segments = extractSyncSegments(this.pendingWrites.join(''));
    this.pendingWrites = [];

    // Write all segments in a single batch (atomic within this frame)
    // xterm.js internally batches multiple write() calls within same frame
    for (const segment of segments) {
      if (segment && !segment.startsWith(DEC_SYNC_START)) {
        this.terminal.write(segment);
      }
    }

    // Sticky scroll: if user was at bottom, keep them there after new output
    if (this._wasAtBottomBeforeWrite) {
      this.terminal.scrollToBottom();
    }
  }

  /**
   * Write large buffer to terminal in chunks to avoid UI jank.
   * Uses requestAnimationFrame to spread work across frames.
   * @param {string} buffer - The full terminal buffer to write
   * @param {number} chunkSize - Size of each chunk (default 128KB for smooth 60fps)
   * @returns {Promise<void>} - Resolves when all chunks written
   */
  chunkedTerminalWrite(buffer, chunkSize = TERMINAL_CHUNK_SIZE) {
    return new Promise((resolve) => {
      if (!buffer || buffer.length === 0) {
        resolve();
        return;
      }

      // Strip any DEC 2026 markers that might be in the buffer
      // (from historical SSE data that was stored with markers)
      const cleanBuffer = buffer.replace(DEC_SYNC_STRIP_RE, '');

      // For small buffers, write directly
      if (cleanBuffer.length <= chunkSize) {
        this.terminal.write(cleanBuffer);
        resolve();
        return;
      }

      let offset = 0;
      const writeChunk = () => {
        if (offset >= cleanBuffer.length) {
          // Wait one more frame for xterm to finish rendering before resolving
          requestAnimationFrame(() => resolve());
          return;
        }

        const chunk = cleanBuffer.slice(offset, offset + chunkSize);
        this.terminal.write(chunk);
        offset += chunkSize;

        // Schedule next chunk on next frame
        requestAnimationFrame(writeChunk);
      };

      // Start writing
      requestAnimationFrame(writeChunk);
    });
  }

  setupEventListeners() {
    // Use capture to handle before terminal
    document.addEventListener('keydown', (e) => {
      // Escape - close panels and modals
      if (e.key === 'Escape') {
        this.closeAllPanels();
        this.closeHelp();
      }

      // Ctrl/Cmd + ? - help
      if ((e.ctrlKey || e.metaKey) && (e.key === '?' || e.key === '/')) {
        e.preventDefault();
        this.showHelp();
      }

      // Ctrl/Cmd + Enter - quick start
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        this.quickStart();
      }

      // Ctrl/Cmd + W - close active session
      if ((e.ctrlKey || e.metaKey) && e.key === 'w') {
        e.preventDefault();
        this.killActiveSession();
      }

      // Ctrl/Cmd + Tab - next session
      if ((e.ctrlKey || e.metaKey) && e.key === 'Tab') {
        e.preventDefault();
        this.nextSession();
      }

      // Ctrl/Cmd + K - kill all
      if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
        e.preventDefault();
        this.killAllSessions();
      }

      // Ctrl/Cmd + L - clear terminal
      if ((e.ctrlKey || e.metaKey) && e.key === 'l') {
        e.preventDefault();
        this.clearTerminal();
      }

      // Ctrl/Cmd + Shift + R - restore terminal size (after mobile squeeze)
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'R') {
        e.preventDefault();
        this.restoreTerminalSize();
      }

      // Ctrl/Cmd + +/- - font size
      if ((e.ctrlKey || e.metaKey) && (e.key === '=' || e.key === '+')) {
        e.preventDefault();
        this.increaseFontSize();
      }
      if ((e.ctrlKey || e.metaKey) && e.key === '-') {
        e.preventDefault();
        this.decreaseFontSize();
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

  // ========== SSE Connection ==========

  connectSSE() {
    // Check if browser is offline
    if (!navigator.onLine) {
      this.setConnectionStatus('offline');
      return;
    }

    // Clear any pending reconnect timeout to prevent duplicate connections
    if (this.sseReconnectTimeout) {
      clearTimeout(this.sseReconnectTimeout);
      this.sseReconnectTimeout = null;
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

    this.eventSource = new EventSource('/api/events');

    // Store all event listeners for cleanup on reconnect
    const listeners = [];
    const addListener = (event, handler) => {
      this.eventSource.addEventListener(event, handler);
      listeners.push({ event, handler });
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
      if (this.sseReconnectTimeout) {
        clearTimeout(this.sseReconnectTimeout);
      }
      // Exponential backoff: 1s, 2s, 4s, ... up to 30s
      const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts - 1), 30000);
      this.sseReconnectTimeout = setTimeout(() => this.connectSSE(), delay);
    };

    addListener('init', (e) => {
      try {
        this.handleInit(JSON.parse(e.data));
      } catch (err) {
        console.error('[SSE] Failed to parse init event:', err);
      }
    });

    addListener('session:created', (e) => {
      const data = JSON.parse(e.data);
      this.sessions.set(data.id, data);
      // Add new session to end of tab order
      if (!this.sessionOrder.includes(data.id)) {
        this.sessionOrder.push(data.id);
        this.saveSessionOrder();
      }
      this.renderSessionTabs();
      this.updateCost();
    });

    addListener('session:updated', (e) => {
      const data = JSON.parse(e.data);
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
    });

    addListener('session:deleted', (e) => {
      const data = JSON.parse(e.data);
      this._cleanupSessionData(data.id);
      if (this.activeSessionId === data.id) {
        this.activeSessionId = null;
        try { localStorage.removeItem('claudeman-active-session'); } catch {}
        this.terminal.clear();
        this.showWelcome();
      }
      this.renderSessionTabs();
      this.renderRalphStatePanel();  // Update ralph panel after session deleted
      this.renderProjectInsightsPanel();  // Update project insights panel after session deleted
    });

    addListener('session:terminal', (e) => {
      const data = JSON.parse(e.data);
      if (data.id === this.activeSessionId) {
        this.batchTerminalWrite(data.data);
      }
    });

    addListener('session:clearTerminal', async (e) => {
      const data = JSON.parse(e.data);
      if (data.id === this.activeSessionId) {
        // Fetch buffer, clear terminal, write buffer, resize (no Ctrl+L needed)
        try {
          const res = await fetch(`/api/sessions/${data.id}/terminal`);
          const termData = await res.json();

          this.terminal.clear();
          this.terminal.reset();
          if (termData.terminalBuffer) {
            // Strip any DEC 2026 markers and write raw content
            // (markers don't help here - this is a static buffer reload, not live Ink redraws)
            const cleanBuffer = termData.terminalBuffer.replace(DEC_SYNC_STRIP_RE, '');
            // Use chunked write to avoid UI freeze with large buffers (can be 1-2MB)
            await this.chunkedTerminalWrite(cleanBuffer);
          }

          // Send resize to ensure proper dimensions
          await this.sendResize(data.id);
        } catch (err) {
          console.error('clearTerminal refresh failed:', err);
        }
      }
    });

    addListener('session:completion', (e) => {
      const data = JSON.parse(e.data);
      this.totalCost += data.cost || 0;
      this.updateCost();
      if (data.id === this.activeSessionId) {
        this.terminal.writeln('');
        this.terminal.writeln(`\x1b[1;32m Done (Cost: $${(data.cost || 0).toFixed(4)})\x1b[0m`);
      }
    });

    addListener('session:error', (e) => {
      const data = JSON.parse(e.data);
      if (data.id === this.activeSessionId) {
        this.terminal.writeln(`\x1b[1;31m Error: ${data.error}\x1b[0m`);
      }
      const session = this.sessions.get(data.id);
      this.notificationManager?.notify({
        urgency: 'critical',
        category: 'session-error',
        sessionId: data.id,
        sessionName: session?.name || data.id?.slice(0, 8),
        title: 'Session Error',
        message: data.error || 'Unknown error',
      });
    });

    addListener('session:exit', (e) => {
      const data = JSON.parse(e.data);
      const session = this.sessions.get(data.id);
      if (session) {
        session.status = 'stopped';
        this.renderSessionTabs();
      }
      // Notify on unexpected exit (non-zero code)
      if (data.code && data.code !== 0) {
        this.notificationManager?.notify({
          urgency: 'critical',
          category: 'session-crash',
          sessionId: data.id,
          sessionName: session?.name || data.id?.slice(0, 8),
          title: 'Session Crashed',
          message: `Exited with code ${data.code}`,
        });
      }
    });

    addListener('session:idle', (e) => {
      const data = JSON.parse(e.data);
      console.log('[DEBUG] session:idle event for:', data.id);
      const session = this.sessions.get(data.id);
      if (session) {
        session.status = 'idle';
        this.renderSessionTabs();
        this.sendPendingCtrlL(data.id);
      }
      // Start stuck detection timer (only if no respawn running)
      if (!this.respawnStatus[data.id]?.enabled) {
        const threshold = this.notificationManager?.preferences?.stuckThresholdMs || 600000;
        clearTimeout(this.idleTimers.get(data.id));
        this.idleTimers.set(data.id, setTimeout(() => {
          const s = this.sessions.get(data.id);
          this.notificationManager?.notify({
            urgency: 'warning',
            category: 'session-stuck',
            sessionId: data.id,
            sessionName: s?.name || data.id?.slice(0, 8),
            title: 'Session Idle',
            message: `Idle for ${Math.round(threshold / 60000)}+ minutes`,
          });
          this.idleTimers.delete(data.id);
        }, threshold));
      }
    });

    addListener('session:working', (e) => {
      const data = JSON.parse(e.data);
      console.log('[DEBUG] session:working event for:', data.id);
      const session = this.sessions.get(data.id);
      if (session) {
        session.status = 'busy';
        // Only clear tab alert if no pending hooks (permission_prompt, elicitation_dialog, etc.)
        if (!this.pendingHooks.has(data.id)) {
          this.tabAlerts.delete(data.id);
        }
        this.renderSessionTabs();
        this.sendPendingCtrlL(data.id);
      }
      // Clear stuck detection timer
      const timer = this.idleTimers.get(data.id);
      if (timer) {
        clearTimeout(timer);
        this.idleTimers.delete(data.id);
      }
    });

    // Scheduled run events
    addListener('scheduled:created', (e) => {
      this.currentRun = JSON.parse(e.data);
      this.showTimer();
    });

    addListener('scheduled:updated', (e) => {
      this.currentRun = JSON.parse(e.data);
      this.updateTimer();
    });

    addListener('scheduled:completed', (e) => {
      this.currentRun = JSON.parse(e.data);
      this.hideTimer();
      this.showToast('Scheduled run completed!', 'success');
    });

    addListener('scheduled:stopped', (e) => {
      this.currentRun = null;
      this.hideTimer();
    });

    // Respawn events
    addListener('respawn:started', (e) => {
      const data = JSON.parse(e.data);
      this.respawnStatus[data.sessionId] = data.status;
      if (data.sessionId === this.activeSessionId) {
        this.showRespawnBanner();
      }
    });

    addListener('respawn:stopped', (e) => {
      const data = JSON.parse(e.data);
      delete this.respawnStatus[data.sessionId];
      if (data.sessionId === this.activeSessionId) {
        this.hideRespawnBanner();
      }
    });

    addListener('respawn:stateChanged', (e) => {
      const data = JSON.parse(e.data);
      if (this.respawnStatus[data.sessionId]) {
        this.respawnStatus[data.sessionId].state = data.state;
      }
      if (data.sessionId === this.activeSessionId) {
        this.updateRespawnBanner(data.state);
      }
    });

    addListener('respawn:cycleStarted', (e) => {
      const data = JSON.parse(e.data);
      if (this.respawnStatus[data.sessionId]) {
        this.respawnStatus[data.sessionId].cycleCount = data.cycleNumber;
      }
      if (data.sessionId === this.activeSessionId) {
        document.getElementById('respawnCycleCount').textContent = data.cycleNumber;
      }
    });

    addListener('respawn:blocked', (e) => {
      const data = JSON.parse(e.data);
      const session = this.sessions.get(data.sessionId);
      const reasonMap = {
        circuit_breaker_open: 'Circuit Breaker Open',
        exit_signal: 'Exit Signal Detected',
        status_blocked: 'Claude Reported BLOCKED',
      };
      const title = reasonMap[data.reason] || 'Respawn Blocked';
      this.notificationManager?.notify({
        urgency: 'critical',
        category: 'respawn-blocked',
        sessionId: data.sessionId,
        sessionName: session?.name || data.sessionId?.slice(0, 8),
        title,
        message: data.details,
      });
      // Update respawn panel to show blocked state
      if (data.sessionId === this.activeSessionId) {
        const stateEl = document.getElementById('respawnStateLabel');
        if (stateEl) {
          stateEl.textContent = title;
          stateEl.classList.add('respawn-blocked');
        }
      }
    });

    addListener('respawn:stepSent', (_e) => {
      // Step info is shown via state label (e.g., "Sending prompt", "Clearing context")
    });

    addListener('respawn:autoAcceptSent', (e) => {
      const data = JSON.parse(e.data);
      const session = this.sessions.get(data.sessionId);
      this.notificationManager?.notify({
        urgency: 'info',
        category: 'auto-accept',
        sessionId: data.sessionId,
        sessionName: session?.name || data.sessionId?.slice(0, 8),
        title: 'Plan Accepted',
        message: `Accepted plan mode for ${session?.name || 'session'}`,
      });
    });

    addListener('respawn:detectionUpdate', (e) => {
      const data = JSON.parse(e.data);
      if (this.respawnStatus[data.sessionId]) {
        this.respawnStatus[data.sessionId].detection = data.detection;
      }
      if (data.sessionId === this.activeSessionId) {
        this.updateDetectionDisplay(data.detection);
      }
    });

    addListener('respawn:aiCheckStarted', (_e) => {
      // AI check status shown via updateDetectionDisplay
    });

    addListener('respawn:aiCheckCompleted', (_e) => {
      // AI check status shown via updateDetectionDisplay
    });

    addListener('respawn:aiCheckFailed', (_e) => {
      // AI check status shown via updateDetectionDisplay
    });

    addListener('respawn:aiCheckCooldown', (_e) => {
      // AI check status shown via updateDetectionDisplay
    });

    // Respawn run timer events (timed respawn runs)
    addListener('respawn:timerStarted', (e) => {
      const data = JSON.parse(e.data);
      this.respawnTimers[data.sessionId] = {
        endAt: data.endAt,
        startedAt: data.startedAt,
        durationMinutes: data.durationMinutes
      };
      if (data.sessionId === this.activeSessionId) {
        this.showRespawnTimer();
      }
    });

    // Respawn controller countdown timer events (internal timers)
    addListener('respawn:timerStarted', (e) => {
      const data = JSON.parse(e.data);
      // This may fire for both run timers and controller timers - check for timer object
      if (data.timer) {
        const { sessionId, timer } = data;
        if (!this.respawnCountdownTimers[sessionId]) {
          this.respawnCountdownTimers[sessionId] = {};
        }
        this.respawnCountdownTimers[sessionId][timer.name] = {
          endsAt: timer.endsAt,
          totalMs: timer.durationMs,
          reason: timer.reason
        };
        if (sessionId === this.activeSessionId) {
          this.updateCountdownTimerDisplay();
          this.startCountdownInterval();
        }
      }
    });

    addListener('respawn:timerCancelled', (e) => {
      const data = JSON.parse(e.data);
      const { sessionId, timerName } = data;
      if (this.respawnCountdownTimers[sessionId]) {
        delete this.respawnCountdownTimers[sessionId][timerName];
      }
      if (sessionId === this.activeSessionId) {
        this.updateCountdownTimerDisplay();
      }
    });

    addListener('respawn:timerCompleted', (e) => {
      const data = JSON.parse(e.data);
      const { sessionId, timerName } = data;
      if (this.respawnCountdownTimers[sessionId]) {
        delete this.respawnCountdownTimers[sessionId][timerName];
      }
      if (sessionId === this.activeSessionId) {
        this.updateCountdownTimerDisplay();
      }
    });

    addListener('respawn:actionLog', (e) => {
      const data = JSON.parse(e.data);
      const { sessionId, action } = data;
      this.addActionLogEntry(sessionId, action);
      if (sessionId === this.activeSessionId) {
        this.updateCountdownTimerDisplay(); // Show row if hidden
        this.updateActionLogDisplay();
      }
    });

    // Auto-clear event
    addListener('session:autoClear', (e) => {
      const data = JSON.parse(e.data);
      if (data.sessionId === this.activeSessionId) {
        this.showToast(`Auto-cleared at ${data.tokens.toLocaleString()} tokens`, 'info');
        this.updateRespawnTokens(0);
      }
      const session = this.sessions.get(data.sessionId);
      this.notificationManager?.notify({
        urgency: 'info',
        category: 'auto-clear',
        sessionId: data.sessionId,
        sessionName: session?.name || data.sessionId?.slice(0, 8),
        title: 'Auto-Cleared',
        message: `Context reset at ${(data.tokens || 0).toLocaleString()} tokens`,
      });
    });

    // Claude Code CLI info (version, model) parsed from terminal
    addListener('session:cliInfo', (e) => {
      const data = JSON.parse(e.data);
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
    });

    // Background task events
    addListener('task:created', (e) => {
      const data = JSON.parse(e.data);
      this.renderSessionTabs();
      if (data.sessionId === this.activeSessionId) {
        this.renderTaskPanel();
      }
    });

    addListener('task:completed', (e) => {
      const data = JSON.parse(e.data);
      this.renderSessionTabs();
      if (data.sessionId === this.activeSessionId) {
        this.renderTaskPanel();
      }
    });

    addListener('task:failed', (e) => {
      const data = JSON.parse(e.data);
      this.renderSessionTabs();
      if (data.sessionId === this.activeSessionId) {
        this.renderTaskPanel();
      }
    });

    addListener('task:updated', (e) => {
      const data = JSON.parse(e.data);
      if (data.sessionId === this.activeSessionId) {
        this.renderTaskPanel();
      }
    });

    // Screen events
    addListener('screen:created', (e) => {
      const screen = JSON.parse(e.data);
      this.screenSessions.push(screen);
      this.renderScreenSessions();
    });

    addListener('screen:killed', (e) => {
      const data = JSON.parse(e.data);
      this.screenSessions = this.screenSessions.filter(s => s.sessionId !== data.sessionId);
      this.renderScreenSessions();
    });

    addListener('screen:died', (e) => {
      const data = JSON.parse(e.data);
      this.screenSessions = this.screenSessions.filter(s => s.sessionId !== data.sessionId);
      this.renderScreenSessions();
      this.showToast('Mux session died: ' + data.sessionId.slice(0, 8), 'warning');
    });

    addListener('screen:statsUpdated', (e) => {
      this.screenSessions = JSON.parse(e.data);
      if (document.getElementById('monitorPanel').classList.contains('open')) {
        this.renderScreenSessions();
      }
    });

    // Ralph loop/todo events
    addListener('session:ralphLoopUpdate', (e) => {
      const data = JSON.parse(e.data);
      // Skip if user explicitly closed this session's Ralph panel
      if (this.ralphClosedSessions.has(data.sessionId)) return;
      this.updateRalphState(data.sessionId, { loop: data.state });
    });

    addListener('session:ralphTodoUpdate', (e) => {
      const data = JSON.parse(e.data);
      // Skip if user explicitly closed this session's Ralph panel
      if (this.ralphClosedSessions.has(data.sessionId)) return;
      this.updateRalphState(data.sessionId, { todos: data.todos });
    });

    addListener('session:ralphCompletionDetected', (e) => {
      const data = JSON.parse(e.data);
      // Skip if user explicitly closed this session's Ralph panel
      if (this.ralphClosedSessions.has(data.sessionId)) return;
      // Prevent duplicate notifications for the same completion
      const completionKey = `${data.sessionId}:${data.phrase}`;
      if (this._shownCompletions?.has(completionKey)) {
        return;
      }
      if (!this._shownCompletions) {
        this._shownCompletions = new Set();
      }
      this._shownCompletions.add(completionKey);
      // Clear after 30 seconds to allow re-notification if loop restarts
      setTimeout(() => this._shownCompletions?.delete(completionKey), 30000);

      // Update ralph state to mark loop as inactive
      const existing = this.ralphStates.get(data.sessionId) || {};
      if (existing.loop) {
        existing.loop.active = false;
        this.updateRalphState(data.sessionId, existing);
      }

      const session = this.sessions.get(data.sessionId);
      this.notificationManager?.notify({
        urgency: 'warning',
        category: 'ralph-complete',
        sessionId: data.sessionId,
        sessionName: session?.name || data.sessionId?.slice(0, 8),
        title: 'Loop Complete',
        message: `Completion: ${data.phrase || 'unknown'}`,
      });
    });

    // RALPH_STATUS block and circuit breaker events
    addListener('session:ralphStatusUpdate', (e) => {
      const data = JSON.parse(e.data);
      // Skip if user explicitly closed this session's Ralph panel
      if (this.ralphClosedSessions.has(data.sessionId)) return;
      this.updateRalphState(data.sessionId, { statusBlock: data.block });
    });

    addListener('session:circuitBreakerUpdate', (e) => {
      const data = JSON.parse(e.data);
      // Skip if user explicitly closed this session's Ralph panel
      if (this.ralphClosedSessions.has(data.sessionId)) return;
      this.updateRalphState(data.sessionId, { circuitBreaker: data.status });
      // Notify if circuit breaker opens
      if (data.status.state === 'OPEN') {
        const session = this.sessions.get(data.sessionId);
        this.notificationManager?.notify({
          urgency: 'critical',
          category: 'circuit-breaker',
          sessionId: data.sessionId,
          sessionName: session?.name || data.sessionId?.slice(0, 8),
          title: 'Circuit Breaker Open',
          message: data.status.reason || 'Loop stuck - no progress detected',
        });
      }
    });

    addListener('session:exitGateMet', (e) => {
      const data = JSON.parse(e.data);
      // Notify when exit gate is met
      const session = this.sessions.get(data.sessionId);
      this.notificationManager?.notify({
        urgency: 'warning',
        category: 'exit-gate',
        sessionId: data.sessionId,
        sessionName: session?.name || data.sessionId?.slice(0, 8),
        title: 'Exit Gate Met',
        message: `Loop ready to exit (indicators: ${data.completionIndicators})`,
      });
    });

    // Active Bash tool events (for clickable file paths)
    addListener('session:bashToolStart', (e) => {
      const data = JSON.parse(e.data);
      this.handleBashToolStart(data.sessionId, data.tool);
    });

    addListener('session:bashToolEnd', (e) => {
      const data = JSON.parse(e.data);
      this.handleBashToolEnd(data.sessionId, data.tool);
    });

    addListener('session:bashToolsUpdate', (e) => {
      const data = JSON.parse(e.data);
      this.handleBashToolsUpdate(data.sessionId, data.tools);
    });

    // Hook events (from Claude Code hooks system)
    // Use pendingHooks state machine to track hook events and derive tab alerts.
    // This ensures alerts persist even when session:working events fire.
    addListener('hook:idle_prompt', (e) => {
      const data = JSON.parse(e.data);
      const session = this.sessions.get(data.sessionId);
      // Always track pending hook - alert will show when switching away from session
      if (data.sessionId) {
        this.setPendingHook(data.sessionId, 'idle_prompt');
      }
      this.notificationManager?.notify({
        urgency: 'warning',
        category: 'hook-idle',
        sessionId: data.sessionId,
        sessionName: session?.name || data.sessionId,
        title: 'Waiting for Input',
        message: data.message || 'Claude is idle and waiting for a prompt',
      });
    });

    addListener('hook:permission_prompt', (e) => {
      const data = JSON.parse(e.data);
      const session = this.sessions.get(data.sessionId);
      // Always track pending hook - action alerts need user interaction to clear
      if (data.sessionId) {
        this.setPendingHook(data.sessionId, 'permission_prompt');
      }
      const toolInfo = data.tool ? `${data.tool}${data.command ? ': ' + data.command : data.file ? ': ' + data.file : ''}` : '';
      this.notificationManager?.notify({
        urgency: 'critical',
        category: 'hook-permission',
        sessionId: data.sessionId,
        sessionName: session?.name || data.sessionId,
        title: 'Permission Required',
        message: toolInfo || 'Claude needs tool approval to continue',
      });
    });

    addListener('hook:elicitation_dialog', (e) => {
      const data = JSON.parse(e.data);
      const session = this.sessions.get(data.sessionId);
      // Always track pending hook - action alerts need user interaction to clear
      if (data.sessionId) {
        this.setPendingHook(data.sessionId, 'elicitation_dialog');
      }
      this.notificationManager?.notify({
        urgency: 'critical',
        category: 'hook-elicitation',
        sessionId: data.sessionId,
        sessionName: session?.name || data.sessionId,
        title: 'Question Asked',
        message: data.question || 'Claude is asking a question and waiting for your answer',
      });
    });

    addListener('hook:stop', (e) => {
      const data = JSON.parse(e.data);
      const session = this.sessions.get(data.sessionId);
      // Clear all pending hooks when Claude finishes responding
      if (data.sessionId) {
        this.clearPendingHooks(data.sessionId);
      }
      this.notificationManager?.notify({
        urgency: 'info',
        category: 'hook-stop',
        sessionId: data.sessionId,
        sessionName: session?.name || data.sessionId,
        title: 'Response Complete',
        message: data.reason || 'Claude has finished responding',
      });
    });

    // ========== Subagent Events (Claude Code Background Agents) ==========

    addListener('subagent:discovered', (e) => {
      const data = JSON.parse(e.data);
      // Clear all old data for this agentId (in case of ID reuse)
      this.subagents.set(data.agentId, data);
      this.subagentActivity.set(data.agentId, []);
      this.subagentToolResults.delete(data.agentId);
      // Close any existing window for this agentId (will be reopened fresh)
      if (this.subagentWindows.has(data.agentId)) {
        this.forceCloseSubagentWindow(data.agentId);
      }
      this.renderSubagentPanel();

      // Find which Claudeman session owns this subagent (direct claudeSessionId match only)
      this.findParentSessionForSubagent(data.agentId);

      // Auto-open window for new active agents — but ONLY if they belong to a Claudeman session tab.
      // Agents from external Claude sessions (not managed by Claudeman) should not pop up.
      if (data.status === 'active') {
        const agentForCheck = this.subagents.get(data.agentId);
        const hasMatchingTab = agentForCheck?.sessionId &&
          Array.from(this.sessions.values()).some(s => s.claudeSessionId === agentForCheck.sessionId);
        if (hasMatchingTab) {
          this.openSubagentWindow(data.agentId);
        }
      }

      // Ensure connection lines are updated after window is created and DOM settles
      requestAnimationFrame(() => {
        this.updateConnectionLines();
      });
    });

    addListener('subagent:updated', (e) => {
      const data = JSON.parse(e.data);
      const existing = this.subagents.get(data.agentId);
      if (existing) {
        // Merge updated fields (especially description)
        Object.assign(existing, data);
        this.subagents.set(data.agentId, existing);
      } else {
        this.subagents.set(data.agentId, data);
      }
      this.renderSubagentPanel();
      // Update floating window if open (content + header/title)
      if (this.subagentWindows.has(data.agentId)) {
        this.renderSubagentWindowContent(data.agentId);
        this.updateSubagentWindowHeader(data.agentId);
      }
    });

    addListener('subagent:tool_call', (e) => {
      const data = JSON.parse(e.data);
      const activity = this.subagentActivity.get(data.agentId) || [];
      activity.push({ type: 'tool', ...data });
      if (activity.length > 100) activity.shift(); // Keep last 100 entries
      this.subagentActivity.set(data.agentId, activity);
      if (this.activeSubagentId === data.agentId) {
        this.renderSubagentDetail();
      }
      this.renderSubagentPanel();
      // Update floating window
      if (this.subagentWindows.has(data.agentId)) {
        this.renderSubagentWindowContent(data.agentId);
      }
    });

    addListener('subagent:progress', (e) => {
      const data = JSON.parse(e.data);
      const activity = this.subagentActivity.get(data.agentId) || [];
      activity.push({ type: 'progress', ...data });
      if (activity.length > 100) activity.shift();
      this.subagentActivity.set(data.agentId, activity);
      if (this.activeSubagentId === data.agentId) {
        this.renderSubagentDetail();
      }
      // Update floating window
      if (this.subagentWindows.has(data.agentId)) {
        this.renderSubagentWindowContent(data.agentId);
      }
    });

    addListener('subagent:message', (e) => {
      const data = JSON.parse(e.data);
      const activity = this.subagentActivity.get(data.agentId) || [];
      activity.push({ type: 'message', ...data });
      if (activity.length > 100) activity.shift();
      this.subagentActivity.set(data.agentId, activity);
      if (this.activeSubagentId === data.agentId) {
        this.renderSubagentDetail();
      }
      // Update floating window
      if (this.subagentWindows.has(data.agentId)) {
        this.renderSubagentWindowContent(data.agentId);
      }
    });

    addListener('subagent:tool_result', (e) => {
      const data = JSON.parse(e.data);
      // Store tool result by toolUseId for later lookup
      if (!this.subagentToolResults.has(data.agentId)) {
        this.subagentToolResults.set(data.agentId, new Map());
      }
      this.subagentToolResults.get(data.agentId).set(data.toolUseId, data);

      // Add to activity stream
      const activity = this.subagentActivity.get(data.agentId) || [];
      activity.push({ type: 'tool_result', ...data });
      if (activity.length > 100) activity.shift();
      this.subagentActivity.set(data.agentId, activity);

      if (this.activeSubagentId === data.agentId) {
        this.renderSubagentDetail();
      }
      // Update floating window
      if (this.subagentWindows.has(data.agentId)) {
        this.renderSubagentWindowContent(data.agentId);
      }
    });

    addListener('subagent:completed', async (e) => {
      const data = JSON.parse(e.data);
      const existing = this.subagents.get(data.agentId);
      if (existing) {
        existing.status = 'completed';
        this.subagents.set(data.agentId, existing);
      }
      this.renderSubagentPanel();
      this.updateSubagentWindows();

      // Auto-minimize completed subagent windows
      if (this.subagentWindows.has(data.agentId)) {
        const windowData = this.subagentWindows.get(data.agentId);
        if (windowData && !windowData.minimized) {
          await this.closeSubagentWindow(data.agentId); // This minimizes to tab
          this.saveSubagentWindowStates(); // Persist the minimized state
        }
      }

      // Clean up activity/tool data for completed agents after 5 minutes
      // This prevents memory leaks from long-running sessions with many subagents
      setTimeout(() => {
        const agent = this.subagents.get(data.agentId);
        // Only clean up if agent is still completed (not restarted)
        if (agent?.status === 'completed') {
          this.subagentActivity.delete(data.agentId);
          this.subagentToolResults.delete(data.agentId);
        }
      }, 5 * 60 * 1000); // 5 minutes
    });

    // ========== Image Detection Events (Screenshots & Generated Images) ==========

    addListener('image:detected', (e) => {
      const data = JSON.parse(e.data);
      console.log('[Image Detected]', data);
      this.openImagePopup(data);
    });

    // Plan subagent visibility events (show Opus agents during plan generation)
    addListener('plan:subagent', (e) => {
      const data = JSON.parse(e.data);
      console.log('[Plan Subagent]', data);
      this.handlePlanSubagentEvent(data);
    });

    // Plan generation progress events (for detailed mode with subagents)
    addListener('plan:progress', (e) => {
      const data = JSON.parse(e.data);
      console.log('[Plan Progress]', data);

      // Update UI if we have a progress handler registered
      if (this._planProgressHandler) {
        this._planProgressHandler({ type: 'plan:progress', data });
      }

      // Also update the loading display directly for better feedback
      const titleEl = document.getElementById('planLoadingTitle');
      const hintEl = document.getElementById('planLoadingHint');

      if (titleEl && data.phase) {
        const phaseLabels = {
          'parallel-analysis': 'Running parallel analysis...',
          'subagent': data.detail || 'Subagent working...',
          'synthesis': 'Synthesizing results...',
          'verification': 'Running verification...',
        };
        titleEl.textContent = phaseLabels[data.phase] || data.phase;
      }
      if (hintEl && data.detail) {
        hintEl.textContent = data.detail;
      }
    });

    // Plan generation started - store orchestrator ID for cancellation
    addListener('plan:started', (e) => {
      const data = JSON.parse(e.data);
      console.log('[Plan Started]', data);
      this.activePlanOrchestratorId = data.orchestratorId;
      this.planGenerationStopped = false; // Reset flag for new generation
      this.renderMonitorPlanAgents();
    });

    // Plan generation cancelled
    addListener('plan:cancelled', (e) => {
      const data = JSON.parse(e.data);
      console.log('[Plan Cancelled]', data);
      if (this.activePlanOrchestratorId === data.orchestratorId) {
        this.activePlanOrchestratorId = null;
      }
      this.renderMonitorPlanAgents();
    });

    // Plan generation completed
    addListener('plan:completed', (e) => {
      const data = JSON.parse(e.data);
      console.log('[Plan Completed]', data);
      if (this.activePlanOrchestratorId === data.orchestratorId) {
        this.activePlanOrchestratorId = null;
      }
      this.renderMonitorPlanAgents();
    });
  }

  setConnectionStatus(status) {
    this._connectionStatus = status;
    this._updateConnectionIndicator();
    if (status === 'connected' && this._inputQueue.size > 0) {
      this._drainInputQueues();
    }
  }

  /**
   * Send input to server without blocking the keystroke flush cycle.
   * Uses a sequential promise chain to preserve character ordering
   * across concurrent async fetches.
   */
  _sendInputAsync(sessionId, input) {
    // Queue immediately if offline
    if (!this.isOnline || this._connectionStatus === 'disconnected') {
      this._enqueueInput(sessionId, input);
      return;
    }

    // Chain on dispatch only — wait for the previous request to be sent before
    // dispatching the next one (preserves keystroke ordering), but don't wait
    // for the server's response. The server handles writeViaScreen as
    // fire-and-forget anyway, so the HTTP response carries no useful data
    // beyond success/failure for retry purposes.
    this._inputSendChain = this._inputSendChain.then(() => {
      const fetchPromise = fetch(`/api/sessions/${sessionId}/input`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input }),
        keepalive: input.length < 65536,
      });

      // Handle response asynchronously — don't block next keystroke on response
      fetchPromise.then(resp => {
        if (!resp.ok) {
          this._enqueueInput(sessionId, input);
        } else {
          this.clearPendingHooks(sessionId);
        }
      }).catch(() => {
        this._enqueueInput(sessionId, input);
      });

      // Return immediately after fetch is dispatched (don't await response)
    });
  }


  _enqueueInput(sessionId, input) {
    const existing = this._inputQueue.get(sessionId) || '';
    let combined = existing + input;
    // Enforce 64KB cap — keep most recent keystrokes
    if (combined.length > this._inputQueueMaxBytes) {
      combined = combined.slice(combined.length - this._inputQueueMaxBytes);
    }
    this._inputQueue.set(sessionId, combined);
    this._updateConnectionIndicator();
  }

  async _drainInputQueues() {
    if (this._inputQueue.size === 0) return;
    // Snapshot and clear
    const queued = new Map(this._inputQueue);
    this._inputQueue.clear();
    this._updateConnectionIndicator();

    for (const [sessionId, input] of queued) {
      try {
        const resp = await fetch(`/api/sessions/${sessionId}/input`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ input })
        });
        if (!resp.ok) {
          this._enqueueInput(sessionId, input);
        }
      } catch {
        this._enqueueInput(sessionId, input);
      }
    }
    this._updateConnectionIndicator();
  }

  _updateConnectionIndicator() {
    const indicator = this.$('connectionIndicator');
    const dot = this.$('connectionDot');
    const text = this.$('connectionText');
    if (!indicator || !dot || !text) return;

    let totalBytes = 0;
    for (const v of this._inputQueue.values()) totalBytes += v.length;

    const status = this._connectionStatus;
    const hasQueue = totalBytes > 0;

    // Connected with empty queue — hide
    if ((status === 'connected' || status === 'connecting') && !hasQueue) {
      indicator.style.display = 'none';
      return;
    }

    indicator.style.display = 'flex';
    dot.className = 'connection-dot';

    const formatBytes = (b) => b < 1024 ? `${b}B` : `${(b / 1024).toFixed(1)}KB`;

    if (status === 'connected' && hasQueue) {
      // Draining
      dot.classList.add('draining');
      text.textContent = `Sending ${formatBytes(totalBytes)}...`;
    } else if (status === 'reconnecting') {
      dot.classList.add('reconnecting');
      text.textContent = hasQueue ? `Reconnecting (${formatBytes(totalBytes)} queued)` : 'Reconnecting...';
    } else {
      // Offline or disconnected
      dot.classList.add('offline');
      text.textContent = hasQueue ? `Offline (${formatBytes(totalBytes)} queued)` : 'Offline';
    }
  }

  setupOnlineDetection() {
    window.addEventListener('online', () => {
      this.isOnline = true;
      this.reconnectAttempts = 0;
      this.connectSSE();
    });
    window.addEventListener('offline', () => {
      this.isOnline = false;
      this.setConnectionStatus('offline');
    });
  }

  handleInit(data) {
    const gen = ++this._initGeneration;

    // Update version displays (header and toolbar)
    if (data.version) {
      const versionEl = this.$('versionDisplay');
      const headerVersionEl = this.$('headerVersion');
      if (versionEl) {
        versionEl.textContent = `v${data.version}`;
        versionEl.title = `Claudeman v${data.version}`;
      }
      if (headerVersionEl) {
        headerVersionEl.textContent = `v${data.version}`;
        headerVersionEl.title = `Claudeman v${data.version}`;
      }
    }

    this.sessions.clear();
    this.ralphStates.clear();
    this.terminalBuffers.clear();
    this.terminalBufferCache.clear();
    this.projectInsights.clear();
    this.teams.clear();
    this.teamTasks.clear();
    // Clear all idle timers to prevent stale timers from firing
    for (const timer of this.idleTimers.values()) {
      clearTimeout(timer);
    }
    this.idleTimers.clear();
    // Clear flicker filter state
    if (this.flickerFilterTimeout) {
      clearTimeout(this.flickerFilterTimeout);
      this.flickerFilterTimeout = null;
    }
    this.flickerFilterBuffer = '';
    this.flickerFilterActive = false;
    // Clear pending terminal writes
    if (this.syncWaitTimeout) {
      clearTimeout(this.syncWaitTimeout);
      this.syncWaitTimeout = null;
    }
    this.pendingWrites = [];
    this.writeFrameScheduled = false;
    // Clear pending hooks
    this.pendingHooks.clear();
    // Clear tab alerts
    this.tabAlerts.clear();
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

    // Restore previously active session (survives page reload + SSE reconnect)
    // Must always re-select because handleInit clears terminal state above.
    // Reset activeSessionId so selectSession doesn't early-return.
    // Guard: skip if a newer handleInit has already started (race between loadState + SSE init).
    if (gen !== this._initGeneration) return;
    const previousActiveId = this.activeSessionId;
    this.activeSessionId = null;
    if (this.sessionOrder.length > 0) {
      // Priority: current active > localStorage > first session
      let restoreId = previousActiveId;
      if (!restoreId || !this.sessions.has(restoreId)) {
        try { restoreId = localStorage.getItem('claudeman-active-session'); } catch {}
      }
      if (restoreId && this.sessions.has(restoreId)) {
        this.selectSession(restoreId);
      } else {
        this.selectSession(this.sessionOrder[0]);
      }
    }
  }

  async loadState() {
    try {
      const res = await fetch('/api/status');
      const data = await res.json();
      this.handleInit(data);
    } catch (err) {
      console.error('Failed to load state:', err);
    }
  }

  // ========== Session Tabs ==========

  renderSessionTabs() {
    // Debounce renders at 100ms to prevent excessive DOM updates
    if (this.renderSessionTabsTimeout) {
      clearTimeout(this.renderSessionTabsTimeout);
    }
    this.renderSessionTabsTimeout = setTimeout(() => {
      this._renderSessionTabsImmediate();
    }, 100);
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
  }

  _renderSessionTabsImmediate() {
    const container = this.$('sessionTabs');
    const existingTabs = container.querySelectorAll('.session-tab[data-id]');
    const existingIds = new Set([...existingTabs].map(t => t.dataset.id));
    const currentIds = new Set(this.sessions.keys());

    // Check if we can do incremental update (same session IDs)
    const canIncremental = existingIds.size === currentIds.size &&
      [...existingIds].every(id => currentIds.has(id));

    if (canIncremental) {
      // Incremental update - only modify changed properties
      for (const [id, session] of this.sessions) {
        const tab = container.querySelector(`.session-tab[data-id="${id}"]`);
        if (!tab) continue;

        const isActive = id === this.activeSessionId;
        const status = session.status || 'idle';
        const name = this.getSessionName(session);
        const taskStats = session.taskStats || { running: 0, total: 0 };
        const hasRunningTasks = taskStats.running > 0;

        // Update active class
        if (isActive && !tab.classList.contains('active')) {
          tab.classList.add('active');
        } else if (!isActive && tab.classList.contains('active')) {
          tab.classList.remove('active');
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

        // Update status indicator
        const statusEl = tab.querySelector('.tab-status');
        if (statusEl && !statusEl.classList.contains(status)) {
          statusEl.className = `tab-status ${status}`;
        }

        // Update name if changed
        const nameEl = tab.querySelector('.tab-name');
        if (nameEl && nameEl.textContent !== name) {
          nameEl.textContent = name;
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

        // Update subagent badge - check if count changed
        const subagentBadgeEl = tab.querySelector('.tab-subagent-badge');
        const minimizedAgents = this.minimizedSubagents.get(id);
        const minimizedCount = minimizedAgents?.size || 0;
        const currentCount = subagentBadgeEl ? parseInt(subagentBadgeEl.querySelector('.subagent-count')?.textContent || '0') : 0;
        if (minimizedCount !== currentCount) {
          // Count changed - need full rebuild for dropdown update
          this._fullRenderSessionTabs();
          return;
        }
      }
    } else {
      // Full rebuild needed (sessions added/removed)
      this._fullRenderSessionTabs();
    }

  }

  _fullRenderSessionTabs() {
    const container = this.$('sessionTabs');

    // Clean up any orphaned dropdowns before re-rendering
    document.querySelectorAll('body > .subagent-dropdown').forEach(d => d.remove());
    this.cancelHideSubagentDropdown();

    // Build tabs HTML using array for better string concatenation performance
    // Iterate in sessionOrder to respect user's custom tab arrangement
    // On mobile: put active session first (only one tab visible anyway)
    const parts = [];
    let tabOrder = this.sessionOrder;
    if (MobileDetection.getDeviceType() === 'mobile' && this.activeSessionId) {
      // Reorder to put active tab first
      tabOrder = [this.activeSessionId, ...this.sessionOrder.filter(id => id !== this.activeSessionId)];
    }
    for (const id of tabOrder) {
      const session = this.sessions.get(id);
      if (!session) continue; // Skip if session was removed

      const isActive = id === this.activeSessionId;
      const status = session.status || 'idle';
      const name = this.getSessionName(session);
      const mode = session.mode || 'claude';
      const color = session.color || 'default';
      const taskStats = session.taskStats || { running: 0, total: 0 };
      const hasRunningTasks = taskStats.running > 0;
      const alertType = this.tabAlerts.get(id);
      const alertClass = alertType === 'action' ? ' tab-alert-action' : alertType === 'idle' ? ' tab-alert-idle' : '';

      // Get minimized subagents for this session
      const minimizedAgents = this.minimizedSubagents.get(id);
      const minimizedCount = minimizedAgents?.size || 0;
      const subagentBadge = minimizedCount > 0 ? this.renderSubagentTabBadge(id, minimizedAgents) : '';

      parts.push(`<div class="session-tab ${isActive ? 'active' : ''}${alertClass}" data-id="${id}" data-color="${color}" onclick="app.selectSession('${id}')" oncontextmenu="event.preventDefault(); app.startInlineRename('${id}')" tabindex="0" role="tab" aria-selected="${isActive ? 'true' : 'false'}" aria-label="${this.escapeHtml(name)} session">
          <span class="tab-status ${status}" aria-hidden="true"></span>
          ${mode === 'shell' ? '<span class="tab-mode shell" aria-hidden="true">sh</span>' : ''}
          <span class="tab-name" data-session-id="${id}">${this.escapeHtml(name)}</span>
          ${hasRunningTasks ? `<span class="tab-badge" onclick="event.stopPropagation(); app.toggleTaskPanel()" aria-label="${taskStats.running} running tasks">${taskStats.running}</span>` : ''}
          ${subagentBadge}
          <span class="tab-gear" onclick="event.stopPropagation(); app.openSessionOptions('${id}')" title="Session options" aria-label="Session options" tabindex="0">&#x2699;</span>
          <span class="tab-close" onclick="event.stopPropagation(); app.requestCloseSession('${id}')" title="Close session" aria-label="Close session" tabindex="0">&times;</span>
        </div>`);
    }

    container.innerHTML = parts.join('');

    // Set up drag-and-drop handlers for tab reordering
    this.setupTabDragHandlers();

    // Set up keyboard navigation for tabs
    this.setupTabKeyboardNavigation(container);

    // Update connection lines after tabs change (positions may have shifted)
    this.updateConnectionLines();
  }

  // Set up arrow key navigation for session tabs (accessibility)
  setupTabKeyboardNavigation(container) {
    // Remove existing listener if any to avoid duplicates
    if (this._tabKeydownHandler) {
      container.removeEventListener('keydown', this._tabKeydownHandler);
    }

    this._tabKeydownHandler = (e) => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End', 'Enter', ' '].includes(e.key)) return;

      const tabs = [...container.querySelectorAll('.session-tab')];
      const currentIndex = tabs.indexOf(document.activeElement);

      // Enter or Space activates the tab
      if ((e.key === 'Enter' || e.key === ' ') && currentIndex >= 0) {
        e.preventDefault();
        const sessionId = tabs[currentIndex].dataset.id;
        this.selectSession(sessionId);
        return;
      }

      if (currentIndex < 0) return;

      let newIndex;
      switch (e.key) {
        case 'ArrowLeft':
          newIndex = currentIndex > 0 ? currentIndex - 1 : tabs.length - 1;
          break;
        case 'ArrowRight':
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

  // Render subagent badge with dropdown for minimized agents on a tab
  renderSubagentTabBadge(sessionId, minimizedAgents) {
    if (!minimizedAgents || minimizedAgents.size === 0) return '';

    const agentItems = [];
    for (const agentId of minimizedAgents) {
      const agent = this.subagents.get(agentId);
      const displayName = agent?.description || agentId.substring(0, 12);
      const truncatedName = displayName.length > 25 ? displayName.substring(0, 25) + '…' : displayName;
      const statusClass = agent?.status || 'idle';
      agentItems.push(`
        <div class="subagent-dropdown-item" onclick="event.stopPropagation(); app.restoreMinimizedSubagent('${agentId}', '${sessionId}')" title="Click to restore">
          <span class="subagent-dropdown-status ${statusClass}"></span>
          <span class="subagent-dropdown-name">${this.escapeHtml(truncatedName)}</span>
          <span class="subagent-dropdown-close" onclick="event.stopPropagation(); app.permanentlyCloseMinimizedSubagent('${agentId}', '${sessionId}')" title="Dismiss">&times;</span>
        </div>
      `);
    }

    // Compact badge - shows on hover, click to pin open
    const count = minimizedAgents.size;
    const label = count === 1 ? 'AGENT' : `AGENTS (${count})`;
    return `
      <span class="tab-subagent-badge"
            onmouseenter="app.showSubagentDropdown(this)"
            onmouseleave="app.scheduleHideSubagentDropdown(this)"
            onclick="event.stopPropagation(); app.pinSubagentDropdown(this);">
        <span class="subagent-label">${label}</span>
        <div class="subagent-dropdown" onmouseenter="app.cancelHideSubagentDropdown()" onmouseleave="app.scheduleHideSubagentDropdown(this.parentElement)">
          ${agentItems.join('')}
        </div>
      </span>
    `;
  }

  // ========== Tab Order and Drag-and-Drop ==========

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
      const saved = localStorage.getItem('claudeman-session-order');
      return saved ? JSON.parse(saved) : [];
    } catch {
      return [];
    }
  }

  // Save session order to localStorage
  saveSessionOrder() {
    try {
      localStorage.setItem('claudeman-session-order', JSON.stringify(this.sessionOrder));
    } catch {
      // Ignore storage errors
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

        // Determine drop position based on mouse position
        const rect = tab.getBoundingClientRect();
        const midpoint = rect.left + rect.width / 2;
        const isLeftHalf = e.clientX < midpoint;

        // Update visual indicator
        tab.classList.toggle('drag-over-left', isLeftHalf);
        tab.classList.toggle('drag-over-right', !isLeftHalf);
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

        // Determine insertion position
        const rect = tab.getBoundingClientRect();
        const midpoint = rect.left + rect.width / 2;
        const insertBefore = e.clientX < midpoint;

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

  // Restore a minimized subagent window
  restoreMinimizedSubagent(agentId, sessionId) {
    // Remove from minimized set
    const minimizedAgents = this.minimizedSubagents.get(sessionId);
    if (minimizedAgents) {
      minimizedAgents.delete(agentId);
      if (minimizedAgents.size === 0) {
        this.minimizedSubagents.delete(sessionId);
      }
    }

    // Restore the window
    this.restoreSubagentWindow(agentId);

    // Re-render tabs to update badge
    this.renderSessionTabs();

    // Persist the state change
    this.saveSubagentWindowStates();
  }

  // Show subagent dropdown on hover
  showSubagentDropdown(badgeEl) {
    this.cancelHideSubagentDropdown();
    const dropdown = badgeEl.querySelector('.subagent-dropdown');
    if (!dropdown || dropdown.classList.contains('open')) return;

    // Close other dropdowns first
    document.querySelectorAll('.subagent-dropdown.open').forEach(d => {
      d.classList.remove('open', 'pinned');
      if (d.parentElement === document.body && d._originalParent) {
        d._originalParent.appendChild(d);
      }
    });

    // Move to body to escape clipping
    dropdown._originalParent = badgeEl;
    document.body.appendChild(dropdown);

    // Position below badge
    const rect = badgeEl.getBoundingClientRect();
    dropdown.style.top = `${rect.bottom + 2}px`;
    dropdown.style.left = `${rect.left + rect.width / 2}px`;
    dropdown.style.transform = 'translateX(-50%)';
    dropdown.classList.add('open');
  }

  // Schedule hide after delay (allows moving mouse to dropdown)
  scheduleHideSubagentDropdown(badgeEl) {
    this._subagentHideTimeout = setTimeout(() => {
      const dropdown = badgeEl?.querySelector?.('.subagent-dropdown') ||
                       document.querySelector('.subagent-dropdown.open');
      if (dropdown && !dropdown.classList.contains('pinned')) {
        dropdown.classList.remove('open');
        if (dropdown._originalParent) {
          dropdown._originalParent.appendChild(dropdown);
        }
      }
    }, 150);
  }

  // Cancel scheduled hide
  cancelHideSubagentDropdown() {
    if (this._subagentHideTimeout) {
      clearTimeout(this._subagentHideTimeout);
      this._subagentHideTimeout = null;
    }
  }

  // Pin dropdown open on click (stays until clicking outside)
  pinSubagentDropdown(badgeEl) {
    const dropdown = document.querySelector('.subagent-dropdown.open');
    if (!dropdown) {
      this.showSubagentDropdown(badgeEl);
      return;
    }
    dropdown.classList.toggle('pinned');

    if (dropdown.classList.contains('pinned')) {
      // Close on outside click
      const closeHandler = (e) => {
        if (!badgeEl.contains(e.target) && !dropdown.contains(e.target)) {
          dropdown.classList.remove('open', 'pinned');
          if (dropdown._originalParent) {
            dropdown._originalParent.appendChild(dropdown);
          }
          document.removeEventListener('click', closeHandler);
        }
      };
      setTimeout(() => document.addEventListener('click', closeHandler), 0);
    }
  }

  // Legacy toggle for backwards compat
  toggleSubagentDropdown(badgeEl) {
    this.pinSubagentDropdown(badgeEl);
  }

  // Permanently close a minimized subagent (remove from DOM and minimized set)
  permanentlyCloseMinimizedSubagent(agentId, sessionId) {
    // Remove from minimized set
    const minimizedAgents = this.minimizedSubagents.get(sessionId);
    if (minimizedAgents) {
      minimizedAgents.delete(agentId);
      if (minimizedAgents.size === 0) {
        this.minimizedSubagents.delete(sessionId);
      }
    }

    // Force close the window (removes from DOM)
    this.forceCloseSubagentWindow(agentId);

    // Re-render tabs to update badge
    this.renderSessionTabs();
    this.updateConnectionLines();

    // Persist the state change
    this.saveSubagentWindowStates();
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
    return session.id.slice(0, 8);
  }

  async selectSession(sessionId) {
    if (this.activeSessionId === sessionId) return;

    const selectGen = ++this._selectGeneration;

    if (selectGen !== this._selectGeneration) return; // newer tab switch won

    // Clean up flicker filter state when switching sessions
    if (this.flickerFilterTimeout) {
      clearTimeout(this.flickerFilterTimeout);
      this.flickerFilterTimeout = null;
    }
    this.flickerFilterBuffer = '';
    this.flickerFilterActive = false;

    // Clean up pending terminal writes to prevent old session data from appearing in new session
    if (this.syncWaitTimeout) {
      clearTimeout(this.syncWaitTimeout);
      this.syncWaitTimeout = null;
    }
    this.pendingWrites = [];
    this.writeFrameScheduled = false;

    this.activeSessionId = sessionId;
    try { localStorage.setItem('claudeman-active-session', sessionId); } catch {}
    this.hideWelcome();
    // Clear idle hooks on view, but keep action hooks until user interacts
    this.clearPendingHooks(sessionId, 'idle_prompt');
    // Instant active-class toggle (no 100ms debounce), then schedule full render for badges/status
    this._updateActiveTabImmediate(sessionId);
    this.renderSessionTabs();

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
    if (session && session.pid === null && session.status === 'idle') {
      // This is a restored session - attach to the existing screen
      try {
        await fetch(`/api/sessions/${sessionId}/interactive`, { method: 'POST' });
        // Update local session state
        session.status = 'busy';
      } catch (err) {
        console.error('Failed to attach to restored session:', err);
      }
    }

    // Load terminal buffer for this session
    // Show cached content instantly while fetching fresh data in background.
    // Use tail mode for faster initial load (256KB is enough for recent visible content).
    try {
      // Instant cache restore — show previous buffer immediately while network fetch runs
      const cachedBuffer = this.terminalBufferCache.get(sessionId);
      if (cachedBuffer) {
        this.terminal.clear();
        this.terminal.reset();
        this.terminal.write(cachedBuffer);
        this.terminal.scrollToBottom();
      }

      const tailSize = 256 * 1024;
      const res = await fetch(`/api/sessions/${sessionId}/terminal?tail=${tailSize}`);
      if (selectGen !== this._selectGeneration) return; // stale — newer selectSession won
      const data = await res.json();

      this.terminal.clear();
      this.terminal.reset();
      if (data.terminalBuffer) {
        // Show truncation indicator if buffer was cut
        if (data.truncated) {
          this.terminal.write('\x1b[90m... (earlier output truncated for performance) ...\x1b[0m\r\n\r\n');
        }
        // Use chunked write for large buffers to avoid UI jank
        await this.chunkedTerminalWrite(data.terminalBuffer);
        if (selectGen !== this._selectGeneration) return; // stale — skip post-write UI updates
        // Ensure terminal is scrolled to bottom after buffer load
        this.terminal.scrollToBottom();

        // Update cache (cap at 20 entries)
        this.terminalBufferCache.set(sessionId, data.terminalBuffer);
        if (this.terminalBufferCache.size > 20) {
          // Evict oldest entry (first key in Map iteration order)
          const oldest = this.terminalBufferCache.keys().next().value;
          this.terminalBufferCache.delete(oldest);
        }
      }

      // Send resize and Ctrl+L to trigger Claude to redraw at correct size
      await this.sendResize(sessionId);

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
          }
        }
      });

      this.terminal.focus();
      this.terminal.scrollToBottom();
    } catch (err) {
      console.error('Failed to load session terminal:', err);
    }
  }

  // Shared cleanup for all session data — called from both closeSession() and session:deleted handler
  _cleanupSessionData(sessionId) {
    this.sessions.delete(sessionId);
    // Remove from tab order
    const orderIndex = this.sessionOrder.indexOf(sessionId);
    if (orderIndex !== -1) {
      this.sessionOrder.splice(orderIndex, 1);
      this.saveSessionOrder();
    }
    this.terminalBuffers.delete(sessionId);
    this.terminalBufferCache.delete(sessionId);
    this._inputQueue.delete(sessionId);
    this.ralphStates.delete(sessionId);
    this.ralphClosedSessions.delete(sessionId);
    this.projectInsights.delete(sessionId);
    this.pendingHooks.delete(sessionId);
    this.tabAlerts.delete(sessionId);
    this.clearCountdownTimers(sessionId);
    this.closeSessionLogViewerWindows(sessionId);
    this.closeSessionImagePopups(sessionId);
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

  async closeSession(sessionId, killScreen = true) {
    try {
      await fetch(`/api/sessions/${sessionId}?killScreen=${killScreen}`, { method: 'DELETE' });
      this._cleanupSessionData(sessionId);

      if (this.activeSessionId === sessionId) {
        this.activeSessionId = null;
        try { localStorage.removeItem('claudeman-active-session'); } catch {}
        // Select another session or show welcome (use sessionOrder for consistent ordering)
        if (this.sessionOrder.length > 0 && this.sessions.size > 0) {
          const nextSessionId = this.sessionOrder[0];
          this.selectSession(nextSessionId);
        } else {
          this.terminal.clear();
          this.showWelcome();
          this.renderRalphStatePanel();  // Clear ralph panel when no sessions
        }
      }

      this.renderSessionTabs();

      if (killScreen) {
        this.showToast('Session closed and tmux killed', 'success');
      } else {
        this.showToast('Tab hidden, tmux still running', 'info');
      }
    } catch (err) {
      this.showToast('Failed to close session', 'error');
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

    document.getElementById('closeConfirmModal').classList.add('active');
  }

  cancelCloseSession() {
    this.pendingCloseSessionId = null;
    document.getElementById('closeConfirmModal').classList.remove('active');
  }

  async confirmCloseSession(killScreen = true) {
    const sessionId = this.pendingCloseSessionId;
    this.cancelCloseSession();

    if (sessionId) {
      await this.closeSession(sessionId, killScreen);
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

  // ========== Navigation ==========

  goHome() {
    // Deselect active session and show welcome screen
    this.activeSessionId = null;
    try { localStorage.removeItem('claudeman-active-session'); } catch {}
    this.terminal.clear();
    this.showWelcome();
    this.renderSessionTabs();
    this.renderRalphStatePanel();
  }

  // ========== Ralph Loop Wizard ==========

  // Wizard state
  ralphWizardStep = 1;
  ralphWizardConfig = {
    taskDescription: '',
    completionPhrase: 'COMPLETE',
    maxIterations: 10,
    caseName: 'testcase',
    enableRespawn: true,
    // Plan generation fields
    generatedPlan: null,      // [{content, priority, enabled, id}] or null
    planGenerated: false,
    skipPlanGeneration: false,
    planDetailLevel: 'detailed', // 'brief', 'standard', 'detailed'
  };
  planLoadingTimer = null;
  planLoadingStartTime = null;

  showRalphWizard() {
    // Reset wizard state
    this.ralphWizardStep = 1;
    this.ralphWizardConfig = {
      taskDescription: '',
      completionPhrase: 'COMPLETE',
      maxIterations: 10,
      caseName: document.getElementById('quickStartCase')?.value || 'testcase',
      enableRespawn: true,
      autoStart: false,         // Auto-start loop after plan generation
      // Plan generation fields
      generatedPlan: null,
      planGenerated: false,
      skipPlanGeneration: false,
      planDetailLevel: 'detailed',
      // Existing plan detection
      existingPlan: null,       // { todos, stats, content } from @fix_plan.md
      useExistingPlan: false,   // User chose to use existing plan
    };

    // Reset UI
    document.getElementById('ralphTaskDescription').value = '';
    document.getElementById('ralphCompletionPhrase').value = 'COMPLETE';
    this.selectIterationPreset(10);
    // Reset auto-start checkboxes (off by default) - there are two, one in step 2 and one in step 3
    const autoStartEl = document.getElementById('ralphAutoStart');
    const autoStartStep2El = document.getElementById('ralphAutoStartStep2');
    if (autoStartEl) autoStartEl.checked = false;
    if (autoStartStep2El) autoStartStep2El.checked = false;

    // Populate case selector
    this.populateRalphCaseSelector();

    // Reset plan generation UI
    this.resetPlanGenerationUI();

    // Check for existing @fix_plan.md in selected case
    this.checkExistingFixPlan();

    // Show wizard modal
    this.updateRalphWizardUI();
    const modal = document.getElementById('ralphWizardModal');
    modal.classList.add('active');

    // Reset wizard position to center
    this.wizardPosition = null;
    this.planAgentsMinimized = false;
    const wizardContent = modal.querySelector('.modal-content');
    if (wizardContent) {
      wizardContent.classList.remove('draggable');
      wizardContent.style.left = '';
      wizardContent.style.top = '';
    }

    // Set up wizard dragging
    this.setupWizardDragging();

    // Hide minimize button initially (no agents yet)
    this.updateWizardAgentCount();

    // Activate focus trap (but don't auto-focus since we have specific focus below)
    this.activeFocusTrap = new FocusTrap(modal);
    this.activeFocusTrap.previouslyFocused = document.activeElement;
    modal.addEventListener('keydown', this.activeFocusTrap.boundHandleKeydown);

    document.getElementById('ralphTaskDescription').focus();

    // Update connection lines to show wizard connections
    this.updateConnectionLines();
  }

  closeRalphWizard() {
    const modal = document.getElementById('ralphWizardModal');
    modal?.classList.remove('active');

    // Deactivate focus trap and restore focus
    if (this.activeFocusTrap) {
      this.activeFocusTrap.deactivate();
      this.activeFocusTrap = null;
    }

    // Clean up wizard drag listeners
    this.cleanupWizardDragging();

    // Remove agents minimized tab if exists
    this.removeAgentsMinimizedTab();

    // Hide minimized indicator
    this.hideWizardMinimizedIndicator();

    // Reset wizard position
    this.wizardPosition = null;
    this.planAgentsMinimized = false;

    // === CRITICAL: Clean up any orphaned plan generation state ===

    // Cancel any in-flight plan generation
    if (this.activePlanOrchestratorId) {
      console.log('[Wizard Close] Cancelling active plan orchestrator:', this.activePlanOrchestratorId);
      fetch('/api/cancel-plan-generation', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orchestratorId: this.activePlanOrchestratorId }),
      }).catch(err => console.error('[Wizard Close] Failed to cancel plan:', err));
      this.activePlanOrchestratorId = null;
    }

    // Abort any in-flight fetch request
    if (this.planGenerationAbortController) {
      this.planGenerationAbortController.abort();
      this.planGenerationAbortController = null;
    }

    // Clear progress handler to prevent orphaned callbacks
    this._planProgressHandler = null;

    // Clear plan loading timers
    if (this.planLoadingTimer) {
      clearInterval(this.planLoadingTimer);
      this.planLoadingTimer = null;
    }
    if (this.planPhaseTimer) {
      clearTimeout(this.planPhaseTimer);
      this.planPhaseTimer = null;
    }

    // Mark generation as stopped to ignore any late SSE events
    this.planGenerationStopped = true;

    // Close all plan subagent windows
    this.closePlanSubagentWindows();

    // Clear wizard minimized windows tracking
    this.wizardMinimizedWindows = null;

    // Update monitor panel to reflect changes
    this.renderMonitorPlanAgents();

    // Update connection lines (wizard closed, revert to normal)
    this.updateConnectionLines();
  }

  minimizeRalphWizard() {
    const modal = document.getElementById('ralphWizardModal');
    modal?.classList.remove('active');

    // Track windows minimized due to wizard minimize (so we can restore them)
    this.wizardMinimizedWindows = new Set();

    // Minimize all plan subagent windows
    for (const [agentId, windowData] of this.planSubagents) {
      if (windowData.element && windowData.element.style.display !== 'none') {
        windowData.element.style.display = 'none';
        this.wizardMinimizedWindows.add(`plan:${agentId}`);
      }
    }

    // Minimize all regular subagent windows
    for (const [agentId, windowData] of this.subagentWindows) {
      if (windowData.element && !windowData.minimized && windowData.element.style.display !== 'none') {
        windowData.element.style.display = 'none';
        windowData.hiddenByWizard = true;
        this.wizardMinimizedWindows.add(`subagent:${agentId}`);
      }
    }

    // Show the minimized indicator
    this.showWizardMinimizedIndicator();

    // Update connection lines (all hidden now)
    this.updateConnectionLines();
  }

  restoreRalphWizard() {
    // Hide the minimized indicator
    this.hideWizardMinimizedIndicator();

    // Show the modal again
    const modal = document.getElementById('ralphWizardModal');
    modal?.classList.add('active');

    // Restore windows that were minimized due to wizard minimize
    if (this.wizardMinimizedWindows) {
      for (const key of this.wizardMinimizedWindows) {
        if (key.startsWith('plan:')) {
          const agentId = key.slice(5);
          const windowData = this.planSubagents.get(agentId);
          if (windowData?.element) {
            windowData.element.style.display = '';
          }
        } else if (key.startsWith('subagent:')) {
          const agentId = key.slice(9);
          const windowData = this.subagentWindows.get(agentId);
          if (windowData?.element && windowData.hiddenByWizard) {
            windowData.element.style.display = '';
            windowData.hiddenByWizard = false;
          }
        }
      }
      this.wizardMinimizedWindows.clear();
    }

    // Update connection lines
    this.updateConnectionLines();
  }

  showWizardMinimizedIndicator() {
    const indicator = document.getElementById('wizardMinimizedIndicator');
    if (!indicator) return;

    indicator.classList.add('visible');

    // Start time counter if plan generation is active
    if (this.planLoadingStartTime) {
      this.wizardMinimizedTimer = setInterval(() => {
        const elapsed = Math.floor((Date.now() - this.planLoadingStartTime) / 1000);
        const timeEl = document.getElementById('wizardMinimizedTime');
        if (timeEl) timeEl.textContent = `${elapsed}s`;
      }, 1000);
    }
  }

  hideWizardMinimizedIndicator() {
    const indicator = document.getElementById('wizardMinimizedIndicator');
    if (indicator) indicator.classList.remove('visible');

    if (this.wizardMinimizedTimer) {
      clearInterval(this.wizardMinimizedTimer);
      this.wizardMinimizedTimer = null;
    }
  }

  populateRalphCaseSelector() {
    const select = document.getElementById('ralphCaseSelect');
    const quickStartSelect = document.getElementById('quickStartCase');

    if (quickStartSelect && select) {
      select.innerHTML = quickStartSelect.innerHTML;
      select.value = this.ralphWizardConfig.caseName;
    }
  }

  selectIterationPreset(iterations) {
    this.ralphWizardConfig.maxIterations = iterations;

    // Update button states
    document.querySelectorAll('.iteration-preset-btn').forEach(btn => {
      const btnIterations = parseInt(btn.dataset.iterations);
      btn.classList.toggle('active', btnIterations === iterations);
    });
  }

  // Check for existing @fix_plan.md in the selected case
  async checkExistingFixPlan() {
    const caseName = this.ralphWizardConfig.caseName;
    if (!caseName) return;

    try {
      const res = await fetch(`/api/cases/${encodeURIComponent(caseName)}/fix-plan`);
      const data = await res.json();

      if (data.success && data.exists && data.todos?.length > 0) {
        this.ralphWizardConfig.existingPlan = {
          todos: data.todos,
          stats: data.stats,
          content: data.content,
        };
        this.updateExistingPlanUI();
      } else {
        this.ralphWizardConfig.existingPlan = null;
        this.updateExistingPlanUI();
      }
    } catch (err) {
      console.error('Failed to check for existing plan:', err);
      this.ralphWizardConfig.existingPlan = null;
    }
  }

  // Check for existing ralph-wizard research files
  async checkExistingWizardFiles() {
    const caseName = this.ralphWizardConfig.caseName;
    if (!caseName) return;

    try {
      const res = await fetch(`/api/cases/${encodeURIComponent(caseName)}/ralph-wizard/files`);
      const data = await res.json();

      if (data.success && data.data?.files?.length > 0) {
        this.ralphWizardConfig.existingWizardFiles = data.data.files;
        this.updateExistingWizardFilesUI();
      } else {
        this.ralphWizardConfig.existingWizardFiles = null;
        this.updateExistingWizardFilesUI();
      }
    } catch (err) {
      console.error('Failed to check for existing wizard files:', err);
      this.ralphWizardConfig.existingWizardFiles = null;
    }
  }

  // Update UI to show existing wizard files option
  updateExistingWizardFilesUI() {
    const files = this.ralphWizardConfig.existingWizardFiles;
    let section = document.getElementById('existingWizardFilesSection');

    if (!files || files.length === 0) {
      section?.remove();
      return;
    }

    // Count agents with results
    const agentsWithResults = files.filter(f => f.resultFile).length;

    if (!section) {
      // Create the section if it doesn't exist - insert before loading state
      const loadingState = document.getElementById('planGenerationLoading');
      section = document.createElement('div');
      section.id = 'existingWizardFilesSection';
      section.className = 'existing-wizard-files-section';
      loadingState?.parentNode?.insertBefore(section, loadingState);
    }

    section.innerHTML = `
      <div class="existing-wizard-card">
        <div class="existing-wizard-header">
          <span class="existing-wizard-icon">📁</span>
          <span class="existing-wizard-title">Previous Research Found</span>
        </div>
        <p class="existing-wizard-desc">
          Found ${agentsWithResults} agent result${agentsWithResults !== 1 ? 's' : ''} from a previous plan generation.
        </p>
        <div class="existing-wizard-agents">
          ${files.filter(f => f.resultFile).map(f => `
            <span class="existing-wizard-agent">${this.getAgentTypeLabel(f.agentType)}</span>
          `).join('')}
        </div>
        <div class="existing-wizard-actions">
          <button class="btn-toolbar btn-sm btn-primary" onclick="app.reuseExistingWizardFiles()">
            Use Existing Research
          </button>
          <button class="btn-toolbar btn-sm" onclick="app.regenerateAllWizardFiles()">
            Regenerate All
          </button>
        </div>
      </div>
    `;
  }

  getAgentTypeLabel(agentType) {
    const labels = {
      research: 'Research',
      requirements: 'Requirements',
      architecture: 'Architecture',
      testing: 'Testing',
      risks: 'Risks',
      verification: 'Verification',
      execution: 'Execution',
      'final-review': 'Review',
    };
    return labels[agentType] || agentType;
  }

  async reuseExistingWizardFiles() {
    // Load the final result if it exists
    const caseName = this.ralphWizardConfig.caseName;
    try {
      const res = await fetch(`/api/cases/${encodeURIComponent(caseName)}/ralph-wizard/file/${encodeURIComponent('final-result.json')}`);
      const data = await res.json();

      if (data.success && data.data?.parsed?.items) {
        // Use the existing plan items
        this.ralphWizardConfig.generatedPlan = data.data.parsed.items.map((item, idx) => ({
          content: item.content || item.title || `Task ${idx + 1}`,
          priority: item.priority || 'P1',
          enabled: true,
          id: item.id || `reused-${Date.now()}-${idx}`,
          source: item.source,
          rationale: item.rationale,
          tddPhase: item.tddPhase,
        }));
        this.ralphWizardConfig.planGenerated = true;
        this.ralphWizardConfig.reusingExistingFiles = true;
        this.ralphWizardConfig.planCost = 0;

        // Hide the existing files section
        document.getElementById('existingWizardFilesSection')?.remove();

        // Show the plan editor
        this.renderPlanEditor();
        this.updateDetailLevelButtons();
      } else {
        // No final result, just skip to generate with existing research
        this.ralphWizardConfig.reusingExistingFiles = true;
        this.generatePlan();
      }
    } catch (err) {
      console.error('Failed to load existing results:', err);
      // Fall back to regenerating
      this.generatePlan();
    }
  }

  regenerateAllWizardFiles() {
    // Clear the reuse flag and hide the section
    this.ralphWizardConfig.reusingExistingFiles = false;
    document.getElementById('existingWizardFilesSection')?.remove();
    this.generatePlan();
  }

  // Called when case selector changes
  onRalphCaseChange() {
    const caseName = document.getElementById('ralphCaseSelect')?.value;
    if (caseName) {
      this.ralphWizardConfig.caseName = caseName;
      this.ralphWizardConfig.existingPlan = null;
      this.ralphWizardConfig.useExistingPlan = false;
      this.ralphWizardConfig.existingWizardFiles = null;
      this.checkExistingFixPlan();
    }
  }

  // Update UI to show existing plan indicator
  updateExistingPlanUI() {
    const existingPlanBadge = document.getElementById('existingPlanBadge');
    const existingPlanSection = document.getElementById('existingPlanSection');
    const plan = this.ralphWizardConfig.existingPlan;

    if (existingPlanBadge) {
      if (plan) {
        const pending = plan.stats?.pending || 0;
        const total = plan.stats?.total || 0;
        existingPlanBadge.textContent = `${pending}/${total} tasks remaining`;
        existingPlanBadge.style.display = '';
      } else {
        existingPlanBadge.style.display = 'none';
      }
    }

    if (existingPlanSection) {
      if (plan) {
        const pending = plan.stats?.pending || 0;
        const completed = plan.stats?.completed || 0;
        const total = plan.stats?.total || 0;
        existingPlanSection.innerHTML = `
          <div class="existing-plan-card">
            <div class="existing-plan-header">
              <span class="existing-plan-icon">📋</span>
              <span>Existing @fix_plan.md found</span>
            </div>
            <div class="existing-plan-stats">
              <span class="stat pending">${pending} pending</span>
              <span class="stat completed">${completed} completed</span>
              <span class="stat total">${total} total</span>
            </div>
            <div class="existing-plan-actions">
              <button class="btn-toolbar btn-primary btn-sm" onclick="app.useExistingPlan()">
                Use Existing Plan
              </button>
              <button class="btn-toolbar btn-sm" onclick="app.generateNewPlan()">
                Generate New
              </button>
            </div>
          </div>
        `;
        existingPlanSection.classList.remove('hidden');
      } else {
        existingPlanSection.classList.add('hidden');
      }
    }
  }

  // Use the existing @fix_plan.md
  useExistingPlan() {
    const plan = this.ralphWizardConfig.existingPlan;
    if (!plan) return;

    // Stop any ongoing plan generation
    this.stopPlanGeneration();

    // Convert existing todos to generatedPlan format (only pending items)
    const pendingTodos = plan.todos.filter(t => t.status === 'pending' || t.status === 'in_progress');
    this.ralphWizardConfig.generatedPlan = pendingTodos.map((todo, idx) => ({
      content: todo.content,
      priority: todo.priority,
      enabled: true,
      id: `existing-${Date.now()}-${idx}`,
    }));
    this.ralphWizardConfig.planGenerated = true;
    this.ralphWizardConfig.useExistingPlan = true;
    this.ralphWizardConfig.planCost = 0; // No cost for existing plan

    this.renderPlanEditor();
    this.updateDetailLevelButtons();
  }

  // Sync auto-start checkboxes between step 2 and step 3
  syncAutoStartCheckbox(sourceEl) {
    const step2El = document.getElementById('ralphAutoStartStep2');
    const step3El = document.getElementById('ralphAutoStart');
    const isChecked = sourceEl.checked;

    if (step2El) step2El.checked = isChecked;
    if (step3El) step3El.checked = isChecked;

    // Update config
    this.ralphWizardConfig.autoStart = isChecked;
  }

  // Stop any ongoing plan generation (abort fetch, clear timers, hide spinner)
  stopPlanGeneration() {
    // Abort ongoing fetch
    if (this.planGenerationAbortController) {
      this.planGenerationAbortController.abort();
      this.planGenerationAbortController = null;
    }

    // Clear timers
    if (this.planLoadingTimer) {
      clearInterval(this.planLoadingTimer);
      this.planLoadingTimer = null;
    }
    if (this.planPhaseTimer) {
      clearInterval(this.planPhaseTimer);
      this.planPhaseTimer = null;
    }

    // Hide loading spinner
    document.getElementById('planGenerationLoading')?.classList.add('hidden');
  }

  // Generate a new plan (ignore existing)
  generateNewPlan() {
    this.ralphWizardConfig.useExistingPlan = false;
    document.getElementById('existingPlanSection')?.classList.add('hidden');
    this.generatePlan();
  }

  ralphWizardNext() {
    if (this.ralphWizardStep === 1) {
      // Validate step 1
      const taskDescription = document.getElementById('ralphTaskDescription').value.trim();
      const completionPhrase = document.getElementById('ralphCompletionPhrase').value.trim() || 'COMPLETE';
      const caseName = document.getElementById('ralphCaseSelect').value;

      if (!taskDescription) {
        this.showToast('Please enter a task description', 'error');
        document.getElementById('ralphTaskDescription').focus();
        return;
      }

      // Save config
      this.ralphWizardConfig.taskDescription = taskDescription;
      this.ralphWizardConfig.completionPhrase = completionPhrase.toUpperCase();
      this.ralphWizardConfig.caseName = caseName;

      // Move to step 2 (plan generation)
      this.ralphWizardStep = 2;
      this.updateRalphWizardUI();

      // Check for existing wizard files first, then existing plan
      this.checkExistingWizardFiles().then(() => {
        // If there's an existing plan (@fix_plan.md), show the option to use it
        if (this.ralphWizardConfig.existingPlan) {
          this.updateExistingPlanUI();
        } else if (!this.ralphWizardConfig.existingWizardFiles?.length) {
          // No existing files, auto-start plan generation
          this.generatePlan();
        }
        // If existingWizardFiles exists, the UI will show and wait for user choice
      });
    } else if (this.ralphWizardStep === 2) {
      // Must have generated or skipped plan
      if (!this.ralphWizardConfig.planGenerated && !this.ralphWizardConfig.skipPlanGeneration) {
        this.showToast('Wait for plan generation or skip', 'warning');
        return;
      }

      // Generate preview
      this.updateRalphPromptPreview();

      // Move to step 3 (launch)
      this.ralphWizardStep = 3;
      this.updateRalphWizardUI();
    }
  }

  ralphWizardBack() {
    if (this.ralphWizardStep === 3) {
      this.ralphWizardStep = 2;
      this.updateRalphWizardUI();
    } else if (this.ralphWizardStep === 2) {
      this.ralphWizardStep = 1;
      this.updateRalphWizardUI();
    }
  }

  updateRalphWizardUI() {
    const step = this.ralphWizardStep;

    // Update progress indicators
    document.querySelectorAll('.wizard-step').forEach(el => {
      const stepNum = parseInt(el.dataset.step);
      el.classList.toggle('active', stepNum === step);
      el.classList.toggle('completed', stepNum < step);
    });

    // Show/hide pages (now 3 pages)
    document.getElementById('ralphWizardStep1').classList.toggle('hidden', step !== 1);
    document.getElementById('ralphWizardStep2').classList.toggle('hidden', step !== 2);
    document.getElementById('ralphWizardStep3').classList.toggle('hidden', step !== 3);

    // Show/hide buttons
    document.getElementById('ralphBackBtn').style.display = step === 1 ? 'none' : 'block';
    document.getElementById('ralphNextBtn').style.display = step === 3 ? 'none' : 'block';
    document.getElementById('ralphStartBtn').style.display = step === 3 ? 'block' : 'none';
  }

  updateRalphPromptPreview() {
    const config = this.ralphWizardConfig;
    const preview = document.getElementById('ralphPromptPreview');
    const hasPlan = config.generatedPlan && config.generatedPlan.filter(i => i.enabled).length > 0;

    // Build the formatted prompt (abbreviated for preview)
    let prompt = config.taskDescription;
    prompt += '\n\n---\n\n';

    if (hasPlan) {
      prompt += '## Task Plan\n';
      prompt += '📋 @fix_plan.md will be created with your task items\n\n';
    }

    prompt += '## Iteration Protocol\n';
    prompt += '• Check previous work • Make progress • Commit changes\n\n';

    prompt += '## Completion Criteria\n';
    prompt += `Output \`<promise>${config.completionPhrase}</promise>\` when done\n\n`;

    prompt += '## If Stuck\n';
    prompt += 'Output `<promise>BLOCKED</promise>` with explanation';

    // Show preview with highlighting
    const highlightedPrompt = prompt
      .replace(/<promise>/g, '<span class="preview-highlight">&lt;promise&gt;')
      .replace(/<\/promise>/g, '&lt;/promise&gt;</span>')
      .replace(/`([^`]+)`/g, '<code>$1</code>');

    preview.innerHTML = highlightedPrompt;

    // Update summary
    document.getElementById('summaryPhrase').textContent = config.completionPhrase;
    document.getElementById('summaryIterations').textContent =
      config.maxIterations === 0 ? 'Unlimited' : config.maxIterations;
    document.getElementById('summaryCase').textContent = config.caseName;

    // Show plan status in summary if plan was generated
    const planSummary = document.getElementById('summaryPlan');
    if (planSummary) {
      if (config.generatedPlan && config.generatedPlan.length > 0) {
        const enabledCount = config.generatedPlan.filter(i => i.enabled).length;
        planSummary.textContent = `${enabledCount} item${enabledCount !== 1 ? 's' : ''}`;
        planSummary.parentElement.style.display = '';
      } else {
        planSummary.parentElement.style.display = 'none';
      }
    }
  }

  // ========== Plan Generation ==========

  resetPlanGenerationUI() {
    // Hide all plan generation states
    document.getElementById('existingPlanSection')?.classList.add('hidden');
    document.getElementById('planGenerationLoading')?.classList.add('hidden');
    document.getElementById('planGenerationError')?.classList.add('hidden');
    document.getElementById('planEditor')?.classList.add('hidden');

    // Reset spinner visibility (in case it was hidden after "Done!")
    const spinnerEl = document.querySelector('.plan-spinner');
    if (spinnerEl) spinnerEl.style.display = '';

    // Reset stopped indicator
    const stoppedIndicator = document.getElementById('planStoppedIndicator');
    if (stoppedIndicator) stoppedIndicator.style.display = 'none';

    // Reset existing plan badge
    const badge = document.getElementById('existingPlanBadge');
    if (badge) badge.style.display = 'none';
  }

  async generatePlan() {
    const config = this.ralphWizardConfig;
    const isDetailed = config.planDetailLevel === 'detailed';

    // Stop any existing generation first
    this.stopPlanGeneration();

    // Close old plan subagent windows and clear their state
    // This ensures clicking on prompts shows fresh data, not cached from previous runs
    this.closePlanSubagentWindows();

    // Reset stopped flag to allow new SSE events
    this.planGenerationStopped = false;

    // Create abort controller for this generation
    this.planGenerationAbortController = new AbortController();

    // Show loading state, hide other sections
    document.getElementById('existingPlanSection')?.classList.add('hidden');
    document.getElementById('planGenerationError')?.classList.add('hidden');
    document.getElementById('planEditor')?.classList.add('hidden');
    document.getElementById('planGenerationLoading')?.classList.remove('hidden');

    // Different phases for detailed vs standard generation
    const standardPhases = [
      { time: 0, title: 'Starting Opus 4.5...', hint: 'Initializing deep reasoning model' },
      { time: 3, title: 'Analyzing task requirements...', hint: 'Understanding the scope and complexity' },
      { time: 8, title: 'Identifying components...', hint: 'Breaking down into modules and features' },
      { time: 15, title: 'Planning TDD approach...', hint: 'Designing test-first implementation strategy' },
      { time: 25, title: 'Generating implementation steps...', hint: 'Creating detailed action items with tests' },
      { time: 40, title: 'Adding verification checkpoints...', hint: 'Ensuring each phase has validation' },
      { time: 55, title: 'Reviewing for completeness...', hint: 'Checking all requirements are covered' },
      { time: 70, title: 'Finalizing plan...', hint: 'Organizing and prioritizing steps' },
      { time: 90, title: 'Still working...', hint: 'Complex tasks take longer - hang tight!' },
    ];

    const detailedPhases = [
      // Phase 0: Research (can take up to 10 minutes for complex tasks)
      { time: 0, title: 'Starting research agent...', hint: 'Gathering external resources and codebase context' },
      { time: 30, title: 'Research agent working...', hint: 'Searching docs, GitHub repos, and analyzing codebase' },
      { time: 60, title: 'Research continuing...', hint: 'Web search and codebase exploration in progress' },
      { time: 120, title: 'Research agent deep diving...', hint: 'Complex tasks require thorough research' },
      { time: 180, title: 'Research almost complete...', hint: 'Compiling findings and recommendations' },
      // Phase 1: Parallel Analysis (after research completes)
      // Note: These times are fallbacks - real-time SSE updates override them
      { time: 300, title: 'Spawning analysis subagents...', hint: 'Starting 4 specialist agents in parallel' },
      { time: 330, title: 'Subagents analyzing...', hint: 'Requirements, Architecture, Testing, Risk analysts working' },
      { time: 400, title: 'Subagents completing...', hint: 'Collecting analysis results' },
      // Phase 2+: Synthesis and verification
      { time: 450, title: 'Synthesizing results...', hint: 'Merging and deduplicating items' },
      { time: 500, title: 'Running verification...', hint: 'Quality assurance and priority assignment' },
      { time: 550, title: 'Optimizing execution...', hint: 'Planning parallelization for Claude Code' },
      { time: 600, title: 'Final review...', hint: 'Holistic validation and gap detection' },
      { time: 660, title: 'Still working...', hint: 'Complex tasks take longer - hang tight!' },
    ];

    const phases = isDetailed ? detailedPhases : standardPhases;

    // Start elapsed time and phase display
    this.planLoadingStartTime = Date.now();
    const timeEl = document.getElementById('planLoadingTime');
    const titleEl = document.getElementById('planLoadingTitle');
    const hintEl = document.getElementById('planLoadingHint');

    if (timeEl) timeEl.textContent = '0s';
    if (titleEl) titleEl.textContent = phases[0].title;
    if (hintEl) hintEl.textContent = phases[0].hint;

    let currentPhaseIndex = 0;
    this.planLoadingTimer = setInterval(() => {
      const elapsed = Math.floor((Date.now() - this.planLoadingStartTime) / 1000);
      if (timeEl) timeEl.textContent = `${elapsed}s`;

      // Update phase based on elapsed time
      for (let i = phases.length - 1; i >= 0; i--) {
        if (elapsed >= phases[i].time && i > currentPhaseIndex) {
          currentPhaseIndex = i;
          if (titleEl) titleEl.textContent = phases[i].title;
          if (hintEl) hintEl.textContent = phases[i].hint;
          break;
        }
      }
    }, 1000);

    // Listen for real-time progress updates from detailed generation
    const handlePlanProgress = (event) => {
      if (event.type === 'plan:progress' && event.data) {
        const titleEl = document.getElementById('planLoadingTitle');
        const hintEl = document.getElementById('planLoadingHint');
        if (titleEl && event.data.phase) {
          const phaseLabels = {
            'research': 'Research agent working...',
            'parallel-analysis': 'Spawning analysis subagents...',
            'subagent': event.data.detail || 'Subagent working...',
            'synthesis': 'Synthesizing results...',
            'verification': 'Running verification...',
            'review-injection': 'Adding review tasks...',
            'execution-optimization': 'Optimizing for Claude Code...',
            'final-review': 'Running final review...',
          };
          titleEl.textContent = phaseLabels[event.data.phase] || event.data.phase;
        }
        if (hintEl && event.data.detail) {
          hintEl.textContent = event.data.detail;
        }
      }
    };

    // Add SSE listener for detailed mode progress
    if (isDetailed) {
      this._planProgressHandler = handlePlanProgress;
    }

    try {
      // Use different endpoint for detailed mode
      const endpoint = isDetailed ? '/api/generate-plan-detailed' : '/api/generate-plan';
      const body = isDetailed
        ? { taskDescription: config.taskDescription, caseName: config.caseName }
        : { taskDescription: config.taskDescription, detailLevel: config.planDetailLevel };

      // Retry logic for network errors
      const maxRetries = 3;
      let lastError = null;
      let data = null;

      for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
          const res = await fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal: this.planGenerationAbortController?.signal,
          });
          data = await res.json();
          break; // Success, exit retry loop
        } catch (fetchErr) {
          lastError = fetchErr;
          // Don't retry if aborted
          if (fetchErr.name === 'AbortError') throw fetchErr;
          // Network error - retry with exponential backoff
          console.warn(`[Plan] Fetch attempt ${attempt + 1} failed:`, fetchErr.message);
          if (attempt < maxRetries - 1) {
            const delay = Math.pow(2, attempt) * 1000; // 1s, 2s, 4s
            const titleEl = document.getElementById('planLoadingTitle');
            const hintEl = document.getElementById('planLoadingHint');
            if (titleEl) titleEl.textContent = 'Connection lost, retrying...';
            if (hintEl) hintEl.textContent = `Attempt ${attempt + 2} of ${maxRetries} in ${delay / 1000}s`;
            await new Promise(r => setTimeout(r, delay));
          }
        }
      }

      if (!data) {
        throw lastError || new Error('Failed to fetch after retries');
      }

      // Stop timer
      if (this.planLoadingTimer) {
        clearInterval(this.planLoadingTimer);
        this.planLoadingTimer = null;
      }

      // Remove progress handler
      this._planProgressHandler = null;

      if (!data.success) {
        this.showPlanError(data.error || 'Failed to generate plan');
        return;
      }

      if (!data.data?.items || data.data.items.length === 0) {
        this.showPlanError('No plan items generated. Try adding more detail to your task.');
        return;
      }

      // Show "Done!" with quality info for detailed mode
      const doneTitle = document.getElementById('planLoadingTitle');
      const doneHint = document.getElementById('planLoadingHint');
      const spinnerEl = document.querySelector('.plan-spinner');

      if (doneTitle) doneTitle.textContent = 'Done!';
      if (doneHint) {
        if (isDetailed && data.data.metadata?.qualityScore) {
          const quality = Math.round(data.data.metadata.qualityScore * 100);
          doneHint.textContent = `Generated ${data.data.items.length} steps (Quality: ${quality}%)`;
        } else {
          doneHint.textContent = `Generated ${data.data.items.length} steps`;
        }
      }
      if (spinnerEl) spinnerEl.style.display = 'none';

      // Brief pause to show "Done!" before showing editor
      await new Promise(r => setTimeout(r, 500));

      // Store plan with enabled state and IDs
      config.generatedPlan = data.data.items.map((item, idx) => ({
        ...item,
        enabled: true,
        id: `plan-${Date.now()}-${idx}`,
      }));
      config.planGenerated = true;
      config.skipPlanGeneration = false;
      config.planCost = data.data.costUsd || 0;

      // Store metadata for detailed mode
      if (isDetailed && data.data.metadata) {
        config.planMetadata = data.data.metadata;
      }

      // Show editor and update detail buttons
      this.renderPlanEditor();
      this.updateDetailLevelButtons();

      // Check for auto-start
      if (this.ralphWizardConfig.autoStart) {
        console.log('[RalphWizard] Auto-start enabled, starting loop automatically...');
        this.showToast('Plan complete! Auto-starting Ralph Loop...', 'success');
        // Small delay to let user see the plan briefly
        await new Promise(r => setTimeout(r, 1500));
        this.startRalphLoop();
      }

    } catch (err) {
      // Stop timer
      if (this.planLoadingTimer) {
        clearInterval(this.planLoadingTimer);
        this.planLoadingTimer = null;
      }

      // Remove progress handler
      this._planProgressHandler = null;

      // Ignore abort errors (user cancelled, e.g., clicked "Use Existing Plan")
      if (err.name === 'AbortError') {
        console.log('Plan generation aborted by user');
        return;
      }

      console.error('Plan generation failed:', err);
      this.showPlanError('Network error: ' + err.message);
    }
  }

  setPlanDetail(level) {
    const previousLevel = this.ralphWizardConfig.planDetailLevel;
    this.ralphWizardConfig.planDetailLevel = level;
    this.updateDetailLevelButtons();

    // If plan was already generated and level changed, automatically regenerate
    if (this.ralphWizardConfig.planGenerated && previousLevel !== level) {
      const modeLabel = level === 'detailed' ? 'Enhanced (Multi-Agent)' : level === 'brief' ? 'Brief' : 'Standard';
      console.log(`[Ralph Wizard] Plan mode changed to ${modeLabel}, regenerating...`);

      // Clear current plan and regenerate
      this.ralphWizardConfig.generatedPlan = null;
      this.ralphWizardConfig.planGenerated = false;
      this.ralphWizardConfig.planMetadata = null;

      // Trigger regeneration with visual feedback
      this.generatePlan();
    }
  }

  updateDetailLevelButtons() {
    const level = this.ralphWizardConfig.planDetailLevel;
    document.querySelectorAll('.plan-detail-btn').forEach(btn => {
      const isActive = btn.dataset.detail === level;
      btn.classList.toggle('active', isActive);

      // Add visual indicator for enhanced mode
      if (btn.dataset.detail === 'detailed') {
        btn.title = 'Enhanced: Uses 4 parallel subagents + verification (slower but more thorough)';
      } else if (btn.dataset.detail === 'standard') {
        btn.title = 'Standard: Single-pass generation with Opus 4.5';
      } else {
        btn.title = 'Brief: High-level milestones only';
      }
    });
  }

  showPlanError(message) {
    document.getElementById('planGenerationLoading')?.classList.add('hidden');
    document.getElementById('planEditor')?.classList.add('hidden');

    const errorEl = document.getElementById('planGenerationError');
    const msgEl = document.getElementById('planErrorMsg');
    const stoppedIndicator = document.getElementById('planStoppedIndicator');

    // Hide the stopped indicator for real errors, show error message
    if (stoppedIndicator) stoppedIndicator.style.display = 'none';
    if (msgEl) msgEl.textContent = message;
    errorEl?.classList.remove('hidden');
  }

  // Plan view mode: 'list' (flat) or 'grouped' (by TDD phase)
  planViewMode = 'list';

  renderPlanEditor() {
    document.getElementById('planGenerationLoading')?.classList.add('hidden');
    document.getElementById('planGenerationError')?.classList.add('hidden');
    document.getElementById('planEditor')?.classList.remove('hidden');

    // Close plan subagent windows since generation is complete
    this.closePlanSubagentWindows();

    const list = document.getElementById('planItemsList');
    if (!list) return;

    list.innerHTML = '';
    const items = this.ralphWizardConfig.generatedPlan || [];
    const cost = this.ralphWizardConfig.planCost || 0;
    const metadata = this.ralphWizardConfig.planMetadata;

    // Update header with item count, cost, and quality score if available
    const statsEl = document.getElementById('planStats');
    if (statsEl) {
      let statsText = `${items.length} steps · $${cost.toFixed(3)}`;

      // Show quality score and source info for detailed mode
      if (metadata) {
        const quality = Math.round(metadata.qualityScore * 100);
        const qualityClass = quality >= 80 ? 'quality-high' : quality >= 60 ? 'quality-medium' : 'quality-low';
        statsText = `<span class="${qualityClass}">${quality}% quality</span> · ${items.length} steps · $${cost.toFixed(3)}`;

        // Add subagent breakdown if available
        if (metadata.synthesisStats?.sourceBreakdown) {
          const sources = metadata.synthesisStats.sourceBreakdown;
          const sourceList = Object.entries(sources)
            .map(([src, count]) => `${src}: ${count}`)
            .join(', ');
          statsText += ` · Sources: ${sourceList}`;
        }
      }

      statsEl.innerHTML = statsText;
    }

    // Show warnings/gaps if present from verification
    const warningsEl = document.getElementById('planWarnings');
    if (warningsEl) {
      if (metadata?.verificationWarnings?.length > 0 || metadata?.verificationGaps?.length > 0) {
        let warningsHtml = '';
        if (metadata.verificationGaps?.length > 0) {
          warningsHtml += `<div class="plan-gaps"><strong>Gaps identified:</strong> ${metadata.verificationGaps.join('; ')}</div>`;
        }
        if (metadata.verificationWarnings?.length > 0) {
          warningsHtml += `<div class="plan-warnings"><strong>Warnings:</strong> ${metadata.verificationWarnings.join('; ')}</div>`;
        }
        warningsEl.innerHTML = warningsHtml;
        warningsEl.classList.remove('hidden');
      } else {
        warningsEl.classList.add('hidden');
      }
    }

    // Render based on view mode - use DocumentFragment for batch DOM updates
    if (this.planViewMode === 'grouped' && items.some(i => i.tddPhase)) {
      this.renderPlanItemsGrouped(list, items);
    } else {
      // Flat list view with DocumentFragment for performance
      const fragment = document.createDocumentFragment();
      items.forEach((item, index) => {
        const row = this.renderPlanItem(item, index);
        fragment.appendChild(row);
      });
      list.appendChild(fragment);
    }
  }

  // Render plan items grouped by TDD phase - uses DocumentFragment for batch DOM updates
  renderPlanItemsGrouped(container, items) {
    const phases = ['setup', 'test', 'impl', 'review', 'verify', null];
    const phaseLabels = {
      setup: { label: 'Setup', icon: '🔧' },
      test: { label: 'Tests', icon: '🧪' },
      impl: { label: 'Implementation', icon: '💻' },
      review: { label: 'Code Review', icon: '🔍' },
      verify: { label: 'Verification', icon: '✅' },
      null: { label: 'Other', icon: '📋' },
    };

    // First, create indexed items to preserve original positions (non-mutating)
    const indexedItems = items.map((item, idx) => ({ ...item, _originalIndex: idx }));

    // Build all DOM elements in a DocumentFragment first (no reflows)
    const fragment = document.createDocumentFragment();

    phases.forEach(phase => {
      // Filter using indexed items
      const phaseItems = indexedItems.filter(item => (item.tddPhase || null) === phase);

      if (phaseItems.length === 0) return;

      const phaseKey = phase || 'null';
      const { label, icon } = phaseLabels[phaseKey];

      // Create group header
      const header = document.createElement('div');
      header.className = 'plan-group-header';
      header.dataset.phase = phaseKey;
      header.innerHTML = `
        <span class="group-icon">${icon}</span>
        <span class="group-label">${label}</span>
        <span class="group-count">${phaseItems.length}</span>
        <span class="group-chevron">&#x25BC;</span>
      `;
      header.onclick = () => this.togglePlanGroup(phaseKey);
      fragment.appendChild(header);

      // Create group items container
      const groupItems = document.createElement('div');
      groupItems.className = 'plan-group-items';
      groupItems.dataset.phase = phaseKey;

      phaseItems.forEach(item => {
        const row = this.renderPlanItem(item, item._originalIndex);
        groupItems.appendChild(row);
      });

      fragment.appendChild(groupItems);
    });

    // Single DOM operation - append all at once
    container.appendChild(fragment);
  }

  togglePlanGroup(phase) {
    const header = document.querySelector(`.plan-group-header[data-phase="${phase}"]`);
    const items = document.querySelector(`.plan-group-items[data-phase="${phase}"]`);

    if (header && items) {
      header.classList.toggle('collapsed');
      items.classList.toggle('collapsed');
    }
  }

  setPlanViewMode(mode) {
    this.planViewMode = mode;

    // Update view toggle buttons
    document.querySelectorAll('.plan-view-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.view === mode);
    });

    this.renderPlanEditor();
  }

  renderPlanItem(item, index) {
    const row = document.createElement('div');

    // Build class with priority indicator
    let className = 'plan-item';
    if (item.priority) {
      className += ` priority-${item.priority.toLowerCase()}`;
    }
    row.className = className;
    row.dataset.index = index;
    row.draggable = true;

    // Add TDD phase badge with enhanced styling
    const phaseIcon = this.getTddPhaseIcon(item.tddPhase);
    const phaseClass = item.tddPhase ? `phase-${item.tddPhase}` : '';
    const phaseTitle = item.tddPhase ? `TDD Phase: ${item.tddPhase}` : '';

    // Build verification tooltip
    const verificationTitle = item.verificationCriteria
      ? `Verification: ${item.verificationCriteria}`
      : '';

    // Dependencies indicator
    const depsCount = item.dependencies?.length || 0;
    const depsTitle = depsCount > 0
      ? `Depends on: ${item.dependencies.join(', ')}`
      : '';

    // Review checklist indicator for review phase tasks
    const checklistCount = item.reviewChecklist?.length || 0;
    const checklistTitle = checklistCount > 0
      ? `Review Checklist:\n• ${item.reviewChecklist.join('\n• ')}`
      : '';

    row.innerHTML = `
      <span class="plan-item-drag" title="Drag to reorder">&#x2630;</span>
      <input type="checkbox" class="plan-item-checkbox" ${item.enabled ? 'checked' : ''}
        onchange="app.togglePlanItem(${index})">
      ${phaseIcon ? `<span class="plan-item-phase ${phaseClass}" title="${phaseTitle}">${phaseIcon}</span>` : ''}
      <input type="text" class="plan-item-content" value="${this.escapeHtml(item.content)}"
        onchange="app.updatePlanItemContent(${index}, this.value)"
        placeholder="Implementation step...">
      <select class="plan-item-priority" onchange="app.updatePlanItemPriority(${index}, this.value)">
        <option value="" ${!item.priority ? 'selected' : ''}>-</option>
        <option value="P0" ${item.priority === 'P0' ? 'selected' : ''}>P0</option>
        <option value="P1" ${item.priority === 'P1' ? 'selected' : ''}>P1</option>
        <option value="P2" ${item.priority === 'P2' ? 'selected' : ''}>P2</option>
      </select>
      ${depsCount > 0 ? `<span class="plan-item-deps" title="${this.escapeHtml(depsTitle)}">&#x2197; ${depsCount}</span>` : ''}
      ${item.verificationCriteria ? `<span class="plan-item-verify" title="${this.escapeHtml(verificationTitle)}">&#x2713; verify</span>` : ''}
      ${checklistCount > 0 ? `<span class="plan-item-checklist" title="${this.escapeHtml(checklistTitle)}">&#x2611; ${checklistCount}</span>` : ''}
      <div class="plan-item-actions">
        <button class="plan-item-action" onclick="app.editPlanItemVerification(${index})" title="Edit verification">&#x270E;</button>
        ${checklistCount > 0 ? `<button class="plan-item-action" onclick="app.showReviewChecklist(${index})" title="View checklist">&#x2630;</button>` : ''}
        <button class="plan-item-action" onclick="app.duplicatePlanItem(${index})" title="Duplicate">&#x2398;</button>
      </div>
      <button class="plan-item-remove" onclick="app.removePlanItem(${index})" title="Remove">&times;</button>
    `;

    // Add drag-and-drop event handlers
    row.addEventListener('dragstart', (e) => this.handlePlanItemDragStart(e, index));
    row.addEventListener('dragend', (e) => this.handlePlanItemDragEnd(e));
    row.addEventListener('dragover', (e) => this.handlePlanItemDragOver(e));
    row.addEventListener('drop', (e) => this.handlePlanItemDrop(e, index));

    return row;
  }

  // Drag and drop handlers for plan items
  handlePlanItemDragStart(e, index) {
    this._draggedPlanIndex = index;
    e.target.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', index);
  }

  handlePlanItemDragEnd(e) {
    e.target.classList.remove('dragging');
    // Remove drag-over class from all items
    document.querySelectorAll('.plan-item.drag-over').forEach(el => {
      el.classList.remove('drag-over');
    });
    this._draggedPlanIndex = null;
  }

  handlePlanItemDragOver(e) {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';

    const item = e.target.closest('.plan-item');
    if (item && !item.classList.contains('dragging')) {
      // Remove drag-over from other items
      document.querySelectorAll('.plan-item.drag-over').forEach(el => {
        if (el !== item) el.classList.remove('drag-over');
      });
      item.classList.add('drag-over');
    }
  }

  handlePlanItemDrop(e, targetIndex) {
    e.preventDefault();
    const sourceIndex = this._draggedPlanIndex;

    if (sourceIndex !== null && sourceIndex !== targetIndex) {
      const plan = this.ralphWizardConfig.generatedPlan;
      if (plan) {
        // Move the item
        const [movedItem] = plan.splice(sourceIndex, 1);
        plan.splice(targetIndex, 0, movedItem);
        this.renderPlanEditor();
      }
    }
  }

  // Edit verification criteria inline
  editPlanItemVerification(index) {
    const plan = this.ralphWizardConfig.generatedPlan;
    if (!plan || !plan[index]) return;

    const currentCriteria = plan[index].verificationCriteria || '';
    const newCriteria = prompt('Verification criteria:', currentCriteria);

    if (newCriteria !== null) {
      plan[index].verificationCriteria = newCriteria.trim() || undefined;
      this.renderPlanEditor();
    }
  }

  // Duplicate a plan item
  duplicatePlanItem(index) {
    const plan = this.ralphWizardConfig.generatedPlan;
    if (!plan || !plan[index]) return;

    const original = plan[index];
    const duplicate = {
      ...original,
      id: `plan-${Date.now()}-dup`,
      content: original.content + ' (copy)',
    };
    plan.splice(index + 1, 0, duplicate);
    this.renderPlanEditor();
  }

  showReviewChecklist(index) {
    const plan = this.ralphWizardConfig.generatedPlan;
    if (!plan || !plan[index]) return;

    const item = plan[index];
    if (!item.reviewChecklist || item.reviewChecklist.length === 0) return;

    // Create modal content
    const checklistHtml = item.reviewChecklist.map((check, i) => `
      <li class="checklist-item">
        <input type="checkbox" id="check-${i}" class="checklist-checkbox">
        <label for="check-${i}">${this.escapeHtml(check)}</label>
      </li>
    `).join('');

    const content = `
      <div class="checklist-modal">
        <h3>Review Checklist</h3>
        <p class="checklist-task">${this.escapeHtml(item.content)}</p>
        <ul class="checklist-list">
          ${checklistHtml}
        </ul>
        <div class="checklist-footer">
          <button class="btn-toolbar" onclick="this.closest('.modal').remove()">Close</button>
        </div>
      </div>
    `;

    // Show in a modal
    const modal = document.createElement('div');
    modal.className = 'modal checklist-modal-container';
    modal.innerHTML = `<div class="modal-content modal-sm">${content}</div>`;
    modal.onclick = (e) => { if (e.target === modal) modal.remove(); };
    document.body.appendChild(modal);
  }

  getTddPhaseIcon(phase) {
    switch (phase) {
      case 'setup': return '🔧';
      case 'test': return '🧪';
      case 'impl': return '💻';
      case 'verify': return '✅';
      case 'review': return '🔍';
      default: return '';
    }
  }

  escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  togglePlanItem(index) {
    const plan = this.ralphWizardConfig.generatedPlan;
    if (plan && plan[index]) {
      plan[index].enabled = !plan[index].enabled;
      this.renderPlanEditor();
    }
  }

  updatePlanItemContent(index, value) {
    const plan = this.ralphWizardConfig.generatedPlan;
    if (plan && plan[index]) {
      plan[index].content = value.trim();
    }
  }

  updatePlanItemPriority(index, value) {
    const plan = this.ralphWizardConfig.generatedPlan;
    if (plan && plan[index]) {
      plan[index].priority = value || null;
    }
  }

  removePlanItem(index) {
    const plan = this.ralphWizardConfig.generatedPlan;
    if (plan) {
      plan.splice(index, 1);
      this.renderPlanEditor();
    }
  }

  addPlanItem() {
    const plan = this.ralphWizardConfig.generatedPlan || [];
    plan.push({
      content: '',
      priority: null,
      enabled: true,
      id: `plan-${Date.now()}-new`,
    });
    this.ralphWizardConfig.generatedPlan = plan;
    this.renderPlanEditor();

    // Focus the new item's input
    setTimeout(() => {
      const list = document.getElementById('planItemsList');
      const lastInput = list?.querySelector('.plan-item:last-child .plan-item-content');
      lastInput?.focus();
    }, 50);
  }

  async cancelPlanGeneration() {
    this.stopPlanGeneration();
    this.planGenerationStopped = true; // Ignore future SSE events

    // Call the cancel API to stop server-side processing
    if (this.activePlanOrchestratorId) {
      try {
        console.log('[Cancel] Sending cancel request for', this.activePlanOrchestratorId);
        await fetch('/api/cancel-plan-generation', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ orchestratorId: this.activePlanOrchestratorId }),
        });
        this.activePlanOrchestratorId = null;
      } catch (err) {
        console.error('[Cancel] Failed to cancel plan generation:', err);
      }
    }

    this.showToast('Plan generation stopped', 'info');

    // Allow user to proceed without a plan by clicking Next
    this.ralphWizardConfig.skipPlanGeneration = true;

    // Show stopped state with clear visual indicator
    const errorEl = document.getElementById('planGenerationError');
    const msgEl = document.getElementById('planErrorMsg');
    const stoppedIndicator = document.getElementById('planStoppedIndicator');

    // Show the stopped indicator, hide error message since this was intentional
    if (stoppedIndicator) stoppedIndicator.style.display = 'flex';
    if (msgEl) msgEl.textContent = '';

    // Hide spinner immediately and show stopped state
    document.getElementById('planGenerationLoading')?.classList.add('hidden');
    errorEl?.classList.remove('hidden');

    // Close all plan subagent windows
    this.closePlanSubagentWindows();
  }

  // ========== Plan Subagent Windows (Visible Opus Agents) ==========

  handlePlanSubagentEvent(event) {
    // Ignore events if user has stopped plan generation
    if (this.planGenerationStopped) return;

    const { type, agentId, agentType, model, status, detail, itemCount, durationMs, error } = event;

    if (type === 'started') {
      // Create new plan subagent window
      this.createPlanSubagentWindow(agentId, agentType, model, detail);
    } else if (type === 'completed' || type === 'failed') {
      // Update window to show completion/failure
      this.updatePlanSubagentWindow(agentId, status, itemCount, durationMs, error);
    } else if (type === 'progress') {
      // Update progress detail
      const windowData = this.planSubagents.get(agentId);
      if (windowData?.element) {
        const detailEl = windowData.element.querySelector('.plan-subagent-detail');
        if (detailEl) detailEl.textContent = detail || '';
      }
    }

    // Update monitor panel to show plan agents
    this.renderMonitorPlanAgents();
  }

  /**
   * Find a free position for a window that doesn't overlap with existing windows.
   * Tries positions around the wizard, avoiding all occupied spaces.
   */
  findFreeWindowPosition(windowWidth, windowHeight, wizardRect, preferredSide = 'right') {
    const gap = 30;
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const minY = 60;
    const maxY = viewportHeight - windowHeight - 10;

    // Collect all occupied rectangles (plan subagent windows + regular subagent windows)
    const occupiedRects = [];

    // Add wizard rect as occupied
    if (wizardRect) {
      occupiedRects.push({
        left: wizardRect.left - gap,
        top: wizardRect.top,
        right: wizardRect.right + gap,
        bottom: wizardRect.bottom,
      });
    }

    // Add existing plan subagent windows
    for (const [, windowData] of this.planSubagents) {
      if (windowData.element) {
        const rect = windowData.element.getBoundingClientRect();
        occupiedRects.push({
          left: rect.left,
          top: rect.top,
          right: rect.right,
          bottom: rect.bottom,
        });
      }
    }

    // Add regular subagent windows
    for (const [, windowInfo] of this.subagentWindows) {
      if (windowInfo.element && !windowInfo.hidden && !windowInfo.minimized) {
        const rect = windowInfo.element.getBoundingClientRect();
        occupiedRects.push({
          left: rect.left,
          top: rect.top,
          right: rect.right,
          bottom: rect.bottom,
        });
      }
    }

    // Check if a position overlaps with any occupied rectangle
    const overlaps = (x, y) => {
      const newRect = {
        left: x,
        top: y,
        right: x + windowWidth,
        bottom: y + windowHeight,
      };
      return occupiedRects.some(rect =>
        newRect.left < rect.right &&
        newRect.right > rect.left &&
        newRect.top < rect.bottom &&
        newRect.bottom > rect.top
      );
    };

    // Try positions on preferred side first, then other side
    const sides = preferredSide === 'right' ? ['right', 'left'] : ['left', 'right'];

    for (const side of sides) {
      // Calculate base X position for this side
      let baseX;
      if (wizardRect) {
        if (side === 'right') {
          baseX = wizardRect.right + gap;
        } else {
          baseX = wizardRect.left - windowWidth - gap;
        }
      } else {
        baseX = side === 'right' ? viewportWidth - windowWidth - 50 : 50;
      }

      // Clamp to viewport
      baseX = Math.max(10, Math.min(baseX, viewportWidth - windowWidth - 10));

      // Try vertical positions from top to bottom
      for (let y = minY; y <= maxY; y += windowHeight + 15) {
        if (!overlaps(baseX, y)) {
          return { x: baseX, y };
        }
      }

      // If side is full, try additional columns
      const columnOffset = side === 'right' ? windowWidth + gap : -(windowWidth + gap);
      for (let col = 1; col <= 2; col++) {
        const x = baseX + col * columnOffset;
        if (x < 10 || x > viewportWidth - windowWidth - 10) continue;

        for (let y = minY; y <= maxY; y += windowHeight + 15) {
          if (!overlaps(x, y)) {
            return { x, y };
          }
        }
      }
    }

    // Fallback: cascade position
    const fallbackOffset = this.planSubagents.size * 30;
    return {
      x: Math.min(50 + fallbackOffset, viewportWidth - windowWidth - 10),
      y: Math.min(120 + fallbackOffset, maxY),
    };
  }

  createPlanSubagentWindow(agentId, agentType, model, detail) {
    if (this.planSubagents.has(agentId)) return;

    const wizardModal = document.getElementById('ralphWizardModal');
    const wizardContent = wizardModal?.querySelector('.modal-content');
    const wizardRect = wizardContent?.getBoundingClientRect();

    // Calculate position using smart positioning that avoids overlaps
    const windowWidth = 280;
    const windowHeight = 100;
    const windowCount = this.planSubagents.size;

    // Alternate preferred side: even=right, odd=left
    const preferredSide = windowCount % 2 === 0 ? 'right' : 'left';
    const { x, y } = this.findFreeWindowPosition(windowWidth, windowHeight, wizardRect, preferredSide);

    // Create window element
    const win = document.createElement('div');
    win.className = 'plan-subagent-window';
    win.id = `plan-subagent-${agentId}`;
    win.style.left = `${x}px`;
    win.style.top = `${y}px`;
    win.style.zIndex = ++this.planSubagentWindowZIndex;

    const typeLabels = {
      research: 'Research Agent',
      requirements: 'Requirements Analyst',
      architecture: 'Architecture Planner',
      testing: 'TDD Specialist',
      risks: 'Risk Analyst',
      verification: 'Verification Expert',
      execution: 'Execution Optimizer',
      'final-review': 'Final Review',
    };

    const typeIcons = {
      research: '🔬',
      requirements: '📋',
      architecture: '🏗️',
      testing: '🧪',
      risks: '⚠️',
      verification: '✓',
      execution: '⚡',
      'final-review': '🔍',
    };

    win.innerHTML = `
      <div class="plan-subagent-header">
        <span class="plan-subagent-prompt-link" data-agent-id="${agentId}" data-agent-type="${agentType}" title="Click to view prompt">
          <span class="plan-subagent-icon">${typeIcons[agentType] || '🤖'}</span>
          <span class="plan-subagent-title">${typeLabels[agentType] || agentType}</span>
        </span>
        <span class="plan-subagent-model">${model}</span>
      </div>
      <div class="plan-subagent-body">
        <div class="plan-subagent-status running">
          <span class="plan-subagent-spinner"></span>
          <span class="plan-subagent-status-text">Running...</span>
        </div>
        <div class="plan-subagent-detail">${detail || ''}</div>
      </div>
    `;

    // Add click handler for prompt link
    const promptLink = win.querySelector('.plan-subagent-prompt-link');
    promptLink.addEventListener('click', (e) => {
      e.stopPropagation();
      this.showPlanAgentPrompt(agentId, agentType);
    });

    document.body.appendChild(win);

    // Calculate relative position to wizard
    let relativePos = null;
    if (wizardRect) {
      relativePos = {
        dx: x - wizardRect.left,
        dy: y - wizardRect.top,
      };
    }

    // Make the window draggable
    const header = win.querySelector('.plan-subagent-header');
    const dragListeners = this.makePlanSubagentDraggable(win, header);

    // Store reference with relative position and drag listeners
    this.planSubagents.set(agentId, {
      agentId,
      type: agentType,
      model,
      status: 'running',
      startTime: Date.now(),
      element: win,
      relativePos,
      dragListeners,
    });

    // If agents are minimized, hide this new window too
    if (this.planAgentsMinimized) {
      win.style.display = 'none';
    }

    // Update wizard agent count button
    this.updateWizardAgentCount();

    // Update connection lines
    this.updateConnectionLines();
  }

  makePlanSubagentDraggable(win, handle) {
    let isDragging = false;
    let startX, startY, startLeft, startTop;
    let dragUpdateScheduled = false;

    const mousedownHandler = (e) => {
      isDragging = true;
      startX = e.clientX;
      startY = e.clientY;
      startLeft = parseInt(win.style.left) || 0;
      startTop = parseInt(win.style.top) || 0;
      win.style.zIndex = ++this.planSubagentWindowZIndex;
      e.preventDefault();
    };

    const moveHandler = (e) => {
      if (!isDragging) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;

      // Constrain to viewport
      const winWidth = win.offsetWidth || 280;
      const winHeight = win.offsetHeight || 100;
      const maxX = window.innerWidth - winWidth - 10;
      const maxY = window.innerHeight - winHeight - 10;
      const newLeft = Math.max(10, Math.min(startLeft + dx, maxX));
      const newTop = Math.max(10, Math.min(startTop + dy, maxY));

      win.style.left = `${newLeft}px`;
      win.style.top = `${newTop}px`;

      // Throttle connection line updates
      if (!dragUpdateScheduled) {
        dragUpdateScheduled = true;
        requestAnimationFrame(() => {
          this.updateConnectionLines();
          dragUpdateScheduled = false;
        });
      }
    };

    const upHandler = () => {
      isDragging = false;
    };

    handle.addEventListener('mousedown', mousedownHandler);
    document.addEventListener('mousemove', moveHandler);
    document.addEventListener('mouseup', upHandler);

    return { mousedown: mousedownHandler, move: moveHandler, up: upHandler };
  }

  updatePlanSubagentWindow(agentId, status, itemCount, durationMs, error) {
    const windowData = this.planSubagents.get(agentId);
    if (!windowData?.element) return;

    const win = windowData.element;
    const statusEl = win.querySelector('.plan-subagent-status');
    const statusTextEl = win.querySelector('.plan-subagent-status-text');
    const spinnerEl = win.querySelector('.plan-subagent-spinner');
    const detailEl = win.querySelector('.plan-subagent-detail');

    windowData.status = status;
    windowData.itemCount = itemCount;

    if (status === 'completed') {
      statusEl?.classList.remove('running');
      statusEl?.classList.add('completed');
      if (spinnerEl) spinnerEl.style.display = 'none';
      if (statusTextEl) {
        statusTextEl.textContent = `Done (${itemCount || 0} items)`;
        statusTextEl.classList.add('clickable');
        statusTextEl.title = 'Click to view result files';
        statusTextEl.onclick = (e) => {
          e.stopPropagation();
          this.showPlanAgentFiles(windowData.agentId, windowData.type);
        };
      }
      if (detailEl && durationMs) detailEl.textContent = `${(durationMs / 1000).toFixed(1)}s`;
    } else if (status === 'failed' || status === 'cancelled') {
      statusEl?.classList.remove('running');
      statusEl?.classList.add('failed');
      if (spinnerEl) spinnerEl.style.display = 'none';
      if (statusTextEl) statusTextEl.textContent = status === 'cancelled' ? 'Cancelled' : 'Failed';
      if (detailEl) detailEl.textContent = error || '';
    }

    // Update minimized tab if agents are hidden
    if (this.planAgentsMinimized) {
      this.createAgentsMinimizedTab();
    }

    // Update connection lines
    this.updateConnectionLines();
  }

  closePlanSubagentWindows() {
    for (const [agentId, windowData] of this.planSubagents) {
      // Clean up drag listeners
      if (windowData.dragListeners) {
        document.removeEventListener('mousemove', windowData.dragListeners.move);
        document.removeEventListener('mouseup', windowData.dragListeners.up);
        if (windowData.dragListeners.touchMove) {
          document.removeEventListener('touchmove', windowData.dragListeners.touchMove);
          document.removeEventListener('touchend', windowData.dragListeners.up);
          document.removeEventListener('touchcancel', windowData.dragListeners.up);
        }
      }
      if (windowData.element) {
        windowData.element.remove();
      }
    }
    this.planSubagents.clear();
    this.updateWizardAgentCount();
    this.removeAgentsMinimizedTab();
    this.updateConnectionLines();
    // Update monitor panel (will hide section if no agents)
    this.renderMonitorPlanAgents();
  }

  // ========== Wizard Dragging ==========

  setupWizardDragging() {
    const modal = document.getElementById('ralphWizardModal');
    const wizardContent = modal?.querySelector('.modal-content');
    const header = wizardContent?.querySelector('.modal-header');
    if (!wizardContent || !header) return;

    // Clean up any existing listeners
    this.cleanupWizardDragging();

    let isDragging = false;
    let startX, startY, startLeft, startTop;
    let dragUpdateScheduled = false;
    let agentStartPositions = new Map(); // Track agent window start positions during drag

    const startHandler = (e) => {
      // Don't drag if clicking buttons
      if (e.target.tagName === 'BUTTON' || e.target.closest('button')) return;

      isDragging = true;

      // If wizard hasn't been moved yet, calculate its current centered position
      if (!this.wizardPosition) {
        const rect = wizardContent.getBoundingClientRect();
        this.wizardPosition = { left: rect.left, top: rect.top };
      }

      const coords = getEventCoords(e);
      startX = coords.clientX;
      startY = coords.clientY;
      startLeft = this.wizardPosition.left;
      startTop = this.wizardPosition.top;

      // Capture agent window start positions
      agentStartPositions.clear();
      for (const [agentId, windowData] of this.planSubagents) {
        if (windowData.element) {
          agentStartPositions.set(agentId, {
            left: parseInt(windowData.element.style.left) || 0,
            top: parseInt(windowData.element.style.top) || 0,
          });
        }
      }

      // Switch to absolute positioning
      wizardContent.classList.add('draggable');
      wizardContent.style.left = `${startLeft}px`;
      wizardContent.style.top = `${startTop}px`;

      // Add move/end listeners only during drag (prevents blocking scroll)
      document.addEventListener('mousemove', moveHandler);
      document.addEventListener('mouseup', upHandler);
      document.addEventListener('touchmove', moveHandler, { passive: false });
      document.addEventListener('touchend', upHandler);

      e.preventDefault();
    };

    const moveHandler = (e) => {
      if (!isDragging) return;

      const coords = getEventCoords(e);
      const dx = coords.clientX - startX;
      const dy = coords.clientY - startY;

      // Constrain to viewport
      const winWidth = wizardContent.offsetWidth || 480;
      const winHeight = wizardContent.offsetHeight || 400;
      const maxX = window.innerWidth - winWidth - 10;
      const maxY = window.innerHeight - winHeight - 10;
      const newLeft = Math.max(10, Math.min(startLeft + dx, maxX));
      const newTop = Math.max(10, Math.min(startTop + dy, maxY));

      this.wizardPosition = { left: newLeft, top: newTop };
      wizardContent.style.left = `${newLeft}px`;
      wizardContent.style.top = `${newTop}px`;

      // Move agent windows using their start positions + delta
      this.moveAgentWindowsWithWizard(agentStartPositions, dx, dy);

      // Throttle connection line updates
      if (!dragUpdateScheduled) {
        dragUpdateScheduled = true;
        requestAnimationFrame(() => {
          this.updateConnectionLines();
          dragUpdateScheduled = false;
        });
      }
    };

    const upHandler = () => {
      if (isDragging) {
        isDragging = false;
        // Remove move/end listeners when drag ends
        document.removeEventListener('mousemove', moveHandler);
        document.removeEventListener('mouseup', upHandler);
        document.removeEventListener('touchmove', moveHandler);
        document.removeEventListener('touchend', upHandler);
        // Save agent window positions for next drag
        this.saveAgentWindowRelativePositions();
      }
    };

    // Only attach start handlers - move/end are added dynamically during drag
    header.addEventListener('mousedown', startHandler);
    header.addEventListener('touchstart', startHandler, { passive: false });

    this.wizardDragListeners = {
      header,
      start: startHandler,
      move: moveHandler,
      up: upHandler,
    };
  }

  cleanupWizardDragging() {
    if (this.wizardDragListeners) {
      const { header, start, move, up } = this.wizardDragListeners;
      // Mouse events
      header?.removeEventListener('mousedown', start);
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
      // Touch events
      header?.removeEventListener('touchstart', start);
      document.removeEventListener('touchmove', move);
      document.removeEventListener('touchend', up);
      this.wizardDragListeners = null;
    }
  }

  moveAgentWindowsWithWizard(agentStartPositions, dx, dy) {
    // Move plan subagent windows using their start positions + delta
    for (const [agentId, windowData] of this.planSubagents) {
      if (windowData.element && !this.planAgentsMinimized) {
        const startPos = agentStartPositions.get(agentId);
        if (startPos) {
          windowData.element.style.left = `${startPos.left + dx}px`;
          windowData.element.style.top = `${startPos.top + dy}px`;
        }
      }
    }
  }

  saveAgentWindowRelativePositions() {
    const wizardModal = document.getElementById('ralphWizardModal');
    const wizardContent = wizardModal?.querySelector('.modal-content');
    if (!wizardContent) return;

    const wizardRect = wizardContent.getBoundingClientRect();

    for (const [, windowData] of this.planSubagents) {
      if (windowData.element) {
        const winRect = windowData.element.getBoundingClientRect();
        windowData.relativePos = {
          dx: winRect.left - wizardRect.left,
          dy: winRect.top - wizardRect.top,
        };
      }
    }
  }

  // ========== Agent Windows Minimize/Expand ==========

  togglePlanAgentsMinimized() {
    this.planAgentsMinimized = !this.planAgentsMinimized;

    if (this.planAgentsMinimized) {
      // Hide all agent windows and show tab
      for (const [, windowData] of this.planSubagents) {
        if (windowData.element) {
          windowData.element.style.display = 'none';
        }
      }
      this.createAgentsMinimizedTab();
    } else {
      // Show all agent windows and remove tab
      for (const [, windowData] of this.planSubagents) {
        if (windowData.element) {
          windowData.element.style.display = '';
        }
      }
      this.removeAgentsMinimizedTab();
    }

    this.updateConnectionLines();
  }

  createAgentsMinimizedTab() {
    // Remove existing tab if any
    this.removeAgentsMinimizedTab();

    const runningCount = Array.from(this.planSubagents.values())
      .filter(w => w.status === 'running').length;
    const totalCount = this.planSubagents.size;

    const tab = document.createElement('div');
    tab.className = 'wizard-agents-tab';
    tab.id = 'wizardAgentsMinimizedTab';
    tab.onclick = () => this.togglePlanAgentsMinimized();

    tab.innerHTML = `
      <span class="tab-icon">🤖</span>
      <span class="tab-label">Plan Agents</span>
      <span class="tab-count">${totalCount}</span>
      ${runningCount > 0 ? `
        <span class="tab-running">
          <span class="tab-spinner"></span>
          ${runningCount} running
        </span>
      ` : ''}
    `;

    document.body.appendChild(tab);
  }

  removeAgentsMinimizedTab() {
    document.getElementById('wizardAgentsMinimizedTab')?.remove();
  }

  updateWizardAgentCount() {
    const btn = document.getElementById('wizardMinimizeAgentsBtn');
    const countEl = document.getElementById('wizardAgentCount');
    if (!btn || !countEl) return;

    const count = this.planSubagents.size;
    countEl.textContent = count;
    btn.style.display = count > 0 ? '' : 'none';

    // Update minimized tab if it exists
    if (this.planAgentsMinimized) {
      this.createAgentsMinimizedTab();
    }
  }

  // ========== Plan Agent Prompts & Files Viewer ==========

  async showPlanAgentPrompt(agentId, agentType) {
    const caseName = this.ralphWizardConfig?.caseName;
    if (!caseName) {
      console.error('No case name available');
      return;
    }

    // Get agent info from planSubagents Map
    const agentInfo = this.planSubagents.get(agentId);
    const isRunning = agentInfo?.status === 'running';
    const taskDescription = this.ralphWizardConfig?.taskDescription || 'No task description available';

    try {
      const filePath = `${agentType}/prompt.md`;
      const res = await fetch(`/api/cases/${encodeURIComponent(caseName)}/ralph-wizard/file/${encodeURIComponent(filePath)}`);
      const data = await res.json();

      if (!data.success) {
        // File not found - show contextual message based on agent status
        if (isRunning) {
          const content = this.buildAgentRunningContent(agentType, agentInfo, taskDescription);
          this.showPlanFileWindow(agentType, 'prompt.md', content, false);
        } else {
          // Agent completed but no prompt file - might have failed
          const content = this.buildAgentNoPromptContent(agentType, taskDescription);
          this.showPlanFileWindow(agentType, 'prompt.md', content, false);
        }
        return;
      }

      this.showPlanFileWindow(agentType, 'prompt.md', data.data.content, false);
    } catch (err) {
      console.error('Failed to fetch prompt:', err);
      if (isRunning) {
        const content = this.buildAgentRunningContent(agentType, agentInfo, taskDescription);
        this.showPlanFileWindow(agentType, 'prompt.md', content, false);
      } else {
        this.showPlanFileWindow(agentType, 'prompt.md', `Error fetching prompt: ${err.message}`, false);
      }
    }
  }

  buildAgentRunningContent(agentType, agentInfo, taskDescription) {
    const typeDescriptions = {
      research: {
        title: 'Research Agent',
        role: 'Gathering external resources, exploring the codebase, and identifying patterns',
        activities: [
          'Reading CLAUDE.md and project documentation',
          'Exploring the codebase structure with Glob and Grep',
          'Searching the web for relevant documentation and examples',
          'Identifying existing patterns and conventions',
          'Finding similar implementations to reference',
        ],
      },
      requirements: {
        title: 'Requirements Analyst',
        role: 'Breaking down the task into concrete, actionable requirements',
        activities: [
          'Analyzing the task description for functional requirements',
          'Identifying non-functional requirements (performance, security)',
          'Detecting edge cases and error scenarios',
          'Defining acceptance criteria for each requirement',
        ],
      },
      architecture: {
        title: 'Architecture Planner',
        role: 'Designing the technical approach and file structure',
        activities: [
          'Identifying files to create or modify',
          'Planning the module/component structure',
          'Defining interfaces and data flow',
          'Ensuring consistency with existing architecture',
        ],
      },
      testing: {
        title: 'TDD Specialist',
        role: 'Planning the test-first development strategy',
        activities: [
          'Identifying test cases for each requirement',
          'Planning unit, integration, and E2E tests',
          'Defining test fixtures and mocks needed',
          'Ensuring edge cases have test coverage',
        ],
      },
      risks: {
        title: 'Risk Analyst',
        role: 'Identifying potential issues and mitigation strategies',
        activities: [
          'Analyzing potential failure points',
          'Identifying security concerns',
          'Flagging performance bottlenecks',
          'Suggesting rollback strategies',
        ],
      },
      verification: {
        title: 'Verification Expert',
        role: 'Validating plan completeness and quality',
        activities: [
          'Checking all requirements have implementation steps',
          'Verifying test coverage is adequate',
          'Ensuring dependencies are correctly ordered',
          'Scoring plan quality and completeness',
        ],
      },
      'execution-optimizer': {
        title: 'Execution Optimizer',
        role: 'Optimizing the plan for Claude Code execution',
        activities: [
          'Identifying tasks that can run in parallel',
          'Grouping related tasks for efficiency',
          'Marking fresh context requirements',
          'Estimating token usage per task',
        ],
      },
      'final-review': {
        title: 'Final Reviewer',
        role: 'Performing holistic validation of the complete plan',
        activities: [
          'Checking for gaps or missing steps',
          'Validating task ordering and dependencies',
          'Ensuring the plan is implementable',
          'Final quality assessment',
        ],
      },
    };

    const info = typeDescriptions[agentType] || {
      title: agentType,
      role: 'Processing the task',
      activities: ['Working on the task...'],
    };

    const elapsed = agentInfo?.startTime
      ? Math.floor((Date.now() - agentInfo.startTime) / 1000)
      : 0;
    const model = agentInfo?.model || 'unknown';

    let content = `# ${info.title} - Still Running\n\n`;
    content += `⏳ **Status:** Generating... (${elapsed}s elapsed)\n`;
    content += `🤖 **Model:** ${model}\n\n`;
    content += `---\n\n`;
    content += `## Role\n${info.role}\n\n`;
    content += `## Currently Working On\n`;
    info.activities.forEach(activity => {
      content += `- ${activity}\n`;
    });
    content += `\n---\n\n`;
    content += `## Task Being Analyzed\n\n`;
    content += `\`\`\`\n${taskDescription}\n\`\`\`\n\n`;
    content += `---\n\n`;
    content += `*The full prompt will be available once the agent completes.*\n`;
    content += `*Click again after completion to see the actual prompt that was used.*`;

    return content;
  }

  buildAgentNoPromptContent(agentType, taskDescription) {
    const typeLabels = {
      research: 'Research Agent',
      requirements: 'Requirements Analyst',
      architecture: 'Architecture Planner',
      testing: 'TDD Specialist',
      risks: 'Risk Analyst',
      verification: 'Verification Expert',
      'execution-optimizer': 'Execution Optimizer',
      'final-review': 'Final Reviewer',
    };

    let content = `# ${typeLabels[agentType] || agentType} - No Prompt Available\n\n`;
    content += `The prompt file for this agent was not saved.\n\n`;
    content += `This can happen if:\n`;
    content += `- The agent failed before completing\n`;
    content += `- The plan generation was cancelled\n`;
    content += `- There was an error saving the output\n\n`;
    content += `---\n\n`;
    content += `## Task Description\n\n`;
    content += `\`\`\`\n${taskDescription}\n\`\`\``;

    return content;
  }

  async showPlanAgentFiles(agentId, agentType) {
    const caseName = this.ralphWizardConfig?.caseName;
    if (!caseName) {
      console.error('No case name available');
      return;
    }

    // Create file manager popup
    this.showPlanFileManager(agentType, caseName);
  }

  showPlanFileManager(agentType, caseName) {
    // Remove existing file manager if any
    document.getElementById('planFileManager')?.remove();

    const typeLabels = {
      research: 'Research Agent',
      requirements: 'Requirements Analyst',
      architecture: 'Architecture Planner',
      testing: 'TDD Specialist',
      risks: 'Risk Analyst',
      verification: 'Verification Expert',
      execution: 'Execution Optimizer',
      'final-review': 'Final Review',
    };

    const fm = document.createElement('div');
    fm.className = 'plan-file-manager';
    fm.id = 'planFileManager';
    fm.innerHTML = `
      <div class="plan-fm-header">
        <span class="plan-fm-title">${typeLabels[agentType] || agentType} Files</span>
        <button class="plan-fm-close" onclick="app.closePlanFileManager()">&times;</button>
      </div>
      <div class="plan-fm-body">
        <div class="plan-fm-loading">Loading files...</div>
      </div>
    `;

    document.body.appendChild(fm);

    // Make draggable
    this.makePlanFileManagerDraggable(fm);

    // Fetch files
    this.loadPlanFileManagerFiles(agentType, caseName, fm);
  }

  async loadPlanFileManagerFiles(agentType, caseName, fm) {
    const body = fm.querySelector('.plan-fm-body');

    try {
      // First try to get the result.json
      const resultPath = `${agentType}/result.json`;
      const res = await fetch(`/api/cases/${encodeURIComponent(caseName)}/ralph-wizard/file/${encodeURIComponent(resultPath)}`);
      const data = await res.json();

      if (!data.success) {
        body.innerHTML = `<div class="plan-fm-error">No result file found</div>`;
        return;
      }

      const parsed = data.data.parsed;
      let items = [];

      // Extract items based on agent type
      if (agentType === 'research' && parsed?.findings) {
        // Research has nested structure
        items = [
          { name: 'External Resources', type: 'section', count: parsed.findings.externalResources?.length || 0 },
          { name: 'Codebase Patterns', type: 'section', count: parsed.findings.codebasePatterns?.length || 0 },
          { name: 'Technical Recommendations', type: 'section', count: parsed.findings.technicalRecommendations?.length || 0 },
          { name: 'Potential Challenges', type: 'section', count: parsed.findings.potentialChallenges?.length || 0 },
          { name: 'Recommended Tools', type: 'section', count: parsed.findings.recommendedTools?.length || 0 },
        ];
      } else if (parsed?.items) {
        items = parsed.items.map((item, idx) => ({
          name: item.category || item.content?.substring(0, 50) || `Item ${idx + 1}`,
          type: 'item',
          content: item.content || JSON.stringify(item, null, 2),
          rationale: item.rationale,
        }));
      } else {
        // Fallback: show raw JSON structure
        items = Object.keys(parsed || {}).map(key => ({
          name: key,
          type: 'key',
          content: JSON.stringify(parsed[key], null, 2),
        }));
      }

      body.innerHTML = `
        <div class="plan-fm-files">
          <div class="plan-fm-file" data-file="prompt.md">
            <span class="plan-fm-file-icon">📄</span>
            <span class="plan-fm-file-name">prompt.md</span>
          </div>
          <div class="plan-fm-file" data-file="result.json">
            <span class="plan-fm-file-icon">📊</span>
            <span class="plan-fm-file-name">result.json</span>
          </div>
          <div class="plan-fm-divider"></div>
          <div class="plan-fm-section-title">Result Contents (${items.length} items)</div>
          ${items.map((item, idx) => `
            <div class="plan-fm-item" data-item-idx="${idx}" data-agent-type="${agentType}">
              <span class="plan-fm-item-icon">${item.type === 'section' ? '📁' : '📝'}</span>
              <span class="plan-fm-item-name">${this.escapeHtml(item.name)}</span>
              ${item.count !== undefined ? `<span class="plan-fm-item-count">${item.count}</span>` : ''}
            </div>
          `).join('')}
        </div>
      `;

      // Store items data for click handlers
      fm._itemsData = items;
      fm._parsedData = parsed;
      fm._caseName = caseName;
      fm._agentType = agentType;

      // Add click handlers
      body.querySelectorAll('.plan-fm-file').forEach(el => {
        el.onclick = () => this.openPlanFile(agentType, caseName, el.dataset.file);
      });

      body.querySelectorAll('.plan-fm-item').forEach(el => {
        el.onclick = () => this.openPlanFileItem(fm, parseInt(el.dataset.itemIdx));
      });

    } catch (err) {
      body.innerHTML = `<div class="plan-fm-error">Error: ${err.message}</div>`;
    }
  }

  async openPlanFile(agentType, caseName, fileName) {
    const filePath = `${agentType}/${fileName}`;
    try {
      const res = await fetch(`/api/cases/${encodeURIComponent(caseName)}/ralph-wizard/file/${encodeURIComponent(filePath)}`);
      const data = await res.json();

      if (!data.success) {
        this.showPlanFileWindow(agentType, fileName, `Error: ${data.error}`, fileName.endsWith('.json'));
        return;
      }

      const content = fileName.endsWith('.json')
        ? JSON.stringify(data.data.parsed, null, 2)
        : data.data.content;

      this.showPlanFileWindow(agentType, fileName, content, fileName.endsWith('.json'));
    } catch (err) {
      this.showPlanFileWindow(agentType, fileName, `Error: ${err.message}`, false);
    }
  }

  openPlanFileItem(fm, itemIdx) {
    const items = fm._itemsData;
    const parsed = fm._parsedData;
    const agentType = fm._agentType;

    if (!items || itemIdx >= items.length) return;

    const item = items[itemIdx];

    // For research agent, expand the section
    if (agentType === 'research' && item.type === 'section') {
      let sectionData;
      switch (item.name) {
        case 'External Resources':
          sectionData = parsed.findings?.externalResources;
          break;
        case 'Codebase Patterns':
          sectionData = parsed.findings?.codebasePatterns;
          break;
        case 'Technical Recommendations':
          sectionData = parsed.findings?.technicalRecommendations;
          break;
        case 'Potential Challenges':
          sectionData = parsed.findings?.potentialChallenges;
          break;
        case 'Recommended Tools':
          sectionData = parsed.findings?.recommendedTools;
          break;
      }
      const content = JSON.stringify(sectionData, null, 2);
      this.showPlanFileWindow(agentType, item.name, content, true);
    } else {
      // Show item content
      const content = item.content || JSON.stringify(item, null, 2);
      this.showPlanFileWindow(agentType, item.name, content, typeof item.content !== 'string');
    }
  }

  showPlanFileWindow(agentType, fileName, content, isJson) {
    const windowId = `plan-file-${Date.now()}`;

    const win = document.createElement('div');
    win.className = 'plan-file-window';
    win.id = windowId;
    win.style.left = `${100 + Math.random() * 200}px`;
    win.style.top = `${100 + Math.random() * 100}px`;
    win.style.zIndex = ++this.planSubagentWindowZIndex;

    const typeLabels = {
      research: 'Research',
      requirements: 'Requirements',
      architecture: 'Architecture',
      testing: 'Testing',
      risks: 'Risks',
      verification: 'Verification',
      execution: 'Execution',
      'final-review': 'Review',
    };

    win.innerHTML = `
      <div class="plan-file-window-header">
        <span class="plan-file-window-title">${typeLabels[agentType] || agentType} / ${this.escapeHtml(fileName)}</span>
        <button class="plan-file-window-close" onclick="app.closePlanFileWindow('${windowId}')">&times;</button>
      </div>
      <div class="plan-file-window-body">
        <pre class="plan-file-content ${isJson ? 'json' : 'markdown'}">${this.escapeHtml(content)}</pre>
      </div>
      <div class="plan-file-window-resize"></div>
    `;

    document.body.appendChild(win);

    // Make draggable and resizable
    this.makePlanFileWindowDraggable(win);
    this.makePlanFileWindowResizable(win);
  }

  makePlanFileManagerDraggable(fm) {
    const header = fm.querySelector('.plan-fm-header');
    let isDragging = false;
    let startX, startY, startLeft, startTop;

    header.addEventListener('mousedown', (e) => {
      if (e.target.tagName === 'BUTTON') return;
      isDragging = true;
      startX = e.clientX;
      startY = e.clientY;
      startLeft = parseInt(fm.style.left) || (window.innerWidth / 2 - 150);
      startTop = parseInt(fm.style.top) || (window.innerHeight / 2 - 200);
      fm.style.left = `${startLeft}px`;
      fm.style.top = `${startTop}px`;
      e.preventDefault();
    });

    const moveHandler = (e) => {
      if (!isDragging) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      fm.style.left = `${Math.max(10, startLeft + dx)}px`;
      fm.style.top = `${Math.max(10, startTop + dy)}px`;
    };

    const upHandler = () => {
      isDragging = false;
    };

    document.addEventListener('mousemove', moveHandler);
    document.addEventListener('mouseup', upHandler);

    // Store handlers for cleanup
    fm._dragHandlers = { move: moveHandler, up: upHandler };
  }

  // Clean up plan file manager and remove document listeners
  closePlanFileManager() {
    const fm = document.getElementById('planFileManager');
    if (fm) {
      if (fm._dragHandlers) {
        document.removeEventListener('mousemove', fm._dragHandlers.move);
        document.removeEventListener('mouseup', fm._dragHandlers.up);
      }
      fm.remove();
    }
  }

  makePlanFileWindowDraggable(win) {
    const header = win.querySelector('.plan-file-window-header');
    let isDragging = false;
    let startX, startY, startLeft, startTop;

    header.addEventListener('mousedown', (e) => {
      if (e.target.tagName === 'BUTTON') return;
      isDragging = true;
      startX = e.clientX;
      startY = e.clientY;
      startLeft = parseInt(win.style.left) || 0;
      startTop = parseInt(win.style.top) || 0;
      win.style.zIndex = ++this.planSubagentWindowZIndex;
      e.preventDefault();
    });

    const moveHandler = (e) => {
      if (!isDragging) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      win.style.left = `${Math.max(10, startLeft + dx)}px`;
      win.style.top = `${Math.max(10, startTop + dy)}px`;
    };

    const upHandler = () => {
      isDragging = false;
    };

    document.addEventListener('mousemove', moveHandler);
    document.addEventListener('mouseup', upHandler);

    // Store handlers for cleanup
    win._dragHandlers = { move: moveHandler, up: upHandler };
  }

  makePlanFileWindowResizable(win) {
    const resizer = win.querySelector('.plan-file-window-resize');
    let isResizing = false;
    let startX, startY, startWidth, startHeight;

    resizer.addEventListener('mousedown', (e) => {
      isResizing = true;
      startX = e.clientX;
      startY = e.clientY;
      startWidth = win.offsetWidth;
      startHeight = win.offsetHeight;
      e.preventDefault();
      e.stopPropagation();
    });

    const moveHandler = (e) => {
      if (!isResizing) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      win.style.width = `${Math.max(300, startWidth + dx)}px`;
      win.style.height = `${Math.max(200, startHeight + dy)}px`;
    };

    const upHandler = () => {
      isResizing = false;
    };

    document.addEventListener('mousemove', moveHandler);
    document.addEventListener('mouseup', upHandler);

    // Store handlers for cleanup
    win._resizeHandlers = { move: moveHandler, up: upHandler };
  }

  // Clean up plan file window and remove document listeners
  closePlanFileWindow(windowId) {
    const win = document.getElementById(windowId);
    if (win) {
      if (win._dragHandlers) {
        document.removeEventListener('mousemove', win._dragHandlers.move);
        document.removeEventListener('mouseup', win._dragHandlers.up);
      }
      if (win._resizeHandlers) {
        document.removeEventListener('mousemove', win._resizeHandlers.move);
        document.removeEventListener('mouseup', win._resizeHandlers.up);
      }
      win.remove();
    }
  }

  skipPlanGeneration() {
    // Stop any running timers
    if (this.planLoadingTimer) {
      clearInterval(this.planLoadingTimer);
      this.planLoadingTimer = null;
    }
    if (this.planPhaseTimer) {
      clearInterval(this.planPhaseTimer);
      this.planPhaseTimer = null;
    }

    this.ralphWizardConfig.skipPlanGeneration = true;
    this.ralphWizardConfig.planGenerated = false;
    this.ralphWizardConfig.generatedPlan = null;

    // Generate preview and go to step 3
    this.updateRalphPromptPreview();
    this.ralphWizardStep = 3;
    this.updateRalphWizardUI();
  }

  regeneratePlan() {
    this.ralphWizardConfig.generatedPlan = null;
    this.ralphWizardConfig.planGenerated = false;
    this.generatePlan();
  }

  generateFixPlanContent(items) {
    // Group items by priority
    const p0Items = items.filter(i => i.priority === 'P0');
    const p1Items = items.filter(i => i.priority === 'P1');
    const p2Items = items.filter(i => i.priority === 'P2');
    const noPriorityItems = items.filter(i => !i.priority);

    let content = '# Implementation Plan\n\n';
    content += `Generated: ${new Date().toISOString().slice(0, 10)}\n\n`;

    if (p0Items.length > 0) {
      content += '## Critical Path (P0)\n\n';
      p0Items.forEach(item => {
        content += `- [ ] ${item.content}\n`;
      });
      content += '\n';
    }

    if (p1Items.length > 0) {
      content += '## Standard (P1)\n\n';
      p1Items.forEach(item => {
        content += `- [ ] ${item.content}\n`;
      });
      content += '\n';
    }

    if (p2Items.length > 0) {
      content += '## Nice-to-Have (P2)\n\n';
      p2Items.forEach(item => {
        content += `- [ ] ${item.content}\n`;
      });
      content += '\n';
    }

    if (noPriorityItems.length > 0) {
      content += '## Tasks\n\n';
      noPriorityItems.forEach(item => {
        content += `- [ ] ${item.content}\n`;
      });
      content += '\n';
    }

    return content;
  }

  async startRalphLoop() {
    const config = this.ralphWizardConfig;

    // Read advanced options (respawn disabled by default for Ralph Loops)
    config.enableRespawn = document.getElementById('ralphEnableRespawn')?.checked ?? false;
    // Check either auto-start checkbox (step 2 or step 3)
    config.autoStart = document.getElementById('ralphAutoStart')?.checked ||
                       document.getElementById('ralphAutoStartStep2')?.checked ||
                       this.ralphWizardConfig.autoStart || false;

    // Close wizard
    this.closeRalphWizard();

    // Determine if we have a task plan
    const hasPlan = config.generatedPlan && config.generatedPlan.filter(i => i.enabled).length > 0;

    // Build the full prompt following Ralph Wiggum methodology
    let fullPrompt = config.taskDescription;
    fullPrompt += '\n\n---\n\n';

    // Add @fix_plan.md reference if plan was generated
    if (hasPlan) {
      fullPrompt += '## Task Plan\n\n';
      fullPrompt += 'A task plan has been written to `@fix_plan.md`. Use this to track progress:\n';
      fullPrompt += '- Reference the plan at the start of each iteration\n';
      fullPrompt += '- Update task checkboxes as you complete items\n';
      fullPrompt += '- Work through items in priority order (P0 > P1 > P2)\n\n';
    }

    fullPrompt += '## Iteration Protocol\n\n';
    fullPrompt += 'This is an autonomous loop. Files from previous iterations persist. On each iteration:\n';
    fullPrompt += '1. Check what work has already been done\n';
    fullPrompt += '2. Make incremental progress toward completion\n';
    fullPrompt += '3. Commit meaningful changes with descriptive messages\n\n';

    fullPrompt += '## Verification\n\n';
    fullPrompt += 'After each significant change:\n';
    fullPrompt += '- Run tests to verify (npm test, pytest, etc.)\n';
    fullPrompt += '- Check for type/lint errors if applicable\n';
    fullPrompt += '- If tests fail, read the error, fix it, and retry\n\n';

    fullPrompt += '## Completion Criteria\n\n';
    fullPrompt += `Output \`<promise>${config.completionPhrase}</promise>\` when ALL of the following are true:\n`;
    fullPrompt += '- All requirements from the task description are implemented\n';
    fullPrompt += '- All tests pass\n';
    fullPrompt += '- Changes are committed\n\n';

    fullPrompt += '## If Stuck\n\n';
    fullPrompt += 'If you encounter the same error for 3+ iterations:\n';
    fullPrompt += '1. Document what you\'ve tried\n';
    fullPrompt += '2. Identify the specific blocker\n';
    fullPrompt += '3. Try an alternative approach\n';
    fullPrompt += '4. If truly blocked, output `<promise>BLOCKED</promise>` with an explanation\n';

    try {
      // Step 1: Create/verify case exists and start session
      this.terminal.clear();
      this.terminal.writeln(`\x1b[1;33m Starting Ralph Loop in ${config.caseName}...\x1b[0m`);
      this.terminal.writeln('');

      // Create session via quick-start
      const res = await fetch('/api/quick-start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ caseName: config.caseName, mode: 'claude' })
      });

      const data = await res.json();
      if (!data.success) {
        this.showToast(data.error || 'Failed to start session', 'error');
        return;
      }

      const sessionId = data.sessionId;

      // Clear from closed set in case user previously closed Ralph for this session
      this.ralphClosedSessions.delete(sessionId);

      // Step 2: Configure Ralph tracker for this session
      await fetch(`/api/sessions/${sessionId}/ralph-config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          enabled: true,
          completionPhrase: config.completionPhrase,
          maxIterations: config.maxIterations || null,
        })
      });

      // Step 2.5: Write @fix_plan.md if plan was generated
      if (config.generatedPlan && config.generatedPlan.length > 0) {
        const enabledItems = config.generatedPlan.filter(i => i.enabled);
        if (enabledItems.length > 0) {
          const planContent = this.generateFixPlanContent(enabledItems);
          // Import the plan content and get the todos back
          const importRes = await fetch(`/api/sessions/${sessionId}/fix-plan/import`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ content: planContent })
          });
          const importData = await importRes.json();

          // Update local ralph state immediately to avoid 100% display bug
          // (SSE event might arrive after selectSession is called)
          if (importData.success && importData.data?.todos) {
            this.updateRalphState(sessionId, { todos: importData.data.todos });
          }

          // Write to disk
          await fetch(`/api/sessions/${sessionId}/fix-plan/write`, { method: 'POST' });
        }
      }

      // Step 3: Enable respawn if requested (with Ralph-specific prompts)
      // NOTE: Prompts must be single-line because screen-manager.ts strips newlines
      if (config.enableRespawn) {
        const ralphUpdatePrompt = 'Before /clear: Update CLAUDE.md with discoveries and notes, mark completed tasks in @fix_plan.md, write a brief progress summary to a file so the next iteration can continue seamlessly.';

        const ralphKickstartPrompt = `You are in a Ralph Wiggum loop. Read @fix_plan.md for task status, check CLAUDE.md for notes from previous iterations, continue on the next uncompleted task, output <promise>${config.completionPhrase}</promise> when ALL tasks are complete.`;

        await fetch(`/api/sessions/${sessionId}/respawn/enable`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            updatePrompt: ralphUpdatePrompt,
            sendClear: true,
            sendInit: true,
            kickstartPrompt: ralphKickstartPrompt,
          })
        });
      }

      // Step 4: Switch to session and wait for it to be ready
      await this.selectSession(sessionId);

      // Wait for Claude CLI to be ready (shows prompt)
      // Check session status multiple times - Claude CLI can take a while to initialize
      let attempts = 0;
      const maxAttempts = 30; // 15 seconds total
      let sessionReady = false;
      console.log('[RalphWizard] Waiting for session to become ready...');
      while (attempts < maxAttempts) {
        await new Promise(r => setTimeout(r, 500));
        try {
          const statusRes = await fetch(`/api/sessions/${sessionId}`);
          const statusData = await statusRes.json();
          // Session is ready ONLY when Claude CLI shows its UI:
          // Must see prompt character '❯' OR 'tokens' status line
          // Do NOT use isWorking=false - that fires before CLI is ready!
          const termBuf = statusData?.terminalBuffer || '';
          const hasPrompt = termBuf.includes('❯');
          const hasTokensLine = termBuf.includes('tokens');
          if (hasPrompt || hasTokensLine) {
            console.log(`[RalphWizard] Session ready after ${attempts + 1} attempts (hasPrompt=${hasPrompt}, hasTokensLine=${hasTokensLine})`);
            sessionReady = true;
            break;
          }
        } catch (e) {
          console.warn('[RalphWizard] Error checking session status:', e);
        }
        attempts++;
      }

      if (!sessionReady) {
        console.warn(`[RalphWizard] Session did not become ready after ${maxAttempts} attempts, sending prompt anyway`);
        this.showToast('Session took longer than expected to initialize, sending prompt...', 'warning');
        // Add extra delay to give Claude CLI more time
        await new Promise(r => setTimeout(r, 2000));
      }

      // Add delay after session ready before sending prompt
      console.log('[RalphWizard] Adding 2s delay before sending prompt...');
      await new Promise(r => setTimeout(r, 2000));

      // Write prompt to file first (avoids screen input escaping issues)
      console.log(`[RalphWizard] Writing prompt to @ralph_prompt.md (${fullPrompt.length} chars)...`);
      const writeRes = await fetch(`/api/sessions/${sessionId}/ralph-prompt/write`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: fullPrompt })
      });

      if (!writeRes.ok) {
        const errorData = await writeRes.json().catch(() => ({}));
        throw new Error(errorData.error || `Failed to write prompt file: ${writeRes.status}`);
      }

      console.log('[RalphWizard] Prompt file written.');

      // If plan was generated, send /init first to load CLAUDE.md with research context
      // This gives Claude awareness of all the research files before starting tasks
      if (hasPlan) {
        console.log('[RalphWizard] Sending /init to load research context from CLAUDE.md...');
        const initRes = await fetch(`/api/sessions/${sessionId}/input`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ input: '/init\r', useScreen: true })
        });

        if (!initRes.ok) {
          console.warn('[RalphWizard] Failed to send /init, continuing anyway...');
        } else {
          // Wait for /init to complete - can take up to 3 minutes for large CLAUDE.md files
          console.log('[RalphWizard] Waiting for /init to complete (can take up to 3 minutes)...');
          let initComplete = false;
          const initMaxAttempts = 180; // 3 minutes at 1 second intervals
          for (let attempt = 0; attempt < initMaxAttempts; attempt++) {
            await new Promise(r => setTimeout(r, 1000));
            try {
              const statusRes = await fetch(`/api/sessions/${sessionId}`);
              const statusData = await statusRes.json();
              const termBuf = statusData?.terminalBuffer || '';
              // /init is complete when we see the prompt indicator (❯) and not working
              const hasPrompt = termBuf.includes('❯');
              const isIdle = !statusData.isWorking;
              if (hasPrompt && isIdle) {
                console.log(`[RalphWizard] /init complete after ${attempt + 1}s, Claude now has research context.`);
                initComplete = true;
                break;
              }
              // Log progress every 15 seconds
              if ((attempt + 1) % 15 === 0) {
                console.log(`[RalphWizard] Still waiting for /init... ${attempt + 1}s elapsed (isWorking=${statusData.isWorking})`);
              }
            } catch (e) {
              console.warn('[RalphWizard] Status check error:', e);
            }
          }
          if (!initComplete) {
            console.warn('[RalphWizard] /init did not complete within 3 minutes, proceeding anyway...');
            this.showToast('/init took longer than expected, prompt may not have full context', 'warning');
          }
          // Delay after /init to let Claude settle
          console.log('[RalphWizard] Adding 3s delay after /init...');
          await new Promise(r => setTimeout(r, 3000));
        }
      }

      console.log('[RalphWizard] Sending read command to Claude...');

      // Send a simple command to Claude to read the prompt file
      // This avoids all the escaping issues with long multi-line prompts
      const readCommand = 'Read @ralph_prompt.md and follow the instructions. Start working immediately.\r';
      const inputRes = await fetch(`/api/sessions/${sessionId}/input`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: readCommand, useScreen: true })
      });

      if (!inputRes.ok) {
        const errorData = await inputRes.json().catch(() => ({}));
        throw new Error(errorData.error || `Failed to send input: ${inputRes.status}`);
      }

      console.log('[RalphWizard] Read command sent, verifying it was received...');

      // Verify the prompt was actually received by checking for activity
      let verified = false;
      for (let verifyAttempt = 0; verifyAttempt < 15; verifyAttempt++) {
        await new Promise(r => setTimeout(r, 1000));
        try {
          const verifyRes = await fetch(`/api/sessions/${sessionId}`);
          const verifyData = await verifyRes.json();
          if (verifyData.isWorking || verifyData.tokens?.total > 0) {
            console.log(`[RalphWizard] Prompt verified! tokens=${verifyData.tokens?.total}`);
            verified = true;
            break;
          }
          console.log(`[RalphWizard] Verify attempt ${verifyAttempt + 1}: status=${verifyData.status}, tokens=${verifyData.tokens?.total || 0}`);
        } catch (e) {
          console.warn('[RalphWizard] Verify error:', e);
        }
      }

      if (!verified) {
        console.warn('[RalphWizard] Session may not have started yet - prompt file is at @ralph_prompt.md');
        this.showToast('Session started - check @ralph_prompt.md if prompt not received', 'warning');
      } else {
        this.showToast(`Ralph Loop started in ${config.caseName}`, 'success');
      }

    } catch (err) {
      console.error('Failed to start Ralph loop:', err);
      this.showToast('Failed to start Ralph loop: ' + err.message, 'error');
    }
  }

  // ========== Quick Start ==========

  async loadQuickStartCases(selectCaseName = null) {
    try {
      // Load settings to get lastUsedCase
      let lastUsedCase = null;
      try {
        const settingsRes = await fetch('/api/settings');
        if (settingsRes.ok) {
          const settings = await settingsRes.json();
          lastUsedCase = settings.lastUsedCase || null;
        }
      } catch {
        // Ignore settings load errors
      }

      // Add cache-busting to ensure fresh data
      const res = await fetch('/api/cases?_t=' + Date.now());
      const cases = await res.json();
      this.cases = cases;
      console.log('[loadQuickStartCases] Loaded cases:', cases.map(c => c.name), 'lastUsedCase:', lastUsedCase);

      const select = document.getElementById('quickStartCase');

      // Build options - existing cases first, then testcase as fallback if not present
      let options = '';
      const hasTestcase = cases.some(c => c.name === 'testcase');
      const isMobile = MobileDetection.getDeviceType() === 'mobile';
      const maxNameLength = isMobile ? 8 : 20; // Truncate to 8 chars on mobile

      cases.forEach(c => {
        const displayName = c.name.length > maxNameLength
          ? c.name.substring(0, maxNameLength) + '…'
          : c.name;
        options += `<option value="${c.name}">${displayName}</option>`;
      });

      // Add testcase option if it doesn't exist (will be created on first run)
      if (!hasTestcase) {
        options = `<option value="testcase">testcase</option>` + options;
      }

      select.innerHTML = options;
      console.log('[loadQuickStartCases] Set options:', select.innerHTML.substring(0, 200));

      // If a specific case was requested, select it
      if (selectCaseName) {
        select.value = selectCaseName;
        this.updateDirDisplayForCase(selectCaseName);
        this.updateMobileCaseLabel(selectCaseName);
      } else if (lastUsedCase && cases.some(c => c.name === lastUsedCase)) {
        // Use lastUsedCase if available and exists
        select.value = lastUsedCase;
        this.updateDirDisplayForCase(lastUsedCase);
        this.updateMobileCaseLabel(lastUsedCase);
      } else if (cases.length > 0) {
        // Fallback to testcase or first case
        const firstCase = cases.find(c => c.name === 'testcase') || cases[0];
        select.value = firstCase.name;
        this.updateDirDisplayForCase(firstCase.name);
        this.updateMobileCaseLabel(firstCase.name);
      } else {
        // No cases exist yet - show the default case name as directory
        select.value = 'testcase';
        document.getElementById('dirDisplay').textContent = '~/claudeman-cases/testcase';
        this.updateMobileCaseLabel('testcase');
      }

      // Only add event listener once (on first load)
      if (!select.dataset.listenerAdded) {
        select.addEventListener('change', () => {
          this.updateDirDisplayForCase(select.value);
          this.saveLastUsedCase(select.value);
          this.updateMobileCaseLabel(select.value);
        });
        select.dataset.listenerAdded = 'true';
      }
    } catch (err) {
      console.error('Failed to load cases:', err);
    }
  }

  async updateDirDisplayForCase(caseName) {
    try {
      const res = await fetch(`/api/cases/${caseName}`);
      const data = await res.json();
      if (data.path) {
        document.getElementById('dirDisplay').textContent = data.path;
        document.getElementById('dirInput').value = data.path;
      }
    } catch (err) {
      document.getElementById('dirDisplay').textContent = caseName;
    }
  }

  async saveLastUsedCase(caseName) {
    try {
      // Get current settings
      const res = await fetch('/api/settings');
      const settings = res.ok ? await res.json() : {};
      // Update lastUsedCase
      settings.lastUsedCase = caseName;
      // Save back
      await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(settings)
      });
    } catch (err) {
      console.error('Failed to save last used case:', err);
    }
  }

  async quickStart() {
    // Alias for backward compatibility
    return this.runClaude();
  }

  // Tab count stepper functions
  incrementTabCount() {
    const input = document.getElementById('tabCount');
    const current = parseInt(input.value) || 1;
    input.value = Math.min(20, current + 1);
  }

  decrementTabCount() {
    const input = document.getElementById('tabCount');
    const current = parseInt(input.value) || 1;
    input.value = Math.max(1, current - 1);
  }

  // Shell count stepper functions
  incrementShellCount() {
    const input = document.getElementById('shellCount');
    const current = parseInt(input.value) || 1;
    input.value = Math.min(20, current + 1);
  }

  decrementShellCount() {
    const input = document.getElementById('shellCount');
    const current = parseInt(input.value) || 1;
    input.value = Math.max(1, current - 1);
  }

  async runClaude() {
    const caseName = document.getElementById('quickStartCase').value || 'testcase';
    const tabCount = Math.min(20, Math.max(1, parseInt(document.getElementById('tabCount').value) || 1));

    this.terminal.clear();
    this.terminal.writeln(`\x1b[1;32m Starting ${tabCount} Claude session(s) in ${caseName}...\x1b[0m`);
    this.terminal.writeln('');

    try {
      // Get case path first
      const caseRes = await fetch(`/api/cases/${caseName}`);
      let caseData = await caseRes.json();

      // Create the case if it doesn't exist
      if (!caseData.path) {
        const createCaseRes = await fetch('/api/cases', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: caseName, description: '' })
        });
        const createCaseData = await createCaseRes.json();
        if (!createCaseData.success) throw new Error(createCaseData.error || 'Failed to create case');
        // Use the newly created case data (API returns { success, case: { name, path } })
        caseData = createCaseData.case;
      }

      const workingDir = caseData.path;
      if (!workingDir) throw new Error('Case path not found');
      let firstSessionId = null;

      // Find the highest existing w-number for THIS case to avoid duplicates
      let startNumber = 1;
      for (const [, session] of this.sessions) {
        const match = session.name && session.name.match(/^w(\d+)-(.+)$/);
        if (match && match[2] === caseName) {
          const num = parseInt(match[1]);
          if (num >= startNumber) {
            startNumber = num + 1;
          }
        }
      }

      // Get global Ralph tracker setting
      const ralphEnabled = this.isRalphTrackerEnabledByDefault();

      // Create all sessions in parallel for speed
      const sessionNames = [];
      for (let i = 0; i < tabCount; i++) {
        sessionNames.push(`w${startNumber + i}-${caseName}`);
      }

      // Build env overrides from global + case settings (case overrides global)
      const caseSettings = this.getCaseSettings(caseName);
      const globalSettings = this.loadAppSettingsFromStorage();
      const envOverrides = {};
      if (caseSettings.agentTeams || globalSettings.agentTeamsEnabled) {
        envOverrides.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = '1';
      }
      const hasEnvOverrides = Object.keys(envOverrides).length > 0;

      // Step 1: Create all sessions in parallel
      this.terminal.writeln(`\x1b[90m Creating ${tabCount} session(s)...\x1b[0m`);
      const createPromises = sessionNames.map(name =>
        fetch('/api/sessions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ workingDir, name, ...(hasEnvOverrides ? { envOverrides } : {}) })
        }).then(r => r.json())
      );
      const createResults = await Promise.all(createPromises);

      // Collect created session IDs
      const sessionIds = [];
      for (const result of createResults) {
        if (!result.success) throw new Error(result.error);
        sessionIds.push(result.session.id);
      }
      firstSessionId = sessionIds[0];

      // Step 2: Configure Ralph for all sessions in parallel
      await Promise.all(sessionIds.map(id =>
        fetch(`/api/sessions/${id}/ralph-config`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ enabled: ralphEnabled, disableAutoEnable: !ralphEnabled })
        })
      ));

      // Step 3: Start all sessions in parallel (biggest speedup)
      this.terminal.writeln(`\x1b[90m Starting ${tabCount} session(s) in parallel...\x1b[0m`);
      await Promise.all(sessionIds.map(id =>
        fetch(`/api/sessions/${id}/interactive`, { method: 'POST' })
      ));

      this.terminal.writeln(`\x1b[90m All ${tabCount} sessions ready\x1b[0m`);

      // Auto-switch to the new session using selectSession (does proper refresh)
      if (firstSessionId) {
        await this.selectSession(firstSessionId);
        this.loadQuickStartCases();
      }

      this.terminal.focus();
    } catch (err) {
      this.terminal.writeln(`\x1b[1;31m Error: ${err.message}\x1b[0m`);
    }
  }

  async runShell() {
    const caseName = document.getElementById('quickStartCase').value || 'testcase';
    const shellCount = Math.min(20, Math.max(1, parseInt(document.getElementById('shellCount').value) || 1));

    this.terminal.clear();
    this.terminal.writeln(`\x1b[1;33m Starting ${shellCount} Shell session(s) in ${caseName}...\x1b[0m`);
    this.terminal.writeln('');

    try {
      // Get the case path
      const caseRes = await fetch(`/api/cases/${caseName}`);
      const caseData = await caseRes.json();
      const workingDir = caseData.path;
      if (!workingDir) throw new Error('Case path not found');

      // Find the highest existing s-number for THIS case to avoid duplicates
      let startNumber = 1;
      for (const [, session] of this.sessions) {
        const match = session.name && session.name.match(/^s(\d+)-(.+)$/);
        if (match && match[2] === caseName) {
          const num = parseInt(match[1]);
          if (num >= startNumber) {
            startNumber = num + 1;
          }
        }
      }

      // Create all shell sessions in parallel
      const sessionNames = [];
      for (let i = 0; i < shellCount; i++) {
        sessionNames.push(`s${startNumber + i}-${caseName}`);
      }

      // Step 1: Create all sessions in parallel
      const createPromises = sessionNames.map(name =>
        fetch('/api/sessions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ workingDir, mode: 'shell', name })
        }).then(r => r.json())
      );
      const createResults = await Promise.all(createPromises);

      const sessionIds = [];
      for (const result of createResults) {
        if (!result.success) throw new Error(result.error);
        sessionIds.push(result.session.id);
      }

      // Step 2: Start all shells in parallel
      await Promise.all(sessionIds.map(id =>
        fetch(`/api/sessions/${id}/shell`, { method: 'POST' })
      ));

      // Step 3: Resize all in parallel (with minimum dimension enforcement)
      const dims = this.getTerminalDimensions();
      if (dims) {
        await Promise.all(sessionIds.map(id =>
          fetch(`/api/sessions/${id}/resize`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(dims)
          })
        ));
      }

      // Switch to first session
      if (sessionIds.length > 0) {
        this.activeSessionId = sessionIds[0];
        await this.selectSession(sessionIds[0]);
      }

      this.terminal.focus();
    } catch (err) {
      this.terminal.writeln(`\x1b[1;31m Error: ${err.message}\x1b[0m`);
    }
  }

  // ========== Directory Input ==========

  toggleDirInput() {
    const btn = document.querySelector('#dirDisplay').parentElement;
    const input = document.getElementById('dirInput');

    if (input.classList.contains('hidden')) {
      input.classList.remove('hidden');
      btn.style.display = 'none';
      input.focus();
    }
  }

  hideDirInput() {
    const btn = document.querySelector('#dirDisplay').parentElement;
    const input = document.getElementById('dirInput');

    setTimeout(() => {
      input.classList.add('hidden');
      btn.style.display = '';

      const value = input.value.trim();
      document.getElementById('dirDisplay').textContent = value || 'No directory';
    }, 100);
  }

  // ========== Respawn Banner ==========

  showRespawnBanner() {
    this.$('respawnBanner').style.display = 'flex';
    // Also show timer if there's a timed respawn
    if (this.activeSessionId && this.respawnTimers[this.activeSessionId]) {
      this.showRespawnTimer();
    }
    // Show tokens if session has token data
    const session = this.sessions.get(this.activeSessionId);
    if (session && session.tokens) {
      this.updateRespawnTokens(session.tokens);
    }
  }

  hideRespawnBanner() {
    this.$('respawnBanner').style.display = 'none';
    this.hideRespawnTimer();
  }

  // Human-friendly state labels
  getStateLabel(state) {
    const labels = {
      'stopped': 'Stopped',
      'watching': 'Watching',
      'confirming_idle': 'Confirming idle',
      'ai_checking': 'AI checking',
      'sending_update': 'Sending prompt',
      'waiting_update': 'Running prompt',
      'sending_clear': 'Clearing context',
      'waiting_clear': 'Clearing...',
      'sending_init': 'Initializing',
      'waiting_init': 'Initializing...',
      'monitoring_init': 'Waiting for work',
      'sending_kickstart': 'Kickstarting',
      'waiting_kickstart': 'Kickstarting...',
    };
    return labels[state] || state.replace(/_/g, ' ');
  }

  updateRespawnBanner(state) {
    const stateEl = this.$('respawnState');
    stateEl.textContent = this.getStateLabel(state);
    // Clear blocked state when state changes (resumed from blocked)
    stateEl.classList.remove('respawn-blocked');
  }

  updateDetectionDisplay(detection) {
    if (!detection) return;

    const statusEl = this.$('detectionStatus');
    const waitingEl = this.$('detectionWaiting');
    const confidenceEl = this.$('detectionConfidence');
    const aiCheckEl = document.getElementById('detectionAiCheck');
    const hookEl = document.getElementById('detectionHook');

    // Hook-based detection indicator (highest priority signals)
    if (hookEl) {
      if (detection.stopHookReceived || detection.idlePromptReceived) {
        const hookType = detection.idlePromptReceived ? 'idle' : 'stop';
        hookEl.textContent = `🎯 ${hookType} hook`;
        hookEl.className = 'detection-hook hook-active';
        hookEl.style.display = '';
      } else {
        hookEl.style.display = 'none';
      }
    }

    // Simplified status - only show when meaningful
    if (detection.statusText && detection.statusText !== 'Watching...') {
      statusEl.textContent = detection.statusText;
      statusEl.style.display = '';
    } else {
      statusEl.style.display = 'none';
    }

    // Hide "waiting for" text - it's redundant with the state label
    waitingEl.style.display = 'none';

    // Show confidence only when confirming (>0%)
    const confidence = detection.confidenceLevel || 0;
    if (confidence > 0) {
      confidenceEl.textContent = `${confidence}%`;
      confidenceEl.style.display = '';
      confidenceEl.className = 'detection-confidence';
      // Hook signals give 100% confidence
      if (detection.stopHookReceived || detection.idlePromptReceived) {
        confidenceEl.classList.add('hook-confirmed');
      } else if (confidence >= 60) {
        confidenceEl.classList.add('high');
      } else if (confidence >= 30) {
        confidenceEl.classList.add('medium');
      }
    } else {
      confidenceEl.style.display = 'none';
    }

    // AI check display - compact format
    if (aiCheckEl && detection.aiCheck) {
      const ai = detection.aiCheck;
      let aiText = '';
      let aiClass = 'detection-ai-check';

      if (ai.status === 'checking') {
        aiText = '🔍 AI checking...';
        aiClass += ' ai-checking';
      } else if (ai.status === 'cooldown' && ai.cooldownEndsAt) {
        const remaining = Math.ceil((ai.cooldownEndsAt - Date.now()) / 1000);
        if (remaining > 0) {
          if (ai.lastVerdict === 'WORKING') {
            aiText = `⏳ Working, retry ${remaining}s`;
            aiClass += ' ai-working';
          } else {
            aiText = `✓ Idle, wait ${remaining}s`;
            aiClass += ' ai-idle';
          }
        }
      } else if (ai.status === 'disabled') {
        aiText = '⚠ AI disabled';
        aiClass += ' ai-disabled';
      } else if (ai.lastVerdict && ai.lastCheckTime) {
        const ago = Math.round((Date.now() - ai.lastCheckTime) / 1000);
        if (ago < 120) {
          aiText = ai.lastVerdict === 'IDLE'
            ? `✓ Idle (${ago}s)`
            : `⏳ Working (${ago}s)`;
          aiClass += ai.lastVerdict === 'IDLE' ? ' ai-idle' : ' ai-working';
        }
      }

      aiCheckEl.textContent = aiText;
      aiCheckEl.className = aiClass;
      aiCheckEl.style.display = aiText ? '' : 'none';
    } else if (aiCheckEl) {
      aiCheckEl.style.display = 'none';
    }

    // Manage row2 visibility - hide if nothing visible
    const row2 = this.$('respawnStatusRow2');
    if (row2) {
      const hasVisibleContent =
        (hookEl && hookEl.style.display !== 'none') ||
        (aiCheckEl && aiCheckEl.style.display !== 'none') ||
        (statusEl && statusEl.style.display !== 'none') ||
        (this.respawnCountdownTimers[this.activeSessionId] &&
         Object.keys(this.respawnCountdownTimers[this.activeSessionId]).length > 0);
      row2.style.display = hasVisibleContent ? '' : 'none';
    }
  }

  showRespawnTimer() {
    const timerEl = this.$('respawnTimer');
    timerEl.style.display = '';
    this.updateRespawnTimer();
    // Update every second
    if (this.respawnTimerInterval) clearInterval(this.respawnTimerInterval);
    this.respawnTimerInterval = setInterval(() => this.updateRespawnTimer(), 1000);
  }

  hideRespawnTimer() {
    this.$('respawnTimer').style.display = 'none';
    if (this.respawnTimerInterval) {
      clearInterval(this.respawnTimerInterval);
      this.respawnTimerInterval = null;
    }
  }

  updateRespawnTimer() {
    if (!this.activeSessionId || !this.respawnTimers[this.activeSessionId]) {
      this.hideRespawnTimer();
      return;
    }

    const timer = this.respawnTimers[this.activeSessionId];
    // Guard against invalid timer data
    if (!timer.endAt || isNaN(timer.endAt)) {
      this.hideRespawnTimer();
      return;
    }

    const now = Date.now();
    const remaining = Math.max(0, timer.endAt - now);

    if (remaining <= 0) {
      this.$('respawnTimer').textContent = 'Time up';
      delete this.respawnTimers[this.activeSessionId];
      this.hideRespawnTimer();
      return;
    }

    this.$('respawnTimer').textContent = this.formatTime(remaining);
  }

  updateRespawnTokens(tokens) {
    // Skip if tokens haven't changed (avoid unnecessary DOM writes)
    const isObject = tokens && typeof tokens === 'object';
    const total = isObject ? tokens.total : tokens;
    if (total === this._lastRespawnTokenTotal) return;
    this._lastRespawnTokenTotal = total;

    const tokensEl = this.$('respawnTokens');
    const input = isObject ? (tokens.input || 0) : Math.round(total * 0.6);
    const output = isObject ? (tokens.output || 0) : Math.round(total * 0.4);

    if (total > 0) {
      tokensEl.style.display = '';
      const tokenStr = this.formatTokens(total);
      const settings = this.loadAppSettingsFromStorage();
      const showCost = settings.showCost ?? false;
      if (showCost) {
        const estimatedCost = this.estimateCost(input, output);
        tokensEl.textContent = `${tokenStr} tokens · $${estimatedCost.toFixed(2)}`;
      } else {
        tokensEl.textContent = `${tokenStr} tokens`;
      }
    } else {
      tokensEl.style.display = 'none';
    }

    // Also update mobile CLI info bar (shows tokens on mobile)
    this.updateCliInfoDisplay();
  }

  // Update CLI info display (tokens, version, model - shown on mobile)
  updateCliInfoDisplay() {
    const infoBar = this.$('cliInfoBar');
    if (!infoBar) return;

    const session = this.sessions.get(this.activeSessionId);
    if (!session) {
      infoBar.style.display = 'none';
      return;
    }

    // Build display parts - tokens first (most important on mobile)
    let parts = [];

    // Add tokens if available
    if (session.tokens) {
      const total = typeof session.tokens === 'object' ? session.tokens.total : session.tokens;
      if (total > 0) {
        parts.push(`${this.formatTokens(total)} tokens`);
      }
    }

    // Add model (condensed)
    if (session.cliModel) {
      // Shorten model names for mobile: "claude-sonnet-4-20250514" -> "Sonnet 4"
      let model = session.cliModel;
      if (model.includes('opus')) model = 'Opus';
      else if (model.includes('sonnet')) model = 'Sonnet';
      else if (model.includes('haiku')) model = 'Haiku';
      parts.push(model);
    }

    // Add version (compact format)
    if (session.cliVersion) {
      // Show "v2.1.27" or "v2.1.27 ↑" if update available
      let versionStr = `v${session.cliVersion}`;
      if (session.cliLatestVersion && session.cliLatestVersion !== session.cliVersion) {
        versionStr += ' ↑'; // Arrow indicates update available
      }
      parts.push(versionStr);
    }

    if (parts.length > 0) {
      infoBar.textContent = parts.join(' · ');
      infoBar.style.display = '';
    } else {
      infoBar.style.display = 'none';
    }
  }

  // ========== Countdown Timer Display Methods ==========

  addActionLogEntry(sessionId, action) {
    // Only keep truly interesting events - no spam
    // KEEP: command (inputs), hook events, AI verdicts, plan verdicts
    // SKIP: timer, timer-cancel, state changes, routine detection, step confirmations

    const interestingTypes = ['command', 'hook'];

    // Always keep commands and hooks
    if (interestingTypes.includes(action.type)) {
      // ok, keep it
    }
    // AI check: only verdicts (IDLE, WORKING) and errors, not "Spawning"
    else if (action.type === 'ai-check') {
      if (action.detail.includes('Spawning')) return;
    }
    // Plan check: only verdicts, not "Spawning"
    else if (action.type === 'plan-check') {
      if (action.detail.includes('Spawning')) return;
    }
    // Transcript: keep completion/plan detection
    else if (action.type === 'transcript') {
      // keep it
    }
    // Skip everything else (timer, timer-cancel, state, detection, step)
    else {
      return;
    }

    if (!this.respawnActionLogs[sessionId]) {
      this.respawnActionLogs[sessionId] = [];
    }
    this.respawnActionLogs[sessionId].unshift(action);
    // Keep reasonable history
    if (this.respawnActionLogs[sessionId].length > 30) {
      this.respawnActionLogs[sessionId].pop();
    }
  }

  startCountdownInterval() {
    if (this.timerCountdownInterval) return;
    this.timerCountdownInterval = setInterval(() => {
      if (this.activeSessionId && this.respawnCountdownTimers[this.activeSessionId]) {
        this.updateCountdownTimerDisplay();
      }
    }, 100);
  }

  stopCountdownInterval() {
    if (this.timerCountdownInterval) {
      clearInterval(this.timerCountdownInterval);
      this.timerCountdownInterval = null;
    }
  }

  updateCountdownTimerDisplay() {
    const timersContainer = this.$('respawnCountdownTimers');
    const row2 = this.$('respawnStatusRow2');
    if (!timersContainer) return;

    const timers = this.respawnCountdownTimers[this.activeSessionId];
    const hasTimers = timers && Object.keys(timers).length > 0;

    if (!hasTimers) {
      timersContainer.innerHTML = '';
      // Update row2 visibility
      if (row2) {
        const hookEl = document.getElementById('detectionHook');
        const aiCheckEl = document.getElementById('detectionAiCheck');
        const statusEl = this.$('detectionStatus');
        const hasVisibleContent =
          (hookEl && hookEl.style.display !== 'none') ||
          (aiCheckEl && aiCheckEl.style.display !== 'none') ||
          (statusEl && statusEl.style.display !== 'none');
        row2.style.display = hasVisibleContent ? '' : 'none';
      }
      return;
    }

    // Show row2 since we have timers
    if (row2) row2.style.display = '';

    const now = Date.now();
    let html = '';

    for (const [name, timer] of Object.entries(timers)) {
      const remainingMs = Math.max(0, timer.endsAt - now);
      const remainingSec = (remainingMs / 1000).toFixed(1);
      const percent = Math.max(0, Math.min(100, (remainingMs / timer.totalMs) * 100));

      // Shorter timer name display
      const displayName = name.replace(/-/g, ' ').replace(/^\w/, c => c.toUpperCase());

      html += `<div class="respawn-countdown-timer" title="${timer.reason || ''}">
        <span class="timer-name">${displayName}</span>
        <span class="timer-value">${remainingSec}s</span>
        <div class="respawn-timer-bar">
          <div class="respawn-timer-progress" style="width: ${percent}%"></div>
        </div>
      </div>`;
    }

    timersContainer.innerHTML = html;
  }

  updateActionLogDisplay() {
    const logContainer = this.$('respawnActionLog');
    if (!logContainer) return;

    const actions = this.respawnActionLogs[this.activeSessionId];
    if (!actions || actions.length === 0) {
      logContainer.innerHTML = '';
      return;
    }

    let html = '';
    // Show fewer entries for compact view
    for (const action of actions.slice(0, 5)) {
      const time = new Date(action.timestamp).toLocaleTimeString('en-US', {
        hour12: false,
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
      });
      const isCommand = action.type === 'command';
      const extraClass = isCommand ? ' action-command' : '';
      // Compact format: time [type] detail
      html += `<div class="respawn-action-entry${extraClass}">
        <span class="action-time">${time}</span>
        <span class="action-type">[${action.type}]</span>
        <span class="action-detail">${action.detail}</span>
      </div>`;
    }

    logContainer.innerHTML = html;
  }

  clearCountdownTimers(sessionId) {
    delete this.respawnCountdownTimers[sessionId];
    delete this.respawnActionLogs[sessionId];
    if (sessionId === this.activeSessionId) {
      this.updateCountdownTimerDisplay();
      this.updateActionLogDisplay();
    }
  }

  async stopRespawn() {
    if (!this.activeSessionId) return;
    try {
      await fetch(`/api/sessions/${this.activeSessionId}/respawn/stop`, { method: 'POST' });
      delete this.respawnTimers[this.activeSessionId];
      this.clearCountdownTimers(this.activeSessionId);
    } catch (err) {
      this.showToast('Failed to stop respawn', 'error');
    }
  }

  // ========== Kill Sessions ==========

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
      await fetch('/api/sessions', { method: 'DELETE' });
      this.sessions.clear();
      this.terminalBuffers.clear();
      this.terminalBufferCache.clear();
      this.activeSessionId = null;
      try { localStorage.removeItem('claudeman-active-session'); } catch {}
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

  // ========== Terminal Controls ==========

  clearTerminal() {
    this.terminal.clear();
  }

  /**
   * Restore terminal size to match web UI dimensions.
   * Use this after mobile screen attachment has squeezed the terminal.
   * Sends resize to PTY and Ctrl+L to trigger Claude to redraw.
   */
  async restoreTerminalSize() {
    if (!this.activeSessionId) {
      this.showToast('No active session', 'warning');
      return;
    }

    const dims = this.getTerminalDimensions();
    if (!dims) {
      this.showToast('Could not determine terminal size', 'error');
      return;
    }

    try {
      // Send resize to restore proper dimensions (with minimum enforcement)
      await this.sendResize(this.activeSessionId);

      // Send Ctrl+L to trigger Claude to redraw at new size
      await fetch(`/api/sessions/${this.activeSessionId}/input`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: '\x0c' })
      });

      this.showToast(`Terminal restored to ${dims.cols}x${dims.rows}`, 'success');
    } catch (err) {
      console.error('Failed to restore terminal size:', err);
      this.showToast('Failed to restore terminal size', 'error');
    }
  }

  // Send Ctrl+L to fix display for newly created sessions once Claude is running
  sendPendingCtrlL(sessionId) {
    console.log('[DEBUG] sendPendingCtrlL called for:', sessionId, 'pending:', this.pendingCtrlL ? [...this.pendingCtrlL] : 'none');
    if (!this.pendingCtrlL || !this.pendingCtrlL.has(sessionId)) {
      console.log('[DEBUG] No pending Ctrl+L for this session');
      return;
    }
    this.pendingCtrlL.delete(sessionId);

    // Only send if this is the active session
    if (sessionId !== this.activeSessionId) {
      console.log('[DEBUG] Not active session, skipping Ctrl+L');
      return;
    }

    console.log('[DEBUG] Sending resize + Ctrl+L for session:', sessionId);
    // Send resize + Ctrl+L to fix the display (with minimum dimension enforcement)
    this.sendResize(sessionId).then(() => {
      console.log('[DEBUG] Resize sent, now sending Ctrl+L');
      fetch(`/api/sessions/${sessionId}/input`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: '\x0c' })
      });
    });
  }

  async copyTerminal() {
    try {
      const buffer = this.terminal.buffer.active;
      let text = '';
      for (let i = 0; i < buffer.length; i++) {
        const line = buffer.getLine(i);
        if (line) text += line.translateToString(true) + '\n';
      }
      await navigator.clipboard.writeText(text.replace(/\n+$/, '\n'));
      this.showToast('Copied to clipboard', 'success');
    } catch (err) {
      this.showToast('Failed to copy', 'error');
    }
  }

  increaseFontSize() {
    const current = this.terminal.options.fontSize || 14;
    this.setFontSize(Math.min(current + 2, 24));
  }

  decreaseFontSize() {
    const current = this.terminal.options.fontSize || 14;
    this.setFontSize(Math.max(current - 2, 10));
  }

  setFontSize(size) {
    this.terminal.options.fontSize = size;
    document.getElementById('fontSizeDisplay').textContent = size;
    this.fitAddon.fit();
    localStorage.setItem('claudeman-font-size', size);
  }

  loadFontSize() {
    const saved = localStorage.getItem('claudeman-font-size');
    if (saved) {
      const size = parseInt(saved, 10);
      if (size >= 10 && size <= 24) {
        this.terminal.options.fontSize = size;
        document.getElementById('fontSizeDisplay').textContent = size;
      }
    }
  }

  /**
   * Get terminal dimensions with minimum enforcement.
   * Prevents extremely narrow terminals that cause vertical text wrapping.
   * @returns {{cols: number, rows: number}|null}
   */
  getTerminalDimensions() {
    const MIN_COLS = 40;
    const MIN_ROWS = 10;
    const dims = this.fitAddon?.proposeDimensions();
    if (!dims) return null;
    return {
      cols: Math.max(dims.cols, MIN_COLS),
      rows: Math.max(dims.rows, MIN_ROWS)
    };
  }

  /**
   * Send resize to a session with minimum dimension enforcement.
   * @param {string} sessionId
   * @returns {Promise<void>}
   */
  async sendResize(sessionId) {
    const dims = this.getTerminalDimensions();
    if (!dims) return;
    await fetch(`/api/sessions/${sessionId}/resize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(dims)
    });
  }

  /**
   * Send input to the active session.
   * @param {string} input - Text to send (include \r for Enter)
   * @returns {Promise<void>}
   */
  async sendInput(input) {
    if (!this.activeSessionId) return;
    await fetch(`/api/sessions/${this.activeSessionId}/input`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input, useScreen: true })
    });
  }

  // ========== Timer ==========

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

  // ========== Tokens ==========

  updateCost() {
    // Now updates tokens instead of cost
    this.updateTokens();
  }

  updateTokens() {
    // Debounce at 200ms — token display is non-critical and shouldn't
    // compete with input handling on the main thread
    if (this._updateTokensTimeout) {
      clearTimeout(this._updateTokensTimeout);
    }
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

  // ========== Session Options Modal ==========

  openSessionOptions(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    this.editingSessionId = sessionId;

    // Reset to Respawn tab
    this.switchOptionsTab('respawn');

    // Update respawn status display and buttons
    const respawnStatus = document.getElementById('sessionRespawnStatus');
    const enableBtn = document.getElementById('modalEnableRespawnBtn');
    const stopBtn = document.getElementById('modalStopRespawnBtn');

    if (this.respawnStatus[sessionId]) {
      respawnStatus.classList.add('active');
      respawnStatus.querySelector('.respawn-status-text').textContent =
        this.respawnStatus[sessionId].state || 'Active';
      enableBtn.style.display = 'none';
      stopBtn.style.display = '';
    } else {
      respawnStatus.classList.remove('active');
      respawnStatus.querySelector('.respawn-status-text').textContent = 'Not active';
      enableBtn.style.display = '';
      stopBtn.style.display = 'none';
    }

    // Only show respawn section for claude mode sessions with a running process
    const respawnSection = document.getElementById('sessionRespawnSection');
    if (session.mode === 'claude' && session.pid) {
      respawnSection.style.display = '';
    } else {
      respawnSection.style.display = 'none';
    }

    // Reset duration presets to default (unlimited)
    this.selectDurationPreset('');

    // Populate respawn config from saved state
    this.loadSavedRespawnConfig(sessionId);

    // Populate auto-compact/clear from session state
    document.getElementById('modalAutoCompactEnabled').checked = session.autoCompactEnabled ?? false;
    document.getElementById('modalAutoCompactThreshold').value = session.autoCompactThreshold ?? 110000;
    document.getElementById('modalAutoCompactPrompt').value = session.autoCompactPrompt ?? '';
    document.getElementById('modalAutoClearEnabled').checked = session.autoClearEnabled ?? false;
    document.getElementById('modalAutoClearThreshold').value = session.autoClearThreshold ?? 140000;
    document.getElementById('modalImageWatcherEnabled').checked = session.imageWatcherEnabled ?? true;
    document.getElementById('modalFlickerFilterEnabled').checked = session.flickerFilterEnabled ?? false;

    // Initialize color picker with current session color
    const currentColor = session.color || 'default';
    const colorPicker = document.getElementById('sessionColorPicker');
    colorPicker?.querySelectorAll('.color-swatch').forEach(s => {
      s.classList.toggle('selected', s.dataset.color === currentColor);
    });

    // Initialize respawn preset dropdown
    this.renderPresetDropdown();
    document.getElementById('respawnPresetSelect').value = '';
    document.getElementById('presetDescriptionHint').textContent = '';

    // Populate Ralph Wiggum form with current session values
    const ralphState = this.ralphStates.get(sessionId);
    this.populateRalphForm({
      enabled: ralphState?.loop?.enabled ?? session.ralphLoop?.enabled ?? false,
      completionPhrase: ralphState?.loop?.completionPhrase || session.ralphLoop?.completionPhrase || '',
      maxIterations: ralphState?.loop?.maxIterations || session.ralphLoop?.maxIterations || 0,
    });

    const modal = document.getElementById('sessionOptionsModal');
    modal.classList.add('active');

    // Activate focus trap
    this.activeFocusTrap = new FocusTrap(modal);
    this.activeFocusTrap.activate();
  }

  async autoSaveAutoCompact() {
    if (!this.editingSessionId) return;
    try {
      await fetch(`/api/sessions/${this.editingSessionId}/auto-compact`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          enabled: document.getElementById('modalAutoCompactEnabled').checked,
          threshold: parseInt(document.getElementById('modalAutoCompactThreshold').value) || 110000,
          prompt: document.getElementById('modalAutoCompactPrompt').value.trim() || undefined
        })
      });
    } catch { /* silent */ }
  }

  async autoSaveAutoClear() {
    if (!this.editingSessionId) return;
    try {
      await fetch(`/api/sessions/${this.editingSessionId}/auto-clear`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          enabled: document.getElementById('modalAutoClearEnabled').checked,
          threshold: parseInt(document.getElementById('modalAutoClearThreshold').value) || 140000
        })
      });
    } catch { /* silent */ }
  }

  async toggleSessionImageWatcher() {
    if (!this.editingSessionId) return;
    const enabled = document.getElementById('modalImageWatcherEnabled').checked;
    try {
      await fetch(`/api/sessions/${this.editingSessionId}/image-watcher`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled })
      });
      // Update local session state
      const session = this.sessions.get(this.editingSessionId);
      if (session) {
        session.imageWatcherEnabled = enabled;
      }
      this.showToast(`Image watcher ${enabled ? 'enabled' : 'disabled'}`, 'success');
    } catch (err) {
      this.showToast('Failed to toggle image watcher', 'error');
    }
  }

  async toggleFlickerFilter() {
    if (!this.editingSessionId) return;
    const enabled = document.getElementById('modalFlickerFilterEnabled').checked;
    try {
      await fetch(`/api/sessions/${this.editingSessionId}/flicker-filter`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled })
      });
      // Update local session state
      const session = this.sessions.get(this.editingSessionId);
      if (session) {
        session.flickerFilterEnabled = enabled;
      }
      this.showToast(`Flicker filter ${enabled ? 'enabled' : 'disabled'}`, 'success');
    } catch (err) {
      this.showToast('Failed to toggle flicker filter', 'error');
    }
  }

  async autoSaveRespawnConfig() {
    if (!this.editingSessionId) return;
    const config = {
      updatePrompt: document.getElementById('modalRespawnPrompt').value,
      sendClear: document.getElementById('modalRespawnSendClear').checked,
      sendInit: document.getElementById('modalRespawnSendInit').checked,
      kickstartPrompt: document.getElementById('modalRespawnKickstart').value.trim() || undefined,
      autoAcceptPrompts: document.getElementById('modalRespawnAutoAccept').checked,
    };
    try {
      await fetch(`/api/sessions/${this.editingSessionId}/respawn/config`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config)
      });
    } catch {
      // Silent save - don't interrupt user
    }
  }

  async loadSavedRespawnConfig(sessionId) {
    try {
      const res = await fetch(`/api/sessions/${sessionId}/respawn/config`);
      const data = await res.json();
      if (data.success && data.config) {
        const c = data.config;
        document.getElementById('modalRespawnPrompt').value = c.updatePrompt || 'update all the docs and CLAUDE.md';
        document.getElementById('modalRespawnSendClear').checked = c.sendClear ?? true;
        document.getElementById('modalRespawnSendInit').checked = c.sendInit ?? true;
        document.getElementById('modalRespawnKickstart').value = c.kickstartPrompt || '';
        document.getElementById('modalRespawnAutoAccept').checked = c.autoAcceptPrompts ?? true;
        // Restore duration if set
        if (c.durationMinutes) {
          const presetBtn = document.querySelector(`.duration-preset-btn[data-minutes="${c.durationMinutes}"]`);
          if (presetBtn) {
            this.selectDurationPreset(String(c.durationMinutes));
          } else {
            this.selectDurationPreset('custom');
            document.getElementById('modalRespawnDuration').value = c.durationMinutes;
          }
        }
      }
    } catch {
      // Ignore - use defaults
    }
  }

  // Handle duration preset selection
  selectDurationPreset(value) {
    // Remove active from all buttons
    document.querySelectorAll('.duration-preset-btn').forEach(btn => btn.classList.remove('active'));

    // Find and activate the clicked button
    const btn = document.querySelector(`.duration-preset-btn[data-minutes="${value}"]`);
    if (btn) btn.classList.add('active');

    // Show/hide custom input
    const customInput = document.querySelector('.duration-custom-input');
    const durationInput = document.getElementById('modalRespawnDuration');

    if (value === 'custom') {
      customInput.classList.add('visible');
      durationInput.focus();
    } else {
      customInput.classList.remove('visible');
      durationInput.value = ''; // Clear custom value when using preset
    }
  }

  // Get selected duration from preset buttons or custom input
  getSelectedDuration() {
    const customInput = document.querySelector('.duration-custom-input');
    const durationInput = document.getElementById('modalRespawnDuration');

    if (customInput.classList.contains('visible')) {
      // Custom mode - use input value
      return durationInput.value ? parseInt(durationInput.value) : null;
    } else {
      // Preset mode - get from active button
      const activeBtn = document.querySelector('.duration-preset-btn.active');
      const minutes = activeBtn?.dataset.minutes;
      return minutes ? parseInt(minutes) : null;
    }
  }

  // ========== Respawn Presets ==========

  loadRespawnPresets() {
    const saved = localStorage.getItem('claudeman-respawn-presets');
    const custom = saved ? JSON.parse(saved) : [];
    return [...BUILTIN_RESPAWN_PRESETS, ...custom];
  }

  saveRespawnPresets(presets) {
    // Only save custom presets (not built-in)
    const custom = presets.filter(p => !p.builtIn);
    localStorage.setItem('claudeman-respawn-presets', JSON.stringify(custom));
  }

  renderPresetDropdown() {
    const presets = this.loadRespawnPresets();
    const builtinGroup = document.getElementById('builtinPresetsGroup');
    const customGroup = document.getElementById('customPresetsGroup');

    if (!builtinGroup || !customGroup) return;

    // Clear and repopulate
    builtinGroup.innerHTML = '';
    customGroup.innerHTML = '';

    presets.forEach(preset => {
      const option = document.createElement('option');
      option.value = preset.id;
      option.textContent = preset.name;
      if (preset.builtIn) {
        builtinGroup.appendChild(option);
      } else {
        customGroup.appendChild(option);
      }
    });
  }

  updatePresetDescription() {
    const select = document.getElementById('respawnPresetSelect');
    const hint = document.getElementById('presetDescriptionHint');
    if (!select || !hint) return;

    const presetId = select.value;
    if (!presetId) {
      hint.textContent = '';
      return;
    }

    const presets = this.loadRespawnPresets();
    const preset = presets.find(p => p.id === presetId);
    hint.textContent = preset?.description || '';
  }

  loadRespawnPreset() {
    const select = document.getElementById('respawnPresetSelect');
    const presetId = select?.value;
    if (!presetId) {
      this.showToast('Please select a preset first', 'warning');
      return;
    }

    const presets = this.loadRespawnPresets();
    const preset = presets.find(p => p.id === presetId);
    if (!preset) return;

    // Populate form fields
    document.getElementById('modalRespawnPrompt').value = preset.config.updatePrompt || '';
    document.getElementById('modalRespawnSendClear').checked = preset.config.sendClear ?? false;
    document.getElementById('modalRespawnSendInit').checked = preset.config.sendInit ?? false;
    document.getElementById('modalRespawnKickstart').value = preset.config.kickstartPrompt || '';

    // Set duration if available
    if (preset.durationMinutes) {
      this.selectDurationPreset(String(preset.durationMinutes));
    }

    // Reset select to placeholder
    select.value = '';
    document.getElementById('presetDescriptionHint').textContent = '';

    this.showToast(`Loaded preset: ${preset.name}`, 'info');
  }

  saveCurrentAsPreset() {
    document.getElementById('savePresetModal').classList.add('active');
    document.getElementById('presetNameInput').value = '';
    document.getElementById('presetDescriptionInput').value = '';
    document.getElementById('presetNameInput').focus();
  }

  closeSavePresetModal() {
    document.getElementById('savePresetModal').classList.remove('active');
  }

  confirmSavePreset() {
    const name = document.getElementById('presetNameInput').value.trim();
    if (!name) {
      this.showToast('Please enter a preset name', 'error');
      return;
    }

    // Get current config from form
    const updatePrompt = document.getElementById('modalRespawnPrompt').value;
    const sendClear = document.getElementById('modalRespawnSendClear').checked;
    const sendInit = document.getElementById('modalRespawnSendInit').checked;
    const kickstartPrompt = document.getElementById('modalRespawnKickstart').value.trim() || undefined;
    const durationMinutes = this.getSelectedDuration();

    const newPreset = {
      id: 'custom-' + Date.now(),
      name,
      description: document.getElementById('presetDescriptionInput').value.trim() || undefined,
      config: {
        idleTimeoutMs: 5000, // Default
        updatePrompt,
        interStepDelayMs: 3000, // Default
        sendClear,
        sendInit,
        kickstartPrompt,
      },
      durationMinutes: durationMinutes || undefined,
      builtIn: false,
      createdAt: Date.now(),
    };

    const presets = this.loadRespawnPresets();
    presets.push(newPreset);
    this.saveRespawnPresets(presets);
    this.renderPresetDropdown();
    this.closeSavePresetModal();
    this.showToast(`Saved preset: ${name}`, 'success');
  }

  deletePreset(presetId) {
    const presets = this.loadRespawnPresets();
    const preset = presets.find(p => p.id === presetId);
    if (!preset || preset.builtIn) {
      this.showToast('Cannot delete built-in presets', 'warning');
      return;
    }

    const filtered = presets.filter(p => p.id !== presetId);
    this.saveRespawnPresets(filtered);
    this.renderPresetDropdown();
    this.showToast(`Deleted preset: ${preset.name}`, 'success');
  }

  // Get respawn config from modal inputs
  getModalRespawnConfig() {
    const updatePrompt = document.getElementById('modalRespawnPrompt').value;
    const sendClear = document.getElementById('modalRespawnSendClear').checked;
    const sendInit = document.getElementById('modalRespawnSendInit').checked;
    const kickstartPrompt = document.getElementById('modalRespawnKickstart').value.trim() || undefined;
    const autoAcceptPrompts = document.getElementById('modalRespawnAutoAccept').checked;
    const durationMinutes = this.getSelectedDuration();

    // Auto-compact settings
    const autoCompactEnabled = document.getElementById('modalAutoCompactEnabled').checked;
    const autoCompactThreshold = parseInt(document.getElementById('modalAutoCompactThreshold').value) || 110000;
    const autoCompactPrompt = document.getElementById('modalAutoCompactPrompt').value.trim() || undefined;

    // Auto-clear settings
    const autoClearEnabled = document.getElementById('modalAutoClearEnabled').checked;
    const autoClearThreshold = parseInt(document.getElementById('modalAutoClearThreshold').value) || 140000;

    return {
      respawnConfig: {
        enabled: true,  // Fix: ensure enabled is set so pre-saved configs with enabled: false get overridden
        updatePrompt,
        sendClear,
        sendInit,
        kickstartPrompt,
        autoAcceptPrompts,
      },
      durationMinutes,
      autoCompactEnabled,
      autoCompactThreshold,
      autoCompactPrompt,
      autoClearEnabled,
      autoClearThreshold
    };
  }

  async enableRespawnFromModal() {
    if (!this.editingSessionId) {
      this.showToast('No session selected', 'warning');
      return;
    }

    const {
      respawnConfig,
      durationMinutes,
      autoCompactEnabled,
      autoCompactThreshold,
      autoCompactPrompt,
      autoClearEnabled,
      autoClearThreshold
    } = this.getModalRespawnConfig();

    try {
      // Enable respawn on the session
      const res = await fetch(`/api/sessions/${this.editingSessionId}/respawn/enable`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ config: respawnConfig, durationMinutes })
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);

      // Set auto-compact if enabled
      if (autoCompactEnabled) {
        await fetch(`/api/sessions/${this.editingSessionId}/auto-compact`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ enabled: true, threshold: autoCompactThreshold, prompt: autoCompactPrompt })
        });
      }

      // Set auto-clear if enabled
      if (autoClearEnabled) {
        await fetch(`/api/sessions/${this.editingSessionId}/auto-clear`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ enabled: true, threshold: autoClearThreshold })
        });
      }

      // Update UI
      const respawnStatus = document.getElementById('sessionRespawnStatus');
      respawnStatus.classList.add('active');
      respawnStatus.querySelector('.respawn-status-text').textContent = 'WATCHING';
      document.getElementById('modalEnableRespawnBtn').style.display = 'none';
      document.getElementById('modalStopRespawnBtn').style.display = '';

      this.showToast('Respawn enabled', 'success');
    } catch (err) {
      this.showToast('Failed to enable respawn: ' + err.message, 'error');
    }
  }

  async stopRespawnFromModal() {
    if (!this.editingSessionId) return;
    try {
      await fetch(`/api/sessions/${this.editingSessionId}/respawn/stop`, { method: 'POST' });
      delete this.respawnTimers[this.editingSessionId];

      // Update the modal display
      const respawnStatus = document.getElementById('sessionRespawnStatus');
      respawnStatus.classList.remove('active');
      respawnStatus.querySelector('.respawn-status-text').textContent = 'Not active';
      document.getElementById('modalEnableRespawnBtn').style.display = '';
      document.getElementById('modalStopRespawnBtn').style.display = 'none';

      this.showToast('Respawn stopped', 'success');
    } catch (err) {
      this.showToast('Failed to stop respawn', 'error');
    }
  }

  closeSessionOptions() {
    this.editingSessionId = null;
    // Stop run summary auto-refresh if it was running
    this.stopRunSummaryAutoRefresh();
    document.getElementById('sessionOptionsModal').classList.remove('active');

    // Deactivate focus trap and restore focus
    if (this.activeFocusTrap) {
      this.activeFocusTrap.deactivate();
      this.activeFocusTrap = null;
    }
  }

  setupColorPicker() {
    const picker = document.getElementById('sessionColorPicker');
    if (!picker) return;

    picker.addEventListener('click', (e) => {
      const swatch = e.target.closest('.color-swatch');
      if (!swatch || !this.editingSessionId) return;

      const color = swatch.dataset.color;
      this.setSessionColor(this.editingSessionId, color);
    });
  }

  async setSessionColor(sessionId, color) {
    try {
      const res = await fetch(`/api/sessions/${sessionId}/color`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ color })
      });

      if (res.ok) {
        const session = this.sessions.get(sessionId);
        if (session) {
          session.color = color;
          this.renderSessionTabs();
        }

        // Update picker UI to show selection
        const picker = document.getElementById('sessionColorPicker');
        if (picker) {
          picker.querySelectorAll('.color-swatch').forEach(swatch => {
            swatch.classList.toggle('selected', swatch.dataset.color === color);
          });
        }
      } else {
        this.showToast('Failed to set session color', 'error');
      }
    } catch (err) {
      this.showToast('Failed to set session color', 'error');
    }
  }

  // ========== Run Summary Modal ==========

  async openRunSummary(sessionId) {
    // Open session options modal and switch to summary tab
    this.openSessionOptions(sessionId);
    this.switchOptionsTab('summary');

    this.runSummarySessionId = sessionId;
    this.runSummaryFilter = 'all';

    // Reset filter buttons
    document.querySelectorAll('.run-summary-filters .filter-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.filter === 'all');
    });

    // Load summary data
    await this.loadRunSummary(sessionId);
  }

  closeRunSummary() {
    this.runSummarySessionId = null;
    this.stopRunSummaryAutoRefresh();
    // Close session options modal (summary is now a tab in it)
    this.closeSessionOptions();
  }

  async refreshRunSummary() {
    const sessionId = this.runSummarySessionId || this.editingSessionId;
    if (!sessionId) return;
    await this.loadRunSummary(sessionId);
  }

  toggleRunSummaryAutoRefresh() {
    const checkbox = document.getElementById('runSummaryAutoRefresh');
    if (checkbox.checked) {
      this.startRunSummaryAutoRefresh();
    } else {
      this.stopRunSummaryAutoRefresh();
    }
  }

  startRunSummaryAutoRefresh() {
    if (this.runSummaryAutoRefreshTimer) return;
    this.runSummaryAutoRefreshTimer = setInterval(() => {
      if (this.runSummarySessionId) {
        this.loadRunSummary(this.runSummarySessionId);
      }
    }, 5000); // Refresh every 5 seconds
  }

  stopRunSummaryAutoRefresh() {
    if (this.runSummaryAutoRefreshTimer) {
      clearInterval(this.runSummaryAutoRefreshTimer);
      this.runSummaryAutoRefreshTimer = null;
    }
    const checkbox = document.getElementById('runSummaryAutoRefresh');
    if (checkbox) checkbox.checked = false;
  }

  exportRunSummary(format) {
    if (!this.runSummaryData) {
      this.showToast('No summary data to export', 'error');
      return;
    }

    const { stats, events, sessionName, startedAt, lastUpdatedAt } = this.runSummaryData;
    const timestamp = new Date().toISOString().slice(0, 19).replace(/:/g, '-');
    const filename = `run-summary-${sessionName || 'session'}-${timestamp}`;

    if (format === 'json') {
      const json = JSON.stringify(this.runSummaryData, null, 2);
      this.downloadFile(`${filename}.json`, json, 'application/json');
    } else if (format === 'md') {
      const duration = lastUpdatedAt - startedAt;
      let md = `# Run Summary: ${sessionName || 'Session'}\n\n`;
      md += `**Duration**: ${this.formatDuration(duration)}\n`;
      md += `**Started**: ${new Date(startedAt).toLocaleString()}\n`;
      md += `**Last Update**: ${new Date(lastUpdatedAt).toLocaleString()}\n\n`;

      md += `## Statistics\n\n`;
      md += `| Metric | Value |\n`;
      md += `|--------|-------|\n`;
      md += `| Respawn Cycles | ${stats.totalRespawnCycles} |\n`;
      md += `| Peak Tokens | ${this.formatTokens(stats.peakTokens)} |\n`;
      md += `| Active Time | ${this.formatDuration(stats.totalTimeActiveMs)} |\n`;
      md += `| Idle Time | ${this.formatDuration(stats.totalTimeIdleMs)} |\n`;
      md += `| Errors | ${stats.errorCount} |\n`;
      md += `| Warnings | ${stats.warningCount} |\n`;
      md += `| AI Checks | ${stats.aiCheckCount} |\n`;
      md += `| State Transitions | ${stats.stateTransitions} |\n\n`;

      md += `## Event Timeline\n\n`;
      if (events.length === 0) {
        md += `No events recorded.\n`;
      } else {
        md += `| Time | Type | Severity | Title | Details |\n`;
        md += `|------|------|----------|-------|----------|\n`;
        for (const event of events) {
          const time = new Date(event.timestamp).toLocaleTimeString('en-US', { hour12: false });
          const details = event.details ? event.details.replace(/\|/g, '\\|') : '-';
          md += `| ${time} | ${event.type} | ${event.severity} | ${event.title} | ${details} |\n`;
        }
      }

      this.downloadFile(`${filename}.md`, md, 'text/markdown');
    }

    this.showToast(`Exported as ${format.toUpperCase()}`, 'success');
  }

  downloadFile(filename, content, mimeType) {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  async loadRunSummary(sessionId) {
    const timeline = document.getElementById('runSummaryTimeline');
    timeline.innerHTML = '<p class="empty-message">Loading summary...</p>';

    try {
      const response = await fetch(`/api/sessions/${sessionId}/run-summary`);
      const data = await response.json();

      if (!data.success) {
        timeline.innerHTML = `<p class="empty-message">Failed to load summary: ${data.error}</p>`;
        return;
      }

      this.runSummaryData = data.summary;
      this.renderRunSummary();
    } catch (err) {
      console.error('Failed to load run summary:', err);
      timeline.innerHTML = '<p class="empty-message">Failed to load summary</p>';
    }
  }

  renderRunSummary() {
    if (!this.runSummaryData) return;

    const { stats, events, sessionName, startedAt, lastUpdatedAt } = this.runSummaryData;

    // Update session info
    const duration = lastUpdatedAt - startedAt;
    document.getElementById('runSummarySessionInfo').textContent =
      `${sessionName || 'Session'} - ${this.formatDuration(duration)} total`;

    // Filter and render events
    const filteredEvents = this.filterRunSummaryEvents(events);
    this.renderRunSummaryTimeline(filteredEvents);
  }

  filterRunSummaryEvents(events) {
    if (this.runSummaryFilter === 'all') return events;

    return events.filter(event => {
      switch (this.runSummaryFilter) {
        case 'errors': return event.severity === 'error';
        case 'warnings': return event.severity === 'warning' || event.severity === 'error';
        case 'respawn': return event.type.startsWith('respawn_') || event.type === 'state_stuck';
        case 'idle': return event.type === 'idle_detected' || event.type === 'working_detected';
        default: return true;
      }
    });
  }

  filterRunSummary(filter) {
    this.runSummaryFilter = filter;

    // Update active state on buttons
    document.querySelectorAll('.run-summary-filters .filter-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.filter === filter);
    });

    this.renderRunSummary();
  }

  renderRunSummaryTimeline(events) {
    const timeline = document.getElementById('runSummaryTimeline');

    if (!events || events.length === 0) {
      timeline.innerHTML = '<p class="empty-message">No events recorded yet</p>';
      return;
    }

    // Reverse to show most recent first
    const reversedEvents = [...events].reverse();

    const html = reversedEvents.map(event => {
      const time = new Date(event.timestamp).toLocaleTimeString('en-US', { hour12: false });
      const severityClass = `event-${event.severity}`;
      const icon = this.getEventIcon(event.type, event.severity);

      return `
        <div class="timeline-event ${severityClass}">
          <div class="event-icon">${icon}</div>
          <div class="event-content">
            <div class="event-header">
              <span class="event-title">${this.escapeHtml(event.title)}</span>
              <span class="event-time">${time}</span>
            </div>
            ${event.details ? `<div class="event-details">${this.escapeHtml(event.details)}</div>` : ''}
          </div>
        </div>
      `;
    }).join('');

    timeline.innerHTML = html;
  }

  getEventIcon(type, severity) {
    if (severity === 'error') return '&#x274C;'; // Red X
    if (severity === 'warning') return '&#x26A0;'; // Warning triangle
    if (severity === 'success') return '&#x2714;'; // Checkmark

    switch (type) {
      case 'session_started': return '&#x1F680;'; // Rocket
      case 'session_stopped': return '&#x1F6D1;'; // Stop sign
      case 'respawn_cycle_started': return '&#x1F504;'; // Cycle
      case 'respawn_cycle_completed': return '&#x2705;'; // Green check
      case 'respawn_state_change': return '&#x27A1;'; // Arrow
      case 'token_milestone': return '&#x1F4B0;'; // Money bag
      case 'idle_detected': return '&#x1F4A4;'; // Zzz
      case 'working_detected': return '&#x1F4BB;'; // Laptop
      case 'ai_check_result': return '&#x1F916;'; // Robot
      case 'hook_event': return '&#x1F514;'; // Bell
      default: return '&#x2022;'; // Bullet
    }
  }

  formatTokens(tokens) {
    if (tokens >= 1000000) return `${(tokens / 1000000).toFixed(1)}M`;
    if (tokens >= 1000) return `${(tokens / 1000).toFixed(1)}k`;
    return String(tokens || 0);
  }

  formatDuration(ms) {
    if (!ms || ms < 0) return '0s';
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);

    if (hours > 0) return `${hours}h ${minutes % 60}m`;
    if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
    return `${seconds}s`;
  }

  saveSessionOptions() {
    // Session options are applied immediately via individual controls
    // This just closes the modal
    this.closeSessionOptions();
  }

  // ========== Session Options Modal Tabs ==========

  switchOptionsTab(tabName) {
    // Toggle active class on tab buttons
    document.querySelectorAll('#sessionOptionsModal .modal-tab-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.tab === tabName);
    });

    // Toggle hidden class on tab content
    document.getElementById('respawn-tab').classList.toggle('hidden', tabName !== 'respawn');
    document.getElementById('context-tab').classList.toggle('hidden', tabName !== 'context');
    document.getElementById('ralph-tab').classList.toggle('hidden', tabName !== 'ralph');
    document.getElementById('summary-tab').classList.toggle('hidden', tabName !== 'summary');

    // Load run summary data when switching to summary tab
    if (tabName === 'summary' && this.editingSessionId) {
      this.loadRunSummary(this.editingSessionId);
    }
  }

  getRalphConfig() {
    return {
      enabled: document.getElementById('modalRalphEnabled').checked,
      completionPhrase: document.getElementById('modalRalphPhrase').value.trim(),
      maxIterations: parseInt(document.getElementById('modalRalphMaxIterations').value) || 0,
      maxTodos: parseInt(document.getElementById('modalRalphMaxTodos').value) || 50,
      todoExpirationMinutes: parseInt(document.getElementById('modalRalphTodoExpiration').value) || 60
    };
  }

  populateRalphForm(config) {
    document.getElementById('modalRalphEnabled').checked = config?.enabled ?? false;
    document.getElementById('modalRalphPhrase').value = config?.completionPhrase || '';
    document.getElementById('modalRalphMaxIterations').value = config?.maxIterations || 0;
    document.getElementById('modalRalphMaxTodos').value = config?.maxTodos || 50;
    document.getElementById('modalRalphTodoExpiration').value = config?.todoExpirationMinutes || 60;
  }

  async saveRalphConfig() {
    if (!this.editingSessionId) {
      this.showToast('No session selected', 'warning');
      return;
    }

    const config = this.getRalphConfig();

    // If user is enabling Ralph, clear from closed set
    if (config.enabled) {
      this.ralphClosedSessions.delete(this.editingSessionId);
    }

    try {
      const res = await fetch(`/api/sessions/${this.editingSessionId}/ralph-config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config)
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);

      this.showToast('Ralph config saved', 'success');
    } catch (err) {
      this.showToast('Failed to save Ralph config: ' + err.message, 'error');
    }
  }

  // Inline rename on right-click
  startInlineRename(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    const tabName = document.querySelector(`.tab-name[data-session-id="${sessionId}"]`);
    if (!tabName) return;

    const currentName = this.getSessionName(session);
    const input = document.createElement('input');
    input.type = 'text';
    input.value = session.name || '';
    input.placeholder = currentName;
    input.className = 'tab-rename-input';
    input.style.cssText = 'width: 80px; font-size: 0.75rem; padding: 2px 4px; background: var(--bg-input); border: 1px solid var(--accent); border-radius: 3px; color: var(--text); outline: none;';

    const originalContent = tabName.textContent;
    tabName.textContent = '';
    tabName.appendChild(input);
    input.focus();
    input.select();

    const finishRename = async () => {
      const newName = input.value.trim();
      tabName.textContent = newName || originalContent;

      if (newName && newName !== session.name) {
        try {
          await fetch(`/api/sessions/${sessionId}/name`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: newName })
          });
        } catch (err) {
          tabName.textContent = originalContent;
          this.showToast('Failed to rename', 'error');
        }
      }
    };

    input.addEventListener('blur', finishRename);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        input.blur();
      } else if (e.key === 'Escape') {
        input.value = '';
        input.blur();
      }
    });
  }

  // ========== App Settings Modal ==========

  openAppSettings() {
    // Load current settings
    const settings = this.loadAppSettingsFromStorage();
    document.getElementById('appSettingsClaudeMdPath').value = settings.defaultClaudeMdPath || '';
    document.getElementById('appSettingsDefaultDir').value = settings.defaultWorkingDir || '';
    // Use device-aware defaults for display settings (mobile has different defaults)
    const defaults = this.getDefaultSettings();
    document.getElementById('appSettingsRalphEnabled').checked = settings.ralphTrackerEnabled ?? defaults.ralphTrackerEnabled ?? false;
    // Header visibility settings
    document.getElementById('appSettingsShowFontControls').checked = settings.showFontControls ?? defaults.showFontControls ?? false;
    document.getElementById('appSettingsShowSystemStats').checked = settings.showSystemStats ?? defaults.showSystemStats ?? true;
    document.getElementById('appSettingsShowTokenCount').checked = settings.showTokenCount ?? defaults.showTokenCount ?? true;
    document.getElementById('appSettingsShowCost').checked = settings.showCost ?? defaults.showCost ?? false;
    document.getElementById('appSettingsShowMonitor').checked = settings.showMonitor ?? defaults.showMonitor ?? true;
    document.getElementById('appSettingsShowProjectInsights').checked = settings.showProjectInsights ?? defaults.showProjectInsights ?? false;
    document.getElementById('appSettingsShowFileBrowser').checked = settings.showFileBrowser ?? defaults.showFileBrowser ?? false;
    document.getElementById('appSettingsShowSubagents').checked = settings.showSubagents ?? defaults.showSubagents ?? false;
    document.getElementById('appSettingsSubagentTracking').checked = settings.subagentTrackingEnabled ?? defaults.subagentTrackingEnabled ?? true;
    document.getElementById('appSettingsSubagentActiveTabOnly').checked = settings.subagentActiveTabOnly ?? defaults.subagentActiveTabOnly ?? true;
    document.getElementById('appSettingsImageWatcherEnabled').checked = settings.imageWatcherEnabled ?? defaults.imageWatcherEnabled ?? false;
    // Claude CLI settings
    const claudeModeSelect = document.getElementById('appSettingsClaudeMode');
    const allowedToolsRow = document.getElementById('allowedToolsRow');
    claudeModeSelect.value = settings.claudeMode || 'dangerously-skip-permissions';
    document.getElementById('appSettingsAllowedTools').value = settings.allowedTools || '';
    allowedToolsRow.style.display = claudeModeSelect.value === 'allowedTools' ? '' : 'none';
    // Toggle allowed tools row visibility based on mode selection
    claudeModeSelect.onchange = () => {
      allowedToolsRow.style.display = claudeModeSelect.value === 'allowedTools' ? '' : 'none';
    };
    // Claude Permissions settings
    document.getElementById('appSettingsAgentTeams').checked = settings.agentTeamsEnabled ?? false;
    // CPU Priority settings
    const niceSettings = settings.nice || {};
    document.getElementById('appSettingsNiceEnabled').checked = niceSettings.enabled ?? false;
    document.getElementById('appSettingsNiceValue').value = niceSettings.niceValue ?? 10;
    // Model configuration (loaded from server)
    this.loadModelConfigForSettings();
    // Notification settings
    const notifPrefs = this.notificationManager?.preferences || {};
    document.getElementById('appSettingsNotifEnabled').checked = notifPrefs.enabled ?? true;
    document.getElementById('appSettingsNotifBrowser').checked = notifPrefs.browserNotifications ?? false;
    document.getElementById('appSettingsNotifAudio').checked = notifPrefs.audioAlerts ?? false;
    document.getElementById('appSettingsNotifStuckMins').value = Math.round((notifPrefs.stuckThresholdMs || 600000) / 60000);
    document.getElementById('appSettingsNotifCritical').checked = !notifPrefs.muteCritical;
    document.getElementById('appSettingsNotifWarning').checked = !notifPrefs.muteWarning;
    document.getElementById('appSettingsNotifInfo').checked = !notifPrefs.muteInfo;
    // Per-event-type preferences
    const eventTypes = notifPrefs.eventTypes || {};
    // Permission prompts
    const permPref = eventTypes.permission_prompt || {};
    document.getElementById('eventPermissionEnabled').checked = permPref.enabled ?? true;
    document.getElementById('eventPermissionBrowser').checked = permPref.browser ?? true;
    document.getElementById('eventPermissionAudio').checked = permPref.audio ?? true;
    // Questions (elicitation_dialog)
    const questionPref = eventTypes.elicitation_dialog || {};
    document.getElementById('eventQuestionEnabled').checked = questionPref.enabled ?? true;
    document.getElementById('eventQuestionBrowser').checked = questionPref.browser ?? true;
    document.getElementById('eventQuestionAudio').checked = questionPref.audio ?? true;
    // Session idle (idle_prompt)
    const idlePref = eventTypes.idle_prompt || {};
    document.getElementById('eventIdleEnabled').checked = idlePref.enabled ?? true;
    document.getElementById('eventIdleBrowser').checked = idlePref.browser ?? true;
    document.getElementById('eventIdleAudio').checked = idlePref.audio ?? false;
    // Response complete (stop)
    const stopPref = eventTypes.stop || {};
    document.getElementById('eventStopEnabled').checked = stopPref.enabled ?? true;
    document.getElementById('eventStopBrowser').checked = stopPref.browser ?? false;
    document.getElementById('eventStopAudio').checked = stopPref.audio ?? false;
    // Respawn cycles
    const respawnPref = eventTypes.respawn_cycle || {};
    document.getElementById('eventRespawnEnabled').checked = respawnPref.enabled ?? true;
    document.getElementById('eventRespawnBrowser').checked = respawnPref.browser ?? false;
    document.getElementById('eventRespawnAudio').checked = respawnPref.audio ?? false;
    // Task complete (ralph_complete)
    const ralphPref = eventTypes.ralph_complete || {};
    document.getElementById('eventRalphEnabled').checked = ralphPref.enabled ?? true;
    document.getElementById('eventRalphBrowser').checked = ralphPref.browser ?? true;
    document.getElementById('eventRalphAudio').checked = ralphPref.audio ?? true;
    // Subagent activity (subagent_spawn and subagent_complete)
    const subagentPref = eventTypes.subagent_spawn || {};
    document.getElementById('eventSubagentEnabled').checked = subagentPref.enabled ?? false;
    document.getElementById('eventSubagentBrowser').checked = subagentPref.browser ?? false;
    document.getElementById('eventSubagentAudio').checked = subagentPref.audio ?? false;
    // Update permission status display (compact format for new grid layout)
    const permStatus = document.getElementById('notifPermissionStatus');
    if (permStatus && typeof Notification !== 'undefined') {
      const perm = Notification.permission;
      permStatus.textContent = perm === 'granted' ? '\u2713' : perm === 'denied' ? '\u2717' : '?';
      permStatus.classList.remove('granted', 'denied');
      if (perm === 'granted') permStatus.classList.add('granted');
      else if (perm === 'denied') permStatus.classList.add('denied');
    }
    // Reset to first tab and wire up tab switching
    this.switchSettingsTab('settings-display');
    const modal = document.getElementById('appSettingsModal');
    modal.querySelectorAll('.modal-tabs .modal-tab-btn').forEach(btn => {
      btn.onclick = () => this.switchSettingsTab(btn.dataset.tab);
    });
    modal.classList.add('active');

    // Activate focus trap
    this.activeFocusTrap = new FocusTrap(modal);
    this.activeFocusTrap.activate();
  }

  switchSettingsTab(tabName) {
    const modal = document.getElementById('appSettingsModal');
    // Toggle active class on tab buttons
    modal.querySelectorAll('.modal-tabs .modal-tab-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.tab === tabName);
    });
    // Toggle hidden class on tab content
    modal.querySelectorAll('.modal-tab-content').forEach(content => {
      content.classList.toggle('hidden', content.id !== tabName);
    });
  }

  closeAppSettings() {
    document.getElementById('appSettingsModal').classList.remove('active');

    // Deactivate focus trap and restore focus
    if (this.activeFocusTrap) {
      this.activeFocusTrap.deactivate();
      this.activeFocusTrap = null;
    }
  }

  async saveAppSettings() {
    const settings = {
      defaultClaudeMdPath: document.getElementById('appSettingsClaudeMdPath').value.trim(),
      defaultWorkingDir: document.getElementById('appSettingsDefaultDir').value.trim(),
      ralphTrackerEnabled: document.getElementById('appSettingsRalphEnabled').checked,
      // Header visibility settings
      showFontControls: document.getElementById('appSettingsShowFontControls').checked,
      showSystemStats: document.getElementById('appSettingsShowSystemStats').checked,
      showTokenCount: document.getElementById('appSettingsShowTokenCount').checked,
      showCost: document.getElementById('appSettingsShowCost').checked,
      showMonitor: document.getElementById('appSettingsShowMonitor').checked,
      showProjectInsights: document.getElementById('appSettingsShowProjectInsights').checked,
      showFileBrowser: document.getElementById('appSettingsShowFileBrowser').checked,
      showSubagents: document.getElementById('appSettingsShowSubagents').checked,
      subagentTrackingEnabled: document.getElementById('appSettingsSubagentTracking').checked,
      subagentActiveTabOnly: document.getElementById('appSettingsSubagentActiveTabOnly').checked,
      imageWatcherEnabled: document.getElementById('appSettingsImageWatcherEnabled').checked,
      // Claude CLI settings
      claudeMode: document.getElementById('appSettingsClaudeMode').value,
      allowedTools: document.getElementById('appSettingsAllowedTools').value.trim(),
      // Claude Permissions settings
      agentTeamsEnabled: document.getElementById('appSettingsAgentTeams').checked,
      // CPU Priority settings
      nice: {
        enabled: document.getElementById('appSettingsNiceEnabled').checked,
        niceValue: parseInt(document.getElementById('appSettingsNiceValue').value) || 10,
      },
    };

    // Save to localStorage
    this.saveAppSettingsToStorage(settings);

    // Save notification preferences separately
    const notifPrefsToSave = {
      enabled: document.getElementById('appSettingsNotifEnabled').checked,
      browserNotifications: document.getElementById('appSettingsNotifBrowser').checked,
      audioAlerts: document.getElementById('appSettingsNotifAudio').checked,
      stuckThresholdMs: (parseInt(document.getElementById('appSettingsNotifStuckMins').value) || 10) * 60000,
      muteCritical: !document.getElementById('appSettingsNotifCritical').checked,
      muteWarning: !document.getElementById('appSettingsNotifWarning').checked,
      muteInfo: !document.getElementById('appSettingsNotifInfo').checked,
      // Per-event-type preferences
      eventTypes: {
        permission_prompt: {
          enabled: document.getElementById('eventPermissionEnabled').checked,
          browser: document.getElementById('eventPermissionBrowser').checked,
          audio: document.getElementById('eventPermissionAudio').checked,
        },
        elicitation_dialog: {
          enabled: document.getElementById('eventQuestionEnabled').checked,
          browser: document.getElementById('eventQuestionBrowser').checked,
          audio: document.getElementById('eventQuestionAudio').checked,
        },
        idle_prompt: {
          enabled: document.getElementById('eventIdleEnabled').checked,
          browser: document.getElementById('eventIdleBrowser').checked,
          audio: document.getElementById('eventIdleAudio').checked,
        },
        stop: {
          enabled: document.getElementById('eventStopEnabled').checked,
          browser: document.getElementById('eventStopBrowser').checked,
          audio: document.getElementById('eventStopAudio').checked,
        },
        session_error: {
          enabled: true,
          browser: document.getElementById('eventPermissionBrowser').checked, // Use permission's browser setting
          audio: false,
        },
        respawn_cycle: {
          enabled: document.getElementById('eventRespawnEnabled').checked,
          browser: document.getElementById('eventRespawnBrowser').checked,
          audio: document.getElementById('eventRespawnAudio').checked,
        },
        token_milestone: {
          enabled: true,
          browser: false,
          audio: false,
        },
        ralph_complete: {
          enabled: document.getElementById('eventRalphEnabled').checked,
          browser: document.getElementById('eventRalphBrowser').checked,
          audio: document.getElementById('eventRalphAudio').checked,
        },
        subagent_spawn: {
          enabled: document.getElementById('eventSubagentEnabled').checked,
          browser: document.getElementById('eventSubagentBrowser').checked,
          audio: document.getElementById('eventSubagentAudio').checked,
        },
        subagent_complete: {
          enabled: document.getElementById('eventSubagentEnabled').checked,
          browser: document.getElementById('eventSubagentBrowser').checked,
          audio: document.getElementById('eventSubagentAudio').checked,
        },
      },
      _version: 3,
    };
    if (this.notificationManager) {
      this.notificationManager.preferences = notifPrefsToSave;
      this.notificationManager.savePreferences();
    }

    // Apply header visibility immediately
    this.applyHeaderVisibilitySettings();
    this.applyMonitorVisibility();
    this.renderProjectInsightsPanel();  // Re-render to apply visibility setting
    this.updateSubagentWindowVisibility();  // Apply subagent window visibility setting

    // Save to server (includes notification prefs for cross-browser persistence)
    try {
      await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...settings, notificationPreferences: notifPrefsToSave })
      });

      // Save model configuration separately
      await this.saveModelConfigFromSettings();

      this.showToast('Settings saved', 'success');
    } catch (err) {
      // Server save failed but localStorage succeeded
      this.showToast('Settings saved locally', 'warning');
    }

    this.closeAppSettings();
  }

  // Load model configuration from server for the settings modal
  async loadModelConfigForSettings() {
    try {
      const res = await fetch('/api/execution/model-config');
      const data = await res.json();
      if (data.success && data.data) {
        const config = data.data;
        // Default model
        const defaultModelEl = document.getElementById('appSettingsDefaultModel');
        if (defaultModelEl) {
          defaultModelEl.value = config.defaultModel || 'opus';
        }
        // Show recommendations
        const showRecsEl = document.getElementById('appSettingsShowModelRecommendations');
        if (showRecsEl) {
          showRecsEl.checked = config.showRecommendations ?? true;
        }
        // Agent type overrides
        const overrides = config.agentTypeOverrides || {};
        const exploreEl = document.getElementById('appSettingsModelExplore');
        const implementEl = document.getElementById('appSettingsModelImplement');
        const testEl = document.getElementById('appSettingsModelTest');
        const reviewEl = document.getElementById('appSettingsModelReview');
        if (exploreEl) exploreEl.value = overrides.explore || '';
        if (implementEl) implementEl.value = overrides.implement || '';
        if (testEl) testEl.value = overrides.test || '';
        if (reviewEl) reviewEl.value = overrides.review || '';
      }
    } catch (err) {
      console.warn('Failed to load model config:', err);
    }
  }

  // Save model configuration from settings modal to server
  async saveModelConfigFromSettings() {
    const defaultModelEl = document.getElementById('appSettingsDefaultModel');
    const showRecsEl = document.getElementById('appSettingsShowModelRecommendations');
    const exploreEl = document.getElementById('appSettingsModelExplore');
    const implementEl = document.getElementById('appSettingsModelImplement');
    const testEl = document.getElementById('appSettingsModelTest');
    const reviewEl = document.getElementById('appSettingsModelReview');

    const agentTypeOverrides = {};
    if (exploreEl?.value) agentTypeOverrides.explore = exploreEl.value;
    if (implementEl?.value) agentTypeOverrides.implement = implementEl.value;
    if (testEl?.value) agentTypeOverrides.test = testEl.value;
    if (reviewEl?.value) agentTypeOverrides.review = reviewEl.value;

    const config = {
      defaultModel: defaultModelEl?.value || 'opus',
      showRecommendations: showRecsEl?.checked ?? true,
      agentTypeOverrides,
    };

    try {
      await fetch('/api/execution/model-config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config)
      });
    } catch (err) {
      console.warn('Failed to save model config:', err);
    }
  }

  // Get the global Ralph tracker enabled setting
  isRalphTrackerEnabledByDefault() {
    const settings = this.loadAppSettingsFromStorage();
    return settings.ralphTrackerEnabled ?? false;
  }

  // Get the settings storage key based on device type (mobile vs desktop)
  getSettingsStorageKey() {
    const isMobile = MobileDetection.getDeviceType() === 'mobile';
    return isMobile ? 'claudeman-app-settings-mobile' : 'claudeman-app-settings';
  }

  // Get default settings based on device type
  // Note: Notification prefs are handled separately by NotificationManager
  getDefaultSettings() {
    const isMobile = MobileDetection.getDeviceType() === 'mobile';
    if (isMobile) {
      // Mobile defaults: minimal UI for small screens
      return {
        // Header visibility - hide everything on mobile
        showFontControls: false,
        showSystemStats: false,
        showTokenCount: false,
        showCost: false,
        // Panel visibility - hide panels on mobile (not enough space)
        showMonitor: false,
        showProjectInsights: false,
        showFileBrowser: false,
        showSubagents: false,
        // Feature toggles - disable tracking features on mobile
        subagentTrackingEnabled: false,
        subagentActiveTabOnly: true, // Only show subagents for active tab
        imageWatcherEnabled: false,
        ralphTrackerEnabled: false,
      };
    }
    // Desktop defaults - rely on ?? operators in apply functions
    // This allows desktop to have different defaults without duplication
    return {};
  }

  loadAppSettingsFromStorage() {
    // Return cached settings if available (avoids synchronous localStorage + JSON.parse
    // on every SSE event — critical for input responsiveness)
    if (this._cachedAppSettings) return this._cachedAppSettings;
    try {
      const key = this.getSettingsStorageKey();
      const saved = localStorage.getItem(key);
      if (saved) {
        this._cachedAppSettings = JSON.parse(saved);
        return this._cachedAppSettings;
      }
    } catch (err) {
      console.error('Failed to load app settings:', err);
    }
    // Return device-specific defaults
    this._cachedAppSettings = this.getDefaultSettings();
    return this._cachedAppSettings;
  }

  saveAppSettingsToStorage(settings) {
    // Invalidate cache on save
    this._cachedAppSettings = settings;
    try {
      const key = this.getSettingsStorageKey();
      localStorage.setItem(key, JSON.stringify(settings));
    } catch (err) {
      console.error('Failed to save app settings:', err);
    }
  }

  applyHeaderVisibilitySettings() {
    const settings = this.loadAppSettingsFromStorage();
    const defaults = this.getDefaultSettings();
    const showFontControls = settings.showFontControls ?? defaults.showFontControls ?? false;
    const showSystemStats = settings.showSystemStats ?? defaults.showSystemStats ?? true;
    const showTokenCount = settings.showTokenCount ?? defaults.showTokenCount ?? true;

    const fontControlsEl = document.querySelector('.header-font-controls');
    const systemStatsEl = document.getElementById('headerSystemStats');
    const tokenCountEl = document.getElementById('headerTokens');

    if (fontControlsEl) {
      fontControlsEl.style.display = showFontControls ? '' : 'none';
    }
    if (systemStatsEl) {
      systemStatsEl.style.display = showSystemStats ? '' : 'none';
    }
    if (tokenCountEl) {
      tokenCountEl.style.display = showTokenCount ? '' : 'none';
    }

    // Hide notification bell when notifications are disabled
    const notifEnabled = this.notificationManager?.preferences?.enabled ?? true;
    const notifBtn = document.querySelector('.btn-notifications');
    if (notifBtn) {
      notifBtn.style.display = notifEnabled ? '' : 'none';
    }
    // Close the drawer if notifications got disabled while it's open
    if (!notifEnabled) {
      const drawer = document.getElementById('notifDrawer');
      if (drawer) drawer.classList.remove('open');
    }
  }

  applyMonitorVisibility() {
    const settings = this.loadAppSettingsFromStorage();
    const defaults = this.getDefaultSettings();
    const showMonitor = settings.showMonitor ?? defaults.showMonitor ?? true;
    const showSubagents = settings.showSubagents ?? defaults.showSubagents ?? false;
    const showFileBrowser = settings.showFileBrowser ?? defaults.showFileBrowser ?? false;

    const monitorPanel = document.getElementById('monitorPanel');
    if (monitorPanel) {
      monitorPanel.style.display = showMonitor ? '' : 'none';
    }

    const subagentsPanel = document.getElementById('subagentsPanel');
    if (subagentsPanel) {
      if (showSubagents) {
        subagentsPanel.classList.remove('hidden');
      } else {
        subagentsPanel.classList.add('hidden');
      }
    }

    // File browser panel visibility
    const fileBrowserPanel = document.getElementById('fileBrowserPanel');
    if (fileBrowserPanel) {
      if (showFileBrowser && this.activeSessionId) {
        fileBrowserPanel.classList.add('visible');
        this.loadFileBrowser(this.activeSessionId);
      } else {
        fileBrowserPanel.classList.remove('visible');
      }
    }
  }

  closeMonitor() {
    // Hide the monitor panel
    const monitorPanel = document.getElementById('monitorPanel');
    if (monitorPanel) {
      monitorPanel.classList.remove('open');
      monitorPanel.style.display = 'none';
    }
    // Save the setting
    const settings = this.loadAppSettingsFromStorage();
    settings.showMonitor = false;
    this.saveAppSettingsToStorage(settings);
  }

  closeSubagentsPanel() {
    // Hide the subagents panel
    const subagentsPanel = document.getElementById('subagentsPanel');
    if (subagentsPanel) {
      subagentsPanel.classList.remove('open');
      subagentsPanel.classList.add('hidden');
    }
    this.subagentPanelVisible = false;
    // Save the setting
    const settings = this.loadAppSettingsFromStorage();
    settings.showSubagents = false;
    this.saveAppSettingsToStorage(settings);
  }

  async clearAllSubagents() {
    const count = this.subagents.size;
    if (count === 0) {
      this.showToast('No subagents to clear', 'info');
      return;
    }

    if (!confirm(`Clear all ${count} tracked subagent(s)? This removes them from the UI but does not affect running processes.`)) {
      return;
    }

    try {
      const res = await fetch('/api/subagents', { method: 'DELETE' });
      const data = await res.json();
      if (data.success) {
        // Clear local state
        this.subagents.clear();
        this.subagentActivity.clear();
        this.subagentToolResults.clear();
        // Close any open subagent windows
        this.cleanupAllFloatingWindows();
        // Update UI
        this.renderSubagentPanel();
        this.renderMonitorSubagents();
        this.updateSubagentBadge();
        this.showToast(`Cleared ${data.data.cleared} subagent(s)`, 'success');
      } else {
        this.showToast('Failed to clear subagents: ' + data.error, 'error');
      }
    } catch (err) {
      this.showToast('Failed to clear subagents', 'error');
    }
  }

  toggleSubagentsPanel() {
    const panel = document.getElementById('subagentsPanel');
    const toggleBtn = document.getElementById('subagentsToggleBtn');
    if (!panel) return;

    // If hidden, show it first
    if (panel.classList.contains('hidden')) {
      panel.classList.remove('hidden');
      // Save setting
      const settings = this.loadAppSettingsFromStorage();
      settings.showSubagents = true;
      this.saveAppSettingsToStorage(settings);
    }

    // Toggle open/collapsed state
    panel.classList.toggle('open');
    this.subagentPanelVisible = panel.classList.contains('open');

    // Update toggle button icon
    if (toggleBtn) {
      toggleBtn.innerHTML = this.subagentPanelVisible ? '&#x25BC;' : '&#x25B2;'; // Down when open, up when collapsed
    }

    if (this.subagentPanelVisible) {
      this.renderSubagentPanel();
    }
  }

  async loadAppSettingsFromServer() {
    try {
      const res = await fetch('/api/settings');
      if (res.ok) {
        const settings = await res.json();
        // Extract notification prefs before merging app settings
        const { notificationPreferences, ...appSettings } = settings;
        // Filter out display settings — these are device-specific (mobile vs desktop)
        // and should not be synced from the server to avoid overriding mobile defaults
        const displayKeys = new Set([
          'showFontControls', 'showSystemStats', 'showTokenCount', 'showCost',
          'showMonitor', 'showProjectInsights', 'showFileBrowser', 'showSubagents',
          'subagentTrackingEnabled', 'subagentActiveTabOnly',
          'imageWatcherEnabled', 'ralphTrackerEnabled',
        ]);
        const filteredAppSettings = {};
        for (const [key, value] of Object.entries(appSettings)) {
          if (!displayKeys.has(key)) {
            filteredAppSettings[key] = value;
          }
        }
        // Merge non-display settings with localStorage (server takes precedence)
        const localSettings = this.loadAppSettingsFromStorage();
        const merged = { ...localSettings, ...filteredAppSettings };
        this.saveAppSettingsToStorage(merged);

        // Apply notification prefs from server if present (only if localStorage has none)
        if (notificationPreferences && this.notificationManager) {
          const localNotifPrefs = localStorage.getItem(this.notificationManager.getStorageKey());
          if (!localNotifPrefs) {
            this.notificationManager.preferences = notificationPreferences;
            this.notificationManager.savePreferences();
          }
        }

        return merged;
      }
    } catch (err) {
      console.error('Failed to load settings from server:', err);
    }
    return this.loadAppSettingsFromStorage();
  }

  // ========== Subagent Window State Persistence ==========

  /**
   * Save subagent window states (minimized/open) to server for cross-browser persistence.
   * Called when a window is minimized, restored, or auto-minimized on completion.
   */
  async saveSubagentWindowStates() {
    // Build state object: which agents are minimized per session
    const minimizedState = {};
    for (const [sessionId, agentIds] of this.minimizedSubagents) {
      minimizedState[sessionId] = Array.from(agentIds);
    }

    // Also track which windows are open (not minimized)
    const openWindows = [];
    for (const [agentId, windowData] of this.subagentWindows) {
      if (!windowData.minimized) {
        openWindows.push({
          agentId,
          position: windowData.position || null
        });
      }
    }

    const windowStates = { minimized: minimizedState, open: openWindows };

    // Save to localStorage for quick restore
    localStorage.setItem('claudeman-subagent-window-states', JSON.stringify(windowStates));

    // Save to server for cross-browser persistence
    try {
      await fetch('/api/subagent-window-states', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(windowStates)
      });
    } catch (err) {
      console.error('Failed to save subagent window states to server:', err);
    }
  }

  /**
   * Load subagent window states from server (or localStorage fallback).
   * Called on page load to restore minimized/open window states.
   */
  async loadSubagentWindowStates() {
    let states = null;

    // Try server first for cross-browser sync
    try {
      const res = await fetch('/api/subagent-window-states');
      if (res.ok) {
        states = await res.json();
        // Also update localStorage
        localStorage.setItem('claudeman-subagent-window-states', JSON.stringify(states));
      }
    } catch (err) {
      console.error('Failed to load subagent window states from server:', err);
    }

    // Fallback to localStorage
    if (!states) {
      try {
        const saved = localStorage.getItem('claudeman-subagent-window-states');
        if (saved) {
          states = JSON.parse(saved);
        }
      } catch (err) {
        console.error('Failed to load subagent window states from localStorage:', err);
      }
    }

    return states || { minimized: {}, open: [] };
  }

  /**
   * Restore subagent window states after loading subagents.
   * Opens windows that were open before, keeps minimized ones minimized.
   * IMPORTANT: Parent associations are loaded from subagentParentMap BEFORE this is called.
   */
  async restoreSubagentWindowStates() {
    const states = await this.loadSubagentWindowStates();

    // Restore minimized state using the PERSISTENT parent map
    // Skip old agents from previous runs to avoid confusion
    const cutoffTime = Date.now() - 10 * 60 * 1000; // 10 minutes
    for (const [savedSessionId, agentIds] of Object.entries(states.minimized || {})) {
      if (Array.isArray(agentIds) && agentIds.length > 0) {
        for (const agentId of agentIds) {
          const agent = this.subagents.get(agentId);
          if (!agent) continue; // Agent no longer exists

          // Skip completed or old agents
          const agentStartTime = agent.startedAt ? new Date(agent.startedAt).getTime() : 0;
          if (agent.status === 'completed' || agentStartTime < cutoffTime) continue;

          // Use the PERSISTENT parent map (THE source of truth)
          // Fall back to saved sessionId only if it exists in current sessions
          const parentFromMap = this.subagentParentMap.get(agentId);
          const correctSessionId = parentFromMap ||
            (this.sessions.has(savedSessionId) ? savedSessionId : null);

          if (correctSessionId) {
            // Ensure the parent map has this association
            if (!parentFromMap && this.sessions.has(savedSessionId)) {
              this.setAgentParentSessionId(agentId, savedSessionId);
            }

            if (!this.minimizedSubagents.has(correctSessionId)) {
              this.minimizedSubagents.set(correctSessionId, new Set());
            }
            this.minimizedSubagents.get(correctSessionId).add(agentId);
          }
        }
      }
    }

    // Restore open windows (for recent, non-completed agents only)
    const now = Date.now();
    const maxAgeMs = 10 * 60 * 1000; // 10 minutes - don't restore windows for old agents
    for (const { agentId, position } of (states.open || [])) {
      const agent = this.subagents.get(agentId);
      // Only restore window if agent exists, is recent, and is still active/idle
      const agentAge = agent?.startedAt ? now - new Date(agent.startedAt).getTime() : Infinity;
      if (agent && agent.status !== 'completed' && agentAge < maxAgeMs) {
        this.openSubagentWindow(agentId);
        // Restore position if saved (with viewport bounds check)
        if (position) {
          const windowData = this.subagentWindows.get(agentId);
          if (windowData && windowData.element) {
            // Parse position values and clamp to viewport
            let left = parseInt(position.left, 10) || 50;
            let top = parseInt(position.top, 10) || 120;
            const viewportWidth = window.innerWidth;
            const viewportHeight = window.innerHeight;
            const windowWidth = 420;
            const windowHeight = 350;
            left = Math.max(10, Math.min(left, viewportWidth - windowWidth - 10));
            top = Math.max(10, Math.min(top, viewportHeight - windowHeight - 10));
            windowData.element.style.left = `${left}px`;
            windowData.element.style.top = `${top}px`;
            windowData.position = { left: `${left}px`, top: `${top}px` };
          }
        }
      }
    }

    this.renderSessionTabs(); // Update tab badges
    this.saveSubagentWindowStates(); // Persist corrected mappings

    // Update connection lines after all windows are restored (use rAF to ensure DOM is ready)
    requestAnimationFrame(() => {
      this.updateConnectionLines();
    });
  }

  // ========== Persistent Parent Associations ==========
  // This is the ROCK-SOLID system for tracking which tab an agent belongs to.
  // Once an agent's parent is discovered, it's saved here PERMANENTLY.

  /**
   * Save the subagent parent map to localStorage and server.
   * Called whenever a new parent association is discovered.
   */
  async saveSubagentParentMap() {
    const mapData = Object.fromEntries(this.subagentParentMap);

    // Save to localStorage for instant recovery
    try {
      localStorage.setItem('claudeman-subagent-parents', JSON.stringify(mapData));
    } catch (err) {
      console.error('Failed to save subagent parents to localStorage:', err);
    }

    // Save to server for cross-browser/session persistence
    try {
      await fetch('/api/subagent-parents', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(mapData)
      });
    } catch (err) {
      console.error('Failed to save subagent parents to server:', err);
    }
  }

  /**
   * Load the subagent parent map from server (or localStorage fallback).
   * Called once on page load, before any agents are discovered.
   */
  async loadSubagentParentMap() {
    let mapData = null;

    // Try server first (most authoritative)
    try {
      const res = await fetch('/api/subagent-parents');
      if (res.ok) {
        mapData = await res.json();
        // Update localStorage as cache
        localStorage.setItem('claudeman-subagent-parents', JSON.stringify(mapData));
      }
    } catch (err) {
      console.error('Failed to load subagent parents from server:', err);
    }

    // Fallback to localStorage
    if (!mapData) {
      try {
        const saved = localStorage.getItem('claudeman-subagent-parents');
        if (saved) {
          mapData = JSON.parse(saved);
        }
      } catch (err) {
        console.error('Failed to load subagent parents from localStorage:', err);
      }
    }

    // Populate the map
    if (mapData && typeof mapData === 'object') {
      for (const [agentId, sessionId] of Object.entries(mapData)) {
        // Only keep associations for sessions that still exist
        if (this.sessions.has(sessionId)) {
          this.subagentParentMap.set(agentId, sessionId);
        }
      }
    }
  }

  /**
   * Get the parent session ID for an agent from the persistent map.
   * This is the ONLY source of truth for connection lines.
   */
  getAgentParentSessionId(agentId) {
    return this.subagentParentMap.get(agentId) || null;
  }

  /**
   * Set and persist the parent session ID for an agent.
   * Once set, this association is PERMANENT and never recalculated.
   */
  setAgentParentSessionId(agentId, sessionId) {
    if (!agentId || !sessionId) return;

    // Only set if not already set (first association wins)
    if (this.subagentParentMap.has(agentId)) {
      return; // Already has a parent, don't override
    }

    this.subagentParentMap.set(agentId, sessionId);
    this.saveSubagentParentMap(); // Persist immediately

    // Also update the agent object for consistency
    const agent = this.subagents.get(agentId);
    if (agent) {
      agent.parentSessionId = sessionId;
      const session = this.sessions.get(sessionId);
      if (session) {
        agent.parentSessionName = this.getSessionName(session);
      }
      this.subagents.set(agentId, agent);
    }
  }

  // ========== Help Modal ==========

  showHelp() {
    const modal = document.getElementById('helpModal');
    modal.classList.add('active');

    // Activate focus trap
    this.activeFocusTrap = new FocusTrap(modal);
    this.activeFocusTrap.activate();
  }

  closeHelp() {
    document.getElementById('helpModal').classList.remove('active');

    // Deactivate focus trap and restore focus
    if (this.activeFocusTrap) {
      this.activeFocusTrap.deactivate();
      this.activeFocusTrap = null;
    }
  }

  closeAllPanels() {
    this.closeSessionOptions();
    this.closeAppSettings();
    this.cancelCloseSession();
    this.closeTokenStats();
    document.getElementById('monitorPanel').classList.remove('open');
    // Collapse subagents panel (don't hide it permanently)
    const subagentsPanel = document.getElementById('subagentsPanel');
    if (subagentsPanel) {
      subagentsPanel.classList.remove('open');
    }
    this.subagentPanelVisible = false;
  }

  // ========== Token Statistics Modal ==========

  async openTokenStats() {
    try {
      const response = await fetch('/api/token-stats');
      const data = await response.json();
      if (data.success) {
        this.renderTokenStats(data);
        document.getElementById('tokenStatsModal').classList.add('active');
      } else {
        this.showToast('Failed to load token stats', 'error');
      }
    } catch (err) {
      console.error('Failed to fetch token stats:', err);
      this.showToast('Failed to load token stats', 'error');
    }
  }

  renderTokenStats(data) {
    const { daily, totals } = data;

    // Calculate period totals
    const today = new Date().toISOString().split('T')[0];
    const todayData = daily.find(d => d.date === today) || { inputTokens: 0, outputTokens: 0, estimatedCost: 0 };

    // Last 7 days totals (for summary card)
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
    const last7Days = daily.filter(d => new Date(d.date) >= sevenDaysAgo);
    const weekInput = last7Days.reduce((sum, d) => sum + d.inputTokens, 0);
    const weekOutput = last7Days.reduce((sum, d) => sum + d.outputTokens, 0);
    const weekCost = this.estimateCost(weekInput, weekOutput);

    // Lifetime totals (from aggregate stats)
    const lifetimeInput = totals.totalInputTokens;
    const lifetimeOutput = totals.totalOutputTokens;
    const lifetimeCost = this.estimateCost(lifetimeInput, lifetimeOutput);

    // Render summary cards
    const summaryEl = document.getElementById('statsSummary');
    summaryEl.innerHTML = `
      <div class="stat-card">
        <span class="stat-card-label">Today</span>
        <span class="stat-card-value">${this.formatTokens(todayData.inputTokens + todayData.outputTokens)}</span>
        <span class="stat-card-cost">~$${todayData.estimatedCost.toFixed(2)}</span>
      </div>
      <div class="stat-card">
        <span class="stat-card-label">7 Days</span>
        <span class="stat-card-value">${this.formatTokens(weekInput + weekOutput)}</span>
        <span class="stat-card-cost">~$${weekCost.toFixed(2)}</span>
      </div>
      <div class="stat-card">
        <span class="stat-card-label">Lifetime</span>
        <span class="stat-card-value">${this.formatTokens(lifetimeInput + lifetimeOutput)}</span>
        <span class="stat-card-cost">~$${lifetimeCost.toFixed(2)}</span>
      </div>
    `;

    // Render bar chart (last 7 days)
    const chartEl = document.getElementById('statsChart');
    const daysEl = document.getElementById('statsChartDays');

    // Get last 7 days (fill gaps with empty data)
    const chartData = [];
    for (let i = 6; i >= 0; i--) {
      const date = new Date();
      date.setDate(date.getDate() - i);
      const dateStr = date.toISOString().split('T')[0];
      const dayData = daily.find(d => d.date === dateStr);
      chartData.push({
        date: dateStr,
        dayName: date.toLocaleDateString('en-US', { weekday: 'short' }),
        tokens: dayData ? dayData.inputTokens + dayData.outputTokens : 0,
        cost: dayData ? dayData.estimatedCost : 0,
      });
    }

    // Find max for scaling
    const maxTokens = Math.max(...chartData.map(d => d.tokens), 1);

    chartEl.innerHTML = chartData.map(d => {
      const height = Math.max((d.tokens / maxTokens) * 100, 3);
      const tooltip = `${d.dayName}: ${this.formatTokens(d.tokens)} (~$${d.cost.toFixed(2)})`;
      return `<div class="bar" style="height: ${height}%" data-tooltip="${tooltip}"></div>`;
    }).join('');

    daysEl.innerHTML = chartData.map(d => `<span>${d.dayName}</span>`).join('');

    // Render table (last 14 days with data)
    const tableEl = document.getElementById('statsTable');
    const tableData = daily.slice(0, 14);

    if (tableData.length === 0) {
      tableEl.innerHTML = '<div class="stats-no-data">No usage data recorded yet</div>';
    } else {
      tableEl.innerHTML = `
        <div class="stats-table-header">
          <span>Date</span>
          <span>Input</span>
          <span>Output</span>
          <span>Cost</span>
        </div>
        ${tableData.map(d => {
          const dateObj = new Date(d.date + 'T00:00:00');
          const dateStr = dateObj.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
          return `
            <div class="stats-table-row">
              <span class="cell cell-date">${dateStr}</span>
              <span class="cell">${this.formatTokens(d.inputTokens)}</span>
              <span class="cell">${this.formatTokens(d.outputTokens)}</span>
              <span class="cell cell-cost">$${d.estimatedCost.toFixed(2)}</span>
            </div>
          `;
        }).join('')}
      `;
    }
  }

  closeTokenStats() {
    const modal = document.getElementById('tokenStatsModal');
    if (modal) {
      modal.classList.remove('active');
    }
  }

  // ========== Monitor Panel (combined Mux Sessions + Background Tasks) ==========

  async toggleMonitorPanel() {
    const panel = document.getElementById('monitorPanel');
    const toggleBtn = document.getElementById('monitorToggleBtn');
    panel.classList.toggle('open');

    if (panel.classList.contains('open')) {
      // Load screens and start stats collection
      await this.loadScreens();
      await fetch('/api/screens/stats/start', { method: 'POST' });
      this.renderTaskPanel();
      if (toggleBtn) toggleBtn.innerHTML = '&#x25BC;'; // Down arrow when open
    } else {
      // Stop stats collection when panel is closed
      await fetch('/api/screens/stats/stop', { method: 'POST' });
      if (toggleBtn) toggleBtn.innerHTML = '&#x25B2;'; // Up arrow when closed
    }
  }

  // Legacy alias for task panel toggle (used by session tab badge)
  toggleTaskPanel() {
    this.toggleMonitorPanel();
  }

  // ========== Monitor Panel Detach & Drag ==========

  toggleMonitorDetach() {
    const panel = document.getElementById('monitorPanel');
    const detachBtn = document.getElementById('monitorDetachBtn');

    if (panel.classList.contains('detached')) {
      // Re-attach to bottom
      panel.classList.remove('detached');
      panel.style.top = '';
      panel.style.left = '';
      panel.style.width = '';
      panel.style.height = '';
      if (detachBtn) {
        detachBtn.innerHTML = '&#x29C9;'; // Detach icon (two overlapping squares)
        detachBtn.title = 'Detach panel';
      }
    } else {
      // Detach as floating window
      panel.classList.add('detached');
      panel.classList.add('open'); // Ensure it's visible
      if (detachBtn) {
        detachBtn.innerHTML = '&#x229E;'; // Attach icon (squared plus - dock back)
        detachBtn.title = 'Attach panel';
      }
      // Setup drag functionality
      this.setupMonitorDrag();
    }
  }

  setupMonitorDrag() {
    const panel = document.getElementById('monitorPanel');
    const header = document.getElementById('monitorPanelHeader');

    if (!panel || !header) return;

    let isDragging = false;
    let startX, startY, startLeft, startTop;

    const onStart = (e) => {
      // Only drag from header, not from buttons
      if (e.target.closest('button')) return;
      if (!panel.classList.contains('detached')) return;

      isDragging = true;
      const coords = getEventCoords(e);
      startX = coords.clientX;
      startY = coords.clientY;
      const rect = panel.getBoundingClientRect();
      startLeft = rect.left;
      startTop = rect.top;

      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onEnd);
      document.addEventListener('touchmove', onMove, { passive: false });
      document.addEventListener('touchend', onEnd);
      e.preventDefault();
    };

    const onMove = (e) => {
      if (!isDragging) return;

      const coords = getEventCoords(e);
      const dx = coords.clientX - startX;
      const dy = coords.clientY - startY;

      let newLeft = startLeft + dx;
      let newTop = startTop + dy;

      // Keep within viewport bounds
      const rect = panel.getBoundingClientRect();
      newLeft = Math.max(0, Math.min(window.innerWidth - rect.width, newLeft));
      newTop = Math.max(0, Math.min(window.innerHeight - rect.height, newTop));

      panel.style.left = newLeft + 'px';
      panel.style.top = newTop + 'px';
    };

    const onEnd = () => {
      isDragging = false;
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onEnd);
      document.removeEventListener('touchmove', onMove);
      document.removeEventListener('touchend', onEnd);
    };

    // Remove existing listeners before adding new ones
    header.removeEventListener('mousedown', header._dragHandler);
    header.removeEventListener('touchstart', header._touchDragHandler);
    header._dragHandler = onStart;
    header._touchDragHandler = onStart;
    header.addEventListener('mousedown', onStart);
    header.addEventListener('touchstart', onStart, { passive: false });
  }

  // ========== Subagents Panel Detach & Drag ==========

  toggleSubagentsDetach() {
    const panel = document.getElementById('subagentsPanel');
    const detachBtn = document.getElementById('subagentsDetachBtn');

    if (panel.classList.contains('detached')) {
      // Re-attach to bottom
      panel.classList.remove('detached');
      panel.style.top = '';
      panel.style.left = '';
      panel.style.width = '';
      panel.style.height = '';
      if (detachBtn) {
        detachBtn.innerHTML = '&#x29C9;'; // Detach icon
        detachBtn.title = 'Detach panel';
      }
    } else {
      // Detach as floating window
      panel.classList.add('detached');
      panel.classList.add('open'); // Ensure it's visible
      if (detachBtn) {
        detachBtn.innerHTML = '&#x229E;'; // Attach icon
        detachBtn.title = 'Attach panel';
      }
      // Setup drag functionality
      this.setupSubagentsDrag();
    }
  }

  setupSubagentsDrag() {
    const panel = document.getElementById('subagentsPanel');
    const header = document.getElementById('subagentsPanelHeader');

    if (!panel || !header) return;

    let isDragging = false;
    let startX, startY, startLeft, startTop;

    const onStart = (e) => {
      // Only drag from header, not from buttons
      if (e.target.closest('button')) return;
      if (!panel.classList.contains('detached')) return;

      isDragging = true;
      const coords = getEventCoords(e);
      startX = coords.clientX;
      startY = coords.clientY;
      const rect = panel.getBoundingClientRect();
      startLeft = rect.left;
      startTop = rect.top;

      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onEnd);
      document.addEventListener('touchmove', onMove, { passive: false });
      document.addEventListener('touchend', onEnd);
      e.preventDefault();
    };

    const onMove = (e) => {
      if (!isDragging) return;

      const coords = getEventCoords(e);
      const dx = coords.clientX - startX;
      const dy = coords.clientY - startY;

      let newLeft = startLeft + dx;
      let newTop = startTop + dy;

      // Keep within viewport bounds
      const rect = panel.getBoundingClientRect();
      newLeft = Math.max(0, Math.min(window.innerWidth - rect.width, newLeft));
      newTop = Math.max(0, Math.min(window.innerHeight - rect.height, newTop));

      panel.style.left = newLeft + 'px';
      panel.style.top = newTop + 'px';
    };

    const onEnd = () => {
      isDragging = false;
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onEnd);
      document.removeEventListener('touchmove', onMove);
      document.removeEventListener('touchend', onEnd);
    };

    // Remove existing listeners before adding new ones
    header.removeEventListener('mousedown', header._dragHandler);
    header.removeEventListener('touchstart', header._touchDragHandler);
    header._dragHandler = onStart;
    header._touchDragHandler = onStart;
    header.addEventListener('mousedown', onStart);
    header.addEventListener('touchstart', onStart, { passive: false });
  }

  renderTaskPanel() {
    // Debounce renders at 100ms to prevent excessive DOM updates
    if (this.renderTaskPanelTimeout) {
      clearTimeout(this.renderTaskPanelTimeout);
    }
    this.renderTaskPanelTimeout = setTimeout(() => {
      this._renderTaskPanelImmediate();
    }, 100);
  }

  _renderTaskPanelImmediate() {
    const session = this.sessions.get(this.activeSessionId);
    const body = document.getElementById('backgroundTasksBody');
    const stats = document.getElementById('taskPanelStats');
    const section = document.getElementById('backgroundTasksSection');

    if (!session || !session.taskTree || session.taskTree.length === 0) {
      // Hide the entire section when there are no background tasks
      if (section) section.style.display = 'none';
      body.innerHTML = '';
      stats.textContent = '0 tasks';
      return;
    }

    // Show the section when there are tasks
    if (section) section.style.display = '';

    const taskStats = session.taskStats || { running: 0, completed: 0, failed: 0, total: 0 };
    stats.textContent = `${taskStats.running} running, ${taskStats.completed} done`;

    // Render task tree recursively
    const renderTask = (task, allTasks) => {
      const statusIcon = task.status === 'running' ? '' :
                        task.status === 'completed' ? '&#x2713;' : '&#x2717;';
      const duration = task.endTime
        ? `${((task.endTime - task.startTime) / 1000).toFixed(1)}s`
        : `${((Date.now() - task.startTime) / 1000).toFixed(0)}s...`;

      let childrenHtml = '';
      if (task.children && task.children.length > 0) {
        childrenHtml = '<div class="task-children">';
        for (const childId of task.children) {
          // Find child task in allTasks map
          const childTask = allTasks.find(t => t.id === childId);
          if (childTask) {
            childrenHtml += `<div class="task-node">${renderTask(childTask, allTasks)}</div>`;
          }
        }
        childrenHtml += '</div>';
      }

      return `
        <div class="task-item">
          <span class="task-status-icon ${task.status}">${statusIcon}</span>
          <div class="task-info">
            <div class="task-description">${this.escapeHtml(task.description)}</div>
            <div class="task-meta">
              <span class="task-type">${task.subagentType}</span>
              <span>${duration}</span>
            </div>
          </div>
        </div>
        ${childrenHtml}
      `;
    };

    // Flatten all tasks for lookup
    const allTasks = this.flattenTaskTree(session.taskTree);

    // Render only root tasks (those without parents or with null parentId)
    let html = '<div class="task-tree">';
    for (const task of session.taskTree) {
      html += `<div class="task-node">${renderTask(task, allTasks)}</div>`;
    }
    html += '</div>';

    body.innerHTML = html;
  }

  flattenTaskTree(tasks, result = []) {
    for (const task of tasks) {
      result.push(task);
      // Children are stored as IDs, not nested objects in taskTree
      // The task tree from server already has the structure we need
    }
    return result;
  }

  // ========== Enhanced Ralph Wiggum Loop Panel ==========

  updateRalphState(sessionId, updates) {
    const existing = this.ralphStates.get(sessionId) || { loop: null, todos: [] };
    const updated = { ...existing, ...updates };
    this.ralphStates.set(sessionId, updated);

    // Re-render if this is the active session
    if (sessionId === this.activeSessionId) {
      this.renderRalphStatePanel();
    }
  }

  toggleRalphStatePanel() {
    // Preserve xterm scroll position to prevent jump when panel height changes
    const xtermViewport = this.terminal?.element?.querySelector('.xterm-viewport');
    const scrollTop = xtermViewport?.scrollTop;

    this.ralphStatePanelCollapsed = !this.ralphStatePanelCollapsed;
    this.renderRalphStatePanel();

    // Restore scroll position and refit terminal after layout change
    requestAnimationFrame(() => {
      // Restore xterm scroll position
      if (xtermViewport && scrollTop !== undefined) {
        xtermViewport.scrollTop = scrollTop;
      }
      // Refit terminal to new container size
      if (this.terminal && this.fitAddon) {
        this.fitAddon.fit();
      }
    });
  }

  async closeRalphTracker() {
    if (!this.activeSessionId) return;

    // Mark this session as explicitly closed - will stay hidden until user re-enables
    this.ralphClosedSessions.add(this.activeSessionId);

    // Disable tracker via API
    await fetch(`/api/sessions/${this.activeSessionId}/ralph-config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: false })
    });

    // Clear local state and hide panel
    this.ralphStates.delete(this.activeSessionId);
    this.renderRalphStatePanel();
  }

  // ========== @fix_plan.md Integration ==========

  toggleRalphMenu() {
    const dropdown = document.getElementById('ralphDropdown');
    if (dropdown) {
      dropdown.classList.toggle('show');
    }
  }

  closeRalphMenu() {
    const dropdown = document.getElementById('ralphDropdown');
    if (dropdown) {
      dropdown.classList.remove('show');
    }
  }

  async resetCircuitBreaker() {
    if (!this.activeSessionId) return;

    try {
      const response = await fetch(`/api/sessions/${this.activeSessionId}/ralph-circuit-breaker/reset`, {
        method: 'POST',
      });
      const data = await response.json();

      if (data.success) {
        this.notificationManager?.notify({
          urgency: 'info',
          category: 'circuit-breaker',
          title: 'Reset',
          message: 'Circuit breaker reset to CLOSED',
        });
      }
    } catch (error) {
      console.error('Error resetting circuit breaker:', error);
    }
  }

  /**
   * Generate @fix_plan.md content and show in a modal.
   */
  async showFixPlan() {
    if (!this.activeSessionId) return;

    try {
      const response = await fetch(`/api/sessions/${this.activeSessionId}/fix-plan`);
      const data = await response.json();

      if (!data.success) {
        this.notificationManager?.notify({
          urgency: 'error',
          category: 'fix-plan',
          title: 'Error',
          message: data.error || 'Failed to generate fix plan',
        });
        return;
      }

      // Show in a modal
      this.showFixPlanModal(data.data.content, data.data.todoCount);
    } catch (error) {
      console.error('Error fetching fix plan:', error);
    }
  }

  /**
   * Show fix plan content in a modal.
   */
  showFixPlanModal(content, todoCount) {
    // Create modal if it doesn't exist
    let modal = document.getElementById('fixPlanModal');
    if (!modal) {
      modal = document.createElement('div');
      modal.id = 'fixPlanModal';
      modal.className = 'modal';
      modal.innerHTML = `
        <div class="modal-content fix-plan-modal">
          <div class="modal-header">
            <h3>@fix_plan.md</h3>
            <button class="btn-close" onclick="app.closeFixPlanModal()">&times;</button>
          </div>
          <div class="modal-body">
            <textarea id="fixPlanContent" class="fix-plan-textarea" readonly></textarea>
          </div>
          <div class="modal-footer">
            <span class="fix-plan-stats" id="fixPlanStats"></span>
            <button class="btn btn-secondary" onclick="app.copyFixPlan()">Copy</button>
            <button class="btn btn-primary" onclick="app.writeFixPlanToFile()">Write to File</button>
            <button class="btn btn-secondary" onclick="app.closeFixPlanModal()">Close</button>
          </div>
        </div>
      `;
      document.body.appendChild(modal);
    }

    document.getElementById('fixPlanContent').value = content;
    document.getElementById('fixPlanStats').textContent = `${todoCount} tasks`;
    modal.classList.add('show');
  }

  closeFixPlanModal() {
    const modal = document.getElementById('fixPlanModal');
    if (modal) {
      modal.classList.remove('show');
    }
  }

  async copyFixPlan() {
    const content = document.getElementById('fixPlanContent')?.value;
    if (content) {
      await navigator.clipboard.writeText(content);
      this.notificationManager?.notify({
        urgency: 'info',
        category: 'fix-plan',
        title: 'Copied',
        message: 'Fix plan copied to clipboard',
      });
    }
  }

  async writeFixPlanToFile() {
    if (!this.activeSessionId) return;

    try {
      const response = await fetch(`/api/sessions/${this.activeSessionId}/fix-plan/write`, {
        method: 'POST',
      });
      const data = await response.json();

      if (data.success) {
        this.notificationManager?.notify({
          urgency: 'info',
          category: 'fix-plan',
          title: 'Written',
          message: `@fix_plan.md written to ${data.data.filePath}`,
        });
        this.closeFixPlanModal();
      } else {
        this.notificationManager?.notify({
          urgency: 'error',
          category: 'fix-plan',
          title: 'Error',
          message: data.error || 'Failed to write file',
        });
      }
    } catch (error) {
      console.error('Error writing fix plan:', error);
    }
  }

  async importFixPlanFromFile() {
    if (!this.activeSessionId) return;

    try {
      const response = await fetch(`/api/sessions/${this.activeSessionId}/fix-plan/read`, {
        method: 'POST',
      });
      const data = await response.json();

      if (data.success) {
        this.notificationManager?.notify({
          urgency: 'info',
          category: 'fix-plan',
          title: 'Imported',
          message: `Imported ${data.data.importedCount} tasks from @fix_plan.md`,
        });
        // Refresh ralph panel
        this.updateRalphState(this.activeSessionId, { todos: data.data.todos });
      } else {
        this.notificationManager?.notify({
          urgency: 'warning',
          category: 'fix-plan',
          title: 'Not Found',
          message: data.error || '@fix_plan.md not found',
        });
      }
    } catch (error) {
      console.error('Error importing fix plan:', error);
    }
  }

  toggleRalphDetach() {
    const panel = this.$('ralphStatePanel');
    const detachBtn = this.$('ralphDetachBtn');

    if (!panel) return;

    if (panel.classList.contains('detached')) {
      // Re-attach to original position
      panel.classList.remove('detached');
      panel.style.top = '';
      panel.style.left = '';
      panel.style.width = '';
      panel.style.height = '';
      if (detachBtn) {
        detachBtn.innerHTML = '&#x29C9;'; // Detach icon (two overlapping squares)
        detachBtn.title = 'Detach panel';
      }
    } else {
      // Detach as floating window
      panel.classList.add('detached');
      // Expand when detaching for better visibility
      this.ralphStatePanelCollapsed = false;
      panel.classList.remove('collapsed');
      if (detachBtn) {
        detachBtn.innerHTML = '&#x229E;'; // Attach icon (squared plus - dock back)
        detachBtn.title = 'Attach panel';
      }
      // Setup drag functionality
      this.setupRalphDrag();
    }
    this.renderRalphStatePanel();
  }

  setupRalphDrag() {
    const panel = this.$('ralphStatePanel');
    const header = this.$('ralphSummary');

    if (!panel || !header) return;

    let isDragging = false;
    let startX, startY, startLeft, startTop;

    const onMouseDown = (e) => {
      // Only drag from header, not from buttons or toggle
      if (e.target.closest('button') || e.target.closest('.ralph-toggle')) return;
      if (!panel.classList.contains('detached')) return;

      isDragging = true;
      startX = e.clientX;
      startY = e.clientY;
      const rect = panel.getBoundingClientRect();
      startLeft = rect.left;
      startTop = rect.top;

      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
      e.preventDefault();
    };

    const onMouseMove = (e) => {
      if (!isDragging) return;

      const dx = e.clientX - startX;
      const dy = e.clientY - startY;

      let newLeft = startLeft + dx;
      let newTop = startTop + dy;

      // Keep within viewport bounds
      const rect = panel.getBoundingClientRect();
      newLeft = Math.max(0, Math.min(window.innerWidth - rect.width, newLeft));
      newTop = Math.max(0, Math.min(window.innerHeight - rect.height, newTop));

      panel.style.left = newLeft + 'px';
      panel.style.top = newTop + 'px';
    };

    const onMouseUp = () => {
      isDragging = false;
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };

    // Remove existing listeners before adding new ones
    header.removeEventListener('mousedown', header._ralphDragHandler);
    header._ralphDragHandler = onMouseDown;
    header.addEventListener('mousedown', onMouseDown);
  }

  renderRalphStatePanel() {
    // Debounce renders at 50ms to prevent excessive DOM updates
    if (this.renderRalphStatePanelTimeout) {
      clearTimeout(this.renderRalphStatePanelTimeout);
    }
    this.renderRalphStatePanelTimeout = setTimeout(() => {
      this._renderRalphStatePanelImmediate();
    }, 50);
  }

  _renderRalphStatePanelImmediate() {
    const panel = this.$('ralphStatePanel');
    const toggle = this.$('ralphToggle');

    if (!panel) return;

    // If user explicitly closed this session's Ralph panel, keep it hidden
    if (this.ralphClosedSessions.has(this.activeSessionId)) {
      panel.style.display = 'none';
      return;
    }

    const state = this.ralphStates.get(this.activeSessionId);

    // Check if there's anything to show
    // Only show panel if tracker is enabled OR there's active state to display
    const isEnabled = state?.loop?.enabled === true;
    const hasLoop = state?.loop?.active || state?.loop?.completionPhrase;
    const hasTodos = state?.todos?.length > 0;
    const hasCircuitBreaker = state?.circuitBreaker && state.circuitBreaker.state !== 'CLOSED';
    const hasStatusBlock = state?.statusBlock !== undefined;

    if (!isEnabled && !hasLoop && !hasTodos && !hasCircuitBreaker && !hasStatusBlock) {
      panel.style.display = 'none';
      return;
    }

    panel.style.display = '';

    // Calculate completion percentage
    const todos = state?.todos || [];
    const completed = todos.filter(t => t.status === 'completed').length;
    const total = todos.length;
    const percent = total > 0 ? Math.round((completed / total) * 100) : 0;

    // Update progress rings
    this.updateRalphRing(percent);

    // Update status badge (pass completion info)
    this.updateRalphStatus(state?.loop, completed, total);

    // Update stats
    this.updateRalphStats(state?.loop, completed, total);

    // Update circuit breaker badge
    this.updateCircuitBreakerBadge(state?.circuitBreaker);

    // Handle collapsed/expanded state
    if (this.ralphStatePanelCollapsed) {
      panel.classList.add('collapsed');
      if (toggle) toggle.innerHTML = '&#x25BC;'; // Down arrow when collapsed (click to expand)
    } else {
      panel.classList.remove('collapsed');
      if (toggle) toggle.innerHTML = '&#x25B2;'; // Up arrow when expanded (click to collapse)

      // Update expanded view content
      this.updateRalphExpandedView(state);
    }
  }

  updateRalphRing(percent) {
    // Ensure percent is a valid number between 0-100
    const safePercent = Math.max(0, Math.min(100, Number(percent) || 0));

    // Mini ring (in summary)
    const miniProgress = this.$('ralphRingMiniProgress');
    const miniText = this.$('ralphRingMiniText');
    if (miniProgress) {
      // Circumference = 2 * PI * r = 2 * PI * 15.9 ≈ 100
      // offset = 100 means 0% visible, offset = 0 means 100% visible
      const offset = 100 - safePercent;
      miniProgress.style.strokeDashoffset = offset;
    }
    if (miniText) {
      miniText.textContent = `${safePercent}%`;
    }

    // Large ring (in expanded view)
    const largeProgress = this.$('ralphRingProgress');
    const largePercent = this.$('ralphRingPercent');
    if (largeProgress) {
      // Circumference = 2 * PI * r = 2 * PI * 42 ≈ 264
      // offset = 264 means 0% visible, offset = 0 means 100% visible
      const offset = 264 - (264 * safePercent / 100);
      largeProgress.style.strokeDashoffset = offset;
    }
    if (largePercent) {
      largePercent.textContent = `${safePercent}%`;
    }
  }

  updateRalphStatus(loop, completed = 0, total = 0) {
    const badge = this.$('ralphStatusBadge');
    const statusText = badge?.querySelector('.ralph-status-text');
    if (!badge || !statusText) return;

    badge.classList.remove('active', 'completed', 'tracking');

    if (loop?.active) {
      badge.classList.add('active');
      statusText.textContent = 'Running';
    } else if (total > 0 && completed === total) {
      // Only show "Complete" when all todos are actually done
      badge.classList.add('completed');
      statusText.textContent = 'Complete';
    } else if (loop?.enabled || total > 0) {
      badge.classList.add('tracking');
      statusText.textContent = 'Tracking';
    } else {
      statusText.textContent = 'Idle';
    }
  }

  updateCircuitBreakerBadge(circuitBreaker) {
    // Find or create the circuit breaker badge container
    let cbContainer = this.$('ralphCircuitBreakerBadge');
    if (!cbContainer) {
      // Create container if it doesn't exist (we'll add it dynamically)
      const summary = this.$('ralphSummary');
      if (!summary) return;

      // Check if it already exists
      cbContainer = summary.querySelector('.ralph-circuit-breaker');
      if (!cbContainer) {
        cbContainer = document.createElement('div');
        cbContainer.id = 'ralphCircuitBreakerBadge';
        cbContainer.className = 'ralph-circuit-breaker';
        // Insert after the status badge
        const statusBadge = this.$('ralphStatusBadge');
        if (statusBadge && statusBadge.nextSibling) {
          statusBadge.parentNode.insertBefore(cbContainer, statusBadge.nextSibling);
        } else {
          summary.appendChild(cbContainer);
        }
      }
    }

    // Hide if no circuit breaker state or CLOSED
    if (!circuitBreaker || circuitBreaker.state === 'CLOSED') {
      cbContainer.style.display = 'none';
      return;
    }

    cbContainer.style.display = '';
    cbContainer.classList.remove('half-open', 'open');

    if (circuitBreaker.state === 'HALF_OPEN') {
      cbContainer.classList.add('half-open');
      cbContainer.innerHTML = `<span class="cb-icon">⚠</span><span class="cb-text">Warning</span>`;
      cbContainer.title = circuitBreaker.reason || 'Circuit breaker warning';
    } else if (circuitBreaker.state === 'OPEN') {
      cbContainer.classList.add('open');
      cbContainer.innerHTML = `<span class="cb-icon">🛑</span><span class="cb-text">Stuck</span>`;
      cbContainer.title = circuitBreaker.reason || 'Loop appears stuck';
    }

    // Add click handler to reset
    cbContainer.onclick = () => this.resetCircuitBreaker();
  }

  async resetCircuitBreaker() {
    if (!this.activeSessionId) return;
    try {
      const response = await fetch(`/api/sessions/${this.activeSessionId}/ralph-circuit-breaker/reset`, {
        method: 'POST',
      });
      if (response.ok) {
        console.log('Circuit breaker reset');
      }
    } catch (err) {
      console.error('Failed to reset circuit breaker:', err);
    }
  }

  updateRalphStats(loop, completed, total) {
    // Time stat
    const timeEl = this.$('ralphStatTime');
    if (timeEl) {
      if (loop?.elapsedHours !== null && loop?.elapsedHours !== undefined) {
        timeEl.textContent = this.formatRalphTime(loop.elapsedHours);
      } else if (loop?.startedAt) {
        const hours = (Date.now() - loop.startedAt) / (1000 * 60 * 60);
        timeEl.textContent = this.formatRalphTime(hours);
      } else {
        timeEl.textContent = '0m';
      }
    }

    // Cycles stat
    const cyclesEl = this.$('ralphStatCycles');
    if (cyclesEl) {
      if (loop?.maxIterations) {
        cyclesEl.textContent = `${loop.cycleCount || 0}/${loop.maxIterations}`;
      } else {
        cyclesEl.textContent = String(loop?.cycleCount || 0);
      }
    }

    // Tasks stat
    const tasksEl = this.$('ralphStatTasks');
    if (tasksEl) {
      tasksEl.textContent = `${completed}/${total}`;
    }
  }

  formatRalphTime(hours) {
    if (hours < 0.0167) return '0m'; // < 1 minute
    if (hours < 1) {
      const minutes = Math.round(hours * 60);
      return `${minutes}m`;
    }
    const h = Math.floor(hours);
    const m = Math.round((hours - h) * 60);
    if (m === 0) return `${h}h`;
    return `${h}h ${m}m`;
  }

  updateRalphExpandedView(state) {
    // Update phrase
    const phraseEl = this.$('ralphPhrase');
    if (phraseEl) {
      phraseEl.textContent = state?.loop?.completionPhrase || '--';
    }

    // Update elapsed
    const elapsedEl = this.$('ralphElapsed');
    if (elapsedEl) {
      if (state?.loop?.elapsedHours !== null && state?.loop?.elapsedHours !== undefined) {
        elapsedEl.textContent = this.formatRalphTime(state.loop.elapsedHours);
      } else if (state?.loop?.startedAt) {
        const hours = (Date.now() - state.loop.startedAt) / (1000 * 60 * 60);
        elapsedEl.textContent = this.formatRalphTime(hours);
      } else {
        elapsedEl.textContent = '0m';
      }
    }

    // Update iterations
    const iterationsEl = this.$('ralphIterations');
    if (iterationsEl) {
      if (state?.loop?.maxIterations) {
        iterationsEl.textContent = `${state.loop.cycleCount || 0} / ${state.loop.maxIterations}`;
      } else {
        iterationsEl.textContent = String(state?.loop?.cycleCount || 0);
      }
    }

    // Update tasks count
    const todos = state?.todos || [];
    const completed = todos.filter(t => t.status === 'completed').length;
    const tasksCountEl = this.$('ralphTasksCount');
    if (tasksCountEl) {
      tasksCountEl.textContent = `${completed}/${todos.length}`;
    }

    // Update plan version display if available
    if (state?.loop?.planVersion) {
      this.updatePlanVersionDisplay(state.loop.planVersion, state.loop.planHistoryLength || 1);
    } else {
      this.updatePlanVersionDisplay(null, 0);
    }

    // Render task cards
    this.renderRalphTasks(todos);

    // Render RALPH_STATUS block if present
    this.renderRalphStatusBlock(state?.statusBlock);
  }

  renderRalphStatusBlock(statusBlock) {
    // Find or create the status block container
    let container = this.$('ralphStatusBlockDisplay');
    const expandedContent = this.$('ralphExpandedContent');

    if (!statusBlock) {
      // Remove container if no status block
      if (container) {
        container.remove();
      }
      return;
    }

    if (!container && expandedContent) {
      container = document.createElement('div');
      container.id = 'ralphStatusBlockDisplay';
      container.className = 'ralph-status-block';
      // Insert at the top of expanded content
      expandedContent.insertBefore(container, expandedContent.firstChild);
    }

    if (!container) return;

    // Build status class
    const statusClass = statusBlock.status === 'IN_PROGRESS' ? 'in-progress'
      : statusBlock.status === 'COMPLETE' ? 'complete'
      : statusBlock.status === 'BLOCKED' ? 'blocked' : '';

    // Build tests status icon
    const testsIcon = statusBlock.testsStatus === 'PASSING' ? '✅'
      : statusBlock.testsStatus === 'FAILING' ? '❌'
      : '⏸';

    // Build work type icon
    const workIcon = statusBlock.workType === 'IMPLEMENTATION' ? '🔧'
      : statusBlock.workType === 'TESTING' ? '🧪'
      : statusBlock.workType === 'DOCUMENTATION' ? '📝'
      : statusBlock.workType === 'REFACTORING' ? '♻️' : '📋';

    let html = `
      <div class="ralph-status-block-header">
        <span>RALPH_STATUS</span>
        <span class="ralph-status-block-status ${statusClass}">${statusBlock.status}</span>
        ${statusBlock.exitSignal ? '<span style="color: #4caf50;">🚪 EXIT</span>' : ''}
      </div>
      <div class="ralph-status-block-stats">
        <span>${workIcon} ${statusBlock.workType}</span>
        <span>📁 ${statusBlock.filesModified} files</span>
        <span>✓ ${statusBlock.tasksCompletedThisLoop} tasks</span>
        <span>${testsIcon} Tests: ${statusBlock.testsStatus}</span>
      </div>
    `;

    if (statusBlock.recommendation) {
      html += `<div class="ralph-status-block-recommendation">${statusBlock.recommendation}</div>`;
    }

    container.innerHTML = html;
  }

  renderRalphTasks(todos) {
    const grid = this.$('ralphTasksGrid');
    if (!grid) return;

    if (todos.length === 0) {
      if (grid.children.length !== 1 || !grid.querySelector('.ralph-state-empty')) {
        grid.innerHTML = '<div class="ralph-state-empty">No tasks detected</div>';
      }
      return;
    }

    // Sort: by priority (P0 > P1 > P2 > null), then by status (in_progress > pending > completed)
    const priorityOrder = { 'P0': 0, 'P1': 1, 'P2': 2, null: 3 };
    const statusOrder = { in_progress: 0, pending: 1, completed: 2 };
    const sorted = [...todos].sort((a, b) => {
      const priA = priorityOrder[a.priority] ?? 3;
      const priB = priorityOrder[b.priority] ?? 3;
      if (priA !== priB) return priA - priB;
      return (statusOrder[a.status] || 1) - (statusOrder[b.status] || 1);
    });

    // Always do full rebuild for enhanced features
    const fragment = document.createDocumentFragment();

    sorted.forEach((todo, idx) => {
      const card = this.createRalphTaskCard(todo, idx);
      fragment.appendChild(card);
    });

    grid.innerHTML = '';
    grid.appendChild(fragment);
  }

  createRalphTaskCard(todo, index) {
    const card = document.createElement('div');
    const statusClass = `task-${todo.status.replace('_', '-')}`;
    const priorityClass = todo.priority ? `task-priority-${todo.priority.toLowerCase()}` : '';
    card.className = `ralph-task-card ${statusClass} ${priorityClass}`.trim();
    card.dataset.taskId = todo.id || index;

    // Status icon
    const iconSpan = document.createElement('span');
    iconSpan.className = 'ralph-task-icon';
    iconSpan.textContent = this.getRalphTaskIcon(todo.status);
    card.appendChild(iconSpan);

    // Priority badge if present
    if (todo.priority) {
      const prioritySpan = document.createElement('span');
      prioritySpan.className = `ralph-task-priority priority-${todo.priority.toLowerCase()}`;
      prioritySpan.textContent = todo.priority;
      card.appendChild(prioritySpan);
    }

    // Task content
    const contentSpan = document.createElement('span');
    contentSpan.className = 'ralph-task-content';
    contentSpan.textContent = todo.content;
    card.appendChild(contentSpan);

    // Attempts indicator (if > 0)
    if (todo.attempts && todo.attempts > 0) {
      const attemptsSpan = document.createElement('span');
      attemptsSpan.className = 'ralph-task-attempts';
      if (todo.lastError) {
        attemptsSpan.classList.add('has-errors');
        attemptsSpan.title = `Last error: ${todo.lastError}`;
      }
      attemptsSpan.textContent = `#${todo.attempts}`;
      card.appendChild(attemptsSpan);
    }

    // Verification badge (if has verification criteria)
    if (todo.verificationCriteria) {
      const verifySpan = document.createElement('span');
      verifySpan.className = 'ralph-task-verify-badge';
      verifySpan.title = `Verify: ${todo.verificationCriteria}`;
      verifySpan.textContent = '✓';
      card.appendChild(verifySpan);
    }

    // Dependencies indicator
    if (todo.dependencies && todo.dependencies.length > 0) {
      const depsSpan = document.createElement('span');
      depsSpan.className = 'ralph-task-deps-indicator';
      depsSpan.title = `Depends on: ${todo.dependencies.join(', ')}`;
      depsSpan.textContent = `↗${todo.dependencies.length}`;
      card.appendChild(depsSpan);
    }

    // Quick action buttons (shown on hover)
    const actions = document.createElement('div');
    actions.className = 'ralph-task-actions';

    if (todo.status !== 'completed') {
      const completeBtn = document.createElement('button');
      completeBtn.className = 'ralph-task-action-btn';
      completeBtn.textContent = '✓';
      completeBtn.title = 'Mark complete';
      completeBtn.onclick = (e) => {
        e.stopPropagation();
        this.updateRalphTaskStatus(todo.id, 'completed');
      };
      actions.appendChild(completeBtn);
    }

    if (todo.status === 'completed') {
      const reopenBtn = document.createElement('button');
      reopenBtn.className = 'ralph-task-action-btn';
      reopenBtn.textContent = '↺';
      reopenBtn.title = 'Reopen';
      reopenBtn.onclick = (e) => {
        e.stopPropagation();
        this.updateRalphTaskStatus(todo.id, 'pending');
      };
      actions.appendChild(reopenBtn);
    }

    if (todo.lastError) {
      const retryBtn = document.createElement('button');
      retryBtn.className = 'ralph-task-action-btn';
      retryBtn.textContent = '↻';
      retryBtn.title = 'Retry (clear error)';
      retryBtn.onclick = (e) => {
        e.stopPropagation();
        this.retryRalphTask(todo.id);
      };
      actions.appendChild(retryBtn);
    }

    card.appendChild(actions);

    return card;
  }

  // Update a Ralph task's status via API
  async updateRalphTaskStatus(taskId, newStatus) {
    if (!this.activeSessionId) return;

    try {
      const res = await fetch(`/api/sessions/${this.activeSessionId}/plan/task/${taskId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: newStatus })
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to update task');
      }

      this.showToast(`Task ${newStatus === 'completed' ? 'completed' : 'reopened'}`, 'success');
    } catch (err) {
      this.showToast('Failed to update task: ' + err.message, 'error');
    }
  }

  // Retry a failed Ralph task (clear error, reset attempts)
  async retryRalphTask(taskId) {
    if (!this.activeSessionId) return;

    try {
      const res = await fetch(`/api/sessions/${this.activeSessionId}/plan/task/${taskId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ attempts: 0, lastError: null, status: 'pending' })
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to retry task');
      }

      this.showToast('Task reset for retry', 'success');
    } catch (err) {
      this.showToast('Failed to retry task: ' + err.message, 'error');
    }
  }

  getRalphTaskIcon(status) {
    switch (status) {
      case 'completed': return '✓';
      case 'in_progress': return '◐';
      case 'pending':
      default: return '○';
    }
  }

  // Legacy method for backwards compatibility
  getTodoIcon(status) {
    return this.getRalphTaskIcon(status);
  }

  // ========== Plan Versioning ==========

  // Update the plan version display in the Ralph panel
  updatePlanVersionDisplay(version, historyLength) {
    const versionRow = this.$('ralphVersionRow');
    const versionBadge = this.$('ralphPlanVersion');
    const rollbackBtn = this.$('ralphRollbackBtn');

    if (!versionRow) return;

    if (version && version > 0) {
      versionRow.style.display = '';
      if (versionBadge) versionBadge.textContent = `v${version}`;
      if (rollbackBtn) {
        rollbackBtn.style.display = historyLength > 1 ? '' : 'none';
      }
    } else {
      versionRow.style.display = 'none';
    }
  }

  // Show plan history dropdown
  async showPlanHistory() {
    if (!this.activeSessionId) return;

    try {
      const res = await fetch(`/api/sessions/${this.activeSessionId}/plan/history`);
      const data = await res.json();

      if (data.error) {
        this.showToast('Failed to load plan history: ' + data.error, 'error');
        return;
      }

      const history = data.history || [];
      if (history.length === 0) {
        this.showToast('No plan history available', 'info');
        return;
      }

      // Show history dropdown modal
      this.showPlanHistoryModal(history, data.currentVersion);
    } catch (err) {
      this.showToast('Failed to load plan history: ' + err.message, 'error');
    }
  }

  // Show the plan history modal
  showPlanHistoryModal(history, currentVersion) {
    // Remove existing modal if present
    const existing = document.getElementById('planHistoryModal');
    if (existing) existing.remove();

    const modal = document.createElement('div');
    modal.id = 'planHistoryModal';
    modal.className = 'modal active';
    modal.innerHTML = `
      <div class="modal-backdrop" onclick="app.closePlanHistoryModal()"></div>
      <div class="modal-content modal-sm">
        <div class="modal-header">
          <h3>Plan Version History</h3>
          <button class="modal-close" onclick="app.closePlanHistoryModal()">&times;</button>
        </div>
        <div class="modal-body">
          <p style="font-size: 0.8rem; color: var(--text-muted); margin-bottom: 0.75rem;">
            Current version: <strong>v${currentVersion}</strong>
          </p>
          <div class="plan-history-list">
            ${history.map(item => `
              <div class="plan-history-item ${item.version === currentVersion ? 'current' : ''}"
                   onclick="app.rollbackToPlanVersion(${item.version})">
                <div>
                  <span class="plan-history-version">v${item.version}</span>
                  <span class="plan-history-tasks">${item.taskCount || 0} tasks</span>
                </div>
                <span class="plan-history-time">${this.formatRelativeTime(item.timestamp)}</span>
              </div>
            `).join('')}
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn-toolbar" onclick="app.closePlanHistoryModal()">Close</button>
        </div>
      </div>
    `;

    document.body.appendChild(modal);
  }

  closePlanHistoryModal() {
    const modal = document.getElementById('planHistoryModal');
    if (modal) modal.remove();
  }

  // Rollback to a specific plan version
  async rollbackToPlanVersion(version) {
    if (!this.activeSessionId) return;

    if (!confirm(`Rollback to plan version ${version}? Current changes will be preserved in history.`)) {
      return;
    }

    try {
      const res = await fetch(`/api/sessions/${this.activeSessionId}/plan/rollback/${version}`, {
        method: 'POST'
      });
      const data = await res.json();

      if (data.error) {
        this.showToast('Failed to rollback: ' + data.error, 'error');
        return;
      }

      this.showToast(`Rolled back to plan v${version}`, 'success');
      this.closePlanHistoryModal();

      // Refresh the plan display
      this.renderRalphStatePanel();
    } catch (err) {
      this.showToast('Failed to rollback: ' + err.message, 'error');
    }
  }

  // Format relative time (e.g., "2 mins ago", "1 hour ago")
  formatRelativeTime(timestamp) {
    if (!timestamp) return '';

    const now = Date.now();
    const diff = now - timestamp;

    const mins = Math.floor(diff / 60000);
    const hours = Math.floor(diff / 3600000);
    const days = Math.floor(diff / 86400000);

    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    if (hours < 24) return `${hours}h ago`;
    return `${days}d ago`;
  }

  // ========== Subagent Panel (Claude Code Background Agents) ==========

  // Legacy alias
  toggleSubagentPanel() {
    this.toggleSubagentsPanel();
  }

  updateSubagentBadge() {
    const badge = this.$('subagentCountBadge');
    const activeCount = Array.from(this.subagents.values()).filter(s => s.status === 'active' || s.status === 'idle').length;

    // Update badge with active count
    if (badge) {
      badge.textContent = activeCount > 0 ? activeCount : '';
    }
  }

  renderSubagentPanel() {
    // Debounce renders at 150ms to prevent excessive DOM updates from rapid subagent events
    if (this._subagentPanelRenderTimeout) {
      clearTimeout(this._subagentPanelRenderTimeout);
    }
    this._subagentPanelRenderTimeout = setTimeout(() => {
      this._renderSubagentPanelImmediate();
    }, 150);
  }

  _renderSubagentPanelImmediate() {
    const list = this.$('subagentList');
    if (!list) return;

    // Always update badge count
    this.updateSubagentBadge();

    // Always update monitor panel (even if subagent panel is hidden)
    this.renderMonitorSubagents();

    // If panel is not visible, don't render content
    if (!this.subagentPanelVisible) {
      return;
    }

    // Render subagent list
    if (this.subagents.size === 0) {
      list.innerHTML = '<div class="subagent-empty">No background agents detected</div>';
      return;
    }

    const html = [];
    const sorted = Array.from(this.subagents.values()).sort((a, b) => {
      // Active first, then by last activity
      if (a.status === 'active' && b.status !== 'active') return -1;
      if (b.status === 'active' && a.status !== 'active') return 1;
      return new Date(b.lastActivityAt).getTime() - new Date(a.lastActivityAt).getTime();
    });

    for (const agent of sorted) {
      const isActive = this.activeSubagentId === agent.agentId;
      const statusClass = agent.status === 'active' ? 'active' : agent.status === 'idle' ? 'idle' : 'completed';
      const activity = this.subagentActivity.get(agent.agentId) || [];
      const lastActivity = activity[activity.length - 1];
      const lastTool = lastActivity?.type === 'tool' ? lastActivity.tool : null;
      const hasWindow = this.subagentWindows.has(agent.agentId);
      const canKill = agent.status === 'active' || agent.status === 'idle';
      const modelBadge = agent.modelShort
        ? `<span class="subagent-model-badge ${agent.modelShort}">${agent.modelShort}</span>`
        : '';

      const teammateInfo = this.getTeammateInfo(agent);
      const displayName = teammateInfo ? teammateInfo.name : (agent.description || agent.agentId.substring(0, 7));
      const teammateBadge = this.getTeammateBadgeHtml(agent);
      const agentIcon = teammateInfo ? `<span class="subagent-icon teammate-dot teammate-color-${teammateInfo.color}">●</span>` : '<span class="subagent-icon">🤖</span>';
      html.push(`
        <div class="subagent-item ${statusClass} ${isActive ? 'selected' : ''}${teammateInfo ? ' is-teammate' : ''}"
             onclick="app.selectSubagent('${agent.agentId}')"
             ondblclick="app.openSubagentWindow('${agent.agentId}')"
             title="Double-click to open tracking window">
          <div class="subagent-header">
            ${agentIcon}
            <span class="subagent-id" title="${this.escapeHtml(agent.description || agent.agentId)}">${this.escapeHtml(displayName.length > 40 ? displayName.substring(0, 40) + '...' : displayName)}</span>
            ${teammateBadge}
            ${modelBadge}
            <span class="subagent-status ${statusClass}">${agent.status}</span>
            ${canKill ? `<button class="subagent-kill-btn" onclick="event.stopPropagation(); app.killSubagent('${agent.agentId}')" title="Kill agent">&#x2715;</button>` : ''}
            <button class="subagent-window-btn" onclick="event.stopPropagation(); app.${hasWindow ? 'closeSubagentWindow' : 'openSubagentWindow'}('${agent.agentId}')" title="${hasWindow ? 'Close window' : 'Open in window'}">
              ${hasWindow ? '✕' : '⧉'}
            </button>
          </div>
          <div class="subagent-meta">
            <span class="subagent-tools">${agent.toolCallCount} tools</span>
            ${lastTool ? `<span class="subagent-last-tool">${this.getToolIcon(lastTool)} ${lastTool}</span>` : ''}
          </div>
        </div>
      `);
    }

    list.innerHTML = html.join('');
  }

  selectSubagent(agentId) {
    this.activeSubagentId = agentId;
    this.renderSubagentPanel();
    this.renderSubagentDetail();
  }

  renderSubagentDetail() {
    const detail = this.$('subagentDetail');
    if (!detail) return;

    if (!this.activeSubagentId) {
      detail.innerHTML = '<div class="subagent-empty">Select an agent to view details</div>';
      return;
    }

    const agent = this.subagents.get(this.activeSubagentId);
    const activity = this.subagentActivity.get(this.activeSubagentId) || [];

    if (!agent) {
      detail.innerHTML = '<div class="subagent-empty">Agent not found</div>';
      return;
    }

    const activityHtml = activity.slice(-30).map(a => {
      const time = new Date(a.timestamp).toLocaleTimeString('en-US', { hour12: false });
      if (a.type === 'tool') {
        const toolDetail = this.getToolDetailExpanded(a.tool, a.input, a.fullInput, a.toolUseId);
        return `<div class="subagent-activity tool" data-tool-use-id="${a.toolUseId || ''}">
          <span class="time">${time}</span>
          <span class="icon">${this.getToolIcon(a.tool)}</span>
          <span class="name">${a.tool}</span>
          <span class="detail">${toolDetail.primary}</span>
          ${toolDetail.hasMore ? `<button class="tool-expand-btn" onclick="app.toggleToolParams('${a.toolUseId}')">▶</button>` : ''}
          ${toolDetail.hasMore ? `<div class="tool-params-expanded" id="tool-params-${a.toolUseId}" style="display:none;"><pre>${this.escapeHtml(JSON.stringify(a.fullInput || a.input, null, 2))}</pre></div>` : ''}
        </div>`;
      } else if (a.type === 'tool_result') {
        const icon = a.isError ? '❌' : '📄';
        const statusClass = a.isError ? 'error' : '';
        const sizeInfo = a.contentLength > 500 ? ` (${this.formatBytes(a.contentLength)})` : '';
        const preview = a.preview.length > 80 ? a.preview.substring(0, 80) + '...' : a.preview;
        return `<div class="subagent-activity tool-result ${statusClass}">
          <span class="time">${time}</span>
          <span class="icon">${icon}</span>
          <span class="name">${a.tool || 'result'}</span>
          <span class="detail">${this.escapeHtml(preview)}${sizeInfo}</span>
        </div>`;
      } else if (a.type === 'progress') {
        // Check for hook events
        const isHook = a.hookEvent || a.hookName;
        const icon = isHook ? '🪝' : (a.progressType === 'query_update' ? '⟳' : '✓');
        const hookClass = isHook ? ' hook' : '';
        const displayText = isHook ? (a.hookName || a.hookEvent) : (a.query || a.progressType);
        return `<div class="subagent-activity progress${hookClass}">
          <span class="time">${time}</span>
          <span class="icon">${icon}</span>
          <span class="detail">${displayText}</span>
        </div>`;
      } else if (a.type === 'message') {
        const preview = a.text.length > 100 ? a.text.substring(0, 100) + '...' : a.text;
        return `<div class="subagent-activity message">
          <span class="time">${time}</span>
          <span class="icon">💬</span>
          <span class="detail">${this.escapeHtml(preview)}</span>
        </div>`;
      }
      return '';
    }).join('');

    const detailTitle = agent.description || `Agent ${agent.agentId}`;
    const modelBadge = agent.modelShort
      ? `<span class="subagent-model-badge ${agent.modelShort}">${agent.modelShort}</span>`
      : '';
    const tokenStats = (agent.totalInputTokens || agent.totalOutputTokens)
      ? `<span>Tokens: ${this.formatTokenCount(agent.totalInputTokens || 0)}↓ ${this.formatTokenCount(agent.totalOutputTokens || 0)}↑</span>`
      : '';

    detail.innerHTML = `
      <div class="subagent-detail-header">
        <span class="subagent-id" title="${this.escapeHtml(agent.description || agent.agentId)}">${this.escapeHtml(detailTitle.length > 60 ? detailTitle.substring(0, 60) + '...' : detailTitle)}</span>
        ${modelBadge}
        <span class="subagent-status ${agent.status}">${agent.status}</span>
        <button class="subagent-transcript-btn" onclick="app.viewSubagentTranscript('${agent.agentId}')">
          View Full Transcript
        </button>
      </div>
      <div class="subagent-detail-stats">
        <span>Tools: ${agent.toolCallCount}</span>
        <span>Entries: ${agent.entryCount}</span>
        <span>Size: ${(agent.fileSize / 1024).toFixed(1)}KB</span>
        ${tokenStats}
      </div>
      <div class="subagent-activity-log">
        ${activityHtml || '<div class="subagent-empty">No activity yet</div>'}
      </div>
    `;
  }

  toggleToolParams(toolUseId) {
    const el = document.getElementById(`tool-params-${toolUseId}`);
    if (!el) return;
    const btn = el.previousElementSibling;
    if (el.style.display === 'none') {
      el.style.display = 'block';
      if (btn) btn.textContent = '▼';
    } else {
      el.style.display = 'none';
      if (btn) btn.textContent = '▶';
    }
  }

  formatTokenCount(count) {
    if (count >= 1000000) return (count / 1000000).toFixed(1) + 'M';
    if (count >= 1000) return (count / 1000).toFixed(1) + 'k';
    return count.toString();
  }

  formatBytes(bytes) {
    if (bytes >= 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + 'MB';
    if (bytes >= 1024) return (bytes / 1024).toFixed(1) + 'KB';
    return bytes + 'B';
  }

  getToolIcon(tool) {
    const icons = {
      WebSearch: '🔍',
      WebFetch: '🌐',
      Read: '📖',
      Write: '📝',
      Edit: '✏️',
      Bash: '💻',
      Glob: '📁',
      Grep: '🔎',
      Task: '🤖',
    };
    return icons[tool] || '🔧';
  }

  getToolDetail(tool, input) {
    if (!input) return '';
    if (tool === 'WebSearch' && input.query) return `"${input.query}"`;
    if (tool === 'WebFetch' && input.url) return input.url;
    if (tool === 'Read' && input.file_path) return input.file_path;
    if ((tool === 'Write' || tool === 'Edit') && input.file_path) return input.file_path;
    if (tool === 'Bash' && input.command) {
      const cmd = input.command;
      return cmd.length > 40 ? cmd.substring(0, 40) + '...' : cmd;
    }
    if (tool === 'Glob' && input.pattern) return input.pattern;
    if (tool === 'Grep' && input.pattern) return input.pattern;
    return '';
  }

  getToolDetailExpanded(tool, input, fullInput, toolUseId) {
    const primary = this.getToolDetail(tool, input);
    // Check if there are additional params beyond the primary one
    const primaryKeys = ['query', 'url', 'file_path', 'command', 'pattern'];
    const inputKeys = Object.keys(fullInput || input || {});
    const extraKeys = inputKeys.filter(k => !primaryKeys.includes(k));
    const hasMore = extraKeys.length > 0 || (fullInput && JSON.stringify(fullInput).length > 100);
    return { primary, hasMore, fullInput: fullInput || input };
  }

  async killSubagent(agentId) {
    try {
      const res = await fetch(`/api/subagents/${agentId}`, { method: 'DELETE' });
      const data = await res.json();
      if (data.success) {
        // Update local state
        const agent = this.subagents.get(agentId);
        if (agent) {
          agent.status = 'completed';
          this.subagents.set(agentId, agent);
        }
        this.renderSubagentPanel();
        this.renderSubagentDetail();
        this.updateSubagentWindows();
        this.showToast(`Subagent ${agentId.substring(0, 7)} killed`, 'success');
      } else {
        this.showToast(data.error || 'Failed to kill subagent', 'error');
      }
    } catch (err) {
      console.error('Failed to kill subagent:', err);
      this.showToast('Failed to kill subagent: ' + err.message, 'error');
    }
  }

  async viewSubagentTranscript(agentId) {
    try {
      const res = await fetch(`/api/subagents/${agentId}/transcript?format=formatted`);
      const data = await res.json();

      if (!data.success) {
        alert('Failed to load transcript');
        return;
      }

      // Show in a modal or new window
      const content = data.data.formatted.join('\n');
      const win = window.open('', '_blank', 'width=800,height=600');
      win.document.write(`
        <html>
          <head>
            <title>Subagent ${agentId} Transcript</title>
            <style>
              body { background: #1a1a2e; color: #eee; font-family: monospace; padding: 20px; }
              pre { white-space: pre-wrap; word-wrap: break-word; }
            </style>
          </head>
          <body>
            <h2>Subagent ${agentId} Transcript (${data.data.entryCount} entries)</h2>
            <pre>${this.escapeHtml(content)}</pre>
          </body>
        </html>
      `);
    } catch (err) {
      console.error('Failed to load transcript:', err);
      alert('Failed to load transcript: ' + err.message);
    }
  }

  // ========== Subagent Parent TAB Tracking ==========
  //
  // CRITICAL: This system tracks which TAB an agent window connects to.
  // The association is stored in `subagentParentMap` (agentId -> sessionId).
  // The sessionId IS the tab identifier (tabs have data-id="${sessionId}").
  // Once set, this association is PERMANENT and persisted across restarts.

  /**
   * Find and assign the parent TAB for a subagent.
   *
   * Matching strategy (in order):
   * 1. Use existing stored association from subagentParentMap (permanent)
   * 2. Match via claudeSessionId (agent.sessionId === session.claudeSessionId)
   * 3. FALLBACK: Use the currently active session (since that's where the user typed the command)
   *
   * Once found, the association is stored PERMANENTLY in subagentParentMap.
   */
  findParentSessionForSubagent(agentId) {
    // Check if we already have a permanent association
    if (this.subagentParentMap.has(agentId)) {
      // Already have a parent - update agent object from stored value
      const storedSessionId = this.subagentParentMap.get(agentId);
      // Verify the session still exists
      if (this.sessions.has(storedSessionId)) {
        const agent = this.subagents.get(agentId);
        if (agent && !agent.parentSessionId) {
          agent.parentSessionId = storedSessionId;
          const session = this.sessions.get(storedSessionId);
          if (session) {
            agent.parentSessionName = this.getSessionName(session);
          }
          this.subagents.set(agentId, agent);
          this.updateSubagentWindowParent(agentId);
        }
        return;
      }
      // Stored session no longer exists - clear and re-discover
      this.subagentParentMap.delete(agentId);
    }

    const agent = this.subagents.get(agentId);
    if (!agent) return;

    // Strategy 1: Match via claudeSessionId (most accurate)
    if (agent.sessionId) {
      for (const [sessionId, session] of this.sessions) {
        if (session.claudeSessionId === agent.sessionId) {
          // FOUND! Store this association PERMANENTLY
          this.setAgentParentSessionId(agentId, sessionId);
          this.updateSubagentWindowParent(agentId);
          this.updateSubagentWindowVisibility();
          this.updateConnectionLines();
          return;
        }
      }
    }

    // Strategy 2: FALLBACK - Use the currently active session
    // This works because agents spawn from where the user typed the command
    if (this.activeSessionId && this.sessions.has(this.activeSessionId)) {
      this.setAgentParentSessionId(agentId, this.activeSessionId);
      this.updateSubagentWindowParent(agentId);
      this.updateSubagentWindowVisibility();
      this.updateConnectionLines();
      return;
    }

    // Strategy 3: If no active session, use the first session
    if (this.sessions.size > 0) {
      const firstSessionId = this.sessions.keys().next().value;
      this.setAgentParentSessionId(agentId, firstSessionId);
      this.updateSubagentWindowParent(agentId);
      this.updateSubagentWindowVisibility();
      this.updateConnectionLines();
    }
  }

  /**
   * Re-check all orphan subagents (those without a parent TAB) when a session updates.
   * Called when session:updated fires with claudeSessionId.
   *
   * Also re-validates existing associations when claudeSessionId becomes available,
   * in case the fallback association was wrong.
   */
  recheckOrphanSubagents() {
    let anyChanged = false;
    for (const [agentId, agent] of this.subagents) {
      // Check if this agent has no parent in the persistent map
      if (!this.subagentParentMap.has(agentId)) {
        this.findParentSessionForSubagent(agentId);
        if (this.subagentParentMap.has(agentId)) {
          anyChanged = true;
        }
      } else if (agent.sessionId) {
        // Agent has a stored parent, but check if we can now do a proper claudeSessionId match
        // This handles the case where fallback was used but now the real parent is known
        const storedParent = this.subagentParentMap.get(agentId);
        const storedSession = this.sessions.get(storedParent);

        // If the stored session doesn't have a matching claudeSessionId, try to find the real match
        if (storedSession && storedSession.claudeSessionId !== agent.sessionId) {
          for (const [sessionId, session] of this.sessions) {
            if (session.claudeSessionId === agent.sessionId) {
              // Found the real parent - update the association
              this.subagentParentMap.set(agentId, sessionId);
              agent.parentSessionId = sessionId;
              agent.parentSessionName = this.getSessionName(session);
              this.subagents.set(agentId, agent);
              this.updateSubagentWindowParent(agentId);
              anyChanged = true;
              break;
            }
          }
        }
      }
    }
    if (anyChanged) {
      this.saveSubagentParentMap();
      this.updateConnectionLines();
    }
  }

  /**
   * Update parentSessionName for all subagents belonging to a TAB.
   * Called when a session is renamed to keep cached names fresh.
   */
  updateSubagentParentNames(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    const newName = this.getSessionName(session);

    // Skip iteration if name hasn't changed (avoids O(n) loop on every session:updated)
    const cachedName = this._parentNameCache?.get(sessionId);
    if (cachedName === newName) return;
    if (!this._parentNameCache) this._parentNameCache = new Map();
    this._parentNameCache.set(sessionId, newName);

    for (const [agentId, storedSessionId] of this.subagentParentMap) {
      if (storedSessionId === sessionId) {
        const agent = this.subagents.get(agentId);
        if (agent) {
          agent.parentSessionName = newName;
          this.subagents.set(agentId, agent);

          // Update the window header if open
          const windowData = this.subagentWindows.get(agentId);
          if (windowData) {
            const parentNameEl = windowData.element.querySelector('.subagent-window-parent .parent-name');
            if (parentNameEl) {
              parentNameEl.textContent = newName;
            }
          }
        }
      }
    }
  }

  /**
   * Add parent header to an agent window, showing which TAB it belongs to.
   */
  updateSubagentWindowParent(agentId) {
    const windowData = this.subagentWindows.get(agentId);
    if (!windowData) return;

    // Get parent from persistent map (THE source of truth)
    const parentSessionId = this.subagentParentMap.get(agentId);
    if (!parentSessionId) return;

    const session = this.sessions.get(parentSessionId);
    const parentName = session ? this.getSessionName(session) : 'Unknown';

    // Check if parent header already exists
    const win = windowData.element;
    const existingParent = win.querySelector('.subagent-window-parent');
    if (existingParent) {
      // Update existing
      existingParent.dataset.parentSession = parentSessionId;
      const nameEl = existingParent.querySelector('.parent-name');
      if (nameEl) {
        nameEl.textContent = parentName;
        nameEl.onclick = () => this.selectSession(parentSessionId);
      }
      return;
    }

    // Insert new parent header after the main header
    const header = win.querySelector('.subagent-window-header');
    if (header) {
      const parentDiv = document.createElement('div');
      parentDiv.className = 'subagent-window-parent';
      parentDiv.dataset.parentSession = parentSessionId;
      parentDiv.innerHTML = `
        <span class="parent-label">from</span>
        <span class="parent-name" onclick="app.selectSession('${parentSessionId}')">${this.escapeHtml(parentName)}</span>
      `;
      header.insertAdjacentElement('afterend', parentDiv);
    }
  }

  // ========== Subagent Connection Lines ==========
  //
  // Connection lines are drawn from agent windows to their parent TABs.
  // The parent TAB is determined by the PERSISTENT subagentParentMap.
  // This map stores agentId -> sessionId, where sessionId is the tab's data-id.

  updateConnectionLines() {
    // Coalesce multiple calls within the same frame into a single rAF
    if (!this._connectionLinesScheduled) {
      this._connectionLinesScheduled = true;
      requestAnimationFrame(() => {
        this._connectionLinesScheduled = false;
        this._updateConnectionLinesImmediate();
      });
    }
  }

  _updateConnectionLinesImmediate() {
    const svg = document.getElementById('connectionLines');
    if (!svg) return;

    svg.innerHTML = '';

    // Check if Ralph wizard modal is open
    const wizardModal = document.getElementById('ralphWizardModal');
    const wizardOpen = wizardModal?.classList.contains('active');
    const wizardContent = wizardOpen ? wizardModal.querySelector('.modal-content') : null;

    // Collect visible regular subagent windows
    const visibleSubagentWindows = [];
    for (const [agentId, windowInfo] of this.subagentWindows) {
      if (windowInfo.minimized || windowInfo.hidden) continue;
      const win = windowInfo.element;
      if (!win) continue;
      visibleSubagentWindows.push({ agentId, windowInfo, win });
    }

    // Get plan subagent windows as array for distribution
    const planSubagentArray = Array.from(this.planSubagents.entries())
      .filter(([, data]) => data.element)
      .map(([id, data]) => ({ id, ...data }));

    for (const { agentId, win } of visibleSubagentWindows) {
      const winRect = win.getBoundingClientRect();

      // If wizard is open with plan subagents, connect regular subagents to plan subagent windows
      if (wizardOpen && wizardContent && planSubagentArray.length > 0) {
        // Find the nearest plan subagent window to connect to
        let nearestPlanAgent = null;
        let nearestDistance = Infinity;

        for (const planAgent of planSubagentArray) {
          const planRect = planAgent.element.getBoundingClientRect();
          const planCenterX = planRect.left + planRect.width / 2;
          const planCenterY = planRect.top + planRect.height / 2;
          const winCenterX = winRect.left + winRect.width / 2;
          const winCenterY = winRect.top + winRect.height / 2;
          const distance = Math.hypot(planCenterX - winCenterX, planCenterY - winCenterY);

          if (distance < nearestDistance) {
            nearestDistance = distance;
            nearestPlanAgent = planAgent;
          }
        }

        if (nearestPlanAgent) {
          const planRect = nearestPlanAgent.element.getBoundingClientRect();

          // Draw line from plan subagent window to regular subagent window
          let x1, y1, x2, y2;
          const planCenterX = planRect.left + planRect.width / 2;
          const winCenterX = winRect.left + winRect.width / 2;

          if (winCenterX < planCenterX) {
            x1 = planRect.left;
            y1 = planRect.top + planRect.height / 2;
            x2 = winRect.right;
            y2 = winRect.top + winRect.height / 2;
          } else {
            x1 = planRect.right;
            y1 = planRect.top + planRect.height / 2;
            x2 = winRect.left;
            y2 = winRect.top + winRect.height / 2;
          }

          const midX = (x1 + x2) / 2;
          const path = `M ${x1} ${y1} C ${midX} ${y1}, ${midX} ${y2}, ${x2} ${y2}`;

          const line = document.createElementNS('http://www.w3.org/2000/svg', 'path');
          line.setAttribute('d', path);
          line.setAttribute('class', 'connection-line plan-to-subagent-line');
          line.setAttribute('data-agent-id', agentId);
          line.setAttribute('data-plan-agent-id', nearestPlanAgent.id);
          svg.appendChild(line);
        }
      } else if (wizardOpen && wizardContent) {
        // Wizard open but no plan subagents - connect directly to wizard
        const wizardRect = wizardContent.getBoundingClientRect();

        const winCenterX = winRect.left + winRect.width / 2;
        const wizardCenterX = wizardRect.left + wizardRect.width / 2;

        let x1, y1, x2, y2;

        if (winCenterX < wizardCenterX) {
          x1 = wizardRect.left;
          y1 = wizardRect.top + wizardRect.height / 2;
          x2 = winRect.right;
          y2 = winRect.top + winRect.height / 2;
        } else {
          x1 = wizardRect.right;
          y1 = wizardRect.top + wizardRect.height / 2;
          x2 = winRect.left;
          y2 = winRect.top + winRect.height / 2;
        }

        const midX = (x1 + x2) / 2;
        const path = `M ${x1} ${y1} C ${midX} ${y1}, ${midX} ${y2}, ${x2} ${y2}`;

        const line = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        line.setAttribute('d', path);
        line.setAttribute('class', 'connection-line wizard-connection');
        line.setAttribute('data-agent-id', agentId);
        svg.appendChild(line);
      } else {
        // NORMAL MODE: Connect agent window to its parent TAB
        // Use the PERSISTENT subagentParentMap as the ONLY source of truth
        const parentSessionId = this.subagentParentMap.get(agentId);

        if (!parentSessionId) {
          // No parent known yet - skip this agent
          continue;
        }

        // Find the TAB element by its data-id
        const tab = document.querySelector(`.session-tab[data-id="${parentSessionId}"]`);
        if (!tab) {
          // Tab not in DOM (might be scrolled out or session closed)
          continue;
        }

        const tabRect = tab.getBoundingClientRect();

        // Draw curved line from TAB bottom-center to window top-center
        const x1 = tabRect.left + tabRect.width / 2;
        const y1 = tabRect.bottom;
        const x2 = winRect.left + winRect.width / 2;
        const y2 = winRect.top;

        // Bezier curve control points for smooth curve
        const midY = (y1 + y2) / 2;
        const path = `M ${x1} ${y1} C ${x1} ${midY}, ${x2} ${midY}, ${x2} ${y2}`;

        const line = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        line.setAttribute('d', path);
        line.setAttribute('class', 'connection-line');
        line.setAttribute('data-agent-id', agentId);
        line.setAttribute('data-parent-tab', parentSessionId);
        svg.appendChild(line);
      }
    }

    // Draw lines from wizard to plan subagent windows (Opus agents during plan generation)
    // Skip if agents are minimized to tab
    if (wizardOpen && wizardContent && this.planSubagents.size > 0 && !this.planAgentsMinimized) {
      const wizardRect = wizardContent.getBoundingClientRect();

      for (const [agentId, windowData] of this.planSubagents) {
        const win = windowData.element;
        if (!win) continue;

        const winRect = win.getBoundingClientRect();

        // Determine which side of wizard the window is on
        const winCenterX = winRect.left + winRect.width / 2;
        const wizardCenterX = wizardRect.left + wizardRect.width / 2;

        let x1, y1, x2, y2;

        if (winCenterX < wizardCenterX) {
          x1 = wizardRect.left;
          y1 = wizardRect.top + wizardRect.height / 3 + (this.planSubagents.size > 3 ? 0 : 50);
          x2 = winRect.right;
          y2 = winRect.top + winRect.height / 2;
        } else {
          x1 = wizardRect.right;
          y1 = wizardRect.top + wizardRect.height / 3 + (this.planSubagents.size > 3 ? 0 : 50);
          x2 = winRect.left;
          y2 = winRect.top + winRect.height / 2;
        }

        const midX = (x1 + x2) / 2;
        const path = `M ${x1} ${y1} C ${midX} ${y1}, ${midX} ${y2}, ${x2} ${y2}`;

        const line = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        line.setAttribute('d', path);
        line.setAttribute('class', 'connection-line wizard-connection plan-subagent-line');
        line.setAttribute('data-plan-agent-id', agentId);
        svg.appendChild(line);
      }
    }
  }

  /**
   * Show/hide subagent windows based on active session.
   * Behavior controlled by "Subagents for Active Tab Only" setting.
   * Uses the PERSISTENT subagentParentMap for accurate tab-based visibility.
   */
  updateSubagentWindowVisibility() {
    const settings = this.loadAppSettingsFromStorage();
    const activeTabOnly = settings.subagentActiveTabOnly ?? true;

    for (const [agentId, windowInfo] of this.subagentWindows) {
      // Get parent from PERSISTENT map (THE source of truth)
      const storedParent = this.subagentParentMap.get(agentId);
      const agent = this.subagents.get(agentId);
      const parentSessionId = storedParent || agent?.parentSessionId;

      // Determine visibility based on setting
      let shouldShow;
      if (activeTabOnly) {
        // Show if: no parent known yet, or parent matches active session
        const hasKnownParent = !!parentSessionId;
        shouldShow = !hasKnownParent || parentSessionId === this.activeSessionId;
      } else {
        // Show all windows (original behavior)
        shouldShow = true;
      }

      if (shouldShow) {
        // Show window (unless it was minimized by user)
        if (!windowInfo.minimized) {
          windowInfo.element.style.display = 'flex';
        }
        windowInfo.hidden = false;
      } else {
        // Hide window (but don't close it)
        windowInfo.element.style.display = 'none';
        windowInfo.hidden = true;
      }
    }
    // Update connection lines after visibility changes
    this.updateConnectionLines();
  }

  // ========== Subagent Floating Windows ==========

  openSubagentWindow(agentId) {
    // If window already exists, focus it
    if (this.subagentWindows.has(agentId)) {
      const existing = this.subagentWindows.get(agentId);
      const agent = this.subagents.get(agentId);
      const settings = this.loadAppSettingsFromStorage();
      const activeTabOnly = settings.subagentActiveTabOnly ?? true;

      // If window is hidden (different tab) and activeTabOnly is enabled, switch to parent tab
      if (existing.hidden && agent?.parentSessionId && activeTabOnly) {
        this.selectSession(agent.parentSessionId);
        return;
      }

      // If not activeTabOnly mode, just show the window
      if (existing.hidden && !activeTabOnly) {
        existing.element.style.display = 'flex';
        existing.hidden = false;
      }

      existing.element.style.zIndex = ++this.subagentWindowZIndex;
      if (existing.minimized) {
        this.restoreSubagentWindow(agentId);
      }
      return;
    }

    const agent = this.subagents.get(agentId);
    if (!agent) return;

    // Only open windows for agents that belong to a Claudeman-managed session tab.
    // Agents from external Claude sessions (not tracked by Claudeman) should not pop up.
    if (agent.sessionId) {
      const hasMatchingTab = Array.from(this.sessions.values()).some(s => s.claudeSessionId === agent.sessionId);
      if (!hasMatchingTab) return;
    }

    // Calculate final position - grid layout to avoid overlaps
    const windowCount = this.subagentWindows.size;
    const isMobile = MobileDetection.getDeviceType() === 'mobile';
    const mobileCardHeight = 110;
    const mobileCardGap = 4;
    const windowWidth = isMobile ? window.innerWidth : 420;
    const windowHeight = isMobile ? mobileCardHeight : 350;
    const gap = 20;
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;

    let finalX = 0;
    let finalY = 0;

    if (isMobile) {
      // Mobile: stack compact cards above toolbar. Count visible (non-minimized) windows.
      let visibleCount = 0;
      for (const [, data] of this.subagentWindows) {
        if (!data.minimized && !data.hidden) visibleCount++;
      }
      const toolbarHeight = 40;
      // Stack from bottom: first card just above toolbar, next above that, etc.
      const bottomOffset = toolbarHeight + visibleCount * (mobileCardHeight + mobileCardGap);
      finalX = 4;
      finalY = viewportHeight - bottomOffset - mobileCardHeight;
    } else {
      // Check if Ralph wizard modal is open - if so, position windows on the sides
      const wizardModal = document.getElementById('ralphWizardModal');
      const wizardOpen = wizardModal?.classList.contains('active');

      let startX, startY, maxCols;

      if (wizardOpen) {
        // Wizard is ~720px wide, centered. Position windows on left/right sides
        const wizardWidth = 720;
        const centerX = viewportWidth / 2;
        const wizardLeft = centerX - wizardWidth / 2;
        const wizardRight = centerX + wizardWidth / 2;

        // Alternate between left and right sides of the wizard
        const leftSideSpace = wizardLeft - 20;
        const rightSideSpace = viewportWidth - wizardRight - 20;

        if (windowCount % 2 === 0 && rightSideSpace >= windowWidth) {
          // Even windows go to the right
          startX = wizardRight + 20;
          maxCols = Math.floor(rightSideSpace / (windowWidth + gap)) || 1;
        } else if (leftSideSpace >= windowWidth) {
          // Odd windows go to the left
          startX = Math.max(10, wizardLeft - windowWidth - 20);
          maxCols = 1; // Usually only room for 1 column on left
        } else {
          // Not enough side space, use right side
          startX = wizardRight + 20;
          maxCols = 1;
        }
        startY = 80; // Start higher when wizard is open
      } else {
        // Normal positioning
        startX = 50;
        startY = 120;
        maxCols = Math.floor((viewportWidth - startX - 50) / (windowWidth + gap)) || 1;
      }

      const maxRows = Math.floor((viewportHeight - startY - 50) / (windowHeight + gap)) || 1;
      const col = windowCount % maxCols;
      const row = Math.floor(windowCount / maxCols) % maxRows; // Wrap rows to stay in viewport
      finalX = startX + col * (windowWidth + gap);
      finalY = startY + row * (windowHeight + gap);

      // Ensure window stays within viewport bounds
      finalX = Math.max(10, Math.min(finalX, viewportWidth - windowWidth - 10));
      finalY = Math.max(10, Math.min(finalY, viewportHeight - windowHeight - 10));
    }

    // Get parent session from PERSISTENT map (THE source of truth for tab connections)
    const parentSessionId = this.subagentParentMap.get(agentId) || agent.parentSessionId;
    let parentSessionName = null;

    if (parentSessionId) {
      const parentSession = this.sessions.get(parentSessionId);
      if (parentSession) {
        parentSessionName = this.getSessionName(parentSession);
        // Ensure the agent object is also updated for consistency
        if (!agent.parentSessionId) {
          agent.parentSessionId = parentSessionId;
          agent.parentSessionName = parentSessionName;
          this.subagents.set(agentId, agent);
        }
      }
    }

    // Get parent TAB element for spawn animation
    const parentTab = parentSessionId
      ? document.querySelector(`.session-tab[data-id="${parentSessionId}"]`)
      : null;

    // Create window element
    const win = document.createElement('div');
    win.className = 'subagent-window';
    win.id = `subagent-window-${agentId}`;
    win.style.zIndex = ++this.subagentWindowZIndex;

    // Build parent header if we have parent info
    const parentHeader = parentSessionId && parentSessionName
      ? `<div class="subagent-window-parent" data-parent-session="${parentSessionId}">
          <span class="parent-label">from</span>
          <span class="parent-name" onclick="app.selectSession('${parentSessionId}')">${this.escapeHtml(parentSessionName)}</span>
        </div>`
      : '';

    const teammateInfo = this.getTeammateInfo(agent);
    const windowTitle = teammateInfo ? teammateInfo.name : (agent.description || agentId.substring(0, 7));
    const maxTitleLen = isMobile ? 30 : 50;
    const truncatedTitle = windowTitle.length > maxTitleLen ? windowTitle.substring(0, maxTitleLen) + '...' : windowTitle;
    const modelBadge = agent.modelShort
      ? `<span class="subagent-model-badge ${agent.modelShort}">${agent.modelShort}</span>`
      : '';
    win.innerHTML = `
      <div class="subagent-window-header">
        <div class="subagent-window-title" title="${this.escapeHtml(agent.description || agentId)}">
          <span class="icon">🤖</span>
          <span class="id">${this.escapeHtml(truncatedTitle)}</span>
          ${modelBadge}
          <span class="status ${agent.status}">${agent.status}</span>
        </div>
        <div class="subagent-window-actions">
          <button onclick="app.closeSubagentWindow('${agentId}')" title="Minimize to tab">─</button>
        </div>
      </div>
      ${parentHeader}
      <div class="subagent-window-body" id="subagent-window-body-${agentId}">
        <div class="subagent-empty">Loading activity...</div>
      </div>
    `;

    // If we have a parent tab, start window at tab position for spawn animation
    if (isMobile) {
      // Mobile: position as stacked card via inline bottom offset
      let visibleCount = 0;
      for (const [, data] of this.subagentWindows) {
        if (!data.minimized && !data.hidden) visibleCount++;
      }
      const bottomPx = 40 + visibleCount * (mobileCardHeight + mobileCardGap);
      win.style.bottom = `${bottomPx}px`;
      win.style.top = 'auto';
    } else if (parentTab) {
      const tabRect = parentTab.getBoundingClientRect();
      win.style.left = `${tabRect.left}px`;
      win.style.top = `${tabRect.bottom}px`;
      win.style.transform = 'scale(0.3)';
      win.style.opacity = '0';
      win.classList.add('spawning');
    } else {
      // No parent tab, just position normally (desktop/tablet)
      win.style.left = `${finalX}px`;
      win.style.top = `${finalY}px`;
    }

    document.body.appendChild(win);

    // Make draggable (returns listener refs for cleanup)
    const dragListeners = this.makeWindowDraggable(win, win.querySelector('.subagent-window-header'));

    // Check if this window should be visible based on settings
    // Use the PERSISTENT parent map for accurate tab-based visibility
    const settings = this.loadAppSettingsFromStorage();
    const activeTabOnly = settings.subagentActiveTabOnly ?? true;
    let shouldHide = false;
    if (activeTabOnly) {
      const storedParent = this.subagentParentMap.get(agentId);
      const hasKnownParent = storedParent || agent.parentSessionId;
      const parentId = storedParent || agent.parentSessionId;
      const isForActiveSession = !hasKnownParent || parentId === this.activeSessionId;
      shouldHide = !isForActiveSession;
    }

    // Store reference (including drag listeners for cleanup)
    this.subagentWindows.set(agentId, {
      element: win,
      minimized: false,
      hidden: shouldHide,
      dragListeners, // Store for cleanup to prevent memory leaks
    });

    // Hide window if not for active session
    if (shouldHide) {
      win.style.display = 'none';
    }

    // Render content — check if this teammate has a tmux pane
    const paneInfo = teammateInfo ? this.teammatePanesByName.get(teammateInfo.name) : null;
    if (paneInfo) {
      this.initTeammateTerminal(agentId, paneInfo, win);
    } else {
      this.renderSubagentWindowContent(agentId);
    }

    // Focus on click
    win.addEventListener('mousedown', () => {
      win.style.zIndex = ++this.subagentWindowZIndex;
    });

    // Update connection lines when window is resized
    const resizeObserver = new ResizeObserver(() => {
      this.updateConnectionLines();
    });
    resizeObserver.observe(win);

    // Store observer for cleanup
    this.subagentWindows.get(agentId).resizeObserver = resizeObserver;

    // Animate to final position if spawning from tab (desktop only)
    if (parentTab && !isMobile) {
      requestAnimationFrame(() => {
        win.style.transition = 'all 0.4s cubic-bezier(0.34, 1.56, 0.64, 1)';
        win.style.left = `${finalX}px`;
        win.style.top = `${finalY}px`;
        win.style.transform = 'scale(1)';
        win.style.opacity = '1';

        // Clean up after animation
        setTimeout(() => {
          win.style.transition = '';
          win.classList.remove('spawning');
          this.updateConnectionLines();
        }, 400);
      });
    } else {
      // No animation (mobile uses CSS positioning), just update connection lines
      this.updateConnectionLines();
    }

    // Persist the state change (new window opened)
    this.saveSubagentWindowStates();
  }

  closeSubagentWindow(agentId) {
    const windowData = this.subagentWindows.get(agentId);
    if (!windowData) return;

    const agent = this.subagents.get(agentId);

    // Get parent from PERSISTENT map (THE source of truth)
    // Fall back to agent's parentSessionId, then to active session
    const storedParent = this.subagentParentMap.get(agentId);
    let parentSessionId = storedParent || agent?.parentSessionId || this.activeSessionId;

    // If we don't have a stored parent yet, store it now
    if (!storedParent && parentSessionId && this.sessions.has(parentSessionId)) {
      this.setAgentParentSessionId(agentId, parentSessionId);
    }

    // Always minimize to tab
    windowData.element.style.display = 'none';
    windowData.minimized = true;

    // Track minimized agent for the session (use the TAB's session ID)
    if (parentSessionId) {
      if (!this.minimizedSubagents.has(parentSessionId)) {
        this.minimizedSubagents.set(parentSessionId, new Set());
      }
      this.minimizedSubagents.get(parentSessionId).add(agentId);

      // Update tab badge to show minimized agents
      this.renderSessionTabs();
    }

    // Persist the state change
    this.saveSubagentWindowStates();
    this.updateConnectionLines();
  }

  // Close all subagent windows for a session (fully removes them, not minimize)
  // If cleanupData is true, also remove activity and toolResults data to prevent memory leaks
  closeSessionSubagentWindows(sessionId, cleanupData = false) {
    const toClose = [];
    for (const [agentId, _windowData] of this.subagentWindows) {
      const agent = this.subagents.get(agentId);
      // Check both subagent parentSessionId and subagentParentMap
      // (standalone pane windows use subagentParentMap, not subagents map)
      const parentFromMap = this.subagentParentMap.get(agentId);
      if (agent?.parentSessionId === sessionId || parentFromMap === sessionId) {
        toClose.push(agentId);
      }
    }
    for (const agentId of toClose) {
      this.forceCloseSubagentWindow(agentId);
      // Clean up activity and tool results data if requested (prevents memory leaks)
      if (cleanupData) {
        this.subagents.delete(agentId);
        this.subagentActivity.delete(agentId);
        this.subagentToolResults.delete(agentId);
        this.subagentParentMap.delete(agentId);
      }
    }
    // Also clean up minimized agents for this session
    this.minimizedSubagents.delete(sessionId);
    this.renderSessionTabs();
  }

  // Fully close a subagent window (removes from DOM, not minimize)
  forceCloseSubagentWindow(agentId) {
    const windowData = this.subagentWindows.get(agentId);
    if (windowData) {
      // Clean up resize observer
      if (windowData.resizeObserver) {
        windowData.resizeObserver.disconnect();
      }
      // Clean up global drag event listeners (prevents memory leak)
      if (windowData.dragListeners) {
        document.removeEventListener('mousemove', windowData.dragListeners.move);
        document.removeEventListener('mouseup', windowData.dragListeners.up);
        if (windowData.dragListeners.touchMove) {
          document.removeEventListener('touchmove', windowData.dragListeners.touchMove);
          document.removeEventListener('touchend', windowData.dragListeners.up);
          document.removeEventListener('touchcancel', windowData.dragListeners.up);
        }
      }
      windowData.element.remove();
      this.subagentWindows.delete(agentId);
    }
    // Clean up teammate terminal if present
    const termData = this.teammateTerminals.get(agentId);
    if (termData) {
      if (termData.resizeObserver) {
        termData.resizeObserver.disconnect();
      }
      if (termData.terminal) {
        try { termData.terminal.dispose(); } catch {}
      }
      this.teammateTerminals.delete(agentId);
    }
  }

  // Clean up ALL floating windows (called during handleInit to prevent memory leaks on reconnect)
  cleanupAllFloatingWindows() {
    // Clean up all subagent windows with their ResizeObservers and drag listeners
    for (const [agentId, windowData] of this.subagentWindows) {
      if (windowData.resizeObserver) {
        windowData.resizeObserver.disconnect();
      }
      if (windowData.dragListeners) {
        document.removeEventListener('mousemove', windowData.dragListeners.move);
        document.removeEventListener('mouseup', windowData.dragListeners.up);
        if (windowData.dragListeners.touchMove) {
          document.removeEventListener('touchmove', windowData.dragListeners.touchMove);
          document.removeEventListener('touchend', windowData.dragListeners.up);
          document.removeEventListener('touchcancel', windowData.dragListeners.up);
        }
      }
      windowData.element.remove();
    }
    this.subagentWindows.clear();

    // Clean up all teammate terminals
    for (const [, termData] of this.teammateTerminals) {
      if (termData.resizeObserver) termData.resizeObserver.disconnect();
      if (termData.terminal) {
        try { termData.terminal.dispose(); } catch {}
      }
    }
    this.teammateTerminals.clear();
    this.teammatePanesByName.clear();

    // Clean up all log viewer windows with their EventSources and drag listeners
    for (const [windowId, data] of this.logViewerWindows) {
      if (data.eventSource) {
        data.eventSource.close();
      }
      if (data.dragListeners) {
        document.removeEventListener('mousemove', data.dragListeners.move);
        document.removeEventListener('mouseup', data.dragListeners.up);
        if (data.dragListeners.touchMove) {
          document.removeEventListener('touchmove', data.dragListeners.touchMove);
          document.removeEventListener('touchend', data.dragListeners.up);
          document.removeEventListener('touchcancel', data.dragListeners.up);
        }
      }
      data.element.remove();
    }
    this.logViewerWindows.clear();

    // Clean up plan file manager and plan file windows (drag/resize handlers)
    this.closePlanFileManager();
    document.querySelectorAll('.plan-file-window').forEach(win => {
      if (win._dragHandlers) {
        document.removeEventListener('mousemove', win._dragHandlers.move);
        document.removeEventListener('mouseup', win._dragHandlers.up);
      }
      if (win._resizeHandlers) {
        document.removeEventListener('mousemove', win._resizeHandlers.move);
        document.removeEventListener('mouseup', win._resizeHandlers.up);
      }
      win.remove();
    });

    // Clean up plan subagent windows (wizard agents)
    if (this.planSubagents) {
      for (const [agentId, windowData] of this.planSubagents) {
        if (windowData.dragListeners) {
          document.removeEventListener('mousemove', windowData.dragListeners.move);
          document.removeEventListener('mouseup', windowData.dragListeners.up);
        }
        if (windowData.element) {
          windowData.element.remove();
        }
      }
      this.planSubagents.clear();
    }

    // Clean up all image popup windows with their drag listeners
    for (const [imageId, popupData] of this.imagePopups) {
      if (popupData.dragListeners) {
        document.removeEventListener('mousemove', popupData.dragListeners.move);
        document.removeEventListener('mouseup', popupData.dragListeners.up);
        if (popupData.dragListeners.touchMove) {
          document.removeEventListener('touchmove', popupData.dragListeners.touchMove);
          document.removeEventListener('touchend', popupData.dragListeners.up);
          document.removeEventListener('touchcancel', popupData.dragListeners.up);
        }
      }
      popupData.element.remove();
    }
    this.imagePopups.clear();

    // Clear orphaned plan generation state
    this.activePlanOrchestratorId = null;
    this._planProgressHandler = null;
    this.planGenerationStopped = true;
    if (this.planGenerationAbortController) {
      this.planGenerationAbortController.abort();
      this.planGenerationAbortController = null;
    }

    // Clean up wizard-specific timers (leak fix: not cleared on SSE reconnect)
    if (this.wizardMinimizedTimer) {
      clearInterval(this.wizardMinimizedTimer);
      this.wizardMinimizedTimer = null;
    }

    // Clean up wizard drag listeners (leak fix: document-level handlers)
    this.cleanupWizardDragging();

    // Deactivate focus trap if wizard was open (leak fix: keydown listener)
    if (this.activeFocusTrap) {
      this.activeFocusTrap.deactivate();
      this.activeFocusTrap = null;
    }

    // Clean up team tasks panel drag listeners
    if (this.teamTasksDragListeners) {
      document.removeEventListener('mousemove', this.teamTasksDragListeners.move);
      document.removeEventListener('mouseup', this.teamTasksDragListeners.up);
      if (this.teamTasksDragListeners.touchMove) {
        document.removeEventListener('touchmove', this.teamTasksDragListeners.touchMove);
        document.removeEventListener('touchend', this.teamTasksDragListeners.up);
        document.removeEventListener('touchcancel', this.teamTasksDragListeners.up);
      }
      this.teamTasksDragListeners = null;
    }

    // Clear minimized agents tracking
    this.minimizedSubagents.clear();

    // Update monitor panel
    this.renderMonitorPlanAgents();

    // Update connection lines (should be empty now)
    this.updateConnectionLines();
  }

  minimizeSubagentWindow(agentId) {
    const windowData = this.subagentWindows.get(agentId);
    if (windowData) {
      windowData.element.style.display = 'none';
      windowData.minimized = true;
      this.updateConnectionLines();
    }
  }

  restoreSubagentWindow(agentId) {
    const windowData = this.subagentWindows.get(agentId);
    const agent = this.subagents.get(agentId);

    // If window doesn't exist but agent does, recreate it
    if (!windowData && agent) {
      this.openSubagentWindow(agentId);
      return;
    }

    if (windowData) {
      const settings = this.loadAppSettingsFromStorage();
      const activeTabOnly = settings.subagentActiveTabOnly ?? true;

      // Get parent from PERSISTENT map (THE source of truth)
      const storedParent = this.subagentParentMap.get(agentId);
      const parentSessionId = storedParent || agent?.parentSessionId;

      // Determine if we should show the window
      let shouldShow = true;
      if (activeTabOnly) {
        // Only restore if the window belongs to the active session (or has no parent)
        shouldShow = !parentSessionId || parentSessionId === this.activeSessionId;
      }

      if (shouldShow) {
        windowData.element.style.display = 'flex';
        windowData.element.style.zIndex = ++this.subagentWindowZIndex;
        windowData.hidden = false;
      }
      windowData.minimized = false;
      this.updateConnectionLines();
    }
  }

  // Returns drag listener references for cleanup (prevents memory leaks)
  makeWindowDraggable(win, handle) {
    let isDragging = false;
    let startX, startY, startLeft, startTop;
    let dragUpdateScheduled = false;

    const startDrag = (clientX, clientY) => {
      isDragging = true;
      startX = clientX;
      startY = clientY;
      startLeft = parseInt(win.style.left) || win.getBoundingClientRect().left;
      startTop = parseInt(win.style.top) || win.getBoundingClientRect().top;
      // On drag start, switch from bottom-positioned to top-positioned so left/top work
      win.style.bottom = 'auto';
    };

    const moveDrag = (clientX, clientY) => {
      if (!isDragging) return;
      const dx = clientX - startX;
      const dy = clientY - startY;
      // Constrain to viewport bounds
      const winWidth = win.offsetWidth || 420;
      const winHeight = win.offsetHeight || 350;
      const maxX = window.innerWidth - winWidth - 4;
      const maxY = window.innerHeight - winHeight - 4;
      const newLeft = Math.max(4, Math.min(startLeft + dx, maxX));
      const newTop = Math.max(4, Math.min(startTop + dy, maxY));
      win.style.left = `${newLeft}px`;
      win.style.top = `${newTop}px`;
      // Throttle connection line updates during drag
      if (!dragUpdateScheduled) {
        dragUpdateScheduled = true;
        requestAnimationFrame(() => {
          this.updateConnectionLines();
          dragUpdateScheduled = false;
        });
      }
    };

    const endDrag = () => {
      if (isDragging) {
        isDragging = false;
        // Save position after drag ends
        this.saveSubagentWindowStates();
      }
    };

    // Mouse events
    handle.addEventListener('mousedown', (e) => {
      if (e.target.tagName === 'BUTTON') return;
      startDrag(e.clientX, e.clientY);
      e.preventDefault();
    });

    // Touch events
    handle.addEventListener('touchstart', (e) => {
      if (e.target.tagName === 'BUTTON') return;
      const touch = e.touches[0];
      startDrag(touch.clientX, touch.clientY);
    }, { passive: true });

    // Store references to document-level listeners so they can be removed on window close
    const moveListener = (e) => {
      moveDrag(e.clientX, e.clientY);
    };

    const touchMoveListener = (e) => {
      if (!isDragging) return;
      e.preventDefault(); // Prevent page scroll while dragging
      const touch = e.touches[0];
      moveDrag(touch.clientX, touch.clientY);
    };

    const upListener = () => {
      endDrag();
    };

    document.addEventListener('mousemove', moveListener);
    document.addEventListener('mouseup', upListener);
    document.addEventListener('touchmove', touchMoveListener, { passive: false });
    document.addEventListener('touchend', upListener);
    document.addEventListener('touchcancel', upListener);

    // Return listener references for cleanup
    return { move: moveListener, up: upListener, touchMove: touchMoveListener };
  }

  renderSubagentWindowContent(agentId) {
    // Skip if this window has a live terminal (don't overwrite xterm with activity HTML)
    if (this.teammateTerminals.has(agentId)) return;

    const body = document.getElementById(`subagent-window-body-${agentId}`);
    if (!body) return;

    const activity = this.subagentActivity.get(agentId) || [];

    if (activity.length === 0) {
      body.innerHTML = '<div class="subagent-empty">No activity yet</div>';
      return;
    }

    // Incremental rendering: track how many items are already rendered
    const renderedCount = body.dataset.renderedCount ? parseInt(body.dataset.renderedCount, 10) : 0;
    const maxItems = 100;
    const visibleActivity = activity.slice(-maxItems);

    // If activity was trimmed or this is a fresh render, do full rebuild
    if (renderedCount === 0 || renderedCount > visibleActivity.length || body.children.length === 0 ||
        (body.children.length === 1 && body.querySelector('.subagent-empty'))) {
      // Full rebuild
      const html = visibleActivity.map(a => this._renderActivityItem(a)).join('');
      body.innerHTML = html;
      body.dataset.renderedCount = String(visibleActivity.length);
    } else {
      // Incremental: only append new items
      const newItems = visibleActivity.slice(renderedCount);
      if (newItems.length > 0) {
        const newHtml = newItems.map(a => this._renderActivityItem(a)).join('');
        body.insertAdjacentHTML('beforeend', newHtml);
        body.dataset.renderedCount = String(visibleActivity.length);

        // Trim excess children from the front if over maxItems
        while (body.children.length > maxItems) {
          body.removeChild(body.firstChild);
        }
      }
    }

    body.scrollTop = body.scrollHeight;
  }

  _renderActivityItem(a) {
    const time = new Date(a.timestamp).toLocaleTimeString('en-US', { hour12: false });
    if (a.type === 'tool') {
      return `<div class="activity-line">
        <span class="time">${time}</span>
        <span class="tool-icon">${this.getToolIcon(a.tool)}</span>
        <span class="tool-name">${a.tool}</span>
        <span class="tool-detail">${this.escapeHtml(this.getToolDetail(a.tool, a.input))}</span>
      </div>`;
    } else if (a.type === 'tool_result') {
      const icon = a.isError ? '❌' : '📄';
      const statusClass = a.isError ? ' error' : '';
      const sizeInfo = a.contentLength > 500 ? ` (${this.formatBytes(a.contentLength)})` : '';
      const preview = a.preview.length > 60 ? a.preview.substring(0, 60) + '...' : a.preview;
      return `<div class="activity-line result-line${statusClass}">
        <span class="time">${time}</span>
        <span class="tool-icon">${icon}</span>
        <span class="tool-name">${a.tool || '→'}</span>
        <span class="tool-detail">${this.escapeHtml(preview)}${sizeInfo}</span>
      </div>`;
    } else if (a.type === 'progress') {
      const isHook = a.hookEvent || a.hookName;
      const icon = isHook ? '🪝' : (a.progressType === 'query_update' ? '⟳' : '✓');
      const displayText = isHook ? (a.hookName || a.hookEvent) : (a.query || a.progressType);
      return `<div class="activity-line progress-line${isHook ? ' hook-line' : ''}">
        <span class="time">${time}</span>
        <span class="tool-icon">${icon}</span>
        <span class="tool-detail">${this.escapeHtml(displayText)}</span>
      </div>`;
    } else if (a.type === 'message') {
      const preview = a.text.length > 150 ? a.text.substring(0, 150) + '...' : a.text;
      return `<div class="message-line">
        <span class="time">${time}</span> 💬 ${this.escapeHtml(preview)}
      </div>`;
    }
    return '';
  }

  // Update all open subagent windows
  updateSubagentWindows() {
    for (const agentId of this.subagentWindows.keys()) {
      this.renderSubagentWindowContent(agentId);
      this.updateSubagentWindowHeader(agentId);
    }
  }

  // Update subagent window header (title and status)
  updateSubagentWindowHeader(agentId) {
    const agent = this.subagents.get(agentId);
    if (!agent) return;

    const win = document.getElementById(`subagent-window-${agentId}`);
    if (!win) return;

    // Update title/id element with description if available
    const idEl = win.querySelector('.subagent-window-title .id');
    if (idEl) {
      const teammateInfo = this.getTeammateInfo(agent);
      const windowTitle = teammateInfo ? teammateInfo.name : (agent.description || agentId.substring(0, 7));
      const truncatedTitle = windowTitle.length > 50 ? windowTitle.substring(0, 50) + '...' : windowTitle;
      idEl.textContent = truncatedTitle;
    }

    // Add or update teammate badge
    let tmBadge = win.querySelector('.teammate-badge');
    const teammateInfo = this.getTeammateInfo(agent);
    if (teammateInfo && !tmBadge) {
      const titleContainer = win.querySelector('.subagent-window-title');
      if (titleContainer) {
        const badge = document.createElement('span');
        badge.className = `teammate-badge teammate-color-${teammateInfo.color}`;
        badge.title = `Team: ${teammateInfo.teamName}`;
        badge.textContent = `@${teammateInfo.name}`;
        const statusEl = titleContainer.querySelector('.status');
        if (statusEl) statusEl.insertAdjacentElement('beforebegin', badge);
      }
    }

    // Update full tooltip
    const titleContainer = win.querySelector('.subagent-window-title');
    if (titleContainer) {
      titleContainer.title = agent.description || agentId;
    }

    // Update or add model badge
    let modelBadge = win.querySelector('.subagent-window-title .subagent-model-badge');
    if (agent.modelShort) {
      if (!modelBadge) {
        modelBadge = document.createElement('span');
        modelBadge.className = `subagent-model-badge ${agent.modelShort}`;
        const statusEl = win.querySelector('.subagent-window-title .status');
        if (statusEl) {
          statusEl.insertAdjacentElement('beforebegin', modelBadge);
        }
      }
      modelBadge.className = `subagent-model-badge ${agent.modelShort}`;
      modelBadge.textContent = agent.modelShort;
    }

    // Update status
    const statusEl = win.querySelector('.subagent-window-title .status');
    if (statusEl) {
      statusEl.className = `status ${agent.status}`;
      statusEl.textContent = agent.status;
    }
  }

  // Open windows for all active subagents
  openAllActiveSubagentWindows() {
    for (const [agentId, agent] of this.subagents) {
      if (agent.status === 'active' && !this.subagentWindows.has(agentId)) {
        this.openSubagentWindow(agentId);
      }
    }
  }

  // ========== Agent Teams ==========

  /** Initialize an xterm.js terminal for a teammate's tmux pane */
  initTeammateTerminal(agentId, paneInfo, windowElement) {
    const body = windowElement.querySelector('.subagent-window-body');
    if (!body) return;

    // Clear the activity log content
    body.innerHTML = '';
    body.classList.add('teammate-terminal-body');
    windowElement.classList.add('has-terminal');

    const sessionId = paneInfo.sessionId;

    // Buffer incoming terminal data until xterm is ready
    const pendingData = [];
    this.teammateTerminals.set(agentId, {
      terminal: null,
      fitAddon: null,
      paneTarget: paneInfo.paneTarget,
      sessionId,
      resizeObserver: null,
      pendingData,
    });

    // Defer terminal creation to next frame so the body element has computed dimensions
    requestAnimationFrame(() => {
      // Safety: if window was closed before we got here, bail out
      if (!document.contains(body)) {
        this.teammateTerminals.delete(agentId);
        return;
      }

      const terminal = new Terminal({
        theme: {
          background: '#0d0d0d',
          foreground: '#e0e0e0',
          cursor: '#e0e0e0',
          cursorAccent: '#0d0d0d',
          selection: 'rgba(255, 255, 255, 0.3)',
          black: '#0d0d0d',
          red: '#ff6b6b',
          green: '#51cf66',
          yellow: '#ffd43b',
          blue: '#339af0',
          magenta: '#cc5de8',
          cyan: '#22b8cf',
          white: '#e0e0e0',
          brightBlack: '#495057',
          brightRed: '#ff8787',
          brightGreen: '#69db7c',
          brightYellow: '#ffe066',
          brightBlue: '#5c7cfa',
          brightMagenta: '#da77f2',
          brightCyan: '#66d9e8',
          brightWhite: '#ffffff',
        },
        fontFamily: '"Fira Code", "Cascadia Code", "JetBrains Mono", "SF Mono", Monaco, monospace',
        fontSize: 12,
        lineHeight: 1.2,
        cursorBlink: true,
        cursorStyle: 'block',
        scrollback: 5000,
        allowTransparency: true,
      });

      const fitAddon = new FitAddon.FitAddon();
      terminal.loadAddon(fitAddon);

      try {
        terminal.open(body);
      } catch (err) {
        console.warn('[TeammateTerminal] Failed to open terminal:', err);
        this.teammateTerminals.delete(agentId);
        return;
      }

      // Wait for terminal renderer to fully initialize before any writes.
      // xterm.js needs a few frames after open() before write() is safe.
      setTimeout(() => {
        try { fitAddon.fit(); } catch {}

        // Fetch initial pane buffer
        fetch(`/api/sessions/${sessionId}/teammate-pane-buffer/${encodeURIComponent(paneInfo.paneTarget)}`)
          .then(r => r.json())
          .then(resp => {
            if (resp.success && resp.data?.buffer) {
              try { terminal.write(resp.data.buffer); } catch {}
            }
          })
          .catch(err => console.error('[TeammateTerminal] Failed to fetch buffer:', err));

        // Flush any data that arrived while terminal was initializing
        for (const chunk of pendingData) {
          try { terminal.write(chunk); } catch {}
        }
        pendingData.length = 0;
      }, 100);

      // Forward keyboard input to the teammate's pane
      terminal.onData((data) => {
        fetch(`/api/sessions/${sessionId}/teammate-pane-input`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ paneTarget: paneInfo.paneTarget, input: data }),
        }).catch(err => console.error('[TeammateTerminal] Failed to send input:', err));
      });

      // Resize observer to refit terminal when window is resized
      const resizeObserver = new ResizeObserver(() => {
        requestAnimationFrame(() => { try { fitAddon.fit(); } catch {} });
      });
      resizeObserver.observe(body);

      // Update the stored entry with the real terminal
      const entry = this.teammateTerminals.get(agentId);
      if (entry) {
        entry.terminal = terminal;
        entry.fitAddon = fitAddon;
        entry.resizeObserver = resizeObserver;
      }
    });
  }

  /** Open a standalone terminal window for a tmux-pane teammate (no subagent entry needed) */
  openTeammateTerminalWindow(paneData) {
    // Only open if the session has a tab in Claudeman
    if (!this.sessions.has(paneData.sessionId)) return;

    // Use pane target as the unique ID for this window
    const windowId = `pane-${paneData.paneTarget}`;

    // If window already exists, focus it
    if (this.subagentWindows.has(windowId)) {
      const existing = this.subagentWindows.get(windowId);
      if (existing.hidden) {
        existing.element.style.display = 'flex';
        existing.hidden = false;
      }
      existing.element.style.zIndex = ++this.subagentWindowZIndex;
      if (existing.minimized) {
        this.restoreSubagentWindow(windowId);
      }
      return;
    }

    // Calculate position
    const windowCount = this.subagentWindows.size;
    const windowWidth = 550;
    const windowHeight = 400;
    const gap = 20;
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const startX = 50;
    const startY = 120;
    const maxCols = Math.floor((viewportWidth - startX - 50) / (windowWidth + gap)) || 1;
    const maxRows = Math.floor((viewportHeight - startY - 50) / (windowHeight + gap)) || 1;
    const col = windowCount % maxCols;
    const row = Math.floor(windowCount / maxCols) % maxRows;
    let finalX = startX + col * (windowWidth + gap);
    let finalY = startY + row * (windowHeight + gap);
    finalX = Math.max(10, Math.min(finalX, viewportWidth - windowWidth - 10));
    finalY = Math.max(10, Math.min(finalY, viewportHeight - windowHeight - 10));

    // Color badge
    const colorClass = paneData.color || 'blue';

    // Create window element
    const win = document.createElement('div');
    win.className = 'subagent-window has-terminal';
    win.id = `subagent-window-${windowId}`;
    win.style.zIndex = ++this.subagentWindowZIndex;
    win.style.left = `${finalX}px`;
    win.style.top = `${finalY}px`;
    win.style.width = `${windowWidth}px`;
    win.style.height = `${windowHeight}px`;
    win.innerHTML = `
      <div class="subagent-window-header">
        <div class="subagent-window-title" title="Teammate terminal: ${this.escapeHtml(paneData.teammateName)} (pane ${paneData.paneTarget})">
          <span class="icon" style="color: var(--team-color-${colorClass}, #339af0)">⬤</span>
          <span class="id">${this.escapeHtml(paneData.teammateName)}</span>
          <span class="status running">terminal</span>
        </div>
        <div class="subagent-window-actions">
          <button onclick="app.closeSubagentWindow('${windowId}')" title="Minimize to tab">─</button>
        </div>
      </div>
      <div class="subagent-window-body teammate-terminal-body" id="subagent-window-body-${windowId}">
      </div>
    `;

    document.body.appendChild(win);

    // Make draggable
    const dragListeners = this.makeWindowDraggable(win, win.querySelector('.subagent-window-header'));

    // Make resizable if method exists
    if (typeof this.makeWindowResizable === 'function') {
      this.makeWindowResizable(win);
    }

    // Check visibility based on active session
    const settings = this.loadAppSettingsFromStorage();
    const activeTabOnly = settings.subagentActiveTabOnly ?? true;
    const shouldHide = activeTabOnly && paneData.sessionId !== this.activeSessionId;

    // Store reference
    this.subagentWindows.set(windowId, {
      element: win,
      minimized: false,
      hidden: shouldHide,
      dragListeners,
      description: `Teammate: ${paneData.teammateName}`,
    });

    // Also add to subagentParentMap for tab-based visibility
    this.subagentParentMap.set(windowId, paneData.sessionId);

    if (shouldHide) {
      win.style.display = 'none';
    }

    // Focus on click
    win.addEventListener('mousedown', () => {
      win.style.zIndex = ++this.subagentWindowZIndex;
    });

    // Resize observer for connection lines
    const resizeObserver = new ResizeObserver(() => {
      this.updateConnectionLines();
    });
    resizeObserver.observe(win);
    this.subagentWindows.get(windowId).resizeObserver = resizeObserver;

    // Init the xterm.js terminal
    this.initTeammateTerminal(windowId, paneData, win);

    // Animate in
    requestAnimationFrame(() => {
      win.style.transition = 'transform 0.3s ease, opacity 0.3s ease';
      win.style.transform = 'scale(1)';
      win.style.opacity = '1';
    });
  }

  /** Rebuild the teammate lookup map from all team configs */
  rebuildTeammateMap() {
    this.teammateMap.clear();
    for (const [teamName, team] of this.teams) {
      for (const member of team.members) {
        if (member.agentType !== 'team-lead') {
          // Use name as key prefix for matching subagent descriptions
          this.teammateMap.set(member.name, {
            name: member.name,
            color: member.color || 'blue',
            teamName,
            agentId: member.agentId,
          });
        }
      }
    }
  }

  /** Check if a subagent is a teammate and return its info */
  getTeammateInfo(agent) {
    if (!agent?.description) return null;
    // Teammate descriptions start with <teammate-message teammate_id=
    const match = agent.description.match(/<teammate-message\s+teammate_id="?([^">\s]+)/);
    if (!match) return null;
    const teammateId = match[1];
    // Extract name from teammate_id (format: name@teamName)
    const name = teammateId.split('@')[0];
    return this.teammateMap.get(name) || { name, color: 'blue', teamName: 'unknown' };
  }

  /** Get teammate badge HTML for a subagent */
  getTeammateBadgeHtml(agent) {
    const info = this.getTeammateInfo(agent);
    if (!info) return '';
    return `<span class="teammate-badge teammate-color-${info.color}" title="Team: ${this.escapeHtml(info.teamName)}">@${this.escapeHtml(info.name)}</span>`;
  }

  /** Render the team tasks panel */
  renderTeamTasksPanel() {
    const panel = document.getElementById('teamTasksPanel');
    if (!panel) return;

    // Find team for active session
    let activeTeam = null;
    let activeTeamName = null;
    if (this.activeSessionId) {
      for (const [name, team] of this.teams) {
        if (team.leadSessionId === this.activeSessionId) {
          activeTeam = team;
          activeTeamName = name;
          break;
        }
      }
    }

    if (!activeTeam) {
      panel.style.display = 'none';
      return;
    }

    // Set initial position and make draggable on first show
    const wasHidden = panel.style.display === 'none';
    panel.style.display = 'flex';

    if (wasHidden && !this.teamTasksDragListeners) {
      // Position bottom-right
      const panelWidth = 360;
      const panelHeight = 300;
      panel.style.left = `${Math.max(10, window.innerWidth - panelWidth - 20)}px`;
      panel.style.top = `${Math.max(10, window.innerHeight - panelHeight - 70)}px`;
      // Make draggable
      const header = panel.querySelector('.team-tasks-header');
      if (header) {
        this.teamTasksDragListeners = this.makeWindowDraggable(panel, header);
      }
    }

    const tasks = this.teamTasks.get(activeTeamName) || [];
    const completed = tasks.filter(t => t.status === 'completed').length;
    const total = tasks.length;
    const pct = total > 0 ? Math.round((completed / total) * 100) : 0;

    const headerEl = panel.querySelector('.team-tasks-header-text');
    if (headerEl) {
      const teammateCount = activeTeam.members.filter(m => m.agentType !== 'team-lead').length;
      headerEl.textContent = `Team Tasks (${teammateCount} teammates)`;
    }

    const progressEl = panel.querySelector('.team-tasks-progress-fill');
    if (progressEl) {
      progressEl.style.width = `${pct}%`;
    }

    const progressText = panel.querySelector('.team-tasks-progress-text');
    if (progressText) {
      progressText.textContent = `${completed}/${total}`;
    }

    const listEl = panel.querySelector('.team-tasks-list');
    if (!listEl) return;

    if (tasks.length === 0) {
      listEl.innerHTML = '<div class="team-task-empty">No tasks yet</div>';
      return;
    }

    const html = tasks.map(task => {
      const statusIcon = task.status === 'completed' ? '✓' : task.status === 'in_progress' ? '◉' : '○';
      const statusClass = task.status.replace('_', '-');
      const ownerBadge = task.owner
        ? `<span class="team-task-owner teammate-color-${this.getTeammateColor(task.owner)}">${this.escapeHtml(task.owner)}</span>`
        : '';
      return `<div class="team-task-item ${statusClass}">
        <span class="team-task-status">${statusIcon}</span>
        <span class="team-task-subject">${this.escapeHtml(task.subject)}</span>
        ${ownerBadge}
      </div>`;
    }).join('');

    listEl.innerHTML = html;
  }

  /** Hide team tasks panel and clean up drag listeners */
  hideTeamTasksPanel() {
    const panel = document.getElementById('teamTasksPanel');
    if (panel) panel.style.display = 'none';
    if (this.teamTasksDragListeners) {
      document.removeEventListener('mousemove', this.teamTasksDragListeners.move);
      document.removeEventListener('mouseup', this.teamTasksDragListeners.up);
      if (this.teamTasksDragListeners.touchMove) {
        document.removeEventListener('touchmove', this.teamTasksDragListeners.touchMove);
        document.removeEventListener('touchend', this.teamTasksDragListeners.up);
        document.removeEventListener('touchcancel', this.teamTasksDragListeners.up);
      }
      this.teamTasksDragListeners = null;
    }
  }

  /** Get teammate color by name */
  getTeammateColor(name) {
    const info = this.teammateMap.get(name);
    return info?.color || 'blue';
  }

  // ========== Project Insights Panel (Bash Tools with Clickable File Paths) ==========

  /**
   * Normalize a file path to its canonical form for comparison.
   * - Expands ~ to home directory approximation
   * - Resolves relative paths against working directory (case folder)
   * - Normalizes . and .. components
   */
  normalizeFilePath(path, workingDir) {
    if (!path) return '';

    let normalized = path.trim();
    const homeDir = '/home/' + (window.USER || 'user'); // Approximation

    // Expand ~ to home directory
    if (normalized.startsWith('~/')) {
      normalized = homeDir + normalized.slice(1);
    } else if (normalized === '~') {
      normalized = homeDir;
    }

    // If not absolute, resolve against working directory (case folder)
    if (!normalized.startsWith('/') && workingDir) {
      normalized = workingDir + '/' + normalized;
    }

    // Normalize path components (resolve . and ..)
    const parts = normalized.split('/');
    const stack = [];

    for (const part of parts) {
      if (part === '' || part === '.') {
        continue;
      } else if (part === '..') {
        if (stack.length > 1) {
          stack.pop();
        }
      } else {
        stack.push(part);
      }
    }

    return '/' + stack.join('/');
  }

  /**
   * Extract just the filename from a path.
   */
  getFilename(path) {
    const parts = path.split('/');
    return parts[parts.length - 1] || '';
  }

  /**
   * Check if a path is a "shallow root path" - an absolute path with only one
   * component after root (e.g., /test.txt, /file.log).
   * These are often typos where the user meant a relative path in the case folder.
   */
  isShallowRootPath(path) {
    if (!path.startsWith('/')) return false;
    const parts = path.split('/').filter(p => p !== '');
    return parts.length === 1;
  }

  /**
   * Check if a path is inside (or is) the working directory (case folder).
   */
  isPathInWorkingDir(path, workingDir) {
    if (!workingDir) return false;
    const normalized = this.normalizeFilePath(path, workingDir);
    return normalized.startsWith(workingDir + '/') || normalized === workingDir;
  }

  /**
   * Smart path equivalence check.
   * Two paths are considered equivalent if:
   * 1. They normalize to the same path (standard case)
   * 2. One is a "shallow root path" (e.g., /test.txt) and the other is the
   *    same filename inside the case folder - the shallow root path
   *    is likely a typo and they probably meant the same file.
   */
  pathsAreEquivalent(path1, path2, workingDir) {
    const norm1 = this.normalizeFilePath(path1, workingDir);
    const norm2 = this.normalizeFilePath(path2, workingDir);

    // Standard check: exact normalized match
    if (norm1 === norm2) return true;

    // Smart check: shallow root path vs case folder path with same filename
    const file1 = this.getFilename(norm1);
    const file2 = this.getFilename(norm2);

    if (file1 !== file2) return false; // Different filenames, can't be equivalent

    const shallow1 = this.isShallowRootPath(path1);
    const shallow2 = this.isShallowRootPath(path2);
    const inWorkDir1 = this.isPathInWorkingDir(norm1, workingDir);
    const inWorkDir2 = this.isPathInWorkingDir(norm2, workingDir);

    // If one is shallow root (e.g., /test.txt) and other is in case folder
    // with same filename, treat as equivalent (user likely made a typo)
    if (shallow1 && inWorkDir2) return true;
    if (shallow2 && inWorkDir1) return true;

    return false;
  }

  /**
   * Pick the "better" of two paths that resolve to the same file.
   * Prefers paths inside the case folder, longer/more explicit paths, and absolute paths.
   */
  pickBetterPath(path1, path2, workingDir) {
    // Prefer paths inside the case folder (working directory)
    if (workingDir) {
      const inWorkDir1 = this.isPathInWorkingDir(path1, workingDir);
      const inWorkDir2 = this.isPathInWorkingDir(path2, workingDir);
      if (inWorkDir1 && !inWorkDir2) return path1;
      if (inWorkDir2 && !inWorkDir1) return path2;
    }

    // Prefer absolute paths
    const abs1 = path1.startsWith('/');
    const abs2 = path2.startsWith('/');
    if (abs1 && !abs2) return path1;
    if (abs2 && !abs1) return path2;

    // Both absolute or both relative - prefer longer (more explicit)
    if (path1.length !== path2.length) {
      return path1.length > path2.length ? path1 : path2;
    }

    // Prefer paths without ~
    if (!path1.includes('~') && path2.includes('~')) return path1;
    if (!path2.includes('~') && path1.includes('~')) return path2;

    return path1;
  }

  /**
   * Deduplicate file paths across all tools, keeping the "best" version.
   * Uses smart equivalence checking:
   * - Standard normalization for relative vs absolute paths
   * - Detects likely typos (e.g., /file.txt when caseFolder/file.txt exists)
   * - Prefers paths inside the case folder (working directory)
   * - Prefers longer, more explicit paths
   * Returns a Map of normalized path -> best raw path.
   */
  deduplicateProjectInsightPaths(tools, workingDir) {
    // Collect all paths with their tool IDs
    const allPaths = [];
    for (const tool of tools) {
      for (const rawPath of tool.filePaths) {
        allPaths.push({ rawPath, toolId: tool.id });
      }
    }

    if (allPaths.length <= 1) {
      const pathMap = new Map();
      for (const p of allPaths) {
        pathMap.set(this.normalizeFilePath(p.rawPath, workingDir), p);
      }
      return pathMap;
    }

    // Sort paths: prefer paths in case folder first, then by length (longer first)
    allPaths.sort((a, b) => {
      const aInWorkDir = this.isPathInWorkingDir(a.rawPath, workingDir);
      const bInWorkDir = this.isPathInWorkingDir(b.rawPath, workingDir);
      if (aInWorkDir && !bInWorkDir) return -1;
      if (bInWorkDir && !aInWorkDir) return 1;
      return b.rawPath.length - a.rawPath.length; // Longer paths first
    });

    const result = new Map(); // normalized -> { rawPath, toolId }
    const seenNormalized = new Set();

    for (const { rawPath, toolId } of allPaths) {
      const normalized = this.normalizeFilePath(rawPath, workingDir);

      // Check if we've already seen an equivalent path
      let isDuplicate = false;
      for (const [, existing] of result) {
        if (this.pathsAreEquivalent(rawPath, existing.rawPath, workingDir)) {
          isDuplicate = true;
          break;
        }
      }

      if (!isDuplicate && !seenNormalized.has(normalized)) {
        result.set(normalized, { rawPath, toolId });
        seenNormalized.add(normalized);
      }
    }

    return result;
  }

  handleBashToolStart(sessionId, tool) {
    let tools = this.projectInsights.get(sessionId) || [];
    // Add new tool
    tools = tools.filter(t => t.id !== tool.id);
    tools.push(tool);
    this.projectInsights.set(sessionId, tools);
    this.renderProjectInsightsPanel();
  }

  handleBashToolEnd(sessionId, tool) {
    const tools = this.projectInsights.get(sessionId) || [];
    const existing = tools.find(t => t.id === tool.id);
    if (existing) {
      existing.status = 'completed';
    }
    this.renderProjectInsightsPanel();
    // Remove after a short delay
    setTimeout(() => {
      const current = this.projectInsights.get(sessionId) || [];
      this.projectInsights.set(sessionId, current.filter(t => t.id !== tool.id));
      this.renderProjectInsightsPanel();
    }, 2000);
  }

  handleBashToolsUpdate(sessionId, tools) {
    this.projectInsights.set(sessionId, tools);
    this.renderProjectInsightsPanel();
  }

  renderProjectInsightsPanel() {
    const panel = this.$('projectInsightsPanel');
    const list = this.$('projectInsightsList');
    if (!panel || !list) return;

    // Check if panel is enabled in settings
    const settings = this.loadAppSettingsFromStorage();
    const showProjectInsights = settings.showProjectInsights ?? false;
    if (!showProjectInsights) {
      panel.classList.remove('visible');
      this.projectInsightsPanelVisible = false;
      return;
    }

    // Get tools for active session only
    const tools = this.projectInsights.get(this.activeSessionId) || [];
    const runningTools = tools.filter(t => t.status === 'running');

    if (runningTools.length === 0) {
      panel.classList.remove('visible');
      this.projectInsightsPanelVisible = false;
      return;
    }

    panel.classList.add('visible');
    this.projectInsightsPanelVisible = true;

    // Get working directory for path normalization
    const session = this.sessions.get(this.activeSessionId);
    const workingDir = session?.workingDir || this.currentSessionWorkingDir;

    // Smart deduplication: collect all unique paths across all tools
    // Paths that resolve to the same file are deduplicated, keeping the most complete version
    const deduplicatedPaths = this.deduplicateProjectInsightPaths(runningTools, workingDir);

    // Build a set of paths to show (only the best version of each unique file)
    const pathsToShow = new Set(Array.from(deduplicatedPaths.values()).map(p => p.rawPath));

    const html = [];
    for (const tool of runningTools) {
      // Filter this tool's paths to only include those that weren't deduplicated away
      const filteredPaths = tool.filePaths.filter(p => pathsToShow.has(p));

      // Skip tools with no paths to show (all were duplicates of better paths elsewhere)
      if (filteredPaths.length === 0) continue;

      const cmdDisplay = tool.command.length > 50
        ? tool.command.substring(0, 50) + '...'
        : tool.command;

      html.push(`
        <div class="project-insight-item" data-tool-id="${tool.id}">
          <div class="project-insight-command">
            <span class="icon">💻</span>
            <span class="cmd" title="${this.escapeHtml(tool.command)}">${this.escapeHtml(cmdDisplay)}</span>
            <span class="project-insight-status ${tool.status}">${tool.status}</span>
            ${tool.timeout ? `<span class="project-insight-timeout">${this.escapeHtml(tool.timeout)}</span>` : ''}
          </div>
          <div class="project-insight-paths">
      `);

      for (const path of filteredPaths) {
        const fileName = path.split('/').pop();
        html.push(`
            <span class="project-insight-filepath"
                  onclick="app.openLogViewerWindow('${this.escapeHtml(path)}', '${tool.sessionId}')"
                  title="${this.escapeHtml(path)}">${this.escapeHtml(fileName)}</span>
        `);
      }

      html.push(`
          </div>
        </div>
      `);
    }

    list.innerHTML = html.join('');
  }

  closeProjectInsightsPanel() {
    const panel = this.$('projectInsightsPanel');
    if (panel) {
      panel.classList.remove('visible');
      this.projectInsightsPanelVisible = false;
    }
  }

  // ========== File Browser Panel ==========

  // File tree data and state
  fileBrowserData = null;
  fileBrowserExpandedDirs = new Set();
  fileBrowserFilter = '';
  fileBrowserAllExpanded = false;
  filePreviewContent = '';

  async loadFileBrowser(sessionId) {
    if (!sessionId) return;

    const treeEl = this.$('fileBrowserTree');
    const statusEl = this.$('fileBrowserStatus');
    if (!treeEl) return;

    // Show loading state
    treeEl.innerHTML = '<div class="file-browser-loading">Loading files...</div>';

    try {
      const res = await fetch(`/api/sessions/${sessionId}/files?depth=5&showHidden=false`);
      if (!res.ok) throw new Error('Failed to load files');

      const result = await res.json();
      if (!result.success) throw new Error(result.error || 'Failed to load files');

      this.fileBrowserData = result.data;
      this.renderFileBrowserTree();

      // Update status
      if (statusEl) {
        const { totalFiles, totalDirectories, truncated } = result.data;
        statusEl.textContent = `${totalFiles} files, ${totalDirectories} dirs${truncated ? ' (truncated)' : ''}`;
      }
    } catch (err) {
      console.error('Failed to load file browser:', err);
      treeEl.innerHTML = `<div class="file-browser-empty">Failed to load files: ${err.message}</div>`;
    }
  }

  renderFileBrowserTree() {
    const treeEl = this.$('fileBrowserTree');
    if (!treeEl || !this.fileBrowserData) return;

    const { tree } = this.fileBrowserData;
    if (!tree || tree.length === 0) {
      treeEl.innerHTML = '<div class="file-browser-empty">No files found</div>';
      return;
    }

    const html = [];
    const filter = this.fileBrowserFilter.toLowerCase();

    const renderNode = (node, depth) => {
      const isDir = node.type === 'directory';
      const isExpanded = this.fileBrowserExpandedDirs.has(node.path);
      const matchesFilter = !filter || node.name.toLowerCase().includes(filter);

      // For directories, check if any children match
      let hasMatchingChildren = false;
      if (isDir && filter && node.children) {
        hasMatchingChildren = this.hasMatchingChild(node, filter);
      }

      const shouldShow = matchesFilter || hasMatchingChildren;
      const hiddenClass = !shouldShow && filter ? ' hidden-by-filter' : '';

      const icon = isDir
        ? (isExpanded ? '\uD83D\uDCC2' : '\uD83D\uDCC1')
        : this.getFileIcon(node.extension);

      const expandIcon = isDir
        ? `<span class="file-tree-expand${isExpanded ? ' expanded' : ''}">\u25B6</span>`
        : '<span class="file-tree-expand"></span>';

      const sizeStr = !isDir && node.size !== undefined
        ? `<span class="file-tree-size">${this.formatFileSize(node.size)}</span>`
        : '';

      const nameClass = isDir ? 'file-tree-name directory' : 'file-tree-name';

      html.push(`
        <div class="file-tree-item${hiddenClass}" data-path="${this.escapeHtml(node.path)}" data-type="${node.type}" data-depth="${depth}">
          ${expandIcon}
          <span class="file-tree-icon">${icon}</span>
          <span class="${nameClass}">${this.escapeHtml(node.name)}</span>
          ${sizeStr}
        </div>
      `);

      // Render children if directory is expanded
      if (isDir && isExpanded && node.children) {
        for (const child of node.children) {
          renderNode(child, depth + 1);
        }
      }
    };

    for (const node of tree) {
      renderNode(node, 0);
    }

    treeEl.innerHTML = html.join('');

    // Add click handlers
    treeEl.querySelectorAll('.file-tree-item').forEach(item => {
      item.addEventListener('click', () => {
        const path = item.dataset.path;
        const type = item.dataset.type;

        if (type === 'directory') {
          this.toggleFileBrowserFolder(path);
        } else {
          this.openFilePreview(path);
        }
      });
    });
  }

  hasMatchingChild(node, filter) {
    if (!node.children) return false;
    for (const child of node.children) {
      if (child.name.toLowerCase().includes(filter)) return true;
      if (child.type === 'directory' && this.hasMatchingChild(child, filter)) return true;
    }
    return false;
  }

  toggleFileBrowserFolder(path) {
    if (this.fileBrowserExpandedDirs.has(path)) {
      this.fileBrowserExpandedDirs.delete(path);
    } else {
      this.fileBrowserExpandedDirs.add(path);
    }
    this.renderFileBrowserTree();
  }

  filterFileBrowser(value) {
    this.fileBrowserFilter = value;
    // Auto-expand all if filtering
    if (value) {
      this.expandAllDirectories(this.fileBrowserData?.tree || []);
    }
    this.renderFileBrowserTree();
  }

  expandAllDirectories(nodes) {
    for (const node of nodes) {
      if (node.type === 'directory') {
        this.fileBrowserExpandedDirs.add(node.path);
        if (node.children) {
          this.expandAllDirectories(node.children);
        }
      }
    }
  }

  collapseAllDirectories() {
    this.fileBrowserExpandedDirs.clear();
  }

  toggleFileBrowserExpand() {
    this.fileBrowserAllExpanded = !this.fileBrowserAllExpanded;
    const btn = this.$('fileBrowserExpandBtn');

    if (this.fileBrowserAllExpanded) {
      this.expandAllDirectories(this.fileBrowserData?.tree || []);
      if (btn) btn.innerHTML = '\u229F'; // Collapse icon
    } else {
      this.collapseAllDirectories();
      if (btn) btn.innerHTML = '\u229E'; // Expand icon
    }
    this.renderFileBrowserTree();
  }

  refreshFileBrowser() {
    if (this.activeSessionId) {
      this.fileBrowserExpandedDirs.clear();
      this.fileBrowserFilter = '';
      this.fileBrowserAllExpanded = false;
      const searchInput = this.$('fileBrowserSearch');
      if (searchInput) searchInput.value = '';
      this.loadFileBrowser(this.activeSessionId);
    }
  }

  closeFileBrowserPanel() {
    const panel = this.$('fileBrowserPanel');
    if (panel) {
      panel.classList.remove('visible');
    }
    // Save setting
    const settings = this.loadAppSettingsFromStorage();
    settings.showFileBrowser = false;
    this.saveAppSettingsToStorage(settings);
  }

  async openFilePreview(filePath) {
    if (!this.activeSessionId || !filePath) return;

    const overlay = this.$('filePreviewOverlay');
    const titleEl = this.$('filePreviewTitle');
    const bodyEl = this.$('filePreviewBody');
    const footerEl = this.$('filePreviewFooter');

    if (!overlay || !bodyEl) return;

    // Show overlay with loading state
    overlay.classList.add('visible');
    titleEl.textContent = filePath;
    bodyEl.innerHTML = '<div class="binary-message">Loading...</div>';
    footerEl.textContent = '';

    try {
      const res = await fetch(`/api/sessions/${this.activeSessionId}/file-content?path=${encodeURIComponent(filePath)}&lines=500`);
      if (!res.ok) throw new Error('Failed to load file');

      const result = await res.json();
      if (!result.success) throw new Error(result.error || 'Failed to load file');

      const data = result.data;

      if (data.type === 'image') {
        bodyEl.innerHTML = `<img src="${data.url}" alt="${this.escapeHtml(filePath)}">`;
        footerEl.textContent = `${this.formatFileSize(data.size)} \u2022 ${data.extension}`;
      } else if (data.type === 'video') {
        bodyEl.innerHTML = `<video src="${data.url}" controls autoplay></video>`;
        footerEl.textContent = `${this.formatFileSize(data.size)} \u2022 ${data.extension}`;
      } else if (data.type === 'binary') {
        bodyEl.innerHTML = `<div class="binary-message">Binary file (${this.formatFileSize(data.size)})<br>Cannot preview</div>`;
        footerEl.textContent = data.extension || 'binary';
      } else {
        // Text content
        this.filePreviewContent = data.content;
        bodyEl.innerHTML = `<pre><code>${this.escapeHtml(data.content)}</code></pre>`;
        const truncNote = data.truncated ? ` (showing 500/${data.totalLines} lines)` : '';
        footerEl.textContent = `${data.totalLines} lines \u2022 ${this.formatFileSize(data.size)}${truncNote}`;
      }
    } catch (err) {
      console.error('Failed to preview file:', err);
      bodyEl.innerHTML = `<div class="binary-message">Error: ${err.message}</div>`;
    }
  }

  closeFilePreview() {
    const overlay = this.$('filePreviewOverlay');
    if (overlay) {
      overlay.classList.remove('visible');
    }
    this.filePreviewContent = '';
  }

  copyFilePreviewContent() {
    if (this.filePreviewContent) {
      navigator.clipboard.writeText(this.filePreviewContent).then(() => {
        this.showToast('Copied to clipboard', 'success');
      }).catch(() => {
        this.showToast('Failed to copy', 'error');
      });
    }
  }

  getFileIcon(ext) {
    if (!ext) return '\uD83D\uDCC4'; // Default file

    const icons = {
      // TypeScript/JavaScript
      'ts': '\uD83D\uDCD8', 'tsx': '\uD83D\uDCD8', 'js': '\uD83D\uDCD2', 'jsx': '\uD83D\uDCD2',
      'mjs': '\uD83D\uDCD2', 'cjs': '\uD83D\uDCD2',
      // Python
      'py': '\uD83D\uDC0D', 'pyx': '\uD83D\uDC0D', 'pyw': '\uD83D\uDC0D',
      // Rust/Go/C
      'rs': '\uD83E\uDD80', 'go': '\uD83D\uDC39', 'c': '\u2699\uFE0F', 'cpp': '\u2699\uFE0F',
      'h': '\u2699\uFE0F', 'hpp': '\u2699\uFE0F',
      // Web
      'html': '\uD83C\uDF10', 'htm': '\uD83C\uDF10', 'css': '\uD83C\uDFA8', 'scss': '\uD83C\uDFA8',
      'sass': '\uD83C\uDFA8', 'less': '\uD83C\uDFA8',
      // Data
      'json': '\uD83D\uDCCB', 'yaml': '\uD83D\uDCCB', 'yml': '\uD83D\uDCCB', 'xml': '\uD83D\uDCCB',
      'toml': '\uD83D\uDCCB', 'csv': '\uD83D\uDCCB',
      // Docs
      'md': '\uD83D\uDCDD', 'markdown': '\uD83D\uDCDD', 'txt': '\uD83D\uDCDD', 'rst': '\uD83D\uDCDD',
      // Images
      'png': '\uD83D\uDDBC\uFE0F', 'jpg': '\uD83D\uDDBC\uFE0F', 'jpeg': '\uD83D\uDDBC\uFE0F',
      'gif': '\uD83D\uDDBC\uFE0F', 'svg': '\uD83D\uDDBC\uFE0F', 'webp': '\uD83D\uDDBC\uFE0F',
      'ico': '\uD83D\uDDBC\uFE0F', 'bmp': '\uD83D\uDDBC\uFE0F',
      // Video/Audio
      'mp4': '\uD83C\uDFAC', 'webm': '\uD83C\uDFAC', 'mov': '\uD83C\uDFAC',
      'mp3': '\uD83C\uDFB5', 'wav': '\uD83C\uDFB5', 'ogg': '\uD83C\uDFB5',
      // Config/Shell
      'sh': '\uD83D\uDCBB', 'bash': '\uD83D\uDCBB', 'zsh': '\uD83D\uDCBB',
      'env': '\uD83D\uDD10', 'gitignore': '\uD83D\uDEAB', 'dockerfile': '\uD83D\uDC33',
      // Lock files
      'lock': '\uD83D\uDD12',
    };

    return icons[ext.toLowerCase()] || '\uD83D\uDCC4';
  }

  formatFileSize(bytes) {
    if (bytes === undefined || bytes === null) return '';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  }

  // ========== Log Viewer Windows (Floating File Streamers) ==========

  openLogViewerWindow(filePath, sessionId) {
    sessionId = sessionId || this.activeSessionId;
    if (!sessionId) return;

    // Create unique window ID
    const windowId = `${sessionId}-${filePath.replace(/[^a-zA-Z0-9]/g, '_')}`;

    // If window already exists, focus it
    if (this.logViewerWindows.has(windowId)) {
      const existing = this.logViewerWindows.get(windowId);
      existing.element.style.zIndex = ++this.logViewerWindowZIndex;
      return;
    }

    // Calculate position (cascade from top-left)
    const windowCount = this.logViewerWindows.size;
    const offsetX = 100 + (windowCount % 5) * 30;
    const offsetY = 100 + (windowCount % 5) * 30;

    // Get filename for title
    const fileName = filePath.split('/').pop();

    // Create window element
    const win = document.createElement('div');
    win.className = 'log-viewer-window';
    win.id = `log-viewer-window-${windowId}`;
    win.style.left = `${offsetX}px`;
    win.style.top = `${offsetY}px`;
    win.style.zIndex = ++this.logViewerWindowZIndex;

    win.innerHTML = `
      <div class="log-viewer-window-header">
        <div class="log-viewer-window-title" title="${this.escapeHtml(filePath)}">
          <span class="icon">📄</span>
          <span class="filename">${this.escapeHtml(fileName)}</span>
          <span class="status streaming">streaming</span>
        </div>
        <div class="log-viewer-window-actions">
          <button onclick="app.closeLogViewerWindow('${windowId}')" title="Close">×</button>
        </div>
      </div>
      <div class="log-viewer-window-body" id="log-viewer-body-${windowId}">
        <div class="log-info">Connecting to ${this.escapeHtml(filePath)}...</div>
      </div>
    `;

    document.body.appendChild(win);

    // Make draggable (returns listener refs for cleanup)
    const dragListeners = this.makeWindowDraggable(win, win.querySelector('.log-viewer-window-header'));

    // Connect to SSE stream
    const eventSource = new EventSource(
      `/api/sessions/${sessionId}/tail-file?path=${encodeURIComponent(filePath)}&lines=50`
    );

    eventSource.onmessage = (e) => {
      const data = JSON.parse(e.data);
      const body = document.getElementById(`log-viewer-body-${windowId}`);
      if (!body) return;

      switch (data.type) {
        case 'connected':
          body.innerHTML = '';
          break;
        case 'data':
          // Append data, auto-scroll
          const wasAtBottom = body.scrollTop + body.clientHeight >= body.scrollHeight - 10;
          const content = this.escapeHtml(data.content);
          body.innerHTML += content;
          if (wasAtBottom) {
            body.scrollTop = body.scrollHeight;
          }
          // Trim if too large
          if (body.innerHTML.length > 500000) {
            body.innerHTML = body.innerHTML.slice(-400000);
          }
          break;
        case 'end':
          this.updateLogViewerStatus(windowId, 'disconnected', 'ended');
          break;
        case 'error':
          body.innerHTML += `<div class="log-error">${this.escapeHtml(data.error)}</div>`;
          this.updateLogViewerStatus(windowId, 'error', 'error');
          break;
      }
    };

    eventSource.onerror = () => {
      this.updateLogViewerStatus(windowId, 'disconnected', 'connection error');
    };

    // Store reference (including drag listeners for cleanup)
    this.logViewerWindows.set(windowId, {
      element: win,
      eventSource,
      filePath,
      sessionId,
      dragListeners, // Store for cleanup to prevent memory leaks
    });
  }

  updateLogViewerStatus(windowId, statusClass, statusText) {
    const statusEl = document.querySelector(`#log-viewer-window-${windowId} .status`);
    if (statusEl) {
      statusEl.className = `status ${statusClass}`;
      statusEl.textContent = statusText;
    }
  }

  closeLogViewerWindow(windowId) {
    const windowData = this.logViewerWindows.get(windowId);
    if (!windowData) return;

    // Close SSE connection
    if (windowData.eventSource) {
      windowData.eventSource.close();
    }

    // Clean up global drag event listeners (prevents memory leak)
    if (windowData.dragListeners) {
      document.removeEventListener('mousemove', windowData.dragListeners.move);
      document.removeEventListener('mouseup', windowData.dragListeners.up);
    }

    // Remove element
    windowData.element.remove();

    // Remove from map
    this.logViewerWindows.delete(windowId);
  }

  // Close all log viewer windows for a session
  closeSessionLogViewerWindows(sessionId) {
    const toClose = [];
    for (const [windowId, data] of this.logViewerWindows) {
      if (data.sessionId === sessionId) {
        toClose.push(windowId);
      }
    }
    for (const windowId of toClose) {
      this.closeLogViewerWindow(windowId);
    }
  }

  // ========== Image Popup Windows (Auto-popup for Screenshots) ==========

  /**
   * Open a popup window to display a detected image.
   * Called automatically when image:detected SSE event is received.
   */
  openImagePopup(imageEvent) {
    const { sessionId, filePath, relativePath, fileName, timestamp, size } = imageEvent;

    // Create unique window ID
    const imageId = `${sessionId}-${timestamp}`;

    // If window already exists for this image, focus it
    if (this.imagePopups.has(imageId)) {
      const existing = this.imagePopups.get(imageId);
      existing.element.style.zIndex = ++this.imagePopupZIndex;
      return;
    }

    // Cap open popups at 20 — close oldest when at limit
    const MAX_IMAGE_POPUPS = 20;
    if (this.imagePopups.size >= MAX_IMAGE_POPUPS) {
      // Map iteration order is insertion order, so first key is oldest
      const oldestId = this.imagePopups.keys().next().value;
      if (oldestId) this.closeImagePopup(oldestId);
    }

    // Calculate position (cascade from center, with offset for multiple popups)
    const windowCount = this.imagePopups.size;
    const centerX = (window.innerWidth - 600) / 2;
    const centerY = (window.innerHeight - 500) / 2;
    const offsetX = centerX + (windowCount % 5) * 30;
    const offsetY = centerY + (windowCount % 5) * 30;

    // Get session name for display
    const session = this.sessions.get(sessionId);
    const sessionName = session?.name || sessionId.substring(0, 8);

    // Format file size
    const sizeKB = (size / 1024).toFixed(1);

    // Build image URL using the existing file-raw endpoint
    // Use relativePath (path from working dir) instead of fileName (basename) for subdirectory images
    const imageUrl = `/api/sessions/${sessionId}/file-raw?path=${encodeURIComponent(relativePath || fileName)}`;

    // Create window element
    const win = document.createElement('div');
    win.className = 'image-popup-window';
    win.id = `image-popup-${imageId}`;
    win.style.left = `${offsetX}px`;
    win.style.top = `${offsetY}px`;
    win.style.zIndex = ++this.imagePopupZIndex;

    win.innerHTML = `
      <div class="image-popup-header">
        <div class="image-popup-title" title="${this.escapeHtml(filePath)}">
          <span class="icon">🖼️</span>
          <span class="filename">${this.escapeHtml(fileName)}</span>
          <span class="session-badge">${this.escapeHtml(sessionName)}</span>
          <span class="size-badge">${sizeKB} KB</span>
        </div>
        <div class="image-popup-actions">
          <button onclick="app.openImageInNewTab('${imageUrl}')" title="Open in new tab">↗</button>
          <button onclick="app.closeImagePopup('${imageId}')" title="Close">×</button>
        </div>
      </div>
      <div class="image-popup-body">
        <img src="${imageUrl}" alt="${this.escapeHtml(fileName)}"
             onerror="this.parentElement.innerHTML='<div class=\\'image-error\\'>Failed to load image</div>'"
             onclick="app.openImageInNewTab('${imageUrl}')" />
      </div>
    `;

    document.body.appendChild(win);

    // Make draggable
    const dragListeners = this.makeWindowDraggable(win, win.querySelector('.image-popup-header'));

    // Focus on click
    win.addEventListener('mousedown', () => {
      win.style.zIndex = ++this.imagePopupZIndex;
    });

    // Store reference
    this.imagePopups.set(imageId, {
      element: win,
      sessionId,
      filePath,
      dragListeners,
    });
  }

  /**
   * Close an image popup window.
   */
  closeImagePopup(imageId) {
    const popupData = this.imagePopups.get(imageId);
    if (!popupData) return;

    // Clean up global drag event listeners
    if (popupData.dragListeners) {
      document.removeEventListener('mousemove', popupData.dragListeners.move);
      document.removeEventListener('mouseup', popupData.dragListeners.up);
    }

    // Remove element
    popupData.element.remove();

    // Remove from map
    this.imagePopups.delete(imageId);
  }

  /**
   * Open image in a new browser tab.
   */
  openImageInNewTab(url) {
    window.open(url, '_blank');
  }

  /**
   * Close all image popups for a session.
   */
  closeSessionImagePopups(sessionId) {
    const toClose = [];
    for (const [imageId, data] of this.imagePopups) {
      if (data.sessionId === sessionId) {
        toClose.push(imageId);
      }
    }
    for (const imageId of toClose) {
      this.closeImagePopup(imageId);
    }
  }

  // ========== Mux Sessions (in Monitor Panel) ==========

  async loadScreens() {
    try {
      const res = await fetch('/api/screens');
      const data = await res.json();
      this.screenSessions = data.screens || [];
      this.renderScreenSessions();
    } catch (err) {
      console.error('Failed to load screens:', err);
    }
  }

  killAllSessions() {
    const count = this.screenSessions?.length || 0;
    if (count === 0) {
      alert('No sessions to kill');
      return;
    }

    // Show the kill all modal
    document.getElementById('killAllCount').textContent = count;
    const modal = document.getElementById('killAllModal');
    modal.classList.add('active');

    // Activate focus trap
    this.activeFocusTrap = new FocusTrap(modal);
    this.activeFocusTrap.activate();
  }

  closeKillAllModal() {
    document.getElementById('killAllModal').classList.remove('active');

    // Deactivate focus trap and restore focus
    if (this.activeFocusTrap) {
      this.activeFocusTrap.deactivate();
      this.activeFocusTrap = null;
    }
  }

  async confirmKillAll(killScreens) {
    this.closeKillAllModal();

    try {
      if (killScreens) {
        // Kill everything including tmux sessions
        const res = await fetch('/api/sessions', { method: 'DELETE' });
        const data = await res.json();
        if (data.success) {
          this.sessions.clear();
          this.screenSessions = [];
          this.activeSessionId = null;
          try { localStorage.removeItem('claudeman-active-session'); } catch {}
          this.renderSessionTabs();
          this.renderScreenSessions();
          this.terminal.clear();
          this.terminal.reset();
          this.toast('All sessions and tmux killed', 'success');
        }
      } else {
        // Just remove tabs, keep screens running
        this.sessions.clear();
        this.activeSessionId = null;
        try { localStorage.removeItem('claudeman-active-session'); } catch {}
        this.renderSessionTabs();
        this.terminal.clear();
        this.terminal.reset();
        this.toast('All tabs removed, tmux still running', 'info');
      }
    } catch (err) {
      console.error('Failed to kill sessions:', err);
      this.toast('Failed to kill sessions: ' + err.message, 'error');
    }
  }

  // ========== Case Settings ==========

  toggleCaseSettings() {
    const popover = document.getElementById('caseSettingsPopover');
    if (popover.classList.contains('hidden')) {
      // Load settings for current case
      const caseName = document.getElementById('quickStartCase').value || 'testcase';
      const settings = this.getCaseSettings(caseName);
      document.getElementById('caseAgentTeams').checked = settings.agentTeams;
      popover.classList.remove('hidden');

      // Close on outside click (one-shot listener)
      const closeHandler = (e) => {
        if (!popover.contains(e.target) && !e.target.classList.contains('btn-case-settings')) {
          popover.classList.add('hidden');
          document.removeEventListener('click', closeHandler);
        }
      };
      // Defer to avoid catching the current click
      setTimeout(() => document.addEventListener('click', closeHandler), 0);
    } else {
      popover.classList.add('hidden');
    }
  }

  getCaseSettings(caseName) {
    try {
      const stored = localStorage.getItem('caseSettings_' + caseName);
      if (stored) return JSON.parse(stored);
    } catch { /* ignore */ }
    return { agentTeams: false };
  }

  saveCaseSettings(caseName, settings) {
    localStorage.setItem('caseSettings_' + caseName, JSON.stringify(settings));
  }

  onCaseSettingChanged() {
    const caseName = document.getElementById('quickStartCase').value || 'testcase';
    const settings = this.getCaseSettings(caseName);
    settings.agentTeams = document.getElementById('caseAgentTeams').checked;
    this.saveCaseSettings(caseName, settings);
    // Sync mobile checkbox
    const mobileCheckbox = document.getElementById('caseAgentTeamsMobile');
    if (mobileCheckbox) mobileCheckbox.checked = settings.agentTeams;
  }

  toggleCaseSettingsMobile() {
    const popover = document.getElementById('caseSettingsPopoverMobile');
    if (popover.classList.contains('hidden')) {
      const caseName = document.getElementById('quickStartCase').value || 'testcase';
      const settings = this.getCaseSettings(caseName);
      document.getElementById('caseAgentTeamsMobile').checked = settings.agentTeams;
      popover.classList.remove('hidden');

      const closeHandler = (e) => {
        if (!popover.contains(e.target) && !e.target.classList.contains('btn-case-settings-mobile')) {
          popover.classList.add('hidden');
          document.removeEventListener('click', closeHandler);
        }
      };
      setTimeout(() => document.addEventListener('click', closeHandler), 0);
    } else {
      popover.classList.add('hidden');
    }
  }

  onCaseSettingChangedMobile() {
    const caseName = document.getElementById('quickStartCase').value || 'testcase';
    const settings = this.getCaseSettings(caseName);
    settings.agentTeams = document.getElementById('caseAgentTeamsMobile').checked;
    this.saveCaseSettings(caseName, settings);
    // Sync desktop checkbox
    const desktopCheckbox = document.getElementById('caseAgentTeams');
    if (desktopCheckbox) desktopCheckbox.checked = settings.agentTeams;
  }

  // ========== Create Case Modal ==========

  showCreateCaseModal() {
    document.getElementById('newCaseName').value = '';
    document.getElementById('newCaseDescription').value = '';
    document.getElementById('linkCaseName').value = '';
    document.getElementById('linkCasePath').value = '';
    // Reset to first tab
    this.caseModalTab = 'case-create';
    this.switchCaseModalTab('case-create');
    // Wire up tab buttons
    const modal = document.getElementById('createCaseModal');
    modal.querySelectorAll('.modal-tabs .modal-tab-btn').forEach(btn => {
      btn.onclick = () => this.switchCaseModalTab(btn.dataset.tab);
    });
    modal.classList.add('active');
    document.getElementById('newCaseName').focus();
  }

  switchCaseModalTab(tabName) {
    this.caseModalTab = tabName;
    const modal = document.getElementById('createCaseModal');
    // Toggle active class on tab buttons
    modal.querySelectorAll('.modal-tabs .modal-tab-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.tab === tabName);
    });
    // Toggle hidden class on tab content
    modal.querySelectorAll('.modal-tab-content').forEach(content => {
      content.classList.toggle('hidden', content.id !== tabName);
    });
    // Update submit button text
    const submitBtn = document.getElementById('caseModalSubmit');
    submitBtn.textContent = tabName === 'case-create' ? 'Create' : 'Link';
    // Focus appropriate input
    if (tabName === 'case-create') {
      document.getElementById('newCaseName').focus();
    } else {
      document.getElementById('linkCaseName').focus();
    }
  }

  closeCreateCaseModal() {
    document.getElementById('createCaseModal').classList.remove('active');
  }

  async submitCaseModal() {
    if (this.caseModalTab === 'case-create') {
      await this.createCase();
    } else {
      await this.linkCase();
    }
  }

  async createCase() {
    const name = document.getElementById('newCaseName').value.trim();
    const description = document.getElementById('newCaseDescription').value.trim();

    if (!name) {
      this.showToast('Please enter a case name', 'error');
      return;
    }

    if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
      this.showToast('Invalid name. Use only letters, numbers, hyphens, underscores.', 'error');
      return;
    }

    try {
      const res = await fetch('/api/cases', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, description })
      });

      const data = await res.json();
      if (data.success) {
        this.closeCreateCaseModal();
        this.showToast(`Case "${name}" created`, 'success');
        // Reload cases and select the new one
        await this.loadQuickStartCases(name);
        // Save as last used case
        await this.saveLastUsedCase(name);
      } else {
        this.showToast(data.error || 'Failed to create case', 'error');
      }
    } catch (err) {
      console.error('Failed to create case:', err);
      this.showToast('Failed to create case: ' + err.message, 'error');
    }
  }

  async linkCase() {
    const name = document.getElementById('linkCaseName').value.trim();
    const path = document.getElementById('linkCasePath').value.trim();

    if (!name) {
      this.showToast('Please enter a case name', 'error');
      return;
    }

    if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
      this.showToast('Invalid name. Use only letters, numbers, hyphens, underscores.', 'error');
      return;
    }

    if (!path) {
      this.showToast('Please enter a folder path', 'error');
      return;
    }

    try {
      const res = await fetch('/api/cases/link', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, path })
      });

      const data = await res.json();
      if (data.success) {
        this.closeCreateCaseModal();
        this.showToast(`Case "${name}" linked to ${path}`, 'success');
        // Reload cases and select the new one
        await this.loadQuickStartCases(name);
        // Save as last used case
        await this.saveLastUsedCase(name);
      } else {
        this.showToast(data.error || 'Failed to link case', 'error');
      }
    } catch (err) {
      console.error('Failed to link case:', err);
      this.showToast('Failed to link case: ' + err.message, 'error');
    }
  }

  // ============================================================================
  // Mobile Case Picker
  // ============================================================================

  showMobileCasePicker() {
    const modal = document.getElementById('mobileCasePickerModal');
    const listContainer = document.getElementById('mobileCaseList');
    const select = document.getElementById('quickStartCase');
    const currentCase = select.value;

    // Build case list HTML
    let html = '';
    const cases = this.cases || [];

    // Add testcase if not in list
    const hasTestcase = cases.some(c => c.name === 'testcase');
    const allCases = hasTestcase ? cases : [{ name: 'testcase' }, ...cases];

    for (const c of allCases) {
      const isSelected = c.name === currentCase;
      html += `
        <button class="mobile-case-item ${isSelected ? 'selected' : ''}"
                onclick="app.selectMobileCase('${this.escapeHtml(c.name)}')">
          <span class="mobile-case-item-icon">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
            </svg>
          </span>
          <span class="mobile-case-item-name">${this.escapeHtml(c.name)}</span>
          <span class="mobile-case-item-check">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
              <polyline points="20 6 9 17 4 12"/>
            </svg>
          </span>
        </button>
      `;
    }

    listContainer.innerHTML = html;
    modal.classList.add('active');
  }

  closeMobileCasePicker() {
    document.getElementById('mobileCasePickerModal').classList.remove('active');
  }

  selectMobileCase(caseName) {
    // Update the desktop select (source of truth)
    const select = document.getElementById('quickStartCase');
    select.value = caseName;

    // Update mobile button label
    this.updateMobileCaseLabel(caseName);

    // Update directory display
    this.updateDirDisplayForCase(caseName);

    // Save as last used
    this.saveLastUsedCase(caseName);

    // Close the picker
    this.closeMobileCasePicker();

    this.showToast(`Selected: ${caseName}`, 'success');
  }

  updateMobileCaseLabel(caseName) {
    const label = document.getElementById('mobileCaseName');
    if (label) {
      // Let CSS handle truncation via text-overflow: ellipsis
      label.textContent = caseName;
    }
  }

  showCreateCaseFromMobile() {
    // Close mobile picker first
    this.closeMobileCasePicker();
    // Open the create case modal
    this.showCreateCaseModal();
  }

  renderScreenSessions() {
    // Debounce renders at 100ms to prevent excessive DOM updates
    if (this.renderScreenSessionsTimeout) {
      clearTimeout(this.renderScreenSessionsTimeout);
    }
    this.renderScreenSessionsTimeout = setTimeout(() => {
      this._renderScreenSessionsImmediate();
    }, 100);
  }

  _renderScreenSessionsImmediate() {
    const body = document.getElementById('screenSessionsBody');

    if (!this.screenSessions || this.screenSessions.length === 0) {
      body.innerHTML = '<div class="monitor-empty">No mux sessions</div>';
      return;
    }

    let html = '';
    for (const screen of this.screenSessions) {
      const stats = screen.stats || { memoryMB: 0, cpuPercent: 0, childCount: 0 };
      const modeClass = screen.mode === 'shell' ? 'shell' : '';

      html += `
        <div class="process-item">
          <span class="process-mode ${modeClass}">${screen.mode}</span>
          <div class="process-info">
            <div class="process-name">${this.escapeHtml(screen.name || screen.screenName)}</div>
            <div class="process-meta">
              <span class="process-stat memory">${stats.memoryMB}MB</span>
              <span class="process-stat cpu">${stats.cpuPercent}%</span>
              <span class="process-stat children">${stats.childCount} children</span>
              <span>PID: ${screen.pid}</span>
            </div>
          </div>
          <div class="process-actions">
            <button class="btn-toolbar btn-sm btn-danger" onclick="app.killScreen('${screen.sessionId}')" title="Kill tmux session">Kill</button>
          </div>
        </div>
      `;
    }

    body.innerHTML = html;
  }

  renderMonitorSubagents() {
    const body = document.getElementById('monitorSubagentsBody');
    const stats = document.getElementById('monitorSubagentStats');
    if (!body) return;

    const subagents = Array.from(this.subagents.values());
    const activeCount = subagents.filter(s => s.status === 'active' || s.status === 'idle').length;

    if (stats) {
      stats.textContent = `${subagents.length} tracked` + (activeCount > 0 ? `, ${activeCount} active` : '');
    }

    if (subagents.length === 0) {
      body.innerHTML = '<div class="monitor-empty">No background agents</div>';
      return;
    }

    let html = '';
    for (const agent of subagents) {
      const statusClass = agent.status === 'active' ? 'active' : agent.status === 'idle' ? 'idle' : 'completed';
      const modelBadge = agent.modelShort ? `<span class="model-badge ${agent.modelShort}">${agent.modelShort}</span>` : '';
      const desc = agent.description ? this.escapeHtml(agent.description.substring(0, 40)) : agent.agentId;

      html += `
        <div class="process-item">
          <span class="process-mode ${statusClass}">${agent.status}</span>
          <div class="process-info">
            <div class="process-name">${modelBadge} ${desc}</div>
            <div class="process-meta">
              <span>ID: ${agent.agentId}</span>
              <span>${agent.toolCallCount || 0} tools</span>
            </div>
          </div>
          <div class="process-actions">
            ${agent.status !== 'completed' ? `<button class="btn-toolbar btn-sm btn-danger" onclick="app.killSubagent('${agent.agentId}')" title="Kill agent">Kill</button>` : ''}
          </div>
        </div>
      `;
    }

    body.innerHTML = html;
  }

  async killScreen(sessionId) {
    if (!confirm('Kill this mux session?')) return;

    try {
      await fetch(`/api/screens/${sessionId}`, { method: 'DELETE' });
      this.screenSessions = this.screenSessions.filter(s => s.sessionId !== sessionId);
      this.renderScreenSessions();
      this.showToast('Tmux session killed', 'success');
    } catch (err) {
      this.showToast('Failed to kill tmux session', 'error');
    }
  }

  async reconcileScreens() {
    try {
      const res = await fetch('/api/screens/reconcile', { method: 'POST' });
      const data = await res.json();

      if (data.dead && data.dead.length > 0) {
        this.showToast(`Found ${data.dead.length} dead screen(s)`, 'warning');
        await this.loadScreens();
      } else {
        this.showToast('All screens are alive', 'success');
      }
    } catch (err) {
      this.showToast('Failed to reconcile screens', 'error');
    }
  }

  // ========== Plan Wizard Agents in Monitor ==========

  renderMonitorPlanAgents() {
    const section = document.getElementById('monitorPlanAgentsSection');
    const body = document.getElementById('monitorPlanAgentsBody');
    const stats = document.getElementById('monitorPlanAgentStats');
    if (!section || !body) return;

    const planAgents = Array.from(this.planSubagents?.values() || []);
    const hasActiveOrchestrator = !!this.activePlanOrchestratorId;

    // Show section only if there are plan agents or active orchestrator
    if (planAgents.length === 0 && !hasActiveOrchestrator) {
      section.style.display = 'none';
      return;
    }

    section.style.display = '';

    const activeCount = planAgents.filter(a => a.status === 'running').length;
    const completedCount = planAgents.filter(a => a.status === 'completed' || a.status === 'failed').length;

    if (stats) {
      if (hasActiveOrchestrator) {
        stats.textContent = `${activeCount} running, ${completedCount} done`;
      } else {
        stats.textContent = `${planAgents.length} total`;
      }
    }

    if (planAgents.length === 0) {
      body.innerHTML = `<div class="monitor-empty">${hasActiveOrchestrator ? 'Plan generation starting...' : 'No plan agents'}</div>`;
      return;
    }

    let html = '';
    for (const agent of planAgents) {
      const statusClass = agent.status === 'running' ? 'active' : agent.status === 'completed' ? 'completed' : 'error';
      const agentLabel = agent.agentType || agent.agentId;
      const modelBadge = agent.model ? `<span class="model-badge opus">opus</span>` : '';
      const detail = agent.detail ? this.escapeHtml(agent.detail.substring(0, 50)) : '';
      const duration = agent.durationMs ? `${(agent.durationMs / 1000).toFixed(1)}s` : '';
      const itemCount = agent.itemCount ? `${agent.itemCount} items` : '';

      html += `
        <div class="process-item">
          <span class="process-mode ${statusClass}">${agent.status || 'pending'}</span>
          <div class="process-info">
            <div class="process-name">${modelBadge} ${this.escapeHtml(agentLabel)}</div>
            <div class="process-meta">
              ${detail ? `<span>${detail}</span>` : ''}
              ${itemCount ? `<span>${itemCount}</span>` : ''}
              ${duration ? `<span>${duration}</span>` : ''}
            </div>
          </div>
        </div>
      `;
    }

    body.innerHTML = html;
  }

  async cancelPlanFromMonitor() {
    if (!this.activePlanOrchestratorId && this.planSubagents?.size === 0) {
      this.showToast('No active plan generation', 'info');
      return;
    }

    if (!confirm('Cancel plan generation and close all plan agent windows?')) return;

    // Cancel the plan generation (reuse existing method)
    await this.cancelPlanGeneration();

    // Also force close the wizard if it's open
    const wizardModal = document.getElementById('ralphWizardModal');
    if (wizardModal?.classList.contains('active')) {
      this.closeRalphWizard();
    }

    // Update monitor display
    this.renderMonitorPlanAgents();
    this.showToast('Plan generation cancelled', 'success');
  }

  // ========== Toast ==========

  // Cached toast container for performance
  _toastContainer = null;

  toggleNotifications() {
    this.notificationManager?.toggleDrawer();
  }

  // Alias for showToast
  toast(message, type = 'info') {
    return this.showToast(message, type);
  }

  showToast(message, type = 'info') {
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.textContent = message;

    // Cache toast container reference
    if (!this._toastContainer) {
      this._toastContainer = document.querySelector('.toast-container');
      if (!this._toastContainer) {
        this._toastContainer = document.createElement('div');
        this._toastContainer.className = 'toast-container';
        document.body.appendChild(this._toastContainer);
      }
    }
    this._toastContainer.appendChild(toast);

    requestAnimationFrame(() => toast.classList.add('show'));

    setTimeout(() => {
      toast.classList.remove('show');
      setTimeout(() => toast.remove(), 200);
    }, 3000);
  }

  // ========== System Stats ==========

  startSystemStatsPolling() {
    // Clear any existing interval to prevent duplicates
    this.stopSystemStatsPolling();

    // Initial fetch
    this.fetchSystemStats();

    // Poll every 2 seconds
    this.systemStatsInterval = setInterval(() => {
      this.fetchSystemStats();
    }, 2000);
  }

  stopSystemStatsPolling() {
    if (this.systemStatsInterval) {
      clearInterval(this.systemStatsInterval);
      this.systemStatsInterval = null;
    }
  }

  async fetchSystemStats() {
    // Skip polling when system stats display is hidden
    const statsEl = document.getElementById('headerSystemStats');
    if (!statsEl || statsEl.style.display === 'none') return;

    try {
      const res = await fetch('/api/system/stats');
      const stats = await res.json();
      this.updateSystemStatsDisplay(stats);
    } catch (err) {
      // Silently fail - system stats are not critical
    }
  }

  updateSystemStatsDisplay(stats) {
    const cpuEl = this.$('statCpu');
    const cpuBar = this.$('statCpuBar');
    const memEl = this.$('statMem');
    const memBar = this.$('statMemBar');

    if (cpuEl && cpuBar) {
      cpuEl.textContent = `${stats.cpu}%`;
      cpuBar.style.width = `${Math.min(100, stats.cpu)}%`;

      // Color classes based on usage
      cpuBar.classList.remove('medium', 'high');
      cpuEl.classList.remove('high');
      if (stats.cpu > 80) {
        cpuBar.classList.add('high');
        cpuEl.classList.add('high');
      } else if (stats.cpu > 50) {
        cpuBar.classList.add('medium');
      }
    }

    if (memEl && memBar) {
      const memGB = (stats.memory.usedMB / 1024).toFixed(1);
      memEl.textContent = `${memGB}G`;
      memBar.style.width = `${Math.min(100, stats.memory.percent)}%`;

      // Color classes based on usage
      memBar.classList.remove('medium', 'high');
      memEl.classList.remove('high');
      if (stats.memory.percent > 80) {
        memBar.classList.add('high');
        memEl.classList.add('high');
      } else if (stats.memory.percent > 50) {
        memBar.classList.add('medium');
      }
    }
  }

  // ========== Utility ==========

  // Pre-compiled HTML escape map for performance (avoids DOM element creation)
  static _htmlEscapeMap = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  };
  static _htmlEscapePattern = /[&<>"']/g;

  escapeHtml(text) {
    if (!text) return '';
    return text.replace(ClaudemanApp._htmlEscapePattern, char => ClaudemanApp._htmlEscapeMap[char]);
  }
}

// Initialize
const app = new ClaudemanApp();

// Expose for debugging/testing
window.app = app;
window.MobileDetection = MobileDetection;
