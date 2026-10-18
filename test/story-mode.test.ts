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
    ['==== 1 error in 0.05s ====', { passed: 0, failed: 1 }],
    ['=== 1 failed, 18 passed, 2 errors in 0.40s ===', { passed: 18, failed: 3 }],
    [' Tests  3 failed (3)', { passed: 0, failed: 3 }],
  ])('%j', (output, counts) => {
    expect(parseTestCounts(output)).toEqual(counts);
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
    expect(firstSentence('## Summary\n- Fixed the 2*3 bug.')).toBe('Summary Fixed the 2*3 bug.');
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
      'Done in 1 second for now. A helper is still working.'
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
    expect(loop.caption.story).toBe('Fix and test, 2 rounds. It passes in the end.');
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
    expect(page.events[1]).toMatchObject({ ok: false, tests: { passed: 0, failed: 1 } });
    const save = page.panels.find((p) => p.kind === 'save')!;
    expect(save.ok).toBe(false);
    expect(save.caption.story).toBe('Claude tries to send the work up, and the command fails.');
    expect(save.caption.director).toContain('1 error');
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
