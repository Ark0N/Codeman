/**
 * @fileoverview Static guard: no code outside the stock catalog branches on a CLI's ID.
 *
 * The whole point of the registry is that behaviour which differs between CLIs is DATA (a
 * `CliEntry` field) or a NAMED PROFILE selected by a field — never `mode === 'codex'`. A
 * single reintroduced id-check is how the old shape grows back, one "just this once" at a
 * time, until adding a CLI means editing forty files again.
 *
 * This guard was cited by name in three separate file headers of an earlier attempt at this
 * refactor and never actually written — and in its absence four id-branches survived that
 * migration, one of them dead code sitting directly under the generic check that replaced it.
 * So the guard is not decoration: it is the thing that makes the rule true rather than
 * aspirational.
 *
 * ## What is allowlisted, and why an allowlist rather than zero
 *
 * Some branches are not CLI-behaviour branches at all, and forcing them through a capability
 * would make the code worse, not better. Each entry below carries its reason. The categories:
 *
 *  - **Legacy `<Mode>Config` plumbing.** `POST /api/sessions` has carried named per-CLI
 *    config objects since before the registry, and `docs/versioning-policy.md` makes that
 *    wire shape public. Selecting `codexConfig` for codex is a fact about the HTTP API, not
 *    about codex, and the `Session` constructor mirrors it. The registry already owns the
 *    translation (`launch.legacyConfigField`); collapsing the constructor too is a public-API
 *    change and belongs in its own PR.
 *  - **Claude's remote/docker command construction.** Claude's pane command varies with the
 *    session's permission mode and its docker form is `--session-id … || resume`, semantics
 *    no other CLI has and a static `overlays.command` string cannot express.
 *  - **Genuinely per-CLI prose.** One error message that explains why a deepseek session in
 *    particular will never deliver a `stop` signal.
 *
 * ⚠️ Adding an entry here is a decision, not a formality. If the branch is about what a CLI
 * CAN DO, it belongs in `CliCapabilities` instead — and if it needs to run code, in
 * `config/cli-registry/profiles.ts` as a named profile.
 *
 * Port: none (pure static analysis).
 */

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { STOCK_CLIS } from '../src/config/cli-registry/stock.js';

const SRC = fileURLToPath(new URL('../src', import.meta.url));

/**
 * Files exempt from the scan entirely, because naming CLI ids IS their job.
 *
 * `stock.ts` is the catalog. The per-CLI resolver modules are each ABOUT one CLI and look up
 * their own entry by id — the same reason the catalog may, and the reason they are not a
 * loophole: they resolve a binary, they decide no behaviour.
 */
const EXEMPT_FILES = new Set(
  [
    'config/cli-registry/stock.ts',
    'utils/claude-cli-resolver.ts',
    'utils/opencode-cli-resolver.ts',
    'utils/codex-cli-resolver.ts',
    'utils/gemini-cli-resolver.ts',
    'utils/antigravity-cli-resolver.ts',
    'utils/pi-cli-resolver.ts',
    'utils/grok-cli-resolver.ts',
    'utils/deepseek-cli-resolver.ts',
    // Names the deepseek launcher profile's implementation; keyed by profile, not by id.
    'utils/cli-launcher.ts',
  ].map((p) => p.split('/').join(sep))
);

/**
 * Specific surviving branches, each with the reason it is not a capability.
 * Keyed `<relative path>::<the matched expression>`.
 */
const ALLOWED_BRANCHES: Record<string, string> = {
  // --- Legacy <Mode>Config plumbing (public wire shape, see the header) ---
  "web/routes/session-routes.ts::mode === 'opencode'": 'legacy <Mode>Config plumbing',
  "web/routes/session-routes.ts::mode === 'codex'": 'legacy <Mode>Config plumbing',
  "web/routes/session-routes.ts::mode === 'gemini'": 'legacy <Mode>Config plumbing',
  "web/routes/session-routes.ts::mode === 'antigravity'": 'legacy <Mode>Config plumbing',
  "web/routes/session-routes.ts::mode === 'pi'": 'legacy <Mode>Config plumbing',
  "web/routes/session-routes.ts::mode === 'grok'": 'legacy <Mode>Config plumbing',
  "web/routes/session-routes.ts::mode === 'deepseek'": 'legacy <Mode>Config plumbing',
  "web/server.ts::mode === 'opencode'": 'legacy <Mode>Config plumbing (session recovery)',
  "web/server.ts::mode === 'codex'": 'legacy <Mode>Config plumbing (session recovery)',
  "web/server.ts::mode === 'gemini'": 'legacy <Mode>Config plumbing (session recovery)',
  "web/server.ts::mode === 'antigravity'": 'legacy <Mode>Config plumbing (session recovery)',
  "web/server.ts::mode === 'pi'": 'legacy <Mode>Config plumbing (session recovery)',
  "web/server.ts::mode === 'grok'": 'legacy <Mode>Config plumbing (session recovery)',
  "web/server.ts::mode === 'deepseek'": 'legacy <Mode>Config plumbing (session recovery)',
  "web/server.ts::mode === 'omp'": 'legacy <Mode>Config plumbing (session recovery)',

  // --- Claude's remote/docker command construction ---
  "tmux-manager.ts::mode === 'claude'":
    "claude's remote pane command carries per-session permission flags, and its docker form is " +
    '`--session-id … || resume`; neither fits a static overlays.command string',
  "tmux-manager.ts::mode === 'omp'":
    'remote omp respawn needs the pinned/continue --resume override threaded through ' +
    '(resumeSessionId/ompConfig), which the static overlays.remote.command string has no ' +
    'room for; the command itself is still rendered through buildSpawnCommandFromRegistry, ' +
    'the same mode-agnostic engine local/docker spawns use — only the BRANCH is per-mode',

  // --- Per-CLI prose and launch handling not yet generalised ---
  "web/session-wait-registry.ts::mode === 'deepseek'":
    'an error message explaining why THIS mode in particular will never deliver a stop signal',
  "web/routes/approval-routes.ts::mode === 'deepseek'":
    'the DeepSeek status bridge is the only non-claude source of approval items',
  "cron/cron-service.ts::mode === 'claude'": 'cron launch handling, not yet generalised',
  "cron/cron-service.ts::mode === 'shell'": 'cron launch handling, not yet generalised',
  "web/routes/session-routes.ts::mode === 'claude'": 'docker case bookkeeping keyed on the claude conversation id',
  "cli.ts::mode === 'shell'": 'a CLI-table label, not behaviour',

  // --- Negated forms surfaced when BRANCH_PATTERN widened past `===` (see its comment) ---
  //
  // None of these is a regression: every one predates the registry and survived the
  // conversion only because the guard could not see `!==`. They are listed here with reasons
  // rather than silently converted, because each would change behaviour or invent a
  // capability field, and this change is meant to change nothing a user can see.

  // Read My Mind + intent capture read CLAUDE's OWN transcript, so `mode === 'claude'` is
  // the right question and `hooksAvailableForMode()` is NOT — once `deepseek` earned a yes
  // there, the shared predicate silently widened both to a mode with no transcript to read.
  // CLAUDE.md documents this as deliberate and `test/deepseek-mode.test.ts` pins it, so a
  // capability here would be actively wrong.
  "web/routes/readmymind-routes.ts::mode !== 'claude'":
    'deliberately mode-not-capability; pinned by deepseek-mode.test.ts',
  "web/server.ts::mode !== 'claude'":
    "intent capture reads Claude's own transcript, and the recovered-workspace hook sweep " +
    'writes .claude hooks — both are claude questions, not capability ones (see CLAUDE.md)',

  // The TUI is a CLIENT of the server, and these two are about what it can offer for a row:
  // resume builds a `claude --resume`, and the mode badge is suppressed for the default mode
  // purely so the common case reads clean. The badge one is cosmetic and not a capability at
  // all; the resume one would need a "resumable from a claude transcript" field that nothing
  // else would read.
  "tui/tui-app.ts::mode !== 'claude'": 'TUI resume builds a claude --resume; claude-transcript-only by construction',
  "tui/tui-render.ts::mode !== 'claude'": 'cosmetic: suppress the mode badge for the default mode',

  // Push approve/deny BUTTONS are withheld for dsh because the answer route refuses
  // keystrokes for its dialogs (third-party TUI, unmeasured contract) — a button whose
  // answer would be refused is worse than none. Arguably wants an "answerable dialogs"
  // capability; deliberately not invented here.
  "web/routes/hook-event-routes.ts::mode !== 'deepseek'":
    'push buttons withheld where the answer route refuses keystrokes',

  // Legacy <Mode>Config plumbing, same category as the `===` entries above.
  "web/routes/session-routes.ts::mode !== 'omp'": 'legacy <Mode>Config plumbing (resolveOmpConfigForCreate)',

  // ⚠️ Scaffolded-case hooks. This chain excludes seven CLIs but NOT `deepseek`, while its
  // own comment says DeepSeek uses its own system — so a scaffolded deepseek case gets a
  // Claude hooks block written into it. That inconsistency is UPSTREAM's and predates this
  // change; expressing the chain as a capability would have to pick a side and would
  // therefore be a behaviour change. Left exactly as found, and named here so it is visible.
  "web/routes/session-routes.ts::mode !== 'opencode'":
    'scaffolded-case hooks + the COD-91 self-heal skip; the chain omits deepseek upstream, ' +
    'so any capability form would change behaviour — see PR discussion',
  "web/routes/session-routes.ts::mode !== 'codex'": 'scaffolded-case hooks (see the opencode entry)',
  "web/routes/session-routes.ts::mode !== 'gemini'": 'scaffolded-case hooks (see the opencode entry)',
  "web/routes/session-routes.ts::mode !== 'antigravity'": 'scaffolded-case hooks (see the opencode entry)',
  "web/routes/session-routes.ts::mode !== 'pi'": 'scaffolded-case hooks (see the opencode entry)',
  "web/routes/session-routes.ts::mode !== 'grok'": 'scaffolded-case hooks (see the opencode entry)',
};

/** Every stock CLI id, derived rather than restated so a new entry is covered automatically. */
const IDS = STOCK_CLIS.map((e) => e.id as string);
const ID_ALT = IDS.join('|');

/**
 * The shapes an id-branch actually takes, all four of them.
 *
 * ⚠️ An earlier version of this guard matched `===` ONLY, and that was not a small gap: the
 * refactor it guards converted the `===` sites and left the negated ones, so 36
 * `mode !== '<id>'` branches survived it — 28 in session-routes.ts alone, including a
 * seven-mode chain auto-enabling Ralph under a comment asking the next person to keep it in
 * step with a predicate BY HAND, while the sibling quick-start path already read
 * `capabilities.ralph`. A guard that sees half the shapes reports a count measured over the
 * half it happens to catch.
 *
 * `switch`/`case` and `[...].includes(mode)` are here for the same reason: each is a way of
 * writing the banned rule that the narrower pattern could not see.
 */
const BRANCH_PATTERN = new RegExp(
  [
    // mode === 'codex'  /  mode !== 'codex'
    `\\b(?:mode|id|agentType)\\s*[!=]==\\s*'(?:${ID_ALT})'`,
    // case 'codex':
    `\\bcase\\s+'(?:${ID_ALT})'\\s*:`,
    // ['codex', 'gemini'].includes(mode) — the id list IS the branch, wherever `mode` sits
    `'(?:${ID_ALT})'\\s*(?:,\\s*'(?:${ID_ALT})'\\s*)*\\]\\s*\\.includes\\(`,
  ].join('|'),
  'g'
);

/**
 * BLANK comment lines before scanning, rather than dropping them. Comments legitimately quote
 * the very pattern being banned — several of them explain WHY a branch was removed — and
 * flagging those would push the next author to delete the explanation rather than the code.
 *
 * ⚠️ Blanking rather than removing is what keeps reported line numbers pointing at the real
 * file. Dropping the lines shifted every finding upward by however many comments preceded it,
 * so the guard's own diagnostic sent you to the wrong place — which for a rule about not
 * writing a branch is exactly the moment you need the right one.
 */
function uncommented(source: string): string {
  return source
    .split('\n')
    .map((line) => (/^\s*(\/\/|\*|\/\*)/.test(line) ? '' : line))
    .join('\n');
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (name.endsWith('.ts')) out.push(full);
  }
  return out;
}

interface Finding {
  file: string;
  expression: string;
  line: number;
  key: string;
}

function scan(): { findings: Finding[]; filesScanned: number } {
  const findings: Finding[] = [];
  const files = walk(SRC);
  let scanned = 0;
  for (const full of files) {
    const rel = relative(SRC, full);
    if (EXEMPT_FILES.has(rel)) continue;
    scanned++;
    const lines = uncommented(readFileSync(full, 'utf-8')).split('\n');
    lines.forEach((line, i) => {
      BRANCH_PATTERN.lastIndex = 0; // shared /g regex — see utils/regex-patterns.ts
      for (const match of line.matchAll(BRANCH_PATTERN)) {
        const expression = match[0].replace(/\s+/g, ' ').replace(/^(?:id|agentType)/, 'mode');
        const posix = rel.split(sep).join('/');
        findings.push({ file: posix, expression, line: i + 1, key: `${posix}::${expression}` });
      }
    });
  }
  return { findings, filesScanned: scanned };
}

const { findings, filesScanned } = scan();

describe('no CLI-id branching outside the stock catalog', () => {
  it('scans a meaningful number of source files (sanity)', () => {
    // If this collapses toward zero the walker or the exemption list drifted and every
    // assertion below would pass vacuously. Fix the scanner, do not delete the test.
    expect(filesScanned).toBeGreaterThan(100);
  });

  it('builds its id list from the live catalog (sanity)', () => {
    expect(IDS).toContain('claude');
    expect(IDS).toContain('deepseek');
    expect(IDS.length).toBeGreaterThanOrEqual(9);
  });

  it('still detects a branch when one exists (anti-vacuity)', () => {
    // Proves the pattern actually matches every shape it is meant to ban, so a regex typo
    // cannot silently turn this whole file into a no-op. One case per alternative, because
    // the `===`-only version of this test passed happily while `!==` went unseen.
    const samples = [
      "if (session.mode === 'codex') { doSomething(); }",
      "if (mode !== 'shell' && mode !== 'deepseek') { doSomething(); }",
      "switch (mode) { case 'gemini': return 1; }",
      "if (['codex', 'gemini'].includes(mode)) { doSomething(); }",
    ];
    for (const sample of samples) {
      BRANCH_PATTERN.lastIndex = 0;
      expect(sample.match(BRANCH_PATTERN), `pattern missed: ${sample}`).not.toBeNull();
    }
    BRANCH_PATTERN.lastIndex = 0;
    expect(uncommented("  // mode === 'codex'\ncode();").match(BRANCH_PATTERN)).toBeNull();
  });

  it('has no unapproved id branches', () => {
    const offenders = findings.filter((f) => !(f.key in ALLOWED_BRANCHES));
    const detail = offenders.map((f) => `  ${f.file}:${f.line}  ${f.expression}`).join('\n');
    expect(
      offenders,
      offenders.length === 0
        ? ''
        : `Found ${offenders.length} CLI-id branch(es) outside the stock catalog:\n${detail}\n\n` +
            'Two ways out, in order of preference:\n' +
            '  1. Express the difference as data on the CliEntry (a CliCapabilities field), or as a\n' +
            '     NAMED PROFILE in config/cli-registry/profiles.ts if it genuinely needs to run code.\n' +
            '  2. If it is not a CLI-behaviour branch at all, add it to ALLOWED_BRANCHES in this file\n' +
            "     WITH the reason. Read this file's header before choosing option 2."
    ).toEqual([]);
  });

  it('has no stale allowlist entries', () => {
    // An allowlisted branch that no longer exists is a lie about the codebase, and the next
    // person to reintroduce that exact branch would sail straight through.
    const present = new Set(findings.map((f) => f.key));
    const stale = Object.keys(ALLOWED_BRANCHES).filter((key) => !present.has(key));
    expect(stale, `ALLOWED_BRANCHES entries no longer present — delete them:\n  ${stale.join('\n  ')}`).toEqual([]);
  });
});

describe('declared-for-later fields', () => {
  /**
   * The fields `CliEntry`'s header declares as not-yet-read. Each is frontend behaviour, and
   * the frontend is untouched by this change.
   *
   * This is here so the list cannot quietly GROW. An unread field is a promise the code does
   * not keep, and the failure mode is a reader trusting one: the next person sees
   * `echo.policy: 'buffer'` on an entry and assumes the terminal honours it. Adding a field
   * nobody reads should be a decision someone makes on purpose, which means updating this
   * list — and wiring one up should make its line here fail, which is the good direction.
   */
  const DECLARED_FOR_LATER = [
    'shortBadge',
    'accent',
    'capabilities.echo',
    'capabilities.wheelForward',
    'capabilities.keyboardAccessory',
    'capabilities.maxFrameBytes',
    // The Docker credential-seeding path still reads its own CRED_STORES table: this shape
    // allows ONE store per CLI and the live table needs two for gemini. See CliOverlays.
    'overlays.credStore',
  ];

  /** Read every `.ts` under src/, minus the registry itself (which of course names them). */
  function sourceOutsideRegistry(): string {
    const parts: string[] = [];
    const stack = [SRC];
    while (stack.length > 0) {
      const dir = stack.pop()!;
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) {
          if (name !== 'cli-registry') stack.push(full);
          continue;
        }
        if (name.endsWith('.ts')) parts.push(uncommented(readFileSync(full, 'utf-8')));
      }
    }
    return parts.join('\n');
  }

  /**
   * Receivers whose same-named property is NOT this field. A leaf-name match is all a static
   * check can do, and `cli.ts` calls `palette.accent('admin')` — the terminal colour helper,
   * unrelated to `CliEntry.accent`. Listing the receiver is better than dropping the field
   * from the check: a real read through any OTHER receiver still fails.
   */
  const UNRELATED_RECEIVERS: Record<string, string[]> = { accent: ['palette'] };

  const outside = sourceOutsideRegistry();

  it.each(DECLARED_FOR_LATER)('%s is still unread outside the registry', (field) => {
    const leaf = field.split('.').pop()!;
    const ignore = UNRELATED_RECEIVERS[leaf] ?? [];
    // `.<leaf>` as a property access. Comment lines are already blanked, so a mention in
    // prose does not count as a read; a receiver listed above does not either.
    const pattern = new RegExp(`(\\w*)\\.${leaf}\\b`, 'g');
    const uses = [...outside.matchAll(pattern)].filter((m) => !ignore.includes(m[1])).map((m) => m[0]);
    expect(
      uses,
      `${field} now looks READ outside config/cli-registry. If that is deliberate, drop it ` +
        "from DECLARED_FOR_LATER here and from CliEntry's header comment — the point of both " +
        'is that a reader can tell which fields are load-bearing.'
    ).toEqual([]);
  });

  it('still catches a read when there is one (anti-vacuity)', () => {
    // The check is only worth having if it fires, so prove it against a field that IS read.
    // `capabilities.ralph` is live in session-routes; if this ever stops matching, the
    // scanner has drifted and every assertion above is passing vacuously.
    expect(outside).toMatch(/\.ralph\b/);
    expect(DECLARED_FOR_LATER.length).toBeGreaterThan(0);
  });
});
