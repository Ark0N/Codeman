---
"aicodeman": patch
---

Files panel: when a session's agent moves into a git worktree part way through (Claude Code's EnterWorktree), the panel now lists that worktree instead of the main checkout, follows the agent back out, and shows a strip that names the worktree with a button to switch to the session's folder. Only a worktree inside the session's folder is followed, and file access stays confined to that folder as before.
