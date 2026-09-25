/**
 * @fileoverview WebSocket terminal I/O route.
 *
 * Provides a low-latency bidirectional channel for terminal input/output,
 * bypassing the HTTP POST + SSE path that adds per-request middleware overhead.
 * Auth is checked once on the WebSocket upgrade handshake (cookies are included
 * automatically by the browser). After upgrade, the connection is raw — no
 * per-message middleware processing.
 *
 * Additive: the existing HTTP POST /api/sessions/:id/input and SSE session:terminal
 * paths remain fully functional. The frontend opts into WS when available and
 * falls back transparently.
 *
 * Terminal output is micro-batched at 8ms to group Ink's rapid cursor-up redraws
 * into single frames, preventing flicker from split ANSI sequences. This matches
 * the SSE path's server-side batching (16-50ms) but at a shorter interval since
 * WS has no Traefik buffering overhead.
 *
 * Protocol (all JSON text frames):
 *   Server -> Client:
 *     {"t":"o","d":"..."} — terminal output
 *     {"t":"c"}           — clear terminal
 *     {"t":"r"}           — needs refresh (reload buffer)
 *     {"t":"ia","seq":N}  — input ACK (echoes the seq of an applied/deduped input frame)
 *     {"t":"zc","c":N,"r":N} — resize confirm: the geometry the PTY now holds, which
 *                          is NOT always the one requested (see Session.resize
 *                          arbitration). Clients adopt it — issue #464.
 *   Client -> Server:
 *     {"t":"i","d":"...","seq":N,"cid":"..."} — input (keystroke or paste). seq+cid are
 *                          optional reliable-delivery tags: the server applies each
 *                          (cid,seq) at-most-once and ACKs with {"t":"ia","seq":N}.
 *     {"t":"z","c":N,"r":N,"f":bool} — resize terminal (f=true forces SIGWINCH even if dims unchanged)
 */

import { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import type { SessionPort } from '../ports/session-port.js';
import { MAX_INPUT_LENGTH } from '../../config/terminal-limits.js';
import { isAllowedRequestHost, isAllowedRequestOrigin, type HostPolicy } from '../network-auth-policy.js';
import { WsConnectionRegistry } from '../ws-connection-registry.js';
import { canAccessOwned, getAuthUser } from '../route-helpers.js';

/** Micro-batch interval for terminal output (ms). Short enough for low latency,
 *  long enough to group Ink's rapid cursor-up redraw sequences into single frames. */
const WS_BATCH_INTERVAL_MS = 8;

/** Flush immediately when batch exceeds this size (bytes) for responsiveness. */
const WS_BATCH_FLUSH_THRESHOLD = 16384;

/** How often to ping each WebSocket client (ms). Detects stale connections that
 *  TCP keepalive won't catch for minutes, especially through tunnels/proxies. */
const WS_PING_INTERVAL_MS = 30_000;

/** If pong isn't received within this window after a ping, terminate the socket. */
const WS_PONG_TIMEOUT_MS = 10_000;

/** DEC 2026 synchronized update markers. Wrapping output in these tells xterm.js
 *  to buffer all content and render atomically in a single frame — eliminates
 *  flicker from cursor-up redraws that Ink sends without its own sync markers
 *  (DA capability negotiation fails through the PTY→server→WS proxy chain). */
const DEC_2026_START = '\x1b[?2026h';
const DEC_2026_END = '\x1b[?2026l';

/** Max concurrent WS connections per session. Prevents listener/bandwidth multiplication. */
const MAX_WS_PER_SESSION = 5;

/**
 * Track live WS connections per session, keyed by clientId (COD-137).
 * Replaces a bare counter that over-counted across the async-close gap on
 * reconnect (spurious 4008). A same-`cid` reconnect supersedes its own socket
 * (reclaims the slot) instead of consuming a new one; cid-less upgrades are
 * admitted anonymously up to the cap. See ws-connection-registry.ts.
 */
const sessionWsRegistry = new WsConnectionRegistry<WebSocket>(MAX_WS_PER_SESSION);

export function registerWsRoutes(app: FastifyInstance, ctx: SessionPort, getHostPolicy: () => HostPolicy): void {
  app.get<{ Params: { id: string }; Querystring: { cid?: string } }>(
    '/ws/sessions/:id/terminal',
    { websocket: true },
    (socket: WebSocket, req) => {
      // Reject cross-site WebSocket hijacking (CSWSH) and DNS-rebinding before doing
      // anything: the upgrade must come from an allowed Host and (when the browser
      // sends one — it always does for WS) a same-site Origin. Writing to this socket
      // injects keystrokes into a --dangerously-skip-permissions agent, so this gate
      // matters even on the default no-password install. See security review H5.
      const policy = getHostPolicy();
      if (!isAllowedRequestHost(req.headers.host, policy) || !isAllowedRequestOrigin(req.headers.origin, policy)) {
        socket.close(4003, 'Forbidden');
        return;
      }

      const { id } = req.params;
      const session = ctx.sessions.get(id);

      if (!session) {
        socket.close(4004, 'Session not found');
        return;
      }

      // Multi-user owner gate: writing to this socket injects keystrokes into the
      // agent, so a non-admin may only attach to their OWN session. The global auth
      // hook already ran on the upgrade request and decorated req.authUser (an
      // unauthenticated upgrade never reaches here — the hook 401s the handshake).
      // findSessionOrFail throws an HTTP-shaped error, so the check is inlined here
      // as a 4003 close. No-op in single-user mode (canAccessOwned returns true).
      if (!canAccessOwned(getAuthUser(req), session.owner)) {
        socket.close(4003, 'Forbidden');
        return;
      }

      // Structured transport logging — surfaces WS open/close/timeout churn so the
      // tunnel-flap behavior (COD-134) is observable in the server logs. Fastify is
      // configured logger:false, so we log via console (→ journald under systemd).

      // Enforce per-session connection limit, scoped by clientId. A same-cid
      // reconnect reclaims its own slot (registry evicts the stale socket), so a
      // drop+reconnect burst can no longer over-count across the async-close gap
      // and trip a spurious 4008. cid-less upgrades are admitted anonymously.
      const cid = typeof req.query?.cid === 'string' && req.query.cid.length > 0 ? req.query.cid : null;
      const { admitted, evictedSocket } = sessionWsRegistry.register(id, cid, socket);
      if (!admitted) {
        console.warn('[ws] terminal rejected: too many connections', {
          sessionId: id,
          wsCount: sessionWsRegistry.liveCount(id),
        });
        socket.close(4008, 'Too many connections');
        return;
      }
      if (evictedSocket) {
        // Same client reconnected; retire the stale socket so it doesn't linger.
        console.info('[ws] terminal superseded by reconnect', { sessionId: id });
        try {
          evictedSocket.close(4010, 'Superseded by reconnect');
        } catch {
          /* socket may already be closing */
        }
      }
      console.info('[ws] terminal open', { sessionId: id, wsCount: sessionWsRegistry.liveCount(id) });

      // Eagerly free the slot on error/terminate — don't wait for the async
      // 'close' (idempotent with the 'close' handler below). This is what kills
      // the reconnect over-count: the slot is released the instant the socket dies.
      socket.on('error', () => {
        sessionWsRegistry.unregister(id, socket);
      });

      // Per-connection micro-batch state
      let batchChunks: string[] = [];
      let batchSize = 0;
      let batchTimer: ReturnType<typeof setTimeout> | null = null;

      const flushBatch = () => {
        batchTimer = null;
        if (batchChunks.length === 0 || socket.readyState !== 1) {
          batchChunks = [];
          batchSize = 0;
          return;
        }
        const data = batchChunks.join('');
        batchChunks = [];
        batchSize = 0;
        socket.send(`{"t":"o","d":${JSON.stringify(DEC_2026_START + data + DEC_2026_END)}}`);
      };

      // Per-connection desktop sizing claim — registered on the first
      // desktop-typed resize and released on socket close, so Session.resize()
      // can ignore small-viewport resizes only while a desktop is actually
      // connected (see Session._desktopSizeClaims).
      const sizingToken = Symbol('ws-desktop-sizing');
      let holdsDesktopClaim = false;

      // Attach message handler synchronously BEFORE any async work
      // (@fastify/websocket requirement to avoid dropped messages).
      socket.on('message', (raw) => {
        try {
          const msg = JSON.parse(String(raw));
          if (msg.t === 'i' && typeof msg.d === 'string') {
            if (msg.d.length > MAX_INPUT_LENGTH) {
              // Refused for good, so say so: a silent return left the frame
              // unACKed and the client redelivered it every few seconds forever
              // (issue #484). A client that predates `err` reads this as a plain
              // ACK and drops the frame, which is also the right outcome.
              if (Number.isInteger(msg.seq) && socket.readyState === 1) {
                socket.send(`{"t":"ia","seq":${msg.seq as number},"err":"too_large","max":${MAX_INPUT_LENGTH}}`);
              }
              return;
            }
            // Reliable delivery: when the frame carries a clientId + seq, apply it
            // exactly once (skip a duplicate redelivery) but ACK it regardless so
            // the client can drop it from its durable queue. Frames without seq
            // (legacy/other tools) are applied as-is — no behavior change.
            const cid = typeof msg.cid === 'string' ? msg.cid : null;
            const seq = Number.isInteger(msg.seq) ? (msg.seq as number) : null;
            const apply = cid && seq !== null ? session.shouldApplyInput(cid, seq) : true;
            let delivered = true;
            if (apply) {
              // Typed input from a claim-holding desktop keeps the claim "hot"
              // and re-asserts the desktop layout after a mobile override.
              if (holdsDesktopClaim) session.noteDesktopActivity();
              // Browser keystrokes are the user's own, so they may name the tab.
              delivered = session.write(msg.d, { fromUser: true });
              // A session whose PTY is gone swallows the write. ACKing anyway told
              // the client to drop the frame from its durable queue and left the seq
              // burnt, so the retry that reliable delivery exists for was rejected as
              // a duplicate: the input was lost for good.
              if (!delivered && cid && seq !== null) session.forgetInputSeq(cid, seq);
            }
            if (seq !== null && socket.readyState === 1) {
              if (apply) {
                if (delivered) socket.send(`{"t":"ia","seq":${seq}}`);
              } else {
                // REJECTED as a duplicate. ACK it — the client must still drop it
                // from its durable queue — but say so, and hand back our watermark.
                //
                // A plain ACK here is indistinguishable from "applied", which is
                // what made a client with a rolled-back counter unrecoverable: its
                // seqs persist to localStorage on a DEBOUNCED write, so a tab killed
                // between a send and that write comes back with a counter BELOW this
                // watermark, every later keystroke lands at or under it, and each one
                // is dropped-but-ACKed. The UI stays clean, nothing is delivered, and
                // a reload restores the same stale counter. `last` is what lets the
                // client lift itself out.
                // ⚠️ Defensive: the session arrives through a structural port, and an
                // implementation without this method must not take the whole input
                // path down with it — a throw here aborts the message handler and the
                // frame is never ACKed at all, which strands it in the client's queue.
                const watermark =
                  typeof (session as { lastInputSeq?: (c: string) => number }).lastInputSeq === 'function'
                    ? (session as { lastInputSeq: (c: string) => number }).lastInputSeq(cid as string)
                    : seq;
                socket.send(`{"t":"ia","seq":${seq},"dup":true,"last":${watermark}}`);
              }
            }
          } else if (
            msg.t === 'z' &&
            Number.isInteger(msg.c) &&
            Number.isInteger(msg.r) &&
            msg.c >= 1 &&
            msg.c <= 500 &&
            msg.r >= 1 &&
            msg.r <= 200
          ) {
            const viewportType = msg.v === 'mobile' || msg.v === 'tablet' || msg.v === 'desktop' ? msg.v : undefined;
            if (viewportType === 'desktop') {
              session.claimDesktopSizing(sizingToken);
              holdsDesktopClaim = true;
            } else if (viewportType) {
              // The connection's viewport can change (e.g. browser window
              // narrowed past the tablet breakpoint) — drop a stale claim.
              session.releaseDesktopSizing(sizingToken);
              holdsDesktopClaim = false;
            }
            const force = msg.f === true;
            session.resize(msg.c, msg.r, { viewportType, force });
            // Report the geometry that actually took. Resize used to be
            // write-only, so a client whose request was declined by the
            // arbitration above — or floored, or overridden by another device
            // — had no way to find out, and went on rendering a CLI's repaints
            // against a screen shape that did not exist (issue #464). Sent
            // unconditionally: it is ~30 bytes on a debounced, rare message,
            // and always-send means the client needs no "did it take?" state.
            // A session with no pane sends nothing at all: its `_ptyCols`/
            // `_ptyRows` are constructor defaults no process was ever told.
            const applied = session.ptyGeometry;
            if (applied && socket.readyState === 1) {
              socket.send(`{"t":"zc","c":${applied.cols},"r":${applied.rows}}`);
            }
          }
        } catch {
          // Ignore malformed messages
        }
      });

      // Terminal output -> micro-batched WS send
      const onTerminal = (data: string) => {
        if (socket.readyState !== 1) return;
        batchChunks.push(data);
        batchSize += data.length;

        // Flush immediately for large batches (responsiveness during bulk output)
        if (batchSize > WS_BATCH_FLUSH_THRESHOLD) {
          if (batchTimer) {
            clearTimeout(batchTimer);
          }
          flushBatch();
          return;
        }

        // Start timer if not already running
        if (!batchTimer) {
          batchTimer = setTimeout(flushBatch, WS_BATCH_INTERVAL_MS);
        }
      };

      const onClearTerminal = () => {
        if (socket.readyState === 1) {
          socket.send('{"t":"c"}');
        }
      };

      const onNeedsRefresh = () => {
        if (socket.readyState === 1) {
          socket.send('{"t":"r"}');
        }
      };

      // Close WS when session exits (deleted, respawned, or crashed) — prevents
      // orphaned listeners and stale writes to a dead PTY.
      const onSessionExit = () => {
        socket.close(4009, 'Session terminated');
      };

      session.on('terminal', onTerminal);
      session.on('clearTerminal', onClearTerminal);
      session.on('needsRefresh', onNeedsRefresh);
      session.on('exit', onSessionExit);

      // Heartbeat: detect stale connections (especially through tunnels where
      // TCP RST can take minutes to propagate).
      let pongTimeout: ReturnType<typeof setTimeout> | null = null;

      socket.on('pong', () => {
        if (pongTimeout) {
          clearTimeout(pongTimeout);
          pongTimeout = null;
        }
      });

      const pingInterval = setInterval(() => {
        if (socket.readyState !== 1) return;
        socket.ping();
        pongTimeout = setTimeout(() => {
          console.warn('[ws] terminal ping timeout — terminating', { sessionId: id });
          // Free the slot eagerly — terminate()'s 'close' may lag, and a client
          // reconnecting after a stale-connection drop must not be over-counted.
          sessionWsRegistry.unregister(id, socket);
          socket.terminate();
        }, WS_PONG_TIMEOUT_MS);
      }, WS_PING_INTERVAL_MS);

      socket.on('close', (code: number, reason: Buffer) => {
        clearInterval(pingInterval);
        if (pongTimeout) clearTimeout(pongTimeout);
        if (batchTimer) clearTimeout(batchTimer);
        batchChunks = [];
        session.off('terminal', onTerminal);
        session.off('clearTerminal', onClearTerminal);
        session.off('needsRefresh', onNeedsRefresh);
        session.off('exit', onSessionExit);
        session.releaseDesktopSizing(sizingToken);

        // Release this socket's slot. Idempotent and identity-matched: if this
        // socket was already superseded (a same-cid reconnect took its slot) or
        // eagerly unregistered on terminate/error, this is a no-op and the
        // reconnected socket keeps the slot.
        sessionWsRegistry.unregister(id, socket);
        console.info('[ws] terminal close', {
          sessionId: id,
          code,
          reason: String(reason),
          wsCount: sessionWsRegistry.liveCount(id),
        });
      });
    }
  );
}
