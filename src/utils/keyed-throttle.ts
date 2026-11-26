/**
 * @fileoverview Per-key throttle: at most one send per key per interval, and the last call in a
 * burst is never lost.
 *
 * The first call for a key in a quiet period sends at once. A call inside the interval after a
 * send schedules one trailing send at the interval's end, and later calls collapse into it while
 * it is pending. The trailing send runs the newest `send` it was given. Timers are unref'd, so a
 * pending send never holds the process open. Its method names match KeyedDebouncer's
 * (debouncer.ts): `cancelKey()` forgets one key, and `dispose()` forgets them all, which is how
 * it integrates with CleanupManager.
 *
 * @module utils/keyed-throttle
 */

interface ThrottleState {
  lastAt: number;
  timer: NodeJS.Timeout | null;
  send: () => void;
}

export class KeyedThrottle<K = string> {
  private readonly state = new Map<K, ThrottleState>();

  constructor(private readonly intervalMs: number) {}

  /** Send for `key` now if its interval has passed, else once at the interval's end. */
  fire(key: K, send: () => void): void {
    let entry = this.state.get(key);
    if (!entry) {
      entry = { lastAt: 0, timer: null, send };
      this.state.set(key, entry);
    }
    entry.send = send;
    // A trailing send is already scheduled, and it covers this call.
    if (entry.timer) return;
    const wait = entry.lastAt + this.intervalMs - Date.now();
    if (wait <= 0) {
      entry.lastAt = Date.now();
      send();
      return;
    }
    const scheduled = entry;
    scheduled.timer = setTimeout(() => {
      scheduled.timer = null;
      scheduled.lastAt = Date.now();
      scheduled.send();
    }, wait);
    scheduled.timer.unref?.();
  }

  /** Forget `key`, dropping its pending trailing send. */
  cancelKey(key: K): void {
    const entry = this.state.get(key);
    if (entry?.timer) clearTimeout(entry.timer);
    this.state.delete(key);
  }

  /** Forget every key, dropping every pending send. The CleanupManager integration point. */
  dispose(): void {
    for (const entry of this.state.values()) {
      if (entry.timer) clearTimeout(entry.timer);
    }
    this.state.clear();
  }
}
