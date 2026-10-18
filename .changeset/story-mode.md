---
'aicodeman': minor
---

Story Mode draws what Claude Code does as a comic. Turn on **Story Mode** in App Settings → Header buttons (per device, off by default) and its button opens the active Claude session as comic pages: one page per prompt, with panels for reading code, planning, calling in helpers, editing, running tests (POW! or KRAK!), asking you and saving, each with a plain caption anyone can follow. The **Director's cut** switch names every tool call instead and lists all of them beside the page. Everything is clickable: a file opens in the file viewer, the code page shows the exact diff of Claude's edits, a test board shows the output with clickable `file:line` links, and a helper shows what it was asked and what it answered. A turn that is still running redraws as Claude works, new panels inking in where blue-pencil roughs stood. The data comes from `GET /api/sessions/:id/story`, an experimental read-only endpoint.
