---
"aicodeman": patch
---

Docker Compose: CLIs installed from Settings (DeepSeek, Pi and any other npm-based CLI) survive `Update-Codeman.sh`. The image's `NPM_CONFIG_PREFIX` (`/opt/codeman-cli`) is image content and was discarded when the container was recreated; `POST /api/clis/:id/install` now installs into `~/.local` on the persistent home mount when running in the container, and `~/.local/bin` is on the image PATH.
