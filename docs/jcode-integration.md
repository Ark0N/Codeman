# jcode sessions

Codeman can drive [jcode](https://github.com/1jehuang/jcode) (1jehuang/jcode, MIT, a
coding-agent TUI written in Rust) as a session backend, alongside Claude Code, OpenCode,
Codex, Gemini, Antigravity, Pi, Grok, DeepSeek and OMP. `jcode` is its own **run mode**:
its own PTY, its own tmux session, its own tab identity (amber, `JC` badge, a plain ring
standing in for jcode's halftone donut). It is not a location overlay like Docker or
remote-SSH cases, and it is not a web tab.

Everything here was measured against jcode v0.98.1 on 2026-10-16 (see
[How it was measured](#how-it-was-measured)). The registry entry in
`src/config/cli-registry/stock.ts` carries the same facts in its comments and is the
source of truth when the two disagree.

## Install

```bash
curl -fsSL https://jcode.sh/install | bash
```

The installer downloads a checksummed release binary into
`~/.jcode/builds/versions/<version>/` and links `~/.local/bin/jcode` (its
`JCODE_INSTALL_DIR` default) to it. The linked `jcode` is a small `sh` **launcher** that
resolves its own path and execs the `jcode-<os>-<arch>.bin` beside it, so the version
directory is what matters, not the single file the link points at.

Codeman resolves the binary through the generic registry resolver (there is no
jcode-specific resolver module): the server PATH, then `~/.local/bin`, `/usr/local/bin`
and `~/bin`, then an interactive login shell. npm carries an unrelated package also called
`jcode`, so a PATH hit is not trusted on its own: `jcode --version` must print
`jcode v<semver>` (the real one prints `jcode v0.98.1 (1c7426eb1)`), and anything else
counts as absent. Check what it resolved:

```bash
curl -s localhost:3000/api/jcode/status | jq
# { "available": true, "path": "/home/you/.local/bin", "version": "0.98.1" }
```

## Authenticate

jcode keeps its own logins: OAuth accounts in `~/.jcode/auth.json`, API keys in
`~/.config/jcode/<provider>.env`, the default provider and model in `~/.jcode/config.toml`.
Set them up with jcode itself (`jcode login`, `/login` inside the TUI, or
`jcode provider add <name> --base-url ... --model ...` for an OpenAI-compatible server).
jcode can also offer to reuse logins other CLIs left behind; it asks before reading any of
them. Codeman forwards no credentials into a jcode pane.

## What Codeman wires up

`JcodeConfig` (per session, persisted in `state.json`, round-trips through respawn and
server restart):

| Field             | Flag            | Notes                                                                        |
| ----------------- | --------------- | ---------------------------------------------------------------------------- |
| `model`           | `--model <v>`   | e.g. `claude-opus-4-8`, `gpt-5.5`                                            |
| `resumeSessionId` | `--resume <v>`  | a session id (`session_fox_1792160401272_f5b47ce47d631006`) or its short name (`fox`) |

Both values are regex-validated at the route and checked again by the argv engine, and a
value that fails is **dropped**, never escaped into the command. `resumeSessionId` uses the
`path-segment` pattern (a leading letter or digit) on purpose: jcode's `--resume` takes an
OPTIONAL value (a bare `--resume` opens its session picker), so a value starting with `-`
would be parsed as a flag of its own (`--resume --no-update` is two flags).

The Run button sends **no** `jcodeConfig`: jcode has no approval prompts and no bypass
flag, so there is nothing to opt into (the same shape as pi). A bare spawn is just `jcode`.

There is **no** `envOverrides` prefix for jcode: `JCODE_*` is not allowlisted. See
[The shared daemon](#the-shared-daemon) for why.

## The shared daemon

Every jcode TUI is a CLIENT of one shared per-user daemon (`jcode serve`). The first client
starts it, in its own session and process group (`setsid`), and every later client attaches
to it. It stays the first client's CHILD by parent pid, though, which is what the
[session kill](#closing-a-tab-never-takes-the-daemon-down) has to account for. The agent and its tools run in the DAEMON, with the daemon's
environment. Measured: a second client started with `CODEMAN_PROBE=second-client` asked its
bash tool to `echo "probe=[$CODEMAN_PROBE]"` and got `probe=[]`.

Three things follow, and each one is a deliberate decision:

- **The agent skill is not injected.** jcode does read `./.agents/skills` (and
  `./.jcode/skills`, `./.claude/skills`), but a jcode agent's tools see the
  `CODEMAN_SESSION_ID`, `CODEMAN_API_URL` and `CODEMAN_MUX` of whichever session started
  the daemon, or none at all if it was started outside Codeman. An injected skill would act
  as THAT session: spawn children under the wrong parent, prompt another session's
  workers. A user-level copy of the skill (`~/.agents/skills`, which jcode also reads) has
  the same problem; this is the same trap as codex's shared `app-server`, only it is jcode's
  normal case rather than an edge.
- **No `JCODE_*` envOverrides prefix.** Most of that namespace is read by the daemon, so a
  per-session value would do nothing, and where it did act (in the session that happens to
  start the daemon) it would reach every jcode session on the machine. The namespace
  includes variables that run code or redirect traffic: `JCODE_HOOK_*`, `JCODE_SPAWN_HOOK`,
  `JCODE_*_COMMAND`, `JCODE_*_API_BASE`. Configure jcode in `~/.jcode/config.toml`, or in
  the Codeman server's own environment.
- **Deleting a Codeman jcode session leaves the daemon running**, by design: the other
  sessions live there (next section). `jcode server stop --force` stops it by hand.

### Closing a tab never takes the daemon down

Codeman's session kill signals every descendant of the pane (by parent pid), so it used to
kill the shared daemon whenever the closed tab happened to be the one that started it.
Measured on a beta before the fix: two jcode sessions, the first one deleted, and the second
one's client looped on `Connection lost - retrying (attempt 9) - server closed the
connection` with its prompt queued (`⏳`), while a send-and-wait on it timed out.

The jcode entry declares `capabilities.sharedDaemon: true`, and for such a CLI the kill
signals only the descendants still in the pane's own process group
(`descendantsInPaneGroup()`, `src/proc-tree.ts`, one bounded `ps -o pid=,pgid=`). The daemon
left that group when it called `setsid`, and everything it runs inherits its group, so the
daemon and its tools are spared while the client and anything else in the pane's group are
killed as before. A lookup that fails keeps the old behaviour (kill every descendant). Every
other CLI is unaffected. Measured after the fix: the kill logs `Sparing 1 process(es)
outside pane <pid>'s group (the CLI's shared daemon)`, the daemon keeps its pid, and the
remaining session answered a send-and-wait in 5 s.

The flip side: a process a jcode agent started (a dev server, a watcher) is a child of the
daemon, not of the pane, so closing the tab does not stop it. That is how jcode behaves in a
plain terminal too.

## Approvals and multi-user mode

jcode has no approval dialog. Its bash tool runs ungated apart from jcode's own model-side
reflection gate on risky commands and a hard deny on catastrophic paths. So there is no
bypass flag to clamp, nothing for the multi-user clamp to force off, and no dialog for
Codeman to read as `blocked`. In multi-user mode a jcode session is like a pi session: an
agent that runs tools without asking, under the one OS account every session shares.

## Terminal behavior

jcode is a **full-screen alternate-screen TUI with mouse tracking on** (tmux
`alternate_on=1`, `mouse_any_flag=1`, `mouse_sgr_flag=1`). It takes the opencode strip,
`altScreen: 'strip-mux-and-mouse'`: the mouse DECSETs are stripped, so a drag selects text
locally (Auto Copy and copy-on-select work) instead of being reported to jcode.

Scrolling: jcode pages its own transcript on PageUp/PageDown and also scrolls on SGR wheel
reports (both measured). It declares `transcriptPageKeys: true`, so over the hollow
alt-screen buffer a wheel or a swipe becomes PageUp/PageDown instead of doing nothing.

Input: a long prompt sent the way Codeman sends one (a bracketed paste, then a separate
Enter) submits cleanly (measured with a 170-character prompt).

### How Codeman reads a working pane

At rest the composer row is `<n>> ` (the prompt number, then `>`); a submitted prompt is
echoed into the transcript as `<n>› <text>`. While a turn runs the composer row reads
`<n>…` and a status row appears directly above it: a braille spinner (the gemini/omp frame
set, about 12 fps), then the phase and the elapsed time:

```
⠋ sending… 0s
⠦ thinking… 2s · https
⠼ waiting for response… 3s · https
⠸ running bash · <detail> · 12s · Alt+B bg
⠼ 12s · 45.1 tps · ↑16k ↓20            (streaming: the time comes first)
↻ network disconnected, waiting to retry · … · 5s
```

Past a minute the time reads `1m 3s`, past an hour `1h 2m`. At rest that row is empty or a
dim tip, never a spinner, and the turn leaves a summary row (`  21s · 199.6 tps · ↑17k ↓2k`)
that has a time but no spinner. The `workingLine` pattern therefore needs a spinner (or the
`↻ network disconnected` row) at the start of a row AND an elapsed time on it.

The composer glyph is the bare `>`. tmux redraws only the cells that changed, and on the
composer row at the end of a turn that is the `…` turning into `>` (the recorded client
stream carries `\x1b[43;2H...> `), never the prompt number, so `>` is what reliably arrives.
Mid-turn stream chunks never contain it. The glyph only ARMS the idle check; the screen and
the silence decide.

Silence is a sound signal for jcode: the spinner repaints the pane at least every 100 ms for
the whole turn, and at rest jcode sends nothing at all (12 seconds recorded: zero bytes).

The submit verifier stays inert for jcode, which is what it wants (it has no early-Enter
defect): every composer row starts with its prompt number, so no screen row starts with
`>` the way the verifier requires.

### Reading a jcode worker's answer

`GET /api/sessions/:id/last-response` returns an **honest empty** (`text: ""`, and
`messages: []` with `?context=full`) for jcode. The pane segmenter the other TUIs use cannot
read a repainting alternate-screen stream (measured: it served jcode's welcome banner as
"the answer"), and without this the route would fall through to the Claude transcript scan,
which could adopt a Claude conversation from the same folder. Read a jcode worker's screen
instead:

- `codeman agent read <id> --tail 3000`
- MCP `read_output` with `source: "terminal"`
- `GET /api/sessions/:id/terminal?tail=3000`

There are no `stop`/`blocked` hook signals for jcode: wait for `idle`, or use `wait-output`
markers, as with every hook-less CLI.

## First run: the onboarding wizard

A fresh jcode install opens an onboarding wizard ("Welcome to jcode onboarding / Log in to
OpenAI?") instead of the composer, on every launch, until its launch counter passes 5 or
10 sessions exist. A prompt typed into the wizard is lost (measured: it wedged that client).
Before driving jcode from Codeman, run `jcode` once in a terminal and finish or skip the
wizard, or press Esc in the Codeman pane.

## jcode's own defaults Codeman does not change

- **Telemetry** is on by default in jcode (install count, version, OS, session activity,
  tool counts; jcode's `TELEMETRY.md`). Opt out with `jcode telemetry disable`, or set
  `JCODE_NO_TELEMETRY=1` in the Codeman SERVER's environment (it is not a per-session env
  override, see above).
- **Auto-update** is on by default for release builds; `--no-update` is jcode's own flag and
  Codeman does not pass it.
- **Self-dev mode**: jcode switches into it when started inside a checkout of jcode itself.

## Docker cases

jcode is not on npm, so the agent image installs it in a dedicated Dockerfile step through
jcode.sh's installer, then copies the WHOLE version directory to `/opt/jcode` (the launcher
execs the binary beside it, so copying only the linked file, as the grok and omp steps do,
would leave a launcher with nothing to run) and links `/usr/local/bin/jcode` to the launcher.
Root's `~/.jcode` is dropped in the same layer so the image does not carry the ~160 MB
binary twice. Verified in `node:22-bookworm-slim`, including `jcode --version` as the
unprivileged `agent` user. Rebuild with the mandatory `--no-cache`:

```bash
node scripts/build-agent-image.mjs --no-cache
```

No credentials are seeded into the container: `~/.jcode` holds the OAuth tokens beside the
builds, sessions and SQLite caches, and API keys live in `~/.config/jcode`. Sign in inside
the container instead.

## Remote SSH cases

`jcode` mode is routed through an interactive login shell
(`exec "$SHELL" -i -l -c 'jcode'`), because sshd's remote-command PATH does not include
`~/.local/bin`. Per-session config does not cross ssh and is rejected rather than silently
ignored; a host whose `jcode` lives elsewhere takes the per-host `commands.jcode` override.

## Not supported yet, and why

- **A transcript reader** (a real `last-response`, Response Viewer content). jcode writes
  sessions as `~/.jcode/sessions/session_<name>_<ms>_<hex>.json` plus a `.journal.jsonl`,
  which is easy to parse, but pairing a Codeman pane with ITS session file is ambiguous: the
  session JSON's `last_pid` is the shared daemon's, not the pane's, so two jcode panes in
  one folder cannot be told apart from the files alone.
- **Custom Model Endpoint Profiles** (`customModelInjection: unsupported`). jcode's provider
  is resolved in the daemon, not the pane, so a per-session redirect has nothing reliable
  to land on.
- **The model in tile headers** (`modelDetect`). The status bar names provider and model
  (`qwen5090 qwen3.8 27b`), but its layout varies by provider and width and was not
  measured enough to anchor a pattern on. A session shows its launch model, if any.
- **Hook-based `stop`/`blocked` signals.** jcode has lifecycle hooks (`session_start`,
  `turn_start`, `turn_end`, `session_end`), but they run in the daemon too, with the
  daemon's environment, so they cannot tell Codeman which session they belong to.
- **Ralph, respawn heuristics, token/CLI-info parsing and the `❯` readiness probe are off**
  for jcode, as for every external CLI.

A per-session daemon (`jcode --socket <path>`) would give each pane its own environment,
but it gives up the shared daemon that is jcode's main design point (cross-session swarm
awareness, a few MB per extra session), so it was not done here.

## How it was measured

- jcode installed with its own installer into a scratch `HOME` with telemetry off
  (`DO_NOT_TRACK=1`, `JCODE_NO_TELEMETRY=1`) and a short `XDG_RUNTIME_DIR` (the daemon's
  Unix socket path must stay under the `SUN_LEN` limit), so nothing touched the real home.
- A provider set up with `jcode provider add` pointing at a local OpenAI-compatible server
  (an RTX 5090 serving Qwen 3.8 27B), so no subscription login was involved.
- jcode run in a scratch tmux socket at 160x45; `tmux capture-pane -p` every 200 ms through
  real turns (a plain reply, a bash tool call, a streamed answer); `pipe-pane` at rest; and a
  tmux CLIENT attached through a PTY to record exactly what Codeman's PTY reads.
- PageUp/PageDown sent with `send-keys`; SGR wheel reports (`\x1b[<64;40;10M`) pasted raw.
- A second client with its own environment to prove where tools run.
- The Docker step run in a throwaway `node:22-bookworm-slim` container.
- End to end through an isolated beta Codeman built from this branch (its own
  `CODEMAN_INSTANCE`, port and tmux socket): `POST /api/quick-start` with `mode: "jcode"`,
  `/api/jcode/status`, send-and-wait (`wait: "idle"` returned after the turn, 12.7 s for a
  turn with a 5 s tool call, not during it), two sessions with the first deleted, and a
  Playwright pass over the Run menu entry, the `Run JC` button and the rendered transcript.

The fixtures in `test/jcode-mode.test.ts` are verbatim from these captures.
