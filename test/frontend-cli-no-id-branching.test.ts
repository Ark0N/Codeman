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
 * Every currently-surviving branch, each with the reason it is not a
 * CLI-behaviour branch a `CliCapabilities` field should express, keyed
 * `<file>::<line>::<the matched expression>`. Found by running the scanner
 * below against the post-B2 state of both files (2026-09-19) and reviewing
 * each hit in context — none of these are leftover oversights, each is a
 * verified, deliberate exception.
 */
const ALLOWED_BRANCHES: Record<string, string> = {
  // --- run(): claude/shell get their own dispatch path, everything else goes ---
  // --- through the shared _runCliMode() — see RUN_MODE_LAUNCH's header comment ---
  "session-ui.js::507::mode === 'shell'": 'run() dispatch: shell needs no CLI probe at all',
  "session-ui.js::510::mode === 'claude'":
    'run() dispatch: claude has its own remote/docker branching and parallel-create path ' +
    '(runClaude), unlike every RUN_MODE_LAUNCH entry',

  // --- runCustomModelEntry(): claude restarts its CLI process in place; every ---
  // --- other custom-model-eligible CLI applies the pick one-shot, before the ---
  // --- session exists at all. Documented in CLAUDE.md's Custom Model Endpoint ---
  // --- Profiles section: "Two launch paths, chosen by mechanism, not preference." ---
  "session-ui.js::862::mode === 'claude'": 'restart-vs-one-shot custom-model launch mechanism, not a preference',

  // --- Button-label ternary (Open Question 7, DEPLOYMENT_PLAN.md): pinned by ---
  // --- test/run-mode-ui.test.ts's exact-text assertions (e.g. 'Run OMP'), which ---
  // --- diverge from CliEntry.shortBadge for at least one CLI (omp: 'OM' vs the ---
  // --- displayed 'OMP') — a catalogue-driven rewrite would silently change ---
  // --- user-visible text and break that pinned test. ---
  "session-ui.js::1527::mode === 'opencode'": 'button-label ternary, pinned exact text (see Open Question 7)',
  "session-ui.js::1527::mode === 'codex'": 'button-label ternary, pinned exact text (see Open Question 7)',
  "session-ui.js::1527::mode === 'gemini'": 'button-label ternary, pinned exact text (see Open Question 7)',
  "session-ui.js::1527::mode === 'antigravity'": 'button-label ternary, pinned exact text (see Open Question 7)',
  "session-ui.js::1527::mode === 'pi'": 'button-label ternary, pinned exact text (see Open Question 7)',
  "session-ui.js::1527::mode === 'grok'": 'button-label ternary, pinned exact text (see Open Question 7)',
  "session-ui.js::1527::mode === 'deepseek'": 'button-label ternary, pinned exact text (see Open Question 7)',
  "session-ui.js::1527::mode === 'omp'": 'button-label ternary, pinned exact text (see Open Question 7)',
  "session-ui.js::1527::mode === 'shell'": 'button-label ternary, pinned exact text (see Open Question 7)',

  // --- Respawn/Ralph section: claude-only by product design, mirroring the ---
  // --- backend's own capabilities.ralph gate (isExternalCliMode() already ---
  // --- excludes Ralph tracking for every non-claude mode server-side). ---
  "session-ui.js::2200::mode === 'claude'": 'Respawn/Ralph section is claude-only by design',

  // --- runMode property setter: a validity allowlist, not a behaviour branch. ---
  // --- Left untouched in Phase 2 (uncertain 'shell' asymmetry — this chain has ---
  // --- no shell arm at all — and no evidence of what callers rely on it). ---
  "session-ui.js::4431::mode === 'opencode'": 'runMode setter validity check, not behaviour',
  "session-ui.js::4431::mode === 'codex'": 'runMode setter validity check, not behaviour',
  "session-ui.js::4431::mode === 'gemini'": 'runMode setter validity check, not behaviour',
  "session-ui.js::4431::mode === 'antigravity'": 'runMode setter validity check, not behaviour',
  "session-ui.js::4431::mode === 'pi'": 'runMode setter validity check, not behaviour',
  "session-ui.js::4431::mode === 'grok'": 'runMode setter validity check, not behaviour',
  "session-ui.js::4431::mode === 'deepseek'": 'runMode setter validity check, not behaviour',
  "session-ui.js::4431::mode === 'omp'": 'runMode setter validity check, not behaviour',
  "session-ui.js::4431::mode === 'claude'": 'runMode setter validity check, not behaviour',

  // --- mobile-overview.js: shell is exempt from the isCliAvailable() gate the ---
  // --- same way the toolbar's #runModeMenu exempts it (shell needs no CLI). ---
  "mobile-overview.js::574::mode !== 'shell'": 'shell needs no CLI, so it is exempt from the availability gate',
};

/** Every stock CLI id, derived rather than restated so a new entry is covered automatically. */
const IDS = STOCK_CLIS.map((e) => e.id as string);
const ID_ALT = IDS.join('|');

/** Same four shapes as the backend guard — see its own comment for why all four matter. */
const BRANCH_PATTERN = new RegExp(
  [
    `\\b(?:mode|id|agentType)\\s*[!=]==\\s*'(?:${ID_ALT})'`,
    `\\bcase\\s+'(?:${ID_ALT})'\\s*:`,
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
        const expression = match[0].replace(/\s+/g, ' ').replace(/^(?:id|agentType)/, 'mode');
        findings.push({ file, expression, line: i + 1, key: `${file}::${i + 1}::${expression}` });
      }
    });
  }
  return findings;
}

const findings = scan();

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
            '  1. Derive the difference from window.__codemanCliCatalog (server.ts) or a shared\n' +
            '     module-level constant, the way _runCliMode()/EXTERNAL_CLI_MODES do.\n' +
            '  2. If it is a genuine mechanism difference (not a CLI-behaviour branch), add it to\n' +
            '     ALLOWED_BRANCHES in this file WITH the reason.'
    ).toEqual([]);
  });

  it('has no stale allowlist entries', () => {
    // An allowlisted branch that no longer exists at that line is a lie about the
    // codebase, and the next person to reintroduce that exact branch elsewhere
    // would sail straight through under the old line number.
    const present = new Set(findings.map((f) => f.key));
    const stale = Object.keys(ALLOWED_BRANCHES).filter((key) => !present.has(key));
    expect(stale, `ALLOWED_BRANCHES entries no longer present — delete them:\n  ${stale.join('\n  ')}`).toEqual([]);
  });
});
