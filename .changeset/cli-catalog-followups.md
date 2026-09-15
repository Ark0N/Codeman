---
"aicodeman": patch
---

Cleans up the loose ends the maintainer flagged as "worth knowing rather than fixing" when
merging the CLI-catalogue-driven `install.sh`/Docker-agent-image PR (#380):

- `install.sh` no longer carries `_cli_index`/`check_cli`/`get_cli_path`, three generic
  lookup helpers left behind once the catalogue-driven menu and hints stopped calling them.
- The generator no longer emits `CLI_KIND`/`CLI_NPM`, two bash arrays nothing in `install.sh`
  read (the `.mjs`/`docker-hosts.ts` producers already read the JSON catalogue's `kind`/
  `npmPackage` fields directly).
- `detect_all_clis` now skips a disabled entry entirely rather than probing it and filtering
  the result downstream — no stock entry ships disabled today, so this is a latent
  inefficiency closed before it is a latent bug, not a behaviour change.
- The install hint for a `launcherProfile` entry (DeepSeek today) now explains, in one line,
  why it is a docs link rather than a runnable command — its docs page documents
  `npm install -g @deepseek-ai/dsh`, which installs the launcher only and cannot drive a pane
  on its own, the exact trap the menu already avoids by withholding the command. Driven by a
  new generated `CLI_LAUNCHER_ONLY` array (from `discovery.launcherProfile`), not an id check.
- The non-interactive default's comment no longer claims it is always Claude Code: on a
  wget-only host, Claude's curl one-liner is filtered out of the offered list first, so the
  default becomes whichever npm-based entry sorts earliest instead. Behaviour is unchanged
  (and was already printed, so never silent) — only the comment was wrong.
