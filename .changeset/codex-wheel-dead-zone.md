---
'aicodeman': patch
---

A mouse wheel over a Codex pane (and any CLI paged with PageUp/PageDown) now moves the transcript on its first notch. Because the wheel is turned into whole-page keys when the CLI does not track the mouse, it used to send nothing until half a screen of travel had built up: 5 notches in Chrome, 7 on Firefox's 3-line notches, so a short scroll looked dead. The first notch now pays its page at once, as a trackpad flick already did, and the notches after it repay it, so the page rate is unchanged.
