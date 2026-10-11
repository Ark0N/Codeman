import { describe, expect, it } from 'vitest';
import {
  getLastTranscriptResponse,
  isExternalCliTranscriptMode,
  parseExternalCliTranscript,
} from '../src/web/response-viewer-transcript.js';
import { isExternalCliMode } from '../src/session.js';
import type { SessionMode } from '../src/types.js';

describe('response viewer transcript parser', () => {
  it('extracts structured COD transcript blocks and keeps labeled status/tool entries', () => {
    const transcript = `
╭──────────────────────────────────────────────────────╮
│ >_ OpenAI Codex (v0.143.0)                           │
│ model:     gpt-5.4 medium   /model to change         │
│ directory: /mnt/c/Users/aakhter/.../kb              │
╰──────────────────────────────────────────────────────╯

Tip: Use /side to start a side conversation in a temporary fork without polluting the main thread.

› i need to create a naming recommendation for project helix

gpt-5.4 medium · kb · main · Ready · Context 100% left

• Explored
  └ Read SKILL.md

Subject: Naming Recommendation for Project Helix

The product helps customers move virtual machine workloads between hypervisors while keeping operations
stable. It improves visibility into application dependencies, supports pre-migration validation, and reduces
the risk
and effort involved in moving workloads.

› Improve documentation in @filename

gpt-5.4 medium · kb · main · Ready · Context 92% left
`.trim();

    const blocks = parseExternalCliTranscript(transcript, 'codex');

    expect(blocks.map((block) => block.kind)).toEqual([
      'status',
      'prompt',
      'status',
      'tool',
      'response',
      'prompt',
      'status',
    ]);
    expect(blocks[0]?.label).toBe('Status');
    expect(blocks[3]?.label).toBe('Tool');
    expect(blocks[4]?.text).toContain('reduces the risk and effort involved');
    expect(blocks[4]?.text).not.toContain('reduces\nthe risk');

    // The frontend's loadFullContext() renders via msg.role: 'user' gets the
    // "You" badge, everything else the agent badge. A block without role
    // rendered every prompt as the agent.
    expect(blocks[1]?.role).toBe('user');
    expect(blocks[5]?.role).toBe('user');
    expect(blocks[0]?.role).toBe('assistant');
    expect(blocks[3]?.role).toBe('assistant');
    expect(blocks[4]?.role).toBe('assistant');
  });

  it('returns the most recent completed response when the last block is a new prompt', () => {
    const transcript = `
› say again

Final polished answer
With two lines

› Improve documentation in @filename

gpt-5.4 medium · kb · main · Ready · Context 92% left
`.trim();

    const blocks = parseExternalCliTranscript(transcript, 'codex');

    expect(getLastTranscriptResponse(blocks)).toBe('Final polished answer\nWith two lines');
  });

  it('drops box-drawing dividers from the last response and treats worked-for lines as status', () => {
    const transcript = `
────────────────────────────────────────────────────────────────────────

• The launcher supports CODEMAN_APP_DIR, so I can deploy this exact worktree without merging it back first.

────────────────────────────────────────────────────────────────────────

• Deployed.

The local Codeman service is now running from the worktree at app/.worktrees/cod-215-response-viewer on
commit 8bbcf77bafbdbf01a34653386c256b685898ad06.

Verified:

- process pid: 2708947
- HTTPS health: https://127.0.0.1:3000/ returned 401 as expected

One detail: I had to restart it outside the sandbox because the sandboxed launch path could not see tmux.

─ Worked for 1m 51s ───────────────────────────────────────────────────

› what are these lines in the middle column?
`.trim();

    const blocks = parseExternalCliTranscript(transcript, 'codex');

    expect(getLastTranscriptResponse(blocks)).toContain('• Deployed.');
    expect(getLastTranscriptResponse(blocks)).not.toContain('────────────────');
    expect(getLastTranscriptResponse(blocks)).not.toContain('Worked for 1m 51s');
    expect(blocks.some((block) => block.kind === 'status' && block.text === 'Worked for 1m 51s')).toBe(true);
  });

  // COD-226: multiline prompt continuations (2-space Codex gutter) must stay in the
  // Prompt block, not be misclassified as Response. The gutter is authoritative ahead
  // of every structural detector (divider, prompt-marker, tool, status).
  describe('COD-226 multiline prompt gutter is authoritative', () => {
    it('keeps bullet/prose continuations and internal blank lines in the Prompt block', () => {
      const transcript = `
› i think we can improve this slide. or maybe a follow on slide. here is what i'm thinking:
  * left hand side: current AI stack (frontier model, cloud hosted, sovereign concerns)
  right hand -> future enterprise stack: frontier model (optional, cloud), on-prem model router, OSS models

  make the point that the right hand side addresses the concerns.

gpt-5.4 medium · kb · main · Ready · Context 100% left

• Explored
  └ Read SKILL.md

Here is the actual assistant answer that starts at column zero and is a real response.

› next prompt
`.trim();

      const blocks = parseExternalCliTranscript(transcript, 'codex');
      const promptBlocks = blocks.filter((b) => b.kind === 'prompt');

      // Exactly two prompts, and the first holds the whole multiline prompt.
      expect(promptBlocks).toHaveLength(2);
      expect(promptBlocks[0]?.text).toContain('left hand side');
      expect(promptBlocks[0]?.text).toContain('right hand');
      expect(promptBlocks[0]?.text).toContain('make the point that the right hand side');

      // The continuation must NOT have leaked into a Response block.
      const responseBlocks = blocks.filter((b) => b.kind === 'response');
      expect(responseBlocks.some((b) => b.text.includes('make the point'))).toBe(false);
      expect(getLastTranscriptResponse(blocks)).toContain('actual assistant answer');
      expect(getLastTranscriptResponse(blocks)).not.toContain('make the point');
    });

    it('does not let an indented divider inside a prompt flush the Prompt block', () => {
      const transcript = `
› compare these two layouts
  first layout uses a single column
  ────────────────────────────
  second layout uses two columns

The response begins here at column zero.
`.trim();

      const blocks = parseExternalCliTranscript(transcript, 'codex');
      const promptBlocks = blocks.filter((b) => b.kind === 'prompt');

      expect(promptBlocks).toHaveLength(1);
      expect(promptBlocks[0]?.text).toContain('first layout');
      expect(promptBlocks[0]?.text).toContain('second layout uses two columns');
      expect(getLastTranscriptResponse(blocks)).toBe('The response begins here at column zero.');
    });

    it('treats a gutter-indented literal › as prompt content, not a new prompt', () => {
      const transcript = `
› here is my question about the ui
  › should this arrow start a new prompt?
  no it should not — it is part of my question

Answer at column zero.
`.trim();

      const blocks = parseExternalCliTranscript(transcript, 'codex');
      const promptBlocks = blocks.filter((b) => b.kind === 'prompt');

      // The gutter-indented › must NOT open a second prompt.
      expect(promptBlocks).toHaveLength(1);
      expect(promptBlocks[0]?.text).toContain('here is my question');
      expect(promptBlocks[0]?.text).toContain('no it should not');
      expect(getLastTranscriptResponse(blocks)).toBe('Answer at column zero.');
    });

    // The two exact live roadmap-tab examples from the ticket (AC: use both verbatim).
    it('live example 1: two-line prompt keeps the gutter continuation in the Prompt block', () => {
      const transcript = `
› create uid for each feature so it's easy to ref.
  for the p200 - why is diffentiation only 2/5?
`.trim();

      const blocks = parseExternalCliTranscript(transcript, 'codex');
      const promptBlocks = blocks.filter((b) => b.kind === 'prompt');

      expect(promptBlocks).toHaveLength(1);
      expect(promptBlocks[0]?.text).toContain('create uid for each feature');
      expect(promptBlocks[0]?.text).toContain('for the p200 - why is diffentiation only 2/5?');
      // The continuation must not have leaked into a Response block.
      expect(blocks.some((b) => b.kind === 'response')).toBe(false);
    });

    it('live example 2: five-line prompt (bullet + prose + blank + prose) stays one Prompt block', () => {
      const transcript = `
› i think we can improve this slide. or maybe a follow on slide. here is what i'm thinking:
  * left hand side... current AI stack: (frontier model), large component cloud hosted, soverign concerns etc.
  right hand -> future-enterprise-stack: frontier-model (optional, in cloud), on-prem: model router, OSS models, rest of stack (gpus, data, etc.)

  make the point that the right hand side addresses the concerns.
`.trim();

      const blocks = parseExternalCliTranscript(transcript, 'codex');
      const promptBlocks = blocks.filter((b) => b.kind === 'prompt');

      expect(promptBlocks).toHaveLength(1);
      expect(promptBlocks[0]?.text).toContain('left hand side');
      expect(promptBlocks[0]?.text).toContain('right hand -> future-enterprise-stack');
      expect(promptBlocks[0]?.text).toContain('make the point that the right hand side addresses the concerns');
      expect(blocks.some((b) => b.kind === 'response')).toBe(false);
    });

    it('still separates a single-line prompt from a column-zero response (no regression)', () => {
      const transcript = `
› say again

Final polished answer at column zero.

› next
`.trim();

      const blocks = parseExternalCliTranscript(transcript, 'codex');
      const promptBlocks = blocks.filter((b) => b.kind === 'prompt');

      expect(promptBlocks).toHaveLength(2);
      expect(promptBlocks[0]?.text).toBe('say again');
      expect(getLastTranscriptResponse(blocks)).toBe('Final polished answer at column zero.');
    });
  });

  // COD-227: Last Response must return the final assistant answer, not tool logs.
  // A response bullet beginning with a tool-like verb (• Created …) must not be
  // classified as Tool, and genuine • Calling / • Called blocks must be classified
  // as Tool. Disambiguator: a verb-bullet is a tool header only when followed by a
  // box-drawing result tree (└│├); Calling/Called are always tool markers.
  describe('COD-227 tool-header vs response disambiguation', () => {
    const MINIMAL_REPRO = `
› new jira issue

• The fresh read shows a formatting problem.

• Calling
└ atlassian.jira_update_issue({})

• Called atlassian.jira_get_issue({})
└ { result: true }

• Created COD-226: View Response → More misclassifies multiline prompt continuations as responses.

  It includes:

  - Two concrete failures
  - Regression-test criteria
`.trim();

    it('returns the final • Created … answer, not the Jira Calling/Called tool log', () => {
      const blocks = parseExternalCliTranscript(MINIMAL_REPRO, 'codex');
      const last = getLastTranscriptResponse(blocks);

      expect(last).toContain('Created COD-226');
      expect(last).toContain('Two concrete failures');
      // Must exclude tool invocations, raw results, and earlier commentary.
      expect(last).not.toContain('atlassian.jira');
      expect(last).not.toContain('Calling');
      expect(last).not.toContain('Called');
      expect(last).not.toContain('fresh read');
    });

    it('classifies genuine • Calling / • Called (with box-drawing results) as Tool', () => {
      const blocks = parseExternalCliTranscript(MINIMAL_REPRO, 'codex');
      const toolText = blocks
        .filter((b) => b.kind === 'tool')
        .map((b) => b.text)
        .join('\n');

      expect(toolText).toContain('Calling');
      expect(toolText).toContain('Called');
      expect(toolText).toContain('atlassian.jira_update_issue');
      // The final answer must not have been swallowed into the tool block.
      expect(toolText).not.toContain('Created COD-226');
    });

    it('labels the repro chronologically: Prompt, Response (commentary), Tool, Response (final)', () => {
      const blocks = parseExternalCliTranscript(MINIMAL_REPRO, 'codex');

      expect(blocks.map((b) => b.kind)).toEqual(['prompt', 'response', 'tool', 'response']);
      expect(blocks[1]?.text).toContain('fresh read');
      expect(blocks[3]?.text).toContain('Created COD-226');
    });

    it('does not classify a verb-prefixed prose bullet as Tool when no result tree follows', () => {
      const transcript = `
› do it

• Created COD-999: a brand new issue with a descriptive title.

  Follow-up prose that belongs to the same answer.
`.trim();

      const blocks = parseExternalCliTranscript(transcript, 'codex');

      expect(blocks.some((b) => b.kind === 'tool')).toBe(false);
      expect(getLastTranscriptResponse(blocks)).toContain('Created COD-999');
      expect(getLastTranscriptResponse(blocks)).toContain('Follow-up prose');
    });

    it('does not regress a genuine verb tool block that has a box-drawing continuation', () => {
      const transcript = `
› look around

• Explored
  └ Read SKILL.md

Here is the assistant answer at column zero.
`.trim();

      const blocks = parseExternalCliTranscript(transcript, 'codex');

      expect(blocks.some((b) => b.kind === 'tool' && b.text.includes('Explored'))).toBe(true);
      expect(getLastTranscriptResponse(blocks)).toBe('Here is the assistant answer at column zero.');
    });
  });

  // The divider-status detector used to be /^[─-]+\s*(.+?)\s*[─-]{3,}$/, whose
  // lazy middle backtracked catastrophically on a long dash run that does not
  // end in 3+ dashes (measured >2min at 8,000 chars). Pane text is
  // agent-controlled and buffers reach 32MB, so the pattern was replaced by a
  // linear counter walk. Same approach as the glob-matcher ReDoS fix (68ae9a8):
  // the hostile input below fails by timeout with the RegExp version.
  describe('divider-status ReDoS hardening', () => {
    it('classifies a hostile 10k dash run in linear time', () => {
      const hostile = '-'.repeat(10_000) + '>';
      const started = Date.now();
      const blocks = parseExternalCliTranscript(`› q\n${hostile}`, 'opencode');
      const elapsed = Date.now() - started;

      expect(elapsed).toBeLessThan(2_000);
      // No 3-dash tail, so the line is not a status divider — it stays prose.
      expect(blocks.some((b) => b.kind === 'response' && b.text.includes('>'))).toBe(true);
      expect(blocks.some((b) => b.kind === 'status')).toBe(false);
    });

    // The counter walk must keep the EXACT accept set and captured content of
    // the old regex (including its backtracking quirks on all-dash lines), so
    // brute-force both against a corpus. The old regex is safe here: probes are
    // capped at 24 chars, far below the blowup threshold.
    it('matches the old regex char-for-char on a brute-force corpus', () => {
      const oldNormalize = (line: string): string | null => {
        const trimmed = line.trim();
        const matched = trimmed.match(/^[─-]+\s*(.+?)\s*[─-]{3,}$/);
        if (!matched) return null;
        return matched[1]?.trim() || null;
      };

      // Observe the private normalizeDividerStatusLine through the parser: after
      // a prompt, a column-zero probe from this alphabet is a status block iff
      // the divider detector matched, and the status text is its return value.
      // (The alphabet triggers no other status arm; letters are limited to 'x'.)
      const observedStatusText = (probe: string): string | null => {
        const blocks = parseExternalCliTranscript(`› q\n${probe}`, 'opencode');
        const status = blocks.find((b) => b.kind === 'status');
        return status ? status.text : null;
      };

      const directed = [
        '──── Status ────',
        '─ Worked for 1m 51s ───────',
        '---',
        '----',
        '-----',
        '------',
        '-------',
        '---- ---',
        '-    ---',
        '--x',
        'x---',
        '----x',
        '----x--',
        '----x---',
        '─x───',
        '- x ---',
        '--- x -',
        '─── ──',
        '-\tx\t---',
        '--->----',
        '─-─- x x ─-─',
        '- x x x ----',
      ];

      // Deterministic LCG so a failure reproduces byte-identically.
      let seed = 0x2f6e2b1;
      const rand = () => {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        return seed / 0x80000000;
      };
      const alphabet = ['-', '-', '─', '─', ' ', ' ', '\t', 'x', '>'];
      const probes = [...directed];
      for (let i = 0; i < 3000; i += 1) {
        const len = Math.floor(rand() * 25);
        let probe = '';
        for (let j = 0; j < len; j += 1) {
          probe += alphabet[Math.floor(rand() * alphabet.length)];
        }
        probes.push(probe);
      }

      for (const raw of probes) {
        const probe = raw.trim();
        // Divider-only lines (8+ dash/whitespace chars) are consumed by
        // isDividerOnlyLine before the status detector ever runs, in both the
        // old and new worlds — the detector is unobservable there.
        if (!probe || /^[\s─-]{8,}$/.test(probe)) continue;
        expect(observedStatusText(probe), `probe: ${JSON.stringify(probe)}`).toBe(oldNormalize(probe));
      }
    });
  });

  // EXTERNAL_CLI_MODES is a local duplicate of isExternalCliMode() in
  // src/session.ts (importing session.ts would drag node-pty and the whole
  // session layer into the pure transcript module). This pin is what keeps the
  // two from drifting — 'pi' was missing here while isExternalCliMode() had it,
  // which left pi sessions with the exact empty-viewer symptom the transcript
  // branch exists to fix.
  describe('mode parity with isExternalCliMode()', () => {
    // Exhaustive by construction: adding a SessionMode without deciding its
    // transcript behavior fails to compile here.
    const ALL_SESSION_MODES: Record<SessionMode, true> = {
      claude: true,
      shell: true,
      opencode: true,
      codex: true,
      gemini: true,
      antigravity: true,
      pi: true,
    };

    it('agrees with isExternalCliMode() for every SessionMode', () => {
      for (const mode of Object.keys(ALL_SESSION_MODES) as SessionMode[]) {
        expect(isExternalCliTranscriptMode(mode), `mode: ${mode}`).toBe(isExternalCliMode(mode));
      }
    });

    it('covers pi', () => {
      expect(isExternalCliTranscriptMode('pi')).toBe(true);
    });
  });
});

describe('GitHub Copilot pane dialect', () => {
  // Captured from a real Copilot 1.0.95 pane inside tmux (a throwaway COPILOT_HOME, a local
  // OpenAI-compatible endpoint): banner, two turns, status rows, composer between rules, footer.
  const rule = '─'.repeat(100);
  const pane = [
    '  ╭─╮╭─╮',
    '  ╰─╯╰─╯  Copilot v1.0.95 uses AI.',
    '  █ ▘▝ █  Check for mistakes.',
    '   ▔▔▔▔',
    ' ! Model "mock" is not in the built-in catalog. Using defaults for: prompt tokens',
    '   (COPILOT_PROVIDER_MAX_PROMPT_TOKENS), output tokens (COPILOT_PROVIDER_MAX_OUTPUT_TOKENS). Run  copilot help',
    '   providers  for configuration details.',
    ' ● Tip: /theme',
    '   └ View or set color mode',
    ' ❯ multi please                                                                                         11:16',
    ' ● First line of the answer.                                                                         ┃',
    '                                                                                                      ┃',
    '   Second paragraph with bold text.                                                                   ┃',
    '                                                                                                      ┃',
    '   • bullet one                                                                                       ┃',
    '   • bullet two                                                                                       ┃',
    ' ❯ WORKDONE followed by _4711                                                                          11:17',
    ' ● WORKDONE_4711',
    ' ● MCP Servers reloaded: 1 server connected',
    ' /tmp/work/.../scratch-2                                                  Session: credits unavailable',
    rule,
    '❯',
    rule,
    ' ← open sidebar · Interactive · Manual Approval · / commands · ? help · tab next tab           mock',
  ].join('\n');

  it('is a transcript mode', () => {
    expect(isExternalCliTranscriptMode('copilot')).toBe(true);
  });

  it('returns the last answer, with no banner, status rows, composer or footer in it', () => {
    const blocks = parseExternalCliTranscript(pane, 'copilot');
    expect(getLastTranscriptResponse(blocks)).toBe('WORKDONE_4711');
  });

  it('keeps a multi-paragraph answer whole and strips the prompt timestamp', () => {
    const blocks = parseExternalCliTranscript(pane, 'copilot');
    const prompts = blocks.filter((b) => b.kind === 'prompt').map((b) => b.text);
    expect(prompts).toEqual(['multi please', 'WORKDONE followed by _4711']);
    const first = blocks.find((b) => b.kind === 'response')!;
    expect(first.text).toContain('First line of the answer.');
    expect(first.text).toContain('Second paragraph with bold text.');
    expect(first.text).toContain('• bullet two');
    expect(first.text).not.toMatch(/Session:|open sidebar|Tip:/);
    // The scrollbar gutter Copilot draws at the right edge of every row never reaches the text.
    expect(first.text).not.toContain('┃');
  });

  it('answers nothing for a session that has only drawn its banner or a trust dialog', () => {
    const banner = pane.split('\n').slice(0, 9).join('\n');
    expect(getLastTranscriptResponse(parseExternalCliTranscript(banner, 'copilot'))).toBe('');
    const trust = [
      '│ Do you trust the files in this folder?',
      '│ ❯ 1. Yes',
      '│   2. Yes, and remember this folder for future sessions',
    ].join('\n');
    expect(getLastTranscriptResponse(parseExternalCliTranscript(trust, 'copilot'))).toBe('');
  });

  it('does not take the empty composer glyph for a prompt', () => {
    const blocks = parseExternalCliTranscript(pane, 'copilot');
    expect(blocks.some((b) => b.kind === 'prompt' && b.text === '')).toBe(false);
  });
});
