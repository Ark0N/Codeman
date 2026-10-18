/**
 * @fileoverview Story Mode core (src/story-mode.ts): transcript lines → entries → turns → comic page.
 * Pure functions on invented transcripts (test/story-fixtures.ts). Port: N/A.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  STORY_LIMITS,
  buildHelperPage,
  buildStoryPage,
  buildStoryTurns,
  classifyBashCommand,
  createStoryReducer,
  exactDuration,
  firstSentence,
  heredocWrites,
  parseTestCounts,
  reportsProblems,
  planFromText,
  printedFiles,
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
    // Only a segment that RUNS a test is a test; naming a runner is not.
    ['which pytest', 'look'],
    ['python3 -m pytest --version', 'look'],
    ['pytest --collect-only -q', 'look'],
    ['pip show pytest', 'run'],
    ['python3 -c "import pytest"', 'run'],
    ['echo "run pytest later"', 'look'],
    ['node --test', 'test'],
    // Logging into scratch is not editing the project; a redirect into a project file is.
    ['./rename.sh --dry-run . | tee "$S/dry.txt"', 'run'],
    ['ls -A > /tmp/before.txt', 'look'],
    ['ls -A > "$S/before.txt"', 'look'],
    ['echo "a > b.txt"', 'look'],
    ['printf "x" > notes.md', 'edit'],
    ['printf "dist/\\n" >> .gitignore', 'edit'],
    ['sed --in-place s/a/b/ f.txt', 'edit'],
    // A here-document's body is data: `pytest.main()` in it runs nothing.
    ["cat > app.py <<'EOF'\nimport pytest\npytest.main()\nEOF", 'edit'],
    ['git commit -m "ignore pytest caches"', 'save'],
    // Shell structure is not a command; read-only probes are looking.
    ['for t in ruff flake8; do $t --version; done', 'look'],
    ['command -v ruff; git config --get user.name', 'look'],
    ['if pytest -q; then echo ok; fi', 'test'],
    ['node --test timer.test.mjs 2>&1 | tail -20', 'test'],
    ['timeout 60 npm test', 'test'],
    ['FOO=1 CI=true pytest -q', 'test'],
    ['cd app && make test', 'test'],
    ['python3 -m unittest discover', 'test'],
    ['make', 'build'],
    ['shellcheck rename.sh', 'build'],
    ['node --check app.js && git init -q && git add -A && git commit -qm "init"', 'save'],
    ['git -c user.name=a -c user.email=b commit -m x', 'save'],
    ['git -C repo push', 'save'],
    ['git init && git add .', 'run'],
    ['mkdir -p samples && touch samples/a.jpg', 'run'],
    ['grep -n "a|b" file.txt', 'look'],
    ["printf 'x' > out.txt", 'edit'],
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

describe('parseTestCounts beyond "N passed"', () => {
  it.each([
    ['# tests 7\n# suites 0\n# pass 7\n# fail 0', { passed: 7, failed: 0 }],
    ['ℹ tests 3\nℹ pass 2\nℹ fail 1', { passed: 2, failed: 1 }],
    ['FAILED test_a.py::test_x\n===== 3 failed in 0.12s =====', { passed: 0, failed: 3 }],
    ['==== 1 error in 0.05s ====', { passed: 0, failed: 0, errors: 1 }],
    ['=== 1 failed, 18 passed, 2 errors in 0.40s ===', { passed: 18, failed: 1, errors: 2 }],
    [' Tests  3 failed (3)', { passed: 0, failed: 3 }],
  ])('%j', (output, counts) => {
    expect(parseTestCounts(output)).toEqual(counts);
  });

  it('reportsProblems reads linters, formatters and type checkers', () => {
    expect(reportsProblems('Found 3 errors.\n[*] 2 fixable')).toBe(true);
    expect(reportsProblems('1 file would be reformatted, 4 files already formatted')).toBe(true);
    expect(reportsProblems('✖ 5 problems (3 errors, 2 warnings)')).toBe(true);
    expect(reportsProblems("src/a.ts(3,1): error TS2322: Type 'x' is not assignable")).toBe(true);
    expect(reportsProblems('All checks passed!\n5 files already formatted\nFound 0 errors.')).toBe(false);
    // The last verdict wins: a formatter's preview, then the fix.
    expect(
      reportsProblems('1 file would be reformatted\n1 file reformatted\nAll checks passed!\n10 files already formatted')
    ).toBe(false);
    expect(
      reportsProblems(
        'All checks passed!\nWould reformat: a.py\n1 file would be reformatted, 9 files already formatted'
      )
    ).toBe(true);
  });

  it('a line that only mentions a failure is not a summary', () => {
    expect(parseTestCounts('The request failed twice: 2 failed attempts')).toBeNull();
  });
});

describe('text helpers', () => {
  it('firstSentence strips markdown and stops at the first sentence', () => {
    expect(firstSentence('**Found it.** The `banner` covers [the button](http://x).')).toBe('Found it.');
    expect(firstSentence('No full stop here')).toBe('No full stop here');
  });

  it('firstSentence keeps underscores and stars that are not markdown', () => {
    expect(firstSentence('I built wcount.py and test_wcount.py.')).toBe('I built wcount.py and test_wcount.py.');
    expect(firstSentence('Renamed rename_by_date.sh to __init__.py style.')).toBe(
      'Renamed rename_by_date.sh to __init__.py style.'
    );
    expect(firstSentence('It is *really* done and _very_ fast.')).toBe('It is really done and very fast.');
    expect(firstSentence('## Summary\n- Fixed the 2*3 bug.')).toBe('Fixed the 2*3 bug.');
  });

  it('firstSentence ends a heading at its line', () => {
    expect(firstSentence('# Plan: add `wrap` to mathx.py\n\n**Context:** it has clamp().')).toBe(
      'Plan: add wrap to mathx.py.'
    );
  });

  it('firstSentence treats code spans as words and an ellipsis or e.g. as no end', () => {
    expect(firstSentence('My `mk -- ...` helper call left a stray file named `--`. Then I removed it.')).toBe(
      'My mk -- ... helper call left a stray file named --.'
    );
    expect(firstSentence('Use a flag, e.g. the dry run. Then go.')).toBe('Use a flag, e.g. the dry run.');
    expect(firstSentence('Wait... it works now. Good.')).toBe('Wait... it works now.');
  });

  it('planFromText reads numbered lists and checkboxes, never plain bullets', () => {
    expect(planFromText('Todo list:\n\n1. Check the layout.\n2. Write `rename.sh`.\n3) Test it')).toEqual([
      { text: 'Check the layout.', done: false },
      { text: 'Write rename.sh.', done: false },
      { text: 'Test it', done: false },
    ]);
    expect(planFromText('- [x] **Read** the code\n- [ ] Fix it')).toEqual([
      { text: 'Read the code', done: true },
      { text: 'Fix it', done: false },
    ]);
    expect(planFromText('Done:\n- added a flag\n- fixed a bug\n- wrote docs')).toBeNull();
    expect(planFromText('1. one\n2. two')).toBeNull();
  });

  it('printedFiles reads cat, head and tail arguments, and gives up after a cd', () => {
    expect(printedFiles('cat README.md "src/a b.ts" && head -n 20 notes.txt | grep x')).toEqual([
      'README.md',
      'src/a b.ts',
      'notes.txt',
    ]);
    expect(printedFiles('cat src/*.ts; tail -f "$LOG"')).toEqual([]);
    expect(printedFiles('cd sub && cat a.txt')).toEqual([]);
  });

  it('formats durations for both captions', () => {
    expect(roughDuration(432_000)).toBe('7 minutes');
    expect(exactDuration(432_000)).toBe('7 min 12 s');
    expect(roughDuration(4_000)).toBe('4 seconds');
    expect(roughDuration(3_900_000)).toBe('1 h 5 min');
    // Past an hour the exact one keeps its seconds, so the two never disagree on the minute.
    expect(roughDuration(4_179_269)).toBe('1 h 10 min');
    expect(exactDuration(4_179_269)).toBe('1 h 9 min 39 s');
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
    // None is a prompt; a local command's output is kept apart, as what that command printed.
    expect(entries).toEqual([{ k: 'local', at: expect.any(String), text: 'ok' }]);
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

  it('judges a Bash call on its whole command, though the label is clipped', () => {
    const long = `printf '%s' "${'x'.repeat(450)}" > /dev/null && git commit -qm "feat: add" && git push`;
    const [turn] = buildStoryTurns(entriesOf([prompt('ship it'), ...bash('b', long, 'Commit and push', 'ok')]));
    const ev = turn.events[1];
    expect(ev.label.length).toBeLessThanOrEqual(STORY_LIMITS.labelChars);
    expect(ev.intent).toBe('save');
    expect(ev.ships).toBe('push');
  });

  it("never lets a turn outlast its own span (a task turn's duration counts from the first prompt)", () => {
    const lines = [prompt('job'), ...bash('b', 'ls', 'List', 'a')];
    const turns = buildStoryTurns(entriesOf([...lines, { ...end(0), durationMs: 158_267 }]));
    expect(turns[0].durationMs).toBeLessThan(10_000);
  });

  it('a background helper stays running until its notification joins the answer back', () => {
    const launched = [
      prompt('Docs please'),
      tool('a1', 'Agent', { description: 'Write README', subagent_type: 'general-purpose', prompt: 'Write it' }),
      result('a1', 'Async agent launched successfully. (This tool result is internal metadata.) agentId: h9', {
        toolUseResult: { isAsync: true, status: 'async_launched', agentId: 'h9', description: 'Write README' },
      }),
      said('The helper is on it.'),
      end(1000),
    ];
    let page = pageOf(launched);
    const helper = page.events[1].helper!;
    expect(helper).toMatchObject({ background: true, running: true, agentId: 'h9' });
    expect(helper.result).toBeUndefined();
    expect(page.helpersRunning).toBe(1);
    expect(page.panels.find((p) => p.kind === 'backup')!.caption.story).toBe(
      'Claude sends 1 helper off to work in the background.'
    );
    expect(page.panels[page.panels.length - 1].caption.story).toBe(
      "Claude's part is done in 1 second. A helper is still working."
    );

    const notification = [
      '<task-notification>',
      '<task-id>h9</task-id>',
      '<tool-use-id>a1</tool-use-id>',
      '<status>completed</status>',
      '<summary>Agent "Write README" finished</summary>',
      '<result>I wrote README.md.</result>',
      '<usage><tool_uses>4</tool_uses><duration_ms>9000</duration_ms></usage>',
      '</task-notification>',
    ].join('\n');
    const turns = buildStoryTurns(
      entriesOf([...launched, prompt(notification, { turnOrigin: 'task_notification' }), said('Thanks.'), end(500)])
    );
    expect(turns).toHaveLength(2);
    page = buildStoryPage(turns[0]);
    expect(page.events[1].helper).toMatchObject({ result: 'I wrote README.md.', toolUses: 4, durationMs: 9000 });
    expect(page.events[1].helper!.running).toBeUndefined();
    expect(page.helpersRunning).toBe(0);
    const second = buildStoryPage(turns[1]);
    expect(second.prompt).toBe('Agent "Write README" finished');
    expect(second.events[0].output).toBe('I wrote README.md.');
    // The report's turn links back to the helper it answers.
    expect(second.events[0].helper).toMatchObject({ agentId: 'h9', result: 'I wrote README.md.' });
  });

  it('a prompt typed while Claude works (a queued_command attachment, no user line) joins the turn', () => {
    const queued = (prompt: string, origin: Record<string, unknown>, mode = 'prompt') => ({
      type: 'attachment',
      uuid: 'att-1',
      timestamp: '2026-10-18T09:41:30.000Z',
      isSidechain: false,
      attachment: { type: 'queued_command', prompt, source_uuid: 'src-1', commandMode: mode, origin, humanTurn: true },
    });
    const turns = buildStoryTurns(
      entriesOf([
        prompt('Build it'),
        ...bash('b1', 'ls', 'List', 'a'),
        queued('Also add a --csv option.', { kind: 'human' }),
        ...bash('b2', 'pytest -q', 'Run tests', '3 passed in 0.1s'),
        end(1000),
      ])
    );
    expect(turns).toHaveLength(1);
    const page = buildStoryPage(turns[0]);
    const added = page.panels.filter((p) => p.kind === 'mission')[1];
    expect(added.caption.story).toBe('You add something while Claude works.');
    expect(added.balloon?.text).toBe('Also add a --csv option.');
    expect(page.events.find((e) => e.id === 'src-1')).toMatchObject({ origin: 'human', actor: 'you' });
  });

  it("a background helper's report that lands mid-turn is a notice on the wire and joins the helper", () => {
    const report = [
      '<task-notification>',
      '<tool-use-id>a1</tool-use-id>',
      '<status>completed</status>',
      '<summary>Agent "Docs" finished</summary>',
      '<result>README written.</result>',
      '</task-notification>',
    ].join('\n');
    const page = pageOf([
      prompt('docs and tests'),
      tool('a1', 'Agent', { description: 'Docs', subagent_type: 'general-purpose', prompt: 'Write docs' }),
      result('a1', 'Async agent launched successfully.', {
        toolUseResult: { isAsync: true, status: 'async_launched' },
      }),
      ...bash('b1', 'npm test', 'Run tests', ' Tests  2 passed (2)'),
      {
        type: 'attachment',
        timestamp: '2026-10-18T09:42:00.000Z',
        attachment: {
          type: 'queued_command',
          prompt: report,
          commandMode: 'task-notification',
          origin: { kind: 'task-notification', producer: 'session-task' },
        },
      },
      said('Both done.'),
      end(1000),
    ]);
    expect(page.panels.filter((p) => p.kind === 'mission')).toHaveLength(1);
    const notice = page.events.find((e) => e.intent === 'notice')!;
    expect(notice).toMatchObject({ tool: 'Report', label: 'Agent "Docs" finished', output: 'README written.' });
    expect(page.toolCalls).toBe(2);
    expect(page.events[1].helper).toMatchObject({ result: 'README written.' });
    expect(page.helpersRunning).toBe(0);
  });

  it('the Stop hook summary ends a turn that never gets turn_duration, timed by its own span', () => {
    const stop = (prevented = false) => ({
      type: 'system',
      subtype: 'stop_hook_summary',
      preventedContinuation: prevented,
      timestamp: '2026-10-18T09:45:00.000Z',
    });
    const [ended] = buildStoryTurns(entriesOf([prompt('one'), ...bash('b', 'ls', 'List', 'a'), stop()]));
    expect(ended.ended).toBe(true);
    expect(ended.durationMs).toBeGreaterThan(200_000); // 09:41:01 to 09:45:00
    const [kept] = buildStoryTurns(entriesOf([prompt('one'), ...bash('b', 'ls', 'List', 'a'), stop(true)]));
    expect(kept.ended).toBe(false);
  });

  it('a teammate helper (teammate_spawned) runs until its teammate message reports back by name', () => {
    const spawned = [
      prompt('docs please'),
      tool('a1', 'Agent', {
        description: 'Write README',
        name: 'readme-writer',
        subagent_type: 'general-purpose',
        prompt: 'Write it',
      }),
      result('a1', 'Spawned successfully.', {
        toolUseResult: { status: 'teammate_spawned', agentId: 'areadme-writer-1', name: 'readme-writer' },
      }),
      end(1000),
    ];
    expect(pageOf(spawned).events[1].helper).toMatchObject({
      background: true,
      running: true,
      agentId: 'areadme-writer-1',
    });
    const message = [
      'Another Claude session sent a message:',
      '<teammate-message teammate_id="readme-writer" color="blue" summary="README done">',
      'README written with examples.',
      '</teammate-message>',
      '<teammate-message teammate_id="readme-writer" color="blue">',
      '{"type":"idle_notification","from":"readme-writer","idleReason":"available","result":"I wrote README.md."}',
      '</teammate-message>',
      '',
      'This came from another Claude session.',
    ].join('\n');
    const turns = buildStoryTurns(
      entriesOf([...spawned, prompt(message, { turnOrigin: undefined, promptSource: undefined })])
    );
    expect(turns).toHaveLength(2);
    expect(turns[1]).toMatchObject({ origin: 'task', prompt: 'readme-writer: README done' });
    const first = buildStoryPage(turns[0]);
    expect(first.events[1].helper).toMatchObject({ result: 'I wrote README.md.' });
    expect(first.helpersRunning).toBe(0);
  });

  it('a report written HTML-escaped reads as text', () => {
    const [turn] = buildStoryTurns(
      entriesOf([
        prompt(
          '<task-notification>\n<summary>Agent &quot;Docs&quot; finished</summary>\n<result>Co-Authored-By: A &lt;a@b.c&gt; &amp; more</result>\n</task-notification>',
          { turnOrigin: 'task_notification' }
        ),
      ])
    );
    expect(turn.prompt).toBe('Agent "Docs" finished');
    expect(turn.events[0].output).toBe('Co-Authored-By: A <a@b.c> & more');
  });

  it('a check run twice the same way reads once, with a count', () => {
    const page = pageOf([
      prompt('test twice'),
      ...bash('b1', 'pytest -q', 'Run tests', '3 passed in 0.1s'),
      ...bash('b2', 'pytest -q', 'Run tests again', '3 passed in 0.1s'),
      end(1000),
    ]);
    expect(page.panels.find((p) => p.kind === 'check')!.caption.director).toBe('pytest -q → ok ×2 · 3 passed');
  });

  it('a message from another session names its sender; pasted text loses its wrapper', () => {
    const [peer] = buildStoryTurns(
      entriesOf([
        prompt(
          '<cross-session-message from="uds:/x.sock" from-name="planner-2">Rebase first, please.</cross-session-message>',
          {
            turnOrigin: undefined,
          }
        ),
      ])
    );
    expect(peer).toMatchObject({ origin: 'peer', prompt: 'planner-2: Rebase first, please.' });
    const [pasted] = buildStoryTurns(
      entriesOf([prompt('<pasted_content id="291c">\nDo these steps.\n</pasted_content>')])
    );
    expect(pasted.prompt).toBe('Do these steps.');
  });

  it('/compact is its own turn: you run it, Claude packs up, and the command answers itself', () => {
    const boundary = { type: 'system', subtype: 'compact_boundary', timestamp: '2026-10-18T09:50:00.000Z' };
    const summary = prompt('This session is being continued from a previous conversation.', { isCompactSummary: true });
    const command = prompt(
      '<command-name>/compact</command-name>\n<command-message>compact</command-message>\n<command-args></command-args>'
    );
    const stdout = prompt('<local-command-stdout>\u001b[2mCompacted \u001b[22m</local-command-stdout>', {
      turnOrigin: undefined,
    });
    const turns = buildStoryTurns(
      entriesOf([prompt('one'), ...bash('b', 'ls', 'List', 'a'), end(1000), boundary, summary, command, stdout])
    );
    expect(turns).toHaveLength(2);
    expect(turns[0].events.some((e) => e.intent === 'compact')).toBe(false);
    expect(turns[1]).toMatchObject({ prompt: '/compact', ended: true });
    const page = buildStoryPage(turns[1]);
    expect(page.panels.map((p) => p.kind)).toEqual(['mission', 'compact', 'complete']);
    expect(page.panels[0].caption.story).toBe('You run /compact.');
    expect(page.events[0]).toMatchObject({ tool: 'Command', output: 'Compacted' });
    // A local command like /model ends at its output too.
    const [, model] = buildStoryTurns(
      entriesOf([
        prompt('one'),
        end(1000),
        prompt('<command-name>/model</command-name><command-args>opus</command-args>'),
        prompt('<local-command-stdout>Set model to opus</local-command-stdout>'),
      ])
    );
    expect(model).toMatchObject({ prompt: '/model opus', ended: true });
  });

  it('one prompt written twice (typed /compact, then its command record) is one turn', () => {
    const turns = buildStoryTurns(
      entriesOf([
        prompt('one'),
        end(1000),
        prompt('/compact', { promptId: 'p2' }),
        { type: 'system', subtype: 'compact_boundary', timestamp: '2026-10-18T09:50:00.000Z' },
        prompt('<command-name>/compact</command-name><command-args></command-args>', { promptId: 'p2' }),
        prompt('<local-command-stdout>Compacted</local-command-stdout>', { promptId: 'p2' }),
      ])
    );
    expect(turns).toHaveLength(2);
    const page = buildStoryPage(turns[1]);
    expect(page.panels.map((p) => p.kind)).toEqual(['mission', 'compact', 'complete']);
    expect(page.panels[0].caption).toEqual({ story: 'You run /compact.', director: 'Command · /compact' });
    expect(page.complete).toBe(true);
  });

  it('plan mode: the plan file is planning, and the plan and your answer come back with ExitPlanMode', () => {
    const plan = '# Plan: add wrap\n\n1. Implement wrap.\n2. Add tests.\n3. Commit.';
    const page = pageOf([
      prompt('plan it'),
      ...bash('b0', 'ls', 'List', 'a'),
      tool('w1', 'Write', { file_path: '/home/me/.claude/plans/radiant.md', content: plan }),
      result('w1', 'File created', {
        toolUseResult: {
          type: 'create',
          filePath: '/home/me/.claude/plans/radiant.md',
          content: plan,
          structuredPatch: [],
        },
      }),
      tool('x1', 'ExitPlanMode', {}),
      result('x1', 'User has approved your plan. You can now start coding.', { toolUseResult: { plan } }),
      ...edit('e1', '/w/a.py', ['+def wrap(): ...']),
      end(1000),
    ]);
    expect(page.panels.map((p) => p.kind)).toEqual(['mission', 'investigate', 'plan', 'ask', 'fix', 'complete']);
    expect(page.panels[2].todos?.map((t) => t.text)).toEqual(['Implement wrap.', 'Add tests.', 'Commit.']);
    expect(page.panels[2].caption.director).toBe('Write · plan file · 3 steps');
    expect(page.panels[3].caption.story).toBe('Claude shows you its plan, and you approve it.');
    expect(page.events.find((e) => e.tool === 'ExitPlanMode')).toMatchObject({
      output: plan,
      question: { answer: 'Approved' },
    });
    expect(page.filesChanged).toBe(1);
  });

  it('a scheduled task (its prompt a meta line) is a turn of its own, not part of the one before', () => {
    const turns = buildStoryTurns(
      entriesOf([
        prompt('/compact', { promptId: 'p1' }),
        prompt('<command-name>/compact</command-name>', { promptId: 'p1' }),
        prompt('<local-command-stdout>Compacted</local-command-stdout>', { promptId: 'p1' }),
        {
          type: 'system',
          subtype: 'scheduled_task_fire',
          timestamp: '2026-10-18T11:00:00.000Z',
          prompt: 'Resume the work',
        },
        prompt('Resume the work', {
          isMeta: true,
          turnOrigin: 'scheduled',
          promptSource: 'system',
          scheduledTaskId: 'abc',
        }),
        ...bash('b', 'ls', 'List', 'a'),
        end(5000),
      ])
    );
    expect(turns.map((t) => [t.prompt, t.origin, t.endedBy])).toEqual([
      ['/compact', 'human', 'local command'],
      ['Resume the work', 'scheduled', 'turn_duration'],
    ]);
    expect(buildStoryPage(turns[1]).panels[0].caption.story).toBe('A scheduled task starts this turn.');
  });

  it('work long after a turn ended is a turn of its own; a line flushed a moment late still joins', () => {
    const turns = buildStoryTurns(
      entriesOf([
        prompt('one'),
        end(1000),
        { ...said('Late line.'), timestamp: undefined },
        {
          type: 'assistant',
          timestamp: '2026-10-18T12:00:00.000Z',
          message: { content: [{ type: 'tool_use', id: 'x', name: 'Bash', input: { command: 'ls' } }] },
        },
      ])
    );
    expect(turns).toHaveLength(2);
    expect(turns[1]).toMatchObject({ origin: 'system', prompt: '', ended: false });
    expect(turns[1].events.map((e) => e.tool)).toEqual(['Bash']);
  });

  it('a page with many prompts added mid-turn still fits, folding added prompts last', () => {
    const queued = (text: string, i: number) => ({
      type: 'attachment',
      timestamp: `2026-10-18T09:5${i}:00.000Z`,
      attachment: { type: 'queued_command', prompt: text, commandMode: 'prompt', origin: { kind: 'human' } },
    });
    const lines: unknown[] = [prompt('big job')];
    for (let i = 0; i < 8; i++) {
      lines.push(queued(`also do ${i}`, i));
      lines.push(...edit(`e${i}`, `/w/f${i}.ts`, ['+x']));
      lines.push(...bash(`b${i}`, 'npm test', 'Run tests', ' Tests  4 passed (4)'));
    }
    lines.push(end(60_000));
    const page = pageOf(lines);
    expect(page.panels.length).toBeLessThanOrEqual(STORY_LIMITS.panelsPerPage);
    expect(page.panels[0].kind).toBe('mission');
    expect(page.panels.some((p) => /you add \d+ things?/.test(p.caption.story))).toBe(true);
  });

  it('an automatic compaction after the last turn closes that turn', () => {
    const [turn] = buildStoryTurns(
      entriesOf([
        prompt('one'),
        end(1000),
        {
          type: 'system',
          subtype: 'compact_boundary',
          timestamp: '2026-10-18T10:00:00.000Z',
          compactMetadata: { trigger: 'auto' },
        },
      ])
    );
    expect(turn.events.map((e) => e.intent)).toEqual(['prompt', 'compact']);
  });

  it('a command sent to the background is running, not passed, until its notification; its output read later is a check', () => {
    const turns = buildStoryTurns(
      entriesOf([
        prompt('run the slow tests in the background'),
        ...bash(
          'b1',
          'sleep 25 && pytest -q',
          'Run slow tests',
          'Command running in background with ID: bg1. Output is being written to: /tmp/x/tasks/bg1.output'
        ),
        said('The tests are running in the background.'),
        end(1000),
        prompt(
          '<task-notification>\n<task-id>bg1</task-id>\n<tool-use-id>b1</tool-use-id>\n<status>completed</status>\n<summary>Background command \"Run slow tests\" completed (exit code 0)</summary>\n</task-notification>',
          { turnOrigin: 'task_notification' }
        ),
        ...bash('b2', 'cat /tmp/x/tasks/bg1.output', 'Read the test output', '7 passed in 25.1s'),
        end(1000),
      ])
    );
    // Before the report the first turn said it was still running; the report settled it.
    const first = buildStoryPage(turns[0]);
    expect(first.events[1]).toMatchObject({ intent: 'test', ok: true });
    expect(first.events[1].running).toBeUndefined();
    // Its drawer says what happened, not the launch note meant for Claude.
    expect(first.events[1].output).toBe(
      'Finished in the background, exit code 0. Its report is the turn it came back in.'
    );
    // Not tests that ran during that turn: they ran later, in the background.
    expect(first.panels.find((p) => p.kind === 'check')!.caption.story).toBe(
      'The tests run in the background and pass.'
    );
    const second = buildStoryPage(turns[1]);
    expect(second.panels.find((p) => p.kind === 'check')).toMatchObject({
      caption: { story: 'The tests pass.' },
      tests: { passed: 7, failed: 0 },
    });

    const [alone] = buildStoryTurns(
      entriesOf([
        prompt('background'),
        ...bash('b1', 'sleep 25 && pytest -q', 'Run slow tests', 'Command running in background with ID: bg1.'),
        end(1000),
      ])
    );
    const page = buildStoryPage(alone);
    expect(page.events[1]).toMatchObject({ running: true });
    expect(page.events[1].ok).toBeUndefined();
    expect(page.events[1].output).toBe('Started in the background. Its result comes back as a report of its own.');
    expect(page.panels.find((p) => p.kind === 'check')!.caption.story).toBe(
      'Claude starts the tests in the background.'
    );
    expect(page.panels.at(-1)!.caption.story).toBe(
      "Claude's part is done in 1 second. A command is still running in the background."
    );
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
    expect(byKind.investigate.caption.story).toBe('Claude reads CheckoutButton.tsx and banner.css.');
    expect(byKind.investigate.caption.director).toBe('Read ×2 · Bash');
    expect(byKind.plan.caption.story).toBe('Claude writes a plan: 2 steps.');
    expect(byKind.backup.caption.story).toBe('Claude calls in 1 helper.');
    expect(byKind.backup.caption.director).toContain('3 calls inside');
    expect(byKind.loop).toMatchObject({ rounds: 2, ok: true, added: 2, removed: 1 });
    expect(byKind.loop.caption.story).toBe('Fix and test: the first run fails, the second passes.');
    expect(byKind.save.caption.story).toBe('Claude saves the work: "banner".');
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
    // A first sentence this short says too little alone: the next one comes along.
    expect(page.panels[page.panels.length - 1].balloon).toEqual({
      who: 'claude',
      text: 'Fixed. The banner sat on top of the button.',
    });
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

  it('a caption names a script by its first line that says something (not set -e, cd or S=...)', () => {
    const page = pageOf([
      prompt('commit'),
      ...bash('b', 'set -e\nS=/tmp/x\ncd repo\ngit commit -qm "feat: a"', 'Commit', 'ok'),
      end(1000),
    ]);
    expect(page.panels.find((p) => p.kind === 'save')!.caption.director).toBe('git commit -qm "feat: a"');
  });

  it('a test run that reports failures failed, even when a pipe hid its exit code', () => {
    const page = pageOf([
      prompt('test it'),
      ...bash('b', 'pytest -q 2>&1 | tail -3', 'Run tests', '1 failed, 18 passed in 0.31s'),
      end(1000),
    ]);
    const check = page.panels.find((p) => p.kind === 'check')!;
    expect(check.ok).toBe(false);
    expect(check.caption.story).toBe('A test fails.');
    expect(check.caption.director).toContain('→ error');
  });

  it('fix, failing test, fix, passing test folds into one loop with the last word as its balloon', () => {
    const page = pageOf([
      prompt('add a flag'),
      ...edit('e1', '/w/a.py', ['+x = 1']),
      ...bash('b1', 'pytest -q | tail -1', 'Run tests', '1 failed, 3 passed in 0.1s'),
      said('The test is right; the flag is off by one.'),
      ...edit('e2', '/w/a.py', ['-x = 1', '+x = 2']),
      ...bash('b2', 'pytest -q | tail -1', 'Run tests', '4 passed in 0.1s'),
      said('All 4 tests pass now.'),
      ...bash('b3', 'git commit -qm x', 'Commit', 'ok'),
      said('Done.'),
      end(1000),
    ]);
    const loop = page.panels.find((p) => p.kind === 'loop')!;
    expect(loop.caption.story).toBe('Fix and test: the first run fails, the second passes.');
    expect(loop.balloon?.text).toBe('All 4 tests pass now.');
    expect(loop.tests).toEqual({ passed: 4, failed: 0 });
  });

  it('a failed save says so; the failing run is marked failed on the event itself', () => {
    const page = pageOf([
      prompt('ship'),
      ...bash('b1', 'pytest -q; echo "exit=$?"', 'Run tests', '1 error in 0.22s\nexit=2'),
      ...bash('b2', 'git push -u origin main && git -C remote.git log', 'Push', 'fatal: bad object', true),
      end(1000),
    ]);
    expect(page.events[1]).toMatchObject({ ok: false, tests: { passed: 0, failed: 0, errors: 1 } });
    const check = page.panels.find((p) => p.kind === 'check')!;
    expect(check.caption.story).toBe("The tests don't even load.");
    expect(check.caption.director).toContain('0 passed, 1 error');
    const save = page.panels.find((p) => p.kind === 'save')!;
    expect(save.ok).toBe(false);
    expect(save.caption.story).toBe('Claude tries to upload the work, and the command fails.');
    expect(save.caption.director).toContain('1 error');
  });

  it('files written through a here-document are edits: on the event, in the counts, out of the label', () => {
    const command = [
      "cat > index.js <<'EOF'",
      'export const add = (a, b) => a + b;',
      'test(1 > 2)',
      'EOF',
      'cat <<EOF > /tmp/scratch.txt',
      'scratch',
      'EOF',
      'node --test && git add -A && git commit -qm "feat: add"',
    ].join('\n');
    const lines = [prompt('write it'), ...bash('b1', command, 'Write, test, commit', '# pass 3\n# fail 0'), end(1000)];
    (lines[1] as { cwd?: string }).cwd = '/work/app';
    const page = pageOf(lines);
    const ev = page.events[1];
    expect(ev.intent).toBe('test');
    expect(ev.edits?.map((d) => [d.file, d.added])).toEqual([['/work/app/index.js', 2]]);
    expect(ev.edits?.[0].hunks[0].lines).toEqual(['+export const add = (a, b) => a + b;', '+test(1 > 2)']);
    expect(ev.label).not.toContain('export const add');
    expect(ev.headline).toBe('node --test');
    expect(page.filesChanged).toBe(1);
    const check = page.panels.find((p) => p.kind === 'check')!;
    expect(check.caption.director).toBe('node --test → ok · 3 passed · writes 1 file · 1 commit');
    // The commit at the end of the test one-liner is not lost, nor the file written: the check says both.
    expect(check.caption.story).toBe('Claude writes 1 file; the tests pass, and Claude saves the work.');
  });

  it('one-line printf/echo writes and the files Claude Code says a command changed are edits', () => {
    expect(
      heredocWrites('printf \'name = "x"\\nversion = 1\\n\' > pyproject.toml && ls', '/w').map((d) => [d.file, d.added])
    ).toEqual([['/w/pyproject.toml', 2]]);
    expect(heredocWrites('echo hi > /tmp/x.txt; echo "a" >> notes.md', '/w').map((d) => d.file)).toEqual([
      '/w/notes.md',
    ]);
    const lines = [
      prompt('rewrite'),
      ...bash(
        'b1',
        "python3 - <<'EOF'\nopen('t.py','w').write('x')\nEOF",
        'Rewrite the test file',
        "done\n[This command modified 1 file you've previously read: test_a.py. Call Read before editing.]"
      ),
      end(1000),
    ];
    (lines[1] as { cwd?: string }).cwd = '/w';
    (lines[2] as { cwd?: string }).cwd = '/w';
    const page = pageOf(lines);
    // The script's own write and the file Claude Code says changed: both, neither with lines.
    expect(page.events[1].edits?.map((d) => [d.file, d.hunks.length])).toEqual([
      ['/w/t.py', 0],
      ['/w/test_a.py', 0],
    ]);
    expect(page.filesChanged).toBe(2);
  });

  it('a commit then a push in its own command is one commit, named; a push alone only uploads', () => {
    const save = (lines: unknown[]) => pageOf(lines).panels.find((p) => p.kind === 'save')!.caption.story;
    expect(
      save([
        prompt('ship it'),
        ...bash('b1', 'git commit -qm "feat: add mode()"', 'Commit', ''),
        ...bash('b2', 'git push origin main', 'Push', 'To ./origin.git\n   f80bb31..3e0fb80  main -> main'),
        end(1000),
      ])
    ).toBe('Claude saves the work and uploads it: "add mode()".');
    expect(save([prompt('push'), ...bash('b1', 'git push', 'Push', 'Everything up-to-date'), end(1000)])).toBe(
      'Claude uploads the work.'
    );
    expect(pageOf([prompt('c'), ...bash('b1', 'git commit -qm x', 'Commit', ''), end(1000)]).events[1].commits).toBe(1);
  });

  it('crafted agent text never takes seconds: every helper stays linear on its worst shapes', () => {
    // Each shape took one to several seconds before (a lazy regex rescanning per opener, or a
    // backtracking one over a long one-liner); a single call blocks the whole server.
    const rep = (str: string, n: number) => str.repeat(Math.ceil(n / str.length)).slice(0, n);
    const ms = (fn: () => unknown) => {
      const start = performance.now();
      fn();
      return performance.now() - start;
    };
    const prompt1 = (content: string) => () => buildStoryTurns(entriesOf([prompt(content), said('ok'), end(1000)]));
    const bashOut = (command: string, output: string) => () =>
      pageOf([prompt('go'), ...bash('b1', command, 'x', output), end(1000)]);
    // At these sizes the old code took 6 to 29 s per shape and the new one takes under 10 ms: the
    // bound sits two orders of magnitude from both, so a loaded runner cannot flake it.
    const shapes: Array<[string, () => unknown]> = [
      ['teammate openers', prompt1(rep('<teammate-message teammate_id="a">x ', 1_000_000))],
      ['system-reminder openers', prompt1('hi ' + rep('<system-reminder>x ', 1_000_000))],
      ['task-notification field openers', prompt1('<task-notification>\n' + rep('<summary>x ', 1_000_000))],
      ['git commit tokens', bashOut(rep('git commit ', 16_000), 'ok')],
      [
        'modified-note phrases',
        bashOut('python3 x.py', rep("This command modified 1 file you've previously read: a", 1_000_000)),
      ],
    ];
    for (const [name, fn] of shapes) expect([name, ms(fn) < 1500]).toEqual([name, true]);
  });

  it('a turn of many questions still keeps to 12 panels: the oldest questions fold last', () => {
    const lines: unknown[] = [prompt('ask me a lot')];
    for (let i = 0; i < 14; i++) {
      lines.push(
        tool(`q${i}`, 'AskUserQuestion', { questions: [{ question: `Question ${i}?`, options: [{ label: 'Yes' }] }] }),
        result(`q${i}`, 'ok', { toolUseResult: { answers: { [`Question ${i}?`]: 'Yes' } } }),
        ...read(`r${i}`, `/w/f${i}.ts`)
      );
    }
    lines.push(end(1000));
    const page = pageOf(lines);
    expect(page.panels.length).toBeLessThanOrEqual(12);
    expect(page.panels[0].kind).toBe('mission');
    expect(page.panels.at(-1)!.kind).toBe('complete');
  });

  it('the closing balloon keeps an open problem from far into the message, never a table row or a question', () => {
    const long = [
      'I built the csvstat tool for your CSV files.',
      'It reads the file and prints the counts for each column, one line per column. '.repeat(4),
      '| column | state |',
      '| amount | not yet rounded |',
      'Want me to add a --json flag?',
      'One known issue: big numbers are shown rounded.',
    ].join('\n');
    const balloon = pageOf([prompt('build it'), said(long), end(1000)]).panels.at(-1)!.balloon!.text;
    expect(balloon).toBe(
      'I built the csvstat tool for your CSV files. One known issue: big numbers are shown rounded.'
    );
  });

  it("a run panel's terminal card shows what the command printed, never what looks like a secret", () => {
    const page = pageOf([
      prompt('dry run please'),
      ...bash(
        'b1',
        './rename.sh --dry-run samples/',
        'Dry run',
        'a.jpg -> holiday_2024-05-01.jpg\nAPI_TOKEN=abc123\nauthor: me@example.com\nb.jpg -> holiday_2024-05-02.jpg'
      ),
      end(1000),
    ]);
    expect(page.panels.find((p) => p.kind === 'run')!.printed).toEqual([
      'a.jpg -> holiday_2024-05-01.jpg',
      'author: …@…',
      'b.jpg -> holiday_2024-05-02.jpg',
    ]);
  });

  it('a helper messaged twice reads as one finished run, not as superseded', () => {
    const r = createStoryReducer({ sidechain: true });
    const lines = [prompt('write it'), said('Done.'), prompt('also the tests'), said('Done too.')].map((l) => ({
      ...(l as object),
      isSidechain: true,
    }));
    const page = buildHelperPage(buildStoryTurns(lines.flatMap((l) => r.reduce(l))), true)!;
    expect(page.superseded).toBeUndefined();
    expect(page.panels.at(-1)!.caption.story).not.toMatch(/trail stops here/);
  });

  it('a python or node script fed by a here-document: the files it opens for writing, never guessed', () => {
    const files = (command: string) => heredocWrites(command, '/w').map((d) => d.file);
    expect(
      files(
        [
          "python3 - <<'EOF'",
          'p = "textstats.py"',
          's = open(p).read()',
          "s = s.replace('a', 'b')",
          'open(p, "w").write(s)',
          "Path('README.md').write_text('# x')",
          "with open('notes.txt', mode='a') as f: f.write('x')",
          "open('/tmp/scratch.txt', 'w').write('x')",
          "open(os.path.join(d, 'x.py'), 'w')",
          "open('data.json').read()",
          'EOF',
        ].join('\n')
      )
    ).toEqual(['/w/textstats.py', '/w/README.md', '/w/notes.txt']);
    expect(files("node <<'EOF'\nconst out = 'dist/app.js';\nfs.writeFileSync(out, code);\nEOF")).toEqual([
      '/w/dist/app.js',
    ]);
    expect(files("python3 - <<'EOF'\nprint(open('a.py').read())\nEOF")).toEqual([]);
    const [edit] = heredocWrites("python3 - <<'EOF'\nopen('a.py', 'w').write('x')\nEOF", '/w');
    expect(edit).toMatchObject({ file: '/w/a.py', added: 0, removed: 0, hunks: [], truncated: true });
    // A script that writes project files is an edit: it draws as a change, not as terminal work.
    const lines = [
      prompt('rewrite'),
      ...bash('b1', "python3 - <<'EOF'\nopen('a.py', 'w').write('x')\nEOF", 'Rewrite a.py', ''),
      end(1000),
    ];
    (lines[1] as { cwd?: string }).cwd = '/w';
    expect(pageOf(lines).panels.map((p) => p.kind)).toEqual(['mission', 'fix', 'complete']);
  });

  it('a compaction says what it did; ToolSearch is looking; EnterPlanMode says plan mode', () => {
    const page = pageOf([
      prompt('go'),
      tool('t1', 'ToolSearch', { query: 'select:EnterPlanMode,ExitPlanMode', max_results: 2 }),
      result('t1', 'ok'),
      tool('p1', 'EnterPlanMode', {}),
      result('p1', 'Entered plan mode.'),
      {
        type: 'system',
        subtype: 'compact_boundary',
        timestamp: '2026-10-18T09:45:00.000Z',
        compactMetadata: { trigger: 'auto', preTokens: 46928, postTokens: 3623, durationMs: 24014 },
      },
      end(1000),
    ]);
    expect(page.panels.map((p) => p.kind)).toEqual(['mission', 'investigate', 'plan', 'compact', 'complete']);
    expect(page.panels[2].caption.story).toBe('Claude switches to plan mode to think it through.');
    expect(page.panels[3].caption).toEqual({
      story: "Claude's memory is full: it packs up its notes.",
      director: 'automatic · 46.9k → 3.6k tokens · 24 s',
    });
  });

  it('heredocWrites skips scratch, stdin bodies and relative paths after a cd', () => {
    expect(heredocWrites("python3 - <<'EOF'\nprint(1)\nEOF", '/w')).toEqual([]);
    expect(heredocWrites('cat > "$S/x.txt" <<EOF\nx\nEOF', '/w')).toEqual([]);
    expect(heredocWrites('cd sub && cat > a.txt <<EOF\nx\nEOF', '/w').map((d) => d.file)).toEqual(['a.txt']);
    expect(heredocWrites('tee -a notes.md <<EOF\nx\nEOF', '/w').map((d) => d.file)).toEqual(['/w/notes.md']);
  });

  it('an append has no line numbers it cannot know; a whole-file write starts at line 1', () => {
    const [append] = heredocWrites("cat >> notes.md <<'EOF'\none\ntwo\nEOF", '/w');
    expect(append.hunks[0]).toMatchObject({ atEnd: true, newStart: 0, newLines: 2 });
    const [echoed] = heredocWrites('echo "more" >> notes.md', '/w');
    expect(echoed.hunks[0]).toMatchObject({ atEnd: true, newStart: 0 });
    const [whole] = heredocWrites("cat > notes.md <<'EOF'\none\nEOF", '/w');
    expect(whole.hunks[0]).toMatchObject({ newStart: 1, newLines: 1 });
    expect(whole.hunks[0].atEnd).toBeUndefined();
  });

  it('sed -n prints part of a file, like head', () => {
    expect(printedFiles("sed -n '5,25p' README.md")).toEqual(['README.md']);
    expect(printedFiles('sed -n 10p src/a.py && ls')).toEqual(['src/a.py']);
    expect(printedFiles("sed -i 's/a/b/' a.py")).toEqual([]);
  });

  it('files a command prints are on its event, resolved against its cwd, whatever it does', () => {
    const lines = [
      prompt('rewrite and test'),
      ...bash('b1', 'cat textstats.py && python3 -m pytest -q', 'Show and test', 'def f(): pass\n5 passed in 0.1s'),
      end(1000),
    ];
    (lines[1] as { cwd?: string }).cwd = '/w';
    const page = pageOf(lines);
    expect(page.events[1]).toMatchObject({ intent: 'test', files: ['/w/textstats.py'] });
  });

  it('words that start a turn but are not yours are a note, not your balloon', () => {
    const turns = buildStoryTurns(
      entriesOf([
        prompt('go'),
        end(1000),
        prompt(
          '<task-notification>\n<task-id>bg1</task-id>\n<status>completed</status>\n<summary>Background command \"Run tests\" completed (exit code 0)</summary>\n</task-notification>',
          { turnOrigin: 'task_notification' }
        ),
        said('All good.'),
        end(1000),
      ])
    );
    expect(buildStoryPage(turns[0]).panels[0].balloon?.who).toBe('you');
    const report = buildStoryPage(turns[1]).panels[0];
    expect(report.caption.story).toBe('A background job reports back.');
    expect(report.balloon?.who).toBe('note');
  });

  it('a loop keeps every run: a lint failure inside a round that passed in the end still shows', () => {
    const page = pageOf([
      prompt('build'),
      ...edit('e1', '/w/a.py', ['+a = 1']),
      ...bash('b1', 'pytest -q', 'Run tests', '3 passed in 0.1s'),
      ...edit('e2', '/w/b.py', ['+b = 1']),
      ...bash(
        'b2',
        'pytest -q; ruff format --check .',
        'Run tests and format check',
        '6 passed in 0.1s\n1 file would be reformatted'
      ),
      ...bash('b3', 'ruff format . && pytest -q', 'Format and retest', '1 file reformatted\n6 passed in 0.1s'),
      end(1000),
    ]);
    const loop = page.panels.find((p) => p.kind === 'loop')!;
    expect(loop.roundsOk).toEqual([true, false, true]);
    expect(loop.caption.story).toBe(
      'Build and test, 2 rounds. The tests pass every time; another check fails once, then passes.'
    );
  });

  it('a live loop marks the runs that finished, and the one still going as null', () => {
    const page = pageOf([
      prompt('fix'),
      ...edit('e1', '/w/a.py', ['+a = 1']),
      ...bash('b1', 'pytest -q', 'Run tests', '1 failed, 2 passed in 0.1s'),
      ...edit('e2', '/w/a.py', ['-a = 1', '+a = 2']),
      tool('b2', 'Bash', { command: 'pytest -q', description: 'Run tests again' }),
    ]);
    expect(page.panels.find((p) => p.kind === 'loop')?.roundsOk).toEqual([false, null]);
  });

  it("Claude's word about a red run stays on that run's check", () => {
    const page = pageOf([
      prompt('test first'),
      ...edit('e1', '/w/test_a.py', ['+import a']),
      ...bash('b1', 'pytest -q', 'Run tests', 'ERROR test_a.py\n1 error in 0.1s'),
      said('Red as expected: collection error, exit code 2.'),
      ...bash('b2', 'git commit -qm "test: first"', 'Commit', ''),
      end(1000),
    ]);
    const check = page.panels.find((p) => p.kind === 'check' || p.kind === 'loop')!;
    expect(check.balloon?.text).toBe('Red as expected: collection error, exit code 2.');
    expect(page.panels.find((p) => p.kind === 'save')!.balloon).toBeUndefined();
  });

  it('checks that all pass from the start read as building, not fixing', () => {
    const page = pageOf([
      prompt('build it'),
      ...edit('e1', '/w/a.py', ['+a = 1']),
      ...bash('b1', 'pytest -q', 'Run tests', '3 passed in 0.1s'),
      ...edit('e2', '/w/b.py', ['+b = 1']),
      ...bash('b2', 'pytest -q', 'Run tests', '6 passed in 0.1s'),
      end(1000),
    ]);
    expect(page.panels.find((p) => p.kind === 'loop')!.caption.story).toBe(
      'Build and test, 2 rounds. Every check passes.'
    );
  });

  it('the advisor (a server tool) is a helper giving a second opinion', () => {
    const page = pageOf([
      prompt('think hard'),
      {
        type: 'assistant',
        timestamp: '2026-10-18T09:41:20.000Z',
        message: {
          content: [
            { type: 'server_tool_use', id: 'srv1', name: 'advisor', input: {} },
            {
              type: 'advisor_tool_result',
              tool_use_id: 'srv1',
              content: { type: 'advisor_redacted_result', encrypted_content: 'xx' },
            },
          ],
        },
      },
      end(1000),
    ]);
    const backup = page.panels.find((p) => p.kind === 'backup')!;
    expect(backup.caption.story).toBe('Claude asks a stronger AI model for a second opinion.');
    expect(page.events[1]).toMatchObject({ tool: 'Advisor', ok: true, helper: { name: 'advisor' } });
    expect(page.events[1].helper!.result).toMatch(/encrypted/);
    expect(page.helpers).toBe(0);
  });

  it('a turn left open when the next prompt starts has ended; an interrupted turn is timed', () => {
    const turns = buildStoryTurns(
      entriesOf([
        prompt('one'),
        ...bash('b', 'ls', 'List', 'a'),
        prompt('two'),
        ...bash('c', 'ls', 'List', 'a'),
        { type: 'user', timestamp: '2026-10-18T09:50:00.000Z', message: { content: '[Request interrupted by user]' } },
      ])
    );
    expect(turns[0]).toMatchObject({ ended: true, interrupted: false, endedBy: 'next prompt' });
    const superseded = buildStoryPage(turns[0]);
    expect(superseded.superseded).toBe(true);
    expect(superseded.panels[superseded.panels.length - 1].caption.story).toBe(
      'The trail stops here: the next prompt starts a new turn.'
    );
    expect(superseded.panels[superseded.panels.length - 1].caption.director).toMatch(
      /^superseded by the next prompt · /
    );
    expect(turns[0].durationMs).toBeGreaterThan(0);
    expect(turns[1]).toMatchObject({ ended: true, interrupted: true });
    expect(turns[1].durationMs).toBeGreaterThan(0);
  });

  it('a remark about committing stays on the save it reports on', () => {
    const page = pageOf([
      prompt('commit then test'),
      ...bash('b1', 'git commit -qm a', 'Commit', 'ok'),
      said('Commits are in.'),
      ...bash('b2', 'pytest -q', 'Run tests', '3 passed in 0.1s'),
      end(1000),
    ]);
    expect(page.panels.find((p) => p.kind === 'save')!.balloon?.text).toBe('Commits are in.');
    expect(page.panels.find((p) => p.kind === 'check')!.balloon).toBeUndefined();
  });

  it('a result remark replaces a step announcement on its check', () => {
    const page = pageOf([
      prompt('steps'),
      said('Step 1: split the module.'),
      ...bash('b1', 'node --test', 'Run tests', '# pass 8\n# fail 0'),
      said('All 8 tests pass.'),
      ...bash('b2', 'git commit -qm x', 'Commit', 'ok'),
      end(1000),
    ]);
    expect(page.panels.find((p) => p.kind === 'check')!.balloon?.text).toBe('All 8 tests pass.');
    expect(page.panels.find((p) => p.kind === 'save')!.balloon).toBeUndefined();
  });

  it('a check whose output reports lint problems failed, though a trailing ls hid the exit code', () => {
    const page = pageOf([
      prompt('check'),
      ...bash(
        'b1',
        'pytest -q | tail -1; ruff format --check .; ls',
        'Tests and format',
        '6 passed in 0.1s\n1 file would be reformatted\nREADME.md'
      ),
      end(1000),
    ]);
    const check = page.panels.find((p) => p.kind === 'check')!;
    expect(check.ok).toBe(false);
    expect(check.caption.story).toBe('The tests pass, but another check fails.');
  });

  it('a save counts its commits, and a montage names what it folded, commits included', () => {
    const page = pageOf([
      prompt('commit'),
      ...bash('b1', 'git add a && git commit -qm a && git add b && git commit -qm b && git push', 'Commit twice', 'ok'),
      end(1000),
    ]);
    expect(page.panels.find((p) => p.kind === 'save')!.caption.story).toBe(
      'Claude saves the work in 2 commits and uploads it.'
    );
    const lines: unknown[] = [prompt('many steps')];
    for (let i = 0; i < 14; i++) {
      lines.push(...read(`r${i}`, `/w/f${i}.ts`));
      lines.push(...bash(`c${i}`, `git commit -qm step${i}`, `Commit ${i}`, 'ok'));
    }
    lines.push(end(60_000));
    const long = pageOf(lines);
    const montages = long.panels.filter((p) => p.kind === 'montage');
    expect(montages.length).toBeGreaterThan(0);
    expect(montages.some((p) => /saves the work/.test(p.caption.story))).toBe(true);
    // The newest panels keep their place: folding starts at the oldest.
    expect(long.panels[long.panels.length - 2].kind).not.toBe('montage');
  });

  it('a loop ends at its last check; writes after it are a panel of their own', () => {
    const page = pageOf([
      prompt('tdd'),
      ...edit('e1', '/w/test_a.py', ['+def test_a(): ...']),
      ...bash('b1', 'pytest -q', 'Run tests', '1 failed in 0.1s'),
      ...edit('e2', '/w/a.py', ['+a = 1']),
      ...bash('b2', 'pytest -q', 'Run tests', '1 passed in 0.1s'),
      ...edit('e3', '/w/README.md', ['+# a']),
      end(1000),
    ]);
    expect(page.panels.map((p) => p.kind)).toEqual(['mission', 'loop', 'fix', 'complete']);
    expect(page.panels[2].files).toEqual(['/w/README.md']);
  });

  it('what Claude says about a check that just ran stays on that check', () => {
    const page = pageOf([
      prompt('test then commit'),
      ...bash('b1', 'node --test', 'Run tests', '# pass 7\n# fail 0'),
      said('All 7 tests pass.'),
      ...bash('b2', 'git commit -qm x', 'Commit', 'ok'),
      said("Now I'll push it."),
      ...bash('b3', 'ls', 'List', 'a'),
      end(1000),
    ]);
    expect(page.panels.find((p) => p.kind === 'check')!.balloon?.text).toBe('All 7 tests pass.');
    expect(page.panels.find((p) => p.kind === 'save')!.balloon).toBeUndefined();
    expect(page.panels.find((p) => p.kind === 'investigate')!.balloon?.text).toBe("Now I'll push it.");
  });

  it('a numbered list Claude writes before working is a plan panel; files it cats are file cards', () => {
    const page = pageOf([
      prompt('plan first'),
      said('Todo list:\n\n1. Look around.\n2. Write the script.\n3. Test it.'),
      ...bash('b1', 'cat README.md && ls', 'Read the readme', '# demo'),
      ...edit('e1', '/w/a.sh', ['+echo hi']),
      said('Summary:\n1. one\n2. two\n3. three'),
      end(1000),
    ]);
    expect(page.panels.map((p) => p.kind)).toEqual(['mission', 'plan', 'investigate', 'fix', 'complete']);
    const plan = page.panels[1];
    expect(plan.todos?.map((t) => t.text)).toEqual(['Look around.', 'Write the script.', 'Test it.']);
    expect(plan.caption.director).toBe('written as text · 3 steps');
    expect(page.panels[2].files).toEqual(['README.md']);
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
