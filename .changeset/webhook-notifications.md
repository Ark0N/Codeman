---
"aicodeman": minor
---

Webhook notifications. Settings → Notifications → "Webhook" posts the same events as Web Push (permission prompts, questions, errors, idle) to ntfy, Slack, Discord or any JSON URL, so a headless server can reach a phone with no browser open. Off by default. The URL is a bearer secret: it is stored in its own 0600 file, never returned by the API, and the routes (`GET`/`PUT /api/webhook`, `POST /api/webhook/test`) are admin only in multi-user mode. Delivery refuses link-local and cloud-metadata targets, does not follow redirects, times out after 5 s, dedupes repeats, and neutralises `@everyone`/Slack control characters in agent-supplied text.
