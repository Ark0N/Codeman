---
'aicodeman': patch
---

Custom endpoints now hand their context window to the CLIs that ask for it. OpenCode and Codex receive the discovered context length on injection (#749), and Codex launches on the selected custom model instead of its default (#750). Endpoint discovery reads each model's context size from `/v1/models` (with a sanity ceiling), with a per-endpoint "Default context length" field for gateways that answer nothing, and boot recovery keeps the saved figure (#754). The "Choose a model" picker also grew a search box that filters the rows as you type.
