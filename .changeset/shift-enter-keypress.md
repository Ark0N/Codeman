---
"aicodeman": patch
---

Shift+Enter no longer submits the prompt after inserting the newline. The terminal key handler swallowed only `keydown`, so xterm's `keypress` for Shift+Enter (which, unlike Ctrl/Alt, it does not discard) still sent a bare `\r`.
