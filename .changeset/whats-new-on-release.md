---
'aicodeman': minor
---

Each release now announces itself. `npm run version-packages` writes `src/web/public/whats-new.json` from the new CHANGELOG section (the bold headline of every change), and the first time a browser loads a newer version it shows one toast naming the headlines, with a link to the full release notes. A browser that has never opened Codeman before records the current version and stays quiet.
