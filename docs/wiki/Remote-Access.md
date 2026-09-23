# Remote Access

Reaching your Codeman from a phone, a laptop on the other side of the house, or a hotel
network. This is the page to read carefully, because Codeman's dashboard is a
remote-code-execution surface by design: it starts agents with permission prompts skipped,
so whoever can reach it can run code on your machine.

## Start from the default

`codeman web` binds `127.0.0.1`. It is reachable from the machine running it and nothing
else, which is why the no-password default is safe out of the box. Every option below is a
deliberate step away from that.

Two rules that make the rest of this page simple:

1. **Never expose Codeman on a network without `CODEMAN_PASSWORD`.** Binding a non-loopback
   host without one starts, but prints a loud warning with the fixes.
2. **Prefer keeping the loopback bind** and putting an authenticated tunnel in front of it,
   over binding wide and relying on a password alone.

## Pick an approach

| Approach              | Good for                                              | Cost                                                      |
| --------------------- | ----------------------------------------------------- | --------------------------------------------------------- |
| **Tailscale**         | Phone access, permanently. The recommended setup.      | Install Tailscale on both devices.                         |
| **Cloudflare tunnel** | A public URL, quickly, from anywhere.                  | Public URL, so a password is mandatory.                    |
| **LAN + password**    | Home network only, no extra software.                  | Every device on your LAN can reach the login page.         |
| **SSH port forward**  | You already SSH to the box.                            | Manual, per session, terminal-bound.                       |

## Tailscale (recommended)

Your devices join a private network, and Codeman stays bound to loopback. Nothing is
published to the internet, and you get real HTTPS with a real certificate.

The installer sets this up for you, including installing Tailscale, logging in, enabling
tailnet HTTPS, and verifying the result end to end. It ends on the URL with a QR code to
scan. To retrofit it onto an existing install, or to see the URL and QR code again:

```bash
install.sh tailscale
install.sh status
```

By hand:

```bash
tailscale serve --bg 3000
tailscale serve status
```

Then open `https://<machine>.<tailnet>.ts.net` from any device on your tailnet.

### The name in the URL

The URL is the machine's MagicDNS name, so on a machine called `tnode` it is
`https://tnode.<tailnet>.ts.net`. Three ways to influence that, from least to most work:

| You want                                   | How                                                                                                   |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| The machine's existing name (default)      | Nothing. This is what the installer does unless you say otherwise.                                     |
| `https://codeman-<hostname>.<tailnet>.ts.net` | Answer yes to the installer's name question, pass `--name codeman-<hostname>`, or run `install.sh name`. This renames the machine tailnet-wide (SSH included), which is why the installer defaults to no. `install.sh uninstall` offers to rename it back. |
| `https://codeman.<tailnet>.ts.net`         | A [Tailscale Service](https://tailscale.com/docs/features/tailscale-services). Only a **tagged** node can host one (a device signed in with a user account cannot), the service is defined and approved in the admin console, and the feature is in beta. The installer does not set this up; it is a `tailscale serve --service=svc:codeman --https=443 127.0.0.1:3000` on a tagged host once the service exists. |

If `:443` on your node already belongs to another app, the installer offers Codeman under
`https://<machine>.<tailnet>.ts.net/codeman` (the default, via `tailscale serve --set-path`
plus Codeman's `--base-url`), on a second port (`https://<machine>.<tailnet>.ts.net:8443`),
or replacing the other mapping. It never replaces anything without asking.

Notes:

- Keep the loopback bind. `tailscale serve` connects to `127.0.0.1:3000` locally, so
  binding wider adds exposure and buys nothing.
- Your tailnet is the authentication boundary. Setting `CODEMAN_PASSWORD` as well is
  reasonable defence in depth, especially if other people have devices on your tailnet.
- Codeman's Host-header allowlist already accepts `.ts.net`, so no extra configuration is
  needed.
- The installer never resets or rewrites `serve` mappings other than the one pointing at
  Codeman's port, so unrelated serve configuration is left alone. It also never opens a
  `tailscale funnel` (that is the public internet) and never advertises a Tailscale Service.
- On macOS, the App Store and standalone Tailscale apps only run once someone is logged in,
  so a headless Mac needs the open-source `tailscaled` for the URL to come back after a
  reboot on its own.

## Cloudflare tunnel

A free [quick tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/do-more-with-tunnels/trycloudflare/)
gives you a public HTTPS URL with no port forwarding, no DNS, and no static IP:

```
Browser → Cloudflare edge (HTTPS) → cloudflared → localhost:3000
```

Prerequisites: [`cloudflared`](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/)
installed, and `CODEMAN_PASSWORD` set.

```bash
./scripts/tunnel.sh start     # starts the tunnel, prints the public URL
./scripts/tunnel.sh url
./scripts/tunnel.sh status
./scripts/tunnel.sh stop
```

The quick-tunnel URL is a random `*.trycloudflare.com` address that changes every time the
tunnel restarts. For a stable hostname, `./scripts/tunnel.sh named setup` walks through a
named tunnel.

To survive reboots:

```bash
systemctl --user enable codeman-tunnel
loginctl enable-linger $USER
```

There is also a toggle in **App Settings → System → Remote access**.

**The tunnel refuses to start without a password.** That is on purpose: a public URL with no
authentication is a terminal on your machine handed to the internet. Acknowledging the risk
explicitly is possible from the UI toggle, and only from there; the API will not do it for
you.

## LAN plus password

```bash
export CODEMAN_PASSWORD='something long'
codeman web -H 0.0.0.0 --https
```

Every device on your local network can now reach the login page. `--https` generates a
self-signed certificate into `~/.codeman/certs/`, which your browser will warn about once.

`CODEMAN_USERNAME` defaults to `admin`.

The installer offers this path and prompts for the password. On re-runs it preserves
whichever binding you already chose.

## SSH port forward

No configuration at all, if you already have SSH access:

```bash
ssh -L 3000:localhost:3000 you@your-box
```

Then open `http://localhost:3000` on the local machine. Codeman keeps its loopback bind and
sees a local connection. Good for occasional access, awkward as a permanent arrangement
because it dies with the SSH session.

## Logging in from a phone

Typing a long password on a phone keyboard is miserable, so Codeman issues **single-use QR
tokens**. The desktop dashboard shows a QR code; scan it and the phone is authenticated.

How it behaves:

- The code rotates every 60 seconds, with a 90 second grace window so scanning during a
  rotation still works.
- Each token is **single use**. The moment a phone consumes it, a new one is generated.
- The URL contains a 6-character lookup code, not the secret, so it does not leak through
  browser history, `Referer` headers, or the tunnel provider's logs.
- The desktop shows a toast naming the device and browser that just authenticated, with a
  one-click revoke.
- QR attempts are rate limited separately from password attempts, so a mistyped password
  cannot lock out your QR login and vice versa.

Someone holding only the tunnel URL still meets the normal password prompt. The QR is the
fast path, not a bypass.

Design detail and the threat analysis it is built against:
[`docs/qr-auth-plan.md`](https://github.com/Ark0N/Codeman/blob/master/docs/qr-auth-plan.md).

## Behind a reverse proxy

Codeman enforces a Host-header allowlist on every request to block DNS rebinding, and the
same allowlist gates the cross-site Origin check. It accepts `localhost`, IP literals, the
bind host, `.ts.net`, `.trycloudflare.com`, `.cfargotunnel.com`, and the active managed
tunnel.

**Your own domain is not on that list.** Add it:

```bash
CODEMAN_ALLOWED_HOSTS='codeman.example.com,.internal.example.com'
```

A bare entry matches that exact host; a leading dot matches subdomains. Without this, a
correctly configured proxy still gets `403 host not allowed`, which reads like a proxy bug
and is not one.

Also make sure the proxy forwards WebSocket upgrades. The terminal is a WebSocket, and the
upgrade runs the same Host and Origin checks, closing with code `4003` on failure.

### Mounting under a sub-path

By default Codeman assumes it is served at the origin root (`/`). To mount it under a
sub-path — e.g. `https://example.com/codeman/` — start it with `--base-url` (or the
`CODEMAN_BASE_URL` env var):

```bash
codeman web --base-url /codeman
# or
CODEMAN_BASE_URL=/codeman codeman web
```

The value is a plain path prefix; `/` (the default) means "mounted at the root". With a
prefix set, Codeman emits every URL — the HTML shell and its assets, API/SSE/WebSocket
calls, redirects, the PWA manifest and the service worker — under that prefix, so a browser
loading `https://example.com/codeman/` stays inside the mount.

**Forward the prefix unchanged — do NOT strip it.** Codeman expects the proxy to pass the
full path (including `/codeman/`) straight through. A minimal nginx block:

```nginx
location /codeman/ {
    proxy_pass         http://127.0.0.1:3000;   # note: no trailing slash — keep the /codeman/ prefix
    proxy_http_version 1.1;
    proxy_set_header   Host              $host;
    proxy_set_header   Upgrade           $http_upgrade;   # WebSocket
    proxy_set_header   Connection        "upgrade";
}
```

Notes and current limits:

- The prefix must still be paired with `CODEMAN_ALLOWED_HOSTS` for your domain, exactly as
  above — the two are independent.
- Health checks, Claude Code hooks and the docker bridge connect to the raw port directly
  (bypassing the proxy), so Codeman also keeps answering at the un-prefixed paths on the port
  itself. Nothing about those flows changes.
- **Web-tab (dashboard) proxying** is base-path aware: proxied dashboards have their injected
  `<base>` tag, root-absolute asset rewrites, runtime `fetch`/XHR shim, `Set-Cookie` paths, and
  redirects all rebased onto the mount, so they load the same under `--base-url` as at the root.

## Session cookies and rate limits

The first request prompts for HTTP Basic credentials. On success the server issues an opaque
`codeman_session` cookie (24 hour lifetime, extended on activity, validated server-side so
it cannot be forged offline). Ten failed attempts from one IP produce a `429` with a 15
minute decay.

A valid cookie or a correct password recovers immediately even while an attacker is hammering
the same IP, which matters because all tunnel traffic arrives from one loopback address.

## Terminal alternatives

You do not have to use a browser. `codeman tui` is a full-screen session dashboard that
works well in SSH clients like Termius or Blink:

```bash
codeman tui           # the dashboard
codeman tui 2         # attach straight to session 2
codeman tui --list    # numbered list, then exit
```

`Enter` attaches into the pane and `F1` comes back. Under 72 columns it drops the preview
and becomes a single-column list, so it stays usable on a phone. The sessions are the same
ones the dashboard shows. See [docs/tui.md](https://github.com/Ark0N/Codeman/blob/master/docs/tui.md)
for the full guide.

## Common problems

| Symptom                                                     | Cause and fix                                                                                          |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `403 host not allowed`                                       | Your domain is not in the allowlist. Set `CODEMAN_ALLOWED_HOSTS`.                                       |
| Assets 404 / blank page under a sub-path                     | Start Codeman with `--base-url /<prefix>` and have the proxy forward the prefix unchanged (don't strip it). |
| Phone shows the login page but the terminal never connects   | The proxy is not forwarding WebSocket upgrades.                                                         |
| Browser warns about the certificate                          | Expected with `--https` and its self-signed certificate. Tailscale gives you a real one instead.        |
| LAN IP does not respond, but a tunnel to the same box works  | The server is bound to loopback. That is the default. A tunnel reaches it; a LAN browser cannot.        |
| Hooks stopped working after switching to HTTPS               | Hook callbacks need `-k` for the self-signed certificate. Recent versions self-heal existing cases; if yours predates that, recreate the case's hooks. |
| Everything is slow over the tunnel                           | Quick tunnels route through Cloudflare's edge. Tailscale is usually a direct connection and much faster. |

## Read next

- [Security](Security) - the whole model, and the hardening checklist.
- [Mobile Guide](Mobile-Guide) - once you can reach it from the phone.
- [Running As A Service](Running-As-A-Service) - keeping server and tunnel up across reboots.
- [`docs/security-architecture.md`](https://github.com/Ark0N/Codeman/blob/master/docs/security-architecture.md) - the full model.
