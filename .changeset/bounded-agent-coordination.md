---
"aicodeman": minor
---

Add bounded agent inspection with expiring scoped cursors and explicit pane snapshots, plus staged local Codex input and single-use hash-confirmed submission receipts. Verify the exact composer, caret, lifecycle and input revision before sending Enter, and serialize dispatch against managed input and auxiliary key operations.

Document the initial local Codex support and conversation-attribution limits in the API, CLI and packaged skill. Other modes retain labeled snapshots or refuse unverifiable guarded input.

SubmitVerifier Enter re-presses now use the shared input boundary and update `lastSubmitAt` for each retry on every supported CLI. This keeps submission timestamps consistent with delivered Enter attempts while preventing a stale retry from bypassing a guarded submission.
