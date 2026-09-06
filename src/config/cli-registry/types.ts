/**
 * @fileoverview Type definitions for the CLI registry — the single source of truth for
 * which agent CLIs Codeman supports and how each one is discovered, launched and treated.
 *
 * This replaces the hard-coded `SessionMode` union and the ~123 per-mode branches that grew
 * out of it. The guiding rule: NO code may branch on a CLI's id. Behaviour that genuinely
 * differs between CLIs is expressed either as data here, or as a named PROFILE selected by
 * a capability field (see profiles.ts) — never as `mode === 'codex'`.
 *
 * @module config/cli-registry/types
 */

import type { TokenPattern } from './patterns.js';

/**
 * A CLI identifier. Branded so an arbitrary string cannot be passed where a validated id is
 * expected; construct with `asCliId()` at the API boundary.
 */
export type CliId = string & { readonly __cliId: unique symbol };

// ---------------------------------------------------------------------------
// Launch argv DSL
// ---------------------------------------------------------------------------

/** Values the ENGINE supplies. Config may reference these by name but never author them. */
export type EngineValue =
  | 'sessionId'
  | 'sessionName'
  | 'muxName'
  | 'effortLevel'
  | 'effortSettingsJson'
  /** `sessionId` prefixed `codeman_<id>` — codex's unique per-pane rollout originator. */
  | 'codemanPrefixedSessionId'
  /**
   * For a launcher CLI (`discovery.launcherProfile`), the target to launch when the caller
   * named none — deepseek's default `dsh` profile. Resolved at spawn time, never frozen
   * into config, because it depends on what is installed on this machine right now.
   */
  | 'launcherDefaultTarget';

/**
 * A declared launch parameter. `token` params carry caller-supplied data and are therefore
 * the only ones that need a pattern; `engine` params are produced in code.
 */
export type ParamSpec =
  | { type: 'enum'; values: string[]; default?: string }
  | { type: 'bool' }
  | { type: 'token'; pattern: TokenPattern }
  | { type: 'engine'; source: EngineValue };

/** A boolean guard over parameter state. */
export type Cond =
  | { param: string; is: string | boolean }
  | { param: string; state: 'set' | 'unset' }
  | { allOf: Cond[] }
  | { anyOf: Cond[] }
  | { not: Cond }
  /** Names an entry in `capabilities.gates`. Fail-closed gates omit when version is unknown. */
  | { capabilityGate: string };

/**
 * How a token is quoted when emitted into the bash command string.
 *
 * This exists ONLY to preserve byte-identical output with the hand-written builders being
 * replaced (claude wraps its values in double quotes; the other builders emit bare words).
 * It is never a safety lever: `renderToken()` verifies the value is metacharacter-free
 * before honouring an explicit style, and falls back to single-quote escaping if it is not.
 * So the worst a wrong `quote` can do is make output uglier, never unsafe.
 */
export type QuoteStyle = 'auto' | 'bare' | 'double' | 'single';

/** One argv element. */
export type ArgSpec =
  /** A bare literal word, e.g. the base binary or codex's `resume` subcommand. */
  | { lit: string; when?: Cond }
  /** A valueless flag, e.g. `--no-approve`. */
  | { flag: string; when?: Cond }
  /** A flag with a fixed literal value. */
  | { flag: string; value: string; quote?: QuoteStyle; when?: Cond }
  /** A flag whose value comes from a declared param. */
  | { flag: string; valueFrom: string; quote?: QuoteStyle; when?: Cond }
  /** A bare positional value from a param, e.g. codex's `resume <id>`. */
  | { valueFrom: string; quote?: QuoteStyle; when?: Cond };

/** One alternative command form. */
export interface CliVariant {
  /** Stable name for diagnostics and tests, e.g. 'resume' / 'new'. */
  id: string;
  when?: Cond;
  args: ArgSpec[];
}

export interface CliLaunch {
  params: Record<string, ParamSpec>;
  /**
   * 'first'    — emit the first variant whose `when` passes (the usual case).
   * 'fallback' — emit EVERY passing variant joined by the engine's own ` || `, which is how
   *              claude's `--resume X || --session-id Y` shell fallback is expressed without
   *              config ever containing shell text. The engine owns the operator.
   */
  chain?: 'first' | 'fallback';
  variants: CliVariant[];
  /**
   * Maps a declared param name to the field name it arrives under on the legacy
   * `POST /api/sessions` wire shape (`OpenCodeConfig.continueSession`, etc — the per-mode
   * config objects predate this registry and stay on the wire for compatibility). A param
   * with no entry here is looked up under its own name. This is what lets the spawn-command
   * bridge (`session-cli-registry-bridge.ts`) stay generic: it reads the raw legacy config
   * object through this DATA-declared alias table instead of a per-mode `if (mode === ...)`.
   */
  legacyConfigAliases?: Record<string, string>;
  /**
   * The field on the legacy spawn option bag holding this CLI's `<Mode>Config` object
   * (`openCodeConfig`, `codexConfig`, …). Those per-mode objects predate this registry and
   * stay on the wire for API compatibility, so SOMETHING has to know which one to read —
   * declaring it here as data is what keeps the bridge a generic reader instead of a
   * `switch (mode)`.
   *
   * ABSENT means this CLI's launch fields live at the TOP LEVEL of the option bag rather
   * than nested in a config object. That is claude, whose discrete `claudeMode` /
   * `allowedTools` / `model` / `resumeSessionId` fields predate the `<Mode>Config` pattern
   * entirely — so "read the option bag itself" is not a special case for it, it is just
   * the other shape.
   */
  legacyConfigField?: string;
  /**
   * How to APPEND a resume id onto an already-built base command, for the docker in-container
   * "tmux was re-created, resume the surviving transcript" path (`appendResumeFlag` in
   * tmux-manager.ts) — a narrower, append-only sibling of the full `variants` shape above,
   * which builds a whole command from scratch. Absent = this CLI has no resume flag to
   * append (shell, opencode: opencode's docker resume goes through its own config object).
   */
  resumeAppend?: { style: 'flag'; flag: string } | { style: 'positional'; token: string };
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

export interface CliVersionProbe {
  arg: string;
  /** Serialized regex, applied to `--version` output only. See compileVersionRegex(). */
  regex?: string;
  /**
   * Treat a binary whose version output does not match as ABSENT rather than as
   * present-with-unknown-version. For CLIs with short, generic binary names (`pi`), where a
   * `which` hit is not by itself evidence the right program is installed.
   */
  requireVersionMatch?: boolean;
  /** Retry a failed probe with backoff instead of caching the failure (claude's behaviour). */
  retryOnTransientFailure?: boolean;
}

/**
 * An identity probe: proof that the binary we found is the program we meant, not an
 * unrelated one that happens to share the name.
 *
 * A version probe is not enough on its own. Debian ships a `dsh` (dancer's shell) that
 * answers `--version` perfectly happily, and npm carries squatters for `pi` and `grok`.
 * `requireVersionMatch` catches a binary whose version output has the WRONG SHAPE; this
 * catches one whose output has the right shape but names the wrong program.
 *
 * Ordering matters and belongs to the resolver, not to config: identity is checked FIRST,
 * so an impostor is rejected before its version string is ever parsed.
 */
export interface CliIdentityProbe {
  /** Argument that makes the binary describe itself, e.g. `--help`. */
  arg: string;
  /**
   * Serialized regex the output must match. Compiled through `compileVersionRegex()`, so
   * it inherits the same length cap and nested-quantifier rejection — this is the second
   * (and last) config-supplied regex in the registry, and it runs against truncated
   * command output exactly like the first.
   */
  regex: string;
}

export interface CliDiscovery {
  /**
   * Binary name(s), first hit wins.
   *
   * This is why the registry fixes a live bug: the mode name is NOT always the binary
   * name (`antigravity` runs `agy`), and `probeDockerCliVersion` assumed it was.
   */
  binaries: string[];
  /** Extra directories probed after `which`. A leading `~` expands to homedir; nothing else. */
  searchDirs: string[];
  version?: CliVersionProbe;
  /** Proof the binary is the right program, checked BEFORE the version probe. */
  identity?: CliIdentityProbe;
  /**
   * Names a LAUNCHER profile (profiles.ts): this CLI's binary is a launcher over some
   * further target, so two questions the registry normally answers from the binary alone
   * have to be asked of that target instead.
   *
   *   - Is it RUNNABLE? Stricter than "is the binary on disk?".
   *   - What is the DEFAULT target, when the caller names none?
   *
   * DeepSeek is why this exists and is its only user. `dsh` launches a profile from
   * `$DSH_HOME/profiles/<name>`, and the profiles DeepSeek itself ships (`web`,
   * `headless`) cannot drive a terminal pane — so a perfectly-installed `dsh` with no
   * third-party TUI profile is installed-but-NOT-runnable. The Run button gates on
   * runnability while the "add a profile" affordance gates on mere availability;
   * collapsing the two would either hide the affordance that fixes the problem or offer a
   * run that always fails.
   *
   * The default target reaches the launch spec as the `launcherDefaultTarget` engine
   * value, so it stays a runtime lookup rather than a value frozen into config.
   *
   * Absent (the normal case) means the binary IS the program, and its presence IS
   * runnability.
   */
  launcherProfile?: string;
  /**
   * The launch param naming the target a caller asked for, so the launcher profile can say
   * why THAT specific target will not start rather than only whether any will. Meaningless
   * without `launcherProfile`.
   */
  launcherTargetParam?: string;
  install: {
    /**
     * DISPLAY TEXT ONLY. Shown verbatim in "CLI not found. Install with: ...".
     *
     * ⚠️ NEVER executed by the server. That is a documented invariant, not an oversight:
     * running it would turn a config file into a code-execution surface. A proposal to
     * execute this on enable is deliberately deferred to its own change so the trust
     * model can be decided on its own merits rather than inside a refactor.
     */
    command: Partial<Record<'linux' | 'darwin' | 'wsl' | 'win32', string>>;
    /** Package name for an npm-installable CLI. Display/tooling metadata only. */
    npmPackage?: string;
    docsUrl?: string;
  };
}

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

export interface CliEnv {
  /** `export K=V` in the bash prelude. Values are literals or engine values, never secrets. */
  exports: Array<{ name: string; value: string | { engine: EngineValue }; when?: Cond }>;
  /** `unset K` — e.g. claude's CLAUDECODE, the truecolor CLIs' NO_COLOR. */
  unset: string[];
  /**
   * NAMES ONLY. Values are read from the server's own process.env and pushed via
   * `tmux setenv`, so a secret is structurally unable to reach the command line.
   */
  tmuxSetenvKeys: string[];
  /** NAMES ONLY, forwarded as `docker exec -e NAME`. */
  dockerExecEnvNames: string[];
  /**
   * Env vars set via `tmux setenv` from a LAUNCH PARAM rather than from the server's own
   * environment — for a CLI whose switch is an env var instead of a flag.
   *
   * DeepSeek's `DSH_PERMISSION_MODE` is the case this exists for. Routing it through a
   * declared param (rather than a bespoke configure step) is what lets the ordinary
   * `privilegedParams` clamp apply to it: the clamp rewrites the param, and whatever the
   * param ends up as is what gets exported.
   *
   * ⚠️ Values are read from a declared, schema-validated param, never from free text, and
   * they reach the pane through `tmux setenv` rather than the command line.
   */
  configSetenv?: Array<{ name: string; fromParam: string }>;
  /** This entry's contribution to the env-override allowlist. Never widens BLOCKED_ENV_KEYS. */
  allowedPrefixes: string[];
  allowedKeys: string[];
  /**
   * Env var carrying a JSON config blob pushed via `tmux setenv` (opencode's
   * OPENCODE_CONFIG_CONTENT). Generic so it is not an opencode special case.
   */
  configContentVar?: string;
  /**
   * Names an entry in `SETENV_PROFILES` (profiles.ts): extra `tmux setenv` work that is
   * genuinely code-shaped rather than a list of key names.
   *
   * DeepSeek's status bridge is the only current user. It has to write an executable shim
   * to disk (`ensureDeepSeekStatusShim()`), then export the shim's path and this session's
   * pane id — a side effect and two computed values, none of which `tmuxSetenvKeys` (a
   * list of names forwarded from the server's own env) can express.
   *
   * Plain secret forwarding stays in `tmuxSetenvKeys` and must NOT move here.
   */
  setenvProfile?: string;
}

// ---------------------------------------------------------------------------
// Capabilities
// ---------------------------------------------------------------------------

/**
 * The closed set of behavioural switches. Each field replaces an id-check somewhere.
 *
 * `hooks`, `transcript` and `altScreen` are INDEPENDENT on purpose. The three predicates
 * they back (`hooksAvailableForMode`, `isExternalCliMode`, `isAltScreenStripMode`) describe
 * three different, deliberately unequal sets, and deriving any one from another has already
 * caused a real bug — a `shell` session has no hooks but is not an "external CLI", so
 * `!isExternalCliMode()` wrongly accepted `until=stop` on it and hung for the full timeout.
 * Keeping them as separate fields makes that invariant structural rather than commented.
 */
export interface CliCapabilities {
  /**
   * Non-Claude run mode that uses its own TUI and output format (`isExternalCliMode`):
   * no Claude transcript, no hooks, no Claude-format token/BashTool parsing. An explicit
   * field rather than derived from `hooks`/`kind`, precisely because it must stay
   * independent — see this interface's own doc comment.
   */
  external: boolean;
  /**
   * How to read this CLI's own TUI for whether it is mid-turn.
   *
   * Codeman infers a working agent from the pane, so the two strings it needs are the
   * ones that differ per CLI: the glyph on the composer row, and the status line the CLI
   * draws while a turn runs. Holding them here is what lets a non-Claude CLI report work
   * at all — `external` used to gate the whole detector, so every external CLI reported
   * itself permanently idle even mid-turn.
   *
   * `promptGlyph` only ARMS the idle confirmation and is never on its own evidence that a
   * turn ended, because a CLI redraws its composer throughout a turn. `workingLine` is
   * the evidence, and `_confirmIdle` consults it before believing the pane went quiet.
   *
   * An entry that omits this field keeps Codeman's historical behaviour: the Claude glyph
   * arms the confirmation and the Claude working line answers it. Leave it out for a CLI
   * whose TUI nobody has characterised, and its sessions report work exactly as before.
   */
  workDetect?: {
    /** The glyph this CLI draws on its composer row, e.g. Claude's `❯`, Codex's `›`. */
    promptGlyph: string;
    /** Source of a regex matching the status line this CLI draws while a turn runs. */
    workingLine: string;
  };
  /** No direct-PTY fallback: the CLI must run inside tmux (secrets ride tmux setenv). */
  requiresMux: boolean;
  /**
   * Whether `stop`/`blocked` wait signals can ever fire for this CLI.
   *
   * ⚠️ A TRI-STATE, not a boolean, because for one CLI this is a per-SESSION question:
   *   'none'       — no hook signals, ever (every external CLI, and `shell`).
   *   'always'     — the CLI installs Codeman's hooks (claude).
   *   'supervised' — the CLI REPORTS its own idle/working/blocked state to a supervisor
   *                  over a generic env-gated contract, and Codeman is that supervisor
   *                  (deepseek, via deepseek-status-shim.ts). Definitive rather than
   *                  inferred, so it earns real signals — but the session can disarm the
   *                  bridge (`deepSeekConfig.statusReporting: false`), and a docker or
   *                  remote session cannot reach it at all.
   *
   * That last case is why `hooksAvailableForMode()` takes per-session options and why
   * every call site must pass `sessionHookOptions(session)`. Answering from the mode alone
   * would promise a `stop` that never arrives, which is the infinite-wait-dressed-as-a-
   * timeout the predicate exists to prevent.
   */
  hooks: 'none' | 'always' | 'supervised';
  /**
   * Which transcript reader, if any, understands this CLI's on-disk history.
   *
   * `deepseek-zstd` is the odd one out: dsh writes zstd-compressed session files and
   * appends ONE FRAME PER WRITE, so it needs a reader that walks frame headers itself
   * rather than the stock decoder. It exists because the pane segmenter served dsh's
   * ASCII-art splash as the worker's first answer.
   */
  transcript: 'claude-jsonl' | 'codex-rollout' | 'deepseek-zstd' | 'omp-jsonl' | 'none';
  /**
   * 'strip-full'     — alt-screen + erase-scrollback + mouse DECSETs stripped (Ink TUIs).
   * 'strip-mux-only' — only tmux's own attach-time smcup (the safe default).
   * 'preserve'       — leave everything (a direct-PTY shell running vim/less/htop).
   */
  altScreen: 'strip-full' | 'strip-mux-only' | 'preserve';
  echo: {
    policy: 'buffer' | 'predict' | 'off';
    /** How the local-echo overlay locates the composer row. */
    anchor: { kind: 'glyph'; glyph: string; offset: number } | { kind: 'cursor' } | { kind: 'none' };
    /** Names a PREDICT_PROFILES key. Unknown or absent degrades to 'buffer', never to broken. */
    predictProfile?: string;
  };
  /** Forwarding the wheel to the CLI's own transcript. 'never' keeps local scrollback. */
  wheelForward: { mode: 'never' | 'version-gated'; minVersion?: string };
  keyboardAccessory: 'agent' | 'shell';
  /** Multi-user: this CLI is a raw shell, so its commands need the privileged gate. */
  privilegedCommandGate: boolean;
  startMode: 'interactive' | 'shell';
  stripInkBloat: boolean;
  ralph: boolean;
  respawn: boolean;
  effort: boolean;
  agentSkillInjection: boolean;
  statusLineTelemetry: boolean;
  /** Where a model override is delivered. Claude uniquely writes settings.local.json. */
  model: { source: 'flag' | 'claude-settings-file' | 'none'; param?: string };
  /**
   * Params a non-granted multi-user owner may not set freely, and what they are forced to.
   * Data-driven so a CUSTOM CLI's bypass flag is clampable exactly like codex's.
   *
   * `materializeWhenAbsent` distinguishes two real shapes, not one:
   *   - only-if-sent (false/omitted; codex, antigravity, grok): the CLI's own
   *     absent-config default already spawns safe, so the clamp should only touch
   *     a config the caller actually sent.
   *   - materialize (true; gemini, pi): the absent-config default is ITSELF unsafe
   *     for a non-granted owner (gemini defaults to `yolo`; pi's absent default is
   *     an interactive trust prompt the session user could just answer "yes" to),
   *     so the clamp must CREATE a config object even when none was sent.
   *
   * ⚠️ `param` names the LAUNCH PARAM, like every other `param` in this file — never the
   * legacy wire field. The clamp translates it through `legacyConfigAliases` on the way out,
   * the same hop `env.configSetenv` makes. The two names coincide for most entries and
   * DELIBERATELY do not for codex (`bypassApprovals` here, `dangerouslyBypassApprovals` on
   * the wire), which is what keeps the distinction visible. `schema.ts` rejects an entry
   * naming a param it never declared, because getting this wrong is a SILENT no-op: no load
   * error, no failing test, the clamp just stops clamping.
   */
  privilegedParams: Array<{ param: string; clampTo: boolean | string; materializeWhenAbsent?: boolean }>;
  /**
   * Env var names a non-granted multi-user owner may not set at all, DROPPED from
   * `envOverrides` before spawn.
   *
   * ⚠️ This is a second, structurally different privileged surface from `privilegedParams`
   * above, and one cannot substitute for the other. `privilegedParams` clamps a field on a
   * per-CLI config object, which reaches the CLI as an argv flag. These clamp env vars,
   * which reach it through `tmux setenv` — a path no argv clamp can see.
   *
   * DeepSeek is why this exists. Its permission switch IS an env var
   * (`DSH_PERMISSION_MODE`), not a flag, so a config-level clamp alone leaves a real
   * multi-user control with nothing enforcing it. Worse, `DSH_*` is an allowlisted
   * `envOverrides` prefix and `applyEnvOverrides()` runs AFTER the per-CLI env configure
   * step, so a non-granted owner sending that key on the SAME request would land last and
   * hand back exactly the privilege the config clamp just removed.
   *
   * Dropping (rather than rewriting) is deliberate: the value then falls through to what
   * the CLI's own env configuration exports, which is already the clamped one.
   *
   * The other two DeepSeek keys are here for reasons worth keeping written down:
   *   - `DSH_HOME` points the launcher at a profile tree whose plugin code runs at BOOT,
   *     before any approval row could apply.
   *   - `DEEPSEEK_BASE_URL` would redirect the server's OWN forwarded `DEEPSEEK_API_KEY`
   *     to a host of the caller's choosing.
   *
   * Every other CLI's bypass is a command-line flag reachable only through its config
   * object, which is why `privilegedParams` alone is the whole gate for them.
   */
  privilegedEnvKeys: string[];
  /** Version gates referenced by `capabilityGate` conditions. */
  gates: Record<string, { minVersion: string; failClosed: boolean }>;
  /** Cap on a single terminal frame, when this CLI needs a tighter one than the default. */
  maxFrameBytes?: number;
}

// ---------------------------------------------------------------------------
// Location overlays (remote SSH / docker)
// ---------------------------------------------------------------------------

/** Docker credential seeding policy — which host dirs are copied or shared into a container. */
export interface CliCredStore {
  rel: string;
  shareDirs?: string[];
  shareFiles?: string[];
  seedFiles?: string[];
  seedWhole?: boolean;
}

export interface CliOverlays {
  /**
   * The remote/docker DEFAULT pane command: just the CLI invocation (e.g. `claude
   * --dangerously-skip-permissions`), independent of each location's own wrapping
   * (remote: login-shell `-c`; docker: `exec`). Absent `command` = the bare
   * `discovery.binaries[0]`. `disabled: true` = this location has no story for this CLI at
   * all (docker for `shell`) — distinct from "no override", which still gets a default.
   */
  remote?: { command?: string } | { disabled: true };
  /**
   * `rootCommand` is the same invocation for a container whose exec user is uid 0. Only
   * declare it when the normal `command` would be REFUSED as root: claude's carries
   * `--dangerously-skip-permissions`, which Claude Code rejects outright under root, and
   * the rejection is visible only inside the container, so the pane dies with no clue on
   * the outside. Codeman's own base image runs a non-root user and never selects this; an
   * ADOPTED container belongs to its owner and is frequently root. Absent = use `command`.
   */
  docker?: { command?: string; rootCommand?: string } | { disabled: true };
  /**
   * ⚠️ DECLARED-FOR-LATER, unlike `remote`/`docker` above, which are live.
   *
   * The Docker credential-seeding path still reads its own `CRED_STORES` table in
   * `docker-hosts.ts`, because this shape cannot yet express that table: it allows ONE store
   * per CLI, and the live table needs two for gemini (`.gemini` for the CLI's own auth plus
   * `.config/gcloud` for Vertex), while deepseek's entry here declares none at all even
   * though `.dsh` is seeded. Wiring it therefore means making this an ARRAY and correcting
   * those two entries — a change to credential seeding, which is both the highest-consequence
   * thing in this file to get wrong and the least covered by tests, since every docker IO
   * path is no-op'd under vitest. It belongs in its own change, measured against a real
   * container.
   */
  credStore?: CliCredStore;
}

// ---------------------------------------------------------------------------
// The entry
// ---------------------------------------------------------------------------

/**
 * ⚠️ DECLARED-FOR-LATER: fields no code reads yet.
 *
 * `shortBadge`, `accent`, `overlays.credStore`, `capabilities.echo`, `capabilities.wheelForward`,
 * `capabilities.keyboardAccessory` and `capabilities.maxFrameBytes` all describe FRONTEND
 * behaviour, and the frontend is deliberately untouched by the change that introduced this
 * registry — `app.js`, `terminal-ui.js`, `styles.css` and friends keep their own
 * hand-authored per-CLI rules, and moving them is its own piece of work with its own way of
 * being verified (a mobile/browser suite the CI gate cannot see).
 *
 * They are declared now because each entry should describe its CLI completely, and because
 * transcribing them while the hand-written source is still on screen is when the values are
 * actually known. But an unread field is a promise, not a fact: nothing enforces that
 * `echo.policy` here matches `_updateLocalEchoState`'s fallthrough, or that `accent` matches
 * the gradient CSS paints. Treat every value in this group as TRANSCRIBED, not authoritative,
 * and re-measure against the frontend before wiring one up.
 *
 * The rest of the interface is live: something reads it, and `test/cli-registry-*.test.ts`
 * pins what it does with it.
 */
export interface CliEntry {
  id: CliId;
  label: string;
  /** Two-ish character tab badge, e.g. 'OC'. */
  shortBadge: string;
  /** Single hex colour. CSS derives every per-CLI gradient from it via --cli-accent. */
  accent: string;
  enabled: boolean;
  /** Set by the loader from the shipped catalog; a user entry can never claim it. */
  stock: boolean;
  order: number;
  /** 'shell' unlocks the raw-shell code paths; everything else is an agent CLI. */
  kind: 'agent' | 'shell';
  discovery: CliDiscovery;
  launch: CliLaunch;
  env: CliEnv;
  capabilities: CliCapabilities;
  overlays: CliOverlays;
}

/**
 * The on-disk shape of ~/.codeman/clis.json — overrides and custom entries only, never the
 * full catalog. Small and hand-readable by design.
 *
 * ⚠️ READ-ONLY in this build. Nothing here writes this file: there is no settings UI and no
 * write API yet, so there is nothing to persist. That also means importing the registry
 * (and therefore `schemas.ts`, which validates against it) performs no filesystem writes —
 * an import side effect worth not having.
 */
export interface CliRegistryFile {
  schemaVersion: number;
  /**
   * Stock ids already introduced to this install — the ratchet that lets one file both gain
   * newly-shipped CLIs on upgrade AND remember that the user disabled one.
   *
   * Read and IGNORED here, and never written: the ratchet only earns its keep once a CLI
   * can be disabled, which needs the write API. Declared now purely so a file written by a
   * later version still loads cleanly under this one instead of failing `.strict()`.
   */
  seededStockIds?: string[];
  /** Keyed by id: a partial override of a stock entry, or a complete custom entry. */
  clis: Record<string, unknown>;
}
