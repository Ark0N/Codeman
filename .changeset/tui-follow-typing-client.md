---
'aicodeman': patch
---

`codeman tui`: while a terminal is attached, the window follows whichever client was used last, as plain tmux does. Before, a browser tab (a phone, for example) that opened or resized the same session pinned the window to the tab's size, and typing or pasting in the terminal did not take it back until a detach and a fresh attach. Now typing, pasting or resizing the terminal fills it again, and typing in the tab, or its Redraw, gives the tab the size. The attach sets one hook and two owner options on the sessions it dressed and removes them on detach; a TUI killed mid-attach has its leftovers removed by the next `codeman tui`. A forced resize at an unchanged size (Redraw) now nudges the attach client's pty by one row first, so tmux counts that tab as the client used last. Needs tmux 3.3 or newer.
