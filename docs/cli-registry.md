# The CLI registry

Every run mode Codeman can launch — Claude Code, Terminal/Shell, OpenCode, Codex, Gemini, Antigravity, Pi, Grok, DeepSeek Harness and OMP — is a `CliEntry`: a data record describing how to find the binary, how to build its command line, what environment it needs, and what it can do. Code that used to ask "which CLI is this?" asks the entry instead.

## Where it lives

| File | What it holds |
| ------------- | ------------------------------------------------------------------------------------------------- |
| `types.ts` | The `CliEntry` interface and everything under it. Read this first. |
| `stock.ts` | The shipped catalog. **The only file allowed to name a CLI id.** |
| `schema.ts` | Zod validation, including the cross-field checks that reject an incoherent entry at LOAD time. |
| `argv.ts` | The argv engine: the only code that turns typed tokens into a command string. |
| `patterns.ts` | The NAMED value patterns (`model`, `uuid`, `path-segment`, …) and the regex-compilation guard. |
| `profiles.ts` | The names of behaviours that genuinely need code, kept import-free so `schema.ts` can validate one. |
| `registry.ts` | Loading, merging `~/.codeman/clis.json`, and the accessors (`getCli`, `enabledClis`). |

`src/session-cli-registry-bridge.ts` maps the legacy per-mode option bag onto the engine, and `src/utils/cli-resolver.ts` / `src/utils/cli-launcher.ts` do registry-driven binary resolution and launcher-profile dispatch.

## The override file

`~/.codeman/clis.json` (instance-scoped through `dataPath()`) holds overrides and custom entries only, never a copy of the stock catalog: `{ "clis": { "<id>": { ...partial entry... } } }`. Objects merge key-wise onto the stock entry, arrays replace wholesale. **The file must be mode 0600**; the loader refuses any group/world permission bit, read bits included, so a file created with a normal umask (0644) is ignored until you `chmod 600` it. Every reason a file was ignored or an entry dropped is logged once, prefixed `[cli-registry]`, on the first load. A stock entry whose override fails validation falls back to the shipped definition; a custom entry that fails is dropped. The file is read once per process and re-read after a change made through CLI management (below).

## Managing CLIs from Settings

App Settings → Agents & CLIs → **CLI management** (`cliManagementEnabled`, default OFF; admin-only in multi-user mode) lists every entry with an installed/not-installed badge and:

- toggles any entry on or off. A `kind: 'shell'` entry cannot be disabled, and the row shows no switch for it. A disabled CLI disappears from the Run menu, the welcome screen and the phone overview, and new session requests for it are rejected.
- installs a missing **stock** CLI by running its shipped install command, after a confirm that names the exact command. Only one install per CLI runs at a time, and the command runs without any `CODEMAN_*` variable in its environment. A custom entry's install command is never executed.
- adds, edits and deletes **custom** entries (id, label, badge, binaries, launch argv). The server re-validates the whole assembled entry through `CliEntrySchema`, so the form cannot bypass the load-time rules.

These are the only writes to `clis.json`. They are serialized, and a file that does not parse or has unsafe permissions is refused rather than overwritten; fix it (or `chmod 600` it) and retry. The HTTP routes are listed in `docs/api-reference.md` under *CLI management*.

## The shape of an entry

```ts
interface CliEntry {
  id: CliId; // 'codex'
  label: string; // 'Codex' — shown in menus
  shortBadge: string; // tab badge, e.g. 'CX'
  accent: string; // single hex colour
  enabled: boolean;
  stock: boolean; // set by the loader; a custom entry can never claim it
  order: number;
  kind: 'agent' | 'shell';
  discovery: CliDiscovery; // how to find and prove the binary
  launch: CliLaunch; // the structured argv template
  env: CliEnv; // exports, tmux setenv keys, the env-override allowlist
  capabilities: CliCapabilities; // what every call site reads instead of the id
  //   .workDetect?: { promptGlyph, workingLine, watchingLine?, watchingLines? } — how
  //   this CLI's pane shows work, and how it shows work it started in the background
  overlays: CliOverlays; // remote-SSH / Docker pane commands, credential store
}
```

`capabilities` is the important part. It is what `isExternalCliMode()`, `isAltScreenStripMode()`, `hooksAvailableForMode()` and every other former per-mode branch actually read.

### Regexes that come from config

Three capability fields carry a regular expression an override file can set: `discovery.version.regex`, `capabilities.workDetect.workingLine` and `capabilities.workDetect.watchingLine`. All three go through `compileVersionRegex()`, which caps the source at 200 characters, refuses the nested-quantifier shapes that cause catastrophic backtracking, and returns `null` rather than throwing so every caller degrades instead of crashing.

`workingLine` is the one that matters most, because it is compiled once per session and then run against every accumulated PTY chunk and every pane capture. A nested quantifier there is a ReDoS against the event loop for the whole server, not just that session. The guard therefore runs in two places, and neither is redundant: `schema.ts` rejects the entry at LOAD time so a bad pattern never reaches a session, and `_workingLinePattern()` in `session.ts` compiles through the same helper so the runtime cannot end up with a pattern the schema would have refused.

`watchingLine` reads a different row of the same screen. A CLI draws it while work the agent
itself started is still running — Claude prints `⏵⏵ bypass permissions on · 1 monitor · ← for
agents` while a monitor, a backgrounded shell or a cloud session is live. Codeman turns that
into `Session.watching`, and an idle prompt from such a session opens already acknowledged,
so a pane waiting for its own background work never raises an alert a human cannot answer.
Group 1 is the label, and a CLI that declares no pattern reports no background work.
Claude's Artifact comment monitor is the one chip that does not count. It waits for a human
to comment on a page the agent published, so Claude's pattern refuses any footer that
carries it, and the idle alert goes out as usual.

Two CLIs declare such a row today, and they put it in different places. Claude writes its
chip on the last row of the screen, so it keeps the default one-row window and anchors on
the `·` its footer joins items with. Codex pins
`1 background terminal running · /ps to view · /stop to close` ABOVE its composer, which
puts the row third from the bottom once the status line and the composer are counted, so its
entry declares `watchingLines: 3` and matches that row end to end. Both were measured
against live panes rather than read out of a binary, which is the standard for adding a
third.

That label is the one value in the registry that an AGENT can influence, because it comes off
the agent's own screen. Two things keep it honest, and both belong to whoever adds a pattern
for a new CLI. `watchingLabel()` in `session-activity.ts` searches only the last few
non-blank rows, which should be the part of the screen the CLI draws rather than the agent,
and the pattern should anchor on chrome only that CLI can produce. Keep the window as small
as the layout allows, since every row it adds is another row the agent may be able to write.
The label is also ANSI-stripped and length-capped at the source, and every interpolation of
it into markup goes through `escapeHtml()`, since it ends up on a badge and in an approval
card.

The two shipped entries do not sit equally well behind that rule, and the difference decides
what a pattern is allowed to do. Claude's chip is the last row, so its one-row window holds
nothing the agent can write — not even the status line above it, whose command a session
running with permissions bypassed can write into its own `.claude/settings.json`. Codex's row
shares its slot with the last row of the transcript whenever no terminal is running, so a
message ending in that exact line is matched. What keeps that harmless is `hooks: 'none'`: no
hook event from a codex session reaches the approvals inbox, so a forged label costs a wrong
badge and cannot silence an alert. Before giving a CLI both hook signals and a pattern, make
sure its row is one the agent cannot write.

### Three capabilities that must stay independent

`external`, `hooks` and `altScreen` describe three different, deliberately unequal sets, and deriving any one from another has already shipped a bug. `shell` has no hooks but is **not** an external CLI, so a hooks predicate written as `!isExternalCliMode()` accepted `until=stop` on a shell session and then blocked the caller for their entire timeout. `deepseek` is the mirror image: it IS external and it DOES have hooks.

`test/cli-capability-predicates.test.ts` asserts that no two of the three are equivalent across the catalog, so collapsing them fails the build rather than a user's session.

## Arg-template safety

The composed command line is interpolated into `bash -c "…"` inside tmux, which makes command construction a security boundary. Four independent layers keep config out of it:

1. **Config contains no shell text.** There is no `command: "..."` field anywhere in the schema. An entry declares a sequence of typed tokens; `argv.ts` is the only place that turns them into a string, and it owns every separator itself — one space between tokens, ` || ` between fallback variants. Neither can originate from config, because config has no field that could hold either.
2. **Every literal is validated at LOAD time** against a safe-word pattern (no space, quote, backtick, `$`, `;`, `&`, `|`, redirection, parens, braces, newline or backslash). A bad literal **rejects the whole entry** rather than being dropped, because a silently dropped flag would change security-relevant behaviour — losing `--no-approve` is not a cosmetic difference.
3. **Values resolve through NAMED patterns.** A value placeholder selects a `TokenPattern` (`model`, `uuid`, `slug`, `path-segment`, `tool-list`, …) from `patterns.ts`; config can never supply its own regex for a value, so a `clis.json` structurally cannot widen its own validation. A value that fails its pattern drops the whole argument, exactly as the hand-written builders did: an invalid `--model` omits `--model`, it never substitutes something else.
4. **Escaping is independent of validation.** `renderToken()` re-checks the resolved value before emitting it unquoted, and single-quotes anything else — so even a value that somehow bypassed validation is quoted, never concatenated raw.

The only config-supplied regexes are `discovery.version.regex` and `discovery.identity.regex`. Both run against **command output** rather than a shell token, both are compiled through `compileVersionRegex()` (length cap, nested-quantifier rejection, never the `g` flag), and the output they see is truncated first.

## Named profiles: the escape hatch

Some differences genuinely need to run code rather than be described. Those are **named profiles**: a capability field holds a profile NAME, and the implementation lives in one place keyed by that name — never by CLI id.

- `discovery.launcherProfile` — for a CLI whose binary is not the agent. `dsh` boots `$DSH_HOME/profiles/<name>`, so "installed" and "runnable" have different answers; the profile answers both, plus why a specifically-named target will not work. Implemented in `utils/cli-launcher.ts`.
- `env.setenvProfile` — per-CLI environment setup that is more than a list of keys, such as DeepSeek's status bridge.
- `capabilities.transcript` — which on-disk history reader understands this CLI (`claude-jsonl`, `codex-rollout`, `deepseek-zstd`, `omp-jsonl`, `none`).
- `capabilities.echo.predictProfile` — the predictive-echo model a composer needs.

The names live in `profiles.ts`, which is kept free of imports so `schema.ts` can validate a name at load time. A profile this build does not implement is a load-time error naming the field, rather than a CLI that silently looks permanently uninstalled.

## DeepSeek: the four assumptions it breaks

DeepSeek is worth reading before assuming an entry looks like its siblings — the schema carries four extensions because of it.

| What it breaks | How the registry expresses it |
| ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| `dsh` is a profile LAUNCHER, not the agent, so "installed" is not "runnable". | `discovery.launcherProfile` + `discovery.launcherTargetParam`. |
| Its permission switch is the **`DSH_PERMISSION_MODE` env var**, not a flag — the harness has none. | `env.configSetenv` (so the ordinary `privilegedParams` clamp still reaches it) **and** `capabilities.privilegedEnvKeys`. |
| It is the only non-claude mode with real hook signals, and for it that is a per-SESSION question. | `capabilities.hooks: 'supervised'` — a third state, not a boolean. |
| Its transcript is zstd session files, one frame per write. | `capabilities.transcript: 'deepseek-zstd'`. |

## Identity probes

`discovery.identity` asks the binary whether it is the program we meant, and it runs **before** the version probe, because a version probe cannot tell an impostor from the real thing. Debian ships an unrelated `dsh` (dancer's shell) that answers `--version` perfectly happily, and npm carries squatters for both `pi` and `grok`.

`discovery.version.requireVersionMatch` is the weaker companion: a binary whose version output has the wrong shape counts as ABSENT rather than present-with-unknown-version. That is what a short, generic binary name needs, and it is what keeps `codeman doctor` and the run mode from telling the user opposite things about the same binary — both read the same regex off the same entry.

## The no-id-branching rule

`test/cli-registry-no-id-branching.test.ts` fails the build if a CLI id comparison appears outside the stock catalog. It builds its id list from the live catalog, blanks comment lines before scanning (comments legitimately quote the pattern to explain why a branch was removed, and blanking rather than dropping is what keeps reported line numbers pointing at the real file), and keeps an allowlist in which **every entry carries its reason**.

It matches four shapes, not one: `mode === '<id>'`, `mode !== '<id>'`, `case '<id>':`, and `['<id>', …].includes(mode)`. The first version matched `===` only, and that gap was not academic — the refactor it guards converted the `===` sites and left the negated ones, so 36 `!==` branches survived it, including a seven-mode chain auto-enabling Ralph under a comment asking the next person to keep it in step with a predicate by hand while the sibling code path already read the capability. A guard that sees half the shapes reports a count measured over the half it happens to catch.

The allowlist is not a formality. If a branch is about what a CLI can DO it belongs in `CliCapabilities`; the entries that remain are things that are not CLI-behaviour branches at all — chiefly the legacy per-mode `<Mode>Config` objects on `POST /api/sessions`, which are a fact about the public HTTP API rather than about any CLI, plus a few documented cases where `mode === 'claude'` is genuinely the right question (Read My Mind reads Claude's _own_ transcript, so a capability there would be actively wrong).

`test/frontend-cli-no-id-branching.test.ts` is the same guard for the two frontend files the CLI registry's Run-menu consolidation touches, `session-ui.js` and `mobile-overview.js` — deliberately not the rest of `src/web/public/`, whose per-CLI rules stay out of scope for now (see "Fields declared for later" below). Its allowlist keys on `<file>::<expression>` with no line number, since a single unrelated edit to a contended file would otherwise shift every subsequent line and make every entry go stale at once, and each entry additionally carries the exact number of approved call sites — a bare key would let a brand-new branch reusing an already-approved expression land unreviewed. Its comparison shape differs from the backend guard's in one respect: the left-hand side may be any identifier, not only one named `mode`, `id` or `agentType`, because the review of #458 found `const m = this._runMode; if (m === 'codex')` slipping past the named form while the scanned file already filters with `(m) => m !== 'shell'`.

## Two namespaces called `param`

`launch.params` keys, `env.configSetenv[].fromParam` and `capabilities.privilegedParams[].param` all name a **launch param**. The **legacy wire field** a param arrives as is a separate namespace, and `launch.legacyConfigAliases` is the only bridge between the two.

This matters because it is invisible when it is wrong. `capabilities.privilegedParams[].param` is the multi-user bypass clamp's only handle on a CLI's privilege switch, and a name from the wrong namespace clamps **nothing**: no load error, no failing test, the clamp simply stops running. Codex is the entry where the two names differ (`bypassApprovals` as the param, `dangerouslyBypassApprovals` on the wire), so it is the one that catches a regression. `schema.ts` rejects any entry naming a param it never declared, on both `configSetenv.fromParam` and `privilegedParams.param`.

## Fields declared for later

`accent`, `capabilities.echo`, `capabilities.wheelForward`, `capabilities.keyboardAccessory` and `capabilities.maxFrameBytes` are **declared but not yet read**. (`shortBadge` was on this list until the CLI management list in Settings started showing it.) They all describe frontend behaviour, and the frontend is deliberately untouched here: `app.js`, `terminal-ui.js` and `styles.css` keep their own hand-authored per-CLI rules, and moving them is its own piece of work verified by a browser/mobile suite the CI gate cannot see.

Treat those values as **transcribed, not authoritative** — nothing enforces that `echo.policy` matches `_updateLocalEchoState`'s fallthrough, so re-measure before wiring one up. `accent` is the one exception: it was measured against styles.css on 2026-09-21 (method in the comment above `CLAUDE` in `stock.ts`), though nothing keeps it in step with the CSS either. A field that is both wrong and unread is worse than an absent one, because the next reader trusts it; `test/cli-registry-no-id-branching.test.ts` pins the list so it cannot quietly grow, and wiring one up makes its line there fail, which is the direction you want.

`overlays.credStore` is in the same category, for a sharper reason: the Docker credential-seeding path still reads its own `CRED_STORES` table, because this shape allows ONE store per CLI and the live table needs two for gemini (`.gemini` for the CLI's own auth plus `.config/gcloud` for Vertex), while deepseek declares none here even though `.dsh` is seeded. Wiring it means making the field an array and correcting those two entries — a change to credential seeding, which is simultaneously the worst thing here to get wrong and the least covered by tests, since every docker IO path is no-op'd under vitest.

Everything else in the interface is live, including `overlays.remote` / `overlays.docker`, which back `defaultRemoteCommandForMode()` and `defaultDockerCommandForMode()` directly. Those two used to be hardcoded `Record<…CommandMode, string>` tables duplicating the registry with nothing keeping the two in step; `test/location-overlay-commands.test.ts` pins every resulting command as a literal string.

## Consumers outside the server

Two things need the catalogue but cannot import TypeScript, so `npm run generate:cli-catalog`
(`scripts/generate-cli-catalog.mts`) emits two artifacts from `stock.ts`. Both are committed,
and `test/cli-catalog-sync.test.ts` fails if either drifts from a fresh generation.

| Artifact | Consumer | Why it exists |
| ------------------------------------ | ---------------------------------- | ---------------------------------------------------------------------------------- |
| `config/clis.stock.json` | `scripts/lib/cli-catalog.mjs` (Docker build args), tests | A `.mjs` cannot import the registry. |
| a marked block inside `install.sh` | the installer itself | It runs via `curl \| bash` before any checkout exists, so it can read neither. |

Only `id`, `label`, `shortBadge`, `enabled`, `order`, `kind` and `discovery` are exported.
`launch`, `env`, `capabilities` and `overlays` are spawn-time concerns the server alone
interprets, and a test asserts they never leak into the artifact — a second reading of the
launch model in a consumer that cannot be tested against a real spawn is exactly what this
registry exists to prevent.

The install.sh copy is **embedded, not fetched**, and is the FULL catalogue. An earlier design
fetched it and fell back to a hardcoded two-CLI list, which degraded silently on an empty
response; there is no degraded mode to fall into now, and no network fetch either — a `curl |
bash` from master already carries a catalogue exactly as fresh as the script itself, so there is
nothing a refresh would buy that isn't already true. An earlier draft added an opt-in refresh
with a `TRUSTED`/`DISPLAY` array split to keep it from ever writing the executed command; it was
dropped before merge rather than shipped half-verified — the split's only actual write was the
label, `DISPLAY` never diverged from `TRUSTED` in practice, and the added surface (a second
array, a fetch path, three failure shapes to warn on) bought nothing the embedded copy didn't
already have.

### The install-command trust boundary

Three rules, and the middle one is why the embed matters:

1. **The server never executes an entry's `install.command`.** Unchanged, and still enforced by nothing executing it: the field is display text (`CliDiscovery.install.command`).
2. **`install.sh` executes only commands embedded in itself.** Those arrive in the same file, over the same TLS fetch, in the same commit as the `curl \| bash` line that fetched the script — identical trust to the hardcoded vendor one-liners it replaces.
3. **Nothing fetched at install time is ever executed.** There is no second code path that fetches anything after the script itself has been fetched.

That is mechanical rather than a promise. `CLI_INSTALL_CMD_TRUSTED` is written only from the
generated block and is the only array the installer ever runs or displays — there is no second
array a refresh could rewrite, because there is no refresh. `test/cli-catalog-sync.test.ts`
asserts that the embedded commands are exactly the registry's, and
`test/install-sh-invariants.test.ts` that nothing in `install.sh` `eval`s.

### bash 3.2

macOS ships bash 3.2 and the documented install is `curl -fsSL <url> | bash` under
`set -euo pipefail`, so a bash-4 construct is not a warning there — it kills the install. The
generated block therefore uses parallel indexed arrays with **offset/length windows** into one
flat array instead of delimiters (a `$HOME` containing a space needs no `IFS` handling, and an
entry with nothing to contribute gets length 0 and is never iterated). CI runs `bash -n` and
executes the script inside a real `bash:3.2` container, because the empty-window case is a
runtime `set -u` abort that `bash -n` cannot see.

## Resolve at call time, never at import

Anything reading the registry must resolve it when it is asked, not when its module is first imported. `sessionModeSchema()`, `allowedEnvPrefixes()`, `dependencyRegistry()` and each resolver's `searchDirs` thunk all re-read the catalog per call.

A module-level const freezes at first import, and the failure is asymmetric: a CLI enabled while the server is running moved the run menu but not the frozen surface, so validation rejected a mode the menu offered, or `codeman doctor` reported a catalog nobody had any more.

## Adding a CLI

1. Add a `CliEntry` to `stock.ts`.
2. Run `npm run generate:cli-catalog` and commit **both** artifacts (`config/clis.stock.json` and `install.sh`). The installer's detection, its install menu, its reminder text and the Docker agent image all follow from that one step — this is what makes upstream `b6d0f1fa` ("wire OMP into install.sh's CLI detection, it had none") impossible rather than merely fixed.
3. Add a golden spawn-command pin to `test/cli-registry-spawn-golden.test.ts`, a row to `test/cli-capability-predicates.test.ts`, its remote/docker commands to `test/location-overlay-commands.test.ts`, and its search paths to `test/install-sh-detection-parity.test.ts`.
4. Only if it cannot install with a plain `npm install -g <pkg>`: give it a layer in `docker/agent.Dockerfile` and set `discovery.install.agentImageLayer: { kind: 'dedicated', reason }` on its entry in `stock.ts`. `test/docker-agent-image-coverage.test.ts` requires both, so an exclusion cannot quietly become an omission. An entry with no `npmPackage` needs only the Dockerfile layer, since it never enters the shared npm layer in the first place.
5. That is usually all. If you find yourself wanting to add an `if` somewhere, the guard test will tell you — and the answer is a capability field, or a named profile if it genuinely needs to run code.

## See also

- [Agent CLIs](wiki/Agent-CLIs.md) — the user-facing per-CLI guide.
- `docs/architecture-invariants.md` — the mechanics and the history behind the rules above.
- `docs/deepseek-integration.md` — why DeepSeek is shaped the way it is.
