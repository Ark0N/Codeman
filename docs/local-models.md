# A model that runs on this Mac

Codeman can set up a coding model that runs on the Mac the server runs on: no account and
no API key, and the session's prompts and files go to a model on this Mac rather than a
cloud provider (the coding agent itself may still check for updates). One button on the welcome screen opens a window that
shows what fits this Mac, installs the choice and ends on a coding agent session that
runs on it.

**Experimental.** The routes and their payloads may change in any release
([versioning-policy.md](versioning-policy.md), "Experimental local model routes"). Apple
silicon macOS only: anywhere else the window says why nothing is offered.

This page is the reference for how it works. The HTTP contract is in
[api-reference.md](api-reference.md) ("Local model"). The rules that must not be broken are
in [architecture-invariants.md](architecture-invariants.md#local-model-install).

## What an install does, in order

The person picks a model, presses "Install on this Mac" and confirms the sizes once. The
server then runs one job of five steps. The window polls `GET /api/local-model` once a
second; the job runs in the server, so the window can be closed.

| Step      | What it does                                                                                                                                              |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `runtime` | Downloads the pinned runtime, compares its hash, unpacks it, chooses a port once, starts it, reads the measured memory budget and judges the choice again |
| `model`   | Downloads the model through the runtime                                                                                                                   |
| `verify`  | Loads the model and checks it: one tiny chat, the memory and context the runtime reports, one tool call                                                   |
| `agent`   | Installs the coding agent with its stock install command. Left out when the agent is installed                                                            |
| `connect` | Saves one model endpoint and switches the custom model endpoints setting on                                                                               |

Every step can be repeated: Resume and "Try again" enter the step the job stopped in.

### The runtime

- **One pinned build.** Ollama 0.40.15 for macOS, a compiled constant
  (`OLLAMA_RUNTIME_PIN` in `src/local-model/runtime.ts`): the URL, the size (185,971,671
  bytes) and the sha256. No file, setting, environment variable or request can change which
  binary is downloaded.
- **Download.** Streamed to `*.partial` while it is hashed. A cut stream is continued with a
  Range request, at most three times. The hash is compared before anything is unpacked, and
  a mismatch deletes the file. Unpacking is `/usr/bin/tar` into a temporary folder, then one
  rename.
- **No administrator rights.** Everything lives in the data directory.
- **Supervised by Codeman.** The runtime is a non-detached child of the server: started at
  boot once a model is installed and not stopped, restarted at most three times after a
  crash, sent SIGTERM at shutdown. It is not a login item: it stops with Codeman, and a
  leftover from a server that was killed is taken back at the next start (see below).
- **Its environment is an allowlist.** `PATH`, `TMPDIR`, `LANG` and the proxy variables are
  copied from the server. `HOME` is a private folder. Exactly these are set:
  `OLLAMA_HOST=127.0.0.1:<port>`, `OLLAMA_MODELS`, `OLLAMA_CONTEXT_LENGTH`,
  `OLLAMA_NO_CLOUD=1`, `OLLAMA_KEEP_ALIVE=10m`, `OLLAMA_NUM_PARALLEL=1`,
  `OLLAMA_MAX_LOADED_MODELS=1`. No `CODEMAN_*` variable and none of the user's own
  `OLLAMA_*` settings reach it.
- **The port is chosen once**, by binding, from 11435 across 20 ports, and stored. 11434 is
  left alone: it is the default of a runtime the user may run themselves, which is never
  touched.
- **An orphan is recognized.** The pid and the port are stored. At boot a listener on the
  port that answers `/api/version` and whose pid runs a binary under Codeman's runtime folder
  is Codeman's own leftover from a server that was killed: it is adopted or replaced. Any
  other listener is "Port 11435 is in use by another program", with "Use another port" as
  the way out.

### The memory budget is measured

Before the runtime exists the budget is an estimate from the installed memory. Right after
it starts, the runtime prints the device total in its log line "inference compute"
(`total="37.4 GiB"` on a 48 GB MacBook). Codeman reads that line, stores the figure and
judges the chosen model against it before a byte of the model is downloaded. A model that no
longer fits ends the job there with "does not fit" and the next model to try. From then on
the window shows the measured budget and the word "estimated" is gone.

The need of a model is its peak: the weights, what stays held per token of context, what the
runner holds beside both, and what it takes for a moment while a long prompt is processed.

### The model download

`POST /api/pull` with `stream: true`. A 23 GB pull sends about 1.4 million progress lines,
so the stream is parsed piece by piece and never kept. Cancel aborts the request, which
stops the download. Resume pulls again and the runtime continues its partial files. An error
line or a cut stream is retried up to five times. Once the pull reported its total, every
size shown for the model is that total.

### The check

After the pull, in this order:

1. One tiny chat with `reasoning_effort: "none"`. It loads the model.
2. `GET /api/ps` must show the whole model on the GPU (`size_vram` equal to `size`) at the
   chosen context length.
3. One tool probe on `/v1/chat/completions` (a `tools` array, `reasoning_effort: "none"`,
   `max_tokens` 1024). It passes on a tool call whose arguments parse.

A failure is a state with a code and one next step, never a bare "failed": `does-not-fit`
and `no-tool-call` offer the next model, `probe-unfinished` (the token limit ended the
probe, so it proves nothing) and `load-failed` offer "Try again". The digest the runtime
reports for the model is stored when the check passed.

### The coding agent

When the chosen coding agent is not installed, the job installs it with the CLI registry's
own stock install command, through the same runner as App Settings > CLIs
(`src/cli-install-runner.ts`). The rules:

- Only a CLI that is a harness row of the local model catalogue.
- Only the **compiled** stock command. A `~/.codeman/clis.json` override cannot change what
  runs here.
- Only after the person's consent click, on a screen that showed the literal command.
- Admin only in multi-user mode, and written to the admin audit log (`cli_install`, with
  `via: "local-model"`).
- One installer per CLI at a time, shared with App Settings: while one runs, the other
  answers that it is busy.
- Afterwards the cached lookups of the CLI's binary are forgotten and the binary is looked
  for again. Still missing is the failure `harness-failed`, with the installer's last lines.

This step does not need the `cliManagementEnabled` setting. That setting gates the general
CLI management surface; this path can only ever run one vetted command for one catalogue
row.

### The connection

Two writes outside the local model folder, both undone by Remove:

1. One record in `custom-model-hosts.json`:

   ```json
   {
     "id": "local-ollama",
     "label": "This Mac",
     "baseUrl": "http://127.0.0.1:11435",
     "authStyle": "bearer",
     "models": ["qwen3.6:35b-a3b"],
     "defaultModelId": "qwen3.6:35b-a3b",
     "defaultContextLength": 131072
   }
   ```

   `defaultContextLength` is the chosen context: the runtime's model listing states none, so
   this field is what reaches the coding agent as its context limit.

2. `customModelEndpointsEnabled: true` in `settings.json`. The value it had before is kept
   in the state file.

The id `local-ollama` is reserved. A new endpoint cannot take it, and a record with that id
that this feature did not write is never overwritten: the install says so before anything is
downloaded. While the record is the managed one it cannot be edited or deleted in App
Settings and the five-minute discovery sweep leaves it alone, so its model list stays the
one model the install checked.

Switching the setting on also starts that five-minute sweep for every other saved endpoint.

## Starting a session

"Start a session" starts the coding agent on the endpoint `local-ollama` through the
existing custom model launch. Before a coding agent is STARTED on that endpoint the server
checks, in this order:

- the runtime child Codeman started is alive (whatever else answers on the port is not
  ours);
- the digest the runtime reports for the installed model is the one stored at install time;
- the model asked for is the one that was installed and checked.

That check runs wherever a new agent process comes to be on the endpoint: a session created
with the model, a model applied to a running session (which restarts its agent), the attach
that starts an agent in a session that has none or whose agent exited, and the rebuild of a
session after a reboot (that entry is skipped with "the local model is not ready" and stays
on offer). An agent that is already running when Codeman restarts is not started by
Codeman, so it is not asked: it keeps running on its port, see below.

A different digest refuses the launch: "The model on this Mac changed since it was
installed. Remove it and install it again." The digest is also read again at boot and when
the runtime is started.

### From a Claude Code session: cloud plus local

The codeman skill ([`skills/codeman`](../skills/codeman/SKILL.md#claude-in-the-cloud-a-local-model-on-this-mac))
lets an agent in a Codeman session hand work to this model, so Claude in the cloud plans and
reviews while the model on this Mac does the bulk: summaries, classification, first drafts, and
files that should not leave the machine. `local_model` reads `GET /api/local-model` and says what
is installed or why nothing can run; `spawn_worker <name> local` starts the runtime when it was
stopped (as Start does), then starts the installed coding agent on `local-ollama` through the same
quick-start launch and the same checks as above; `sendmark` gives the worker a task and reads its
answer back from a file it writes in its own folder. The skill never installs a model and never
answers a confirmation, the runtime still answers one request at a time, and while a worker it
opened is live, Stop and Remove are refused until it is closed.

## Stop, Start, Remove

- **Stop** stops the runtime and keeps it from starting at the next boot. **Start** undoes
  that.
- **Remove** stops the runtime, removes the endpoint record, switches the setting off again
  only when this feature switched it on and no other endpoint is saved, and deletes the
  runtime and its private home. The downloaded model is deleted only when asked. The coding
  agent stays. While a live session uses the model, Remove answers with the session names
  instead.

## Where everything is

All under the data directory (`~/.codeman`, or the instance's own):

```
local-model.json                           the state file (mode 0600)
local-model/
  runtime/ollama-0.40.15.tgz.partial       the runtime archive while it downloads
  runtime/ollama-0.40.15/                  the unpacked runtime (about 579 MB)
  models/                                  the model store
  home/                                    the runtime's private HOME (its key pair is here)
```

Nothing is written or deleted outside `local-model/` except the state file beside it and the
two writes of the connection. The state file holds no path, so it can never point a delete
somewhere else. The user's own `~/.ollama` is never created, read or removed.

`local-model.json` is not part of a config backup. `custom-model-hosts.json` and
`settings.json` are, so restoring an older backup can take the endpoint record away while
the model stays installed. The record is put back the next time Codeman starts (the setting
is left as the backup had it). A restore can also bring a record back after a Remove: it
then points at a port nothing listens on, is an ordinary endpoint again, and can be deleted
in App Settings.

## The job's states

| State        | A server restart                                              | Cancel           | What can be done                       |
| ------------ | ------------------------------------------------------------- | ---------------- | -------------------------------------- |
| `idle`       | stays idle                                                    | refused          | install                                |
| `installing` | becomes `paused` at the same step                             | becomes `paused` | cancel                                 |
| `paused`     | stays paused                                                  | refused          | resume, install, remove                |
| `failed`     | stays failed, same error                                      | refused          | resume, install, remove                |
| `installed`  | stays installed; the runtime is started unless it was stopped | refused          | start a session, stop or start, remove |

One job at a time. A job a server restart interrupted comes back paused and never continues
without a click. Cancel interrupts the step in flight (the download, the pull, the request,
the installer's process group); in the last step it is honoured before the first write, and
once the two writes began they finish.

## On a Mac without developer tools

Coding agents call `git` and `python3`. On a Mac without Xcode or the Command Line Tools
those are stubs that open macOS's "install the command line developer tools" window. So the
window says one sentence wherever the person commits or finishes, and only when
`/usr/bin/xcode-select -p` fails:

> Coding agents use git and Python. This Mac has no developer tools yet, so macOS will offer
> to install them the first time an agent needs one.

Codeman itself only ever runs `/usr/bin/xcode-select -p` for this, bounded, and never `git`
or `python3`.

## What to know before relying on it

- **The runtime's port has no login.** Any program on this Mac, and any web page served from
  `localhost`, can use the model server and change its models. That is why the endpoint
  record lists one model, why the sweep leaves it alone, and why the digest is compared
  before a session starts.
- **A Codeman restart stops the runtime.** A session that is mid-answer on the local model
  loses that answer. The runtime is started again with the server, and the first request
  loads the model again (seconds).
- **An open session keeps calling the runtime's port.** The coding agent was given the
  address when it started. While the runtime is stopped, or for the seconds of a Codeman
  restart, its requests go to a port nothing of ours holds, and any program on this Mac could
  bind that port and answer them. That is why Stop and "Use another port" are refused while
  a session uses the model: close those sessions first.
- **The runtime does not enforce the context length.** A prompt longer than the context was
  accepted in testing. Do not rely on the runtime to stop one.
- **The model stays in memory for ten minutes** after the last request, then the runtime
  unloads it.

## Source

| What                                           | Where                                                                                              |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Hardware probe, catalogue, recommendation      | `src/local-model/hardware.ts`, `src/config/local-model-catalog.ts`, `src/local-model/recommend.ts` |
| Runtime pin, download, environment, supervisor | `src/local-model/runtime.ts`                                                                       |
| Runtime HTTP client, pull parser, checks       | `src/local-model/ollama-client.ts`                                                                 |
| Developer tools check                          | `src/local-model/developer-tools.ts`                                                               |
| Job (state table, reducer, view, service)      | `src/local-model/install-job.ts`                                                                   |
| State file                                     | `src/local-model/state-store.ts`                                                                   |
| Connection and its undoing                     | `src/local-model/connect.ts`                                                                       |
| Paths                                          | `src/local-model/paths.ts`                                                                         |
| Routes                                         | `src/web/routes/local-model-routes.ts`                                                             |
| Shared CLI install runner                      | `src/cli-install-runner.ts`                                                                        |
| Serialized writer of the endpoint store        | `src/custom-model-hosts-writer.ts`                                                                 |
