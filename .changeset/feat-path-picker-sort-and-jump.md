---
"aicodeman": minor
---

feat(files): let the path picker jump to a typed path and sort by name or date

The picker's current-folder line was read-only, so reaching a deep folder meant tapping
through every level, and its listing was fixed to name order, so the file an agent had
just written was somewhere in a 500-entry list. The current folder is now an editable
field (Enter or Go jumps there, a full file path lands in its folder with the file
selected, and a typo keeps the listing you had instead of resetting to the root), the
listing can be sorted by name or modified time in either direction with folders always
first (the choice is remembered per device), and each entry shows a compact modified
time. `GET /api/filesystem/browse` entries carry `mtimeMs` to make that possible, with
one stat per entry.
