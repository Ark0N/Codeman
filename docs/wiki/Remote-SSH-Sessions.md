# Remote SSH Sessions

Point a case at another machine and the agent runs **there**, with the same dashboard,
mobile UI, and autonomy features. Your laptop becomes a window onto a session living on the
remote host.

Like Docker, this is a **location overlay** on a case, not a run mode. All eleven run modes
work remotely. See [Core Concepts](Core-Concepts).

## Why bother

The agent runs where the work is: a build server, a NAS, a GPU box, a machine reachable only
through a jump host. Your laptop can sleep, change networks, or close, and the run continues.

## Setting it up

**Add Case → Remote**:

| Field                 | Notes                                                                |
| --------------------- | -------------------------------------------------------------------- |
| **Host**              | Hostname or IP.                                                       |
| **Username**          | The SSH user.                                                         |
| **Port**              | Defaults to 22.                                                       |
| **Identity file**     | `~` and `$HOME` are expanded for you.                                 |
| **Jump host**         | The `-J` equivalent, `[user@]host[:port]`.                            |
| **SOCKS proxy**       | For hosts reachable only through a proxy.                             |
| **Extra SSH options** | Any `KEY=VALUE` options your normal connection needs.                 |
| **Remote path**       | The working directory on that machine.                                |

Hosts are saved and reusable, so a second case on the same machine is just a path. Host
profiles can also carry per-run-mode launch command overrides, for when the binary lives
somewhere unusual on that host.

The remote host needs **tmux**. Codeman probes for it when you link the host rather than
failing later at launch.

## What actually runs

The agent lives inside a dedicated tmux server on the **remote** host, and Codeman fronts it
with a local tmux pane running `ssh`.

That two-layer arrangement is what makes it durable: a dropped SSH connection, a network
change, or a closed laptop kills the local pane, not the remote session. Reconnecting lands
back in the same live conversation.

The remote session name is deliberately chosen so that a Codeman **running on the target
host** will not adopt it as one of its own. Two Codemans, one host, no interference.

## Auto-reconnect

A watcher with bounded backoff notices a dead SSH pane and quietly reattaches to the still
running remote session. On by default; the kill switch is in
**App Settings → Agents & CLIs → Remote auto-reconnect**.

Intentional kills are never revived. Closing a session means closing it. Neither is a clean
exit inside the pane (Ctrl-D, `exit`, Ctrl-C at the CLI's prompt): that tears the remote
tmux session down, and the watcher revives a session only when that durable session is
verifiably still alive. Only a transport drop is reconnected.

## Discover and attach

Codeman can list the `codeman-*` sessions already running on a host, whether that machine's
own Codeman started them or another operator did, and attach to one.

The distinction that matters:

| Session      | On tab close                                    |
| ------------ | ------------------------------------------------ |
| **Launched** | Killed, like any local session.                  |
| **Attached** | **Detached, never killed.**                      |

Attaching to someone else's session and closing your tab must not end their run, so it does
not. Several clients can attach the same remote session at different window sizes without
clamping each other, and discovery shows a shared badge with the client count.

## Files

Previews, downloads and text reads in a remote case go over the same ssh connection the
session uses, so a clicked path opens the file on the machine the agent is on, `Range`
seeking included. Nothing is copied to the Codeman host. Editing, Office previews,
thumbnails, the file tree and the tail viewer are not available remotely and answer a clear
400 rather than a misleading 404. Details in [Working With Files](Working-With-Files).

## Security

Every SSH command line in Codeman flows through one builder that shell-escapes every
user-supplied field: identity paths, jump hosts, proxy commands, and extra options. That is
the entire injection surface, and it is deliberately a single function rather than string
concatenation spread across the codebase.

Host, path, and identity fields are schema-validated on top of that.

Codeman does not store SSH passwords. Use keys, as you would for any other automation.

## Gotchas

- **The remote host needs tmux.** Probed at link time, so you find out immediately.
- **The local working directory is meaningless** for a remote session, and is not used.
- **Run flows must go through the quick-start path** for remote cases. This matters if you
  are driving Codeman over the API: the plain session-create endpoint validates the working
  directory locally and has no case concept, so it will reject or misroute a remote case.
- **Latency is SSH latency.** Local echo helps the typing feel, but a slow link is a slow
  link.
- **Transcript-backed features follow the transcript.** Subagent windows and similar surfaces
  read files on the machine where the agent runs.

## Read next

- [Core Concepts](Core-Concepts) - overlays versus run modes.
- [Docker Cases](Docker-Cases) - the other overlay.
- [Security](Security) - the wider model.
- [`docs/remote-sessions.md`](https://github.com/Ark0N/Codeman/blob/master/docs/remote-sessions.md) - the full design.
