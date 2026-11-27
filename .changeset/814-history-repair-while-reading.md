---
'aicodeman': patch
---

Fix missing terminal history above live output in agent sessions (seen with OMP) with a manual Reload history action in the existing history banner on desktop and mobile. The action preserves the text being read and output arriving during the download, and can be disabled per device in Settings > Terminal & Input > Scrolling & rendering. Ordinary scrolling only pulls history at the top.

While you are scrolled up, new output no longer moves the text you are reading once the terminal's scrollback is full. This applies to every session type, whether or not the Reload history setting is on.
