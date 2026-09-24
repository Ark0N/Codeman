---
"aicodeman": patch
---

Install `uv` and `uvx` in the Compose server image and the agent image, so MCP servers launched with `uvx` (such as the Nginx Proxy Manager MCP) can be enabled by Codex instead of failing with `uvx` not found. The server image also carries `pnpm` for `dsh plugin`.

Both images also install `libsecret-1-0`, the native library the `keytar` dependency of the Azure DevOps MCP (`@azure-devops/mcp`) needs; without it the server crashes before answering the MCP initialize handshake.

The agent image also installs `sudo` with passwordless access for the `agent` user, so a session can install system packages itself. The Compose server image is unchanged here: it runs with `no-new-privileges` and `cap_drop: ALL`, where `sudo` cannot work.
