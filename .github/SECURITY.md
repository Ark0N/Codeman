# Security Policy

Codeman launches AI coding sessions with `--dangerously-skip-permissions`, so the
web UI is **by design a remote-code-execution surface for whoever can reach it**.
The entire security model exists to control *who* that is. Please read this before
exposing an instance beyond `localhost`. The full model lives in
[`docs/security-architecture.md`](../docs/security-architecture.md).

## Supported versions

Security fixes land on the latest published `codeman@X.Y.Z` release and `master`.
Older versions are not patched — upgrade to the latest release (App Settings →
Updates for git-clone installs, or `npm i -g aicodeman@latest`).

| Version | Supported |
| ------- | --------- |
| latest `0.9.x` / `master` | ✅ |
| anything older | ❌ (upgrade) |

## Reporting a vulnerability

**Please do not open a public issue for security problems.**

Report privately via **GitHub's private vulnerability reporting**:
the repository's **Security** tab → **Report a vulnerability**
(<https://github.com/Ark0N/Codeman/security/advisories/new>). This opens a private
advisory thread with the maintainer.

> Maintainer note: enable *Settings → Code security and analysis → Private
> vulnerability reporting* so this channel is live.

When reporting, please include: affected version/commit, the deployment shape
(loopback-only, `CODEMAN_PASSWORD` set, tunnel/`tailscale serve`, custom
reverse proxy), reproduction steps, and impact. We aim to acknowledge within a
few days. Coordinated disclosure is appreciated — we'll agree a disclosure
timeline with you once impact is confirmed.

### In scope
- Authentication / session-cookie bypass when `CODEMAN_PASSWORD` is set
- DNS-rebinding, CSRF/CSWSH, or Origin/Host-guard bypass reaching state-changing routes
- Remote code execution reachable **without** local OS access (e.g. via a browser, a tunnel, or a foreign origin)
- Path traversal / arbitrary file read or write through the HTTP API
- Supply-chain integrity of the in-app self-updater

### Out of scope (by design — see Known limitations)
- Anything requiring an already-trusted **same-machine, same-uid** process. Codeman trusts the local OS user it runs as; a peer process of that user is already inside the boundary.
- Running an authless instance bound to a non-loopback host after dismissing the startup warning (you explicitly acknowledged it).
- The default loopback + no-password posture itself (it is reachable only from the same machine).

## Trust model (summary)

- **Loopback by default.** Binds `127.0.0.1`; the no-password default is safe out of the box. Binding a non-loopback host without `CODEMAN_PASSWORD` *starts but prints a loud warning* with concrete fixes.
- **Always-on Host + Origin guards.** Block DNS-rebinding and cross-site state-changing requests even on the no-auth loopback install (a missing Origin is allowed so CLI/hooks work).
- **Optional auth.** HTTP Basic via `CODEMAN_USERNAME`/`CODEMAN_PASSWORD`; success issues an opaque server-side 256-bit cookie. Per-IP rate limiting on failures.
- **Hardened file serving, tmux launch, transport headers, and multi-instance isolation** — see the full architecture doc.

## Known limitations and accepted risk

A 1.0 release is an implicit statement that the documented model *is* the model, so
these residuals are stated explicitly. Most sit **inside the same-uid OS trust
boundary** or behind the always-on Origin guard; they matter mainly for
shared-host, multi-user, or tunneled deployments.

- **Self-update trusts an unsigned release tag.** The in-app updater does `git checkout <tag> && npm install` (lifecycle scripts run) of a tag matched only by name shape, from whatever `origin` points to — no signature/commit verification. Treat the updater as trusting your `origin` remote and your release pipeline. (Hardening tracked for 1.0.)
- **CSP ships `'unsafe-inline'`.** Inline handlers mean the Content-Security-Policy is defense-in-depth only; all AI-/file-derived sinks are escaped, but a future missed escape would be executable.
- **`workingDir` is unconstrained.** A session may be created with any absolute working directory (e.g. `/`), which becomes the file-route boundary for that session. Scope it to trusted paths on shared hosts.
- **Hook-event auth exemption is loopback-IP-based.** `POST /api/hook-event` is exempt from auth for loopback callers; because tunnels (cloudflared / `tailscale serve`) terminate at `127.0.0.1`, a loopback-terminating tunnel inherits the exemption. Set `CODEMAN_PASSWORD` and prefer a tunnel that preserves the client identity if this matters.
- **Session cookie is not bound to client IP/UA on reuse, and refreshes without an absolute cap.** A stolen cookie replays until its idle TTL elapses.
- **Multi-instance tmux socket is process-wide.** Two Codeman instances on the same `CODEMAN_INSTANCE` share a tmux socket and can attach each other's live sessions — isolate with distinct `CODEMAN_INSTANCE` values.
- **The live log-tail route reads `/var/log` and `~/logs`** in addition to the session working directory (read-only) — a deliberate choice for tailing system/app logs. On a password-protected remote deployment an authenticated user can therefore read those roots outside their session. See `docs/security-architecture.md` §5.

- **The local model runtime listens on a loopback port with no login.** The model server the local model install starts (macOS only, opt-in by a click) accepts requests from any process of any account on the Mac, and from any page served from `localhost`, like every model server of its kind. Codeman limits what that buys (one model in the endpoint record, a digest check before an agent is started on it) but does not authenticate the port. See `docs/security-architecture.md` §10d.
- **The web-tab proxy fetches from the server's network position.** Any authenticated user can save a dashboard URL on loopback or a private range and have Codeman relay to it; that is the feature. Link-local and cloud-metadata addresses are the only refused targets (see below). On a shared host, restrict who holds an account.

Recent hardening (2026-09-04): the web-tab proxy, its "Test" probe and its
WebSocket relay refuse link-local and cloud-metadata targets (`169.254.0.0/16`,
`fe80::/10`, `fd00:ec2::254`, `168.63.129.16`, `100.100.100.200`,
`metadata.google.internal`), judged on the RESOLVED address so a DNS name pointing
there is refused too; proxy capabilities are revoked on logout, admin logout and
user deletion; proxied responses carry `Referrer-Policy: same-origin`. Earlier:
web-push subscription endpoints are restricted to https public hosts (SSRF guard,
rejects internal/metadata IP literals, validated at subscribe and send time), and
tmux session names discovered on the shared socket are validated against the
safe-name pattern before reaching any shell call site.

For the detailed rationale, defenses, and recommended secure setups, see
[`docs/security-architecture.md`](../docs/security-architecture.md).
