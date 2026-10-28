---
'aicodeman': patch
---

Keep parenthesised filenames with spaces clickable as one complete file path, including `.conf` configuration files. Preserve the filename's space and clickable row positions when a CLI wraps the path onto another line, instead of opening a truncated folder name. The same detector serves the terminal and Response Viewer, with the existing path guards retained.
