---
"aicodeman": patch
---

fix(terminal): let Claude use truecolor so its themed backgrounds render

Claude draws the user's own messages as a block of background color, and inside a Codeman
pane that block was invisible. tmux hands each pane `TERM=screen`, which supports-color reads
as 16 colors, and the registry entry for Claude deleted `COLORTERM` on top of that. Claude
therefore quantized every RGB color its theme asked for down to the basic palette, where
`rgb(55, 55, 55)` and every other dark background becomes `ESC[40m` — the terminal's own
black. A custom Claude theme could change the color and nothing on screen moved.

Claude now exports `COLORTERM=truecolor`, which is what codex, gemini, antigravity, pi, grok,
deepseek and omp already do. Those seven also unset `NO_COLOR`; Claude does not, so a user who
exports `NO_COLOR` globally keeps the monochrome panes they asked for. `CLAUDECODE` stays
unset, because Claude reads it as a signal that it is running nested inside itself.

`buildClaudeEnv()`, the direct-PTY fallback used when tmux is unavailable, now reads the same
registry entry as the tmux pane and its attach client instead of deleting `COLORTERM` from a
hand-maintained list of its own. A remote pane still exports nothing — `buildRemoteLaunchCommand()`
never carried these declarations — so an SSH-remote Claude session keeps the old rendering.

PR #3 introduced the `unset COLORTERM` in February, citing xterm.js#484 for the claim that
xterm.js mishandles truecolor. xterm.js closed that issue in April 2019, Codeman now depends
on `@xterm/xterm` 6, and `TmuxManager` sets `terminal-overrides ",*:Tc"` on its own tmux
server, so 24-bit color already reaches the browser for the CLIs that ask for it.
