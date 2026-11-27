# Multi-User Mode

Share one Codeman with a small trusted team. Each person gets their own login and workspace,
and sessions, cases, search, and live events are scoped to their owner.

**Off by default.** Without the flag, behaviour is identical to single-user Codeman, because
every scoping check short-circuits.

## Read this before enabling it

**Multi-user mode separates workspaces. It does not sandbox users from each other.**

Every session still runs as the **same operating system account**. A determined user's agent
can reach another user's files, because at the OS level they are the same user. This is a
convenience and organization feature, not a security boundary.

If you need real isolation:

- Pair each user with [Docker Cases](Docker-Cases), which gives their work its own
  filesystem and network.
- Or run separate Codeman instances under separate OS accounts, each with its own
  `CODEMAN_INSTANCE`.

"Small trusted team" is the honest description of who this is for.

## Enabling it

```bash
codeman users add alice --admin      # create the first admin, prompts for a password
codeman web --multiuser              # or CODEMAN_MULTIUSER=1
```

Then manage users from the CLI or the **Users** entry in App Settings:

```bash
codeman users add bob                # a regular user
codeman users list
codeman users passwd bob             # reset to a one-time password
codeman users rm bob
```

`--password-stdin` reads the password from standard input, for scripts.

Accounts live in `~/.codeman/users.json` with scrypt-hashed passwords, mode 0600.
Administrative actions are audited to `~/.codeman/admin-audit.jsonl`.

## What each user gets

| Thing               | Scope                                                                        |
| ------------------- | ---------------------------------------------------------------------------- |
| **Case space**      | `~/codeman-users/<name>/cases`, their own.                                    |
| **Sessions**        | Only theirs are listed, reachable, or controllable.                           |
| **Events**          | Live event routing is per owner, and fails closed.                            |
| **Search**          | Scoped on read, including historical results.                                 |
| **File previews**   | Scoped to sessions they own.                                                  |
| **Path picker**     | Only their own user space as a root, not the whole home directory.            |

Admins see everything.

Ownership threads through every list endpoint, the session lookup helper, the WebSocket
layer, and file previews. A user cannot address another user's session even by id.

## Server-wide settings are admin only

There is one set of server settings (`~/.codeman/settings.json`) for everyone: the feature
switches, the run mode, respawn presets, the case order, the Cloudflare tunnel, the default
models. Every user can **read** them, but only an **admin** can change them. For a regular
user the settings write routes answer `403 FORBIDDEN` (see the
[HTTP API](HTTP-API) and [`docs/api-reference.md`](https://github.com/Ark0N/Codeman/blob/master/docs/api-reference.md)).
A regular user reads them without what is the admin's: the Deepgram key an admin saved for
voice dictation, and the admin's case names (case order, last used case).

In the browser this means:

- **App Settings → Save** still keeps a regular user's per-device settings (skin, fonts,
  header buttons, keyboard bar and the rest of the per-device keys) on that device. If they
  also changed a server-wide setting, one notice says it can only be changed by an admin,
  and the setting keeps the server's value.
- A regular user's run-mode pick and respawn presets are their own: kept in that browser
  under their name, not sent to the server, and still theirs on the next visit (over what
  an admin set). Their last used case is not recorded server-wide.
- Reordering cases and switching the tunnel on or off are admin actions.
- If the page could not tell yet who is signed in (a slow or failed sign-in check), the
  server's refusal is read the same way: the same notice, and nothing more is sent.

The operations that act on the whole server are admin actions too: updating Codeman,
opening the multi-display window, regenerating the tunnel QR code (it clears every user's
pending QR login) and cleaning up stale session state. So is the **Opened outside Codeman**
block on the home screens, which shows everyone's processes and opens a shell as the server's
account. **Revoke All** signs a regular user out of their own logins only, and the tunnel
panel lists only their own.

Per-user server settings are not part of this version.

## Safer defaults for regular users

Non-admins get tighter defaults, and lifting them is an explicit per-user grant:

| Default                            | Meaning                                                                  |
| ---------------------------------- | ------------------------------------------------------------------------ |
| Claude runs in `auto` permission mode | Anthropic's classifier-guarded mode instead of skip-prompts.           |
| Raw shell sessions require a grant  | A plain shell is unmediated machine access.                              |
| Skip-permissions requires a grant   | Same reasoning.                                                          |
| Codex **Allow network access** requires a grant | It lets a sandboxed command reach any host, Codeman's own API included. |
| Cron `launchCommand` requires a grant | It is an arbitrary command on a schedule.                              |
| Pi project trust defaults to off    | Trust makes Pi execute repo-local TypeScript.                            |

These exist because the OS boundary is shared. They narrow what a normal account can do
casually; they do not make the account a sandbox.

## Accounts and sessions

Each user authenticates with their own name and password rather than the shared
`CODEMAN_PASSWORD`. Logins are individually revocable: disable, reset, or delete an account
at any time, and existing browser sessions can be revoked. A person who signs in through a
reverse proxy (next section) uses no Codeman password and holds no browser session, so a
password reset or a logout does not end their access: disable or delete the account.

## Single sign-on through a reverse proxy

Instead of Codeman passwords, people can sign in through your identity provider (Entra ID,
Google Workspace, Keycloak, Okta, ...). An authenticating reverse proxy on the same host
does the sign-in and tells Codeman who the person is. Codeman still decides who has an
account: the username must name an existing, enabled user, or the request gets `403`.

**Experimental.** The settings, the two headers and the `viaTrustedProxy` field of
`GET /api/me` may still change (see
[`docs/versioning-policy.md`](https://github.com/Ark0N/Codeman/blob/master/docs/versioning-policy.md)).

"Trusted proxy" here means only this sign-in. It does not make Codeman read
`X-Forwarded-For` or any other forwarded address: the client address stays the address of
the socket, which behind the proxy is `127.0.0.1`.

```
browser --HTTPS--> Caddy --forward_auth--> oauth2-proxy (127.0.0.1:4180) --> identity provider
                     \--reverse_proxy--> Codeman (127.0.0.1:3000, multi-user mode)
```

On every request the proxy adds two headers:

| Header | Value |
|---|---|
| `X-Codeman-Proxy-Secret` | the shared secret |
| `X-Codeman-User` | the Codeman username (another name can be set with `CODEMAN_TRUSTED_PROXY_USER_HEADER`: an `X-…` header such as `X-Forwarded-User`, or `Remote-User`; standard and reserved headers are refused, because the header is removed from every request) |

Codeman believes them only from a loopback connection with the matching secret, so keep
Codeman bound to `127.0.0.1` and the proxy on the same host. It removes both headers from
every request before anything else sees them. The exact rules are in
[`docs/security-architecture.md` §10a](https://github.com/Ark0N/Codeman/blob/master/docs/security-architecture.md).

The secret keeps other local processes from claiming an identity. It does not protect
against anything that runs as Codeman's own OS account, which includes every agent session:
such a process can read the secret and sign in as anyone, an admin included, over loopback.
That is the same exposure as editing `users.json`, which the same account can also do (see
[Read this before enabling it](#read-this-before-enabling-it)).

### Codeman

```bash
install -m 600 /dev/null ~/.codeman/proxy-secret
openssl rand -hex 32 > ~/.codeman/proxy-secret   # the shared secret, also given to the proxy
codeman users add alice --admin                  # accounts still come from Codeman
CODEMAN_MULTIUSER=1 \
CODEMAN_ALLOWED_HOSTS=codeman.example.com \
CODEMAN_TRUSTED_PROXY_SECRET_FILE=~/.codeman/proxy-secret \
codeman web                                      # stays on 127.0.0.1:3000
```

The startup log says `Trusted-proxy sign-in enabled (experimental)`. A setup that cannot be
used stops the start, with a message that says why:

- the secret file cannot be read, is empty, or can be read by group or others (`chmod 600`
  it; the mode is not checked on Windows);
- the secret is shorter than 32 characters or not printable ASCII;
- both `CODEMAN_TRUSTED_PROXY_SECRET_FILE` and `CODEMAN_TRUSTED_PROXY_SECRET` are set;
- a secret is set without multi-user mode;
- `CODEMAN_TRUSTED_PROXY_USER_HEADER` names a header that is not allowed.

In a systemd unit, give the file as an absolute path (systemd does not expand `~`; `%h`
works in a user unit; in a system unit write the full path). Codeman's downloads and
attachments refuse the configured secret file.

`CODEMAN_TRUSTED_PROXY_SECRET` (the value itself) works too. Codeman reads the settings
once and removes both variables from its environment, so sessions started later don't
inherit them. That is all it does: the value stays visible in `/proc/<pid>/environ` for as
long as the server runs, and a tmux server started earlier with it set keeps its own copy
until restarted. Prefer the file.

Password sign-in stays available for requests that reach Codeman without the proxy.
Codeman's own tools need it: `codeman agent`, `mcp`, `notify`, `attach` and `tui` and the
Codeman skill sign in on loopback with `CODEMAN_USERNAME` / `CODEMAN_PASSWORD`. Such a
request is not checked by the identity provider, so its MFA does not apply to it. For a
person who only ever signs in through the proxy, create the account without a password:
Codeman generates a random one-time password, which you can discard. The account then
keeps its `must-change-pw` label in the Admin Panel; the label has no effect on proxy
sign-ins.

### oauth2-proxy

Register an OIDC app with your identity provider (redirect URI
`https://codeman.example.com/oauth2/callback`) and restrict it to the people who should
get in. A minimal `oauth2-proxy.cfg`:

```toml
http_address = "127.0.0.1:4180"
reverse_proxy = true
provider = "oidc"
oidc_issuer_url = "https://login.microsoftonline.com/<tenant-id>/v2.0"   # your provider
redirect_url = "https://codeman.example.com/oauth2/callback"
whitelist_domains = ["codeman.example.com"]
email_domains = ["example.com"]
set_xauthrequest = true          # return the identity as X-Auth-Request-* headers
skip_provider_button = true
upstreams = ["static://202"]     # forward_auth only, nothing to proxy
cookie_secure = true
cookie_samesite = "lax"          # never sent from a sandboxed web-tab frame
cookie_expire = "12h"            # sign in again after this (default 168h)
cookie_refresh = "1h"            # re-check with the provider this often
cookie_csrf_per_request = true   # one CSRF cookie per sign-in, so parallel ones don't collide
cookie_csrf_per_request_limit = 5
scope = "openid email profile offline_access"   # offline_access: a refresh token (Entra ID)
```

Client ID, client secret and cookie secret go in the environment
(`OAUTH2_PROXY_CLIENT_ID`, `OAUTH2_PROXY_CLIENT_SECRET`, `OAUTH2_PROXY_COOKIE_SECRET`).
For Entra ID add `oidc_email_claim = "preferred_username"`. Without `cookie_refresh`, a
person disabled at the provider keeps access until the cookie expires. `cookie_refresh`
needs a refresh token: without one (for Entra ID, without `offline_access` in the scope),
oauth2-proxy can't refresh, and people are sent back through sign-in whenever the ID token
expires, about hourly.

Set `cookie_samesite`. oauth2-proxy puts no `SameSite` attribute on its cookie unless it is
configured, and browsers disagree about a cookie without one. With `lax`, a sandboxed
web-tab frame does not send the proxy's cookie in any browser.

The username Codeman gets is only as trustworthy as the claim it comes from:

- **Register the app as single-tenant.** The proxy trusts values that the administrators
  of the signing-in person's tenant control, so only your own tenant may sign in.
- **`email` and `preferred_username` are mutable.** An administrator can change them, and
  an address can be given to another person later. That person then gets the Codeman
  account the address maps to, until you remove its row from the `map` below. Go through
  the table when people leave or are renamed.

### Caddy

Give Caddy the same secret through its environment, not in the Caddyfile (which is often
world-readable): for the packaged service, a systemd drop-in with
`EnvironmentFile=/etc/caddy/codeman-proxy.env` (mode 0600) containing
`CODEMAN_TRUSTED_PROXY_SECRET=<secret>`. Keep the `{env.…}` placeholder below; a `{$…}`
placeholder would put the value into the adapted config, which local processes can read
from Caddy's admin port.

```caddyfile
codeman.example.com {
	# Signed-in identity -> Codeman username (case-sensitive: use the spelling your
	# provider returns). Unlisted people get an empty username and are refused below.
	map {http.request.header.X-Auth-Request-Email} {codeman_user} {
		alice@example.com alice
		default ""
	}

	# Hooks call 127.0.0.1:3000 directly; never expose them (or their /api/v1 aliases).
	@hooks path /api/hook-event /api/status-telemetry /api/v1/hook-event /api/v1/status-telemetry
	# Web tabs and rendered HTML files authenticate by the capability in their URL: their
	# sandboxed frames send no cookies, so they can't pass the sign-in below.
	@capability path /webview/* /html-view/*

	# `route` keeps the order as written. Without it Caddy sorts directives itself, and
	# `handle` would run before `respond`, or forward_auth before request_header.
	route {
		respond @hooks 403

		handle /oauth2/* {
			reverse_proxy 127.0.0.1:4180 {
				header_up X-Real-IP {remote_host}
				header_up X-Forwarded-Uri {uri}
			}
		}

		handle @capability {
			# No sign-in and no secret: Codeman checks the capability itself. No password
			# either: these paths must never reach Codeman's password check or prompt.
			request_header -X-Codeman-Proxy-Secret
			request_header -X-Codeman-User
			request_header -Authorization
			# oauth2-proxy's cookie is a sign-in for this whole site. Codeman never needs
			# it, and its web-tab relay forwards browser cookies to a dashboard opened in
			# trusted mode.
			request_header Cookie "(^|;\s*)_oauth2_proxy[^=;]*=[^;]*" ""
			reverse_proxy 127.0.0.1:3000 {
				header_down -WWW-Authenticate
			}
		}

		handle {
			route {
				# Only oauth2-proxy and this file may set identity headers.
				request_header -X-Auth-Request-Email
				request_header -X-Codeman-Proxy-Secret
				request_header -X-Codeman-User

				forward_auth 127.0.0.1:4180 {
					uri /oauth2/auth
					copy_headers X-Auth-Request-Email
					@unauthenticated status 401
					handle_response @unauthenticated {
						# Only a page navigation can complete a sign-in. A background request
						# (fetch, the live-update stream, a WebSocket) gets a 401. A client
						# that sends no Sec-Fetch-Mode header is still redirected.
						@background {
							header Sec-Fetch-Mode *
							not header Sec-Fetch-Mode navigate
						}
						route {
							respond @background "Sign-in required" 401
							redir * /oauth2/start?rd={scheme}://{hostport}{uri}
						}
					}
				}

				@nouser vars {codeman_user} ""
				respond @nouser "No Codeman account for this sign-in" 403

				# After forward_auth, which needs it: remove oauth2-proxy's cookie.
				request_header Cookie "(^|;\s*)_oauth2_proxy[^=;]*=[^;]*" ""

				reverse_proxy 127.0.0.1:3000 {
					header_up X-Codeman-Proxy-Secret {env.CODEMAN_TRUSTED_PROXY_SECRET}
					header_up X-Codeman-User {codeman_user}
					# Codeman needs only the two headers above.
					header_up -X-Auth-Request-Email
				}
			}
		}
	}
}
```

This example was run with Caddy 2.11.9 and oauth2-proxy 7.15.6. What it relies on, because
Codeman cannot see a mistake here:

- **The proxy removes what the client sent.** The `request_header -…` lines delete any
  copy of the identity headers that arrived from outside, and `header_up` replaces a
  header, it never appends. The username therefore only ever comes from the sign-in result.
- **The secret is added only behind the sign-in**, never on the `/webview/*` and
  `/html-view/*` route.
- **The proxy's own cookie stops at the proxy.** The `request_header Cookie …` lines remove
  it on both routes. With a different `cookie_name` in oauth2-proxy, change the name in
  the pattern.
- **A background request is not sent to the sign-in.** A request with a `Sec-Fetch-Mode`
  other than `navigate` gets a `401`. Page navigations are redirected as before, and so
  are clients that send no such header (command-line tools, old browsers). Without that
  rule an open Codeman page whose proxy session has ended starts a sign-in with every
  background request that follows the redirect, which `fetch()` and the live-update stream
  do. Each one replaces oauth2-proxy's CSRF cookie, and the person's real sign-in then
  ends on oauth2-proxy's error page ("CSRF token mismatch"). `cookie_csrf_per_request`
  covers the remaining case of several tabs signing in at once.
- **oauth2-proxy's identity headers stop at the proxy too.** `header_up -X-Auth-Request-Email`
  removes the address on the way to Codeman, because the web-tab relay passes headers it
  does not know on to dashboards.

Check the order Caddy will actually use with
`caddy adapt --config Caddyfile --adapter caddyfile` before going live. With
`CODEMAN_BASE_URL` (a sub-path mount), prefix the paths in `@hooks` and `@capability`.

To check that a forged header is ignored, run this in the browser console of the signed-in
page. It must show your own username:

```js
fetch('/api/me', { headers: { 'X-Codeman-User': 'someone-else' } }).then((r) => r.json()).then(console.log)
```

### Taking the username from the identity provider instead

The `map` is a list you maintain. If your provider can put the Codeman username into the
ID token (for example the AD logon name: Entra ID can add it with a claims mapping policy
that emits `user.onpremisessamaccountname` as a custom claim; the app then needs
`acceptMappedClaims` enabled, which belongs only on a single-tenant app registration), let
oauth2-proxy return that claim as a header. That needs
oauth2-proxy 7.15.5 or later with its alpha config (`--alpha-config`), and the claim must
be listed in the provider's `additionalClaims`, otherwise the header stays empty:

```yaml
providers:
  - id: idp
    provider: oidc
    # ... clientID, clientSecretFile, oidcConfig ...
    additionalClaims:
      - samaccountname
injectResponseHeaders:
  - name: X-Auth-Request-Codeman-User
    values:
      - claimSource:
          claim: samaccountname
```

In the Caddyfile, drop the `map` and replace the inner `route` of the last `handle`:

```caddyfile
route {
	request_header -X-Auth-Request-Email
	request_header -X-Auth-Request-Codeman-User
	request_header -X-Codeman-Proxy-Secret
	request_header -X-Codeman-User

	forward_auth 127.0.0.1:4180 {
		uri /oauth2/auth
		copy_headers X-Auth-Request-Email X-Auth-Request-Codeman-User
		@unauthenticated status 401
		handle_response @unauthenticated {
			@background {
				header Sec-Fetch-Mode *
				not header Sec-Fetch-Mode navigate
			}
			route {
				respond @background "Sign-in required" 401
				redir * /oauth2/start?rd={scheme}://{hostport}{uri}
			}
		}
	}

	@nouser vars {http.request.header.X-Auth-Request-Codeman-User} ""
	respond @nouser "No Codeman username for this sign-in" 403

	request_header Cookie "(^|;\s*)_oauth2_proxy[^=;]*=[^;]*" ""

	reverse_proxy 127.0.0.1:3000 {
		header_up X-Codeman-Proxy-Secret {env.CODEMAN_TRUSTED_PROXY_SECRET}
		header_up X-Codeman-User {http.request.header.X-Auth-Request-Codeman-User}
		header_up -X-Auth-Request-Email
		header_up -X-Auth-Request-Codeman-User
	}
}
```

Adding a person is then: allow them at the identity provider, and
`codeman users add <name>`. Codeman usernames allow letters, digits, `_` and `-` only, so
the claim must fit that. A logon name with a dot (`jane.doe`) does not: for such accounts
keep the `map`. A browser that signed in before the claim existed needs to sign
out (`/oauth2/sign_out`) and in again.

### Things to know

- **No Codeman cookie is issued** for proxy sign-ins. The proxy authorizes every new
  request and WebSocket upgrade, but a terminal or live-update connection that is already
  open stays open until it disconnects.
- **Cutting someone off:** disable their Codeman account (new requests are refused), then
  use **Logout** for them in the Admin Panel, which also revokes the web-tab and HTML-view
  links they opened (disabling alone doesn't, and those links don't need the proxy's
  sign-in). Deleting the account does both. Logout alone, or a password reset, does not
  cut off a proxy sign-in: it holds no cookie and uses no password, so the next request
  signs the person in again. Connections already open stay open until they disconnect.
- **Web tabs and HTML view behind the proxy:** with trusted-proxy sign-in configured, a
  path under those prefixes without a live capability, malformed ones included, is refused
  (`403` / `404`) without a password check,
  prompt or failure count, so anonymous requests can't probe passwords or lock out the
  password sign-in.
- **When the proxy session expires**, API calls and the live-update stream get the proxy's
  `401`. An open Codeman page then shows "No connection to the Codeman server" and does
  not recover by itself: reload it to sign in again. The `rd=` return address is not
  URL-encoded, so a query string with `&` loses everything after the first one.
- **`mustChangePassword` is ignored** for proxy sign-ins, since no Codeman password was
  used, and `GET /api/me` reports it as `false` for them. A person's own "Revoke all" and logout end Codeman cookies, not the proxy's
  session; sign out of the proxy at `/oauth2/sign_out`.
- **A wrong or empty secret is refused outright** (and failures are rate-limited per IP);
  it never falls back to the cookie or password sign-in.
- **Sandboxed web tabs:** a request the dashboard makes outside its
  `/webview/<capability>/` prefix (a root-absolute asset the rewriting missed, or a page
  that reloads itself) goes through the proxy's sign-in, carries no cookie and fails
  there. Codeman's `Referer` relay and lost-frame recovery never see it. Dashboards that
  use relative URLs work; for the others use trusted mode or a new browser tab.
- **Trusted web tabs** forward the browser's cookies to their dashboard. The proxy's
  sign-in cookie would be among them, which is why the Caddy example removes it.
- **Docker Compose installs** can't use this: the proxy on the host reaches the container
  from the bridge address, not loopback.
- **Audit log:** admin actions through the proxy are recorded with IP `127.0.0.1`.

## Gotchas

- **Enabling it does not migrate existing cases** into a user space. They stay where they
  are, owned by whoever the ownership rules resolve them to.
- **Admins see everything**, including other users' sessions. Choose admins accordingly.
- **The audit log is append-only and local.** Ship it somewhere if you care about it.
- **It is not a substitute for OS accounts.** Restating this because it is the one thing
  people get wrong.

## Read next

- [Security](Security) - where this fits in the model, and what it does not cover.
- [Docker Cases](Docker-Cases) - the isolation story that actually isolates.
- [`docs/multi-user-plan.md`](https://github.com/Ark0N/Codeman/blob/master/docs/multi-user-plan.md) - the design.
