---
"aicodeman": patch
---

The Run dropdown scrolls. It opens upward from the toolbar with no height limit, so with every CLI, the custom endpoint entries ("Claude Code (llama.cpp)" and so on), Terminal and the saved URLs it grew taller than the room above the toolbar: its top ran off-screen and the entries up there could not be reached, worst on a phone. It is now capped to the space between the header and the toolbar (`dvh`, with a `vh` fallback) and scrolls inside that, keeping the scroll from chaining to the page, and its sub-lists (history, saved URLs) are no longer squashed to nothing as the menu fills.
