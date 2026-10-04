---
"aicodeman": minor
---

Opt-in MCP server sync between CLIs. Turn on Settings → Agents & CLIs → MCP servers → "Enable MCP server sync" (`mcpSyncEnabled`, off by default; `GET`/`POST /api/mcp-sync` answer 403 until it is on), then Preview or Sync now to copy each installed, enabled CLI's MCP servers into the others' own config files (Claude, Gemini, Codex, OpenCode, Antigravity). It only adds missing servers, never edits or removes one, skips servers you switched off, keeps a `.codeman-bak` of every file it changes, writes through symlinked dotfiles, leaves files that receive env values or headers readable by you only, and reports same-name conflicts instead of overwriting. Enabled CLIs with no known MCP config (Pi, Grok, OMP, DeepSeek) are listed as unsupported. Adds the `smol-toml` dependency to read Codex's `config.toml` safely.
