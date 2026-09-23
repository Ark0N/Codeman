---
'aicodeman': patch
---

fix(sessions): stop pinning the `w1-myapp` placeholder as Claude's session title. Local Claude spawns passed the tab name as `--name`, which is also the `/resume` picker entry and the terminal title, and a pinned title stops Claude generating its own, so every conversation of a case showed up in `/resume` as the same `w1-myapp` and none got a generated title. Only a name the user chose is pinned now; placeholder and auto-named tabs let Claude title the conversation again. Renaming a Claude tab also reaches `/resume`: the new name is appended to the conversation's transcript as the `custom-title` row `/rename` writes (a tab that was spawned with `--name` keeps re-appending its own title until its next respawn, so the rename wins from then on). Orchestrators that rely on a fixed peer name should give workers a descriptive `sessionName` rather than a `w<N>-` one.
