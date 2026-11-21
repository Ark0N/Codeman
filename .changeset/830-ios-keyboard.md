---
'aicodeman': patch
'xterm-zerolag-input': patch
---

Fix iOS keyboard suggestions, phrase replacement, dictation and hold-delete by retaining native input ownership in each terminal pane. Preserve local-echo Enter ordering across session switches, reset native editing at toolbar and programmatic input boundaries, and show the native trackpad caret on the exact cell of the visible input, including across wide-character wraps, with emoji-safe deletion. The local-echo overlay deletes one grapheme cluster per backspace and adds `getInputEndAnchor()`, `getInputAnchor(offset)`, `committedText` and `onLayout()` for hosts that position a caret against the drawn input.
