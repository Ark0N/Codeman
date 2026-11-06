---
'aicodeman': patch
---

Adopted tmux sessions: close adopted tabs before going back to 1.48.0 or older. An older server does not know a tab is adopted and drops every adoption guard, so respawn, Ralph and auto-clear are no longer refused on it.
