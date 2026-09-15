# Remote Sessions (SSH)

Codeman can run a session's agent on a **remote host over SSH** instead of the
local machine. The agent (Claude, OpenCode, Codex, Antigravity, Gemini, Pi, Grok, or a plain shell)
runs inside a `tmux` server **on the remote host**, so it survives the SSH
connection dropping; Codeman attaches to it the same way it attaches to a local
managed session.

This document covers the data model, the shell-safe SSH command construction
(COD-107), the durable-launch design (COD-104), and the operational caveats.
For the local session/mux machinery this builds on, see the **Mux** and
**Session** entries in `CLAUDE.md` → Architecture.

## Why it exists

A developer box (`AA-DESKTOP`) often needs to drive an agent on another machine —
a NAS, a build server, a host reachable only through a jump box or a
cloudflared SOCKS5 proxy. Rather than wrap `ssh` by hand per host, Codeman
stores reusable **remote hosts** + **remote cases** and reproduces the exact
connection the operator already uses (`ssh-aa-desktop`-style configs:
custom port, identity file, `-J` jump host, `-o ProxyCommand`).

## Data model

Types live in `src/types/session.ts`; persistence in `src/remote-hosts.ts`.

| Type                                         | Role                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `RemoteSshOptions`                           | The **HOW-to-reach** fields, shared by host + session: `identityFile`, `socksProxy` (`host:port`), `jumpHost` (`[user@]host[:port]`), `extraSshOptions` (`KEY=VALUE[]`). Every field optional — all-absent reproduces port-22, default-identity, directly-SSH-able behavior.                                                                                                                                                                                                               |
| `RemoteHost` (extends `RemoteSshOptions`)    | A saved host: `id`, `label`, `host`, `username`, `port?`, `commands?` (per-mode launch command override).                                                                                                                                                                                                                                                                                                                                                                                  |
| `RemoteCase`                                 | A working directory on a host: `name`, `type: 'remote'`, `hostId`, `remotePath`.                                                                                                                                                                                                                                                                                                                                                                                                           |
| `SessionRemote` (extends `RemoteSshOptions`) | The resolved bundle stamped onto a live session: host coordinates + `remotePath` + `commands`, plus **`owned?`** and **`remoteSessionName?`** (COD-105 — see [Ownership](#ownership-launched-vs-discovered-and-attached-cod-105)). Built by `toSessionRemote(host, case)` (sets `owned: true`) for the launch path, or `toAttachedSessionRemote(host, name, path)` (sets `owned: false`) for the attach path. Both copy the advanced SSH options through so every connection is identical. |
| `RemoteCommandMode`                          | `Extract<SessionMode, 'shell' \| 'claude' \| 'opencode' \| 'codex' \| 'gemini' \| 'antigravity' \| 'pi' \| 'grok' \| 'deepseek' \| 'omp'>` — the modes that can run remotely.                                                                                                                                                                                                                                                                                                              |
| `RemoteSessionInfo` (COD-105)                | One discovered remote tmux session: `name` (always `codeman-*`), `attached` (a client is connected), `created` (epoch s), `windows`. Returned by `listRemoteCodemanSessions()`.                                                                                                                                                                                                                                                                                                            |

Persistence is two flat JSON arrays in the instance data dir:

- `~/.codeman/remote-hosts.json` — `readRemoteHosts()` / `writeRemoteHosts()`
- `~/.codeman/remote-cases.json` — `readRemoteCases()` / `writeRemoteCases()`

(Paths via `remoteHostsPath()` / `remoteCasesPath()`; both honor `CODEMAN_INSTANCE`
because the config dir is the instance data dir.)

On the live `Session`, the remote rides as `_remote?: SessionRemote`. When
attaching, `resolveMuxAttachCwd()` forces the cwd to `/tmp` for remote sessions —
the local working directory is meaningless on the remote box.

## SSH command construction (COD-107 — the injection surface)

**All** SSH command lines flow through one function so user-controlled fields are
escaped once and the launch + prereq probe can never drift apart:

```ts
// src/remote-hosts.ts
buildSshConnectionArgs(remote: RemoteSshOptions & Pick<RemoteHost, 'port'>): string[]
```

It returns the **ordered leading tokens** of an ssh command line (no `-t`, no
target, no remote command):

```
ssh -o BatchMode=yes
    [-p <port>]
    [-i <abs-identity>]            # ~ / $HOME expanded, then shellescaped
    [-J <jumpHost>]                # shellescaped, single token
    [-o ProxyCommand=nc -X 5 -x <socks> %h %p]   # ONE shellescaped -o token
    [-o <KEY=VALUE>] …             # each extra option, shellescaped
```

Rules that keep this safe — **do not bypass them by hand-building an ssh line elsewhere:**

- **Every** user-controlled value (`-i`, `-J`, `-o`, ProxyCommand) is POSIX
  single-quote `shellescape`d (`'…'` with embedded `'\''`). The helper mirrors
  the one in `tmux-manager.ts`.
- **`~`/`$HOME` in `identityFile` is expanded at build time** (`expandIdentityPath`),
  _before_ escaping — ssh does not expand `~` inside `-i`, and the escaped value
  never reaches a shell that would.
- **The ProxyCommand is one shellescaped `-o KEY=VALUE` token**, so its spaces and
  the `%h`/`%p` placeholders reach ssh as a single argument. `%h %p` survive
  verbatim — **ssh** expands them to the real host/port, not the shell.
- **Empty options ⇒ `['ssh', '-o BatchMode=yes']`** (+ `-p` only when set) —
  byte-identical to the historical behavior.

Token construction is unit-tested independently of any live connection (see
`test/` for `buildSshConnectionArgs` / `buildRemoteTmuxCheckCommand` cases).

## Durable launch (COD-104)

`buildRemoteLaunchCommand({ mode, remote, sessionId })` in `tmux-manager.ts`
builds the command that launches (or **reattaches** to) the remote session:

```
ssh -o BatchMode=yes -t <connection-args> user@host \
  'tmux -L codeman-remote new-session -A -s codeman-ssh-<id8> -c <remotePath> "cd <remotePath> && exec <cli>" \; \
     set -t codeman-ssh-<id8> status off \; set -t codeman-ssh-<id8> mouse off \; \
     set -t codeman-ssh-<id8> prefix C-q \; set -s escape-time 0 \; \
     set -t codeman-ssh-<id8> window-size latest'
```

Key points:

- **`new-session -A -s codeman-ssh-<id8>`** = attach-if-exists-else-create, so a
  reconnect (same deterministic `remoteTmuxSessionName(sessionId)` — `codeman-ssh-` +
  the first 8 chars of the session id) lands back in
  the **same** remote session rather than spawning a duplicate. This is what makes
  the remote agent survive an SSH drop. The name deliberately fails
  `SAFE_MUX_NAME_PATTERN` so a Codeman running ON the remote host never adopts it.
- **`-L codeman-remote`** = a DEDICATED socket for sessions launched by remote
  Codemans, NOT the canonical `-L codeman` socket the remote host's own Codeman
  uses. Options are set per-session (`set -t`), never `-g`, so a shared remote
  tmux server's other sessions are untouched (#145 hardening). Note the
  asymmetry: **discovery/attach (COD-105) target the canonical `-L codeman`
  socket** — they join sessions the remote's own Codeman manages, while owned
  durable launches live on `-L codeman-remote`.
- **`exec <cli>`** replaces the pane shell with the agent, so the pane PID _is_
  the agent. The per-mode command comes from `remote.commands?.[mode]` or
  `defaultRemoteCommandForMode(mode)` (`exec claude` / `exec opencode` /
  `exec codex` / `exec gemini` / `exec agy` / `exec bash -l`).
  ⚠️ **claude and omp no longer take that path**: both have their own arm in
  `buildRemoteLaunchCommand` so a respawn can continue the same conversation
  (see [Respawn / reattach continuation](#respawn--reattach-continuation)), and
  because the claude arm is an `a || b` pair under `-c`, its pane PID is the
  **login shell**, not the agent.
- The **whole tmux invocation is a single shell-quoted ssh argument**, and the
  pane command is independently quoted, so a `remotePath` with spaces is safe.
- Connection options come from the **same `buildSshConnectionArgs(remote)`** as
  the prereq probe; `-t` is inserted right after `ssh -o BatchMode=yes`,
  preserving historical token order.

### tmux prerequisite probe

Because durable remote sessions require tmux on the remote host,
`checkRemoteTmuxAvailable(host)` runs `command -v tmux` over SSH **before**
creating a remote case/session and returns a structured, never-throwing result:

- empty stdout / non-zero exit → _"remote host `<host>` needs tmux installed for
  durable remote sessions"_
- stderr present → _"could not verify tmux on remote host `<host>`: `<stderr>`"_
  (a real connection failure, surfaced to the operator)
- success → `{ ok: true, tmuxPath }`

It connects with the **identical** options as the launch
(`buildRemoteTmuxCheckCommand` reuses `buildSshConnectionArgs` and inserts
`-o ConnectTimeout=10`), so a proxied/custom-port/identity host that the launch
can reach also passes the probe (and vice-versa).

**Test-mode short-circuit:** under `VITEST` the probe returns
`{ ok: true, tmuxPath: '(test-mode)' }` without opening a socket — mirroring
`TmuxManager`'s no-op-shell-under-VITEST (`IS_TEST_MODE`). Without it, remote-case
create-path tests would hit a real ~10s ssh timeout. Only the live probe is
skipped; command construction is still asserted by unit tests.

## Ownership: launched vs. discovered-and-attached (COD-105)

COD-104 (above) was Phase 1 — Codeman _launches_ a remote session and owns it.
COD-105 is Phase 2 — Codeman can also **discover** `codeman-*` tmux sessions
already running on a remote host (created by the remote's own Codeman or another
instance) and **attach** to one it didn't launch. Ownership decides what happens
when the tab closes.

`SessionRemote.owned` carries this:

- **`owned: true`** (or absent — legacy/COD-104 sessions persisted before this
  field) — we launched it via `buildRemoteLaunchCommand` and may explicitly kill it.
- **`owned: false`** — discovered + attached; another Codeman owns the remote
  session. `remoteSessionName` holds its existing tmux name. Closing the tab
  **detaches**, never kills.

### Discovery

`listRemoteCodemanSessions(host)` lists the remote's `codeman-*` sessions:

- `buildRemoteListSessionsCommand()` runs `tmux -L codeman list-sessions -F "…"`
  over SSH (connection args from the shared `buildSshConnectionArgs`, so discovery
  connects identically to launch/probe). `2>/dev/null` swallows tmux's "no server
  running" stderr.
- `parseRemoteSessionList()` is a **pure, unit-tested** parser. ⚠️ Quirk: the
  remote tmux's `-F "…\t…"` format emits the **literal two-character `\t`**, not a
  real tab (verified on tmux next-3.7), so the parser splits on `/\\t|\t/` (literal
  backslash-t **or** a real tab, for builds that do expand it). It keeps only
  `codeman-*` names, coerces types, and skips malformed lines.
- `listRemoteCodemanSessions()` **never throws** — unreachable host / no tmux / no
  sessions all map to `[]`. Like the prereq probe, it **no-ops to `[]` under
  `VITEST`** so a request path never opens a real ssh connection.

Discovery is **explicit** — the UI has a "Discover existing sessions" button per
host; Codeman never auto-discovers on host select.

### Attach vs. launch selection

`buildRemoteSessionCommand(mode, remote, sessionId)` in `tmux-manager.ts` picks the
remote command line by ownership:

- **`owned === false`** → `buildRemoteAttachCommand(remote, name)` — emits
  `ssh … -t … 'tmux -L codeman attach -t <remoteSessionName>'`. It uses **`attach`,
  NOT `new-session -A`**, so it only _joins_ an existing session and never creates
  one.
- **owned (default)** → `buildRemoteLaunchCommand` (the COD-104 path above).

### Detach-not-kill

`TmuxManager.killSession()` has an **early return for non-owned remote sessions**:
it tears down **only the LOCAL pane** holding the ssh client (`tmux -L codeman
kill-session` on _this_ host's socket). Killing the local ssh sends SIGHUP to the
remote `tmux attach`, which **detaches** — the durable remote session survives.
The early return is a structural guarantee that **no code path can ever issue a
remote `kill-session` for a session we don't own** — the only `kill-session` run is
on the local socket, which never reaches the remote socket.

## Respawn / reattach continuation

A dropped connection or a dead pane must reconnect to the **same conversation**,
not launch a fresh one — the whole point of a durable remote session.

- **Claude**: the launch command is idempotent — `claude --session-id <id> ||
claude --resume <id>` (see `buildRemoteLaunchCommand`'s claude branch). The
  first run creates the conversation under the deterministic session id; every
  later reattach/respawn re-runs the same line, `--session-id` fails
  ("already in use"), and the `||` fallback resumes it.
- **OMP**: `omp` has no equivalent idempotent single-line form, so
  `Session._pinOmpRespawnId()` resolves and pins an explicit `--resume <id>`
  before a respawn (mirroring the local/docker builders, rendered through the
  same `buildSpawnCommandFromRegistry` engine — not a hand-rolled command and
  not `appendResumeFlag()`, which is docker-only and cannot work here: appending
  a flag after the quoted `-c 'omp'` hands the id to the login shell as `$0`
  instead of to `omp`). ⚠️ **The resolver only ever reads THIS host's local
  `~/.omp/agent/sessions/`**, which is meaningless for a remote session — the
  conversation and its session file live on the remote host, under the remote
  user's home. For a remote session, `_pinOmpRespawnId()` therefore skips local
  resolution entirely and falls back to `omp`'s own ambiguous `--continue`
  (`ompConfig.continueSession`), which the remote pane command already renders.
  This is a known, accepted degradation versus the local/docker paths' exact
  `--resume` pin — safe in practice because each remote respawn talks to
  exactly one remote pane's own omp history, so "most recent" is normally
  correct, but it can drift the same way `--continue` always could if two
  remote sessions ever share one remote directory.

## Auto-reconnect vs. a clean agent exit

`remoteAutoReconnect` (default ON) watches for a dropped SSH connection and
reconnects with bounded backoff. It must **never** revive a session whose agent
exited cleanly (Ctrl-C, Ctrl-D, `exit`) — that tears down the durable remote
tmux session itself, and a transport-level `isPaneDead()` cannot tell that apart
from a plain network drop. `remoteTmuxSessionAlive()` (#355) resolves this by
probing the remote host directly: `tmux -L codeman-remote has-session -t
codeman-ssh-<id8>` over the same `buildSshConnectionArgs` as launch, classified
by **exit status alone** (`classifyRemoteAliveExit`: `0` = alive, ssh's `255` or
a timeout = unknown, anything else = gone) — `has-session` prints nothing on
success, so reading stdout would misclassify every live session as gone. An
unreachable host answers "unknown", which also means do not revive. The answer
is cached per session and cleared whenever the pane is next seen alive, so a
stale `true` from one transport drop can never revive the NEXT clean exit.

## File access over SSH

A remote case's `workingDir` is an absolute path on the **remote** host
(`Session.workingDir = RemoteCase.remotePath`), so the file routes cannot use local
`fs`: a local `realpathSync` on a remote-only path fails by construction, which is why
previewing a file used to answer `404 File not found` for a case that was working
perfectly (#415). `src/remote-files.ts` is the one module that reads remote bytes,
and it follows the same rule as the launch path: every ssh command line comes from
`buildSshConnectionArgs()` — **never** a hand-built ssh line.

| Request                                                                          | What happens                                                                                                                                                                                                       |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /api/sessions/:id/file-raw`                                                 | Streamed over `ssh` (`cat`, or `tail -c +N \| head -c L` for a `Range`); the same 200/206/416 contract as a local file, so `<video>`/`<audio>` seeking works                                                       |
| `GET /api/sessions/:id/file-content`                                             | `cat` into memory, capped by the existing text limit; `edit=1` answers `400` (see below) and `editable` is always `false`                                                                                          |
| `PUT /api/sessions/:id/file-content`                                             | `400` before any path is looked at: the guard sits AHEAD of the local path validation, because with a same-named directory on the Codeman host (an `sshfs` mount) the write would otherwise land on the local twin |
| `GET /api/sessions/:id/file-preview`                                             | Non-office files redirect to `file-raw` (which works remotely); docx/pptx answer `400`                                                                                                                             |
| `GET /api/sessions/:id/file-thumbnail`                                           | `400` for remote files                                                                                                                                                                                             |
| `POST /api/sessions/:id/attachments`                                             | Registers an absolute path that lives on the **remote** host (a clicked link pointing outside the case directory) by probing it there                                                                              |
| `GET /api/sessions/:id/attachments/:attachmentId/raw`                            | Streams the registered remote file over ssh, same 200/206/416 contract; `preview` (office) and `thumbnail` answer `400`                                                                                            |
| `GET /api/sessions/:id/attachments/:attachmentId`, `GET …/attachments` (history) | Size/mtime/existence resolved over ssh, so a remote entry is not reported `missing`; the history list resolves EVERY entry in one batched probe, never one connection per entry                                    |

⚠️ The attachment route is the one a clicked path takes when it is **outside** the case
directory (a remote `/tmp` scratchpad capture, a screenshot elsewhere in the home dir):
the frontend's `_isExternalPreviewPath()` sends every absolute path that is not under
`workingDir` there, so fixing only `file-raw` would leave exactly that half broken.

Guard order is deliberately **the same as locally**, and the checks are not weakened
by the transport:

1. Ownership (`findSessionOrFail` / the scope helper) — unchanged.
2. Lexical containment of `workingDir + path` — a `../` escape is refused before any
   connection is opened.
3. ONE ssh round trip that returns `realpath` **and** `stat` for the path **and** the
   workspace root (`remoteProbePaths`). Resolving the root remotely is what keeps the
   boundary honest for a symlinked `remotePath`. The probe uses `readlink -f` when
   available; on a host without it (macOS before 12.3) a POSIX fallback canonicalizes
   the directory chain with `cd -P`/`pwd -P` and then follows the LAST component with
   plain `readlink` for a bounded number of hops. ⚠️ **The fallback fails closed**: a
   path it cannot fully resolve (a loop, a `readlink` failure, the hop cap) is reported
   as unresolvable and answers 404, never as its own unresolved string. An earlier
   version resolved only the directory chain, so `ws/notes.txt -> ~/.ssh/id_rsa` passed
   containment under the link's own path while `cat` followed it to the key.
   Records come back NUL-separated and index-keyed (`<index>|kind|size|mtime|realPath`,
   after a leading NUL that fences off any login banner), so a filename containing a
   newline cannot shift the alignment.
4. Containment of the remote realpath against the remote root. The sensitive-path
   blocklist then applies on whichever routes already apply it locally (`/api/download`,
   attachment registration, edit mode — where resolving symlinks first is what makes it
   meaningful); the remote branch neither drops a guard the local path has nor invents a
   stricter one. One entry of that blocklist is host-bound by construction: the three
   home-anchored members (`~/.claude.json`, `~/.claude/settings.json`,
   `~/.claude/settings.local.json`) are compared against the **Codeman host's** home
   directory, so they do not match a remote home at a different path. Everything else in
   the list is depth-anchored (`/.ssh/`, `/.aws/credentials`, `/.claude/.credentials.json`,
   `/etc/shadow`, ...) and applies to a remote path unchanged.
5. Size cap (`CODEMAN_MAX_DOWNLOAD_BYTES`) applied to the **remote** size, before the
   body is requested.

The path arrives from the browser (`?path=`) and is interpolated as a single
`shellescape`-quoted token, in a command that is itself shellescaped into the ssh
line; `BatchMode=yes` means a host needing a passphrase fails fast instead of hanging.
A failed connection is reported as **502** with the remote reason — never a 404, which
used to make an unreachable host look like a typo in the agent's output. The reason is
the first stderr line, the timeout, or the exit code; never Node's `Command failed: …`
message, which would carry the identity-file path and the probe script into the body.

**Connections are bounded.** Every probe and buffered read runs through a small global
semaphore (`src/remote-ssh-limiter.ts`, default 4, `CODEMAN_MAX_REMOTE_FILE_SSH`), the
attachment-history list resolves its whole history in one batched probe instead of one
handshake per entry, and probes are chunked at 40 paths per round trip. Terminal output
in a remote session is written on the remote host, so a prompt-injected agent printing
hundreds of `codeman://attach` links used to make the server fork one `ssh` per link,
each holding a 20 s probe timeout, and a 100-entry history re-listed on every
`attachment:detected` event tripped OpenSSH's default `MaxStartups 10:30:100`. Streams
(`file-raw`, by-id `raw`) are not counted: one is held per browser request for the life
of a playback, and each is gated behind a counted probe anyway.

⚠️ **There is deliberately NO local fallback.** A remote case reads the remote bytes or
fails, even when a file with the same absolute name exists on the Codeman host — which
is the ordinary case for the documented stop-gap workaround, an `sshfs` mount of the
remote tree at the identical path. Serving the local twin instead would silently hand
back a DIFFERENT filesystem's bytes under a name the user believes is the remote file
(a stale mount, a different checkout, a leftover file), and the failure would be
invisible. An existing mount therefore stops being load-bearing for previews and
downloads but is harmless, and a missing remote file stays a 404 even if the mount
still has it.

**Not available over ssh (by choice, not by accident):** editing a file (writes would
need SFTP; `docs/file-viewer-edit-plan.md` §6), office-document previews and
generated thumbnails (both need the bytes on the server's disk — no remote file is ever
spilled onto the server), the file-tree/picker listings, and `tail-file`. Those routes
are still local-only, so with an `sshfs` mount in place they read the mounted copy —
the two views can only disagree when that mount is stale. Docker cases are unaffected:
their workspace is bind-mounted at the same absolute path, so local `fs` reads real bytes.

⚠️ A remote record stores the **remote** path, and the same absolute path STRING means a
different file on each host. What decides which host to read is therefore never the
path but the SESSION (`session.remote`): a remote session never falls back to local
`fs`, and a local session never opens an ssh connection — including for attachment
records, which are keyed to the session that registered them.

## Wake-on-LAN from user input

A durable remote session survives an SSH drop (COD-104/108), but nothing brought the
HOST back. When the remote machine suspended, the local pane's `ssh` child **stalled**
rather than exited: `tmux send-keys` SUCCEEDS against a stalled pane, so typed input
vanished with no error anywhere, and without a keepalive the pane could look alive for
the OS TCP timeout. The only recovery was waiting for the reconnect watcher, which
gave up after ~13 minutes and, once exhausted, never retried.

An **optional** `wakeMac` (one or more MAC addresses, comma-separated) or `wakeCommand` on a
remote host closes that: on user input, `POST /api/sessions/:id/input` probes the host, and if
it is unreachable it wakes it, polls until the host answers, reattaches the pane
(`Session.reattachRemote()`, which idempotently attaches the still-running remote tmux — the
agent conversation is not restarted), and flushes the input that arrived meanwhile.
Implementation: `src/remote-wake.ts`.

Two wake paths, `wakeCommand` first because it is the explicit override:

- **`wakeMac`** — Codeman builds the magic packet itself (`buildMagicPacket`, six `0xFF`
  bytes then the MAC repeated 16×; the shape is asserted byte-for-byte) and broadcasts it
  over UDP port 9 (`sendWakePackets`). This is the normal case: no external script, and one
  MAC list per host instead of one per consumer.
- **`wakeCommand`** — a single executable path, run WITHOUT a shell. For hosts that need a
  router/another machine to send the packet.

**UI**: a banner (`#hostWakeBanner`, `host-wake-ui.js`) appears while the ACTIVE remote
session's host is unreachable — amber, since the Codeman session is healthy and only the
machine is asleep. With a wake target the action is **Wake** (`POST /api/sessions/:id/wake`);
with none it is **Configure WoL** and opens `#wakeConfigModal`, a small form for that host's
`wakeMac`/`wakeCommand` that saves with `PUT /api/remote-hosts/:id`. Reachability for the
banner comes from `GET /api/sessions/:id/reachability`, polled for the active remote session
(30 s, visible tab only).

The invariants worth keeping:

- **Only real user input or an explicit wake request may wake a host.** The COD-108 watcher,
  the server's dropped-session handler and boot recovery have no access to the wake registry —
  a wake there would re-wake the host seconds after every suspend, so it could never stay
  asleep (the same failure `hufflepuff-mcp-lazy` exists to prevent for MCP keepalives). A
  reachability check never wakes: it is a question, not an action. Both are enforced by tests
  in `test/remote-wake.test.ts` and `test/routes/session-remote-wake.test.ts`, not comments.
- **Detection is a bare TCP connect** to the SSH port (then the configured `port`, else 22),
  throttled per session, and only for wake-enabled hosts. No `ServerAliveInterval` is added to
  the launch command: keepalives push bytes into an otherwise idle connection every interval,
  which is exactly what a byte-threshold idle detector must not count as activity. A probe is
  ~200 bytes per 30 s, orders of magnitude below any such threshold, and the SYN alone cannot
  wake a host.
- **Input is buffered while a wake is in flight** (`REMOTE_WAKE_PENDING_MAX_BYTES`,
  oldest bytes dropped, bounded so user input cannot grow memory) and flushed in order
  after the reattach, with a settle delay so bytes cannot land in a still-connecting
  pane. The **send-and-wait** path blocks on the wake instead — its response is open
  anyway, and buffering would break the wait contract.
- **The command runs without a shell** (`spawn(path, [], { stdio: 'ignore' })` — `shell`
  defaults to `false`), the schema
  requires a single executable path (no arguments, no `$`/backtick), and `wakeMac` is a
  structural hex-pair allowlist. A broken or missing wake target fails the wake, never the
  input route.
- **`wakeMac`/`wakeCommand` are host-level config, refreshed on recovery AND live**
  (`rehydrateRemoteHostFields` in `src/remote-hosts.ts` plus `RemoteWakeDeps.resolveRemote`).
  A session's `remote` block is persisted at launch time, so a field added to
  `remote-hosts.json` later would otherwise never reach an already-running session — not even
  across a Codeman restart, and certainly not right after saving the banner's config dialog.
  Recovery rehydration covers restarts, the (throttled, cache-backed) resolver covers the live
  session; the host config is authoritative for both (removing the field disables the feature
  again). Other host-level fields deliberately stay as persisted, so neither path can
  silently re-point an existing pane's SSH options.
- **UI/SSE**: `remote:hostWaking` and `remote:hostWakeFailed` (plus the reused
  `remote:sessionReconnected`) drive the banner and toasts, all from `host-wake-ui.js` —
  its handlers are the ONLY definitions, since a second one in another mixin would be
  silently shadowed by script order.

Tests: `test/remote-wake.test.ts` (decision/throttle table, single-flight registry,
buffering + flush order, MAC parsing/magic packet, live host-config resolution, and the wiring
guard) and `test/routes/session-remote-wake.test.ts` (the input route buffers instead of writing
into a sleeping host, the reachability route never wakes, and the wake route reports the
no-target case the UI turns into "configure WoL").

## API

Routes are registered in `src/web/routes/case-routes.ts`:

| Method   | Path                                 | Purpose                                                                                        |
| -------- | ------------------------------------ | ---------------------------------------------------------------------------------------------- |
| `GET`    | `/api/remote-hosts`                  | List saved hosts                                                                               |
| `POST`   | `/api/remote-hosts`                  | Create a host                                                                                  |
| `PUT`    | `/api/remote-hosts/:id`              | Update a host                                                                                  |
| `DELETE` | `/api/remote-hosts/:id`              | Delete a host                                                                                  |
| `GET`    | `/api/remote-hosts/:hostId/sessions` | Discover `codeman-*` sessions on the host (COD-105; `listRemoteCodemanSessions`, never errors) |
| `POST`   | `/api/cases/remote-link`             | Link a case to a remote host (creates the `RemoteCase`)                                        |

`RemoteHost` accepts the optional `wakeMac` (magic packet, sent by Codeman) and `wakeCommand`
(single executable path, run without a shell, takes precedence) — see **Wake-on-LAN from user
input** above.

Attaching to a discovered session is a **session-create** path, not a host route:
`POST /api/sessions` accepts `attachRemoteSession: { hostId, remoteSessionName }`
(schema in `schemas.ts`; `remoteSessionName` must match `^codeman-[a-zA-Z0-9._-]+$`),
which `session-routes.ts` turns into a non-owned (`owned: false`) session.

Frontend touchpoints: the remote-host management UI is in `session-ui.js` /
`panels-ui.js`; a remote session is created by picking a remote host/case in the
session-create flow, or via the per-host **"Discover existing sessions"** button →
**Attach** action (creates an `owned: false` session).

## Security notes

- **`identityFile` is a path only — never key bytes.** Codeman stores the path and
  passes it to `ssh -i`; the key never enters Codeman's state or the wire.
- The injection surface is the SSH option fields. The single-source
  `buildSshConnectionArgs` + `shellescape` discipline (COD-107) is the control —
  audit any new code path that constructs an ssh command to route through it
  rather than concatenating options inline.
- `BatchMode=yes` means **no interactive password/passphrase prompts** — remote
  hosts must be reachable with key-based or agent auth (or an unencrypted key the
  agent has loaded). A host needing a passphrase will fail the probe with an ssh
  diagnostic rather than hang.

## Related

- `CLAUDE.md` → Architecture → **Remote** row, and the **Remote sessions (SSH)**
  Key Pattern.
- `docs/security-architecture.md` — overall network/auth model.
- COD-104 (tmux prereq + durable launch), COD-105 (discover + attach, detach-not-kill ownership), COD-107 (shell-safe connection args).
