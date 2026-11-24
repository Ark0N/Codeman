---
'aicodeman': patch
---

On tmux 3.8, a session whose agent exited (`/exit`) is now seen as exited and closed like on older tmux, instead of staying on the board as idle. tmux 3.8 prints a blank pane pid for a dead pane, and the pane watcher threw that row away, so the clean-exit sweep never ran and a restart of Codeman dropped the session's record while its tmux session stayed on the socket. A dead pane's exit is now told apart from the next one by `#{pane_dead_time}`. Closing a session whose pane is dead no longer signals the pid recorded for it, which belonged to the program that exited and may have been reused by another process; only the tmux session is killed.
