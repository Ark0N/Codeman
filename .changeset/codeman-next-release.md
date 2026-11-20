---
"aicodeman": patch
---

### Thanks
- @kkalisz for Send on Enter in the phone's input field (#820), `codeman tui <name>` (#834), and a password-protected Codeman that installs as an app (#826).
- @ArizeSky for web tabs that render the DeepSeek Harness web UI and Vite dashboards (#825), and for closing a session-cookie leak on the web tab's WebSocket leg (#827).
- @JDProfresh for tracking a 174 GiB log flood down to a chokidar retry loop and fixing it (#818), and for wheel forwarding that any CLI entry can ask for (#831).
- @aakhter for the tmux 3.7 key-table fix (#821) and for Start-Codeman.sh on WSL (#822).
- @ludovicfourrage for the report and the fix that makes the header's CPU reading real CPU use (#823, #824).
- @johoja12 for Discord replies that are typed once, however often the gateway replays them (#832).
- @shenlvkang-collab for the report in #701 that led to answers on a relocated Claude config folder (#812).

**Phone: Send on Enter for the input field (#820).** A new per-device setting next to CJK Input, Input Field: Send on Enter. With both on, the field above the keyboard works like a chat box: your text stays there while you scroll the terminal to reread a question, Enter sends it, Shift+Enter adds a line and Esc clears it. The phone keyboard layout is sturdier for everyone too: a swipe on the live screen no longer closes the field's keyboard, and on iOS the bars sit on the keyboard the first time it opens.

**The terminal dashboard attaches by session name (#834).** `codeman tui <name>` attaches to a live session by its exact name as well as by its list number, so getting back into the same session over SSH no longer depends on where it sits in the list.

**Web tabs render the DeepSeek Harness web UI and Vite dashboards (#825).** The DeepSeek Harness web tab opened on a blank 401 page since `dsh web` started asking for a one-time launch token. Codeman now trades that token for dsh's session cookie and presents it only to that tab. Dashboards that ship a relative `<base href>` (what Vite and SvelteKit builds emit) and ones that load modules with `import("/...")` render through the web tab proxy too.

**Local model: Muse Glimmer 30B as its MLX build (#803).** On a Mac with 48 GB or more, Run a model on this Mac offers the MLX build of Muse Glimmer 30B. On an M5 Pro with 48 GB it wrote twice as many tokens a second as the GGUF build on the same request, and finished an OpenCode turn the GGUF build never answered. Macs with 32 or 36 GB keep the GGUF row as it was.

**Fixes.**
- **A failing file watcher no longer floods the log (#818).** When Linux ran out of inotify instances, a watcher whose `fs.watch` failed retried on each parent folder up to `/` and then forever, writing about 112,000 log lines a second until the disk filled. It now logs one warning and keeps working by polling, and the agent-teams watcher switches its live watcher back on once watching works again.
- **A password-protected Codeman installs as an app (#826).** The browser fetched the app manifest without the login cookie and got a 401, so Chrome's Install app refused. The manifest request now carries the cookie.
- **A trusted web tab's WebSocket no longer sends Codeman's session cookie to the dashboard (#827).** The HTTP leg already stripped it.
- **Answers come back for a session on its own Claude config folder (#701, #812).** A session started with `CLAUDE_CONFIG_DIR` (a second Claude account) showed "No response yet" in the response viewer, and `codeman agent read` and the Discord bridge's last message came back empty. They now read the transcript from that session's own folder.
- **tmux 3.7 to 3.7c: the prefix table and `codeman tui` keys read right (#821).** Those releases print nothing for a key table with exactly one binding, so Codeman reset its already reduced prefix table on every new session and `codeman tui` took a bound key for a free one.
- **`docker/Start-Codeman.sh` no longer hangs on WSL (#822).** Each free-port check gives up after about a second instead of waiting out the kernel's connect timeout.
- **The header CPU reading is CPU use (#823, #824).** It showed the load average per core, which read 100% on a host whose cores were mostly idle. Behaviour change: on such a host the figure is now much lower.
- **Discord: a replayed reply is typed once (#832).** A gateway replay, also after a restart, could type the same reply into a session twice. If the small store that prevents it fails, the reply is still typed.
- **A custom full-screen CLI can get the mouse wheel (#831).** The wheel went only to a fixed list of CLIs. It now follows each entry's `wheelForward` rule, so a `clis.json` entry can ask for it; stock CLIs behave as before.

**Fixes applied while landing.** The web tab proxy filters Codeman's session cookie off the WebSocket leg whether or not the dsh cookie is added, and a dsh tab created in multi-user mode still gets its cookie after a switch back to single-user mode (#825, #827). The CPU fallback no longer divides by a core count of 0 (#824). A watcher that a restart finds still failing warns again, and the watcher tests skip on macOS, where chokidar never calls `fs.watch` (#818). The Discord reply store has a test for a planted symlink at its path (#832).

**Docs and tests.** The docs name the tmux releases with the blank key-table answer, the DeepSeek web cookie rules and how a custom full-screen CLI asks for the wheel.

About 8,900 lines of code nothing reached are gone, among them the Ralph plan wizard that no button opened any more and the Agent Teams terminal windows; no route, setting or SSE event was removed. `npm run check:frontend-dead` lists frontend code nothing references.
