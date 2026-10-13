---
'aicodeman': minor
---

Shortcut rebinding (App Settings → Shortcuts) now covers Previous Session and the alternate Next Session, which were fixed at Alt/Option+[ and Alt/Option+]. Capturing a chord another action already owns is refused with a message naming that action (Alt+1-9 are reserved for tab switching, Ctrl/Shift+Enter for newline and Ctrl/Cmd+V for paste); re-enabling a disabled shortcut and Reset run the same check. A chord you rebound to an app action no longer also types into the terminal: a rebind to Alt+J used to switch tabs and send ESC j to the session as well.
