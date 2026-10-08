---
'aicodeman': patch
---

Create New → custom folder no longer refuses every folder below the cases folder. Only the cases folder itself and its direct children are refused, because those are the only ones Codeman lists as local cases (a second registration would show them twice). With the cases folder set to a broad root such as `/mnt/user/Scripts` (`CODEMAN_CASES_PATH`), a folder like `/mnt/user/Scripts/GitHub/me/new-project` can now be created and linked. The refusal message now names the cases folder.
