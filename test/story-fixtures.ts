/**
 * @fileoverview Builders for Story Mode test transcripts. Every line is INVENTED content shaped like a
 * real Claude Code transcript entry (field names as measured on local transcripts, 2026-10-18), so no
 * real prompt, path or output ever lands in the repo.
 */

let clock = 0;
const at = () => new Date(Date.UTC(2026, 9, 18, 9, 41, 0) + (clock += 1000)).toISOString();

export function resetClock(): void {
  clock = 0;
}

export const prompt = (text: string, extra: Record<string, unknown> = {}) => ({
  type: 'user',
  uuid: `u-${clock + 1}`,
  timestamp: at(),
  isSidechain: false,
  message: { role: 'user', content: text },
  turnOrigin: 'human',
  promptSource: 'typed',
  ...extra,
});

export const said = (text: string) => ({
  type: 'assistant',
  timestamp: at(),
  message: { role: 'assistant', content: [{ type: 'text', text }] },
});

export const tool = (id: string, name: string, input: Record<string, unknown>) => ({
  type: 'assistant',
  timestamp: at(),
  message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] },
});

export const result = (
  id: string,
  content: string,
  opts: { isError?: boolean; toolUseResult?: Record<string, unknown> } = {}
) => ({
  type: 'user',
  timestamp: at(),
  message: {
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: id, content, is_error: opts.isError ?? false }],
  },
  toolUseResult: opts.toolUseResult,
});

/** A turn's end. The clock moves on by the duration first, so the turn's own span is at least that long. */
export const end = (durationMs: number) => {
  clock += durationMs;
  return { type: 'system', subtype: 'turn_duration', durationMs, isMeta: true, timestamp: at() };
};

/** An Edit call and its result, with a structuredPatch like Claude Code writes. */
export function edit(id: string, file: string, lines: string[], oldStart = 10) {
  const added = lines.filter((l) => l.startsWith('+')).length;
  const removed = lines.filter((l) => l.startsWith('-')).length;
  const context = lines.length - added - removed;
  return [
    tool(id, 'Edit', { file_path: file, old_string: 'old', new_string: 'new' }),
    result(id, 'The file has been updated successfully.', {
      toolUseResult: {
        filePath: file,
        oldString: 'old',
        newString: 'new',
        originalFile: 'WHOLE ORIGINAL FILE THAT MUST NEVER REACH THE PAGE',
        structuredPatch: [
          { oldStart, oldLines: removed + context, newStart: oldStart, newLines: added + context, lines },
        ],
        userModified: false,
        replaceAll: false,
      },
    }),
  ];
}

export const bash = (id: string, command: string, description: string, output: string, isError = false) => [
  tool(id, 'Bash', { command, description }),
  result(id, output, { isError, toolUseResult: { stdout: output, stderr: '', interrupted: false } }),
];

export const read = (id: string, file: string) => [
  tool(id, 'Read', { file_path: file }),
  result(id, 'FILE CONTENT THAT MUST NEVER REACH THE PAGE', {
    toolUseResult: {
      type: 'text',
      file: { filePath: file, content: 'FILE CONTENT', numLines: 3, startLine: 1, totalLines: 3 },
    },
  }),
];

/** A complete demo turn: read, plan, helper, fix, failing test, fix, passing test, commit. */
export function demoTurn(): unknown[] {
  return [
    prompt('The checkout button does nothing on phones. Can you fix it?'),
    said('Let me see how checkout works. I will start with the button.'),
    ...read('r1', '/work/demo-shop/src/checkout/CheckoutButton.tsx'),
    ...read('r2', '/work/demo-shop/src/styles/banner.css'),
    ...bash(
      'b1',
      'grep -rn "onClick" src/checkout',
      'Find click handlers',
      'src/checkout/CheckoutButton.tsx:7: onClick'
    ),
    tool('t1', 'TodoWrite', {
      todos: [
        { content: 'Fix the banner', status: 'in_progress' },
        { content: 'Test at phone size', status: 'pending' },
      ],
    }),
    result('t1', 'Todos have been modified successfully.'),
    tool('a1', 'Agent', {
      description: 'Write a phone-size test',
      subagent_type: 'general-purpose',
      prompt: 'Write a test.',
    }),
    result('a1', 'Test written.', {
      toolUseResult: {
        status: 'completed',
        agentId: 'ag1',
        content: [{ type: 'text', text: 'Test written. It fails today.' }],
        totalToolUseCount: 3,
        totalDurationMs: 30000,
      },
    }),
    ...edit('e1', '/work/demo-shop/src/styles/banner.css', ['   z-index: 50;', '+  pointer-events: none;', ' }']),
    ...bash('b2', 'npm test', 'Run the test suite', ' Tests  1 failed | 41 passed (42)\nExit code 1', true),
    ...edit('e2', '/work/demo-shop/src/styles/banner.css', [
      '-.promo-banner__inner { pointer-events: auto; }',
      '+.promo-banner__cta { pointer-events: auto; }',
    ]),
    ...bash('b3', 'npm test', 'Run the test suite', ' Tests  42 passed (42)'),
    ...bash('b4', 'git commit -m "fix: banner"', 'Commit the fix', '[main 4be19d2] fix: banner'),
    said('Fixed. The banner sat on top of the button. The same fix covers the cart page.'),
    end(432_000),
  ];
}
