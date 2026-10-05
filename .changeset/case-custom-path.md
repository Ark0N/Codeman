---
"aicodeman": minor
---

Create a new case in a folder of your choice. Add Case → Create New has a "Create in a custom folder" option with a Browse button: the case folder is created inside the parent you pick, scaffolded like any other case (`CLAUDE.md`, `src/`, hooks), and listed alongside the rest. `POST /api/cases` accepts an optional `path` for the same thing. The folder must not exist or must be empty (use Link Existing for a project that already has files), system folders, the home folder and credential folders are refused, and nothing is left behind if creation fails part-way. Admin only in multi-user mode, like Link Existing.
