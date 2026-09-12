---
"aicodeman": patch
---

fix(web): show the whole last turn in the Claude response viewer's brief view

The eye button rendered `text`, which is one row — the last assistant row — while a
Claude answer is a median of 3 model messages (p90 11) split around tool calls, so the
brief view usually showed the tail of an answer ("Done.") and the substance only after
More. The brief view now asks `GET /api/sessions/:id/last-response?context=turn`, which
returns the assistant messages of the last answered turn, and renders them the way the
full view renders that turn: one badge, then continuation segments. `text` stays the last
assistant row in every mode (agent pollers hash it), a prompt queued after the answer does
not blank the view, and readers without turns (Codex, the pane parser, an older server)
keep their single card.
