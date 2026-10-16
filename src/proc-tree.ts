/**
 * @fileoverview Bounded descendant walk over a process-tree snapshot.
 *
 * Split out of `tmux-manager.ts` so the traversal can be unit-tested directly. It
 * previously lived as a private method, which meant the regression test had to keep
 * its own copy of the algorithm — a test that passes while the shipped code rots.
 *
 * ## The incident this guards against
 *
 * On 2026-07-30 an unbounded version of this walk took a machine down. It ran
 * `pgrep -P <pid>` once per node and recursed with no visited set, no depth limit and
 * no node cap. Across ~28 adopted tmux trees the fan-out exploded, and because each
 * `pgrep` blocks in the WSL kernel while reading `/proc/<pid>/cgroup`, none of them
 * returned while the walk kept spawning more. Result: ~13,000 `pgrep` processes stuck
 * in D-state out of ~39,000 total, load average above 13,000, and a machine only
 * recoverable by restarting WSL — which cost every running session.
 *
 * Three properties make that impossible, and each has a test:
 *   1. a cycle terminates instead of looping (stale snapshots can contain one),
 *   2. depth is capped,
 *   3. node count is capped.
 *
 * The fourth property — spawning nothing per node — is structural: this function
 * takes a snapshot and cannot spawn anything at all.
 *
 * @module proc-tree
 */

/** Maximum generations to descend. Deeper than any real agent process tree. */
export const PROC_WALK_MAX_DEPTH = 10;

/** Hard ceiling on collected descendants. A backstop, not an expected limit. */
export const PROC_WALK_MAX_NODES = 500;

export interface WalkOptions {
  maxDepth?: number;
  maxNodes?: number;
  /**
   * Called once when a cap truncated the result, with which cap it was. Both are
   * reported: a silent depth cap would hide a deep tree just as effectively as a
   * silent node cap hides a wide one, and the whole point of this module is that
   * truncation is visible rather than mysterious.
   */
  onTruncated?: (pid: number, cap: number, reason: 'nodes' | 'depth') => void;
}

/**
 * All descendants of `pid`, breadth-first and bounded.
 *
 * @param pid      root of the walk; never included in the result
 * @param byParent parent pid → child pids, from ONE `ps` snapshot
 */
export function collectDescendants(
  pid: number,
  byParent: ReadonlyMap<number, readonly number[]>,
  opts: WalkOptions = {}
): number[] {
  const maxDepth = opts.maxDepth ?? PROC_WALK_MAX_DEPTH;
  const maxNodes = opts.maxNodes ?? PROC_WALK_MAX_NODES;

  const out: number[] = [];
  const visited = new Set<number>([pid]);
  let frontier = [pid];

  for (let depth = 0; depth < maxDepth && frontier.length; depth += 1) {
    const next: number[] = [];
    for (const parent of frontier) {
      for (const child of byParent.get(parent) ?? []) {
        if (visited.has(child)) continue; // a real tree has no cycles, a stale
        visited.add(child); // snapshot can still produce one
        out.push(child);
        next.push(child);
        if (out.length >= maxNodes) {
          opts.onTruncated?.(pid, maxNodes, 'nodes');
          return out;
        }
      }
    }
    frontier = next;
    // Ran out of generations while descendants were still queued: the tree is
    // deeper than the cap and the result is incomplete.
    if (depth === maxDepth - 1 && frontier.length > 0) {
      opts.onTruncated?.(pid, maxDepth, 'depth');
    }
  }
  return out;
}

/**
 * The descendants a session kill may signal when the pane's CLI runs a SHARED daemon
 * (`capabilities.sharedDaemon`): only those still in the pane's own process group.
 *
 * Such a CLI's first client starts a per-user daemon that every other session of that
 * CLI talks to, and the daemon detaches itself into its own session (setsid), which also
 * makes it the leader of a new process group. It stays a descendant of that first pane
 * by parent pid, though, so the plain descendant kill took it down with the pane and cut
 * every other session off (measured with jcode: deleting the tab that happened to start
 * the daemon left the next tab's client reconnecting forever). A process that left the
 * pane's group did so on purpose, and its whole subtree inherits the new group, so the
 * group is what draws the line.
 *
 * A pid whose group could not be read is KEPT in the kill list: it most likely exited
 * between the walk and the lookup, and the kill path already checks liveness before it
 * signals. Callers that could not read the groups at all keep the full list, which is
 * the behaviour before this existed.
 *
 * @param descendants the walk's result for the pane pid
 * @param groupOf pgid per pid, as read once by the caller
 * @param paneGroup the pane process's own pgid
 */
export function descendantsInPaneGroup(
  descendants: readonly number[],
  groupOf: ReadonlyMap<number, number>,
  paneGroup: number
): number[] {
  return descendants.filter((pid) => {
    const group = groupOf.get(pid);
    return group === undefined || group === paneGroup;
  });
}
