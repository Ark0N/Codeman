---
'aicodeman': patch
---

Files panel: one large folder no longer uses up the 5,000-entry listing limit before the folders after it, or the ones inside it, get a turn. The tree and its search now walk folders in a per-directory round-robin (breadth-first), so search results come back shallow-first rather than depth-first. This is fair per directory, not per subtree: a folder made of thousands of small subfolders can still use most of the limit one level down. One listing also stops opening folders after reading 250,000 entries, so folders that add up to that can leave later ones unread, and a folder below the workspace that does not answer is skipped rather than waited on. A folder a limit stopped short of no longer looks empty: `GET /api/sessions/:id/files` marks it `incomplete: true` (additive) and, when expanded, it shows a dim "Not fully scanned (file limit reached)" row.
