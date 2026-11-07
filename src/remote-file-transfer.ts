/**
 * @fileoverview Shared symlink-safe, atomic remote file-write over SSH (COD-241).
 *
 * Extracted from the paste-image path (session-routes.ts) so BOTH the paste-image
 * route and the document-upload route (file-routes.ts) build the identical remote
 * shell script and spawn the `ssh` child the same way — they cannot drift.
 *
 * The remote script is deliberately minimal and defensive:
 *  - refuses a symlinked / non-directory target dir (an agent could plant
 *    `.codeman-attachments -> ~/.ssh`), exiting 73 with a clear stderr message;
 *  - `mkdir`s the dir only when absent (non-recursive — no path traversal);
 *  - `umask 077` so the staged bytes are private;
 *  - stages to a temp file, then `mv -n` (no-clobber) into place atomically,
 *    and cleans the temp file up.
 *
 * COD-107: every dynamic value (dir, file, tmp, and the message) is `shellescape`d
 * into a single quoted token, so spaces / `$` / backticks / quotes in a path are
 * inert. Connection tokens come from `buildSshConnectionArgv` — the ssh line is
 * never hand-built here.
 */

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { buildSshConnectionArgv, remoteSshTarget, shellescape, withRemotePathBootstrap } from './remote-hosts.js';
import type { SessionRemote } from './types/session.js';

export interface RemoteFileWriteScriptOptions {
  /** Absolute remote directory that will hold the file (created if absent). */
  dir: string;
  /** Absolute remote destination path. */
  filePath: string;
  /** Absolute remote temp path used for atomic staging. */
  tmpPath: string;
  /** stderr message (exit 73) when `dir` exists but is a symlink / not a directory. */
  notADirectoryMessage: string;
  /** Opt-in private upload directories and strict staged-file cleanup. */
  privateDirectory?: boolean;
  strict?: boolean;
}

/**
 * Build the remote shell script that atomically writes stdin bytes to `filePath`.
 * Pure + deterministic (no randomness) so it is fully unit-testable.
 */
export function buildRemoteFileWriteScript(opts: RemoteFileWriteScriptOptions): string {
  return withRemotePathBootstrap(
    [
      ...(opts.strict ? ['set -eu'] : []),
      `dir=${shellescape(opts.dir)}`,
      `file=${shellescape(opts.filePath)}`,
      `tmp=${shellescape(opts.tmpPath)}`,
      `if [ -L "$dir" ] || { [ -e "$dir" ] && [ ! -d "$dir" ]; }; then echo ${shellescape(
        opts.notADirectoryMessage
      )} >&2; exit 73; fi`,
      'umask 077',
      'if [ ! -e "$dir" ]; then mkdir "$dir"; fi',
      ...(opts.privateDirectory ? ['chmod 700 "$dir"'] : []),
      ...(opts.strict ? [`trap 'rm -f "$tmp"' EXIT HUP INT TERM`] : []),
      'cat > "$tmp"',
      'mv -n "$tmp" "$file"',
      'rm -f "$tmp"',
    ].join('; ')
  );
}

export interface WriteRemoteFileBytesOptions extends Omit<RemoteFileWriteScriptOptions, 'tmpPath'> {
  /** Bytes to write on the ssh child's stdin. */
  bytes: Buffer;
  /** Client-side hard timeout (ms) for the whole ssh transfer. */
  timeoutMs: number;
  /** Human-readable label used in timeout / failure error messages. */
  transferLabel: string;
  /** Optional explicit temp path (default: `${filePath}.tmp-<hex>`). */
  tmpPath?: string;
}

/**
 * Stream `bytes` to a remote file over ssh using {@link buildRemoteFileWriteScript}.
 * Resolves on exit 0; rejects with a `transferLabel`-prefixed error on timeout,
 * spawn error, or non-zero exit (remote stderr is surfaced when present).
 */
export async function writeRemoteFileBytes(remote: SessionRemote, opts: WriteRemoteFileBytesOptions): Promise<void> {
  const tmpPath = opts.tmpPath ?? `${opts.filePath}.tmp-${randomBytes(4).toString('hex')}`;
  const script = buildRemoteFileWriteScript({
    dir: opts.dir,
    filePath: opts.filePath,
    tmpPath,
    notADirectoryMessage: opts.notADirectoryMessage,
    privateDirectory: opts.privateDirectory,
    strict: opts.strict,
  });
  const args = [...buildSshConnectionArgv(remote), '-o', 'ConnectTimeout=10', remoteSshTarget(remote), script];
  await new Promise<void>((resolve, reject) => {
    const child = spawn('ssh', args, { stdio: ['pipe', 'ignore', 'pipe'] });
    const stderr: Buffer[] = [];
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      fn();
    };
    const timeout = setTimeout(() => {
      finish(() => {
        child.kill('SIGTERM');
        reject(new Error(`${opts.transferLabel} timed out connecting to ${remote.host}`));
      });
    }, opts.timeoutMs);
    child.stderr.on('data', (chunk: Buffer) => stderr.push(Buffer.from(chunk)));
    child.on('error', (err) => finish(() => reject(err)));
    child.on('close', (code) => {
      if (code === 0) {
        finish(resolve);
        return;
      }
      const message = Buffer.concat(stderr).toString('utf8').trim();
      finish(() => reject(new Error(message || `${opts.transferLabel} failed with exit code ${code ?? 'unknown'}`)));
    });
    child.stdin.end(opts.bytes);
  });
}
