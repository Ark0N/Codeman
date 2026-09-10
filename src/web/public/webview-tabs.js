/**
 * @fileoverview Web tabs: saved dashboard URLs rendered as tabs beside agent
 * sessions, so Codeman is one mission control instead of Codeman plus a pile of
 * browser tabs.
 *
 * Each open dashboard is an <iframe> inside #webviewLayer, which covers the
 * terminal while a web tab is active. Frames stay MOUNTED while hidden, because a
 * dashboard that reloads and re-authenticates on every tab switch is worse than
 * the browser tab it replaced. `maxLiveFrames` (from the server) bounds that with
 * least-recently-viewed eviction.
 *
 * Sandboxing: a proxied dashboard is served from Codeman's own origin, so the
 * iframe deliberately omits `allow-same-origin` unless the dashboard is marked
 * trusted. Without that omission the page could read this document and call the
 * API that spawns agents.
 *
 * @mixin Extends CodemanApp.prototype via Object.assign
 * @dependency app.js, api-client.js, constants.js (escapeHtml)
 * @loadorder 12.5 of 16, after session-ui.js (needs the tab strip), before api-client.js
 */

// ── Loopback links ──────────────────────────────────────────────────────────
//
// An agent prints `http://localhost:5173/` and the user taps it on a phone.
// That link can only ever resolve on the Codeman box itself, so opening it in
// the browser is a guaranteed connection error from anywhere else — while the
// proxied web tab fetches from the server, where it works. Only loopback is
// routed this way: a LAN or tailnet address may well be reachable from the
// device (a VPN, the same Wi-Fi), and a direct open is the cheaper, richer path.

const LOOPBACK_HOSTNAMES = new Set(['localhost', '0.0.0.0', '::1', '[::1]', '::', '[::]']);

/** `localhost`, `*.localhost`, 127.0.0.0/8, 0.0.0.0 and the IPv6 loopback forms. */
function isLoopbackHostname(hostname) {
  const host = String(hostname || '')
    .trim()
    .toLowerCase()
    .replace(/\.$/, '');
  if (!host) return false;
  if (LOOPBACK_HOSTNAMES.has(host) || host.endsWith('.localhost')) return true;
  const ipv4 = /^(\d{1,3})\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.exec(host);
  return !!ipv4 && Number(ipv4[1]) === 127;
}

/**
 * Whether a link should open through a proxied web tab rather than directly:
 * an http(s) URL on a loopback host, viewed from a page that is NOT itself on
 * that host (on the box, the browser can reach localhost and the direct open
 * keeps devtools, extensions and the real origin).
 */
function linkNeedsWebTabProxy(rawUrl, pageHostname) {
  let url;
  try {
    url = new URL(String(rawUrl || ''));
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  if (!isLoopbackHostname(url.hostname)) return false;
  return !isLoopbackHostname(pageHostname);
}

if (typeof window !== 'undefined') {
  window.CodemanWebviewLinks = { isLoopbackHostname, linkNeedsWebTabProxy };
}

Object.assign(CodemanApp.prototype, {
  // ── Loopback links ────────────────────────────────────────────────────────

  /**
   * Take a link the device cannot reach and open it through a proxied web tab.
   * Returns true when it took the link; false leaves the caller's own opening
   * path (window.open, an anchor's default) untouched.
   */
  openLinkThroughWebTabIfLoopback(rawUrl) {
    if (!linkNeedsWebTabProxy(rawUrl, window.location?.hostname)) return false;
    void this.openUrlInWebTab(rawUrl);
    return true;
  },

  /**
   * Open an arbitrary URL as a proxied web tab, deep path included. A saved
   * proxied dashboard on the same origin is reused (one tab per dev server,
   * not one per link); otherwise one is saved under the host:port name so it
   * is there in the Run dropdown next time.
   */
  async openUrlInWebTab(rawUrl) {
    let url;
    try {
      url = new URL(String(rawUrl || ''));
    } catch {
      return;
    }
    if (!this.webviews) await this.refreshWebviews();
    if (!this.webviews) {
      this.showToast?.('Could not open URL', 'error');
      return;
    }

    let existing = null;
    for (const webview of this.webviews.values()) {
      if (webview.managed || (webview.embedMode ?? 'proxy') !== 'proxy') continue;
      try {
        if (new URL(webview.url).origin === url.origin) {
          existing = webview;
          break;
        }
      } catch {
        /* a saved URL that no longer parses is not a match */
      }
    }

    let id = existing?.id;
    if (!id) {
      const created = await this._apiJson('/api/webviews', {
        method: 'POST',
        body: { name: url.host.slice(0, 60), url: `${url.origin}/`, embedMode: 'proxy', trusted: false },
      });
      if (!created?.id) {
        this.showToast?.('Could not open URL', 'error');
        return;
      }
      await this.refreshWebviews();
      id = created.id;
    }
    const path = `${url.pathname}${url.search}${url.hash}`;
    await this.openWebview(id, { path: path === '/' ? '' : path });
  },

  // ── State ─────────────────────────────────────────────────────────────────

  /** Load the saved list and restore which tabs were open. */
  async initWebviews() {
    this.webviews = this.webviews || new Map();
    this.webviewOrder = this.webviewOrder || [];
    this.activeWebviewId = this.activeWebviewId || null;
    this._webviewMaxFrames = this._webviewMaxFrames || 6;
    this._webviewFrameLru = this._webviewFrameLru || [];

    await this.refreshWebviews();

    // Restore the previously open web tabs (per device: which dashboards you keep
    // open is a workspace-layout choice, not something to sync across machines).
    let saved = [];
    try {
      saved = JSON.parse(localStorage.getItem('codeman-webview-order') || '[]');
    } catch {
      saved = [];
    }
    this.webviewOrder = saved.filter((id) => this.webviews.has(id));
    this.renderSessionTabs();
  },

  async refreshWebviews() {
    const data = await this._apiJson('/api/webviews');
    if (!data) return;
    this.webviews = new Map((data.webviews || []).map((w) => [w.id, w]));
    if (typeof data.maxLiveFrames === 'number') this._webviewMaxFrames = data.maxLiveFrames;
    this.renderWebviewMenuItems();
  },

  /** SSE: the saved list changed (possibly on another device). */
  async _onWebviewChanged(data) {
    await this.refreshWebviews();
    // A dashboard deleted elsewhere must not linger as a dead tab here.
    if (data && data.action === 'deleted' && data.id) this._removeWebviewTab(data.id);
    this.renderSessionTabs();
  },

  _persistWebviewOrder() {
    try {
      localStorage.setItem('codeman-webview-order', JSON.stringify(this.webviewOrder || []));
    } catch {
      /* private mode / quota, order is a convenience, never fatal */
    }
  },

  // ── Tab strip ─────────────────────────────────────────────────────────────

  /**
   * Tab HTML for every OPEN web tab, appended by _fullRenderSessionTabs().
   * `startIndex` continues the Alt+N numbering after the session tabs.
   */
  renderWebviewTabs(startIndex) {
    if (!this.webviewOrder || this.webviewOrder.length === 0) return '';
    const parts = [];
    let idx = startIndex;

    for (const id of this.webviewOrder) {
      const webview = this.webviews.get(id);
      if (!webview) continue;
      const isActive = id === this.activeWebviewId;
      const jsonId = escapeHtml(JSON.stringify(id));
      const icon = webview.icon ? escapeHtml(webview.icon) : '';

      parts.push(`<div class="session-tab session-tab--web ${isActive ? 'active' : ''}" data-webview-id="${escapeHtml(id)}"
          onclick="app.handleWebviewTabClick(event, ${jsonId})"
          tabindex="0" role="tab" aria-selected="${isActive ? 'true' : 'false'}"
          aria-label="${escapeHtml(webview.name)} web tab" title="${escapeHtml(webview.url)}">
          ${idx < 9 ? '<span class="tab-number">' + (idx + 1) + '</span>' : ''}
          <span class="tab-web-icon" aria-hidden="true">${icon || this._webviewGlobeIcon()}</span>
          <span class="tab-info">
            <span class="tab-name-row">
              <span class="tab-name">${escapeHtml(webview.name)}</span>
            </span>
          </span>
          <span class="tab-actions"><span class="tab-gear" onclick="event.stopPropagation(); app.showWebviewModal(${jsonId})" title="URL settings" aria-label="URL settings" tabindex="0">&#x2699;</span><span class="tab-close" onclick="event.stopPropagation(); app.closeWebviewTab(${jsonId})" title="Close tab" aria-label="Close web tab" tabindex="0">&times;</span></span>
        </div>`);
      idx++;
    }
    return parts.join('');
  },

  _webviewGlobeIcon() {
    return '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15 15 0 0 1 0 20 15 15 0 0 1 0-20"/></svg>';
  },

  handleWebviewTabClick(event, id) {
    event?.preventDefault?.();
    return this.openWebview(id);
  },

  /** Mark exactly one tab active across BOTH tab kinds. */
  _updateActiveWebviewTab() {
    const container = this.$('sessionTabs');
    if (!container) return;
    for (const tab of container.querySelectorAll('.session-tab[data-webview-id]')) {
      tab.classList.toggle('active', tab.dataset.webviewId === this.activeWebviewId);
    }
    if (this.activeWebviewId) {
      // A web tab is active, so no session tab may also look active.
      for (const tab of container.querySelectorAll('.session-tab[data-id]')) tab.classList.remove('active');
    }
  },

  // ── Opening / closing ─────────────────────────────────────────────────────

  /**
   * Open (or focus) a dashboard tab. Mints a fresh capability every time: they are
   * memory-only and expire, so a tab reopened after a server restart must not reuse
   * the dead URL from the previous run.
   */
  /**
   * @param {string} id
   * @param {{path?: string}} [options] `path` (pathname+search+hash) opens a
   *   deep link inside the dashboard: appended to the proxy prefix, or resolved
   *   against the real URL in direct mode. A mounted frame is navigated there
   *   rather than left on whatever page it was showing.
   */
  async openWebview(id, options = {}) {
    const webview = this.webviews.get(id);
    if (!webview) return;

    if (!this.webviewOrder.includes(id)) {
      this.webviewOrder.push(id);
      this._persistWebviewOrder();
    }

    const data = await this._apiJson(`/api/webviews/${encodeURIComponent(id)}/open`, { method: 'POST' });
    if (!data) {
      this.showToast?.('Could not open URL', 'error');
      return;
    }
    if (data.webview) this.webviews.set(id, data.webview);

    let src = data.embedUrl || data.webview?.url || webview.url;
    const path = typeof options.path === 'string' ? options.path : '';
    if (path) {
      // The proxy prefix is `/webview/<cap>/`; a wildcard rides after it. In
      // direct mode the deep link resolves against the dashboard's own origin.
      src = data.embedUrl ? `${data.embedUrl.replace(/\/?$/, '/')}${path.replace(/^\//, '')}` : new URL(path, src).href;
    }
    this._mountWebviewFrame(id, src, data.webview || webview, { navigate: !!path });
    this.activeWebviewId = id;
    this.hideWelcome?.();
    document.querySelector('.main')?.classList.add('webview-active');
    this.renderSessionTabs();
    this._updateActiveWebviewTab();
    // Web tabs live in the same list as sessions, so picking one from the
    // handheld session drawer has to dismiss it too (no-op elsewhere).
    this.closeSessionSidebarOnHandheld?.();
  },

  /** Create the frame if absent, then reveal it and hide its siblings. */
  _mountWebviewFrame(id, src, webview, { navigate = false } = {}) {
    const layer = document.getElementById('webviewLayer');
    if (!layer) return;

    let wrap = layer.querySelector(`.webview-frame[data-webview-id="${CSS.escape(id)}"]`);
    if (wrap && navigate) {
      // A deep link into an already-mounted dashboard: navigate the live frame
      // instead of tearing it down, so its login and state survive.
      const frame = wrap.querySelector('iframe');
      if (frame) frame.src = CodemanBase.url(src);
    }
    if (!wrap) {
      wrap = document.createElement('div');
      wrap.className = 'webview-frame';
      wrap.dataset.webviewId = id;

      const frame = document.createElement('iframe');
      frame.className = 'webview-iframe';
      frame.setAttribute('title', webview.name);
      // No allow-same-origin unless explicitly trusted: a proxied page is served
      // from THIS origin, so granting it would let the dashboard read this document
      // and drive the Codeman API.
      const sandbox = ['allow-scripts', 'allow-forms', 'allow-popups', 'allow-downloads', 'allow-modals'];
      if (webview.trusted) sandbox.push('allow-same-origin');
      frame.setAttribute('sandbox', sandbox.join(' '));
      frame.setAttribute('referrerpolicy', 'no-referrer-when-downgrade');
      // Proxied dashboards carry a root-absolute `/webview/<cap>/` embedUrl that must
      // ride the mount prefix; external (trusted) URLs are absolute and pass through.
      frame.src = CodemanBase.url(src);

      const failure = document.createElement('div');
      failure.className = 'webview-failure';
      failure.innerHTML = this._webviewFailureHtml(id);

      wrap.appendChild(frame);
      wrap.appendChild(failure);
      layer.appendChild(wrap);

      // A frame that never fires `load` is the normal symptom of a refused embed or
      // an unreachable host. Show an actionable panel instead of a blank rectangle.
      const timer = setTimeout(() => wrap.classList.add('webview-frame--failed'), 8000);
      frame.addEventListener('load', () => {
        clearTimeout(timer);
        wrap.classList.remove('webview-frame--failed');
      });
    }

    this._touchWebviewFrame(id);
    for (const other of layer.querySelectorAll('.webview-frame')) {
      other.classList.toggle('active', other.dataset.webviewId === id);
    }
    // Chart libraries measure on resize; a frame revealed from display:none needs the nudge.
    requestAnimationFrame(() => window.dispatchEvent(new Event('resize')));
  },

  _webviewFailureHtml(id) {
    const jsonId = escapeHtml(JSON.stringify(id));
    return `<div class="webview-failure-inner">
        <h3>This URL did not load</h3>
        <p>It may be unreachable from the Codeman server, or it may refuse to be embedded.</p>
        <div class="webview-failure-actions">
          <button class="btn-secondary" onclick="app.reloadWebview(${jsonId})">Reload</button>
          <button class="btn-secondary" onclick="app.openWebviewExternal(${jsonId})">Open in new tab</button>
          <button class="btn-secondary" onclick="app.showWebviewModal(${jsonId})">Edit</button>
        </div>
      </div>`;
  },

  /** Least-recently-viewed eviction so N open dashboards cannot pin N live pages. */
  _touchWebviewFrame(id) {
    this._webviewFrameLru = (this._webviewFrameLru || []).filter((x) => x !== id);
    this._webviewFrameLru.push(id);
    const layer = document.getElementById('webviewLayer');
    if (!layer) return;
    while (this._webviewFrameLru.length > this._webviewMaxFrames) {
      const evict = this._webviewFrameLru.shift();
      if (evict === this.activeWebviewId) continue;
      layer.querySelector(`.webview-frame[data-webview-id="${CSS.escape(evict)}"]`)?.remove();
    }
  },

  reloadWebview(id) {
    const target = id || this.activeWebviewId;
    if (!target) return;
    document
      .getElementById('webviewLayer')
      ?.querySelector(`.webview-frame[data-webview-id="${CSS.escape(target)}"]`)
      ?.remove();
    this._webviewFrameLru = (this._webviewFrameLru || []).filter((x) => x !== target);
    return this.openWebview(target);
  },

  openWebviewExternal(id) {
    const webview = this.webviews.get(id || this.activeWebviewId);
    if (webview) window.open(webview.url, '_blank', 'noopener');
  },

  closeWebviewTab(id) {
    this._removeWebviewTab(id);
    this.renderSessionTabs();
  },

  _removeWebviewTab(id) {
    this.webviewOrder = (this.webviewOrder || []).filter((x) => x !== id);
    this._webviewFrameLru = (this._webviewFrameLru || []).filter((x) => x !== id);
    this._persistWebviewOrder();
    document
      .getElementById('webviewLayer')
      ?.querySelector(`.webview-frame[data-webview-id="${CSS.escape(id)}"]`)
      ?.remove();

    if (this.activeWebviewId === id) {
      this.activeWebviewId = null;
      const next = this.webviewOrder[0];
      if (next) {
        this.openWebview(next);
      } else {
        this._hideWebviewLayer();
        // Fall back to whatever session was last shown, or the welcome screen.
        if (this.activeSessionId) this._updateActiveTabImmediate(this.activeSessionId);
        else this.showWelcome?.();
      }
    }
  },

  /** Called by selectSession(): a session tab takes the stage back from a web tab. */
  _hideWebviewLayer() {
    if (!this.activeWebviewId && !document.querySelector('.main.webview-active')) return;
    this.activeWebviewId = null;
    document.querySelector('.main')?.classList.remove('webview-active');
    for (const frame of document.querySelectorAll('#webviewLayer .webview-frame')) {
      frame.classList.remove('active');
    }
    this._updateActiveWebviewTab();
  },

  // ── Run-menu entries ──────────────────────────────────────────────────────

  /**
   * Saved dashboards listed inside the Run dropdown, under "Web / URL".
   *
   * Each row carries its own edit and delete buttons. Without them the only way to
   * change or remove a saved URL was to open it as a tab first and go through the
   * tab's gear, which is a dead end for a URL you no longer want open at all.
   */
  renderWebviewMenuItems() {
    const container = document.getElementById('runModeWebviews');
    if (!container) return;
    // Managed records are maintained by their own menu entry (the DeepSeek web
    // UI shortcut), so listing them here showed one dashboard twice: the
    // shortcut that starts it, and the row it wrote on the previous click.
    const list = [...(this.webviews?.values() || [])].filter((w) => !w.managed);
    if (list.length === 0) {
      container.innerHTML = '<div class="run-mode-empty">No URLs yet</div>';
      return;
    }
    container.innerHTML = list
      .map((w) => {
        const jsonId = escapeHtml(JSON.stringify(w.id));
        const name = escapeHtml(w.name);
        const icon = w.icon ? escapeHtml(w.icon) : '<span class="run-mode-dot web"></span>';
        return `<div class="run-mode-row run-mode-row--web">
          <button class="run-mode-option run-mode-option--web" onclick="app.openWebviewFromMenu(${jsonId})" title="${escapeHtml(w.url)}">
            <span class="run-mode-menu-icon">${icon}</span><span class="run-mode-web-name">${name}</span>
          </button>
          <button class="run-mode-row-btn run-mode-webview-edit" onclick="event.stopPropagation(); app.showWebviewModal(${jsonId})"
            title="Edit URL" aria-label="Edit ${name}">&#x2699;</button>
          <button class="run-mode-row-btn run-mode-webview-delete" onclick="event.stopPropagation(); app.deleteWebviewById(${jsonId})"
            title="Delete URL" aria-label="Delete ${name}">&times;</button>
        </div>`;
      })
      .join('');
  },

  openWebviewFromMenu(id) {
    document.getElementById('runModeMenu')?.classList.remove('active');
    return this.openWebview(id);
  },

  // ── Icon picker ───────────────────────────────────────────────────────────

  /** Common dashboard/service glyphs. The text field stays open for anything else. */
  _webviewIconChoices() {
    return ['📊', '📈', '🖥️', '🎛️', '📡', '🐳', '🗄️', '🔒', '🌐', '📁', '🧪', '🧬', '⚡', '🔔', '📝', '🎧'];
  },

  _renderWebviewIconPicker(selected) {
    const picker = document.getElementById('webviewIconPicker');
    if (!picker) return;
    picker.innerHTML = this._webviewIconChoices()
      .map(
        (icon) =>
          `<button type="button" class="webview-icon-choice${icon === selected ? ' selected' : ''}"
             onclick="app.pickWebviewIcon(${escapeHtml(JSON.stringify(icon))})"
             aria-label="Use ${escapeHtml(icon)} as the icon">${escapeHtml(icon)}</button>`
      )
      .join('');
  },

  /** Clicking the selected icon again clears it, so there is a way back to no icon. */
  pickWebviewIcon(icon) {
    const field = document.getElementById('webviewIcon');
    if (!field) return;
    field.value = field.value === icon ? '' : icon;
    this._renderWebviewIconPicker(field.value);
  },

  // ── Editor modal ──────────────────────────────────────────────────────────

  showWebviewModal(id) {
    const modal = document.getElementById('webviewModal');
    if (!modal) return;
    const webview = id ? this.webviews.get(id) : null;
    this._editingWebviewId = webview ? webview.id : null;

    document.getElementById('webviewModalTitle').textContent = webview ? 'Edit URL' : 'Add URL';
    this._renderWebviewIconPicker(webview?.icon || '');
    document.getElementById('webviewName').value = webview?.name || '';
    document.getElementById('webviewUrl').value = webview?.url || '';
    document.getElementById('webviewIcon').value = webview?.icon || '';
    document.getElementById('webviewSandboxed').checked = !webview?.trusted;
    document.getElementById('webviewProbeResult').textContent = '';
    document.getElementById('webviewDeleteBtn').style.display = webview ? '' : 'none';

    document.getElementById('runModeMenu')?.classList.remove('active');
    modal.classList.add('active');
    document.getElementById('webviewName').focus();
  },

  closeWebviewModal() {
    document.getElementById('webviewModal')?.classList.remove('active');
    this._editingWebviewId = null;
  },

  /** Server-side probe: it runs from the network position the proxy will use. */
  async testWebviewUrl() {
    const url = document.getElementById('webviewUrl').value.trim();
    const out = document.getElementById('webviewProbeResult');
    if (!url) {
      out.textContent = 'Enter a URL first.';
      return;
    }
    out.textContent = 'Testing...';
    const probe = await this._apiJson('/api/webviews/probe', { method: 'POST', body: { url } });
    if (!probe) {
      out.textContent = 'Test failed (invalid URL?).';
      return;
    }
    // #238: the probe runs server-to-upstream; say so, or a passing Test reads as
    // "the embedded page will work" when the browser sandbox / a cookie-auth
    // reverse proxy in front of Codeman can still break it.
    out.textContent = probe.reachable
      ? `Reachable (HTTP ${probe.status}) from the Codeman server. ${probe.reason} ` +
        `(Tests server-to-upstream reachability only, not how the page behaves in a sandboxed frame.)`
      : `Not reachable from the Codeman server. ${probe.reason}`;
    out.className = 'form-hint webview-probe-result ' + (probe.reachable ? 'ok' : 'bad');
  },

  async saveWebview() {
    const name = document.getElementById('webviewName').value.trim();
    const url = document.getElementById('webviewUrl').value.trim();
    const icon = document.getElementById('webviewIcon').value.trim();
    const trusted = !document.getElementById('webviewSandboxed').checked;
    if (!name || !url) {
      this.showToast?.('Name and URL are required', 'error');
      return;
    }

    // `icon: undefined` rather than null, the schema uses .optional(), which
    // rejects an explicit null on the wire.
    const body = { name, url, icon: icon || undefined, trusted };
    const editing = this._editingWebviewId;
    const data = editing
      ? await this._apiJson(`/api/webviews/${encodeURIComponent(editing)}`, { method: 'PATCH', body })
      : await this._apiJson('/api/webviews', { method: 'POST', body });

    if (!data) {
      this.showToast?.('Could not save (check the URL)', 'error');
      return;
    }

    await this.refreshWebviews();
    this.closeWebviewModal();
    if (editing) {
      // The capability was revoked server-side by the edit, so a mounted frame is
      // now pointing at a dead URL. Remount it.
      if (this.webviewOrder.includes(editing)) this.reloadWebview(editing);
    } else {
      this.openWebview(data.id);
    }
  },

  async deleteWebview() {
    const id = this._editingWebviewId;
    if (!id) return;
    if (await this._confirmAndDeleteWebview(id)) this.closeWebviewModal();
  },

  /**
   * Delete straight from a Run-dropdown row, without opening the editor first.
   *
   * The dropdown's outside-click handler closes the menu when the click target is
   * not inside it, and by the time the delete resolves this row is gone, so the
   * menu is re-asserted open: deleting one of several saved URLs should leave you
   * looking at the rest of the list.
   */
  async deleteWebviewById(id) {
    if (!id) return;
    if (!(await this._confirmAndDeleteWebview(id))) return;
    document.getElementById('runModeMenu')?.classList.add('active');
  },

  /** Shared by the row button and the editor modal. @returns true when deleted. */
  async _confirmAndDeleteWebview(id) {
    const webview = this.webviews.get(id);
    if (!confirm(`Delete "${webview?.name || id}"?`)) return false;
    const res = await this._apiDelete(`/api/webviews/${encodeURIComponent(id)}`);
    if (!res || !res.ok) {
      this.showToast?.('Could not delete URL', 'error');
      return false;
    }
    this._removeWebviewTab(id);
    this.webviews.delete(id);
    this.renderWebviewMenuItems();
    this.renderSessionTabs();
    return true;
  },
});
