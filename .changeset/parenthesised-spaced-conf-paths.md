---
'aicodeman': patch
---

A parenthesised absolute file path whose name contains a space (`(/mnt/data/Kobo/Kobo eReader.conf)`, including one hard-wrapped between the words) is linked as that whole file. A relative path or a bare spaced filename inside parentheses is left to the ordinary detectors, which still need an explicit path label for a spaced relative path. `.conf` is a link extension, the same text the attachment routes already serve. The space the wrap consumed stays in the path when that parenthesis starts the broken-off token (or is separated from it by whitespace only) and the next token closes it right after the extension, and the clickable cells stay on the rows that hold the name.
