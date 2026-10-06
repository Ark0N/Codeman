---
"aicodeman": patch
---

The Git status window's limits are settings now. **Git status: max repositories** (App Settings → Header & Panels → Bottom bar, per device, 1 to 50, default 12) is how many repositories it lists when the session's folder holds several projects, and **Git status: git timeout** (5 to 120 seconds, default 30, was a fixed 10) is how long one git command may run. A repository git could not read (a timeout on a slow network share was the usual cause) used to be dropped without a word, which left a count like "first 11" under a limit of 12; it now stays in the list with the reason, shows as `? N` in the indicator instead of letting it read ✓, and the truncation line reads "Showing the first N of more than N repositories" and points at the setting. `GET /api/sessions/:id/git-status` and `/git-diff` take `maxRepos` and `timeout` (seconds) query parameters, clamped server-side, and the overview reports `repoLimit`.
