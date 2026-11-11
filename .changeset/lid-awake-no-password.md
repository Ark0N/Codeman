---
"aicodeman": patch
---

**Mac app: With the Lid Closed no longer asks for a password.** Codeman > Keep This Mac Awake > With the Lid Closed is a plain switch now. 1.50.1 asked for your administrator password and installed a small root helper for it. The app now does what [LogoLight](https://logolight.app) does: it turns off macOS's sleep-on-lid-close itself while your agents work, and turns it back on when they stop, when the app quits or crashes, and on battery. If you ticked With the Lid Closed in 1.50.1, it keeps working after the update, and the old helper does nothing any more. Remove it with Codeman > Keep This Mac Awake > Remove the Old Lid Helper… (that asks for your password one last time). If the Mac ever sleeps under the lid anyway, the status line in the same menu says until when.
