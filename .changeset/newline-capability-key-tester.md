---
"aicodeman": patch
---

Shift+Enter's newline chord is now registry data (`capabilities.newline`: `line-feed` by default, `esc-enter` for Codex) instead of being chosen in the `send-key` route, so a CLI with a different composer is one line in `stock.ts`. Adds a Key tester under Settings → Terminal & Input that shows the keydown/keypress/keyup events a browser reports, to diagnose a device where a shortcut behaves differently.
