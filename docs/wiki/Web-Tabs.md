# Web Tabs

Open any dashboard you run, Grafana, Uptime Kuma, Portainer, a status page on port 4000, as
a tab beside your agent sessions. Codeman becomes one mission control instead of Codeman
plus a pile of browser tabs.

A web tab is **not a session**. There is no PTY, no tmux, and no respawn behind it, the same
way a docker case is not a run mode.

## Adding one

1. Click the chevron next to **Run**.
2. Under **Web / URL**, pick **Add URL**.
3. Name it, paste the URL, optionally hit **Test**, and **Save**.

It opens immediately and appears in the dropdown from then on. Web tabs share the tab strip
with sessions, continue the same `Alt+1` to `Alt+9` numbering, and carry a globe icon so
they never read as a running agent.

**Closing a tab is not deleting it.** The tab's `x` closes; the `x` on its **dropdown row**
deletes the saved dashboard. Each dropdown row also has a gear for editing the URL.

Switching tabs does not reload a dashboard. Frames stay alive in the background, so one that
took a while to authenticate is still there when you come back. Past six live frames, the
least recently viewed is dropped to bound memory.

## Single-page apps, reloads and links

A history-routed dashboard (React Router, Vue Router, a Vite dev server) sees the path it
would see on its own origin, not the proxy prefix, so it renders its real route instead of
its own "page not found". A navigation the page starts itself afterwards, a dev server's
full reload or a root-absolute `location.href`, would land outside the proxy with no
capability; Codeman recognises it, answers with a small recovery page, and remounts the
frame at the path that was lost, bounded to five recoveries a minute per frame. A reload on
the dashboard's landing page is recovered the same way.

A `localhost` or `127.0.0.1` link in agent output opens as a web tab automatically, reusing
a saved dashboard for the same server or saving one under its `host:port`. On a phone that
address only exists on the Codeman box, so the link would otherwise be a guaranteed
connection error. LAN and tailnet addresses still open directly. `*.localhost` names are
deliberately not auto-routed: they are DNS names rather than address literals, and the link
came from agent output. Add such a dashboard by hand instead.

## Why dashboards are proxied

A plain cross-origin iframe fails three ways at once in the setup Codeman actually ships in:

| Blocker             | What happens                                                                                  |
| ------------------- | ----------------------------------------------------------------------------------------------- |
| **Mixed content**   | Production is HTTPS, and browsers hard-block `http://` iframes on an HTTPS page. No override, and none at all on iOS Safari. |
| **Framing refusal** | Grafana, Portainer, Home Assistant and many others send `X-Frame-Options: DENY`.                |
| **Codeman's CSP**   | `default-src 'self'` blocks a cross-origin frame before it starts.                              |

So by default the dashboard is served **through Codeman's own origin**: the browser loads a
path on Codeman, and Codeman relays to the dashboard, stripping the framing refusal,
rewriting redirects, cookies and root-absolute URLs, and relaying WebSockets so live panels
still update.

A useful side effect: the dashboard is fetched **by the Codeman server**, so a tailnet-only
or localhost-only dashboard works from any device that can reach Codeman, including a phone
that is not on your tailnet.

There is also a `direct` mode, a plain cross-origin iframe, which is cheaper but only works
for an HTTPS dashboard that permits framing.

## The Test button, and what it does not test

**Test** probes from the server and tells you which mode applies. It verifies
**server-to-upstream reachability and nothing else**. It does not exercise the browser
sandbox, cookies, CORS, CSP, or any reverse proxy in front of Codeman.

A passing Test does not guarantee the embedded page renders.

## The sandbox, and when to turn it off

Because a proxied dashboard is served from Codeman's own address, the browser considers it
same-origin with Codeman. Unchecked, its JavaScript could read the Codeman page and call the
API that spawns agents.

So the frame is sandboxed **without** same-origin access by default. The page runs in an
opaque origin: it cannot touch Codeman, and it gets no cookies or local storage of its own.

Unchecking **Open sandboxed** grants a real origin. Do that only for a dashboard you fully
trust, and only when you need it, which in practice means one with its own login that stores
a session in a cookie.

Either way, Codeman never forwards its own credentials upstream. The `Authorization` header
and the `codeman_session` cookie are stripped on the way out, so `CODEMAN_PASSWORD` cannot
leak into a dashboard.

## Known incompatibility: cookie-authenticated reverse proxies

If Codeman itself sits behind Cloudflare Access, Authelia, oauth2-proxy, or similar, a
**sandboxed** tab may render unstyled or broken while the Codeman page around it works fine.

The reason: an opaque-origin frame's stylesheet, script, and API requests do not carry the
proxy's authentication cookie. The proxy redirects them to the login provider, and CORS or
CSP kills them there.

Trusted mode keeps a real origin and the cookie, so it works. In trusted mode Codeman
forwards the browser's cookies to the dashboard, and that includes the proxy's own session
cookie unless the proxy removes it from what it forwards to Codeman (the Caddy example in
[Multi-User Mode](Multi-User-Mode#single-sign-on-through-a-reverse-proxy) does). Test cannot catch this, because
it checks the server's reach, not the browser's.

## Security notes

The proxy authenticates on an in-memory capability embedded in the path, which is why it is
exempt from the cookie and Origin checks that every API route enforces. That exemption is
fenced to safe methods and non-API paths, and there is a test pinning it in place.

Saved URLs are refused when they point at a link-local or cloud-metadata address, at save
time and again against the address the name resolves to at connect time; loopback and
private ranges stay allowed, because a `localhost` Grafana is the feature. Capabilities are
revoked on logout, and proxied responses carry a same-origin referrer policy so a dashboard
cannot hand the capability-bearing URL to a third party.

Two failure modes that only appear inside a sandboxed frame, and that curl can never
reproduce, are handled: runtime-built root-absolute URLs escaping the injected base, and
same-host requests being CORS-checked with a null origin. Both present as the dashboard's own
"Failed to fetch" while the page itself renders fine.

## Read next

- [The Dashboard](The-Dashboard) - the tab strip these share.
- [Security](Security) - why the sandbox default is what it is.
- [`docs/web-tabs.md`](https://github.com/Ark0N/Codeman/blob/master/docs/web-tabs.md) - the full reference.
