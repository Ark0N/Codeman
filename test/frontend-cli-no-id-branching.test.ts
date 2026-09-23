/**
 * @fileoverview Static guard: no NEW CLI-id branch in the two files PR B2 touched
 * (`session-ui.js`, `mobile-overview.js`), mirroring
 * `test/cli-registry-no-id-branching.test.ts` for the backend registry.
 *
 * Deliberately scoped to ONLY these two files, not all of `src/web/public/`.
 * `docs/cli-registry.md` and CLAUDE.md are explicit that the rest of the
 * frontend (`app.js`, `terminal-ui.js`, `styles.css`, `settings-ui.js`, …)
 * keeps its own hand-authored per-CLI rules deliberately — "moving them is
 * its own piece of work verified by a browser/mobile suite the CI gate cannot
 * see." Widening this guard to the whole directory would force either fixing
 * or allowlisting dozens of branches in files nobody has touched or reviewed
 * for this change, which is scope B2 never took on.
 *
 * Port: none (pure static analysis).
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { STOCK_CLIS } from '../src/config/cli-registry/stock.js';

const PUBLIC = fileURLToPath(new URL('../src/web/public/', import.meta.url));
const SCANNED_FILES = ['session-ui.js', 'mobile-overview.js'];

/**
 * Every currently-surviving branch, each with the COUNT of physical call
 * sites carrying it and the reason none of them is a `CliCapabilities`
 * field, keyed `<file>::<the matched expression>` — deliberately NO line
 * number. An earlier version keyed on `<file>::<line>::<expression>`, and
 * inserting one comment line at the top of `session-ui.js` shifted every
 * subsequent line number, so all 21 entries went stale and the same 21
 * branches were then reported as "new". `session-ui.js` is one of the most
 * contended files in the repo, so a guard that goes red on any unrelated
 * edit to it sends the next person after the wrong problem.
 *
 * The `count` is what closes the gap dropping the line number opened: a key
 * alone says "this expression is approved somewhere in this file", so a
 * BRAND NEW `mode === 'codex'` site anywhere in `session-ui.js` would reuse
 * the same key as the two approved ones and pass silently. The count makes
 * that a mismatch — one more occurrence than declared — and the "counts
 * match" test below catches it, while a genuinely new expression (a CLI id
 * with no ALLOWED_BRANCHES entry at all) is still caught by the separate
 * "no unapproved id branches" test either way.
 */
const ALLOWED_BRANCHES: Record<string, { count: number; reason: string }> = {
  "session-ui.js::mode === 'shell'": {
    count: 2,
    reason:
      'run() dispatch (shell needs no CLI probe at all) and the button-label ternary (pinned exact ' +
      "text — test/run-mode-ui.test.ts asserts e.g. 'Run OMP', which diverges from CliEntry.shortBadge " +
      "for at least omp ('OM' vs the displayed 'OMP'), so a catalogue-driven rewrite would silently " +
      'change user-visible text and break that pinned test; the maintainer confirmed leaving this ' +
      'hardcoded, see the PR #458 review thread)',
  },

  "session-ui.js::mode === 'claude'": {
    count: 4,
    reason:
      'four claude-specific call sites, not one branch: run() dispatch (claude has its own ' +
      'remote/docker branching and parallel-create path, unlike every RUN_MODE_LAUNCH entry), ' +
      'runCustomModelEntry() (restart-vs-one-shot launch mechanism, not a preference — see ' +
      "CLAUDE.md's Custom Model Endpoint Profiles section), the Respawn/Ralph section (claude-only " +
      "by design, mirroring the backend capabilities.ralph gate), and the runMode setter's " +
      'validity check',
  },

  // The 8 external CLIs share the same two call sites and the same reason at
  // each: the button-label ternary (see the shell entry above for why it
  // stays hardcoded) and the runMode property setter's validity allowlist
  // (not a behaviour branch; left hardcoded in Phase 2 since its chain has
  // no shell arm at all and no evidence of what callers rely on it).
  "session-ui.js::mode === 'opencode'": { count: 2, reason: 'button-label ternary + runMode setter validity check' },
  "session-ui.js::mode === 'codex'": { count: 2, reason: 'button-label ternary + runMode setter validity check' },
  "session-ui.js::mode === 'gemini'": { count: 2, reason: 'button-label ternary + runMode setter validity check' },
  "session-ui.js::mode === 'antigravity'": {
    count: 2,
    reason: 'button-label ternary + runMode setter validity check',
  },
  "session-ui.js::mode === 'pi'": { count: 2, reason: 'button-label ternary + runMode setter validity check' },
  "session-ui.js::mode === 'grok'": { count: 2, reason: 'button-label ternary + runMode setter validity check' },
  "session-ui.js::mode === 'deepseek'": { count: 2, reason: 'button-label ternary + runMode setter validity check' },
  "session-ui.js::mode === 'omp'": { count: 2, reason: 'button-label ternary + runMode setter validity check' },

  // The docker adopt-preflight status line and the docker link/adopt toast
  // both list the agent CLIs probed INSIDE the container and leave `shell`
  // out of that human-readable "found ..." summary (it is always present and
  // is not an agent CLI). Written as `(m) => m !== 'shell'`, the naming the
  // original named-variable pattern could not see; the widened pattern
  // normalizes the `m` to `mode` (see BRANCH_PATTERN below).
  "session-ui.js::mode !== 'shell'": {
    count: 2,
    reason: 'display filter: the "CLIs found inside the container" summaries omit shell, which is not an agent CLI',
  },

  // mobile-overview.js: shell is exempt from the isCliAvailable() gate the
  // same way the toolbar's #runModeMenu exempts it (shell needs no CLI).
  "mobile-overview.js::mode !== 'shell'": {
    count: 1,
    reason: 'shell needs no CLI, so it is exempt from the availability gate',
  },
};

/** Every stock CLI id, derived rather than restated so a new entry is covered automatically. */
const IDS = STOCK_CLIS.map((e) => e.id as string);
const ID_ALT = IDS.join('|');

/**
 * The backend guard's four shapes (see its own comment for why all four
 * matter), with ONE deliberate widening on the first.
 *
 * The backend pattern accepts a comparison only when its left-hand side is
 * literally named `mode`, `id` or `agentType`, so both
 * `const m = this._runMode; if (m === 'codex')` and
 * `if (this._runMode !== 'gemini')` slip past it, and `session-ui.js` already
 * uses exactly that naming (`(m) => m !== 'shell'`, twice). The review of
 * PR #458 surfaced that blind spot, so here the left-hand side is ANY
 * identifier (`[\w$]+`, the leaf of a member chain), normalized to `mode` in
 * the allowlist key by `scan()` so a local rename never churns the entries.
 * Measured over both scanned files before widening: every extra hit was a
 * genuine mode comparison (the two `m !== 'shell'` filters, allowlisted
 * above), so the widening added no false positive; a future one gets an
 * allowlist entry with its reason like any other. The backend guard keeps
 * its narrower form and is deliberately not changed here.
 *
 * Still unseen, and worth knowing: a Yoda comparison (`'codex' === mode`),
 * and an id list held in a variable (`EXTERNAL.includes(mode)`), since the
 * third shape needs the literal list inline.
 */
const BRANCH_PATTERN = new RegExp(
  [
    // <identifier> === 'codex'  /  <identifier> !== 'codex' (any left-hand identifier, see above)
    `\\b[\\w$]+\\s*[!=]==\\s*'(?:${ID_ALT})'`,
    // case 'codex':
    `\\bcase\\s+'(?:${ID_ALT})'\\s*:`,
    // ['codex', 'gemini'].includes(mode) — the id list IS the branch, wherever `mode` sits
    `'(?:${ID_ALT})'\\s*(?:,\\s*'(?:${ID_ALT})'\\s*)*\\]\\s*\\.includes\\(`,
  ].join('|'),
  'g'
);

/** Blanks comment lines before scanning — see the backend guard's own comment on why. */
function uncommented(source: string): string {
  return source
    .split('\n')
    .map((line) => (/^\s*(\/\/|\*|\/\*)/.test(line) ? '' : line))
    .join('\n');
}

interface Finding {
  file: string;
  expression: string;
  line: number;
  key: string;
}

function scan(): Finding[] {
  const findings: Finding[] = [];
  for (const file of SCANNED_FILES) {
    const lines = uncommented(readFileSync(PUBLIC + file, 'utf-8')).split('\n');
    lines.forEach((line, i) => {
      BRANCH_PATTERN.lastIndex = 0; // shared /g regex — see utils/regex-patterns.ts
      for (const match of line.matchAll(BRANCH_PATTERN)) {
        // Normalize the comparison shape's left-hand identifier (whatever the
        // local is called: `id`, `agentType`, `m`, `_runMode`) to `mode`; the
        // lookahead leaves the `case`/`.includes(` shapes untouched.
        const expression = match[0].replace(/\s+/g, ' ').replace(/^[\w$]+(?=\s*[!=]==)/, 'mode');
        findings.push({ file, expression, line: i + 1, key: `${file}::${expression}` });
      }
    });
  }
  return findings;
}

const findings = scan();

function actualCounts(): Map<string, number> {
  const counts = new Map<string, number>();
  for (const f of findings) counts.set(f.key, (counts.get(f.key) ?? 0) + 1);
  return counts;
}

describe('no NEW CLI-id branching in session-ui.js / mobile-overview.js (PR B2)', () => {
  it('scans both files (sanity)', () => {
    // If this drops to zero the scanner or the file list drifted and every
    // assertion below would pass vacuously.
    const scannedBytes = SCANNED_FILES.reduce((n, f) => n + readFileSync(PUBLIC + f, 'utf-8').length, 0);
    expect(scannedBytes).toBeGreaterThan(10_000);
  });

  it('builds its id list from the live catalog (sanity)', () => {
    expect(IDS).toContain('claude');
    expect(IDS).toContain('deepseek');
    expect(IDS.length).toBeGreaterThanOrEqual(9);
  });

  it('still detects a branch when one exists (anti-vacuity)', () => {
    const samples = [
      "if (session.mode === 'codex') { doSomething(); }",
      "if (mode !== 'shell' && mode !== 'deepseek') { doSomething(); }",
      "switch (mode) { case 'gemini': return 1; }",
      "if (['codex', 'gemini'].includes(mode)) { doSomething(); }",
      // The two forms the named-variable pattern was blind to (see BRANCH_PATTERN).
      "const m = this._runMode; if (m === 'codex') { doSomething(); }",
      "if (this._runMode !== 'gemini') { doSomething(); }",
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
        : `Found ${offenders.length} new CLI-id branch(es) in session-ui.js/mobile-overview.js:\n${detail}\n\n` +
            'Two ways out, in order of preference:\n' +
            '  1. Derive the difference from a shared module-level constant, the way\n' +
            '     _runCliMode()/RUN_MODE_LAUNCH/EXTERNAL_CLI_MODES do.\n' +
            '  2. If it is a genuine mechanism difference (not a CLI-behaviour branch), add it to\n' +
            '     ALLOWED_BRANCHES in this file WITH the reason.'
    ).toEqual([]);
  });

  it('every allowlisted branch occurs exactly its declared number of times', () => {
    // This is what closes the gap the line-number removal opened (see the
    // ALLOWED_BRANCHES header comment): a key alone cannot tell "the two
    // approved sites" from "the two approved sites plus a brand new third
    // one reusing the same expression" — the count can. A mismatch in
    // either direction is real: higher means an unreviewed NEW branch
    // landed reusing an approved expression, lower means one of the
    // reviewed call sites was removed and the entry is now a stale lie
    // about the codebase (the count going to 0 is the old "stale entry"
    // case, now folded into this same check rather than a separate one).
    const actual = actualCounts();
    const mismatches: string[] = [];
    for (const [key, { count: expected }] of Object.entries(ALLOWED_BRANCHES)) {
      const got = actual.get(key) ?? 0;
      if (got !== expected) {
        mismatches.push(`  ${key}  expected ${expected}, found ${got}`);
      }
    }
    expect(
      mismatches,
      mismatches.length === 0
        ? ''
        : `ALLOWED_BRANCHES count mismatch(es):\n${mismatches.join('\n')}\n\n` +
            'A count LOWER than declared means a reviewed call site was removed — update or delete ' +
            'the entry. A count HIGHER than declared means a NEW branch landed reusing an already-' +
            'approved expression — review it and bump the count (or fix the branch) explicitly, ' +
            'rather than let it ride in on an existing approval.'
    ).toEqual([]);
  });
});
