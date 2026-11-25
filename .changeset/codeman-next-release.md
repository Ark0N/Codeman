---
"aicodeman": patch
"xterm-zerolag-input": patch
---

### Thanks

- @HadrienKerlero for the iPhone keyboard fix (#839), nine review rounds of it, and for the report that started it (#830).
- @DodgyBadger for the Files panel that loads one folder at a time (#848), built on the design from #759.
- @kkalisz for tracking down the login lockout after a restart (#838).
- @bearyjd for the installer's multi-user guidance (#847) and the wiki section on keeping reverse-proxy hostnames across restarts (#845), a first contribution.

**Closing a tab can no longer signal every process of your account.** tmux reports pid 0 for a pane that has no process, such as an empty split beside the agent. A server restart could record that 0 for the tab, and closing the tab while that pane was the active one then signalled the children of pid 0, which is every process of the account: all sessions, tmux and the systemd user manager. A kill now never takes pid 0 or 1. Such a tab is closed by tmux alone and nothing else is signalled.

**The Files panel loads one folder at a time (#848).** Opening the panel reads only the top folder, and a folder is read when you open it, 500 entries a page with Load more. Large workspaces no longer stop at a scan limit, and Refresh keeps the folders you had open. Behaviour change: typing in the search box filters the folders already loaded, and Enter searches the whole workspace.

**iPhone keyboard suggestions, dictation and hold-delete work in the terminal (#839, fixes #830).** Tapping a suggestion used to send only its first letter, and holding delete never went word by word. Suggestions, text replacement, dictation and held delete now reach the agent as one ordered edit, in the main terminal, the split pane and every tile. A delayed Enter or paste stays with the session it was typed for when you switch tabs, and backspace deletes a whole emoji.

**Fixes.**

- **An open tab after a restart no longer locks everyone out (#838).** A request with no `Authorization` header always gets the login prompt and is no longer counted as a failed login. Before, an open tab's background requests filled the per-IP limit within seconds of a restart, and everyone behind the same tunnel address was locked out for 15 minutes. Wrong passwords and malformed headers are counted as before.
- **The installer explains multi-user mode and keeps it across re-runs (#847).** The done screen says how to create the first admin and switch multi-user sign-in on for a systemd unit or a LaunchAgent, and a re-run keeps an existing `CODEMAN_MULTIUSER` setting.
- **A hand-written quoted value in the systemd unit survives an installer re-run.** `Environment=CODEMAN_PASSWORD="my pass"` used to be dropped when the installer rewrote the unit, which left a server bound to the LAN without its password. It is now read the way systemd reads it.

**Fixes applied while landing.** The installer prints the manual multi-user start line only where no service runs, since next to a running service it would start a second server on the same data (#847). The Files panel no longer pages through a whole large folder looking for an open folder that was deleted, shows a folder that is still waiting to load as loading instead of empty, and its error line and single-match count read correctly in Chinese and English (#848).

**Docs and tests.** The Remote Access wiki page shows how to keep `CODEMAN_ALLOWED_HOSTS` across restarts with a systemd drop-in (#845), and the kill guard, the installer's unit reader and the Files panel restore have tests that fail without them.
