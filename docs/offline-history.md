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
requires a full native UUID and includes transitive descendants found in metadata.
The default store is `$CODEX_HOME/sessions`, or `~/.codex/sessions` when unset.
`--file` selects one file and does not search for its ancestors or children.

Topic matching is a case-insensitive literal substring. Dates are inclusive
`YYYY-MM-DD` bounds. Each filter selects whole user/assistant turns; a turn is
retained if it has a date match and a topic match, which may be different messages
in that turn. Tool calls/results and injected context are omitted. Adjacent duplicate
native representations are collapsed; repeated messages from the same
representation are retained.

JSON is the default (`--json` or `--format json`); `--format text` is available.
Results identify source paths, native session/root IDs, timestamps, roles and phases,
plus scan counters and `complete`. A root ID is `null` when ancestry cannot be proven.
Report that uncertainty; never relabel the queried child as its own root.
`complete: false` reports malformed or partial records, skipped links, unattributed
files or missing ancestors. It does not prove the store includes every conversation
ever created, and a filtered result is only evidence for its selected scope.

Reads require regular UTF8 files and reject final-component symlinks, conflicting
metadata, ambiguous IDs, cyclic ancestry, invalid selectors and changed selected
files. Directory traversal skips symlinks. Parent directories of an explicitly
supplied path must be trusted; this is not a filesystem sandbox.

The default total metadata/transcript scan budget is 16 MiB; `--scan-bytes` allows
1–67108864 bytes. Directory scans are capped at 8192 entries and depth 8. The output
budget is 8192 bytes by default; `--max-bytes` allows 1–1048576 bytes, including the
final newline. Exhausted budgets fail with an error: output is never silently
truncated or split into partial JSON or turns. Narrow the store/filters or explicitly
raise the relevant budget. Missing evidence is an error, not an empty success.

This command does not inspect live panes, stage prompts, submit input or manage
sessions. Live session operations use the separate `codeman agent` commands and
require the managed-session environment and running server.
