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

`~/.codeman/clis.json` (instance-scoped through `dataPath()`) holds overrides and custom entries only, never a copy of the stock catalog: `{ "clis": { "<id>": { ...partial entry... } } }`. Objects merge key-wise onto the stock entry, arrays replace wholesale. **The file must be mode 0600**; the loader refuses any group/world permission bit, read bits included, so a file created with a normal umask (0644) is ignored until you `chmod 600` it. Every reason a file was ignored or an entry dropped is logged once, prefixed `[cli-registry]`, on the first load. A stock entry whose override fails validation falls back to the shipped definition; a custom entry that fails is dropped. The file is read once per process and re-read only on restart.

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
  //   .workDetect?: { promptGlyph, workingLine } — how this CLI's pane shows work
  overlays: CliOverlays; // remote-SSH / Docker pane commands, credential store
}
```

`capabilities` is the important part. It is what `isExternalCliMode()`, `isAltScreenStripMode()`, `hooksAvailableForMode()` and every other former per-mode branch actually read.

### Regexes that come from config

Two capability fields carry a regular expression an override file can set: `discovery.version.regex` and `capabilities.workDetect.workingLine`. Both go through `compileVersionRegex()`, which caps the source at 200 characters, refuses the nested-quantifier shapes that cause catastrophic backtracking, and returns `null` rather than throwing so every caller degrades instead of crashing.

`workingLine` is the one that matters most, because it is compiled once per session and then run against every accumulated PTY chunk and every pane capture. A nested quantifier there is a ReDoS against the event loop for the whole server, not just that session. The guard therefore runs in two places, and neither is redundant: `schema.ts` rejects the entry at LOAD time so a bad pattern never reaches a session, and `_workingLinePattern()` in `session.ts` compiles through the same helper so the runtime cannot end up with a pattern the schema would have refused.

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

## Two namespaces called `param`

`launch.params` keys, `env.configSetenv[].fromParam` and `capabilities.privilegedParams[].param` all name a **launch param**. The **legacy wire field** a param arrives as is a separate namespace, and `launch.legacyConfigAliases` is the only bridge between the two.

This matters because it is invisible when it is wrong. `capabilities.privilegedParams[].param` is the multi-user bypass clamp's only handle on a CLI's privilege switch, and a name from the wrong namespace clamps **nothing**: no load error, no failing test, the clamp simply stops running. Codex is the entry where the two names differ (`bypassApprovals` as the param, `dangerouslyBypassApprovals` on the wire), so it is the one that catches a regression. `schema.ts` rejects any entry naming a param it never declared, on both `configSetenv.fromParam` and `privilegedParams.param`.

## Fields declared for later

`shortBadge`, `accent`, `capabilities.echo`, `capabilities.wheelForward`, `capabilities.keyboardAccessory` and `capabilities.maxFrameBytes` are **declared but not yet read**. They all describe frontend behaviour, and the frontend is deliberately untouched here: `app.js`, `terminal-ui.js` and `styles.css` keep their own hand-authored per-CLI rules, and moving them is its own piece of work verified by a browser/mobile suite the CI gate cannot see.

Treat those values as **transcribed, not authoritative** — nothing enforces that `echo.policy` matches `_updateLocalEchoState`'s fallthrough, or that `accent` matches the gradient CSS paints, so re-measure before wiring one up. A field that is both wrong and unread is worse than an absent one, because the next reader trusts it; `test/cli-registry-no-id-branching.test.ts` pins the list so it cannot quietly grow, and wiring one up makes its line there fail, which is the direction you want.

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
response; there is no degraded mode to fall into now. An optional, opt-in refresh
(`CODEMAN_CLI_CATALOGUE_URL`, or `CODEMAN_REFRESH_CLI_CATALOGUE=1`) exists for a stale local
copy, and warns on all three failure shapes — empty body, unparseable content, failed fetch.

### The install-command trust boundary

Three rules, and the middle one is why the embed matters:

1. **The server never executes an entry's `install.command`.** Unchanged, and still enforced by nothing executing it: the field is display text (`CliDiscovery.install.command`).
2. **`install.sh` executes only commands embedded in itself.** Those arrive in the same file, over the same TLS fetch, in the same commit as the `curl \| bash` line that fetched the script — identical trust to the hardcoded vendor one-liners it replaces.
3. **Nothing fetched at install time is ever executed.**

That is mechanical rather than a promise. `CLI_INSTALL_CMD_TRUSTED` is written only from the
generated block and is the only array the installer runs; `CLI_INSTALL_CMD_DISPLAY` is what the
refresh may rewrite. `test/install-sh-invariants.test.ts` asserts the split holds, that the
refresh never assigns into a `*_TRUSTED` array, and that it never `eval`s.

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
4. Only if it cannot install with a plain `npm install -g <pkg>`: give it a layer in `docker/agent.Dockerfile` and a reason in `AGENT_IMAGE_SPECIAL_CASES` (`scripts/lib/cli-catalog.mjs`). The coverage test requires both, so an exclusion cannot quietly become an omission.
5. That is usually all. If you find yourself wanting to add an `if` somewhere, the guard test will tell you — and the answer is a capability field, or a named profile if it genuinely needs to run code.

## See also

- [Agent CLIs](wiki/Agent-CLIs.md) — the user-facing per-CLI guide.
- `docs/architecture-invariants.md` — the mechanics and the history behind the rules above.
- `docs/deepseek-integration.md` — why DeepSeek is shaped the way it is.
