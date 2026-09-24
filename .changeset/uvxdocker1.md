---
"aicodeman": patch
---

Install `uv` and `uvx` in the Compose server image and the agent image, so MCP servers launched with `uvx` (such as the Nginx Proxy Manager MCP) can be enabled by Codex instead of failing with `uvx` not found. The server image also carries `pnpm` for `dsh plugin`.
