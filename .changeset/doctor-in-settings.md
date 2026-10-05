---
"aicodeman": minor
---

Settings → System → Diagnostics runs `codeman doctor` on the server (`GET /api/doctor`) and lists which agent CLIs, tmux, Node and the optional office tools are installed, their versions, paths and install hints. The probe runs in a child process so a slow `--version` can never freeze the server; admin only in multi-user mode.
