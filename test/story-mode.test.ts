/**
 * @fileoverview Story Mode core (src/story-mode.ts): transcript lines → entries → turns → comic page.
 * Pure functions on invented transcripts (test/story-fixtures.ts). Port: N/A.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  STORY_LIMITS,
  buildStoryPage,
  buildStoryTurns,
  classifyBashCommand,
  createStoryReducer,
  exactDuration,
  firstSentence,
  parseTestCounts,
  roughDuration,
  summarizeTurns,
  type StoryEntry,
} from '../src/story-mode.js';
import { bash, demoTurn, edit, end, prompt, read, resetClock, result, said, tool } from './story-fixtures.js';

function entriesOf(lines: unknown[]): StoryEntry[] {
  const reducer = createStoryReducer();
  return lines.flatMap((l) => reducer.reduce(l));
}
const pageOf = (lines: unknown[]) => {
  const turns = buildStoryTurns(entriesOf(lines));
  return buildStoryPage(turns[turns.length - 1]);
};

beforeEach(() => resetClock());

describe('classifyBashCommand', () => {
  it.each([
    ['npm test', 'test'],
    ['npm test > out.log 2>&1', 'test'],
    ['cd app && npx vitest run src/a.test.ts', 'test'],
    ['python3 -m pytest -q', 'test'],
    ['npm run typecheck', 'build'],
    ['npx eslint src', 'build'],
    ['git commit -m "fix"', 'save'],
    ['git push origin HEAD', 'save'],
    ['gh pr create --title x', 'save'],
    ["sed -i 's/a/b/' file.ts", 'edit'],
    ['echo hi > notes.txt', 'edit'],
    ['cat > config.json <<EOF', 'edit'],
    ['ls -la', 'look'],
    ['cd src && grep -rn foo .', 'look'],
    ['git status --short', 'look'],
    ['ls 2>/dev/null', 'look'],
    ['curl -s localhost:3000/api/status', 'run'],
    ['node scripts/build.mjs', 'run'],
  ])('%s → %s', (command, intent) => {
    expect(classifyBashCommand(command)).toBe(intent);
  });
});

describe('parseTestCounts', () => {
  it.each([
    [' Tests  1 failed | 41 passed (42)', { passed: 41, failed: 1 }],
    ['Tests:       2 failed, 40 passed, 42 total', { passed: 40, failed: 2 }],
    ['==== 1 failed, 41 passed in 6.31s ====', { passed: 41, failed: 1 }],
    ['  41 passing (2s)\n  1 failing\n', { passed: 41, failed: 1 }],
    ['test result: ok. 42 passed; 0 failed; 0 ignored', { passed: 42, failed: 0 }],
  ])('reads %j', (output, expected) => {
    expect(parseTestCounts(output)).toEqual(expected);
  });

  it('returns null without a summary line', () => {
    expect(parseTestCounts('compiled successfully')).toBeNull();
  });
});

describe('text helpers', () => {
  it('firstSentence strips markdown and stops at the first sentence', () => {
    expect(firstSentence('**Found it.** The `banner` covers [the button](http://x).')).toBe('Found it.');
    expect(firstSentence('No full stop here')).toBe('No full stop here');
  });

  it('formats durations for both captions', () => {
    expect(roughDuration(432_000)).toBe('7 minutes');
    expect(exactDuration(432_000)).toBe('7 min 12 s');
    expect(roughDuration(4_000)).toBe('4 seconds');
    expect(roughDuration(3_900_000)).toBe('1 h 5 min');
  });
});

describe('createStoryReducer', () => {
  it('never keeps file contents, originals or images', () => {
    const entries = entriesOf([prompt('go'), ...read('r1', '/w/a.ts'), ...edit('e1', '/w/a.ts', ['+x'])]);
    const text = JSON.stringify(entries);
    expect(text).not.toContain('FILE CONTENT');
    expect(text).not.toContain('WHOLE ORIGINAL FILE');
  });

  it('keeps an edit as structuredPatch hunks with exact counts', () => {
    const entries = entriesOf([prompt('go'), ...edit('e1', '/w/a.ts', [' a', '-b', '+c', '+d'], 7)]);
    const r = entries.find((e) => e.k === 'result');
    expect(r).toMatchObject({
      k: 'result',
      edit: {
        file: '/w/a.ts',
        added: 2,
        removed: 1,
        created: false,
        hunks: [{ oldStart: 7, lines: [' a', '-b', '+c', '+d'] }],
      },
    });
  });

  it('turns a new file written with Write into added lines', () => {
    const entries = entriesOf([
      prompt('go'),
      tool('w1', 'Write', { file_path: '/w/new.ts', content: 'a\nb\n' }),
      result('w1', 'File created', {
        toolUseResult: { type: 'create', filePath: '/w/new.ts', content: 'a\nb\n', structuredPatch: [] },
      }),
    ]);
    expect(entries.find((e) => e.k === 'result')).toMatchObject({
      edit: { created: true, added: 2, removed: 0, hunks: [{ lines: ['+a', '+b'] }] },
    });
  });

  it('keeps only the tail of a long output', () => {
    const long = Array.from({ length: 500 }, (_, i) => `line ${i}`).join('\n');
    const entries = entriesOf([prompt('go'), ...bash('b1', 'node x.js', 'Run it', long)]);
    const r = entries.find((e) => e.k === 'result') as Extract<StoryEntry, { k: 'result' }>;
    expect(r.outputTruncated).toBe(true);
    expect(r.output?.split('\n')).toHaveLength(STORY_LIMITS.outputLines);
    expect(r.output?.endsWith('line 499')).toBe(true);
  });

  it('skips meta, compact summaries, companions, sidechains and local command wrappers', () => {
    const entries = entriesOf([
      prompt('meta', { isMeta: true }),
      prompt('summary', { isCompactSummary: true }),
      prompt('companion', { turnCompanion: true }),
      prompt('side', { isSidechain: true }),
      prompt('<local-command-stdout>ok</local-command-stdout>'),
      prompt('<bash-input>ls</bash-input>'),
    ]);
    expect(entries).toEqual([]);
  });

  it('reads slash commands, task notifications, interrupts and strips system reminders', () => {
    const entries = entriesOf([
      prompt('<command-name>/review</command-name><command-args>42</command-args>'),
      prompt('<task-notification><summary>Build finished</summary></task-notification>', {
        turnOrigin: 'task_notification',
      }),
      prompt('[Request interrupted by user]'),
      prompt('Fix it<system-reminder>secret plumbing</system-reminder>'),
    ]);
    expect(entries.map((e) => (e.k === 'prompt' ? [e.k, e.text, e.origin] : [e.k]))).toEqual([
      ['prompt', '/review 42', 'human'],
      ['prompt', 'Build finished', 'task'],
      ['interrupt'],
      ['prompt', 'Fix it', 'human'],
    ]);
  });

  it('ignores lines that are not transcript objects', () => {
    const reducer = createStoryReducer();
    expect(reducer.reduce(null)).toEqual([]);
    expect(reducer.reduce('text')).toEqual([]);
    expect(reducer.reduce({ type: 'ai-title', title: 'x' })).toEqual([]);
  });
});

describe('buildStoryTurns', () => {
  it('splits turns at prompts and ends them at turn_duration', () => {
    const turns = buildStoryTurns(
      entriesOf([prompt('one'), said('ok'), end(1000), prompt('two'), ...bash('b', 'ls', 'List', 'a')])
    );
    expect(turns.map((t) => [t.prompt, t.ended])).toEqual([
      ['one', true],
      ['two', false],
    ]);
    expect(turns[0].durationMs).toBe(1000);
  });

  it('a prompt queued while Claude works joins the running turn', () => {
    const turns = buildStoryTurns(
      entriesOf([prompt('one'), ...bash('b', 'ls', 'List', 'a'), prompt('also this', { promptSource: 'queued' })])
    );
    expect(turns).toHaveLength(1);
    expect(turns[0].events.filter((e) => e.intent === 'prompt')).toHaveLength(2);
  });

  it('marks a turn whose prompt is outside the window as partial', () => {
    const turns = buildStoryTurns(entriesOf([...bash('b', 'ls', 'List', 'a'), end(5000)]));
    expect(turns[0]).toMatchObject({ partial: true, prompt: '', ended: true });
  });

  it('flags failed calls and pending calls', () => {
    const turns = buildStoryTurns(
      entriesOf([
        prompt('go'),
        ...bash('b1', 'npm test', 'Test', 'Exit code 1', true),
        tool('b2', 'Bash', { command: 'sleep 9' }),
      ])
    );
    const [failed, running] = turns[0].events.filter((e) => e.tool === 'Bash');
    expect(failed).toMatchObject({ ok: false, intent: 'test' });
    expect(running).toMatchObject({ pending: true });
    expect(running.ok).toBeUndefined();
  });

  it('an interrupt ends the turn', () => {
    const turns = buildStoryTurns(
      entriesOf([prompt('go'), ...bash('b', 'ls', 'List', 'a'), prompt('[Request interrupted by user]')])
    );
    expect(turns[0]).toMatchObject({ ended: true, interrupted: true });
    expect(summarizeTurns(turns)[0]).toMatchObject({ complete: false, interrupted: true });
  });
});

describe('buildStoryPage', () => {
  it('draws the demo turn as mission, investigate, plan, backup, loop, save, complete', () => {
    const page = pageOf(demoTurn());
    expect(page.panels.map((p) => p.kind)).toEqual([
      'mission',
      'investigate',
      'plan',
      'backup',
      'loop',
      'save',
      'complete',
    ]);
    expect(page).toMatchObject({ complete: true, toolCalls: 10, filesChanged: 1, added: 2, removed: 1, helpers: 1 });
  });

  it('writes plain story captions and tool-level director captions', () => {
    const page = pageOf(demoTurn());
    const byKind = Object.fromEntries(page.panels.map((p) => [p.kind, p]));
    expect(byKind.mission.caption.story).toBe('You give Claude a job.');
    expect(byKind.investigate.caption.story).toBe('Claude reads 2 files to find its way around.');
    expect(byKind.investigate.caption.director).toBe('Read ×2 · Bash');
    expect(byKind.plan.caption.story).toBe('Claude writes a plan: 2 steps.');
    expect(byKind.backup.caption.story).toBe('Claude calls in 1 helper.');
    expect(byKind.backup.caption.director).toContain('3 calls inside');
    expect(byKind.loop).toMatchObject({ rounds: 2, ok: true, added: 2, removed: 1 });
    expect(byKind.loop.caption.story).toBe('Fix and test, 2 rounds. It passes in the end.');
    expect(byKind.save.caption.story).toBe('Claude saves the work.');
    expect(byKind.complete.caption.story).toBe('Done in 7 minutes.');
    expect(byKind.complete.caption.director).toContain('7 min 12 s');
  });

  it('gives balloons to the prompt and to what Claude says before a panel and at the end', () => {
    const page = pageOf(demoTurn());
    expect(page.panels[0].balloon).toEqual({
      who: 'you',
      text: 'The checkout button does nothing on phones. Can you fix it?',
    });
    expect(page.panels[1].balloon).toEqual({ who: 'claude', text: 'Let me see how checkout works.' });
    expect(page.panels[page.panels.length - 1].balloon).toEqual({ who: 'claude', text: 'Fixed.' });
  });

  it('lists files and keeps edits reachable from the panel', () => {
    const page = pageOf(demoTurn());
    const investigate = page.panels.find((p) => p.kind === 'investigate');
    expect(investigate?.files).toEqual([
      '/work/demo-shop/src/checkout/CheckoutButton.tsx',
      '/work/demo-shop/src/styles/banner.css',
    ]);
    const loop = page.panels.find((p) => p.kind === 'loop');
    const editEvents = loop?.events.map((i) => page.events[i]).filter((e) => e.edit);
    expect(editEvents?.map((e) => e.edit?.hunks[0].lines)).toEqual([
      ['   z-index: 50;', '+  pointer-events: none;', ' }'],
      ['-.promo-banner__inner { pointer-events: auto; }', '+.promo-banner__cta { pointer-events: auto; }'],
    ]);
  });

  it('a failing check says so and reads the test counts', () => {
    const page = pageOf([
      prompt('go'),
      ...bash('b1', 'npm test', 'Run tests', ' Tests  3 failed | 39 passed (42)', true),
    ]);
    const check = page.panels.find((p) => p.kind === 'check');
    expect(check).toMatchObject({ ok: false, tests: { passed: 39, failed: 3 }, live: true });
    expect(check?.caption.story).toBe('3 tests fail.');
  });

  it('an unfinished turn has no complete panel and marks its newest panel live', () => {
    const page = pageOf([prompt('go'), ...read('r1', '/w/a.ts'), said('Now the fix.')]);
    expect(page.panels.map((p) => p.kind)).toEqual(['mission', 'investigate']);
    expect(page.panels[1]).toMatchObject({ live: true });
    expect(page.complete).toBe(false);
  });

  it('folds a long turn into montage panels so the page fits', () => {
    const lines: unknown[] = [prompt('big job')];
    for (let i = 0; i < 30; i++) {
      lines.push(...read(`r${i}`, `/w/f${i}.ts`));
      lines.push(...bash(`b${i}`, `node step${i}.js`, `Step ${i}`, 'ok'));
    }
    lines.push(end(60_000));
    const page = pageOf(lines);
    expect(page.panels.length).toBeLessThanOrEqual(STORY_LIMITS.panelsPerPage);
    expect(page.panels[0].kind).toBe('mission');
    expect(page.panels[page.panels.length - 1].kind).toBe('complete');
    expect(page.panels.some((p) => p.kind === 'montage')).toBe(true);
    // Every tool call is still on the page, in some panel.
    expect(new Set(page.panels.flatMap((p) => p.events)).size).toBe(61);
  });

  it('drops the oldest outputs first when a page is over its text budget', () => {
    const big = 'x'.repeat(7000);
    const lines: unknown[] = [prompt('go')];
    for (let i = 0; i < 80; i++) lines.push(...bash(`b${i}`, `node s${i}.js`, `Step ${i}`, big));
    const page = pageOf(lines);
    expect(page.truncated).toBe(true);
    const bashEvents = page.events.filter((e) => e.tool === 'Bash');
    expect(bashEvents[0].output).toBeUndefined();
    expect(bashEvents[0].outputTruncated).toBe(true);
    expect(bashEvents[bashEvents.length - 1].output).toBe(big);
  });

  it('an origin other than you changes the mission caption', () => {
    const page = pageOf([
      prompt('<task-notification><summary>Build done</summary></task-notification>', {
        turnOrigin: 'task_notification',
      }),
      said('Nice.'),
      end(1000),
    ]);
    expect(page.panels[0].caption.story).toBe('A background job reports back.');
    expect(page.origin).toBe('task');
  });
});
