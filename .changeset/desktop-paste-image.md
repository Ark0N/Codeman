---
"aicodeman": patch
---

**Mac app: pasting an image works.** ⌘V with a copied picture in a session's terminal did nothing in the Mac app, while the same server worked in a browser. Codeman's paste asks the browser for the clipboard first, and inside the app WebKit answers that with a hidden "Paste" permission menu that held up the real paste. The app now declines that request the way Chrome does, so the picture uploads and its path lands in the prompt, the same as in a browser. Screenshots, images copied from an app, files copied in Finder and plain text all paste with one ⌘V, also from servers on older Codeman versions.
