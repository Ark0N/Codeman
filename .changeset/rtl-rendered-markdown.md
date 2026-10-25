---
'aicodeman': patch
---

Persian, Arabic and Hebrew now read right to left in the Response Viewer and in the File Viewer's markdown view (#715). Each paragraph, heading, list, quote and table takes its direction from its own first letter, so a right-to-left answer is right-aligned with its punctuation, list bullets and quote bar on the right, while an English paragraph beside it stays left to right. Code blocks, inline code and file paths stay left to right and no longer decide a sentence's direction, so a Persian sentence that starts with `npm install` still reads right to left. The phone's Compose dialog lays a right-to-left prompt out the same way. The terminal pane is unchanged: xterm.js has no right-to-left support yet (xtermjs/xterm.js#701).
