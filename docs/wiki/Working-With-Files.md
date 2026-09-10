# Working With Files

Reading, editing, attaching, and previewing files without leaving the dashboard. Useful on
a desktop; on a phone it is the difference between reviewing an agent's work and waiting
until you get home.

## The File Viewer

A panel that browses the active session's working directory. Its header button is on by
default; if it is missing, re-enable it in **App Settings → Header & Panels**.

It renders what it can:

| Kind                     | Behaviour                                                                 |
| ------------------------ | ------------------------------------------------------------------------- |
| Text and code            | Syntax-aware preview. Long files are truncated in plain preview.           |
| Images                   | Inline.                                                                    |
| Audio and video          | Inline with a working scrub bar, because range requests are supported.     |
| PDF and Office documents | Converted for preview when a converter is available.                       |
| Anything else            | Download.                                                                  |

Caps: 10 MB for text preview, 2 GB for raw and download (set `CODEMAN_MAX_DOWNLOAD_BYTES`
to change it, `0` for no limit — these bodies are streamed, so a large file costs a read
stream rather than server memory). Sensitive paths (`.env`, anything
matching credentials, `~/.ssh`, AWS credentials) are blocked from download, and SVG and HTML
are served as downloads rather than rendered, so they cannot execute in the page.

Closing the preview pauses and unloads any playing media. A video that keeps playing after
you close the panel means you are on an old version.

## Editing in place

Text files can be edited and saved directly in the viewer. Click the pencil in the preview
header, edit, **Save**.

The guardrails are worth knowing, because they are what makes editing safe rather than
convenient:

- **Extension allowlist**, not a blocklist. Code, docs, config, and markup are editable.
  Anything not on the list is not.
- **512 KB cap** on both read and write.
- **Edit mode never truncates.** The plain preview does truncate long files, and saving a
  truncated buffer would silently delete the rest, so the editor loads the whole file or
  refuses.
- **Optimistic concurrency.** The save carries a hash of what you started from. If the file
  changed underneath you (likely, when an agent is working in the same repo), the save is
  rejected rather than clobbering their work.
- **No file creation.** Writes go to a temporary file and are renamed over the original, and
  the open never creates. Editing in place is structural, not a rule.
- **Line endings are preserved** server-side, so editing two lines of a CRLF file does not
  produce a whole-file diff.
- **`.git/` is denied outright.** Hooks are executable code, and a corrupted index looks
  unrecoverable to someone who wanted to fix a typo.
- **Non-UTF-8 content is refused**, verified by a round-trip comparison.

## Attachments

Attachments are live references to files **outside** the session's workspace: a spec on your
desktop, a PDF in Downloads, a design document elsewhere on the machine.

Register one from the CLI:

```bash
codeman attach /path/to/spec.pdf
```

An attachment card appears in the session, and the file can be previewed inline. The
attachment gets a stable id, and browser requests use that id rather than carrying absolute
paths around.

Agents can register attachments too, by emitting a `codeman://attach?...` link in their
output. That path is **prompt-injectable by nature**, so it is force-confined to the
session's workspace: a hostile prompt cannot use it to pull arbitrary host files into the
event stream. The gate is an extension allowlist rather than a blocklist.

Document conversion for previews is globally rate limited. Without that, ten large documents
detected at once would fork ten multi-minute converter processes.

## Clicking a path

File paths in a session are links. That works in two places:

- **In the terminal**, on any absolute path an agent prints.
- **In the response viewer**, where paths are usually written as prose or in backticks. They
  render as underlined monospace links.

Clicking one opens it in the preview: images and PDFs render, video and audio play with a
working scrub bar, documents convert, text and Markdown show inline. Log-shaped files open in
the tail viewer instead, which follows a file that is still being written.

Paths **outside** the session's workspace work too, which matters because that is where most
of an agent's output lands: a screenshot in `/tmp`, a capture in its own scratchpad, a file in
another checkout. Those are served through the attachment routes rather than the workspace
ones, so the same rules apply as to any other attachment: secret trees are blocked, the
extension allowlist decides what can be opened, and symlinks are resolved before either check.

Outside the workspace the allowlist is images, video, audio, PDF, Office documents, and text
files, where "text" is the same list the viewer will let you edit: code, config, logs, csv,
markdown. The reasoning is that a session can already `cat` any of those, so the file suffix
was never what kept anything secret; the path guard is. Types outside the list (`.svg`,
`.bmp`) say so rather than failing silently, and `.html` previews as source rather than being
rendered, so nothing served this way can execute in the page.

Text previews are capped at the first 500 lines, fetched as a partial read, so clicking a
one-gigabyte log does not try to paint one.

Log-shaped files inside the workspace still open in the tail viewer, which follows a file as
it is written. Outside the workspace they open in the preview instead: the tail viewer runs
`tail -f`, and that is deliberately restricted to the workspace, `/var/log` and `~/logs`.

Nothing is registered until you click. Opening a file this way does not add an attachment card.

## The path picker

For choosing a path rather than typing one. It appears in two places:

- **Browse** in **Add Case → Link Existing**.
- The **📁 Path** key on the mobile keyboard bar.

It browses one directory at a time and can show hidden entries on request. The picker
inserts the path into your prompt **without** pressing Enter, so nothing is submitted by
accident. Its sibling **⌫ All** key clears the unsent prompt, and never sends the agent's
`/clear` command.

This is a separate file-serving surface from the viewer, with its own rules: it allowlists
your home directory, the cases directory, and anything in `CODEMAN_FILE_PICKER_ROOTS`, and
blocks sensitive trees. In multi-user mode a non-admin gets only their own user space as a
root, because per-user spaces live inside the home directory and a home-directory root would
expose everyone.

## Images into a session

Paste from the clipboard or drag and drop straight onto the terminal. The image is written
where the agent can read it and the reference is inserted into your prompt. On a phone, the
image key in the keyboard bar opens the camera or photo library.

HEIC images from an iPhone are converted to JPEG on the way in.

## Generated artifacts

When an agent produces a file the UI can show (a chart, a diagram, a document), it can
surface as an artifact attachment rather than a path you have to go and find.

## Gotchas

- **The viewer follows the active session's workspace.** Switching tabs changes what you are
  browsing.
- **A save can be rejected, and that is the feature.** It means the agent edited the file
  while you were typing. Re-open, re-apply, save again.
- **Attachments live outside the workspace on purpose.** For files inside it, just use the
  viewer.
- **`.env` files are readable in the viewer if the extension policy allows the preview, but
  never downloadable.** Do not treat the viewer as a secrets boundary; treat the machine as
  the boundary.

## Read next

- [The Dashboard](The-Dashboard) - where the panels live.
- [Input And Voice](Input-And-Voice) - other ways to get content into a session.
- [Security](Security) - how the file surfaces are confined.
- [`docs/file-viewer-edit-plan.md`](https://github.com/Ark0N/Codeman/blob/master/docs/file-viewer-edit-plan.md) - the edit-mode design.
