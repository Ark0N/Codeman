# A model that runs on this Mac

Codeman can set up a coding model that runs on the Mac the server runs on: no account and
no API key, and the session's prompts and files go to a model on this Mac rather than a
cloud provider (the coding agent itself may still check for updates). One button on the welcome screen opens a window that
shows what fits this Mac, installs the choice and ends on a coding agent session that
runs on it. The same window then lists the models that are on this Mac with what each takes
on disk, adds another one, switches between them and deletes one
([The models on this Mac](#the-models-on-this-mac)).

**Experimental.** The routes and their payloads may change in any release
([versioning-policy.md](versioning-policy.md), "Experimental local model routes"). Apple
silicon macOS only: anywhere else the window says why nothing is offered.

This page is the reference for how it works. The HTTP contract is in
[api-reference.md](api-reference.md) ("Local model"). The rules that must not be broken are
in [architecture-invariants.md](architecture-invariants.md#local-model-install).

## Which model fits which Mac

The window offers the best model of the catalogue (`src/config/local-model-catalog.ts`) that
fits this Mac's memory at a context a coding agent can work with, and under it every other
model of the catalogue that fits (ten models today: a 16 GB Mac sees one of them, a 512 GB
Mac all ten). What the catalogue answers today, before the runtime measured anything (the
budget is then an estimate: 2/3 of the memory below 36 GB, 3/4 from 36 GB, less 1 GiB, and
never more than the memory less 6, 8 or 12 GiB for macOS, Codeman, a browser and the agent):

| Memory           | Budget  | What it gets                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ---------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 8 GB             | 2.1 GB  | Nothing. The smallest model a coding agent can work with needs 9.3 GB at 65,536 tokens                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| 16 GB            | 10.4 GB | A small model (`limited`): Ornith 1.0 9B at 65,536 tokens, 9.3 GB, tight (90%). Its build has no vision projector, which makes it 0.9 GB smaller than the other two 9B builds: MiMo V2.6 9B needs 10.2 GB there, 98.7% of the budget, just past the 98% a tight fit may reach. Once the runtime measures what a 16 GB Mac mini measured (10.7 GB), all three fit and MiMo is the pick. No 9B was run on such a Mac by us: only a run settles it                                                                                                                                        |
| 18 GB            | 11.8 GB | A small model (`limited`): MiMo V2.6 9B at 131,072 tokens, 11.4 GB, tight. Ornith 1.0 9B (10.5 GB) and Qwen3.5 9B are the alternatives                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| 24 GB            | 16.1 GB | The same, with room. On a base M2 or M3 (100 GB/s) it computes to 9.3 tokens per second: slow                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 32 GB            | 21.8 GB | No longer a small-model Mac: Muse Glimmer 30B fits at 65,536 tokens (21.2 GB, 97%, tight). It is a dense model. On an M1 Max or M2 Max it computes to 11.8 tokens per second and is the pick; on a base or Pro chip it computes to under 6 and is listed as slow, and the pick stays MiMo V2.6 9B at 131,072 tokens with the note that it is a small model. North Mini Code 1.0 needs 23.2 GB at 65,536 tokens; once the runtime measures about 3/4 of the memory, as it did on a 16 and a 48 GB Mac, the Mac gets it at 131,072 tokens, or Qwen3.8 27B at 65,536 tokens on a Max chip |
| 36 GB            | 27.9 GB | Qwen3.8 27B at 131,072 tokens on an M4 or M5 Max (27.0 GB, 97%); on a slower chip, where the dense 27B computes to under 10 tokens per second, Qwen3.6 35B-A3B as a GGUF build (27.1 GB, 97%). Both tight. Muse Glimmer 30B at 131,072 tokens (21.6 GB, 78%) is the alternative with room to spare                                                                                                                                                                                                                                                                                     |
| 48 GB            | 37.6 GB | Qwen3.6 35B-A3B (MLX) at 131,072 tokens: the pair we tested, "Recommended" on an Apple M5 Pro with 48 GB. On a Max chip Qwen3.8 27B at 262,144 tokens (32.1 GB, tight). The test was a short task: in a long session MLX may keep up to 8 GiB more, which brings this pair to the edge of the budget, and past it while a long prompt is processed                                                                                                                                                                                                                                     |
| 64 GB            | 50.5 GB | Qwen3.8 27B at 262,144 tokens on a Max chip; Qwen3.6 35B-A3B (MLX) on a Pro chip                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 96 GB            | 76.2 GB | Qwen3.8 27B at 262,144 tokens; on an M3 Max, Qwen3.6 35B-A3B (MLX)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| 128 GB           | 102 GB  | Ornith 1.5 122B-A10B (MLX) at 131,072 tokens, 97.4 GB, tight                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 192, 256, 512 GB | 154 GB+ | Ornith 1.5 122B-A10B at 262,144 tokens                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |

"Tight" means the need is between 85% and 98% of the budget; above 98% a model is not
offered. A model that computes to under 10 tokens per second on the chip is "slow" and ranks
after the fast ones, which is why the chip changes the pick at 32 to 96 GB. Every model is
offered at the largest context it fits at, and never below 65,536 tokens: OpenCode's own
prompt is 8,000 to 10,000 tokens, and at 32,768 it would compact after less than one default
file read. `test/local-model-recommend.test.ts` ("every memory size") pins this table.

### How much memory a model needs

The need of a model is its peak: the weights, what stays held per token of context, what the
runner holds beside both, and what it takes for a moment while a long prompt is processed. The
runtime runs a model with one of two runners, which spend memory differently, so every row
names its runner (`runner`) and its figures follow that runner's rule:

- **llama.cpp** (GGUF builds, on Metal) allocates the K/V cache for the whole context when the
  model loads and does not grow after that. The runtime is started with
  `OLLAMA_KV_CACHE_TYPE=q8_0` (the cache in 8 bits, 17/32 of the default f16; the runtime's
  own documentation calls the loss very small), `OLLAMA_FLASH_ATTENTION=1` (an 8-bit cache
  needs it), `LLAMA_ARG_CACHE_RAM=1024` (llama-server keeps copies of earlier prompts, and
  this bounds them to 1 GiB) and `LLAMA_ARG_CTX_CHECKPOINTS=8` (llama-server keeps copies of
  the state it cannot roll back, two or three per request, up to 32 by default: 5 GB for the
  27B; 8 keeps the last few requests, which is what an agent's next request restores from). A
  row's figures are computed from its model's `config.json`: the K/V cache of its attention
  layers, its recurrent or sliding-window state, live and in each of the 8 checkpoints, 1.0
  GB for the runner and the 1 GiB prompt cache. A build with a multi-token-prediction layer
  (the two `-mtp` tags and `qwen3.8:27b-q8_0`) costs more: the runtime turns prediction on,
  so llama-server keeps that layer's cache in f16 and one more copy of the recurrent state for
  rollback per drafted token (the tag's `draft_num_predict`: 2 for the 35B-A3B, 4 for the
  27B). No peak: the buffers are allocated at load. The checkpoints and the
  prediction costs were read in the llama.cpp source the runtime bundles (b12111), not
  measured.
- **MLX** grows its cache with the tokens actually used, keeps snapshots of the recurrent
  state, and may keep up to 8 GiB of snapshots of earlier prompts, which no setting bounds. A
  Mac always takes the MLX build of a tag that has one. Below 48 GB that 8 GiB does not fit
  beside a useful model, so the catalogue lists GGUF builds there.

Where every figure comes from:

| Model                        | Runner    | Memory figures                                                                      | Speed (tokens per second per 100 GB/s)                    |
| ---------------------------- | --------- | ----------------------------------------------------------------------------------- | --------------------------------------------------------- |
| `qwen3.5:9b-q4_k_m`          | llama.cpp | computed from the Qwen3.5-9B config                                                 | 9.3: a published run on an M1 Max                         |
| `ornith:9b-q4_k_m`           | llama.cpp | the same (a fine-tune of Qwen3.5-9B; its config and its GGUF header say so)         | 9.3: the same architecture and weights size               |
| `mimo-v2.6:9b-q4_k_m`        | llama.cpp | the same (a fine-tune of Qwen3.5-9B)                                                | 9.3: the same architecture and size                       |
| `north-mini-code-1.0:q4_k_m` | llama.cpp | computed from its config                                                            | 13.6: the 35B-A3B's, the same 3 billion active parameters |
| `muse-glimmer:30b-q4_k_m`    | llama.cpp | computed from its config: 13 full-attention and 39 sliding-window layers            | 2.95: the dense 27B's, whose weights are the same size    |
| `qwen3.6:35b-a3b-mtp-q4_k_m` | llama.cpp | computed from the Qwen3.6-35B-A3B config, prediction layer included                 | 13.6: a published run on an M1 Max                        |
| `qwen3.6:35b-a3b`            | MLX       | **measured** on an Apple M5 Pro with 48 GB                                          | 16.9: a published run; 67.7 measured on the tested Mac    |
| `qwen3.8:27b-q8_0`           | llama.cpp | computed from the Qwen3.8-27B config, prediction layer included                     | 1.7: the row below scaled by file size                    |
| `qwen3.8:27b-mtp-q4_k_m`     | llama.cpp | computed from the Qwen3.8-27B config, prediction layer included                     | 2.95: a published run without prediction (a floor)        |
| `ornith-1.5:122b`            | MLX       | computed from the Qwen3.5-122B-A10B config, scaled by the measured MLX row, + 8 GiB | 5.0: the 35B-A3B's, x 3/10 active parameters              |

Sizes are what the registry serves a Mac for each tag (every layer plus the config), read on
2026-11-08 (the Ornith 1.0 and Muse Glimmer rows on 2026-11-10). Only one row was ever run on
a Mac, so every other answer in the table above is a calculation. For a llama.cpp build the check after the download catches a load that was
judged too kindly, but not what grows after it in host memory (the checkpoints and the prompt
cache, which are counted, not checked); for an MLX build it catches neither (see "The check"
below). The measured row's figures come from single long prompts, not a session of many
requests, in which MLX may keep up to 8 GiB more. The catalogue header lists the models left
out on purpose (no evidence of working tool calls, a restrictive licence, a known bug, a
build that needs a newer runtime than the pinned one) and why. The strongest of those today
is Ripple 65B Preview, published on 2026-11-09: every build of it requires Ollama 0.40.16,
one above the pin.

A new row needs its model's architecture (attention layers, K/V heads, head size, and its
linear-attention or sliding-window layers, from its `config.json`) in the table of
`test/local-model-catalog.test.ts`, which recomputes every computed figure from it and fails
for a row it does not know. Its answer for each memory size is then pinned in
`test/local-model-recommend.test.ts`.

## What an install does, in order

The person picks a model, presses "Install on this Mac" and confirms the sizes once. The
server then runs one job of five steps. The same job adds a second model to an installed one
("Add a model"): the runtime is there already, so it downloads the model alone, and the
earlier model stays on disk. The window polls `GET /api/local-model` once a
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
  `OLLAMA_MAX_LOADED_MODELS=1`, and four memory settings of the llama.cpp runner:
  `OLLAMA_KV_CACHE_TYPE=q8_0`, `OLLAMA_FLASH_ATTENTION=1`, `LLAMA_ARG_CACHE_RAM=1024` and
  `LLAMA_ARG_CTX_CHECKPOINTS=8` (see "How much memory a model needs" above). No `CODEMAN_*`
  variable and none of the user's own `OLLAMA_*` or `LLAMA_ARG_*` settings reach it.
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

The need of a model is its peak (see "How much memory a model needs" above).

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
   chosen context length. For a llama.cpp build both figures are the buffers llama-server
   reports allocating (weights, K/V cache, compute), so this proves the whole load is on the
   GPU. For an MLX build it proves only the weights: the runtime books an MLX model at its
   weights (runtime issue 19417), so for those rows the catalogue's figures are all there is.
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

### Which coding agents, and what each was measured with

The coding agent is chosen **per session**. An installed model lists every agent it can be
run with (`install.harnesses` of the GET), and the window shows them as chips under "Start a
session with": the agent the model was installed with is the default, and the choice is
remembered on the device. The launch check asks about the endpoint and the model, never about
the agent, so a session with one agent and a session with another run on the same model.

| Agent            | First request (its fixed prompt)                                    | Installed from the window | What was seen, and where                                                                                                                    |
| ---------------- | ------------------------------------------------------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| OpenCode         | about 8,100 tokens, 11 tools (v1.19.5; more with user-level skills) | yes                       | A tool round trip on a Mac with a real model (the catalogue's tested entry), and on a scripted endpoint for v1.19.5                         |
| Claude Code      | about 36,000 tokens, so the first answer takes minutes              | yes                       | Shipped in 1.50.0; not measured again for this table                                                                                        |
| Pi               | 2,096 tokens, 4 tools (v1.5.2)                                      | yes                       | A complete tool round trip against a real model: tool call, tool result, final answer, the file on disk                                     |
| DeepSeek Harness | about 7,650 tokens, 25 tools (0.1.1-rc.2); 6,983, 27 tools (0.2.2-rc.1) | **no**                | A tool round trip on a scripted endpoint only, on both versions. Against a real model the launch and the model name reached the runtime, and no turn finished |

How to read the last column: the runs of 2026-11-10 were made on **Linux**, through Codeman's
own custom model launch, against Ollama 0.13.0 with a 1.7B model on a CPU ("a real model") or
against a scripted endpoint that replays that runtime's stream of a tool call. A scripted run
proves the agent's side of the protocol, not what a model does with its prompt. None of them
ran on a Mac or on the pinned runtime. Every agent sent the `name:tag` model name unchanged.

Three things follow from how the agents differ:

- **Pi is told the model's window.** Without it Pi takes an unknown model for a
  128,000-token one and never compacts before the real window is full. Codeman now writes the
  endpoint's context length into the model list it gives Pi (the custom model feature as a
  whole, not only this window). Two things remain: a custom model session gives Pi a home
  directory of its own, so Pi fetches its two search tools again at every start (it needs the
  network for that; `PI_OFFLINE=1` skips it), and Pi asks "Trust project
  folder?" in every such session when a folder above the working directory holds agent
  skills, because the answer is stored in the home it does not keep.
- **DeepSeek Harness is a launcher.** `dsh` starts nothing by itself: a session needs a
  terminal profile, which is third-party code with its own consent in the Run menu. Its
  install command installs the launcher only, so this window never installs it. It is listed
  as "Needs setup" until the Run menu can start it, and as a normal agent from then on. It is
  the one agent of the four besides Claude Code that reports the end of a turn. Its custom
  endpoint recipe itself was verified with a real model on a llama.cpp server
  ([custom-model-endpoints.md](custom-model-endpoints.md)); what is missing is a finished turn
  on this feature's runtime. On today's version (0.2.2-rc.1 with dsh-TUI 0.19.0) two more
  things were seen: a setup guide opens in every session until a person has finished it once
  (a person in a tab presses through it; a script must not, see the codeman skill), and its
  transcript file was renamed, so Codeman's response viewer and `last-response` are empty for
  a dsh session on that version until the reader learns the new name.
- **OpenCode and DeepSeek Harness send a second, small request** beside the first prompt (a
  title, a side question). The runtime answers one request at a time, so it queues.

### Installing one more agent beside an installed model

An agent that is not on the Mac has "Not installed" on its chip. Selecting it shows the
literal install command, and the main button becomes "Install <agent>". That click is the
consent; `POST /api/local-model/agent` then runs the same stock command under the same rules
as the `agent` step above (catalogue row only, compiled command only, admin only, audited,
one installer at a time).

It is **not a job**. The state stays `installed` whatever the installer does: the model stays
loaded, sessions are not refused, and a session with another agent can be started while it
runs. A failed install shows the sentence and the installer's last lines under the chip, and
leaves everything else as it was. The outcome is kept in memory only, so a restart of the
server forgets a failure (the chip then simply says "Not installed" again).

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

"Start a session" starts the selected coding agent on the endpoint `local-ollama` through the
existing custom model launch. Before a coding agent is STARTED on that endpoint the server
checks, in this order:

- no job that changes the model in use is running or stopped: until an install or a switch
  ended, nothing is started ("The model on this Mac is being changed and is not ready");
- the runtime child Codeman started is alive (whatever else answers on the port is not
  ours);
- the digest the runtime reports for the model in use is the one stored when it was checked;
- the model asked for is the model in use. Another model that is on this Mac is not started
  on the endpoint: switch to it in the window first.

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
is installed or why nothing can run, with the coding agents the model can be run with and the
models on the Mac; `spawn_worker <name> local` starts the runtime when it was
stopped (as Start does), then starts the default coding agent (`install.cli`), or with
`local:<agent>` (`local:pi`, `local:deepseek`) another one that is ready, on `local-ollama` through the same
quick-start launch and the same checks as above; `sendmark` gives the worker a task and reads its
answer back from a file it writes in its own folder. The skill never installs a model or a coding agent and never
answers a confirmation, the runtime still answers one request at a time, and while a worker it
opened is live, Stop and Remove are refused until it is closed.

## The models on this Mac

The model store can hold several models. **One of them is the model in use**: the one the
endpoint record `local-ollama` lists, the runtime is started for and a session can be
started on. The runtime holds one model in memory at a time (`OLLAMA_MAX_LOADED_MODELS=1`),
so this is what the Mac can really do, and it keeps every rule above: one record, one
model, one stored digest per model.

The installed screen lists what is on this Mac, the model in use first:

| A row says    | It means                                                                                                                                                              |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| In use        | The model sessions start on                                                                                                                                           |
| Ready         | Codeman downloaded and checked it. **Use** switches to it                                                                                                             |
| Not checked   | The runtime lists it and Codeman never checked it: a model an earlier Remove kept, or one another program pulled through the runtime's port. It can only be deleted   |
| Changed       | It was checked, and the runtime now reports another digest under its name. It is never started; delete it and install it again                                        |
| Missing       | It was checked, and the runtime no longer lists it. **Delete** drops the entry                                                                                        |

Each row shows the context the model was checked with and its size on disk, as the runtime
reports it. Under the list is what all downloads take together: the size of the files in
`local-model/models/blobs`, so layers two models share are counted once and an interrupted
download is included. The window asks the runtime for the list at most every five seconds
and measures the store at most every thirty, never on every poll.

- **Add a model** opens the chooser. A model that is not on this Mac is installed like the
  first one, with its sizes confirmed; when the job ends it is the model in use, and the
  earlier model stays in the list. A row that is on this Mac already says so and is switched
  to, without a download and without a confirm screen.
- **Use** switches to a checked model. It is a job of two steps, `verify` and `connect`:
  the runtime is restarted with the context the model was checked with, the model is loaded
  and checked again (the tiny chat, the GPU, the tool probe), its digest must still be the
  stored one (else the switch fails with `model-changed` before the model is loaded), and
  the endpoint record is rewritten. The default coding agent becomes the one the model was
  checked with when it is still installed, else the one of the installation, else any other
  agent that is on the Mac and can run the model.
- **Delete** removes one model through the runtime's own delete, after one question in the
  row. The request carries the model's name, never a path, and the server deletes only a
  name of its own listing. The model in use cannot be deleted: switch first, or Remove. It
  needs the running runtime, so a stopped model shows no Delete until Start.

Adding a model and switching are refused while a session uses the model ("Sessions are
still using this model"), like Stop: their coding agents were started with the other model's
name, and the runtime would swap models on every request.

While a job that started from an installed model runs, or after it stopped (paused or
failed), no session is started: the checks above want a finished installation, and the
refusal says so (`job-unfinished`). The window
then lists the checked models with **Use**, which is the way back to the earlier one. Going
back deletes what the stopped job left of a model that never passed its check, the way a new
install does; a checked model is never deleted that way.

## Stop, Start, Remove

- **Stop** stops the runtime and keeps it from starting at the next boot. **Start** undoes
  that, and so does a switch to another model or the install of one: the job starts the
  runtime, and the model it ends on is in use.
- **Remove** stops the runtime, removes the endpoint record, switches the setting off again
  only when this feature switched it on and no other endpoint is saved, and deletes the
  runtime and its private home. The downloaded models (all of them) are deleted only when
  asked. The coding agent stays. While a live session uses the model, Remove answers with
  the session names instead.
- **Models a Remove kept** are not lost space: with nothing installed the window says how
  much they still take and offers "Delete them", and after a new install they show in the
  list as "Not checked", each with its own Delete.

## Where everything is

All under the data directory (`~/.codeman`, or the instance's own):

```
local-model.json                           the state file (mode 0600), with the list of checked models
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
| `paused`     | stays paused                                                  | refused          | resume, install, use, delete a model, remove |
| `failed`     | stays failed, same error                                      | refused          | resume, install, use, delete a model, remove |
| `installed`  | stays installed; the runtime is started unless it was stopped | refused          | start a session, stop or start, install (add a model), use, delete a model, remove |

`use` and "delete a model" are listed only while a row of the list offers them, and in
`idle` "remove" is offered only while the model store still holds something.

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
- **Most memory figures are calculated, not measured.** One model was run on one Mac; the
  others are computed from their architecture, and the runtime settings they assume (an 8-bit
  K/V cache, flash attention, a 1 GiB prompt cache) were read in its source, not yet observed
  on a Mac. "Recommended" appears only for the pair we ran, on the Mac we ran it on.
- **A tool call that quotes a tool call can be cut off.** The pinned runtime reads the tool
  calls of every Qwen-family model in the catalogue (the Ornith, MiMo and Qwen rows, the pair
  we ran included) with one parser, and that parser ends a call at the first closing tag it
  sees. An argument that itself contains a whole tool call, such as a prompt handed to a
  sub-agent that shows one, arrives cut off and the rest as text (runtime issue 16992, filed
  on `ornith:35b`; the fix, runtime pull request 17021, is open). The check after a download
  asks for one plain tool call and does not see this.
- **The model stays in memory for ten minutes** after the last request, then the runtime
  unloads it.
- **One model runs at a time.** Several can be on disk; the runtime holds one, and a switch
  restarts it and loads the other model (seconds to a minute). Close the sessions on the
  model first: the window refuses the switch while one is open.
- **The disk figures are the runtime's.** A row's size is what the runtime reports for the
  model, and the total is the size of its blob files. Neither was compared with Finder on a
  Mac yet.

## Keeping the catalogue current

The catalogue (`src/config/local-model-catalog.ts`) and the runtime pin are compiled into
Codeman on purpose: no file or download decides what is recommended or run. What the
registry serves can still move away from them: a tag is pushed again or removed, the build
a Mac downloads changes size, Ollama ships a new version. The workflow
`.github/workflows/local-model-catalog.yml` looks for that every Monday at 06:00 UTC. It
runs `scripts/check-local-model-catalog.mjs`, which also runs locally:
`npm run check:local-model-catalog` prints the report and exits 0 (clean), 1 (drift) or 2
(the check itself failed).

For every model row it checks:

- **The tag still exists** in the registry.
- **The size of what a Mac downloads** is within 0.1% of the row's `bytes`. A tag can be a
  manifest list with one build per runner, and Ollama on Apple silicon takes the `mlx` build
  when there is one, else `llamacpp`, else `ggml`. So the check asks for the tag the way
  Ollama asks, picks the build a Mac picks and sizes it the way a pull counts it (every layer
  plus the config). The plain manifest other tools get for the same tag is the `llamacpp`
  build, which is not what a Mac downloads.
- **The runner of that build**, once a row names its `runner`: a Mac still pulls an `mlx`
  build for an `mlx` row and a GGUF build (`llamacpp`, or a manifest that names no runner)
  for a `llamacpp` row. A row's memory figures follow its runner, so a tag that gains or
  loses an mlx build is drift even at about the same size.
- **The build a Mac pulls runs on the pinned runtime**: its config declares no newer
  Ollama (`requires`) than `OLLAMA_RUNTIME_PIN`.
- **The pinned digest**, once a row carries one: a Mac would still pull that manifest. The
  field is `digest` and its value is what `/api/tags` reports after the pull. The catalogue
  schema does not have it yet: `LocalModelEntrySchema` must gain an optional `digest` under
  exactly that name, or the check never compares it. Until then the report lists today's
  digests, rows with measured figures first, because without a digest a rebuild of about the
  same size goes unnoticed (a switch between the mlx and the gguf build does not: their sizes
  differ by 2% or more). Pinning digests is a decision, not a quick fix: today the catalogue
  holds no digest on purpose, and `test/local-model-catalog.test.ts` ("holds no download
  data") refuses a `sha256` anywhere in it, so that rule changes with it.

For the runtime pin it checks whether a newer Ollama release exists, and whether the pinned
`ollama-darwin.tgz` is still on GitHub with the pinned size and sha256.

It reads manifests and configs only, never a model layer. It does not check the memory
figures, the speeds or whether a coding agent works with a model: no manifest says anything
about those, and they change only when somebody measures on a Mac.

**The issue.** Drift opens one issue, "Local model catalogue: weekly check", or, while that
issue is open, replaces its description with the new report and adds a comment. A clean week
comments on the open issue and does nothing when there is none. A check that failed (the
network, a rate limit, an answer that did not parse) fails the run and leaves the issue
alone; what it found is in the run's summary. The schedule runs the copy of the workflow on
`master`, and so does `gh workflow run local-model-catalog.yml`.

**What a maintainer does with it**, in a pull request each time:

- **Size drift or a changed digest**: correct the row. When the build itself changed (another
  runner or quantization), its memory figures and speed no longer describe it: mark the row
  `estimated` until somebody measures it again.
- **A tag that is gone, or a build that needs a newer runtime**: replace or drop the row, or
  move the runtime pin first.
- **A newer Ollama**: read its release notes, then move `OLLAMA_RUNTIME_PIN` (version, URL,
  size and sha256, checked against the release's `sha256sum.txt`) and run an install on a
  Mac before merging.
- **A pinned archive that changed**: a security question first. Every install refuses it at
  the hash compare, so nobody gets it, but find out why before moving the pin.

Close the issue once the fix is merged. A catalogue or pin change reaches users only in a
release: an installed Codeman keeps the catalogue it was built with until it is updated.

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
| Weekly catalogue check                         | `scripts/check-local-model-catalog.mjs`, `.github/workflows/local-model-catalog.yml`               |
