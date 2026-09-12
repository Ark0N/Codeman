/**
 * @fileoverview Bridges the legacy per-mode spawn options (`buildSpawnCommand`'s option bag
 * in tmux-manager.ts, unchanged on the wire since before this registry existed) onto the CLI
 * registry's generic argv engine (`renderLaunch`).
 *
 * The per-mode `<Mode>Config` objects on `POST /api/sessions` predate the registry and stay
 * on the wire for API compatibility (`docs/versioning-policy.md`), so SOMETHING has to know
 * which field holds which CLI's config. That knowledge is DATA — `launch.legacyConfigField`
 * and `launch.legacyConfigAliases`, declared once per entry in `config/cli-registry/stock.ts`
 * — which is what lets this file stay a generic reader rather than a `switch (mode)`.
 *
 * An entry declaring NO `legacyConfigField` reads its params straight off the top-level
 * option bag. That is claude, whose discrete `claudeMode`/`allowedTools`/`model`/
 * `resumeSessionId` fields predate the `<Mode>Config` pattern — not a special case for
 * claude, just the other of the two shapes the wire has always had.
 *
 * @module session-cli-registry-bridge
 */

import type { CliEntry } from './config/cli-registry/types.js';
import { renderLaunch, type EngineValues, type ParamValues } from './config/cli-registry/argv.js';
import { matchesPattern } from './config/cli-registry/patterns.js';
import { buildEffortCliArgs, sanitizeCliSessionName } from './session-cli-builder.js';
import { compareVersions } from './utils/dependency-checker.js';
import { getClaudeCliVersion } from './utils/claude-cli-resolver.js';
import { launcherDefaultTarget } from './utils/cli-launcher.js';
import { getCli } from './config/cli-registry/registry.js';
import type {
  AntigravityConfig,
  ClaudeMode,
  CodexConfig,
  DeepSeekConfig,
  EffortLevel,
  GeminiConfig,
  GrokConfig,
  OmpConfig,
  OpenCodeConfig,
  PiConfig,
} from './types/session.js';

export interface SpawnBridgeOptions {
  mode: string;
  sessionId: string;
  model?: string;
  claudeMode?: ClaudeMode;
  allowedTools?: string;
  openCodeConfig?: OpenCodeConfig;
  codexConfig?: CodexConfig;
  geminiConfig?: GeminiConfig;
  antigravityConfig?: AntigravityConfig;
  piConfig?: PiConfig;
  grokConfig?: GrokConfig;
  deepSeekConfig?: DeepSeekConfig;
  ompConfig?: OmpConfig;
  resumeSessionId?: string;
  effort?: EffortLevel;
  sessionName?: string;
  claudeCliVersion?: string | null;
  /**
   * Resolved by resolveStatusLineCliCommand (hooks-config.ts) — undefined skips the
   * exporter. Claude only. Rides the SAME `--settings` JSON object as `effortSettingsJson`
   * (see buildSpawnCommandFromRegistry): Claude Code accepts only one `--settings` flag
   * per invocation, so the two must be merged before reaching the argv engine rather than
   * rendered as two independent params.
   */
  statusLineCommand?: string;
}

/**
 * The raw legacy config object this entry's params should be read from: the declared
 * `<Mode>Config` field, or the option bag itself when none is declared.
 */
function legacyConfigFor(entry: CliEntry, options: SpawnBridgeOptions): Record<string, unknown> | undefined {
  const field = entry.launch.legacyConfigField;
  if (field === undefined) return options as unknown as Record<string, unknown>;
  return (options as unknown as Record<string, unknown>)[field] as Record<string, unknown> | undefined;
}

/**
 * Same lookup, addressed by mode rather than by entry, for callers holding only a mode and an
 * option bag (tmux-manager's env configuration). Returns undefined for an unregistered mode.
 */
export function legacyConfigForMode(
  mode: string,
  options: Record<string, unknown>
): Record<string, unknown> | undefined {
  const entry = getCli(mode);
  if (!entry) return undefined;
  return legacyConfigFor(entry, options as unknown as SpawnBridgeOptions);
}

/**
 * Build `ParamValues` for every declared `token`/`bool`/`enum` param by reading it out of the
 * legacy config object through `legacyConfigAliases` (falling back to the param's own name).
 * `engine`-sourced params are skipped — those come from `EngineValues`, never legacy config.
 */
function buildParamsFromLegacyConfig(entry: CliEntry, rawConfig: Record<string, unknown> | undefined): ParamValues {
  const params: ParamValues = {};
  if (!rawConfig) return params;
  const aliases = entry.launch.legacyConfigAliases ?? {};
  for (const [paramName, spec] of Object.entries(entry.launch.params)) {
    if (spec.type === 'engine') continue;
    const legacyKey = aliases[paramName] ?? paramName;
    const value = rawConfig[legacyKey];
    if (value === undefined) continue;
    // Anything that is not already a string or boolean is DROPPED rather than coerced: the
    // wire shape is Zod-validated upstream, so a surprise here means something is wrong,
    // and `String({})` would happily produce a token nobody intended.
    if (typeof value === 'string' || typeof value === 'boolean') {
      params[paramName] = value;
    }
  }
  return params;
}

/**
 * The env vars this CLI declares in `env.configSetenv`, resolved from its legacy config
 * object — i.e. the ones whose value comes from the CALLER rather than the server's own
 * environment.
 *
 * ⚠️ Re-validated here against the declared `ParamSpec` even though the wire shape is already
 * Zod-checked upstream. These values reach `tmux setenv`, and for DeepSeek the value IS a
 * permission level: a builder must never trust its caller on a security-relevant field, and
 * the cost of re-checking an enum is nothing.
 *
 * A value that fails validation is DROPPED, not defaulted — which is the safe direction: the
 * var goes unset, and the CLI falls back to its own default (for dsh, `workspace-write`,
 * which asks) rather than to something we guessed.
 */
export function configSetenvValues(
  entry: CliEntry,
  rawConfig: Record<string, unknown> | undefined
): Record<string, string> {
  const out: Record<string, string> = {};
  const mappings = entry.env.configSetenv;
  if (!mappings || !rawConfig) return out;
  const aliases = entry.launch.legacyConfigAliases ?? {};
  for (const { name, fromParam } of mappings) {
    const spec = entry.launch.params[fromParam];
    if (!spec) continue; // schema-validated at load; belt and braces
    const raw = rawConfig[aliases[fromParam] ?? fromParam];
    if (typeof raw !== 'string') continue;
    if (spec.type === 'enum' && !spec.values.includes(raw)) continue;
    if (spec.type === 'token' && !matchesPattern(spec.pattern, raw)) continue;
    out[name] = raw;
  }
  return out;
}

/**
 * Which `capabilities.gates` are currently satisfied. `resolveVersion` is called AT MOST
 * ONCE, and only when the entry actually declares a gate — a `--version` subprocess probe
 * has no reason to run for an entry with none.
 */
function resolveGatesPassed(entry: CliEntry, resolveVersion: () => string | null): Set<string> {
  const passed = new Set<string>();
  const gateEntries = Object.entries(entry.capabilities.gates);
  if (gateEntries.length === 0) return passed;
  const cliVersion = resolveVersion();
  if (!cliVersion) return passed; // fail-closed: an unknown version satisfies no gate
  for (const [name, gate] of gateEntries) {
    if (compareVersions(cliVersion, gate.minVersion) >= 0) passed.add(name);
  }
  return passed;
}

/**
 * Render the spawn command for `entry` from the legacy option bag. Returns `undefined` for a
 * `shell`-kind entry (or any entry declaring no launch variants), which callers take as "fall
 * back to the local login-shell resolution" — shell has no CLI to template.
 */
export function buildSpawnCommandFromRegistry(entry: CliEntry, options: SpawnBridgeOptions): string | undefined {
  if (entry.kind === 'shell' || entry.launch.variants.length === 0) return undefined;

  const params = buildParamsFromLegacyConfig(entry, legacyConfigFor(entry, options));

  const engineValues: EngineValues = {
    sessionId: options.sessionId,
    // Allowlist-sanitized (Unicode letters/digits + ` . _ : -`, 64 chars), matching
    // buildNameCliArgs exactly — sanitizeCliSessionName is the injection guard for this
    // value, NOT the `quote: 'double'` escaping on the --name arg (which only makes an
    // unsafe value inert, it does not launder one into something meaningful).
    sessionName: sanitizeCliSessionName(options.sessionName),
  };

  // Only a launcher CLI has one, and resolving it means a filesystem scan of the launcher's
  // profile tree, so skip the lookup entirely for the eight entries that declare no profile.
  if (entry.discovery.launcherProfile !== undefined) {
    engineValues.launcherDefaultTarget = launcherDefaultTarget(entry) ?? undefined;
  }

  // Mirrors buildEffortCliArgs exactly: ultracode carries a fixed settings blob, every other
  // level rides a plain `--effort <level>` flag. Reusing the canonical builder here (rather
  // than re-deriving the ultracode special case) keeps the EFFORT_LEVELS allowlist and the
  // settings-JSON shape single-sourced in session-cli-builder.ts.
  const [effortFlag, effortValue] = buildEffortCliArgs(options.effort);
  if (effortFlag === '--effort') {
    engineValues.effortLevel = effortValue;
  }

  // Fold the ephemeral plan-usage statusLine exporter (see resolveStatusLineCliCommand in
  // hooks-config.ts) into the SAME `--settings` JSON object as ultracode/ effort, since Claude
  // Code accepts only one `--settings` flag per invocation — rendering them as two independent
  // params would let the second one silently win. Claude-only in practice (statusLineCommand
  // is resolved claude-mode-only upstream), but this merge is mode-agnostic.
  if ((effortFlag === '--settings' && effortValue) || options.statusLineCommand) {
    const settingsObj: Record<string, unknown> =
      effortFlag === '--settings' && effortValue ? JSON.parse(effortValue) : {};
    if (options.statusLineCommand) {
      settingsObj.statusLine = { type: 'command', command: options.statusLineCommand };
    }
    engineValues.effortSettingsJson = JSON.stringify(settingsObj);
  }

  // Preserves buildSpawnCommand's original fallback exactly: an EXPLICIT `undefined` probes
  // the local claude CLI (getClaudeCliVersion, null under vitest); an explicit `null` means
  // "known to be unresolvable" and must not probe. The probe only ever runs from
  // resolveGatesPassed, and only for an entry that actually declares a gate, so this stays
  // generic without spawning a stray `claude --version` for every other CLI's launch.
  const gatesPassed = resolveGatesPassed(entry, () =>
    options.claudeCliVersion !== undefined ? options.claudeCliVersion : getClaudeCliVersion()
  );

  return renderLaunch(entry.launch, params, engineValues, gatesPassed);
}
