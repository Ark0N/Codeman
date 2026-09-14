---
"aicodeman": patch
---

fix(statusline): stop the plan-usage exporter from stealing the user's statusline (#405)

Claude Code ranks a repo's `.claude/settings.local.json` above `~/.claude/settings.json`, so
the statusLine Codeman injects for the Plan Usage chip shadowed whatever statusline the user
had configured globally, and running `claude` by hand in a managed repo rendered the bare word
`codeman`. The exporter is now a generated, delegating shim (`src/statusline-shim.ts`, the
`deepseek-status-shim` pattern): it forwards the same payload to `/api/status-telemetry` and,
concurrently, runs the statusline it shadows and prints that. Codeman's footer appears only when
there is nothing to shadow, and with neither the line stays blank. The delegate is resolved at
render time from the three settings files Claude Code documents (`workspace.project_dir` first,
then `~/.claude/settings.json`), never from an ancestor directory or a user-level
`settings.local.json`.

The injected command is a self-selecting shell guard that runs the shim where it exists and
falls through to the inline curl exporter where it does not, so the same bind-mounted
`settings.local.json` still reports telemetry from inside a Docker case's container. Ownership
accepts both the new `codeman-statusline-shim` token and the old `/api/status-telemetry`
command, so repos managed by an older Codeman upgrade in place. `POST /api/status-telemetry`
answers an unknown session with an empty body instead of `codeman`, and the session-status
footer is empty rather than a brand word when the payload carries nothing to show.

Turning the Plan Usage chip off now removes the exporter from the workspaces of your live Claude
sessions. The removal rides only the settings save that flips the chip off on a device, so a
phone whose chip was never on cannot strip the exporter a desktop depends on.
