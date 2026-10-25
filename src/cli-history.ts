/** Local offline transcript commands. Deliberately separate from the agent API guard. */
import type { Command } from 'commander';
import { formatLocalHistory, HISTORY_DEFAULT_SCAN_BYTES, readLocalHistory } from './local-history.js';

export function registerHistoryCommands(program: Command): Command {
  const history = program
    .command('history')
    .description('Read local saved native transcripts without a running server');
  history
    .command('read')
    .description('Read Codex history by file, native id, or root conversation and descendants')
    .option('--file <path>', 'Explicit local JSONL transcript (regular file only)')
    .option('--session-id <id>', 'Native Codex conversation UUID or unique prefix (at least 8 characters)')
    .option('--root-session-id <uuid>', 'Native root UUID, including transitive child conversations')
    .option('--sessions-root <path>', 'Local Codex sessions directory (default: CODEX_HOME/sessions)')
    .option('--topic <text>', 'Case-insensitive literal match, preserving whole matching turns')
    .option('--after <date>', 'Inclusive YYYY-MM-DD lower bound; preserves whole matching turns')
    .option('--before <date>', 'Inclusive YYYY-MM-DD upper bound; preserves whole matching turns')
    .option('--max-bytes <n>', 'Maximum complete output bytes (1–1048576)', '8192')
    .option(
      '--scan-bytes <n>',
      'Total metadata and selected transcript read budget (1–67108864)',
      String(HISTORY_DEFAULT_SCAN_BYTES)
    )
    .option('--format <format>', 'json or text', 'json')
    .option('--json', 'JSON output (also the default)')
    .action(async (options: Record<string, string | boolean | undefined>) => {
      try {
        const format = options.json ? 'json' : options.format;
        if (format !== 'json' && format !== 'text') throw new Error('--format must be json or text');
        const result = await readLocalHistory({
          file: options.file as string | undefined,
          sessionId: options.sessionId as string | undefined,
          rootSessionId: options.rootSessionId as string | undefined,
          sessionsRoot: options.sessionsRoot as string | undefined,
          topic: options.topic as string | undefined,
          after: options.after as string | undefined,
          before: options.before as string | undefined,
          scanBytes: Number(options.scanBytes),
        });
        program.configureOutput().writeOut?.(`${formatLocalHistory(result, format, Number(options.maxBytes))}\n`);
      } catch (error) {
        program.error(error instanceof Error ? error.message : String(error), { exitCode: 1, code: 'history.read' });
      }
    });
  return history;
}
