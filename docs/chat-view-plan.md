# Chat view: a rendered conversation as the main session view

## Goal

A Claude session should be readable the way the Claude Code web and desktop apps
are: prose in a proportional font, markdown rendered, code in boxed blocks, and the
page's own light or dark colours. Codeman should keep managing the session exactly
as it does today. The agent still runs in its tmux pane, and only the way the
browser shows that pane changes.

The Response Viewer already renders a conversation this way, and its output is the
look to keep. Its problem is placement: it is a sheet the user opens on demand,
it does not update while the agent works, and it cannot send a prompt. The chat
view moves that same rendering into the main area, keeps it live, and puts a
message box under it.

## What the user sees

Each Claude session gets two views of the same pane:

- **Chat** shows the conversation rendered by the Response Viewer's markdown
  pipeline, newest message at the bottom, with a message box underneath.
- **Terminal** is today's xterm.js pane, unchanged.

A toggle switches between them, and a keyboard shortcut does the same. The choice
is remembered per session on this device. The toggle floats at the top right of the
terminal. A second per-device setting shows or hides it. It shows by default, and a
user who never uses the chat view can turn it off. The shortcut still switches views
while the toggle is hidden. A per-device setting picks the view for every session
this browser has no choice for yet, so a user who prefers chat never has to switch by
hand. The setting defaults to Terminal. Chat replaces the main view and still sends
some dialogs to the terminal in phase 1, so nobody gets it without choosing it.

Your own prompts show in full when they are short. A prompt longer than about 12
lines, typically a pasted log or spec, shows its first 6 lines followed by
"Show all (N lines)", so a long paste does not fill the screen between two
answers. Keep-warm nudges are hidden, as Read My Mind already drops them, because
Codeman sent them and you did not.

While the agent works, the chat view shows a status line under the last message.
It names what the running tool works on, such as "Reading src/session.ts" or
"Running npm test". A Bash call with a description shows the description, with the
command on a second `$ …` line, as the CLI does. The status line can say this because
`transcript:tool_start` carries `detail` and `command`, which `summarizeToolCall()` and
`toolCallCommand()` in `src/tool-call-summary.ts` pick out of the call's input. Each
block of Claude's answer appears as a rendered message as soon as Claude writes it to
the transcript, so a long turn fills in while it runs.

While Claude Code compacts the conversation, the status line says "Compacting
conversation". A compaction runs for a minute or more and writes nothing to the
transcript until it ends. Claude Code then draws `✻ Compacting conversation… (12s)` as
its working line, for `/compact` and for its own auto-compaction alike. The terminal
stays attached under the chat view, so the chat view reads that line from the
terminal's own buffer on each tick of the status line. Only Claude's newest row above
its message box counts, so an answer that quotes the line does not.

Between turns, Claude can still run work in the background, such as a background
shell or a monitor. The server reads that off Claude's screen as the session's
`watching` value, and the status line then says so, for example "1 shell still
running".

The chat view always shows the session's current conversation. After `/clear` it
starts empty, as Claude itself does. Claude Code runs the statusline command about a
second after a `/clear`, and its input names the new conversation and its transcript
file. The statusline exporter posts that input to the server, which moves the session
to the new conversation, so the chat view follows before the next prompt. A session
without the exporter, such as a Docker session or any session while Plan Usage Limits
is off, moves with its next prompt's hook. A session with neither moves when the chat
view next reads its conversation, as described under How the view stays live.

## Where the conversation comes from

Claude Code writes every session to a transcript file, one JSON object per line.
`GET /api/sessions/:id/last-response?context=full` already reads that file and
returns the whole conversation as prompt and response messages, each tagged with
its turn number. The Response Viewer's "More" button uses it today, so the chat
view needs no new reader for its first version.

That reader keeps only text. It drops tool calls, tool results and thinking blocks,
so in phase 1 the conversation shows prompts and answers only.

Phase 2 adds a turn's tool activity as one muted summary line, such as
"Read 9 files · edited 2 · ran 3 commands". A busy turn makes dozens of calls, and
a line per call would push the answer far down the page. Clicking the summary
expands it to one line per call ("Read src/session.ts", "Ran npm test"), and each
of those expands to show the call's input. For edits, the Edit history panel also
shows the diffs.

The summary needs every call, so in phase 2 the parser emits a `tool` message for
each `tool_use` block. The message type already exists: the DeepSeek transcript
reader and the readers for the CLIs whose conversation Codeman reads from the pane
emit it.

Parsing the whole file on every update would hold the server's event loop for over a
second on a long conversation. So the server keeps each transcript's parse and the
byte offset it reached, and a read parses only the bytes appended since the last one
(`src/web/claude-response-transcript.ts`). Phase 3 adds a cursor, so the browser asks
only for messages after the last one it has.

## How the view stays live

The server watches a Claude session's transcript. A watcher starts at the session's
first hook or statusline report, and either one reports the transcript's path.
Codeman installs those hooks in every Claude workspace unless `workspaceHooksEnabled`
is off.

A session that sends neither a hook nor a statusline report has no watcher:

- a session the server picked up after a restart, until either one arrives;
- a session with hooks switched off and no statusline exporter;
- a Docker case whose hooks cannot reach the server.

For those, any full read of the conversation starts a watcher from the transcript that
read found. A full read is `GET /api/sessions/:id/last-response?context=full`, which
both the chat view and the Response Viewer's More button make. So these sessions
also update mid-turn. After a `/clear`, a read moves a watcher it started itself to
the conversation's new file, because no hook or statusline report will move it. The
read never replaces or moves a watcher that a hook or a statusline report started,
and it starts none for a remote session.

The watcher emits `transcript:update` whenever new lines arrive. The server
broadcasts it as an SSE event, throttled to one per 750 ms per session, so the
browser learns of each new message while a turn is still running.

The chat view also listens for these events:

- `transcript:tool_start` drives the status line, because it carries the tool's
  `detail` and, for a described Bash call, its `command`. With parallel tool calls,
  the matching `transcript:tool_end` fires once, so the status line shows the most
  recent tool rather than counting calls.
- `session:working` and `session:idle` mark the start and end of a turn. They come
  from Codeman's idle detection, not from hooks, so they also work where no
  transcript watcher runs.

`transcript:complete` does not help here. It fires only for a `result` row, and an
interactive Claude transcript has none.

A Docker case whose hooks do reach the server gets no mid-turn updates. Its hook reports the
transcript's path inside the container, which the host cannot open. The watcher
keeps that path, so the full read starts no second one. Such a session refetches on
`session:working` and `session:idle` alone, and so updates only at the start and end
of each turn.

## How the user sends a prompt

The message box is a multiline text area. On a desktop, Enter sends and
Shift+Enter adds a line. On a touch device the Send button sends, and so does
Ctrl+Enter or Cmd+Enter from a hardware keyboard. Plain Enter adds a line there, as
in the phone's Compose dialog.

A send posts the text and its Enter as one input to `POST /api/sessions/:id/input`
with `useMux: true`. The server then pastes the text through tmux, presses Enter,
and arms its submit check. That check re-presses Enter while the prompt still sits
in Claude's composer, which Claude 2.1.277 and later cause by ignoring Enter for 30
to 50 seconds after the composer appears.

The browser's WebSocket input channel cannot do this. It writes raw bytes straight
into the pane and never reaches the tmux path, whatever the frame asks for. So the
chat view does not use it for prompts, even though that channel queues input
across a dropped connection.

Each request carries a client id, made once per page load, and a sequence number.
A request that fails on the network, or that the server answers with a 5xx error,
is retried with the same pair, so the server applies it once. A request the server
refuses with a 4xx status is not retried, and the text stays in the message box.

The submit check cannot always recognise a multi-line prompt in the composer. So a
long paste sent in the 30 to 50 seconds after Claude's composer appears can still
strand.

Claude Code stores a pasted prompt inside a `<pasted_content>` tag, and every
multi-line prompt sent through tmux is a paste. The chat view unwraps that tag
before rendering, or the markdown renderer would run the lines together.

The box also gets these controls:

- A stop button sends Esc, which interrupts the current turn.
- An attach button, drag-and-drop and pasting a screenshot or file into the message
  box all reuse the existing prompt upload route. The uploaded files' paths go into
  the chat message box, using the upload code's existing option to return paths
  instead of typing them into the pane. A paste that carries no file the attach rules
  admit stays a plain text paste.
- A slash command is sent as text, and the conversation shows it as typed
  (`/dual-review`), not as the tags Claude Code records it with. A skill's body,
  which Claude Code adds as a hidden row, stays out. Claude Code records `/compact`
  only when its turn ends, so the sent copy stays drawn while that turn runs. A
  skill's row arrives as its turn starts, followed at once by the hidden body row,
  and that row takes the sent copy's place then. A command that runs no turn and is
  never recorded goes from the thread after four seconds.
- Some slash commands typed with nothing after them get special handling in the chat view:
  - `/quit` and `/exit` close the session at once, as the tab's close button does,
    rather than waiting for the agent to exit and the server to notice.
  - `/clear` empties the thread at once. Claude Code starts a new conversation file,
    and the server moves to it when the statusline reports it, about a second later.
    A session without the exporter moves later, as described at the end of What the
    user sees. Until then the chat view leaves out every message no newer than the
    newest one it drew before `/clear`.
  - A built-in that opens a picker or a panel inside Claude's interface, such as a
    bare `/model` or `/config`, shows the terminal, with a note that Alt+Shift+C
    goes back. The session's remembered choice of view does not change. The server
    marks those commands (`opensTerminal` in the `/` menu's list).

The terminal stays mounted and attached while Chat shows. The chat view is a layer
over the terminal's area, so the terminal keeps its size and switching views never
resizes the pane. The stop button uses the terminal's connection to send Esc. Any
focus that lands on the hidden terminal moves to the message box, so keys never
reach the pane unseen.

## What else the message box shows

The message box also carries three things the terminal shows around Claude's
composer.

- **A `/` menu.** Typing `/` at the start of the box opens a menu of slash commands,
  fed by `GET /api/sessions/:id/slash-commands`. The list merges three sources:
  Claude Code's built-in commands, the skills and prompt commands that the
  transcript's `skill_listing` rows name, and the skills and commands on disk. The server reads those files from
  the workspace's `.claude` folder and the user's Claude config folder, and every
  read is bounded. For a Docker session it reads only the workspace's `.claude`
  folder, because that session's config folder is the container's. Picking a row
  puts `/<name> ` in the box and sends nothing.
- **The statusline.** Claude Code draws the user's statusline under its composer,
  and the chat view draws the same text under the message box. Codeman's statusline
  exporter wraps the user's own statusline command. Its V5 script prints that
  command's output unchanged and posts a base64 copy of it as `rendered`. The server
  keeps only the text, line breaks and colours, and broadcasts each change as
  `session:statusLine`. A user without a statusline of their own sees Codeman's footer.
  Claude Code does not run the statusline command while a session sits idle, so the
  server restores the last text after a restart, and an idle session keeps its statusline.
- **The suggested next prompt.** After a turn ends, Claude Code may draw a predicted
  next prompt, faint, in its empty composer. It writes that prediction nowhere else,
  so `src/web/prompt-suggestion-reader.ts` reads it off the pane three times, at
  about 1.5, 4 and 10 seconds after the turn ends. It reads nothing while no browser
  is connected to the server. The chat view shows it as the box's placeholder, and Tab in
  the empty box fills it in. A suggestion is never sent without the user.
  Each read is a synchronous tmux capture that blocks the server's event loop, and
  so are the reads of the submit verifier, the idle probe and keep-warm. Moving every
  one of those screen reads to an async capture is a follow-up.

## Dialogs and questions

Claude sometimes stops to ask: a permission prompt, an AskUserQuestion with
options, a plan approval. The question appears in the transcript as a tool call,
but the dialog that answers it exists only in the pane.

Codeman's Approvals Inbox already detects these through Claude's hooks, reads the
options from the pane, and answers them with `POST /api/approvals/:id/answer`.
Its store runs even while the inbox setting is off. In phase 2 the chat view shows a
pending item for its session as a card at the bottom of the conversation, with one
button per option. A click goes through the same answer route, which re-reads the pane
before it types anything.

The pane can also need attention in ways the inbox cannot parse. For those, the
chat view shows a notice that says "Claude is waiting for your answer in the
terminal." and offers a button that switches to the terminal view.

In phase 1, the `permission_prompt` and `elicitation_dialog` hooks raise that notice,
and the answer cards follow in phase 2. While the notice shows, the message box sends
nothing and keeps its text. A send then would type into the dialog, and its Enter could
pick the highlighted option. A session without working hooks gets neither the notice
nor the send block: its hooks are switched off, or it is a Docker case whose hooks
cannot reach the server. A send there can still type into a dialog. Covering those
sessions needs a read of the screen, because the Approvals Inbox behind the phase 2
cards is fed by the same hooks. Dialogs are rare enough for this order. Codeman starts
Claude with `--dangerously-skip-permissions` by default, so a session stops only for
Claude's own questions and plan approvals. A session started in another
permission mode stops for every permission prompt and sends each one to the
terminal until phase 2.

## Scope

The first version covers local and Docker Claude sessions in the single main view.
Remote (SSH) and adopted sessions keep the terminal, even an adopted session that
runs on this machine, because Codeman cannot name an adopted session's transcript.
Tiles in the tile grid and the second pane of a split stay terminals. Phones keep
the terminal until phase 3. The chat view is not offered on a handheld device, whatever
its orientation, so a phone turned to landscape keeps the terminal too.

Docker Claude sessions read their transcripts through the same route, because
the container bind-mounts the host's `~/.claude/projects`. That works only when the
folder existed when the container was created. It also works only while the server
runs without `CLAUDE_CONFIG_DIR`. With that variable set, the route reads
`$CLAUDE_CONFIG_DIR/projects`, which the container does not mount. A Docker session
whose hooks cannot reach the server updates mid-turn once a full read has started its
watcher. That read comes from the chat view or the Response Viewer's More button, as
described under "How the view stays live".

Remote SSH sessions are not covered. The route reads the local projects folder,
and a remote session's transcript lives on the remote host. The Edit history panel
already reads remote transcripts over its bounded ssh path, and phase 3 can reuse
it.

Codex and DeepSeek Harness also write structured transcripts, which Codeman
already reads, so they can follow in phase 3. OMP writes a structured transcript as
well, and Codeman reads it for the session history list. The conversation route has
no OMP reader yet, so OMP can follow once that route reads its transcript. Every
other CLI keeps the terminal view for now, and its toggle is hidden. For the CLIs without a structured transcript, Codeman reads the conversation
off the screen, which is too coarse for a main view, or cannot read it at all.

The agent keeps running in its tmux pane, and respawn, Ralph, auto-compact and the
other server features work as they do now. The chat view adds no hook to the
workspaces Codeman installs hooks in, and changes nothing in a session whose chat view
is off.

## Phases

1. **Live chat view**, in five steps that each work on their own:
   1. **Read.** Add the Chat/Terminal toggle, the setting that hides it and the
      default-view setting. Broadcast transcript updates as a throttled SSE event,
      render the full conversation with the Response Viewer's pipeline, and refetch it
      on transcript and session events. Show a working status line, the "waiting for
      your answer in the terminal" notice with its switch button, and follow `/clear`
      through the statusline. Typing still happens in the terminal.
   2. **Write.** Add the message box with send, stop and attach.
   3. **Slash commands.** Add the `/` menu, draw a typed slash command as typed, and
      handle `/clear`, `/quit`, `/exit` and the picker commands.
   4. **What Claude is doing.** Name the running tool in the status line, say when
      Claude compacts or still runs background work, and show the suggested next
      prompt as the message box's placeholder.
   5. **The statusline** under the message box.
2. **Dialogs and tool activity.** Show approval cards inline. Extend the transcript
   parser with tool messages and render each turn's calls as one expandable
   summary line.
3. **Scale and reach.** Add incremental fetching with a cursor. Extend the view to
   remote SSH sessions, Codex and DeepSeek Harness, and lay it out for phones,
   where the chat view could replace the terminal and accessory bar entirely.
