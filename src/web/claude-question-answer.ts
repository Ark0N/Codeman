import { setTimeout as delay } from 'node:timers/promises';
import type { Session } from '../session.js';
import {
  parseClaudeVisibleQuestion,
  claudeQuestionGone,
  type ClaudeVisibleQuestion,
} from './claude-visible-question.js';

/** Match upstream transcript ownership: prefer the compaction-chain tail, then a hook-vouched ID. */
export function claudeQuestionConversation(session: Session): string | undefined {
  return (
    session.claudeSessionChain?.at(-1) ??
    (session.claudeSessionIdIsFirstHand ? session.claudeSessionId : undefined) ??
    (/^[a-f0-9-]{36}$/i.test(session.id) ? session.id : undefined)
  );
}

/** Never replay Enter. Re-check the exact question after every navigation key under the input lease. */
export async function answerClaudeQuestion(
  session: Session,
  expected: ClaudeVisibleQuestion,
  option: number,
  allowed: () => boolean
): Promise<'accepted' | 'blocked' | 'uncertain'> {
  if (expected.multiSelect || !expected.choices.some((o) => o.n === option)) return 'blocked';
  let submitted = false;
  try {
    return await session.withNativeQuestionInput(async (lease) => {
      let current = parseClaudeVisibleQuestion(await lease.capture());
      if (!allowed() || !lease.current() || !current || current.identity !== expected.identity) return 'blocked';
      for (let step = 0; current.selected !== option && step < 6; step++) {
        const selected = current.selected + (current.selected < option ? 1 : -1);
        if (!(await lease.write(current.selected < option ? '\x1b[B' : '\x1b[A'))) return 'blocked';
        for (let poll = 0; poll < 10; poll++) {
          const next = parseClaudeVisibleQuestion(await lease.capture());
          if (!allowed() || !lease.current() || !next || next.identity !== expected.identity) return 'blocked';
          current = next;
          if (current.selected === selected) break;
          if (poll < 9) await delay(50);
        }
        if (current.selected !== selected) return 'blocked';
      }
      // A final capture ensures Enter cannot target an unverified cursor or a newer dialog.
      current = parseClaudeVisibleQuestion(await lease.capture());
      if (
        !allowed() ||
        !lease.current() ||
        !current ||
        current.identity !== expected.identity ||
        current.selected !== option
      )
        return 'blocked';
      submitted = true;
      if (!(await lease.write('\r'))) return 'uncertain';
      for (let poll = 0; poll < 20; poll++) {
        const frame = await lease.capture();
        const next = parseClaudeVisibleQuestion(frame);
        if (!allowed() || !lease.current()) return 'uncertain';
        if (next && next.identity !== expected.identity) return 'accepted';
        if (!next && claudeQuestionGone(frame)) return 'accepted';
        if (poll < 19) await delay(100);
      }
      return 'uncertain';
    }, allowed);
  } catch {
    return submitted ? 'uncertain' : 'blocked';
  }
}
