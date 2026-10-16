---
"aicodeman": minor
---

**jcode as a run mode.** Codeman can now start [jcode](https://github.com/1jehuang/jcode) sessions from the Run menu, the phone overview and the API (`mode: "jcode"`, with `jcodeConfig: { model?, resumeSessionId? }`), locally, over SSH and in Docker cases (the agent image installs it). Codeman reads jcode's spinner row to tell a working session from an idle one, the wheel pages jcode's own transcript, and `codeman doctor` and the installer find it. jcode runs every session's tools in one shared background daemon, so closing a jcode tab never stops that daemon, its sessions get no Codeman agent skill and take no `JCODE_*` environment overrides, and a jcode worker's answer is read from its terminal rather than `last-response`; see `docs/jcode-integration.md`.
