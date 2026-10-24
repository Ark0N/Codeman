---
'aicodeman': patch
---

Scrolling over a Codex selection menu no longer moves its selection. When Codex does not track the mouse (measured on 0.162.1 and 0.164.0), Codeman turns the wheel into PageUp and PageDown, which those menus use to move the selection: at the "Implement this plan?" prompt one notch down landed on "No, stay in Plan mode" and one up on "Yes, implement this plan". The wheel is now consumed while such a menu is showing (main pane and tiles) and pages the transcript again once it closes.
