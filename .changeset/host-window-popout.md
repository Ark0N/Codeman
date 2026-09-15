---
"aicodeman": minor
---

feat(mobile): pop a session or a file preview out beside the dashboard from a native wrapper

A WebView app has no browser pop-ups, so "Open in a new window" had nothing to open on a
phone, and mobile.css hid it there. An embedding app that can put a page in a window of its
own (an Android app on a foldable or in split screen) now says so with
`window.CodemanHost.openWindow(absoluteUrl)`, returning whether a window opened. When it is
present, the tab pop-out, the file viewer's detach button and a web tab's "open externally"
go through it, and the tab's pop-out icon defaults on and shows at tablet widths (phone tabs
keep their gear + close tap zones, so the host offers the pop-out from its own chrome through
`app.detachSession`). The dashboard
tracks such a window over the existing window channel, the path a reloaded dashboard already
uses, and a solo window closes and raises itself through the optional
`CodemanHost.closeWindow()` / `CodemanHost.focusWindow()`. Browsers define none of these, so
nothing changes there.
