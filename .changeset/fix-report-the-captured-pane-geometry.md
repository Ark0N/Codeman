---
"aicodeman": patch
---

fix(terminal): replay a pane capture at the geometry it was taken at

A visible-frame capture repaints each row at an absolute position, counting up
to the pane's height. A terminal shorter than that clamps every address past
its own height onto its last line, so the overflow rows overwrite one another
and the rows underneath are lost. Against a 50-row pane, a 30-row terminal
rendered 28 of a 45-line command and drew the surviving frame twice.

Nothing in the response said what height the frame was built for, so the client
could not detect this. A capture now reports the geometry it was really taken at
through `capturedGeometry` on `PaneCaptureOptions`, and the terminal response
carries it as `captureCols` and `captureRows`. When the captured pane is taller
than the terminal, or the size that produced the capture did not survive the
load, `selectSession` replays once at the size that stuck. `resizeRetry` caps
that at one attempt, so two competing fits cannot trade replays forever.

That repairs the case where a capture won a race against the resize meant to
precede it. It does not repair a capture whose pane was too tall because
`Session.resize` declined the resize outright, which it does for a small
viewport while a desktop viewport's size claim is live: the retry re-sends the
same declined resize and captures the same pane. The reported geometry still
helps there, because the client can see the mismatch at all.
