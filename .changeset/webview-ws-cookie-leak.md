---
"aicodeman": patch
---

The WebSocket leg of a trusted web tab no longer forwards Codeman's own `codeman_session` cookie upstream, which the HTTP leg already stripped.
