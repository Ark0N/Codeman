/**
 * @fileoverview One-time boot migration that lets the 1.50.0 agent skill default reach installs
 * that saved App Settings before it.
 *
 * `agentSkillEnabled` is ON by default since 1.50.0 (an absent key is on, only an explicit false
 * is off). Up to 1.49.0 the App Settings switch loaded an absent key as off (`?? false`) and Save
 * sends the whole form, so every install whose App Settings were ever saved holds an explicit
 * `false` the user may never have chosen, and the new default would never reach it. On the first
 * start of a server that has this module, a stored `false` is switched on, exactly once per data
 * dir. It cannot tell a deliberate off from the old default; that is accepted and stated as a
 * behaviour change in the release notes. An off set after this ran is never touched again.
 *
 * Why a stored `false` becomes `true` rather than being deleted: deleting it would not reach the
 * page. Every browser that saved App Settings keeps the form in its localStorage blob, and
 * `loadAppSettingsFromServer()` only overwrites a synced key the server HAS: a key the server
 * lacks keeps the device's `false`, the switch loads off, and the next Save of any setting writes
 * `false` back (measured with the real page code in the JSDOM harness of
 * test/agent-skill-setting-ui.test.ts, which pins the shipped shape). A stored `true` wins on
 * every device, including a browser still running a cached settings-ui.js from before the upgrade.
 * Every reader treats `true` and an absent key alike (`!== false`).
 *
 * Why the "done" marker is its own file (`agent-skill-default-migrated.json` in the data dir)
 * and not a key in settings.json:
 *  - it is not a setting, so `GET /api/settings` never returns it, the page never holds it, and
 *    the page's Save (rebuilt from the form) can neither send it back nor drop it; the `.strict()`
 *    `SettingsUpdateSchema` never sees it;
 *  - a PUT or any other settings.json writer cannot erase it, which would re-arm the migration and
 *    switch a deliberate later off back on;
 *  - it is not in `CONFIG_BACKUP_FILES` (like `config-backup-id`), so a restore leaves it alone:
 *    once the migration has run, a restored settings.json, even one from before 1.50.0 holding
 *    `false`, is what the user asked for and stays as restored.
 * A data dir is one instance, and settings.json is one file for the whole server, so in
 * multi-user mode this runs once for the server, never per user.
 *
 * Order: the marker is checked first (present: nothing is read), the settings change goes through
 * `mutateSettingsFile()` (serialized, atomic, refuses a file that does not parse), and the marker
 * is written only after that resolves. A refused or failed settings write writes no marker, so the
 * migration runs again at the next start (after the user fixed the file). Until then it has not
 * run, so an off saved after the fix and before that start is switched on with the rest: the same
 * "cannot tell" trade as above, in a window that needs an unparseable settings.json at the first
 * 1.50.0 start. A crash between the two writes is harmless: the next start finds `true` (nothing
 * to change) and writes the marker.
 *
 * Called once from `WebServer.start()`, before the first settings read and before the server
 * listens, so no request path can see the old value.
 */

import fs from 'node:fs/promises';
import { dirname } from 'node:path';
import { dataPath } from '../config/instance.js';
import { getErrorMessage } from '../types.js';
import { mutateSettingsFile, SettingsWriteRefusedError } from './settings-writer.js';

/** The marker's file name in the data dir. Never in CONFIG_BACKUP_FILES (see the file comment). */
export const AGENT_SKILL_DEFAULT_MARKER = 'agent-skill-default-migrated.json';

/**
 * - `switched-on`: settings.json held `agentSkillEnabled: false`; it now holds `true`.
 * - `nothing-to-change`: the key was absent or not `false` (or there is no settings.json); nothing was written to it.
 * - `already-done`: the marker exists; settings.json was not read.
 * - `refused`: settings.json could not be read, parsed or written, or the marker could not be checked.
 *   Nothing changed and no marker was written, so the next start tries again.
 */
export type AgentSkillDefaultMigration = 'switched-on' | 'nothing-to-change' | 'already-done' | 'refused';

/** The log line of a migration that switched the skill on. */
export const AGENT_SKILL_DEFAULT_MIGRATED_LOG =
  '[agent-skill] switched on the off stored before 1.50.0, so the new default applies (turn it off again under App Settings, Agents & CLIs, Codeman Agent Skill; that choice is kept)';

export async function migrateAgentSkillDefault(
  markerPath: string = dataPath(AGENT_SKILL_DEFAULT_MARKER)
): Promise<AgentSkillDefaultMigration> {
  try {
    await fs.lstat(markerPath);
    return 'already-done';
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      // Not knowing whether it ran must not switch a deliberate off on a second time.
      console.warn(`[agent-skill] default migration skipped: cannot check ${markerPath} (${getErrorMessage(err)})`);
      return 'refused';
    }
  }

  let switched = false;
  try {
    await mutateSettingsFile((current) => {
      if (current.agentSkillEnabled !== false) return undefined;
      switched = true;
      return { ...current, agentSkillEnabled: true };
    });
  } catch (err) {
    // A refusal is already logged by the writer (`[settings] write refused: ...`), with the fix.
    const why = err instanceof SettingsWriteRefusedError ? 'settings.json was left as it is' : getErrorMessage(err);
    console.warn(`[agent-skill] default migration skipped (${why}); it runs again at the next start`);
    return 'refused';
  }

  try {
    await fs.mkdir(dirname(markerPath), { recursive: true });
    const marker = { migratedAt: new Date().toISOString(), switchedOn: switched };
    await fs.writeFile(markerPath, `${JSON.stringify(marker, null, 2)}\n`, { mode: 0o600 });
  } catch (err) {
    // settings.json is already right; without the marker the next start runs again, which
    // changes nothing unless the user has switched it off by then.
    console.warn(`[agent-skill] could not record the default migration at ${markerPath}: ${getErrorMessage(err)}`);
  }

  if (switched) console.log(AGENT_SKILL_DEFAULT_MIGRATED_LOG);
  return switched ? 'switched-on' : 'nothing-to-change';
}
