# File Viewer edit mode (issue #212)

Plan only. No implementation yet.

Goal: close the loop "agent writes a file, you review it in the viewer, tweak two lines, save, tell the
agent to continue" without hopping into the terminal, with the phone as the primary target.

Scope from the issue: an Edit toggle on text previews, a write endpoint that inherits the read path's
confinement, text-only, edit-in-place (no create, no delete, no rename), no editing through the
Docker/remote overlays.

---

## 1. What exists today

**Read path (backend), all in `src/web/routes/file-routes.ts`:**

| Route                                | Line   | Notes                                                              |
| ------------------------------------ | ------ | ------------------------------------------------------------------ |
| `GET /api/sessions/:id/files`        | `741`  | Tree scan of `session.workingDir`, hidden files off by default      |
| `GET /api/sessions/:id/file-content` | `865`  | The text/preview classifier. `findSessionOrFail` + `validateSessionFilePath` |
| `GET /api/sessions/:id/file-raw`     | `1018` | Bytes, 50MB cap                                                    |
| `GET /api/sessions/:id/file-preview` | `1254` | DOCX/PPTX to PDF, everything else redirects to `file-raw`           |
| `GET /api/download`                  | `1384` | The only read route that also runs `isSensitivePath()`              |

`file-content` classification order (`file-routes.ts:881-1011`): extension buckets (image / video / audio /
known-binary) return metadata only; otherwise the bytes are read, sniffed for a NUL in the first 8KB, and
either reported as `type:'binary'` or decoded as UTF-8 and **truncated to `lines` (default 500, hard cap
10000)**. Caps: `MAX_TEXT_FILE_SIZE` 10MB.

Confinement is `validateSessionFilePath()` (`src/web/route-helpers.ts:67`): `resolve()` then `realpathSync()`
then reject if the result is not under `workingDir`. Because it realpaths the *full* path, a symlink whose
target escapes the workspace is already rejected. Ownership is `findSessionOrFail()` which runs
`canAccessOwned()` (`route-helpers.ts:102`), a no-op outside multi-user mode.

**Read path (frontend), `src/web/public/panels-ui.js`:**

- `loadFileBrowser()` `2947`, `renderFileBrowserTree()` `2978`, click to `openFilePreview()` `3056`.
- `openFilePreview(filePath, sessionId, attachmentId)` `3193`: attachment-id branch, then docx/pptx, pdf,
  svg branches, then the generic `file-content` fetch at `3274` with **`&lines=500` hardcoded**, rendering
  text as `<pre><code>${escapeHtml(...)}</code></pre>` at `3298` and stashing `this.filePreviewContent`.
- `closeFilePreview()` `3308`, `copyFilePreviewContent()` `3751`.
- Markup: `src/web/public/index.html:420-432` (`filePreviewOverlay` / `-Title` / `-Body` / `-Footer`, two
  header buttons: copy and close).
- CSS: `src/web/public/styles.css:9320-9430`. Overlay `z-index: 2000`, window `80vw/80vh`, capped
  `900x700`. There are **no `.file-preview-*` rules in `mobile.css` at all**.

**Reachability on phones.** When this plan was written the header File Viewer button was hidden below 430px
(`mobile.css:482`, locked by `KNOWN_PHONE_HIDDEN` in `test/mobile-header-buttons-policy.test.ts`); since
#759 it shows on a phone once switched on there, and stays off by default. Without it, on a
phone the preview overlay is reached through:

1. an attachment card's **Preview** button (`panels-ui.js:3451`), which is exactly the "agent just wrote a
   file" path the issue describes,
2. the attachment-history drawer (`panels-ui.js:3709`),
3. App Settings to Panels to **File Browser** (`showFileBrowser`, applied in `settings-ui.js:2202`; the
   panel is mobile-styled at `mobile.css:1868`).

So edit mode is reachable on a phone today via (1) and (2) without touching the header policy. Improving
the entry point is listed as an open decision in section 10, not assumed.

---

## 2. Threat model, stated honestly

Anyone who can call this API can already reach `POST /api/sessions/:id/input` and type an arbitrary prompt
into an agent running with `--dangerously-skip-permissions`. A workspace-confined write endpoint therefore
does not create a new privilege tier for an authenticated caller.

What it *would* create if built carelessly is a **new host-write primitive reachable by path**, so the
things this plan actually defends against are:

1. **Path traversal / symlink escape** writing outside the workspace.
2. **TOCTOU**: a path component that becomes a symlink between validation and write.
3. **Cross-user writes** in multi-user mode (`canAccessOwned`).
4. **Silent data loss**, which is the highest-probability real-world failure here and gets its own section.

CSRF is already covered: `registerHostGuard()` (`src/web/middleware/auth.ts:555-578`) rejects any
non-safe-method request whose `Origin` is cross-site. The webview-capability exemption at that gate is
fenced to `GET`/`HEAD` for the Referer form (`auth.ts:161`) and to `/webview/:cap/*` paths for the path
form, so a proxied dashboard cannot reach a new `PUT /api/...`. Using `PUT` + `application/json` also
forces a preflight for any cross-origin attempt.

---

## 3. Backend design

### 3.1 New policy module: `src/config/file-editing.ts`

Pure, unit-testable, no IO (config lives in `src/config/`, no barrel, import the file directly).

```ts
export const MAX_EDITABLE_BYTES = 512 * 1024;      // content cap, both directions
export const EDITABLE_EXTENSIONS: ReadonlySet<string>;  // ts,tsx,js,jsx,mjs,cjs,json,jsonc,md,mdx,txt,
                                                        // css,scss,less,html,htm,xml,svg?,yml,yaml,toml,
                                                        // ini,cfg,conf,env?,sh,bash,zsh,fish,py,rb,go,rs,
                                                        // java,kt,swift,c,h,cpp,hpp,cs,php,sql,graphql,
                                                        // proto,lua,pl,r,jl,tf,gradle,csv,tsv,log,diff,patch
export const EDITABLE_BASENAMES: ReadonlySet<string>;   // Dockerfile, Makefile, LICENSE, .gitignore,
                                                        // .prettierignore, .editorconfig, .nvmrc, ...
export function isEditableFileName(fileName: string): boolean;
export function isDeniedEditRelativePath(rel: string): boolean;  // `.git/` subtree
export function detectEol(text: string): 'lf' | 'crlf';
export function applyEol(text: string, eol: 'lf' | 'crlf'): string;
```

Decisions baked in:

- **Allowlist, not blocklist**, per the issue and per the existing attachment-guard precedent.
- `svg` and `env` are deliberately marked with `?` above: `svg` is served as an untrusted octet-stream on
  the read side (`file-routes.ts:118`) so allowing an edit is defensible, but I recommend **excluding
  both** in v1. `.env` files are matched by `isSensitivePath()` anyway and would be rejected downstream;
  excluding them at the allowlist keeps a single obvious refusal. Superseded for dotenv: the plain
  preview serves a workspace `.env` in full, so the editor now opens dotenv files (`allowDotenv`, see
  `docs/architecture-invariants.md#file-viewer-edit-mode`); `svg` stays excluded.
- `isDeniedEditRelativePath` blocks the `.git/` subtree: `.git/hooks/*` is code execution and a corrupt
  index is unrecoverable-looking to a user who only wanted to fix a typo. Other dotfiles stay allowed but
  are not reachable from the tree UI anyway (`showHidden=false`).

### 3.2 Read-for-edit: extend the existing GET

`GET /api/sessions/:id/file-content?path=<rel>&edit=1`

When `edit=1`:

- skip line truncation entirely (a truncated buffer must never become an edit buffer, see section 4.1),
- enforce `MAX_EDITABLE_BYTES` instead of `MAX_TEXT_FILE_SIZE` and answer 413 over it (as a structured
  throw with `statusCode: 413`, the `throwFilesystemPickerError` pattern, since the central errorCode-to-
  status map has no 413 entry; see the error-mechanics note in 3.3),
- run the editability gate (`isEditableFileName`, `isDeniedEditRelativePath`, `isSensitivePath`,
  `isBlockedAttachmentPath`) and the content gate (NUL sniff plus UTF-8 round-trip, see 4.3),
- return `{ content, size, mtimeMs, totalLines, truncated: false, extension, editable: true, hash, eol }`.
  `hash` is `sha256` hex of the exact on-disk bytes.

Non-`edit` responses gain **only** `editable: boolean` (additive, no shape change for existing consumers),
which is all the UI needs to decide whether to show the Edit button. No `hash` on plain reads: the Edit
action re-fetches with `edit=1` anyway (section 4.1), which is where the hash comes from, and hashing every
casual 10MB preview would be pure waste.

### 3.3 Write: `PUT /api/sessions/:id/file-content`

Body (new `FileWriteSchema` in `src/web/schemas.ts`, Zod v4):

```ts
{ path: string, content: string, baseHash: string, eol?: 'lf'|'crlf', force?: boolean }
```

Registered with an explicit route option `{ bodyLimit: 4 * 1024 * 1024 }`. **Fastify's default `bodyLimit`
is 1MB and this repo configures none**, and JSON escaping expands content: 2x for a file full of quotes or
backslashes, up to 6x for control characters (each serialized as a `\uXXXX` escape), so 512KB of content
can legitimately exceed 1MB on the wire; blowing the limit produces a raw `FST_ERR_CTP_BODY_TOO_LARGE`, not an `ApiResponse` envelope. Two
related sizing notes: `z.string().max()` counts **UTF-16 code units, not bytes**, so the schema's `.max()`
is only a coarse pre-filter and the real cap is an explicit `Buffer.byteLength(content, 'utf8')` check in
the handler (step 7a below); and 4MB comfortably bounds the worst-case expansion of a 512KB file without
inviting multi-MB bodies elsewhere.

**Error mechanics** (matters for both prod behavior and testability): a handler that *returns* a
`{success:false, errorCode}` envelope gets its HTTP status assigned centrally by the preSerialization hook
in `server.ts` (`httpStatusForErrorCode()`, `src/types/api.ts`), but the route-test harness
(`test/routes/_route-test-utils.ts`) installs only `installRouteErrorHandler`, **not** that hook, so
returned envelopes surface as HTTP 200 in tests. The PUT handler should therefore use the same
structured-**throw** pattern as the filesystem picker (`throwFilesystemPickerError`, `file-routes.ts:411`):
thrown `{statusCode, body}` errors are rendered identically in prod and in the harness, and they allow the
one status the code map cannot express (413). The error envelope itself is strictly
`{success:false, error, errorCode}`, **it has no data arm**, so no error response may carry extra payload.

Handler order (each step is a test case):

1. `findSessionOrFail(ctx, id, req)` (live sessions only, matching the read route, and it carries the
   multi-user ownership check).
2. `parseBody(FileWriteSchema, req.body)`, then `Buffer.byteLength(content, 'utf8') <= MAX_EDITABLE_BYTES`
   or 413 (the schema `.max()` alone cannot enforce a byte cap, see the sizing note above).
3. `validateSessionFilePath(session.workingDir, path)` or 404 (do not distinguish "outside workspace" from
   "missing", matching the read route).
4. `isSensitivePath(resolvedPath) || isBlockedAttachmentPath(resolvedPath, guard.blockedTrees)` or 403.
5. `isDeniedEditRelativePath(relativePath)` or 403.
6. `isEditableFileName(basename(resolvedPath))` or 400.
7. `stat`: must be `isFile()`, size within `MAX_EDITABLE_BYTES`, else 400/413. **No `O_CREAT` anywhere in
   this handler**, which is what enforces edit-in-place.
8. Read current bytes, compute `hash`, run the NUL sniff and the UTF-8 round-trip check, else 400.
9. `hash !== baseHash && !force` gives **409 CONFLICT** (`ApiErrorCode.CONFLICT`, plain envelope; the error
   arm carries no data, see the error-mechanics note). The client's conflict dialog gets fresh state by
   re-fetching `edit=1`, which it needs for its Reload action anyway.
10. Build the output buffer: `applyEol(content, eol ?? detected-from-original)`; re-check
    `Buffer.byteLength` against the cap.
11. Write atomically in the resolved parent directory:
    `fs.open(<dir>/.<name>.codeman-tmp-<rand>, 'wx', stat.mode & 0o777)`, then `fchmod(stat.mode & 0o777)`
    (open's mode argument is masked by the process umask, so the chmod is what actually preserves an
    unusual mode), write, `fsync`, close, `fs.rename(tmp, resolvedPath)`, unlink the temp on any failure.
12. Re-stat, return `{ success: true, data: { path, size, mtimeMs, hash, totalLines } }`.

Why `O_EXCL` temp plus rename rather than truncate-in-place:

- `wx` cannot follow a pre-existing symlink, which closes the TOCTOU window from step 3 to step 11 without
  needing `O_NOFOLLOW` gymnastics.
- `rename()` does not follow a symlink in the final component, so even if `resolvedPath` were swapped for a
  symlink after validation, the symlink itself is replaced and the swap target is untouched.
- A crash mid-write leaves the original intact.

Caveat to document in the code comment: rename replaces the inode, so hardlinks to the file keep the old
content. That is the same trade-off vim makes by default and is preferable to a truncate window here.

No SSE event in v1. Nothing else in the app needs to know: `image-watcher.ts` only reacts to
`.png/.jpg/.jpeg/.gif/.webp/.bmp/.svg/.pdf/.docx/.pptx` adds (`image-watcher.ts:23-25`), none of which are
editable text, and the temp filename does not match either.

---

## 4. The five traps

These are the parts that turn a "small write endpoint" into a bug report.

### 4.1 Truncation (the data-loss trap)

The frontend fetches `&lines=500` (`panels-ui.js:3274`). Saving that buffer back would **delete every line
past 500**. Worse, the content hash of the full file would still match, so an optimistic-concurrency check
cannot catch it.

Mitigations, all three:

- The Edit affordance is only offered when the loaded payload came from `edit=1` (which never truncates).
  Tapping Edit on an already-rendered preview **re-fetches** with `edit=1` before swapping in the editor.
- The read-for-edit path 413s above `MAX_EDITABLE_BYTES` rather than truncating, so "too big to edit here"
  is an explicit refusal with a message, never a silent partial buffer.
- A test asserts `edit=1` never returns `truncated: true`.

### 4.2 Line endings

A `<textarea>`'s `.value` normalizes to LF. Saving a CRLF file naively rewrites every line, producing a
whole-file diff for a two-line change. So: the read returns the detected `eol`, the client echoes it back
unchanged, and the server re-applies it. Mixed-EOL files use the dominant style, which is lossy for the
minority lines; call that out in the response and accept it in v1.

### 4.3 Encoding

`buf.toString('utf-8')` on a latin-1 or otherwise non-UTF-8 file yields U+FFFD replacement characters, and
writing that back **corrupts the file**. The check is a round-trip:
`Buffer.from(decoded, 'utf8').equals(buf)`. If it fails, `editable: false` and the write is refused. This
also catches binary content that the NUL sniff misses. A UTF-8 BOM survives because it round-trips as a
leading U+FEFF; do not strip it.

### 4.4 Concurrency with the agent

The whole use case is editing a file the agent just wrote and may write again. `baseHash` plus 409 is the
guard. Do not use mtime alone: agents rewrite files within a single filesystem timestamp tick, and an
identical rewrite should not be reported as a conflict.

### 4.5 Symlinks and TOCTOU

Covered by `validateSessionFilePath` (escape) plus `wx` temp and `rename` (post-validation swap). One
intentional allowance: a symlink whose target is *inside* the workspace is edited through to its target,
because `validateSessionFilePath` returns the realpath. That matches what a user tapping the file expects.

---

## 5. Frontend design

All in `panels-ui.js` (prettier-exempt, hand-formatted; match the surrounding style), `index.html`,
`styles.css`, `mobile.css`.

### 5.1 State

```js
filePreviewEdit = { active, sessionId, path, baseHash, eol, original, dirty }
```

Reset in `closeFilePreview()` and on every `openFilePreview()` entry.

### 5.2 Markup (`index.html:420-432`)

Add one header button (pencil, `btn-icon-sm`, `id="filePreviewEditBtn"`, hidden by default) next to the
copy button, and an edit bar inside the footer region holding Save / Cancel / a dirty dot. Keep the
existing footer text element; the edit bar is a sibling toggled by class so the read-mode footer is
untouched.

### 5.3 Behavior

- `openFilePreview()` shows the Edit button only when the response has `editable: true` and the render took
  the text branch. Attachment-id previews, media, binary, pdf, docx/pptx and svg all leave it hidden.
- **Enter edit**: re-fetch with `edit=1`; on 413 or `editable:false`, toast the reason and stay in read
  mode. This fetch must **parse the error envelope on non-ok responses**: the existing generic
  `if (!res.ok) throw new Error('Failed to load file')` pattern (`panels-ui.js:3275`) would swallow the
  specific "too large to edit here" message, since error envelopes arrive with real 4xx statuses in prod. On success replace the body with `<textarea class="file-preview-editor" spellcheck="false"
  autocapitalize="off" autocorrect="off" autocomplete="off" wrap="off">` and assign `.value = content`
  (never `innerHTML`, so no escaping question arises). Do **not** autofocus: on a phone that opens the
  keyboard before the user has picked a line.
- `input` sets `dirty` and enables Save.
- **Save**: `PUT` with `baseHash`, `eol`, and `content`. On success update `baseHash`/`original` from the
  response, leave edit mode, re-render the read view from the local editor value (the response carries
  metadata only, not content), toast "Saved". On **409** offer `Reload (discard mine)` / `Overwrite`:
  Reload re-fetches `edit=1` and replaces the buffer; Overwrite re-sends with `force: true`. The 409 body
  itself carries no state (section 3.3, step 9).
- **Cancel / close / Escape while dirty**: `confirm('Discard unsaved changes?')`, consistent with the
  existing `window.confirm` usage in this codebase (`panels-ui.js:4323`, `app.js:4176`). Note the global
  Escape handler (`app.js:999-1007`) closes other panels via `closeAllPanels()` but does not touch this
  overlay today; if Escape-to-close is wired up as part of this work it must go through the same dirty
  guard.
- `copyFilePreviewContent()` copies the live editor value while editing.

⚠️ Repo gotcha to respect at the fetch call: **Zod `.optional()` rejects `null`**. Build the body with
`eol: eol ?? undefined` (or declare `.nullish()`), or the PUT fails `INVALID_INPUT`. This has shipped as a
real bug twice.

### 5.4 Mobile

- **Sizing.** The window is `80vw/80vh` centered with no mobile override, so when the keyboard opens on iOS
  the lower half sits behind it. Add a `@media (max-width: 430px)` block using
  `height: var(--app-height, 100vh)`, full width, no border radius. `--app-height` is already maintained
  against `visualViewport` by `KeyboardHandler.handleViewportResize()` (`mobile-handlers.js:283-317`), so
  the editor tracks the keyboard for free.
- **iOS zoom.** The editor font must be >= 16px on phones; there is an existing zoom-prevention block at
  `mobile.css` under `@media (max-width: 768px)`. Verify it covers `textarea` and do not override it with a
  smaller `rem` value.
- **Accessory bar.** Focusing any input fires `KeyboardHandler.onKeyboardShow()`, which calls
  `KeyboardAccessoryBar.show()` and refits/resizes the terminal (`mobile-handlers.js:407+`). The bar's keys
  target the **terminal**, not the editor, so an Esc or clear-input tap while editing goes to the agent.
  The overlay's `z-index: 2000` covers the bar's `51`, so it is not visible, but confirm it is not
  interactive underneath and consider an explicit `KeyboardAccessoryBar.hide()` while the editor holds
  focus. This is the item most likely to look "fine on desktop, wrong on the phone".
- No header-policy change is needed (section 1), so
  `test/mobile-header-buttons-policy.test.ts` stays untouched.

### 5.5 i18n

`i18n.js` already skips `textarea`, `pre`, `code` and `.file-preview-content` in its `SKIP_SELECTOR`
(`i18n.js:20-38`), so file content is never translated. Add zh-CN entries for the new chrome: Edit, Save,
Cancel, Unsaved changes, Discard unsaved changes?, File changed on disk, Reload, Overwrite, Saved,
Too large to edit here.

---

## 6. Docker and remote cases

Out of scope per the issue, and the current behavior already degrades correctly:

- **Docker cases**: the workspace is a host directory bind-mounted at the same absolute path, so a host-side
  write is visible in the container immediately. Edit mode works and needs nothing special. Worth one line
  in the docs.
- **Remote SSH cases**: `workingDir` is a path on the remote host, and the READ routes now
  resolve it over ssh (`src/remote-files.ts`, same `buildSshConnectionArgs` discipline as the
  launch path — #415). What stays unsupported is the WRITE side: an `edit=1` / `PUT` answers
  `400` "editing is not supported for files in a remote (SSH) case", `editable` is always
  `false`, office previews and generated thumbnails answer `400`, and no remote file is ever
  copied to the server's disk. Do not attempt an SFTP write path.

---

## 7. Tests

| File                                        | Kind        | Covers                                                                 |
| ------------------------------------------- | ----------- | ---------------------------------------------------------------------- |
| `test/file-editing-policy.test.ts`          | pure unit   | `isEditableFileName` (allow + deny + basenames), `isDeniedEditRelativePath`, `detectEol`/`applyEol` round-trip incl. mixed EOL, BOM preservation |
| `test/routes/file-write-routes.test.ts`     | `app.inject` | The handler order in 3.3, against a **real temp dir** (do not `vi.mock('node:fs')` in this file; set `MockSession.workingDir`, `test/mocks/mock-session.ts:14`) |
| extend `test/routes/file-routes.test.ts`    | `app.inject` | `edit=1` never truncates; `editable` present on the plain read          |

Status-code caveat for all of these: the route-test harness does not install the server's preSerialization
envelope hook, so a handler that *returns* an error envelope answers 200 in tests. The statuses below are
only assertable because the plan has the handler **throw** structured errors (section 3.3, error
mechanics), which `installRouteErrorHandler` renders identically in prod and in the harness.

Route cases to assert explicitly:

1. happy path writes the bytes and returns a new hash
2. `../` and absolute paths give 404
3. symlink pointing outside the workspace gives 404
4. symlink pointing inside is written through to the target
5. non-allowlisted extension gives 400
6. `.git/config` gives 403
7. a `.env` in the workspace gives 403 (sensitive-path); superseded: it is now editable, while `.ssh/.env`,
   the data dir's `.env` and the other credential files still give 403
8. a file with a NUL byte gives 400
9. a latin-1 file that fails the UTF-8 round-trip gives 400
10. stale `baseHash` gives 409 (`CONFLICT` envelope, no data); `force:true` then succeeds
11. over `MAX_EDITABLE_BYTES` gives 413
12. a path that does not exist gives 404 and creates nothing (no `O_CREAT`)
13. multi-user: `authUser: {role:'user'}` against another user's session gives 404 (pass `authUser` to
    `createRouteTestHarness`, otherwise the synthetic admin makes the test pass vacuously)
14. CRLF file edited and saved stays CRLF
15. file mode is preserved across the temp-plus-rename

Run with `npm test -- test/routes/file-write-routes.test.ts`, never bare `npm test`.

**End-to-end verification before any deploy** (unit tests passing is not sufficient here):

- `curl -sk https://localhost:3000/...` against a **throwaway** session created for the purpose, never
  `w1`/`w2`/`w3`; delete it by exact id afterwards.
- Playwright on a phone profile: open a preview, tap Edit, type with `page.keyboard.type()`, Save, then
  assert the bytes on disk changed. Assert real state, not HTTP 200.

---

## 8. Docs and release

- This plan lives at `docs/file-viewer-edit-plan.md`.
- `docs/architecture-invariants.md`: new anchor `#file-viewer-edit-mode` covering the write confinement
  chain, the truncation invariant, and why temp-plus-rename.
- `CLAUDE.md`: one line under the **Filesystem path picker** neighborhood noting that the File Viewer now
  has a **third** file surface and that it is the only one that writes, plus its confinement rules.
  Remember `CLAUDE.md` is prettier-ignored on purpose.
- `docs/api-reference.md`: the new `PUT` and the `edit=1` query.
- Release: a normal COM applies (the 1.10.0 batch hold is over). This is a new user-facing feature plus an
  additive API surface, so **COM minor** when it ships.

Formatting note: `panels-ui.js`, `styles.css`, `mobile.css`, `index.html` are all in `.prettierignore` and
are hand-formatted; new TypeScript (`src/config/file-editing.ts`, route + schema edits) is prettier-enforced
and must pass `npm run format:check`.

---

## 9. Implementation order

Each phase is independently reviewable and leaves the tree working.

1. **Policy module + tests.** `src/config/file-editing.ts` and `test/file-editing-policy.test.ts`. Pure, no
   route wiring. (Small.)
2. **Read-for-edit.** `edit=1` (returning `hash`/`eol`) plus the additive `editable` flag on plain reads,
   tests. Nothing consumes it yet. (Small.)
3. **Write endpoint.** `FileWriteSchema`, `PUT` handler, `test/routes/file-write-routes.test.ts`. Fully
   testable by curl before any UI exists. (Medium, the security-relevant part.)
4. **Desktop UI.** Edit button, textarea swap, Save/Cancel, dirty guard, 409 flow. (Medium.)
5. **Mobile pass.** `mobile.css` sizing against `--app-height`, font size, accessory-bar interaction,
   real-device check. (Small but the part that decides whether the feature is actually usable.)
6. **Docs, i18n strings, changeset.**

---

## 10. Open decisions

1. **Editor widget.** Recommend a plain `<textarea>` for v1: zero dependencies, no CSP question, no bundle
   growth, and it is the only thing guaranteed to behave with the iOS keyboard. CodeMirror-light with
   syntax highlighting is a clean follow-up once the write path is proven. The issue allows either.
2. **Phone entry point.** Edit mode is reachable on a phone through attachment cards and the history
   drawer without changing anything. A dedicated toolbar or overview affordance for "browse this session's
   files" would make it discoverable, but it is a separate UX change and would need a decision against the
   deliberately minimal phone header policy. Recommend deferring it and revisiting after the feature ships.
3. **`svg` editability.** Recommend excluded in v1 (it is deliberately treated as untrusted on the read
   side). Easy to add later.
4. **Create / delete / rename.** Explicitly out of scope per the issue. Note that keeping `O_CREAT` out of
   the handler is what makes that a structural property rather than a convention.
