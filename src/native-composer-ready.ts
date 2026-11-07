/** Pure empty-composer proof shared by settings and queued follow-ups. */
import { getCli } from './config/cli-registry/registry.js';
import { readGuardedComposer } from './agent-staging.js';
import { stripAnsi } from './utils/regex-patterns.js';
export function nativeModelComposerReady(mode: string, raw: string): boolean {
  const profile = getCli(mode)?.capabilities.nativeSettingsProfile;
  if (!profile) return false;
  if (/\besc to interrupt\b/i.test(stripAnsi(raw).split('\n').slice(-12).join('\n'))) return false;
  const rows = raw.split('\n');
  let composer = -1;
  for (let i = rows.length - 1; i >= 0; i--) {
    if (
      stripAnsi(rows[i])
        .trimStart()
        .startsWith(profile === 'codex-tui' ? '›' : '❯')
    ) {
      composer = i;
      break;
    }
  }
  // Claude can add a fourth noninteractive footer row inside tmux. Remove only
  // that exact known hint, never a composer/draft row or arbitrary terminal text.
  const screen =
    profile === 'claude-tui'
      ? rows
          .filter(
            (row, index) =>
              index <= composer ||
              !/^\s*tmux focus-events off · add 'set -g focus-events on' to ~\/\.tmux\.conf and reattach for focus tracking\s*$/.test(
                stripAnsi(row)
              )
          )
          .join('\n')
      : raw;
  return (
    readGuardedComposer(screen, {
      promptGlyph: profile === 'codex-tui' ? '›' : '❯',
      footerLine:
        profile === 'codex-tui'
          ? /^\s*(?:.* · .*|.*\? for shortcuts.*|.*← for agents.*)$/
          : /^\s*(?:.*\? for shortcuts.*|.*(?:bypass permissions|accept edits|plan mode|shift\+tab|ctrl\+t|context left).*|─+|(?:Fable|Opus|Sonnet|Haiku)\s+\d+(?:\.\d+)?(?:\s+\([^\n)]{1,40}\))?\s+in:[\d,]+\s+out:[\d,]+(?:\s+ctx:\d{1,3}%)?(?:\s+cache:[^\n]{0,40})?(?:\s+Not logged in · Run \/login)?)$/i,
    }) === ''
  );
}
