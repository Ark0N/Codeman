/**
 * @fileoverview Shape helpers for Codex rollout JSONL lines, shared by the two
 * readers of `~/.codex/sessions`: the Past Sessions scanner
 * (`codex-transcript.ts`, previews only) and the offline history reader
 * (`local-history.ts`, whole conversations).
 *
 * Both readers must agree on three facts, so they live here once:
 *
 *  - where the store is (`$CODEX_HOME/sessions`, else `~/.codex/sessions`);
 *  - which line shapes carry a user or assistant message;
 *  - which `response_item` user rows are injected context rather than input.
 *
 * ## The message shapes
 *
 * Codex has written conversation text under three shapes:
 *
 *  - `event_msg` / `user_message` and `agent_message`, written by every version
 *    seen so far. `agent_message` carries a `phase` (`commentary` or
 *    `final_answer`); `user_message` carries none.
 *  - `event_msg` / `item_completed` with an `item.type` of `UserMessage` or
 *    `AgentMessage`, written by newer versions (0.152.1 and later).
 *  - `response_item` rows with `role: 'user'` or `'assistant'`. These are what
 *    the model saw, so the user rows mix real input with injected context.
 *
 * ## The injected-context rule
 *
 * Codex injects context as `response_item` user rows that start with a Markdown
 * heading (`# AGENTS.md instructions for ...`) or an XML-style tag
 * (`<environment_context>`, `<recommended_plugins>`, `<subagent_notification>`,
 * `<skill>`, `<turn_aborted>`, `<image ...>`, `<codex_internal_context ...>`).
 * Measured on a store of 2,916 rollouts (codex 0.120 to 0.163), every
 * `response_item` user row with either prefix and no event twin was injected;
 * the real prompts that start with `#` all have a `user_message` or
 * `UserMessage` event twin, which this rule never filters. A fixed list of tag
 * names would leak every wrapper Codex adds later (`<recommended_plugins>`
 * alone was 1,355 rows on that store), so the rule is the prefix.
 *
 * @module codex-rollout-format
 */

import { homedir } from 'node:os';
import { join } from 'node:path';

/** Codex's home directory: `$CODEX_HOME`, else `~/.codex`, exactly as codex resolves it. */
export function codexHomeDir(): string {
  return process.env.CODEX_HOME || join(homedir(), '.codex');
}

/** The rollout store under {@link codexHomeDir}. */
export function codexSessionsRoot(): string {
  return join(codexHomeDir(), 'sessions');
}

/**
 * Flatten Codex message content, which is a string or an array of blocks.
 * Only blocks carrying a string `text` contribute (images and skills do not).
 * Not trimmed: callers that want a preview trim.
 */
export function codexContentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter(
      (b): b is { text: string } => !!b && typeof b === 'object' && typeof (b as { text?: unknown }).text === 'string'
    )
    .map((b) => b.text)
    .filter(Boolean)
    .join('\n');
}

/** Injected context rather than typed input. Applies to `response_item` user rows only. */
export function isCodexInjectedContext(text: string): boolean {
  const start = text.trimStart();
  return start.startsWith('#') || start.startsWith('<');
}

/** One rollout line's user or assistant message, whichever shape carried it. */
export interface CodexLineMessage {
  role: 'user' | 'assistant';
  /** Untrimmed text, never empty. */
  text: string;
  /** `event` = user_message/agent_message, `item` = item_completed, `response` = response_item. */
  shape: 'event' | 'item' | 'response';
  /** Codex's own phase (`commentary` / `final_answer`) when the line carries one. */
  phase?: string;
  /** A `response_item` user row: may be injected context, see {@link isCodexInjectedContext}. */
  injectionProne: boolean;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function phaseOf(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

/** The message a parsed rollout line carries, or null for every other line. */
export function codexMessageFromLine(entry: unknown): CodexLineMessage | null {
  const e = record(entry);
  const p = record(e.payload);
  let role: CodexLineMessage['role'] | undefined;
  let text = '';
  let shape: CodexLineMessage['shape'] = 'event';
  let phase: string | undefined;
  if (e.type === 'event_msg') {
    if (p.type === 'user_message' || p.type === 'agent_message') {
      role = p.type === 'user_message' ? 'user' : 'assistant';
      text = codexContentText(p.message);
      phase = phaseOf(p.phase);
    } else if (p.type === 'item_completed') {
      const item = record(p.item);
      if (item.type === 'UserMessage' || item.type === 'AgentMessage') {
        role = item.type === 'UserMessage' ? 'user' : 'assistant';
        shape = 'item';
        text = codexContentText(item.content);
        phase = phaseOf(item.phase);
      }
    }
  } else if (e.type === 'response_item' && (p.role === 'user' || p.role === 'assistant')) {
    role = p.role;
    shape = 'response';
    text = codexContentText(p.content);
    phase = phaseOf(p.phase);
  }
  if (!role || !text) return null;
  return { role, text, shape, phase, injectionProne: shape === 'response' && role === 'user' };
}
