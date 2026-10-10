/**
 * @fileoverview Remote (SSH) file access for remote-SSH cases.
 *
 * A remote case's `workingDir` is an absolute path on ANOTHER host
 * (`Session.workingDir = RemoteCase.remotePath`, see docs/remote-sessions.md). Every
 * file route used to read it with local `fs`, which cannot work: the local
 * `realpathSync` in `validateSessionFilePath` fails first, so the request died as a
 * 404 "File not found" before a byte was read (#415). This module is the ONE place
 * that reads remote bytes, mirroring how `remote-hosts.ts` is the one place that
 * builds an ssh command line.
 *
 * Connection options come from `buildSshConnectionArgs()` — never a hand-built ssh
 * line (the COD-107 discipline in docs/remote-sessions.md) — so a proxied,
 * custom-port or jump-hosted case reaches its files with exactly the credentials the
 * launch used, and `BatchMode=yes` means a host that needs a passphrase fails fast
 * instead of hanging on a prompt nothing can answer.
 *
 * ⚠️ The path is the injection surface: it arrives from the browser (`?path=`). It is
 * always interpolated as a single `shellescape`d token, and the whole remote command
 * is itself shellescaped into the ssh line, so the local shell and the remote shell
 * each see one opaque argument. Never build a command here by concatenating a raw
 * path into the string.
 *
 * Read-only by design: previews, text reads and streaming. Writing to a remote file
 * is deliberately NOT implemented (docs/file-viewer-edit-plan.md §6), nor are the
 * office-conversion/thumbnail paths that would need the bytes on the server's disk.
 */

import { exec, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { PassThrough, type Readable } from 'node:stream';
import type { SessionRemote } from './types/session.js';
import { buildSshConnectionArgs, remoteSshTarget, shellescape } from './remote-hosts.js';
import { runWithRemoteSshLimit } from './remote-ssh-limiter.js';

const execAsync = promisify(exec);

/**
 * Bound on the probe (realpath + stat) round trip. The connect itself is already
 * bounded by `buildSshConnectionArgs`'s default `-o ConnectTimeout=10`; this covers
 * a host that accepts the TCP connection and then never answers.
 */
const REMOTE_PROBE_TIMEOUT_MS = 20_000;

/** Bound on a buffered remote read (`cat`), on top of the caller's own size cap. */
const REMOTE_READ_TIMEOUT_MS = 30_000;

/** Slack over the caller's byte cap so a file exactly at the limit still fits. */
const READ_BUFFER_SLACK_BYTES = 64 * 1024;

/** Marker a probe prints when the path does not exist on the remote host. */
const NOT_FOUND_MARKER = 'n';

/**
 * Marker a probe prints when the path exists but could NOT be canonicalized (no
 * `readlink -f`, and the portable fallback hit its hop cap or a `readlink` failure).
 * Parsed as `null`, i.e. 404: a path whose real target is unknown must never be
 * served, because every containment and blocklist check runs on the resolved path.
 */
const UNRESOLVABLE_MARKER = 'x';

/**
 * Paths per ssh round trip. The whole remote script is ONE shellescaped argument,
 * and Linux caps a single argv string at 128 KiB, so a 100-entry attachment history
 * of long paths is split rather than risking `E2BIG` on the local `sh`.
 */
const REMOTE_PROBE_CHUNK_SIZE = 40;

/** Symlink hops the portable resolver follows before giving up (Linux uses 40). */
const REMOTE_SYMLINK_MAX_HOPS = 40;

/**
 * Under vitest no real ssh connection may ever be opened (mirrors
 * `checkRemoteTmuxAvailable` and friends in remote-hosts.ts). The route tests mock
 * this module, so nothing reaches here today; this is what keeps the NEXT
 * remote-session test that touches a file route from opening a connection from CI.
 * A clear 502-shaped error, never a fake success: there are no fake bytes to return.
 */
function assertNotUnderTest(): void {
  if (process.env.VITEST) {
    throw new RemoteFileAccessError('remote file access is disabled under test');
  }
}

/** What a remote path turned out to be. `other` = symlink/socket/fifo/device. */
export type RemotePathKind = 'file' | 'directory' | 'other';

export interface RemoteProbe {
  /** The path with symlinks resolved on the REMOTE host. */
  realPath: string;
  kind: RemotePathKind;
  /** Size in bytes (0 for anything that is not a regular file). */
  size: number;
  /** mtime in ms since epoch (0 when the remote `stat` reported none). */
  mtimeMs: number;
}

/**
 * A remote file access failed for a reason that is NOT "the file is missing" —
 * unreachable host, timeout, ssh error, unexpected probe output. Callers map this to
 * a 5xx with the remote reason in the message; a missing file is reported separately
 * as `null`/404 so the two cannot be confused.
 */
export class RemoteFileAccessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RemoteFileAccessError';
  }
}

/**
 * Wrap a remote shell command in the shared, shellescaped ssh line.
 *
 * The single entry point for "run this on the remote host": connection args (port,
 * identity, jump host, SOCKS ProxyCommand, extra `-o`) all come from
 * `buildSshConnectionArgs`, and the command is ONE shellescaped token, so a path with
 * spaces, quotes or `$(…)` cannot escape into the ssh command line.
 */
export function buildRemoteFileCommand(remote: SessionRemote, shellCommand: string): string {
  return [...buildSshConnectionArgs(remote), remoteSshTarget(remote), shellescape(shellCommand)].join(' ');
}

/**
 * `realpath + stat + existence` for one or more paths, in a SINGLE ssh round trip.
 *
 * One call instead of three matters: without a shared connection (no ControlMaster)
 * every extra `ssh` is a fresh handshake, and the file routes need the path AND the
 * workspace root canonicalized to compare them.
 *
 * Output format: the script first prints a lone NUL, then one NUL-terminated record
 * per path, `<index>|n` (missing), `<index>|x` (exists but cannot be canonicalized) or
 * `<index>|kind|size|mtime|realPath`. Records are keyed by INDEX and separated by NUL
 * rather than newline so that a remote filename containing a newline cannot shift the
 * alignment, and the leading NUL is what separates a login banner or an eager rc-file
 * `echo` (which land before the script runs) from the records without any "last N
 * lines" guesswork. `realPath` is the last field, so a `|` in a path still parses.
 *
 * A path starting with `~/` is taken relative to the remote user's `$HOME`: this
 * server does not know that home, and a clicked `~/…` link means the host the
 * session runs on. The record's `realPath` is absolute, as for any other path.
 *
 * Symlink resolution is portable AND fails closed. `readlink -f` where available
 * (Linux, macOS >= 12.3); otherwise the fallback canonicalizes the directory chain
 * with `cd -P`/`pwd -P` and then follows the LAST component with plain `readlink`
 * (which the systems lacking `-f` do have) for a bounded number of hops. A path the
 * fallback cannot resolve prints `x`, never the unresolved string: every containment
 * and blocklist check downstream runs on `realPath`, and an earlier version of this
 * fallback returned the directory-resolved path with the final symlink still in it,
 * so `ws/notes.txt -> ~/.ssh/id_rsa` passed containment while `cat` served the key.
 */
export function buildRemoteProbeCommand(paths: readonly string[]): string {
  const probes = paths.map((path, index) => `probe ${index} ${shellescape(path)}`).join('\n');
  return [
    'resolve_last() {',
    '  q=$1',
    '  hops=0',
    '  while :; do',
    '    d=$(cd -P "$(dirname "$q")" 2>/dev/null && pwd -P) || return 1',
    '    q=$d/$(basename "$q")',
    '    [ -L "$q" ] || break',
    '    hops=$((hops + 1))',
    `    [ "$hops" -le ${REMOTE_SYMLINK_MAX_HOPS} ] || return 1`,
    '    l=$(readlink "$q" 2>/dev/null) || return 1',
    '    [ -n "$l" ] || return 1',
    '    case $l in /*) q=$l ;; *) q=$d/$l ;; esac',
    '  done',
    '  if [ -d "$q" ]; then q=$(cd -P "$q" 2>/dev/null && pwd -P) || return 1; fi',
    '  printf %s "$q"',
    '}',
    'probe() {',
    '  i=$1',
    '  p=$2',
    // `~/…` from a clicked link: THIS host's home (assignment, so no word splitting).
    "  case $p in '~/'*) p=$HOME/${p#??} ;; esac",
    `  if [ ! -e "$p" ]; then printf '%s|${NOT_FOUND_MARKER}\\0' "$i"; return; fi`,
    `  r=$(readlink -f "$p" 2>/dev/null) || r=$(resolve_last "$p") || { printf '%s|${UNRESOLVABLE_MARKER}\\0' "$i"; return; }`,
    `  [ -n "$r" ] || { printf '%s|${UNRESOLVABLE_MARKER}\\0' "$i"; return; }`,
    '  if [ -d "$r" ]; then t=d; elif [ -f "$r" ]; then t=f; else t=o; fi',
    '  s=0',
    '  if [ "$t" = f ]; then s=$(stat -c %s "$r" 2>/dev/null || stat -f %z "$r" 2>/dev/null); [ -n "$s" ] || s=0; fi',
    '  m=$(stat -c %Y "$r" 2>/dev/null || stat -f %m "$r" 2>/dev/null || printf 0)',
    `  printf '%s|%s|%s|%s|%s\\0' "$i" "$t" "$s" "$m" "$r"`,
    '}',
    "printf '\\0'",
    probes,
  ].join('\n');
}

/**
 * Parse one probe record (index prefix already stripped). `null` for the not-found
 * and unresolvable markers or anything malformed.
 */
export function parseRemoteProbeRecord(record: string): RemoteProbe | null {
  if (!record || record === NOT_FOUND_MARKER || record === UNRESOLVABLE_MARKER) return null;

  const parts = record.split('|');
  if (parts.length < 4) return null;

  const [kindRaw, sizeRaw, mtimeRaw] = parts;
  const kind: RemotePathKind | null =
    kindRaw === 'f' ? 'file' : kindRaw === 'd' ? 'directory' : kindRaw === 'o' ? 'other' : null;
  if (!kind) return null;

  const realPath = parts.slice(3).join('|');
  if (!realPath) return null;

  const size = Number.parseInt(sizeRaw, 10);
  const mtimeSeconds = Number.parseInt(mtimeRaw, 10);
  return {
    realPath,
    kind,
    size: Number.isFinite(size) && size > 0 ? size : 0,
    mtimeMs: Number.isFinite(mtimeSeconds) && mtimeSeconds > 0 ? mtimeSeconds * 1000 : 0,
  };
}

/**
 * Parse the output of {@link buildRemoteProbeCommand} into one entry per requested
 * path, in order. Throws when a path's record is missing: that means the transport
 * or the remote shell did something unexpected, and silently treating it as "not
 * found" would turn an infrastructure failure into a wrong 404.
 *
 * Everything before the first NUL is the remote shell's own chatter (banner, rc-file
 * output) and is discarded; records are matched by their index prefix, so neither
 * extra output nor a newline inside a filename can shift the mapping.
 */
export function parseRemoteProbeOutput(stdout: string, paths: readonly string[]): Array<RemoteProbe | null> {
  const records = stdout.split('\0').slice(1);
  const byIndex = new Map<number, string>();
  for (const record of records) {
    const match = /^(\d+)\|([\s\S]*)$/.exec(record);
    if (!match) continue;
    const index = Number.parseInt(match[1], 10);
    if (!byIndex.has(index)) byIndex.set(index, match[2]);
  }
  return paths.map((_, index) => {
    const record = byIndex.get(index);
    if (record === undefined) {
      throw new RemoteFileAccessError('remote host returned no usable file information');
    }
    return parseRemoteProbeRecord(record);
  });
}

/**
 * Probe one or more remote paths. Entry is `null` for a path that does not exist (or
 * could not be canonicalized, which is refused the same way).
 *
 * Large batches are split into round trips of {@link REMOTE_PROBE_CHUNK_SIZE}, each
 * counted against the global ssh limiter, so an attachment history of 100 entries
 * costs three connections in sequence rather than 100 at once.
 */
export async function remoteProbePaths(
  remote: SessionRemote,
  paths: readonly string[]
): Promise<Array<RemoteProbe | null>> {
  assertNotUnderTest();
  const results: Array<RemoteProbe | null> = [];
  for (let offset = 0; offset < paths.length; offset += REMOTE_PROBE_CHUNK_SIZE) {
    const chunk = paths.slice(offset, offset + REMOTE_PROBE_CHUNK_SIZE);
    const command = buildRemoteFileCommand(remote, buildRemoteProbeCommand(chunk));
    let stdout: string;
    try {
      const result = await runWithRemoteSshLimit(() =>
        execAsync(command, { timeout: REMOTE_PROBE_TIMEOUT_MS, maxBuffer: 256 * 1024 })
      );
      stdout = result.stdout;
    } catch (err) {
      throw new RemoteFileAccessError(
        `remote host ${remote.label || remote.host} unreachable: ${describeExecError(err)}`
      );
    }
    results.push(...parseRemoteProbeOutput(stdout, chunk));
  }
  return results;
}

/** Read a whole remote file into memory, capped by `maxBytes`. */
export async function remoteReadFile(remote: SessionRemote, remotePath: string, maxBytes: number): Promise<Buffer> {
  assertNotUnderTest();
  const command = buildRemoteFileCommand(remote, `cat ${shellescape(remotePath)}`);
  try {
    const result = await runWithRemoteSshLimit(() =>
      execAsync(command, {
        timeout: REMOTE_READ_TIMEOUT_MS,
        maxBuffer: maxBytes + READ_BUFFER_SLACK_BYTES,
        encoding: 'buffer',
      })
    );
    return Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout);
  } catch (err) {
    throw new RemoteFileAccessError(`failed to read remote file: ${describeExecError(err)}`);
  }
}

/**
 * Command that writes a remote file's bytes to stdout.
 *
 * ⚠️ Range reads use `tail -c +N | head -c L` (both POSIX, constant memory) because
 * the alternative — `dd bs=1` — issues one read syscall per byte and would make video
 * seeking unusable. The trade-off is that a `tail` failure (the file vanished
 * mid-request) reports `head`'s exit status, i.e. a short body on an already-sent
 * 206; the client retries. The uncompressed path (`cat`) reports its own failure
 * correctly, so the streaming error path is still covered by the normal case.
 */
export function buildRemoteReadCommand(remotePath: string, range?: { start: number; end: number }): string {
  const quoted = shellescape(remotePath);
  if (!range) return `cat ${quoted}`;
  const length = range.end - range.start + 1;
  return `tail -c +${range.start + 1} ${quoted} | head -c ${length}`;
}

export interface RemoteFileStream {
  /** The remote file's bytes, streamed from the ssh child's stdout. */
  stream: Readable;
  /**
   * Abort the transfer and reap the ssh child. The caller MUST call this when the
   * HTTP request ends — especially on a client disconnect — or the `ssh` process
   * keeps running (and holding a connection open) after nobody is reading it.
   */
  close(): void;
}

/**
 * Stream a remote file (optionally a byte range) as a Node Readable.
 *
 * Nothing is buffered in server memory: the bytes go from `ssh`'s stdout straight to
 * the HTTP response, which is what makes a multi-GB remote video cost one pipe.
 */
export function remoteCreateReadStream(
  remote: SessionRemote,
  remotePath: string,
  range?: { start: number; end: number }
): RemoteFileStream {
  if (process.env.VITEST) {
    // Same rule as the buffered calls, in stream form: the consumer sees the error
    // through the stream's normal failure path instead of a connection attempt.
    const stream = new PassThrough();
    process.nextTick(() => stream.destroy(new RemoteFileAccessError('remote file access is disabled under test')));
    return { stream, close: () => stream.destroy() };
  }
  const command = buildRemoteFileCommand(remote, buildRemoteReadCommand(remotePath, range));
  const child = spawn(command, { shell: true, stdio: ['ignore', 'pipe', 'pipe'] });

  let stderr = '';
  child.stderr?.on('data', (chunk: Buffer) => {
    if (stderr.length < 2000) stderr += chunk.toString();
  });

  const stream = child.stdout;
  let ended = false;
  stream.on('end', () => {
    ended = true;
  });
  stream.on('error', () => {
    ended = true;
  });

  child.on('error', (err: Error) => {
    stream.destroy(err);
  });
  child.on('close', (code: number | null) => {
    // Only a truncated transfer is an error. A non-zero exit AFTER the body finished
    // (e.g. a signal delivered as the last byte was flushed) must not destroy an
    // already-complete response, or the browser reports a broken body for a file it
    // received in full.
    if (ended || code === 0 || code === null) return;
    const detail = stderr.trim().split('\n')[0];
    stream.destroy(new RemoteFileAccessError(`remote read failed (ssh exit ${code})${detail ? `: ${detail}` : ''}`));
  });

  return {
    stream,
    close(): void {
      if (!stream.destroyed) stream.destroy();
      child.kill('SIGTERM');
    },
  };
}

/**
 * First useful line of an exec/stderr error, for a user-facing message.
 *
 * ⚠️ Never Node's `err.message`: for a failed `exec` it is `Command failed: <the whole
 * ssh line>`, which carries the identity-file path and the probe script, and this
 * string goes out in a 502 body. stderr, the timeout flag and the exit/spawn code are
 * everything a user can act on.
 */
function describeExecError(err: unknown): string {
  if (typeof err === 'object' && err !== null) {
    const record = err as { stderr?: unknown; code?: unknown; killed?: unknown };
    const stderr =
      typeof record.stderr === 'string' ? record.stderr : Buffer.isBuffer(record.stderr) ? String(record.stderr) : '';
    const line = stderr
      .split('\n')
      .map((entry) => entry.trim())
      .find((entry) => entry.length > 0);
    if (line) return line.slice(0, 300);
    if (record.killed) return 'timed out';
    if (typeof record.code === 'number') return `ssh exit ${record.code}`;
    if (typeof record.code === 'string') return `ssh could not be started (${record.code})`;
  }
  return 'unknown error';
}
