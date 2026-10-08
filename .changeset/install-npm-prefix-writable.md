---
'aicodeman': patch
---

Installing an npm-based CLI from Settings (DeepSeek's `dsh`, pi, ...) no longer fails with EACCES on a native install whose system node keeps its global prefix under `/usr`. When the npm global prefix is not writable by the Codeman user, the install now goes to `~/.local` (where Codeman already looks for CLIs), as the Docker deployment already did. A prefix you set yourself, or one that is writable, is left alone.
