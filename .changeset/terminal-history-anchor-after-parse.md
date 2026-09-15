---
"aicodeman": patch
---

Keep the terminal anchored where you are reading while an agent streams (#358). Scrolling up during a Codex response could still be dragged back to the live bottom by the next redraw: the flush captured the viewport before writing and restored it immediately after, but xterm parses asynchronously, so at that moment the buffer had not moved yet, the restore compared the anchor against itself and did nothing, and the redraw landed a tick later with nothing left to pull the view back. The restore now runs inside xterm's own write callback, which is the first point at which the redraw's effect exists, and it holds across consecutive and chunked redraws. It is dropped if you switch sessions or a history replay starts before the write parses, since the anchor indexes the buffer it was captured from.
