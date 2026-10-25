---
'aicodeman': patch
---

The rendered markdown in the File Viewer now fills the window as the window grows. The rule carried a fixed 960px reading column that shipped before the window could be resized, so text stopped reflowing once the window was dragged or expanded past it, while the plain-text view already filled it. A narrow window is unchanged, because a cap only binds when content is wider than it. Pinned by test/file-preview-window.test.ts.
