---
"aicodeman": patch
---

A link to another heading of the same file in the markdown File Viewer (`[Install](#installation)`) now scrolls to that heading. It did nothing: marked emits no heading ids, so there was nothing to jump to, and with `<base href="/">` a bare `#installation` href points at the dashboard's root, not at the page, so letting the browser follow it was never an in-page jump either. The shared link handler (File Viewer and Response Viewer) now resolves fragment links itself against the rendered document: headings get GitHub-style slugs (lower-case, punctuation dropped, a repeated title numbered `-1`, `-2`), matched case-insensitively and percent-decoded, `#` goes to the top, an explicit `<a id>` in the document works, and a fragment that matches nothing is ignored instead of navigating the app. The anchors are `data-md-anchor` attributes looked up inside the document, never `id`s, so a heading called "Settings" cannot collide with an element of the app itself.
