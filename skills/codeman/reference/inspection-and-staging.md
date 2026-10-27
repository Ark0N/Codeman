# Experimental bounded inspection and guarded submission

**Experimental:** `codeman agent inspect`, `stage` and `submit`, and their
`/api/v1/sessions/:id/inspect|stage|submit` routes (including `/api` aliases),
are labeled experimental and so are not part of the stable CLI/HTTP contract. Their commands, flags, paths,
payloads and behavior may change or be removed in a minor or patch release.
Pin a compatible Codeman version when automating them. Authentication and
session ownership checks still apply.

They are also opt-in: until the user turns on **Experimental agent coordination**
in App Settings (`agentCoordinationEnabled`, off by default), every one of them
fails with `FORBIDDEN: ... (HTTP 403)` naming that setting. That is not something
to retry or work around: tell the user, or use `send`/`read` instead.

Use these commands inside a Codeman session. They use its authenticated HTTP API.
They supplement `send`, `wait` and `read` over the same HTTP transport; no direct
tmux access is required.

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

Terminal resizes preserve inspection cursors. Cursors are opaque, scoped to the
requesting identity, session, pane lifecycle generation
and attributed transcript, expire after 15 minutes, and disappear on server
restart. Each caller and session keeps its newest 8 (so retrying the last call
works), at most 1024 in all; an older cursor can be retired. A replaced/truncated/rewritten source, reassociated session, foreign cursor
or unavailable native source returns `409 CONFLICT`. Inspect again without
`--since` to establish a new tail baseline; this may omit older evidence.

`blockedReason` explains an unfinished or oversized record. Incremental reads
never split or silently skip one. Increase the byte budget for
`record-exceeds-output-budget`; when the record exceeds the maximum or scan cap,
use `read --tail` for a labeled terminal view or start a fresh tail baseline.
Inspect scans at most 256 KiB of record data plus bounded generation anchors.
Attribution separately caps directory entries (8192), depth (8), negative-filter
prefix reads (8 MiB) and candidate metadata including final verification (1 MiB). Evidence and
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
footer and an exact, unwrapped line/caret capture. Before typing, stage checks
the actual captured width and composer indentation; a message that would reach
the right edge or wrap is refused without writing anything. Unknown, working, modal,
wrapped, remote/container and shell composers are refused. A customized footer or
unsupported character-width rendering can also make verification unavailable.
Self-targets are refused by the CLI.

Stage also refuses, before typing, a message that would change what Enter does:
one starting with `/` (a Codex slash command; with its command list open, Enter
would run the highlighted command instead) or `!` (a shell command), and one whose
**last** word starts with `@` (file/mention search) or `$` (skills). Those popups
follow the caret, which stage leaves at the end, so `look at @src/app.ts please`
is fine. Send slash and shell commands with `codeman agent send`, and end a
message with an ordinary word when it mentions a file. A frame showing a
suggestion popup above the composer is refused at stage and submit too.

The receipt stores a hash and ephemeral identities, never prompt content. It
expires after two minutes; capacity is 1024 live receipts. After typing, stage
re-reads the pane (every 50 ms, up to one second, since Codex repaints a little
after the keys) and issues a receipt only for a frame that shows exactly the
message with the caret after it. Any refusal after the keys went out (typing
failed or was ambiguous, the pane or input changed, or no frame verified in time)
says the message may already be in the composer: no receipt was issued. Do not
stage again on top of it; follow [Recover a stranded draft](#recover-a-stranded-draft) below first.

While a submit's Enter is in flight (milliseconds, plus the moment it takes to
write input held behind it), TAGGED input to that session (`clientId` and `seq`,
which `codeman agent send` and `interrupt` always carry) answers `409 CONFLICT`
with nothing written; retry it. Untagged input, terminal keystrokes, `send-key`
and Codeman's own managed writes are held instead and written in arrival order
once the Enter is out.

Submit checks the caller, session, hash, expiry, pane lifecycle, input revision,
geometry, exact composer and caret, then sends one conditional Enter at the session's input
boundary. It first waits until 250 ms have passed since stage typed (Codex turns an
Enter that follows typed text within 120 ms into a newline), so submitting right
after stage is fine. Competing Codeman writes are held during dispatch and written
after it, except tagged input, which is refused with `409`. Browser/API/key
input and managed restarts invalidate receipts even when the visible text or pid
is restored. Direct tmux edits are outside that input serialization; captures
remain evidence at the time observed, rather than terminal isolation.

Every owned submit attempt consumes its receipt, including hash mismatch,
verification failure and delivery failure. Concurrent/repeated submits cannot
replay Enter, and there is no autonomous retry. A successful response means one
Enter was delivered; use inspection or a suitable wait signal to observe native
acceptance. A `409` or broken connection means inspect first. Do not automatically
stage/submit again or send an unguarded Enter to recover.

## Recover a stranded draft

A consumed receipt cannot be reused, and a stage refused after typing issued
none. First observe whether the prompt is still in the composer or was accepted: use transcript evidence/wait signals and a fresh terminal capture
(`GET /api/v1/sessions/:id/terminal?tail=8192`). If the target is working, has
accepted the prompt, shows a dialog, or delivery is ambiguous, keep observing;
do not clear or resend anything. A transcript prompt row alone is not proof
that text remains unsent in the current composer.

Only recover an unambiguously unsent draft in an input-ready local Codex
composer: verify the complete draft, recognized footer and caret at its end in
the current frame, and ensure no other writer can edit this target during
recovery. If the frame is wrapped, incomplete or unclear, ask the user to clear
it in the terminal instead of guessing keys. Never use `send` to overwrite a
draft: that appends and submits both prompts together.

After those checks, the known Codex line-clear chord may be sent once through
the existing raw input route, with **no Enter**. This conditional example uses
the authenticated `CURL`/`API` values loaded by §0 and the exact target id:

```bash
"${CURL[@]}" -X POST "$API/api/v1/sessions/$SID/input" \
  -H 'Content-Type: application/json' -d '{"input":"\u0015","useMux":false}'
```

Do not retry a failed/ambiguous clear blindly. Read a fresh terminal frame and
verify the composer is empty and input-ready. Only then create a **fresh** stage
receipt for the intended prompt and submit that receipt once. If the draft did
not clear, the target began working, or verification remains uncertain, stop and
ask the user; do not send an unguarded Enter or replay the old prompt.
