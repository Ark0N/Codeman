import { beforeEach, expect, it, vi } from 'vitest';
import { parseClaudeVisibleQuestion } from '../src/web/claude-visible-question.js';
import { answerClaudeQuestion } from '../src/web/claude-question-answer.js';
import { answerPendingApproval } from '../src/web/routes/approval-routes.js';
import { approvalInbox } from '../src/web/approval-inbox.js';
import type { Session } from '../src/session.js';

const frame = (selected = 1, question = 'Choose a test color?', boxed = true) =>
  `☐ Color\n\n${boxed ? '│ ' : ''}${question}\n\n${selected === 1 ? '❯' : ' '} 1. Red\n     Select red\n${selected === 2 ? '❯' : ' '} 2. Blue\n     Select blue\n${selected === 3 ? '❯' : ' '} 3. Green\n     Select green\n  4. Type something.\n──────────\n  5. Chat about this\n\nEnter to select · ↑/↓ to navigate · Esc to cancel\n`;
function harness() {
  let selected = 1,
    done = false,
    allow = true;
  const writes: string[] = [];
  const capture = vi.fn(async () => (done ? '────\n❯ \n────' : frame(selected)));
  const write = vi.fn(async (key: string) => {
    writes.push(key);
    if (key === '\x1b[B') selected++;
    else if (key === '\x1b[A') selected--;
    else if (key === '\r') done = true;
    return true;
  });
  const s = {
    id: 'q-test',
    mode: 'claude',
    claudeSessionId: 'conversation',
    claudeSessionIdIsFirstHand: true,
    discordQueueRevision: 'input',
    withNativeQuestionInput: async (run: any, current: () => boolean) =>
      run({ capture, write, current: () => allow && current() }),
  } as unknown as Session;
  return {
    s,
    writes,
    capture,
    write,
    revoke: () => {
      allow = false;
    },
  };
}
beforeEach(() => approvalInbox.stop());
it('verifies selected cursor changes before sending one Enter', async () => {
  const h = harness();
  expect(await answerClaudeQuestion(h.s, parseClaudeVisibleQuestion(frame())!, 3, () => true)).toBe('accepted');
  expect(h.writes).toEqual(['\x1b[B', '\x1b[B', '\r']);
});
it('recognizes both bordered and recent unbordered Claude question bodies', () => {
  expect(parseClaudeVisibleQuestion(frame(1, 'Choose a test color?', false))?.question).toBe('Choose a test color?');
  expect(parseClaudeVisibleQuestion(frame(1))?.identity).toBe(parseClaudeVisibleQuestion(frame(3))?.identity);
});
it('does not send Enter if the question or scope changes while navigating', async () => {
  const h = harness();
  h.write.mockImplementationOnce(async (key) => {
    h.writes.push(key);
    h.revoke();
    return true;
  });
  expect(await answerClaudeQuestion(h.s, parseClaudeVisibleQuestion(frame())!, 2, () => true)).toBe('blocked');
  expect(h.writes).toEqual(['\x1b[B']);
  const other = harness();
  other.capture.mockResolvedValue(frame(1, 'Different question?'));
  expect(await answerClaudeQuestion(other.s, parseClaudeVisibleQuestion(frame())!, 2, () => true)).toBe('blocked');
  expect(other.writes).toEqual([]);
});
it('refuses type-in/chat entries and never retries an unconfirmed Enter', async () => {
  const h = harness();
  expect(await answerClaudeQuestion(h.s, parseClaudeVisibleQuestion(frame())!, 4, () => true)).toBe('blocked');
  h.write.mockImplementation(async (key) => {
    h.writes.push(key);
    return false;
  });
  expect(await answerClaudeQuestion(h.s, parseClaudeVisibleQuestion(frame())!, 1, () => true)).toBe('uncertain');
  expect(h.writes).toEqual(['\r']);
});
function pending(h: ReturnType<typeof harness>) {
  return approvalInbox.notePrompt({
    sessionId: h.s.id,
    sessionName: 'test',
    mode: 'claude',
    kind: 'question',
    message: 'Choose a test color?',
    nativeQuestion: {
      conversation: 'conversation',
      inputRevision: 'input',
      dialog: parseClaudeVisibleQuestion(frame())!,
      state: 'pending',
    },
  });
}
it('shares the checked answer route with cards and consumes the exact question after native confirmation', async () => {
  const h = harness(),
    p = pending(h);
  expect(p.options?.map((o) => o.label)).toEqual(['Red', 'Blue', 'Green']);
  expect((await answerPendingApproval(h.s, p.id, { action: 'option', option: 2 })).success).toBe(true);
  expect(h.writes).toEqual(['\x1b[B', '\r']);
  expect(approvalInbox.getById(p.id)).toBeUndefined();
});
it('keeps uncertain answers pending but disables their selection controls instead of retrying', async () => {
  const h = harness(),
    p = pending(h);
  h.write.mockImplementation(async (key) => {
    h.writes.push(key);
    return false;
  });
  expect((await answerPendingApproval(h.s, p.id, { action: 'option', option: 1 })).success).toBe(false);
  expect(p.nativeQuestion?.state).toBe('uncertain');
  expect(p.answerInTerminal).toBe(true);
  expect((await answerPendingApproval(h.s, p.id, { action: 'option', option: 1 })).success).toBe(false);
  expect(h.writes).toEqual(['\r']);
});
it('rejects double clicks, a replaced conversation and revoked caller scope', async () => {
  const h = harness(),
    p = pending(h);
  let release!: (value: string) => void;
  h.capture.mockImplementationOnce(
    () =>
      new Promise((r) => {
        release = r;
      })
  );
  const first = answerPendingApproval(h.s, p.id, { action: 'option', option: 1 });
  expect((await answerPendingApproval(h.s, p.id, { action: 'option', option: 2 })).success).toBe(false);
  release(frame());
  expect((await first).success).toBe(true);
  expect(h.writes).toEqual(['\r']);
  const other = harness(),
    q = pending(other);
  Object.assign(other.s, { claudeSessionId: 'different' });
  expect((await answerPendingApproval(other.s, q.id, { action: 'option', option: 1 })).success).toBe(false);
  expect(other.writes).toEqual([]);
  Object.assign(other.s, { claudeSessionId: 'conversation' });
  expect((await answerPendingApproval(other.s, q.id, { action: 'option', option: 1 }, () => false)).success).toBe(
    false
  );
  expect(other.writes).toEqual([]);
});

it('projects verified native questions as selectable inbox options shared by Discord and the web API', async () => {
  const { createDiscordNativeUiServices } = await import('../src/web/discord-native-ui-services.js');
  const h = harness();
  const services = createDiscordNativeUiServices({
    sessions: () => new Map([[h.s.id, h.s]]),
    cases: async () => [],
    allowed: () => true,
    url: () => undefined,
    capture: () => frame(),
  });
  await services.sessions();
  const q = services.question(h.s.id)!;
  expect(q.terminalOnly).toBe(false);
  expect(q.options.map((o) => o.label)).toEqual(['Red', 'Blue', 'Green']);
  await expect(services.answer(h.s.id, q.id, q.revision, '2')).resolves.toContain('Answer sent');
  expect(h.writes).toEqual(['\x1b[B', '\r']);
});

it('does not let an old card follow changed user input or a later identical question', async () => {
  const { createDiscordNativeUiServices } = await import('../src/web/discord-native-ui-services.js');
  const h = harness();
  const services = createDiscordNativeUiServices({
    sessions: () => new Map([[h.s.id, h.s]]),
    cases: async () => [],
    allowed: () => true,
    url: () => undefined,
    capture: () => frame(),
  });
  await services.sessions();
  const old = services.question(h.s.id)!;
  Object.assign(h.s, { discordQueueRevision: 'changed-input' });
  await services.sessions();
  const fresh = services.question(h.s.id)!;
  expect(fresh.id).not.toBe(old.id);
  await expect(services.answer(h.s.id, old.id, old.revision, '1')).rejects.toThrow('Question changed');
  expect(h.writes).toEqual([]);
  await services.answer(h.s.id, fresh.id, fresh.revision, '1');
  await services.sessions();
  expect(services.question(h.s.id)!.id).not.toBe(fresh.id);
});

it('answers only the current hook-vouched compaction-chain tail', async () => {
  const h = harness();
  Object.assign(h.s, { claudeSessionId: 'older', claudeSessionChain: ['older', 'conversation'] });
  const p = pending(h);
  expect((await answerPendingApproval(h.s, p.id, { action: 'option', option: 2 })).success).toBe(true);
  expect(h.writes).toEqual(['\x1b[B', '\r']);
});
it('refuses an unverified inherited conversation ID before navigating a question', async () => {
  const h = harness();
  Object.assign(h.s, { claudeSessionIdIsFirstHand: false });
  const p = pending(h);
  expect((await answerPendingApproval(h.s, p.id, { action: 'option', option: 2 })).success).toBe(false);
  expect(h.writes).toEqual([]);
});

it('preserves exact question identity across mobile footer wrapping and separator resizing', () => {
  const wide = frame();
  const narrow = wide
    .replaceAll('──────────', '────────────────────────────')
    .replace('Esc to cancel', 'Esc to\ncancel');
  expect(parseClaudeVisibleQuestion(narrow)?.identity).toBe(parseClaudeVisibleQuestion(wide)?.identity);
  expect(parseClaudeVisibleQuestion(narrow + 'Unexpected newer text')).toBeUndefined();
  expect(parseClaudeVisibleQuestion(narrow.replace('Blue', 'Yellow'))?.identity).not.toBe(
    parseClaudeVisibleQuestion(wide)?.identity
  );
});
