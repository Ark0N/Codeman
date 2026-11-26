/**
 * @fileoverview Chat view: a session's conversation, rendered like the Response Viewer, as the
 * session's main view (docs/chat-view-plan.md, phase 1).
 *
 * The agent keeps running in its tmux pane. The chat view is a second way to look at that pane:
 * it covers the terminal (which stays mounted, attached and sized, so the PTY is never resized
 * by a view switch) and draws the conversation from the session's transcript.
 *
 * - Which sessions can have it: those whose run mode Codeman reads from a Claude-format
 *   transcript (`window.__codemanChatViewModes`, published from the `transcript` capability,
 *   never an id list here), local or Docker, not remote and not adopted, and not on a phone.
 * - Which view a session shows: the per-device choice remembered for that session
 *   (`codeman:chatViewModes` in localStorage), else the per-device setting `chatViewDefault`
 *   (default off, so a session opens in Terminal until the user picks Chat).
 * - The Chat / Terminal switch: shown on an eligible session unless the per-device setting
 *   `showChatViewSwitch` is false (an absent key means shown). Hiding it changes nothing else:
 *   the session keeps its view, and Alt+Shift+C still switches.
 * - Live updates: the conversation is re-read (debounced) on the session's `transcript:update`,
 *   `session:working` and `session:idle`. Nothing is read while the chat view is hidden.
 * - Typing: the chat view has no message box yet, so the user types in the terminal. A focus
 *   that lands on the hidden terminal moves to the conversation, so keys never reach the pane
 *   unseen.
 * - A dialog in the pane (permission, question, plan approval) shows as a notice with a button
 *   that switches to the terminal, where it is answered.
 *
 * Messages are model and user text: they go through the Response Viewer's sanitising markdown
 * pipeline (`_buildResponseViewerMessage`), and everything else is set with `textContent`.
 *
 * @mixin Extends CodemanApp.prototype via Object.assign
 * @dependency app.js (this.activeSessionId, this.sessions, this.pendingHooks, _buildResponseViewerMessage,
 *   _bindResponseViewerInteractions, _getResponseViewerAgentLabel)
 * @dependency constants.js (CodemanChatView)
 * @dependency api-client.js at runtime (this._apiJson)
 * @loadorder 12.595 of 16, after local-model-ui.js, before entrance-animations.js
 */

const CHAT_VIEW_MODES_KEY = 'codeman:chatViewModes';
/** Wait after an update before re-reading, so a burst of events costs one read. */
const CHAT_VIEW_RELOAD_DEBOUNCE_MS = 250;

Object.assign(CodemanApp.prototype, {
  // ─── Eligibility and choice ──────────────────────────────────

  /** Whether `sessionId` can show the chat view on this device. */
  chatViewEligible(sessionId) {
    const session = sessionId ? this.sessions?.get(sessionId) : null;
    if (!session) return false;
    const modes = Array.isArray(window.__codemanChatViewModes) ? window.__codemanChatViewModes : [];
    if (!session.mode || !modes.includes(session.mode)) return false;
    // A remote session's transcript lives on its host, and an adopted one has none Codeman can name.
    if (session.remote || session.adopt) return false;
    // Phones keep the terminal and its keyboard bars (phase 3 lays the chat view out for them),
    // whatever their orientation or fold: a phone turned to landscape is still a phone.
    if (typeof MobileDetection !== 'undefined') {
      const phone = MobileDetection.isHandheldDevice?.() ?? MobileDetection.getDeviceType?.() === 'mobile';
      if (phone) return false;
    }
    return true;
  },

  /** The per-device choice for each session, `{ [sessionId]: 'chat' | 'terminal' }`. */
  _chatViewStoredModes() {
    try {
      const parsed = JSON.parse(localStorage.getItem(CHAT_VIEW_MODES_KEY) || '{}');
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  },

  _chatViewStoreModes(modes) {
    try {
      localStorage.setItem(CHAT_VIEW_MODES_KEY, JSON.stringify(modes));
    } catch {
      // Storage blocked: the choice lasts for this page load only.
    }
  },

  /** 'chat' or 'terminal' for `sessionId`. */
  chatViewModeFor(sessionId) {
    const stored = this._chatViewStoredModes()[sessionId];
    if (stored === 'chat' || stored === 'terminal') return stored;
    if (this._chatViewMemoryModes?.has(sessionId)) return this._chatViewMemoryModes.get(sessionId);
    return this.loadAppSettingsFromStorage?.().chatViewDefault === true ? 'chat' : 'terminal';
  },

  setChatViewMode(sessionId, mode) {
    if (!sessionId || (mode !== 'chat' && mode !== 'terminal')) return;
    if (!this._chatViewMemoryModes) this._chatViewMemoryModes = new Map();
    this._chatViewMemoryModes.set(sessionId, mode);
    const modes = this._chatViewStoredModes();
    modes[sessionId] = mode;
    this._chatViewStoreModes(modes);
    if (sessionId === this.activeSessionId) this._chatViewSync({ focus: true });
  },

  /**
   * Called after each init (app.js) with the server's session list: drop the view choice of every
   * session not in it. A session deleted while no page was open sends this page no event.
   */
  _chatViewPruneModes(liveIds) {
    for (const id of [...(this._chatViewMemoryModes?.keys() ?? [])]) {
      if (!liveIds.has(id)) this._chatViewMemoryModes.delete(id);
    }
    const modes = this._chatViewStoredModes();
    const kept = Object.fromEntries(Object.entries(modes).filter(([id]) => liveIds.has(id)));
    if (Object.keys(kept).length !== Object.keys(modes).length) this._chatViewStoreModes(kept);
  },

  /** Whether this device shows the Chat / Terminal switch. An absent setting means it does. */
  _chatViewSwitchShown() {
    return this.loadAppSettingsFromStorage?.().showChatViewSwitch !== false;
  },

  /** The Alt+Shift+C action: flip the active session between Chat and Terminal. */
  toggleChatView() {
    const id = this.activeSessionId;
    if (!this.chatViewEligible(id) || this._tilesOwnTerminal?.()) return;
    this.setChatViewMode(id, this.chatViewModeFor(id) === 'chat' ? 'terminal' : 'chat');
  },

  /**
   * True when `e` is the chat view toggle chord and it applies here, so the xterm key handler
   * swallows it. Outside a session that can show the chat view, the chord reaches the terminal.
   */
  shouldToggleChatViewFromShortcut(e) {
    if (!e || (!e.ctrlKey && !e.metaKey && !e.altKey)) return false;
    if (!this.chatViewEligible(this.activeSessionId) || this._tilesOwnTerminal?.()) return false;
    if (typeof this.getShortcutRegistry !== 'function' || typeof this.matchesShortcutEvent !== 'function') return false;
    const shortcut = this.getShortcutRegistry().find((s) => s.id === 'toggle-chat-view');
    if (!shortcut || shortcut.disabled) return false;
    return this.matchesShortcutEvent(e, shortcut);
  },

  // ─── DOM ─────────────────────────────────────────────────────

  /**
   * `text` in the page's language. i18n.js translates the DOM as it changes, but it skips every
   * <textarea> and the `data-i18n-skip` conversation, so the strings drawn there are looked up here.
   */
  _chatViewT(text, vars) {
    return window.CodemanI18n?.t?.(text, vars) ?? text;
  },

  _chatViewEnsureDom() {
    if (this._chatView) return this._chatView;
    const wrap = document.querySelector('.terminal-wrap');
    if (!wrap) return null;

    const toggle = document.createElement('div');
    toggle.className = 'chat-view-toggle';
    toggle.setAttribute('role', 'group');
    toggle.setAttribute('aria-label', 'Session view');
    toggle.hidden = true;
    const chatBtn = document.createElement('button');
    chatBtn.type = 'button';
    chatBtn.className = 'chat-view-toggle-btn';
    chatBtn.dataset.mode = 'chat';
    chatBtn.textContent = 'Chat';
    chatBtn.title = 'Show the conversation (Alt+Shift+C)';
    const termBtn = document.createElement('button');
    termBtn.type = 'button';
    termBtn.className = 'chat-view-toggle-btn';
    termBtn.dataset.mode = 'terminal';
    termBtn.textContent = 'Terminal';
    termBtn.title = 'Show the terminal (Alt+Shift+C)';
    toggle.append(chatBtn, termBtn);
    toggle.addEventListener('click', (ev) => {
      const btn = ev.target.closest('.chat-view-toggle-btn');
      if (btn && this.activeSessionId) this.setChatViewMode(this.activeSessionId, btn.dataset.mode);
    });

    const root = document.createElement('section');
    root.className = 'chat-view';
    root.setAttribute('aria-label', 'Conversation');
    root.hidden = true;

    // The Response Viewer's body class: the chat view renders exactly as the viewer does.
    const scroller = document.createElement('div');
    scroller.className = 'chat-view-scroll response-viewer-body';
    scroller.setAttribute('data-i18n-skip', '');
    // Focusable, so a focus taken from the hidden terminal has somewhere to go.
    scroller.tabIndex = -1;
    const thread = document.createElement('div');
    thread.className = 'chat-view-thread';
    const empty = document.createElement('p');
    empty.className = 'chat-view-empty';
    empty.hidden = true;
    scroller.append(thread, empty);

    const dialog = document.createElement('div');
    dialog.className = 'chat-view-dialog';
    dialog.setAttribute('role', 'status');
    dialog.hidden = true;
    const dialogText = document.createElement('span');
    dialogText.className = 'chat-view-dialog-text';
    dialogText.textContent = 'Claude is waiting for your answer in the terminal.';
    const dialogBtn = document.createElement('button');
    dialogBtn.type = 'button';
    dialogBtn.className = 'chat-view-btn chat-view-btn-primary';
    dialogBtn.textContent = 'Open terminal';
    dialogBtn.addEventListener('click', () => {
      const id = this.activeSessionId;
      if (!id) return;
      this.setChatViewMode(id, 'terminal');
      this.terminal?.focus?.();
    });
    dialog.append(dialogText, dialogBtn);

    const status = document.createElement('div');
    status.className = 'chat-view-status';
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    status.hidden = true;
    const statusDot = document.createElement('span');
    statusDot.className = 'chat-view-status-dot';
    statusDot.setAttribute('aria-hidden', 'true');
    const statusBody = document.createElement('div');
    statusBody.className = 'chat-view-status-body';
    const statusText = document.createElement('div');
    statusText.className = 'chat-view-status-text';
    statusBody.append(statusText);
    status.append(statusDot, statusBody);

    // The status line follows the last message, inside the scrolling area, so an eye watching
    // the newest output finds it there and not at the bottom of the window.
    scroller.insertBefore(status, empty);
    root.append(scroller, dialog);
    wrap.append(root, toggle);

    // Keys must never reach the hidden terminal: a focus that lands there (a click-through, a
    // code path that refocuses the terminal after a load) moves to the conversation. That covers
    // #terminalContainer and #cjkInput, which takes terminal.focus() while CJK input is on and
    // sits outside the container, under the chat layer.
    const redirectFocus = () => {
      if (this._chatViewShowing()) this._chatView?.scroller.focus({ preventScroll: true });
    };
    document.getElementById('terminalContainer')?.addEventListener('focusin', redirectFocus);
    document.getElementById('cjkInput')?.addEventListener('focusin', redirectFocus);

    // A file dropped on the conversation or on the Chat / Terminal switch must not make the
    // browser open it and leave Codeman. Nothing is uploaded here: an upload would type the file's
    // path into the hidden pane, and attaching belongs to the message box (docs/chat-view-plan.md,
    // phase 1 step 2). The no-drop cursor tells a user who drags a file here that Chat takes none.
    const refuseDragOver = (ev) => {
      ev.preventDefault();
      if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'none';
    };
    const refuseDrop = (ev) => ev.preventDefault();
    for (const target of [root, toggle]) {
      target.addEventListener('dragover', refuseDragOver);
      target.addEventListener('drop', refuseDrop);
    }

    this._chatView = {
      root,
      toggle,
      chatBtn,
      termBtn,
      scroller,
      thread,
      empty,
      dialog,
      status,
      statusText,
      sessionId: null,
      keys: [],
      reloadTimer: null,
      statusTimer: null,
      loading: false,
      reloadAgain: false,
    };
    return this._chatView;
  },

  /** Whether the chat view is what the main area shows right now. */
  _chatViewShowing() {
    return !!this._chatView && !this._chatView.root.hidden;
  },

  /** Whether keyboard focus sits in the terminal: inside #terminalContainer, or on #cjkInput. */
  _chatViewFocusInTerminal() {
    const active = document.activeElement;
    if (!active) return false;
    if (active.id === 'cjkInput') return true;
    return !!document.getElementById('terminalContainer')?.contains(active);
  },

  // ─── Sync with the active session ────────────────────────────

  /** app.js selectSession(): the active session changed. */
  onChatViewActiveSession() {
    this._chatViewSync({ focus: true });
  },

  /**
   * Show or hide the toggle and the chat view for the active session, and (re)load the
   * conversation when the chat view starts showing a session.
   */
  _chatViewSync(opts = {}) {
    const id = this.activeSessionId;
    const eligible = this.chatViewEligible(id);
    if (!eligible && !this._chatView) return;
    const view = this._chatViewEnsureDom();
    if (!view) return;
    // Focus follows the app's tab-switch rule, as the terminal's does.
    const focus = !!opts.focus && (this._shouldFocusTerminalForTabSwitch?.() ?? true);
    const mode = eligible ? this.chatViewModeFor(id) : 'terminal';
    // The tile grid owns the terminal area while it is open, and its tiles are terminals: the
    // chat view stays hidden, whatever the active session's choice (tile-grid.js syncs it).
    const showChat = eligible && mode === 'chat' && !this._tilesOwnTerminal?.();

    // The setting hides only the switch: the session keeps its view, and Alt+Shift+C still works.
    view.toggle.hidden = !eligible || !this._chatViewSwitchShown();
    view.chatBtn.setAttribute('aria-pressed', String(showChat));
    view.termBtn.setAttribute('aria-pressed', String(!showChat));
    view.toggle.classList.toggle('chat-view-toggle--over-chat', showChat);

    const wasShowing = !view.root.hidden;
    const previousId = view.sessionId;
    view.root.hidden = !showChat;
    document.querySelector('.terminal-wrap')?.classList.toggle('chat-view-active', showChat);
    // styles.css hides the keyboard accessory bar while this is set: its keys write into the pane.
    document.body.classList.toggle('chat-view-showing', showChat);
    if (!showChat) {
      if (view.statusTimer) {
        clearInterval(view.statusTimer);
        view.statusTimer = null;
      }
      if (wasShowing && focus && eligible) this.terminal?.focus?.();
      return;
    }

    if (previousId !== id) {
      view.sessionId = id;
      view.keys = [];
      view.thread.replaceChildren();
      view.empty.hidden = true;
    }
    const agent = this._getResponseViewerAgentLabel?.() || 'Claude';
    view.root.querySelector('.chat-view-dialog-text').textContent =
      `${agent} is waiting for your answer in the terminal.`;
    this._chatViewSyncDialog(id);
    this._chatViewRenderStatus();
    if (previousId !== id || !wasShowing) this._chatViewReload({ immediate: true });
    // A terminal that already has focus fires no new focusin, so hardware-keyboard input would
    // keep reaching the pane behind the chat view. Move that focus now, whatever the tab-switch
    // rule says: focusing the conversation opens no soft keyboard.
    if (this._chatViewFocusInTerminal()) view.scroller.focus({ preventScroll: true });
    if (focus) requestAnimationFrame(() => view.scroller.focus({ preventScroll: true }));
  },

  /** Hide everything (home screen, session gone). */
  _chatViewHide() {
    if (!this._chatView) return;
    if (this._chatView.statusTimer) {
      clearInterval(this._chatView.statusTimer);
      this._chatView.statusTimer = null;
    }
    this._chatView.root.hidden = true;
    this._chatView.toggle.hidden = true;
    document.querySelector('.terminal-wrap')?.classList.remove('chat-view-active');
    document.body.classList.remove('chat-view-showing');
  },

  /**
   * Called when a session is deleted (app.js): forget its turn state. The view choice stays, because
   * a detach sends the same event and the session can be attached again; `_chatViewPruneModes`
   * drops the choices of sessions that are gone.
   */
  _chatViewForget(sessionId) {
    this._chatViewTurnStarts?.delete(sessionId);
    this._chatViewIdleSeen?.delete(sessionId);
    this._chatViewKeepAliveTurns?.delete(sessionId);
    if (this._chatView?.sessionId === sessionId) {
      this._chatView.sessionId = null;
      this._chatView.keys = [];
      this._chatView.thread.replaceChildren();
    }
  },

  // ─── Events ──────────────────────────────────────────────────

  /** SSE `transcript:update`: new transcript lines for `data.sessionId`. */
  _onChatViewTranscriptUpdate(data) {
    if (data?.sessionId && data.sessionId === this._chatView?.sessionId && this._chatViewShowing()) {
      this._chatViewReload();
    }
  },

  /**
   * app.js `_onSessionIdle` / `_onSessionWorking`: a turn started or ended. `keepAlive` marks
   * Codeman's own keep-warm turn, which the conversation hides: the status line stays hidden
   * for it.
   */
  onChatViewTurnEvent(sessionId, idle, keepAlive) {
    if (!this._chatViewTurnStarts) this._chatViewTurnStarts = new Map();
    if (!this._chatViewIdleSeen) this._chatViewIdleSeen = new Set();
    if (!this._chatViewKeepAliveTurns) this._chatViewKeepAliveTurns = new Set();
    if (!idle && keepAlive) this._chatViewKeepAliveTurns.add(sessionId);
    else this._chatViewKeepAliveTurns.delete(sessionId);
    // A turn's start is "now" only when this page saw the session idle first. A working event
    // for a session already busy when the page loaded (or the server restarted) says nothing
    // about when its turn began, so the status line falls back to the last Enter.
    if (!idle && this._chatViewIdleSeen.has(sessionId)) {
      this._chatViewIdleSeen.delete(sessionId);
      this._chatViewTurnStarts.set(sessionId, Date.now());
    }
    if (idle) {
      this._chatViewIdleSeen.add(sessionId);
      this._chatViewTurnStarts.delete(sessionId);
    }
    if (sessionId !== this._chatView?.sessionId || !this._chatViewShowing()) return;
    this._chatViewRenderStatus();
    this._chatViewReload();
  },

  /** app.js updateTabAlertFromHooks(): a dialog appeared or was answered. */
  onChatViewHooksChanged(sessionId) {
    if (sessionId !== this._chatView?.sessionId || !this._chatViewShowing()) return;
    this._chatViewSyncDialog(sessionId);
  },

  /** Whether the pane shows a dialog (permission, question, plan approval), answered in the terminal. */
  _chatViewDialogPending(sessionId) {
    const hooks = this.pendingHooks?.get(sessionId);
    return !!hooks && (hooks.has('permission_prompt') || hooks.has('elicitation_dialog'));
  },

  _chatViewSyncDialog(sessionId) {
    const view = this._chatView;
    if (!view) return;
    view.dialog.hidden = !this._chatViewDialogPending(sessionId);
  },

  /** Whether `sessionId` runs a turn the chat view shows: busy, and not Codeman's keep-alive turn. */
  _chatViewBusy(sessionId) {
    if (this._chatViewKeepAliveTurns?.has(sessionId)) return false;
    return this.sessions?.get(sessionId)?.status === 'busy';
  },

  _chatViewRenderStatus() {
    const view = this._chatView;
    if (!view) return;
    const session = this.sessions?.get(view.sessionId);
    const busy = this._chatViewBusy(view.sessionId);
    // Keep the view pinned to the bottom when the status line appears under the last message,
    // if the reader was already there.
    const scroller = view.scroller;
    const atBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 48;
    view.status.hidden = !busy;
    if (!busy && view.sessionId) {
      if (!this._chatViewIdleSeen) this._chatViewIdleSeen = new Set();
      this._chatViewIdleSeen.add(view.sessionId);
    }
    if (busy) {
      const activity = this._chatViewT('Working');
      // The turn's start: seen live (session:working after idle), else the last Enter (a page
      // loaded mid-turn), else unknown and left out.
      const startedAt = this._chatViewTurnStarts?.get(view.sessionId) || session?.lastSubmitAt || 0;
      view.statusText.textContent = startedAt
        ? `${activity} · ${window.CodemanChatView.elapsed(Date.now() - startedAt)}`
        : activity;
    }
    // The running time ticks once a second, only while the status line is on screen.
    const ticking = busy && this._chatViewShowing();
    if (ticking && !view.statusTimer) view.statusTimer = setInterval(() => this._chatViewRenderStatus(), 1000);
    if (!ticking && view.statusTimer) {
      clearInterval(view.statusTimer);
      view.statusTimer = null;
    }
    if (atBottom) scroller.scrollTop = scroller.scrollHeight;
  },

  // ─── Reading and drawing the conversation ────────────────────

  /** Re-read the conversation, debounced unless `immediate`. One read at a time. */
  _chatViewReload(opts = {}) {
    const view = this._chatView;
    if (!view || !view.sessionId) return;
    clearTimeout(view.reloadTimer);
    if (opts.immediate) {
      this._chatViewFetch();
      return;
    }
    view.reloadTimer = setTimeout(() => this._chatViewFetch(), CHAT_VIEW_RELOAD_DEBOUNCE_MS);
  },

  async _chatViewFetch() {
    const view = this._chatView;
    if (!view || !view.sessionId || !this._chatViewShowing()) return;
    if (view.loading) {
      view.reloadAgain = true;
      return;
    }
    const sessionId = view.sessionId;
    view.loading = true;
    try {
      const data = await this._apiJson(`/api/sessions/${encodeURIComponent(sessionId)}/last-response?context=full`);
      // A read that finished after the user moved on is dropped.
      if (view.sessionId !== sessionId || !this._chatViewShowing()) return;
      if (data && Array.isArray(data.messages)) this._chatViewRender(data.messages);
    } finally {
      view.loading = false;
      if (view.reloadAgain) {
        view.reloadAgain = false;
        this._chatViewReload();
      }
    }
  },

  _chatViewRender(rawMessages) {
    const view = this._chatView;
    const helpers = window.CodemanChatView;
    if (!view || !helpers) return;
    const messages = helpers.visibleMessages(rawMessages);
    const keys = messages.map(helpers.messageKey);
    const plan = helpers.renderPlan(view.keys, keys);
    view.empty.hidden = messages.length > 0;
    if (messages.length === 0) view.empty.textContent = this._chatViewT('No messages yet.');
    if (plan.mode === 'none') return;

    const scroller = view.scroller;
    const atBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 48;
    const firstDraw = view.keys.length === 0;
    const from = plan.mode === 'append' ? plan.from : 0;
    if (plan.mode === 'replace') view.thread.replaceChildren();

    const agentLabel = this._getResponseViewerAgentLabel?.() || 'Claude';
    const fragment = document.createDocumentFragment();
    for (let i = from; i < messages.length; i++) {
      const msg = messages[i];
      const previous = i > 0 ? messages[i - 1] : null;
      // Same rule as the Response Viewer's full view: one badge per speaker per turn.
      const continuation =
        !!previous && previous.role === msg.role && typeof msg.turn === 'number' && previous.turn === msg.turn;
      fragment.appendChild(this._chatViewBuildMessage(msg, agentLabel, continuation));
    }
    view.thread.appendChild(fragment);
    view.keys = keys;
    this._bindResponseViewerInteractions?.(view.thread);
    if (firstDraw || atBottom) scroller.scrollTop = scroller.scrollHeight;
  },

  /** One drawn message. A long prompt folds to its first lines. */
  _chatViewBuildMessage(msg, agentLabel, continuation) {
    const meta = { ...msg, continuation };
    if (msg.role !== 'user') return this._buildResponseViewerMessage(msg.text, 'assistant', agentLabel, meta);
    const text = window.CodemanChatView.promptText(msg.text);
    const fold = window.CodemanChatView.promptFold(text);
    const el = this._buildResponseViewerMessage(fold.head, 'user', agentLabel, meta);
    if (!fold.folded) return el;
    el.classList.add('chat-view-msg-folded');
    const more = document.createElement('button');
    more.type = 'button';
    more.className = 'chat-view-show-all';
    more.textContent = this._chatViewT(`Show all (${fold.totalLines} ${fold.totalLines === 1 ? 'line' : 'lines'})`);
    // Unfold in place, keeping the badge the element shows now.
    more.addEventListener('click', () => {
      const full = this._buildResponseViewerMessage(text, 'user', agentLabel, {
        ...meta,
        continuation: el.classList.contains('rv-msg-cont'),
      });
      el.replaceChildren(...full.childNodes);
      el.classList.remove('chat-view-msg-folded');
    });
    el.appendChild(more);
    return el;
  },
});
