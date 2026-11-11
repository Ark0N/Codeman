---
"aicodeman": minor
---

### Thanks

- @Randalix for auto-compact and auto-clear that see the whole context (#777), and for the measurements in #585 that showed why they did not.
- @JDProfresh for the report and the change that lets the File Viewer edit `.env` files (#796, #797).
- @timkjr for omp tool approvals that raise an alert (#798).
- @irisitymichaelgrundberg for finding why Firefox still pasted twice (#799).

**Local models: a library, more models, and the coding agent you choose (#803, #804, #806, #807, #808).** Run a local model (on a Mac) now lists every model that fits instead of five, with two new ones: Muse Glimmer 30B, the first of its class a 32 GB Mac can hold, and Ornith 1.0 9B, the first model that fits a 16 GB Mac. Installed models form a library: each shows its size on disk, and you can add another, switch between them or delete one. You pick the coding agent when you start a session (OpenCode, Claude Code, Pi or DeepSeek Harness), and a missing one installs from the same screen. The codeman skill starts a local worker with the agent you name (`spawn_worker <name> local:pi`), and the wiki has a new Local Models page. Still experimental.

**Mac app: With the Lid Closed no longer asks for a password.** Codeman > Keep This Mac Awake > With the Lid Closed is a plain switch now. 1.50.1 asked for your administrator password and installed a small root helper for it. The app now does what [LogoLight](https://logolight.app) does: it turns off macOS's sleep-on-lid-close itself while your agents work, and turns it back on when they stop, when the app quits or crashes, and on battery. If you ticked With the Lid Closed in 1.50.1, it keeps working after the update, and the old helper does nothing any more. Remove it with Codeman > Keep This Mac Awake > Remove the Old Lid Helper… (that asks for your password one last time). If the Mac ever sleeps under the lid anyway, the status line in the same menu says until when.

**Auto-compact and auto-clear see the whole context (#777).** Both compared a token counter that never counted the cached part of a conversation, so on a long session they fired far too late or not at all. For Claude sessions they now read the context size Claude Code reports, and a threshold can go up to the model's window (1M with extended context). Behaviour change: a session with auto-compact or auto-clear on fires earlier than it did, because 110k and 140k now mean the real context. Other CLIs, remote and Docker sessions keep the old counter.

**jcode as a run mode (#650).** Codeman can now start [jcode](https://github.com/1jehuang/jcode) sessions from the Run menu, the phone overview and the API (`mode: "jcode"`), locally, over SSH and in Docker cases. jcode runs every session's tools in one shared background daemon, so closing a jcode tab never stops that daemon, its sessions get no Codeman agent skill, and a jcode worker's answer is read from its terminal; see `docs/jcode-integration.md`.

**The File Viewer edits `.env` files (#796, #797).** A workspace `.env`, `.env.local` or `prod.env` opened in the preview but could never be edited. It now gets the pencil like any config file, and a save keeps the file's mode and group. Other credential files (`.npmrc`, `credentials.json`, anything under `.ssh/`) and Codeman's own `~/.codeman/.env` stay read-only there, and downloads and attachments still refuse dotenv files.

**Fixes.**

- **Firefox no longer pastes twice on Ctrl+V (#799).** Firefox sent a second paste for the same key press, and some of the time it reached the terminal.
- **An omp pane that asks for a tool approval alerts (#798).** It raised no tab alert, no notification and no Approvals Inbox item. Behaviour change: Codeman writes a small hook file into `.claude/hooks/pre/` of an omp session's folder.

**Fixes applied while landing.** Auto-compact and auto-clear decide again at the moment the command goes out, so a `/clear` is not sent into a conversation Claude Code just compacted itself, into a session paused on a usage limit, or after you switched the option off (#777). The File Viewer cannot reach Codeman's own `.env` by another spelling on a case-insensitive disk (#797). An omp alert stays up until omp says its dialog closed (#798).

**Docs and tests.** The experimental API list names the new local model routes, and the wiki's Local Models page walks from install to cloud plus local.
