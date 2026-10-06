---
"aicodeman": patch
---

Fix text being duplicated when an Android keyboard autocorrects while typing straight into the terminal prompt. SwiftKey and Gboard autocorrect on space by deleting the word and inserting the corrected one; xterm answered by sending the whole helper-textarea value (it diffs with `newValue.replace(oldValue, '')`, which only works for appends) and then the inserted text a second time, so `testing the peompt` + space reached the shell as `testing the peompttesting the prompt rompt `. A multi-character delete was also sent as a single DEL. The keyCode-229 controller now replaces xterm's `_handleAnyTextareaChanges` with an edit-based diff against the value already sent (DEL per deleted character, then the new text, once), and puts xterm's own handler back on teardown.
