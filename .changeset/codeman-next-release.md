---
"aicodeman": minor
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

**Mac app: server tabs (#816).** The Mac app keeps several Codeman servers open in one window, one tab each in the title bar, and switches between them with a click or ⌘1 to ⌘8. Every tab shows whether its server needs you, is waiting, is working or is offline, and ⌘0 shows all servers at once with the ones that need you first. ⌘T opens another server, a tab can be renamed, coloured and dragged, ⇧⌘T reopens a closed one, and your tabs come back at the next launch. On macOS 14 and later every server keeps its own login and cookies; before macOS 14 a second tab on the same machine is refused. Behaviour change: only the server you used last keeps its per-device settings (font size, skin); every other server starts those fresh once.

**Fixes.**

- **An open tab after a restart no longer locks everyone out (#838).** A request with no `Authorization` header always gets the login prompt and is no longer counted as a failed login. Before, an open tab's background requests filled the per-IP limit within seconds of a restart, and everyone behind the same tunnel address was locked out for 15 minutes. Wrong passwords and malformed headers are counted as before.
- **Closing a dialog you opened with the mouse puts the keyboard back in the terminal (#857).** After App Settings or Session Options was opened with a click and closed again, nothing you typed reached the terminal until you clicked it. A dialog now returns the keyboard to the field you were typing in when you clicked, which with the tile grid or the split open is the pane you were in. The Session Manager and the command palette follow the same rule, and a dialog opened with the keyboard still returns to the control it was opened from.
- **The Ledger tab layout shows the working spinner again (#851).** The ledger hid the status dot and the spinner with it, so a busy session looked like an idle one. A working cell now keeps the ring.
- **The phone toolbar sits directly on the keyboard (#819).** With the keyboard open on an iPhone, an empty band sat between the toolbar and the keyboard, and the last line of the prompt you were typing was hidden under the bar above it. Both are gone.
- **Mac app: pasting an image works (#817).** ⌘V with a copied picture did nothing in the Mac app, while the same server worked in a browser. Screenshots, images copied from an app, files copied in Finder and plain text now paste with one ⌘V, also from servers on older Codeman versions.
- **The installer explains multi-user mode and keeps it across re-runs (#847).** The done screen says how to create the first admin and switch multi-user sign-in on for a systemd unit or a LaunchAgent, and a re-run keeps an existing `CODEMAN_MULTIUSER` setting.
- **A hand-written quoted value in the systemd unit survives an installer re-run.** `Environment=CODEMAN_PASSWORD="my pass"` used to be dropped when the installer rewrote the unit, which left a server bound to the LAN without its password. It is now read the way systemd reads it.

**Fixes applied while landing.** The installer prints the manual multi-user start line only where no service runs, since next to a running service it would start a second server on the same data (#847). The Files panel no longer pages through a whole large folder looking for an open folder that was deleted, shows a folder that is still waiting to load as loading instead of empty, and its error line and single-match count read correctly in Chinese and English (#848).

**Docs and tests.** The Remote Access wiki page shows how to keep `CODEMAN_ALLOWED_HOSTS` across restarts with a systemd drop-in (#845), and the kill guard, the installer's unit reader and the Files panel restore have tests that fail without them.
