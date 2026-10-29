---
'aicodeman': minor
---

**A two-way Discord bridge: one thread per tab, with replies typed back in.** Codeman posts to a private Discord channel when a session asks for permission, asks a question, goes idle or errors, in a thread of its own for that tab, with the tail of what the CLI printed. A reply in the thread from an allowed Discord user is typed into that tab as one line plus Enter, so a blocked CLI can be answered from a phone away from the network. A CLI can also ask for the person deliberately with `POST /api/sessions/:id/discord-notify` (a physical step, a blocker, a timed-out watch). Threads are created on the first alert or for every new tab, and are kept, archived or deleted with the tab; pings are off, critical only or every post. The bot token is stored in `discord.json` (0600) and never returned. Setup with least-privilege bot permissions is in `docs/discord-bridge.md`.
