/**
 * @fileoverview Close a chokidar watcher on its first error, safely.
 *
 * chokidar 3 with `persistent: false` has no guard for an `fs.watch` that
 * throws (EMFILE once the inotify instance limit is used up, ENOSPC once the
 * watch limit is): it emits the error, then a TypeError from closing the
 * watcher it never got, then retries on the parent directory, one level per
 * pass, and re-adds `/` forever, since the parent of `/` is `/`. Only a closed
 * watcher ends that loop, so a watcher whose `'error'` handler just logs logs
 * forever.
 *
 * Closing from the handler is not enough on its own:
 * - `close()` removes every listener, and the TypeError of the same pass is
 *   emitted after it. With no `'error'` listener EventEmitter throws it, and it
 *   reaches the process as an unhandled rejection. So a no-op listener stays
 *   on the closed watcher.
 * - callbacks chokidar already has in flight can still call `add()` (a deleted
 *   file's `_remove()` re-adds the file when chokidar thinks it was the only
 *   watched path), and `add()` sets `closed = false`, which starts the climb
 *   again, silently now. So `add()` becomes a no-op on the closed watcher.
 *
 * @module utils/close-watcher-on-error
 */

import type { FSWatcher } from 'chokidar';

/**
 * Close `watcher` on its first `'error'` and pass that error to `onClosed`,
 * once. The caller's polling has to cover what the watcher watched and create it
 * again later: chokidar 3 reports a one-off ENOENT race through the same error.
 */
export function closeWatcherOnError(watcher: FSWatcher, onClosed: (err: unknown) => void): void {
  watcher.once('error', (err: unknown) => {
    watcher.close().catch(() => {}); // best-effort, like the stop() paths
    watcher.on('error', () => {}); // see the fileoverview
    watcher.add = () => watcher; // likewise
    onClosed(err);
  });
}
