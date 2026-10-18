---
'aicodeman': minor
---

New App Settings option, "Pin tab names on the CLI" (off by default): launch every Claude session with `--name <tab name>`, not only the ones you renamed, so Claude Code's prompt-box label, `/resume` entry and remote session list read the same as the tab instead of Claude's own generated title. With it off nothing changes. The cost: Claude stops generating its own titles for those sessions, and a rename in Codeman holds only until the next turn (an auto-name reaches the CLI at its next spawn). The setting is read at each session start and respawn, so a toggle applies without a server restart.
