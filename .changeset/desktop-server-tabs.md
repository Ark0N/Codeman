---
"aicodeman": patch
---

**Mac app: server tabs.** The Mac app now keeps several Codeman servers open in one window, one tab each in the title bar, and switches between them with a click or ⌘1 to ⌘8. Every tab shows whether its server needs you, is waiting, is working or is offline, and ⌘0 shows all servers at once with the ones that need you first. ⌘T opens another server, a tab can be renamed, coloured and dragged, ⇧⌘T reopens a closed one, and your tabs come back at the next launch. On macOS 14 and later every server keeps its own login and cookies; before macOS 14 a second tab on the same machine is refused. Behaviour change: only the server you used last keeps its per-device settings (font size, skin); every other server starts those fresh once.
