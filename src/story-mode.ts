/**
 * @fileoverview Story Mode core (pure): a Claude Code transcript becomes comic pages, one page per turn.
 *
 * Three stages, each pure so the tests exercise the shipped code:
 *
 *  1. `createStoryReducer()` turns ONE parsed transcript line into compact `StoryEntry`s. This is where
 *     size is shed: a Read result's file content, a Write/Edit result's `originalFile` and image data
 *     never leave this function, outputs keep only a bounded tail, and an edit keeps its
 *     `structuredPatch` hunks up to `STORY_LIMITS.hunkLines`. The reader (story-reader.ts) caches
 *     these entries, so what is dropped here is never held in memory.
 *  2. `buildStoryTurns()` joins each tool call with its result and splits the entries into turns.
 *  3. `buildStoryPage()` groups one turn's events into panels and writes two captions per panel:
 *     a plain-language "story" line for anyone and a "director" line naming the tools.
 *
 * What the format rests on (measured 2026-10-18 on 40 local transcripts, counts and key names only):
 *  - Interactive transcripts carry NO `type: 'result'` entries. A turn ends with
 *    `{ type: 'system', subtype: 'turn_duration', durationMs }`; a compaction is `compact_boundary`.
 *  - A prompt is a `user` entry with text and no `tool_result`. `isMeta` and `isCompactSummary`
 *    entries are plumbing, `turnCompanion` rides along with a prompt, and `turnOrigin` says who
 *    started the turn (`human`, `task_notification`, `peer`, `system`, `scheduled`, `sdk`).
 *  - Tool results carry `toolUseResult` beside the `tool_result` block: every Edit result had a
 *    `structuredPatch` with line numbers (125 of 125), Write results the new `content`, Agent
 *    results `totalToolUseCount`/`totalDurationMs`, AskUserQuestion results `answers`.
 *  - Bash results carry no exit code; a failed call's `tool_result` has `is_error: true`
 *    (72 of 3,334, most starting "Exit code"). 92% of Bash calls carry Claude's own
 *    `description` ("Run the test suite"), which is what the plain captions use.
 *  - Bash is 78% of all tool calls, so a Bash call is sorted by what its command does
 *    (`classifyBashCommand`), not by its tool name.
 *
 * Everything here is untrusted text written by the agent. Nothing is interpreted: no path is
 * opened, no command run, no regex built from transcript content.
 */

import type {
  StoryActor,
  StoryEdit,
  StoryEvent,
  StoryHelper,
  StoryHunk,
  StoryIntent,
  StoryPage,
  StoryPanel,
  StoryPanelKind,
  StoryTests,
  StoryTodo,
  StoryTurnOrigin,
  StoryTurnSummary,
} from './types/story.js';

/** Size caps. A page stays small enough to fetch on every live refresh. */
export const STORY_LIMITS = Object.freeze({
  promptChars: 600,
  textChars: 600,
  labelChars: 400,
  inputChars: 2000,
  outputChars: 8000,
  outputLines: 160,
  hunkLines: 160,
  lineChars: 400,
  helperChars: 4000,
  todoItems: 12,
  eventsPerPage: 800,
  panelsPerPage: 12,
  /** Characters of output, hunk and helper text per page; older events give theirs up first. */
  pageTextBudget: 400_000,
  turnsListed: 60,
});

// ========== Entries (stage 1 output) ==========

interface ReducedInput {
  command?: string;
  description?: string;
  file?: string;
  offset?: number;
  old?: string;
  new?: string;
  pattern?: string;
  path?: string;
  url?: string;
  query?: string;
  type?: string;
  name?: string;
  prompt?: string;
  todos?: StoryTodo[];
  question?: string;
  options?: string[];
  plan?: string;
  to?: string;
  summary?: string;
  text?: string;
}

export type StoryEntry =
  | { k: 'prompt'; id: string; at: string; text: string; origin: StoryTurnOrigin; queued: boolean }
  | { k: 'text'; at: string; text: string }
  | { k: 'tool'; at: string; id: string; name: string; input: ReducedInput }
  | {
      k: 'result';
      at: string;
      id: string;
      isError: boolean;
      output?: string;
      outputTruncated?: boolean;
      edit?: StoryEdit;
      helper?: { result?: string; toolUses?: number; durationMs?: number; agentId?: string };
      answer?: string;
      tests?: StoryTests;
    }
  | { k: 'end'; at: string; durationMs?: number }
  | { k: 'compact'; at: string }
  | { k: 'interrupt'; at: string };

// ========== Small helpers ==========

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

export function clip(value: string, max: number): string {
  const s = value.trim();
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;
}

/** The END of a long output: that is where the result and the error are. */
function clipTail(value: string, maxChars: number, maxLines: number): { text: string; truncated: boolean } {
  let lines = value.replace(/\s+$/, '').split('\n');
  let truncated = false;
  if (lines.length > maxLines) {
    lines = lines.slice(-maxLines);
    truncated = true;
  }
  let text = lines.join('\n');
  if (text.length > maxChars) {
    text = text.slice(-maxChars);
    truncated = true;
  }
  return { text, truncated };
}

/** Text of a message `content`: a string, or the text blocks of a block array. */
function blockText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((b) => (isRecord(b) && b.type === 'text' && typeof b.text === 'string' ? b.text : ''))
    .filter(Boolean)
    .join('\n');
}

const basename = (path: string): string => path.slice(path.replace(/\/+$/, '').lastIndexOf('/') + 1) || path;
const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;
const unique = <T>(items: T[]): T[] => [...new Set(items)];

/** The first sentence of a message, without markdown, for a speech balloon. */
export function firstSentence(text: string, max = 160): string {
  // Only real markdown goes: paired emphasis and line-start markers. A bare `_` or `*` inside a word
  // stays, or `test_wcount.py` would read `testwcount.py`.
  const plain = text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`\n]*)`/g, '$1')
    .replace(/!?\[([^\]\n]*)\]\([^)\n]*\)/g, '$1')
    .replace(/(^|[\s(])(\*\*|__)(?=\S)([^\n]*?\S)\2(?=[\s),!?:;]|\.(?:\s|$)|$)/g, '$1$3')
    .replace(/(^|[\s(])([*_])(?=\S)([^*_\n]*?\S)\2(?=[\s),!?:;]|\.(?:\s|$)|$)/g, '$1$3')
    .replace(/^[ \t]{0,3}(#{1,6}|>|[-*+]|\d+\.)[ \t]+/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
  const match = /^(.+?[.!?])(\s|$)/.exec(plain);
  return clip(match ? match[1] : plain, max);
}

export function roughDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return plural(s, 'second');
  const m = Math.round(s / 60);
  if (m < 60) return plural(m, 'minute');
  const h = Math.floor(m / 60);
  const rest = m % 60;
  return rest ? `${h} h ${rest} min` : plural(h, 'hour');
}

export function exactDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ${s % 60} s`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}

const fmtCounts = (added: number, removed: number): string =>
  [added ? `+${added}` : '', removed ? `−${removed}` : ''].filter(Boolean).join(' ') || '±0';

// ========== Bash commands and test counts ==========

/**
 * Splits a command line into its simple commands at `&&`, `||`, `;`, `|` and newlines, outside quotes.
 * Not a shell parser: just enough to see what each part of a one-liner starts with.
 */
function commandSegments(command: string): string[] {
  const segments: string[] = [];
  let cur = '';
  let quote = '';
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote) {
      if (ch === quote) quote = '';
      else if (ch === '\\' && quote === '"') cur += command[++i] ?? '';
      cur += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      cur += ch;
      continue;
    }
    if (ch === ';' || ch === '\n' || ch === '|' || (ch === '&' && command[i + 1] === '&')) {
      if (ch === '&' || (ch === '|' && command[i + 1] === '|')) i++;
      segments.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  segments.push(cur);
  return segments.map((x) => x.trim()).filter(Boolean);
}

/** A segment's command with what only wraps it removed: env assignments, `sudo`, `timeout 60`, `( ...`. */
function segmentHead(segment: string): string {
  let s = segment.replace(/^[({\s]+/, '');
  for (let k = 0; k < 6; k++) {
    const next = s
      .replace(/^[A-Za-z_][A-Za-z0-9_]*=("[^"]*"|'[^']*'|\S*)\s+/, '')
      .replace(/^(sudo|command|exec|time|nice|nohup|env|xargs)\s+/, '')
      .replace(/^timeout\s+(-\S+\s+)*\S+\s+/, '');
    if (next === s) break;
    s = next;
  }
  // `git -c k=v -C dir commit`: drop git's own options so the subcommand comes next.
  return s.replace(/^git((\s+-[cC]\s+\S+)|(\s+--\S+))*\s+/, 'git ');
}

const TEST_HEAD =
  /^(npm (run )?test\b|npm run test:\S+|yarn (run )?test\b|pnpm (run )?test\b|bun test\b|npx (vitest|jest|mocha|playwright test)\b|vitest\b|jest\b|mocha\b|pytest\b|py\.test\b|python3? -m (pytest|unittest)\b|node --test\b|deno test\b|go test\b|cargo (test|nextest)\b|make (test|check)\b|rspec\b|phpunit\b|mix test\b|dotnet test\b|ctest\b|tox\b)/;
const BUILD_HEAD =
  /^(npm run (build|typecheck|lint|check|format)\S*|yarn (run )?(build|lint|typecheck)\b|pnpm (run )?(build|lint|typecheck)\b|tsc\b|npx (tsc|eslint|prettier|biome)\b|eslint\b|prettier\b|biome\b|make\b|cargo (build|check|clippy)\b|go (build|vet)\b|gradlew?\b|\.\/gradlew\b|mvn\b|ruff\b|mypy\b|black\b|cmake\b|ninja\b|shellcheck\b|node --check\b)/;
const SAVE_HEAD = /^(git (commit|push|tag|merge|rebase|cherry-pick|revert|am)\b|gh (pr|release) (create|merge)\b)/;
const EDIT_SEGMENT = /^(sed -i\b|perl -p?i\b|cat\s*>|tee\b|patch\b|git apply\b)|(^|[^>&0-9])>\s*[\w./~-]+\.\w+\b/;
const LOOK_HEAD =
  /^(cd|cat|head|tail|sed -n|grep|egrep|rg|find|ls|wc|awk|jq|tree|stat|file|du|df|diff|less|more|xxd|od|which|type|pwd|echo|printf|sort|uniq|cut|basename|dirname|realpath|readlink|git (status|diff|log|show|branch|blame|ls-files|rev-parse|remote)|gh (pr|issue|run|api) (view|list|diff|checks))\b/;
/** A probe that names a test runner without running tests: `pytest --version`, `npm test --help`. */
const PROBE = /\s--(version|help)\b|\s-[Vh]\s*$/;

/**
 * Strongest first: one test in a one-liner makes the whole call a test run (its pass or fail is the
 * news), and a commit outranks the build or lint that ran before it.
 */
const INTENT_RANK: StoryIntent[] = ['test', 'save', 'build', 'edit', 'run', 'look'];

/**
 * What a Bash command does, from the command text alone. Never executes it, and never parses it as
 * shell beyond splitting it into simple commands: each part is judged by what it starts with (after
 * env assignments and wrappers like `timeout`), and the strongest intent of any part wins.
 */
export function classifyBashCommand(command: string): StoryIntent {
  let best = INTENT_RANK.length - 1;
  for (const segment of commandSegments(command.slice(0, 2000))) {
    const head = segmentHead(segment);
    const intent: StoryIntent =
      TEST_HEAD.test(head) && !PROBE.test(head)
        ? 'test'
        : BUILD_HEAD.test(head) && !PROBE.test(head)
          ? 'build'
          : SAVE_HEAD.test(head)
            ? 'save'
            : EDIT_SEGMENT.test(head)
              ? 'edit'
              : LOOK_HEAD.test(head)
                ? 'look'
                : 'run';
    best = Math.min(best, INTENT_RANK.indexOf(intent));
  }
  return INTENT_RANK[best];
}

/**
 * Passed/failed counts from a test runner's summary line (vitest, jest, pytest, mocha, cargo...).
 * Scans the last lines only; returns null when no summary is recognisable.
 */
export function parseTestCounts(output: string): StoryTests | null {
  const lines = output.split('\n').slice(-40).reverse();
  for (const line of lines) {
    const passed = /\b(\d+) (passed|passing)\b/i.exec(line);
    if (!passed) continue;
    const failedSameLine = /\b(\d+) (failed|failing)\b/i.exec(line);
    let failed = failedSameLine ? Number(failedSameLine[1]) : 0;
    if (!failedSameLine) {
      const failing = lines.map((l) => /^\s*(\d+) failing\b/i.exec(l)).find(Boolean);
      if (failing) failed = Number(failing[1]);
    }
    return { passed: Number(passed[1]), failed };
  }
  return null;
}

// ========== Stage 1: reduce one transcript line ==========

const SYSTEM_REMINDER_RE = /<system-reminder>[\s\S]*?<\/system-reminder>/g;
/** Wrappers around things the user did locally (shell `!`, slash command output): never a turn. */
const LOCAL_WRAPPER_RE =
  /^\s*<(local-command-caveat|local-command-stdout|local-command-stderr|bash-input|bash-stdout|bash-stderr)>/;

function readPrompt(raw: string): { text: string; kind: 'prompt' | 'task' | 'interrupt' } | null {
  const text = raw.replace(SYSTEM_REMINDER_RE, '').trim();
  if (!text) return null;
  if (/^\[Request interrupted/.test(text)) return { text, kind: 'interrupt' };
  if (LOCAL_WRAPPER_RE.test(text)) return null;
  const command = /<command-name>([^<]*)<\/command-name>/.exec(text);
  if (command) {
    const args = /<command-args>([^<]*)<\/command-args>/.exec(text)?.[1] ?? '';
    return { text: `${command[1].trim()} ${args.trim()}`.trim(), kind: 'prompt' };
  }
  if (/^<task-notification>/.test(text)) {
    const summary = /<summary>([\s\S]*?)<\/summary>/.exec(text)?.[1];
    return { text: (summary || 'A background task finished.').trim(), kind: 'task' };
  }
  return { text, kind: 'prompt' };
}

function originOf(turnOrigin: unknown, kind: 'prompt' | 'task'): StoryTurnOrigin {
  if (turnOrigin === 'human') return 'human';
  if (turnOrigin === 'task_notification' || kind === 'task') return 'task';
  if (turnOrigin === 'peer') return 'peer';
  if (typeof turnOrigin === 'string') return 'system';
  return 'human';
}

function reduceInput(name: string, input: unknown): ReducedInput {
  const i = isRecord(input) ? input : {};
  const s = (v: unknown, max: number) => {
    const value = str(v);
    return value === undefined ? undefined : clip(value, max);
  };
  switch (name) {
    case 'Bash':
      return { command: s(i.command, STORY_LIMITS.labelChars), description: s(i.description, 160) };
    case 'Read':
    case 'NotebookRead':
      return { file: s(i.file_path ?? i.notebook_path, 1000), offset: num(i.offset) };
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return {
        file: s(i.file_path ?? i.notebook_path, 1000),
        old: s(i.old_string ?? i.old_str, STORY_LIMITS.inputChars),
        new: s(i.new_string ?? i.new_str, STORY_LIMITS.inputChars),
      };
    case 'Write':
      return { file: s(i.file_path, 1000) };
    case 'Grep':
    case 'Glob':
      return { pattern: s(i.pattern, 200), path: s(i.path, 1000) };
    case 'WebFetch':
      return { url: s(i.url, 400) };
    case 'WebSearch':
      return { query: s(i.query, 200) };
    case 'Agent':
    case 'Task':
      return {
        description: s(i.description, 160),
        type: s(i.subagent_type, 60),
        name: s(i.name, 60),
        prompt: s(i.prompt, STORY_LIMITS.helperChars),
      };
    case 'TodoWrite': {
      const todos = Array.isArray(i.todos) ? i.todos : [];
      return {
        todos: todos.slice(0, STORY_LIMITS.todoItems).map((t) => ({
          text: clip(String((isRecord(t) && (str(t.content) ?? str(t.subject))) || ''), 160),
          done: isRecord(t) && t.status === 'completed',
        })),
      };
    }
    case 'AskUserQuestion': {
      const q = Array.isArray(i.questions) && isRecord(i.questions[0]) ? i.questions[0] : {};
      const options = Array.isArray(q.options) ? q.options : [];
      return {
        question: s(q.question, 300),
        options: options.slice(0, 6).map((o) => clip(String((isRecord(o) ? str(o.label) : str(o)) ?? ''), 80)),
      };
    }
    case 'ExitPlanMode':
      return { plan: s(i.plan, STORY_LIMITS.helperChars) };
    case 'SendMessage':
      return { to: s(i.to ?? i.recipient, 80), summary: s(i.summary ?? i.message, 200) };
    default: {
      const first = Object.values(i).find((v): v is string => typeof v === 'string');
      return { text: first ? clip(first, 200) : undefined };
    }
  }
}

function editFromResult(name: string, result: Record<string, unknown>, input: ReducedInput): StoryEdit | undefined {
  const file = str(result.filePath) ?? input.file;
  if (!file) return undefined;
  const clipLine = (l: string) =>
    l.length > STORY_LIMITS.lineChars ? `${l.slice(0, STORY_LIMITS.lineChars - 1)}…` : l;
  const hunks: StoryHunk[] = [];
  let added = 0;
  let removed = 0;
  let truncated = false;
  let budget: number = STORY_LIMITS.hunkLines;
  const patch = Array.isArray(result.structuredPatch) ? result.structuredPatch : [];
  for (const h of patch) {
    if (!isRecord(h)) continue;
    const lines = Array.isArray(h.lines) ? h.lines.filter((l): l is string => typeof l === 'string') : [];
    for (const l of lines) {
      if (l.startsWith('+')) added++;
      else if (l.startsWith('-')) removed++;
    }
    const kept = lines.slice(0, Math.max(0, budget)).map(clipLine);
    budget -= kept.length;
    if (kept.length < lines.length) truncated = true;
    if (kept.length) {
      hunks.push({
        oldStart: num(h.oldStart) ?? 0,
        oldLines: num(h.oldLines) ?? 0,
        newStart: num(h.newStart) ?? 0,
        newLines: num(h.newLines) ?? 0,
        lines: kept,
      });
    }
  }
  const content = str(result.content);
  if (!patch.length && name === 'Write' && content !== undefined) {
    // A new file has no patch: every line is an addition.
    const lines = content.split('\n');
    if (content.endsWith('\n')) lines.pop();
    added = lines.length;
    const kept = lines.slice(0, STORY_LIMITS.hunkLines).map((l) => clipLine(`+${l}`));
    truncated = kept.length < lines.length;
    hunks.push({ oldStart: 0, oldLines: 0, newStart: 1, newLines: lines.length, lines: kept });
  } else if (!patch.length && input.old !== undefined && input.new !== undefined) {
    // An older transcript without `structuredPatch`: show the replacement itself.
    const oldLines = input.old.split('\n');
    const newLines = input.new.split('\n');
    removed = oldLines.length;
    added = newLines.length;
    const lines = [...oldLines.map((l) => `-${l}`), ...newLines.map((l) => `+${l}`)];
    const kept = lines.slice(0, STORY_LIMITS.hunkLines).map(clipLine);
    truncated = kept.length < lines.length;
    hunks.push({ oldStart: 0, oldLines: removed, newStart: 0, newLines: added, lines: kept });
  }
  return { file, added, removed, created: result.type === 'create', hunks, truncated };
}

/** Tools whose result text is noise on a comic page (file contents, "edited successfully"). */
const QUIET_RESULTS = new Set(['Read', 'NotebookRead', 'Edit', 'MultiEdit', 'Write', 'NotebookEdit', 'TodoWrite']);
const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);

export interface StoryReducer {
  /** Compact entries for one parsed JSONL line (an object, or anything: non-objects reduce to nothing). */
  reduce(line: unknown): StoryEntry[];
}

/**
 * A reducer remembers each tool call's name and input until its result arrives, since the result line
 * does not repeat them. Bounded: a call whose result never comes is forgotten after 4,000 newer calls.
 * `sidechain` reads a helper's own transcript, where every line is a sidechain line; the main
 * transcript skips them.
 */
export function createStoryReducer({ sidechain = false }: { sidechain?: boolean } = {}): StoryReducer {
  const calls = new Map<string, { name: string; input: ReducedInput }>();
  const remember = (id: string, name: string, input: ReducedInput) => {
    calls.set(id, { name, input });
    if (calls.size > 4000) {
      const oldest = calls.keys().next().value;
      if (oldest !== undefined) calls.delete(oldest);
    }
  };

  function reduceUser(entry: Record<string, unknown>, at: string): StoryEntry[] {
    if (entry.isCompactSummary === true || entry.isVisibleInTranscriptOnly === true) return [];
    const message = isRecord(entry.message) ? entry.message : {};
    const content = message.content;
    const out: StoryEntry[] = [];
    if (Array.isArray(content)) {
      const results = content.filter((b): b is Record<string, unknown> => isRecord(b) && b.type === 'tool_result');
      for (const block of results) {
        const id = str(block.tool_use_id);
        if (!id) continue;
        const call = calls.get(id);
        const name = call?.name ?? '';
        const isError = block.is_error === true;
        // `toolUseResult` describes the entry's (single) result; only trust it for the first block.
        const extra = block === results[0] && isRecord(entry.toolUseResult) ? entry.toolUseResult : {};
        const text = blockText(block.content);
        const result: Extract<StoryEntry, { k: 'result' }> = { k: 'result', at, id, isError };
        if (EDIT_TOOLS.has(name) && !isError) {
          const edit = editFromResult(name, extra, call?.input ?? {});
          if (edit) result.edit = edit;
        }
        if (name === 'Agent' || name === 'Task') {
          const answer = blockText(extra.content) || text;
          result.helper = {
            result: answer ? clip(answer, STORY_LIMITS.helperChars) : undefined,
            toolUses: num(extra.totalToolUseCount),
            durationMs: num(extra.totalDurationMs),
            agentId:
              typeof extra.agentId === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(extra.agentId)
                ? extra.agentId
                : undefined,
          };
        } else if (name === 'AskUserQuestion' && isRecord(extra.answers)) {
          const first = Object.values(extra.answers).find((v): v is string => typeof v === 'string');
          if (first) result.answer = clip(first, 300);
        } else if (text && (!QUIET_RESULTS.has(name) || isError)) {
          const tail = clipTail(text, STORY_LIMITS.outputChars, STORY_LIMITS.outputLines);
          result.output = tail.text;
          if (tail.truncated) result.outputTruncated = true;
          if (name === 'Bash') {
            const tests = parseTestCounts(tail.text);
            if (tests) result.tests = tests;
          }
        }
        out.push(result);
        calls.delete(id);
      }
      if (results.length) return out;
    }
    if (entry.isMeta === true || entry.turnCompanion === true) return out;
    const prompt = readPrompt(blockText(content));
    if (!prompt) return out;
    if (prompt.kind === 'interrupt') return [{ k: 'interrupt', at }];
    return [
      {
        k: 'prompt',
        id: str(entry.uuid) ?? `prompt-${at}`,
        at,
        text: clip(prompt.text, STORY_LIMITS.promptChars),
        origin: originOf(entry.turnOrigin, prompt.kind),
        queued: entry.promptSource === 'queued',
      },
    ];
  }

  function reduceAssistant(entry: Record<string, unknown>, at: string): StoryEntry[] {
    const message = isRecord(entry.message) ? entry.message : {};
    const content = message.content;
    if (typeof content === 'string')
      return content.trim() ? [{ k: 'text', at, text: clip(content, STORY_LIMITS.textChars) }] : [];
    if (!Array.isArray(content)) return [];
    const out: StoryEntry[] = [];
    for (const block of content) {
      if (!isRecord(block)) continue;
      if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
        out.push({ k: 'text', at, text: clip(block.text, STORY_LIMITS.textChars) });
      } else if (block.type === 'tool_use' && typeof block.id === 'string' && typeof block.name === 'string') {
        const input = reduceInput(block.name, block.input);
        remember(block.id, block.name, input);
        out.push({ k: 'tool', at, id: block.id, name: block.name, input });
      }
    }
    return out;
  }

  return {
    reduce(line: unknown): StoryEntry[] {
      if (!isRecord(line) || (line.isSidechain === true && !sidechain)) return [];
      const at = str(line.timestamp) ?? '';
      switch (line.type) {
        case 'user':
          return reduceUser(line, at);
        case 'assistant':
          return reduceAssistant(line, at);
        case 'system':
          if (line.subtype === 'turn_duration') return [{ k: 'end', at, durationMs: num(line.durationMs) }];
          if (line.subtype === 'compact_boundary') return [{ k: 'compact', at }];
          return [];
        default:
          return [];
      }
    },
  };
}

// ========== Stage 2: turns ==========

export interface StoryTurn {
  id: string;
  at: string;
  prompt: string;
  origin: StoryTurnOrigin;
  /** Began before the part of the transcript that was read. */
  partial: boolean;
  events: StoryEvent[];
  ended: boolean;
  interrupted: boolean;
  endedAt?: string;
  durationMs?: number;
}

function intentOf(name: string, input: ReducedInput): StoryIntent {
  switch (name) {
    case 'Read':
    case 'NotebookRead':
    case 'LS':
      return 'read';
    case 'Grep':
    case 'Glob':
      return 'search';
    case 'WebFetch':
    case 'WebSearch':
      return 'web';
    case 'TodoWrite':
    case 'TaskCreate':
    case 'TaskUpdate':
    case 'EnterPlanMode':
      return 'plan';
    case 'ExitPlanMode':
    case 'AskUserQuestion':
      return 'ask';
    case 'Agent':
    case 'Task':
    case 'Workflow':
      return 'helper';
    case 'SendMessage':
      return 'message';
    case 'Edit':
    case 'MultiEdit':
    case 'Write':
    case 'NotebookEdit':
      return 'edit';
    case 'Bash':
      return classifyBashCommand(input.command ?? '');
    default:
      return 'tool';
  }
}

function labelOf(name: string, i: ReducedInput): string {
  switch (name) {
    case 'Bash':
      return i.command ?? '';
    case 'Grep':
    case 'Glob':
      return `"${i.pattern ?? ''}"${i.path ? ` in ${i.path}` : ''}`;
    case 'WebFetch':
      return i.url ?? '';
    case 'WebSearch':
      return i.query ?? '';
    case 'Agent':
    case 'Task':
      return `${i.name || i.type || 'helper'}: ${i.description ?? ''}`.trim();
    case 'TodoWrite':
      return plural(i.todos?.length ?? 0, 'item');
    case 'AskUserQuestion':
      return i.question ?? '';
    case 'ExitPlanMode':
      return 'Plan ready for your OK';
    case 'SendMessage':
      return `to ${i.to ?? '?'}: ${i.summary ?? ''}`.trim();
    default:
      return i.file ?? i.text ?? '';
  }
}

function toolEvent(e: Extract<StoryEntry, { k: 'tool' }>, actor: StoryActor): StoryEvent {
  const i = e.input;
  const ev: StoryEvent = {
    id: e.id,
    at: e.at,
    actor,
    tool: e.name,
    label: clip(labelOf(e.name, i), STORY_LIMITS.labelChars),
    intent: intentOf(e.name, i),
    pending: true,
  };
  if (i.file) ev.file = i.file;
  if (i.offset) ev.line = i.offset;
  if (e.name === 'Bash' && i.description) ev.description = i.description;
  if (e.name === 'Agent' || e.name === 'Task') {
    ev.helper = {
      name: i.name || i.type || 'helper',
      type: i.type || 'general-purpose',
      task: i.description,
      prompt: i.prompt || i.description || '',
    };
  }
  if (i.todos) ev.todos = i.todos;
  if (e.name === 'AskUserQuestion') ev.question = { text: i.question ?? '', options: i.options ?? [] };
  if (e.name === 'ExitPlanMode')
    ev.question = { text: firstSentence(i.plan ?? 'Claude has a plan.', 240), options: [] };
  return ev;
}

function applyResult(ev: StoryEvent, r: Extract<StoryEntry, { k: 'result' }>): void {
  ev.pending = undefined;
  ev.ok = !r.isError;
  if (r.output !== undefined) ev.output = r.output;
  if (r.outputTruncated) ev.outputTruncated = true;
  if (r.edit) {
    ev.edit = r.edit;
    ev.file = r.edit.file;
  }
  if (r.tests) ev.tests = r.tests;
  if (r.helper && ev.helper) {
    const helper: StoryHelper = { ...ev.helper };
    if (r.helper.result) helper.result = r.helper.result;
    if (r.helper.toolUses !== undefined) helper.toolUses = r.helper.toolUses;
    if (r.helper.durationMs !== undefined) helper.durationMs = r.helper.durationMs;
    if (r.helper.agentId) helper.agentId = r.helper.agentId;
    ev.helper = helper;
  }
  if (r.answer && ev.question) ev.question = { ...ev.question, answer: r.answer };
}

/**
 * Splits reduced entries into turns. A prompt starts a turn, except one queued while a turn is
 * still running, which joins it ("you add something"). Entries before the first prompt in the
 * window form a `partial` turn. `turn_duration` ends a turn; an interrupt ends it too.
 */
export function buildStoryTurns(entries: StoryEntry[]): StoryTurn[] {
  const turns: StoryTurn[] = [];
  let cur: StoryTurn | null = null;
  const byId = new Map<string, StoryEvent>();
  let say = 0;
  const ensure = (at: string): StoryTurn => {
    if (!cur) {
      cur = {
        id: `partial-${at}`,
        at,
        prompt: '',
        origin: 'human',
        partial: true,
        events: [],
        ended: false,
        interrupted: false,
      };
      turns.push(cur);
    }
    return cur;
  };
  for (const e of entries) {
    switch (e.k) {
      case 'prompt': {
        const ev: StoryEvent = { id: e.id, at: e.at, actor: 'you', tool: 'Prompt', label: e.text, intent: 'prompt' };
        if (cur && !cur.ended && e.queued) {
          cur.events.push(ev);
        } else {
          cur = {
            id: e.id,
            at: e.at,
            prompt: e.text,
            origin: e.origin,
            partial: false,
            events: [ev],
            ended: false,
            interrupted: false,
          };
          turns.push(cur);
          byId.clear();
        }
        break;
      }
      case 'text':
        ensure(e.at).events.push({
          id: `say-${say++}`,
          at: e.at,
          actor: 'claude',
          tool: 'Text',
          label: e.text,
          intent: 'say',
        });
        break;
      case 'tool': {
        const ev = toolEvent(e, 'claude');
        ensure(e.at).events.push(ev);
        byId.set(e.id, ev);
        break;
      }
      case 'result': {
        const ev = byId.get(e.id);
        if (ev) applyResult(ev, e);
        break;
      }
      case 'end': {
        const t = cur as StoryTurn | null;
        if (t) {
          t.ended = true;
          t.endedAt = e.at;
          if (e.durationMs !== undefined) t.durationMs = e.durationMs;
        }
        break;
      }
      case 'compact':
        ensure(e.at).events.push({
          id: `compact-${say++}`,
          at: e.at,
          actor: 'system',
          tool: 'Compact',
          label: 'Context compacted',
          intent: 'compact',
        });
        break;
      case 'interrupt': {
        const t = ensure(e.at);
        t.events.push({
          id: `stop-${say++}`,
          at: e.at,
          actor: 'you',
          tool: 'Interrupt',
          label: 'You stopped Claude',
          intent: 'interrupt',
        });
        t.interrupted = true;
        t.ended = true;
        t.endedAt = e.at;
        break;
      }
    }
  }
  return turns;
}

const NOT_TOOL_CALLS = new Set<StoryIntent>(['prompt', 'say', 'interrupt', 'compact']);
const countToolCalls = (events: StoryEvent[]) => events.filter((e) => !NOT_TOOL_CALLS.has(e.intent)).length;

export function summarizeTurn(turn: StoryTurn): StoryTurnSummary {
  return {
    id: turn.id,
    at: turn.at,
    prompt: clip(turn.prompt.split('\n')[0] ?? '', 140),
    origin: turn.origin,
    complete: turn.ended && !turn.interrupted,
    interrupted: turn.interrupted,
    toolCalls: countToolCalls(turn.events),
  };
}

// ========== Stage 3: panels ==========

const PANEL_FOR: Record<StoryIntent, StoryPanelKind | null> = {
  prompt: 'mission',
  read: 'investigate',
  search: 'investigate',
  look: 'investigate',
  web: 'research',
  plan: 'plan',
  say: null,
  helper: 'backup',
  message: 'backup',
  edit: 'fix',
  test: 'check',
  build: 'check',
  run: 'run',
  tool: 'run',
  save: 'save',
  ask: 'ask',
  compact: 'compact',
  interrupt: null,
};
/** Kinds whose consecutive events share one panel. A prompt or a question always gets its own. */
const MERGEABLE = new Set<StoryPanelKind>([
  'investigate',
  'research',
  'plan',
  'backup',
  'fix',
  'check',
  'run',
  'save',
  'compact',
]);
/** Kinds that may be folded into a montage when a page has too many panels. */
const MINOR = new Set<StoryPanelKind>(['investigate', 'research', 'plan', 'run', 'compact', 'save', 'montage']);

interface DraftPanel {
  kind: StoryPanelKind;
  events: number[];
  balloon?: { who: 'you' | 'claude'; text: string };
  rounds?: number;
}

/** Keeps the newest outputs, hunks and helper texts within the page budget. */
function applyTextBudget(events: StoryEvent[]): boolean {
  let used = 0;
  let cut = false;
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    const hunkChars = e.edit ? e.edit.hunks.reduce((n, h) => n + h.lines.reduce((m, l) => m + l.length, 0), 0) : 0;
    const size = (e.output?.length ?? 0) + hunkChars + (e.helper?.result?.length ?? 0) + (e.helper?.prompt.length ?? 0);
    if (used + size <= STORY_LIMITS.pageTextBudget) {
      used += size;
      continue;
    }
    if (e.output !== undefined) {
      delete e.output;
      e.outputTruncated = true;
    }
    if (e.edit && e.edit.hunks.length) e.edit = { ...e.edit, hunks: [], truncated: true };
    if (e.helper)
      e.helper = {
        ...e.helper,
        prompt: clip(e.helper.prompt, 200),
        result: e.helper.result ? clip(e.helper.result, 200) : undefined,
      };
    cut = true;
  }
  return cut;
}

function groupPanels(events: StoryEvent[]): { panels: DraftPanel[]; trailingSay?: string } {
  const panels: DraftPanel[] = [];
  let pendingSay: string | undefined;
  events.forEach((ev, idx) => {
    if (ev.intent === 'say') {
      pendingSay ??= firstSentence(ev.label);
      return;
    }
    const kind = PANEL_FOR[ev.intent];
    if (!kind) return;
    const last = panels[panels.length - 1];
    if (last && last.kind === kind && MERGEABLE.has(kind)) {
      last.events.push(idx);
      if (pendingSay && !last.balloon) last.balloon = { who: 'claude', text: pendingSay };
    } else {
      const panel: DraftPanel = { kind, events: [idx] };
      if (kind === 'mission') panel.balloon = { who: 'you', text: clip(ev.label, 220) };
      else if (pendingSay) panel.balloon = { who: 'claude', text: pendingSay };
      panels.push(panel);
    }
    pendingSay = undefined;
  });
  return { panels, trailingSay: pendingSay };
}

/** Fix → check → fix → check (4 panels or more) is one "loop" panel: try, test, repeat. */
function collapseLoops(panels: DraftPanel[]): DraftPanel[] {
  const out: DraftPanel[] = [];
  let i = 0;
  while (i < panels.length) {
    let j = i;
    while (
      j < panels.length &&
      (panels[j].kind === 'fix' || panels[j].kind === 'check') &&
      (j === i || panels[j].kind !== panels[j - 1].kind)
    ) {
      j++;
    }
    const run = panels.slice(i, j);
    if (run.length >= 4) {
      out.push({
        kind: 'loop',
        events: run.flatMap((p) => p.events),
        balloon: run[0].balloon,
        rounds: run.filter((p) => p.kind === 'check').length,
      });
      i = j;
    } else {
      out.push(panels[i]);
      i++;
    }
  }
  return out;
}

/** Folds the smallest neighbouring pair into a montage until the page fits. */
function capPanels(panels: DraftPanel[], max: number): DraftPanel[] {
  const out = [...panels];
  const firstMergeable = out[0]?.kind === 'mission' ? 1 : 0;
  while (out.length > max) {
    let best = -1;
    let bestSize = Infinity;
    for (const strict of [true, false]) {
      for (let k = firstMergeable; k < out.length - 1; k++) {
        const a = out[k];
        const b = out[k + 1];
        const ok = strict
          ? MINOR.has(a.kind) && MINOR.has(b.kind)
          : ![a.kind, b.kind].some((kind) => kind === 'mission' || kind === 'ask');
        const size = a.events.length + b.events.length;
        if (ok && size < bestSize) {
          best = k;
          bestSize = size;
        }
      }
      if (best >= 0) break;
    }
    if (best < 0) break;
    const a = out[best];
    const b = out[best + 1];
    out.splice(best, 2, { kind: 'montage', events: [...a.events, ...b.events], balloon: a.balloon ?? b.balloon });
  }
  return out;
}

function countBy(events: StoryEvent[], key: (e: StoryEvent) => string): string {
  const counts = new Map<string, number>();
  for (const e of events) counts.set(key(e), (counts.get(key(e)) ?? 0) + 1);
  return [...counts].map(([k, n]) => (n > 1 ? `${k} ×${n}` : k)).join(' · ');
}

const shortCommand = (e: StoryEvent) => clip(e.label.split('\n')[0] ?? '', 60);

function montageSummary(evs: StoryEvent[]): string {
  const parts: string[] = [];
  const files = unique(evs.filter((e) => e.intent === 'read' && e.file).map((e) => e.file as string)).length;
  const commands = evs.filter((e) => e.intent === 'run' || e.intent === 'look' || e.intent === 'tool').length;
  if (files) parts.push(`reads ${plural(files, 'file')}`);
  if (commands) parts.push(`runs ${plural(commands, 'command')}`);
  if (evs.some((e) => e.intent === 'plan')) parts.push('updates its plan');
  if (evs.some((e) => e.intent === 'web')) parts.push('checks the web');
  if (evs.some((e) => e.intent === 'edit')) parts.push('changes files');
  if (evs.some((e) => e.intent === 'test' || e.intent === 'build')) parts.push('runs checks');
  return parts.length ? parts.join(', ') : 'a few more steps';
}

function decorate(draft: DraftPanel, events: StoryEvent[], turn: StoryTurn, index: number): StoryPanel {
  const evs = draft.events.map((i) => events[i]);
  const panel: StoryPanel = { kind: draft.kind, events: draft.events, caption: { story: '', director: '' } };
  if (draft.balloon) panel.balloon = draft.balloon;
  const edits = evs.filter((e) => e.edit).map((e) => e.edit as StoryEdit);
  const checks = evs.filter((e) => e.intent === 'test' || e.intent === 'build');
  const lastCheck = checks[checks.length - 1];
  const notesOf = (list: StoryEvent[]) =>
    list
      .map((e) => clip(e.description || shortCommand(e), 80))
      .filter(Boolean)
      .slice(0, 4);
  const tools = countBy(evs, (e) => e.tool);
  let story = '';
  let director = tools;

  switch (draft.kind) {
    case 'mission': {
      const words = evs[0]?.label.split(/\s+/).filter(Boolean).length ?? 0;
      const lines: Record<StoryTurnOrigin, string> = {
        human: 'You give Claude a job.',
        task: 'A background job reports back.',
        peer: 'Another session sends a message.',
        system: 'Something automatic starts this turn.',
      };
      story = index > 0 ? 'You add something while Claude works.' : lines[turn.origin];
      director = `Prompt · ${plural(words, 'word')}${turn.origin === 'human' ? '' : ` · ${turn.origin}`}`;
      break;
    }
    case 'investigate': {
      const files = unique(evs.filter((e) => e.file && e.intent === 'read').map((e) => e.file as string));
      panel.files = files.slice(0, 12);
      panel.notes = evs
        .filter((e) => e.intent !== 'read')
        .map(shortCommand)
        .slice(0, 4);
      story = files.length
        ? `Claude reads ${plural(files.length, 'file')} to find its way around.`
        : evs.every((e) => e.intent === 'search')
          ? 'Claude searches the code.'
          : 'Claude looks around the project.';
      break;
    }
    case 'research':
      panel.notes = evs.map(shortCommand).slice(0, 4);
      story = 'Claude looks things up on the web.';
      break;
    case 'plan': {
      const todos = [...evs].reverse().find((e) => e.todos)?.todos;
      if (todos) panel.todos = todos;
      else panel.notes = evs.map(shortCommand).slice(0, 4);
      story = todos ? `Claude writes a plan: ${plural(todos.length, 'step')}.` : 'Claude thinks it through.';
      if (todos) director = `${tools} · ${todos.filter((t) => t.done).length}/${todos.length} done`;
      break;
    }
    case 'backup': {
      const helpers = draft.events
        .filter((i) => events[i].helper)
        .map((i) => ({
          name: (events[i].helper as StoryHelper).name,
          type: (events[i].helper as StoryHelper).type,
          task: (events[i].helper as StoryHelper).task,
          event: i,
        }));
      panel.helpers = helpers;
      panel.notes = evs
        .filter((e) => e.intent === 'message')
        .map(shortCommand)
        .slice(0, 4);
      story = helpers.length
        ? `Claude calls in ${plural(helpers.length, 'helper')}.`
        : 'Claude sends a message to another session.';
      const inside = evs.reduce((n, e) => n + (e.helper?.toolUses ?? 0), 0);
      director = `${tools}${helpers.length ? ` · ${unique(helpers.map((h) => h.type)).join(' + ')}` : ''}${inside ? ` · ${plural(inside, 'call')} inside` : ''}`;
      break;
    }
    case 'fix':
    case 'loop': {
      // From the calls, not only the results: an edit still running already names its file.
      const files = unique(evs.filter((e) => e.intent === 'edit' && e.file).map((e) => e.file as string));
      panel.files = files.slice(0, 12);
      panel.added = edits.reduce((n, e) => n + e.added, 0);
      panel.removed = edits.reduce((n, e) => n + e.removed, 0);
      if (draft.kind === 'fix') {
        const created = unique(edits.filter((e) => e.created).map((e) => e.file)).length;
        story =
          created && created === files.length
            ? `Claude writes ${plural(created, 'new file')}.`
            : files.length
              ? `Claude changes ${plural(files.length, 'file')}.`
              : 'Claude changes a file.';
        const perFile = files.slice(0, 3).map((f) => {
          const mine = edits.filter((e) => e.file === f);
          return `${basename(f)} ${fmtCounts(
            mine.reduce((n, e) => n + e.added, 0),
            mine.reduce((n, e) => n + e.removed, 0)
          )}`;
        });
        director = `${tools}${perFile.length ? ` · ${perFile.join(' · ')}` : ''}`;
      } else {
        panel.rounds = draft.rounds ?? checks.length;
        if (lastCheck?.ok !== undefined) panel.ok = lastCheck.ok;
        story = `Fix and test, ${plural(panel.rounds, 'round')}.${panel.ok === true ? ' It passes in the end.' : panel.ok === false ? ' Still failing.' : ''}`;
        director = `${plural(checks.length, 'check')} · ${plural(edits.length, 'edit')} · ${fmtCounts(panel.added, panel.removed)} · last: ${
          lastCheck?.ok === undefined ? 'running' : lastCheck.ok ? 'ok' : 'error'
        }`;
      }
      break;
    }
    case 'check': {
      const tests = [...checks].reverse().find((e) => e.tests)?.tests;
      if (tests) panel.tests = tests;
      if (lastCheck?.ok !== undefined) panel.ok = lastCheck.ok;
      panel.notes = notesOf(checks);
      const isTest = checks.some((e) => e.intent === 'test');
      const failedFirst = checks.slice(0, -1).some((e) => e.ok === false);
      if (lastCheck?.ok === undefined) story = isTest ? 'Claude runs the tests.' : 'Claude runs the checks.';
      else if (lastCheck.ok)
        story = failedFirst ? 'It fails at first, then passes.' : isTest ? 'The tests pass.' : 'The checks pass.';
      else
        story = isTest
          ? tests && tests.failed > 1
            ? `${tests.failed} tests fail.`
            : 'A test fails.'
          : 'A check fails.';
      director = checks
        .slice(-3)
        .map((e) => `${shortCommand(e)} → ${e.ok === undefined ? 'running' : e.ok ? 'ok' : 'error'}`)
        .join(' · ');
      if (tests) director += ` · ${tests.passed} passed${tests.failed ? `, ${tests.failed} failed` : ''}`;
      break;
    }
    case 'run':
      panel.notes = notesOf(evs);
      story = evs.every((e) => e.tool !== 'Bash') ? 'Claude uses a tool.' : 'Claude works in the terminal.';
      director = `${tools} · ${shortCommand(evs[0])}`;
      break;
    case 'save': {
      panel.notes = notesOf(evs);
      const labels = evs.map((e) => e.label).join('\n');
      story = /\bgh pr create\b/.test(labels)
        ? 'Claude opens a pull request.'
        : /\bgit push\b/.test(labels)
          ? 'Claude saves the work and sends it up.'
          : 'Claude saves the work.';
      director = evs.map(shortCommand).slice(0, 2).join(' · ');
      break;
    }
    case 'ask': {
      const q = evs[0]?.question;
      if (q) panel.question = { text: q.text, answer: q.answer };
      const plan = evs[0]?.tool === 'ExitPlanMode';
      story = plan
        ? 'Claude shows you its plan and waits for your OK.'
        : q?.answer
          ? 'Claude asks you, and you answer.'
          : 'Claude asks you something.';
      director = `${tools}${q?.answer ? ` · answer: ${clip(q.answer, 60)}` : ''}`;
      break;
    }
    case 'compact':
      story = 'Claude packs up its notes to free memory.';
      director = 'compact_boundary';
      break;
    case 'montage':
      panel.notes = notesOf(evs.filter((e) => e.tool === 'Bash'));
      story = `Claude keeps going: ${montageSummary(evs)}.`;
      break;
    case 'complete':
      break;
  }
  panel.caption = { story, director };
  return panel;
}

function completePanel(turn: StoryTurn, page: Omit<StoryPage, 'panels'>, trailingSay?: string): StoryPanel {
  const story = turn.interrupted
    ? 'You stop Claude here.'
    : turn.durationMs !== undefined
      ? `Done in ${roughDuration(turn.durationMs)}.`
      : 'Done.';
  const director = [
    turn.interrupted ? 'interrupted' : 'turn_duration',
    turn.durationMs !== undefined ? exactDuration(turn.durationMs) : '',
    plural(page.toolCalls, 'tool call'),
    page.filesChanged ? plural(page.filesChanged, 'file') + ' changed' : '',
    page.helpers ? plural(page.helpers, 'helper') : '',
  ]
    .filter(Boolean)
    .join(' · ');
  const panel: StoryPanel = { kind: 'complete', events: [], caption: { story, director } };
  if (trailingSay) panel.balloon = { who: 'claude', text: trailingSay };
  if (page.filesChanged) {
    panel.added = page.added;
    panel.removed = page.removed;
  }
  return panel;
}

/** One turn as one comic page. Pure: the same turn always draws the same page. */
export function buildStoryPage(turn: StoryTurn): StoryPage {
  let events = turn.events.map((e) => ({ ...e }));
  let truncated = false;
  if (events.length > STORY_LIMITS.eventsPerPage) {
    const head = events[0]?.intent === 'prompt' ? [events[0]] : [];
    events = [...head, ...events.slice(-(STORY_LIMITS.eventsPerPage - head.length))];
    truncated = true;
  }
  if (applyTextBudget(events)) truncated = true;

  const { panels: grouped, trailingSay } = groupPanels(events);
  const room = STORY_LIMITS.panelsPerPage - (turn.ended ? 1 : 0);
  const drafts = capPanels(collapseLoops(grouped), room);
  const panels = drafts.map((d, i) => decorate(d, events, turn, i));

  const edits = events.filter((e) => e.edit).map((e) => e.edit as StoryEdit);
  const base: Omit<StoryPage, 'panels'> = {
    ...summarizeTurn({ ...turn, events }),
    partial: turn.partial,
    truncated,
    events,
    filesChanged: unique(edits.map((e) => e.file)).length,
    added: edits.reduce((n, e) => n + e.added, 0),
    removed: edits.reduce((n, e) => n + e.removed, 0),
    helpers: events.filter((e) => e.helper).length,
  };
  if (turn.endedAt) base.endedAt = turn.endedAt;
  if (turn.durationMs !== undefined) base.durationMs = turn.durationMs;
  if (turn.ended) {
    panels.push(completePanel(turn, base, trailingSay));
  } else if (panels.length) {
    const last = panels[panels.length - 1];
    last.live = true;
    if (trailingSay && !last.balloon) last.balloon = { who: 'claude', text: trailingSay };
  }
  return { ...base, panels };
}

/**
 * A helper's own transcript as one page. Its first prompt is the job Claude gave it; a later prompt
 * (Claude messaging it again) continues the same page. `finished` comes from the helper's metadata,
 * since a helper's transcript has no `turn_duration` of its own.
 */
export function buildHelperPage(turns: StoryTurn[], finished?: boolean): StoryPage | null {
  if (!turns.length) return null;
  const first = turns[0];
  const last = turns[turns.length - 1];
  return buildStoryPage({
    ...first,
    events: turns.flatMap((t) => t.events),
    ended: finished ?? last.ended,
    interrupted: false,
    endedAt: last.endedAt,
    durationMs: undefined,
  });
}

/** The turn list for the page picker, newest last, capped. */
export function summarizeTurns(turns: StoryTurn[]): StoryTurnSummary[] {
  return turns.slice(-STORY_LIMITS.turnsListed).map(summarizeTurn);
}
