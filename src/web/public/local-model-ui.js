/**
 * @fileoverview The "model on this Mac" card of the welcome screen and its row in App Settings.
 *
 * Reads `GET /api/local-model` (hardware of the machine the server runs on, the recommendation,
 * the catalogue date) and shows, read-only:
 *  - the hardware line (chip, memory, free disk);
 *  - the verdict: the headline the server sent, then the pick with its numbers (model, harness,
 *    context, memory need against the budget, download size, speed) and the notes;
 *  - one line saying that Codeman cannot download or install the model yet: that is the next
 *    step and is not built. It sits right under the pick, where a reader looks for a button;
 *  - the other models that fit, each with its fit and speed label. A label says what it
 *    measures in its tooltip and accessible name ("Good" is the memory fit, not a rating of
 *    the model), and an alternative with a speed estimate prints the figure.
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
 * multi-user mode gets a `403 FORBIDDEN`, which is an answer: stop asking) and after the user hid
 * it on this device.
 *
 * The Settings group ("Model on this Mac") follows the same knowledge: it is hidden for
 * `not-macos` (most servers are not a Mac, and a group about "this Mac" there is false), for a
 * refused request and while the first request is in flight (nothing says yet that the server is
 * a Mac). It shows the answer for a Mac, and one failure sentence when the first request
 * failed. It is the way back to the numbers after a Hide.
 *
 * "Refused" means the envelope's `errorCode` is `FORBIDDEN`. The auth layer has a second 403 for
 * every /api route (`PASSWORD_CHANGE_REQUIRED`, an admin who must change the password first):
 * that one is a failed request, asked again on the next show and on `codeman:me`.
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
 *  - Sizes are printed exactly as sent (`needGb`, `downloadGb`, `budgetGb`, `freeDiskGb`:
 *    decimal GB as text). Bytes are never divided here. The installed memory is the one size
 *    that is not decimal GB: the hardware line prints `memClassGb`, the size the Mac is sold as
 *    (48, not 51.5), which is what About This Mac shows.
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

/**
 * Per-device dismissal of the welcome card, named for THIS stage (the read-only card). The stage
 * that can set a model up takes a key of its own, so hiding a card that offers nothing yet does
 * not hide the offer later.
 */
const LOCAL_MODEL_DISMISS_KEY = 'codeman:local-model-dismissed:readonly';

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

/** What the fit label measures: the share of the memory budget the model needs. */
function localModelFitHint(candidate) {
  if (!Number.isFinite(candidate.budgetShare)) return '';
  const share = String(Math.round(candidate.budgetShare * 100));
  return localModelT('Memory fit: needs {share}% of what this Mac can give a model', { share });
}

/** What the speed label stands for: the estimate behind "Slow", or that there is none. */
function localModelSpeedHint(candidate) {
  const speed = localModelSpeed(candidate.tokensPerSecond);
  if (speed) return localModelT('About {speed} tokens per second (estimated).', { speed });
  return localModelT('No speed estimate for this model on this chip');
}

/**
 * "Qwen3.8 27B (qwen3.8:27b) with OpenCode", then the fit and speed labels the server chose.
 * A bare "Good" next to a model name reads as a rating of the model, so each label carries what
 * it measures as its tooltip and its accessible name.
 */
function localModelCandidateHead(candidate) {
  const head = localModelEl('div', 'local-model-name-row');
  const name = localModelT('{model} ({id}) with {harness}', {
    model: candidate.modelLabel || candidate.modelId,
    id: candidate.modelId,
    harness: candidate.cliLabel || candidate.cli,
  });
  head.appendChild(localModelEl('span', 'local-model-name', name));
  const pills = [
    [candidate.fitLabel, localModelFitHint],
    [candidate.speedLabel, localModelSpeedHint],
  ];
  for (const [label, hint] of pills) {
    if (typeof label !== 'string' || !label) continue;
    const pill = localModelEl('span', 'local-model-pill', localModelT(label));
    const meaning = hint(candidate);
    if (meaning) {
      pill.title = meaning;
      pill.setAttribute('role', 'note');
      pill.setAttribute('aria-label', `${pill.textContent}. ${meaning}`);
    }
    head.appendChild(pill);
  }
  return head;
}

/**
 * The dim line under a candidate's name: context, then for an alternative its memory need and,
 * when there is an estimate, its speed (so "Slow" comes with a number on a screen without
 * hover), the download, and for the pick the license.
 */
function localModelMeta(candidate, { alternative = false } = {}) {
  const bits = [localModelT('Context {context} tokens', { context: localModelCount(candidate.context) })];
  if (alternative && candidate.needGb) bits.push(localModelT('{need} GB of memory', { need: candidate.needGb }));
  if (candidate.downloadGb) bits.push(localModelT('{download} GB download', { download: candidate.downloadGb }));
  const speed = alternative ? localModelSpeed(candidate.tokensPerSecond) : '';
  if (speed) bits.push(localModelT('about {speed} tokens per second', { speed }));
  if (!alternative && candidate.license) bits.push(String(candidate.license));
  return bits.join(' · ');
}

/** The pick with its numbers. */
function localModelPick(pick, recommendation) {
  const box = localModelEl('div', 'local-model-pick');
  box.appendChild(localModelCandidateHead(pick));
  box.appendChild(localModelEl('div', 'local-model-line', localModelMeta(pick)));
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

/**
 * The other models that fit. Folded behind a native disclosure on the welcome card, open in
 * Settings. No count beside the title: the server lists four at most, so the number of rows is
 * not the number of models that fit.
 */
function localModelAlternatives(alternatives, fold) {
  const wrap = localModelEl(fold ? 'details' : 'div', 'local-model-alts');
  const title = localModelEl(fold ? 'summary' : 'div', 'local-model-alts-title', localModelT('Other models that fit'));
  wrap.appendChild(title);
  for (const candidate of alternatives) {
    const row = localModelEl('div', 'local-model-alt');
    row.appendChild(localModelCandidateHead(candidate));
    row.appendChild(localModelEl('div', 'local-model-line', localModelMeta(candidate, { alternative: true })));
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
  // Right under the pick and its notes, above the list: the pick names a download and maybe a
  // harness that is not installed, so this is where a reader looks for a button.
  if (pick) {
    const next = localModelT(
      'Codeman cannot download or install this for you yet. That is the next step, and it is not built yet.'
    );
    body.appendChild(localModelEl('div', 'local-model-next', next));
  }
  const alternatives = pick && Array.isArray(recommendation.alternatives) ? recommendation.alternatives : [];
  if (alternatives.length) body.appendChild(localModelAlternatives(alternatives, fold));
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
    // Only the route's own refusal is final. The auth layer answers 403 too, with
    // PASSWORD_CHANGE_REQUIRED, for an admin who must change the password first: that is a
    // failed request, asked again once the password is changed.
    if (res?.status === 403 && body?.errorCode === 'FORBIDDEN') {
      this._localModelState = 'refused';
      this._localModelStatus = null;
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
    // The page can be open on another laptop or a tablet: "this Mac" is the server's.
    title.title = localModelT('The Mac that Codeman runs on, which is not always the device you are reading on.');
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
    const status = this._localModelStatus;
    const failed = !status && this._localModelState === 'failed';
    // The whole group goes for a non-admin, the way the other admin-only groups of this modal
    // do, and for a server that is not a Mac: its title and hint are about "this Mac". Until
    // the first answer nothing says the server is one, so the group waits for it.
    const shown = !this._localModelRefused() && (failed || (!!status && status.recommendation.reason !== 'not-macos'));
    const group = document.getElementById('localModelGroup');
    if (group) group.style.display = shown ? '' : 'none';
    if (!shown) return;
    if (status) {
      row.appendChild(localModelBody(status, { fold: false }));
      return;
    }
    row.appendChild(localModelEl('div', 'local-model-headline', localModelT('Could not reach the server.')));
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
