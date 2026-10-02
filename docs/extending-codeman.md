# Extending Codeman

Codeman has no plugin runtime, and that is a deliberate choice rather than a
missing feature. A plugin runtime means running third-party code inside a process
that spawns agents with your credentials, on a server people routinely expose
over a tunnel or Tailscale. Codeman's security model is one of its reasons to
exist, so it does not hand that away for an extension mechanism.

Instead there are four seams that already work, from any language, with nothing
installed:

| You want to | Use | Runs where |
| --- | --- | --- |
| Show your own UI inside Codeman | [Web tabs](#seam-1-web-tabs) | Your own process, rendered as a tab |
| React when an agent needs you | [SSE events](#seam-2-sse-events) | Anywhere that can hold an HTTP connection |
| Drive Codeman from a script | [HTTP API](#seam-3-http-api-and-cli) or the `codeman` CLI | Anywhere |
| React inside a Claude session | [Hooks](#seam-4-hooks) | The agent's own machine |

Everything below is covered by the stability promise in
[`versioning-policy.md`](versioning-policy.md): endpoint paths, the response
envelope, `errorCode` values, and SSE event names are stable. Additive changes
(new endpoints, new optional fields, new events) are non-breaking. Breaking
changes ship under a new prefix (`/api/v2`).

## Before you start

**Base URL.** `http://127.0.0.1:3000` by default. Prefer the versioned prefix
`/api/v1/...` for anything you publish; the unversioned `/api/...` is an alias.

**Auth.** If `CODEMAN_PASSWORD` is set, send HTTP Basic on every request, or
authenticate once and keep the `codeman_session` cookie. With no password set,
Codeman is loopback-only and unauthenticated.

```bash
curl -u admin:$CODEMAN_PASSWORD http://127.0.0.1:3000/api/v1/sessions
```

**Envelope.** Every response is `{"success": true, "data": ...}` or
`{"success": false, "error": "...", "errorCode": "..."}`. Check the HTTP status
or `body.success`, then read `body.data`. The full `errorCode` to status mapping
is in [`api-reference.md`](api-reference.md).

⚠️ A few legacy GETs (`/api/away-digest` among them) return a bare-ish body with
the payload at the top level rather than under `data`. Read defensively with
`body.data ?? body`.

⚠️ A `401` is not an envelope at all: auth is rejected in a request hook that
replies with the bare string `Unauthorized`, so parsing it as JSON throws. Branch on
the status code before you parse, or a missing password looks like a broken endpoint.

**Already driving Codeman from an agent?** The README's
[Programmatic Guide](../README.md#driving-codeman-from-an-agent--programmatic-guide)
covers the in-session case: the `CODEMAN_MUX`, `CODEMAN_API_URL`,
`CODEMAN_SESSION_ID` and `CODEMAN_HOOK_SECRET_FILE` variables that let a CLI
running inside Codeman find the API and avoid acting on itself. This page is for
code running *outside* a session.

## Seam 1: Web tabs

The highest-leverage seam. Any web app you can serve locally becomes a tab beside
your agent sessions. You write a normal web page; Codeman handles embedding it.

```bash
curl -u admin:$PASS -X POST http://127.0.0.1:3000/api/v1/webviews \
  -H 'Content-Type: application/json' \
  -d '{"name":"My Dashboard","url":"http://127.0.0.1:8787","icon":"📊"}'
```

Fields: `name` (1 to 60 chars), `url`, and optionally `icon` (a single glyph, max
8 code units), `embedMode` (`proxy` by default, or `direct`), and `trusted`.

Related endpoints: `GET /api/v1/webviews`, `PATCH /api/v1/webviews/:id`,
`DELETE /api/v1/webviews/:id`, `POST /api/v1/webviews/probe` (reachability and
framing check), `POST /api/v1/webviews/:id/open`.

### Why it is proxied

By default your page is served through Codeman's own origin at `/webview/:cap/*`
rather than framed directly. A direct iframe fails three ways at once: production
is HTTPS so `http://` targets are blocked as mixed content, many dashboards send
`X-Frame-Options: DENY`, and Codeman's own `default-src 'self'` CSP blocks
cross-origin frames. Proxying solves all three without weakening the CSP.

### The two things that will confuse you

A proxied frame is sandboxed and therefore **opaque-origin** unless you set
`trusted: true`. Two consequences look like bugs in your own app:

1. **Root-absolute URLs built at runtime** (`/assets/x.png` assembled in JS)
   escape the injected `<base>` tag. Codeman injects a `runtimeUrlShim()` that
   patches the common DOM sinks, but if you construct URLs in an unusual way,
   prefer relative paths.
2. **Same-host `fetch` and `XHR` are CORS-checked with `Origin: null`.** Codeman
   handles this with `buildProxyCorsHeaders()`, and the proxy is exempt from the
   global `OPTIONS` short-circuit. If you see "Failed to fetch" while the page
   itself renders fine, this is the area to look at.

⚠️ `trusted: true` opts out of the sandbox. A proxied page is served from
Codeman's origin, so `allow-same-origin` lets it read the Codeman page and call
the API that spawns agents. Only mark your own trusted code.

## Seam 2: SSE events

`GET /api/v1/events` is a Server-Sent Events stream. Each message is
`event: <name>` plus `data: <json>`. There are 149 event names following a
`domain:action` convention, registered in `src/web/sse-events.ts`.

The ones most integrations want:

| Event | Meaning |
| --- | --- |
| `session:created`, `session:deleted` | A session appeared or went away |
| `session:idle` | The agent stopped working |
| `session:completion` | A completion message was detected |
| `session:exit`, `session:error` | The session ended or failed |
| `hook:permission_prompt` | The agent is asking for permission |
| `hook:idle_prompt`, `hook:stop` | The agent is waiting on you, or stopped |
| `hook:task_completed`, `task:completed` | Work finished |
| `subagent:discovered`, `subagent:completed` | Background agent lifecycle |
| `mux:died` | A multiplexer session died unexpectedly |
| `cron:runCreated`, `cron:runUpdated` | Scheduled job activity |

### Filtering

`?sessions=id1,id2` suppresses only the high-volume `session:terminal` stream for
sessions you did not list. Lifecycle and metadata events are always delivered, so
you cannot accidentally filter away the thing you are listening for.

Pass `?clientId=<uuid>` to enable live filter updates through
`POST /api/v1/events/subscribe` without reconnecting the stream.

### Example: notify when any agent needs you

```js
const res = await fetch('http://127.0.0.1:3000/api/v1/events', {
  headers: { Authorization: 'Basic ' + btoa(`admin:${process.env.CODEMAN_PASSWORD}`) },
});
const reader = res.body.getReader();
const decoder = new TextDecoder();
let buf = '';
const WANTED = new Set(['hook:permission_prompt', 'hook:idle_prompt', 'session:idle']);

for (;;) {
  const { value, done } = await reader.read();
  if (done) break;
  buf += decoder.decode(value, { stream: true });
  const frames = buf.split('\n\n');
  buf = frames.pop() ?? '';
  for (const frame of frames) {
    const name = frame.match(/^event: (.+)$/m)?.[1];
    const data = frame.match(/^data: (.+)$/m)?.[1];
    if (name && WANTED.has(name)) notify(name, JSON.parse(data ?? '{}'));
  }
}
```

## Seam 3: HTTP API and CLI

Around 200 handlers across 21 route files cover sessions, cases, files, cron,
respawn, Ralph, the orchestrator, search, and admin. Each route module carries an
`@fileoverview` describing its endpoints.

If the caller is an agent running _inside_ a Codeman session, install the packaged
agent skill instead of teaching it these calls by hand: `skills/codeman` in the repo
(`npx skills add Ark0N/Codeman --skill codeman -g`, or `codeman skill install
[--case <name>]`, or the synced `agentSkillEnabled` App Setting for automatic
per-case injection on Claude session create). The skill carries the guard, the
safety rules, and verified wait/orchestration recipes.

The common ones:

```bash
# List sessions (live + persisted + transcript history, deduped)
curl -u admin:$PASS http://127.0.0.1:3000/api/v1/sessions/unified

# Create a session
curl -u admin:$PASS -X POST http://127.0.0.1:3000/api/v1/sessions \
  -H 'Content-Type: application/json' \
  -d '{"workingDir":"/home/me/project","mode":"claude"}'

# Send a prompt (single-line only, and it must end with \r: Enter is sent only
# when the input contains a carriage return; without it the text sits on the
# session's prompt unsubmitted)
curl -u admin:$PASS -X POST http://127.0.0.1:3000/api/v1/sessions/$ID/input \
  -H 'Content-Type: application/json' \
  -d '{"input":"run the tests\r","useMux":true}'
```

`POST .../input` also accepts `clientId` (stable per client, max 128 chars) and
`seq` (monotonic per session). Send both and the server applies each pair
at-most-once, so retrying after a dropped connection cannot type the prompt
twice. Omit them entirely rather than sending `null`.

It also accepts `wait` and `waitTimeout`, which hold the response open until the
session finishes the turn you just started. `wait` is `true` (the default signal
set) or a comma list of `idle,working,stop,blocked,exit`; the result comes back
under `data.wait`. Sending them changes nothing for callers that do not: without
`wait` the response is still `{"success": true, "data": {}}` and the write is still
fire-and-forget. The two interact with `clientId` / `seq` in one way worth knowing:
a **tagged duplicate** (a pair the server already applied) skips the write but still
waits, answering from the session's current state rather than blocking for a
transition that already happened. It reports `"delivered": false, "duplicate": true`.

### Waiting instead of polling

Three calls block until something happens: `GET /api/v1/sessions/:id/wait` (a
lifecycle signal), `GET /api/v1/sessions/:id/wait-output` (a literal string in the
output), and the `wait` field above. Full parameter and response tables are in
[`api-reference.md`](api-reference.md#long-polling-agent-wait). Four things decide
whether your integration works, and the last one is what actually bites:

- **A timeout is a `200` with `wait.timedOut: true`**, not an error. Loop over short
  waits rather than issuing one long one, because `tailscale serve` and cloudflared
  both cut idle connections and a single 10-minute call is the pattern most likely
  to die in the field.
- **`wait.timeoutMs`** is the timeout after server-side clamping (600 s ceiling by
  default). Read it rather than assuming you got what you asked for.
- **`stop` and `blocked` only exist for `claude` sessions**, and on a `shell` session
  even `idle` fires only once at startup, so send-and-wait there can only time out.
  See the Gotchas below.

⚠️ **There is no readiness signal, and skipping readiness is the failure that looks
like success.** A session reports `idle` before its CLI has spawned, and a `claude`
worker in a brand-new case comes up on the CLI's **trust dialog**, which has a ❯
prompt of its own. Prompt it at that moment and the text lands in the dialog, the
`\r` does not get past it, and the session's startup `idle` lands inside the wait
window: the wait resolves on `idle` in a couple of seconds with `timedOut: false`,
indistinguishable from a finished turn. Wait for the pid, then wait for the
composer, answering the dialog only as the bounded fallback.

⚠️ **Answering it is not "press Enter".** Claude Code 2.1.252 dropped the options'
numbers, reversed them, and highlights `No, exit` by default, so a blind `\r` quits
the CLI and the pane is dead seconds after the spawn. Read the `❯` marker off the
rendered pane (`GET .../terminal?full=1`), send `ESC [ B` while it sits on `No, exit`,
re-read, and confirm only once the marker is on `Yes, I trust this folder`. Codeman's
own auto-accept (`trustDialogNextKey()` in `src/session-trust-dialog.ts`) does exactly
this, inside a 90 s startup window and a 6-keystroke cap.

A worked orchestration: start a worker, get it ready, prompt it, wait, clean up.

```bash
API="${CODEMAN_API_URL:-http://127.0.0.1:3000}"   # auto-set in-session, correct scheme included
AUTH=(-u "admin:$CODEMAN_PASSWORD")     # omit entirely if no password is set
CURL=(curl -sk "${AUTH[@]}")   # -k: harmless on http, required on --https installs (self-signed cert)

# 1. Start a worker session (creates the case if it does not exist yet).
#    The guard matters: a TLS or auth failure otherwise leaves SID empty and every
#    later step "succeeds" against nothing.
SID=$("${CURL[@]}" -X POST "$API/api/v1/quick-start" \
  -H 'Content-Type: application/json' \
  -d '{"caseName":"worker-1","mode":"claude"}' | jq -r '.data.sessionId')
[ -n "$SID" ] && [ "$SID" != null ] || { echo "quick-start failed"; exit 1; }

# 2. READINESS: composer marker first, trust dialog only as the bounded fallback.
#    Skip this and step 3 reports a turn that never ran. Match single tokens only:
#    TUI text can arrive without its spaces. Stage 1 is short on purpose (an
#    already-trusted case matches in <1 s; a first-run case can never pass it and
#    pays it in full).
#    ⚠️ NEVER answer the dialog with a bare \r. Its highlighted option is `No, exit`
#    (claude-cli 2.1.252), so a blind Enter quits the CLI; and the dialog text stays
#    in the buffer for the life of the session, so a `from=buffer` probe for `trust`
#    keeps matching long after it is gone. Read the CURRENT pane instead and steer.
until [ "$("${CURL[@]}" "$API/api/v1/sessions/$SID" | jq '.data.pid')" != null ]
do sleep 1; done
R=$("${CURL[@]}" -G "$API/api/v1/sessions/$SID/wait-output" \
      --data-urlencode 'match=bypass' --data-urlencode 'from=buffer' \
      --data-urlencode 'timeout=5000')           # composer's status bar = ready
if ! jq -e '.data.wait.matched' <<<"$R" >/dev/null; then
  ESC=$(printf '\033')   # \x1b is GNU-sed only; this form also works on macOS
  for _ in 1 2 3 4 5 6; do
    # Which option the ❯ marker sits on, read off the CURRENT frame.
    K=$("${CURL[@]}" -G "$API/api/v1/sessions/$SID/terminal" --data-urlencode 'full=1' \
        | jq -r '.data.terminalBuffer // empty' \
        | sed -e "s/$ESC\[[0-9;?]*[a-zA-Z]//g" -e "s/$ESC[()][AB0]//g" | tr -d ' \t' \
        | grep -i '❯[0-9.]*\(yes,itrustthisfolder\|no,exit\)' | tail -1 \
        | sed -e 's/.*[Yy]es,.*/confirm/' -e 's/.*[Nn]o,.*/move/')
    [ -n "$K" ] || break                      # no dialog on screen: nothing to answer
    [ "$K" = confirm ] && IN="\r" || IN="$ESC[B"
    "${CURL[@]}" -X POST "$API/api/v1/sessions/$SID/input" \
      -H 'Content-Type: application/json' \
      -d "$(jq -nc --arg i "$IN" '{input:$i,useMux:true}')" >/dev/null
    [ "$K" = confirm ] && break
    sleep 1                                   # re-read: confirm the arrow landed
  done
  "${CURL[@]}" -G "$API/api/v1/sessions/$SID/wait-output" \
    --data-urlencode 'match=bypass' --data-urlencode 'from=buffer' \
    --data-urlencode 'timeout=45000' >/dev/null
fi

# 3. Send the prompt AND register the wait in one call, so the answer cannot be
#    the previous turn's idle state. Single line only, ending in \r (otherwise
#    Enter is never sent and this wait times out on a turn that never started).
W=$("${CURL[@]}" -X POST "$API/api/v1/sessions/$SID/input" \
  -H 'Content-Type: application/json' \
  -d '{"input":"Run the test suite and summarize the failures\r","useMux":true,
       "clientId":"orchestrator","seq":1,"wait":"stop,exit","waitTimeout":60000}' \
  | jq -c '.data.wait')

# 4. That first wait probably timed out (60 s). Keep going in SHORT waits.
for _ in $(seq 1 30); do
  [ "$(jq -r '.timedOut' <<<"$W")" = 'true' ] || break        # signal fired, or wait ended
  W=$("${CURL[@]}" \
    "$API/api/v1/sessions/$SID/wait?until=stop,exit&timeout=60000" | jq -c '.data.wait')
done
jq -r 'if .ended or .aborted then "worker is not running"
       elif .timedOut then "still working after 30 waits"
       else "signal: \(.signal)" end' <<<"$W"

# 5. Read what it produced, then delete the session YOU created, by exact id.
#    ⚠️ NOT /output: its textOutput is empty for every tmux-backed session.
#    `tail` counts BYTES, and the payload is terminal data with ANSI in it.
"${CURL[@]}" "$API/api/v1/sessions/$SID/terminal?tail=8000" | jq -r '.data.terminalBuffer'
"${CURL[@]}" -X DELETE "$API/api/v1/sessions/$SID"
```

Waiting on a marker instead of a signal is the form that works in **every** mode,
and the only one that works on a `shell` session:

```bash
# ⚠️ Split the marker so the typed line never contains it: your own keystrokes echo
# into the output stream, so an unsplit marker matches before the command has run.
# `from=buffer` also catches a marker that printed before the wait registered.
N=$RANDOM
"${CURL[@]}" -X POST "$API/api/v1/sessions/$SID/input" \
  -H 'Content-Type: application/json' \
  -d "{\"input\":\"M=DONE; npm test; echo \${M}_$N rc=\$?\r\",\"useMux\":true}"
"${CURL[@]}" -G "$API/api/v1/sessions/$SID/wait-output" \
  --data-urlencode "match=DONE_$N" --data-urlencode 'from=buffer' \
  --data-urlencode 'timeout=60000' | jq '.data.wait'
```

For shell scripting, the `codeman` CLI is the same surface without the HTTP
plumbing:

```
codeman session start|stop|list|logs     codeman task add|list|status|remove|clear
codeman ralph start|stop|status|reset    codeman users add|passwd|list
codeman status | list | attach <path>    codeman doctor
```

### Opening a session from your own page

To send someone from your page to one session, link to the dashboard with the
session id in the fragment, as in `http://127.0.0.1:3000/#session=<id>`. The
dashboard selects that tab when it loads. It also removes the fragment from its
own URL, so a later link to the same session still counts as a change.

Keep reusing one named window to make later links fast:

```js
window.open(`${codeman}/#session=${encodeURIComponent(id)}`, 'codeman');
```

When that window already shows the dashboard, only the fragment differs. The
browser therefore keeps the page loaded, and the dashboard switches tabs without
reloading it. A session the window has shown before appears at once. A session
your page has only just created may not be listed yet, so the dashboard waits
for its `session:created` event and selects it then. That wait lasts at most 30
seconds: a link whose session never appears (a closed session, a typo, or in
multi-user mode another user's session) is dropped with a "Session not found"
notice. Clicking another tab, going Home or opening a web tab also ends the
wait, so a session that turns up later never takes the screen from the person.

When your page holds the window reference (`const win = window.open(...)`),
prefer `win.location.replace(url)` for later links: it still fires `hashchange`
without a reload, but adds no history entry, so Back in the dashboard window
does not turn into a silent no-op.

Following a link does not count as someone looking at the session, so it
leaves the session's idle alert in place. The alert clears when the person
clicks the tab or types into the session. A link to a session that is popped
out into its own window asks that window to come forward, as clicking its tab does.

A link to `/session/<id>` opens a page showing that session alone, and that
page loads from scratch for every link.

## Seam 4: Hooks

Claude Code hooks post to `POST /api/v1/hook-event` from inside an agent session.
Codeman installs its own hooks automatically, but the endpoint is open to yours.

```json
{ "event": "task_completed", "sessionId": "abc123", "data": { "any": "json" } }
```

`event` must be one of `permission_prompt`, `elicitation_dialog`, `idle_prompt`,
`stop`, `teammate_idle`, `task_completed`. Each becomes the matching `hook:*` SSE
event.

⚠️ This endpoint skips Basic auth so hooks keep working, but when auth is active
the loopback bypass requires the `X-Codeman-Hook-Secret` header
(`~/.codeman/hook-secret`) unconditionally.

## Gotchas

Every one of these has cost somebody real time.

- **CORS is localhost-only.** `Access-Control-Allow-Origin` is echoed only for
  `localhost`, `127.0.0.1`, and `::1`. A browser app on any other origin cannot
  call the API. Integrate server-side.
- **A missing `Origin` header is allowed**, which is why curl, CLIs, and hooks
  work. Cross-site origins are blocked by the CSRF guard.
- **Reverse-proxy domains are rejected** by the anti-DNS-rebinding Host allowlist
  unless added via `CODEMAN_ALLOWED_HOSTS=host,.suffix`.
- **`null` is not `undefined`.** Request schemas use Zod `.optional()`, which
  accepts `undefined` only. `JSON.stringify({ field: null })` keeps the null on
  the wire and fails with `INVALID_INPUT`. Omit the key instead. This has caused
  shipped bugs more than once.
- **`text/plain` bodies stay raw.** Auto-parsing them as JSON enabled
  simple-request CSRF, so it is deliberate. Send `application/json`.
- **Prompts are single-line and must end with `\r`.** The server splits your text
  and Enter into two separate tmux writes (Ink needs them apart), but it sends the
  Enter **only when the input contains a carriage return**. Without it your text
  sits on the prompt unsubmitted, which is the single most common "the wait
  endpoints don't work" report: the wait runs its full timeout on a turn that never
  started. Newlines inside the string are stripped rather than rejected, so
  `"echo A\necho B\r"` runs the single joined command `echo Aecho B`: send one line
  per call.
- **`wait-output`'s `from=now` is not "printed after you asked".** tmux repaints
  the visible screen on attach, on resize, and on any TUI redraw, and a repaint
  arrives as ordinary output, so text already on screen can satisfy a fresh wait.
  Observed live: a marker echoed a minute earlier matched instantly. Use a marker
  unique to each call, and build it so the typed line never contains it (your own
  keystrokes echo into the stream). Matching is a literal substring, so `regex=` is
  rejected with a `400` rather than ignored.
- **`wait-output` matches the normalized PTY stream, not the screen.** ANSI escape
  sequences are stripped (the `ESC ( B` charset escape a bash prompt emits on every
  line included), a partial escape at a chunk boundary is held back until its tail
  arrives, and a match may straddle PTY chunks, so text you printed yourself
  matches reliably (`printf STRAD; sleep 1; printf DLEQQ` is matchable as
  `STRADDLEQQ`). What can still fail is TUI output: a full-screen TUI positions
  words with cursor moves, so its text can reach the matcher **without spaces** and
  a multi-word match is unreliable there. Match one short space-free token, ideally
  one you printed yourself, and keep it out of the typed line (your own keystrokes
  echo into the stream).
- **`stop` and `blocked` never fire for `shell`, `opencode`, `codex`, `gemini`,
  `antigravity` or `pi` sessions.** They come from Claude Code hooks, which no other mode
  installs, so only `idle`, `working` and `exit` exist there. Asking for them
  explicitly is a `400`; omitting `until` is safe, since the server drops them from
  the default set and echoes what it actually waited on as `wait.until`. Even in
  `claude` mode, a Docker case needs `CODEMAN_DOCKER_BRIDGE_HOOKS=1` for hooks to
  reach the server at all, a remote-SSH case's hooks may never arrive, and a case
  written by Codeman < 1.13.0 against an `--https` install carries hook curls
  without `-k` that TLS-fail silently — a 1.13.0+ server rewrites them the next
  time a session starts in that case.
- **Unwrap the envelope** before reading fields. `data` is not the response body.

## Publishing your integration

There is no registry and no review queue. Add the GitHub topic
**`codeman-integration`** to your public repository so others can find it, and
link back to Codeman in your README.

If a real ecosystem of these appears, a manifest format and an install command
become worth building. Until then, these four seams are the contract, and they
require nothing of you but HTTP.

## What Codeman deliberately does not have

- **No in-process plugin runtime.** See the reasoning at the top of this page.
- **No build or startup hooks** for third-party code. Run your own process.
- **No per-plugin config or state directories.** Manage your own files.
- **No sandbox for integration code**, because Codeman never launches it. Your
  integration is your own process, started by you, with your permissions,
  talking HTTP.

That last point is about integration code specifically, not about Codeman.
Sandboxing lives on a different axis here: the thing worth isolating is the
**agent**, and you isolate it per case with
[Docker cases](docker-cases.md), which run the agent in a hardened container with
a bind-mounted workspace and seeded (not shared) credentials. An integration that
creates or drives a Docker-backed session inherits that isolation for free, since
it is a property of the session rather than of the caller.
