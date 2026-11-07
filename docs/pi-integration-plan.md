# Pi (pi.dev) Run Mode: Implementation Plan

Tracking issue: [#206 "Plans to support pi.dev?"](https://github.com/Ark0N/Codeman/issues/206)

**SUPERSEDED in part (PR #771, 2026-11):** what this record says about pi's default screen and
the strips no longer holds. Fullscreen became pi's default in 1.0.0, and pi now takes the mouse
strip (`altScreen: 'strip-mux-and-mouse'`). Each affected passage carries a SUPERSEDED note;
current behaviour is in `docs/pi-integration.md` and the "Pi is the same shape" paragraph of
`docs/architecture-invariants.md`.

Status: **IMPLEMENTED 2026-08-13** (see `docs/pi-integration.md` for the user-facing
guide). Everything below is the design record; the open questions were resolved
empirically against pi 0.84.1 and the answers are recorded inline as **RESULT**
notes. Originally reworked 2026-08-06; **rechecked 2026-08-13 against master @
`f39beb3` (v1.17.0)**, and every line anchor below was re-verified at that commit (the 1.11.2-era
anchors drifted heavily: six releases landed in between, including the settings-surface overhaul and
the codex predictive-echo work, both of which added new pi touchpoints, §2.10 and the Brain picker in
Phase 3). Upstream facts verified against `@earendil-works/pi-coding-agent` **v0.84.1** (npm latest,
published 2026-08-07) and the [`earendil-works/pi`](https://github.com/earendil-works/pi) repo (cite
that name: upstream docs still contain stale `pi-mono` links from a repo rename). Line numbers are
anchors for orientation, not contracts; they drift.

---

## 1. What Pi is

[Pi](https://pi.dev) (MIT) is a minimal, extensible coding-agent harness. Facts below are verified
against the upstream docs in `packages/coding-agent/docs/`.

| Property         | Value                                                                                              |
| ---------------- | -------------------------------------------------------------------------------------------------- |
| Binary           | `pi` (`bin: { pi: 'dist/cli.js' }`)                                                                |
| npm package      | `@earendil-works/pi-coding-agent`, latest **0.84.1** (2026-08-07; 0.84.0 was 2026-08-06); `legacy-node20` dist-tag at 0.74.2 |
| Install          | `npm install -g --ignore-scripts @earendil-works/pi-coding-agent`, or `curl -fsSL https://pi.dev/install.sh \| sh` (the curl installer also goes through global npm, so both uninstall via npm) |
| Config dir       | `~/.pi/agent` (override: `PI_CODING_AGENT_DIR`). Holds `auth.json`, `trust.json`, `settings.json`, `models.json` (user-defined providers), `models-store.json` (cached catalogs), `keybindings.json`, `extensions/`, `skills/`, `prompts/`, `themes/`, `AGENTS.md`, `SYSTEM.md`, and the package trees `npm/` + `git/` |
| Sessions         | `~/.pi/agent/sessions/--<cwd with / replaced by ->--/<timestamp>_<uuid>.jsonl`, tree-structured (`id`/`parentId`), format v3. Overrides: `PI_CODING_AGENT_SESSION_DIR`, `--session-dir` |
| Credentials      | `~/.pi/agent/auth.json` (OAuth subscriptions + API keys, auto-refresh), plus ~34 provider env vars with **no common prefix**. 0.84.1 adds `pi auth check` (auth preflight with optional credential output) |
| TUI              | Default: **main screen with terminal-owned scrollback**. Since **0.84.0** an experimental fullscreen mode exists, selectable via `--tui-mode fullscreen` **or at runtime through `/settings`**; the default remains the main-screen mode. **SUPERSEDED (PR #771, 2026-11):** fullscreen is the default since pi 1.0.0, and `tuiMode: regular` keeps the main screen |
| Providers        | 15+ (Anthropic, OpenAI, Google, Azure, Bedrock, Mistral, Groq, xAI, OpenRouter, Copilot, Baseten since 0.84.0, ...). OAuth subscription login via `/login` for six: ChatGPT Plus/Pro, Claude Pro/Max, GitHub Copilot, xAI, OpenRouter, Radius |
| Permission model | **No permission prompts at all.** No built-in sandbox, no MCP (none planned), no sub-agents, no plan mode, no to-dos, no background bash. Tools run with the user's own permissions |
| Trust model      | "Project trust" gates **loading** of project-local `.pi/` config/extensions/skills and **installing missing project packages**, not tool execution. Triggered only when the cwd (or an ancestor) contains `.pi/settings.json`, `.pi/extensions\|skills\|prompts\|themes`, `.pi/SYSTEM.md`/`.pi/APPEND_SYSTEM.md`, or `.agents/skills`; a bare `.pi/` directory does NOT prompt. Global `defaultProjectTrust`: `ask` (default) / `always` / `never` |

Three consequences shape the whole integration:

1. **There is no `--dangerously-skip-permissions` analog and none is needed.** Pi never prompts for
   tool approval. The Claude/Codex/Gemini/Antigravity pattern of "send the bypass flag so the session
   is not stuck on a modal" does not apply. Codeman must not invent a flag here.
2. **The one privileged knob is `--approve` / `-a`** (trust project-local files for this run), which
   makes pi load and execute project `.pi/extensions` TypeScript **and run an npm install of missing
   project packages**. That is the field the multi-user clamp has to cover. Its explicit inverse
   `-na` / `--no-approve` exists, which lets the clamp force-deny rather than merely omit (§3, §5.2).
3. **Provider keys cannot ride the env allowlist.** Pi's provider key vars (`ANTHROPIC_API_KEY`,
   `OPENAI_API_KEY`, `DEEPSEEK_API_KEY`, `HF_TOKEN`, `BASETEN_API_KEY`, ...) share no prefix, so
   there is no way to admit them through `ALLOWED_ENV_PREFIXES` without widening the list for every
   mode (§2.4).

---

## 2. Design decisions

### 2.1 Mode identity

`SessionMode` gains `'pi'`. Not a location overlay (unlike Docker/remote-SSH cases), not a web tab:
a real sixth CLI backend with its own PTY, tmux session and respawn behaviour, exactly like
`antigravity`. Append `pi` after `antigravity` in every enum/list to keep ordering consistent.

| Surface          | Value                                                                 |
| ---------------- | --------------------------------------------------------------------- |
| `SessionMode`    | `'pi'`                                                                |
| Display label    | `Pi`                                                                  |
| Tab badge        | `pi` (two-letter lowercase, like `sh`/`oc`/`cx`/`gm`/`ag`)            |
| Run button label | `Run PI` (short-label ternary in `_applyRunMode`, pattern `Run AG`)   |
| Kill-menu label  | `Kill Tmux & Pi`                                                      |
| Identity color   | **`#f472b6` (rose-400)**. Verified free: live computed values on the default skin are claude `#38b6f0`, opencode `#44b993`, codex `#2b8fd9`, gemini `#8ab4f8`, antigravity `#22d3ee`, shell `#98a2b1`, web `#38bdf8`; purple is codex's base hex and amber reads as the shell tab badge, so pink/rose (or orange `#fb923c`) are the only genuinely free hues. No `pi` CSS identifier collides anywhere (`mode-pi`, `.tab-mode.pi`, `.run-mode-dot.pi` all grep clean, re-checked at f39beb3) |
| Env prefix       | `PI_`                                                                 |
| Dependency id    | `pi`                                                                  |
| Status endpoint  | `GET /api/pi/status`                                                  |

### 2.2 `isExternalCliMode()` yes, `isAltScreenStripMode()` no

Pi joins `isExternalCliMode()` (`session.ts:164-167`): its own TUI, its own output format, so the
Ralph tracker, `BashToolParser`, token/CLI-info scraping and the `❯` readiness probe all stay off
(gates at `session.ts:1100`, `:1701`, `:2000`, `:2103`), and readiness falls back to the output
stabilization used by the other external CLIs.

Pi stays **out** of `isAltScreenStripMode()` (`session.ts:197-199`, currently codex/claude/gemini;
antigravity and opencode are deliberately excluded). Pi's default TUI renders into the main screen
with terminal-owned scrollback, so there is nothing to strip. The fullscreen mode **shipped in
0.84.0 and is runtime-switchable via `/settings`**, so Codeman cannot assume a pi session stays
main-screen for its lifetime; staying out of the strip list is exactly what makes that safe (the alt
screen is load-bearing when the user flips to fullscreen, as it is for `opencode`). Putting pi IN
the strip list would corrupt fullscreen sessions. Three mirrors must stay consistent (all unchanged
for pi, i.e. pi appears in none of them): the replay-side strip in `session-routes.ts:2275`, the
live-stream twin in `session.ts`, and the frontend `_sessionUsesServerMouseStrip()` in
`terminal-ui.js` (usages `:3432`, `:3697`).

**SUPERSEDED (PR #771, 2026-11):** pi still stays out of `isAltScreenStripMode()`, but it is no
longer outside every strip: it takes the mouse strip (`isMuxMouseStripMode()`), which removes the
alt-screen toggles and the mouse enables and keeps `3J`. Fullscreen is its default since 1.0.0, the
enables are recorded as `cliMouseTracking`, and the wheel is forwarded from that flag, so it survives
a tab switch or reload. A `/settings` flip of `tuiMode` is followed in both directions.

### 2.3 tmux required, no direct-PTY fallback, no per-mode configurator

Same rule as the other external CLIs: `pi` mode throws if tmux is unavailable. Add a fourth block to
the guard chain at `session.ts:1751-1768` (antigravity's is `:1765-1768`).

**No `_configurePi()` is needed.** Opencode/codex/gemini each have a tmux-`setenv` configurator
(`tmux-manager.ts:1709-1727`), but antigravity has none: it relies entirely on the generic
`applyEnvOverrides()` (`tmux-manager.ts:1643`, `VALID_KEY = /^[A-Z_][A-Z0-9_]*$/`), which runs for
every mode in both create (`:1880`) and respawn (`:2107`) and injects via socket-scoped
`tmux setenv`, never the spawn command line. Pi follows the antigravity precedent: `PI_*` overrides
flow through `applyEnvOverrides()` and nothing else.

Pi joins the truecolor branches: `buildEnvExports()` (`tmux-manager.ts:1604-1609`,
`export COLORTERM=truecolor` + `unset NO_COLOR` for codex/gemini/antigravity) and the attach-env
condition at `session.ts:1400-1402` (`buildMuxAttachEnv(...)`, whose comment says it must mirror
`buildEnvExports`). Add `|| mode === 'pi'` to both, or the tmux session and the attach client
disagree about color depth.

### 2.4 Env prefix: `PI_` only

Add `'PI_'` to `ALLOWED_ENV_PREFIXES` (`schemas.ts:125`) and to the prose error message at `:163`
(two edits: the message hardcodes the list, and since 1.12+ it also names the exact-key allowlist,
currently `...ANTIGRAVITY_* keys and CLAUDE_CONFIG_DIR are allowed.`; there is now a separate
`ALLOWED_ENV_KEYS` exact-key set alongside the prefix list, which pi does not need to touch). That
covers every documented variable pi reads: `PI_CODING_AGENT_DIR`, `PI_CODING_AGENT_SESSION_DIR`,
`PI_PACKAGE_DIR`, `PI_OFFLINE`, `PI_SKIP_VERSION_CHECK`, `PI_TELEMETRY`, `PI_CACHE_RETENTION`,
`PI_SHARE_VIEWER_URL`, `PI_HARDWARE_CURSOR`, `PI_EXPERIMENTAL` (whose meaning 0.84.0 extended to
strict JSON-schema tool sampling). (Pi also *sets* `PI_CODING_AGENT=true` and `AI_AGENT=pi` in child
processes; those are output markers, not inputs, and need nothing from us.)

**Deliberately not added:** `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, `XAI_API_KEY`,
`GROQ_API_KEY`, `MISTRAL_API_KEY` and the other ~28 provider keys. `ALLOWED_ENV_PREFIXES` is a
single global list applied by one Zod refine with no mode context (`safeEnvOverridesSchema`,
`schemas.ts:153-165`), so allowlisting bare provider keys for pi would widen the allowlist for
**every** mode at once, violating the multi-CLI prefix discipline in CLAUDE.md. Users authenticate
pi through `/login` (stored in `~/.pi/agent/auth.json`, auto-refreshed) or by exporting the key in
the Codeman server process's own environment.

Making the allowlist mode-aware is the clean fix, listed as a follow-up in §9. Do not smuggle it
into this change.

### 2.5 Docker credential policy: seed files, not the whole dir

`CRED_STORES` (`docker-hosts.ts:597-605`; file unchanged since the 2026-08-06 verification) gets a
`.pi/agent` entry. Nested `rel` paths already work (`.config/gcloud` maps to seed name
`.config-gcloud` via the `replace(/\//g, '-')` at `:620`). Unlike antigravity, which needed **no**
entry (`agy` nests all state under `~/.gemini/antigravity-cli/`, already covered by the `.gemini`
policy, per the comment at `:599-602`), pi has its own top-level dir and needs its own entry. Use
`seedFiles`, **not** `seedWhole`:

```ts
{ rel: '.pi/agent', seedFiles: ['auth.json', 'settings.json', 'trust.json', 'models.json', 'models-store.json'] },
```

Rationale: `~/.pi/agent` also contains `sessions/`, `extensions/`, `skills/` and the installed
package trees (`npm/`, `git/`), which on an active host is easily gigabytes; `seedWhole` would
`cp -a` all of it into every container start. The five seeded files are what pi needs to
authenticate and behave consistently: `models.json` is in the list because it holds user-defined
custom providers, and omitting it would silently strip those inside containers. Seeding (RO mount
then copy) also means the in-container pi never writes refreshed OAuth tokens back to the host,
which is the whole point of the seeding policy, and bind mounts stay excluded from `docker commit`
so exports remain secret-free.

Trade-off to accept and document: in-container pi sessions are not visible host-side, so `pi -c`
inside a Docker case only sees that container's own history. Codex shares `sessions/` RW precisely
because Codeman reads it host-side for the response viewer; there is no such reader for pi yet
(the response-viewer follow-up in §9 would justify flipping this).

### 2.6 The `pi` binary name is generic

Unlike `agy`/`codex`/`gemini`, `pi` is a short, common name (Raspberry Pi tooling, personal scripts,
`$PATH` accidents). The resolver must not blindly trust a hit. None of the existing external-CLI
resolvers execute their binary (only `claude-cli-resolver.ts` does, via the cached
`getClaudeCliVersion()`, skipped under vitest), so the sanity check is new ground: model it on
`getClaudeCliVersion()`. Run `pi --version` once via `execFileSync`, cache the result module-level,
skip under `VITEST`, and require output matching `/^\d+\.\d+\.\d+/`; on mismatch treat the binary as
unavailable and log the rejected path. Surface `{ available, path, version }` from
`GET /api/pi/status` so a misresolution is diagnosable from the UI (additive relative to the sibling
endpoints' `{ available, path }`). The `dependency-registry` entry carries `versionArg: '--version'`
for `codeman doctor`.

### 2.7 tmux extended keys (a real pi-specific footgun)

Pi documents (`docs/tmux.md`, verified verbatim) that without

```tmux
set -g extended-keys on
set -g extended-keys-format csi-u
```

tmux collapses `Shift+Enter` and `Ctrl+Enter` into a plain `\r` (and `Alt+Enter` into `\x1b\r`), and
pi's editor uses those for newline vs submit. `extended-keys-format` requires tmux 3.5+; tmux
3.2-3.4 works with `extended-keys on` alone (pi then falls back to xterm `modifyOtherKeys`).
Codeman's own browser input path sends `\r` for submit, so basic use works unconfigured, but
newline-in-editor is degraded both for a user typing in an attached terminal (`sc`) and potentially
for the browser Shift+Enter path.

Upstream recommends `~/.tmux.conf` and notes the setting may need a full `tmux kill-server` restart
to take effect. **Codeman must NEVER run `kill-server` on its socket** (it would kill every live
session, including `w1`/`w2`/`w3`). Action: attempt to set both options **server-scoped on
Codeman's own socket only** (`tmux -L codeman set -s ...`, never `-g` on the user's default socket)
at the point the tmux server is first started, verify with `tmux -L codeman show-options -s` and an
empirical Shift+Enter test which scope actually takes for the installed tmux version, and fall back
to a documented manual step in `docs/pi-integration.md` (a `~/.tmux.conf` snippet plus the
kill-server caveat) if it cannot be applied safely to an already-running server. Upstream does not
discuss socket- or server-scoped configuration at all, so this verification is original work, not a
doc lookup.

**RESULT (measured, tmux 3.4 + pi 0.84.1):** `tmux -L <socket> set -s extended-keys on` takes effect
on an **already-running** server with **no `kill-server`** — pi's own startup warning
(`Warning: tmux extended-keys is off…`, a convenient in-band probe) disappears for the next session
started afterwards. `extended-keys-format` does **not exist on tmux 3.4** and errors with
`invalid option: extended-keys-format`, so the two options must be issued independently rather than
chained. Decision: Codeman does **not** set this itself — it is a server-wide tmux option affecting
every session of every backend, so silently changing key encoding is not Codeman's call. It is
documented as a user step in `docs/pi-integration.md` instead, carrying the measured facts.

### 2.8 The completeness trap: which mode tables fail loud vs silent

Adding `'pi'` to the `SessionMode` union makes some omissions compile errors and leaves others
silent. The plan calls this out so review can focus on the silent ones.

**Loud (typecheck fails until edited):** `getModeLabel()` (`session.ts:168-183`, exhaustive switch
with no default), `defaultDockerCommandForMode` and `defaultRemoteCommandForMode` (both typed
`Record<...CommandMode, string>`), **but only after** `RemoteCommandMode` (`types/session.ts:48-51`)
and `DockerCommandMode` (`:157-161`) are widened: both are `Extract<SessionMode, '...'>` with every
member spelled out, so forgetting the `Extract` lists keeps `tsc` green while docker/remote pi cases
silently fall back to `exec bash -l` via the `|| commands.shell` on the lookup. Edit union + both
`Extract` lists + both `Record` literals together.

**Silent (compiles clean, mode just doesn't work):**

- `appendResumeFlag()` (`tmux-manager.ts:1030-1042`) has a `default:` arm; a missing `case 'pi'`
  silently drops docker resume.
- `buildSpawnCommand()` (`:770-825`) and `buildPathExport()` (`:1680-1707`) are if-chains with
  fallthrough returns; a missing branch spawns pi as a login shell / with no PATH augmentation.
- `isExternalCliMode()` / `isAltScreenStripMode()` are boolean chains.
- The `runMode` accessor's **setter whitelist** (`session-ui.js:2949-2960`) coerces any unknown mode
  to `'claude'`. Omitting `pi` there makes the mode **unselectable while every other edit appears to
  work**: this is the single most deceptive omission in the frontend.
- `window.__codemanCliAvailable` (injected by `renderIndexHtml`, `server.ts:1375-1407`): the client
  treats a **missing key as available** (`isCliAvailable` in settings-ui.js), so forgetting the
  injection un-gates pi on boxes without the CLI instead of hiding it.

### 2.9 The Daylight skin cascade eats per-mode run-button colors

A finding that changes the CSS work (verified empirically with computed styles on the live
instance, re-confirmed at f39beb3): `styles.css:13681` opens a nested skin block,
`html:not([data-skin="og"]) { ... }`, and the **default skin is `daylight-blue`, not `og`**, so the
block is live for every default-skin user. Inside it, `.btn-toolbar.btn-run` is re-declared
generically and per-mode only for claude/opencode/codex (codex at `:13787`). CSS nesting adds the
wrapper's specificity (the nested rules resolve to (0,3,1) vs (0,3,0) for
`.btn-toolbar.btn-run.mode-X`), so **gemini's and antigravity's toolbar gradients are dead on the
default skin**: both render the generic claude gradient today, still unfixed as of f39beb3. The
base-sheet rules (gemini/antigravity at `:4406`/`:4420`) only ever render on the `og` skin. Since
1.12+ styles.css itself documents this trap in comments (`:9214`, `:11091`), which confirms the
mechanism.

Consequences for pi:

- The toolbar gradient needs **two** rules: one in the base sheet (`:4420` area, for `og`), and one
  **inside** the `13681` block next to codex's (`:13787` area), using the block's own idiom
  (or the color is invisible to the average user).
- `mobile.css` phone-toolbar colors need `!important` on `background`/`border-color`/`color`,
  exactly as the CLAUDE.md gotcha prescribes. Antigravity's phone block (`mobile.css:895-910`,
  inside the `@media (max-width: 430px)` opened at `:338`) has no `!important` and is dead on the
  default skin; do not copy that mistake.
- Three surfaces work from base rules alone (verified): run-mode **dots** (list at `:4506-4516`;
  the skin block overrides only claude/opencode/codex/shell dots, so a base-sheet
  `.run-mode-dot.pi` renders as authored), **tab badges**, and the **welcome button** (the skin
  block overrides only claude/opencode/tunnel welcome buttons).
- Optional, separate cleanup (not this change): gemini/antigravity could get the same in-block
  treatment to resurrect their colors.

### 2.10 Local-echo policy: pi lands on the buffer overlay by default

New since the first draft of this plan: the codex predictive-echo work (1.13+) introduced a
per-session echo policy in `_updateLocalEchoState()` (terminal-ui.js, `_localEchoPolicy` set at
`:2837`): `codex → 'predict'` (write-through predictive echo), `shell → 'off'`, **everything else
→ 'buffer'** (the `LocalEchoOverlay` that buffers typed text until Enter). Pi therefore gets the
buffer overlay on touch devices with zero edits, via the fallthrough.

That default is a real open question, not a freebie: the codex history (issues #218/#219/#220/#222)
shows that a composer which re-renders per keystroke (live-filtering slash picker, server-side
cursor movement, wrap-as-you-type) is starved by buffer-until-Enter, and pi's editor is exactly
such a composer. Decision for v1: ship with the default `'buffer'` policy but make phone-profile
typing an explicit E2E gate (§7 step 4); if pi's editor mis-renders under the overlay, the cheap
fallback is forcing `'off'` for pi (one branch in `_updateLocalEchoState`), and teaching the
predict path pi's composer row is a follow-up, not a v1 requirement.
`test/local-echo-codex-gating.test.ts` pins the per-mode policy via
`it.each(['claude', 'gemini', 'opencode'])` lists (`:193`, `:376`); add `'pi'` to those lists once
the buffer decision is confirmed (or pin the `'off'` branch if that is the outcome).

**RESULT (measured, pi 0.84.1, iPhone 14 Pro profile + a PTY-level A/B):** the buffer policy
**holds**; codex's failure mode does **not** reproduce. Pi's slash picker re-filters on the **whole
composer content**, not on per-keystroke deltas: a one-shot literal write of `/set` (what the overlay
flush does) filters the picker to `settings` **identically** to sending `/ s e t` as five separate
keystrokes, and the delayed `\r` then selects it and opens the settings menu. Prose prompts buffer
correctly (`pendingText` right, nothing on the PTY before Enter), flush on Enter, and are accepted as
a single prompt. `'pi'` was added to both `it.each` lists. The `'off'` fallback stays documented but
unused.

---

## 3. Config surface: `PiConfig` to CLI flags

```ts
/** Pi CLI session configuration */
export interface PiConfig {
  /** Model pattern or ID. Supports `provider/id` and a `:<thinking>` suffix (e.g. `sonnet:high`). Passed via --model. */
  model?: string;
  /** Provider name (anthropic, openai, google, ...). Passed via --provider. */
  provider?: string;
  /** Reasoning level. Passed via --thinking. */
  thinking?: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  /** Continue the most recent session (-c). Per-cwd scoping is strongly implied upstream but not documented; treat as probable. */
  continueSession?: boolean;
  /** Resume a specific session by ID or partial UUID (--session). Codeman deliberately accepts ids only, never paths. */
  resumeSessionId?: string;
  /**
   * Tri-state project trust (repo-local `.pi/` settings/extensions/skills, plus installing
   * missing project packages):
   *   true  -> --approve   (trust for this run; loads and EXECUTES repository TypeScript)
   *   false -> --no-approve (force-deny; the trust prompt never appears)
   *   absent -> pi's own defaultProjectTrust (ask).
   * Multi-user: MATERIALIZED to false for non-granted owners (§5.2).
   */
  approveProjectTrust?: boolean;
}
```

Flag mapping in `buildPiCommand()` (new, `tmux-manager.ts`, directly after `buildAntigravityCommand`
at `:718-736`; every builder there regex-allowlists each user value and silently drops failures
because the result lands in a `bash -c "..."` string):

| Field                 | Flag                            | Validation                                                                        |
| --------------------- | ------------------------------- | --------------------------------------------------------------------------------- |
| `approveProjectTrust` | `--approve` / `--no-approve` / nothing | tri-state boolean, clamped (§5.2)                                          |
| `model`               | `--model <v>`                   | `/^[a-zA-Z0-9._\-/:]+$/` (`:` for `sonnet:high`, `/` for `openai/gpt-4o`)         |
| `provider`            | `--provider <v>`                | `/^[a-z0-9-]+$/`                                                                  |
| `thinking`            | `--thinking <v>`                | runtime allowlist of the 7 enum values (defense in depth beyond Zod)              |
| `resumeSessionId`     | `--session <v>`                 | `/^[a-zA-Z0-9._-]+$/` (same shape as `RESUME_ID_SAFE`, `:1021`; excludes paths on purpose) |
| `continueSession`     | `-c`                            | boolean; **skipped when a valid `resumeSessionId` is present** (the two conflict) |

**Not** wired in v1, with reasons:

- `--api-key <key>`: ⚠️ **never wire this.** It puts a provider secret on the spawn command line,
  which is exactly what the socket-scoped `tmux setenv` discipline exists to prevent (visible in
  `ps`, tmux server state, and logs). Listed here so nobody "helpfully" adds it later.
- `--tui-mode` (released in 0.84.0): never passed by Codeman. The main-screen default is the
  friendly case for the browser terminal, and fullscreen remains the user's own runtime choice via
  `/settings` (§2.2 is designed for that). `--use-theme` (still unreleased) likewise.
  **SUPERSEDED (PR #771, 2026-11):** still never passed, but fullscreen is the default since pi 1.0.0.
- `--name <name>` (`-n`): nice for `/resume` readability, but names contain spaces and would be the
  first user-controlled value needing real shell quoting in `buildSpawnCommand`. Defer.
- `--no-session`: ephemeral mode fights respawn/resume. Defer.
- `-p`/`--print`, `--mode json`, `--mode rpc`: non-interactive transports, a different product shape
  (§9). Note upstream already shipped a breaking change to JSON-mode `message_update` framing, so
  any future consumer must assemble deltas.
- `--tools` / `--exclude-tools` / `--no-tools` / `--no-builtin-tools` (`-t`/`-xt`/`-nt`/`-nbt`): a
  genuinely useful "read-only session" affordance (0.84.0 also added a `defaultTools` setting), but
  it needs UI design. Follow-up.
- `-r`/`--resume` (interactive picker), `--fork`, `-e`/`--extension`, `--skill`, `--system-prompt`,
  `--append-system-prompt`, `--export`, `--models`, `--list-models`: not session-manager concerns in
  v1. (`-e` matters later: §9's extension follow-up notes CLI extensions load before trust
  resolution.)

---

## 4. Implementation phases

### Phase 1: Backend core

| File                                | Change                                                                                                       |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `src/utils/pi-cli-resolver.ts`      | **New**, mirror `antigravity-cli-resolver.ts` (65 lines: search-dir list, module-level cache with `''` negative sentinel, `which pi` first). Search dirs: `~/.local/bin`, `/usr/local/bin`, `~/.bun/bin`, `~/.npm-global/bin`, `~/bin`. Add the `pi --version` sanity probe from §2.6 (execFileSync, cached, vitest-skipped). Export `resolvePiDir()`, `isPiAvailable()`, `getPiCliVersion()` |
| `src/utils/index.ts`                | Re-export the three (resolver block `:30-36`)                                                                |
| `src/types/session.ts`              | `SessionMode` union `:46`; **both `Extract` lists**: `RemoteCommandMode` `:48-51`, `DockerCommandMode` `:157-161` (§2.8); new `PiConfig` after `AntigravityConfig` (`:325-333`); `SessionState.piConfig` after `:486`; `@fileoverview` mode list `:11` + config list `:17` |
| `src/mux-interface.ts`              | `piConfig?: PiConfig` on `CreateSessionOptions` (config block ends `:78`) and `RespawnPaneOptions` (ends `:109`) |
| `src/session.ts`                    | `isExternalCliMode()` `:164-167` (+pi); `getModeLabel()` `:168-183` (+`'Pi'`); `_piConfig` field decl `:466-470`; ctor option `:556-563` + apply `:652-654`; `toState()` `:1227-1230`; `_buildRespawnPaneOptions()` `:1466-1469` (single source of truth shared by `startInteractive` and `reattachRemote`); `startInteractive()` createSessionOptions `:1680-1683`; COLORTERM attach-env condition `:1400-1402` (+pi); requires-tmux guard chain `:1751-1768` (new block: "Pi sessions require tmux for env override injection via setenv") |
| `src/tmux-manager.ts`               | `buildPiCommand()` after `:736` per §3; `buildSpawnCommand()` signature `:770-779` + dispatch branch after `:822-825`; `appendResumeFlag()` `:1030-1042` (`case 'pi': return \`${modeCommand} --session ${resumeId}\`;`); `buildEnvExports()` truecolor branches `:1604-1609` (+pi); `buildPathExport()` `:1680-1707` (+pi branch calling `resolvePiDir()`); missing-CLI error chain in `createSession` `:1788-1806` (+pi, install hint `npm install -g --ignore-scripts @earendil-works/pi-coding-agent`; note `respawnPane` deliberately has no such check); `piConfig` threading at the four sites `:1748`, `:1817`, `:2041`, `:2080`. **No `_configurePi`** (§2.3) |
| `src/config/dependency-registry.ts` | New entry after antigravity's (`:101-108`; file unchanged since 2026-08-06): `{ id: 'pi', label: 'Pi CLI', category: 'core', required: false, usedBy: ['Pi sessions'], resolvers: [{ match: ALL, resolver: { kind: 'path', bins: ['pi'], versionArg: '--version' } }] }` |
| `src/docker-hosts.ts`               | `defaultDockerCommandForMode` `:138-149`: `pi: 'exec pi'`. `CRED_STORES` `:597-605`: the `.pi/agent` seedFiles entry per §2.5 (nested `rel` already handled at `:613-645`). File unchanged since 2026-08-06 |
| `src/remote-hosts.ts`               | `defaultRemoteCommandForMode` `:92-118`: `pi: remoteLoginShellCommand('pi')` (`remoteLoginShellCommand` at `:88-90`). Login-shell routing is mandatory (the #209/e803186 lesson: ssh remote-command exec sees only sshd's minimal PATH, and npm's global bin is usually only on PATH via rc files) |

### Phase 2: Web layer

| File                               | Change                                                                                          |
| ---------------------------------- | ----------------------------------------------------------------------------------------------- |
| `src/web/schemas.ts`               | `'PI_'` in `ALLOWED_ENV_PREFIXES` `:125` **and** the prose error message `:163` (which now also names `CLAUDE_CONFIG_DIR`; the `ALLOWED_ENV_KEYS` exact-key set needs no change); new `PiConfigSchema` after `AntigravityConfigSchema` (`:256-271`), mirroring §3's regexes, `.optional()`, not `.strict()`; `piConfig` on `CreateSessionSchema` (`:299` area) and `QuickStartSchema` (`:712` area); `'pi'` in all three mode enums (`:285`, `:708`, cron `agentType` `:1214`; they are byte-identical and there is no fourth); `pi` key in `RemoteCommandOverridesSchema` `:426-436` (it is `.strict()`, so an unknown key is a hard error today; one edit covers both remote `:501` and docker `:577` reuse) |
| `src/web/routes/session-routes.ts` | Thread `piConfig` through create (`POST /api/sessions`): disk-strip exclusion chain `:705-712`, availability gate `:782-790` (+`isPiAvailable` with install-hint error), model resolution `:825-838` (`mode === 'pi' ? body.piConfig?.model : ...`), clamp call `:845`, Session ctor `:860` (`piConfig: mode === 'pi' ? gatedPiConfig : undefined`). Quick-start (`POST /api/quick-start`, handler `:2559`): remote-case config rejection `:2614-2621` and docker-case `:2645-2652` (+`piConfig`: per-CLI config does not cross ssh or the bind mount), hooks-scaffold exclusions `:2801`/`:2809`, availability gate `:2744-2752` (local-case branch only), env-strip chains `:2833`/`:2863`, model resolution `:2885`, clamp `:2897`, ctor `:2913`. **Extend `clampExternalCliBypassForOwner()`** (`:305-336`, doc comment above): fifth param + return field; pi joins the **materialize** branch per §5.2. Alt-screen replay-strip at `:2275` unchanged (pi not in it, §2.2) |
| `src/web/routes/system-routes.ts`  | `GET /api/pi/status` after the antigravity handler (`:418-426`; file unchanged since 2026-08-06), same shape plus `version` (§2.6); update the "CLI Integrations" prose comment `:377` |
| `src/web/server.ts`                | Restore path: `piConfig: muxSession.mode === 'pi' ? savedState?.piConfig : undefined` after `:2636`. **`renderIndexHtml` CLI-availability injection `:1375-1407`**: add `isPiAvailable` to the dynamic-import tuple (`:1382`) and a `pi` key to the injected object (`:1399`). Per §2.8 a missing key reads as *available*, so this is a correctness edit, not polish |

### Phase 3: Frontend

The antigravity touchpoints are the template. Since the first draft, the settings-surface overhaul
moved most anchors and added one **new touchpoint** (the clone-repo Brain picker below).
`constants.js`, `api-client.js`, `ralph-wizard.js`, `cron-ui.js`, `webview-tabs.js` and `sw.js`
still need **no** changes (re-verified zero mode coupling at f39beb3; cron-ui reads the `<select>`
generically and special-cases only `shell`).

| File                | Change                                                                                                 |
| ------------------- | ------------------------------------------------------------------------------------------------------ |
| `index.html`        | Welcome button `welcomePiBtn` after Gemini's (antigravity's is `:347`; there is deliberately no codex welcome button), `display:none` default, `onclick="app.setRunMode('pi'); app.runPi()"`, text `Run Pi`; run-mode-option row with `.run-mode-dot.pi` after antigravity's (`:526-528`), before the `.run-mode-sep` `:529`; cron `<option value="pi">Pi</option>` after `:803`; **NEW: the clone-repo "Brain" picker** (`cloneCaseBrain`, `:2476-2486`): add `<option value="pi" data-cli="pi">Pi</option>` after the antigravity option `:2483` (gating is automatic: session-ui.js `:2107-2115` hides options whose `data-cli` fails `isCliAvailable`, and `:2250` reads the value at clone time); docker image hint `:2624` (`claude/codex/gemini/opencode/agy` + pi). No per-CLI remote-command override field needed (only codex has one, `:2559`) |
| `session-ui.js`     | `@fileoverview` mode list `:2`; `run()` dispatch branch after `:400-402`; `_refreshRunModeAvailability` list `:468` (+`'pi'` as a quoted literal, the static test in §6 demands it); short-label ternary `:565` (+`'Run PI'`); **the `runMode` setter whitelist `:2949-2960`** (§2.8, the deceptive one); new `runPi()` modeled on `runAntigravity()` `:1170-1219`: same remote/docker skip, same `_beginSessionLaunchStatus` frame, probes `/api/pi/status` reading `(await res.json()).data.available` (envelope!), **sends no `piConfig` at all** (no bypass exists and trust defaults are pi's own; envOverrides still sent for local cases), install-hint error text matching Phase 1's; `isAltMode` `:1233` and `isExternalCli` `:1263` four-way comparisons (+pi) |
| `settings-ui.js`    | `applyWelcomeCliVisibility()` `:1176-1191`: add `['welcomePiBtn', 'pi']`                               |
| `app.js`            | Response-viewer agent label `:1998-2009` (+pi -> `'Pi'`); tab badge ternary `:3884` (`<span class="tab-mode pi" aria-hidden="true">pi</span>`; claude stays badge-less); kill-title ternary `:5046-5057` (`Kill Tmux & Pi`)                                                    |
| `panels-ui.js`      | Command-palette `labels` map `:430` (+`pi: 'Pi'`; the `\|\| mode` fallback means this is cosmetic, not load-bearing) |
| `mobile-overview.js`| `MOBILE_OVERVIEW_RUN_MODES` `:55-62`: `{ mode: 'pi', label: 'Pi', short: 'Pi' }` after antigravity `:60`, before the shell entry. Nothing else: the Run-button badge (`:499`) and menu builder (`:554-556`) consume the list generically, and the buttons carry `btn-toolbar btn-run mode-pi`, which is exactly why they inherit the §2.9 cascade problem and its fix |
| `terminal-ui.js`    | Badge-row comment `:1750` only (the badge itself is a raw `s.mode` passthrough, no list to extend). `_sessionUsesServerMouseStrip` unchanged (§2.2). `_updateLocalEchoState` unchanged for v1 (§2.10: pi lands on `'buffer'` via the fallthrough; only touch it if E2E forces the `'off'` fallback) |
| `i18n.js`           | `'Run Pi': '运行 Pi'` in the zh-CN table (`:102-107`, matches the welcome-button text; short labels like `Run PI` are deliberately untranslated, as are the other modes')                                              |
| `styles.css`        | Tab badge `.session-tab .tab-mode.pi` after `:2157` (`background: rgba(244,114,182,0.2); color: #f472b6;`); add `.session-tab .tab-mode.pi` to the light-skin ink list `:325-336` (gemini + antigravity are its precedent, `:332`); welcome `.welcome-btn-pi` + `:hover` after antigravity's `:3366` block, rose family (e.g. base `linear-gradient(135deg, #33121f 0%, #9d174d 55%, #be185d 100%)`, border `rgba(244,114,182,0.4)`, text `#fce7f3`); toolbar gradient pair `.btn-toolbar.btn-run.mode-pi, .btn-toolbar.btn-run-gear.mode-pi` + `:hover` after `:4420`'s antigravity block; `.run-mode-dot.pi { background: #f472b6; }` in the dot list `:4506-4516`; **and the §2.9 rule inside the Daylight block** next to codex's `:13787` (e.g. `background: linear-gradient(135deg, #be185d, #f472b6); border-color: #be185d; color: #fff1f7;`). The dot needs no skin-block entry (the block overrides only claude/opencode/codex/shell dots; gemini/antigravity dots already fall through correctly) |
| `mobile.css`        | Phone toolbar block after `:910` inside the `@media (max-width: 430px)` opened at `:338`: `mode-pi` base + `:active`, **with `!important` on background/border-color/color** (§2.9; antigravity's block `:895-910` omits it and is dead); light-skin override entry after `:2985` with the same four-skin `html:is(...)` prefix as its siblings |

### Phase 4: Docker image and installer

Both files are unchanged since the 2026-08-06 verification; all anchors stand.

- `docker/agent.Dockerfile`: a **separate** `RUN` step after the antigravity block (`:38-45`), not a
  fifth line in the shared npm block (`:31-36`), because pi documents `--ignore-scripts` and that
  flag must not silently change how the other four install:

  ```dockerfile
  # Pi (pi.dev). Upstream documents --ignore-scripts (pi needs no lifecycle scripts);
  # kept out of the shared npm block above so the flag cannot affect the other CLIs.
  RUN npm install -g --ignore-scripts @earendil-works/pi-coding-agent \
   && npm cache clean --force \
   && pi --version
  ```

  Implementation checklist item: the gid-0 pre-created dirs at `:64-68` include `.claude/projects`
  and `.codex/sessions`; verify whether the cred-seed copy into `~/.pi/agent` creates its target
  dir in a fresh container or whether `.pi/agent` must join that `mkdir` line. Rebuild with
  `node scripts/build-agent-image.mjs --no-cache` (the script itself needs no change; nothing in it
  is CLI-specific). The cached npm layer has silently frozen a CLI at a broken version before; see
  `docs/docker-cases.md`.
- `install.sh` (six edit sites, all verified): `PI_SEARCH_PATHS` block after `:125` (mirror the
  resolver's dirs); `check_pi` / `get_pi_path` pair inserted at `:531` (antigravity's pair spans
  `:504-530`); the satisfying-AI-CLI chain `:2032-2063` (`has_pi` local at `:2037` area, detect
  block after `:2059`, widen the five-way test at `:2061` and the warn text at `:2063`); the menu
  option-4 text `:2070`; the skip-path hints `:2115-2116` (add
  `npm install -g --ignore-scripts @earendil-works/pi-coding-agent   (Pi)`); the final no-CLI
  reminder `:2416-2423` (add `check_pi` to the condition and a pi line to the echo block).
  Detection plus a hint only; do **not** add an auto-install path in this change.

### Phase 5: Docs

- `docs/pi-integration.md` (**new**, user-facing): install (both installers uninstall via npm), auth
  (`/login` OAuth for six providers vs API keys; `pi auth check` for preflight; Claude Pro/Max
  third-party harness usage bills as Anthropic "extra usage" per token, not plan limits; OpenRouter
  login supports pasting the redirect URL, which matters over remote SSH), what Codeman wires up
  and deliberately does not (§3, incl. never passing `--tui-mode`), the tmux extended-keys note
  from §2.7 with the manual `~/.tmux.conf` fallback, Docker/remote behaviour (in-container sessions
  invisible host-side), the trust model in §1 words, known gaps.
- `CLAUDE.md`: tech-stack line (six CLIs + `SessionMode` union), the env-prefix gotcha bullet, the
  multi-CLI prefix-discipline bullet, the "External CLI modes" key-pattern paragraph (note it now
  also carries the codex predictive-echo block; pi's echo-policy decision from §2.10 belongs in the
  same paragraph), the `src/utils/` resolver list.
- `docs/architecture-invariants.md`: the external-CLI-modes section. ⚠️ Its anchor was already
  renamed once to `#external-cli-modes-opencode-codex-gemini-antigravity` while CLAUDE.md's link
  text still shows the old name; when renaming again for pi, update every inbound link (CLAUDE.md
  and this file).
- `docs/docker-cases.md` (cred-seeding table + supported modes + image contents),
  `docs/remote-sessions.md` (`RemoteCommandMode`), `docs/cron-guide.md` + `docs/cron-discovery.md`
  (`agentType` enum; note the readiness caveat from §6's cron paragraph),
  `docs/security-architecture.md` (env prefix allowlist row).
- `README.md` + `README.zh-CN.md`: six CLIs.
- `package.json` keywords: `pi`.
- Update the issue #206 thread when it ships.

---

## 5. Security checklist

1. **Command injection.** Every `PiConfig` value is regex-validated in `buildPiCommand()` before
   entering the `bash -c "..."` string; anything failing validation is dropped, not escaped
   (matching the four existing builders). No user string reaches the spawn line unvalidated. Pinned
   by a "rejects unsafe values" test per field.
2. **Multi-user clamp, materialize branch.** `approveProjectTrust` is the privilege-shaped field: it
   makes pi execute repository-supplied TypeScript and install project packages.
   `clampExternalCliBypassForOwner()` (`session-routes.ts:305-336`) has two branches, and pi belongs
   in the **gemini-style materialize branch**, not the codex/antigravity only-if-sent branch:
   pi's absent-config default is an *interactive trust prompt the session user can answer
   themselves in the terminal*, so merely omitting `--approve` is not a clamp. For a non-granted
   owner, materialize `{ ...(piConfig ?? {}), approveProjectTrust: false }` so `buildPiCommand`
   always emits `--no-approve` and the prompt never appears. Both call sites (`:845`, `:2897`)
   widen. This helper still has **zero test coverage** (re-confirmed at f39beb3); §6 adds the first
   tests.
3. **Secrets stay off the command line.** `PI_*` overrides flow through `applyEnvOverrides()` /
   socket-scoped `tmux setenv`, never inlined into the spawn string. No `-e` at container create
   time. And `--api-key` is never wired (§3): it would put a provider secret into `ps`/tmux state.
4. **Env allowlist not widened.** Only the `PI_` prefix is added; the provider keys stay out (§2.4)
   and `ALLOWED_ENV_KEYS` is untouched. Pinned by a test that `PI_OFFLINE` passes and
   `ANTHROPIC_API_KEY` still fails validation.
5. **Docker seeding, not sharing.** Per §2.5: RO mount then copy, so refreshed OAuth tokens never
   write back to the host; bind mounts stay excluded from `docker commit` so exports remain
   secret-free.
6. **Remote SSH.** `pi` mode goes through `defaultRemoteCommandForMode` and therefore
   `buildSshConnectionArgs()`. No hand-built ssh line anywhere.
7. **No sandbox claims.** Pi documents that it has no sandbox and no permission prompts, and that
   extensions run with the user's full permissions. Codeman docs must say plainly that a pi session
   can read, write and execute anything the Codeman user can, and point at Docker cases as the
   isolation story. Do not imply the trust prompt is a safety boundary (upstream itself says it is
   not). Worth one doc sentence: `pi auth print-api-key` / `print-bearer-token` (0.83.0) and
   `pi auth check` (0.84.1) mean a pi session can print its own provider credentials by design;
   isolation, again, is Docker.
8. **Loud-vs-silent audit.** Before review, walk §2.8's silent list and confirm each site has its
   pi branch; the loud ones the compiler already caught.

---

## 6. Test plan

- `test/pi-mode.test.ts` (**new**, modeled on `test/antigravity-mode.test.ts`, 125 lines, no port;
  file unchanged since 2026-08-06 so its structure remains the template):
  `CreateSessionSchema`/`QuickStartSchema` accept a pi config; unsafe `model`/`provider`/
  `resumeSessionId` values are rejected (`'pi; rm -rf /'` shapes); `buildSpawnCommand({ mode: 'pi', ... })`
  emits expected flags, drops invalid ones, emits `--no-approve` for `approveProjectTrust: false`
  and `--approve` for `true`, and skips `-c` when a `resumeSessionId` is present;
  `defaultDockerCommandForMode('pi') === 'exec pi'` and
  `defaultRemoteCommandForMode('pi') === 'exec "${SHELL:-/bin/sh}" -i -l -c \'pi\''`;
  `isExternalCliMode('pi') === true`, `isAltScreenStripMode('pi') === false`; the env pair
  (`PI_OFFLINE` accepted, `ANTHROPIC_API_KEY` rejected), mirroring antigravity-mode `:49-63`.
- **First-ever coverage for `clampExternalCliBypassForOwner`** (still nothing in `test/` touches
  it): cover pi's materialize branch (absent config still yields `approveProjectTrust: false` for a
  non-granted owner; a sent `true` is forced to `false`; granted owner passes through) and, while
  there, pin the three existing modes' behavior. Prefer exporting the helper for direct unit tests
  over a heavier multi-user route fixture; either way it lives under `test/routes/`.
- `test/run-mode-ui.test.ts`: extend `loadUi()`'s stub lists (welcome-button ids, mode buttons,
  `ALL_OFF`) and add pi welcome/dropdown gating cases; note the static parser test
  `'gates every mode the run-mode menu actually offers'` (`:433-456`) picks up the new
  `data-mode="pi"` from index.html automatically and **fails until** `_refreshRunModeAvailability`
  contains a quoted `'pi'`, which is exactly the regression it exists for. Add a
  `describe('Pi quick start')` modeled on the antigravity one (`:840`) driving `runPi()` against a
  stubbed `/api/pi/status` + `/api/quick-start`, asserting the posted body has `mode: 'pi'` and
  **no `piConfig`**, and that the envelope is unwrapped. (The short-label assertion pattern is at
  `:82`, `'Run AG'`.)
- `test/render-index-html.test.ts` `:141`: the injected `window.__codemanCliAvailable` is asserted
  with an exact `toEqual` and now carries **seven** keys (claude, opencode, codex, gemini,
  antigravity, cloudflared, and since 1.12+ `git`), so it **must** gain the `pi` key (and the
  resolver mock an `isPiAvailable`); its comment explains why: a dropped key silently un-gates
  (§2.8).
- `test/routes/system-routes.test.ts`: `GET /api/pi/status` shape, modeled on the antigravity
  describe (`:816-838`) + resolver mock (`:84-87`); file unchanged since 2026-08-06.
- `test/mobile-overview.test.ts`: `:375` is an exact-array `toEqual` over the run-menu modes and
  **will fail until updated** to include `'pi'` (the second exact-array at `:366`,
  `['claude', 'shell']`, is a gating case and stays as-is); the sibling static parser then covers
  the new entry automatically. The no-hex-literals guard only scans `.mobile-overview*` rules, so
  pi's `mode-pi` colors in mobile.css do not trip it.
- `test/local-echo-codex-gating.test.ts` (§2.10): once the buffer-policy decision is confirmed in
  E2E, add `'pi'` to the `it.each(['claude', 'gemini', 'opencode'])` lists (`:193`, `:376`) so the
  chosen policy is pinned.
- `test/skin-themes.test.ts`: will NOT trip (it enumerates skins, not modes); run it anyway since
  styles.css is touched. `test/mobile-header-buttons-policy.test.ts`: trips only if a header
  button is added; pi adds none (welcome button and run-menu rows are outside `header-right`).
- Cron: schema-level acceptance of `agentType: 'pi'` (the service consumes `SessionMode`
  generically; `src/cron/` is unchanged since the first draft). Known, documented degradation: the
  readiness poll (`cron-service.ts:515`) looks for `❯`/`tokens`, which pi never prints, so cron pi
  jobs burn the ready-poll attempts and then send anyway. Acceptable for v1; note it in
  `docs/cron-guide.md`.
- Sweep with `npm run test:ci`. Never bare `npm test`. No new ports needed (all new/extended suites
  are portless).

---

## 7. End-to-end verification (required before COM)

Unit tests passing is not evidence the mode works (pi is not currently installed on the dev box, so
step 1 is a real step). Before shipping:

1. Install pi (`npm install -g --ignore-scripts @earendil-works/pi-coding-agent`), authenticate once
   with `/login`.
2. `curl -sk https://localhost:3000/api/pi/status | jq` reports `available: true`, the right path,
   and a sane `version`.
3. Create a **throwaway** case, launch a pi session from the Run dropdown, send a prompt from the
   browser, confirm the reply renders and scrollback survives a tab switch. Do not touch
   `w1`/`w2`/`w3`.
4. **Local-echo policy gate (§2.10):** on a phone profile, type into the pi editor through the
   buffer overlay (drive with `page.keyboard.type()`, never `app.sendInput()`, and force
   `app._localEchoEnabled = true`; headless Chromium reports touch as false) and confirm pi's
   composer renders the flushed text correctly on Enter. If it mis-renders, flip pi to the `'off'`
   branch in `_updateLocalEchoState` and pin that instead.
5. Visual pass on the **default skin** (the §2.9 finding makes this the load-bearing check, not a
   formality): run-button gradient actually renders rose (not generic claude blue), dot, tab badge,
   welcome button, kill-menu label; then a phone profile (toolbar `!important` colors and light-skin
   overrides are the usual regressions).
6. Kill and respawn the session; confirm `piConfig` round-trips through `state.json` and the pane
   comes back with the same flags. Then `/clear`-style respawn via the Respawn tab.
7. Extended keys (§2.7): in an attached terminal, verify whether Shift+Enter inserts a newline in
   pi's editor with and without the socket-scoped options; record the outcome in
   `docs/pi-integration.md` either way. While attached, also flip `/settings` to the fullscreen TUI
   and back to confirm the no-strip decision holds (§2.2).
8. Trust model: point a throwaway case at a repo containing `.pi/extensions`, confirm the trust
   prompt appears interactively and that a multi-user non-granted session instead launches with
   `--no-approve` (prompt never shown, extensions not loaded).
9. **NOT RUN in this pass — an honest gap.** Docker case with `mode: 'pi'`: rebuild the agent image with `--no-cache`, confirm `pi --version`
   inside the container **as the `agent` user**, confirm seeded auth works and a session starts
   (this is exactly where the antigravity Docker path broke in 1.11.2: the CLI was never installed
   in the image).
10. **NOT RUN in this pass — the other gap.** Remote SSH case with `mode: 'pi'`: confirm the
    login-shell wrapper resolves the npm global bin.
11. Only then: changeset, `COM minor` (new capability, additive to the API surface).

**Verification actually performed** (2026-08-13, pi 0.84.1, isolated `CODEMAN_INSTANCE=pi-beta`
server on :5055 with its own tmux socket and data dir): steps 1-8 pass. Highlights:
`/api/pi/status` resolved through the **search-dir fallback** (pi installed to `~/.npm-global/bin`,
deliberately not on PATH) and reported
`{available:true, path:'/home/arkon/.npm-global/bin', version:'0.84.1'}`; the real spawn line came
out as `… COLORTERM=truecolor … && pi --approve --provider anthropic --thinking high`; `piConfig`
round-tripped through `state.json` across a **full server restart**; the trust prompt appeared for a
case containing `.pi/extensions` + `.pi/settings.json`, and `--no-approve` suppressed it
(`This project is not trusted. Project .pi resources and packages are ignored.`); on the **default
`daylight-blue` skin** the toolbar Run button computed to
`linear-gradient(135deg, rgb(190,24,93), rgb(244,114,182))` — genuinely rose and **distinct from
claude's blue**, so the §2.9 cascade trap is avoided; and flipping `/settings` to the fullscreen TUI
put the pane into the alt screen (`alternate_on=1`), **empirically confirming §2.2**: had pi been in
the strip list, Codeman would have stripped that switch and corrupted the session. Steps 9-10 need a
Docker daemon and a remote host respectively.

---

## 8. Effort estimate

Calibrated against the real antigravity history, which is the honest baseline: the feature commit
`26cbbe0` was 24 files, +638/-63, and it then took **four follow-up commits** (`e803186` login-shell
routing, `292ba2c` ownership helpers, `5d28999` CLI gating incl. tests, `0d0b772` docs/installer/UI
propagation) totaling roughly +600/-170 across ~43 file-touches to make the mode actually
first-class. Budgeting only the feature-commit shape under-scopes by ~40%. This plan folds all four
follow-up surfaces in from the start (login-shell routing in Phase 1, availability gating in Phases
2-3, installer/docs propagation in Phases 4-5), so expect the full footprint in one pass:

| Phase                 | Size                                                                       |
| --------------------- | -------------------------------------------------------------------------- |
| 1. Backend core       | ~260 lines across 9 files, one new file (resolver incl. version probe)     |
| 2. Web layer          | ~110 lines across 4 files (incl. the clamp widening + availability inject) |
| 3. Frontend           | ~175 lines across 10 files (enumerations + CSS in two sheets + skin block + the Brain picker option) |
| 4. Docker + installer | ~45 lines, plus one `--no-cache` image rebuild                             |
| 5. Docs               | one new doc, ~10 files touched                                             |
| 6. Tests              | one new test file, 6 extended (2 of which fail loudly until updated), plus the first clamp coverage |

---

## 9. Out of scope, tracked as follow-ups

- **A Codeman pi extension for real idle/completion events (highest value, now fully de-risked).**
  Pi extensions are TypeScript modules with Node built-ins and npm deps available, so an HTTP POST
  to `/api/hook-event` is trivial. The **`agent_settled`** event **shipped in 0.84.0** and is
  documented for exactly this use case (fires only when pi will not continue on its own: after
  auto-retries, auto-compaction and queued follow-ups; `ctx.isIdle()` is true inside the handler).
  That is a genuine idle signal replacing output-silence heuristics, i.e. the same class of upgrade
  hooks give Claude sessions. The bash tool exposes five env vars (`PI_SESSION_ID`,
  `PI_SESSION_FILE`, `PI_PROVIDER`, `PI_MODEL`, `PI_REASONING_LEVEL`), injected per command. Bonus:
  an extension can own the **`project_trust`** event (first yes/no wins, and CLI `-e` extensions
  load *before* trust resolution), so Codeman could answer the trust prompt programmatically, a
  cleaner mechanism than the `--approve` flag for both the single-user convenience case and the
  multi-user deny case.
- **Response viewer for pi.** Sessions are JSONL v3 under
  `~/.pi/agent/sessions/--<cwd-dashed>--/<timestamp>_<uuid>.jsonl` with an `id`/`parentId` tree and
  typed content blocks (text, image, thinking, toolCall); the cwd-derived dir name is trivially
  computable host-side. Feasible, and it would justify flipping the Docker cred policy to share
  `sessions/` RW like Codex.
- **Mode-aware env allowlist.** Would let pi sessions accept provider keys without widening the
  global list. Needs `ALLOWED_ENV_PREFIXES` to become a per-mode map plus mode context inside the
  Zod refine.
- **`--tools` / `--exclude-tools` / `--no-tools` / `--no-builtin-tools` read-only sessions** (plus
  the 0.84.0 `defaultTools` setting). Real product value, needs UI.
- **Predictive echo for pi's composer** if the §2.10 buffer decision does not hold up in practice:
  teach `PredictiveEchoAddon` pi's composer row the way `isCodexComposerRow` handles codex's.
- **`--mode json` / `--mode rpc`, and upstream's experimental remote-session client APIs**
  (transport-neutral `PiClient`, CBOR protocol, Unix-socket transport, `RemoteSession` controller,
  still unreleased as of 0.84.1). A potential non-PTY integration path, a different architecture
  from the tmux+PTY model. Note the already-shipped breaking change to `message_update` framing
  (delta-only): any consumer must assemble deltas between `message_start`/`message_end`.
- **`--name` for session labels.** Blocked on shell-quoting a user string in `buildSpawnCommand`.

---

## 10. Risks

| Risk                                                                | Mitigation                                                                     |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `pi` resolves to an unrelated binary                                | `pi --version` + semver-shape check in the resolver (§2.6); path and version shown in `/api/pi/status` |
| Pi's TUI repaints in a way the browser terminal handles badly       | Test scrollback and repaint early (step 3 of §7); pi's default is main-screen with terminal-owned scrollback, which is the friendly case |
| Fullscreen TUI mode (shipped 0.84.0, runtime-switchable)            | Already designed for: pi stays OUT of the strip list, so a user flipping `/settings` to fullscreen gets opencode-like alt-screen behavior, not corruption. §7 step 7 tests the flip explicitly. **SUPERSEDED (PR #771, 2026-11):** fullscreen is the default since pi 1.0.0 and pi now takes the mouse strip, see §2.2 |
| The buffer local-echo overlay fights pi's live composer             | §2.10: explicit E2E gate (§7 step 4) with the one-line `'off'` fallback; predictive echo for pi is a tracked follow-up, not a v1 blocker |
| Pi moves fast (pre-1.0; 9 releases in the 7 weeks before 0.84.1)    | Keep the flag surface small; every flag validated and droppable; nothing pinned in the Dockerfile beyond the `--no-cache` rebuild cadence. Live example of the hazard: `--tui-mode` went from main-only docs to released between the two drafts of this plan |
| Docker image grows                                                  | Pi is an npm package; the layer is modest next to the ~190MB `agy` binary      |
| Trust prompt blocks a session                                       | Narrower than feared: only fires when `.pi/settings.json`, `.pi/extensions\|skills\|prompts\|themes`, `.pi/SYSTEM.md`/`APPEND_SYSTEM.md` or `.agents/skills` exists (bare `.pi/` does not). Documented; `approveProjectTrust` is the opt-in escape hatch; multi-user forces `--no-approve` (§5.2); the `project_trust` extension follow-up removes the prompt entirely |
| Interactive `/login` OAuth can't complete headlessly                | Document: authenticate once interactively (or seed `auth.json`); `pi auth check` verifies credentials preflight; OpenRouter's paste-the-redirect-URL flow covers remote SSH |
| Provider auth is awkward without key prefixes in the allowlist      | `/login` writes `~/.pi/agent/auth.json` once and Docker seeds it; the mode-aware allowlist follow-up removes the friction |
| Cron pi jobs mis-detect readiness                                   | Known degradation, documented in §6; readiness falls through after the poll budget and the prompt still sends |
