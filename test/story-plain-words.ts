/**
 * @fileoverview The Simple reading level's promise, as a check: a caption a reader who has never seen a
 * terminal can read. No path, code or file name, no tool name, no flag and no developer jargon. Used by
 * test/story-mode.test.ts and test/story-corpus.test.ts (helper only, no tests of its own).
 */

/** Claude Code's tool names: matched case-sensitively, so "Claude reads" is fine and "Read" is not. */
const TOOL_NAMES = [
  'Bash',
  'BashOutput',
  'KillShell',
  'Edit',
  'MultiEdit',
  'Write',
  'Read',
  'Grep',
  'Glob',
  'LS',
  'Task',
  'Agent',
  'WebFetch',
  'WebSearch',
  'TodoWrite',
  'NotebookEdit',
  'NotebookRead',
  'EnterPlanMode',
  'ExitPlanMode',
  'ToolSearch',
  'AskUserQuestion',
  'SlashCommand',
  'SendMessage',
  'Skill',
  'Advisor',
];

/** Words a developer reads past and a parent stops at. Whole words, any case. */
const JARGON = [
  'test suite',
  'tests?',
  'lint(?:s|er|ers|ing)?',
  'commits?',
  'committed',
  'repo(?:s|sitory|sitories)?',
  'branch(?:es)?',
  'diffs?',
  'API',
  'dependency',
  'dependencies',
  'builds?',
  'deploy(?:s|ed|ment)?',
  'terminal',
  'commands?',
  'scripts?',
  'code',
  'git',
  'push(?:es|ed)?',
  'pull request',
  'merge[sd]?',
  'compiles?',
  'server',
  'functions?',
  'JSON',
  'CLI',
  'shell',
  'flags?',
  'tool calls?',
  'exit code',
  'stdout',
  'stderr',
  'prompts?',
  'sessions?',
  'background',
  'mode',
  'context',
  'tokens?',
  'refactor\\w*',
  'modules?',
  'packages?',
  'install\\w*',
  'npm',
  'pytest',
  'node',
];
const JARGON_RE = new RegExp(`\\b(?:${JARGON.join('|')})\\b`, 'i');
const TOOL_RE = new RegExp(`\\b(?:${TOOL_NAMES.join('|')})\\b`);
/** A file name or extension (`a.py`, `README.md`, `.gitignore`): in prose a full stop is followed by a space. */
const FILE_RE = /\S*\.[A-Za-z0-9]\S*/;
/** A command-line flag: `-q`, `--json`. */
const FLAG_RE = /(?:^|\s)-{1,2}[A-Za-z]/;

/** What makes `text` unfit for the Simple level (the offending part), or null when it reads plainly. */
export function plainWordsProblem(text: string): string | null {
  if (!text.trim()) return '(empty)';
  for (const ch of ['/', '\\', '`', '|', '{', '}', '<', '>', '=', '_', '#', '$', '~', '*'])
    if (text.includes(ch)) return ch;
  for (const re of [FILE_RE, FLAG_RE, TOOL_RE, JARGON_RE]) {
    const m = re.exec(text);
    if (m) return m[0];
  }
  return null;
}
