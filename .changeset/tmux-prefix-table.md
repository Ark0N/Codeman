---
"aicodeman": patch
---

Browser terminals can no longer be moved onto another session by tmux's prefix keys: typing Ctrl+B then `)`, `(`, `s` or `w` in a tab switched its tmux client to a different session while the tab kept the original's name. Codeman's tmux socket now keeps only Ctrl+B Ctrl+B (send-prefix) in its prefix table, so `Ctrl+B d` no longer detaches a terminal attached there: `codeman tui` and `scripts/tmux-manager.sh` detach with F1.
