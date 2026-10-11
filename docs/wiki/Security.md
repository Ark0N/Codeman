# Security

The honest version first: **Codeman's dashboard is a remote code execution surface, by
design.** It starts agents with permission prompts skipped by default, so anyone who can
reach it can run arbitrary code as your user, on your machine. Every protection in Codeman
exists to control who that is.

That is not a flaw to be fixed. It is what "run my coding agent for me" means. The job is to
make sure the set of people who can reach it is exactly the set you intended.

## The default is safe

A bare `codeman web` binds `127.0.0.1`. Only processes on that machine can reach it, which
is why shipping with no password by default is defensible. Everything risky starts when you
expose it.

## Hardening checklist

In order of how much they matter:

1. **Do not expose it without `CODEMAN_PASSWORD`.** Binding a non-loopback host without one
   starts, but warns loudly. A tunnel refuses outright unless you acknowledge the exposure
   in the UI.
2. **Prefer Tailscale over a public tunnel.** Keeping the loopback bind and putting a
   private network in front of it removes the public attack surface entirely, and gives you
   real HTTPS. See [Remote Access](Remote-Access).
3. **Use a long password.** It is the only thing between a public URL and your shell.
4. **Consider the permission mode.** **App Settings → Agents & CLIs → Claude → Startup
   Mode** can switch new sessions from skip-prompts to Anthropic's classifier-guarded `auto`
   mode, to normal prompting, or to an explicit allowed-tools list.
5. **Use Docker cases for untrusted work.** If you are pointing an autonomous loop at a repo
   you did not write, [Docker Cases](Docker-Cases) gives it its own filesystem and network
   for the cost of one checkbox.
6. **Keep it updated.** Browser-driven attack paths were closed in 0.9.x and hardening is
   ongoing.

## What protects what

These run on **every** request, including on a default no-password loopback install:

| Layer                        | What it stops                                                                                  |
| ---------------------------- | ----------------------------------------------------------------------------------------------- |
| **Host-header allowlist**    | DNS rebinding. A domain rebound to `127.0.0.1` is rejected before any handler runs. Add your own domains with `CODEMAN_ALLOWED_HOSTS`. |
| **Cross-site Origin guard**  | CSRF on state-changing requests. A *missing* Origin is allowed so curl, the CLI, and hooks keep working; a foreign or opaque one is rejected. |
| **Raw `text/plain` bodies**  | The CORS simple-request CSRF vector, where a cross-site form could smuggle JSON into a write route with no preflight. |
| **WebSocket origin check**   | Cross-site WebSocket hijacking. The terminal upgrade closes with code `4003` on failure.        |
| **Output escaping**          | Stored XSS from agent-derived strings: tool names, command arguments, subagent descriptions.     |
| **Security headers**         | A strict content security policy, `nosniff`, frame options, and HSTS over HTTPS. CORS is reflected only for loopback origins. |

When authentication is enabled:

| Layer               | Behaviour                                                                                       |
| ------------------- | ------------------------------------------------------------------------------------------------ |
| **HTTP Basic**      | `CODEMAN_USERNAME` (default `admin`) and `CODEMAN_PASSWORD`.                                      |
| **Session cookie**  | A 256-bit opaque token validated server side, so it cannot be forged offline. 24 hours, extended on activity, with a device-context audit trail. |
| **Rate limiting**   | Ten failed attempts per IP produce a `429` with a 15 minute decay. A correct password or valid cookie recovers immediately even under attack, which matters because all tunnel traffic shares one loopback address. |
| **QR auth**         | Single-use 60-second tokens with their own separate rate limiter, so a mistyped password cannot lock out QR login. |
| **Hook endpoints**  | The hook and telemetry endpoints skip Basic auth because they are called from localhost by the CLI, but when auth is on, that bypass additionally requires a per-instance hook secret. |

## File access

Three separate file surfaces, each confined differently, because a single shared rule would
be wrong for at least one of them:

| Surface              | Rules                                                                                      |
| -------------------- | -------------------------------------------------------------------------------------------- |
| **File Viewer**      | Real path resolution before boundary checks, so symlinks cannot escape. Sensitive trees blocked. Edit mode adds an extension allowlist, a size cap, `.git` denial, and optimistic concurrency. It never creates files. |
| **Attachments**      | An id-based registry, so browser requests never carry absolute paths. The magic-link scanner is prompt-injectable by nature and is therefore force-confined to the session's workspace. Extension allowlist, not a blocklist. |
| **Path picker**      | Its own root allowlist rather than the workspace confinement. In multi-user mode a non-admin gets only their own user space, because per-user spaces live inside the home directory. |
| **Remote cases**     | Reads go over the session's own ssh connection and are resolved and contained on the remote host, with a bounded number of ssh children. Nothing is copied to the Codeman host; writes, Office previews and thumbnails are refused. |

Downloads block sensitive paths outright (`.env`, credentials files, `~/.ssh`, AWS
credentials), and SVG and HTML are served as downloads with `nosniff` so they cannot execute
in the page.

## Supply chain and isolation

- Security-sensitive transitive dependencies are pinned to patched versions, and lockfile
  integrity is checked on every push and pull request: every entry must resolve to the public
  registry with a hash.
- Public assets are scanned for NUL bytes and syntax-checked in CI.
- `CODEMAN_INSTANCE` scopes the tmux socket and the data directory together, so two
  instances never attach each other's live sessions.

## What Codeman does not protect against

Stated plainly, because a security page that only lists strengths is not useful:

- **Multi-user mode is not a sandbox.** It separates workspaces. Every session still runs as
  the same OS account, so a determined user's agent can reach another user's files. For real
  isolation, pair users with Docker cases or run separate instances under separate OS
  accounts.
- **An agent you gave shell access can do anything you can.** Permission modes narrow this;
  they do not remove it.
- **A tunnel makes your machine reachable from the internet.** The password is the whole
  boundary. Treat it accordingly.
- **Codeman cannot detect your own loopback reverse proxy**, which is why the hook-endpoint
  bypass requires a secret unconditionally when auth is on.
- **The agent CLIs have their own trust models.** Pi's project trust executes repo-local
  TypeScript, for instance. See [Agent CLIs](Agent-CLIs).

## Privacy

No telemetry, no analytics, no phone-home. Codeman's only network traffic is between your
browser and your server. Your agent CLI's traffic is its own, on your account.

Two features send data outward, both off by default and both stated where they appear: voice
dictation through your Claude login, and the Read My Mind prediction call.

[Config Backups](Config-Backups) copies some credential-bearing files (`.env`, `users.json`,
`custom-model-hosts.json`, `push-keys.json`) into a backup folder. The default folder is inside
the data directory, and every backup is mode `0700`/`0600`, so nothing new is exposed. Only a
folder you choose yourself can move them somewhere less private; admin only in multi-user mode.

## Reporting a vulnerability

**Never in a public issue.**
[SECURITY.md](https://github.com/Ark0N/Codeman/blob/master/.github/SECURITY.md) has the
private disclosure process and the current list of known limitations.

## Read next

- [Remote Access](Remote-Access) - the safe ways to expose it.
- [Multi-User Mode](Multi-User-Mode) - what it does and does not separate.
- [Docker Cases](Docker-Cases) - real isolation for untrusted work.
- [`docs/security-architecture.md`](https://github.com/Ark0N/Codeman/blob/master/docs/security-architecture.md) - the complete model.
