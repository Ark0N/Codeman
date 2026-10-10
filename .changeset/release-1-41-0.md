---
"aicodeman": minor
---

### Thanks
- @Randalix for `codeman agent` (#557), the session verbs (`ls`, `spawn`, `send`, `wait`, `read`, `interrupt`, `rm`) for agents in every CLI mode, and for moving every test server onto an ephemeral port (#570), which finishes #440. Thanks also for reporting and fixing git's clone errors on non-English hosts (#568, shipped as #572 with your commit).
- @opticon454 for four PRs: an Apply button that saves Settings without closing them (#565), configurable toast and browser-notification display times (#564), in-document links in rendered markdown that scroll to their heading (#563), and npm-based CLI installs that work when the system npm prefix is root-owned (#562).
- @JDProfresh for upload failures that say why they failed (#578).

![Codeman tile grid: six live agents powering on and off with the CRT tile animation](https://raw.githubusercontent.com/Ark0N/Codeman/fc7ffe1ad899b894bc4f15380dd40af592e8be22/docs/images/tiles-crt-20261010.gif)

**Tile Animations (#571).** The tile grid from 1.40.0 can now open with a show. App Settings has a new **Animations** section (right after Appearance) that holds every animation setting: the Entrance Theme (moved out of Appearance), the new **Tile Animations** row, and a button that opens the animation lab. Tile styles: **CRT** (each tile switches on as a hot line in a diagonal wave, and switches off to a line and a dot), **Fly from tab** (each tile grows out of its session tab and flies back into it), **Deal** (dealt out of the Tiles button like cards), **Beam down**, **Cascade**, **Pop**, **Soft** and **None**. A styled tile plays in two beats: the frame enters in the tile style, then its screen powers on in the terminal style of your Entrance Theme. Picking a theme presets a matching tile style, and a new **Launch** theme flies the tiles out of their tabs. Off by default (the grid keeps its quick fade), per device, nothing moves under reduced motion, and the animations never cost an extra PTY resize. The terminal pane's Boot entrance style is gone; a saved Boot falls back to off.

**The wheel scrolls Claude inside a tile (#577).** In a tile or the split's second pane, a Claude session on its fullscreen renderer now scrolls its own conversation with the mouse wheel, exactly like the main terminal: the wheel goes to Claude as mouse reports, aimed at that tile's session and computed from the tile's own screen. Before, the wheel did nothing or scrolled the stale frames left over from loading the tile. Shift+wheel (scroll local history) works in every tile on Windows and Linux too; it was dead there.

**`codeman agent`: session verbs for every CLI (#557).** Agents in any mode (Codex, OpenCode, Gemini, Pi and the rest, not just Claude) can now drive other Codeman sessions from the command line: `codeman agent ls | spawn | send | wait | read | interrupt | rm`. It is a thin client over the existing session API: every call names the session that made it, `wait` blocks on a signal (`--until stop,exit`) or a literal output marker (`--match`), and exit codes say what happened (`0` ok, `1` error, `2` timeout, `3` exited, `4` refused). Ids shorter than 8 characters are refused, so a stray `rm 9` can never pick a session at random, and `rm` never deletes the session it runs in. See the README section "`codeman agent`" and the wiki page Driving Codeman From An Agent. This is phase 1 of #445.

**Settings: Apply (#565).** Next to Save, an Apply button saves the same way but keeps Settings open. Switching on MCP server sync makes its Preview and Sync usable straight away, and CLI management's add, enable and disable work without closing and reopening Settings.

**Notifications stay as long as you want (#564).** Settings → Notifications has a Toast display time and a Browser notification display time (seconds, per device; the defaults stay 3 s and 8 s).

**CLI logos on tabs can be switched off (#569).** App Settings → Appearance → Tabs → **CLI Logos on Tabs** hides the agent logo on every tab surface (header strip, rails, sidebar, phone chips, the desktop home list) on this device. On by default. Tile headers, split pane headers and the Run menus keep their logos.

**Fixes.**
- **Clone errors on non-English hosts (#572, from #568).** Cloning a repository as a case now classifies a failed clone correctly whatever the host's language: a missing branch or tag is "does not exist on the remote" (400) and a missing repository is a 404, instead of a generic 422 with git's German (or any other) error text. Git runs with `LC_ALL=C` for clones and repo status, so the repo status card's error text is English on every host as well.
- **Links within a markdown file (#563).** A link to another heading of the same document (`[Install](#installation)`) in the File Viewer or Response Viewer scrolls to that heading instead of doing nothing. Headings get GitHub-style slugs, repeated titles are numbered, and non-ASCII headings work.
- **npm CLI installs on a root-owned prefix (#562).** Installing an npm-based CLI from Settings (DeepSeek's `dsh`, pi, ...) no longer fails with EACCES when the system node keeps its global prefix under `/usr`: the install goes to `~/.local`, where Codeman already looks for CLIs. A prefix you set yourself, or one you can write to, is left alone, including when Codeman runs under `npm run`.
- **Upload failures say why (#578).** When a prompt image upload fails, the toast shows the server's reason (for example a rate limit) instead of only "1 failed".
- **New cases ask for clickable file paths.** The CLAUDE.md generated into a new case asks the agent to report every file it created as a full absolute path, which Codeman turns into a link that opens the File Viewer, and mentions the codeman skill for starting and managing worker sessions.

**For contributors (#570).** Every in-process test server binds an ephemeral port, the mobile suite included, and the port guard now also refuses raw listeners on a fixed port, so two test runs on one machine never collide.

**Fixes applied while landing.** zh-CN translations for the two new notification display-time settings, and test and doc cleanups left over from review.
