# Tailscale Setup in the Installer (Plan)

> Superseded in part by [`installer-v2-plan.md`](installer-v2-plan.md) (2026-09-20), which
> moved every human step before the build, added the sub-path / second-port answer for an
> occupied `:443`, the opt-in rename, flags, and the done screen with a QR code. The
> state machine and safety rules below still hold.

Goal: make "Codeman over Tailscale, with real HTTPS" a first-class, guided path in
`install.sh`, instead of a one-line hint pointing at the docs. Today the safest
recommended deployment (loopback bind + `tailscale serve`) is exactly what the
maintainer's own prod runs, but a new user has to discover and wire it by hand.
The installer should do it for them.

Status: IMPLEMENTED (2026-08-04). `install.sh` carries the 3-way network
prompt, the guided Tailscale flow, and the `tailscale` subcommand; README,
`docs/security-architecture.md` section A, and CLAUDE.md are updated. Verified
live on the maintainer's prod host: `install.sh tailscale` took the idempotent
kept-as-is path against the existing serve mapping (recognizing the legacy
`https+insecure://` target), verified `https://<node>.ts.net/api/status`
end-to-end, and left `tailscale serve status` byte-identical. Items 1-4, 7,
and 10-12 of the manual matrix below still need a fresh machine to exercise.

## Why this is low-hanging fruit

Everything on the app side already works; this is almost purely installer UX:

- `.ts.net` is already in `DEFAULT_TRUSTED_HOST_SUFFIXES`
  (`src/web/network-auth-policy.ts`), so the always-on Host/Origin guard accepts
  `tailscale serve` traffic with zero configuration. No `CODEMAN_ALLOWED_HOSTS`
  needed.
- The loopback bind is the server default and prints no warning; nothing to
  acknowledge, no `CODEMAN_PASSWORD` strictly required (the tailnet is the auth
  boundary; Tailscale authenticates the device before a packet ever reaches us).
- `tailscale serve` terminates TLS with a real Let's Encrypt certificate for
  `<node>.<tailnet>.ts.net`. That gives users valid HTTPS with no self-signed
  cert warnings, and (because it is a proper secure context) working service
  worker, PWA install, and web push on phones. This is strictly better than
  `codeman web --https` for remote access.
- SSE and WebSockets work through serve (proven by prod:
  `https://tnode.tailf80371.ts.net` fronting `127.0.0.1:3000` daily).
- `docs/security-architecture.md` section "A. Tailscale serve (recommended)"
  already documents this as the preferred setup; the installer just does not
  implement it.

## UX design

### 1. The network-access prompt grows a Tailscale option

`choose_network_binding()` (install.sh:1051) currently offers two choices. New
menu, with Tailscale first when it can be recommended:

```
  Network access

  How should the Codeman dashboard be reachable?

    1) Tailscale (recommended)
       Private VPN access from your phone/laptop, real HTTPS,
       no password needed. Works from anywhere, not just your Wi-Fi.
    2) Any device on your network (0.0.0.0)
       Open it straight from your phone or laptop on the same Wi-Fi.
       Less safe: set a password so only you control your agents.
    3) This machine only (127.0.0.1)
       Safest. Reach it remotely via Tailscale or a tunnel later.
```

Choice mapping:

- Option 1 = bind `127.0.0.1` (unchanged server posture) + configure
  `tailscale serve`. Internally it is option 3 plus the serve setup, so all
  existing binding plumbing (`BIND_HOST`, service files, `read_existing_binding`)
  is untouched.
- Options 2 and 3 behave exactly as today (renumbered).
- Default choice: 1 when tailscale is installed and logged in, or when an
  existing serve mapping for our port is detected; otherwise keep today's
  defaults (1 -> 2, 2 -> 3 renumbering, preserving the "existing setup wins"
  rule). If tailscale is not installed, option 1 is still shown (the installer
  offers to install it), but the default stays on the current behavior so a
  bare Enter never pulls in new software.
- Password: after choosing Tailscale, offer the password prompt as optional
  defense in depth with default skip ("the tailnet already authenticates your
  devices; add one anyway?"). No `BIND_ACK` needed since the bind is loopback.

### 2. The Tailscale flow (state machine)

New `setup_tailscale_access()` runs after the binding choice, before service
setup, handling each state in order:

1. **Not installed.**
   - Linux: offer to run the official installer
     (`curl -fsSL https://tailscale.com/install.sh | sh`), which handles all
     distros and enables `tailscaled` at boot. This mirrors our own
     curl-pipe-bash story and avoids maintaining per-distro logic like the six
     `install_cloudflared_*` functions.
   - macOS: do not auto-install (the GUI app needs an interactive login).
     Offer `brew install --cask tailscale` when brew exists, else print the
     download link, then wait-and-retry or let the user skip.
   - Declined install => fall back to plain loopback (option 3 behavior) and
     print how to redo this later (`install.sh tailscale`, see below).
2. **Installed but logged out** (`tailscale status --json` ->
   `.BackendState == "NeedsLogin"` or `"Stopped"`).
   - Run `tailscale up` (via `run_as_root` if needed). It prints an auth URL
     that works headless (user opens it on any device). Poll
     `.BackendState == "Running"` with a friendly spinner + timeout; on
     timeout, skip gracefully with re-run instructions.
3. **Running: grant operator (Linux).** `sudo tailscale set --operator=$USER`
   so serve configuration (now and in the future) does not need root. Skip
   silently if we are already operator (probe: `tailscale serve status`
   exits 0) or sudo is declined; fall back to `run_as_root tailscale serve ...`.
4. **HTTPS availability check.** `.CertDomains` empty or
   `.CurrentTailnet.MagicDNSEnabled == false` means the tailnet has not enabled
   MagicDNS / HTTPS certificates. Print the exact two toggles with the admin
   URL (https://login.tailscale.com/admin/dns: enable MagicDNS, then enable
   HTTPS Certificates), then offer "I enabled it, re-check" / "skip for now".
   No silent HTTP fallback: the pitch is real HTTPS, and a plain-HTTP serve
   would break the PWA/push story. Skipping falls back to loopback + re-run
   instructions.
5. **Existing serve config check** (`tailscale serve status --json`).
   - Already proxying to our port (443 -> `127.0.0.1:$PORT`): keep it, report
     it, done. Re-running the installer must be idempotent.
   - Port 443 occupied by a DIFFERENT target: never clobber it. Ask whether to
     replace it or skip. (Prod itself has a second serve on :5000; blind
     `tailscale serve reset` would destroy user config. NEVER use `reset`.)
6. **Configure.** `tailscale serve --bg $PORT` where `$PORT` is the install's
   Codeman port (default 3000; honor a preset `CODEMAN_PORT`). Serve targets
   plain HTTP on loopback; TLS terminates at tailscaled with the real cert.
   The `--bg` config persists in tailscaled state across reboots, so no extra
   service unit is needed.
   (Note: do NOT combine this with `codeman web --https`; that is what forces
   the awkward `https+insecure://` proxy target prod historically used. New
   installs should keep Codeman on plain HTTP behind serve.)
7. **Verify end-to-end.** Derive the URL from `.Self.DNSName` (strip the
   trailing dot) and curl `https://<dnsname>/api/status` after the service is
   up, retrying for ~30s: the first request can be slow while the Let's
   Encrypt cert is issued. Print success with the URL, or the observed error
   with `tailscale serve status` output on failure. This follows the "always
   test before claiming it works" rule; a blind "done!" is not acceptable.

### 3. Closing summary and security notice

- The final summary gains a "Remote Access (Tailscale)" block, printed above
  the cloudflared block, showing the actual URL:

  ```
    Remote Access (Tailscale):
      https://tnode.tailf80371.ts.net    (any device on your tailnet, HTTPS)
      tailscale serve status             # inspect
  ```

- `print_security_notice()` third branch (loopback) gets a variant: when a
  serve mapping for our port is detected, lead with "reachable on your tailnet
  at https://... (HTTPS, tailnet-only)" instead of the generic "do ONE of"
  list. Detection is dynamic (query `tailscale serve status --json` at print
  time), no marker persisted anywhere: tailscaled's own state is the single
  source of truth, so external changes never drift against a stale flag.

### 4. Standalone entry point: `install.sh tailscale`

Add a `tailscale` subcommand next to `update` / `uninstall` in the existing
dispatch. It runs `setup_tailscale_access()` against the already-installed
service (reads the port from the service file, requires an existing install).
This serves:

- existing installs that predate the feature,
- users who picked "this machine only" and changed their mind,
- every "skip for now" branch above, all of which print this exact command.

One implementation, two entry points. No separate `scripts/tailscale-setup.sh`
(unlike cloudflared, there is no long-running process for a `tunnel.sh`-style
start/stop wrapper to manage; tailscaled owns the lifecycle).

### 5. Non-interactive / automation

- `CODEMAN_TAILSCALE=1` presets choice 1 (analogous to presetting
  `CODEMAN_HOST`). In non-interactive runs it only proceeds through states
  that need no human (already installed + logged in + HTTPS-enabled tailnet);
  anything requiring interaction (login URL, admin-console toggle, replacing a
  foreign serve mapping) warns and falls back to loopback. It never installs
  tailscale non-interactively.
- `CODEMAN_NONINTERACTIVE=1` with an existing serve mapping: preserve it, same
  "never silently loosen/change" policy as `read_existing_binding`.
- Document both in the header comment block of install.sh (the env-var
  reference at the top) and in the README.

## Edge cases and decisions

| Case | Decision |
| ---- | -------- |
| macOS GUI app without `tailscale` on PATH | `get_tailscale_path()` helper mirroring `get_cloudflared_path()`: check PATH, then `/Applications/Tailscale.app/Contents/MacOS/Tailscale`. All calls go through it. |
| Tailnet HTTPS certs disabled | Guided admin-console instructions + re-check loop; skip falls back to loopback. Never configure plain-HTTP serve. |
| Port 443 serve exists for another app | Prompt replace/skip; never `tailscale serve reset` (destroys unrelated mappings). |
| First cert issuance latency | Verify step retries ~30s and says why the first load may be slow. |
| `tailscale up` needs auth | Print the auth URL prominently, poll with timeout, skip gracefully. Works headless. |
| Custom `CODEMAN_PORT` | Serve target uses the actual port; `install.sh tailscale` re-reads it from the service file. |
| Funnel (public internet) | OUT OF SCOPE for v1. If ever added it must mirror the tunnel guard: refuse without `CODEMAN_PASSWORD` (`isUnauthenticatedNetworkAcknowledged`). Funnel exposes to the whole internet and is a different risk class than tailnet-only serve. Mention `tailscale funnel` in docs only, with the password warning. |
| Uninstall | Best effort: if `serve status --json` shows 443 proxying to our port, run the targeted `tailscale serve --https=443 off` (still accepted by current CLIs); if the CLI rejects it, print manual instructions. Never touch other mappings, never uninstall tailscale itself. |
| User already fronting Codeman some other way (reverse proxy etc.) | The serve check only looks at tailscale state; other proxies are invisible and unaffected (same stance as the loopback-exemption note in security-architecture). |

## What does NOT change

- Server code: no changes required. Host guard already trusts `.ts.net`,
  loopback bind is already the default, SSE/WS already work through serve.
- The two existing binding options and their semantics, `read_existing_binding`
  preservation, and the LAN+password flow.
- `scripts/tunnel.sh` / cloudflared support (stays as the "no Tailscale
  account" alternative).
- The security model: this feature only ever narrows exposure (loopback +
  authenticated overlay), never widens it.

## Files touched (implementation inventory)

| File | Change |
| ---- | ------ |
| `install.sh` | New: `check_tailscale`, `get_tailscale_path`, `tailscale_status_field` (jq-free JSON field extraction; the installer cannot assume jq: use `sed`/`grep` like existing helpers or `tailscale status --json` piped to `node -e` since node is guaranteed post-install), `offer_install_tailscale`, `ensure_tailscale_login`, `ensure_tailscale_operator`, `ensure_tailnet_https`, `setup_tailscale_serve`, `verify_tailscale_access`, `setup_tailscale_access` (orchestrator). Modified: `choose_network_binding` (3-way menu), summary block, `print_security_notice`, subcommand dispatch (`tailscale`), `uninstall` (targeted serve removal), header env-var docs (`CODEMAN_TAILSCALE`). |
| `README.md` | Remote-access section: promote the Tailscale path with the one-liner and `install.sh tailscale`; keep the tailscale-IP HTTP note for non-serve users but recommend serve + HTTPS. |
| `docs/security-architecture.md` | Section A gains "the installer can set this up for you" + `install.sh tailscale` pointer. |
| `CLAUDE.md` | One line in Scripts & Tunnel: installer offers Tailscale setup (`install.sh tailscale` to redo). |
| `test/` | No unit tests possible for interactive bash + a live tailnet; guard with `shellcheck install.sh` (already the norm) and the manual matrix below. |

## Manual test matrix (before release)

1. Linux + tailscale absent: install offered, declined => loopback fallback + hint.
2. Linux + tailscale absent: install accepted => full flow => URL verified.
3. Logged out => auth URL flow => Running => serve configured.
4. Tailnet with HTTPS certs disabled => guided instructions => re-check => success; and the skip branch.
5. Re-run installer with serve already configured => idempotent, preserved, reported.
6. Second serve mapping on another port present => untouched (prod-like state).
7. Port 443 already proxying another target => replace/skip prompt honored.
8. `install.sh tailscale` on an existing loopback install (the retrofit path).
9. `CODEMAN_NONINTERACTIVE=1` re-run => preserves everything, no prompts.
10. macOS (Mac mini `arbbot` box): GUI-app CLI path detection + full flow.
11. Uninstall removes only our 443 mapping, leaves others.
12. Phone check: PWA install + push from the `https://*.ts.net` origin.

## Release

Changeset: `minor` (new documented installer capability + new `CODEMAN_TAILSCALE`
env var). The feature is installer-only, so it ships with zero risk to running
servers; `install.sh update` does not invoke the new flow (updates never rewrite
access config), only fresh installs and the explicit `install.sh tailscale`
subcommand do.
