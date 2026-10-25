---
"aicodeman": minor
---

Add experimental bounded agent inspection with expiring scoped cursors and explicit pane snapshots, plus staged local Codex input and single-use hash-confirmed submission receipts. Verify the exact composer, caret, lifecycle and input revision before sending Enter, and serialize dispatch against managed input and auxiliary key operations.

The three new CLI verbs (`codeman agent inspect`, `stage`, `submit`) and their HTTP routes (`/api/v1` and `/api`) are labeled experimental, so the versioning policy's rule for experimental surfaces applies: their shape and behavior may change in minor or patch releases. They are opt-in behind a new synced setting, `agentCoordinationEnabled` (App Settings, Cross-session features, "Experimental agent coordination", default OFF, translated for zh-CN): while it is off all three routes answer `403 FORBIDDEN` with a message naming it, and the CLI verbs print that refusal verbatim.

Codex rollout attribution remembers the attributed file per session and re-verifies only that file's head on later calls, rescanning only the date directories not older than it for a codex `/new`, so a large never-pruned `~/.codex/sessions` store no longer falls back to a pane snapshot or costs a full walk per call. An unexpected inspection read error answers `422 OPERATION_FAILED` and is logged with the session id and error code only, instead of a retryable `409`.

The guarded composer read takes its glyph and footer from the CLI registry: codex's `workDetect.promptGlyph` and a new `workDetect.composerFooterLine` capability (config-supplied regex, compiled through the ReDoS guard). Only a CLI declaring it takes guarded input. Codex's footer effort words are now one shared list for this and `modelDetect.screenLine`.

Stage waits for the pane to show what it typed: it re-reads the composer every 50 ms for up to one second and issues a receipt only for a frame showing exactly the message (Codex repaints 30 to 60 ms after the keys, so the first capture was often stale and stage refused with the text already typed). Every refusal after typing now says the message may be in the composer and points at the Ctrl+U recovery. A visible-frame pane capture reads the screen and the caret in one tmux invocation. Stage refuses messages that would change what Enter does (codex: a leading `/` or `!`, or a last word starting with `@` or `$`, which open a command or completion popup) and frames with a suggestion popup above the composer, from three new registry fields (`workDetect.composerPopupLine`, `composerCommandPrefixes`, `composerCompletionSigils`). Submit waits until 250 ms after the staged keys before sending Enter, since codex turns an Enter within 120 ms of typed text into a newline. While a guarded submit is in flight, `POST /api/sessions/:id/input` answers `409 CONFLICT` with its seq returned instead of a `200` for input that was never written.

Document the initial local Codex support and conversation-attribution limits in the API, CLI and packaged skill. Other modes retain labeled snapshots or refuse unverifiable guarded input.

SubmitVerifier Enter re-presses now use the shared input boundary and update `lastSubmitAt` for each retry on every supported CLI. This keeps submission timestamps consistent with delivered Enter attempts while preventing a stale retry from bypassing a guarded submission.
