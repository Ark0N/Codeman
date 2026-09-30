/**
 * @fileoverview Discovery contract for FOREIGN tmux sessions — the ones a human
 * started by hand (`tmux new -s work`, then `claude` or `codex` inside it), which
 * Codeman did not create and does not own.
 *
 * Codeman's own sessions live on a dedicated, instance-scoped socket
 * (`tmux -L codeman`) and are gated by `SAFE_MUX_NAME_PATTERN`. Everything here
 * is about the OTHER servers: the default socket, a colleague's `-L` socket, the
 * tmux inside a container, the tmux on an ssh host.
 *
 * Key exports:
 * - ForeignTmuxLocation, WHERE a foreign tmux server lives — the same three
 *   locations Codeman already runs sessions in (local / docker / remote).
 * - ForeignPaneProbe, one parsed row of the probe script's output.
 * - ForeignTmuxSession, one adoptable candidate as the UI sees it.
 * - ForeignDiscoveryResult, one scan of one or more locations.
 *
 * ⚠️ `location` here describes where a candidate was FOUND. Once adopted, the
 * location fact is carried by `SessionAdopt` (types/session.ts) instead. The two
 * must never stand in for each other, or an un-adopted candidate starts looking
 * like a live session.
 *
 * No I/O here. The probe/parse/classify core is `src/foreign-tmux.ts`; the three
 * transports are `src/foreign-tmux-discovery.ts`.
 */

import type { SessionMode } from './session.js';

/** Where a foreign tmux server lives. Mirrors Codeman's own three locations. */
export type ForeignTmuxLocationKind = 'local' | 'docker' | 'remote';

/**
 * A location to scan. `hostId` refers to the saved docker-host / remote-host
 * registry entry, so the transport can be rebuilt without trusting the browser.
 */
export interface ForeignTmuxLocation {
  kind: ForeignTmuxLocationKind;
  /** Registry id (`docker-hosts.json` / `remote-hosts.json`). Absent for local. */
  hostId?: string;
  /** Display label for the UI. Absent for local. */
  label?: string;
  /** Container to `docker exec` into (`kind === 'docker'`). */
  containerName?: string;
}

/** One pane row from the probe script, after parsing. */
export interface ForeignPaneProbe {
  socketPath: string;
  sessionName: string;
  windowIndex: number;
  paneId: string;
  panePid: number;
  /** tmux's own idea of the running command — `node` for both claude and codex. */
  paneCurrentCommand: string;
  paneCurrentPath: string;
  sessionAttached: boolean;
  /** tmux `session_created`, epoch SECONDS. */
  sessionCreated: number;
  windows: number;
}

/** One adoptable foreign session. */
export interface ForeignTmuxSession {
  /**
   * Stable, opaque id for the UI and the adopt request. Derived from
   * location + socket + session name, so it survives a re-scan and can be
   * matched against an already-adopted session without echoing raw paths back
   * through the browser as command inputs.
   */
  id: string;
  location: ForeignTmuxLocationKind;
  hostId?: string;
  hostLabel?: string;
  containerName?: string;
  /** Absolute socket path AS SEEN FROM THE LOCATION (not from Codeman's host). */
  socketPath: string;
  sessionName: string;
  windows: number;
  attached: boolean;
  /** Epoch MILLISECONDS (tmux reports seconds; normalized on parse). */
  createdAt: number;
  /** What the active pane is running, from the bounded process-tree walk. */
  mode: SessionMode;
  /** Truncated command line behind the classification, for the UI subtitle. */
  command: string;
  /** The active pane's cwd. Informational — an adopted pane is never `cd`'d. */
  workingDir: string;
  /** Codeman session id already wrapping this target, when one exists. */
  adoptedBy?: string;
}

/** One discovery scan. Never throws — unreachable locations become notes. */
export interface ForeignDiscoveryResult {
  sessions: ForeignTmuxSession[];
  /** Epoch ms of the scan the result came from (may be a cache hit). */
  scannedAt: number;
  /**
   * Non-fatal reasons a location produced nothing (host unreachable, no tmux,
   * engine down). Surfaced so an empty list is never silently ambiguous.
   */
  notes: string[];
}
