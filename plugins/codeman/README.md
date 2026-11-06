# codeman (Claude Code plugin)

The agent skill for [Codeman](https://getcodeman.com), the self-hosted mission control for AI coding agents. With it, a Claude Code session running inside Codeman can start other sessions, prompt them, block until they finish, read their answers and clean up, in plain English instead of API calls.

```
/plugin marketplace add Ark0N/Codeman
/plugin install codeman@codeman
```

The skill acts inside a Codeman-managed session (`CODEMAN_MUX=1`). Outside one it only reads saved Codex conversations offline (`codeman history read`) and refuses everything else, so installing it globally costs nothing for unrelated sessions.

Pick one install route. Codeman can inject the skill into each case itself (App Settings, Agent Skill), and `codeman skill install` writes a user-level copy; a Claude Code that has one of those AND this plugin lists the skill twice, as `codeman` and `codeman:codeman`. Both work, the second is just noise.

This directory is a mirror of [`skills/codeman`](../../skills/codeman) in the main repository, kept byte-identical by `scripts/sync-plugin.mjs` and pinned by a test. Edit the source there, never here. `npm run check:plugin` (repo root, needs the `claude` CLI) checks the mirror and validates both manifests. Source, issues and the rest of Codeman: https://github.com/Ark0N/Codeman
