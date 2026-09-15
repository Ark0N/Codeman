/**
 * @fileoverview Remote-host wake-on-LAN: the "host unreachable" banner + its config dialog.
 *
 * A sleeping remote host does not fail loudly. The local tmux pane runs `ssh`, and when
 * the machine suspends, that ssh child stalls: `tmux send-keys` still SUCCEEDS, so typed
 * input disappears with no error and the pane looks alive. The server side
 * (`src/remote-wake.ts`) buffers input and wakes the host when the user types; this
 * module makes the state VISIBLE and gives it a button, which is what turns "why is
 * nothing happening" into one click.
 *
 * Behavior:
 *  - Polls `GET /api/sessions/:id/reachability` for the ACTIVE remote session only
 *    (on tab activation and every `POLL_MS` while the tab is visible). The endpoint
 *    shares the server's probe cache with the input path, so opening the tab also
 *    primes the wake path.
 *  - Unreachable + a configured wake target → "Wake" button → `POST /api/sessions/:id/wake`
 *    (which wakes, waits, reattaches the pane and flushes buffered input).
 *  - Unreachable + NO wake target → "Configure WoL" → `#wakeConfigModal`, a small form
 *    for this host's MAC/command that saves via `PUT /api/remote-hosts/:id`. The server
 *    re-resolves host config while the session is live, so saving takes effect without
 *    restarting the session.
 *  - SSE (`remote:hostWaking`, `remote:hostWakeFailed`, `remote:sessionReconnected`)
 *    keeps the banner in sync while a wake is running.
 *
 * @mixin Extends CodemanApp.prototype via Object.assign
 */

const HOST_WAKE_POLL_MS = 30_000;

Object.assign(CodemanApp.prototype, {
  /** Per-tab banner state (single active session at a time). */
  _hostWake: null,
  /** The page-wide poller interval (created once, see `_ensureHostWakePoller`). */
  _hostWakeTimer: null,

  /** Fresh state for a session we just switched to. */
  _hostWakeState() {
    return {
      sessionId: null,
      /** Last reachability answer, or null before the first poll. */
      reachable: null,
      /** 'command' | 'mac' | 'none' — what the banner action should do. */
      wakeConfigured: 'none',
      host: '',
      label: '',
      /** True between clicking Wake and the answer coming back. */
      waking: false,
      /** Set when the last wake attempt or poll failed. */
      error: '',
    };
  },

  /**
   * Entry point from the session switcher — called for every active session, remote or
   * not, so it must be cheap and must clear the banner for local sessions.
   *
   * ⚠️ The POLLER is page-wide and independent of this call on purpose: a session
   * switch is not the only way the active tab changes (boot restore, a page loaded with
   * the tab already active, and `selectSession`'s own early return for the tab you are
   * already on), and the banner must not depend on any single one of those paths
   * running — that is exactly how it could silently never appear.
   */
  refreshHostWakeBanner(sessionId) {
    this._ensureHostWakePoller();
    const state = this._hostWake;
    if (state && state.sessionId && state.sessionId !== sessionId) this._hostWake = null;
    this._hostWakeTick();
  },

  /** Create the page-wide poller once (interval + a visibility wake-up). */
  _ensureHostWakePoller() {
    if (this._hostWakeTimer) return;
    this._hostWakeTimer = setInterval(() => this._hostWakeTick(), HOST_WAKE_POLL_MS);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') this._hostWakeTick();
    });
  },

  /**
   * One poller tick: resolve the ACTIVE session, reset the banner when it changed, and
   * ask the server. No-op while the page is hidden (a background tab must not poll).
   */
  _hostWakeTick() {
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
    const sessionId = this.activeSessionId;
    const session = sessionId && this.sessions ? this.sessions.get(sessionId) : null;
    if (!sessionId || !session || !session.remote) {
      if (this._hostWake) {
        this._hostWake = null;
        this._renderHostWakeBanner();
      }
      return;
    }
    let state = this._hostWake;
    if (!state || state.sessionId !== sessionId) {
      state = this._hostWake = this._hostWakeState();
      state.sessionId = sessionId;
      state.host = session.remote.host || '';
      state.label = session.remote.label || 'Remote host';
      // Text from the session payload first (instant, no round trip), corrected by the
      // poll — a session whose wake config was added after launch only knows it after
      // the server resolves host config.
      state.wakeConfigured = session.remote.wakeMac || session.remote.wakeCommand ? 'mac' : 'none';
      this._renderHostWakeBanner();
    }
    this._pollHostReachability();
  },

  /** One reachability check for the active remote session. */
  async _pollHostReachability(force = false) {
    const state = this._hostWake;
    if (!state || !state.sessionId) return;
    const sessionId = state.sessionId;
    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/reachability${force ? '?force=1' : ''}`);
      const data = await res.json();
      if (!data.success) return;
      // The tab may have changed while this was in flight.
      if (this._hostWake !== state || state.sessionId !== sessionId) return;
      state.reachable = data.data.reachable !== false;
      state.wakeConfigured = data.data.wakeConfigured || 'none';
      if (data.data.host) state.host = data.data.host;
      if (data.data.label) state.label = data.data.label;
      if (state.reachable) {
        state.waking = false;
        state.error = '';
      }
      this._renderHostWakeBanner();
    } catch {
      /* A failed poll is not a state change: leave the banner as it was. */
    }
  },

  /** Draw the banner from `_hostWake`. */
  _renderHostWakeBanner() {
    const state = this._hostWake;
    const banner = this.$('hostWakeBanner');
    const text = this.$('hostWakeBannerText');
    const detail = this.$('hostWakeBannerDetail');
    const action = this.$('hostWakeBannerAction');
    if (!banner || !text || !action) return;

    const visible = Boolean(state && state.sessionId && state.reachable === false);
    banner.hidden = !visible;
    if (!visible) return;

    const hasTarget = state.wakeConfigured !== 'none';
    const target = state.label || state.host || 'Remote host';
    if (state.waking) {
      text.textContent = `Waking ${target} …`;
    } else if (state.error) {
      text.textContent = `${target} did not wake up`;
    } else {
      text.textContent = `${target} is not reachable`;
    }
    if (detail) {
      detail.textContent = state.waking
        ? 'input is queued until it is back'
        : hasTarget
          ? `ssh ${state.host}`
          : 'no wake-on-LAN configured';
    }
    // After a FAILED wake the only useful next step is fixing the target (wrong MAC,
    // host moved NIC, command gone) — otherwise a configured-but-broken host would be
    // stuck behind a button that keeps failing with no way to edit it.
    const offerConfig = !hasTarget || Boolean(state.error);
    action.textContent = state.waking ? 'Waking …' : offerConfig ? 'Configure WoL' : 'Wake';
    action.disabled = state.waking;
  },

  /** Banner button: wake the host, or open the setup dialog when nothing is configured. */
  hostWakeAction() {
    const state = this._hostWake;
    if (!state || !state.sessionId || state.waking) return;
    if (state.wakeConfigured === 'none' || state.error) {
      this.openWakeConfigDialog();
      return;
    }
    this.wakeRemoteHost();
  },

  /** POST the manual wake for the active session and follow the result. */
  async wakeRemoteHost() {
    const state = this._hostWake;
    if (!state || !state.sessionId) return;
    const sessionId = state.sessionId;
    state.waking = true;
    state.error = '';
    this._renderHostWakeBanner();
    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/wake`, { method: 'POST' });
      const data = await res.json();
      if (this._hostWake !== state || state.sessionId !== sessionId) return;
      state.waking = false;
      if (!data.success) {
        // Most likely: no wake target configured after all (the route is the authority).
        state.error = data.error || 'Wake failed';
        if (String(data.error || '').includes('No wake-on-LAN target')) state.wakeConfigured = 'none';
        this._renderHostWakeBanner();
        return;
      }
      state.reachable = data.data.reachable !== false;
      state.wakeConfigured = data.data.wakeConfigured || state.wakeConfigured;
      if (state.reachable) {
        this.showToast(`${state.label || 'Remote host'} is awake`, 'success');
      } else {
        state.error = 'timeout';
      }
      this._renderHostWakeBanner();
    } catch (err) {
      if (this._hostWake !== state) return;
      state.waking = false;
      state.error = err && err.message ? err.message : 'Wake failed';
      this._renderHostWakeBanner();
    }
  },

  /** Open the small WoL dialog for the banner's host, pre-filled from the host config. */
  async openWakeConfigDialog() {
    const state = this._hostWake;
    const session = state && state.sessionId && this.sessions ? this.sessions.get(state.sessionId) : null;
    if (!session || !session.remote) return;
    const hostId = session.remote.hostId;
    const label = this.$('wakeConfigHostLabel');
    const mac = this.$('wakeConfigMac');
    const command = this.$('wakeConfigCommand');
    const status = this.$('wakeConfigStatus');
    if (!mac || !command) return;

    mac.value = session.remote.wakeMac || '';
    command.value = session.remote.wakeCommand || '';
    if (label) label.textContent = session.remote.label || hostId;
    if (status) status.textContent = '';
    this._wakeConfigHostId = hostId;
    const modal = this.$('wakeConfigModal');
    if (modal) modal.classList.add('active');

    // Read the saved host so the dialog shows what is actually persisted (the session
    // payload may predate a change made in another tab).
    try {
      const res = await fetch('/api/remote-hosts');
      const data = await res.json();
      const hosts = data.success ? data.data : [];
      const host = Array.isArray(hosts) ? hosts.find((item) => item.id === hostId) : null;
      if (host && this._wakeConfigHostId === hostId) {
        mac.value = host.wakeMac || '';
        command.value = host.wakeCommand || '';
      }
    } catch {
      /* The form is already usable from the session payload. */
    }
  },

  closeWakeConfigDialog() {
    const modal = this.$('wakeConfigModal');
    if (modal) modal.classList.remove('active');
    this._wakeConfigHostId = null;
  },

  /** Save MAC/command for the host, then re-check whether the session can wake now. */
  async saveWakeConfig() {
    const hostId = this._wakeConfigHostId;
    const mac = this.$('wakeConfigMac');
    const command = this.$('wakeConfigCommand');
    const status = this.$('wakeConfigStatus');
    const save = this.$('wakeConfigSave');
    if (!hostId || !mac || !command) return;

    const macValue = mac.value.trim();
    const commandValue = command.value.trim();
    if (
      macValue &&
      !/^[0-9a-fA-F]{2}([:-][0-9a-fA-F]{2}){5}(\s*,\s*[0-9a-fA-F]{2}([:-][0-9a-fA-F]{2}){5})*$/.test(macValue)
    ) {
      if (status) status.textContent = 'MAC must look like 04:d9:f5:80:c6:58 (comma-separated for several).';
      return;
    }
    if (commandValue && /\s/.test(commandValue)) {
      if (status) status.textContent = 'The wake command must be a single executable path (no arguments).';
      return;
    }

    if (save) save.disabled = true;
    if (status) status.textContent = 'Saving …';
    try {
      const listRes = await fetch('/api/remote-hosts');
      const listData = await listRes.json();
      const hosts = listData.success ? listData.data : [];
      const host = Array.isArray(hosts) ? hosts.find((item) => item.id === hostId) : null;
      if (!host) throw new Error('Remote host not found');
      // PUT takes the whole host (schema-validated), so send back everything we know and
      // only replace the wake fields. `undefined` drops the key entirely.
      const payload = {
        ...host,
        wakeMac: macValue || undefined,
        wakeCommand: commandValue || undefined,
      };
      const res = await fetch(`/api/remote-hosts/${encodeURIComponent(hostId)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error || 'Save failed');
      this.showToast('Wake settings saved', 'success');
      this.closeWakeConfigDialog();
      // The server re-resolves host config for live sessions, so the banner can offer
      // the wake right away — probe fresh instead of waiting out the poll interval.
      await this._pollHostReachability(true);
    } catch (err) {
      if (status) status.textContent = err && err.message ? err.message : 'Save failed';
    } finally {
      if (save) save.disabled = false;
    }
  },

  /**
   * SSE `remote:hostWaking` — a wake is running (ours or one started by typing).
   *
   * ⚠️ The ONLY definition of this handler: `panels-ui.js` must not define it too.
   * Both mix into `Codeman.prototype` and this file loads later, so a second copy
   * would be silently shadowed (the guard in `sse-dispatch-table.test.ts` sees that a
   * handler exists, not that two modules claim the same name). The toast is
   * deliberately UNCONDITIONAL — a wake can start for a background session (input on
   * a non-active tab) where there is no banner to update.
   */
  _onRemoteHostWaking(data) {
    const label = data && data.label ? data.label : 'Remote host';
    // Long enough to cover the wake + attach (~10s measured on a warm S3), and it
    // is replaced by `remote:sessionReconnected` the moment the pane is back.
    this.showToast(`Waking ${label} … input is queued`, 'info', { duration: 12000 });
    const state = this._hostWake;
    if (!state || !data || state.sessionId !== data.sessionId) return;
    state.waking = true;
    state.error = '';
    if (data.label) state.label = data.label;
    this._renderHostWakeBanner();
  },

  /** SSE `remote:hostWakeFailed` — the host did not come back in time. */
  _onRemoteHostWakeFailed(data) {
    const label = data && data.label ? data.label : 'Remote host';
    this.showToast(`${label} did not wake up — queued input is still held`, 'error', { duration: 15000 });
    const state = this._hostWake;
    if (!state || !data || state.sessionId !== data.sessionId) return;
    state.waking = false;
    state.error = 'timeout';
    state.reachable = false;
    this._renderHostWakeBanner();
  },
});
