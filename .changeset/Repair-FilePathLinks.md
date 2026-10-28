---
'aicodeman': patch
---

Keep parenthesised filenames with spaces clickable as one complete file path, including `.conf` configuration files. For an ambiguous hard wrap, check the original concatenated filename through the existing guarded attachment route when clicked, and try the spaced filename only after a not-found response. Every original response other than not-found retains the normal opener, including workspace files whose extensions the attachment registry rejects. A spaced alternative opens only after successful registration. Preserve clickable row positions and share the spaced-path detector between the terminal and Response Viewer.

Restrict comma-separated-list detection to parenthesised candidates so existing own-line, list-marker and labelled paths with commas remain whole. A rejected workspace path is named in the attachment-lookup error without describing it as outside the workspace.

Keep the normal opener for the original filename when both hard-wrap candidates are missing, and exclude path labels and list markers inside parentheses from the lookup key.
