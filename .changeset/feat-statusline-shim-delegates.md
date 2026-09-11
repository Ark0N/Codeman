---
"aicodeman": patch
---

feat(statusline): stop the plan-usage exporter from stealing the user's statusline

Claude Code ranks a repo's `.claude/settings.local.json` above `~/.claude/settings.json`, so
the statusLine Codeman injects for the Plan Usage chip SHADOWS whatever statusline the user
configured globally. The inline exporter then printed Codeman's own footer in its place, and
running `claude` by hand in a managed repo rendered the bare word `codeman` — the response
the server returns for a session id it does not know.

The exporter is now a generated shim, `src/statusline-shim.ts`, following the
`deepseek-status-shim` pattern: versioned `.mjs` written into the data dir, refreshed on a
marker change, temp-and-rename so a live render cannot read a half-written file. It forwards
the same payload to `/api/status-telemetry` and, concurrently, resolves the statusline it is
shadowing and prints that instead. Codeman's footer still appears when there is nothing to
shadow, so the exporter keeps its value on a machine with no statusline of its own.

The delegate is resolved at render time by walking the settings files Claude Code consults,
nearest first, skipping Codeman's own entry in either the shim or the pre-shim form. Late
resolution means editing a global statusline takes effect with no reinjection. Ownership now
keys on the version-free `codeman-statusline-shim` token, and `applyStatusLineConfig` still
reads the old `/api/status-telemetry` command as ours so managed repos upgrade in place
rather than being mistaken for hand-authored. A hand-authored statusLine is left alone
exactly as before.
