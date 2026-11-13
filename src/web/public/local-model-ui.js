/**
 * @fileoverview "Run a model on this Mac": the welcome button, the chooser window and the row in
 * App Settings > Models.
 *
 * Reads `GET /api/local-model` (the hardware of the machine the server runs on, the
 * recommendation, and `install`: where the install stands and what can be done about it) and
 * drives the install verbs:
 *
 *   POST   /api/local-model/install   { modelId, cli, context, acknowledgedBytes }
 *   POST   /api/local-model/use       { modelId }
 *   POST   /api/local-model/cancel
 *   POST   /api/local-model/resume    { newPort? }
 *   POST   /api/local-model/runtime   { action: 'start' | 'stop', newPort? }
 *   DELETE /api/local-model           { removeModel }
 *   DELETE /api/local-model/models    { modelId }
 *   POST   /api/local-model/agent     { cli }
 *
 * ## Three surfaces, one window
 *
 *  - Welcome screen: ONE large button (`#welcomeLocalModelBtn`) above the launchers, on the chip
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
 *    |             | coding agent, "Install on this Mac". Also from an installed       |
 *    |             | model ("Add a model"): a row that is on this Mac already says so  |
 *    |             | and is switched to without a download                             |
 *    | `confirm`   | after that button: the download as a table with its total, where  |
 *    |             | it goes                                                           |
 *    | `progress`  | installing: the download bar, the steps, Cancel                   |
 *    | `paused`    | paused (Cancel or a server restart): Continue or Remove           |
 *    | `failed`    | failed: the server's sentence and the ONE action that helps       |
 *    | `installed` | installed: running or stopped, the coding agents a session can be |
 *    |             | started with, the models on this Mac with their size on disk      |
 *    |             | (Use, Delete), Add a model, Start a session (or "Install <agent>" |
 *    |             | for one that is not on this Mac), Stop/Start, Remove (right after |
 *    |             | an install: Start a session alone)                                |
 *    | `none`      | idle and nothing fits: the hardware line, the reason, Close       |
 *
 * The memory bar is the one strong element: the memory this Mac can give a model, filled to
 * what the selected model needs at its PEAK (`budgetShare`). Selecting another row moves the
 * fill. The legend under it and the line of an installed model use the same words for that
 * peak, so the two figures a person meets (what the model takes now, what it can take) are
 * never read as a contradiction.
 *
 * The window is ONE frame for the whole flow: the header and the foot (`#localModelWindowFoot`,
 * the buttons) stay where they are and only the body between them changes and scrolls, so a
 * button never moves away from under the pointer and is never cut off.
 *
 * The rows of the chooser are the server's: its pick first, then the other models by download
 * size, largest first, which is a column the reader can see. The server's own order of the
 * alternatives is its ranking (what it would offer next), not a reading order.
 *
 * The models on this Mac (`install.library`) are a list of their own, on the installed screen
 * and on a paused or failed one that has a model to go back to: the model in use first, each
 * with its size on disk and the two things a row can offer, "Use" (a switch, nothing is
 * downloaded) and "Delete" (asked once, in the row). Under it the disk use of all downloaded
 * models (`install.store`) and "Add a model". A row has a button only for an action the server
 * lists for THAT row (`row.actions`).
 *
 * The coding agent is chosen per session (`install.harnesses`): on the installed screen every
 * agent the model can be run with is a chip of one radio group, the server's default first.
 * The main button follows the selected chip: "Start a session" for one that can be started,
 * "Install <agent>" for one that is not on this Mac (its literal install command is on screen
 * above the button, so the click is the consent), and nothing to press for one that needs a
 * setup of its own. An install of an agent runs beside the model: the state stays `installed`,
 * and another agent can be started meanwhile. The device remembers the agent a session was
 * last STARTED with, and each opening of the window selects it while it can be started (a
 * chip that was only looked at is not a choice, or the window would reopen on "Install").
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
 *  - Sizes are printed exactly as sent (`downloadGb`, `installGb`, `completedGb`, `totalGb`,
 *    `memoryGb`: decimal GB as text). Bytes are never turned into a size here. The one figure
 *    that is rounded is the memory estimate beside the bar and in the installed line: it says
 *    "about", so it is printed in whole GB from the server's own text (`needGb`, `budgetGb`).
 *    The installed memory alone is `memClassGb`, the size the Mac is sold as. The byte
 *    figures this file does read are the consent total (sent back unchanged as
 *    `acknowledgedBytes`), the two ends of a bar and the download size the rows are ordered by.
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

/** What `confirmDelete` holds while the question is about everything an earlier Remove kept. No model id has a space. */
const LOCAL_MODEL_STORE_KEY = 'the store';

/** Where this device remembers the coding agent last chosen for a session (a CLI id, as data). */
const LOCAL_MODEL_AGENT_STORAGE_KEY = 'codeman-local-model-agent';

/** The tag kinds of the server's pick (`CandidateTagKind`): the ones drawn in the accent colour. */
const LOCAL_MODEL_ACCENT_TAGS = ['tested', 'best', 'best-tight'];

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

/**
 * The rows of the chooser: the server's pick first, then the other models that fit by download
 * size, largest first. The download is a column of the list, so the order can be read off the
 * screen; the server sends the alternatives in its own ranking, which no column shows.
 */
function localModelCandidates(status) {
  const recommendation = (status && status.recommendation) || {};
  if (recommendation.verdict === 'none' || !recommendation.pick) return [];
  const rest = (Array.isArray(recommendation.alternatives) ? recommendation.alternatives : []).filter(
    (row) => row && typeof row.modelId === 'string'
  );
  const bytes = (row) => (Number.isFinite(row.downloadBytes) ? row.downloadBytes : 0);
  // A stable sort: rows of one size keep the server's order.
  const bySize = rest
    .map((row, index) => ({ row, index }))
    .sort((a, b) => bytes(b.row) - bytes(a.row) || a.index - b.index);
  return [recommendation.pick, ...bySize.map((entry) => entry.row)].filter(
    (row) => row && typeof row.modelId === 'string'
  );
}

/**
 * Whether the job of `install` is a switch to a model that is on this Mac already: its steps
 * hold no download. The steps are the server's; nothing is compared with a model or an agent.
 */
function localModelIsSwitch(install) {
  const steps = Array.isArray(install.steps) ? install.steps : [];
  return steps.length > 0 && !steps.includes('model');
}

/** The rows of `install.library`: the models on this Mac. A payload without the list has none. */
function localModelLibrary(install) {
  return (Array.isArray(install.library) ? install.library : []).filter((row) => row && typeof row.id === 'string');
}

/** What a library row's state is called, and the tag class that colours it. */
function localModelLibraryTag(row) {
  if (row.active === true) return { text: localModelT('In use'), kind: 'inuse' };
  if (row.status === 'ready') return { text: localModelT('Ready'), kind: 'ready' };
  if (row.status === 'changed') return { text: localModelT('Changed'), kind: 'changed' };
  if (row.status === 'missing') return { text: localModelT('Missing'), kind: 'missing' };
  return { text: localModelT('Not checked'), kind: 'unverified' };
}

/** The rows of `install.harnesses`: the coding agents the model in use can be run with. A payload without the list has none. */
function localModelAgents(install) {
  return (Array.isArray(install.harnesses) ? install.harnesses : []).filter(
    (row) => row && typeof row.cli === 'string' && row.cli
  );
}

/** What an agent chip says beside the name, and the tag class that colours it. Nothing for one that can be started. */
function localModelAgentTag(row) {
  if (row.status === 'installing') return { text: localModelT('Installing'), kind: 'tight' };
  if (row.status === 'installable') return { text: localModelT('Not installed'), kind: 'unverified' };
  if (row.status === 'setup-needed') return { text: localModelT('Needs setup'), kind: 'unverified' };
  return null;
}

/** The coding agent this device chose last, or '' (storage can be empty or refused: the default agent stands then). */
function localModelStoredAgent() {
  try {
    const value = window.localStorage.getItem(LOCAL_MODEL_AGENT_STORAGE_KEY);
    return typeof value === 'string' ? value : '';
  } catch {
    return '';
  }
}

function localModelStoreAgent(cli) {
  try {
    window.localStorage.setItem(LOCAL_MODEL_AGENT_STORAGE_KEY, String(cli));
  } catch {
    /* a convenience only */
  }
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

/**
 * A memory estimate in whole GB, from the server's decimal GB text ('36.0' is '36'). Only for
 * a figure that says "about": an estimate printed to the decimal reads as a measurement.
 * Text that is no number is returned as it is.
 */
function localModelWholeGb(value) {
  const number = Number(value);
  return typeof value === 'string' && value !== '' && Number.isFinite(number)
    ? String(Math.round(number))
    : String(value ?? '');
}

/**
 * A sentence group split after its first sentence: `[first, rest]`. The first is what a
 * headline carries; the rest is read in the body size. Works on the translated text, so both
 * the Latin full stop (followed by a space) and the ideographic one end a sentence.
 */
function localModelSentences(text) {
  const value = String(text ?? '').trim();
  const match = /^(.+?(?:[.!?](?=\s)|[。！？]))\s*(.+)$/su.exec(value);
  return match ? [match[1], match[2]] : [value, ''];
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

/**
 * The memory map: one bar for what this Mac can give a model, split into what the selected
 * model takes of it. The track that stays is what stays free. A candidate without its parts
 * (`memory`) gets one plain fill.
 */
function localModelMemoryBar(candidate, budgetBytes, last, label) {
  const percent = (bytes) => (budgetBytes > 0 ? Math.max(0, (bytes / budgetBytes) * 100) : 0);
  const parts = candidate.memory;
  const bar = localModelBar({ share: candidate.budgetShare, role: 'meter', kind: 'memory', from: last.memory, label });
  if (!parts) return bar;
  const fills = [
    ['model', parts.modelBytes],
    ['context', parts.contextBytes],
    ['peak', parts.peakBytes],
  ];
  bar.replaceChildren(
    ...fills.map(([name, bytes]) => {
      const to = Math.min(100, Math.round(percent(bytes) * 10) / 10);
      const fill = localModelEl('div', `lm-bar-fill lm-part-${name}`);
      fill.dataset.kind = `memory-${name}`;
      fill.dataset.to = String(to);
      const from = last[fill.dataset.kind];
      fill.style.width = `${Number.isFinite(from) ? from : to}%`;
      return fill;
    })
  );
  return bar;
}

/** The legend under the memory map: a swatch, what it stands for and its size in whole GB. */
function localModelMemoryParts(candidate, budgetBytes) {
  const parts = candidate.memory;
  if (!parts) return null;
  const gb = (bytes) => localModelGb(String(Math.round(Math.max(0, bytes) / 1e9)));
  const free = budgetBytes - parts.modelBytes - parts.contextBytes - parts.peakBytes;
  const rows = [
    ['model', localModelT('The model'), parts.modelBytes],
    [
      'context',
      localModelT('Context, {context} tokens', { context: localModelCount(candidate.context) }),
      parts.contextBytes,
    ],
    ['peak', localModelT('Brief peaks'), parts.peakBytes],
    ['free', localModelT('Stays free'), free],
  ];
  const legend = localModelEl('div', 'lm-legend');
  for (const [name, text, bytes] of rows) {
    const item = localModelEl('span', 'lm-legend-item');
    item.appendChild(localModelEl('span', `lm-swatch lm-part-${name}`));
    item.appendChild(localModelEl('span', 'lm-legend-name', text));
    item.appendChild(localModelEl('span', 'lm-legend-size', gb(bytes)));
    legend.appendChild(item);
  }
  return legend;
}

/** The size tile of a model row: its billions of parameters, coloured by how large it is. */
function localModelTile(candidate) {
  const size = Number(candidate.paramsB);
  if (!Number.isFinite(size) || size <= 0) return localModelEl('span', 'lm-tile');
  const tone = size >= 30 ? 'large' : size >= 15 ? 'mid' : 'small';
  const tile = localModelEl('span', `lm-tile lm-tile-${tone}`, `${Math.floor(size)}B`);
  tile.setAttribute('aria-hidden', 'true');
  return tile;
}

/**
 * One row of the confirm screen's table: what is fetched, how large it is, and under the name
 * a second line that says what it is (`note`) and, for a coding agent, the literal command of
 * its installer (`command`). A row without a size (the coding agent: its installer decides)
 * has none.
 */
function localModelSizeRow(label, { gb, note, command, strong = false } = {}) {
  const row = localModelEl('div', strong ? 'lm-size-row lm-size-total' : 'lm-size-row');
  const what = localModelEl('div', 'lm-size-what');
  what.appendChild(localModelEl('span', 'lm-size-name', label));
  if (note) what.appendChild(localModelEl('span', 'lm-size-note', note));
  if (command) what.appendChild(localModelEl('code', 'lm-command', command));
  row.appendChild(what);
  if (gb) row.appendChild(localModelEl('span', 'lm-size-gb', localModelGb(gb)));
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
    this._noteLocalModelInstall(data.install);
    this._localModelStatus = data;
    this._localModelState = 'ready';
    this._localModelLoadedAt = Date.now();
    this.renderLocalModel();
  },

  /**
   * Called with the `install` object that is about to replace the one on screen. An install
   * that was running and is installed now finished in front of the person: the window then
   * shows the screen that ends it (see `justInstalled`). A switch is the exception: it ends
   * on the whole installed screen, list of models included. Any other state ends that moment.
   */
  _noteLocalModelInstall(next) {
    const ui = this._localModelWindowState();
    const last = localModelInstall(this._localModelStatus);
    const before = last.state;
    const after = next && typeof next.state === 'string' ? next.state : 'idle';
    // A switch downloads nothing (its job has no `model` step). The person pressed Use in the
    // list of models, so it ends on that list, with "In use" on the other row: the screen
    // that ends an install would take the list away from someone who came to tidy it.
    const switched = Array.isArray(last.steps) && !last.steps.includes('model');
    if (after !== 'installed') ui.justInstalled = false;
    else if (before === 'installing' && ui.open) ui.justInstalled = !switched;
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
        /**
         * The coding agent chosen for a session on the installed model (a CLI id, as data), or
         * null: what this device chose last, else the server's default.
         */
        agent: null,
        /** A verb is in flight: every button waits. */
        busy: false,
        /** What the last verb answered when it was refused. */
        notice: null,
        /** After a 409 `size-changed`: the server's own total for the row, to show and to send. */
        expected: null,
        /** The Remove question is open, and whether the downloaded model goes too. */
        confirmRemove: false,
        removeModel: true,
        /**
         * The Delete question of one row is open: that row's model id, or `LOCAL_MODEL_STORE_KEY`
         * for the downloaded models an earlier Remove kept.
         */
        confirmDelete: null,
        /**
         * An install (a job that downloaded a model) finished while this window was open:
         * the screen that ends it shows "Start a session" alone. Stop and Remove belong to
         * the window opened later. Never set by a switch (`_noteLocalModelInstall`).
         */
        justInstalled: false,
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

  /**
   * The coding agents of the installed model and the one a session would start with: the chip
   * selected in this opening of the window, else the agent this device last STARTED a session
   * with while it can still be started, else the server's default (its first row). A
   * remembered agent that is not startable now never wins: the window would open on "Install"
   * or on nothing to press, with "Start a session" out of sight. `row` is null when the server
   * lists none.
   */
  _localModelAgent() {
    const ui = this._localModelWindowState();
    const rows = localModelAgents(localModelInstall(this._localModelStatus));
    const stored = ui.agent ? '' : localModelStoredAgent();
    const row =
      rows.find((entry) => entry.cli === ui.agent) ||
      rows.find((entry) => entry.cli === stored && entry.status === 'ready') ||
      rows.find((entry) => entry.default === true) ||
      rows[0];
    return { rows, row: row || null };
  },

  /** Which screen the window shows, see the table in @fileoverview. */
  _localModelScreen() {
    const ui = this._localModelWindowState();
    const install = localModelInstall(this._localModelStatus);
    const selection = this._localModelSelection();
    if (install.state === 'installing') return 'progress';
    const canInstall = install.actions.includes('install') && !!selection;
    // The chooser is also where a second model is added to an installed one.
    if (canInstall && (ui.view === 'choose' || ui.view === 'confirm')) return ui.view;
    if (install.state === 'installed') return 'installed';
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
    Object.assign(ui, {
      open: true,
      view: 'auto',
      busy: false,
      notice: null,
      expected: null,
      // A chip that was only looked at in an earlier opening is not a choice: each opening
      // starts from the agent last STARTED on this device, else the server's default.
      agent: null,
      confirmRemove: false,
      confirmDelete: null,
      justInstalled: false,
    });
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
      this._noteLocalModelInstall(data);
      if (this._localModelStatus) this._localModelStatus = { ...this._localModelStatus, install: data };
      result = { ok: true, view: data };
    } else if (res?.status === 409 && data) {
      ui.notice = { message: data.message, sessions: data.sessions };
      result = { ok: false, conflict: data };
    } else if (res && data && data.message && typeof data.message.text === 'string') {
      // A refusal the server names (a 400, a full disk) carries its sentence with the slots
      // apart, like a 409, so it is printed in the window's own language.
      ui.notice = { message: data.message };
      result = { ok: false };
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

  /** Back to the chooser (from the confirm screen, to pick another model after a stop, or to add one). */
  chooseLocalModel(modelId) {
    const ui = this._localModelWindowState();
    Object.assign(ui, { view: 'choose', notice: null, expected: null, confirmRemove: false, confirmDelete: null });
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

  /**
   * "Use": switch to a model that is on this Mac already. Nothing is downloaded, so there is
   * no confirm screen: the server loads and checks the model again and connects it.
   */
  async useLocalModel(modelId) {
    const ui = this._localModelWindowState();
    ui.confirmDelete = null;
    const result = await this._localModelVerb('POST', '/api/local-model/use', { modelId });
    // Started, or refused with the server's sentence: either way the state's own screen says it.
    if (result.ok || result.conflict) ui.view = 'auto';
    this.renderLocalModel();
  },

  /** "Delete" of one row: first the question in the row, then (with `confirmed`) the delete. */
  async deleteLocalModelEntry(modelId, { confirmed = false } = {}) {
    const ui = this._localModelWindowState();
    if (!confirmed) {
      Object.assign(ui, { confirmDelete: modelId, confirmRemove: false, notice: null });
      this.renderLocalModel();
      // On the safe answer, whatever had the focus (a click does not move it in every browser).
      this._focusLocalModelWindow('delete-no');
      return;
    }
    await this._localModelVerb('DELETE', '/api/local-model/models', { modelId });
    ui.confirmDelete = null;
    this.renderLocalModel();
  },

  /** "Delete them": the downloaded models an earlier Remove kept, while nothing is installed. */
  async deleteLocalModelStore({ confirmed = false } = {}) {
    const ui = this._localModelWindowState();
    if (!confirmed) {
      Object.assign(ui, { confirmDelete: LOCAL_MODEL_STORE_KEY, notice: null });
      this.renderLocalModel();
      this._focusLocalModelWindow('delete-no');
      return;
    }
    await this._localModelVerb('DELETE', '/api/local-model', { removeModel: true });
    ui.confirmDelete = null;
    this.renderLocalModel();
  },

  /** Leave a Delete question without deleting. The focus goes back to the button that asked. */
  keepLocalModelEntry() {
    const ui = this._localModelWindowState();
    const asked = ui.confirmDelete;
    Object.assign(ui, { confirmDelete: null, notice: null });
    this.renderLocalModel();
    if (asked) this._focusLocalModelWindow(asked === LOCAL_MODEL_STORE_KEY ? 'store-delete' : `delete:${asked}`);
  },

  /**
   * Select a coding agent for the next session. Nothing is sent, and nothing is remembered
   * yet: a chip can be selected just to see what installing it would run. The device
   * remembers an agent once a session was started with it.
   */
  selectLocalModelAgent(cli) {
    const ui = this._localModelWindowState();
    if (ui.busy || typeof cli !== 'string' || !cli) return;
    ui.agent = cli;
    ui.notice = null;
    this.renderLocalModel();
  },

  /**
   * "Install <agent>": the consent click for the command shown above the button. The server
   * runs its own stock command for that agent, never text from here, and answers at once: the
   * install goes on beside the model and the next polls say how it stands.
   */
  installLocalModelAgent(cli) {
    return this._localModelVerb('POST', '/api/local-model/agent', { cli });
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
      Object.assign(ui, { confirmRemove: true, confirmDelete: null, notice: null });
      this.renderLocalModel();
      return;
    }
    const result = await this._localModelVerb('DELETE', '/api/local-model', { removeModel: ui.removeModel === true });
    if (result.ok) Object.assign(ui, { confirmRemove: false, view: 'auto', modelId: null, cli: null });
    this.renderLocalModel();
  },

  /**
   * "Start a session": a session on the saved connection with a coding agent: `cli` (the
   * chip that is selected), or without one the server's default agent (`install.cli`).
   * The page's own copies are stale right after an install (the settings flag was switched on
   * by the server and the agent may have been installed a moment ago), so both are read again
   * before the existing launcher runs. Both values are the payload's; no id is compared.
   */
  async startLocalModelSession(cli) {
    const install = localModelInstall(this._localModelStatus);
    const agent = typeof cli === 'string' && cli ? cli : install.cli;
    if (typeof agent !== 'string' || typeof install.endpointId !== 'string') return;
    // The agent a session was started with is the one the next opening selects.
    if (typeof cli === 'string' && cli) localModelStoreAgent(cli);
    const settingsOpen = document.getElementById('appSettingsModal')?.classList.contains('active');
    this.closeLocalModelWindow();
    if (settingsOpen) this.closeAppSettings?.();
    await this.loadAppSettingsFromServer?.();
    await this.loadCliListForSettings?.();
    await this.selectCustomModelEntry?.(agent, install.endpointId);
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
    const switching = localModelIsSwitch(install);
    if (install.state === 'installing') {
      return switching ? localModelT('Switching to {model}', { model }) : localModelT('Installing {model}', { model });
    }
    if (install.state === 'paused') {
      return switching
        ? localModelT('The switch to {model} is paused', { model })
        : localModelT('The install of {model} is paused', { model });
    }
    if (install.state === 'failed') {
      return switching
        ? localModelT('The switch to {model} stopped', { model })
        : localModelT('The install of {model} stopped', { model });
    }
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
      const moved = this._localModelDownloadMeter(screen, last);
      if (moved) {
        meter.replaceWith(moved);
        this._settleLocalModelBars(body);
        return;
      }
    }
    this._localModelFrameKey = frame;

    const modal = document.getElementById('localModelModal');
    const active = document.activeElement;
    const inside = !!(modal && active && modal.contains(active));
    const focusKey = inside && active.dataset ? active.dataset.lmKey : undefined;
    const scrolled = body.dataset.screen === screen ? body.scrollTop : 0;
    const parts = this._buildLocalModelScreen(screen, last);
    // The buttons (or the Remove question) are the last part a screen builds. They go into
    // the foot of the frame, outside the part that scrolls, so they stay in one place.
    const foot = document.getElementById('localModelWindowFoot');
    const tail = parts[parts.length - 1];
    const actions =
      foot && tail && tail.classList && (tail.classList.contains('lm-foot') || tail.classList.contains('lm-remove'));
    body.dataset.screen = screen;
    body.replaceChildren(...(actions ? parts.slice(0, -1) : parts));
    // A screen that carries the list of models starts at the top and scrolls (see styles.css).
    body.dataset.long = body.querySelector('.lm-library') ? 'true' : 'false';
    if (foot) foot.replaceChildren(...(actions ? [tail] : []));
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
    // The body and the foot: a screen's controls live in both.
    const keyed = [...modal.querySelectorAll('[data-lm-key]')].filter((el) => !el.disabled);
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

  /** One model row of the chooser: radio, size tile, name, tag, speed with its gauge, download. */
  _localModelRow(candidate, { checked, tabStop, topSpeed }) {
    const row = localModelEl('div', 'lm-model');
    row.setAttribute('role', 'radio');
    row.setAttribute('aria-checked', checked ? 'true' : 'false');
    row.setAttribute('tabindex', tabStop ? '0' : '-1');
    row.dataset.lmKey = 'model';
    row.dataset.modelId = candidate.modelId;
    row.appendChild(localModelEl('span', 'lm-radio'));
    if (checked) row.classList.add('lm-model-on');
    row.appendChild(localModelTile(candidate));
    row.appendChild(localModelEl('span', 'lm-model-name', String(candidate.modelLabel || candidate.modelId)));
    const tagSlot = localModelEl('span', 'lm-model-tag');
    const label = candidate.tag && typeof candidate.tag.label === 'string' ? candidate.tag.label : '';
    if (label) {
      const tag = localModelEl('span', 'lm-tag', localModelT(label));
      // The tags of the row the window opens on take the accent. Every other tag is quiet.
      if (LOCAL_MODEL_ACCENT_TAGS.includes(candidate.tag.kind)) tag.classList.add('lm-tag-accent');
      tag.classList.add(`lm-tag-${candidate.tag.kind}`);
      tagSlot.appendChild(tag);
    }
    // Already on this Mac: choosing it switches to it, and nothing is downloaded.
    if (candidate.library === 'active') {
      tagSlot.appendChild(localModelEl('span', 'lm-tag lm-tag-inuse', localModelT('In use')));
    } else if (candidate.library === 'ready') {
      tagSlot.appendChild(localModelEl('span', 'lm-tag lm-tag-ready', localModelT('On this Mac')));
    }
    row.appendChild(tagSlot);
    const speed = localModelEl('span', 'lm-model-speed', localModelSpeedText(candidate));
    const gauge = localModelEl(
      'span',
      `lm-gauge lm-gauge-${candidate.speed === 'slow' ? 'slow' : candidate.speed === 'ok' ? 'ok' : 'unknown'}`
    );
    const fast = Number(candidate.tokensPerSecond);
    if (Number.isFinite(fast) && topSpeed > 0) {
      const needle = localModelEl('span', 'lm-gauge-fill');
      needle.style.width = `${Math.max(6, Math.round((fast / topSpeed) * 100))}%`;
      gauge.appendChild(needle);
    }
    speed.appendChild(gauge);
    row.appendChild(speed);
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
    // An estimate, so whole GB: "about 36 of 38", never an estimate to the decimal.
    const sizes = { need: localModelWholeGb(candidate.needGb), budget: localModelWholeGb(recommendation.budgetGb) };
    head.appendChild(localModelEl('span', 'lm-figure', localModelT('About {need} of {budget} GB of memory', sizes)));
    // A formula's figure says so, once. A wired limit and the runtime's own figure are facts.
    if (recommendation.budgetSource === 'estimated') {
      head.appendChild(localModelEl('span', 'lm-figure-aside', localModelT('estimated')));
    }
    const fitWord =
      candidate.fit === 'tight' ? localModelT('Tight fit') : candidate.fit === 'good' ? localModelT('Good fit') : '';
    if (fitWord) head.appendChild(localModelEl('span', `lm-fit lm-fit-${candidate.fit}`, fitWord));
    meter.appendChild(head);
    const share = String(Math.round((Number.isFinite(candidate.budgetShare) ? candidate.budgetShare : 0) * 100));
    // The bar is the model at its PEAK, split into what makes that peak.
    meter.appendChild(
      localModelMemoryBar(
        candidate,
        Number(recommendation.budgetBytes),
        last,
        localModelT('The selected model needs {share}% of the memory this Mac can give a model', { share })
      )
    );
    const legend = localModelMemoryParts(candidate, Number(recommendation.budgetBytes));
    if (legend) meter.appendChild(legend);
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
    const topSpeed = Math.max(0, ...candidates.map((row) => Number(row.tokensPerSecond) || 0));
    for (const row of candidates) {
      const checked = row === candidate;
      const el = this._localModelRow(row, { checked, tabStop: checked, topSpeed });
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
    if (harness.installed === false) hints.push(localModelT('Not on this Mac yet. Codeman installs it for you.'));
    if (harness.slowFirstTurn === true) hints.push(localModelT('The first answer can take minutes.'));
    if (hints.length) runs.appendChild(localModelEl('span', 'lm-runs-hint', hints.join(' ')));
    parts.push(runs);

    // Nothing is installed, and an earlier Remove kept its downloads: what they take, and the way to free it.
    const leftovers = this._localModelStoreEl(install);
    if (leftovers) parts.push(leftovers);

    const notice = this._localModelNoticeEl();
    if (notice) parts.push(notice);

    const foot = localModelEl('div', 'lm-foot');
    const promise = localModelT('No account and no API key. The model runs only on this Mac.');
    foot.appendChild(localModelEl('p', 'lm-foot-note', promise));
    const buttons = localModelEl('div', 'lm-buttons');
    // Reached from a paused or stopped install, or from an installed model: the way back to it.
    if (install.state !== 'idle') {
      buttons.appendChild(
        localModelButton(localModelT('Back'), { key: 'back', onClick: () => this.leaveLocalModelChooser() })
      );
    }
    if (candidate.library === 'active') {
      // The model that runs now: nothing to do with it here.
      buttons.appendChild(localModelButton(localModelT('In use'), { key: 'primary', primary: true, disabled: true }));
    } else if (candidate.library === 'ready' && install.actions.includes('use')) {
      buttons.appendChild(
        localModelButton(localModelT('Use this model'), {
          key: 'primary',
          primary: true,
          disabled: ui.busy,
          onClick: () => void this.useLocalModel(candidate.modelId),
        })
      );
    } else if (install.actions.includes('install')) {
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

  /**
   * The models on this Mac: one row per model of `install.library` with its name, the context
   * it was checked with, its state, its size on disk and what the server offers for it. A row
   * whose Delete was pressed is followed by the question, once, in place. `null` when there is
   * no row, or (with `onlyWithActions`, for a paused or failed job) no row offers anything.
   */
  _localModelLibraryEl(install, { onlyWithActions = false } = {}) {
    const ui = this._localModelWindowState();
    const rows = localModelLibrary(install);
    const offers = (row, action) => Array.isArray(row.actions) && row.actions.includes(action);
    if (!rows.length) return null;
    if (onlyWithActions && !rows.some((row) => offers(row, 'use') || offers(row, 'delete'))) return null;

    const section = localModelEl('div', 'lm-library');
    const list = localModelEl('div', 'lm-lib-list');
    list.setAttribute('role', 'list');
    list.setAttribute('aria-labelledby', 'localModelLibraryLabel');
    const caption = localModelEl('div', 'lm-lib-caption');
    const label = localModelEl('span', 'lm-lib-caption-label', localModelT('Models on this Mac'));
    label.id = 'localModelLibraryLabel';
    caption.appendChild(label);
    caption.appendChild(localModelEl('span', 'lm-lib-caption-size', localModelT('On disk')));
    list.appendChild(caption);

    for (const row of rows) {
      const name = String(row.label || row.id);
      const item = localModelEl('div', row.active === true ? 'lm-lib-row lm-lib-row-on' : 'lm-lib-row');
      item.setAttribute('role', 'listitem');
      const what = localModelEl('div', 'lm-lib-name');
      what.appendChild(localModelEl('span', 'lm-lib-label', name));
      if (Number.isFinite(row.context)) {
        what.appendChild(
          localModelEl(
            'span',
            'lm-lib-meta',
            localModelT('{context} tokens', { context: localModelCount(row.context) })
          )
        );
      }
      item.appendChild(what);
      const tag = localModelLibraryTag(row);
      const tagSlot = localModelEl('span', 'lm-lib-tag');
      tagSlot.appendChild(localModelEl('span', `lm-tag lm-tag-${tag.kind}`, tag.text));
      item.appendChild(tagSlot);
      item.appendChild(localModelEl('span', 'lm-lib-size', row.sizeGb ? localModelGb(row.sizeGb) : ''));

      const asking = ui.confirmDelete === row.id && offers(row, 'delete');
      const actions = localModelEl('span', 'lm-lib-actions');
      // While the row's question is open its buttons keep their place and are out of reach,
      // so the column of sizes does not move when the question opens.
      if (asking) {
        actions.classList.add('lm-lib-actions-away');
        actions.setAttribute('aria-hidden', 'true');
      }
      if (offers(row, 'use')) {
        const use = localModelButton(localModelT('Use'), {
          key: `use:${row.id}`,
          disabled: ui.busy || asking,
          onClick: () => void this.useLocalModel(row.id),
        });
        use.classList.add('lm-btn-row');
        use.setAttribute('aria-label', localModelT('Use {model}', { model: name }));
        actions.appendChild(use);
      }
      if (offers(row, 'delete')) {
        const remove = localModelButton(localModelT('Delete'), {
          key: `delete:${row.id}`,
          disabled: ui.busy || asking,
          onClick: () => void this.deleteLocalModelEntry(row.id),
        });
        remove.classList.add('lm-btn-row');
        remove.setAttribute('aria-label', localModelT('Delete {model}', { model: name }));
        actions.appendChild(remove);
      }
      item.appendChild(actions);
      list.appendChild(item);

      if (asking) {
        list.appendChild(
          this._localModelAskEl({
            question: localModelT('Delete {model} from this Mac?', { model: name }),
            detail: row.sizeGb ? localModelT('This frees {size} GB.', { size: row.sizeGb }) : '',
            onYes: () => void this.deleteLocalModelEntry(row.id, { confirmed: true }),
          })
        );
      }
    }
    section.appendChild(list);

    const foot = localModelEl('div', 'lm-lib-foot');
    const notes = localModelEl('div', 'lm-lib-notes');
    const store = install.store;
    if (store && Number(store.bytes) > 0 && store.gb) {
      notes.appendChild(
        localModelEl('p', 'lm-aside', localModelT('Downloaded models use {size} GB on this Mac.', { size: store.gb }))
      );
    }
    // Only the runtime deletes a model: with it stopped, the rows offer none, and this says why.
    if (install.state === 'installed' && install.running !== true && rows.length > 1) {
      notes.appendChild(localModelEl('p', 'lm-aside', localModelT('Press Start to delete a single model.')));
    }
    if (notes.childElementCount) foot.appendChild(notes);
    if (install.state === 'installed' && install.actions.includes('install') && this._localModelSelection()) {
      const add = localModelButton(localModelT('Add a model'), {
        key: 'add',
        disabled: ui.busy,
        onClick: () => this.chooseLocalModel(),
      });
      add.classList.add('lm-btn-row');
      foot.appendChild(add);
    }
    if (foot.childElementCount) section.appendChild(foot);
    return section;
  },

  /** A Delete question in place: the question, what it frees, Cancel and the red Delete. */
  _localModelAskEl({ question, detail, onYes }) {
    const ui = this._localModelWindowState();
    const ask = localModelEl('div', 'lm-lib-ask');
    ask.setAttribute('role', 'group');
    const text = localModelEl('div', 'lm-lib-ask-text');
    text.appendChild(localModelEl('p', 'lm-lead', question));
    if (detail) text.appendChild(localModelEl('p', 'lm-aside', detail));
    ask.appendChild(text);
    const buttons = localModelEl('div', 'lm-lib-actions');
    const no = localModelButton(localModelT('Cancel'), {
      key: 'delete-no',
      disabled: ui.busy,
      onClick: () => this.keepLocalModelEntry(),
    });
    no.classList.add('lm-btn-row');
    const yes = localModelButton(localModelT('Delete'), {
      key: 'delete-yes',
      danger: true,
      disabled: ui.busy,
      onClick: onYes,
    });
    yes.classList.add('lm-btn-row');
    buttons.appendChild(no);
    buttons.appendChild(yes);
    ask.appendChild(buttons);
    return ask;
  },

  /**
   * Nothing is installed and the model store still holds downloads (an earlier Remove kept
   * them): what they take on disk and "Delete them", asked once in place. `null` unless the
   * server offers that removal.
   */
  _localModelStoreEl(install) {
    const ui = this._localModelWindowState();
    const store = install.store;
    if (install.state !== 'idle' || !install.actions.includes('remove')) return null;
    if (!store || !(Number(store.bytes) > 0) || !store.gb) return null;
    if (ui.confirmDelete === LOCAL_MODEL_STORE_KEY) {
      const box = localModelEl('div', 'lm-leftovers');
      box.appendChild(
        this._localModelAskEl({
          question: localModelT('Delete the downloaded models from this Mac?'),
          detail: localModelT('This frees {size} GB.', { size: store.gb }),
          onYes: () => void this.deleteLocalModelStore({ confirmed: true }),
        })
      );
      return box;
    }
    const box = localModelEl('div', 'lm-leftovers lm-lib-foot');
    box.appendChild(
      localModelEl(
        'p',
        'lm-aside',
        localModelT('Models from an earlier install still use {size} GB on this Mac.', { size: store.gb })
      )
    );
    const remove = localModelButton(localModelT('Delete them'), {
      key: 'store-delete',
      disabled: ui.busy,
      onClick: () => void this.deleteLocalModelStore(),
    });
    remove.classList.add('lm-btn-row');
    box.appendChild(remove);
    return box;
  },

  /**
   * The coding agents a session on the installed model can be started with
   * (`install.harnesses`): one chip per agent, a radio group, and under it one line about the
   * selected one. For an agent that is not on this Mac that line is the literal install command
   * (the main button then reads "Install <agent>"), and after a failed install the server's
   * sentence with the installer's last words folded away. `null` when the server lists none.
   */
  _localModelAgentsEl() {
    const ui = this._localModelWindowState();
    const { rows, row: chosen } = this._localModelAgent();
    if (!rows.length || !chosen) return null;

    const section = localModelEl('div', 'lm-agents');
    const label = localModelEl('p', 'lm-agents-label', localModelT('Start a session with'));
    label.id = 'localModelAgentsLabel';
    section.appendChild(label);

    const group = localModelEl('div', 'lm-agent-list');
    group.setAttribute('role', 'radiogroup');
    group.setAttribute('aria-labelledby', 'localModelAgentsLabel');
    for (const row of rows) {
      const on = row === chosen;
      const chip = localModelEl('button', on ? 'lm-agent lm-agent-on' : 'lm-agent');
      chip.type = 'button';
      chip.setAttribute('role', 'radio');
      chip.setAttribute('aria-checked', on ? 'true' : 'false');
      // One tab stop for the group: the selected chip.
      chip.tabIndex = on ? 0 : -1;
      chip.dataset.lmKey = `agent:${row.cli}`;
      chip.disabled = ui.busy;
      const radio = localModelEl('span', 'lm-radio');
      radio.setAttribute('aria-hidden', 'true');
      chip.appendChild(radio);
      chip.appendChild(localModelEl('span', 'lm-agent-name', String(row.cliLabel || row.cli)));
      const tag = localModelAgentTag(row);
      if (tag) chip.appendChild(localModelEl('span', `lm-tag lm-tag-${tag.kind}`, tag.text));
      chip.addEventListener('click', () => this.selectLocalModelAgent(row.cli));
      group.appendChild(chip);
    }
    group.addEventListener('keydown', (event) => this._onLocalModelAgentKey(event));
    section.appendChild(group);

    const name = String(chosen.cliLabel || chosen.cli);
    const about = localModelEl('div', 'lm-agent-about');
    if (chosen.status === 'installable' || chosen.status === 'installing') {
      const lead =
        chosen.status === 'installing'
          ? localModelT('Installing {cli}. You can start a session with another agent meanwhile.', { cli: name })
          : localModelT('{cli} is not on this Mac yet. Codeman installs it with this command:', { cli: name });
      about.appendChild(localModelEl('p', 'lm-aside', lead));
      if (chosen.installCommand) about.appendChild(localModelEl('code', 'lm-command', String(chosen.installCommand)));
    } else if (chosen.status === 'setup-needed') {
      about.appendChild(
        localModelEl(
          'p',
          'lm-aside',
          localModelT(
            '{cli} needs a setup of its own. Set it up from the Run menu, then start a session with it here.',
            {
              cli: name,
            }
          )
        )
      );
    } else if (chosen.slowFirstTurn === true) {
      about.appendChild(localModelEl('p', 'lm-aside', localModelT('The first answer can take minutes.')));
    }
    // The last install of this agent failed: the server's sentence, and what the installer said.
    const error = chosen.status === 'installable' ? chosen.error : null;
    if (error && error.message) {
      const failed = localModelEl('div', 'lm-notice');
      failed.setAttribute('role', 'alert');
      failed.appendChild(localModelEl('p', 'lm-notice-text', localModelMessage(error.message)));
      if (typeof error.detail === 'string' && error.detail) {
        const details = localModelEl('details', 'lm-details');
        details.appendChild(localModelEl('summary', '', localModelT('Details')));
        details.appendChild(localModelEl('pre', 'lm-detail-text', error.detail));
        failed.appendChild(details);
      }
      about.appendChild(failed);
    }
    if (about.childElementCount) section.appendChild(about);
    return section;
  },

  /** Arrow keys, Home and End move the selection of the agent chips, and the focus with it. */
  _onLocalModelAgentKey(event) {
    const { rows, row } = this._localModelAgent();
    if (!rows.length || !row) return;
    const index = rows.indexOf(row);
    let next = -1;
    if (event.key === 'ArrowDown' || event.key === 'ArrowRight') next = (index + 1) % rows.length;
    else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') next = (index - 1 + rows.length) % rows.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = rows.length - 1;
    if (next < 0 || next === index) return;
    event.preventDefault();
    this.selectLocalModelAgent(rows[next].cli);
    this._focusLocalModelWindow(`agent:${rows[next].cli}`);
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

  /**
   * The confirm screen: the download as a table. One row per thing that is fetched (the chosen
   * model, the program that runs it while it is missing, the coding agent while it is
   * missing), each with what it is in a second line, and the total under them in the strong
   * weight. The table IS the screen; around it only where it goes and, on a Mac without the
   * developer tools, the one sentence about them.
   */
  _buildLocalModelConfirm() {
    const ui = this._localModelWindowState();
    const status = this._localModelStatus;
    const install = localModelInstall(status);
    const { candidate, harness } = this._localModelSelection();
    const parts = [];
    const hw = this._localModelHardwareEl();
    if (hw) parts.push(hw);

    const cli = String(harness.cliLabel || harness.cli);
    const sizes = localModelEl('div', 'lm-sizes');
    sizes.appendChild(localModelEl('h4', 'lm-heading', localModelT('What will be downloaded')));

    // The list collapses to the chosen row: it is the first row of the table.
    const about = localModelT('At {context} tokens of context, with {cli}', {
      cli,
      context: localModelCount(candidate.context),
    });
    sizes.appendChild(
      localModelSizeRow(String(candidate.modelLabel || candidate.modelId), { gb: candidate.downloadGb, note: about })
    );
    const runtime = install.runtime || {};
    if (runtime.installed !== true && Number(runtime.downloadBytes) > 0 && runtime.downloadGb) {
      sizes.appendChild(
        localModelSizeRow(localModelT('Ollama {version}', { version: runtime.version }), {
          gb: runtime.downloadGb,
          note: localModelT('The program that runs the model'),
        })
      );
    }
    // The coding agent, when it is missing: its own installer fetches it, with this literal command.
    if (harness.installed === false) {
      const note = harness.installCommand
        ? localModelT('Not on this Mac yet. Its own installer fetches it with this command:')
        : localModelT('Not on this Mac yet. Its own installer fetches it.');
      sizes.appendChild(
        localModelSizeRow(cli, { note, command: harness.installCommand ? String(harness.installCommand) : '' })
      );
    }
    const expected = ui.expected && ui.expected.modelId === candidate.modelId ? ui.expected : null;
    const total = expected ? expected.gb : candidate.installGb;
    if (total) sizes.appendChild(localModelSizeRow(localModelT('Total'), { gb: total, strong: true }));
    parts.push(sizes);

    if (install.folder) {
      const where = localModelEl('p', 'lm-where');
      where.appendChild(localModelEl('span', '', localModelT('Goes into')));
      where.appendChild(document.createTextNode(' '));
      where.appendChild(localModelEl('code', 'lm-path', String(install.folder)));
      parts.push(where);
    }
    const tools = this._localModelDeveloperToolsEl();
    if (tools) parts.push(tools);

    const notice = this._localModelNoticeEl();
    if (notice) parts.push(notice);

    const foot = localModelEl('div', 'lm-foot');
    foot.appendChild(localModelEl('p', 'lm-foot-note', localModelT('No administrator password.')));
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
   * The download bar and its figure: "6.2 of 23.1 GB", then the speed and the time left. The
   * bar means ONE thing, the model download: while the runtime is fetched (seconds) it stands
   * at the start with the size that is coming, it fills while the model arrives, and once the
   * model is in it is gone (`null`): the step list carries the rest.
   */
  _localModelDownloadMeter(screen, last) {
    const install = localModelInstall(this._localModelStatus);
    if (install.step !== 'runtime' && install.step !== 'model') return null;
    const paused = screen === 'paused';
    const progress = install.step === 'model' ? install.progress : null;
    const meter = localModelEl('div', 'lm-meter');
    const head = localModelEl('div', 'lm-meter-head');
    const label = localModelT('Download of the model');
    let share = 0;
    if (progress && Number(progress.totalBytes) > 0) {
      share = Number(progress.completedBytes) / Number(progress.totalBytes);
      const sizes = { done: progress.completedGb, total: progress.totalGb };
      head.appendChild(localModelEl('span', 'lm-figure lm-figure-count', localModelT('{done} of {total} GB', sizes)));
      const left = localModelTimeLeft(progress.secondsLeft);
      let rate = '';
      if (!paused && progress.mbPerSecond && left) {
        rate = localModelT('{speed} MB per second, {left}', { speed: progress.mbPerSecond, left });
      } else if (!paused && progress.mbPerSecond) {
        rate = localModelT('{speed} MB per second', { speed: progress.mbPerSecond });
      }
      if (rate) head.appendChild(localModelEl('span', 'lm-figure-aside', rate));
    } else {
      // Nothing of the model has arrived yet: the size that is coming, from the row it was chosen on.
      const row = localModelCandidates(this._localModelStatus).find(
        (candidate) => install.model && candidate.modelId === install.model.id
      );
      const text = row && row.downloadGb ? localModelT('0 of {total} GB', { total: row.downloadGb }) : label;
      head.appendChild(localModelEl('span', 'lm-figure lm-figure-count', text));
    }
    meter.appendChild(head);
    meter.appendChild(localModelBar({ share, role: 'progressbar', kind: 'download', from: last.download, label }));
    return meter;
  },

  /** Installing, and the same picture frozen: paused. */
  _buildLocalModelProgress(screen, last) {
    const ui = this._localModelWindowState();
    const install = localModelInstall(this._localModelStatus);
    const paused = screen === 'paused';
    const model = install.model ? String(install.model.label || install.model.id || '') : '';
    const parts = [];
    // A switch to a model that is on this Mac already downloads nothing, and says so in its name.
    const switching = localModelIsSwitch(install);
    let title;
    if (switching) {
      title = paused
        ? localModelT('The switch to {model} is paused', { model })
        : localModelT('Switching to {model}', { model });
    } else {
      title = paused
        ? localModelT('The install of {model} is paused', { model })
        : localModelT('Installing {model}', { model });
    }
    parts.push(localModelEl('p', 'lm-title', title));

    // The download bar takes the place of the memory bar, for as long as something downloads.
    const meter = this._localModelDownloadMeter(screen, last);
    if (meter) parts.push(meter);

    const list = this._localModelStepsEl(install, { stopped: paused });
    if (list) parts.push(list);

    if (ui.confirmRemove) {
      parts.push(this._localModelRemoveEl());
      return parts;
    }

    // What waits or goes on is the download while there is one, the install (or the switch) after it.
    const downloading = !!meter;
    let note;
    if (paused && switching) {
      note = localModelT('The switch waits until you continue.');
    } else if (paused) {
      note = downloading
        ? localModelT('The download waits until you continue.')
        : localModelT('The install waits until you continue.');
    } else if (switching) {
      note = localModelT('You can close this window. The switch continues while Codeman is running.');
    } else {
      note = downloading
        ? localModelT('You can close this window. The download continues while Codeman is running.')
        : localModelT('You can close this window. The install continues while Codeman is running.');
    }
    parts.push(localModelEl('p', 'lm-aside', note));
    // A paused job that has a checked model beside it: the way back to that model.
    const library = paused ? this._localModelLibraryEl(install, { onlyWithActions: true }) : null;
    if (library) parts.push(library);
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
   * It is the main button of the screen, except a removal, which never takes the accent.
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
      // The one action that helps, and still a removal: quiet here, red only in its question.
      return localModelButton(localModelT('Remove'), {
        key: 'primary',
        disabled: ui.busy,
        onClick: () => void this.removeLocalModel(),
      });
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

  /**
   * An error as the window shows it: the first sentence of the server's text as the headline,
   * what follows it in the body size, and the raw detail folded away.
   */
  _localModelErrorEl(error) {
    const box = localModelEl('div', 'lm-error');
    const [headline, rest] = localModelSentences(localModelMessage(error.message));
    box.appendChild(localModelEl('p', 'lm-title', headline));
    if (rest) box.appendChild(localModelEl('p', 'lm-lead', rest));
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
    // A checked model beside the one that stopped: the way back to it.
    const library = this._localModelLibraryEl(install, { onlyWithActions: true });
    if (library) parts.push(library);
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

  /**
   * The line of facts under an installed model: the context, what the model takes now (what
   * the runtime reported when the install checked it) and, in the words of the chooser's
   * legend, what it can take at its peak (the row's own estimate, so the two figures a person
   * meets are told apart instead of read as a contradiction).
   */
  _localModelFactsLine(install) {
    const loaded = install.loaded || {};
    const context = localModelCount(loaded.context ?? install.context);
    const row = localModelCandidates(this._localModelStatus).find(
      (candidate) =>
        install.model &&
        candidate.modelId === install.model.id &&
        candidate.context === (loaded.context ?? install.context)
    );
    const facts = { context, memory: loaded.memoryGb, peak: row ? localModelWholeGb(row.needGb) : '' };
    const sentences = [];
    if (context) sentences.push(localModelT('Context {context} tokens.', facts));
    if (loaded.memoryGb && facts.peak) {
      sentences.push(
        localModelT(
          'Takes {memory} GB of memory now, and up to about {peak} GB at its peak, with all of the context in use.',
          facts
        )
      );
    } else if (loaded.memoryGb) {
      sentences.push(localModelT('Takes {memory} GB of memory now.', facts));
    }
    if (loaded.memoryGb && loaded.onGpu === true) sentences.push(localModelT('All of it is on the GPU.'));
    return sentences.join(' ');
  },

  _buildLocalModelInstalled() {
    const ui = this._localModelWindowState();
    const install = localModelInstall(this._localModelStatus);
    const model = install.model ? String(install.model.label || install.model.id || '') : '';
    const error = install.error;
    const parts = [];

    // Something blocks a session: that sentence is the headline, not "is ready". Its one
    // action is the main button below.
    if (error) {
      parts.push(this._localModelErrorEl(error));
    } else {
      const title = install.running
        ? localModelT('{model} is ready on this Mac.', { model })
        : localModelT('{model} is installed on this Mac.', { model });
      parts.push(localModelEl('p', 'lm-title', title));
    }

    const state = localModelEl('div', 'lm-state');
    // Green says "a session can be started". A model that is blocked is not that.
    const dot = localModelEl('span', install.running && !error ? 'lm-dot lm-dot-on' : 'lm-dot');
    dot.setAttribute('aria-hidden', 'true');
    state.appendChild(dot);
    const running = install.running ? localModelT('Running') : localModelT('Stopped');
    state.appendChild(localModelEl('span', 'lm-state-text', error ? `${model}, ${running}` : running));
    parts.push(state);
    const about = [];
    // The agents have their own block below when the server lists them; without the list, the one of the install.
    const agent = this._localModelAgent().row;
    if (!agent && install.cliLabel) about.push(localModelT('Runs with {cli}.', { cli: String(install.cliLabel) }));
    const line = this._localModelFactsLine(install);
    if (line) about.push(line);
    if (about.length) parts.push(localModelEl('p', 'lm-aside', about.join(' ')));

    if (ui.confirmRemove) {
      parts.push(this._localModelRemoveEl());
      return parts;
    }
    const tools = this._localModelDeveloperToolsEl();
    if (tools) parts.push(tools);
    const notice = this._localModelNoticeEl();

    const can = (action) => install.actions.includes(action);
    const next = error ? this._localModelNextButton(install, error) : null;
    // The screen that ends an install has one button. Stop and Remove are for the window
    // opened later (or for this one once anything else was said in it).
    const ending = ui.justInstalled === true && can('start-session') && !error && !notice;
    // Which coding agent the next session runs with. Not on the screen that ends an install
    // (that one says one thing: the session starts with the agent that was just chosen), and
    // not while something blocks every session.
    const agents = ending || error ? null : this._localModelAgentsEl();
    if (agents) parts.push(agents);
    // Everything that is on this Mac, what it takes on disk, and the way to another model.
    // Not on the screen that ends an install: that one says one thing.
    const library = ending ? null : this._localModelLibraryEl(install);
    if (library) parts.push(library);
    if (notice) parts.push(notice);
    const foot = localModelEl('div', 'lm-foot');
    const buttons = localModelEl('div', 'lm-buttons');
    if (!ending && can('remove') && error?.next !== 'remove') {
      buttons.appendChild(
        localModelButton(localModelT('Remove'), {
          key: 'remove',
          disabled: ui.busy,
          onClick: () => void this.removeLocalModel(),
        })
      );
    }
    if (!ending && can('stop')) {
      buttons.appendChild(
        localModelButton(localModelT('Stop'), {
          key: 'stop',
          disabled: ui.busy,
          onClick: () => void this.setLocalModelRuntime('stop'),
        })
      );
    }
    // Start is the main action of a stopped model, unless the error's own button says so already.
    const startIsMain =
      can('start') &&
      !(error && (error.next === 'start' || error.next === 'other-port')) &&
      !can('start-session') &&
      !next;
    if (can('start') && !(error && (error.next === 'start' || error.next === 'other-port'))) {
      buttons.appendChild(
        localModelButton(localModelT('Start'), {
          key: startIsMain ? 'primary' : 'start',
          primary: startIsMain,
          disabled: ui.busy,
          onClick: () => void this.setLocalModelRuntime('start'),
        })
      );
    }
    if (next) buttons.appendChild(next);
    // The main button follows the selected coding agent, by what the server offers for it.
    const offers = (action) => !!agents && Array.isArray(agent?.actions) && agent.actions.includes(action);
    if (agents && agent && agent.status !== 'ready') {
      const name = String(agent.cliLabel || agent.cli);
      if (offers('install')) {
        buttons.appendChild(
          localModelButton(localModelT('Install {cli}', { cli: name }), {
            // A stopped model's main action is Start: installing an agent is the quiet one then.
            key: startIsMain ? 'agent-install' : 'primary',
            primary: !next && !startIsMain,
            disabled: ui.busy,
            onClick: () => void this.installLocalModelAgent(agent.cli),
          })
        );
      } else if (agent.status === 'installing') {
        buttons.appendChild(
          localModelButton(localModelT('Installing {cli}', { cli: name }), {
            key: startIsMain ? 'agent-install' : 'primary',
            primary: !next && !startIsMain,
            disabled: true,
          })
        );
      }
      // An agent that needs a setup of its own has nothing to press: the line above says where.
    } else if (agents ? offers('start-session') : can('start-session')) {
      buttons.appendChild(
        localModelButton(localModelT('Start a session'), {
          key: 'primary',
          primary: !next,
          disabled: ui.busy,
          onClick: () => void this.startLocalModelSession(agents && agent ? agent.cli : undefined),
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
    const leftovers = this._localModelStoreEl(localModelInstall(status));
    if (leftovers) parts.push(leftovers);
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
