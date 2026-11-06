# Saved Codex history (offline)

Use `codeman history read` for retained local Codex JSONL transcripts. This command
works outside a managed session and never calls the HTTP API. Do not bootstrap
API credentials or require `CODEMAN_MUX` for this read-only job.

Choose exactly one selector:

```bash
codeman history read --file /path/to/rollout.jsonl
codeman history read --session-id aaaaaaaa --sessions-root /path/to/sessions
codeman history read --root-session-id aaaaaaaa-1111-4111-8111-111111111111 \
  --topic 'authentication' --after 2026-10-01 --before 2026-10-24 \
  --max-bytes 65536
```

`--session-id` accepts a native conversation UUID or unique prefix of at least
8 characters; identity comes from metadata, not filenames. `--root-session-id`
requires a full native UUID and includes transitive descendants found in metadata
(spawned sub-agents and forks). The default store is `$CODEX_HOME/sessions`, or
`~/.codex/sessions` when unset; a store directory that is itself a symlink is
followed, links inside it are skipped. `--file` selects one file and does not
search for its ancestors or children.

Topic matching is a case-insensitive literal substring. Dates are inclusive
`YYYY-MM-DD` bounds compared as UTC calendar dates. Each filter selects whole
user/assistant turns; a turn is retained if it has a date match and a topic match,
which may be different messages in that turn. Tool calls/results and injected
context (rows Codex adds that start with `#` or `<`, such as AGENTS.md and
`<environment_context>`) are omitted. Adjacent duplicate native representations
are collapsed; repeated messages from the same representation are retained.

A forked or spawned thread's file starts with a copy of its parent's history. That
copy is dropped (it is in the parent's own file), so each record belongs to the
thread that wrote it. A later `session_meta` for any thread that is not a declared
ancestor still refuses the file.

JSON is the default (`--json` or `--format json`); `--format text` prints one block
per record. `--json` together with `--format text` is an error.
Results identify source paths, native session/root IDs, timestamps, roles and phases,
plus scan counters and `complete`. `phase` is Codex's own (`commentary` or
`final_answer`) on assistant records and `null` on user records or when none was
recorded. A root ID is `null` when ancestry cannot be proven.
Report that uncertainty; never relabel the queried child as its own root.
`complete: false` reports malformed or partial records (a running Codex may be
mid-write), skipped links, unattributed files, compressed rollouts, unreadable
directories, missing ancestors, or an inherited copy whose end could not be found
or proven (including when the parent's file is present but cannot be read). It
does not prove the store includes every conversation ever created, and a filtered
result is only evidence for its selected scope.

Reads require regular UTF8 files and reject final-component symlinks, conflicting
metadata, ambiguous IDs, cyclic ancestry and invalid selectors. A store file that
cannot be attributed (invalid UTF8 in its head, no metadata in its first 128 KiB,
changing while its head is read) is counted in `unattributedFiles` instead of
failing the lookup. Codex's optional rollout compression rewrites cold rollouts to
`*.jsonl.zst`; those are not read. Each is counted in `compressedFiles` (one whose
plain `.jsonl` sibling exists is skipped, as Codex skips it), and a lookup that
misses names them. A compressed file passed to `--file` is refused; read a
decompressed copy instead (`zstd -dc <file> > copy.jsonl`). A selected rollout
that a running Codex is appending to is read as a snapshot up to its last complete
line; one that was replaced or truncated fails. Parent directories of an explicitly supplied path must be trusted; this is
not a filesystem sandbox.

Budgets, each failing with an error rather than a partial answer. Every flag is
validated before the first file is read, and only plain decimal integers are
accepted:

| Flag | Bounds | Default | Maximum |
| ---- | ------ | ------- | ------- |
| `--metadata-bytes` | head reads attributing every rollout in the store | 1 GiB | 16 GiB |
| `--max-entries` | directory entries visited | 65536 | 1048576 |
| `--scan-bytes` | the selected transcripts, plus any parent file read to prove where a copy ends (each file charged once) | 16 MiB | 256 MiB |
| `--max-bytes` | output, including the final newline | 8192 | 1048576 |

Each rollout's `session_meta` carries Codex's base instructions (about 20 KiB), so
attributing a store costs about that much per rollout, charged to
`--metadata-bytes`, never to `--scan-bytes`. Directory depth is capped at 8 (Codex
writes `YYYY/MM/DD`). Output is never silently truncated or split into partial
JSON or turns. Narrow the store/filters or explicitly raise the relevant budget.
Missing evidence is an error, not an empty success.

This command does not inspect live panes, stage prompts, submit input or manage
sessions. For live operations return to the managed-session guard in the skill.
