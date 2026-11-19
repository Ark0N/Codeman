---
'aicodeman': patch
---

Fix iOS keyboard suggestions, phrase replacement, dictation and hold-delete by retaining native input ownership in each terminal pane. Preserve local-echo Enter ordering across session switches, reset native editing at toolbar and programmatic input boundaries, and show the native trackpad caret against the visible input, including emoji-safe deletion.
