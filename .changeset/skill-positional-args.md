---
'aicodeman': patch
---

Codeman skill: the §0 bootstrap now survives Claude Code loading the skill with arguments. Claude Code replaces a bare `$1`, `$2` in a skill body with the words of the request, so an agent that pasted the bootstrap (every session without a pre-seeded preamble: Agent Skill injection off, the default, or a remote or Docker session) wrote helpers that asked about session `5` with `timeout=claude` and never found the password. The shell now uses `${1}` / `${2}`, and the preamble stamp moved to 1.41.2 so a file written by the broken bootstrap is rewritten on the next run.
