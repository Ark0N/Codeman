/**
 * @fileoverview Named value patterns for the CLI registry's argv engine.
 *
 * Config entries select a pattern BY NAME; the regexes themselves live here, in code.
 * That is deliberate and is the reason a user-editable `clis.json` cannot widen its own
 * validation: there is no field anywhere in the schema that accepts a raw regex for a
 * shell token, so no entry can supply `.*` (nor a catastrophically backtracking one).
 *
 * The sole user-supplied regex in the whole registry is `discovery.version.regex`, which
 * is applied to `--version` OUTPUT rather than to a shell token, and goes through
 * `compileVersionRegex()` below.
 *
 * Every pattern here is transcribed from the builder it replaces in tmux-manager.ts, so
 * the argv engine accepts and rejects exactly the values the hand-written builders did.
 *
 * @module config/cli-registry/patterns
 */

/** Names a value pattern. Config may only reference these. */
export type TokenPattern =
  | 'model'
  | 'model-claude'
  | 'model-pi'
  | 'id'
  | 'id-dotted'
  | 'uuid'
  | 'slug'
  | 'path-segment'
  | 'tool-list'
  | 'config-kv';

/**
 * The patterns, each traced to the builder it came from.
 *
 * ⚠️ These are ALLOWLISTS (`^...$` over a safe character class), never blocklists — with
 * one deliberate exception, `tool-list`, which mirrors the existing `--allowedTools`
 * sanitizer. That one is a metacharacter REJECTION because tool specs legitimately contain
 * `(`, `)`, `*`, `:` and spaces (`Bash(git:*), Read`), so an allowlist of safe words cannot
 * express it. Keeping it byte-identical to the original matters more than making it uniform.
 */
const PATTERNS: Record<TokenPattern, RegExp> = {
  // buildOpenCodeCommand / buildCodexCommand / buildGeminiCommand / buildAntigravityCommand
  model: /^[a-zA-Z0-9._\-/]+$/,
  // buildSpawnCommand's claude branch — `[` and `]` for bracketed model aliases
  'model-claude': /^[a-zA-Z0-9._\-[\]]+$/,
  // buildPiCommand — `:` for a thinking suffix (`sonnet:high`), `/` for `provider/id`
  'model-pi': /^[a-zA-Z0-9._\-/:]+$/,
  // opencode --session, codex resume
  id: /^[a-zA-Z0-9_-]+$/,
  // gemini --resume, antigravity --conversation, pi --session
  'id-dotted': /^[a-zA-Z0-9._-]+$/,
  // claude --resume / --session-id
  uuid: /^[a-f0-9-]+$/,
  // pi --provider
  slug: /^[a-z0-9-]+$/,
  // dsh --profile. Deliberately STRICTER than `id-dotted`: a profile name is both
  // interpolated into the shell line AND joined into a filesystem path, so it must be a
  // single path segment. Requiring a leading alphanumeric is what rules out `.`, `..` and
  // dotfile names, which `id-dotted` would happily accept.
  'path-segment': /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/,
  // codex --config tui.animations=false
  'config-kv': /^[A-Za-z0-9._-]+=[A-Za-z0-9._-]+$/,
  // Placeholder; `tool-list` is handled by isSafeToolList() below, not by a match.
  'tool-list': /^$/,
};

/**
 * Shell metacharacters rejected in an `--allowedTools` value. Transcribed verbatim from
 * buildClaudePermissionFlags so the accepted set does not move.
 */
const TOOL_LIST_DANGEROUS = /[;&|$`\\{}<>'"[\]\n\r]/;

/** Does `value` satisfy the named pattern? */
export function matchesPattern(pattern: TokenPattern, value: string): boolean {
  if (pattern === 'tool-list') return value.length > 0 && !TOOL_LIST_DANGEROUS.test(value);
  return PATTERNS[pattern].test(value);
}

/** Every pattern name, for schema validation and error messages. */
export const TOKEN_PATTERNS = Object.keys(PATTERNS) as TokenPattern[];

/**
 * Characters a token may contain and still be emitted UNQUOTED into the `bash -c "..."`
 * command string. Intentionally narrower than "what bash tolerates": anything outside it
 * gets single-quoted, so the classification can only ever err toward more quoting.
 */
export const SAFE_BARE_TOKEN = /^[A-Za-z0-9._:@=+/,-]+$/;

/**
 * Longest `--version` output we will run a user-supplied regex over. A version banner is a
 * line or two; anything larger is a misconfiguration, and capping the input is what keeps a
 * sloppy (not necessarily malicious) regex from becoming a stall.
 */
export const MAX_VERSION_OUTPUT = 200;

/** Longest permitted `discovery.version.regex` source. */
const MAX_VERSION_REGEX_SOURCE = 200;

/**
 * Nested quantifiers — `(a+)+`, `(a*)*`, `(a+)*` and friends — the classic catastrophic
 * backtracking shape. Rejected outright rather than analysed: this field exists to pull a
 * semver out of a banner, and nothing legitimate for that job needs a nested quantifier.
 */
const NESTED_QUANTIFIER = /\([^)]*[+*][^)]*\)\s*[+*{]/;

/**
 * Compile a user-supplied version regex, or return null if it is not one we are willing to
 * run. Returning null (rather than throwing) lets the caller degrade to "version unknown",
 * which every consumer already handles.
 */
export function compileVersionRegex(source: string): RegExp | null {
  if (source.length > MAX_VERSION_REGEX_SOURCE) return null;
  if (NESTED_QUANTIFIER.test(source)) return null;
  try {
    // No `g`: a global regex carries lastIndex state across calls, which is a documented
    // footgun in this codebase (see utils/regex-patterns.ts).
    return new RegExp(source);
  } catch {
    return null;
  }
}

/**
 * How many capture groups a regex source declares (named ones included), or -1 when it
 * does not compile. Matching the empty string against `source|` always succeeds through
 * the empty alternative, and the match array then has one slot per group.
 */
export function countCaptureGroups(source: string): number {
  try {
    return (new RegExp(`${source}|`).exec('') as RegExpExecArray).length - 1;
  } catch {
    return -1;
  }
}
