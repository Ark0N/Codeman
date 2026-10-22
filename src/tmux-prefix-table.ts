/**
 * @fileoverview Keep tmux's prefix table on Codeman's socket down to `send-prefix`.
 *
 * Codeman drives tmux through commands, never through key bindings, but every
 * keystroke typed into a browser terminal reaches the `tmux attach-session`
 * client behind it. With tmux's stock prefix table that client obeys the whole
 * menu: Ctrl+B then `(`, `)`, `L`, `s` or `w` runs `switch-client` /
 * `choose-tree` and re-attaches the tab's client to a DIFFERENT session, so the
 * tab shows, and types into, another session's agent while Codeman still labels
 * it as the original. Ctrl+B `d` detaches the client, `$` renames the session
 * under Codeman's feet, `:` opens tmux's command prompt. Ctrl+B is not a rare
 * key in a terminal (readline backward-char, Claude Code's background chord),
 * and whatever is typed next lands in that menu.
 *
 * The prefix itself stays: Claude Code running inside tmux asks for
 * "ctrl+b ctrl+b" to background a command, which only works through
 * `send-prefix`. So the table keeps exactly that one binding, on whatever key
 * the socket's prefix is (the socket reads the user's `~/.tmux.conf`).
 *
 * `codeman tui` shares the socket (src/tui/tui-app.ts, beginAttachHandoff). For
 * the length of an attach it claims a held-Ctrl detach alias (`C-d`) in the
 * prefix table, and its one-key way out (F1) and Alt+1..9 in the `root` table.
 * `root` is never touched here, and a `C-<letter> detach-client` binding is left
 * alone (and put back when a reset clears the rest of the table around it), so
 * creating a session while a TUI attach is open does not take the attach's way
 * out away. The reset only runs while the table holds anything else, i.e. once
 * per tmux server in practice.
 *
 * That tolerance is server-wide like every key table: while such an alias is
 * bound, a browser tab's client can detach itself with it too. The same goes
 * for the `root` keys an attach claims, including Alt+1..9, which run
 * `switch-client`: a tab that receives Esc then a digit within tmux's
 * `escape-time` is moved onto another session for as long as those bindings
 * exist. Leaving `root` alone keeps the attach working; it does not close that.
 *
 * @module tmux-prefix-table
 */

import { execSync } from 'node:child_process';
import { EXEC_TIMEOUT_MS } from './config/exec-timeout.js';
import { shellescape } from './remote-hosts.js';

/** tmux's stock prefix, used when `show-options` cannot be read. */
const DEFAULT_PREFIX = 'C-b';

/** One `list-keys -T prefix` line: key and command. */
const PREFIX_LINE = /^bind-key\s+(?:-\S+\s+)*?-T\s+prefix\s+(\S+)\s+(.+)$/;

/** The held-Ctrl detach alias `codeman tui` claims during an attach (heldCtrlAlias). */
const TUI_DETACH_ALIAS = /^C-[a-z]$/;

/**
 * A key as `list-keys` prints it, without tmux's backslash escaping: `show-options`
 * prints the prefix `C-\` as is, while the listing shows `C-\\` (and `\#`, `\$`, `\"`).
 */
function unescapeListedKey(key: string): string {
  return key.replace(/\\(.)/g, '$1');
}

/**
 * Whether the prefix table (as printed by `tmux list-keys -T prefix`) still holds
 * a binding other than `<prefix> send-prefix` or a TUI detach alias, or lacks
 * `<prefix> send-prefix`. Unparseable output counts as "needs a reset":
 * resetting is idempotent, skipping one leaves `switch-client` reachable from
 * the browser. A prefix of `None` expects no `send-prefix` binding at all.
 */
export function prefixTableNeedsReset(listKeysOutput: string, prefix: string = DEFAULT_PREFIX): boolean {
  let hasSendPrefix = false;
  for (const raw of listKeysOutput.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const match = PREFIX_LINE.exec(line);
    if (!match) return true;
    const key = unescapeListedKey(match[1]);
    const command = match[2].trim();
    if (command === 'send-prefix' && key === prefix) {
      hasSendPrefix = true;
      continue;
    }
    if (command === 'detach-client' && TUI_DETACH_ALIAS.test(key) && key !== prefix) continue;
    return true;
  }
  return prefix === 'None' ? false : !hasSendPrefix;
}

/** The `C-<letter> detach-client` bindings in a `list-keys -T prefix` listing (see prefixTableNeedsReset). */
function tuiDetachAliases(listKeysOutput: string, prefix: string): string[] {
  const keys: string[] = [];
  for (const raw of listKeysOutput.split('\n')) {
    const match = PREFIX_LINE.exec(raw.trim());
    if (!match) continue;
    const key = unescapeListedKey(match[1]);
    if (match[2].trim() === 'detach-client' && TUI_DETACH_ALIAS.test(key) && key !== prefix) keys.push(key);
  }
  return keys;
}

/** Runs one tmux command line and returns its stdout. */
export type TmuxRunner = (command: string) => string;

const defaultRunner: TmuxRunner = (command) =>
  execSync(command, { encoding: 'utf8', timeout: EXEC_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'ignore'] });

/**
 * Reduce the prefix table of the tmux server behind `tmux` (e.g. `tmux -L 'codeman'`)
 * to `<prefix> send-prefix`, when it holds anything more. Never throws: a failure
 * only leaves tmux's stock bindings in place. Returns whether a reset ran.
 */
export function restrictTmuxPrefixTable(tmux: string, run: TmuxRunner = defaultRunner): boolean {
  let prefix = DEFAULT_PREFIX;
  try {
    prefix = run(`${tmux} show-options -gv prefix`).trim() || DEFAULT_PREFIX;
  } catch {
    /* keep tmux's stock prefix */
  }
  let listing: string | null;
  try {
    listing = run(`${tmux} list-keys -T prefix`);
  } catch {
    listing = null; // an empty table makes list-keys fail on some tmux builds
  }
  if (listing !== null && !prefixTableNeedsReset(listing, prefix)) return false;
  try {
    run(`${tmux} unbind-key -a -T prefix`);
  } catch {
    /* an empty table makes unbind-key -a fail too ("table prefix doesn't exist"); nothing to clear */
  }
  try {
    if (prefix !== 'None') run(`${tmux} bind-key -T prefix ${shellescape(prefix)} send-prefix`);
    // `unbind-key -a` also took a running TUI attach's held-Ctrl way out; give it back.
    for (const key of tuiDetachAliases(listing ?? '', prefix)) {
      run(`${tmux} bind-key -T prefix ${shellescape(key)} detach-client`);
    }
    return true;
  } catch {
    return false;
  }
}
