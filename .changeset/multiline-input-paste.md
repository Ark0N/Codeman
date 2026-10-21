---
'aicodeman': patch
---

A multi-line prompt sent through the mux (`POST /api/sessions/:id/input` with `useMux`) now keeps its line breaks. `sendInput` used to strip every `\n` before the text reached tmux, so `"line one\nline two\r"` arrived as `line oneline two`. The lines now go in as one bracketed paste, the same paste a single-line prompt already uses, and the Enter after it submits them together; multi-line text without an Enter is pasted too instead of typed. A shell runs each line. The submit check that re-presses a stranded Enter does not yet recognise a multi-line paste in the composer, so the unattended senders stay single-line: cron still rejects multi-line prompts, respawn's update and kickstart prompts and the auto-compact focus prompt now have their lines joined with a space (they used to run together), and `codeman agent send` and the TUI keep refusing or joining multi-line input.
