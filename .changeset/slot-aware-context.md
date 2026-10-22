---
'aicodeman': patch
---

A custom llama.cpp model whose parallel slots share a context pool too small for concurrent Claude Code requests now gets an in-app warning. Four simultaneous 40K-token requests against a 4-slot ~131K pool all failed with "Context size has been exceeded" while the old total-context check stayed silent. Discovery records each model's slot count (from `--parallel`/`-np`, or `/props` `total_slots` when the launch command states none) and the warning names the fix: `--parallel 1`, or a context large enough for every slot.
