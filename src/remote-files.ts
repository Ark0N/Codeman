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
import type { EditSourceReadOptions, EditSourceRequest, EditSources } from './edit-history-local-source.js';

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

/** One entry of a remote folder listing: a file (with size/mtime) or a subfolder. */
export interface RemoteFolderEntry {
  kind: 'file' | 'directory';
  name: string;
  size: number;
  mtimeMs: number;
}

/** A remote folder listing; `dir` is the folder with symlinks resolved on the remote host. */
export interface RemoteFolderListing {
  dir: string;
  entries: RemoteFolderEntry[];
  truncated: boolean;
}

/**
 * List one remote folder in a SINGLE ssh round trip: its canonical path, then every
 * non-hidden subfolder and every regular file (symlinks followed) whose name ends in
 * one of `extensions` (any case), up to `maxEntries`.
 *
 * Same output discipline as {@link buildRemoteProbeCommand}: a lone NUL first (so rc
 * chatter before it is discarded), then NUL-terminated records — `E|n` (no such
 * folder), `E|x` (cannot be canonicalized), `D|<dir>`, `d|0|0|<name>`,
 * `f|<size>|<mtime>|<name>`, and `T|` when the cap cut the listing. The name is the
 * last field, so a `|` in it still parses, and NUL is the one byte a filename cannot
 * hold. A leading `~/` is the remote user's `$HOME`, as in the probe.
 */
export function buildRemoteFolderListCommand(dir: string, extensions: readonly string[], maxEntries: number): string {
  // `[pP][nN][gG]`: any case, as the local listing compares lowercased (`shot.Png`).
  const patterns = [...new Set(extensions.map((ext) => ext.toLowerCase()))]
    .map((ext) => `*.${ext.replace(/[a-z]/g, (c) => `[${c}${c.toUpperCase()}]`)}`)
    .join('|');
  const script = [
    `d=${shellescape(dir)}`,
    "case $d in '~/'*) d=$HOME/${d#??} ;; esac",
    "printf '\\0'",
    '[ -d "$d" ] || { [ -e "$d" ] && printf \'E|f\\0\' || printf \'E|n\\0\'; exit 0; }',
    'r=$(cd -P "$d" 2>/dev/null && pwd -P) || { printf \'E|x\\0\'; exit 0; }',
    'printf \'D|%s\\0\' "$r"',
    'n=0',
    'for f in "$r"/*; do',
    '  [ -e "$f" ] || continue',
    `  [ "$n" -lt ${Math.max(1, Math.floor(maxEntries))} ] || { printf 'T|\\0'; break; }`,
    '  b=${f##*/}',
    '  if [ -d "$f" ]; then n=$((n + 1)); printf \'d|0|0|%s\\0\' "$b"; continue; fi',
    '  [ -f "$f" ] || continue',
    `  case $b in ${patterns || '*.__none__'}) ;; *) continue ;; esac`,
    "  sm=$(stat -L -c '%s %Y' \"$f\" 2>/dev/null || stat -L -f '%z %m' \"$f\" 2>/dev/null) || sm='0 0'",
    '  n=$((n + 1))',
    '  printf \'f|%s|%s|%s\\0\' "${sm% *}" "${sm#* }" "$b"',
    'done',
  ].join('\n');
  // ⚠️ sshd runs the command in the remote user's LOGIN shell, rc aliases included.
  // On Hufflepuff `cd` is an alias that echoes the new directory (`$(cd -P "$d" &&
  // pwd -P)` came back as two lines, then zsh aborted on the glob: "no matches found:
  // /x\n/x/*"), so no folder listing worked over ssh. An explicit `sh` reads no rc
  // file — the same wrapper the transcript read uses.
  return `sh -c ${shellescape(script)}`;
}

/**
 * Parse {@link buildRemoteFolderListCommand} output: null when nothing exists there
 * (or it cannot be resolved), `'not-a-folder'` when it is a file.
 */
export function parseRemoteFolderListOutput(stdout: string): RemoteFolderListing | 'not-a-folder' | null {
  const records = stdout.split('\0').slice(1);
  let dir: string | null = null;
  let truncated = false;
  const entries: RemoteFolderEntry[] = [];
  for (const record of records) {
    if (record === 'E|f') return 'not-a-folder';
    if (record.startsWith('E|')) return null;
    if (record.startsWith('D|')) {
      dir = record.slice(2);
      continue;
    }
    if (record === 'T|') {
      truncated = true;
      continue;
    }
    const match = /^([fd])\|(\d*)\|(\d*)\|([\s\S]+)$/.exec(record);
    if (!match) continue;
    const size = Number.parseInt(match[2], 10);
    const mtime = Number.parseInt(match[3], 10);
    entries.push({
      kind: match[1] === 'd' ? 'directory' : 'file',
      name: match[4],
      size: Number.isFinite(size) && size > 0 ? size : 0,
      mtimeMs: Number.isFinite(mtime) && mtime > 0 ? mtime * 1000 : 0,
    });
  }
  if (!dir) {
    throw new RemoteFileAccessError('remote host returned no usable folder listing');
  }
  return { dir, entries, truncated };
}

/** List a remote folder (see {@link buildRemoteFolderListCommand}). */
export async function remoteListFolder(
  remote: SessionRemote,
  dir: string,
  extensions: readonly string[],
  maxEntries: number
): Promise<RemoteFolderListing | 'not-a-folder' | null> {
  assertNotUnderTest();
  const command = buildRemoteFileCommand(remote, buildRemoteFolderListCommand(dir, extensions, maxEntries));
  let stdout: string;
  try {
    const result = await runWithRemoteSshLimit(() =>
      execAsync(command, { timeout: REMOTE_PROBE_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 })
    );
    stdout = result.stdout;
  } catch (err) {
    throw new RemoteFileAccessError(
      `remote host ${remote.label || remote.host} unreachable: ${describeExecError(err)}`
    );
  }
  return parseRemoteFolderListOutput(stdout);
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

/** Conversation ids are uuids; anything else never reaches the remote shell. */
const CLAUDE_TRANSCRIPT_ID_PATTERN = /^[A-Za-z0-9._-]+$/;

/** Exit status the edit-history scripts use for "no such transcript on that host". */
const TRANSCRIPT_NOT_FOUND_EXIT = 3;

/** Transcript files an edit-source request may name; nothing else reaches the shell. */
const EDIT_SOURCE_REL_PATH_PATTERN = /^(main|subagents\/agent-[A-Za-z0-9_-]+\.jsonl)$/;

/** The meta record's relPath; group 1 is the agentId. */
const EDIT_SOURCE_META_REL_PATH_PATTERN = /^subagents\/agent-([A-Za-z0-9_-]+)\.meta\.json$/;

/** Cap on one subagent `.meta.json` record (outside the transcript budget), as in the local reader. */
const EDIT_SOURCE_META_MAX_BYTES = 8192;

/** Cap on all meta records of one read; a meta past it is sent with a later read. */
const EDIT_SOURCE_META_BUDGET_BYTES = 4 * 1024 * 1024;

/** Room for the record headers (one per transcript file) on top of budget and metas. */
const EDIT_SOURCE_HEADER_SLACK_BYTES = 1024 * 1024;

/**
 * The slowest link an edit-history read is given time for. Such a read can carry megabytes
 * (a forward pass its budget plus the metas, "Load older" up to three budgets), which a flat
 * {@link REMOTE_READ_TIMEOUT_MS} would cut off below ~1 MiB/s. 256 KiB/s ≈ 2 Mbit/s.
 */
const EDIT_SOURCE_MIN_BYTES_PER_SEC = 256 * 1024;

/**
 * Timeout of an edit-history read that may return up to `maxBytes`: the flat read timeout plus
 * the transfer time at {@link EDIT_SOURCE_MIN_BYTES_PER_SEC}. It ends a hung read (a host that
 * fell asleep mid-transfer; no keepalives, see the wake invariants), it does not cut a slow one.
 */
export function remoteEditSourcesTimeoutMs(maxBytes: number): number {
  return REMOTE_READ_TIMEOUT_MS + Math.ceil((Math.max(0, maxBytes) / EDIT_SOURCE_MIN_BYTES_PER_SEC) * 1000);
}

const TMUX_NAME_PATTERN = /^[A-Za-z0-9._-]+$/;

/** Where a remote session's agent runs: the remote tmux socket and session (`remoteTmuxLocation`). */
export interface RemoteClaudePane {
  socket: string;
  sessionName: string;
}

function isByteCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/** De-duplicated ids that match {@link CLAUDE_TRANSCRIPT_ID_PATTERN}, in order. */
function safeClaudeTranscriptIds(ids: readonly string[]): string[] {
  return [...new Set(ids)].filter((id) => CLAUDE_TRANSCRIPT_ID_PATTERN.test(id));
}

/** A main transcript path the read script takes: absolute, `<id>.jsonl`, no NUL or newline. */
export function isRemoteClaudeTranscriptPath(path: string): boolean {
  if (!path.startsWith('/') || !path.endsWith('.jsonl') || /[\0\n]/.test(path)) return false;
  return CLAUDE_TRANSCRIPT_ID_PATTERN.test(path.slice(path.lastIndexOf('/') + 1, -'.jsonl'.length));
}

/**
 * Shell lines that set `cfg` to claude's config dir on the remote host: an absolute
 * `CLAUDE_CONFIG_DIR` from the ssh command's environment, else `$HOME/.claude` — claude's own
 * rule. ⚠️ The remote claude runs under `$SHELL -i -l -c` (`remoteLoginShellCommand`), this
 * script under a plain non-interactive `sh` from sshd's `$SHELL -c`: a `CLAUDE_CONFIG_DIR` set
 * only in a login or interactive profile (`.profile`, `.bash_profile`, `.zshrc`) is not seen
 * here; one from `.zshenv`, sshd `SetEnv` or the system environment is.
 */
function claudeConfigDirLines(): string[] {
  return ['cfg=$HOME/.claude', 'case ${CLAUDE_CONFIG_DIR:-} in /*) cfg=$CLAUDE_CONFIG_DIR ;; esac'];
}

/**
 * Shell lines that set `live` to the conversation the claude in `pane` is writing NOW,
 * or leave it empty; they need `cfg` ({@link claudeConfigDirLines}). Codeman launches a
 * remote claude with `--session-id <id>`, but a `/clear` (or a resume picked inside claude)
 * starts a new conversation, and with no hooks from a remote host Codeman never hears of it.
 * claude itself keeps `<config dir>/sessions/<pid>.json` with the current `sessionId`, so: the
 * pane's pid, its children and grandchildren (a wrapper shell may sit in between), the first
 * of those with such a file. Only `[A-Za-z0-9._-]` survives the `sed`, the id pattern, so
 * `$live` is safe unquoted. `ps -A -o pid= -o ppid=` is POSIX (no GNU `--ppid`).
 */
function liveClaudeIdLines(pane: RemoteClaudePane | undefined): string[] {
  if (!pane || !TMUX_NAME_PATTERN.test(pane.socket) || !TMUX_NAME_PATTERN.test(pane.sessionName)) return [];
  return [
    'live=',
    `pp=$(tmux -L ${shellescape(pane.socket)} list-panes -t ${shellescape(`=${pane.sessionName}`)} -F '#{pane_pid}' 2>/dev/null | head -n 1)`,
    "case $pp in ''|*[!0-9]*) pp= ;; esac",
    'if [ -n "$pp" ]; then',
    '  tree=$(ps -A -o pid= -o ppid= 2>/dev/null)',
    '  kids=$(printf \'%s\\n\' "$tree" | awk -v p="$pp" \'$2 == p { print $1 }\')',
    '  grand=$(for k in $kids; do printf \'%s\\n\' "$tree" | awk -v p="$k" \'$2 == p { print $1 }\'; done)',
    '  for c in $pp $kids $grand; do',
    '    f="$cfg/sessions/$c.json"',
    '    [ -f "$f" ] || continue',
    '    live=$(sed -n \'s/.*"sessionId":"\\([A-Za-z0-9._-]*\\)".*/\\1/p\' "$f" | head -n 1)',
    '    [ -n "$live" ] && break',
    '  done',
    'fi',
  ];
}

/**
 * Script that finds a remote claude session's main transcript and prints `\0<path>\0`;
 * exit {@link TRANSCRIPT_NOT_FOUND_EXIT} when there is none. First the conversation the
 * claude in `pane` writes now ({@link liveClaudeIdLines}); without one, the most recently
 * written transcript of ALL `ids`, not the first id that has one: the conversation claude
 * wrote last is the current one whether a `/clear` moved on from the launch id or a respawn
 * resumed it again, and no order of the ids gets both right. Each id is looked up as
 * `<config dir>/projects/*\/<id>.jsonl` ({@link claudeConfigDirLines}). `$HOME` is expanded
 * by the REMOTE shell: the transcript lives in the remote user's home, which the server
 * cannot know.
 *
 * ⚠️ Runs under an explicit `sh` with `LC_ALL=C`: sshd runs a command in the remote user's
 * LOGIN shell, and on a zsh host `ls` can be an alias and an unmatched glob aborts the whole
 * script ("no matches found"). So: no `ls` at all, the newest file wins via `-nt`, and an
 * `[ -f ]` guard on every glob. `C` makes bracket ranges and glob order plain bytes.
 */
export function buildRemoteClaudeTranscriptLocateCommand(ids: readonly string[], pane?: RemoteClaudePane): string {
  const safeIds = safeClaudeTranscriptIds(ids);
  if (safeIds.length === 0) return `exit ${TRANSCRIPT_NOT_FOUND_EXIT}`;
  const liveLines = liveClaudeIdLines(pane);
  const script = [
    'LC_ALL=C',
    'export LC_ALL',
    'best=',
    ...claudeConfigDirLines(),
    // newest <id>: `best` becomes that id's transcript if it is newer than the current best.
    'newest() {',
    '  for f in "$cfg"/projects/*/"$1".jsonl; do',
    '    [ -f "$f" ] || continue',
    '    if [ -z "$best" ] || [ "$f" -nt "$best" ]; then best=$f; fi',
    '  done',
    '}',
    ...liveLines,
    ...(liveLines.length ? ['[ -z "$live" ] || newest "$live"'] : []),
    'if [ -z "$best" ]; then',
    `  for id in ${safeIds.map((id) => shellescape(id)).join(' ')}; do newest "$id"; done`,
    'fi',
    `[ -n "$best" ] || exit ${TRANSCRIPT_NOT_FOUND_EXIT}`,
    'printf \'\\0%s\\0\' "$best"',
  ].join('\n');
  return `sh -c ${shellescape(script)}`;
}

/** The path from {@link buildRemoteClaudeTranscriptLocateCommand} output; null when there is none. */
export function parseRemoteClaudeTranscriptLocate(stdout: Buffer): string | null {
  const start = stdout.indexOf(0);
  const end = start === -1 ? -1 : stdout.indexOf(0, start + 1);
  if (end === -1) return null;
  const path = stdout.toString('utf8', start + 1, end);
  return isRemoteClaudeTranscriptPath(path) ? path : null;
}

/**
 * Find a remote claude session's main transcript in ONE ssh round trip (see
 * {@link buildRemoteClaudeTranscriptLocateCommand}). `null` when it has none; an unreachable
 * host, an ssh failure or broken output is a `RemoteFileAccessError`. Never wakes a host: a
 * sleeping one is a connect timeout, like every other read in this module.
 */
export async function remoteLocateClaudeTranscript(
  remote: SessionRemote,
  ids: readonly string[],
  pane?: RemoteClaudePane
): Promise<string | null> {
  assertNotUnderTest();
  const command = buildRemoteFileCommand(remote, buildRemoteClaudeTranscriptLocateCommand(ids, pane));
  let stdout: Buffer;
  try {
    const result = await runWithRemoteSshLimit(() =>
      execAsync(command, { timeout: REMOTE_READ_TIMEOUT_MS, maxBuffer: READ_BUFFER_SLACK_BYTES, encoding: 'buffer' })
    );
    stdout = Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout);
  } catch (err) {
    if ((err as { code?: unknown }).code === TRANSCRIPT_NOT_FOUND_EXIT) return null;
    throw new RemoteFileAccessError(
      `remote host ${remote.label || remote.host} unreachable: ${describeExecError(err)}`
    );
  }
  const path = parseRemoteClaudeTranscriptLocate(stdout);
  if (!path) throw new RemoteFileAccessError('unexpected output from the remote transcript lookup');
  return path;
}

/**
 * Script that reads a remote claude session's main transcript at `mainPath` and its subagent
 * transcripts (`<mainPath without .jsonl>/subagents/agent-<id>.jsonl`) in ONE ssh round trip,
 * with exactly the local reader's rules (`readClaudeEditSources`):
 *
 * - a request without `len` reads from `offset` (clamped to the size);
 * - a request with `len` is a block that ends at `offset + len`: short of budget, its end;
 * - a file without a request (one the caller has not seen) reads its last bytes, and a new
 *   subagent's `.meta.json` (≤ {@link EDIT_SOURCE_META_MAX_BYTES}, outside the budget) comes
 *   along as its own record; with `onlyRequested` such files are left out.
 *
 * `budgetBytes` is shared by all transcript files, main first, then the subagents in byte
 * order. A file that gets none of it still produces a zero-length record, because the caller
 * needs its size. Exit {@link TRANSCRIPT_NOT_FOUND_EXIT} when `mainPath` is not a file.
 *
 * Output: `\0<transcriptId>\0`, then per record `<relPath>\0<size>\0<start>\0<len>\0`
 * followed by exactly `<len>` raw bytes. Should a file shrink between `wc -c` and the read,
 * the slice is NUL-padded to `<len>` so the framing never shifts.
 *
 * Inputs never reach the script unchecked: the path via {@link isRemoteClaudeTranscriptPath}
 * (and shellescaped), relPaths via {@link EDIT_SOURCE_REL_PATH_PATTERN}, offsets and lengths as
 * plain digits; anything invalid is dropped. A subagent file whose name the pattern would
 * reject is skipped on the remote side too. Same `sh` + `LC_ALL=C` rules as the lookup.
 */
export function buildRemoteClaudeEditSourcesCommand(
  mainPath: string,
  requests: readonly EditSourceRequest[],
  budgetBytes: number,
  opts: EditSourceReadOptions = {}
): string {
  if (!isRemoteClaudeTranscriptPath(mainPath)) return `exit ${TRANSCRIPT_NOT_FOUND_EXIT}`;
  const transcriptId = mainPath.slice(mainPath.lastIndexOf('/') + 1, -'.jsonl'.length);

  const byRelPath = new Map<string, { offset: number; len: number | null }>();
  for (const request of requests) {
    if (!request || typeof request.relPath !== 'string') continue;
    if (!EDIT_SOURCE_REL_PATH_PATTERN.test(request.relPath)) continue;
    if (!isByteCount(request.offset)) continue;
    if (request.len !== undefined && !isByteCount(request.len)) continue;
    if (byRelPath.has(request.relPath)) continue;
    byRelPath.set(request.relPath, { offset: request.offset, len: request.len ?? null });
  }
  const budget = Number.isFinite(budgetBytes) ? Math.max(0, Math.floor(budgetBytes)) : 0;
  const requestArgs = (request: { offset: number; len: number | null }): string =>
    `r ${request.offset} ${request.len === null ? "''" : String(request.len)}`;

  const main = byRelPath.get('main');
  const mainLine = main
    ? `emit main "$best" ${requestArgs(main)}`
    : opts.onlyRequested
      ? ''
      : 'emit main "$best" t 0 \'\'';
  const subagentCases = [...byRelPath.entries()]
    .filter(([relPath]) => relPath !== 'main')
    .map(([relPath, request]) => {
      const name = relPath.slice('subagents/'.length);
      return `    ${shellescape(name)}) emit "subagents/$b" "$f" ${requestArgs(request)} ;;`;
    });
  const newSubagent = opts.onlyRequested
    ? ['    *) ;;']
    : [
        '    *) emit "subagents/$b" "$f" t 0 \'\'',
        '      m=${f%.jsonl}.meta.json',
        '      if [ -f "$m" ]; then',
        '        fsize "$m"',
        `        mn=$s; [ "$mn" -le ${EDIT_SOURCE_META_MAX_BYTES} ] || mn=${EDIT_SOURCE_META_MAX_BYTES}`,
        '        if [ "$mn" -le "$mbudget" ]; then',
        '          mbudget=$((mbudget - mn))',
        '          printf \'%s\\0%s\\0%s\\0%s\\0\' "subagents/${b%.jsonl}.meta.json" "$s" 0 "$mn"',
        '          [ "$mn" -eq 0 ] || bytes "$m" 0 "$mn"',
        '        fi',
        '      fi ;;',
      ];

  const script = [
    'LC_ALL=C',
    'export LC_ALL',
    `best=${shellescape(mainPath)}`,
    `[ -f "$best" ] || exit ${TRANSCRIPT_NOT_FOUND_EXIT}`,
    `printf '\\0%s\\0' ${shellescape(transcriptId)}`,
    `budget=${budget}`,
    `mbudget=${EDIT_SOURCE_META_BUDGET_BYTES}`,
    // Size via `wc -c <` (POSIX; BSD pads it with spaces, hence the tr).
    'fsize() {',
    '  s=$(wc -c < "$1" 2>/dev/null | tr -d \' \\t\\n\')',
    "  case $s in ''|*[!0-9]*) s=0 ;; esac",
    '}',
    // Exactly $3 bytes of $1 from offset $2, NUL-padded if the file shrank meanwhile.
    'bytes() {',
    '  { tail -c +$(($2 + 1)) "$1" 2>/dev/null | head -c "$3"; head -c "$3" /dev/zero; } | head -c "$3"',
    '}',
    // emit <relPath> <file> <r|t> <offset> <len|''>: r = a request, t = the tail of a new file.
    'emit() {',
    '  fsize "$2"',
    '  if [ "$3" = r ] && [ -n "$5" ]; then',
    '    bs=$4; [ "$bs" -le "$s" ] || bs=$s',
    '    be=$(($4 + $5)); [ "$be" -le "$s" ] || be=$s',
    '    n=$((be - bs)); [ "$n" -le "$budget" ] || n=$budget',
    '    start=$((be - n))',
    '  elif [ "$3" = r ]; then',
    '    start=$4; [ "$start" -le "$s" ] || start=$s',
    '    n=$((s - start)); [ "$n" -le "$budget" ] || n=$budget',
    '  else',
    '    n=$s; [ "$n" -le "$budget" ] || n=$budget',
    '    start=$((s - n))',
    '  fi',
    '  budget=$((budget - n))',
    '  printf \'%s\\0%s\\0%s\\0%s\\0\' "$1" "$s" "$start" "$n"',
    '  [ "$n" -eq 0 ] || bytes "$2" "$start" "$n"',
    '}',
    mainLine,
    'for f in "${best%.jsonl}"/subagents/agent-*.jsonl; do',
    '  [ -f "$f" ] || continue',
    '  b=${f##*/}',
    '  case $b in agent-.jsonl|agent-*[!A-Za-z0-9_-]*.jsonl) continue ;; esac',
    '  case $b in',
    ...subagentCases,
    ...newSubagent,
    '  esac',
    'done',
  ].join('\n');
  return `sh -c ${shellescape(script)}`;
}

/**
 * Parse {@link buildRemoteClaudeEditSourcesCommand} output, byte-exact on the Buffer (a chunk
 * may end mid UTF-8 sequence, so nothing here measures decoded strings). Everything before
 * the first NUL is rc-file chatter. `null` = protocol broken: a missing or malformed header
 * field, an unknown relPath, a slice outside the file or a body shorter than its length.
 */
export function parseRemoteClaudeEditSources(stdout: Buffer): EditSources | null {
  let pos = stdout.indexOf(0);
  if (pos === -1) return null;
  pos += 1;

  const readField = (): string | null => {
    const end = stdout.indexOf(0, pos);
    if (end === -1) return null;
    const field = stdout.toString('utf8', pos, end);
    pos = end + 1;
    return field;
  };
  const readNumber = (): number | null => {
    const field = readField();
    if (field === null || !/^\d+$/.test(field)) return null;
    const value = Number(field);
    return Number.isSafeInteger(value) ? value : null;
  };

  const transcriptId = readField();
  if (!transcriptId || !CLAUDE_TRANSCRIPT_ID_PATTERN.test(transcriptId)) return null;

  const files: EditSources['files'] = [];
  const metas: Record<string, string> = {};
  while (pos < stdout.length) {
    const relPath = readField();
    const size = readNumber();
    const startOffset = readNumber();
    const len = readNumber();
    if (relPath === null || size === null || startOffset === null || len === null) return null;
    if (startOffset + len > size || pos + len > stdout.length) return null;
    const chunk = stdout.subarray(pos, pos + len);
    pos += len;

    const meta = EDIT_SOURCE_META_REL_PATH_PATTERN.exec(relPath);
    if (meta) {
      metas[meta[1]] = chunk.toString('utf8');
    } else if (EDIT_SOURCE_REL_PATH_PATTERN.test(relPath)) {
      files.push({ relPath, size, startOffset, chunk });
    } else {
      return null;
    }
  }
  return { transcriptId, files, metas };
}

/**
 * Read a remote claude session's transcripts (see {@link buildRemoteClaudeEditSourcesCommand}),
 * the remote twin of `readClaudeEditSources`. `null` when `mainPath` does not exist; an
 * unreachable host, an ssh failure or broken output is a `RemoteFileAccessError`. Never wakes.
 */
export async function remoteReadClaudeEditSources(
  remote: SessionRemote,
  mainPath: string,
  requests: readonly EditSourceRequest[],
  budgetBytes: number,
  opts: EditSourceReadOptions = {}
): Promise<EditSources | null> {
  assertNotUnderTest();
  const budget = Number.isFinite(budgetBytes) ? Math.max(0, Math.floor(budgetBytes)) : 0;
  const command = buildRemoteFileCommand(remote, buildRemoteClaudeEditSourcesCommand(mainPath, requests, budget, opts));
  const maxBytes = budget + EDIT_SOURCE_META_BUDGET_BYTES + EDIT_SOURCE_HEADER_SLACK_BYTES;
  let stdout: Buffer;
  try {
    const result = await runWithRemoteSshLimit(() =>
      execAsync(command, {
        timeout: remoteEditSourcesTimeoutMs(maxBytes),
        maxBuffer: maxBytes,
        encoding: 'buffer',
      })
    );
    stdout = Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout);
  } catch (err) {
    if ((err as { code?: unknown }).code === TRANSCRIPT_NOT_FOUND_EXIT) return null;
    throw new RemoteFileAccessError(
      `remote host ${remote.label || remote.host} unreachable: ${describeExecError(err)}`
    );
  }
  const parsed = parseRemoteClaudeEditSources(stdout);
  if (!parsed || !mainPath.endsWith(`/${parsed.transcriptId}.jsonl`)) {
    throw new RemoteFileAccessError('unexpected output from the remote edit-history read');
  }
  return parsed;
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
