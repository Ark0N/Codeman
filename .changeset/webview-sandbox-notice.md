---
'aicodeman': patch
---

A web tab that dies because its sandbox blocks browser storage now says so. The proxy's injected script wraps the page's `localStorage`/`sessionStorage` getters and reports the first blocked access, once per load; the tab replaces the dashboard's endless loading screen with the reason and a **Reload unsandboxed** button that flips that one setting and remounts. Nothing is probed at load time and nothing is loosened automatically — a page that never touches storage never sees it.

The panel is drawn from the active skin's tokens rather than a hardcoded dark plate, its buttons use the same surface and border tokens as the rest of the shell instead of the browser's default button, both actions are deliberately neutral, and the strings are translated under `zh-CN`.
