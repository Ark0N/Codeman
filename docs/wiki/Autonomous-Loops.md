# Autonomous Loops

Two features that go further than "keep the session going": the **Ralph loop**, which works
a task list to completion in one session, and the **Orchestrator**, which turns a goal into
a phased plan and drives it across agents.

Both are Claude-only, both are off by default, and neither is where to start. If what you
want is an agent that keeps working overnight, that is
[Keeping Agents Running](Keeping-Agents-Running), and it is simpler, better understood, and
what most people actually use.

## Which one, if either

| You have                                          | Use                                                          |
| ------------------------------------------------- | ------------------------------------------------------------ |
| A session that stops too early                     | [Respawn](Keeping-Agents-Running)                             |
| A written task list to grind through               | Ralph loop                                                    |
| One large goal that needs planning and checkpoints | Orchestrator                                                  |
| Work that should start at a certain time           | [Cron Jobs](Cron-Jobs)                                        |
| Several workers to fan out and supervise           | [Driving Codeman From An Agent](Driving-Codeman-From-An-Agent) |

## The Ralph loop

Named after the Ralph Wiggum pattern: keep feeding the agent its own task list until the
list is empty.

The shape of it:

- The task list lives in a plan file in the case, conventionally `fix_plan.md`.
- Each cycle the agent reads the plan, works the next incomplete task, and marks progress.
- Codeman watches the file, tracks todos, and detects stalls.
- The loop ends when the agent signals completion, when the iteration cap is reached, or
  when you stop it.

Start it from **Session Options → Ralph / Todo**.

| Setting                | What it does                                                             |
| ---------------------- | ------------------------------------------------------------------------ |
| Max iterations         | Hard ceiling on cycles.                                                   |
| Max todos              | Cap on tracked tasks, default 500, oldest evicted first.                   |
| Todo expiration        | Auto-expiry for stale todos, default 60 minutes.                           |
| Plan file              | Which file holds the task list.                                            |

A **circuit breaker** sits behind it to stop respawn thrashing: it moves from closed to
half-open to open, and is reset explicitly from the session's Ralph controls.

Honest assessment: Ralph is functional but is not where development attention goes. It
predates the respawn presets, which cover most of what people originally used it for with
less ceremony. Treat it as a specialised tool rather than the headline feature.

Full background, including the upstream pattern it is based on:
[`docs/ralph-wiggum-guide.md`](https://github.com/Ark0N/Codeman/blob/master/docs/ralph-wiggum-guide.md).

## The Orchestrator

A state machine that turns one goal into a phased plan and drives it to completion:

```
idle → planning → approval → executing → verifying → (replanning) → completed / failed
```

- **Planning** turns your goal into phases.
- **Approval** is yours. You see the plan before anything runs.
- **Executing** runs each phase, using team agents and the task queue.
- **Verifying** gates each phase before the next one starts. A failed gate can send it back
  to replanning rather than forward.

Open it from the Orchestrator panel in the toolbar. State persists in `state.json`, so a
server restart does not lose an in-flight plan.

Where it differs from Ralph: Ralph is one session grinding a list, the Orchestrator
coordinates phases and agents with verification between them. It suits work that has a
natural shape ("migrate this, then update callers, then update the tests") rather than a
flat backlog.

Architecture: [`docs/orchestrator-loop-architecture.md`](https://github.com/Ark0N/Codeman/blob/master/docs/orchestrator-loop-architecture.md).

## Running any of this safely

Autonomous loops are the features most able to spend money and change code while you are not
looking. Some habits that pay off:

- **Run them in a case that is a git repository**, on a branch you are willing to throw
  away. Being able to read the diff afterwards is the whole safety net.
- **Consider a container.** [Docker Cases](Docker-Cases) gives the agent its own filesystem
  and network, and one checkbox is all it costs.
- **Set the iteration cap deliberately.** It is the ceiling on the spend.
- **Turn on notifications** so a blocked loop reaches you: see
  [Notifications And Approvals](Notifications-And-Approvals).
- **Read the run summary and lifecycle log afterwards**, not just the final diff. They show
  where it went sideways and recovered.

## Read next

- [Keeping Agents Running](Keeping-Agents-Running) - the simpler feature that usually fits better.
- [Watching Agents Work](Watching-Agents-Work) - seeing what a loop is doing while it runs.
- [Docker Cases](Docker-Cases) - a sandbox for unattended work.
