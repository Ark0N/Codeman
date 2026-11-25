---
"aicodeman": patch
---

**Closing a dialog you opened with the mouse puts the keyboard back in the terminal.** After App Settings or Session Options was opened with a click and closed again, nothing you typed reached the terminal until you clicked it: focus was left on the button you had clicked, and in Safari and the Mac app on nothing at all. A dialog now returns the keyboard to the field you were typing in when you clicked, which with the tile grid or the split open is the pane you were in. The Session Manager and the command palette follow the same rule. A dialog opened with the keyboard still returns to the control it was opened from.
