# HTTP API

Codeman's HTTP and SSE API is a **stable contract**. Everything the dashboard does goes
through it, so anything the dashboard can do, a script can do.

This page is the orientation. The complete specification, including every wait semantic and
the SSE catalogue, is
[`docs/api-reference.md`](https://github.com/Ark0N/Codeman/blob/master/docs/api-reference.md).

## What is stable

Covered by semantic versioning: endpoint paths under `/api/v1`, the response envelope,
`errorCode` values, and SSE event names.

Not covered, and free to change in a patch release: on-disk state files, internal modules,
and anything marked experimental. The full statement is in
[Versioning](Versioning).

`/api/v1/*` is a versioned alias of `/api/*`. Prefer the versioned form in anything you
intend to keep.

## The envelope

```json
{ "success": true, "data": { } }
```

```json
{ "success": false, "error": "human readable", "errorCode": "NOT_FOUND" }
```

A few legacy GET handlers return bare bodies rather than the envelope, so a robust client
reads `body.data ?? body`.

Branch on `errorCode`, which is stable. The HTTP status is reliable too:

| `errorCode`        | HTTP | Meaning                                          |
| ------------------ | ---- | ------------------------------------------------ |
| `INVALID_INPUT`    | 400  | Malformed request or failed validation.           |
| `UNAUTHORIZED`     | 401  | Authentication required or failed.                |
| `NOT_FOUND`        | 404  | No such resource.                                 |
| `SESSION_BUSY`     | 409  | The session is busy.                              |
| `CONFLICT`         | 409  | Conflicts with current state.                     |
| `ALREADY_EXISTS`   | 409  | Resource already exists.                          |
| `OPERATION_FAILED` | 422  | Well formed, could not be completed.              |
| `RATE_LIMITED`     | 429  | Too many requests.                                |
| `INTERNAL_ERROR`   | 500  | Unexpected server error.                          |

New error codes are non-breaking. Removing or renaming one is a major change.

## Cron Jobs

Saved scheduled jobs that start a session and deliver a prompt. See [Cron Jobs](Cron-Jobs) for the user-facing guide.

These routes are under `/api/cron` (also available as `/api/v1/cron`). They are part of the HTTP surface; request and response shapes follow the same patterns as other endpoints.

| Method | Path                         | Description                          |
| ------ | ---------------------------- | ------------------------------------ |
| GET    | `/api/cron/jobs`             | List jobs visible to the caller.     |
| POST   | `/api/cron/jobs`             | Create a job.                        |
| GET    | `/api/cron/jobs/:id`         | Get one job.                         |
| PUT    | `/api/cron/jobs/:id`         | Update a job (partial body).         |
| DELETE | `/api/cron/jobs/:id`         | Delete a job.                        |
| PUT    | `/api/cron/jobs/:id/enabled` | Enable or disable a job.             |
| POST   | `/api/cron/jobs/:id/run`     | Run the job immediately.             |
| GET    | `/api/cron/jobs/:id/runs`    | List run history for one job.        |
| GET    | `/api/cron/runs`             | List run history across jobs.        |

Create body (POST) requires `name`, `agentType`, `workingDir`, `promptMode`, `inputMode`, `scheduleType`, `enabled`, `concurrencyPolicy`, plus the fields required by the chosen modes (e.g. `promptText` for `inline_text`, `dailyTime` for `daily`). See `src/web/schemas.ts` (`CronJobSchema`) for the full validation rules.

Responses return the job object or `{ job }` / `{ run, activeAgents }` as appropriate. Errors use the standard envelope (`NOT_FOUND`, `FORBIDDEN`, `INVALID_INPUT`, etc.).

The run history statuses are `created`, `session_started`, `prompt_sent`, `skipped`, and `failed`. The history records whether the session started and the prompt was delivered, not whether the agent's task succeeded.

## Quick examples

```bash
API="${CODEMAN_API_URL:-http://localhost:3000}"

curl -s "$API/api/status" | jq                     # whole-system snapshot
curl -s "$API/api/sessions" | jq '.data[].name'    # live sessions
curl -s "$API/api/sessions/unified" | jq           # live + historical, deduped
curl -s "$API/api/subagents" | jq                  # background agents
curl -s "$API/api/search?q=deploy" | jq            # cross-session search
curl -s "$API/api/mcp-sync" | jq                    # preview MCP server sync (opt-in: 403 until mcpSyncEnabled is on)
curl -s -X POST "$API/api/mcp-sync" | jq             # apply it: add missing servers to each CLI config, never edit/remove

# with ID set to a session id:
curl -s "$API/api/sessions/$ID/last-response" | jq -r '.data.text'   # last answer, from the transcript (claude, codex, deepseek)
curl -s "$API/api/model-endpoints" | jq                                # saved custom OpenAI-compatible endpoints
curl -s -X POST "$API/api/sessions/$ID/custom-model" -H 'Content-Type: application/json' \
  -d '{"endpointId":"local-llama","modelId":"qwen3-27b"}' | jq        # restart the CLI on that endpoint; {"clear":true} undoes it
```

## Limits

| Limit                 | Default                                    |
| --------------------- | ------------------------------------------ |
| Max sessions          | 50                                          |
| Max agent windows     | 500                                         |
| Max SSE clients       | 100                                         |
| Terminal buffer       | 32 MB per session                           |
| Text payload          | 1 MB                                        |
| Wait timeout ceiling  | 600 s, and the response tells you what was applied |

Most are environment-overridable. See `src/config/`.

## Read next

- [Driving Codeman From An Agent](Driving-Codeman-From-An-Agent) - the practical version, with recipes.
- [Hooks And Integrations](Hooks-And-Integrations) - events flowing back into Codeman.
- [Versioning](Versioning) - what the version number promises.
- [`docs/api-reference.md`](https://github.com/Ark0N/Codeman/blob/master/docs/api-reference.md) - the full specification.
