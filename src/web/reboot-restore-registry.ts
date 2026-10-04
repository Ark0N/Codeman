/**
 * @fileoverview The pending restore plan: what a host reboot destroyed, waiting on a click.
 *
 * The boot pass builds this plan inside `restoreMuxSessions()`, in the window
 * where reconciliation has reported the dead sessions and `cleanupStaleSessions()`
 * has not pruned their records yet. The board then offers "restore N sessions
 * from before the reboot", and `web/routes/reboot-restore-routes` spends the plan
 * when the user clicks.
 *
 * Invariants:
 * - Entries are in-memory only. A server restart drops the plan, and nothing
 *   re-builds it, because the records it was built from are pruned by then.
 *   That costs the convenience this feature adds and never the conversation:
 *   the conversation IS the transcript under `~/.claude/projects`, which
 *   `services/unified-session-service.ts` reads for the Welcome screen's Resume
 *   list and the Session Manager, and `resumeHistorySession()` in
 *   `web/public/terminal-ui.js` resumes from a row there with no persisted
 *   session record involved. A dropped plan therefore returns the user to
 *   resuming by hand, one at a time, which is where they are without this
 *   feature. What the plan held that a transcript does not is the owner, the
 *   name, the env overrides, the effort, the advisor model and the lineage.
 * - Module-level singleton in the style of `web/approval-inbox.ts`: no `Session`
 *   import and no IO, which keeps it unit-testable and cycle-free.
 * - Spending is take-then-build: `take()` removes entries synchronously, before
 *   the route's first `await`, so a double-click or two devices cannot both
 *   reach the same entry and put two panes on one conversation.
 * - One restore runs at a time per owner. `beginSpending()` single-flights the
 *   route, so two concurrent clicks cannot interleave pane creation for the same
 *   user, while two different users never block each other.
 *
 * @dependencies reboot-restore (RebootRestoreEntry)
 * @consumedby web/server (plan build at boot), web/routes/reboot-restore-routes
 *
 * @module web/reboot-restore-registry
 */

import type { RebootRestoreEntry } from '../reboot-restore.js';

/**
 * A plan older than this is dropped on read. A machine that rebooted yesterday
 * has moved on, and an offer nobody took by then is noise rather than a rescue.
 */
const PLAN_TTL_MS = 24 * 60 * 60 * 1000;

export class RebootRestoreRegistry {
  /** Keyed by session id, in the order the boot pass found them. */
  private entries = new Map<string, RebootRestoreEntry>();
  /** When the boot pass built the plan, in ms since the epoch. */
  private builtAt = 0;
  /**
   * Entries handed to a restore that has not finished, by session id, each
   * remembering which caller is spending it.
   *
   * A taken entry is still part of the offer until its restore resolves it, so
   * it has to stay reachable by everything that can invalidate an offer. Holding
   * the entries themselves — rather than a counter to compare against later —
   * means `clear()` filters them by the SAME `canAccess(entry.owner)` predicate
   * it already applies to the plan. A counter cannot do that, because the caller
   * spending an entry need not be its owner: an admin may restore another user's
   * sessions, and then the spender and the owner are different keys.
   */
  private parked = new Map<string, { entry: RebootRestoreEntry; spender: string | undefined }>();
  /**
   * Owners with a restore in flight, between its take and its last pane.
   * Keyed by owner so one user's restore does not turn another user's click into
   * a conflict; `take()` already guarantees no two callers get the same entry.
   * Single-user mode has one key, `undefined`, so it behaves as one global flight.
   */
  private spending = new Set<string | undefined>();

  /** Replace the plan with what the boot pass found. An empty list clears it. */
  set(entries: readonly RebootRestoreEntry[]): void {
    this.entries = new Map(entries.map((entry) => [entry.sessionId, entry]));
    this.builtAt = entries.length > 0 ? Date.now() : 0;
    // A fresh boot plan supersedes anything an in-flight restore still holds.
    this.parked.clear();
  }

  /**
   * The entries a viewer may see, newest plan first-come order preserved.
   *
   * @param canAccess Ownership predicate, so a user sees their own entries and
   *   an admin sees all. Applied here rather than in the route so the count the
   *   banner shows and the entries a click spends come from one filter.
   */
  list(canAccess: (owner: string | undefined) => boolean): RebootRestoreEntry[] {
    this.dropIfExpired();
    return [...this.entries.values()].filter((entry) => canAccess(entry.owner));
  }

  /**
   * Remove and return the entries a click is about to spend.
   *
   * Synchronous and total: an entry leaves the plan here, before any pane is
   * created, so a second click finds nothing to spend. Entries a caller may not
   * access are left in place, and unknown ids are ignored.
   *
   * @param sessionIds The ids to spend, or undefined for every visible entry.
   */
  take(
    canAccess: (owner: string | undefined) => boolean,
    sessionIds: readonly string[] | undefined,
    spender: string | undefined
  ): RebootRestoreEntry[] {
    this.dropIfExpired();
    const wanted = sessionIds ? new Set(sessionIds) : undefined;
    const taken: RebootRestoreEntry[] = [];
    for (const entry of [...this.entries.values()]) {
      if (wanted && !wanted.has(entry.sessionId)) continue;
      if (!canAccess(entry.owner)) continue;
      this.entries.delete(entry.sessionId);
      // Parked rather than forgotten: until this restore resolves the entry, a
      // dismiss still has to be able to reach and cancel it.
      this.parked.set(entry.sessionId, { entry, spender });
      taken.push(entry);
    }
    return taken;
  }

  /**
   * Put entries back after a rebuild never got as far as creating a pane.
   *
   * Used for the click-time rejections that may resolve themselves: a workspace
   * that comes back, a capacity limit the user makes room under, a CLI that
   * starts once its binary is on the PATH. A conversation the user resumed by
   * hand is NOT put back, because that one cannot stop being true, and an entry
   * the banner keeps re-offering forever is noise only Dismiss can clear.
   */
  releaseFlight(spender: string | undefined, keep: readonly RebootRestoreEntry[]): void {
    const wanted = new Set(keep.map((entry) => entry.sessionId));
    let added = 0;
    for (const [sessionId, held] of [...this.parked]) {
      if (held.spender !== spender) continue;
      this.parked.delete(sessionId);
      // Still parked means nothing cancelled it while the restore ran. A dismiss,
      // an expiry or a fresh boot plan removes it from `parked`, and then it does
      // not come back however the restore ended.
      if (wanted.has(sessionId)) {
        this.entries.set(sessionId, held.entry);
        added += 1;
      }
    }
    if (added > 0 && this.builtAt === 0) this.builtAt = Date.now();
  }

  /** Drop the entries a viewer can see. Returns how many went. */
  clear(canAccess: (owner: string | undefined) => boolean): number {
    const removable = [...this.entries.values()].filter((entry) => canAccess(entry.owner));
    for (const entry of removable) this.entries.delete(entry.sessionId);
    // Entries a restore is holding are dismissed by the same rule, so a dismiss
    // that lands mid-restore wins. Judged on the ENTRY's owner, exactly as above,
    // rather than on who happens to be restoring it.
    let parkedRemoved = 0;
    for (const [sessionId, held] of [...this.parked]) {
      if (!canAccess(held.entry.owner)) continue;
      this.parked.delete(sessionId);
      parkedRemoved += 1;
    }
    if (this.entries.size === 0) this.builtAt = 0;
    return removable.length + parkedRemoved;
  }

  /**
   * Claim the right to run a restore for one owner, or report that owner already
   * has one running. Callers that get `true` must call `endSpending()` in a
   * `finally` with the same owner.
   */
  beginSpending(owner?: string): boolean {
    if (this.spending.has(owner)) return false;
    this.spending.add(owner);
    return true;
  }

  endSpending(owner?: string): void {
    this.spending.delete(owner);
  }

  /** Test hook: forget everything, including the single-flight claim. */
  reset(): void {
    this.entries.clear();
    this.parked.clear();
    this.builtAt = 0;
    this.spending.clear();
  }

  private dropIfExpired(): void {
    if (this.builtAt > 0 && Date.now() - this.builtAt > PLAN_TTL_MS) {
      // A restore that took entries just before the expiry must not hand them
      // back afterwards and give an expired plan another full day of life.
      this.parked.clear();
      this.entries.clear();
      this.builtAt = 0;
    }
  }
}

/** Process-wide singleton, mirroring `approvalInbox`. */
export const rebootRestoreRegistry = new RebootRestoreRegistry();
