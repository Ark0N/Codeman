---
'aicodeman': minor
---

Keep your laptop awake while Codeman runs. App Settings > System > Power has "Keep this computer awake" (off by default) and "Only on AC power" (on by default), with a live status line. On Linux it stops lid-close suspend while you are logged in to the desktop; on macOS it stops idle sleep, and lid-close sleep too with the optional root helper. The installer asks on laptops, and `install.sh keep-awake` turns it on for an existing install.
