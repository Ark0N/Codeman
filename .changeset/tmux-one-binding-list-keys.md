---
'aicodeman': patch
---

A tmux built from master (`next-3.7`) prints nothing for `list-keys -T prefix` when the prefix table holds exactly one binding, which is the shape Codeman reduces it to. Codeman then reset the already reduced table on every session create, and `codeman tui` read a bound key as free, so it could claim a key the user relies on. Both now read a blank answer from the full `list-keys` listing. tmux 3.4 is unchanged.
