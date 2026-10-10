---
'aicodeman': minor
---

GitHub Copilot CLI is a run mode. It appears in the Run menu, the welcome screen and the cron agent list once `copilot` is installed, runs in tmux like the other agent CLIs, reports working and idle from its `Working` footer, shows the model it reads off its footer on the tab, and is listed in CLI management with an install command (`npm install -g @github/copilot`). It takes the same launch options as the other agent CLIs: a `copilotConfig` on the session create and quick-start bodies with `model` (`--model`), `resumeSessionId` (`--resume`), `continueSession` (`--continue`) and `allowAll` (`--yolo`, which the Run button sends and which is clamped off for non-granted multi-user owners), history resume, and a `GET /api/copilot/status` probe.
