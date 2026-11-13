/**
 * @fileoverview Reboot-restore banner: offer back the sessions a host reboot destroyed.
 *
 * A host reboot takes the tmux server down with it, so every session's pane dies
 * and the board comes up empty. The server works out what was running from the
 * records it still holds at boot, and this banner asks the user whether to
 * rebuild them. Nothing is created until they click, because the server's
 * reboot guess is a heuristic and a wrong automatic restore would spawn CLI
 * processes nobody asked for.
 *
 * Seeded from `GET /api/reboot-restore` on init and again on every SSE reconnect,
 * because the tab most likely to want this is one that was open across the reboot
 * and reconnects to a server that came back up with an empty board. Restore posts to
 * `POST /api/reboot-restore/restore` and Dismiss posts to
 * `POST /api/reboot-restore/dismiss`. Dismiss always clears the banner; Restore
 * re-reads the plan afterwards, because the server puts back anything it could
 * not build for a reason that may pass, such as a session limit or an agent that
 * would not start. The restored sessions arrive as ordinary `session:created`
 * events, so no extra rendering is needed here.
 *
 * The banner says that terminal history did not survive, because a restored
 * session is a new pane: the conversation continues and the scrollback does not.
 * Saying so is what keeps an empty pane from reading as a broken restore.
 * Backend: src/web/reboot-restore-registry.ts, src/web/routes/reboot-restore-routes.ts.
 *
 * @mixin Extends CodemanApp.prototype via Object.assign
 * @dependency app.js (CodemanApp class, showToast)
 * @dependency api-client.js at runtime (this._api / this._apiJson)
 * @loadorder 11.65, after approvals-ui.js and before admin-ui.js (11.7)
 */

/** Plain-language wording for one skip reason, for the toast after a restore. */
function rebootSkipReason(reason) {
  switch (reason) {
    case 'workspace-missing':
      return 'workspace is gone';
    case 'workspace-forbidden':
      return 'workspace is outside your space';
    case 'already-live':
      return 'already open';
    case 'capacity-reached':
      return 'session limit reached';
    case 'local-model-not-ready':
      return 'the local model is not ready';
    case 'rebuild-failed':
      return 'the agent would not start';
    default:
      return reason;
  }
}

Object.assign(CodemanApp.prototype, {
  /** Ask the server whether a reboot left anything on offer, and show the banner if so. */
  async initRebootRestoreBanner() {
    const data = await this._apiJson('/api/reboot-restore');
    const sessions = data?.sessions ?? [];
    if (sessions.length === 0) return;
    this._rebootRestoreSessions = sessions;
    this.renderRebootRestoreBanner();
  },

  renderRebootRestoreBanner() {
    const banner = this.$('rebootRestoreBanner');
    if (!banner) return;
    const sessions = this._rebootRestoreSessions ?? [];
    if (sessions.length === 0) {
      banner.hidden = true;
      return;
    }
    const count = sessions.length;
    const text = this.$('rebootRestoreBannerText');
    if (text) {
      const noun = count === 1 ? 'session' : 'sessions';
      text.textContent = `Restore ${count} ${noun} from before the reboot`;
    }
    const detail = this.$('rebootRestoreBannerDetail');
    if (detail) {
      // Names, so the user can tell what they are about to relaunch.
      const names = sessions
        .map((s) => s.name || s.workingDir?.split('/').pop() || s.id.slice(0, 8))
        .slice(0, 4)
        .join(', ');
      detail.textContent = count > 4 ? `${names}, …` : names;
      detail.title = sessions.map((s) => `${s.name || s.id}\n${s.workingDir}`).join('\n\n');
    }
    const accept = this.$('rebootRestoreBannerAccept');
    // The note is hidden at phone width, so the warning travels on the button too.
    if (accept) accept.title = 'Conversations return; terminal history does not.';
    banner.hidden = false;
  },

  /** Rebuild everything on offer. The panes are new, so scrollback does not come back. */
  async restoreRebootSessions() {
    const button = this.$('rebootRestoreBannerAccept');
    if (button) button.disabled = true;
    const res = await this._api('/api/reboot-restore/restore', { method: 'POST', body: {} });
    if (res && res.status === 409) {
      if (button) button.disabled = false;
      this.showToast?.('A restore is already running', 'info');
      return;
    }
    // The uniform envelope wraps every /api payload; reading the outer object
    // would report every count as zero.
    const body = res && res.ok ? (await res.json().catch(() => null))?.data : null;
    if (!body) {
      if (button) button.disabled = false;
      this.showToast?.('Could not restore the sessions', 'error');
      return;
    }
    const restored = body.restored?.length ?? 0;
    const skipped = body.skipped?.length ?? 0;
    // Re-read rather than clearing: the server puts back anything it could not
    // build for a reason that may pass, such as a session limit or an agent that
    // would not start, and blanking the banner here would put those entries out
    // of reach until a reload.
    await this.refreshRebootRestoreBanner();
    if (button) button.disabled = false;
    if (restored > 0) {
      const noun = restored === 1 ? 'conversation' : 'conversations';
      this.showToast?.(`Restored ${restored} ${noun}. Terminal history did not survive the reboot.`, 'success');
    }
    if (skipped > 0) {
      // Each reason means a different next step for the user, so they are not
      // collapsed into one message: capacity clears by closing something, a
      // failed start usually means the CLI is not on the server's PATH.
      const reasons = new Set((body.skipped ?? []).map((s) => s.reason));
      this.showToast?.(`${skipped} not restored: ${[...reasons].map(rebootSkipReason).join('; ')}`, 'warning');
    }
  },

  /** Re-read the offer after a reconnect, for a tab that was open across the reboot. */
  async refreshRebootRestoreBanner() {
    const data = await this._apiJson('/api/reboot-restore');
    this._rebootRestoreSessions = data?.sessions ?? [];
    this.renderRebootRestoreBanner();
  },

  /** Drop the offer. The Resume list still reaches every one of these conversations. */
  async dismissRebootRestore() {
    this._rebootRestoreSessions = [];
    this.renderRebootRestoreBanner();
    await this._apiPost('/api/reboot-restore/dismiss', {});
  },
});
