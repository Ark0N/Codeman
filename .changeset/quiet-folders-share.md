---
'aicodeman': patch
---

Files panel: one large folder no longer uses up the 5,000-entry scan limit and hides the folders after it. The tree and its search now walk folders in a per-directory round-robin (breadth-first), so search results come back shallow-first rather than depth-first. This is fair per directory, not per subtree: a folder made of thousands of small subfolders can still use most of the limit one level down. A folder the limit stopped short of no longer looks empty: `GET /api/sessions/:id/files` marks it `incomplete: true` (additive) and, when expanded, it shows a dim "Not fully scanned (file limit reached)" row.
