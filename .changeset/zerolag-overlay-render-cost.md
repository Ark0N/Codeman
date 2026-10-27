---
"aicodeman": patch
"xterm-zerolag-input": patch
---

**Typing stays smooth in a long prompt.** The local echo overlay (the instant preview of what you type before the session echoes it back) used to throw away and rebuild every character of the prompt on each keystroke, so the longer the prompt, the slower each key. On a phone-class CPU it dropped below 60 fps at about 300 characters, and at about 4,000 characters a single keystroke took most of a second to appear. It now rebuilds only the line that changed, and each line is one paint layer instead of one layer per character, so a keystroke costs the same however long the prompt is. What you see is unchanged: every character still sits on its terminal cell, within 1/8 px. This ships in `xterm-zerolag-input` as well: the README's rendering section describes the new layout.
