---
"aicodeman": patch
---

The DeepSeek Harness web tab opens on the dashboard again instead of a blank 401 page. `dsh web` now gates its own index behind a one-time launch token it prints on boot; the supervisor reads that token out of the captured output, trades it for the session cookie once at startup, and the webview proxy presents the cookie on both the HTTP and WebSocket legs — scoped to the loopback authority it was minted for. A dsh without the gate keeps working unchanged.
