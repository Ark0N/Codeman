# Reliable input delivery (exactly-once, durable)

## The bug this fixes

With local echo on, pressing Enter cleared the overlay and then sent the prompt
over the WebSocket **fire-and-forget** (`ws.send({t:'i',d})`). On a flaky link
(e.g. a moving train) the socket is frequently *half-open*: `readyState === OPEN`
so `ws.send()` does **not** throw, but the underlying TCP is dead, so the frame is
silently discarded. Nothing was enqueued (the send "succeeded"), the on-screen
prompt was already wiped, and `navigator.onLine` stays `true` — so a long typed
prompt vanished with no trace and no resend.

## The guarantee

Every byte of user input is **recorded durably before delivery** and **only
dropped once the server ACKs it** — so a half-open socket, a reconnect, or a page
reload can never lose input. Redelivery is **exactly-once**: the server applies
each `(clientId, seq)` at most once, so a resend can't type the prompt twice.

## How it works

### Client (`app.js`)

- A stable **`clientId`** (`localStorage['codeman:clientId']`) identifies this
  browser to the server's dedup across reconnects and reloads.
- Each input frame gets a **monotonic per-session `seq`**. Frame records
  (`{seq,data,useMux,ts,tries,sentAt}`) live in `_pendingDeliveries`
  (`Map<sessionId, record[]>`), persisted (debounced, + flushed on `pagehide`/
  `visibilitychange`) to `localStorage['codeman:pendingInput']`. The seq counters
  persist too, so seqs stay monotonic across reloads (never reset — a reset would
  let the server treat fresh input as an already-applied duplicate).
- **Delivery** (`_drainSession`):
  - **WS path** — when the socket is `OPEN` for the session, send each not-yet-sent
    record (`sentAt === 0`) in seq order over the single ordered stream. Records
    stay pending until the server's `{t:'ia',seq}` ACK removes them.
  - **POST path** — when no WS, POST records in order, awaiting each (the HTTP 2xx
    *is* the ACK). A 404/410 (session gone) drops the record rather than retry
    forever.
- **Half-open recovery** (`_redeliverSweep`, every 2s): if the active WS session's
  oldest record is unacked past `_reliableAckTimeoutMs` (4s), the socket is assumed
  dead — `ws.close()` forces a fast reconnect; `onopen` (`_onWsReady`) resets
  `sentAt = 0` and re-sends everything pending. Also re-drains background sessions
  over POST, and fires on SSE-reconnect / `online`.
- The connection indicator shows pending count/bytes (`_pendingBytes`).

### Server

- **`Session.shouldApplyInput(clientId, seq)`** — returns `true` exactly once per
  `(clientId, seq)`: the first time a seq strictly greater than that client's
  last-applied is seen. A replayed/lower seq returns `false`. Bounded MRU map
  (`MAX_INPUT_DEDUP_CLIENTS = 256`).
- **WS route** (`ws-routes.ts`) — parses optional `cid`/`seq` on `{t:'i'}`; applies
  via `shouldApplyInput`. An applied frame is ACKed with `{t:'ia',seq}`; a duplicate is
  ACKed as `{t:'ia',seq,dup:true,last:<watermark>}`, where `last` is the server's
  highest applied seq for that `clientId` (`Session.lastInputSeq`). The client drops
  the record either way, and on `dup` it lifts its own counter to `last` first and
  re-sends a FIRST-attempt record (a retry being called a duplicate is the mechanism
  working: the original landed). Without `last`, a tab killed between a send and the
  persisted counter write came back counting BELOW the server's watermark, and every
  later keystroke was dropped-but-ACKed: a silently dead terminal a reload could not
  fix, since the stale counter was restored from localStorage too. The client now
  persists the counter synchronously on every send for the same reason. Untagged
  frames apply unconditionally (no behavior change).
- **POST route** (`/api/sessions/:id/input`) — optional `seq`/`clientId` in
  `SessionInputWithLimitSchema`; a deduped duplicate returns 200 without writing
  (the 200 is the client's ACK). `curl`/legacy callers omit the fields and always
  apply.

## Oversized input (issue #484)

Delivery has a third outcome besides "applied" and "retry": **refused for good**.
Both transports refuse a frame longer than `MAX_INPUT_LENGTH` (64 KiB,
`src/config/terminal-limits.ts`; the POST schema uses the same constant). Before
#484 the client treated that like a transient failure, so an oversized paste sat
at the head of the queue, was re-sent every 2 s forever, blocked every later
input for the session, and came back from localStorage on each reload.

- `_sendInputAsync()` splits a paste over the frame limit into in-limit frames
  (`CodemanInputLimit.split`, constants.js, never cutting a surrogate pair). They
  go out in seq order, so the PTY sees one contiguous stream. A paste over
  `PASTE_MAX_CHARS` (1 MiB), or an oversized `useMux` write (line-oriented, never
  split), is refused with a toast and never queued.
- The WebSocket answers an oversized sequenced frame with
  `{t:'ia', seq, err:'too_large', max}`; the client drops it with a toast. A
  client that predates `err` reads it as a plain ACK and drops it too.
- The POST drain drops a frame answered `400`/`413` (`401`/`403` stay transient:
  an expired login delivers once the user signs in again).
- `_loadReliableState()` prunes persisted frames over the limit, so a queue
  poisoned by an older build heals on the first load after upgrading.
- ⚠️ The frontend limit (`INPUT_FRAME_MAX_CHARS`) and the composer's
  `COMPOSER_INPUT_FRAME_LIMIT` must equal `MAX_INPUT_LENGTH`; pinned by
  `test/input-size-limit.test.ts`.

## Known limitation

Dedup state is in-memory on the server. A **server restart** between a write and
the client's redelivery of that same seq could re-apply it (a rare duplicate).
This is a deliberate trade-off: favor *never losing input* over a rare duplicate
across the narrow restart window.

## Tests

- `test/reliable-input-dedup.test.ts` — `Session.shouldApplyInput` exactly-once
  semantics (monotonic, per-client, gap-tolerant, eviction-safe).
- `test/routes/session-routes.test.ts` — POST `/input` applies a tagged
  `(clientId, seq)` once on redelivery; untagged input always applies.
- `test/input-size-limit.test.ts`: one input limit on both sides, frame
  splitting, and dropping (never retrying) a frame refused for good (#484).
