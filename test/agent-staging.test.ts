/** @fileoverview Guarded staging one-shot and content-verification safety. */
import { beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { CODEX_REASONING_EFFORTS } from '../src/types/session.js';
import {
  GuardedStageStore,
  STAGE_SETTLE_INTERVAL_MS,
  STAGE_SETTLE_TIMEOUT_MS,
  SUBMIT_QUIET_MS,
  composerTriggerRefusal,
  guardedComposerChrome,
  readGuardedComposer,
  readGuardedSnapshot,
  type GuardedInputTarget,
} from '../src/agent-staging.js';
import { getCli, listClis } from '../src/config/cli-registry/registry.js';
/** Codex's composer chrome exactly as the registry declares it: no copy of the glyph or footer here. */
const CODEX = guardedComposerChrome(getCli('codex'))!;
const readGuardedCodexComposer = (screen: string) => readGuardedComposer(screen, CODEX);
const readGuardedCodexSnapshot = (snapshot: string) => readGuardedSnapshot(snapshot, CODEX);
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
let store: GuardedStageStore;
let time: number;
let generation: string;
let revision: number;
let composer: string | null;
let writes: string[];
let fail: boolean;
let target: GuardedInputTarget;
/** Every settle-window wait, on the fake clock: no real timer runs in this file. */
let sleeps: number[];
const fakeSleep = async (ms: number) => {
  sleeps.push(ms);
  time += ms;
};
beforeEach(() => {
  sleeps = [];
  time = 0;
  generation = 'pane-1';
  revision = 0;
  composer = '';
  writes = [];
  fail = false;
  store = new GuardedStageStore(() => time, 2, 1000, { sleep: fakeSleep });
  target = {
    id: 's',
    chrome: () => CODEX,
    snapshot: () =>
      composer === null ? null : { generation, revision, composerSha: sha(composer), availableColumns: 100 },
    submit: async () => target.write('\r'),
    write: async (text) => {
      writes.push(text);
      revision++;
      if (fail) return false;
      composer = text === '\r' ? '' : composer + text;
      return true;
    },
  };
});
it('stages without Enter, stores only a hash, and submits exactly once', async () => {
  const receipt = await store.stage(target, 'alice', 'hello');
  expect(writes).toEqual(['hello']);
  expect(receipt.sha256).toBe(sha('hello'));
  expect(JSON.stringify(receipt)).not.toContain('hello');
  await store.submit(target, 'alice', receipt.stageId, receipt.sha256);
  expect(writes).toEqual(['hello', '\r']);
  await expect(store.submit(target, 'alice', receipt.stageId, receipt.sha256)).rejects.toThrow();
});
it('refuses multiline, controls, oversized prompts and nonempty or unprovable composers before writing', async () => {
  for (const text of ['', 'one\ntwo', 'one\rtwo', '\u001b', '\u0085', 'x'.repeat(20000), '\ud800'])
    await expect(store.stage(target, 'alice', text)).rejects.toThrow();
  composer = 'existing';
  await expect(store.stage(target, 'alice', 'hello')).rejects.toThrow();
  composer = null;
  await expect(store.stage(target, 'alice', 'hello')).rejects.toThrow();
  expect(writes).toEqual([]);
});
it('refuses altered composer including whitespace-only differences', async () => {
  const receipt = await store.stage(target, 'alice', 'hello world');
  composer = 'helloworld';
  await expect(store.submit(target, 'alice', receipt.stageId, receipt.sha256)).rejects.toThrow();
  expect(writes).toEqual(['hello world']);
});
it('refuses changed generation, intervening input, wrong owner/session/hash and expiry', async () => {
  for (const change of [
    () => {
      generation = 'pane-2';
    },
    () => {
      revision++;
    },
    () => {
      time += 1001;
    },
  ]) {
    composer = '';
    const receipt = await store.stage(target, 'alice', 'hello');
    change();
    await expect(store.submit(target, 'alice', receipt.stageId, receipt.sha256)).rejects.toThrow();
  }
  composer = '';
  const receipt = await store.stage(target, 'alice', 'hello');
  await expect(store.submit(target, 'bob', receipt.stageId, receipt.sha256)).rejects.toThrow();
  await expect(store.submit({ ...target, id: 'other' }, 'alice', receipt.stageId, receipt.sha256)).rejects.toThrow();
  await expect(store.submit(target, 'alice', receipt.stageId, sha('other'))).rejects.toThrow();
  expect(writes.filter((s) => s === '\r')).toHaveLength(0);
});
it('consumes before write so concurrent and failed deliveries never replay Enter', async () => {
  const receipt = await store.stage(target, 'alice', 'hello');
  fail = true;
  const results = await Promise.allSettled([
    store.submit(target, 'alice', receipt.stageId, receipt.sha256),
    store.submit(target, 'alice', receipt.stageId, receipt.sha256),
  ]);
  expect(results.every((r) => r.status === 'rejected')).toBe(true);
  expect(writes).toEqual(['hello', '\r']);
  await expect(store.submit(target, 'alice', receipt.stageId, receipt.sha256)).rejects.toThrow();
});
it('does not issue a receipt on failed staging or intervening input during its write', async () => {
  fail = true;
  await expect(store.stage(target, 'alice', 'hello')).rejects.toThrow();
  fail = false;
  composer = '';
  const altered = {
    ...target,
    write: async (s: string) => {
      await target.write(s);
      revision++;
      return true;
    },
  };
  await expect(store.stage(altered, 'alice', 'hello')).rejects.toThrow();
});

it('reads exact composer spaces and refuses wrapped or modal frames', async () => {
  expect(readGuardedCodexComposer('› hello  world\n  GPT-6-Luna default · ~/case\n')).toBe('hello  world');
  expect(
    readGuardedCodexComposer(
      '› \x1b[2mAsk Codex to do anything\x1b[0m\n  GPT-6-Luna default · ~/case\n  ← for agents · ? for shortcuts'
    )
  ).toBe('');
  expect(readGuardedCodexComposer('› wrapped\n  more text\n  GPT-6-Luna default · ~/case')).toBeNull();
  expect(readGuardedCodexComposer('› 1. Yes\n  Press enter to confirm')).toBeNull();
  expect(readGuardedCodexComposer('› hello\n')).toBeNull();
});
it('requires capture cursor geometry, rejecting invisible trailing edits and moved cursors', async () => {
  const { formatPaneSnapshot } = await import('../src/tmux-manager.js');
  const frame = (text: string, x: number, y = 0) =>
    formatPaneSnapshot([`› ${text}`, '  GPT-6-Luna default · ~/case'], { cols: 100, rows: 20, cursorX: x, cursorY: y });
  expect(readGuardedCodexSnapshot(frame('hello', 7))).toBe('hello');
  expect(readGuardedCodexSnapshot(frame('hello', 8))).toBeNull();
  expect(readGuardedCodexSnapshot(frame('hello', 4))).toBeNull();
  expect(readGuardedCodexSnapshot(frame('hello', 7, 1))).toBeNull();
  expect(readGuardedCodexSnapshot('› hello\n  GPT-6-Luna default · ~/case')).toBeNull();
  expect(readGuardedCodexSnapshot(frame('你好', 6))).toBe('你好');
  expect(readGuardedCodexSnapshot(frame('\x1b[38;2;2;100;100mhello\x1b[0m', 7))).toBe('hello');
});
it('reserves receipt capacity before concurrent stages type', async () => {
  store = new GuardedStageStore(() => time, 1, 1000, { sleep: fakeSleep });
  let release: (() => void) | undefined;
  const firstTarget = {
    ...target,
    write: async (text: string) => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return target.write(text);
    },
  };
  const first = store.stage(firstTarget, 'alice', 'hello');
  const otherTarget = { ...target, id: 'other' };
  await expect(store.stage(otherTarget, 'alice', 'other')).rejects.toThrow(/capacity/i);
  expect(writes).toEqual([]);
  release!();
  await first;
});

it.each([...CODEX_REASONING_EFFORTS, 'default'])(
  'accepts the shared Codex effort word %s in the footer',
  async (word) => {
    expect(readGuardedCodexComposer(`› hello\n  GPT-6 ${word} · ~/case\n`)).toBe('hello');
  }
);

it('refuses messages that reach the available pane columns before typing', async () => {
  target.snapshot = () => ({ generation, revision, composerSha: sha(composer ?? ''), availableColumns: 4 });
  for (const text of ['four', '界界']) await expect(store.stage(target, 'alice', text)).rejects.toThrow();
  expect(writes).toEqual([]);
  await expect(store.stage(target, 'alice', 'abc')).resolves.toMatchObject({ submitted: false });
});

it('takes the composer glyph and footer from the registry, and only codex declares a footer', () => {
  const codex = getCli('codex')!.capabilities.workDetect!;
  expect(CODEX.promptGlyph).toBe(codex.promptGlyph);
  expect(CODEX.footerLine.source).toBe(codex.composerFooterLine);
  // Another glyph drives the same reader: nothing in it is codex-specific.
  const other = { promptGlyph: '>>', footerLine: CODEX.footerLine };
  expect(readGuardedComposer('>> hello\n  GPT-6 default · ~/case\n', other)).toBe('hello');
  expect(readGuardedComposer('› hello\n  GPT-6 default · ~/case\n', other)).toBeNull();
  const declaring = listClis()
    .filter((entry) => entry.capabilities.workDetect?.composerFooterLine)
    .map((entry) => entry.id);
  expect(declaring).toEqual(['codex']);
  expect(guardedComposerChrome(getCli('claude'))).toBeNull();
  // A pattern the ReDoS guard refuses yields no chrome, so no guarded input.
  const unsafe = structuredClone(getCli('codex')!);
  unsafe.capabilities.workDetect!.composerFooterLine = '(a+)+b';
  expect(guardedComposerChrome(unsafe)).toBeNull();
});

describe('the settle window after typing (a live codex pane repaints 30 to 60 ms after the keys)', () => {
  /** Serve these post-write frames in order, then the target's own snapshot. */
  function afterWrite(frames: Array<(() => ReturnType<GuardedInputTarget['snapshot']>) | null>) {
    let written = false;
    const own = target.snapshot;
    const write = target.write;
    target.write = async (text) => {
      const ok = await write(text);
      written = true;
      return ok;
    };
    target.snapshot = () => {
      if (!written || frames.length === 0) return own();
      const next = frames.shift()!;
      return next ? next() : null;
    };
  }
  const stale = () => ({ generation, revision, composerSha: sha(''), availableColumns: 100 });

  it('names its bounds', () => {
    expect(STAGE_SETTLE_TIMEOUT_MS).toBe(1000);
    expect(STAGE_SETTLE_INTERVAL_MS).toBe(50);
  });
  it('issues a receipt once a null first frame is followed by a valid one', async () => {
    afterWrite([null]);
    const receipt = await store.stage(target, 'alice', 'hello');
    expect(receipt.sha256).toBe(sha('hello'));
    expect(sleeps).toEqual([STAGE_SETTLE_INTERVAL_MS]);
  });
  it('issues a receipt once a stale frame (the old, empty composer) is followed by a valid one', async () => {
    afterWrite([stale, stale]);
    await expect(store.stage(target, 'alice', 'hello')).resolves.toMatchObject({ submitted: false });
    expect(sleeps).toHaveLength(2);
  });
  it('refuses, saying the text may be in the composer, when no frame verifies within the window', async () => {
    target.snapshot = () => (writes.length ? null : stale());
    const refusal = await store.stage(target, 'alice', 'hello').catch((error: Error) => error.message);
    expect(refusal).toMatch(/within 1000 ms; no receipt was issued/);
    expect(refusal).toMatch(/may already be in the composer.*Ctrl\+U/);
    expect(sleeps.length).toBeGreaterThanOrEqual(STAGE_SETTLE_TIMEOUT_MS / STAGE_SETTLE_INTERVAL_MS);
  });
  it('issues no receipt for a frame whose composer text differs from the message', async () => {
    const write = target.write;
    target.write = async (text) => {
      await write(text);
      composer = 'hellp'; // codex shows something else: a transformed paste, a dropped key
      return true;
    };
    await expect(store.stage(target, 'alice', 'hello')).rejects.toThrow(/did not show the staged message/);
    // Nothing to submit: no receipt was stored for the frame that did not match.
    composer = 'hello';
    await expect(store.submit(target, 'alice', '11111111-1111-4111-8111-111111111111', sha('hello'))).rejects.toThrow(
      /Unknown/
    );
  });
  it('refuses at once, without waiting, when another writer moved the input during the window', async () => {
    afterWrite([() => ({ generation, revision: revision + 1, composerSha: sha('hello'), availableColumns: 100 })]);
    await expect(store.stage(target, 'alice', 'hello')).rejects.toThrow(
      /Input or pane changed while staging; no receipt was issued\. The message may already be in the composer/
    );
    expect(sleeps).toEqual([]);
  });
  it('words a failed typing delivery like the submit refusal: it cannot know whether the text landed', async () => {
    fail = true;
    await expect(store.stage(target, 'alice', 'hello')).rejects.toThrow(
      /^Staging delivery failed or ambiguous; no receipt was issued\. The message may already be in the composer/
    );
  });
});

describe('popups and commands that change what Enter does (codex rust-v0.162.0 bottom_pane)', () => {
  const footer = '  gpt-5.6-terra default · ~/case';
  /** A frame as codex lays it out: transcript, popup, the composer's blank top row, composer, blank, footer. */
  const frame = (popup: string[], draft: string) =>
    ['• Earlier answer from the agent.', '', ...popup, '', `› ${draft}`, '', footer].join('\n');

  it('reads the idle frame with transcript above it', () => {
    expect(readGuardedCodexComposer(frame([], 'hello'))).toBe('hello');
  });
  it('refuses the slash-command list codex opens above `› /stat` (Enter would run /status)', () => {
    const popup = [
      '› /status      show current session configuration and token usage',
      '  /statusline  configure which items appear in the status line',
    ];
    expect(readGuardedCodexComposer(frame(popup, '/stat'))).toBeNull();
    // A wrapped description row at the bottom of the list does not hide it.
    expect(readGuardedCodexComposer(frame(['› /tier-one  Use faster', '             inference'], '/tier'))).toBeNull();
  });
  it('refuses the skill, mention and file-search popups', () => {
    const skill = ['› 1password  [Skill] Example skill used in tests.', '', '  enter insert · esc close'];
    const mention = [
      '  Mentions',
      '   All Results   Filesystem Only   Plugins',
      '  sa',
      '› Sample Plugin   Plugin with skills and an MCP server                Plugin',
      '  enter/tab insert · esc close · ↑/↓ select · ←/→ filter',
    ];
    expect(readGuardedCodexComposer(frame(skill, '$1p'))).toBeNull();
    expect(readGuardedCodexComposer(frame(mention, '@sa'))).toBeNull();
    expect(readGuardedCodexComposer(frame(['  loading...', ''], '@src'))).toBeNull();
    expect(readGuardedCodexComposer(frame(['no matches'], '/zz'))).toBeNull();
  });
  it('looks only at the block directly above the composer, not the transcript further up', () => {
    const screen = ['  /status  shows the status', '', '• Answer.', '', '', '', '› hello', '', footer].join('\n');
    expect(readGuardedCodexComposer(screen)).toBe('hello');
  });
  it('takes the popup pattern and the trigger characters from the registry', () => {
    const codex = getCli('codex')!.capabilities.workDetect!;
    expect(CODEX.popupLine?.source).toBe(new RegExp(codex.composerPopupLine!).source);
    expect(CODEX.commandPrefixes).toBe('/!');
    expect(CODEX.completionSigils).toBe('@$');
    // A popup pattern the ReDoS guard refuses yields no chrome, rather than chrome without it.
    const unsafe = structuredClone(getCli('codex')!);
    unsafe.capabilities.workDetect!.composerPopupLine = '(a+)+b';
    expect(guardedComposerChrome(unsafe)).toBeNull();
  });
  it.each([
    ['/stat', '/'],
    ['/status now', '/'],
    ['  /review', '/'],
    ['!ls -la', '!'],
    ['review @src/app', '@'],
    ['@notes', '@'],
    ['run $skill', '$'],
    ['costs $5', '$'],
  ])('refuses %j before typing (trigger %s)', async (message, trigger) => {
    expect(composerTriggerRefusal(message, CODEX)).toContain(`"${trigger}"`);
    await expect(store.stage(target, 'alice', message)).rejects.toThrow(
      trigger === '/' || trigger === '!' ? /codeman agent send/ : /completion popup/
    );
    expect(writes).toEqual([]);
  });
  it.each(['look at @src/app.ts please', 'mail a@b.example', 'pay $5 today', 'a/b and c!'])(
    'stages %j: no trigger at the start, and the caret word opens nothing',
    async (message) => {
      expect(composerTriggerRefusal(message, CODEX)).toBeNull();
      await expect(store.stage(target, 'alice', message)).resolves.toMatchObject({ submitted: false });
    }
  );
});

describe("the quiet time before Enter (codex's 120 ms paste-burst window turns Enter into a newline)", () => {
  it('waits out the rest of the window after the staged keys before checking and sending Enter', async () => {
    expect(SUBMIT_QUIET_MS).toBeGreaterThan(120);
    const receipt = await store.stage(target, 'alice', 'hello');
    time += 40;
    await store.submit(target, 'alice', receipt.stageId, receipt.sha256);
    expect(sleeps).toEqual([SUBMIT_QUIET_MS - 40]);
    expect(writes).toEqual(['hello', '\r']);
  });
  it('does not wait once the window has passed', async () => {
    const receipt = await store.stage(target, 'alice', 'hello');
    time += SUBMIT_QUIET_MS;
    await store.submit(target, 'alice', receipt.stageId, receipt.sha256);
    expect(sleeps).toEqual([]);
  });
  it('still refuses when a keystroke lands during the wait', async () => {
    store = new GuardedStageStore(() => time, 2, 1000, {
      sleep: async (ms) => {
        await fakeSleep(ms);
        revision++; // the user typed while submit waited
      },
    });
    const receipt = await store.stage(target, 'alice', 'hello');
    await expect(store.submit(target, 'alice', receipt.stageId, receipt.sha256)).rejects.toThrow(
      /changed; nothing submitted/
    );
    expect(writes).toEqual(['hello']);
  });
});
