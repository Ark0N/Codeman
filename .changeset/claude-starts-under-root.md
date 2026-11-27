---
"aicodeman": patch
---

Claude sessions now start when Codeman itself runs as root (a VPS, an LXC container): Claude Code refuses `--dangerously-skip-permissions` under root and every local Claude tab showed a dead pane, so a root server now starts Claude without the bypass (it asks for permission instead) and says so in the server log.
