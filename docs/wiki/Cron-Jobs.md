# Cron Jobs

Saved, named jobs that start a session and send it a prompt on a schedule. Cron for agent
sessions: *every weekday at 03:00, open a Claude session in `~/proj` and tell it to update
dependencies and open a PR.*

The ⏰ **Cron** button in the bottom toolbar is opt-in. Turn it on under
**App Settings → Header & Panels → Scheduling**.

## Creating a job

1. Click **⏰ Cron**, then **+ New Job**.
2. Give it a name, pick the agent type and working directory.
3. Write the prompt, or point at a file containing it.
4. Choose a schedule and leave **Enabled** on.
5. **Save**. The job appears with its computed next run.

**Run Now** fires it immediately without touching the schedule, which is the fastest way to
find out whether the prompt does what you meant.

## The fields

| Field                    | Notes                                                                                    |
| ------------------------ | ---------------------------------------------------------------------------------------------- |
| **Name**                 | Also used as the created session's name.                                                     |
| **Agent type**           | Any run mode, including `shell`.                                                                |
| **Working directory**    | Validated when you save **and** again when the job fires. Blocked system trees are refused.  |
| **Launch command**       | Shell jobs only. Sent as the first line once the shell is up, before the prompt.             |
| **Prompt**               | Inline text, or a path to a file read at fire time.                                          |
| **Input mode**           | `typed` behaves like a human typing. `paste` writes directly.                                |
| **Schedule**             | `once`, `interval`, `daily`, or `weekly`.                                                    |
| **Enabled**              | Disabled jobs never fire on their own. **Run Now** still works.                              |
| **Concurrency policy**   | What to do if sessions of the same type are already running.                                 |
| **Auto-close previous**  | Recurring jobs only. Closes the session the previous run created. Default on.                |
| **Notes**                | Free text for you.                                                                           |

## Schedules

All wall-clock times are in the **server's local timezone**, not your browser's. A job set
for 03:00 fires at 03:00 where the server is.

| Type       | Behaviour                                                                                      |
| ---------- | ---------------------------------------------------------------------------------------------- |
| `once`     | Fires at an absolute time, then disables itself. A job missed because the server was down still fires once on the next tick. |
| `interval` | Every N minutes, from 1 minute to a year.                                                      |
| `daily`    | At HH:MM every day. If today's time has passed, the next run is tomorrow.                     |
| `weekly`   | At HH:MM on the weekdays you pick.                                                             |

Interval jobs re-anchor to when they actually fired, not to an ideal cadence, so a slow tick
or a server restart shifts later runs slightly. That drift is accepted rather than corrected.

## Prompts are single line

This is the rule people trip over. Programmatic input into an agent session is single line
everywhere in Codeman, because the terminal UIs these CLIs use treat a newline as submit. A
multi-line prompt would be silently mangled, so it is **rejected** instead: the form refuses
it, and a prompt file whose contents are multi-line fails the run with a clear message.

For anything longer than a sentence, put the instructions in a file and make the prompt tell
the agent to read it:

```
read TASKS.md and work through it
```

That is also easier to edit than a job field.

### Prompt files

Reading the prompt from a file at fire time is useful when the instructions change more
often than the schedule. The path is confined to the job's working directory, symlinks are
resolved before the check, sensitive trees are refused, and the file has to be a regular
file under 1 MiB.

If any of that fails, the run is recorded as failed and **no session is created**.

## Concurrency

Applies to scheduled runs only, never to **Run Now**:

| Policy                             | Behaviour                                                                    |
| ---------------------------------- | ---------------------------------------------------------------------------- |
| `warn_only`                        | Always launch. The count of live same-type sessions is shown but does not block. |
| `skip_if_same_agent_running`       | Skip this fire if another live session of that mode exists.                  |

The skip policy has the details you would want it to have:

- Only **live** sessions block. A tab whose CLI already exited does not count.
- Sessions the job created on its own previous runs never block it, otherwise a recurring
  job would deadlock on itself after the first fire.
- A skipped `once` job is not consumed. It stays armed and fires when the blocker goes away.
- Consecutive skips are collapsed into one record per streak, so a perpetually skipped job
  cannot bloat your state file.

## Run history

Every fire is recorded per job, with a status:

| Status            | Meaning                                                                 |
| ----------------- | ----------------------------------------------------------------------- |
| `created`         | The run started and a session was created.                              |
| `session_started` | The session was started successfully.                                   |
| `prompt_sent`     | The prompt was delivered to the session.                                |
| `skipped`         | The concurrency policy blocked it. Not counted as a run.                |
| `failed`          | The prompt could not be resolved, or the working directory was gone.    |

The history records whether the session started and the prompt was delivered, not whether the agent's task succeeded.

The schedule is advanced **before** the session launches, so a slow start cannot cause the
same job to re-trigger.

## Cron versus the other autonomy features

| Want                                                | Use                                                     |
| --------------------------------------------------- | ------------------------------------------------------- |
| Start work at a specific time                        | Cron                                                     |
| Keep an existing session working                     | [Keeping Agents Running](Keeping-Agents-Running)         |
| Drive one goal to completion across phases           | [Autonomous Loops](Autonomous-Loops)                     |

There is also an older, deliberately separate `ScheduledRun` concept behind
`/api/scheduled`: a run-now, duration-bounded loop with no recurrence and no saved jobs. The
two systems never interact, and Cron is the one you want.

## From the API

```bash
API=http://localhost:3000

curl -s -X POST "$API/api/cron/jobs" \
  -H 'Content-Type: application/json' \
  -d '{
    "name": "nightly-deps",
    "agentType": "claude",
    "workingDir": "/home/me/proj",
    "promptMode": "inline_text",
    "promptText": "Update dependencies and open a PR",
    "inputMode": "typed",
    "scheduleType": "daily",
    "dailyTime": "03:00",
    "enabled": true,
    "concurrencyPolicy": "warn_only"
  }' | jq

curl -s "$API/api/cron/jobs" | jq
curl -s -X POST "$API/api/cron/jobs/<jobId>/run" | jq
curl -s "$API/api/cron/jobs/<jobId>/runs" | jq
```

Add `-u admin:"$CODEMAN_PASSWORD"` when a password is set, and `-k` with the `https://` URL
on an HTTPS install.

## Gotchas

- **Times are the server's, not yours.** Obvious until you are travelling.
- **A `pi` job starts slowly.** The readiness poll looks for markers pi does not print, so it
  burns its poll budget before sending the prompt. The job still works.
- **A deleted working directory fails the run**, by design, rather than creating a session
  somewhere unexpected.
- **Auto-close only touches sessions this job created.** Your own tabs are never closed.

## Read next

- [Keeping Agents Running](Keeping-Agents-Running) - continuing work rather than starting it.
- [Notifications And Approvals](Notifications-And-Approvals) - hearing about a job that got stuck.
- [`docs/cron-guide.md`](https://github.com/Ark0N/Codeman/blob/master/docs/cron-guide.md) - the complete reference, including the API and SSE events.
