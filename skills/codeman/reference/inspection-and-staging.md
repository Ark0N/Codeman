# Bounded inspection and guarded submission

Use these commands inside a Codeman session. They use its authenticated HTTP API;
no direct tmux access, second transport, or session-bridge installation is required.
They supplement `send`, `wait` and `read`. They do not establish full parity with
session-bridge or retire that skill.

## Inspect recent evidence

```bash
codeman agent inspect "$SID" --max-bytes 8192 --json
codeman agent inspect "$SID" --max-bytes 8192 --since "$CURSOR" --json
```

Read `source`, `identity`, `activity`, `evidence`, `truncated` and `cursor` before
interpreting the result. `maxBytes` bounds UTF8 evidence bytes, excluding the JSON
metadata/envelope. The default is 8192, maximum 65536.

- `codex-jsonl`: strictly attributed local Codex JSONL records. The first call
  selects recent complete records within a bounded tail window;
  `omittedBeforeBytes` labels older bytes deliberately omitted. A cursor continues
  after the last consumed complete record. Partial final records remain pending.
- `pane-snapshot`: UTF8-safe tail of a visible frame or the session's buffered
  output. It has `incremental:false` and `cursor:null`. This is the fallback for
  other modes, remote/container sessions, ambiguous attribution, and exhausted
  attribution budgets. Repeating a snapshot can repeat evidence.

Attribution proves which file supplied the evidence, not which thread is now
active in the TUI. A launch resume that conflicts with a newly owned rollout
falls back to a snapshot. An in-CLI `/resume` of an existing foreign-originator
thread may leave launch metadata unchanged. Check `identity.conversationId`;
these reads do not provide authoritative current-thread tracking.

Cursors are opaque, scoped to the requesting identity, session, pane generation
and attributed transcript, expire after 15 minutes, and disappear on server
restart. At most 1024 are retained; capacity eviction can invalidate an older
cursor. A replaced/truncated/rewritten source, reassociated session, foreign cursor
or unavailable native source returns `409 CONFLICT`. Inspect again without
`--since` to establish a new tail baseline; this may omit older evidence.

`blockedReason` explains an unfinished or oversized record. Incremental reads
never split or silently skip one. Increase the byte budget for
`record-exceeds-output-budget`; when the record exceeds the maximum or scan cap,
use `read --tail` for a labeled terminal view or start a fresh tail baseline.
Inspect scans at most 256 KiB of record data plus bounded generation anchors.
Attribution separately caps directory entries and metadata bytes. Evidence and
activity are observations, not proof of task completion or authorization.

## Stage, inspect, then submit once

```bash
printf '%s' 'Review src/ and report the failing tests' > /tmp/codeman-message.txt
codeman agent stage "$SID" --message-file /tmp/codeman-message.txt --json
# Review the returned stageId, sha256, expiresAt; inspect the target if needed.
codeman agent submit "$SID" --stage-id "$STAGE_ID" --confirm-sha "$SHA256" --json
```

Stage types the file contents **without Enter**. The file must be regular, UTF8,
one printable line, at most 8192 bytes, with no control characters or trailing
whitespace/newline. It initially supports a local Codex composer with a recognized
footer and an exact, unwrapped line/caret capture. Unknown, working, modal,
wrapped, remote/container and shell composers are refused. A customized footer or
unsupported character-width rendering can also make verification unavailable.
Self-targets are refused by the CLI.

The receipt stores a hash and ephemeral identities, never prompt content. It
expires after two minutes; capacity is 1024 live receipts. Stage delivery can
precede the next screen paint: a receipt acknowledges typing, while submit still
requires the fully painted exact composer. If typing fails or is ambiguous, stage
issues no receipt; inspect the pane before trying again.

Submit checks the caller, session, hash, expiry, pane lifecycle, input revision,
exact composer and caret, then sends one conditional Enter at the session's input
boundary. Competing Codeman writes are refused during dispatch. Browser/API/key
input and managed restarts invalidate receipts even when the visible text or pid
is restored. Direct tmux edits are outside that input serialization; captures
remain evidence at the time observed, rather than terminal isolation.

Every owned submit attempt consumes its receipt, including hash mismatch,
verification failure and delivery failure. Concurrent/repeated submits cannot
replay Enter, and there is no autonomous retry. A successful response means one
Enter was delivered; use inspection or a suitable wait signal to observe native
acceptance. A `409` or broken connection means inspect first. Do not automatically
stage/submit again or send an unguarded Enter to recover.
