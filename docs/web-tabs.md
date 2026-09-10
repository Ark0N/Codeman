# Web Tabs (dashboards as Codeman tabs)

Open any dashboard you run, Grafana, Uptime Kuma, Portainer, a status page on port
4000, as a tab beside your Claude/Codex/Antigravity sessions. Codeman becomes one mission
control instead of Codeman plus a pile of browser tabs.

## Using it

1. Click the chevron next to **Run** to expand the dropdown.
2. Under **Web / URL**, pick **Add dashboard...**
3. Give it a name and a URL, optionally hit **Test**, then **Save**.

The dashboard opens as a tab immediately, and appears in the Run dropdown from then
on. Web tabs sit in the same strip as session tabs, continue the same `Alt+1..9`
numbering, and carry a globe icon so they never read as a running agent.

Closing a tab (the `x`) only closes it. The saved dashboard stays in the dropdown.
To delete it for good, use the `x` on its **dropdown row** (the tab's own `x` is
close, not delete). Each dropdown row also has a gear for editing, so a saved URL
can be changed or removed without opening it first.

Switching tabs does **not** reload a dashboard. Frames stay alive in the background,
so a dashboard that took a while to authenticate is still there when you come back.
Past six live frames the least-recently-viewed one is dropped to bound memory
(`CODEMAN_MAX_LIVE_WEBVIEW_FRAMES`).

## Why dashboards are proxied

A plain `<iframe src="http://your-box:4000">` does not work in the setup Codeman
actually ships in, for three separate reasons:

| Blocker             | What happens                                                                                   |
| ------------------- | ---------------------------------------------------------------------------------------------- |
| **Mixed content**   | Production serves HTTPS (behind `tailscale serve`). Browsers hard-block `http://` iframes on an HTTPS page, with no override, and none at all on iOS Safari. |
| **Framing refusal** | Grafana, Portainer, Home Assistant and many others send `X-Frame-Options: DENY` or `frame-ancestors 'none'`. |
| **Codeman's CSP**   | `default-src 'self'` means `frame-src` falls back to `'self'`, so a cross-origin iframe is blocked before it starts. |

Serving the dashboard **through Codeman's own origin** dissolves all three. So by
default a web tab loads `/webview/<capability>/` on Codeman, and Codeman relays to
the dashboard: stripping the framing refusal, rewriting redirects, cookies and
root-absolute URLs, and relaying WebSockets so live panels actually update.

A useful consequence: the dashboard is fetched **from the Codeman server**, so a
tailnet-only or `localhost`-only dashboard works from any device that can reach
Codeman, including a phone that is not on the tailnet.

`direct` mode (a plain cross-origin iframe) still exists and is cheaper, but it only
works for an HTTPS dashboard that permits framing. The **Test** button probes from
the server and tells you which mode applies. Note what Test actually verifies:
**server-to-upstream reachability, nothing else**. It does not exercise the browser
sandbox, cookies, CORS, CSP, or any reverse proxy sitting in front of Codeman, so a
passing Test does not guarantee the embedded page will render (see the
cookie-authenticated reverse proxy caveat below).

## Links to `localhost` from another device

An agent prints `http://localhost:5173/` (a dev server, a preview, a report it just
served) and you tap it on your phone. That address only exists on the Codeman box, so
the phone's browser can never load it — but the web-tab proxy fetches from the server,
where it works.

So a **loopback** link (`localhost`, `*.localhost`, `127.0.0.0/8`, `0.0.0.0`, `::1`) clicked
in the terminal or in the Response Viewer opens as a **proxied web tab** whenever the
Codeman page itself is not on that box. A saved proxied dashboard on the same origin is
reused (one tab per dev server, with the link's own path opened inside it); otherwise
one is saved under its `host:port` so it is in the Run dropdown next time. Sandboxed by
default, like any other web tab.

Only loopback is routed this way. A LAN or tailnet address (`192.168.…`, `100.…`,
`box.ts.net`) may well be reachable from the device — a VPN, the same Wi-Fi — and a
direct open is the cheaper, richer path, so those links still open in a new browser tab.
On the box itself (a browser on `localhost`) every link opens directly.

## The sandbox, and when to turn it off

Because a proxied dashboard is served from Codeman's own address, it is
*same-origin with Codeman* as far as the browser is concerned. Left unchecked, its
JavaScript could read the Codeman page and call the API that spawns agents.

So the iframe is sandboxed **without** `allow-same-origin` by default. The page runs
in an opaque origin: it cannot touch Codeman, and it gets no cookies or
`localStorage` of its own.

Unchecking **Open sandboxed** grants `allow-same-origin`. Do that only for a
dashboard you fully trust, and only if you need it, which in practice means a
dashboard with its own login that stores a session in a cookie or `localStorage`.

Even in trusted mode, Codeman never forwards its own credentials upstream: the
`Authorization` header and the `codeman_session` cookie are stripped on the way out,
so `CODEMAN_PASSWORD` cannot leak into a dashboard.

⚠️ **Sandboxed tabs may not work when Codeman itself is behind a
cookie-authenticated reverse proxy** (Cloudflare Access, Authelia, oauth2-proxy and
similar). The sandboxed frame is opaque-origin, so its stylesheet, script, and API
requests do not carry the proxy's authentication cookie; the proxy redirects them to
the login provider, where CORS/CSP kills them, and the embedded app renders
unstyled or broken while the Codeman page around it works fine. Trusted mode
(**Open sandboxed** off) keeps a real origin and the cookie, so it works. The
**Test** button cannot catch this: it checks that the Codeman *server* can reach the
upstream, not that a sandboxed *browser* frame can load assets through the public
authentication layer.

## How the proxy authenticates

A sandboxed iframe is opaque-origin, so every request it makes is cross-site: the
`SameSite=lax` session cookie is not sent, and writes and WebSocket upgrades arrive
with `Origin: null`. Cookie auth cannot work.

Instead, opening a dashboard mints a **capability**: 192 bits of entropy in the URL
path, held in memory only, with a rolling 12-hour TTL, bound to the user who minted
it, and granting exactly one thing, relaying bytes to that one saved URL. Editing or
deleting a dashboard revokes it, and a server restart invalidates every outstanding
capability (tabs re-mint transparently on next click).

## Limits and env vars

| Variable                             | Default | Meaning                                    |
| ------------------------------------ | ------- | ------------------------------------------ |
| `CODEMAN_MAX_WEBVIEWS`               | 50      | Saved dashboards per owner                 |
| `CODEMAN_MAX_LIVE_WEBVIEW_FRAMES`    | 6       | Iframes kept mounted at once               |
| `CODEMAN_WEBVIEW_CAPABILITY_TTL_MS`  | 12h     | Rolling capability lifetime                |
| `CODEMAN_WEBVIEW_TIMEOUT_MS`         | 30000   | Upstream request timeout                   |
| `CODEMAN_WEBVIEW_PROBE_TIMEOUT_MS`   | 8000    | Timeout for the Test button                |
| `CODEMAN_MAX_WEBVIEW_HTML_BYTES`     | 8MB     | Largest HTML document rewritten            |
| `CODEMAN_MAX_WEBVIEW_SOCKETS`        | 8       | Concurrent proxied WebSockets per dashboard |

Saved dashboards live in `~/.codeman/webviews.json`. Which tabs you have open is
per-device (`localStorage`), since that is workspace layout rather than config.

## How a dashboard's own API calls keep working

Worth knowing, because it is where this feature does its least obvious work. Three
layers cooperate so a dashboard talking to its own backend just works:

1. `<base href>` handles relative URLs in the markup.
2. Attribute rewriting handles root-absolute `src`/`href`/`action` in the page the
   proxy serves.
3. A small injected script rebases URLs built at **runtime**, which the first two
   cannot see: `fetch('/api/data')` and `new WebSocket('/live')`, but equally
   `card.innerHTML = '<img src="/api/hero">'`, `img.src = '/api/slide'`, and
   `url(/img.png)` inside a `<style>` the page injects. That second group is why
   images are covered too. A dashboard that renders its thumbnails from script
   would otherwise show all its data and none of its pictures, because `<base>`
   does not apply to root-absolute URLs and the attribute rewriting only ever saw
   the initial document.
4. As a last resort, a request that still lands on Codeman's own root is relayed
   using its `Referer` to identify the dashboard. This only fires for a request
   that already missed every Codeman route, and never for one that resolves to a
   real route, which is what keeps it from being an authentication bypass.
5. The same script **masks the proxy prefix off the page's own URL** before any
   of the page's code runs (`history.replaceState` to the path the page would see
   on its own origin). A single-page app routes on `location.pathname` at boot,
   and `/webview/<cap>/` is a path no app has a route for: without this, a React
   Router / Vue Router / Next dev server painted its HTML and CSS and then replaced
   them with its own "page not found" the moment its script ran. The page only
   *reads* the masked path; every URL it emits still goes through the layers above.
6. A navigation the page starts **itself** after that — `location.reload()` (a dev
   server's full-reload HMR), a root-absolute `location.href = '/login'` — now
   targets Codeman's root with no capability anywhere on it. Codeman recognises
   that request by shape (a top-level `<iframe>` navigation asking for HTML, for a
   path it does not serve) and answers a static page that does nothing but tell
   the owning tab which path was lost; the tab remounts the frame inside the
   prefix at that path. It never counts as a failed login, so a dev server that
   reloads on every save cannot rate-limit its user out of Codeman.

On top of that, the proxy answers those requests with CORS headers. That sounds
wrong for same-host requests, but a sandboxed iframe has an *opaque* origin, so the
browser treats every one of its `fetch`/XHR calls as cross-origin even though the
URL is on Codeman itself. Without those headers, a dashboard renders perfectly and
then every API call fails, which looks like the dashboard being broken.

## Known limits

- **Exotic loaders.** The layers above cover normal `fetch`/XHR/WebSocket/
  EventSource, normal markup, the DOM sinks a page uses to build markup at runtime,
  and `url()` inside stylesheets. Something that constructs requests by an unusual
  route can still slip through. Symptom: the page renders but a panel stays empty.
- **Root-absolute `location` navigation is recovered, not prevented.** `Location`
  is unforgeable, so `location.href = '/login'` or `location.reload()` really does
  leave the prefix; the frame comes back through the recovery hop in layer 6 above,
  which needs a browser that sends `Sec-Fetch-Dest` (every current one; iOS Safari
  since 16.4). Older browsers show Codeman's 404 in the frame; the tab's **Reload**
  button puts it back.
- **Cross-origin redirects are not followed.** If a dashboard bounces to a different
  host (an external SSO provider, say), the proxy hands the redirect back unchanged
  rather than relaying it, because relaying would make this an open proxy. Use
  **Open in new tab** for those.
- **Login-protected dashboards need trusted mode**, since a sandboxed frame has no
  cookie jar. A server-side per-dashboard cookie jar would lift this and is the
  natural next step if it becomes annoying.
- **Cookie-authenticated reverse proxies in front of Codeman break sandboxed tabs**
  (#238). The sandboxed frame's requests carry no auth cookie, so the proxy bounces
  them to its login provider and the app loads broken while Test reports reachable.
  Use trusted mode behind Cloudflare Access and friends; see the warning above.
- **Slow endpoints and the upstream timeout** (#237). The proxy waits
  `CODEMAN_WEBVIEW_TIMEOUT_MS` (default 300s) for the upstream's response *headers*,
  then streams the body without any time bound; a header timeout is logged
  server-side and answered as a 502 that names the limit. WebSocket handshakes use
  the separate `CODEMAN_WEBVIEW_WS_HANDSHAKE_TIMEOUT_MS` (default 30s).
- **Not a security boundary, with one carve-out.** The proxy reaches whatever the
  Codeman server can reach (a `localhost` dashboard is the point), so it is not an
  escalation for someone who already commands `--dangerously-skip-permissions`
  agents, but in multi-user mode it does mean a non-admin user's dashboard is
  fetched from the server's network position. The carve-out: link-local and
  cloud-metadata addresses (`169.254.0.0/16`, `fe80::/10`, `fd00:ec2::254`,
  Azure's `168.63.129.16`, Alibaba's `100.100.100.200`, the
  `metadata.google.internal` alias) are refused at save time AND at connect
  time, judged on the address a name actually resolves to. Nothing anyone embeds
  as a dashboard lives there; an instance's IAM credentials do.
- **The proxy URL is a bearer credential.** `/webview/<cap>/...` needs no cookie,
  so treat it like a password. It is revoked when you log out, when an admin logs
  you out, and when your account is deleted, and it expires after 12 hours
  without use. Proxied responses carry `Referrer-Policy: same-origin`, so a
  dashboard that links to third-party sites does not hand them the URL.

## Where the code lives

| Concern                  | File                                    |
| ------------------------ | --------------------------------------- |
| Pure rewrite helpers     | `src/web/webview-proxy.ts`              |
| Routes + proxy + sockets | `src/web/routes/webview-routes.ts`      |
| Capability tokens        | `src/webview-capabilities.ts`           |
| Persistence              | `src/webview-store.ts`                  |
| Limits                   | `src/config/webview-limits.ts`          |
| Frontend                 | `src/web/public/webview-tabs.js`        |
| Auth exemption           | `src/web/middleware/auth.ts`             |
