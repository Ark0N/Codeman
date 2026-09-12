# OMP (Oh My Pi) sessions

Codeman can drive [OMP](https://github.com/can1357/oh-my-pi) (`omp`, Oh My Pi) as a session
backend, alongside Claude Code, OpenCode, Codex, Gemini, Antigravity, Pi, Grok and
DeepSeek Harness. `omp` is the ninth CLI backend (tenth `SessionMode`, counting
`shell`): its own PTY, its own tmux session, its own tab identity. It is not a
location overlay like Docker or remote-SSH cases, and it is not a web tab.

## Install

```bash
curl -fsSL https://omp.sh/install | sh
```

The installer places the binary in `~/.local/bin` (verified against a real
`--no-cache` Docker build — see `docker/agent.Dockerfile`; an earlier guess of
`~/.omp/bin` was wrong). Codeman resolves the binary via the server PATH and then
the usual install locations (`~/.local/bin` first, then `~/.omp/bin`,
`/usr/local/bin`, `~/.bun/bin`, `~/.npm-global/bin`, `~/bin`).

**`omp` is a short name**, so like `pi` and `grok` the resolver does not trust a PATH
hit on its own: it runs `omp --version` and requires `omp/<semver>`-shaped output
(e.g. `omp/18.0.8`) before accepting a candidate. Check what it resolved:

```bash
curl -s localhost:3000/api/omp/status | jq
# { "available": true, "path": "/home/you/.local/bin", "version": "18.0.8" }
```

## Authenticate

OMP owns its own auth and provider configuration entirely in `~/.omp` — there is
no Codeman-side login flow, API key field, or bypass switch to configure. Run `omp`
directly once outside Codeman to complete whatever onboarding the CLI itself asks
for; every session started through Codeman afterward inherits that config.

## What Codeman wires up

`OmpConfig` (per session, persisted in `state.json`, round-trips through respawn):

| Field              | Flag            | Notes                                                     |
| ------------------ | --------------- | ---------------------------------------------------------- |
| `model`            | `--model <v>`   | Regex-validated (`[a-zA-Z0-9._-/]+`); `provider/model` forms like `crof/glm-5.2` pass |
| `continueSession`  | `--continue`    | omp's own "most recent conversation in this directory" heuristic |
| `resumeSessionId`  | `--resume <id>` | Ids only, id-regexed; wins over `--continue` when both are present |

Every value is regex-validated and **dropped** (not escaped) if it fails, because the
result is interpolated into the pane's spawn command.

**omp reads its own model routing and hooks from `~/.omp`, so no trust or
permission flags are needed** — unlike every sibling CLI in this family, there is no
bypass-permissions equivalent to wire up, so `buildOmpCommand()` only ever passes
`--model`/`--resume`/`--continue`. ⚠️ That does NOT mean omp is unrestricted: its
documented default `tools.approvalMode` is `yolo`, so an omp pane auto-approves exec
with no flag from Codeman — the CLI's own config, not Codeman, is what would need to
change that.

Env overrides: the `OMP_*` prefix is allowlisted, and per omp's own
`docs/environment-variables.md` it is not the narrow surface it looks like. omp reads
roughly 40 provider keys from the environment (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`,
`XAI_API_KEY`, `HF_TOKEN`, ...) — pi's 34-key problem in the same shape — which is why
none of those get a dedicated allowlist entry; a session authenticates from `~/.omp`
config or the server process's own env instead, like pi. omp's own documented knobs
are mostly `PI_*`, not `OMP_*` (`PI_CONFIG_DIR`, `PI_CODING_AGENT_DIR`,
`PI_CODING_AGENT_SESSION_DIR`, `PI_SUBPROCESS_CMD`, `PI_SHELL_PREFIX`,
`OMP_PROFILE`/`PI_PROFILE`), and `PI_*` is already allowlisted globally because pi
mode needs it — so an omp session today already accepts all of those. The first three
also move the tree `omp-session-resolver.ts` and `omp-transcript.ts` hardcode
(`resolveOmpHome()` assumes `~/.omp` unconditionally), so pinning and history quietly
stop working under a redirected config root; this is a known gap, not fixed here.

The `OMP_` prefix itself brings in `OMP_AUTH_BROKER_URL` / `OMP_AUTH_BROKER_TOKEN`,
where omp resolves credentials from — the same shape `DEEPSEEK_BASE_URL` is dropped
for in `clampEnvOverridesForOwner()` (session-routes.ts), so both are clamped there
for a non-granted owner in multi-user mode. None of this matters in single-user mode.

## Exact-id pinning: why `--resume`, not just `--continue`

`--continue` alone is ambiguous the moment **any** other omp conversation has
touched the same working directory more recently — it just picks the newest session
file on disk, silently. That happens routinely: a closed-then-resumed Codeman row
plus a still-running duplicate, two Codeman sessions pointed at the same case, or a
plain reattach after a server restart.

`src/utils/omp-session-resolver.ts` resolves and **pins** the exact conversation id
once (`findLatestOmpSessionId()` reads `~/.omp/agent/sessions/<mangled-workingDir>/`,
the newest `.jsonl` file's embedded uuid), then every later respawn reuses that
pinned id via `--resume` instead of re-guessing with `--continue`.

⚠️ **The directory mangling is NOT a straight `/` → `-` replace.** Unlike Claude
Code's `~/.claude/projects/*` convention (which keeps the full path, e.g.
`-home-user-codeman-cases-foo`), omp strips the `$HOME` prefix FIRST and only then
dash-replaces (`/home/user/codeman-cases/foo` → `-codeman-cases-foo`; a path outside
`$HOME`, like `/tmp/...`, is dash-replaced as-is with no stripping). Getting this
wrong doesn't error — `findLatestOmpSessionId()` just silently returns null for
every case under `$HOME` (virtually all real Codeman cases), so pinning quietly
degrades to omp's own ambiguous `--continue`. This was found and fixed 2026-08-27
after months of testing had only ever exercised `/tmp`-based working directories,
where the bug's wrong output happened to coincidentally match the right one.

## Surviving a full session kill

`src/omp-transcript.ts` scans `~/.omp/agent/sessions/**/*.jsonl` directly — a second,
independent history source alongside Codeman's own state. This means an OMP
conversation's history (working directory, first/last prompt, size) is recoverable
in the Past Sessions list even when **both** the Codeman session record and the
underlying tmux pane are gone — verified live against a full OS reboot, not just a
"Kill Tmux" button click.

## Terminal behavior

OMP renders inside tmux like every external CLI (narrow scrollback strip — alt-screen
toggles only, not the full Claude/Codex/Gemini strip). It stays out of the
alt-screen-strip list and lands on the `'buffer'` local-echo policy via the
`_updateLocalEchoState` fallthrough, same as grok and pi.

## Docker cases

The agent image installs omp in its own Dockerfile step (not npm; omp's installer
targets `$HOME/.local/bin` with no `--dir` override, the same shape as grok's
installer). Rebuild with the mandatory `--no-cache`:

```bash
node scripts/build-agent-image.mjs --no-cache
```

⚠️ **`--resume` pinning does not currently reach an in-container omp process.**
Docker panes are built from `defaultDockerCommandForMode`, which never sees
`ompConfig` — `appendResumeFlag()`'s `case 'omp'` keys off the top-level
`resumeSessionId` field, which nothing populates for omp today. Host-side history
recovery still works (the shared `sessions/` mount below), but a respawned
in-container omp pane falls back to its own ambiguous `--continue`, not a pinned
id. Flagged in upstream review, not yet fixed.

Credentials are **mostly seeded**, but `sessions/` is the one exception in this CLI
family: `~/.omp/agent/{config.yml,mcp.json,models.yml,settings.yml}` are seeded
(read-only mount, copied into the container's own `~/.omp/agent` once), so an
in-container omp never writes refreshed config back to the host and `docker commit`
exports stay secret-free. But `~/.omp/agent/sessions/` is **shared (RW)**, not
seeded — the same treatment as codex's `sessions/`, and for the identical reason:
Codeman reads it host-side (`omp-transcript.ts`, `omp-session-resolver.ts`) for
history recovery and `--resume` pinning. Seeding it instead of sharing it would make
an in-container OMP conversation invisible to Codeman's own history/resume logic,
silently breaking Docker support for the kill-survival feature above. The rest of
`~/.omp/agent` (`agent.db`/`history.db`/`models.db` SQLite caches,
`terminal-sessions/`, `blobs/`, `cache/`) stays container-local and is neither
shared nor seeded.

## Remote SSH cases

`omp` mode is routed through an interactive login shell
(`exec "$SHELL" -i -l -c 'omp'`), because sshd's remote-command PATH does not
include `~/.local/bin`. Per-session config and `envOverrides` do not cross ssh and are
rejected rather than silently ignored; use the per-host command override instead.

⚠️ A **respawn or reattach** of a remote omp session runs `omp --continue`, not a
bare `omp`, so it lands back in the same conversation. It is deliberately
`--continue` rather than the exact `--resume <id>` the local and docker paths
pin: `omp-session-resolver.ts` only ever reads THIS host's `~/.omp/agent/sessions/`,
and a remote conversation's session file lives on the remote host under the
remote user's home, so resolving locally would pin a stranger's id. See
[Respawn / reattach continuation](remote-sessions.md#respawn--reattach-continuation).

## Known gaps

- **No idle/completion hook.** Idle detection falls back to output-stabilization
  like every other external CLI. If omp ever ships a hooks system, a Codeman hook
  POSTing to `/api/hook-event` would be the highest-value follow-up.
- **Killing a pane mid-turn loses the conversation for real.** `tmux kill-session`
  before an in-TUI `/exit` beats omp's own session-file flush — confirmed by direct
  testing (kill after a clean `/exit` resumes correctly; kill without `/exit` first
  does not). This is not something Codeman can compensate for from outside the
  process; it would need an upstream omp fix (e.g. flush-on-SIGTERM).
- **Unverified: `$HOME` as a symlink.** The directory-mangling fix above compares
  against the literal `homedir()` string, not a `realpath()`-resolved one. Whether
  omp itself canonicalizes symlinks before mangling is unconfirmed — this has not
  been tested against a symlinked-home setup.
- Ralph, respawn heuristics, token/CLI-info parsing and the `❯` readiness probe are
  off for omp, as for every external CLI.
