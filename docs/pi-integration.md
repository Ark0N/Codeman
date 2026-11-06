# Pi (pi.dev) sessions

Codeman can drive [Pi](https://pi.dev) (`@earendil-works/pi-coding-agent`, MIT) as a
session backend, alongside Claude Code, OpenCode, Codex, Gemini and Antigravity.
`pi` is a sixth **run mode**: its own PTY, its own tmux session, its own tab colour
(rose). It is not a location overlay like Docker or remote-SSH cases, and it is not
a web tab.

Tracking issue: [#206](https://github.com/Ark0N/Codeman/issues/206). The design
rationale behind each decision below lives in `docs/pi-integration-plan.md`.

## Install

```bash
npm install -g --ignore-scripts @earendil-works/pi-coding-agent
# or
curl -fsSL https://pi.dev/install.sh | sh
```

Both installers end up going through global npm, so either one uninstalls with
`npm uninstall -g @earendil-works/pi-coding-agent`.

Codeman finds the binary via `which pi` and then the usual global-bin locations
(`~/.local/bin`, `/usr/local/bin`, `~/.bun/bin`, `~/.npm-global/bin`, `~/bin`).

**`pi` is a short, generic name**, so unlike the other CLI resolvers Codeman does
not trust a `which` hit on its own: it runs `pi --version` once and requires
semver-shaped output. Anything else is rejected as "not installed" and the
rejected path is logged. Check what it resolved:

```bash
curl -s localhost:3000/api/pi/status | jq
# { "available": true, "path": "/home/you/.local/bin", "version": "0.84.1" }
```

That endpoint carries `version` on top of the shape the sibling `/api/*/status`
endpoints return, precisely so a misresolution is visible rather than presenting
as "the mode just doesn't work".

## Authenticate

Pi supports 15+ providers. Two ways in:

- **OAuth subscription login** — run `/login` inside a pi session. Six providers
  support it: ChatGPT Plus/Pro, Claude Pro/Max, GitHub Copilot, xAI, OpenRouter
  and Radius. Credentials land in `~/.pi/agent/auth.json` and pi refreshes them
  itself. OpenRouter's flow accepts a pasted redirect URL, which is what makes it
  workable over remote SSH.
- **API keys** — exported in the environment of the **Codeman server process**.

⚠️ **Provider API keys cannot be sent as per-session `envOverrides`.** Pi reads
about 34 provider variables (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`,
`DEEPSEEK_API_KEY`, `HF_TOKEN`, `BASETEN_API_KEY`, …) that share no common prefix.
Codeman's env allowlist is a single global list applied to every mode at once, so
admitting bare provider keys for pi would widen the allowlist for Claude, Codex,
Gemini and everything else too. Only the **`PI_*`** prefix was added, which covers
every documented pi input: `PI_CODING_AGENT_DIR`, `PI_CODING_AGENT_SESSION_DIR`,
`PI_PACKAGE_DIR`, `PI_OFFLINE`, `PI_SKIP_VERSION_CHECK`, `PI_TELEMETRY`,
`PI_CACHE_RETENTION`, `PI_SHARE_VIEWER_URL`, `PI_HARDWARE_CURSOR`,
`PI_EXPERIMENTAL`.

`pi auth check` verifies credentials before you start a long run.

Note if you authenticate with a Claude Pro/Max subscription: third-party harness
usage bills as Anthropic "extra usage" per token rather than against plan limits.

## What Codeman wires up

`PiConfig` (per session, persisted in `state.json`, round-trips through respawn):

| Field                 | Flag                                   | Notes                                                            |
| --------------------- | -------------------------------------- | ---------------------------------------------------------------- |
| `model`               | `--model <v>`                          | Accepts `provider/id` and a `:<thinking>` suffix (`sonnet:high`) |
| `provider`            | `--provider <v>`                       | `anthropic`, `openai`, `google`, …                               |
| `thinking`            | `--thinking <v>`                       | `off`/`minimal`/`low`/`medium`/`high`/`xhigh`/`max`              |
| `continueSession`     | `-c`                                   | Skipped when `resumeSessionId` is set (the two conflict)          |
| `resumeSessionId`     | `--session <v>`                        | Ids only, never paths                                             |
| `approveProjectTrust` | `--approve` / `--no-approve` / nothing | Tri-state, see below                                              |

Every value is regex-validated and **dropped** (not escaped) if it fails, because
the result is interpolated into the pane's `bash -c "…"` command.

The Run button sends **no `PiConfig` at all**: pi has no permission prompts to
bypass, and project trust is a decision the person at the terminal makes.

## What Codeman deliberately does NOT wire up

- **`--api-key`.** Never. It would put a provider secret on the spawn command
  line, visible in `ps`, tmux server state and logs. `PI_*` overrides go through
  socket-scoped `tmux setenv` for exactly this reason.
- **`--tui-mode`.** Pi's default main-screen TUI is the friendly case for a
  browser terminal. The fullscreen mode (0.84.0) stays your own runtime choice via
  `/settings`.
- **`--name`, `--no-session`, `-p`/`--print`, `--mode json`, `--mode rpc`,
  `--tools`/`--exclude-tools`, `-e`/`--extension`, `--skill`,
  `--system-prompt`.** Tracked as follow-ups in the plan doc.

## Permission and trust model — read this

**Pi has no permission prompts and no sandbox.** There is no
`--dangerously-skip-permissions` analog and none is needed: tools run with the
user's own permissions, always. A pi session can read, write and execute anything
the Codeman user can. If you need isolation, use a **Docker case** — that is the
isolation story, here as everywhere else in Codeman.

Pi's "project trust" prompt is **not** a safety boundary (upstream says so too).
It gates *loading* repo-local `.pi/` config, extensions and skills, and
*installing* missing project packages. It only appears when the cwd or an ancestor
contains `.pi/settings.json`, `.pi/extensions|skills|prompts|themes`,
`.pi/SYSTEM.md`/`.pi/APPEND_SYSTEM.md`, or `.agents/skills`. A bare `.pi/`
directory does not trigger it.

`approveProjectTrust: true` answers it with `--approve`, which means pi **loads
and executes repository-supplied TypeScript** and runs an npm install for missing
project packages. Treat it exactly as seriously as that sounds.

**Multi-user mode:** for an owner without the privileged-command grant, Codeman
materializes `approveProjectTrust: false` so the pane launches with
`--no-approve` and the prompt never appears. Merely *omitting* `--approve` would
not be a clamp, since pi's own default is to ask and the session user could just
answer yes.

Also worth knowing: `pi auth print-api-key` / `print-bearer-token` and
`pi auth check` mean a pi session can print its own provider credentials by
design. Isolation is Docker.

## tmux extended keys (Shift+Enter)

Pi's editor uses `Shift+Enter` / `Ctrl+Enter` for newline-vs-submit. Without
extended keys, tmux collapses both into a plain `\r`. Upstream recommends:

```tmux
set -g extended-keys on
set -g extended-keys-format csi-u
```

`extended-keys-format` needs tmux 3.5+; on 3.2–3.4 `extended-keys on` alone works
(pi falls back to xterm `modifyOtherKeys`).

Codeman's browser input path sends `\r` for submit, so basic use works
unconfigured — what degrades is newline-in-editor, mostly when you attach to the
pane directly (`codeman tui`).

⚠️ Upstream notes the setting may need a full `tmux kill-server` to take effect.
**Never run `tmux kill-server` on Codeman's socket** — it would kill every live
session, `w1`/`w2`/`w3` included.

**Measured (tmux 3.4, pi 0.84.1): no `kill-server` is needed.** Setting the option
server-scoped on Codeman's own socket takes effect on the ALREADY-RUNNING server;
the next pi session starts without the warning. Existing sessions keep the old
setting until they respawn.

```bash
tmux -L codeman set -s extended-keys on
tmux -L codeman set -s extended-keys-format csi-u   # tmux 3.5+ only, see below
tmux -L codeman show-options -s | grep extended     # verify
```

On **tmux 3.4 and older, `extended-keys-format` does not exist** and the second
line fails with `invalid option: extended-keys-format`. That is harmless — pi
falls back to xterm `modifyOtherKeys` and `extended-keys on` alone silences the
warning. Run the two lines independently rather than chained.

Pi tells you which state it is in: an unconfigured session prints
`Warning: tmux extended-keys is off. Modified Enter keys may not work.` in its
startup banner, so you can verify the change by starting a new pi session.

⚠️ Use `-L <socket>` and `-s`, never `-g` on your default socket, and never
`kill-server`. Codeman does not set this for you: it is a server-wide tmux option
and silently changing key encoding for every session of every backend is not
Codeman's call to make.

## Typing from the browser (local echo)

On touch devices Codeman buffers typed characters in the `LocalEchoOverlay` and
flushes them to the PTY on Enter. Pi gets that `'buffer'` policy, the same as
Claude, Gemini and OpenCode.

This was an explicit open question, because that policy is exactly what broke
Codex (issues #218/#219/#220/#222): Codex's composer reacts per keystroke, so
buffer-until-Enter starved it. **Measured against pi 0.84.1: it does not
reproduce.** Pi's slash-command picker re-filters on the whole composer content
rather than on per-keystroke deltas, so a one-shot flush of `/set` filters the
picker down to `settings` identically to typing it character by character, and
the delayed `\r` then selects it. Prose prompts flush and submit correctly too.

If a future pi release changes that, the cheap fallback is one `'off'` branch in
`_updateLocalEchoState` (terminal-ui.js); teaching `PredictiveEchoAddon` pi's
composer row is the larger follow-up.

## Docker cases

The agent image (`docker/agent.Dockerfile`) installs pi in its own `RUN` step with
`--ignore-scripts`, kept out of the shared npm block so the flag cannot change how
the other four CLIs install. Rebuild with:

```bash
node scripts/build-agent-image.mjs --no-cache   # --no-cache is mandatory
```

Credentials are **seeded**, not shared: `~/.pi/agent/auth.json`, `settings.json`,
`trust.json`, `models.json` and `models-store.json` are mounted read-only and
copied into the container's own `~/.pi/agent`. So an in-container pi never writes
refreshed OAuth tokens back to the host, and `docker commit` exports stay
secret-free. `models.json` is in the list because it holds user-defined custom
providers, which would otherwise silently vanish inside containers.

Only those five files are seeded because `~/.pi/agent` also holds `sessions/`,
`extensions/`, `skills/` and the installed package trees (`npm/`, `git/`), which
on an active host is easily gigabytes.

**Trade-off:** in-container pi sessions are invisible host-side, so `pi -c` inside
a Docker case only sees that container's own history.

## Remote SSH cases

`pi` mode is routed through an interactive login shell
(`exec "$SHELL" -i -l -c 'pi'`), because sshd's remote-command PATH does not
include npm's global bin on most hosts. Per-session config and `envOverrides` do
not cross ssh and are rejected rather than silently ignored; use the per-host
command override instead.

## Known gaps

- **No idle/completion hook.** Pi has no hook system Codeman can install into, so
  idle detection reads the screen: the registry entry's `workDetect` names pi's
  composer rule (`─`) as the glyph that arms the idle check and the spinner pi embeds
  in that rule while a turn runs (`── ⠏ Working ───`) as the working line, measured
  on pi 1.1.0. Without it a pi session that had started a turn never left `busy`,
  since pi never draws Claude's `❯`. Pi 0.84.0 shipped an `agent_settled` extension
  event that is a genuine idle signal; a Codeman pi extension using it is still the
  highest-value follow-up.
- **No response viewer.** Pi writes JSONL v3 session files under
  `~/.pi/agent/sessions/`; nothing reads them yet.
- **Cron jobs mis-detect readiness.** The cron readiness poll looks for `❯` or a
  token count, neither of which pi prints, so a pi cron job burns its poll budget
  and then sends the prompt anyway. It works; it is just slower to start.
- **Ralph, respawn heuristics, token/CLI-info parsing and the `❯` readiness probe
  are off** for pi, as for every external CLI.
