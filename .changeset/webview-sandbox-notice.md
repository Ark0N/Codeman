---
"aicodeman": patch
---

A web tab that dies because its sandbox blocks browser storage now says so. The proxy's injected script reports the blocked `localStorage` access once per load; the tab replaces the dashboard's endless loading screen with the reason and a **Reload unsandboxed** button that flips that one setting and remounts. Nothing is loosened automatically — a dashboard that never asks for storage never sees it.
