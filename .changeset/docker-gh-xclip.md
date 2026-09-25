---
'aicodeman': patch
---

The Docker images now install `xclip` together with the optional GitHub CLI (`CODEMAN_INSTALL_GH=1`), so `gh auth login` can copy its device-login code where an X11 clipboard is available. Images built without the GitHub CLI are unchanged.
