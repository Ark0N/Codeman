# Custom Model Endpoints

Point a harness at your own OpenAI-compatible server instead of its native cloud backend, for
one session at a time. "Custom endpoint" covers **local** hardware (llama.cpp, Ollama, vLLM,
a home GPU rig, DGX Spark, Strix Halo) and **cloud** services (Azure AI Foundry's
OpenAI-compatible endpoint, OpenRouter, a company gateway) alike, anything answering
`GET /v1/models` and `POST /v1/chat/completions` in the standard shape.

**Off by default.** Turn it on in App Settings → Models → **Custom model endpoints**.

## Adding an endpoint

Still in App Settings → Models → Custom model endpoints:

1. **+ Add endpoint** — give it an id, a label, and the base URL (`http://192.168.1.50:8080`,
   say). An API key is optional; most local servers don't check one.
2. **Discover** — fetches the endpoint's own model list over `GET /v1/models` and stores it.
3. Pick a **default model** from what was discovered. This is the model the Run-menu entry
   applies directly when only one model is discovered; with two or more, it's just the one
   pre-marked in the picker dialog described below, not a silent default.

Endpoint management is admin-only in multi-user mode, the same as remote hosts and Docker
hosts — these are machine-level infra, not a per-user setting.

**Model lists refresh themselves.** Every saved endpoint is re-discovered automatically every
5 minutes in the background, so a model the server starts serving later — or stops serving —
shows up without another manual click of **Discover**. One endpoint being unreachable on a
given cycle (powered off, wrong network) never blocks the others from refreshing.

**Context length is picked up automatically where it can be, safely.** Against a
llama.cpp/llama-swap server, discovery also learns each _currently loaded_ model's real
context window and applies it to the launched session (Claude Code today — see below), so
the harness stops assuming a large default window for a model name it doesn't recognise and
overflowing a much smaller real one. It's deliberately never probed for a model that isn't
already loaded, since asking a llama-swap server about an unloaded model can trigger an
actual, slow model swap as a side effect — a model just not currently loaded keeps whatever
context length an earlier cycle already learned for it instead.

## Running a session against one

With the setting on and at least one endpoint carrying a discovered model, the **Run**
dropdown grows a **Custom Endpoints** section: one entry per harness that can redirect to a
custom endpoint, per saved endpoint, e.g. "Claude Code (llama.cpp)". Picking one starts a
session on that harness exactly the way its own entry would. It is a one-off "try this
endpoint" action, not a sticky mode — the plain **Run** button still means "this harness,
native cloud" afterward, and a fresh session never inherits whatever the last one was
pointed at.

**Which model it uses depends on how many the endpoint has discovered.** With exactly one,
the session launches straight away on that model — nothing to choose. With two or more, a
small dialog asks which one to use for this launch before starting the session; the
endpoint's default model, if set, is marked but not auto-picked, so a launch can deliberately
use a different one without changing the saved default. The list is not raw discovery order
either: the model llama-swap reports loaded and ready is moved to the top and tagged
**Currently loaded**, and when nothing is loaded, the model you last launched on this harness
and endpoint pair is moved up instead and tagged **Last used** (a per-device browser value, so
another device starts from its own history). The default model keeps its own **Default** pill
in both cases, and nothing is ever auto-chosen: the promoted row is simply the one under your
thumb.

**For opencode, Codex, Gemini, Pi, Grok, DeepSeek and OMP, picking an entry launches
straight onto the endpoint** — no restart, because the endpoint is applied before the
session's process ever starts. **Claude still restarts the harness's process in place** —
same tab, same conversation (`--resume`) — after a normal native launch, since that restart
is far less jarring for Claude than for the other seven, whose own TUI can fully
reinitialize on a restart. Either way, every supported harness reads its endpoint config at
process start, never per turn, so there is no live hot-swap while a turn is running.

Picking an entry that launches a **brand-new** Claude session waits (up to 20 seconds) for it to
finish its own startup before applying — a freshly started CLI reports itself as busy for its
boot sequence, and applying to a genuinely busy session is refused so a real, in-progress
turn is never interrupted out from under you. A session that is still busy after that wait
(a very slow-starting CLI, or one you started typing into right away) surfaces that refusal
as an ordinary error, which now stays on screen with a close button instead of vanishing
after a few seconds — read it, it names the actual reason rather than a generic failure.

Entries are hidden entirely for a session in a **remote (SSH) or Docker case** — support for
redirecting those hasn't landed yet, see below. The picker also only appears in the desktop
**Run** dropdown; the phone home screen builds its own run picker separately and does not
currently offer these entries.

**Against llama-swap, applying a selection also starts the actual model load, rather than
waiting on your first prompt to do it.** llama-swap has no "switch model" button of its own
— the only thing that starts a swap is a real request naming the model, and confirmed live:
just applying a selection never reached llama-swap's own logs at all until something asked
it to load. Picking an entry now also sends the smallest real request that will trigger
that load, in the background, the moment the target model isn't already loaded and ready.

**The centred loading banner has no countdown and no automatic timeout — it waits as long as
it takes, and tells you so.** When it knows the model's discovered file size (its GB figure,
when llama-swap states one) it's shown too, e.g. "Loading qwen3.8-27b (16.4 GB) on
llama-swap — this can take a while depending on your hardware and the model size." An
earlier version tried to estimate and enforce a time limit, but real load time depends on
hardware this feature has no way to know, so a fixed number was always a guess — worse, one
that could kill a genuinely slow load partway through. If it really is taking too long, a
**Cancel** button right on the banner ends the wait and **closes the session that load was
for**, on your own call rather than a guessed deadline.

**The banner also shows a real, live second line of what llama.cpp itself is doing** — not
a made-up progress phase, the actual next line the `llama-server` process printed, e.g.
"llama.cpp: load_model: loading model '/models/.../Qwen3.8-27B.gguf'" then later
"llama.cpp: llama_server: model loaded". It comes straight from llama-swap's own event
feed, filtered down to just the backend process's own output (not llama-swap's own request
logging), and stays on whatever it last said once the load goes quiet, rather than
clearing back to nothing.

**You'll also be told if a session's model gets swapped out from under it later, not just
at launch.** The conflict warning above only fires at the moment you launch or apply a
model — llama.cpp only runs one model at a time, so if a DIFFERENT session using the same
endpoint later triggers its own load, whatever was loaded before (including a session you
already had running) gets silently evicted, with no warning at that instant since nothing
conflicted when it was first set up. A background check (every 20 seconds) catches this
after the fact and shows a toast naming which session lost its model and what's loaded now
— so you know before typing into that session that it's about to reload (and, in turn,
evict whatever displaced it).

**Claude Code specifically gets three extra fixes applied automatically:**

- Its discovered context length (see above) is passed through as
  `CLAUDE_CODE_MAX_CONTEXT_TOKENS`, so it doesn't send a full-size prompt against a much
  smaller real local context and overflow it.
- Its session runs with an isolated `CLAUDE_CONFIG_DIR`, so the injected API key never sits
  in the same directory as a stored claude.ai login — that combination is harmless for actual
  requests (the API key wins) but the CLI still prints a "both claude.ai and
  ANTHROPIC_API_KEY set" warning about it, which this avoids entirely. The isolated directory
  keeps a link back to your real session history so the response viewer and similar features
  still work for that session. That isolated directory starts with no prior approvals of its
  own, so Codeman also pre-approves the injected key the same way answering Claude Code's own
  "Detected a custom API key" prompt once would — without it, that prompt would otherwise
  reappear on every single launch with nobody there to answer it.
- **That same fresh isolated directory also looks like a brand-new Claude Code profile**, so
  without this fix it replayed the WHOLE first-run sequence every single launch: the theme
  picker, the security-notes screen, the "trust this folder?" dialog, and a one-time warning
  about running with permissions bypassed — none of which a real, already-used profile shows
  again. Codeman now pre-seeds that same "already been through this once" state (onboarding
  completed, this session's own project marked trusted, the bypass-permissions warning
  acknowledged) so a custom-model launch reaches the actual conversation exactly as fast as a
  native cloud one does, instead of stopping at a wizard with nobody there to click through it.

**If a model's real context is too small for Claude Code to even get started, you get a
warning instead of a confusing failure.** Claude Code's own system prompt and tools take up
roughly 40K tokens on their own, before you've typed anything — a small local model with a
smaller real context than that fails outright on the very first message, no matter what
context size Codeman tells it to expect (raising the declared context only changes when
Claude Code trims _conversation history_, and there is none yet on message one). Picking
such a model now shows an in-app dialog naming the model, its discovered context and what's
needed, before anything launches or restarts, with the fix spelled out: reconfigure
llama-swap to give that model (or a smaller one) an explicit larger context instead of
relying on auto-fit (`--fit-ctx`), which sizes the context around fitting the biggest model
rather than the biggest context — for example adding `-c 65536` to that model's llama-swap
entry. "Launch anyway" is still there if you want to try regardless.

## Which harnesses actually work

| Harness                                  | Status                                                                                                                                                                                                               |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Claude Code, opencode, Pi, Grok, OMP** | Verified end-to-end against a real local server.                                                                                                                                                                     |
| **Codex**                                | Config is correct, and plain chat can work against a server that speaks the Responses API — but a real tool-call attempt comes back as inert text instead of running, so it's still not usable for real coding work. |
| **Gemini**                               | Fails with an auth error gemini-cli raises once redirected. Unresolved; don't rely on it yet.                                                                                                                        |
| **DeepSeek**                             | The original 404 is root-caused and fixed (DeepSeek Harness's own code was missing a `/v1` most local servers require) — not yet re-run against a real `dsh` install to confirm end-to-end.                          |
| **Antigravity**                          | No known custom-endpoint mechanism at all. Not offered.                                                                                                                                                              |

Which harnesses show up in the Run-menu picker is read live off Codeman's own CLI registry,
not a fixed list here, so this table can go stale before this page does — a greyed-out or
missing entry is the more current answer.

## What it does not do

- **No remote or Docker sessions yet.** Both restart their agent differently under the hood
  (reattaching a durable tmux session rather than relaunching the process), so redirecting
  them needs its own plumbing that hasn't been built.
- **No live hot-swap mid-conversation.** Applying a selection always restarts the process.
- **No button to un-point a session from the UI yet.** Clearing back to native cloud is an
  HTTP call (`POST .../custom-model {"clear": true}`) or deleting the session; the settings
  panel manages saved endpoints, not what a running session is currently pointed at.
- **Nothing is shared with your real cloud credentials.** The endpoint's own key, if any,
  never touches your Anthropic/OpenAI/Google login — a custom endpoint is a separate,
  explicit choice per session.

## Security

An endpoint's base URL can't point at a link-local or cloud-metadata address (both at save
time and against the address it actually resolves to), the same guard Web Tabs uses for
saved dashboards. Endpoint records and any per-session config files a harness needs are
written with owner-only permissions. See
[custom-model-endpoints-plan.md](https://github.com/Ark0N/Codeman/blob/master/docs/custom-model-endpoints-plan.md)
in the repository for the full design reasoning, including why this feature closed a
pre-existing gap in how session environment overrides were guarded rather than opening a new
one.
