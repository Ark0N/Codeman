/**
 * @fileoverview Story Mode types: one Claude Code turn drawn as a comic page.
 *
 * Produced by the pure core in `src/story-mode.ts` and served by
 * `GET /api/sessions/:id/story` (`src/web/routes/story-routes.ts`). The shape is
 * EXPERIMENTAL (docs/api-reference.md), not part of the stable `/api/v1` contract yet.
 *
 * Every string in here comes from a transcript the agent wrote, so it is untrusted
 * text: the browser renders it with `textContent` only, and a file path in here is
 * opened through the existing file preview, never fetched directly.
 */

/** What one transcript event means, read from the tool name and, for Bash, the command. */
export type StoryIntent =
  | 'prompt'
  | 'read'
  | 'search'
  | 'look'
  | 'web'
  | 'plan'
  | 'say'
  | 'helper'
  | 'message'
  | 'edit'
  | 'test'
  | 'build'
  | 'run'
  | 'save'
  | 'ask'
  | 'compact'
  | 'interrupt'
  | 'notice'
  | 'tool';

/** The comic panel a run of events is drawn as. */
export type StoryPanelKind =
  | 'mission'
  | 'investigate'
  | 'research'
  | 'plan'
  | 'backup'
  | 'fix'
  | 'check'
  | 'loop'
  | 'run'
  | 'save'
  | 'ask'
  | 'compact'
  | 'montage'
  | 'complete';

export type StoryActor = 'you' | 'claude' | 'helper' | 'system';

/** Who started a turn: you, a background task reporting back, another session, or a schedule/SDK. */
export type StoryTurnOrigin = 'human' | 'task' | 'peer' | 'scheduled' | 'system';

/** One hunk of an edit, in the shape of Claude Code's `structuredPatch` (lines keep their ` `/`+`/`-` prefix). */
export interface StoryHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
  /** Lines appended at the end of the file (`>>`): where they start is not known, so no line numbers. */
  atEnd?: boolean;
}

/** What one Edit/Write call changed. Counts are exact even when `hunks` was cut to size. */
export interface StoryEdit {
  file: string;
  added: number;
  removed: number;
  created: boolean;
  hunks: StoryHunk[];
  truncated: boolean;
}

/** A helper (Agent/Task/Workflow call): what it was asked and what it answered. */
export interface StoryHelper {
  name: string;
  type: string;
  /** Claude's short description of the job ("Write a phone-size test"). */
  task?: string;
  prompt: string;
  result?: string;
  toolUses?: number;
  durationMs?: number;
  /** Claude Code's id for the helper; its own steps are at `GET /api/sessions/:id/story/helpers/<agentId>`. */
  agentId?: string;
  /** Started in the background: Claude went on working, and the answer comes later in a notification. */
  background?: boolean;
  /** A background helper that has not reported back yet. */
  running?: boolean;
}

export interface StoryTests {
  passed: number;
  failed: number;
  /** Errors outside the tests (pytest's collection errors): the run failed although no test did. */
  errors?: number;
}

export interface StoryTodo {
  text: string;
  done: boolean;
}

/** One row of "the wire": a prompt, a sentence Claude said, or one tool call with its result. */
export interface StoryEvent {
  id: string;
  at: string;
  actor: StoryActor;
  tool: string;
  label: string;
  intent: StoryIntent;
  /**
   * False when the call failed: its result was flagged as an error, or it reported failed tests (an
   * exit code a pipe hid). Absent while the call is still running.
   */
  ok?: boolean;
  pending?: boolean;
  /** The one file this event concerns (Read, Edit, Write), as the transcript gave it. */
  file?: string;
  /** Files a Bash call printed (`cat a b`, `head -n 20 c`), as the command named them (maybe relative). */
  files?: string[];
  line?: number;
  /** Claude's own short description of a Bash call ("Run the test suite"). */
  description?: string;
  /** A command sent to the background ("Command running in background") that has not reported back. */
  running?: boolean;
  /** A command that ran in the background (its result came back later, as a report of its own). */
  background?: boolean;
  /** Background work (this command, or this helper call's helper) that finished after its turn ended. */
  finishedLater?: boolean;
  /**
   * Sentences from further into a long message that a reader must not lose: an open problem, a step
   * not taken, what you asked for. From the whole message, past the clip of `label`.
   */
  keyPoints?: string[];
  /** A save that ships the work: `gh pr create` (`pr`) or `git push` (`push`). */
  ships?: 'pr' | 'push';
  /** How many commits a Bash call makes (`git commit` segments). */
  commits?: number;
  /** The first commit's message, when the command spells it out (`-m "..."` or a here-document). */
  subject?: string;
  /** Who a prompt came from (a prompt added mid-turn can come from someone other than the turn's starter). */
  origin?: StoryTurnOrigin;
  output?: string;
  outputTruncated?: boolean;
  edit?: StoryEdit;
  /** Files a Bash call wrote through a here-document (`cat > f <<'EOF'`), each as a whole-file edit. */
  edits?: StoryEdit[];
  /** The part of a Bash one-liner that decided its intent (the test run, the commit), for captions. */
  headline?: string;
  helper?: StoryHelper;
  tests?: StoryTests;
  todos?: StoryTodo[];
  question?: { text: string; options: string[]; answer?: string };
}

export interface StoryPanel {
  kind: StoryPanelKind;
  /** Indices into the page's `events`. */
  events: number[];
  caption: { story: string; director: string };
  /** `note`: words that start a turn but are not yours (a background job's report, another session). */
  balloon?: { who: 'you' | 'claude' | 'note'; text: string };
  files?: string[];
  notes?: string[];
  /** What a run panel's last command printed, for its terminal card: the first lines, the last ones when it failed. */
  printed?: string[];
  helpers?: Array<{ name: string; type: string; task?: string; event: number }>;
  added?: number;
  removed?: number;
  ok?: boolean;
  rounds?: number;
  /** A loop's test runs in order: whether each passed, `null` for one still running. */
  roundsOk?: (boolean | null)[];
  tests?: StoryTests;
  todos?: StoryTodo[];
  question?: { text: string; answer?: string };
  /** The turn is still running and this is its newest panel. */
  live?: boolean;
}

export interface StoryTurnSummary {
  id: string;
  at: string;
  prompt: string;
  origin: StoryTurnOrigin;
  complete: boolean;
  interrupted: boolean;
  /** Ended only because the next prompt started (no end marker of its own: an abandoned or crashed turn). */
  superseded?: boolean;
  toolCalls: number;
}

export interface StoryPage extends StoryTurnSummary {
  endedAt?: string;
  durationMs?: number;
  /** The turn began before the part of the transcript that was read. */
  partial: boolean;
  /** Older events, outputs or hunks were dropped to keep the page small. */
  truncated: boolean;
  panels: StoryPanel[];
  events: StoryEvent[];
  filesChanged: number;
  added: number;
  removed: number;
  helpers: number;
  /** Background helpers that had not reported back when this page was drawn. */
  helpersRunning: number;
  /** Helpers and background commands of this turn that finished only after it ended. */
  finishedLater?: number;
  /** Claude's last words leave something open: `catch` a problem, `note` something not done or checked yet. */
  openNote?: 'catch' | 'note';
  /** Claude's last words ask you something or offer more: the next move is yours. */
  asks?: boolean;
  /** Every tool call of the turn failed (a blocked command, nothing that worked): no celebration. */
  noneWorked?: boolean;
}

/** `GET /api/sessions/:id/story/helpers/:agentId`: one helper's own steps, as one page. */
export type StoryHelperResponse =
  | { supported: false; reason: string }
  | {
      supported: true;
      helper: { agentId: string; type?: string; description?: string; finished?: boolean };
      page: StoryPage | null;
    };

export type StoryResponse =
  | { supported: false; reason: string }
  | {
      supported: true;
      turns: StoryTurnSummary[];
      page: StoryPage | null;
      /** The transcript is longer than the part that was read: older turns are not listed. */
      older?: boolean;
    };
