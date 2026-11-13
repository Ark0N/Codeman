/**
 * @fileoverview The argv rendering engine — turns a `CliLaunch` spec plus a set of resolved
 * parameter values into the shell command string that goes into `bash -c "..."`.
 *
 * SECURITY MODEL (read before touching this file):
 *
 * 1. Config contains no shell text. There is no `command: "..."` field anywhere in the
 *    schema. An entry declares a sequence of typed tokens (`ArgSpec`); this module is the
 *    ONLY place that turns them into a string, and it owns every separator itself: a single
 *    space between tokens, and ` || ` between fallback variants. Neither can originate from
 *    config, because config has no field that could hold either.
 * 2. Every literal (`lit`, `flag`, `value`) is validated against `SAFE_BARE_TOKEN` — no
 *    space, quote, backtick, `$`, `;`, `&`, `|`, `<`, `>`, parens, braces, newline or
 *    backslash — at LOAD time (see schema.ts), so a bad literal fails registry validation
 *    rather than reaching this renderer.
 * 3. Every `valueFrom` resolves through a declared `ParamSpec`, whose `token` variant names
 *    a PATTERN rather than accepting one — see patterns.ts. A value that fails its pattern
 *    causes the WHOLE ArgSpec to be dropped, exactly like the hand-written builders this
 *    replaces (an invalid `--model` value silently omits `--model`, it does not substitute
 *    something else).
 * 4. Escaping and validation are independent. `renderToken()` always re-checks the resolved
 *    value against `SAFE_BARE_TOKEN` before emitting it unquoted; anything else is
 *    single-quote-escaped. So even a value that somehow bypassed pattern validation is still
 *    quoted, never concatenated raw.
 *
 * @module config/cli-registry/argv
 */

import type { ArgSpec, CliLaunch, Cond, EngineValue, ParamSpec, QuoteStyle } from './types.js';
import { matchesPattern } from './patterns.js';
import { SAFE_BARE_TOKEN } from './patterns.js';

/** Resolved parameter values, keyed by the name declared in `CliLaunch.params`. */
export type ParamValues = Record<string, string | boolean | undefined>;

/** Values the caller supplies for the reserved engine params. */
export type EngineValues = Partial<Record<EngineValue, string>>;

/**
 * POSIX single-quote escaping: end-quote, escaped-literal-quote, restart-quote. Identical in
 * shape to the three copies already in the codebase (tmux-manager.ts, remote-hosts.ts,
 * docker-hosts.ts) — kept local rather than importing one of them so this module has no
 * dependency on the files it is replacing.
 */
function singleQuoteEscape(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function doubleQuoteEscape(value: string): string {
  // Escape the characters that are special inside a double-quoted bash string. SAFE_BARE_TOKEN
  // already excludes all of them, so in practice this never fires; kept as defense in depth.
  return `"${value.replace(/([$`"\\])/g, '\\$1')}"`;
}

/**
 * Render a single resolved value per its requested quote style. `auto` (the default) emits
 * bare only when the value is provably safe; every other case single-quotes.
 */
function renderToken(value: string, style: QuoteStyle | undefined): string {
  const safe = SAFE_BARE_TOKEN.test(value);
  switch (style) {
    case 'double':
      return doubleQuoteEscape(value);
    case 'single':
      return singleQuoteEscape(value);
    case 'bare':
      return safe ? value : singleQuoteEscape(value);
    case 'auto':
    default:
      return safe ? value : singleQuoteEscape(value);
  }
}

/** Resolve one parameter to a plain string, or undefined if it is unset / invalid. */
function resolveParam(
  name: string,
  spec: ParamSpec | undefined,
  params: ParamValues,
  engineValues: EngineValues
): string | undefined {
  if (!spec) return undefined;
  if (spec.type === 'engine') return engineValues[spec.source];

  const raw = params[name];
  if (raw === undefined) return spec.type === 'enum' ? spec.default : undefined;

  if (spec.type === 'bool') return typeof raw === 'boolean' ? String(raw) : undefined;
  if (spec.type === 'enum') {
    const s = String(raw);
    return spec.values.includes(s) ? s : spec.default;
  }
  // token
  const s = String(raw);
  return matchesPattern(spec.pattern, s) ? s : undefined;
}

/** Is the resolved value "set" for the purposes of a `state` condition? */
function isSet(name: string, params: ParamValues, resolved: (n: string) => string | undefined): boolean {
  if (name in params) {
    const raw = params[name];
    if (typeof raw === 'boolean') return true; // a bool param is always "set" once declared
  }
  return resolved(name) !== undefined;
}

function evalCond(
  cond: Cond | undefined,
  params: ParamValues,
  resolved: (n: string) => string | undefined,
  gatesPassed: ReadonlySet<string>
): boolean {
  if (!cond) return true;
  if ('allOf' in cond) return cond.allOf.every((c) => evalCond(c, params, resolved, gatesPassed));
  if ('anyOf' in cond) return cond.anyOf.some((c) => evalCond(c, params, resolved, gatesPassed));
  if ('not' in cond) return !evalCond(cond.not, params, resolved, gatesPassed);
  if ('capabilityGate' in cond) return gatesPassed.has(cond.capabilityGate);
  if ('state' in cond) {
    const set = isSet(cond.param, params, resolved);
    return cond.state === 'set' ? set : !set;
  }
  // { param, is }
  const raw = params[cond.param];
  if (typeof cond.is === 'boolean') return raw === cond.is;
  return resolved(cond.param) === cond.is;
}

function renderArg(
  spec: ArgSpec,
  params: ParamValues,
  resolved: (n: string) => string | undefined,
  gatesPassed: ReadonlySet<string>
): string | null {
  if (!evalCond(spec.when, params, resolved, gatesPassed)) return null;

  if ('lit' in spec) return spec.lit;
  if ('flag' in spec && !('value' in spec) && !('valueFrom' in spec)) return spec.flag;
  if ('flag' in spec && 'value' in spec) return `${spec.flag} ${renderToken(spec.value, spec.quote)}`;
  if ('flag' in spec && 'valueFrom' in spec) {
    const v = resolved(spec.valueFrom);
    return v === undefined ? null : `${spec.flag} ${renderToken(v, spec.quote)}`;
  }
  // bare positional
  const v = resolved((spec as { valueFrom: string }).valueFrom);
  return v === undefined ? null : renderToken(v, (spec as { quote?: QuoteStyle }).quote);
}

/**
 * Render one CLI's launch command. Returns the full `bash -c` payload — never a shell
 * fragment with embedded newlines or unescaped separators, by construction (see file header).
 *
 * `gatesPassed` — the set of `capabilities.gates` keys whose version requirement is
 * currently satisfied. Callers compute this once per spawn (it depends on a version probe),
 * never inside the renderer, keeping this function pure and easy to test byte-for-byte.
 */
export function renderLaunch(
  launch: CliLaunch,
  params: ParamValues,
  engineValues: EngineValues,
  gatesPassed: ReadonlySet<string> = new Set()
): string {
  const cache = new Map<string, string | undefined>();
  const resolved = (name: string): string | undefined => {
    if (cache.has(name)) return cache.get(name);
    const v = resolveParam(name, launch.params[name], params, engineValues);
    cache.set(name, v);
    return v;
  };

  const passing = launch.variants.filter((variant) => evalCond(variant.when, params, resolved, gatesPassed));
  const chosen = launch.chain === 'fallback' ? passing : passing.slice(0, 1);

  const rendered = chosen.map((variant) =>
    variant.args
      .map((arg) => renderArg(arg, params, resolved, gatesPassed))
      .filter((tok): tok is string => tok !== null)
      .join(' ')
  );

  return rendered.join(' || ');
}
