/**
 * @fileoverview Mobile device support: detection, keyboard handling, and swipe navigation.
 *
 * Defines three singleton objects that manage mobile-specific behavior:
 *
 * - MobileDetection — Device type detection (mobile/tablet/desktop), touch capability,
 *   iOS/Safari identification, and body class management for CSS targeting.
 * - KeyboardHandler — Virtual keyboard show/hide detection via visualViewport API,
 *   toolbar/accessory bar repositioning, terminal resize on keyboard open/close,
 *   and input scroll-into-view. Uses 100px threshold for iOS address bar drift.
 * - SwipeHandler — Horizontal swipe detection on the terminal area for session switching.
 *   80px minimum distance, 300ms maximum time, 100px max vertical drift.
 *
 * All three have init()/cleanup() lifecycle methods. They are re-initialized after SSE
 * reconnect (in handleInit) to prevent stale closures.
 *
 * @globals {object} MobileDetection
 * @globals {object} KeyboardHandler
 * @globals {object} SwipeHandler
 *
 * @dependency keyboard-accessory.js (KeyboardAccessoryBar reference in KeyboardHandler.onKeyboardShow, soft — guarded with typeof check)
 * @loadorder 2 of 9 — loaded after constants.js, before voice-input.js
 */

// Codeman — Mobile detection, keyboard handling, and swipe navigation
// Loaded after constants.js, before app.js

// ═══════════════════════════════════════════════════════════════
// Mobile Detection
// ═══════════════════════════════════════════════════════════════

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

  /** Check if screen is small (phone-sized, <=430px) */
  isSmallScreen() {
    return window.innerWidth <= 430;
  },

  /** Check if screen is medium (tablet-sized, 431-768px) */
  isMediumScreen() {
    return window.innerWidth > 430 && window.innerWidth < 768;
  },

  /** Get device type based on screen width */
  getDeviceType() {
    const width = window.innerWidth;
    if (width <= 430) return 'mobile';
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
    this._resizeHandler = () => {
      clearTimeout(resizeTimeout);
      resizeTimeout = setTimeout(() => this.updateBodyClass(), 100);
    };
    window.addEventListener('resize', this._resizeHandler);

    // iOS: prevent pinch-to-zoom (Safari ignores user-scalable=no since iOS 10)
    if (this.isIOS()) {
      this._gestureStartHandler = (e) => e.preventDefault();
      this._gestureChangeHandler = (e) => e.preventDefault();
      document.addEventListener('gesturestart', this._gestureStartHandler);
      document.addEventListener('gesturechange', this._gestureChangeHandler);
    }
  },

  /** Remove event listeners */
  cleanup() {
    if (this._resizeHandler) {
      window.removeEventListener('resize', this._resizeHandler);
      this._resizeHandler = null;
    }
    if (this._gestureStartHandler) {
      document.removeEventListener('gesturestart', this._gestureStartHandler);
      document.removeEventListener('gesturechange', this._gestureChangeHandler);
      this._gestureStartHandler = null;
      this._gestureChangeHandler = null;
    }
  }
};

// ═══════════════════════════════════════════════════════════════
// Mobile Keyboard Handler
// ═══════════════════════════════════════════════════════════════

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

    // --- Keyboard SHOW detection (two signals, either triggers) ---

    // Signal 1: focusin on typeable element
    this._focusinHandler = (e) => {
      const target = e.target;
      if (!this.keyboardVisible) {
        const isTypeable = target &&
          (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' ||
           target.isContentEditable || target.closest('.xterm'));
        if (isTypeable) {
          this._showKeyboard();
        }
      }
      if (!this.isInputElement(target)) return;
      setTimeout(() => this.scrollInputIntoView(target), 400);
    };
    document.addEventListener('focusin', this._focusinHandler);

    // Signal 2: visualViewport resize (catches keyboard open when textarea
    // already had focus — focusin doesn't fire in that case)
    if (window.visualViewport) {
      this._viewportResizeHandler = () => {
        const currentHeight = window.visualViewport.height;
        const heightDiff = this.initialViewportHeight - currentHeight;
        if (heightDiff > 150 && !this.keyboardVisible) {
          this._showKeyboard();
        }
        // HIDE detection: viewport growing back means keyboard is closing.
        // iOS dismiss button hides keyboard without blurring focus, so
        // focusout never fires. Detect hide when viewport returns close
        // to initial height. 50px threshold avoids false triggers from
        // iOS address bar or predictive text fluctuations.
        if (this.keyboardVisible && heightDiff < 50) {
          this._hideKeyboard();
        }
        // Update app size when keyboard is visible (tracks animation)
        if (this.keyboardVisible) {
          this._resizeAppForKeyboard();
        }
        // Update baseline only when keyboard is not visible
        if (!this.keyboardVisible) {
          this.initialViewportHeight = currentHeight;
        }
      };
      window.visualViewport.addEventListener('resize', this._viewportResizeHandler);
      // Also track scroll — iOS scrolls the visual viewport when keyboard opens
      this._viewportScrollHandler = () => {
        if (this.keyboardVisible) this._resizeAppForKeyboard();
      };
      window.visualViewport.addEventListener('scroll', this._viewportScrollHandler);
    }

    // --- Keyboard HIDE detection (two signals, either triggers) ---

    // Signal 1: focusout — catches blur from tapping outside, switching tabs, etc.
    this._focusoutHandler = () => {
      if (!this.keyboardVisible) return;
      // Wait 500ms for focus to settle — xterm may briefly blur/refocus
      // its textarea during terminal operations
      setTimeout(() => {
        const active = document.activeElement;
        const stillTyping = active &&
          (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' ||
           active.isContentEditable || active.closest('.xterm'));
        if (!stillTyping) {
          this._hideKeyboard();
        }
      }, 500);
    };
    document.addEventListener('focusout', this._focusoutHandler);
    // Signal 2: visualViewport resize growing back — handled in _viewportResizeHandler above.
    // Catches iOS dismiss button which hides keyboard without blurring focus.
  },

  /** Show keyboard state (deduplicated) */
  _showKeyboard() {
    if (this.keyboardVisible) return;
    this.keyboardVisible = true;
    document.body.classList.add('keyboard-visible');
    this.onKeyboardShow();
  },

  /** Hide keyboard state (deduplicated — safe to call from multiple signals) */
  _hideKeyboard() {
    if (!this.keyboardVisible) return;
    this.keyboardVisible = false;
    document.body.classList.remove('keyboard-visible');
    this.onKeyboardHide();
  },

  /** Remove event listeners */
  cleanup() {
    if (this._focusinHandler) {
      document.removeEventListener('focusin', this._focusinHandler);
      this._focusinHandler = null;
    }
    if (this._focusoutHandler) {
      document.removeEventListener('focusout', this._focusoutHandler);
      this._focusoutHandler = null;
    }
    if (this._viewportResizeHandler && window.visualViewport) {
      window.visualViewport.removeEventListener('resize', this._viewportResizeHandler);
      this._viewportResizeHandler = null;
    }
    if (this._viewportScrollHandler && window.visualViewport) {
      window.visualViewport.removeEventListener('scroll', this._viewportScrollHandler);
      this._viewportScrollHandler = null;
    }
  },


  /** Resize the .app container to visual viewport height so the flex layout
   *  (including toolbar) fits above the keyboard without fixed positioning. */
  _resizeAppForKeyboard() {
    if (!window.visualViewport || !this.keyboardVisible) return;
    const appEl = document.querySelector('.app');
    if (!appEl) return;
    const vv = window.visualViewport;
    appEl.style.height = `${vv.height}px`;
    appEl.style.position = 'fixed';
    appEl.style.top = `${vv.offsetTop}px`;
    appEl.style.left = '0';
    appEl.style.right = '0';
  },

  /** Reset layout to normal (no keyboard) */
  resetLayout() {
    const appEl = document.querySelector('.app');
    if (appEl) {
      appEl.style.height = '';
      appEl.style.position = '';
      appEl.style.top = '';
      appEl.style.left = '';
      appEl.style.right = '';
    }
  },

  /** Called when keyboard appears */
  onKeyboardShow() {
    // Show keyboard accessory bar
    if (typeof KeyboardAccessoryBar !== 'undefined') {
      KeyboardAccessoryBar.show();
    }

    // Resize app container to fit within the visual viewport (above keyboard).
    // iOS Safari doesn't reposition fixed-bottom elements above the keyboard
    // until a user scroll, so instead we shrink the entire app to the visible
    // area and switch the toolbar to non-fixed (flex child) positioning.
    this._resizeAppForKeyboard();

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

    // Reposition subagent windows to stack from bottom (above keyboard)
    if (typeof app !== 'undefined') app.relayoutMobileSubagentWindows();
  },

  /** Called when keyboard hides */
  onKeyboardHide() {
    // Reset app layout to CSS defaults
    this.resetLayout();

    // Hide keyboard accessory bar
    if (typeof KeyboardAccessoryBar !== 'undefined') {
      KeyboardAccessoryBar.hide();
    }

    // Refit terminal, scroll to bottom, and send resize to restore original dimensions
    setTimeout(() => {
      if (typeof app !== 'undefined' && app.fitAddon) {
        try { app.fitAddon.fit(); } catch {}
        if (app.terminal) app.terminal.scrollToBottom();
        // Send resize to server to restore full terminal size
        this._sendTerminalResize();
      }
    }, 100);

    // Reposition subagent windows to stack from top (below header)
    if (typeof app !== 'undefined') app.relayoutMobileSubagentWindows();
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
        }).catch(() => {});
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

// ═══════════════════════════════════════════════════════════════
// Mobile Swipe Handler
// ═══════════════════════════════════════════════════════════════

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

  _touchStartHandler: null,
  _touchEndHandler: null,
  _element: null,

  /** Initialize swipe handling */
  init() {
    // Only on touch devices
    if (!MobileDetection.isTouchDevice()) return;

    const terminal = document.querySelector('.main');
    if (!terminal) return;

    this._element = terminal;
    this._touchStartHandler = (e) => this.onTouchStart(e);
    this._touchEndHandler = (e) => this.onTouchEnd(e);
    terminal.addEventListener('touchstart', this._touchStartHandler, { passive: true });
    terminal.addEventListener('touchend', this._touchEndHandler, { passive: true });
  },

  /** Remove swipe listeners */
  cleanup() {
    if (this._element && this._touchStartHandler) {
      this._element.removeEventListener('touchstart', this._touchStartHandler);
      this._element.removeEventListener('touchend', this._touchEndHandler);
    }
    this._touchStartHandler = null;
    this._touchEndHandler = null;
    this._element = null;
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
