/**
 * @fileoverview Story Mode against real sessions. Each fixture in test/fixtures/story-corpus/ is the
 * transcript of a real Claude Code worker that a review agent had build a small program while Story
 * Mode drew it (2026-10-18), cut down to the lines and fields the reducer reads, with every path,
 * user name and email rewritten and file contents of Reads left out. The expected file beside each
 * pins every page: panel kinds, captions, balloons, counts. A change that alters one fails here, and
 * the diff shows exactly which story changed. After an intended change, regenerate with
 * `STORY_CORPUS_UPDATE=1 npm test -- test/story-corpus.test.ts` and read the diff before committing.
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildStoryPage, buildStoryTurns, createStoryReducer } from '../src/story-mode.js';

const DIR = join(import.meta.dirname, 'fixtures', 'story-corpus');
const NAMES = readdirSync(DIR)
  .filter((f) => f.endsWith('.jsonl'))
  .map((f) => f.slice(0, -'.jsonl'.length))
  .sort();

/** What a reader sees of each turn: the page's facts and every panel's kind, words and counts. */
function pagesOf(name: string) {
  const reducer = createStoryReducer();
  const entries = readFileSync(join(DIR, `${name}.jsonl`), 'utf8')
    .split('\n')
    .filter(Boolean)
    .flatMap((line) => reducer.reduce(JSON.parse(line)));
  return buildStoryTurns(entries).map((turn) => {
    const p = buildStoryPage(turn);
    return {
      prompt: p.prompt.slice(0, 100),
      origin: p.origin,
      complete: p.complete,
      interrupted: p.interrupted,
      durationMs: p.durationMs ?? null,
      toolCalls: p.toolCalls,
      filesChanged: p.filesChanged,
      added: p.added,
      removed: p.removed,
      helpers: p.helpers,
      helpersRunning: p.helpersRunning,
      finishedLater: p.finishedLater ?? 0,
      openNote: p.openNote ?? false,
      asks: p.asks ?? false,
      panels: p.panels.map((x) => ({
        kind: x.kind,
        ok: x.ok ?? null,
        story: x.caption.story,
        unaskedSave: x.unaskedSave ?? false,
        director: x.caption.director,
        balloon: x.balloon?.text ?? null,
        tests: x.tests ?? null,
        roundsOk: x.roundsOk ?? null,
        printed: x.printed ?? null,
        events: x.events.length,
      })),
    };
  });
}

describe('Story Mode on real sessions', () => {
  it('has the corpus', () => {
    expect(NAMES.length).toBeGreaterThanOrEqual(11);
  });

  it.each(NAMES)('%s draws as it did when it was checked by hand', (name) => {
    const pages = pagesOf(name);
    const file = join(DIR, `${name}.expected.json`);
    if (process.env.STORY_CORPUS_UPDATE === '1') writeFileSync(file, `${JSON.stringify(pages, null, 2)}\n`);
    expect(pages).toEqual(JSON.parse(readFileSync(file, 'utf8')));
  });

  // The beats the review rounds were about, stated outright (the expected files hold everything else).
  const panel = (name: string, turn: number, kind: string) => pagesOf(name)[turn].panels.find((p) => p.kind === kind);

  it('a fix, a failing test (exit code hidden by a pipe), a fix and a pass fold into one loop', () => {
    // Three runs in two rounds: the failing test asked for, then ruff, then a pass (the marks: ✗ ✗ ✓).
    expect(panel('python-cli-fix-loop', 0, 'loop')).toMatchObject({
      // The failing test was a real bug, the second failure only ruff: said apart, with the 4 commits made inside.
      story:
        'Fix and test, 2 rounds: a test fails and Claude fixes it, then a formatting check fails and Claude fixes that; everything passes. Claude starts a git repository and saves the work in 4 commits along the way.',
      roundsOk: [false, false, true],
    });
  });

  it('a prompt typed mid-turn (a queued_command attachment) is drawn where Claude took it in', () => {
    expect(
      panel('long-turn-prompt-added', 0, 'mission') && pagesOf('long-turn-prompt-added')[0].panels[4]
    ).toMatchObject({
      kind: 'mission',
      story: 'You add something while Claude works.',
    });
  });

  it("teammates' reports are their own turns, and every turn ends without turn_duration", () => {
    const pages = pagesOf('teammates-then-interrupt');
    expect(pages.map((p) => [p.origin, p.complete || p.interrupted])).toEqual([
      ['human', true],
      ['task', true],
      ['task', true],
      ['human', true],
      ['human', true],
    ]);
    expect(pages[3].panels.at(-1)?.story).toBe(
      'You stop Claude here, during its step 3 (new tests under test/). Saved before the stop: 2 commits.'
    );
  });

  it('a commit at the end of a test one-liner is kept, and a background helper reports back in 9 s', () => {
    expect(panel('text-plan-dry-run-helper', 0, 'check')?.story).toBe(
      // test_csvstat.py was written a panel before and only patched here.
      'Claude writes pyproject.toml and changes test_csvstat.py; the tests pass, then Claude starts a git repository and saves the work on a new branch (feat/csvstat).'
    );
    expect(panel('text-plan-dry-run-helper', 0, 'plan')?.story).toBe('Claude writes a plan: 4 steps.');
    expect(pagesOf('text-plan-dry-run-helper')[1]).toMatchObject({ origin: 'task', durationMs: 9008 });
  });

  it('/compact is one turn of its own, and an approved plan says so', () => {
    const pages = pagesOf('compact-then-plan-mode');
    expect(pages[1].panels.map((p) => p.kind)).toEqual(['mission', 'compact', 'complete']);
    expect(pages[1].panels[0].story).toBe('You run /compact.');
    expect(panel('compact-then-plan-mode', 2, 'ask')?.story).toBe('Claude shows you its plan, and you approve it.');
    expect(pages[2].filesChanged).toBe(2);
  });

  it('a push that went through, with a step after it that failed, says both', () => {
    expect(panel('question-tests-first-push', 0, 'save')).toMatchObject({
      ok: true,
      // One commit, then a push in a command of its own: one commit, not two.
      // The folder had no repository: the first save starts one, and the reader is told.
      story:
        'Claude starts a git repository, saves the work: "add kebab CLI that turns text into URL slugs" and copies it to remote.git, a folder on this computer, but a check after that fails.',
    });
  });

  it('tests that do not load, a commit then a push in its own command, a push with a failing step after it', () => {
    const [first, second, third] = pagesOf('errors-push-append');
    expect(first.panels.find((p) => p.kind === 'check')?.story).toBe("The tests don't even load, as you asked.");
    expect(second.panels.find((p) => p.kind === 'loop')).toMatchObject({
      // The prompt asked for it ("it should fail because mode is missing"): the user's idea, not Claude's.
      story: 'The first run fails on purpose, as you asked; the second passes.',
      roundsOk: [false, true],
    });
    expect(second.panels.find((p) => p.kind === 'save')?.story).toBe(
      // `git describe --tags` failed after the push; `; echo "exit=$?"` hid it from the exit code, not from the output.
      'Claude saves the work: "add calc_stats.mode with smallest-value tie-breaking" and copies it to origin.git, a folder on this computer, but a check after that fails, as you said it might.'
    );
    expect(third.panels.find((p) => p.kind === 'save')?.story).toBe(
      'Claude saves the work: "add NOTES.md describing mode behavior" and copies it to origin.git, a folder on this computer, but a check after that fails, as you said it might.'
    );
  });

  it('helpers and a command in the background: their reports are turns of their own, counted where they started', () => {
    const pages = pagesOf('background-helpers-reports');
    expect(pages[0].panels.find((p) => p.kind === 'backup')?.story).toBe(
      'Claude sends 2 helpers off to work in the background.'
    );
    expect(pages[0].helpers).toBe(2);
    for (const report of [pages[1], pages[2], pages[4], pages[5]]) {
      expect(report.origin).toBe('task');
      expect(report.helpers).toBe(0);
      expect(report.panels[0].story).toBe('A background job reports back.');
    }
    expect(pages[3].panels.map((p) => p.story)).toContain(
      'Claude starts the tests in the background; later they pass.'
    );
    // A python script that rewrote README.md counts as a change, beside the two files written.
    expect(pages[3].panels.map((p) => p.story)).toContain('Claude changes 3 files.');
  });

  it("Claude's last words keep what a reader must not lose (round 8, the cold readers)", () => {
    const last = (name: string, turn: number) => pagesOf(name)[turn].panels.at(-1)!;
    // An open problem, said further into the final message than its first sentence.
    expect(last('web-page-node-test', 0).balloon).toMatch(/won't work if you double-click index\.html/);
    // ...and the turn is not drawn as a clean finish.
    expect(pagesOf('web-page-node-test')[0].openNote).toBe('catch');
    expect(last('text-plan-dry-run-helper', 1).balloon).toMatch(/doesn't fix it/);
    // What you expected, and what you asked for mid-turn.
    expect(last('errors-push-append', 2).balloon).toMatch(/As you expected, git describe --tags then failed/);
    expect(last('long-turn-prompt-added', 0).balloon).toMatch(/--csv is part of the CLI commit/);
    // A helper's warning that turned out to be out of date, with what it was about.
    expect(last('teammates-then-interrupt', 1).balloon).toMatch(/didn't exist yet\. That's out of date/);
    expect(last('teammates-then-interrupt', 2).balloon).toMatch(/they had looked before I created it/);
  });

  it('helpers still out when a turn ended finished later, and the page says so', () => {
    expect(pagesOf('background-helpers-reports')[0].panels.at(-1)!.story).toBe(
      "Claude's part is done in 36 seconds. Its 2 helpers finished later and reported back."
    );
    expect(pagesOf('background-helpers-reports')[0].finishedLater).toBe(2);
  });

  it('a lookup of tools reads as getting them ready, without their names; for plan mode, as getting ready to plan', () => {
    const panel = pagesOf('compact-then-plan-mode')
      .flatMap((p) => p.panels)
      .find((p) => p.story === 'Claude gets ready to plan.');
    expect(panel).toBeTruthy();
  });

  it('an ending that says Claude did not follow your wording is a note, not a clean finish (round 10)', () => {
    const [, exact] = pagesOf('long-turn-prompt-added');
    expect(exact.openNote).toBe('note');
    expect(exact.panels.at(-1)!.balloon).toMatch(/Steps 5, 10 and 15: I added a second -m/);
  });

  it('the saves no prompt asked for are marked on their first panel (round 11)', () => {
    const marked = (name: string) =>
      pagesOf(name).flatMap((p, t) => p.panels.filter((x) => x.unaskedSave).map((x) => `T${t + 1} ${x.kind}`));
    expect(marked('compact-then-plan-mode')).toEqual(['T1 save', 'T3 save']);
    expect(marked('python-cli-fix-loop')).toEqual(['T1 loop']);
    expect(marked('text-plan-dry-run-helper')).toEqual(['T1 check']);
    // The prompt asked to commit and push: nothing to mark.
    expect(marked('question-tests-first-push')).toEqual([]);
  });

  it('a helper reporting back is heard in its own words, not only "finished" (round 9)', () => {
    const [, readme, extra] = pagesOf('background-helpers-reports');
    expect(readme.panels[0].balloon).toBe(
      '"Helper A: write README.md" reports back with the file it wrote: README.md.'
    );
    // What the helper did not do is on the page, and a long path does not crowd it out.
    expect(extra.panels[0].balloon).toMatch(
      /^"Helper B: write extra pytest tests" reports: I wrote the file: tests\/test_extra\.py /
    );
    expect(extra.panels[0].balloon).toMatch(/I haven't run it against the real wordcount\.py\.$/);
  });

  it('a blocked command ends a turn where nothing worked, without a celebration', () => {
    const last = pagesOf('teammates-then-interrupt')[4];
    expect(last.panels.map((p) => p.story)).toEqual([
      'You give Claude a job.',
      'Claude tries a command, and it is blocked.',
      'Nothing Claude tried worked, so the job is not done.',
    ]);
  });
});
