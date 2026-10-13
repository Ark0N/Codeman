---
'aicodeman': patch
---

Switching to a fullscreen Claude tab is about ten times faster. Claude keeps that conversation itself and tmux holds no scrollback for it, so instead of downloading and replaying a 1 MB tail of old screen redraws on every switch, the browser loads just the current screen (a few KB), the same as a page load already did. Tabs whose pane does keep scrollback are unchanged.
