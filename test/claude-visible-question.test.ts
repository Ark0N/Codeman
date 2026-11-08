import { describe, expect, it, beforeEach, vi } from 'vitest';
import { claudeVisibleQuestion, claudeQuestionGone } from '../src/web/claude-visible-question.js';
import { createDiscordNativeUiServices } from '../src/web/discord-native-ui-services.js';
import { approvalInbox } from '../src/web/approval-inbox.js';
import type { Session } from '../src/session.js';

const frame = `Free disk  ✔ Submit  →

│ Which caches should I clear?
│ These can be regenerated.

❯ 1. [ ] Build target (94G)
         Build output, kept release files.
  2. [x] Docker images (~25G)
         Unused images only.
  3. [ ] Type something
     Submit
────────────────────
  4. Chat about this

Enter to select · ↑/↓ to navigate · Esc to cancel
`;
beforeEach(() => {
  approvalInbox.stop();
});
describe('visible Claude multi-select question', () => {
  it('keeps the wrapped question and every label, including the text alternative', () => {
    expect(claudeVisibleQuestion(frame)).toBe(
      'Which caches should I clear? These can be regenerated.\n\n1. Build target (94G)\n2. Docker images (~25G)\n3. Type something\n\nSelect one or more options and submit in the terminal.'
    );
    expect(claudeVisibleQuestion('\x1b[32m' + frame + '\x1b[0m')).toBe(claudeVisibleQuestion(frame));
  });
  it.each([
    '',
    frame.replace('Enter to select', 'Enter to confirm'),
    frame + '❯ normal composer',
    frame.replace('2. [x]', '7. [x]'),
    frame.replace('     Submit\n', ''),
    frame.replaceAll('│', ''),
    '```\n' + frame + '```',
  ])('rejects incomplete dialogs, examples and inconsistent choices', (value) => {
    expect(claudeVisibleQuestion(value)).toBeUndefined();
  });
  it('requires a fresh normal composer to conclude a question disappeared', () => {
    expect(claudeQuestionGone(frame)).toBe(false);
    expect(claudeQuestionGone('Partial capture')).toBe(false);
    expect(claudeQuestionGone('────\n❯ \n────')).toBe(true);
  });
});
function fixture() {
  const s = {
    id: 's',
    name: 'w29-test',
    mode: 'claude',
    claudeSessionId: 'conversation',
    claudeSessionIdIsFirstHand: true,
    discordQueueRevision: 'revision',
    isWorking: false,
    workingDir: '/workspace',
  } as unknown as Session;
  const sessions = new Map([['s', s]]);
  let allowed = true;
  let capture: () => string | null | Promise<string | null> = () => frame;
  const notify = vi.fn();
  const services = createDiscordNativeUiServices({
    sessions: () => sessions,
    cases: async () => [],
    allowed: () => allowed,
    url: () => undefined,
    capture: () => capture(),
    questionObserved: notify,
  });
  return {
    s,
    sessions,
    services,
    notify,
    capture: (value: typeof capture) => {
      capture = value;
    },
    revoke: () => {
      allowed = false;
    },
  };
}
it('projects, forwards once, and refuses Discord keystrokes for a live checkbox question', async () => {
  const f = fixture();
  Object.assign(f.s, { isWorking: true, watching: 'background task' });
  expect((await f.services.sessions())[0].pending).toBe(true);
  const q = f.services.question('s')!;
  expect(q.terminalOnly).toBe(true);
  expect(q.text).toContain('2. Docker images');
  await expect(f.services.answer('s', q.id, q.revision, '1')).rejects.toThrow();
  await f.services.sessions();
  Object.assign(f.s, { discordQueueRevision: 'navigated' });
  await f.services.sessions();
  expect(f.notify).toHaveBeenCalledTimes(1);
});
it.each(['conversation', 'revision', 'session', 'allowed', 'exit', 'write'])(
  'drops a capture after %s changes',
  async (change) => {
    const f = fixture();
    f.capture(() => {
      if (change === 'conversation') Object.assign(f.s, { claudeSessionId: 'new' });
      if (change === 'revision') Object.assign(f.s, { discordQueueRevision: 'new' });
      if (change === 'session') f.sessions.set('s', { ...f.s } as Session);
      if (change === 'allowed') f.revoke();
      if (change === 'exit') Object.assign(f.s, { paneExit: {} });
      if (change === 'write') Object.assign(f.s, { guardedInputPendingWrites: 1 });
      return frame;
    });
    await f.services.sessions();
    expect(f.notify).not.toHaveBeenCalled();
    expect(approvalInbox.listPending()).toEqual([]);
  }
);
it('keeps pending on unavailable/partial captures and resolves only its own item on a fresh composer', async () => {
  const f = fixture();
  await f.services.sessions();
  f.capture(() => null);
  await f.services.sessions();
  expect(f.services.question('s')).toBeDefined();
  f.capture(() => 'Partial frame');
  await f.services.sessions();
  expect(f.services.question('s')).toBeDefined();
  f.capture(() => '────\n❯ \n────');
  await f.services.sessions();
  expect(f.services.question('s')).toBeUndefined();
  f.capture(() => frame);
  await f.services.sessions();
  expect(f.notify).toHaveBeenCalledTimes(2);
  const hook = approvalInbox.notePrompt({ sessionId: 's', sessionName: 'test', kind: 'permission' });
  f.capture(() => '────\n❯ \n────');
  await f.services.sessions();
  expect(approvalInbox.getById(hook.id)).toBeDefined();
});
it('does not replace hook-owned questions or double-read concurrent captures', async () => {
  const f = fixture();
  let release!: (frame: string) => void;
  f.capture(
    () =>
      new Promise((resolve) => {
        release = resolve;
      })
  );
  const first = f.services.sessions();
  await vi.waitFor(() => expect(release).toBeTypeOf('function'));
  await f.services.sessions();
  const hook = approvalInbox.notePrompt({ sessionId: 's', sessionName: 'test', kind: 'question' });
  release(frame);
  await first;
  expect(f.notify).not.toHaveBeenCalled();
  expect(approvalInbox.getById(hook.id)).toBeDefined();
});
it('retries failed forwarding without duplicating the pending item, then stops after success', async () => {
  const f = fixture();
  f.notify.mockReturnValueOnce(false).mockReturnValueOnce(true);
  await f.services.sessions();
  const id = f.services.question('s')!.id;
  await f.services.sessions();
  await f.services.sessions();
  expect(f.services.question('s')!.id).toBe(id);
  expect(f.notify).toHaveBeenCalledTimes(2);
});
it('removes its pending item when the session closes without touching another session', async () => {
  const f = fixture();
  await f.services.sessions();
  const other = approvalInbox.notePrompt({ sessionId: 'other', sessionName: 'Other', kind: 'question' });
  f.sessions.clear();
  await f.services.sessions();
  expect(approvalInbox.listPending().map((p) => p.id)).toEqual([other.id]);
});

const singleQuestion = `Release canary

│ The agent release is built and scanned.
│ The image is ready for the last gate.
│ The canary runs on a customer runner.
│ It writes to the runner's workspace.
│ A live batch is still running there.
│ The canary refuses while a job runs.
│ How should I run it?

❯ 1. Wait for an idle gap (Recommended)
     Poll the runner and start when idle.
     The batch may queue behind it.
     Waiting takes twenty minutes.
     Keep the next deployment waiting.
  2. Skip canary, promote now
     Publish without the canary.
     This skips a required safety gate.
     Only the agent image changed.
     The toolchain is unchanged.
  3. Hold the release
     Do not touch the runner.
     Keep the image unpublished.
     Other services keep waiting.
     No work is performed now.
  4. Type something.
─────────────────────────────
  5. Chat about this

Enter to select · ↑/↓ to navigate · Esc to cancel
`;
it('detects a long single-choice question without clipping its beginning or losing wrapped question lines', () => {
  expect(singleQuestion.split('\n').length).toBeGreaterThan(30);
  const q = claudeVisibleQuestion(singleQuestion)!;
  expect(q).toMatch(/^The agent release is built and scanned\./);
  expect(q).toContain('How should I run it?');
  expect(q).toContain('1. Wait for an idle gap (Recommended)');
  expect(q).toContain('2. Skip canary, promote now');
  expect(q).toContain('3. Hold the release');
  expect(q).toContain('4. Type something.');
  expect(q).toContain('5. Chat about this');
  expect(q).toMatch(/Choose an option in the terminal\.$/);
});
it.each([
  singleQuestion.replace('5. Chat about this', '5. Other prose'),
  singleQuestion.replace('4. Type something.', '4. Another choice'),
  singleQuestion.replace('❯ 1.', '  1.'),
  singleQuestion.replace('2. Skip', '9. Skip'),
  singleQuestion.replace('2. Skip', '2. [ ] Skip'),
  singleQuestion + '❯ New composer\n────',
])('rejects partial, historical and mixed single-choice layouts', (frame) => {
  expect(claudeVisibleQuestion(frame)).toBeUndefined();
});
it('projects a single-choice live question into the inbox and forwards it once without allowing terminal writes', async () => {
  const f = fixture();
  f.capture(() => singleQuestion);
  expect((await f.services.sessions())[0].pending).toBe(true);
  const q = f.services.question('s')!;
  expect(q.text).toContain('The agent release is built and scanned.');
  expect(q.terminalOnly).toBe(true);
  await expect(f.services.answer('s', q.id, q.revision, '1')).rejects.toThrow();
  await f.services.sessions();
  expect(f.notify).toHaveBeenCalledTimes(1);
});
