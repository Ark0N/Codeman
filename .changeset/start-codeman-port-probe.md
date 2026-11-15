---
'aicodeman': patch
---

`docker/Start-Codeman.sh` no longer hangs on WSL while it looks for a free port. On WSL a connect to a closed 127.0.0.1 port is dropped rather than refused and only fails at the kernel's connect timeout, so the first-run port search (up to 100 ports) and the check before `docker compose up` could stall for many minutes. Each port check now gives up after about a second and reads no answer as free.
