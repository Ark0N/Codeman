---
'aicodeman': minor
---

The plan-usage chip in the header gains a `Copilot` row: the calendar-month premium-request quota, with the request counts and the reset in the tooltip. The host reads it every 10 minutes from GitHub's `copilot_internal/user` endpoint with the Copilot CLI's own sign-in token. It is on by default while the CLI is installed and signed in (an absent Plan Usage Limits setting reads as on), and turning Plan Usage Limits off in App Settings stops the request. Any failure leaves the chip without a Copilot row. The FAQ, Installation and Security pages say so.
