import { existsSync, mkdirSync } from 'node:fs';
import fs from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import type {
  RemoteCase,
  RemoteCommandMode,
  RemoteHost,
  RemoteSessionInfo,
  RemoteSshOptions,
  SessionMode,
  SessionRemote,
} from './types.js';

const execAsync = promisify(exec);

const REMOTE_HOSTS_FILE = 'remote-hosts.json';
const REMOTE_CASES_FILE = 'remote-cases.json';

export function remoteHostsPath(configDir: string): string {
  return join(configDir, REMOTE_HOSTS_FILE);
}

export function remoteCasesPath(configDir: string): string {
  return join(configDir, REMOTE_CASES_FILE);
}

async function readJsonArray<T>(path: string): Promise<T[]> {
  try {
    const raw = await fs.readFile(path, 'utf-8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

async function writeJsonArray<T>(configDir: string, path: string, value: T[]): Promise<void> {
  if (!existsSync(configDir)) mkdirSync(configDir, { recursive: true });
  await fs.writeFile(path, JSON.stringify(value, null, 2));
}

export async function readRemoteHosts(configDir: string): Promise<RemoteHost[]> {
  return readJsonArray<RemoteHost>(remoteHostsPath(configDir));
}

export async function writeRemoteHosts(configDir: string, hosts: RemoteHost[]): Promise<void> {
  await writeJsonArray(configDir, remoteHostsPath(configDir), hosts);
}

export async function readRemoteCases(configDir: string): Promise<RemoteCase[]> {
  return readJsonArray<RemoteCase>(remoteCasesPath(configDir));
}

export async function writeRemoteCases(configDir: string, cases: RemoteCase[]): Promise<void> {
  await writeJsonArray(configDir, remoteCasesPath(configDir), cases);
}

/**
 * The remote user's login shell, defaulted and quoted.
 *
 * The default is belt-and-braces, not a live bug: an empty `$SHELL` would expand
 * to `exec  -i -l`, which the shell reads as `exec -i` — "not found", pane dead on
 * arrival, the #208 failure all over again (verified: `sh -c 'exec $SHELL -i -l'`
 * with SHELL unset prints `exec: -i: not found`). In practice tmux always exports
 * SHELL into a pane from its own `default-shell` option, so the command as USED
 * here is safe either way (also verified). The default matters because these
 * strings are the seed values a per-host `commands.*` override is edited from, and
 * nothing constrains where an edited one ends up running. Quoted for a shell path
 * containing spaces. `/bin/sh` exists on every POSIX host.
 */
const REMOTE_LOGIN_SHELL = '"${SHELL:-/bin/sh}"';

/**
 * Run `command` through the remote user's interactive login shell, so per-user
 * PATH entries (~/.local/bin, ~/.opencode/bin, …) are resolved before the CLI name
 * is looked up. ssh's remote-command execution is neither interactive nor login,
 * so a bare `exec claude` sees only sshd's minimal default PATH and dies with
 * "command not found" (exit 127).
 *
 * Shells that take neither flag (nushell, elvish, …) cannot be detected from here
 * the way `loginShellArgs()` detects them locally, since the shell is whatever the
 * REMOTE passwd says. A host like that is what the per-host `commands.*` override
 * is for.
 */
export function remoteLoginShellCommand(command: string): string {
  return `exec ${REMOTE_LOGIN_SHELL} -i -l -c ${shellescape(command)}`;
}

export function defaultRemoteCommandForMode(mode: SessionMode): string {
  // Agent CLIs (claude/opencode/codex/gemini/antigravity) are typically installed
  // under per-user paths like ~/.local/bin or ~/.opencode/bin, added to PATH only by
  // the remote user's interactive-login shell startup files (~/.zshrc etc.). ssh's
  // remote-command execution is neither interactive nor login, so a bare `exec
  // claude` sees only sshd's minimal default PATH and fails with "command not
  // found" (exit 127) — confirmed via `tmux capture-pane` on the
  // remain-on-exit-preserved dead pane. Route through `$SHELL -i -l -c`, the same
  // fix already used for shell mode below, so PATH is fully resolved before the
  // CLI name is looked up.
  const commands: Record<RemoteCommandMode, string> = {
    // $SHELL, not a hardcoded bash: sshd sets it from the remote user's
    // /etc/passwd entry, so this launches their actual login shell (zsh,
    // fish, etc.). -i -l so it sources rc files (~/.zshrc etc.), matching
    // the local shell-mode launch.
    shell: `exec ${REMOTE_LOGIN_SHELL} -i -l`,
    // Mirror the LOCAL claude default so the remote agent runs non-interactively
    // (no trust-folder/permission prompt that nothing on the remote answers). The
    // per-host `commands.claude` override stays the escape hatch.
    claude: remoteLoginShellCommand('claude --dangerously-skip-permissions'),
    opencode: remoteLoginShellCommand('opencode'),
    codex: remoteLoginShellCommand('codex'),
    gemini: remoteLoginShellCommand('gemini'),
    antigravity: remoteLoginShellCommand('agy'),
    pi: remoteLoginShellCommand('pi'),
    grok: remoteLoginShellCommand('grok'),
    // `dsh` alone boots nothing: the launcher needs a profile, and the remote box's
    // profile inventory is unknown here. The per-host `commands.deepseek` override
    // is the escape hatch for naming one.
    deepseek: remoteLoginShellCommand('dsh'),
    omp: remoteLoginShellCommand('omp'),
  };
  return commands[mode as RemoteCommandMode] || commands.shell;
}

export function remoteSshTarget(host: Pick<RemoteHost, 'username' | 'host'>): string {
  return `${host.username}@${host.host}`;
}

/**
 * POSIX single-quote shell-escaping (end-quote, escaped-quote, restart-quote).
 * Mirrors the helper in tmux-manager.ts so a value with spaces/metachars stays a
 * single shell token. Used here for identity paths and `-o KEY=VALUE` options.
 */
function shellescape(str: string): string {
  return "'" + str.replace(/'/g, "'\\''") + "'";
}

/**
 * Expand a leading `~` or `$HOME` in an identity path to an absolute path.
 *
 * ssh does NOT expand `~` inside `-i` (the shell would, but we shellescape the
 * value into a single quoted token so the shell never sees it). So we expand at
 * build time, before escaping. Non-`~`/`$HOME` paths are returned unchanged.
 */
function expandIdentityPath(identityFile: string): string {
  if (identityFile === '~') return homedir();
  if (identityFile.startsWith('~/')) return join(homedir(), identityFile.slice(2));
  if (identityFile === '$HOME') return homedir();
  if (identityFile.startsWith('$HOME/')) return join(homedir(), identityFile.slice('$HOME/'.length));
  return identityFile;
}

/**
 * COD-107 — build the ordered, shell-safe ssh CONNECTION tokens shared by both
 * the durable-launch command (`buildRemoteLaunchCommand`) and the tmux
 * prerequisite probe (`buildRemoteTmuxCheckCommand`), so the prereq check and
 * the real launch connect with IDENTICAL options (they can't drift).
 *
 * Returns the leading tokens of an ssh command line (NOT including `-t`, the
 * target, or any remote command). Order:
 *   ssh -o BatchMode=yes
 *       [-o ConnectTimeout=10]           (default; suppressed if extraSshOptions sets it)
 *       [-p <port>]
 *       [-i <abs-identity>]              (~/$HOME expanded, then shellescaped)
 *       [-J <jumpHost>]                  (shellescaped, single token)
 *       [-o ProxyCommand=nc -X 5 -x <socks> %h %p]   (ONE shellescaped -o token)
 *       [-o <KEY=VALUE>] …               (each extra option, shellescaped)
 *
 * Escaping notes (the risky part):
 *  - The ProxyCommand is emitted as a single shellescaped `-o KEY=VALUE`, so the
 *    whole value (spaces + `%h`/`%p`) reaches ssh as one argument and `%h %p`
 *    survive verbatim — ssh expands them to the real host/port, not the shell.
 *  - A default `-o ConnectTimeout=10` bounds the wait on an unreachable/blackholed
 *    host (else the pane hangs on the OS TCP timeout). It is omitted when the
 *    operator already set ConnectTimeout via extraSshOptions, so their value wins.
 */
export function buildSshConnectionArgs(remote: RemoteSshOptions & Pick<RemoteHost, 'port'>): string[] {
  const parts: string[] = ['ssh', '-o BatchMode=yes'];
  const hasConnectTimeout = (remote.extraSshOptions ?? []).some((opt) => /^ConnectTimeout=/i.test(opt));
  if (!hasConnectTimeout) parts.push('-o ConnectTimeout=10');
  if (remote.port) parts.push(`-p ${remote.port}`);
  if (remote.identityFile) parts.push(`-i ${shellescape(expandIdentityPath(remote.identityFile))}`);
  if (remote.jumpHost) parts.push(`-J ${shellescape(remote.jumpHost)}`);
  if (remote.socksProxy) {
    parts.push(`-o ${shellescape(`ProxyCommand=nc -X 5 -x ${remote.socksProxy} %h %p`)}`);
  }
  for (const opt of remote.extraSshOptions ?? []) {
    parts.push(`-o ${shellescape(opt)}`);
  }
  return parts;
}

/**
 * COD-104 — build the SSH command that checks the remote host has tmux.
 *
 * Durable remote sessions run the agent inside a tmux server ON the remote host
 * (`tmux -L codeman new-session -A …`), so tmux is now a hard prerequisite there.
 * `command -v tmux` exits 0 (and prints the path) when tmux is installed.
 *
 * COD-107 — connects with the SAME options as the real launch
 * (`buildSshConnectionArgs`) so a proxied/custom-port/identity host that the
 * launch can reach also passes the prereq probe (and vice-versa).
 */
export function buildRemoteTmuxCheckCommand(
  host: Pick<RemoteHost, 'username' | 'host' | 'port'> & RemoteSshOptions
): string {
  // ConnectTimeout is now a default of buildSshConnectionArgs (shared with the launch).
  return [...buildSshConnectionArgs(host), remoteSshTarget(host), "'command -v tmux'"].join(' ');
}

export interface RemoteTmuxCheckResult {
  ok: boolean;
  /** Resolved tmux path on the remote (when ok). */
  tmuxPath?: string;
  /** Human-readable failure reason (when !ok). */
  error?: string;
}

/**
 * COD-104 — verify the remote host has tmux installed (required for durable
 * remote sessions). Returns a structured result with a clear, user-facing error
 * when tmux is missing or the host is unreachable. Never throws.
 */
export async function checkRemoteTmuxAvailable(
  host: Pick<RemoteHost, 'username' | 'host' | 'port'> & RemoteSshOptions
): Promise<RemoteTmuxCheckResult> {
  // Under vitest, never open a real ssh connection — mirrors TmuxManager's
  // no-op-shell-under-VITEST (IS_TEST_MODE). Without this, remote-case
  // create-path tests hit a real ~10s ssh timeout. The command construction is
  // covered by buildRemoteTmuxCheckCommand unit tests; only the live probe is
  // short-circuited here.
  if (process.env.VITEST) {
    return { ok: true, tmuxPath: '(test-mode)' };
  }
  const command = buildRemoteTmuxCheckCommand(host);
  try {
    const { stdout } = await execAsync(command, { timeout: 15_000 });
    const tmuxPath = stdout.trim();
    if (!tmuxPath) {
      return {
        ok: false,
        error: `remote host ${host.host} needs tmux installed for durable remote sessions`,
      };
    }
    return { ok: true, tmuxPath };
  } catch (err) {
    const stderr =
      err && typeof err === 'object' && 'stderr' in err ? String((err as { stderr?: unknown }).stderr ?? '') : '';
    // `command -v tmux` exits non-zero when tmux is absent (no stderr); a real
    // connection failure surfaces ssh diagnostics on stderr.
    if (stderr.trim()) {
      return {
        ok: false,
        error: `could not verify tmux on remote host ${host.host}: ${stderr.trim()}`,
      };
    }
    return {
      ok: false,
      error: `remote host ${host.host} needs tmux installed for durable remote sessions`,
    };
  }
}

/**
 * The CLI binary each session mode runs on the remote host. Antigravity's
 * binary is `agy` (the mode name is not the command); shell has no CLI to
 * probe, so it is absent.
 */
const REMOTE_CLI_BIN: Partial<Record<SessionMode, string>> = {
  claude: 'claude',
  opencode: 'opencode',
  codex: 'codex',
  gemini: 'gemini',
  antigravity: 'agy',
  pi: 'pi',
  omp: 'omp',
};

/**
 * Build the SSH command that reads the remote CLI's version (`claude --version`
 * on the remote host). The version query is routed through
 * `remoteLoginShellCommand` (the SAME `$SHELL -i -l -c` wrapper the real
 * launch uses), because agent CLIs live on PATH only after the remote user's
 * interactive-login startup files run (see defaultRemoteCommandForMode); a bare
 * `claude --version` over ssh exits 127. Connection options come from the
 * shared `buildSshConnectionArgs`, so the probe reaches exactly the hosts the
 * launch can reach. Returns null for modes with no CLI (shell).
 */
export function buildRemoteCliVersionProbeCommand(
  host: Pick<RemoteHost, 'username' | 'host' | 'port'> & RemoteSshOptions,
  mode: SessionMode
): string | null {
  const bin = REMOTE_CLI_BIN[mode];
  if (!bin) return null;
  return [
    ...buildSshConnectionArgs(host),
    remoteSshTarget(host),
    shellescape(remoteLoginShellCommand(`${bin} --version`)),
  ].join(' ');
}

/**
 * Read the CLI version installed ON THE REMOTE HOST. Feeds Session.cliVersion
 * for remote sessions: the deterministic local probe deliberately skips them
 * (it would report the LOCAL host's claude), and the startup-banner scrape is
 * unreliable (newer Claude Code builds print no banner; resumed sessions never
 * do), which left cliVersion undefined and silently disabled wheel-forwarding
 * to the CLI transcript (residual #154, noted in the #205 analysis). The
 * version is parsed as the first semver in stdout, never raw output: an
 * interactive-login shell may echo rc-file noise around it. Returns undefined
 * on any failure. No-op under VITEST (mirrors checkRemoteTmuxAvailable).
 */
export async function probeRemoteCliVersion(
  host: Pick<RemoteHost, 'username' | 'host' | 'port'> & RemoteSshOptions,
  mode: SessionMode
): Promise<string | undefined> {
  if (process.env.VITEST) return undefined;
  const command = buildRemoteCliVersionProbeCommand(host, mode);
  if (!command) return undefined;
  try {
    const { stdout } = await execAsync(command, { timeout: 15_000 });
    const match = stdout.match(/\d+\.\d+\.\d+/);
    return match ? match[0] : undefined;
  } catch {
    return undefined;
  }
}

/**
 * COD-108 — build the SSH command that asks whether THIS Codeman's durable
 * remote tmux session (`-L codeman-remote -s codeman-ssh-<id>`) is still alive
 * on the remote host.
 *
 * `has-session` exits 0 when the session exists, non-zero otherwise (and
 * stderr is swallowed). Connection options come from the shared
 * `buildSshConnectionArgs` so this probe reaches exactly the hosts the launch
 * can reach — same port/identity/proxy/jump-host as `buildRemoteLaunchCommand`.
 */
export function buildRemoteSessionAliveCommand(
  host: Pick<RemoteHost, 'username' | 'host' | 'port'> & RemoteSshOptions,
  remoteSessionName: string
): string {
  const [ssh, ...connectionArgs] = buildSshConnectionArgs(host);
  const remoteCmd = `tmux -L codeman-remote has-session -t ${shellescape(remoteSessionName)} 2>/dev/null`;
  return [ssh, ...connectionArgs, remoteSshTarget(host), shellescape(remoteCmd)].join(' ');
}

/**
 * COD-108 — resolve whether THIS Codeman's durable remote tmux session is still
 * alive on the remote host, for the auto-reconnect watcher.
 *
 * Returns:
 *   - `true`      → the remote tmux session exists (the agent is still running
 *                   on the remote; the LOCAL pane died from a transport drop →
 *                   safe to auto-reconnect).
 *   - `false`     → the remote session is gone (the agent exited cleanly and
 *                   the remote tmux tore down; reviving would relaunch a fresh
 *                   agent — must NOT auto-reconnect).
 *   - `undefined` → probe failed (host unreachable, ssh error, tmux missing).
 *                   Callers MUST treat this as "do not reconnect": an
 *                   unreachable host is not a reason to relaunch the agent.
 *
 * VITEST guard — returns `true` under test so a real ssh never runs; the
 * command construction is covered by `buildRemoteSessionAliveCommand`.
 */
export async function remoteTmuxSessionAlive(
  remote: Pick<RemoteHost, 'username' | 'host' | 'port'> & RemoteSshOptions,
  remoteSessionName: string
): Promise<boolean | undefined> {
  if (process.env.VITEST) return true;
  const command = buildRemoteSessionAliveCommand(remote, remoteSessionName);
  try {
    const { stdout } = await execAsync(command, { timeout: 15_000 });
    // has-session prints the session name on success (exit 0). Anything else is
    // a non-zero exit → the session is gone.
    return stdout.trim().length > 0;
  } catch {
    return undefined;
  }
}

/**
 * COD-105 — build the SSH command that lists `codeman-*` tmux sessions on a
 * remote host's canonical `-L codeman` socket.
 *
 * `list-sessions` exits NON-ZERO with empty output when no sessions exist (and
 * the server isn't running), so `2>/dev/null` swallows tmux's "no server
 * running" stderr; the caller treats a non-zero exit / empty output as "no
 * sessions" rather than an error.
 *
 * COD-107 — connection options come from the shared `buildSshConnectionArgs`, so
 * discovery connects with the SAME port/identity/proxy/jump-host as the launch
 * and the tmux prereq probe.
 */
export function buildRemoteListSessionsCommand(
  host: Pick<RemoteHost, 'username' | 'host' | 'port'> & RemoteSshOptions
): string {
  const [ssh, ...connectionArgs] = buildSshConnectionArgs(host);
  const parts = [ssh, connectionArgs[0], '-o ConnectTimeout=10', ...connectionArgs.slice(1)];
  // The tmux list-sessions invocation is passed as ONE shell-quoted argument so
  // the remote login shell runs it verbatim. The `-F` format uses literal `\t`
  // separators (tmux expands them); `2>/dev/null` is inside the quoted command.
  const remoteCmd =
    'tmux -L codeman list-sessions -F "#{session_name}\\t#{session_attached}\\t#{session_created}\\t#{session_windows}" 2>/dev/null';
  parts.push(remoteSshTarget(host), shellescape(remoteCmd));
  return parts.join(' ');
}

/**
 * COD-105 — pure parser for the `tmux list-sessions -F` output emitted by
 * `buildRemoteListSessionsCommand`. Factored out so the parse is unit-testable
 * without opening a real ssh connection.
 *
 * - Splits each non-empty line into [name, attached, created, windows] on the
 *   field separator. IMPORTANT: the remote tmux's `-F "…\t…"` format does NOT
 *   expand `\t` to a real tab — it emits the LITERAL two-character sequence
 *   `\t` (verified on aa-desktop / tmux next-3.7). So we split on the literal
 *   backslash-t sequence; we also tolerate a real tab in case a tmux build
 *   does expand it. (A real TAB is the regex `\t`; a literal backslash-t is the
 *   regex `\\t`.)
 * - Keeps ONLY sessions whose name starts with `codeman-` (ignores foreign tmux
 *   sessions that happen to share the socket).
 * - Coerces: `attached` → boolean (`'1'`), `created`/`windows` → finite ints.
 * - Skips malformed lines (wrong column count or non-numeric created/windows)
 *   rather than emitting garbage.
 */
export function parseRemoteSessionList(stdout: string): RemoteSessionInfo[] {
  const out: RemoteSessionInfo[] = [];
  for (const rawLine of stdout.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    // Split on a literal `\t` (backslash + t, what the remote tmux emits) OR a
    // real tab character. `/\\t|\t/` = the two-char sequence, or a TAB.
    const cols = line.split(/\\t|\t/);
    if (cols.length !== 4) continue;
    const [name, attachedStr, createdStr, windowsStr] = cols;
    if (!name.startsWith('codeman-')) continue;
    const created = Number(createdStr);
    const windows = Number(windowsStr);
    if (!Number.isFinite(created) || !Number.isFinite(windows)) continue;
    // COD-106 — `session_attached` is the CLIENT COUNT (not a 0/1 flag); >1 = shared.
    const attachedNum = Number(attachedStr.trim());
    const attachedClients = Number.isFinite(attachedNum) ? Math.max(0, Math.trunc(attachedNum)) : 0;
    out.push({
      name,
      attached: attachedClients > 0,
      attachedClients,
      created: Math.trunc(created),
      windows: Math.trunc(windows),
    });
  }
  return out;
}

/**
 * COD-105 — discover `codeman-*` tmux sessions already running on a remote host
 * (created by the remote's own Codeman, another instance, or this one), so the
 * operator can attach to one this Codeman didn't launch.
 *
 * NEVER throws: returns `[]` on unreachable host / no tmux / no sessions
 * (`list-sessions` exits non-zero with empty output when there are none).
 *
 * VITEST guard — like `checkRemoteTmuxAvailable`, returns `[]` under test so a
 * real ssh never runs in a request path (which would make route tests hit a
 * ~10s timeout). The command construction is covered by
 * `buildRemoteListSessionsCommand` and the parse by `parseRemoteSessionList`.
 */
export async function listRemoteCodemanSessions(
  remote: Pick<RemoteHost, 'username' | 'host' | 'port'> & RemoteSshOptions
): Promise<RemoteSessionInfo[]> {
  if (process.env.VITEST) {
    return [];
  }
  const command = buildRemoteListSessionsCommand(remote);
  try {
    const { stdout } = await execAsync(command, { timeout: 15_000 });
    return parseRemoteSessionList(stdout);
  } catch {
    // Unreachable host, no tmux server, or no sessions (non-zero exit). All map
    // to "nothing to attach to" — never surface as an error to the caller.
    return [];
  }
}

export function remoteDisplayPath(
  remote: Pick<SessionRemote, 'username' | 'host' | 'remotePath'> | { username: string; host: string; path: string }
): string {
  const path = 'remotePath' in remote ? remote.remotePath : remote.path;
  return `${remote.username}@${remote.host}:${path}`;
}

export function toSessionRemote(host: RemoteHost, remoteCase: RemoteCase): SessionRemote {
  return {
    hostId: host.id,
    label: host.label,
    host: host.host,
    username: host.username,
    port: host.port,
    remotePath: remoteCase.remotePath,
    commands: host.commands,
    // COD-105 — the COD-104 launch path creates the remote session, so we own it
    // (an explicit kill may propagate a remote kill-session). Discovered+attached
    // sessions go through `toAttachedSessionRemote` with `owned: false`.
    owned: true,
    // COD-107 — carry the advanced SSH options from host config into the session
    // so the launch/prereq commands connect the same way the operator configured.
    identityFile: host.identityFile,
    socksProxy: host.socksProxy,
    jumpHost: host.jumpHost,
    extraSshOptions: host.extraSshOptions,
  };
}

/**
 * COD-105 — build a NON-owned `SessionRemote` for ATTACHING to a `codeman-*`
 * session already running on a remote host (discovered via
 * `listRemoteCodemanSessions`). The resulting session's pane runs
 * `tmux -L codeman attach -t <remoteSessionName>` (see
 * `buildRemoteAttachCommand`), and because we did NOT create the remote session,
 * `owned: false` means closing the tab DETACHES rather than killing it.
 *
 * `remotePath` is informational here (the attached remote session keeps its own
 * cwd); we record the host's nominal path so display helpers still show
 * `user@host:path`.
 */
export function toAttachedSessionRemote(
  host: RemoteHost,
  remoteSessionName: string,
  remotePath: string
): SessionRemote {
  return {
    hostId: host.id,
    label: host.label,
    host: host.host,
    username: host.username,
    port: host.port,
    remotePath,
    commands: host.commands,
    // Discovered + attached — another Codeman created it. Detach-not-kill.
    owned: false,
    remoteSessionName,
    identityFile: host.identityFile,
    socksProxy: host.socksProxy,
    jumpHost: host.jumpHost,
    extraSshOptions: host.extraSshOptions,
  };
}
