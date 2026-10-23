---
"aicodeman": patch
---

Terminal links: a relative path printed in the terminal now resolves against the directory the session's pane is in now (tmux `#{pane_current_path}`), not only the session's start directory, so after a `cd` in a shell the link opens the file that is actually there. The value is read from the pane-exit watcher's existing batched pane read (no new tmux call, no new SSE event), published as a runtime-only `cwd` field on the session state, and only changes the base a relative path joins: the workspace confinement and the attachment routing are unchanged. Remote SSH, Docker, direct-PTY and rediscovered sessions keep resolving against the working directory.
