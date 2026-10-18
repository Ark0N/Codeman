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
 *    (`classifyBashCommand`), not by its tool name. Across all 1,309 local transcripts (3,856
 *    turns, 44,008 tool calls) it is 87%, and 91% of those calls carry a `description`.
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
  promptChars: 4000,
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
  /**
   * Characters of output, hunk and helper text per page; older events give theirs up first. Sized on
   * 3,855 local turns: 94% never reach it, and the longest live page went from 157 KB to 74 KB
   * gzipped (it is refetched every few seconds while it changes).
   */
  pageTextBudget: 120_000,
  turnsListed: 60,
});

// ========== Entries (stage 1 output) ==========

interface ReducedInput {
  command?: string;
  /** A Bash call's intent, judged on the whole command before `command` is clipped for display. */
  intent?: StoryIntent;
  /** Files a Bash call prints (`cat`, `head`, `tail`), from the whole command. */
  reads?: string[];
  /** A save that ships: `gh pr create` opens a pull request, `git push` sends the work up. */
  ships?: 'pr' | 'push';
  /** The segment of a Bash one-liner that decided its intent. */
  headline?: string;
  /** How many commits the command makes (`git commit` segments), when any. */
  commits?: number;
  /** The first commit's message, when the command spells it out. */
  subject?: string;
  /** Files a Bash call writes through here-documents. */
  writes?: StoryEdit[];
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
  | {
      k: 'prompt';
      id: string;
      at: string;
      text: string;
      origin: StoryTurnOrigin;
      queued: boolean;
      /** A slash command (`/compact`), not a prompt to Claude. */
      slash?: boolean;
      /** Claude Code's id for the prompt; one prompt can be written more than once (typed, then as a command). */
      promptId?: string;
      /** A background task reporting back: which call it answers, and how it went. */
      task?: StoryTaskReport;
      /** Teammates (helpers started as a team) reporting back, matched to their helper by name. */
      teammates?: StoryTeammateReport[];
    }
  | { k: 'text'; at: string; text: string; keyPoints?: string[] }
  | { k: 'tool'; at: string; id: string; name: string; input: ReducedInput }
  | {
      k: 'result';
      at: string;
      id: string;
      isError: boolean;
      output?: string;
      outputTruncated?: boolean;
      edit?: StoryEdit;
      helper?: { result?: string; toolUses?: number; durationMs?: number; agentId?: string; background?: boolean };
      answer?: string;
      tests?: StoryTests;
      /** A check whose output reports problems (lint, format, types). */
      problems?: boolean;
      /** The plan an ExitPlanMode call presented. */
      plan?: string;
      /** Files Claude Code says a Bash call changed ("This command modified 1 file you've previously read: a.py"). */
      modified?: string[];
      /** A Bash call sent to the background: its result only says it started. */
      background?: boolean;
    }
  | { k: 'end'; at: string; durationMs?: number }
  | { k: 'compact'; at: string; trigger?: string; preTokens?: number; postTokens?: number; durationMs?: number }
  /** What a local slash command printed (`<local-command-stdout>`): its whole answer. */
  | { k: 'local'; at: string; text: string }
  | { k: 'interrupt'; at: string };

/** What a `<task-notification>` says about the background call it answers. */
interface StoryTaskReport {
  toolUseId?: string;
  status?: string;
  result?: string;
  toolUses?: number;
  durationMs?: number;
}

/** One `<teammate-message>`: a helper started as a teammate, reporting back by name. */
interface StoryTeammateReport {
  from: string;
  summary?: string;
  result?: string;
}

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

/**
 * Markdown to plain text: only real markdown goes, paired emphasis and line-start markers. A bare `_`
 * or `*` inside a word stays, or `test_wcount.py` would read `testwcount.py`. Code spans come back
 * as placeholders (`\u0000<n>\u0000`, their text in `spans`) so nothing inside one is read as
 * markdown or as the end of a sentence.
 */
function plainMarkdown(text: string, spans: string[]): string {
  return (
    text
      .replace(/```[\s\S]*?```/g, ' ')
      .replace(/`([^`\n]*)`/g, (_, code: string) => `\u0000${spans.push(code) - 1}\u0000`)
      .replace(/!?\[([^\]\n]*)\]\([^)\n]*\)/g, '$1')
      .replace(/(^|[\s(])(\*\*|__)(?=\S)([^\n]*?\S)\2(?=[\s),!?:;]|\.(?:\s|$)|$)/g, '$1$3')
      .replace(/(^|[\s(])([*_])(?=\S)([^*_\n]*?\S)\2(?=[\s),!?:;]|\.(?:\s|$)|$)/g, '$1$3')
      // A heading ends at its line. A short one (`## Summary`) is a label and goes; a longer one
      // (`# Plan: add wrap to mathx.py`) is a sentence of its own.
      .replace(/^[ \t]{0,3}#{1,6}[ \t]+(.*?)[ \t]*$/gm, (_, h: string) =>
        h.split(/\s+/).length <= 3 ? '' : /[.!?:]$/.test(h) ? h : `${h}.`
      )
      .replace(/^[ \t]{0,3}(>|[-*+]|\d+[.)])[ \t]+/gm, '')
  );
}

const restoreSpans = (text: string, spans: string[]): string =>
  // NUL marks a kept span: no text Claude writes contains one.
  // eslint-disable-next-line no-control-regex
  text.replace(/\u0000(\d+)\u0000/g, (_, n: string) => spans[Number(n)] ?? '');

/**
 * Where a sentence ends: `.`, `!` or `?` before a space or the end, but not inside an ellipsis
 * (`...`) and not after `e.g` or `i.e`.
 */
const SENTENCE_END = /^(.+?(?<!\.)(?<!\b(?:e\.g|i\.e|vs|cf))[.!?](?!\.))(?=\s|$)/;

/** The first two sentences of a message, without markdown (the second may be empty). */
function firstTwoSentences(text: string): [string, string] {
  const spans: string[] = [];
  const plain = plainMarkdown(text, spans).replace(/\s+/g, ' ').trim();
  const one = SENTENCE_END.exec(plain);
  if (!one) return [restoreSpans(plain, spans), ''];
  const rest = plain.slice(one[1].length).trim();
  const two = SENTENCE_END.exec(rest);
  return [restoreSpans(one[1], spans), two ? restoreSpans(two[1], spans) : ''];
}

/** A sentence that reports a problem: its next sentence (usually the fix) belongs with it. */
const REPORTS_PROBLEM = /\b(left|stray|broke|broken|fail(s|ed)?|error|missing|wrong|bug|oops|mistake|forgot)\b/i;
/** A sentence that carries a caveat a reader must not lose. */
const CAVEAT =
  /^(but|however|note|nothing|no\b|none|one (caveat|gap|thing)|heads up|caveat|warning|i (didn't|did not|couldn't|could not|haven't|have not|wasn't|left)|it (isn't|is not|wasn't|was not)|this (isn't|is not)|the (only|one) )/i;

/** What a speech balloon says: the first sentence, and the next when the first reports a problem. */
export function balloonText(text: string): string {
  const [one, two] = firstTwoSentences(text);
  return clip(two && REPORTS_PROBLEM.test(one) && two.length <= 140 ? `${one} ${two}` : one, 260);
}

/**
 * A sentence a reader of Claude's last words must not lose. STRONG: an open problem or quirk,
 * something not yet done, checked or confirmed, work still out, a word on what you asked for or
 * expected, a correction of an earlier warning. WEAK: a bare negation ("I didn't push"), kept only when
 * nothing strong is there.
 */
/** The open-problem part of a key point: something wrong, not done, not checked, or still out. */
const OPEN_PROBLEM = new RegExp(
  String.raw`\b(problem|known (issue|quirk)s?|quirks?|caveat|limitation|heads up|warning|not yet|haven't|have not|never|unfixed|left (open|unfixed|out)|still (fails?|failing|broken|missing|open|running|working)|must be (served|run)|(won't|doesn't|does not|will not) (work|fix)|(isn't|is not|not) fixed|can't tell|isn't (confirmed|committed|pushed|tested|done|checked)|not (checked|tested|verified|confirmed|committed|pushed|opened))\b`,
  'i'
);
const KEY_POINT_STRONG = new RegExp(
  [
    OPEN_PROBLEM.source,
    String.raw`\b(as you (asked|expected|said|wanted|suggested)|you asked|your (--?[\w-]+|request|option|flag|change))\b`,
    String.raw`\b(out of date|looked too early|turned out|was wrong)\b`,
  ].join('|'),
  'i'
);
const KEY_POINT_WEAK = /\b(didn't|did not|couldn't|could not|wasn't able|won't|doesn't)\b/i;

/**
 * Sentences from further into a long message that carry a key point, at most two strong ones (or one
 * weak one when none is strong), in order. Read on the whole message (the event's label is clipped),
 * its first 8,000 characters. Table rows, list intros ending in `:` and questions are skipped: none of
 * them reads on its own in a balloon.
 */
function keyPointsOf(text: string): string[] {
  if (text.length <= 160) return [];
  const spans: string[] = [];
  const plain = plainMarkdown(text.slice(0, 8000), spans);
  const strong: string[] = [];
  let weak: string | undefined;
  let first = true;
  let previous = '';
  for (const line of plain.split('\n')) {
    if (strong.length >= 2) break;
    const trimmed = line.trim();
    if (trimmed.startsWith('|') || (trimmed.match(/\|/g)?.length ?? 0) >= 2) continue; // a table row
    let rest = trimmed.replace(/\s+/g, ' ');
    while (rest && strong.length < 2) {
      const m = SENTENCE_END.exec(rest);
      const sentence = (m ? m[1] : rest).trim();
      rest = m ? rest.slice(m[1].length).trim() : '';
      // The first sentence is the balloon's anyway.
      if (first) {
        first = false;
        continue;
      }
      const before = previous;
      previous = sentence;
      if (sentence.length < 12 || /[:?]$/.test(sentence)) continue;
      // "That's out of date" needs what "that" was: the sentence before comes along.
      const context = /^(that|this|it)\b/i.test(sentence) && before && !strong.includes(before) ? `${before} ` : '';
      const shown = clip(restoreSpans(context + sentence, spans), context ? 300 : 180);
      if (KEY_POINT_STRONG.test(sentence)) strong.push(shown);
      else if (!weak && KEY_POINT_WEAK.test(sentence)) weak = shown;
    }
  }
  return strong.length ? strong : weak ? [weak] : [];
}

/**
 * Claude's last words: the first sentence, the next when it carries a caveat, and the key points from
 * further in (an open problem, what was or was not done), so the final panel never reads as a clean
 * finish when Claude said otherwise.
 */
export function closingText(text: string, keyPoints: string[] = []): string {
  const [one, two] = firstTwoSentences(text);
  // A very short first sentence ("Not done.") says too little alone.
  const parts = [one];
  if (two && (CAVEAT.test(two) || one.length < 24) && two.length <= 200) parts.push(two);
  for (const point of keyPoints) if (!parts.some((p) => p.includes(point) || point.includes(p))) parts.push(point);
  return clip(parts.join(' '), parts.length > 2 ? 420 : 300);
}

/** The first sentence of a message, without markdown, for a speech balloon. */
export function firstSentence(text: string, max = 160): string {
  const spans: string[] = [];
  // Only the start can hold the first sentence; the rest (a helper's whole report) is never scanned.
  const plain = plainMarkdown(text.slice(0, 4000), spans).replace(/\s+/g, ' ').trim();
  const match = SENTENCE_END.exec(plain);
  return clip(restoreSpans(match ? match[1] : plain, spans).replace(/\s+/g, ' '), max);
}

/**
 * A plan Claude wrote as text (no plan tool): three numbered items or more, or two checkboxes or
 * more. Plain bullets never count; a summary at the end of a turn is usually a bullet list.
 */
export function planFromText(text: string): StoryTodo[] | null {
  const items: StoryTodo[] = [];
  let numbered = 0;
  let boxes = 0;
  for (const line of text.slice(0, 20_000).split('\n')) {
    const m = /^\s{0,3}(?:(\d+)[.)]|[-*+])\s+(\[[ xX]\]\s+)?(\S.*)$/.exec(line);
    if (!m || (!m[1] && !m[2])) continue;
    if (m[2]) boxes++;
    else numbered++;
    const spans: string[] = [];
    const plain = restoreSpans(plainMarkdown(m[3].slice(0, 400), spans), spans)
      .replace(/\s+/g, ' ')
      .trim();
    if (plain) items.push({ text: clip(plain, 120), done: /x/i.test(m[2] ?? '') });
  }
  return numbered >= 3 || boxes >= 2 ? items.slice(0, STORY_LIMITS.todoItems) : null;
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
  return `${Math.floor(m / 60)} h ${m % 60} min ${s % 60} s`;
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
  // Shell structure is not a command: `for x in a b`, `done`, `fi`; `do`/`then`/`if` only wrap one.
  if (/^(for\s+\w+(\s+in\b.*)?|done|fi|esac|else|[{}])\s*$/.test(s)) return '';
  if (/^command\s+-[vV]\b/.test(s)) return 'which';
  for (let k = 0; k < 6; k++) {
    const next = s
      .replace(/^(do|then|else|if|elif|while|until|!)\s+/, '')
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
/** Editors that change files in place. `tee` is not one: in a pipeline it keeps a log. */
const EDIT_HEAD = /^(sed (-i|--in-place)\b|perl -p?i\b|patch\b|git apply\b)/;
/** Where a redirect writes scratch, not the project: temp dirs, devices, and paths held in variables. */
const SCRATCH_TARGET = /^(\/tmp\/|\/var\/tmp\/|\/dev\/|\$|~\/\.cache\/)/;
const LOOK_HEAD =
  /^(cd|cat|head|tail|sed -n|grep|egrep|rg|find|ls|wc|awk|jq|tree|stat|file|du|df|diff|less|more|xxd|od|which|type|pwd|echo|printf|sort|uniq|cut|basename|dirname|realpath|readlink|git (status|diff|log|show|branch|blame|ls-files|rev-parse|remote|config (--get|-l|--list))|gh (pr|issue|run|api) (view|list|diff|checks))\b/;
/** A probe that asks a tool about itself without running anything: `pytest --version`, `npm test --help`. */
const PROBE = /\s--(version|help|collect-only)\b|\s-[Vh]\s*$/;

/**
 * Whether a segment writes a project file through a redirect (`> notes.md`, `>> app.log`, `cat > a.py`).
 * Quote-aware: a `>` inside a quoted string is text. A redirect into scratch (`/tmp/x`, `"$S/out.txt"`,
 * `/dev/null`) or onto a stream (`2>&1`) is not an edit, and the target must look like a file.
 */
function redirectsIntoProject(segment: string): boolean {
  let quote = '';
  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i];
    if (quote) {
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (ch !== '>') continue;
    const before = segment[i - 1] ?? ' ';
    if (/[0-9&>]/.test(before) && before !== ' ') continue; // `2>`, `&>`, the second `>` of `>>`
    let j = i + 1;
    if (segment[j] === '>') j++;
    if (segment[j] === '&' || segment[j] === '(') continue; // `>&2`, `>(process)`
    while (segment[j] === ' ' || segment[j] === '\t') j++;
    const q = segment[j] === '"' || segment[j] === "'" ? segment[j++] : '';
    let target = '';
    while (j < segment.length && (q ? segment[j] !== q : !/[\s|;&<>()]/.test(segment[j]))) target += segment[j++];
    if (target && !SCRATCH_TARGET.test(target) && /^[\w./~@+-]*\.\w+$/.test(target)) return true;
    i = j;
  }
  return false;
}

/**
 * One-line writes: `printf 'a\nb\n' > f`, `echo "x" >> f`. The quoted text is the content (printf
 * and `echo -e` turn `\n` into line breaks). Same target rules as here-documents.
 */
function echoWrites(command: string, cwd?: string): StoryEdit[] {
  const out: StoryEdit[] = [];
  let moved = false;
  for (const segment of commandSegments(withoutHeredocBodies(command.slice(0, 20_000)))) {
    const head = segmentHead(segment);
    if (/^(cd|pushd)\b/.test(head)) moved = true;
    const m =
      /^(printf|echo)((?:\s+-[neE]+)*)\s+(['"])((?:(?!\3)[\s\S])*)\3\s*(>>?)\s*(["']?)([^\s"'|;&<>()]+)\6\s*$/.exec(
        head
      );
    if (!m || SCRATCH_TARGET.test(m[7])) continue;
    const escapes = m[1] === 'printf' || /e/.test(m[2]);
    const text = escapes ? m[4].replace(/\\n/g, '\n').replace(/\\t/g, '\t') : m[4];
    const lines = text.replace(/\n$/, '').split('\n');
    const file =
      m[7].startsWith('/') || !cwd || moved ? m[7] : `${cwd.replace(/\/+$/, '')}/${m[7].replace(/^\.\//, '')}`;
    out.push({
      file,
      added: lines.length,
      removed: 0,
      created: false,
      hunks: [
        {
          oldStart: 0,
          oldLines: 0,
          newStart: m[5] === '>>' ? 0 : 1,
          newLines: lines.length,
          lines: lines.slice(0, 40).map((l) => `+${clip(l, STORY_LIMITS.lineChars)}`),
          ...(m[5] === '>>' ? { atEnd: true } : {}),
        },
      ],
      truncated: lines.length > 40,
    });
    if (out.length >= 6) break;
  }
  return out;
}

/**
 * The first commit's message in a command: `-m "..."` / `-m '...'`, or the first line of the
 * here-document a `git commit -F -` reads.
 */
function commitSubject(command: string): string | undefined {
  // Line by line with plain searches, never one regex over the command: a command is agent-written,
  // and `[^;]*commit[^;]*?-m` over many `git commit` tokens backtracks (seconds on a long one-liner).
  const lines = command.slice(0, 8000).split('\n');
  for (let i = 0; i < lines.length && i < 400; i++) {
    const line = lines[i];
    const g = line.search(/\bgit\b/);
    if (g < 0) continue;
    const c = line.slice(g).search(/\bcommit\b/);
    if (c < 0) continue;
    const rest = line.slice(g + c + 'commit'.length);
    // Its own options only: the part before the next `;`, `&` or `|`.
    const stop = rest.search(/[;&|]/);
    const end = stop < 0 ? rest.length : stop;
    // `-m`, a combined `-am` / `-qm`, or `--message`; a trailer (`Co-Authored-By:`) is never the subject.
    const m = /\s-(?:[a-zA-Z]{0,8}m|-message=?)\s*(["'])/.exec(rest);
    if (m && m.index < end) {
      const from = m.index + m[0].length;
      const close = rest.indexOf(m[1], from);
      const first = (close < 0 ? rest.slice(from) : rest.slice(from, close)).trim();
      if (first && !/^[\w-]+-By:/i.test(first)) return clip(first, 100);
      continue;
    }
    // `git commit -F - <<'EOF'`: the here-document's first line.
    const f = /\s-F\s*-(?=\s|$)/.exec(rest);
    const h = /<<-?\s*(['"]?)(\w+)\1/.exec(rest);
    if (f && f.index < end && h) {
      const body = lines[i + 1]?.trim();
      if (body && body !== h[2]) return clip(body, 100);
    }
  }
  return undefined;
}

/** A here-document's body is data, not commands: `cat > a.py <<'EOF' ... EOF` keeps only its first line. */
function withoutHeredocBodies(command: string): string {
  const out: string[] = [];
  let end: string | null = null;
  for (const line of command.split('\n')) {
    if (end !== null) {
      if (line.trim() === end) end = null;
      continue;
    }
    out.push(line);
    const m = /<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/.exec(line.replace(/<<</g, '   '));
    if (m) end = m[2];
  }
  return out.join('\n');
}

/**
 * Files a command prints with `cat`, `head` or `tail`, as named (maybe relative). Nothing when the
 * command changes directory first (a relative name would point elsewhere) or names a glob or a variable.
 */
export function printedFiles(command: string): string[] {
  const files: string[] = [];
  for (const segment of commandSegments(withoutHeredocBodies(command.slice(0, 2000)))) {
    const head = segmentHead(segment);
    if (/^(cd|pushd)\b/.test(head)) return [];
    // `sed -n '5,25p' README.md` prints part of a file, like head and tail.
    const sed = /^sed\s+-n\s+(['"]?)[0-9,$]+p\1\s+(.+)$/.exec(head);
    const m = sed ? [head, 'sed', sed[2]] : /^(cat|head|tail|nl|bat)\s+(.*)$/.exec(head);
    if (!m || /[<>]/.test(m[2])) continue;
    const words = m[2].match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
    for (let k = 0; k < words.length; k++) {
      const w = words[k];
      if (w.startsWith('-')) {
        if (/^-[nc]$/.test(w)) k++; // `head -n 20 file`
        continue;
      }
      const name = w.replace(/^(["'])(.*)\1$/, '$2');
      if (!name || /[*?$`{}[\]]/.test(name) || /^\d+$/.test(name)) continue;
      files.push(name);
    }
  }
  return unique(files).slice(0, 8);
}

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
  return judgeBashCommand(command).intent;
}

/** The intent of a Bash command and the segment that decided it. */
function judgeBashCommand(command: string): { intent: StoryIntent; segment: string } {
  let best = INTENT_RANK.length - 1;
  let deciding = '';
  for (const segment of commandSegments(withoutHeredocBodies(command.slice(0, 4000)))) {
    const head = segmentHead(segment);
    if (!head) continue;
    const intent: StoryIntent = PROBE.test(head)
      ? 'look'
      : TEST_HEAD.test(head)
        ? 'test'
        : BUILD_HEAD.test(head)
          ? 'build'
          : SAVE_HEAD.test(head)
            ? 'save'
            : EDIT_HEAD.test(head) || redirectsIntoProject(head)
              ? 'edit'
              : LOOK_HEAD.test(head)
                ? 'look'
                : 'run';
    const rank = INTENT_RANK.indexOf(intent);
    if (rank < best || !deciding) {
      best = Math.min(best, rank);
      deciding = segment.trim();
    }
  }
  return { intent: INTENT_RANK[best], segment: deciding };
}

/**
 * Files a command writes through here-documents: `cat > f <<'EOF'`, `cat <<EOF > f`, `tee f <<EOF`
 * (and `>>` / `tee -a`, appends). Each becomes a whole-file edit of the body's lines. A relative
 * target resolves against the transcript line's `cwd` unless the command changed directory first;
 * scratch targets (`/tmp/x`, `"$S/x"`) are not project files. A script fed to python or node
 * (`python3 - <<EOF`) is read for the files it opens for writing; those are edits without lines,
 * since what the script changed is not in the command.
 */
export function heredocWrites(command: string, cwd?: string): StoryEdit[] {
  const out: StoryEdit[] = [...echoWrites(command, cwd)];
  const lines = command.slice(0, 200_000).split('\n');
  let moved = false;
  for (let i = 0; i < lines.length && out.length < 6; i++) {
    const line = lines[i];
    if (/(^|[;&|(]\s*)(cd|pushd)\s/.test(line.split('<<')[0])) moved = true;
    const m = /<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/.exec(line.replace(/<<</g, '   '));
    if (!m) continue;
    const body: string[] = [];
    let j = i + 1;
    while (j < lines.length && lines[j].trim() !== m[2]) body.push(lines[j++]);
    i = j;
    const before = line.slice(0, m.index);
    const after = line.slice(m.index + m[0].length);
    const redirect = /(?:^|[^>&0-9])(>>?)\s*(["']?)([^\s"'|;&<>()]+)\2/;
    let target: string | undefined;
    let append = false;
    if (/\bcat\s*(>|$|\s)/.test(before)) {
      const r = redirect.exec(before) ?? redirect.exec(after);
      if (r) {
        target = r[3];
        append = r[1] === '>>';
      }
    } else {
      const tee = /\btee\s+(-a\s+)?(["']?)([^\s"'|;&<>()]+)\2/.exec(before);
      if (tee) {
        target = tee[3];
        append = !!tee[1];
      }
    }
    if (!target && /\b(python3?|node)\b/.test(before)) {
      for (const written of scriptWrites(body)) {
        if (SCRATCH_TARGET.test(written) || out.some((d) => d.file.endsWith(written))) continue;
        const file =
          written.startsWith('/') || !cwd || moved
            ? written
            : `${cwd.replace(/\/+$/, '')}/${written.replace(/^\.\//, '')}`;
        out.push({ file, added: 0, removed: 0, created: false, hunks: [], truncated: true });
        if (out.length >= 6) break;
      }
      continue;
    }
    if (!target || SCRATCH_TARGET.test(target)) continue;
    const file =
      target.startsWith('/') || !cwd || moved ? target : `${cwd.replace(/\/+$/, '')}/${target.replace(/^\.\//, '')}`;
    const kept = body
      .slice(0, STORY_LIMITS.hunkLines)
      .map((l) => (l.length >= STORY_LIMITS.lineChars ? `+${l.slice(0, STORY_LIMITS.lineChars - 2)}…` : `+${l}`));
    out.push({
      file,
      added: body.length,
      removed: 0,
      created: false,
      hunks: [
        append
          ? { oldStart: 0, oldLines: 0, newStart: 0, newLines: body.length, lines: kept, atEnd: true }
          : { oldStart: 0, oldLines: 0, newStart: 1, newLines: body.length, lines: kept },
      ],
      truncated: kept.length < body.length,
    });
  }
  return out;
}

/**
 * Files a python or node script opens for writing: `open('a.py', 'w')`, `open(p, "w")` after
 * `p = "a.py"`, `Path('a.py').write_text(...)`, `fs.writeFileSync('a.js', ...)`. Only string literals
 * and names bound to one; anything computed is left out rather than guessed.
 */
function scriptWrites(body: string[]): string[] {
  const names = new Map<string, string>();
  for (const line of body) {
    const m = /^\s*(?:(?:const|let|var)\s+)?([A-Za-z_]\w*)\s*=\s*(?:Path\(\s*)?(['"])([^'"\n]+)\2\s*\)?\s*;?\s*$/.exec(
      line
    );
    if (m) names.set(m[1], m[3]);
  }
  const target = (lit: string | undefined, name: string | undefined) => lit ?? (name ? names.get(name) : undefined);
  const found: Array<{ at: number; file: string }> = [];
  const text = body.join('\n');
  const patterns = [
    // open(target, 'w') / open(target, mode="a+")
    /\bopen\(\s*(?:(['"])([^'"\n]+)\1|([A-Za-z_]\w*))\s*,\s*(?:mode\s*=\s*)?(['"])([rwaxbt+]*)\4/g,
    // Path(target).write_text( / name.write_text(
    /(?:\bPath\(\s*(?:(['"])([^'"\n]+)\1|([A-Za-z_]\w*))\s*\)|\b([A-Za-z_]\w*))\.write_(?:text|bytes)\(/g,
    // fs.writeFileSync(target / appendFileSync(target
    /\b(?:write|append)File(?:Sync)?\(\s*(?:(['"])([^'"\n]+)\1|([A-Za-z_]\w*))/g,
  ];
  for (const [k, re] of patterns.entries()) {
    for (const m of text.matchAll(re)) {
      if (k === 0 && !/[wax+]/.test(m[5])) continue;
      const file = k === 1 ? target(m[2], m[3] ?? m[4]) : target(m[2], m[3]);
      if (file && !/[*?$`{}]/.test(file)) found.push({ at: m.index ?? 0, file });
    }
  }
  // In the order the script writes them.
  return unique(found.sort((x, y) => x.at - y.at).map((f) => f.file)).slice(0, 6);
}

/**
 * Whether a linter, formatter or type checker reported problems (`Found 3 errors.`, `1 file would be
 * reformatted`, `✖ 5 problems`, `error TS2322:`). Read when a trailing command (`; ls`) hid the exit code.
 */
export function reportsProblems(output: string): boolean {
  // The last verdict wins: a formatter's "1 file would be reformatted" preview, then "1 file
  // reformatted" and a clean check, is clean.
  const last = (patterns: RegExp[]) =>
    Math.max(-1, ...patterns.map((re) => [...output.matchAll(new RegExp(re.source, 'gm'))].pop()?.index ?? -1));
  const problem = last([
    /\bFound [1-9]\d* errors?\b/,
    /\b[1-9]\d* files? would be reformatted\b/,
    /^would reformat /,
    /✖ [1-9]\d* problems?\b/,
    /\[warn\] Code style issues found/,
    /\berror TS\d+:/,
  ]);
  if (problem < 0) return false;
  const clean = last([
    /\bAll checks passed!/,
    /\bFound 0 errors\b/,
    /^(?!.*would be).*\b\d+ files? reformatted\b/,
    /^(?!.*would be).*\b\d+ files? (left unchanged|already formatted)\b/,
  ]);
  return problem > clean;
}

/**
 * Passed/failed counts from a test runner's summary line (vitest, jest, pytest, mocha, cargo...).
 * Scans the last lines only; returns null when no summary is recognisable.
 */
export function parseTestCounts(output: string): StoryTests | null {
  // The newest summary wins; a long output is searched from its end (the last 2,000 lines).
  const lines = output.split('\n').slice(-2000).reverse();
  // node:test (TAP `# pass 7` / spec reporter `ℹ pass 7`), with its own fail line.
  const nodePass = lines.map((l) => /^\s*[#ℹ]\s*pass\s+(\d+)\s*$/.exec(l)).find(Boolean);
  if (nodePass) {
    const nodeFail = lines.map((l) => /^\s*[#ℹ]\s*fail\s+(\d+)\s*$/.exec(l)).find(Boolean);
    return { passed: Number(nodePass[1]), failed: nodeFail ? Number(nodeFail[1]) : 0 };
  }
  // Errors (pytest's collection errors) are counted apart: the run failed although no test did.
  const errorsOn = (line: string) => Number(/\b(\d+) errors?\b/i.exec(line)?.[1] ?? 0);
  const counts = (passed: number, failed: number, errors: number): StoryTests =>
    errors ? { passed, failed, errors } : { passed, failed };
  for (const line of lines) {
    const passed = /\b(\d+) (passed|passing)\b/i.exec(line);
    if (!passed) continue;
    const failedSameLine = /\b(\d+) (failed|failing)\b/i.exec(line);
    let failed = failedSameLine ? Number(failedSameLine[1]) : 0;
    if (!failedSameLine) {
      const failing = lines.map((l) => /^\s*(\d+) failing\b/i.exec(l)).find(Boolean);
      if (failing) failed = Number(failing[1]);
    }
    return counts(Number(passed[1]), failed, errorsOn(line));
  }
  // Nothing passed: a summary line that only counts failures (`=== 3 failed in 0.12s ===`,
  // `Tests  3 failed (3)`, `1 error in 0.05s`).
  for (const line of lines) {
    if (!/^\s*(=+ |Tests?:?\s|test result:)|\bin [\d.]+m?s\b/.test(line)) continue;
    const failed = Number(/\b(\d+) (failed|failing)\b/i.exec(line)?.[1] ?? 0);
    if (failed || errorsOn(line)) return counts(0, failed, errorsOn(line));
  }
  return null;
}

// ========== Stage 1: reduce one transcript line ==========

/*
 * Tagged blocks in prompt text are found with indexOf, never a lazy `<a>[\s\S]*?</a>` regex: that
 * one rescans to the end for every opener without a closer (seconds on a crafted megabyte, and a
 * teammate's or a helper's message is another agent's writing).
 */
/** The text with every `<open>…<close>` block taken out; an opener never closed stays. */
function withoutBlocks(text: string, open: string, close: string): string {
  let out = '';
  let from = 0;
  for (;;) {
    const at = text.indexOf(open, from);
    if (at < 0) break;
    const end = text.indexOf(close, at + open.length);
    if (end < 0) break;
    out += text.slice(from, at);
    from = end + close.length;
  }
  return out + text.slice(from);
}

/** `<name attrs>inner</name>` blocks in order (`name` followed by a space or `>`), at most `limit`. */
function blocks(text: string, name: string, limit = 50): Array<{ attrs: string; inner: string }> {
  const out: Array<{ attrs: string; inner: string }> = [];
  const open = `<${name}`;
  const close = `</${name}>`;
  let from = 0;
  while (out.length < limit) {
    const at = text.indexOf(open, from);
    if (at < 0) break;
    const next = text[at + open.length];
    if (next !== '>' && next !== undefined && !/\s/.test(next)) {
      from = at + open.length;
      continue;
    }
    const gt = text.indexOf('>', at + open.length);
    if (gt < 0) break;
    const end = text.indexOf(close, gt + 1);
    if (end < 0) break;
    out.push({ attrs: text.slice(at + open.length, gt), inner: text.slice(gt + 1, end) });
    from = end + close.length;
  }
  return out;
}

/** The inner text of the first `<name>…</name>`. */
function blockText1(text: string, name: string): string | undefined {
  const at = text.indexOf(`<${name}>`);
  if (at < 0) return undefined;
  const end = text.indexOf(`</${name}>`, at);
  return end < 0 ? undefined : text.slice(at + name.length + 2, end);
}
/** Wrappers around things the user did locally (shell `!`, slash command output): never a turn. */
const LOCAL_WRAPPER_RE =
  /^\s*<(local-command-caveat|local-command-stdout|local-command-stderr|bash-input|bash-stdout|bash-stderr)>/;

/**
 * Messages from teammates: `<teammate-message teammate_id="x" summary="...">body</teammate-message>`,
 * where the body is text or a JSON notification (`{"type":"idle_notification","result":"..."}`).
 */
function readTeammateMessages(text: string): StoryTeammateReport[] {
  const reports: StoryTeammateReport[] = [];
  for (const m of blocks(text, 'teammate-message')) {
    const from = /teammate_id="([^"]*)"/.exec(m.attrs)?.[1]?.split('@')[0];
    if (!from) continue;
    const rawSummary = /summary="([^"]*)"/.exec(m.attrs)?.[1];
    const summary = rawSummary === undefined ? undefined : unescapeXml(rawSummary);
    let body: string | undefined = unescapeXml(m.inner.trim());
    if (body.startsWith('{')) {
      try {
        const note: unknown = JSON.parse(body);
        body = isRecord(note) ? (str(note.result) ?? str(note.summary) ?? str(note.message)) : undefined;
      } catch {
        // not JSON after all: keep it as text
      }
    }
    reports.push({
      from: clip(from, 80),
      summary: summary ? clip(summary, 200) : undefined,
      result: body || undefined,
    });
  }
  return reports;
}

/** Claude Code escapes a notification's text (`&lt;noreply@anthropic.com&gt;`); undo the five it uses. */
const unescapeXml = (s: string): string =>
  s.replace(
    /&(lt|gt|quot|apos|amp);/g,
    (_, e: string) => ({ lt: '<', gt: '>', quot: '"', apos: "'", amp: '&' })[e] ?? _
  );

function readPrompt(raw: string): {
  text: string;
  kind: 'prompt' | 'task' | 'peer' | 'interrupt';
  /** A slash command (`/compact`, `/model`), from its `<command-name>`. */
  slash?: boolean;
  task?: StoryTaskReport;
  teammates?: StoryTeammateReport[];
} | null {
  const text = withoutBlocks(raw, '<system-reminder>', '</system-reminder>')
    .replace(/<\/?pasted_content\b[^>]*>/g, '') // Claude Code's wrapper around pasted text
    .replace(/^\s*Another Claude session sent a message:\s*/, '')
    .trim();
  if (!text) return null;
  if (/^<teammate-message\b/.test(text)) {
    const teammates = readTeammateMessages(text);
    const first = teammates.find((t) => t.summary || t.result) ?? teammates[0];
    if (first)
      return {
        text: `${first.from}: ${first.summary || (first.result ? firstSentence(first.result, 200) : 'reports back')}`,
        kind: 'task',
        teammates,
      };
  }
  const peer = /^<cross-session-message\b([^>]*)>([\s\S]*?)(?:<\/cross-session-message>|$)/.exec(text);
  if (peer) {
    const name = /from-name="([^"]*)"/.exec(peer[1])?.[1];
    return { text: `${name ? `${name}: ` : ''}${peer[2].trim()}`, kind: 'peer' };
  }
  if (/^\[Request interrupted/.test(text)) return { text, kind: 'interrupt' };
  if (LOCAL_WRAPPER_RE.test(text)) return null;
  const command = /<command-name>([^<]*)<\/command-name>/.exec(text);
  if (command) {
    const args = /<command-args>([^<]*)<\/command-args>/.exec(text)?.[1] ?? '';
    return { text: `${command[1].trim()} ${args.trim()}`.trim(), kind: 'prompt', slash: true };
  }
  if (/^<task-notification>/.test(text)) {
    const tag = (name: string) => {
      const value = blockText1(text, name)?.trim();
      return value === undefined ? undefined : unescapeXml(value);
    };
    const count = (name: string) => {
      const n = Number(tag(name));
      return tag(name) !== undefined && Number.isFinite(n) ? n : undefined;
    };
    const task: StoryTaskReport = {
      toolUseId: tag('tool-use-id'),
      status: tag('status'),
      result: tag('result'),
      toolUses: count('tool_uses'),
      durationMs: count('duration_ms'),
    };
    return { text: tag('summary') || 'A background task finished.', kind: 'task', task };
  }
  // A command typed as such (`/compact`, `/model opus`); a path (`/home/x`) is not one.
  if (/^\/[a-z][\w:-]*(\s|$)/i.test(text) && !text.includes('\n')) return { text, kind: 'prompt', slash: true };
  return { text, kind: 'prompt' };
}

function originOf(turnOrigin: unknown, kind: 'prompt' | 'task' | 'peer'): StoryTurnOrigin {
  if (turnOrigin === 'task_notification' || turnOrigin === 'task-notification' || kind === 'task') return 'task';
  if (turnOrigin === 'peer' || turnOrigin === 'coordinator' || kind === 'peer') return 'peer';
  if (turnOrigin === 'human') return 'human';
  if (turnOrigin === 'scheduled') return 'scheduled';
  if (typeof turnOrigin === 'string') return 'system';
  return 'human';
}

function reduceInput(name: string, input: unknown, cwd?: string): ReducedInput {
  const i = isRecord(input) ? input : {};
  const s = (v: unknown, max: number) => {
    const value = str(v);
    return value === undefined ? undefined : clip(value, max);
  };
  switch (name) {
    case 'Bash': {
      // Judged on the whole command: a commit or a test run often sits past the displayed part.
      const full = str(i.command) ?? '';
      const { intent, segment } = judgeBashCommand(full);
      const input: ReducedInput = {
        // Shown without here-document bodies: the files they write are shown as diffs instead.
        command: clip(withoutHeredocBodies(full), STORY_LIMITS.labelChars),
        description: s(i.description, 160),
        intent,
      };
      if (segment && segment !== full.trim() && (intent === 'test' || intent === 'build' || intent === 'save'))
        input.headline = clip(segment, 200);
      const writes = heredocWrites(full, cwd);
      if (writes.length) input.writes = writes;
      // A script or command that writes project files is an edit, whatever it was run as.
      if (writes.length && (intent === 'run' || intent === 'look')) input.intent = 'edit';
      // Files it prints, whatever else it does (`cat a.py && pytest`): the drawer offers them. A
      // relative name resolves against the line's cwd (printedFiles gives none after a `cd`).
      const reads = printedFiles(full).map((f) =>
        f.startsWith('/') || f.startsWith('~') || !cwd ? f : `${cwd.replace(/\/+$/, '')}/${f.replace(/^\.\//, '')}`
      );
      if (reads.length) input.reads = reads;
      {
        // Counted whatever wins: a test run that ends in a commit still saves the work.
        const heads = commandSegments(withoutHeredocBodies(full.slice(0, 4000))).map(segmentHead);
        if (heads.some((h) => /^gh pr create\b/.test(h))) input.ships = 'pr';
        else if (heads.some((h) => /^git push\b/.test(h))) input.ships = 'push';
        const commits = heads.filter((h) => /^git commit\b/.test(h)).length;
        // Counted on every command that commits: a save can also be a push or a tag that makes none.
        if (commits) input.commits = commits;
        if (commits) {
          const subject = commitSubject(full);
          if (subject) input.subject = subject;
        }
      }
      return input;
    }
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
    case 'Write': {
      const file = s(i.file_path, 1000);
      // A plan-mode plan file keeps its text: it becomes the plan panel's list.
      return file && PLAN_FILE.test(file) ? { file, plan: s(i.content, 4000) } : { file };
    }
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
/** Server tools under the names the client tools of the same kind use. */
const SERVER_TOOLS: Record<string, string> = { advisor: 'Advisor', web_search: 'WebSearch', web_fetch: 'WebFetch' };
/** The advisor's answer reaches the transcript encrypted; this says so instead. */
const ADVISOR_ANSWER = 'The advice went to Claude only: the transcript keeps it encrypted.';

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
          // A background start answers with launch notes meant for Claude only, never the helper's answer.
          const background =
            extra.isAsync === true || extra.status === 'async_launched' || extra.status === 'teammate_spawned';
          const answer = background ? '' : blockText(extra.content) || text;
          result.helper = {
            background: background || undefined,
            result: answer ? clip(answer, STORY_LIMITS.helperChars) : undefined,
            toolUses: num(extra.totalToolUseCount),
            durationMs: num(extra.totalDurationMs),
            agentId:
              typeof extra.agentId === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(extra.agentId)
                ? extra.agentId
                : undefined,
          };
        } else if (name === 'ExitPlanMode') {
          // The plan rides on the result (the call's input is empty in current builds), with your answer.
          if (typeof extra.plan === 'string') result.plan = clip(extra.plan, 4000);
          if (!isError && /\bapproved\b/i.test(text)) result.answer = 'Approved';
          else if (text) result.answer = 'Sent back';
        } else if (name === 'AskUserQuestion' && isRecord(extra.answers)) {
          const first = Object.values(extra.answers).find((v): v is string => typeof v === 'string');
          if (first) result.answer = clip(first, 300);
        } else if (text && (!QUIET_RESULTS.has(name) || isError)) {
          const tail = clipTail(text, STORY_LIMITS.outputChars, STORY_LIMITS.outputLines);
          result.output = tail.text;
          if (tail.truncated) result.outputTruncated = true;
          if (name === 'Bash' && /^\s*Command running in background with ID:/.test(text)) {
            result.background = true;
            // The launch note tells Claude where to read later; the reader gets what it means.
            result.output = 'Started in the background. Its result comes back as a report of its own.';
            result.outputTruncated = undefined;
          } else if (name === 'Bash') {
            // Counted on the whole output: a later command's lines can push the summary out of the tail.
            const tests = parseTestCounts(text);
            if (tests) result.tests = tests;
            const intent = call?.input.intent;
            if ((intent === 'build' || intent === 'test') && reportsProblems(tail.text)) result.problems = true;
            // Claude Code appends this note: one anchored try at its last occurrence, never a scan
            // of the whole output (a lazy match per repeat of the phrase is quadratic).
            const noteAt = text.lastIndexOf('This command modified ');
            const note =
              noteAt < 0
                ? null
                : /^This command modified \d+ files? you've previously read: ([^\]\n]{1,2000}?)\.? Call Read/.exec(
                    text.slice(noteAt, noteAt + 2400)
                  );
            if (note) {
              const cwd = str(entry.cwd);
              result.modified = note[1]
                .split(/,\s*/)
                .filter((f) => f && !/\s/.test(f))
                .slice(0, 8)
                .map((f) => (f.startsWith('/') || !cwd ? f : `${cwd.replace(/\/+$/, '')}/${f}`));
            }
          }
        }
        out.push(result);
        calls.delete(id);
      }
      if (results.length) return out;
    }
    // A scheduled task's prompt is written as a meta line; it still starts a turn of its own.
    const scheduled = entry.turnOrigin === 'scheduled' || typeof entry.scheduledTaskId === 'string';
    if ((entry.isMeta === true && !scheduled) || entry.turnCompanion === true) return out;
    const local = /^\s*<local-command-(stdout|stderr)>([\s\S]*?)<\/local-command-\1>/.exec(blockText(content));
    if (local) {
      const text = local[2]
        // eslint-disable-next-line no-control-regex
        .replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
        .replace(/`([^`\n]+)`/g, '$1')
        .trim();
      return [{ k: 'local', at, text: clip(text, 2000) }];
    }
    const prompt = readPrompt(blockText(content));
    if (!prompt) return out;
    if (prompt.kind === 'interrupt') return [{ k: 'interrupt', at }];
    return [
      {
        ...promptEntry(
          prompt,
          str(entry.uuid) ?? `prompt-${at}`,
          at,
          originOf(entry.turnOrigin, prompt.kind),
          entry.promptSource === 'queued'
        ),
        promptId: str(entry.promptId),
      },
    ];
  }

  /**
   * A prompt that arrived while Claude worked: current builds write no user line for it, only an
   * `attachment` of type `queued_command` where Claude took it in (a typed prompt, a background
   * task's notification, a message from another session).
   */
  function reduceQueuedCommand(entry: Record<string, unknown>, at: string): StoryEntry[] {
    const a = isRecord(entry.attachment) ? entry.attachment : {};
    if (a.type !== 'queued_command') return [];
    const prompt = readPrompt(typeof a.prompt === 'string' ? a.prompt : blockText(a.prompt));
    if (!prompt || prompt.kind === 'interrupt') return [];
    const from = isRecord(a.origin) ? a.origin.kind : undefined;
    const kind = a.commandMode === 'task-notification' && prompt.kind === 'prompt' ? 'task' : prompt.kind;
    const id = str(a.source_uuid) ?? str(entry.uuid) ?? `queued-${at}`;
    return [promptEntry(prompt, id, at, originOf(from ?? 'human', kind), true)];
  }

  function promptEntry(
    prompt: NonNullable<ReturnType<typeof readPrompt>>,
    id: string,
    at: string,
    origin: StoryTurnOrigin,
    queued: boolean
  ): Extract<StoryEntry, { k: 'prompt' }> {
    const reduced: Extract<StoryEntry, { k: 'prompt' }> = {
      k: 'prompt',
      id,
      at,
      text: clip(prompt.text, STORY_LIMITS.promptChars),
      origin,
      queued,
    };
    if (prompt.slash) reduced.slash = true;
    if (prompt.task) {
      const t = prompt.task;
      reduced.task = {
        toolUseId: t.toolUseId && /^[A-Za-z0-9_-]{1,128}$/.test(t.toolUseId) ? t.toolUseId : undefined,
        status: t.status ? clip(t.status, 40) : undefined,
        result: t.result ? clip(t.result, STORY_LIMITS.helperChars) : undefined,
        toolUses: t.toolUses,
        durationMs: t.durationMs,
      };
    }
    if (prompt.teammates?.length)
      reduced.teammates = prompt.teammates.slice(0, 8).map((t) => ({
        from: t.from,
        summary: t.summary,
        result: t.result ? clip(t.result, STORY_LIMITS.helperChars) : undefined,
      }));
    return reduced;
  }

  function reduceAssistant(entry: Record<string, unknown>, at: string): StoryEntry[] {
    const message = isRecord(entry.message) ? entry.message : {};
    const content = message.content;
    const textEntry = (text: string): StoryEntry => {
      const keyPoints = keyPointsOf(text);
      return { k: 'text', at, text: clip(text, STORY_LIMITS.textChars), ...(keyPoints.length ? { keyPoints } : {}) };
    };
    if (typeof content === 'string') return content.trim() ? [textEntry(content)] : [];
    if (!Array.isArray(content)) return [];
    const out: StoryEntry[] = [];
    for (const block of content) {
      if (!isRecord(block)) continue;
      if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
        out.push(textEntry(block.text));
      } else if (block.type === 'tool_use' && typeof block.id === 'string' && typeof block.name === 'string') {
        const input = reduceInput(block.name, block.input, str(entry.cwd));
        remember(block.id, block.name, input);
        out.push({ k: 'tool', at, id: block.id, name: block.name, input });
      } else if (block.type === 'server_tool_use' && typeof block.id === 'string' && typeof block.name === 'string') {
        // Tools the API runs itself (the advisor, web search): call and result share the message.
        const name = SERVER_TOOLS[block.name] ?? block.name;
        const input = reduceInput(name, block.input);
        remember(block.id, name, input);
        out.push({ k: 'tool', at, id: block.id, name, input });
      } else if (
        typeof block.type === 'string' &&
        block.type.endsWith('_tool_result') &&
        typeof block.tool_use_id === 'string' &&
        calls.has(block.tool_use_id)
      ) {
        const content = isRecord(block.content) ? block.content : {};
        const isError = typeof content.type === 'string' && /error/.test(content.type);
        const call = calls.get(block.tool_use_id);
        const result: Extract<StoryEntry, { k: 'result' }> = { k: 'result', at, id: block.tool_use_id, isError };
        if (call?.name === 'Advisor' && !isError) result.helper = { result: ADVISOR_ANSWER };
        out.push(result);
        calls.delete(block.tool_use_id);
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
        case 'attachment':
          return reduceQueuedCommand(line, at);
        case 'system':
          if (line.subtype === 'turn_duration') return [{ k: 'end', at, durationMs: num(line.durationMs) }];
          // Some sessions never write turn_duration; the Stop hook's summary marks the same end (unless
          // the hook kept Claude going).
          if (line.subtype === 'stop_hook_summary' && line.preventedContinuation !== true) return [{ k: 'end', at }];
          if (line.subtype === 'compact_boundary') {
            const meta = isRecord(line.compactMetadata) ? line.compactMetadata : {};
            return [
              {
                k: 'compact',
                at,
                trigger: str(meta.trigger),
                preTokens: num(meta.preTokens),
                postTokens: num(meta.postTokens),
                durationMs: num(meta.durationMs),
              },
            ];
          }
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
  /** Claude Code's id for the prompt that started the turn. */
  promptId?: string;
  /** What ended the turn, for the Director's cut. */
  endedBy?: 'turn_duration' | 'stop_hook_summary' | 'local command' | 'interrupted' | 'next prompt';
}

/** How long after a turn's end a line may still belong to it (Claude Code flushes some lines late). */
const LATE_FLUSH_MS = 5000;

/** Plan mode keeps its plan in a file under `~/.claude/plans/`: writing it is planning, not changing code. */
const PLAN_FILE = /\/\.claude\/plans\/[^/]+\.md$/;

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
    case 'ToolSearch':
      return 'look';
    case 'ExitPlanMode':
    case 'AskUserQuestion':
      return 'ask';
    case 'Agent':
    case 'Task':
    case 'Workflow':
    case 'Advisor':
      return 'helper';
    case 'SendMessage':
      return 'message';
    case 'Edit':
    case 'MultiEdit':
    case 'Write':
    case 'NotebookEdit':
      return input.file && PLAN_FILE.test(input.file) ? 'plan' : 'edit';
    case 'Bash':
      return input.intent ?? classifyBashCommand(input.command ?? '');
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
    case 'Advisor':
      return 'a second opinion';
    case 'TodoWrite':
      return plural(i.todos?.length ?? 0, 'item');
    case 'AskUserQuestion':
      return i.question ?? '';
    case 'ExitPlanMode':
      return 'Plan ready for your OK';
    case 'EnterPlanMode':
      return 'plan mode on';
    case 'ToolSearch':
      return `tools: ${(i.text ?? '').replace(/^select:/, '')}`;
    case 'Write':
    case 'Edit':
      return i.file && PLAN_FILE.test(i.file) ? `the plan, ${basename(i.file)}` : (i.file ?? '');
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
  if (i.reads) ev.files = i.reads;
  if (i.ships) ev.ships = i.ships;
  if (i.headline) ev.headline = i.headline;
  if (i.commits) ev.commits = i.commits;
  if (i.subject) ev.subject = i.subject;
  if (i.writes) ev.edits = i.writes;
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
  if (e.name === 'Advisor')
    ev.helper = {
      name: 'advisor',
      type: 'advisor',
      task: 'A second opinion',
      prompt: 'Claude shows a stronger model the whole conversation so far and asks what it thinks.',
    };
  if (i.todos) ev.todos = i.todos;
  if (i.plan) {
    const todos = planFromText(i.plan);
    if (todos) ev.todos = todos;
  }
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
  if (r.edit && ev.intent !== 'plan') {
    ev.edit = r.edit;
    ev.file = r.edit.file;
  }
  if (r.plan) {
    ev.output = r.plan;
    if (ev.question) ev.question = { ...ev.question, text: firstSentence(r.plan, 240) };
    const todos = planFromText(r.plan);
    if (todos) ev.todos = todos;
  }
  if (r.problems) ev.ok = false;
  if (r.background) {
    // Started, not done: its task notification says how it ended.
    ev.running = true;
    ev.background = true;
    ev.ok = undefined;
  }
  // Reading a background job's output file that reports tests is a look at test results.
  if (
    r.tests &&
    ev.tool === 'Bash' &&
    (ev.intent === 'look' || ev.intent === 'run') &&
    /\.(output|log)\b|\/tasks\//.test(ev.label)
  )
    ev.intent = 'test';
  if (r.modified?.length) {
    // Changed, but no diff to show: the file is listed, its lines unknown. A plain command that did
    // it (a script, a formatter) edited files.
    if (ev.intent === 'run' || ev.intent === 'look') ev.intent = 'edit';
    const known = new Set((ev.edits ?? []).map((d) => d.file));
    const more = r.modified
      .filter((f) => !known.has(f))
      .map((file) => ({ file, added: 0, removed: 0, created: false, hunks: [], truncated: true }));
    if (more.length) ev.edits = [...(ev.edits ?? []), ...more];
  }
  if (r.tests) {
    ev.tests = r.tests;
    // A run that reports failed tests failed, whatever its exit code (`pytest | tail` exits 0).
    if (r.tests.failed > 0 || (r.tests.errors ?? 0) > 0) ev.ok = false;
  }
  if (r.helper && ev.helper) {
    const helper: StoryHelper = { ...ev.helper };
    if (r.helper.background && !r.isError) {
      helper.background = true;
      helper.running = true;
    }
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
  /** Helper calls by tool id, across turns: a background helper reports back in a later turn. */
  const helpers = new Map<string, StoryEvent>();
  /** A compaction between turns, held for the turn that comes next. */
  let pendingCompact: StoryEvent | null = null;
  /** The same helpers by name: a teammate reports back by name, not by call. */
  const helpersByName = new Map<string, StoryEvent>();
  let say = 0;
  /** The turn each helper or command call belongs to: a report after that turn ended came back later. */
  const turnOfCall = new WeakMap<StoryEvent, StoryTurn>();
  const cameBackLater = (ev: StoryEvent) => {
    const own = turnOfCall.get(ev);
    return !!own && (own !== cur || own.ended);
  };
  const teammatesBack = (reports: StoryTeammateReport[], prompt: StoryEvent) => {
    const told = reports.filter((r) => r.result || r.summary);
    if (told.length) {
      prompt.output = clip(
        told.map((r) => `${r.from}: ${r.result ?? r.summary}`).join('\n\n'),
        STORY_LIMITS.helperChars
      );
    }
    for (const r of reports) {
      const ev = helpersByName.get(r.from);
      if (!ev?.helper) continue;
      const helper: StoryHelper = { ...ev.helper, running: undefined };
      if (helper.background && cameBackLater(ev)) ev.finishedLater = true;
      if (r.result) helper.result = r.result;
      ev.helper = helper;
    }
  };
  /** Ends a turn at `at` with no duration of its own: timed by its span, when the span is known. */
  const closeTurn = (t: StoryTurn, at: string, by: NonNullable<StoryTurn['endedBy']>) => {
    t.ended = true;
    t.endedAt = at;
    t.endedBy = by;
    const span = Date.parse(at) - Date.parse(t.at);
    if (!t.partial && Number.isFinite(span) && span >= 0) t.durationMs ??= span;
  };
  const reportBack = (report: StoryTaskReport, prompt: StoryEvent) => {
    if (report.result) {
      prompt.output = report.result;
      if (report.result.length >= STORY_LIMITS.helperChars) prompt.outputTruncated = true;
    }
    const ev = report.toolUseId ? helpers.get(report.toolUseId) : undefined;
    if (ev?.running && !ev.helper) {
      // A background command: done now, and its summary carries the exit code.
      ev.running = undefined;
      if (cameBackLater(ev)) ev.finishedLater = true;
      const code = /\(exit code (\d+)\)/.exec(prompt.label)?.[1];
      ev.ok =
        code !== undefined ? code === '0' : !report.status || /^(completed|done|finished|success)/i.test(report.status);
      ev.output = `Finished in the background${code !== undefined ? `, exit code ${code}` : ''}. Its report is the turn it came back in.`;
      return;
    }
    if (!ev?.helper) return;
    const helper: StoryHelper = { ...ev.helper, running: undefined };
    if (helper.background && cameBackLater(ev)) ev.finishedLater = true;
    if (report.result) helper.result = report.result;
    if (report.toolUses !== undefined) helper.toolUses = report.toolUses;
    if (report.durationMs !== undefined) helper.durationMs = report.durationMs;
    ev.helper = helper;
    // The report's own turn links back to the helper: its drawer shows what the helper did.
    prompt.helper = { ...helper };
    if (report.status && !/^(completed|done|finished|success)/i.test(report.status)) ev.ok = false;
  };
  const ensure = (at: string): StoryTurn => {
    // Work that comes well after a turn ended (no prompt of its own) is a turn of its own; a line
    // Claude Code flushed a moment late still joins the turn it belongs to.
    const after = cur?.ended ? Date.parse(at) - Date.parse(cur.endedAt ?? at) : 0;
    if (!cur || (cur.ended && Number.isFinite(after) && after > LATE_FLUSH_MS)) {
      cur = {
        id: cur ? `continued-${at}` : `partial-${at}`,
        at,
        prompt: '',
        origin: cur ? 'system' : 'human',
        partial: !cur,
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
        const ev: StoryEvent = {
          id: e.id,
          at: e.at,
          actor: e.origin === 'human' ? 'you' : 'system',
          tool: e.slash ? 'Command' : 'Prompt',
          label: e.text,
          intent: 'prompt',
          origin: e.origin,
        };
        if (e.task) reportBack(e.task, ev);
        if (e.teammates) teammatesBack(e.teammates, ev);
        const open = cur as StoryTurn | null;
        if (open && !open.ended && e.promptId && open.promptId === e.promptId) {
          // The same prompt written again (`/compact` typed, then recorded as a command): one turn.
          const first = open.events[0];
          if (e.slash && first?.intent === 'prompt') {
            first.tool = 'Command';
            first.label = e.text;
            open.prompt = e.text;
          }
          break;
        }
        if (open && !open.ended && e.queued) {
          // A report that lands while Claude works is a line on the wire, not a new mission.
          if (e.origin === 'task') {
            ev.intent = 'notice';
            ev.tool = 'Report';
          }
          open.events.push(ev);
        } else {
          // Claude runs one turn at a time: a turn still open when the next one starts has ended.
          if (open && !open.ended) closeTurn(open, e.at, 'next prompt');
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
          if (e.promptId) cur.promptId = e.promptId;
          turns.push(cur);
          byId.clear();
          if (pendingCompact) {
            cur.events.push(pendingCompact);
            pendingCompact = null;
          }
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
          ...(e.keyPoints ? { keyPoints: e.keyPoints } : {}),
        });
        break;
      case 'tool': {
        const ev = toolEvent(e, 'claude');
        ensure(e.at).events.push(ev);
        byId.set(e.id, ev);
        if (ev.helper || ev.tool === 'Bash') {
          // A helper, or a command that may turn out to run in the background: both report back later.
          helpers.set(e.id, ev);
          turnOfCall.set(ev, ensure(e.at));
          if (helpers.size > 2000) helpers.delete(helpers.keys().next().value as string);
          if (ev.helper) {
            helpersByName.set(ev.helper.name, ev);
            if (helpersByName.size > 500) helpersByName.delete(helpersByName.keys().next().value as string);
          }
        }
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
          // Claude Code times a turn a background task started from the prompt that started the chain;
          // a turn never takes longer than its own span, so that is the cap.
          const span = Date.parse(e.at) - Date.parse(t.at);
          const known = !t.partial && Number.isFinite(span) && span >= 0;
          if (e.durationMs !== undefined) t.durationMs = known ? Math.min(e.durationMs, span) : e.durationMs;
          else if (known && t.durationMs === undefined) t.durationMs = span; // ended by the Stop hook's summary
          t.endedBy = e.durationMs !== undefined ? 'turn_duration' : (t.endedBy ?? 'stop_hook_summary');
        }
        break;
      }
      case 'compact': {
        const ev: StoryEvent = {
          id: `compact-${say++}`,
          at: e.at,
          actor: 'system',
          tool: 'Compact',
          label: 'Context compacted',
          intent: 'compact',
        };
        const k = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
        const facts = [
          e.trigger === 'auto' ? 'automatic' : e.trigger,
          e.preTokens !== undefined && e.postTokens !== undefined
            ? `${k(e.preTokens)} → ${k(e.postTokens)} tokens`
            : '',
          e.durationMs !== undefined ? exactDuration(e.durationMs) : '',
        ].filter(Boolean);
        if (facts.length) ev.description = facts.join(' · ');
        if (e.trigger === 'auto') ev.label = 'Context compacted: memory was full';
        // Between turns (`/compact` writes its boundary before the command line itself), it belongs to
        // the turn that comes next; mid-turn (an automatic compaction), to the running one.
        const t = cur as StoryTurn | null;
        if (t && !t.ended) t.events.push(ev);
        else pendingCompact = ev;
        break;
      }
      case 'local': {
        // A local slash command answers itself: its turn ends with what it printed.
        const t = cur as StoryTurn | null;
        if (t && !t.ended && t.events[0]?.tool === 'Command' && countToolCalls(t.events) === 0) {
          if (e.text) t.events[0].output = e.text;
          closeTurn(t, e.at, 'local command');
        }
        break;
      }
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
        closeTurn(t, e.at, 'interrupted');
        break;
      }
    }
  }
  // A compaction after the last turn (no turn came after it to take it) closes that turn.
  if (pendingCompact && turns.length) turns[turns.length - 1].events.push(pendingCompact);
  return turns;
}

const NOT_TOOL_CALLS = new Set<StoryIntent>(['prompt', 'say', 'interrupt', 'compact', 'notice']);
const countToolCalls = (events: StoryEvent[]) => events.filter((e) => !NOT_TOOL_CALLS.has(e.intent)).length;

export function summarizeTurn(turn: StoryTurn): StoryTurnSummary {
  return {
    id: turn.id,
    at: turn.at,
    prompt: clip(turn.prompt.split('\n')[0] ?? '', 140),
    origin: turn.origin,
    complete: turn.ended && !turn.interrupted,
    interrupted: turn.interrupted,
    ...(turn.endedBy === 'next prompt' ? { superseded: true } : {}),
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
  notice: null,
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
const MINOR = new Set<StoryPanelKind>(['investigate', 'research', 'plan', 'run', 'compact', 'montage']);

interface DraftPanel {
  kind: StoryPanelKind;
  events: number[];
  balloon?: { who: 'you' | 'claude' | 'note'; text: string };
  rounds?: number;
}

/** Every edit an event made: an Edit/Write call's one, or the files a Bash call wrote. */
const editsOf = (e: StoryEvent): StoryEdit[] => (e.edit ? [e.edit] : (e.edits ?? []));

/** Keeps the newest outputs, hunks and helper texts within the page budget; true when it cut any. */
function applyTextBudget(events: StoryEvent[]): boolean {
  let used = 0;
  let cut = false;
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    const hunkChars = editsOf(e).reduce(
      (n, d) => n + d.hunks.reduce((m, h) => m + h.lines.reduce((k, l) => k + l.length, 0), 0),
      0
    );
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
    if (e.edits?.some((d) => d.hunks.length)) e.edits = e.edits.map((d) => ({ ...d, hunks: [], truncated: true }));
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

/** Claude reporting how a check went ("All 7 tests pass"), as opposed to announcing its next step. */
const TALKS_RESULTS = /\b(pass(es|ed|ing)?|fail(s|ed|ing|ures?)?|green|red|clean|errors?)\b/i;
/** Claude reporting a save ("Commits are in.", "Pushed to origin."). */
const TALKS_SAVES = /\b(commit(s|ted)?|pushed|merged|tagged)\b/i;
/** The remark that reports on a panel of this kind, if any. */
const REPORT_TALK: Partial<Record<StoryPanelKind, RegExp>> = {
  check: TALKS_RESULTS,
  save: TALKS_SAVES,
  run: TALKS_RESULTS,
};
const ANNOUNCES = /\b(I'll|I will|let me|let's|I'm going to|next,? I|now I)\b/i;

function groupPanels(events: StoryEvent[]): { panels: DraftPanel[]; trailingSay?: string; openNote?: boolean } {
  const panels: DraftPanel[] = [];
  let pendingSay: string | undefined;
  let lastSaid: StoryEvent | undefined;
  events.forEach((ev, idx) => {
    if (ev.intent === 'say' && !ev.todos) {
      pendingSay ??= balloonText(ev.label);
      lastSaid ??= ev;
      return;
    }
    lastSaid = undefined;
    const kind = ev.todos && ev.intent === 'say' ? 'plan' : PANEL_FOR[ev.intent];
    if (!kind) return;
    const last = panels[panels.length - 1];
    const advisorMix =
      kind === 'backup' &&
      last?.kind === 'backup' &&
      (events[last.events[0]].tool === 'Advisor') !== (ev.tool === 'Advisor');
    if (last && last.kind === kind && MERGEABLE.has(kind) && !advisorMix) {
      last.events.push(idx);
      if (pendingSay && !last.balloon) last.balloon = { who: 'claude', text: pendingSay };
    } else {
      const panel: DraftPanel = { kind, events: [idx] };
      // A sentence about how the check just before went belongs to that check, not to what comes next.
      // A check that also committed reports on both: "All 8 pass." and "Committed."
      const saves = last?.kind === 'check' && last.events.some((i) => events[i].commits);
      const talk = last
        ? saves
          ? new RegExp(`${TALKS_RESULTS.source}|${TALKS_SAVES.source}`, 'i')
          : REPORT_TALK[last.kind]
        : undefined;
      const reportsBack =
        pendingSay &&
        talk &&
        last &&
        (!last.balloon || (last.kind === 'check' && !talk.test(last.balloon.text))) &&
        talk.test(pendingSay) &&
        !ANNOUNCES.test(pendingSay);
      if (kind === 'mission') panel.balloon = { who: 'you', text: clip(ev.label, 400) };
      else if (reportsBack && last && pendingSay) last.balloon = { who: 'claude', text: pendingSay };
      else if (pendingSay) panel.balloon = { who: 'claude', text: pendingSay };
      panels.push(panel);
    }
    pendingSay = undefined;
  });
  // The closing words keep a caveat that follows them ("Nothing is committed: this is no git repo.").
  return {
    panels,
    trailingSay: lastSaid !== undefined ? closingText(lastSaid.label, lastSaid.keyPoints) : pendingSay,
    // Claude's last words name an open problem: the final panel is not a celebration.
    openNote: !!lastSaid?.keyPoints?.some((k) => OPEN_PROBLEM.test(k)),
  };
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
    // A loop ends at a check: writes after the last check (docs, config) are their own panel.
    while (j > i && panels[j - 1].kind === 'fix') j--;
    const run = panels.slice(i, j);
    if (run.length >= 4) {
      out.push({
        kind: 'loop',
        events: run.flatMap((p) => p.events),
        // The last word of the rounds is how they ended.
        balloon: [...run].reverse().find((p) => p.balloon)?.balloon,
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

/**
 * Folds neighbouring panels into montages until the page fits. Quiet kinds fold first, and the
 * oldest pair first, growing a montage already there when it can: so on a live page, the panels
 * the reader is watching keep their place, and the newest panel is never the one folded while
 * another choice exists.
 */
function capPanels(panels: DraftPanel[], max: number): DraftPanel[] {
  const out = [...panels];
  const firstMergeable = out[0]?.kind === 'mission' ? 1 : 0;
  while (out.length > max) {
    let best = -1;
    // Four passes: quiet kinds; then anything but a prompt or a question; then a prompt you added
    // mid-turn; then, only so the page keeps its 12 panels, a question too (the turn's own prompt
    // is never folded).
    search: for (const pass of [0, 1, 2, 3]) {
      for (const lastStart of [out.length - 3, out.length - 2]) {
        let oldest = -1;
        for (let k = firstMergeable; k <= lastStart; k++) {
          const a = out[k];
          const b = out[k + 1];
          const ok =
            pass === 0
              ? MINOR.has(a.kind) && MINOR.has(b.kind)
              : pass === 1
                ? ![a.kind, b.kind].some((kind) => kind === 'mission' || kind === 'ask')
                : ![a, b].some(
                    (d) =>
                      (pass === 2 && d.kind === 'ask') || (d.kind === 'mission' && d.events[0] === out[0]?.events[0])
                  );
          if (!ok) continue;
          if (a.kind === 'montage' || b.kind === 'montage') {
            best = k;
            break search;
          }
          if (oldest < 0) oldest = k;
        }
        if (oldest >= 0) {
          best = oldest;
          break search;
        }
      }
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

/** Lines of a script that say nothing about what it does: `set -e`, a bare `cd dir`, `S=/tmp/x`, comments. */
const NOISE_LINE = /^\s*(#.*|set\s+[-+][a-zA-Z]+(\s+\w+)?|cd\s+\S+|[A-Za-z_][A-Za-z0-9_]*=\S*)?\s*$/;
/** What a command does, for a caption: the part that decided it, else its first telling line. */
const shortCommand = (e: StoryEvent) => {
  if (e.headline) return clip((e.headline.split('\n')[0] ?? '').replace(/\s*<<-?\s*(['"]?)\w+\1/g, ''), 60);
  const lines = e.label.split('\n');
  return clip(lines.find((l) => !NOISE_LINE.test(l)) ?? lines[0] ?? '', 60);
};

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
  const commits = evs.reduce((n, e) => n + (e.commits ?? 0), 0);
  if (commits || evs.some((e) => e.intent === 'save'))
    parts.push(commits > 1 ? `saves the work in ${commits} commits` : 'saves the work');
  return parts.length ? parts.join(', ') : 'a few more steps';
}

/** You asked for a failing run first (test first), or Claude said the failure was expected. */
const PLANNED_IN_PROMPT =
  /\b(test[- ]first|tdd|fail(s|ing)? (first|on purpose)|failing tests? first|on purpose|red first|before (the )?(code|module|function|implementation) exists)\b/i;
const EXPECTED_BY_CLAUDE =
  /\b(as expected|as planned|as intended|expected (failure|to fail|red)|deliberately fail\w*|on purpose|test[- ]first|the red state)\b/i;
function plannedFailure(turn: StoryTurn, events: StoryEvent[]): boolean {
  const prompt = events.find((e) => e.intent === 'prompt')?.label ?? turn.prompt;
  return PLANNED_IN_PROMPT.test(prompt) || events.some((e) => e.intent === 'say' && EXPECTED_BY_CLAUDE.test(e.label));
}

function decorate(draft: DraftPanel, events: StoryEvent[], turn: StoryTurn, index: number): StoryPanel {
  const evs = draft.events.map((i) => events[i]);
  const panel: StoryPanel = { kind: draft.kind, events: draft.events, caption: { story: '', director: '' } };
  if (draft.balloon) panel.balloon = draft.balloon;
  const edits = evs.flatMap(editsOf);
  const checks = evs.filter((e) => e.intent === 'test' || e.intent === 'build');
  const lastCheck = checks[checks.length - 1];
  // A run that reports failed tests failed, whatever its exit code (`pytest | tail` exits 0).
  const passed = (e: StoryEvent | undefined): boolean | undefined =>
    e?.ok === undefined ? undefined : e.ok && !(e.tests && e.tests.failed > 0);
  const outcome = (e: StoryEvent) => {
    const ok = passed(e);
    return ok === undefined ? 'running' : ok ? 'ok' : 'error';
  };
  const errors = evs.filter((e) => e.ok === false).length;
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
        scheduled: 'A scheduled task starts this turn.',
        system: 'Something automatic starts this turn.',
      };
      const origin = evs[0]?.origin ?? turn.origin;
      const command = evs[0]?.tool === 'Command' ? evs[0].label.split(/\s/)[0] : '';
      story = command
        ? `You run ${command}.`
        : index === 0
          ? lines[turn.origin]
          : origin === 'human'
            ? 'You add something while Claude works.'
            : origin === 'peer'
              ? 'Another session chimes in while Claude works.'
              : lines[origin];
      // Words that started the turn but are not yours are a note, not your balloon.
      if (panel.balloon && !command && origin !== 'human') panel.balloon = { ...panel.balloon, who: 'note' };
      director = command
        ? `Command · ${clip(evs[0].label, 60)}`
        : `Prompt · ${plural(words, 'word')}${origin === 'human' ? '' : ` · ${origin}`}`;
      break;
    }
    case 'investigate': {
      const files = unique(
        evs.flatMap((e) => (e.intent === 'read' && e.file ? [e.file] : e.intent === 'look' ? (e.files ?? []) : []))
      );
      panel.files = files.slice(0, 12);
      // Codeman's own case file is plumbing, not part of the story.
      panel.files = panel.files.filter((f) => !/(^|\/)\.codeman[-.]/.test(f));
      panel.notes = evs
        .filter((e) => e.intent !== 'read')
        .map((e) => e.description || shortCommand(e))
        .slice(0, 4);
      if (evs.every((e) => e.tool === 'Bash')) director = `${tools} · ${shortCommand(evs[0])}`;
      if (errors) director += ` · ${plural(errors, 'error')}`;
      const shown = files.filter((f) => !/(^|\/)\.codeman[-.]/.test(f));
      // A file or two by name; in a turn a report started, reading is checking what came back.
      const checking = turn.origin === 'task' || turn.origin === 'peer';
      const named = shown.map((f) => basename(f));
      story = evs.every((e) => e.tool === 'ToolSearch')
        ? 'Claude gets the tools it needs ready.'
        : shown.length && shown.length <= 2
          ? `Claude ${checking ? 'checks' : 'reads'} ${named.join(' and ')}.`
          : shown.length
            ? `Claude reads ${plural(shown.length, 'file')} to find its way around.`
            : evs.every((e) => e.intent === 'search')
              ? 'Claude searches the code.'
              : 'Claude looks around the project.';
      // A tool lookup's query (`select:EnterPlanMode,ExitPlanMode`) means nothing to a reader.
      if (evs.every((e) => e.tool === 'ToolSearch')) panel.notes = [];
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
      story = todos
        ? `Claude writes a plan: ${plural(todos.length, 'step')}.`
        : evs.every((e) => e.tool === 'EnterPlanMode')
          ? 'Claude switches to plan mode to think it through.'
          : 'Claude thinks it through.';
      // A plan written as text has no progress to report; a plan tool's list does.
      if (todos && evs.every((e) => e.tool === 'Text')) director = `written as text · ${plural(todos.length, 'step')}`;
      else if (todos && evs.some((e) => e.file && PLAN_FILE.test(e.file)))
        director = `${tools} · plan file · ${plural(todos.length, 'step')}`;
      else if (todos) director = `${tools} · ${todos.filter((t) => t.done).length}/${todos.length} done`;
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
      const behind = evs.filter((e) => e.helper?.background).length;
      const advisor = evs.filter((e) => e.tool === 'Advisor').length;
      story = helpers.length
        ? advisor === helpers.length
          ? evs.every((e) => e.tool !== 'Advisor' || e.ok === false)
            ? 'Claude asks a stronger AI model for a second opinion, but gets no answer.'
            : 'Claude asks a stronger AI model for a second opinion.'
          : behind === helpers.length
            ? `Claude sends ${plural(helpers.length, 'helper')} off to work in the background.`
            : `Claude calls in ${plural(helpers.length, 'helper')}.`
        : 'Claude sends a message to another session.';
      const inside = evs.reduce((n, e) => n + (e.helper?.toolUses ?? 0), 0);
      const types = unique(helpers.map((h) => h.type).filter((t) => t !== 'advisor'));
      director = `${tools}${advisor ? ' · a second opinion' : ''}${types.length ? ` · ${types.join(' + ')}` : ''}${inside ? ` · ${plural(inside, 'call')} inside` : ''}`;
      break;
    }
    case 'fix':
    case 'loop': {
      // From the calls, not only the results: an edit still running already names its file.
      const files = unique([
        ...evs.filter((e) => e.intent === 'edit' && e.file).map((e) => e.file as string),
        ...edits.map((d) => d.file),
      ]);
      panel.files = files.slice(0, 12);
      panel.added = edits.reduce((n, e) => n + e.added, 0);
      panel.removed = edits.reduce((n, e) => n + e.removed, 0);
      if (draft.kind === 'fix') {
        const created = unique(edits.filter((e) => e.created).map((e) => e.file)).length;
        const whole =
          edits.length > 0 && edits.every((d) => d.created || d.hunks.every((h) => !h.oldStart && !h.oldLines));
        story =
          created && created === files.length
            ? `Claude writes ${plural(created, 'new file')}.`
            : whole && files.length
              ? `Claude writes ${plural(files.length, 'file')}.`
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
        const ok = passed(lastCheck);
        if (ok !== undefined) panel.ok = ok;
        const tests = lastCheck?.tests;
        if (tests) panel.tests = tests;
        // Every test run's verdict, so a run that failed (often the one you asked for) is not lost,
        // even inside a round that passed in the end.
        const runs = checks.map(passed);
        // A run still going is null, so a live loop already shows the runs that finished.
        if (runs.some((r) => r !== undefined)) panel.roundsOk = runs.map((r) => r ?? null);
        const failed = checks.slice(0, -1).filter((e) => passed(e) === false);
        const fails = failed.length;
        // A failure where the tests passed and only a linter or formatter complained.
        const lintFails = failed.filter(
          (e) => !!e.tests && e.tests.passed > 0 && !e.tests.failed && !e.tests.errors
        ).length;
        const n = panel.rounds;
        const testFails = fails - lintFails;
        // A failure you asked for (test first), or that Claude said it expected, is the plan working.
        const planned = plannedFailure(turn, events) && passed(checks[0]) === false;
        story =
          panel.ok === true && !fails
            ? `Build and test, ${plural(n, 'round')}. Every check passes.`
            : panel.ok === true && fails === lintFails
              ? `Build and test, ${plural(n, 'round')}. The tests pass every time; another check fails ${fails === 1 ? 'once' : `${fails} times`}, then passes.`
              : panel.ok === true && planned && checks.length === 2
                ? 'Test first: the first run fails as planned, the second passes.'
                : panel.ok === true && planned
                  ? `Test first, ${plural(n, 'round')}: the first run fails as planned, then it passes.`
                  : panel.ok === true && checks.length === 2 && fails === 1
                    ? 'Fix and test: the first run fails, the second passes.'
                    : panel.ok === true && testFails && lintFails
                      ? `Fix and test, ${plural(n, 'round')}: ${testFails === 1 ? 'a test run fails' : `${testFails} test runs fail`}, then another check, then everything passes.`
                      : panel.ok === true
                        ? `Fix and test, ${plural(n, 'round')}: ${fails === 1 ? 'one run fails' : `${fails} runs fail`}, then it passes.`
                        : panel.ok === false && tests && tests.passed && !tests.failed && !tests.errors
                          ? `Fix and test, ${plural(n, 'round')}. The tests pass, but another check fails.`
                          : panel.ok === false
                            ? `Fix and test, ${plural(n, 'round')}. Still failing.`
                            : `Fix and test, ${plural(n, 'round')}.`;
        // Commits made inside the loop (a test one-liner that ends in one) are part of its story.
        const saved = evs.reduce((k, e) => k + (e.commits ?? 0), 0);
        if (saved) story += ` Claude saves the work${saved > 1 ? ` in ${saved} commits` : ''} along the way.`;
        director = `${plural(checks.length, 'check')} · ${plural(edits.length, 'edit')} · ${fmtCounts(panel.added, panel.removed)} · last: ${
          lastCheck ? outcome(lastCheck) : 'running'
        }`;
      }
      break;
    }
    case 'check': {
      const tests = [...checks].reverse().find((e) => e.tests)?.tests;
      if (tests) panel.tests = tests;
      const ok = passed(lastCheck);
      if (ok !== undefined) panel.ok = ok;
      panel.notes = notesOf(checks);
      const isTest = checks.some((e) => e.intent === 'test');
      const failedFirst = checks.slice(0, -1).some((e) => passed(e) === false);
      if (lastCheck?.running)
        story = isTest ? 'Claude starts the tests in the background.' : 'Claude starts the checks in the background.';
      // Finished later, in the background: not tests that ran during this turn.
      else if (lastCheck?.background && ok !== undefined)
        story = `The ${isTest ? 'tests' : 'checks'} run in the background and ${ok ? 'pass' : 'fail'}.`;
      else if (ok === undefined) story = isTest ? 'Claude runs the tests.' : 'Claude runs the checks.';
      else if (!ok && tests && !tests.passed && !tests.failed && tests.errors) story = "The tests don't even load.";
      else if (!ok && tests && tests.passed && !tests.failed && !tests.errors)
        story = 'The tests pass, but another check fails.';
      else if (ok)
        story = failedFirst ? 'It fails at first, then passes.' : isTest ? 'The tests pass.' : 'The checks pass.';
      else
        story = isTest
          ? tests && tests.failed > 1
            ? `${tests.failed} tests fail.`
            : 'A test fails.'
          : 'A check fails.';
      if (ok === false && plannedFailure(turn, events)) story = `${story.replace(/[.]$/, '')}, as planned.`;
      // The same command with the same outcome twice in a row reads once, with a count.
      const runs: Array<{ text: string; n: number }> = [];
      for (const e of checks) {
        const text = `${shortCommand(e)} → ${outcome(e)}`;
        const prev = runs[runs.length - 1];
        if (prev?.text === text) prev.n++;
        else runs.push({ text, n: 1 });
      }
      director = runs
        .slice(-3)
        .map((r) => (r.n > 1 ? `${r.text} ×${r.n}` : r.text))
        .join(' · ');
      if (tests)
        director += ` · ${tests.passed} passed${tests.failed ? `, ${tests.failed} failed` : ''}${
          tests.errors ? `, ${plural(tests.errors, 'error')}` : ''
        }`;
      if (edits.length) director += ` · writes ${plural(unique(edits.map((d) => d.file)).length, 'file')}`;
      const written = unique(edits.map((d) => d.file)).length;
      if (written) story = `Claude writes ${plural(written, 'file')}; ${story[0].toLowerCase()}${story.slice(1)}`;
      const saved = checks.reduce((n, e) => n + (e.commits ?? 0), 0);
      if (saved) {
        director += ` · ${plural(saved, 'commit')}`;
        if (ok)
          story = `${story.slice(0, -1)}, and Claude saves the work${checks.some((e) => e.ships === 'push') ? ' and sends it up' : ''}.`;
      }
      break;
    }
    case 'run':
      panel.notes = notesOf(evs);
      story = evs.every((e) => e.running)
        ? `Claude starts ${evs.length === 1 ? 'a command' : `${evs.length} commands`} in the background.`
        : errors && errors === evs.length
          ? `Claude tries ${evs.length === 1 ? 'a command' : `${evs.length} commands`}, and ${
              evs.some((e) => /\bblocked\b|PreToolUse|denied/i.test(e.output ?? ''))
                ? 'it is blocked'
                : evs.length === 1
                  ? 'it fails'
                  : 'they fail'
            }.`
          : evs.every((e) => e.tool !== 'Bash')
            ? 'Claude uses a tool.'
            : 'Claude works in the terminal.';
      director = `${tools} · ${shortCommand(evs[0])}${errors ? ` · ${plural(errors, 'error')}` : ''}`;
      break;
    case 'save': {
      panel.notes = notesOf(evs);
      const last = evs[evs.length - 1];
      if (last?.ok !== undefined) panel.ok = last.ok;
      const ships = evs.some((e) => e.ships === 'pr') ? 'pr' : evs.some((e) => e.ships === 'push') ? 'push' : '';
      // The command failed, but its own output shows the push (or the commit) went through: a step
      // chained after it failed, not the save.
      const out = last?.output ?? '';
      const savedAnyway =
        last?.ok === false &&
        (ships === 'push'
          ? /\[new branch\]|\S+\.\.\S+\s+\S+\s+->|\bset up to track\b|Everything up-to-date/.test(out)
          : /^\[[^\]\n]+ [0-9a-f]{7,}\]/m.test(out));
      if (savedAnyway) panel.ok = true;
      const commits = evs.reduce((n, e) => n + (e.commits ?? 0), 0);
      const inCommits = commits > 1 ? ` in ${commits} commits` : '';
      // A push of commits made earlier: nothing is saved here, only uploaded.
      const uploadOnly = ships === 'push' && !commits;
      // One commit: its message says what was saved.
      const subject = commits === 1 ? evs.find((e) => e.subject)?.subject : undefined;
      // Its conventional prefix (`feat:`, `chore(deps):`) is for git, not for the reader.
      const plainSubject = subject?.replace(/^[a-z]+(\([^)]*\))?!?:\s*/i, '');
      const said = plainSubject ? `: "${clip(plainSubject, 60).replace(/[.]$/, '')}"` : '';
      story = savedAnyway
        ? uploadOnly
          ? 'Claude uploads the work, but a step after that fails.'
          : ships === 'push'
            ? `Claude saves the work${inCommits} and uploads it, but a step after that fails.`
            : `Claude saves the work${inCommits}, but a step after that fails.`
        : panel.ok === false
          ? ships === 'pr'
            ? 'Claude tries to open a pull request, and the command fails.'
            : ships === 'push'
              ? 'Claude tries to upload the work, and the command fails.'
              : 'Claude tries to save the work, and the command fails.'
          : ships === 'pr'
            ? 'Claude opens a pull request.'
            : uploadOnly
              ? 'Claude uploads the work.'
              : ships === 'push'
                ? `Claude saves the work${inCommits} and uploads it${said}.`
                : `Claude saves the work${inCommits}${said}.`;
      const wrote = unique(edits.map((d) => d.file)).length;
      if (wrote && story.startsWith('Claude ')) story = `Claude writes ${plural(wrote, 'file')} and ${story.slice(7)}`;
      director = `${evs.map(shortCommand).slice(0, 2).join(' · ')}${errors ? ` · ${plural(errors, 'error')}` : ''}${
        edits.length ? ` · writes ${plural(unique(edits.map((d) => d.file)).length, 'file')}` : ''
      }`;
      break;
    }
    case 'ask': {
      const q = evs[0]?.question;
      if (q) panel.question = { text: q.text, answer: q.answer };
      const plan = evs[0]?.tool === 'ExitPlanMode';
      story = plan
        ? q?.answer === 'Approved'
          ? 'Claude shows you its plan, and you approve it.'
          : q?.answer
            ? 'Claude shows you its plan, and you send it back.'
            : 'Claude shows you its plan and waits for your OK.'
        : q?.answer
          ? 'Claude asks you, and you answer.'
          : 'Claude asks you something.';
      director = `${tools}${q?.answer ? ` · answer: ${clip(q.answer, 60)}` : ''}`;
      break;
    }
    case 'compact':
      story = evs.some((e) => e.label.includes('memory was full'))
        ? "Claude's memory is full: it packs up its notes."
        : 'Claude packs up its notes to free memory.';
      director = evs.map((e) => e.description).find(Boolean) ?? 'compact_boundary';
      break;
    case 'montage': {
      panel.notes = notesOf(evs.filter((e) => e.tool === 'Bash'));
      const added = evs.filter((e) => e.intent === 'prompt').length;
      story = `Claude ${index <= 1 ? 'gets started' : 'keeps going'}${added ? ` (you add ${plural(added, 'thing')})` : ''}: ${montageSummary(evs)}.`;
      break;
    }
    case 'complete':
      break;
  }
  panel.caption = { story, director };
  return panel;
}

function completePanel(turn: StoryTurn, page: Omit<StoryPage, 'panels'>, trailingSay?: string): StoryPanel {
  const running = page.helpersRunning;
  const commands = page.events.filter((e) => e.running && !e.helper).length;
  const later = page.events.filter((e) => e.finishedLater && e.intent !== 'prompt');
  const laterHelpers = later.filter((e) => e.helper).length;
  const laterCommands = later.length - laterHelpers;
  const done = turn.durationMs !== undefined ? `Done in ${roughDuration(turn.durationMs)}.` : 'Done.';
  // Where a stop landed: the step Claude last announced ("Step 3: …"), and what it had saved by then.
  const announced = [...page.events].reverse().find((e) => e.intent === 'say' && /^\W{0,4}step \d+\b/i.test(e.label));
  const step = announced ? /step (\d+)/i.exec(announced.label)?.[1] : undefined;
  const savedBefore = page.events.reduce((n, e) => n + (e.commits ?? 0), 0);
  const story = turn.interrupted
    ? `You stop Claude here${step ? `, during its step ${step}` : ''}.${
        savedBefore ? ` Saved before the stop: ${plural(savedBefore, 'commit')}.` : ''
      }`
    : page.noneWorked
      ? 'Nothing Claude tried worked, so the job is not done.'
      : turn.endedBy === 'next prompt'
        ? 'The trail stops here: the next prompt starts a new turn.'
        : running || commands
          ? `Claude's part is done${turn.durationMs !== undefined ? ` in ${roughDuration(turn.durationMs)}` : ''}. ${[
              running ? `${running === 1 ? 'A helper is' : `${running} helpers are`} still working.` : '',
              commands
                ? `${commands === 1 ? 'A command is' : `${commands} commands are`} still running in the background.`
                : '',
            ]
              .filter(Boolean)
              .join(' ')}`
          : later.length
            ? `Claude's part is done${turn.durationMs !== undefined ? ` in ${roughDuration(turn.durationMs)}` : ''}. ${[
                laterHelpers
                  ? `${laterHelpers === 1 ? 'Its helper' : `Its ${laterHelpers} helpers`} finished later and reported back.`
                  : '',
                laterCommands
                  ? `${laterCommands === 1 ? 'Its background command' : `${laterCommands} background commands`} finished later.`
                  : '',
              ]
                .filter(Boolean)
                .join(' ')}`
            : done;
  const director = [
    turn.endedBy === 'next prompt' ? 'superseded by the next prompt' : (turn.endedBy ?? 'turn_duration'),
    turn.durationMs !== undefined ? exactDuration(turn.durationMs) : '',
    plural(page.toolCalls, 'tool call'),
    page.filesChanged ? plural(page.filesChanged, 'file') + ' changed' : '',
    page.helpers ? plural(page.helpers, 'helper') : '',
    running ? `${running} still running` : '',
  ]
    .filter(Boolean)
    .join(' · ');
  const panel: StoryPanel = {
    kind: 'complete',
    events: [],
    caption: {
      story: turn.durationMs !== undefined && turn.durationMs < 1000 && story === done ? 'Done.' : story,
      director,
    },
  };
  // A local command answers itself: its own first line is the last word.
  const said = turn.endedBy === 'local command' ? turn.events[0]?.output?.split('\n')[0] : undefined;
  if (trailingSay) panel.balloon = { who: 'claude', text: trailingSay };
  else if (said) panel.balloon = { who: 'claude', text: clip(said, 160) };
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
  // Claude wrote its plan as a numbered list before starting work (no plan tool): draw it as one.
  for (const e of events) {
    if (e.intent === 'edit' || e.intent === 'test' || e.intent === 'build' || e.intent === 'save') break;
    if (e.intent !== 'say') continue;
    const todos = planFromText(e.label);
    if (todos) e.todos = todos;
  }

  const { panels: grouped, trailingSay, openNote } = groupPanels(events);
  const room = STORY_LIMITS.panelsPerPage - (turn.ended ? 1 : 0);
  const drafts = capPanels(collapseLoops(grouped), room);
  const panels = drafts.map((d, i) => decorate(d, events, turn, i));

  const edits = events.flatMap(editsOf);
  const base: Omit<StoryPage, 'panels'> = {
    ...summarizeTurn({ ...turn, events }),
    partial: turn.partial,
    truncated,
    events,
    filesChanged: unique(edits.map((e) => e.file)).length,
    added: edits.reduce((n, e) => n + e.added, 0),
    removed: edits.reduce((n, e) => n + e.removed, 0),
    // The advisor is a second opinion, not a helper that does work.
    helpers: events.filter((e) => e.helper && e.tool !== 'Advisor' && e.intent !== 'prompt').length,
    helpersRunning: events.filter((e) => e.helper?.running).length,
    ...(openNote && turn.ended && !turn.interrupted ? { openNote: true } : {}),
    ...(events.some((e) => e.finishedLater && e.intent !== 'prompt')
      ? { finishedLater: events.filter((e) => e.finishedLater && e.intent !== 'prompt').length }
      : {}),
  };
  const calls = events.filter((e) => !NOT_TOOL_CALLS.has(e.intent));
  if (calls.length && calls.every((e) => e.ok === false)) base.noneWorked = true;
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
  // One helper's whole run as one page: how it ended is the LAST turn's (the first one "ended" only
  // because the helper was messaged again, which would read as superseded).
  return buildStoryPage({
    ...first,
    events: turns.flatMap((t) => t.events),
    ended: finished ?? last.ended,
    endedBy: last.endedBy === 'next prompt' ? undefined : last.endedBy,
    interrupted: false,
    endedAt: last.endedAt,
    durationMs: undefined,
  });
}

/** The turn list for the page picker, newest last, capped. */
export function summarizeTurns(turns: StoryTurn[]): StoryTurnSummary[] {
  return turns.slice(-STORY_LIMITS.turnsListed).map(summarizeTurn);
}
