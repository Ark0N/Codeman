---
'aicodeman': patch
---

Fix missing terminal history above live OMP output with a manual Reload history action in the existing history banner on desktop and mobile. The action preserves the text being read and output arriving during the download, and can be disabled per device in Settings > Terminal & Input > Scrolling & rendering. Ordinary scrolling only pulls history at the top; deferred dropped-output recovery retains its retry attempt.
