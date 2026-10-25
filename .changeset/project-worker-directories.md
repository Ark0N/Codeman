---
"aicodeman": minor
---

Allow `codeman agent spawn` to start workers in the current project directory or an existing directory selected with `--working-dir`, while preserving explicit case quick-start behavior. A directory launch uses `POST /api/v1/sessions` followed by the mode's start route (`/interactive` or `/shell`), and its `--json` output is `{ sessionId, workingDir, created: true, ready }` (plus `startupError` when the start failed, exit 1). Only an omitted case means "use a directory": an empty case name still goes to quick-start, which refuses it, and an empty or whitespace-only `--working-dir` is refused locally (exit 4) before any request instead of resolving to the cwd.

One change for named-case spawns too: an unknown `--mode` is now refused locally (exit 4) before any request, where it used to reach quick-start and come back as the server's 400 (exit 1).
