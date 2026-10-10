---
'aicodeman': minor
---

MCP server sync now includes GitHub Copilot CLI. If `copilot` is installed (or `~/.copilot/mcp-config.json` exists), its MCP servers are copied into your other CLIs and theirs into it, with the same rules as the others: only missing servers are added, nothing is edited or removed, a server you switched off with `copilot mcp disable` is not copied, and a file that receives env values or headers stays readable by you only. `COPILOT_HOME` is followed. Copilot is not a Codeman run mode, so it is declared as a sync-only target rather than a CLI-registry entry.
