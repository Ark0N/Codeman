---
"aicodeman": patch
---

pi: the mouse wheel no longer goes dead after a tab switch or reload. pi's fullscreen TUI, the default since 1.0.0, enables mouse tracking once at start, and Codeman's replay dropped that mode in the browser, so the wheel landed in an empty local buffer. pi now takes the same path as Copilot: the server strips the mouse enables and remembers them, and the wheel is forwarded from that record, on the primary pane, tiles, split Pane B and phones. A drag in fullscreen pi now selects text in the browser instead of using pi's own selection. A pi in `tuiMode: regular` is unaffected. Thanks to @Randalix for the report and the fix.
