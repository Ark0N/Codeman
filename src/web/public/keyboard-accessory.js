// Codeman — Keyboard accessory bar and focus trap for modals
// Loaded after mobile-handlers.js, before app.js

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
      btn.dataset.origHtml = btn.innerHTML;
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
      if (btn && btn.dataset.origHtml) {
        btn.innerHTML = btn.dataset.origHtml;
        delete btn.dataset.origHtml;
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
    }).catch(() => {});
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
