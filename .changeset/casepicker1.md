---
"aicodeman": patch
---

The case picker now refreshes its list from `/api/cases` when it opens and every 5 seconds while it stays open, so folders deleted or created on disk appear without a page reload. If the selected case has been removed, the picker falls back to another case without saving it as the last-used one.
