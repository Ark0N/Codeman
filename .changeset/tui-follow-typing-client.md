---
'aicodeman': patch
---

`codeman tui`: a terminal attached to a session takes the window size back when you type, paste or resize it, after a browser tab (a phone, for example) opened or resized the same session and Codeman sized the window to that tab. Until now the terminal kept showing a small pane until a detach and a fresh attach. The attach sets a `client-active` hook on the sessions it dressed that acts only for its own tmux client, and removes it on detach. Needs tmux 3.3 or newer.
