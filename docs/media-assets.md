# Media assets: videos and GIFs

Codeman produces a lot of video: README GIFs, website loops, release-note clips, promo videos and their drafts, raw screen captures. This page says where each kind lives and which of them belong in git.

## The rule

**Only media that a public page embeds is pushed to GitHub. Everything else stays on the maintainer's machine, in the local media library.**

| Kind | Where it lives | On GitHub? |
| --- | --- | --- |
| GIFs the README, the wiki or a published article embeds | `docs/images/` on `master` | yes |
| Release-note and media-kit clips | the orphan `design-assets` branch | yes, but never on `master` |
| getcodeman.com videos and GIFs | `pr/website/assets/` (local, deployed to Cloudflare Pages) | no |
| Masters, promo videos, drafts, shorts, feature clips, raw captures | `pr/media/` (the local media library) | no |
| Remotion render inputs for the promo videos | `scripts/remotion/public/` on the unpushed promo branch | no |

`.gitignore` enforces it: `*.mp4`, `*.webm`, `*.mov`, `*.m4v`, `*.mkv`, `*.avi` and `*.gif` are ignored everywhere except `docs/images/*.gif`, plus `scripts/remotion/public/`, whose render inputs the promo branch tracks. A video that really must be committed needs `git add -f`, which makes the exception visible in review.

A GIF that leaves `docs/images/` stays in git history, so removing it does not shrink a clone. The rule keeps new weight out and the tree honest about what is actually used.

## Tracked GIFs (`docs/images/`)

| File | Embedded in | Shows |
| --- | --- | --- |
| `tiles-crt-stats-1600-20261010.gif` | README hero (en + zh-CN) | six live agents in the tile grid, powering on and off with the CRT animation, header stats on |
| `tile-grid-20261009.gif` | README, Tile Grid section | the Tiles button opening six live sessions side by side, and closing them |
| `zerolag-demo-20260728.gif` | README, wiki `Input-And-Voice`, `packages/xterm-zerolag-input/README.md`, CHANGELOG, getcodeman.com docs | instant local echo next to slow server echo, on two phones |
| `codeman-tab-states-20261010.gif` | README, Tab Alerts section | annotated tab states: working, blocked on a question, idle |
| `codeman-skill-crt-20261010.gif` | README, agent skill section; wiki `Codeman-Skill` (getcodeman.com docs show the MP4 cut) | one prompt to Claude Code spawning and driving two worker sessions through the skill |
| `codeman-skill-grid-20261015.gif` | README, agent skill section (Step 2); wiki `Codeman-Skill` (getcodeman.com docs show the MP4 cut) | one prompt to a Claude Code lead, five Claude Code workers powering on as tiles in the grid |
| `codeman-skill-tabs-20261015.gif` | README, agent skill section (Step 3); wiki `Codeman-Skill` (getcodeman.com docs show the MP4 cut) | one prompt to a Claude Code lead, eight worker tabs powering on with lineage lines, then a click into a live worker |
| `subagent-demo-20260724.gif` | the "mission control" article on dev.to, Hashnode and Medium (hotlinked from `master`) | subagent windows fanning out |

Before removing one, search for hotlinks: `README*.md`, `docs/wiki/`, `packages/*/README.md`, `CHANGELOG.md`, the site (`pr/website/`), and published articles, which link `raw.githubusercontent.com/Ark0N/Codeman/master/docs/images/<file>` and break silently.

On 2026-10-13, seven GIFs that no page embedded left `docs/images/` and moved into the library: `codeman-demo.gif`, `codeman-skill-20261010.gif`, `subagent-demo-new.gif`, `subagent-demo-opt.gif`, `tab-alerts-glow-20260815.gif`, `tiles-crt-20261010.gif`, `tiles-crt-stats-20261010.gif`.

### Adding or replacing a README GIF

1. Keep the master (the lossless MP4 or the full-size GIF) in `pr/media/clips/<feature>/`, or in the project folder it came from.
2. Commit only the size the README shows, named `<feature>-<YYYYMMDD>.gif`, and keep it lean: the current ones are 0.8 to 10 MB.
3. A replaced GIF leaves `docs/images/` in the same commit, unless something outside the repo hotlinks it (see above).

## Website media (getcodeman.com)

The site is built and deployed from `pr/website/` (gitignored) with `pr/deploy-site.sh`. Its `/docs` pages are generated from `docs/wiki/`, and a wiki GIF that has an MP4 cut of the same run on the site is shown there as that video (the README and the GitHub wiki keep the GIF, since GitHub cannot autoplay inline video). Its videos and GIFs sit in `pr/website/assets/` because that directory is what gets uploaded: they are web cuts (1280 to 1600 px wide, high CRF, posters next to them) derived from masters in the library. `pr/site-notes.md` records how each one was cut and from which master. A few superseded files stay deployed on purpose, so links that point at them keep resolving.

## Release notes and the media kit (`design-assets` branch)

GitHub releases and the Announcements discussions embed clips from the orphan `design-assets` branch (`release-1.40/`, `release-1.41/`, `media-kit-2026-10/`). They are referenced by a commit-pinned raw URL, so the branch can change later without breaking old notes, and none of it ever touches `master`.

## The local media library (`pr/media/`)

`pr/` is gitignored, so the library is never pushed. It holds every master, every finished promo cut and every superseded draft in one tree:

```
pr/media/
  README.md          curated guide: what each collection is, which cut is current, where it is published
  INVENTORY.md       generated list of every file (size, length, resolution, fps, date, published-or-not)
  inventory.mjs      regenerates INVENTORY.md: node pr/media/inventory.mjs
  videos/<production>/        finished promo videos; superseded renders in drafts/
  shorts/<episode>/           per-feature cuts of a promo; older sets in drafts/
  clips/<feature>/            feature loops and GIF masters (README / site / release clips start here)
  crt-gifs/                   CRT tile-animation loops
  files-one-click-20261011/   the Files panel loop project (own README)
  screenshots-hq/             high-res stills and their capture masters
  raw-captures/               unedited screen recordings, safe to prune
```

Two working directories keep files the library only archives, because tools read them from fixed paths: `pr/website/assets/` (the deploy upload) and the promo worktree's `scripts/remotion/public/` (Remotion's `staticFile()` inputs). Renders still land in `scripts/remotion/out/` and are filed into `pr/media/videos/<production>/` once checked. A finished render never goes to `tmp/`.
