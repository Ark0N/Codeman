# Config Backups

Codeman keeps timestamped copies of the files that hold what you have customized, so a bad
write, a hand edit or a botched restart can be undone. It is on by default, needs no setup,
and everything about it (where the copies go, how many are kept, how long) is a setting.

## What is backed up

A fixed list of files from the data directory (`~/.codeman/`, or the directory of the
[instance](Core-Concepts#instances) you run):

| File | What it holds |
| ---- | ------------- |
| `settings.json` | Your preferences that sync across devices, including model and CLI settings. |
| `clis.json` | CLI enable/disable and custom CLI entries. |
| `custom-model-hosts.json` | Saved custom model endpoints. **Holds API keys.** |
| `webhook.json` | Webhook notification target. |
| `intents.json` | Read My Mind per-case profiles. |
| `linked-cases.json` | Registered cases. |
| `remote-hosts.json`, `remote-cases.json`, `docker-hosts.json`, `docker-cases.json` | Remote SSH and Docker overlay configuration. |
| `webviews.json` | Saved dashboard URLs. |
| `push-keys.json` | Web-push keys (regenerating them drops every device's subscription). |
| `users.json` | Multi-user accounts. **Holds password hashes.** |
| `.env` | Credentials the TUI client reads. **Holds a password.** |

Only files that exist are included. This is an allowlist: nothing else in the data
directory is ever copied.

**Not backed up:** `state.json` (sessions, and also cron jobs and respawn presets: it is rewritten
with every session event, so it would bury the real changes), logs, `mux-sessions.json`, the hook
secret, Docker seeds and caches. Back `state.json` up with your normal file backups if you rely on
cron jobs.

## When a backup is made

- **At startup**, so the state the server found is always on record.
- **Whenever the content changes.** The files are read and hashed every five minutes; a new
  backup is written only if the set differs from the latest backup. An idle server writes
  nothing, and the history is one entry per real change rather than one per timer tick.
  A field a file rewrites on its own is not a change, and the comparison looks through it (the
  snapshot still stores the file exactly as written, and a restore puts those fields back as they
  were): `custom-model-hosts.json` `lastDiscoveredAt` (the model-discovery poll, every five
  minutes), `users.json` `lastLoginAt`, `settings.json` `lastUsedCase`, `intents.json`
  `recentPrompts` and `updatedAt` (every captured prompt) and `docker-cases.json`
  `lastClaudeSessionId` (a Docker case's conversation id after a `/clear`) and `webviews.json`
  `lastOpenedAt` (opening a web tab). Without that, every
  tick looked like an edit and 20 copies covered only about 100 minutes. So Compare shows
  `intents.json` as unchanged when only prompts differ, yet a restore drops the prompts captured
  since.
- **On demand**, with **Back up now** (always writes one, even if nothing changed).
- **Before a restore**, as a `pre-restore` safety copy of the files about to be replaced (unless
  nothing changed since the newest backup).

## Where they go and what they are called

The default folder is `<data dir>/backups/config` (`~/.codeman/backups/config`). You can point
it anywhere with an absolute path (a leading `~` is expanded). A path that is not absolute, or
that is the data directory itself, falls back to the default.

Each backup is one folder named for the moment it was made, in the server's local time:

```
~/.codeman/backups/config/
  cfg-20261011-120305/
    manifest.json        id, createdAt (epoch ms), reason, appVersion, hash, origin,
                         keepCount and keepDays in force, SHA-256 + size per file
    settings.json        the original file names, unchanged
    clis.json
    custom-model-hosts.json
    ...
  cfg-20261011-123012/
  cfg-20261011-123012-2/   a second backup in the same second gets -2, -3, ...
```

| Part | Meaning |
| ---- | ------- |
| `cfg-YYYYMMDD-HHMMSS` | Date and time (server local time) the backup was made. A collision in the same second gets `-2`, `-3`, … |
| `manifest.json` | The record of the backup: `reason`, `appVersion`, the change-check `hash`, the `origin` id, the retention in force (`keepCount`, `keepDays`), and a SHA-256 and size for every file. |
| `reason` | `startup`, `auto` (a change was detected), `manual` (Back up now) or `pre-restore`. It is in the manifest and the Settings list, not in the folder name. |
| `.tmp-…` | A backup being written. It is renamed into place when complete and is never listed. |

A folder counts as a backup only if its name matches that pattern **and** it has a valid
`manifest.json`. That is what makes it safe to point the folder at a directory that also holds
other things.

## Retention

Two limits, applied after every backup:

| Setting | Range | Default | Meaning |
| ------- | ----- | ------- | ------- |
| **Keep this many backups** (`configBackupKeepCount`) | 2 – 500 | 20 | Keep the newest N; older ones are removed. (1 is not offered: every change would delete the state before it.) |
| **Delete backups older than (days)** (`configBackupKeepDays`) | 0 – 3650 | 30 | Also remove a backup once it has been replaced for longer than this. `0` means no age limit. |

Both apply together. Four guarantees:

- **The newest backup is never removed**, whatever the numbers say, so there is always one to
  go back to.
- **Only folders Codeman made are ever removed**, never anything else that happens to live in a
  custom folder.
- **Age counts from when a backup was replaced**, not from when it was made. Backups are made on
  change, so a config that stays the same for months has one backup whose own date keeps
  ageing; it is the copy you need the day something goes wrong, so it stays until a newer one
  has existed for longer than the limit.
- Because backups are made on change, 20 backups reach back across 20 *changes*, however long
  that took, not 20 timer ticks.

## Settings → System → Config backups

| Control | Setting | Default |
| ------- | ------- | ------- |
| Back up my configuration | `configBackupEnabled` | On (absent means on) |
| Backup folder | `configBackupDir` | empty = `<data dir>/backups/config` |
| Keep this many backups | `configBackupKeepCount` | 20 |
| Delete backups older than (days) | `configBackupKeepDays` | 30 |
| **Back up now** | | |
| The list, with **Restore**, **Compare with current** and **Changes in this backup** per entry | | |
| **Compare** … with … **Show changes** | | |

The settings are saved server-side and read fresh, so a change applies on the next pass. The
list and **Back up now** use the **saved** folder and retention: apply your edits first.

## Restoring

From the list, press **Restore** on a backup and confirm. Codeman then:

1. **Verifies** every file in the backup against the SHA-256 in its manifest. If any file is
   missing or does not match, nothing is changed and you get an error. It also refuses a backup
   folder or file that is a symlink or that group or others can read or write (Codeman never
   makes one like that, and writing it back as `0600` would turn it into trusted config). The
   permission test is skipped when the backup folder's filesystem does not keep file modes
   (FAT/exFAT drives, SMB shares, WSL's `/mnt/d` without the `metadata` option report the same
   mode for every file, so it would refuse every backup there). The symlink test is not. Compare
   applies the same checks to the backups it reads.
2. **Takes a `pre-restore` backup** of the files about to be replaced, so a restore can itself
   be undone. When nothing changed since the newest backup (the same comparison an automatic
   backup makes), no copy is made and the response names that backup instead (`safetySnapshot`).
3. **Replaces each file atomically** (written beside it, then renamed) with mode `0600`.

Only the tracked names are ever written, whatever a manifest lists.

If a file cannot be written (a full disk, a folder where the file should be), the restore still
writes the others and then reports an error that names the files it restored, the ones it could
not write, and the backup that holds the files as they were before. The restored files are in
effect as after a full restore (Settings re-reads `settings.json` into the form), so fix the cause
and restore again, or restore that backup to go back.

Restoring `settings.json` keeps the four backup settings (on or off, folder, how many, how many
days) at their current values, so a restore from before a folder change does not point the list
at the old folder and hide the `pre-restore` copy it just made. The exception is the two
retention values: where the live `settings.json` lacks one (a reset file), the restore keeps the
backup's own, key by key, so the next pass does not fall back to 20 copies and 30 days. The
`pre-restore` copy records the retention in force too.

Settings are re-read on the next request, so reload the page. `.env` and `push-keys.json` are
read once per process: **restart Codeman** for those to take effect (the response lists which).
`clis.json` is reloaded by the restore itself and `users.json` is re-read within a second. Restoring `settings.json` also does not re-run the switches
that saving in Settings applies at once (file watchers and the like), so those apply after a
restart, and `settings.json` is listed with the restart-required files. A restore does not touch
running sessions.

When the backup folder is shared (a synced folder used by two machines, or prod and a beta),
each snapshot records a random id that the instance made once and keeps in its data directory
(`config-backup-id`; not the hostname, which a Docker container changes on every recreate). Every
instance only snapshots, lists, prunes, compares and restores its own. Deleting that file makes
the instance a new owner, and its earlier snapshots stop being listed (they stay on disk). The
same happens after a reinstall of the data directory. To see them again, copy the `origin` value
from any of their `manifest.json` files into `<data dir>/config-backup-id`.

You can also restore by hand: the files in a backup folder are the originals, so copying one back
over the file in the data directory is equivalent (stop Codeman first if you are replacing
`clis.json` or `users.json`).

## Comparing backups

Before you restore, or to find out what changed and when, use **Compare** in the list:

- **Compare with current** on a backup shows what differs between that backup and the config
  running now. A restore puts back the files the backup holds; files created since are left as
  they are, and the restore response names them (`untouched`).
- **Changes in this backup** shows what differs between the backup before it and this one.
- The **Compare … with … Show changes** pickers compare any two backups, or a backup with the
  current config.

Each file that differs is listed with its changed keys (`theme.mode`, `tags[1]`, a variable name
in `.env`) as before → after, plus files that appeared or vanished between the two states. Files
that are the same are listed on one line. A file that is not JSON shows only that it differs, and
a file with more than 200 changes is cut short, so use the files themselves for a full diff. The
self-rewritten fields listed under "When a backup is made" are not counted as changes.

**Credential values are never shown.** `.env`, `users.json`, `push-keys.json`, `webhook.json` (the
URL is a bearer secret) and `intents.json` (captured prompts) list only the names that changed, and in every other file a key that looks like a token, secret, password,
credential or key is shown as "changed" without its value. URL values lose any `user:password@`,
query and fragment.

## Security

- Some tracked files carry credentials (`.env`, `users.json`, `custom-model-hosts.json`,
  `push-keys.json`, `webhook.json`). Each backup folder is mode `0700` and its files `0600`, so the default
  location exposes nothing the data directory does not already.
- **A custom folder is your decision.** Putting it on a shared drive, a synced folder or a
  network share copies those credentials there, with whatever permissions that location has.
  Choose a private location, or turn the feature off if you cannot.
- **Retention survives a bad `settings.json`.** If it does not parse, a pass still takes its
  snapshot but deletes nothing. If a retention setting is missing (a reset file), the pass
  prunes with the retention the newest backup that recorded one holds, not the 20 copies and 30
  days defaults, and Settings shows those values. Saving sends a retention value only if it was
  saved before or you edited it there, so saving other settings (or re-entering a custom folder
  after a reset) does not write the displayed 20 and 30 over it; the first pass in the re-entered
  folder finds the retention its own backups recorded. While `settings.json` does not
  parse, a pass reads it as empty, so its snapshot goes to the default folder even if a custom
  folder is set or backups are switched off; nothing is widened (same modes, inside the data
  directory).
- **Anyone who can write to a custom backup folder can plant a backup that Restore applies.**
  Restore refuses symlinks and files others can write, but a file of your own user's making
  passes, so keep the folder private.
- In [multi-user mode](Multi-User-Mode) all of it is admin only: the list, Back up now,
  Restore and Compare, and each restore is written to the admin audit log
  (`config_backup_restore`).
- Listing returns file names and sizes, never contents. A comparison returns changed values but
  never a credential's (see [Comparing backups](#comparing-backups)).

## HTTP API

```bash
API=http://localhost:3000
curl -s "$API/api/config-backups" | jq                                  # settings, folder, list
curl -s -X POST "$API/api/config-backups" | jq                          # back up now
curl -s -X POST "$API/api/config-backups/cfg-20261011-120305/restore" | jq
curl -s "$API/api/config-backups/diff?from=cfg-20261011-120305" | jq   # that backup vs the running config
curl -s "$API/api/config-backups/diff?from=cfg-20261011-120305&to=cfg-20261012-090000" | jq
```

See [HTTP API](HTTP-API) and the endpoint reference in `docs/api-reference.md`.

## Troubleshooting

- **The list is empty.** None of the tracked files existed yet, or backups are turned off. Press
  **Back up now**.
- **"Backups are not available here".** You are not an admin in multi-user mode.
- **No new backup after I changed a setting.** Changes are picked up within five minutes; **Back up
  now** takes one immediately.
- **A restore said a file does not match its checksum.** The backup was altered or damaged on
  disk. Nothing was changed; restore an earlier one.
- **The backups folder is growing.** Lower **Keep this many backups**. Each backup is a few
  kilobytes, but `custom-model-hosts.json` and `intents.json` can be larger.
- **I want my own off-machine copy.** Point the folder at a location your backup tool already
  covers, mind the Security note above, and keep **Keep this many backups** high enough that
  your tool sees each one.

## Read next

- [Settings Reference](Settings-Reference) - where the controls live.
- [Core Concepts](Core-Concepts) - what is on disk.
- [Security](Security) - what is protected and how.
- [Troubleshooting](Troubleshooting) - "my settings were reset".
