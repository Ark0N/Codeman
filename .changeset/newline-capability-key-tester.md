---
"aicodeman": patch
---

Shift+Enter's newline chord is now registry data (`capabilities.newline`: `line-feed` by default, `esc-enter` available for a CLI whose composer ignores a bare line feed; no stock CLI changes) instead of being chosen in the `send-key` route. Adds a Key tester under Settings → Terminal & Input that shows the keydown/keypress/keyup events a browser reports, to diagnose a device where a shortcut behaves differently. Keys pressed in the tester no longer trigger app shortcuts (Ctrl+W, Ctrl+L, Escape, ...).
