---
"aicodeman": patch
---

A web tab that dies because its sandbox blocks browser storage now says so. The proxy's injected script reports the blocked `localStorage` access once per load; the tab replaces the dashboard's endless loading screen with the reason and a **Reload unsandboxed** button that flips that one setting and remounts. Nothing is loosened automatically — a dashboard that never asks for storage never sees it.

The panel is drawn from the active skin's tokens rather than a hardcoded dark plate, its buttons use the same surface/border/accent tokens as the rest of the shell instead of the browser's default button, and the strings are translated under `zh-CN`.
