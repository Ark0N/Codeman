---
"aicodeman": patch
---

Install pnpm in the Docker Compose server image. `dsh plugin` spawns a literal `pnpm` with no npm fallback, so the Run menu's "DeepSeek - add a terminal profile" button failed with `dsh: pnpm not found on PATH` in that image. Because this changes `server.Dockerfile`, the in-app updater will ask Compose deployments to rebuild the image (`Update-Codeman.sh`) rather than apply this release in place.
