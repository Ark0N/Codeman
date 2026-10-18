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
      panels: p.panels.map((x) => ({
        kind: x.kind,
        ok: x.ok ?? null,
        story: x.caption.story,
        director: x.caption.director,
        balloon: x.balloon?.text ?? null,
        tests: x.tests ?? null,
        events: x.events.length,
      })),
    };
  });
}

describe('Story Mode on real sessions', () => {
  it('has the corpus', () => {
    expect(NAMES.length).toBeGreaterThanOrEqual(9);
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
    expect(panel('python-cli-fix-loop', 0, 'loop')?.story).toBe(
      'Fix and test: the first run fails, the second passes.'
    );
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
    expect(pages[3].panels.at(-1)?.story).toBe('You stop Claude here.');
  });

  it('a commit at the end of a test one-liner is kept, and a background helper reports back in 9 s', () => {
    expect(panel('text-plan-dry-run-helper', 0, 'check')?.story).toBe(
      'Claude writes 2 files; the tests pass, and Claude saves the work.'
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
      story: 'Claude saves the work in 2 commits and uploads it, but a step after that fails.',
    });
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
