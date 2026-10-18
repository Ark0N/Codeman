---
'aicodeman': minor
---

The plan-usage chip in the header gains a `Copilot` row: the calendar-month premium-request quota, with the request counts and the reset in the tooltip. The host reads it every 10 minutes from GitHub's `copilot_internal/user` endpoint with the Copilot CLI's own sign-in token, only when the CLI is installed, signed in and the plan-usage chip is on, so turning the chip off stops the request. Any failure leaves the chip without a Copilot row. This is the one request Codeman makes on its own, and the FAQ, Installation and Security pages now say so.
