---
'aicodeman': minor
---

**A two-way Discord bridge: answer a blocked agent from your phone.** Opt-in. Codeman posts to a private Discord channel when a session asks for permission, asks a question, goes idle or errors, in a thread of its own for that tab, with what is on the tab's screen. A reply in the thread from an allowed Discord user is typed into that tab as one line plus Enter, so you can answer from anywhere, with no inbound exposure (it only makes outbound connections).

- **Agents can ask for you.** `codeman notify "<message>" [--urgent] [--file <path>]` posts to the tab's thread (`POST /api/sessions/:id/discord-notify`), for a physical step, a blocker or a wait that timed out. Claude is told about it in its system prompt at launch; other CLIs are sent one short message the first time a brand-new tab goes idle (a setting, on while the bridge is on; never to shell tabs).
- **Files both ways.** A file attached in a thread is saved under `<tab folder>/.codeman-discord/` and its path given to the agent; `--file` uploads a file of up to 8 MB from inside the tab's folder.
- **Configurable.** Threads are created on the first alert or for every new tab; a deleted tab's thread is kept, archived or deleted; pings are off, critical only or every post.
- **Safe by default.** The bot token is stored in `discord.json` (0600) and never returned; only allowlisted user IDs can reply; least-privilege bot setup is in `docs/discord-bridge.md`.
