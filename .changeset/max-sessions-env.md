---
'aicodeman': minor
---

The cap of 50 concurrent sessions can now be set with `CODEMAN_MAX_SESSIONS` (a positive integer, read at startup), for a machine with the memory for more sessions or a small one that should run fewer. Without it nothing changes. A value that is not a positive integer falls back to 50, so a typo never blocks session creation. In multi-user mode the per-user cap still defaults to half the global cap, so it follows the new value unless `CODEMAN_MAX_SESSIONS_PER_USER` is set.
