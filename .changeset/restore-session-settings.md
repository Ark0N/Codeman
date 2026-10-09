---
'aicodeman': patch
---

A session's tab colour, pin and image watcher now survive a Codeman restart or crash. Recovery rebuilt each surviving pane with its name, auto-clear, auto-compact and auto-resume settings but not those three, so they reset to default and the next save overwrote the stored values.
