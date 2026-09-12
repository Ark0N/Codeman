---
"aicodeman": minor
---

feat(webview): open `localhost` links from the terminal and the Response Viewer through a proxied web tab

An agent prints `http://localhost:5173/` and the user taps it on a phone: that address
only exists on the Codeman box, so the link was a guaranteed connection error from any
other device. A loopback link (`localhost`, `*.localhost`, 127/8, 0.0.0.0, ::1) clicked in
the terminal or in the Response Viewer now opens as a proxied web tab whenever the
Codeman page itself is not on that box — reusing a saved proxied dashboard on the same
origin (with the link's own path opened inside it) or saving one under its host:port.
LAN and tailnet addresses, which the device may reach directly, keep opening in a new
browser tab, and on the box itself every link opens directly.
