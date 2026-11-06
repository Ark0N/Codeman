---
'aicodeman': patch
---

Docker Compose: `docker/Start-Codeman.sh` now refuses to run while `CODEMAN_PASSWORD` is still the example value `changeme`, because the container is reachable from your network and holds the host's Docker socket. A deployment still on that value has to set a real password in its `.env` before its next restart, and `Update-Codeman.sh` ends in the same script.
