# Local Models

Run a coding model on your own Mac, next to the cloud models you already use. Codeman
installs the model, keeps it running, and lets you start sessions on it or hand it work from
a cloud session. No account and no API key: the model runs only on that Mac.

This is **experimental**, and it needs a Mac with Apple silicon as the machine the Codeman
server runs on. On a machine that is not a Mac the button stays hidden.

## Install a model

1. Press **Run a local model** on the welcome screen (or open App Settings > Models > Model
   on this Mac).
2. The window shows which models fit this Mac. The bar at the top is the memory the Mac can
   give a model, filled to what the selected model needs at its peak. A nearly full bar is a
   tight fit.
3. Pick a model, and under **Runs with** the coding agent to start it with.
4. Press **Install on this Mac**. The next screen lists every download with its size and
   where it goes. Nothing is downloaded before you confirm there.
5. Codeman downloads a model runtime and the model into `~/.codeman/local-model`, loads the
   model, checks that all of it runs on the GPU and that it can call a tool, and installs
   the coding agent if it is missing. No administrator password is asked for.
6. Press **Start a session**.

You can close the window while it downloads. **Cancel** pauses the install and **Continue**
picks it up where it stopped. After a Codeman restart an unfinished install waits for your
click.

## Pick the coding agent

A model is driven by a coding agent: the program that reads your prompt, calls tools and
edits files. You choose it **per session**. Open the window again and look at **Start a
session with**: one chip per agent the model can be run with.

| Agent            | Pick it when                                                                                   |
| ---------------- | ---------------------------------------------------------------------------------------------- |
| OpenCode         | You have no reason to choose. It is the pair Codeman was tested with on a Mac                  |
| Pi               | You want the first answer soon. Its fixed prompt is the smallest by far, which also leaves the most room for your work |
| Claude Code      | You want Claude Code's own tools and habits. Its first answer on a local model takes minutes  |
| DeepSeek Harness | You already use it and have it set up                                                          |

Select a chip and press **Start a session**. The choice is remembered on that device.

**A chip that says "Not installed"** is an agent Codeman can install for you. Select it: the
window shows the exact command it would run, and the main button becomes **Install** with
the agent's name. The model stays ready while the installer runs, and you can start a
session with another agent meanwhile. If the install fails, the window says so under the
chip and nothing else changes.

**A chip that says "Needs setup"** is an agent that needs more than one command. DeepSeek
Harness is the one today: set it up from the **Run** menu first, then it can be started
here. A new DeepSeek Harness also opens its own setup guide in every session until you have
finished it once.

## More than one model

Once a model is installed, the window lists **Models on this Mac** with what each takes on
disk, and the total under the list.

- **Add a model** opens the list of models again and downloads another one. When it is
  ready it becomes the model in use; the earlier one stays on the Mac.
- **Use** switches to a model that is already there. Nothing is downloaded: Codeman loads it
  and checks it again.
- **Delete** removes one model, after one question that says how much space it frees.

One model runs at a time. Adding and switching are refused while sessions still use the
current model: close those sessions first. The model in use cannot be deleted: switch first,
or use **Remove**, which takes the runtime and the connection away (and the downloaded
models too, if you tick that).

## Cloud and local together

The reason to keep a local model next to a cloud one: the cloud model plans and reviews, the
Mac does the bulk. From a Claude Code session in Codeman, with the
[Codeman skill](Codeman-Skill) (on by default), you can just say it:

| You say                                                                                 | What happens                                                                                           |
| --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| "Is there a local model on this Mac?"                                                    | It reads what is installed, which agents can run it and which models are on the Mac. Read-only          |
| "Use the local model to summarize every file in `docs/`, then check its summaries."      | A worker on the local model does the reading; the cloud session reads its answer back and reviews it   |
| "Spawn a local worker with Pi to draft tests for `src/parser.ts`."                       | The worker runs the local model through Pi                                                             |
| "Start two cloud workers for the API and the UI, and a local one for the changelog."     | One mixed fleet: cloud workers side by side, the Mac as a queue                                        |

The worker sessions appear as tabs in the dashboard and are closed when the work is done.

Good to know before you rely on it:

- **One request at a time.** The local model answers one request at a time, so two local
  workers take turns. Fan out to the cloud, and give the Mac a queue.
- **Slower than a cloud model**, and the first request after a start loads the model first.
- **Review what comes back.** A local model is good at bulk work and weaker at judgment.
  Treat its answer as a first draft.
- **The skill never installs anything.** A model or an agent that is missing is yours to
  install in the window; the skill tells you what is missing and stops.
- **While a local worker is open**, the window refuses Stop, Remove and a switch of models,
  and names the sessions that are in the way.

## Good to know

- **What was tested.** One pair was run on a real Mac: OpenCode with Qwen3.6 35B-A3B on an
  M5 Pro with 48 GB. The window marks that pair on a Mac like it. Everything else in the
  list is calculated from each model's own figures, and the install checks the model on your
  Mac before it lets you start a session.
- **Memory first.** A model that does not fit in memory is not offered. An estimate becomes
  a measurement the first time the runtime starts, and the model is judged against that
  before it is downloaded.
- **The developer tools.** Coding agents use git and Python. On a Mac without them, macOS
  offers to install them the first time an agent needs one.
- **Stop** keeps the runtime from starting with Codeman next time. **Start** undoes that.
- **In multi-user mode** only an admin sees and uses this.

More detail: [A model that runs on this Mac](Custom-Model-Endpoints#a-model-that-runs-on-this-mac)
for how it relates to your own model servers, and
[`docs/local-models.md`](https://github.com/Ark0N/Codeman/blob/master/docs/local-models.md)
for how it works inside.
