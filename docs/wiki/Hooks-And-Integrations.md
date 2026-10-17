# Hooks and Integrations

Events flowing **back** into Codeman, and the four seams a third party can build against.

## Hooks

Claude Code can run a command when something happens in a session. Codeman writes a hooks
configuration into each Claude case so those events post back to it, which is what turns a
terminal into something that can notify you.

| Event                  | Fires when                                      | Drives                                        |
| ---------------------- | ----------------------------------------------- | --------------------------------------------- |
| `permission_prompt`    | The agent asks for permission.                   | Red tab alert, Approvals Inbox, push.          |
| `idle_prompt`          | The agent is waiting for input.                  | Yellow tab alert, the `idle` wait signal.      |
| `stop`                 | A turn ends.                                     | The `stop` wait signal, idle detection.        |
| `elicitation_dialog`   | A dialog opens.                                  | Approvals Inbox.                               |
| `elicitation_complete` | The dialog closes.                               | Clearing the alert.                            |
| `elicitation_response` | The dialog is answered.                          | Clearing the alert.                            |
| `teammate_idle`        | An agent-team member goes idle.                  | Team surfaces.                                 |
| `task_completed`       | A task finishes.                                 | Task tracking, run summary.                    |

This is why several Codeman features are Claude-only. One partial exception is DeepSeek
Harness, whose terminal front door reports idle, working and blocked to Codeman over the
harness's own supervisor contract, so it gets the hook-driven surfaces without any hook
file. Codex gets one of them from its screen: Codeman reads its approval, question and
trust dialogs off the pane and raises the same red "needs you" alert a `permission_prompt`
hook raises (see [Agent CLIs](Agent-CLIs#codex)). The other CLIs have no equivalent, so for
them Codeman watches terminal output, which reveals that something happened but not what it
was.

### How hooks get installed

Codeman writes them into the case when a Claude session is created. Hook blocks are
**marker-owned**: Codeman only ever updates a block it wrote, and never touches
configuration you added yourself.

If tab alerts and approvals never fire in a particular case, that case is missing its hook
block. Recreating the case rewrites it.

### The hook secret

`/api/hook-event` and `/api/status-telemetry` skip HTTP Basic authentication, because they
are called from localhost by the CLI itself. When authentication is on, that bypass
additionally requires a per-instance hook secret, because Codeman cannot tell a genuine
loopback call from a request arriving through your own loopback reverse proxy.

The secret lives in the data directory, and its path is exported into every managed session.

### Two things that break hooks

- **HTTPS.** Hook callbacks must accept the self-signed certificate. Recent versions
  self-heal existing cases; older cases need recreating.
- **Docker cases on a loopback bind.** A container cannot reach `127.0.0.1` on the host, so
  in-container hooks silently do not fire. Set `CODEMAN_DOCKER_BRIDGE_HOOKS=1` to open a
  hooks-only listener on the bridge gateway. See [Docker Cases](Docker-Cases).

## Integration seams

Codeman has **no plugin runtime**, and that is a decision rather than a gap. A plugin runtime
means running third-party code inside a process that spawns agents with your credentials, on
a server people routinely expose over a tunnel. Codeman's security posture is one of its
reasons to exist, so it does not trade that away for an extension mechanism.

What exists instead is four documented seams.

### 1. Web tabs

Anything with a web UI can live inside Codeman as a tab, proxied through Codeman's own
origin. The lowest-effort integration by a wide margin: if your tool has a dashboard, it can
sit beside the agents with no code at all. See [Web Tabs](Web-Tabs).

### 2. SSE events

`GET /api/events` streams everything Codeman knows: session lifecycle, output, agent
activity, approvals, cron runs. 158 named events, stable under semantic versioning.

This is the seam for anything that reacts. A bot that pings your chat channel when an agent
needs a human is a short script over this stream.

### 3. HTTP API and CLI

Everything the dashboard does. Create sessions, send input, block on wait primitives, read
terminals, manage cron. See [HTTP API](HTTP-API) and
[Driving Codeman From An Agent](Driving-Codeman-From-An-Agent).

### 4. Hooks

The seam above, in the other direction: your own hook commands can run alongside Codeman's
in a case, as long as you leave Codeman's marker-owned block alone.

## Publishing an integration

There is no registry to submit to. Share it in
[Show and tell](https://github.com/Ark0N/Codeman/discussions/300), and if it needs a change
in Codeman to work properly, open an issue or a Discussion first.

## Read next

- [HTTP API](HTTP-API) - the endpoint map and envelope.
- [Driving Codeman From An Agent](Driving-Codeman-From-An-Agent) - the agent-facing path.
- [`docs/extending-codeman.md`](https://github.com/Ark0N/Codeman/blob/master/docs/extending-codeman.md) - the seams in full, with examples.
- [`docs/claude-code-hooks-reference.md`](https://github.com/Ark0N/Codeman/blob/master/docs/claude-code-hooks-reference.md) - upstream hook semantics.
