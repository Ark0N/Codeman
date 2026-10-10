---
'aicodeman': patch
---

The "Showing the most recent 1.0 MB of this session" notice no longer appears on every tab switch. It shows up only when you scroll to the top of a terminal, leaves when you scroll back down, and stays closed for that tab once you dismiss it. Sessions with nothing more to load (fullscreen Claude, whose history lives in Claude itself) never show it, and when there is more, it states the scrollback line count instead of an inflated byte figure. `GET /api/v1/sessions/:id/terminal` reports the new `paneHistoryLines` field.
