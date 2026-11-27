/**
 * @fileoverview Whether the Codeman server process itself runs as root (uid 0).
 *
 * A CLI the server starts LOCALLY is its child, so it runs under the same uid, and some
 * CLIs refuse part of their own command line there: Claude Code exits on
 * `--dangerously-skip-permissions` under root ("cannot be used with root/sudo privileges").
 * A server installed and started as root is common on a VPS and in an LXC container, and
 * there every such session showed a dead pane.
 *
 * The answer is read at CALL time, never cached in a module-level const: every local launch
 * asks again, and a test stands in for the uid through `stubServerUidForTest()`.
 *
 * Test hermeticity: under vitest the real uid is never consulted (`false` unless a test
 * stubbed one), so the suite gives the same command lines when it is run as root, in a
 * container for instance.
 *
 * @module utils/server-uid
 */

/** A test's stand-in for the process uid: `null` = no stub, `undefined` = a platform with no uid. */
let stubbedUid: number | undefined | null = null;

/**
 * True when this process runs as uid 0. False on a platform with no uid (`process.getuid`
 * is absent on Windows).
 */
export function serverRunsAsRoot(): boolean {
  if (stubbedUid !== null) return stubbedUid === 0;
  if (process.env.VITEST) return false;
  return typeof process.getuid === 'function' && process.getuid() === 0;
}

/** Test seam: answer as if the server ran under `uid`; `null` puts the hermetic default back. */
export function stubServerUidForTest(uid: number | undefined | null): void {
  stubbedUid = uid;
}
