/**
 * @fileoverview The "model on this Mac" card of the welcome screen and its row in App Settings.
 *
 * Reads `GET /api/local-model` (hardware of the machine the server runs on, the recommendation,
 * the catalogue date) and shows, read-only:
 *  - the hardware line (chip, memory, free disk);
 *  - the verdict: the headline and notes the server sent, then the pick with its numbers
 *    (model, harness, context, memory need against the budget, download size, speed);
 *  - the other models that fit, each with its fit and speed label;
 *  - one line saying that setting the model up from Codeman is the next step and is not built
 *    yet.
 *
 * ## One body, two containers
 *
 * The welcome card (`#localModelCard`) and the App Settings row (`#localModelSettings`) are
 * painted from the same payload by the same builder (`localModelBody`), so the two can never
 * name a different pick. They differ only in chrome: the card has a title and a Hide button and
 * folds the alternatives; the row lists them open.
 *
 * ## When the card shows
 *
 * The card ships `hidden` and appears only once the server has answered for a Mac. It stays
 * hidden while the first request is in flight and after a failed one (nothing is known about the
 * machine then, and an error card would be the only thing this feature ever showed on a server
 * that is not a Mac), when the answer is `not-macos`, when the request is refused (a non-admin in
 * multi-user mode gets a 403, which is an answer: stop asking) and after the user hid it on this
 * device. The Settings row is where the loading and failure sentences show, and it is the way
 * back to the numbers after a Hide.
 *
 * Rules:
 *  - Read-only: no control here downloads, installs or writes anything but the per-device
 *    dismissal (a localStorage key, never a server setting).
 *  - Every dynamic string goes in through `textContent`. Model, harness and chip names are
 *    someone else's text, so both containers carry `data-i18n-skip` and this file translates
 *    its own sentences at render time. A language or display-name change therefore re-renders
 *    (`<html lang>` is written by every i18n `configure()`).
 *  - Names and labels come from the payload: this file holds no list of models or harnesses and
 *    never compares a CLI id with a literal.
 *  - Sizes are printed exactly as sent (`needGb`, `downloadGb`, `budgetGb`, `memGb`,
 *    `freeDiskGb`: decimal GB as text). Bytes are never divided here.
 *  - A sentence the server chose arrives as `{ text, vars }` and goes through
 *    `localModelT(text, vars)`; this file's own strings are literals in that same call, in
 *    `{placeholder}` form, so the i18n test can harvest them. Both kinds need a zh-CN entry in
 *    i18n.js. `{name}` is the translator's own slot (the display name) and is never used here.
 *  - The word "Recommended" is not in this file. Which headline a Mac gets is the server's call.
 *
 * @mixin Extends CodemanApp.prototype via Object.assign
 * @dependency app.js (CodemanApp)
 * @dependency api-client.js (_api)
 * @dependency constants.js (CodemanBase, optional)
 * @dependency i18n.js (codemanT, optional)
 * @loadorder 12.59 of 16, after edit-history-ui.js, before entrance-animations.js
 */

/** Per-device dismissal of the welcome card. */
const LOCAL_MODEL_DISMISS_KEY = 'codeman:local-model-dismissed';

/** The server caches its hardware probe for a minute, so asking again sooner cannot change the answer. */
const LOCAL_MODEL_MAX_AGE_MS = 60000;

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

/** Whether the page already knows the route will refuse it (a non-admin in multi-user mode). */
function localModelNotAdmin() {
  const me = (typeof window !== 'undefined' && window.__codemanUser) || {};
  return !!(me.multiUser && me.role !== 'admin');
}

/** Chip, memory and free disk in one line. Every part but the memory may be missing. */
function localModelHardwareLine(hw) {
  const chip = String(hw.chip || hw.model || '');
  const sizes = { chip, memory: hw.memGb, free: hw.freeDiskGb };
  if (!hw.memGb) return chip;
  if (chip && hw.freeDiskGb) return localModelT('{chip}, {memory} GB memory, {free} GB free', sizes);
  if (chip) return localModelT('{chip}, {memory} GB memory', sizes);
  if (hw.freeDiskGb) return localModelT('{memory} GB memory, {free} GB free', sizes);
  return localModelT('{memory} GB memory', sizes);
}

/** "Qwen3.8 27B (qwen3.8:27b) with OpenCode", then the fit and speed labels the server chose. */
function localModelCandidateHead(candidate) {
  const head = localModelEl('div', 'local-model-name-row');
  const name = localModelT('{model} ({id}) with {harness}', {
    model: candidate.modelLabel || candidate.modelId,
    id: candidate.modelId,
    harness: candidate.cliLabel || candidate.cli,
  });
  head.appendChild(localModelEl('span', 'local-model-name', name));
  for (const label of [candidate.fitLabel, candidate.speedLabel]) {
    if (typeof label !== 'string' || !label) continue;
    head.appendChild(localModelEl('span', 'local-model-pill', localModelT(label)));
  }
  return head;
}

/** The dim line under a candidate's name: context, memory need (alternatives), download, license (the pick). */
function localModelMeta(candidate, { need = false, license = false } = {}) {
  const bits = [localModelT('Context {context} tokens', { context: localModelCount(candidate.context) })];
  if (need && candidate.needGb) bits.push(localModelT('{need} GB of memory', { need: candidate.needGb }));
  if (candidate.downloadGb) bits.push(localModelT('{download} GB download', { download: candidate.downloadGb }));
  if (license && candidate.license) bits.push(String(candidate.license));
  return bits.join(' · ');
}

/** The pick with its numbers. */
function localModelPick(pick, recommendation) {
  const box = localModelEl('div', 'local-model-pick');
  box.appendChild(localModelCandidateHead(pick));
  box.appendChild(localModelEl('div', 'local-model-line', localModelMeta(pick, { license: true })));
  const sizes = { need: pick.needGb, budget: recommendation.budgetGb };
  // A wired limit is a setting of this Mac; anything else is the formula's estimate, and says so.
  const need =
    recommendation.budgetSource === 'wired-limit'
      ? localModelT('Needs about {need} GB of the {budget} GB this Mac can give a model.', sizes)
      : localModelT('Needs about {need} GB of the {budget} GB this Mac can give a model (estimated).', sizes);
  box.appendChild(localModelEl('div', 'local-model-line', need));
  const speed = localModelSpeed(pick.tokensPerSecond);
  if (speed) {
    const line = localModelT('About {speed} tokens per second (estimated).', { speed });
    box.appendChild(localModelEl('div', 'local-model-line', line));
  }
  const harness = pick.cliLabel || pick.cli;
  if (pick.cliInstalled === false) {
    const line = localModelT('{harness} is not installed on this Mac yet.', { harness });
    box.appendChild(localModelEl('div', 'local-model-line', line));
  }
  if (pick.slowFirstTurn === true) {
    const line = localModelT('With {harness}, the first answer can take minutes.', { harness });
    box.appendChild(localModelEl('div', 'local-model-line', line));
  }
  return box;
}

/** The other models that fit. Folded behind a native disclosure on the welcome card, open in Settings. */
function localModelAlternatives(alternatives, fold) {
  const wrap = localModelEl(fold ? 'details' : 'div', 'local-model-alts');
  const title = localModelEl(fold ? 'summary' : 'div', 'local-model-alts-title');
  title.appendChild(localModelEl('span', '', localModelT('Other models that fit')));
  title.appendChild(localModelEl('span', 'local-model-count', String(alternatives.length)));
  wrap.appendChild(title);
  for (const candidate of alternatives) {
    const row = localModelEl('div', 'local-model-alt');
    row.appendChild(localModelCandidateHead(candidate));
    row.appendChild(localModelEl('div', 'local-model-line', localModelMeta(candidate, { need: true })));
    wrap.appendChild(row);
  }
  return wrap;
}

/**
 * Everything the server said, in reading order. The ONLY builder: the card and the Settings row
 * both call it, see @fileoverview.
 */
function localModelBody(status, { fold }) {
  const hardware = status.hardware || {};
  const recommendation = status.recommendation || {};
  const body = localModelEl('div', 'local-model-body');
  // Not a Mac: one plain sentence, and no line calling another machine's parts "this Mac".
  const hardwareLine = recommendation.reason === 'not-macos' ? '' : localModelHardwareLine(hardware);
  if (hardwareLine) body.appendChild(localModelEl('div', 'local-model-hw', hardwareLine));
  const headline = localModelMessage(recommendation.headline);
  if (headline) body.appendChild(localModelEl('div', 'local-model-headline', headline));
  const pick = recommendation.verdict === 'none' ? null : recommendation.pick;
  if (pick) body.appendChild(localModelPick(pick, recommendation));
  for (const note of Array.isArray(recommendation.notes) ? recommendation.notes : []) {
    const text = localModelMessage(note);
    if (text) body.appendChild(localModelEl('div', 'local-model-note', text));
  }
  const alternatives = pick && Array.isArray(recommendation.alternatives) ? recommendation.alternatives : [];
  if (alternatives.length) body.appendChild(localModelAlternatives(alternatives, fold));
  if (pick) {
    const next = localModelT('Setting this up from Codeman is the next step. It is not built yet.');
    body.appendChild(localModelEl('div', 'local-model-next', next));
  }
  return body;
}

/** The `data` of the GET, or null for anything that is not one. */
function localModelPayload(body) {
  const data = body && body.success === true ? body.data : null;
  const recommendation = data && typeof data === 'object' ? data.recommendation : null;
  if (!recommendation || typeof recommendation !== 'object' || typeof recommendation.verdict !== 'string') return null;
  return data;
}

Object.assign(CodemanApp.prototype, {
  // ═══════════════════════════════════════════════════════════════
  // Data
  // ═══════════════════════════════════════════════════════════════

  /**
   * Ask the server what this Mac can run, at most once a minute, and paint both containers.
   * Called when the welcome screen shows and when App Settings opens. Idempotent: a request in
   * flight is shared, and a fresh answer is only re-rendered.
   */
  loadLocalModel() {
    this._wireLocalModel();
    if (this._localModelRefused()) {
      this.renderLocalModel();
      return Promise.resolve();
    }
    if (this._localModelInFlight) return this._localModelInFlight;
    const fresh = this._localModelStatus && Date.now() - (this._localModelLoadedAt || 0) < LOCAL_MODEL_MAX_AGE_MS;
    if (fresh) {
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
    // `_api`, not `_apiJson`: a 403 (admin-only in multi-user mode) is an answer and must be told
    // apart from a request that failed.
    const res = await this._api(localModelUrl('/api/local-model'));
    if (res?.status === 403) {
      this._localModelState = 'refused';
      this._localModelStatus = null;
      this.renderLocalModel();
      return;
    }
    let body = null;
    if (res?.ok) {
      try {
        body = await res.json();
      } catch {
        body = null;
      }
    }
    const data = localModelPayload(body);
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

  // ═══════════════════════════════════════════════════════════════
  // Dismissal (per device)
  // ═══════════════════════════════════════════════════════════════

  isLocalModelCardDismissed() {
    if (this._localModelDismissed === true) return true;
    try {
      return localStorage.getItem(LOCAL_MODEL_DISMISS_KEY) === '1';
    } catch {
      return false;
    }
  },

  /** Hide the welcome card on this device. The Settings row keeps showing the same answer. */
  dismissLocalModelCard() {
    // Remembered on the instance too: with storage blocked the card still stays away until a reload.
    this._localModelDismissed = true;
    try {
      localStorage.setItem(LOCAL_MODEL_DISMISS_KEY, '1');
    } catch {
      /* storage blocked: hidden for this page load only */
    }
    this.renderLocalModel();
  },

  // ═══════════════════════════════════════════════════════════════
  // Render
  // ═══════════════════════════════════════════════════════════════

  /** Paint every mounted container (welcome card + App Settings row). */
  renderLocalModel() {
    const card = document.getElementById('localModelCard');
    if (card) this._renderLocalModelCard(card);
    const row = document.getElementById('localModelSettings');
    if (row) this._renderLocalModelSettings(row);
  },

  _localModelRefused() {
    return this._localModelState === 'refused' || localModelNotAdmin();
  },

  _renderLocalModelCard(card) {
    // The one piece of state the card holds itself: whether the alternatives were unfolded.
    const wasOpen = card.querySelector('details')?.open === true;
    card.textContent = '';
    const status = this._localModelStatus;
    const hidden =
      !status ||
      this._localModelRefused() ||
      status.recommendation.reason === 'not-macos' ||
      this.isLocalModelCardDismissed();
    card.hidden = hidden;
    if (hidden) return;

    const head = localModelEl('div', 'local-model-head');
    const title = localModelEl('h3', 'local-model-title', localModelT('Model on this Mac'));
    title.id = 'localModelCardTitle';
    head.appendChild(title);
    const hide = localModelEl('button', 'local-model-hide', localModelT('Hide'));
    hide.type = 'button';
    hide.title = localModelT('Hide this card on this device. It stays in App Settings, under Models.');
    hide.addEventListener('click', () => this.dismissLocalModelCard());
    head.appendChild(hide);
    card.appendChild(head);

    const box = localModelEl('div', 'local-model-box');
    box.appendChild(localModelBody(status, { fold: true }));
    card.appendChild(box);
    const details = card.querySelector('details');
    if (details && wasOpen) details.open = true;
  },

  _renderLocalModelSettings(row) {
    row.textContent = '';
    const refused = this._localModelRefused();
    // The whole group goes for a non-admin, the way the other admin-only groups of this modal do.
    const group = document.getElementById('localModelGroup');
    if (group) group.style.display = refused ? 'none' : '';
    if (refused) return;
    const status = this._localModelStatus;
    if (status) {
      row.appendChild(localModelBody(status, { fold: false }));
      return;
    }
    const text =
      this._localModelState === 'failed'
        ? localModelT('Could not reach the server.')
        : localModelT('Checking this Mac…');
    row.appendChild(localModelEl('div', 'local-model-headline', text));
  },

  /** Listeners that outlive a render, wired once. */
  _wireLocalModel() {
    if (this._localModelWired) return;
    this._localModelWired = true;
    // Both containers are data-i18n-skip (see @fileoverview), so the DOM translator never
    // revisits them: a language or display-name change has to repaint them from here.
    if (typeof MutationObserver === 'function' && document.documentElement) {
      const observer = new MutationObserver(() => this.renderLocalModel());
      observer.observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] });
    }
    // The real role can arrive after the first render (admin-ui.js fetches /api/me): a non-admin
    // loses the card and the group, and an admin the page had taken for one is asked for at last.
    document.addEventListener?.('codeman:me', () => void this.loadLocalModel());
  },
});
