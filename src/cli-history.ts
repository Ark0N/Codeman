/**
 * @fileoverview `codeman history read`: the command-line front of the offline
 * Codex history reader (`local-history.ts`).
 *
 * Deliberately separate from `codeman agent` (`cli-agent.ts`): that command is
 * a client of a running Codeman and refuses outside a managed session, while
 * this one reads rollout files from disk and needs neither a server nor
 * `CODEMAN_MUX`. It never writes, never inspects a live pane and never sends
 * input.
 *
 * Every bound the reader enforces has a flag here with the reader's own
 * maximum, so a large store is a matter of raising a number rather than an
 * impossible lookup. Output is JSON unless `--format text` is given; `--json`
 * is the JSON spelling and refuses to combine with `--format text`.
 *
 * @module cli-history
 */
import type { Command } from 'commander';
import {
  formatLocalHistory,
  HISTORY_DEFAULT_MAX_ENTRIES,
  HISTORY_DEFAULT_METADATA_BYTES,
  HISTORY_DEFAULT_OUTPUT_BYTES,
  HISTORY_DEFAULT_SCAN_BYTES,
  HISTORY_MAX_ENTRIES,
  HISTORY_MAX_METADATA_BYTES,
  HISTORY_MAX_OUTPUT_BYTES,
  HISTORY_MAX_SCAN_BYTES,
  readLocalHistory,
  validateOutputBytes,
} from './local-history.js';

/**
 * A budget flag's value as a number. Only plain decimal digits count, so `0x10`,
 * `1e3` and ` 5 ` are refused rather than read as 16, 1000 and 5; anything else
 * becomes NaN, which the reader's range check rejects with the flag's name.
 */
function budgetFlag(value: string | boolean | undefined): number {
  return typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : NaN;
}

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
    .option(
      '--sessions-root <path>',
      'Local Codex sessions directory (default: $CODEX_HOME/sessions, else ~/.codex/sessions)'
    )
    .option('--topic <text>', 'Case-insensitive literal match, preserving whole matching turns')
    .option('--after <date>', 'Inclusive YYYY-MM-DD lower bound, as a UTC date; preserves whole matching turns')
    .option('--before <date>', 'Inclusive YYYY-MM-DD upper bound, as a UTC date; preserves whole matching turns')
    .option(
      '--max-bytes <n>',
      `Maximum complete output bytes (1-${HISTORY_MAX_OUTPUT_BYTES})`,
      String(HISTORY_DEFAULT_OUTPUT_BYTES)
    )
    .option(
      '--scan-bytes <n>',
      `Read budget for the selected transcripts (1-${HISTORY_MAX_SCAN_BYTES})`,
      String(HISTORY_DEFAULT_SCAN_BYTES)
    )
    .option(
      '--metadata-bytes <n>',
      `Read budget for attributing every rollout in the store (1-${HISTORY_MAX_METADATA_BYTES})`,
      String(HISTORY_DEFAULT_METADATA_BYTES)
    )
    .option(
      '--max-entries <n>',
      `Directory entries visited in the store (1-${HISTORY_MAX_ENTRIES})`,
      String(HISTORY_DEFAULT_MAX_ENTRIES)
    )
    .option('--format <format>', 'json or text', 'json')
    .option('--json', 'JSON output (the default; conflicts with --format text)')
    .action(async (options: Record<string, string | boolean | undefined>, command: Command) => {
      try {
        if (options.format !== 'json' && options.format !== 'text') throw new Error('--format must be json or text');
        if (options.json && options.format === 'text' && command.getOptionValueSource('format') === 'cli')
          throw new Error('--json conflicts with --format text; pass one of them');
        const format = options.format;
        // Every flag is checked before the first file is read: --max-bytes would otherwise
        // only be judged after the whole store had been scanned.
        const maxBytes = budgetFlag(options.maxBytes);
        validateOutputBytes(maxBytes);
        const result = await readLocalHistory({
          file: options.file as string | undefined,
          sessionId: options.sessionId as string | undefined,
          rootSessionId: options.rootSessionId as string | undefined,
          sessionsRoot: options.sessionsRoot as string | undefined,
          topic: options.topic as string | undefined,
          after: options.after as string | undefined,
          before: options.before as string | undefined,
          scanBytes: budgetFlag(options.scanBytes),
          metadataBytes: budgetFlag(options.metadataBytes),
          maxEntries: budgetFlag(options.maxEntries),
        });
        program.configureOutput().writeOut?.(`${formatLocalHistory(result, format, maxBytes)}\n`);
      } catch (error) {
        program.error(error instanceof Error ? error.message : String(error), { exitCode: 1, code: 'history.read' });
      }
    });
  return history;
}
