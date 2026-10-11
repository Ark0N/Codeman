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
| `remote-hosts.json`, `docker-hosts.json`, `docker-cases.json` | Remote SSH and Docker overlay configuration. |
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
- **On demand**, with **Back up now** (always writes one, even if nothing changed).
- **Before a restore**, as a `pre-restore` safety copy of the files about to be replaced.

## Where they go and what they are called

The default folder is `<data dir>/backups/config` (`~/.codeman/backups/config`). You can point
it anywhere with an absolute path (a leading `~` is expanded). A path that is not absolute, or
that is the data directory itself, falls back to the default.

Each backup is one folder named for the moment it was made, in the server's local time:

```
~/.codeman/backups/config/
  cfg-20261011-120305/
    manifest.json        id, createdAt (epoch ms), reason, appVersion, SHA-256 + size per file
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
| `manifest.json` | The record of the backup: `reason`, `appVersion`, and a SHA-256 and size for every file. |
| `reason` | `startup`, `auto` (a change was detected), `manual` (Back up now) or `pre-restore`. It is in the manifest and the Settings list, not in the folder name. |
| `.tmp-…` | A backup being written. It is renamed into place when complete and is never listed. |

A folder counts as a backup only if its name matches that pattern **and** it has a valid
`manifest.json`. That is what makes it safe to point the folder at a directory that also holds
other things.

## Retention

Two limits, applied after every backup:

| Setting | Range | Default | Meaning |
| ------- | ----- | ------- | ------- |
| **Keep this many backups** (`configBackupKeepCount`) | 1 – 500 | 20 | Keep the newest N; older ones are removed. |
| **Delete backups older than (days)** (`configBackupKeepDays`) | 0 – 3650 | 30 | Also remove anything older than this. `0` means no age limit. |

Both apply together. Three guarantees:

- **The newest backup is never removed**, whatever the numbers say, so there is always one to
  go back to.
- **Only folders Codeman made are ever removed**, never anything else that happens to live in a
  custom folder.
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
| The list, with **Restore** per entry | | |

The settings are saved server-side and read fresh, so a change applies on the next pass. The
list and **Back up now** use the **saved** folder and retention: apply your edits first.

## Restoring

From the list, press **Restore** on a backup and confirm. Codeman then:

1. **Verifies** every file in the backup against the SHA-256 in its manifest. If any file is
   missing or does not match, nothing is changed and you get an error.
2. **Takes a `pre-restore` backup** of the files about to be replaced, so a restore can itself
   be undone.
3. **Replaces each file atomically** (written beside it, then renamed) with mode `0600`.

Only the tracked names are ever written, whatever a manifest lists.

Settings are re-read on the next request, so reload the page. `clis.json`, `users.json`,
`.env` and `push-keys.json` are read once per process: **restart Codeman** for those to take
effect (the response lists which). A restore does not touch running sessions.

You can also restore by hand: the files in a backup folder are the originals, so copying one back
over the file in the data directory is equivalent (stop Codeman first if you are replacing
`clis.json` or `users.json`).

## Security

- Some tracked files carry credentials (`.env`, `users.json`, `custom-model-hosts.json`,
  `push-keys.json`). Each backup folder is mode `0700` and its files `0600`, so the default
  location exposes nothing the data directory does not already.
- **A custom folder is your decision.** Putting it on a shared drive, a synced folder or a
  network share copies those credentials there, with whatever permissions that location has.
  Choose a private location, or turn the feature off if you cannot.
- In [multi-user mode](Multi-User-Mode) all of it is admin only: the list, Back up now and
  Restore.
- Listing returns file names and sizes, never contents.

## HTTP API

```bash
API=http://localhost:3000
curl -s "$API/api/config-backups" | jq                                  # settings, folder, list
curl -s -X POST "$API/api/config-backups" | jq                          # back up now
curl -s -X POST "$API/api/config-backups/cfg-20261011-120305/restore" | jq
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
