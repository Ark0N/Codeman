---
"aicodeman": minor
---

MCP server sync between CLIs: Settings → Agents & CLIs → "Sync MCP servers across CLIs" (and `GET`/`POST /api/mcp-sync`) copies each enabled CLI's MCP servers into the others' config files (Claude, Gemini, Codex, OpenCode, Antigravity; enabled CLIs without a known MCP config are listed as unsupported). It only adds missing servers, never edits or removes one, keeps a `.codeman-bak` of every file it changes, and reports same-name conflicts instead of overwriting.
