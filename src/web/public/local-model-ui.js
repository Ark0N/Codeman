/**
 * @fileoverview "Run a model on this Mac": the welcome button, the chooser window and the row in
 * App Settings > Models.
 *
 * Reads `GET /api/local-model` (the hardware of the machine the server runs on, the
 * recommendation, and `install`: where the install stands and what can be done about it) and
 * drives the install verbs:
 *
 *   POST   /api/local-model/install   { modelId, cli, context, acknowledgedBytes }
 *   POST   /api/local-model/cancel
 *   POST   /api/local-model/resume    { newPort? }
 *   POST   /api/local-model/runtime   { action: 'start' | 'stop', newPort? }
 *   DELETE /api/local-model           { removeModel }
 *
 * ## Three surfaces, one window
 *
 *  - Welcome screen: ONE button (`#welcomeLocalModelBtn`) under the launchers, in the chip
 *    family. "Run a local model", or "Local model" once one is installed. Ships `hidden` and
 *    shows only once the server has answered for a Mac.
 *  - App Settings > Models: one row (`#localModelSettings`), the state in a few words, and a
 *    button that opens the window.
 *  - The window (`#localModelModal`): everything happens here. Which screen it shows follows
 *    `install.state`, plus the one choice the page holds itself (chooser or confirm):
 *
 *    | Screen      | When                                                              |
 *    |-------------|-------------------------------------------------------------------|
 *    | `choose`    | idle: the memory bar, the models that fit as a radio group, the   |
 *    |             | coding agent, "Install on this Mac"                               |
 *    | `confirm`   | after that button: what is downloaded with sizes, where it goes   |
 *    | `progress`  | installing: the download bar, the steps, Cancel                   |
 *    | `paused`    | paused (Cancel or a server restart): Continue or Remove           |
 *    | `failed`    | failed: the server's sentence and the ONE action that helps       |
 *    | `installed` | installed: running or stopped, Start a session, Stop/Start, Remove |
 *    | `none`      | idle and nothing fits: the hardware line, the reason, Close       |
 *
 * The memory bar is the one strong element: the memory this Mac can give a model, filled to
 * what the selected model needs (`budgetShare`). Selecting another row moves the fill.
 *
 * ## Polling
 *
 * The window asks the GET once a second WHILE IT IS OPEN, and never otherwise (there is no SSE
 * event). Closing it clears the timer. The welcome button and the Settings row use the same
 * answer and ask at most once a minute by themselves. A poll that changes nothing repaints
 * nothing, and a repaint puts the keyboard focus back where it was.
 *
 * ## Rules
 *
 *  - Every dynamic string goes in through `textContent`. Model, coding agent and chip names, an
 *    error's raw detail and a session name are someone else's text, so the window body, the
 *    button and the row carry `data-i18n-skip` and this file translates its own sentences at
 *    render time. A language or display-name change therefore repaints (`<html lang>` is
 *    written by every i18n `configure()`).
 *  - Names and labels come from the payload: this file holds no list of models or coding
 *    agents and never compares a CLI id with a literal. The id is passed on as data
 *    (`cli` of the install request, the session start).
 *  - Sizes are printed exactly as sent (`needGb`, `budgetGb`, `downloadGb`, `installGb`,
 *    `completedGb`, `totalGb`: decimal GB as text). Bytes are never turned into a size here.
 *    The installed memory alone is `memClassGb`, the size the Mac is sold as. The two byte
 *    figures this file does read are the consent total (sent back unchanged as
 *    `acknowledgedBytes`) and the two ends of a bar.
 *  - The consent is bound to the size shown: the install request carries the server's own total
 *    for the row (`Candidate.installBytes`), and a 409 `size-changed` shows the server's new
 *    total and asks again.
 *  - A button exists only for an action the server lists in `install.actions`.
 *  - A sentence the server chose arrives as `{ text, vars }` and goes through
 *    `localModelT(text, vars)`; this file's own strings are literals in that same call, in
 *    `{placeholder}` form, so the i18n test can harvest them. Both kinds need a zh-CN entry in
 *    i18n.js. `{name}` is the translator's own slot (the display name) and is never used here.
 *  - The word "Recommended" is not in this file. Which headline a Mac gets is the server's call.
 *
 * @mixin Extends CodemanApp.prototype via Object.assign
 * @dependency app.js (CodemanApp)
 * @dependency api-client.js (_api)
 * @dependency keyboard-accessory.js (FocusTrap, optional)
 * @dependency session-ui.js (selectCustomModelEntry, for "Start a session")
 * @dependency settings-ui.js (loadAppSettingsFromServer, loadCliListForSettings, optional)
 * @dependency constants.js (CodemanBase, optional)
 * @dependency i18n.js (codemanT, optional)
 * @loadorder 12.59 of 16, after edit-history-ui.js, before entrance-animations.js
 */

/** The server caches its hardware probe for a minute, so asking again sooner cannot change the answer. */
const LOCAL_MODEL_MAX_AGE_MS = 60000;

/** How often the open window asks where the install stands. */
const LOCAL_MODEL_POLL_MS = 1000;

/** i18n.js's translator with the `{placeholder}` slots filled, or the English source filled the same way. */
function localModelT(source, vars) {
  const values = vars && typeof vars === 'object' ? vars : {};
  if (typeof codemanT === 'function') return codemanT(source, values);
  return String(source).replace(/\{([a-zA-Z]\w*)\}/g, (_match, key) => String(values[key] ?? ''));
}

/** The route, under the reverse-proxy base path when there is one. */
function localModelUrl(path) {
  return typeof CodemanBase !== 'undefined' && CodemanBase ? CodemanBase.url(path) : path;
}

function localModelEl(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}

/** A sentence the server chose: `{ text, vars }` from the payload. */
function localModelMessage(message) {
  if (!message || typeof message.text !== 'string') return '';
  return localModelT(message.text, message.vars);
}

/** A token count as people write it (131,072). */
function localModelCount(value) {
  return Number.isFinite(value) ? Number(value).toLocaleString('en-US') : String(value ?? '');
}

/** Tokens per second: whole from 10, one decimal below. Empty when the server sent none. */
function localModelSpeed(value) {
  if (!Number.isFinite(value) || value <= 0) return '';
  return String(value >= 10 ? Math.round(value) : Math.round(value * 10) / 10);
}

/** Whether the page already knows the routes will refuse it (a non-admin in multi-user mode). */
function localModelNotAdmin() {
  const me = (typeof window !== 'undefined' && window.__codemanUser) || {};
  return !!(me.multiUser && me.role !== 'admin');
}

/**
 * Chip, memory and free disk in one line. The memory is the size the Mac is sold as
 * (`memClassGb`: 48 for a Mac whose 48 x 2^30 bytes are 51.5 decimal GB), a number or nothing:
 * an unknown size (0) is left out, never printed.
 */
function localModelHardwareLine(hw) {
  const chip = String(hw.chip || hw.model || '');
  const memory = Number.isFinite(hw.memClassGb) && hw.memClassGb > 0 ? String(hw.memClassGb) : '';
  const sizes = { chip, memory, free: hw.freeDiskGb };
  if (!memory) return chip;
  if (chip && hw.freeDiskGb) return localModelT('{chip}, {memory} GB memory, {free} GB free', sizes);
  if (chip) return localModelT('{chip}, {memory} GB memory', sizes);
  if (hw.freeDiskGb) return localModelT('{memory} GB memory, {free} GB free', sizes);
  return localModelT('{memory} GB memory', sizes);
}

/** The `data` of the GET, or null for anything that is not one. */
function localModelPayload(body) {
  const data = body && body.success === true ? body.data : null;
  const recommendation = data && typeof data === 'object' ? data.recommendation : null;
  if (!recommendation || typeof recommendation !== 'object' || typeof recommendation.verdict !== 'string') return null;
  return data;
}

/**
 * The `install` object of the payload. A server that does not send one yet is read as "nothing
 * installed, and nothing can be done from here": the chooser shows without its button.
 */
function localModelInstall(status) {
  const install = status && status.install && typeof status.install === 'object' ? status.install : null;
  if (install && typeof install.state === 'string') {
    return { ...install, actions: Array.isArray(install.actions) ? install.actions : [] };
  }
  return { state: 'idle', running: false, developerTools: 'unknown', actions: [] };
}

/** The rows of the chooser: the pick first, then the other models that fit. */
function localModelCandidates(status) {
  const recommendation = (status && status.recommendation) || {};
  if (recommendation.verdict === 'none' || !recommendation.pick) return [];
  const rest = Array.isArray(recommendation.alternatives) ? recommendation.alternatives : [];
  return [recommendation.pick, ...rest].filter((row) => row && typeof row.modelId === 'string');
}

/**
 * The coding agents a row can run with. A payload without the list means the one agent of the
 * row's flat fields.
 */
function localModelHarnesses(candidate) {
  if (Array.isArray(candidate.harnesses) && candidate.harnesses.length) return candidate.harnesses;
  return [
    {
      cli: candidate.cli,
      cliLabel: candidate.cliLabel,
      installed: candidate.cliInstalled !== false,
      slowFirstTurn: candidate.slowFirstTurn === true,
    },
  ];
}

/**
 * The server's own total for a row: what a click on Install downloads, in bytes. A payload
 * without it means the model plus the runtime archive while the runtime is not installed.
 */
function localModelInstallBytes(candidate, install) {
  if (Number.isFinite(candidate.installBytes)) return candidate.installBytes;
  const runtime = install.runtime && Number.isFinite(install.runtime.downloadBytes) ? install.runtime.downloadBytes : 0;
  return (Number.isFinite(candidate.downloadBytes) ? candidate.downloadBytes : 0) + runtime;
}

/** A size as sent (decimal GB text) with its unit. The unit is the same in every language. */
function localModelGb(value) {
  return `${value} GB`;
}

/** "about 68 tokens/s", the measured figure without "about", or that there is none. */
function localModelSpeedText(candidate) {
  const speed = localModelSpeed(candidate.tokensPerSecond);
  if (!speed) return localModelT('speed not known');
  if (candidate.tested === true) return localModelT('{speed} tokens/s', { speed });
  return localModelT('about {speed} tokens/s', { speed });
}

/** How long a download still takes, in the words of a person. Empty when the server sent no figure. */
function localModelTimeLeft(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '';
  if (seconds < 60) return localModelT('less than a minute left');
  if (seconds < 3600) {
    const minutes = Math.max(1, Math.round(seconds / 60));
    if (minutes === 1) return localModelT('about 1 minute left');
    return localModelT('about {minutes} minutes left', { minutes: String(minutes) });
  }
  const hours = Math.max(1, Math.round(seconds / 3600));
  if (hours === 1) return localModelT('about 1 hour left');
  return localModelT('about {hours} hours left', { hours: String(hours) });
}

/** What a step of the install is called. The coding agent's name comes from the payload. */
function localModelStepLabel(step, cliLabel) {
  if (step === 'runtime') return localModelT('Getting the runtime');
  if (step === 'model') return localModelT('Downloading the model');
  if (step === 'verify') return localModelT('Loading and checking');
  if (step === 'agent') return localModelT('Installing {cli}', { cli: cliLabel });
  if (step === 'connect') return localModelT('Connecting');
  return String(step);
}

/**
 * A button of the window, in the button set of the Git worktrees dialog (`wt-btn`): its main
 * action reads as one on every skin, and the phone toolbar's sizing does not reach it.
 */
function localModelButton(label, { key, primary = false, danger = false, disabled = false, onClick } = {}) {
  const button = localModelEl('button', 'wt-btn lm-btn', label);
  button.type = 'button';
  if (primary) button.classList.add('wt-btn-primary');
  if (danger) button.classList.add('wt-btn-danger');
  if (key) button.dataset.lmKey = key;
  if (disabled) button.disabled = true;
  if (typeof onClick === 'function') button.addEventListener('click', onClick);
  return button;
}

/**
 * The bar: a track filled to `share` (0 to 1). `kind` names it for the width transition: a
 * repaint starts the new bar at the width the last one of its kind had, so a selection or a
 * poll moves the fill instead of redrawing it.
 */
function localModelBar({ share, role, label, kind, from }) {
  const percent = Math.max(0, Math.min(100, Math.round((Number.isFinite(share) ? share : 0) * 100)));
  const bar = localModelEl('div', 'lm-bar');
  bar.setAttribute('role', role);
  bar.setAttribute('aria-valuemin', '0');
  bar.setAttribute('aria-valuemax', '100');
  bar.setAttribute('aria-valuenow', String(percent));
  if (label) bar.setAttribute('aria-label', label);
  const fill = localModelEl('div', 'lm-bar-fill');
  fill.dataset.kind = kind;
  fill.dataset.to = String(percent);
  fill.style.width = `${Number.isFinite(from) ? from : percent}%`;
  bar.appendChild(fill);
  return bar;
}

/** One line of the confirm screen's download list: what, and how large. */
function localModelSizeRow(label, gb, { strong = false } = {}) {
  const row = localModelEl('div', strong ? 'lm-size-row lm-size-total' : 'lm-size-row');
  row.appendChild(localModelEl('span', 'lm-size-what', label));
  row.appendChild(localModelEl('span', 'lm-size-gb', localModelGb(gb)));
  return row;
}

Object.assign(CodemanApp.prototype, {
  // ═══════════════════════════════════════════════════════════════
  // Data
  // ═══════════════════════════════════════════════════════════════

  /**
   * Ask the server what this Mac can run and where the install stands, and paint every surface.
   * Called when the welcome screen shows and when App Settings opens (at most one request a
   * minute then), and with `force` by the open window's poll and after a verb. Idempotent: a
   * request in flight is shared.
   */
  loadLocalModel({ force = false } = {}) {
    this._wireLocalModel();
    if (this._localModelRefused()) {
      this.renderLocalModel();
      return Promise.resolve();
    }
    if (this._localModelInFlight) return this._localModelInFlight;
    const fresh = this._localModelStatus && Date.now() - (this._localModelLoadedAt || 0) < LOCAL_MODEL_MAX_AGE_MS;
    if (fresh && !force) {
      this.renderLocalModel();
      return Promise.resolve();
    }
    // An answer already on screen stays there while it is refreshed.
    if (!this._localModelStatus) this._localModelState = 'loading';
    this.renderLocalModel();
    this._localModelInFlight = this._fetchLocalModel().finally(() => {
      this._localModelInFlight = null;
    });
    return this._localModelInFlight;
  },

  async _fetchLocalModel() {
    const verbs = this._localModelVerbs || 0;
    // `_api`, not `_apiJson`: a refusal (admin-only in multi-user mode) is an answer and must be
    // told apart from a request that failed.
    const res = await this._api(localModelUrl('/api/local-model'));
    let body = null;
    if (res?.ok || res?.status === 403) {
      try {
        body = await res.json();
      } catch {
        body = null;
      }
    }
    // A verb was answered while this request was on its way: what it carries is older than
    // what is on screen, and the verb has asked again already.
    if ((this._localModelVerbs || 0) !== verbs) return;
    // Only the route's own refusal is final. The auth layer answers 403 too, with
    // PASSWORD_CHANGE_REQUIRED, for an admin who must change the password first: that is a
    // failed request, asked again once the password is changed.
    if (res?.status === 403 && body?.errorCode === 'FORBIDDEN') {
      this._localModelState = 'refused';
      this._localModelStatus = null;
      this.closeLocalModelWindow();
      this.renderLocalModel();
      return;
    }
    const data = res?.ok ? localModelPayload(body) : null;
    if (!data) {
      // A failed refresh must not blank an answer the user is reading: keep the last good one.
      if (!this._localModelStatus) this._localModelState = 'failed';
      this.renderLocalModel();
      return;
    }
    this._localModelStatus = data;
    this._localModelState = 'ready';
    this._localModelLoadedAt = Date.now();
    this.renderLocalModel();
  },

  _localModelRefused() {
    return this._localModelState === 'refused' || localModelNotAdmin();
  },

  /** What the page itself holds about the window: open or not, and the choices made in it. */
  _localModelWindowState() {
    if (!this._localModelUi) {
      this._localModelUi = {
        open: false,
        /** `auto`: the screen the install state dictates. `choose` and `confirm`: the person went there. */
        view: 'auto',
        /** The selected row's model id, or null for the server's pick. */
        modelId: null,
        /** The selected coding agent (a CLI id, as data), or null for the row's first. */
        cli: null,
        /** A verb is in flight: every button waits. */
        busy: false,
        /** What the last verb answered when it was refused. */
        notice: null,
        /** After a 409 `size-changed`: the server's own total for the row, to show and to send. */
        expected: null,
        /** The Remove question is open, and whether the downloaded model goes too. */
        confirmRemove: false,
        removeModel: true,
      };
    }
    return this._localModelUi;
  },

  /** The selected row and coding agent, or null when no model fits. */
  _localModelSelection() {
    const ui = this._localModelWindowState();
    const candidates = localModelCandidates(this._localModelStatus);
    if (!candidates.length) return null;
    const candidate = candidates.find((row) => row.modelId === ui.modelId) || candidates[0];
    const harnesses = localModelHarnesses(candidate);
    const harness = harnesses.find((entry) => entry.cli === ui.cli) || harnesses[0];
    return { candidates, candidate, harnesses, harness };
  },

  /** Which screen the window shows, see the table in @fileoverview. */
  _localModelScreen() {
    const ui = this._localModelWindowState();
    const install = localModelInstall(this._localModelStatus);
    const selection = this._localModelSelection();
    if (install.state === 'installing') return 'progress';
    if (install.state === 'installed') return 'installed';
    const canInstall = install.actions.includes('install') && !!selection;
    if (canInstall && (ui.view === 'choose' || ui.view === 'confirm')) return ui.view;
    if (install.state === 'paused') return 'paused';
    if (install.state === 'failed') return 'failed';
    return selection ? 'choose' : 'none';
  },

  // ═══════════════════════════════════════════════════════════════
  // The window: open, close, poll
  // ═══════════════════════════════════════════════════════════════

  isLocalModelWindowOpen() {
    return this._localModelWindowState().open === true;
  },

  /** Open the window (welcome button, Settings row) and start asking once a second. */
  openLocalModelWindow() {
    const modal = document.getElementById('localModelModal');
    if (!modal || this._localModelRefused()) return;
    const ui = this._localModelWindowState();
    if (ui.open) return;
    Object.assign(ui, { open: true, view: 'auto', busy: false, notice: null, expected: null, confirmRemove: false });
    this._forgetLocalModelPaint();
    modal.classList.add('active');
    // A trap of its own: the window can open on top of App Settings, whose trap must stay
    // that modal's. Only the Tab cycle of FocusTrap is used, so the first focus is ours to place.
    if (typeof FocusTrap === 'function') {
      this._localModelFocusTrap = new FocusTrap(modal);
      this._localModelFocusTrap.previouslyFocused = document.activeElement;
      modal.addEventListener('keydown', this._localModelFocusTrap.boundHandleKeydown);
    } else {
      this._localModelReturnFocus = document.activeElement;
    }
    this.renderLocalModel();
    this._focusLocalModelWindow(null);
    void this.loadLocalModel({ force: true });
    this._scheduleLocalModelPoll();
  },

  /**
   * Close the window and stop asking. Called by the close button, the backdrop, Escape and
   * "Start a session"; a no-op unless the window is open.
   */
  closeLocalModelWindow() {
    const ui = this._localModelWindowState();
    if (!ui.open) return;
    ui.open = false;
    if (this._localModelPollTimer) clearTimeout(this._localModelPollTimer);
    this._localModelPollTimer = null;
    document.getElementById('localModelModal')?.classList.remove('active');
    if (this._localModelFocusTrap) {
      this._localModelFocusTrap.deactivate();
      this._localModelFocusTrap = null;
    } else if (this._localModelReturnFocus && typeof this._localModelReturnFocus.focus === 'function') {
      this._localModelReturnFocus.focus();
    }
    this._localModelReturnFocus = null;
    // The button and the row may say something else now (installed, installing).
    this.renderLocalModel();
  },

  /** One tick a second while the window is open; the timer is not re-armed once it is closed. */
  _scheduleLocalModelPoll() {
    if (this._localModelPollTimer) clearTimeout(this._localModelPollTimer);
    this._localModelPollTimer = null;
    if (!this.isLocalModelWindowOpen()) return;
    this._localModelPollTimer = setTimeout(() => {
      this._localModelPollTimer = null;
      if (!this.isLocalModelWindowOpen()) return;
      // A tab in the background keeps its place in the queue and asks nothing.
      const asked = document.hidden === true ? Promise.resolve() : this.loadLocalModel({ force: true });
      void Promise.resolve(asked).finally(() => this._scheduleLocalModelPoll());
    }, LOCAL_MODEL_POLL_MS);
  },

  // ═══════════════════════════════════════════════════════════════
  // Verbs
  // ═══════════════════════════════════════════════════════════════

  /**
   * Send one install verb. On success the answer is the `install` object after the verb, which
   * is painted at once; a 409 leaves the server's sentence on screen. Either way the whole
   * status is read again, because a verb can change the recommendation too.
   */
  async _localModelVerb(method, path, body) {
    const ui = this._localModelWindowState();
    if (ui.busy) return { ok: false };
    ui.busy = true;
    ui.notice = null;
    this.renderLocalModel();
    let res = null;
    let json = null;
    try {
      res = await this._api(localModelUrl(path), body === undefined ? { method } : { method, body });
      if (res) {
        try {
          json = await res.json();
        } catch {
          json = null;
        }
      }
    } finally {
      ui.busy = false;
    }
    const data = json && typeof json === 'object' && json.data && typeof json.data === 'object' ? json.data : null;
    let result;
    if (res?.ok && json?.success === true && data && typeof data.state === 'string') {
      if (this._localModelStatus) this._localModelStatus = { ...this._localModelStatus, install: data };
      result = { ok: true, view: data };
    } else if (res?.status === 409 && data) {
      ui.notice = { message: data.message, sessions: data.sessions };
      result = { ok: false, conflict: data };
    } else {
      ui.notice = res
        ? { refused: true, detail: typeof json?.error === 'string' ? json.error : '' }
        : { unreachable: true };
      result = { ok: false };
    }
    this._localModelVerbs = (this._localModelVerbs || 0) + 1;
    this.renderLocalModel();
    // After any read that was already under way (its answer is dropped, see _fetchLocalModel).
    void Promise.resolve(this._localModelInFlight).then(() => this.loadLocalModel({ force: true }));
    return result;
  },

  /** "Install on this Mac": the confirm screen with the sizes. Nothing is sent yet. */
  reviewLocalModelInstall() {
    const ui = this._localModelWindowState();
    Object.assign(ui, { view: 'confirm', notice: null, expected: null });
    this.renderLocalModel();
  },

  /** Back to the chooser (from the confirm screen, or to pick another model after a stop). */
  chooseLocalModel(modelId) {
    const ui = this._localModelWindowState();
    Object.assign(ui, { view: 'choose', notice: null, expected: null, confirmRemove: false });
    if (typeof modelId === 'string') {
      ui.modelId = modelId;
      ui.cli = null;
    }
    this.renderLocalModel();
  },

  /** Back from the chooser to what the install state says (a paused or stopped install). */
  leaveLocalModelChooser() {
    const ui = this._localModelWindowState();
    Object.assign(ui, { view: 'auto', notice: null, expected: null });
    this.renderLocalModel();
  },

  /** Select a row of the chooser. The coding agent stays when the new row offers it too. */
  selectLocalModel(modelId) {
    const ui = this._localModelWindowState();
    if (ui.busy) return;
    ui.modelId = modelId;
    ui.expected = null;
    this.renderLocalModel();
  },

  /**
   * "Download and install": the consent click. Sends the row with the total that was on screen;
   * a server whose own total differs answers 409, and the screen then shows that total.
   */
  async installLocalModel() {
    const ui = this._localModelWindowState();
    const selection = this._localModelSelection();
    if (!selection) return;
    const { candidate, harness } = selection;
    const install = localModelInstall(this._localModelStatus);
    const expected = ui.expected && ui.expected.modelId === candidate.modelId ? ui.expected : null;
    const result = await this._localModelVerb('POST', '/api/local-model/install', {
      modelId: candidate.modelId,
      cli: harness.cli,
      context: candidate.context,
      acknowledgedBytes: expected ? expected.bytes : localModelInstallBytes(candidate, install),
    });
    if (result.ok) {
      Object.assign(ui, { view: 'auto', expected: null });
    } else if (result.conflict?.reason === 'size-changed' && Number.isFinite(result.conflict.expectedBytes)) {
      ui.expected = {
        modelId: candidate.modelId,
        bytes: result.conflict.expectedBytes,
        gb: typeof result.conflict.expectedGb === 'string' ? result.conflict.expectedGb : '',
      };
    } else if (result.conflict) {
      // A job is running or a model is installed already: show that, with the server's sentence.
      ui.view = 'auto';
    }
    this.renderLocalModel();
  },

  cancelLocalModelInstall() {
    return this._localModelVerb('POST', '/api/local-model/cancel');
  },

  /** "Continue", "Try again", "Use another port" of a paused or stopped install. */
  resumeLocalModelInstall({ newPort = false } = {}) {
    return this._localModelVerb('POST', '/api/local-model/resume', newPort ? { newPort: true } : {});
  },

  /** "Start" and "Stop" of an installed model's runtime. */
  setLocalModelRuntime(action, { newPort = false } = {}) {
    return this._localModelVerb('POST', '/api/local-model/runtime', newPort ? { action, newPort: true } : { action });
  },

  /** "Remove": first the question, then (with `confirmed`) the delete. */
  async removeLocalModel({ confirmed = false } = {}) {
    const ui = this._localModelWindowState();
    if (!confirmed) {
      Object.assign(ui, { confirmRemove: true, notice: null });
      this.renderLocalModel();
      return;
    }
    const result = await this._localModelVerb('DELETE', '/api/local-model', { removeModel: ui.removeModel === true });
    if (result.ok) Object.assign(ui, { confirmRemove: false, view: 'auto', modelId: null, cli: null });
    this.renderLocalModel();
  },

  /**
   * "Start a session": a session on the saved connection with the coding agent of the install.
   * The page's own copies are stale right after an install (the settings flag was switched on
   * by the server and the agent may have been installed a moment ago), so both are read again
   * before the existing launcher runs. Both values are the payload's; no id is compared.
   */
  async startLocalModelSession() {
    const install = localModelInstall(this._localModelStatus);
    if (typeof install.cli !== 'string' || typeof install.endpointId !== 'string') return;
    const settingsOpen = document.getElementById('appSettingsModal')?.classList.contains('active');
    this.closeLocalModelWindow();
    if (settingsOpen) this.closeAppSettings?.();
    await this.loadAppSettingsFromServer?.();
    await this.loadCliListForSettings?.();
    await this.selectCustomModelEntry?.(install.cli, install.endpointId);
  },

  // ═══════════════════════════════════════════════════════════════
  // Render
  // ═══════════════════════════════════════════════════════════════

  /** Paint every surface: the welcome button, the App Settings row and, when open, the window. */
  renderLocalModel() {
    this._renderLocalModelButton();
    this._renderLocalModelSettings();
    this._renderLocalModelWindow();
  },

  /** Whether the server answered for a Mac (the only case in which anything about "this Mac" shows). */
  _localModelOnMac() {
    const status = this._localModelStatus;
    return !!status && !this._localModelRefused() && status.recommendation.reason !== 'not-macos';
  },

  _renderLocalModelButton() {
    const button = document.getElementById('welcomeLocalModelBtn');
    if (!button) return;
    const shown = this._localModelOnMac();
    button.hidden = !shown;
    if (!shown) return;
    const installed = localModelInstall(this._localModelStatus).state === 'installed';
    const label = installed ? localModelT('Local model') : localModelT('Run a local model');
    const slot = document.getElementById('welcomeLocalModelLabel') || button;
    slot.textContent = label;
    // The page can be open on another laptop or a tablet: "this Mac" is the server's.
    button.title = localModelT('The Mac that Codeman runs on, which is not always the device you are reading on.');
  },

  /** The state in a few words, for the Settings row. */
  _localModelSummary() {
    const status = this._localModelStatus;
    const install = localModelInstall(status);
    const model = install.model ? String(install.model.label || install.model.id || '') : '';
    if (install.state === 'installing') return localModelT('Installing {model}', { model });
    if (install.state === 'paused') return localModelT('The install of {model} is paused', { model });
    if (install.state === 'failed') return localModelT('The install of {model} stopped', { model });
    if (install.state === 'installed') {
      if (install.running) return localModelT('{model} is running', { model });
      return localModelT('{model} is installed and stopped', { model });
    }
    return localModelT('No model installed');
  },

  _renderLocalModelSettings() {
    const row = document.getElementById('localModelSettings');
    if (!row) return;
    row.textContent = '';
    const status = this._localModelStatus;
    const failed = !status && this._localModelState === 'failed';
    // The whole group goes for a non-admin, the way the other admin-only groups of this modal
    // do, and for a server that is not a Mac: its title and hint are about "this Mac". Until
    // the first answer nothing says the server is one, so the group waits for it.
    const shown = !this._localModelRefused() && (failed || this._localModelOnMac());
    const group = document.getElementById('localModelGroup');
    if (group) group.style.display = shown ? '' : 'none';
    const open = document.getElementById('localModelSettingsOpen');
    if (open) open.hidden = !shown || !status;
    if (!shown) return;
    if (!status) {
      row.appendChild(localModelEl('span', 'set-row-label', localModelT('Could not reach the server.')));
      return;
    }
    row.appendChild(localModelEl('span', 'set-row-label', this._localModelSummary()));
    const install = localModelInstall(status);
    const none = install.state === 'idle' && !localModelCandidates(status).length;
    // Nothing fits: the reason, in the server's sentence. Otherwise what the Mac is.
    const detail = none
      ? localModelMessage(status.recommendation.headline)
      : localModelHardwareLine(status.hardware || {});
    if (detail) row.appendChild(localModelEl('span', 'set-row-desc', detail));
    if (open) {
      const choosing = install.state === 'idle' && !none;
      open.textContent = choosing ? localModelT('Choose a model') : localModelT('Open');
    }
  },

  /**
   * Paint the window's body. Skipped when nothing it shows has changed (the poll asks every
   * second). A tick that moved only the download replaces the bar and its figure alone, so a
   * button is never swapped out under a click; any other change rebuilds the screen and puts
   * the keyboard focus back on the control it was on.
   */
  _renderLocalModelWindow() {
    const ui = this._localModelWindowState();
    const body = document.getElementById('localModelWindowBody');
    if (!body || !ui.open) return;
    const status = this._localModelStatus;
    const key = JSON.stringify([status, this._localModelState, ui]);
    if (key === this._localModelWindowKey) return;
    this._localModelWindowKey = key;
    // The same picture without the download figures: equal means only the download moved.
    const still = status && status.install ? { ...status, install: { ...status.install, progress: null } } : status;
    const frame = JSON.stringify([still, this._localModelState, ui]);
    const last = this._localModelBarLast || {};
    const screen = this._localModelScreen();
    const meter = body.querySelector('.lm-meter');

    if (frame === this._localModelFrameKey && (screen === 'progress' || screen === 'paused') && meter) {
      meter.replaceWith(this._localModelDownloadMeter(screen, last));
      this._settleLocalModelBars(body);
      return;
    }
    this._localModelFrameKey = frame;

    const modal = document.getElementById('localModelModal');
    const active = document.activeElement;
    const inside = !!(modal && active && modal.contains(active));
    const focusKey = inside && active.dataset ? active.dataset.lmKey : undefined;
    const scrolled = body.scrollTop;
    body.dataset.screen = screen;
    body.replaceChildren(...this._buildLocalModelScreen(screen, last));
    body.scrollTop = scrolled;
    this._settleLocalModelBars(body);
    if (inside || active === document.body) this._focusLocalModelWindow(focusKey);
  },

  /**
   * Forget what the window last painted, so the next render rebuilds the whole screen. Both
   * keys go: with the frame key left, a progress screen would repaint its bar alone and keep
   * every other word in the language it was painted in.
   */
  _forgetLocalModelPaint() {
    this._localModelWindowKey = null;
    this._localModelFrameKey = null;
  },

  /** Each bar was built at the width the last one of its kind had: move it to its own. */
  _settleLocalModelBars(body) {
    const painted = {};
    for (const fill of body.querySelectorAll('.lm-bar-fill')) {
      fill.getBoundingClientRect();
      fill.style.width = `${fill.dataset.to}%`;
      painted[fill.dataset.kind] = Number(fill.dataset.to);
    }
    this._localModelBarLast = painted;
  },

  /** Put the focus on the control named `key`, else on the screen's main action, else on Close. */
  _focusLocalModelWindow(key) {
    const modal = document.getElementById('localModelModal');
    const body = document.getElementById('localModelWindowBody');
    if (!modal || !body) return;
    const keyed = [...body.querySelectorAll('[data-lm-key]')].filter((el) => !el.disabled);
    const target =
      (key && keyed.find((el) => el.dataset.lmKey === key && el.getAttribute('tabindex') !== '-1')) ||
      keyed.find((el) => el.dataset.lmKey === 'model' && el.getAttribute('aria-checked') === 'true') ||
      keyed.find((el) => el.dataset.lmKey === 'primary') ||
      keyed.find((el) => el.getAttribute('tabindex') !== '-1') ||
      modal.querySelector('.modal-close');
    if (target && typeof target.focus === 'function') target.focus({ preventScroll: true });
  },

  _buildLocalModelScreen(screen, last) {
    const status = this._localModelStatus;
    if (!status) {
      const waiting = this._localModelState === 'failed';
      const text = waiting ? localModelT('Could not reach the server.') : localModelT('Checking this Mac');
      return [localModelEl('p', 'lm-lead', text)];
    }
    if (screen === 'choose') return this._buildLocalModelChooser(last);
    if (screen === 'confirm') return this._buildLocalModelConfirm();
    if (screen === 'progress' || screen === 'paused') return this._buildLocalModelProgress(screen, last);
    if (screen === 'failed') return this._buildLocalModelFailed();
    if (screen === 'installed') return this._buildLocalModelInstalled();
    return this._buildLocalModelNone();
  },

  /** The hardware line every idle screen opens with. */
  _localModelHardwareEl() {
    const text = localModelHardwareLine(this._localModelStatus.hardware || {});
    return text ? localModelEl('p', 'lm-hw', text) : null;
  },

  /** What the last verb answered when it was refused, or nothing. */
  _localModelNoticeEl() {
    const notice = this._localModelWindowState().notice;
    if (!notice) return null;
    const box = localModelEl('div', 'lm-notice');
    box.setAttribute('role', 'alert');
    if (notice.message) {
      box.appendChild(localModelEl('p', 'lm-notice-text', localModelMessage(notice.message)));
    } else if (notice.unreachable) {
      box.appendChild(localModelEl('p', 'lm-notice-text', localModelT('Could not reach the server.')));
    } else {
      box.appendChild(localModelEl('p', 'lm-notice-text', localModelT('The server did not accept that.')));
      if (notice.detail) box.appendChild(localModelEl('p', 'lm-notice-detail', notice.detail));
    }
    return box;
  },

  /** The one honest sentence about git and Python, only on a Mac without the developer tools. */
  _localModelDeveloperToolsEl() {
    if (localModelInstall(this._localModelStatus).developerTools !== 'missing') return null;
    return localModelEl(
      'p',
      'lm-aside',
      localModelT(
        'Coding agents use git and Python. This Mac has no developer tools yet, so macOS will offer to install them the first time an agent needs one.'
      )
    );
  },

  /** One model row: the radio of the chooser, or the same line as plain text on the confirm screen. */
  _localModelRow(candidate, { checked, interactive, tabStop }) {
    const row = localModelEl('div', 'lm-model');
    if (interactive) {
      row.setAttribute('role', 'radio');
      row.setAttribute('aria-checked', checked ? 'true' : 'false');
      row.setAttribute('tabindex', tabStop ? '0' : '-1');
      row.dataset.lmKey = 'model';
      row.dataset.modelId = candidate.modelId;
      row.appendChild(localModelEl('span', 'lm-radio'));
    } else {
      row.classList.add('lm-model-static');
    }
    if (checked) row.classList.add('lm-model-on');
    row.appendChild(localModelEl('span', 'lm-model-name', String(candidate.modelLabel || candidate.modelId)));
    const tagSlot = localModelEl('span', 'lm-model-tag');
    const label = candidate.tag && typeof candidate.tag.label === 'string' ? candidate.tag.label : '';
    if (label) {
      const tag = localModelEl('span', 'lm-tag', localModelT(label));
      // The pick, and a row run on a Mac like this one, take the accent. Every other tag is quiet.
      if (candidate.tag.kind === 'best' || candidate.tag.kind === 'tested') tag.classList.add('lm-tag-accent');
      tagSlot.appendChild(tag);
    }
    row.appendChild(tagSlot);
    row.appendChild(localModelEl('span', 'lm-model-speed', localModelSpeedText(candidate)));
    row.appendChild(localModelEl('span', 'lm-model-size', localModelGb(candidate.downloadGb)));
    return row;
  },

  _buildLocalModelChooser(last) {
    const ui = this._localModelWindowState();
    const status = this._localModelStatus;
    const recommendation = status.recommendation;
    const install = localModelInstall(status);
    const { candidates, candidate, harnesses, harness } = this._localModelSelection();
    const parts = [];
    const hw = this._localModelHardwareEl();
    if (hw) parts.push(hw);

    // The memory bar: what this Mac can give a model, filled to what the selected one needs.
    const meter = localModelEl('div', 'lm-meter');
    const head = localModelEl('div', 'lm-meter-head');
    const sizes = { need: candidate.needGb, budget: recommendation.budgetGb };
    head.appendChild(localModelEl('span', 'lm-figure', localModelT('About {need} of {budget} GB of memory', sizes)));
    // A formula's figure says so, once. A wired limit and the runtime's own figure are facts.
    if (recommendation.budgetSource === 'estimated') {
      head.appendChild(localModelEl('span', 'lm-figure-aside', localModelT('estimated')));
    }
    meter.appendChild(head);
    const share = String(Math.round((Number.isFinite(candidate.budgetShare) ? candidate.budgetShare : 0) * 100));
    meter.appendChild(
      localModelBar({
        share: candidate.budgetShare,
        role: 'meter',
        kind: 'memory',
        from: last.memory,
        label: localModelT('The selected model needs {share}% of the memory this Mac can give a model', { share }),
      })
    );
    const legend = localModelEl('div', 'lm-legend');
    const context = localModelCount(candidate.context);
    legend.appendChild(localModelEl('span', '', localModelT('The model at {context} tokens of context', { context })));
    legend.appendChild(localModelEl('span', '', localModelT('What stays free')));
    meter.appendChild(legend);
    parts.push(meter);

    // The server's headline: its word for a pick it has run on a Mac like this one labels the
    // list, and the small-model caveat is a sentence above it. "Best fit for this Mac" would
    // only repeat the pick's tag, so the list is then labelled by what it holds.
    const pick = recommendation.pick || {};
    const headline = localModelMessage(recommendation.headline);
    if (recommendation.verdict === 'limited' && headline) parts.push(localModelEl('p', 'lm-lead', headline));
    const tested = pick.tested === true && recommendation.verdict !== 'limited' && !!headline;

    const list = localModelEl('div', 'lm-list');
    const caption = localModelEl('div', 'lm-caption');
    const captionLabel = tested
      ? localModelEl('span', 'lm-caption-label lm-caption-strong', headline)
      : localModelEl('span', 'lm-caption-label', localModelT('Models that fit this Mac'));
    captionLabel.id = 'localModelListLabel';
    caption.appendChild(captionLabel);
    caption.appendChild(localModelEl('span', 'lm-caption-speed', localModelT('Speed')));
    caption.appendChild(localModelEl('span', 'lm-caption-size', localModelT('Download')));
    list.appendChild(caption);
    const group = localModelEl('div', 'lm-models');
    group.setAttribute('role', 'radiogroup');
    group.setAttribute('aria-labelledby', 'localModelListLabel');
    for (const row of candidates) {
      const checked = row === candidate;
      const el = this._localModelRow(row, { checked, interactive: true, tabStop: checked });
      el.addEventListener('click', () => this.selectLocalModel(row.modelId));
      group.appendChild(el);
    }
    group.addEventListener('keydown', (event) => this._onLocalModelListKey(event));
    list.appendChild(group);
    parts.push(list);

    const notes = localModelEl('div', 'lm-notes');
    for (const note of Array.isArray(recommendation.notes) ? recommendation.notes : []) {
      const text = localModelMessage(note);
      if (text) notes.appendChild(localModelEl('p', 'lm-aside', text));
    }
    if (notes.childElementCount) parts.push(notes);

    // The coding agent, on its own line: only the ones the server offers for the selected row.
    const runs = localModelEl('div', 'lm-runs');
    const runsLabel = localModelEl('label', 'lm-runs-label', localModelT('Runs with'));
    runsLabel.htmlFor = 'localModelCli';
    runs.appendChild(runsLabel);
    const select = localModelEl('select', 'lm-select');
    select.id = 'localModelCli';
    select.dataset.lmKey = 'cli';
    harnesses.forEach((entry, index) => {
      const option = localModelEl('option', '', String(entry.cliLabel || entry.cli));
      option.value = String(index);
      option.selected = entry === harness;
      select.appendChild(option);
    });
    select.addEventListener('change', () => {
      const chosen = harnesses[Number(select.value)];
      if (!chosen) return;
      ui.cli = chosen.cli;
      this.renderLocalModel();
    });
    runs.appendChild(select);
    const hints = [];
    if (harness.installed === false) hints.push(localModelT('Not on this Mac yet. It is installed for you.'));
    if (harness.slowFirstTurn === true) hints.push(localModelT('The first answer can take minutes.'));
    if (hints.length) runs.appendChild(localModelEl('span', 'lm-runs-hint', hints.join(' ')));
    parts.push(runs);

    const notice = this._localModelNoticeEl();
    if (notice) parts.push(notice);

    const foot = localModelEl('div', 'lm-foot');
    const promise = localModelT('No account and no API key. The model runs only on this Mac.');
    foot.appendChild(localModelEl('p', 'lm-foot-note', promise));
    const buttons = localModelEl('div', 'lm-buttons');
    // Reached from a paused or stopped install: the way back to it.
    if (install.state !== 'idle') {
      buttons.appendChild(
        localModelButton(localModelT('Back'), { key: 'back', onClick: () => this.leaveLocalModelChooser() })
      );
    }
    if (install.actions.includes('install')) {
      buttons.appendChild(
        localModelButton(localModelT('Install on this Mac'), {
          key: 'primary',
          primary: true,
          disabled: ui.busy,
          onClick: () => this.reviewLocalModelInstall(),
        })
      );
    }
    if (buttons.childElementCount) foot.appendChild(buttons);
    parts.push(foot);
    return parts;
  },

  /** Arrow keys, Home and End move the selection of the radio group, and the focus with it. */
  _onLocalModelListKey(event) {
    const selection = this._localModelSelection();
    if (!selection) return;
    const { candidates, candidate } = selection;
    const index = candidates.indexOf(candidate);
    let next = -1;
    if (event.key === 'ArrowDown' || event.key === 'ArrowRight') next = (index + 1) % candidates.length;
    else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft')
      next = (index - 1 + candidates.length) % candidates.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = candidates.length - 1;
    else if (event.key === ' ' || event.key === 'Enter') next = index;
    if (next < 0) return;
    event.preventDefault();
    // The repaint puts the focus on the row that is selected now: the group's one tab stop.
    this.selectLocalModel(candidates[next].modelId);
  },

  _buildLocalModelConfirm() {
    const ui = this._localModelWindowState();
    const status = this._localModelStatus;
    const install = localModelInstall(status);
    const { candidate, harness } = this._localModelSelection();
    const parts = [];
    const hw = this._localModelHardwareEl();
    if (hw) parts.push(hw);

    // The list collapses to the chosen row.
    const chosen = localModelEl('div', 'lm-list');
    const one = localModelEl('div', 'lm-models');
    one.appendChild(this._localModelRow(candidate, { checked: true, interactive: false }));
    chosen.appendChild(one);
    parts.push(chosen);
    const cli = String(harness.cliLabel || harness.cli);
    const runs = localModelT('Runs with {cli}, at {context} tokens of context.', {
      cli,
      context: localModelCount(candidate.context),
    });
    parts.push(localModelEl('p', 'lm-aside', runs));

    // What is downloaded, with sizes: the model, the runtime while it is missing, the total.
    const sizes = localModelEl('div', 'lm-sizes');
    sizes.appendChild(localModelEl('h4', 'lm-heading', localModelT('What is downloaded')));
    sizes.appendChild(localModelSizeRow(String(candidate.modelLabel || candidate.modelId), candidate.downloadGb));
    const runtime = install.runtime || {};
    if (runtime.installed !== true && Number(runtime.downloadBytes) > 0 && runtime.downloadGb) {
      const what = localModelT('Ollama {version}, the program that runs the model', { version: runtime.version });
      sizes.appendChild(localModelSizeRow(what, runtime.downloadGb));
    }
    const expected = ui.expected && ui.expected.modelId === candidate.modelId ? ui.expected : null;
    const total = expected ? expected.gb : candidate.installGb;
    if (total) sizes.appendChild(localModelSizeRow(localModelT('Total'), total, { strong: true }));
    parts.push(sizes);

    // The coding agent, when it is missing: the literal command its installer runs.
    if (harness.installed === false) {
      const agent = localModelEl('div', 'lm-agent');
      const lead = harness.installCommand
        ? localModelT('{cli} is not on this Mac yet. Its own installer is run with this command:', { cli })
        : localModelT('{cli} is not on this Mac yet. It is installed with its own installer.', { cli });
      agent.appendChild(localModelEl('p', 'lm-aside', lead));
      if (harness.installCommand) agent.appendChild(localModelEl('code', 'lm-command', String(harness.installCommand)));
      parts.push(agent);
    }

    const where = localModelEl('div', 'lm-where');
    if (install.folder) {
      where.appendChild(localModelEl('p', 'lm-aside', localModelT('The model and the program that runs it go into:')));
      where.appendChild(localModelEl('code', 'lm-command', String(install.folder)));
    }
    where.appendChild(localModelEl('p', 'lm-aside', localModelT('No administrator password.')));
    parts.push(where);
    const tools = this._localModelDeveloperToolsEl();
    if (tools) parts.push(tools);

    const notice = this._localModelNoticeEl();
    if (notice) parts.push(notice);

    const foot = localModelEl('div', 'lm-foot');
    const buttons = localModelEl('div', 'lm-buttons');
    buttons.appendChild(
      localModelButton(localModelT('Back'), { key: 'back', disabled: ui.busy, onClick: () => this.chooseLocalModel() })
    );
    buttons.appendChild(
      localModelButton(localModelT('Download and install'), {
        key: 'primary',
        primary: true,
        disabled: ui.busy,
        onClick: () => void this.installLocalModel(),
      })
    );
    foot.appendChild(buttons);
    parts.push(foot);
    return parts;
  },

  /** The steps of the job as a short list: done, the current one, and what is still to come. */
  _localModelStepsEl(install, { stopped }) {
    const steps = Array.isArray(install.steps) ? install.steps : [];
    if (!steps.length) return null;
    const list = localModelEl('ol', 'lm-steps');
    const at = steps.indexOf(install.step);
    steps.forEach((step, index) => {
      const item = localModelEl('li', 'lm-step');
      if (index < at) item.classList.add('lm-step-done');
      else if (index === at) {
        item.classList.add(stopped ? 'lm-step-stopped' : 'lm-step-now');
        item.setAttribute('aria-current', 'step');
      }
      item.appendChild(localModelEl('span', 'lm-step-mark'));
      item.appendChild(
        localModelEl('span', 'lm-step-label', localModelStepLabel(step, String(install.cliLabel || '')))
      );
      list.appendChild(item);
    });
    return list;
  },

  /** The Remove question, in place of a screen's buttons. */
  _localModelRemoveEl() {
    const ui = this._localModelWindowState();
    const box = localModelEl('div', 'lm-remove');
    box.appendChild(localModelEl('p', 'lm-lead', localModelT('Remove the local model from this Mac?')));
    const label = localModelEl('label', 'lm-check');
    const check = localModelEl('input', '');
    check.type = 'checkbox';
    check.checked = ui.removeModel === true;
    check.dataset.lmKey = 'remove-model';
    check.addEventListener('change', () => {
      ui.removeModel = check.checked;
      this.renderLocalModel();
    });
    label.appendChild(check);
    label.appendChild(localModelEl('span', '', localModelT('Also delete the downloaded model')));
    box.appendChild(label);
    box.appendChild(localModelEl('p', 'lm-aside', localModelT('The coding agent stays installed.')));
    const notice = this._localModelNoticeEl();
    if (notice) box.appendChild(notice);
    const buttons = localModelEl('div', 'lm-buttons');
    buttons.appendChild(
      localModelButton(localModelT('Cancel'), {
        key: 'back',
        disabled: ui.busy,
        onClick: () => {
          Object.assign(ui, { confirmRemove: false, notice: null });
          this.renderLocalModel();
        },
      })
    );
    buttons.appendChild(
      localModelButton(localModelT('Remove'), {
        key: 'primary',
        danger: true,
        disabled: ui.busy,
        onClick: () => void this.removeLocalModel({ confirmed: true }),
      })
    );
    const foot = localModelEl('div', 'lm-foot');
    foot.appendChild(buttons);
    box.appendChild(foot);
    return box;
  },

  /**
   * The download bar and its figure: "6.2 of 23.1 GB", then the speed and the time left. A step
   * that downloads nothing names itself instead, with the bar full once the model is in.
   */
  _localModelDownloadMeter(screen, last) {
    const install = localModelInstall(this._localModelStatus);
    const paused = screen === 'paused';
    const progress = install.progress;
    const meter = localModelEl('div', 'lm-meter');
    const head = localModelEl('div', 'lm-meter-head');
    const steps = Array.isArray(install.steps) ? install.steps : [];
    const now = localModelStepLabel(install.step, String(install.cliLabel || ''));
    let share = steps.indexOf(install.step) > steps.indexOf('model') ? 1 : 0;
    if (progress && Number(progress.totalBytes) > 0) {
      share = Number(progress.completedBytes) / Number(progress.totalBytes);
      const sizes = { done: progress.completedGb, total: progress.totalGb };
      head.appendChild(localModelEl('span', 'lm-figure', localModelT('{done} of {total} GB', sizes)));
      const left = localModelTimeLeft(progress.secondsLeft);
      let rate = '';
      if (!paused && progress.mbPerSecond && left) {
        rate = localModelT('{speed} MB per second, {left}', { speed: progress.mbPerSecond, left });
      } else if (!paused && progress.mbPerSecond) {
        rate = localModelT('{speed} MB per second', { speed: progress.mbPerSecond });
      }
      if (rate) head.appendChild(localModelEl('span', 'lm-figure-aside', rate));
    } else {
      head.appendChild(localModelEl('span', 'lm-figure', now));
    }
    meter.appendChild(head);
    meter.appendChild(localModelBar({ share, role: 'progressbar', kind: 'download', from: last.download, label: now }));
    return meter;
  },

  /** Installing, and the same picture frozen: paused. */
  _buildLocalModelProgress(screen, last) {
    const ui = this._localModelWindowState();
    const install = localModelInstall(this._localModelStatus);
    const paused = screen === 'paused';
    const model = install.model ? String(install.model.label || install.model.id || '') : '';
    const parts = [];
    const title = paused
      ? localModelT('The install of {model} is paused', { model })
      : localModelT('Installing {model}', { model });
    parts.push(localModelEl('p', 'lm-title', title));

    // The download bar takes the place of the memory bar.
    parts.push(this._localModelDownloadMeter(screen, last));

    const list = this._localModelStepsEl(install, { stopped: paused });
    if (list) parts.push(list);

    if (ui.confirmRemove) {
      parts.push(this._localModelRemoveEl());
      return parts;
    }

    const note = paused
      ? localModelT('Nothing is downloaded until you continue.')
      : localModelT('You can close this window. The download continues while Codeman is running.');
    parts.push(localModelEl('p', 'lm-aside', note));
    const notice = this._localModelNoticeEl();
    if (notice) parts.push(notice);

    const foot = localModelEl('div', 'lm-foot');
    const buttons = localModelEl('div', 'lm-buttons');
    if (install.actions.includes('cancel')) {
      buttons.appendChild(
        localModelButton(localModelT('Cancel'), {
          key: 'primary',
          disabled: ui.busy,
          onClick: () => void this.cancelLocalModelInstall(),
        })
      );
    }
    if (paused && install.actions.includes('remove')) {
      buttons.appendChild(
        localModelButton(localModelT('Remove'), {
          key: 'remove',
          disabled: ui.busy,
          onClick: () => void this.removeLocalModel(),
        })
      );
    }
    if (paused && install.actions.includes('install') && this._localModelSelection()) {
      buttons.appendChild(
        localModelButton(localModelT('Choose another model'), {
          key: 'choose',
          disabled: ui.busy,
          onClick: () => this.chooseLocalModel(),
        })
      );
    }
    if (paused && install.actions.includes('resume')) {
      buttons.appendChild(
        localModelButton(localModelT('Continue'), {
          key: 'primary',
          primary: true,
          disabled: ui.busy,
          onClick: () => void this.resumeLocalModelInstall(),
        })
      );
    }
    if (buttons.childElementCount) foot.appendChild(buttons);
    parts.push(foot);
    return parts;
  },

  /**
   * The ONE action that helps after an error, as a button, or null when the server does not
   * offer it right now. `error.next` names it; `install.actions` says whether it is possible.
   */
  _localModelNextButton(install, error) {
    const ui = this._localModelWindowState();
    const can = (action) => install.actions.includes(action);
    const primary = (label, onClick) =>
      localModelButton(label, { key: 'primary', primary: true, disabled: ui.busy, onClick });
    const installed = install.state === 'installed';
    if (error.next === 'retry' && can('resume')) {
      return primary(localModelT('Try again'), () => void this.resumeLocalModelInstall());
    }
    if (error.next === 'other-port' && installed && can('start')) {
      return primary(localModelT('Use another port'), () => void this.setLocalModelRuntime('start', { newPort: true }));
    }
    if (error.next === 'other-port' && can('resume')) {
      return primary(localModelT('Use another port'), () => void this.resumeLocalModelInstall({ newPort: true }));
    }
    if (error.next === 'start' && can('start')) {
      return primary(localModelT('Start'), () => void this.setLocalModelRuntime('start'));
    }
    if (error.next === 'remove' && can('remove')) {
      return primary(localModelT('Remove'), () => void this.removeLocalModel());
    }
    if (error.next === 'next-model' && can('install')) {
      const candidates = localModelCandidates(this._localModelStatus);
      const next = error.nextModel && candidates.find((row) => row.modelId === error.nextModel.modelId);
      if (next) {
        const model = String(error.nextModel.modelLabel || next.modelLabel || next.modelId);
        return primary(localModelT('Try {model}', { model }), () => this.chooseLocalModel(next.modelId));
      }
      if (candidates.length) return primary(localModelT('Choose another model'), () => this.chooseLocalModel());
    }
    return null;
  },

  /** An error as the window shows it: the server's sentence, and its raw detail folded away. */
  _localModelErrorEl(error) {
    const box = localModelEl('div', 'lm-error');
    box.appendChild(localModelEl('p', 'lm-title', localModelMessage(error.message)));
    if (typeof error.detail === 'string' && error.detail) {
      const details = localModelEl('details', 'lm-details');
      details.appendChild(localModelEl('summary', '', localModelT('Details')));
      details.appendChild(localModelEl('pre', 'lm-detail-text', error.detail));
      box.appendChild(details);
    }
    return box;
  },

  _buildLocalModelFailed() {
    const ui = this._localModelWindowState();
    const install = localModelInstall(this._localModelStatus);
    const error = install.error || {};
    const parts = [];
    parts.push(this._localModelErrorEl(error));
    const list = this._localModelStepsEl(install, { stopped: true });
    if (list) parts.push(list);

    if (ui.confirmRemove) {
      parts.push(this._localModelRemoveEl());
      return parts;
    }
    const notice = this._localModelNoticeEl();
    if (notice) parts.push(notice);

    const foot = localModelEl('div', 'lm-foot');
    const buttons = localModelEl('div', 'lm-buttons');
    const next = this._localModelNextButton(install, error);
    // The way out, kept quiet beside the action that helps (unless that action is the removal).
    if (install.actions.includes('remove') && error.next !== 'remove') {
      buttons.appendChild(
        localModelButton(localModelT('Remove'), {
          key: 'remove',
          disabled: ui.busy,
          onClick: () => void this.removeLocalModel(),
        })
      );
    }
    if (next) buttons.appendChild(next);
    if (buttons.childElementCount) foot.appendChild(buttons);
    parts.push(foot);
    return parts;
  },

  _buildLocalModelInstalled() {
    const ui = this._localModelWindowState();
    const install = localModelInstall(this._localModelStatus);
    const model = install.model ? String(install.model.label || install.model.id || '') : '';
    const parts = [];
    const title = install.running
      ? localModelT('{model} is ready on this Mac.', { model })
      : localModelT('{model} is installed on this Mac.', { model });
    parts.push(localModelEl('p', 'lm-title', title));

    // The measured facts, in one line: what the runtime reported when the install checked it.
    const loaded = install.loaded || {};
    const facts = { context: localModelCount(loaded.context ?? install.context), memory: loaded.memoryGb };
    let line = '';
    if (loaded.memoryGb && loaded.onGpu === true) {
      line = localModelT('Context {context} tokens. Takes {memory} GB of memory when loaded, all on the GPU.', facts);
    } else if (loaded.memoryGb) {
      line = localModelT('Context {context} tokens. Takes {memory} GB of memory when loaded.', facts);
    } else if (facts.context) {
      line = localModelT('Context {context} tokens.', facts);
    }
    const state = localModelEl('div', 'lm-state');
    const dot = localModelEl('span', install.running ? 'lm-dot lm-dot-on' : 'lm-dot');
    dot.setAttribute('aria-hidden', 'true');
    state.appendChild(dot);
    state.appendChild(
      localModelEl('span', 'lm-state-text', install.running ? localModelT('Running') : localModelT('Stopped'))
    );
    parts.push(state);
    const about = [];
    if (install.cliLabel) about.push(localModelT('Runs with {cli}.', { cli: String(install.cliLabel) }));
    if (line) about.push(line);
    if (about.length) parts.push(localModelEl('p', 'lm-aside', about.join(' ')));

    // Something blocks a session: the server's sentence. Its one action is the main button below.
    const error = install.error;
    if (error) parts.push(this._localModelErrorEl(error));

    if (ui.confirmRemove) {
      parts.push(this._localModelRemoveEl());
      return parts;
    }
    const tools = this._localModelDeveloperToolsEl();
    if (tools) parts.push(tools);
    const notice = this._localModelNoticeEl();
    if (notice) parts.push(notice);

    const can = (action) => install.actions.includes(action);
    const next = error ? this._localModelNextButton(install, error) : null;
    const foot = localModelEl('div', 'lm-foot');
    const buttons = localModelEl('div', 'lm-buttons');
    if (can('remove') && error?.next !== 'remove') {
      buttons.appendChild(
        localModelButton(localModelT('Remove'), {
          key: 'remove',
          disabled: ui.busy,
          onClick: () => void this.removeLocalModel(),
        })
      );
    }
    if (can('stop')) {
      buttons.appendChild(
        localModelButton(localModelT('Stop'), {
          key: 'stop',
          disabled: ui.busy,
          onClick: () => void this.setLocalModelRuntime('stop'),
        })
      );
    }
    // Start is the main action of a stopped model, unless the error's own button says so already.
    if (can('start') && !(error && (error.next === 'start' || error.next === 'other-port'))) {
      buttons.appendChild(
        localModelButton(localModelT('Start'), {
          key: can('start-session') || next ? 'start' : 'primary',
          primary: !can('start-session') && !next,
          disabled: ui.busy,
          onClick: () => void this.setLocalModelRuntime('start'),
        })
      );
    }
    if (next) buttons.appendChild(next);
    if (can('start-session')) {
      buttons.appendChild(
        localModelButton(localModelT('Start a session'), {
          key: 'primary',
          primary: !next,
          disabled: ui.busy,
          onClick: () => void this.startLocalModelSession(),
        })
      );
    }
    if (buttons.childElementCount) foot.appendChild(buttons);
    parts.push(foot);
    return parts;
  },

  /** No model fits: the hardware line, the reason in the server's sentence, and Close. */
  _buildLocalModelNone() {
    const status = this._localModelStatus;
    const parts = [];
    const hw = status.recommendation.reason === 'not-macos' ? null : this._localModelHardwareEl();
    if (hw) parts.push(hw);
    const reason = localModelMessage(status.recommendation.headline);
    if (reason) parts.push(localModelEl('p', 'lm-reason', reason));
    const notice = this._localModelNoticeEl();
    if (notice) parts.push(notice);
    const foot = localModelEl('div', 'lm-foot');
    const buttons = localModelEl('div', 'lm-buttons');
    buttons.appendChild(
      localModelButton(localModelT('Close'), { key: 'primary', onClick: () => this.closeLocalModelWindow() })
    );
    foot.appendChild(buttons);
    parts.push(foot);
    return parts;
  },

  /** Listeners that outlive a render, wired once. */
  _wireLocalModel() {
    if (this._localModelWired) return;
    this._localModelWired = true;
    // Every surface is data-i18n-skip (see @fileoverview), so the DOM translator never revisits
    // them: a language or display-name change has to repaint them from here.
    if (typeof MutationObserver === 'function' && document.documentElement) {
      const observer = new MutationObserver(() => {
        this._forgetLocalModelPaint();
        this.renderLocalModel();
      });
      observer.observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] });
    }
    // The real role can arrive after the first render (admin-ui.js fetches /api/me): a non-admin
    // loses the button and the group, and an admin the page had taken for one is asked for at last.
    document.addEventListener?.('codeman:me', () => void this.loadLocalModel());
  },
});
