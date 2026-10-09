/**
 * @fileoverview In-memory attachment registry for live external document references.
 *
 * Session-local files keep using the existing workspace-scoped file routes. This
 * registry is only for explicit, live external attachments that need a stable ID
 * so browser requests never contain arbitrary absolute paths.
 */

import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import fs from 'node:fs/promises';
import { basename, extname, isAbsolute } from 'node:path';
import { isBlockedAttachmentPath, isUnderTree, loadAttachmentGuardConfig } from './config/attachment-guard.js';
import { EDITABLE_EXTENSIONS } from './config/file-editing.js';
import { validateSessionFilePath } from './web/route-helpers.js';
import { remoteProbePaths, RemoteFileAccessError, type RemoteProbe } from './remote-files.js';
import type { AttachmentDetectedEvent, AttachmentDetectedType } from './types.js';
import type { SessionRemote } from './types/session.js';

/**
 * Playable media extensions, single-sourced here because the WORKSPACE preview
 * (`file-content`'s media classification) and the out-of-workspace attachment
 * path must agree on what plays. They diverged once: a video an agent wrote
 * inside the workspace played with a working scrub bar, while the same file in
 * `/tmp` was refused as an unsupported type, which reads as a bug rather than a
 * boundary. Serving is range-aware in both, which is what makes seeking work.
 */
export const VIDEO_ATTACHMENT_EXTENSIONS: ReadonlySet<string> = new Set(['mp4', 'webm', 'mov', 'm4v', 'ogv']);
export const AUDIO_ATTACHMENT_EXTENSIONS: ReadonlySet<string> = new Set([
  'mp3',
  'wav',
  'ogg',
  'oga',
  'm4a',
  'aac',
  'flac',
  'opus',
]);

/**
 * Plain-text extensions, REUSING the File Viewer's edit-mode allowlist rather
 * than curating a second list that would drift from it. The rule reads: if the
 * viewer would open that file for editing inside the workspace, the same file
 * outside it can be read here. `svg` and `env` are absent from that list by
 * design and stay absent here.
 *
 * Why widen at all: the agent in the session can already `cat` any of these,
 * and every path-shaped surface (the picker, the workspace viewer) can already
 * show them. Refusing a `.log` an agent just wrote to `/tmp` bought no
 * confidentiality, it only made the click fail. The confidentiality gate is the
 * path guard that still runs on every registration (sensitive-file blocklist,
 * `/root` and `/etc` trees, realpath before the check), not the file's suffix.
 */
export const TEXT_ATTACHMENT_EXTENSIONS: ReadonlySet<string> = EDITABLE_EXTENSIONS;

/**
 * Document types an attachment card previews. Also the list `codeman attach`'s
 * error text names, so the help cannot drift from what is accepted. `xlsx` is
 * previewed client-side (spreadsheet-preview-worker.js) and served raw like the rest.
 */
export const DOCUMENT_ATTACHMENT_EXTENSIONS: readonly string[] = Object.freeze(['pdf', 'docx', 'pptx', 'xlsx']);

const SUPPORTED_ATTACHMENT_EXTENSIONS = new Set([
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  ...DOCUMENT_ATTACHMENT_EXTENSIONS,
  'md',
  'txt',
  ...VIDEO_ATTACHMENT_EXTENSIONS,
  ...AUDIO_ATTACHMENT_EXTENSIONS,
  ...TEXT_ATTACHMENT_EXTENSIONS,
]);

export type AttachmentSource = 'detected' | 'external';

export interface AttachmentRecord {
  attachmentId: string;
  sessionId: string;
  filePath: string;
  fileName: string;
  extension: string;
  attachmentType: AttachmentDetectedType;
  size: number;
  mtimeMs: number;
  timestamp: number;
  source: AttachmentSource;
}

export interface AttachmentRegistrationResult extends AttachmentDetectedEvent {
  attachmentId: string;
  source: AttachmentSource;
  rawUrl: string;
  previewUrl: string;
  thumbnailUrl: string;
}

export class AttachmentRegistrationError extends Error {
  constructor(
    message: string,
    readonly statusCode: number = 400
  ) {
    super(message);
  }
}

/** Per-session attachment cap. Bounds memory against a client (or a
 *  prompt-injected magic-link flood) registering unbounded distinct paths. */
const MAX_ATTACHMENTS_PER_SESSION = 200;

class AttachmentRegistry {
  private recordsBySession = new Map<string, Map<string, AttachmentRecord>>();

  register(record: AttachmentRecord): void {
    let records = this.recordsBySession.get(record.sessionId);
    if (!records) {
      records = new Map();
      this.recordsBySession.set(record.sessionId, records);
    }
    records.set(record.attachmentId, record);
    // Evict oldest (insertion-order) entries beyond the cap.
    while (records.size > MAX_ATTACHMENTS_PER_SESSION) {
      const oldest = records.keys().next().value;
      if (oldest === undefined) break;
      records.delete(oldest);
    }
  }

  get(sessionId: string, attachmentId: string): AttachmentRecord | undefined {
    return this.recordsBySession.get(sessionId)?.get(attachmentId);
  }

  findByFilePath(sessionId: string, filePath: string): AttachmentRecord | undefined {
    const records = this.recordsBySession.get(sessionId);
    if (!records) return undefined;
    for (const record of records.values()) {
      if (record.filePath === filePath) return record;
    }
    return undefined;
  }

  clearSession(sessionId: string): void {
    this.recordsBySession.delete(sessionId);
  }
}

export const attachmentRegistry = new AttachmentRegistry();

export function isSupportedAttachmentExtension(extension: string): boolean {
  return SUPPORTED_ATTACHMENT_EXTENSIONS.has(extension.toLowerCase().replace(/^\./, ''));
}

export function getAttachmentType(extension: string): AttachmentDetectedType {
  const normalized = extension.toLowerCase().replace(/^\./, '');
  if (['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(normalized)) return 'image';
  if (VIDEO_ATTACHMENT_EXTENSIONS.has(normalized)) return 'video';
  if (AUDIO_ATTACHMENT_EXTENSIONS.has(normalized)) return 'audio';
  if (normalized === 'pdf') return 'pdf';
  if (normalized === 'pptx') return 'presentation';
  if (normalized === 'xlsx') return 'spreadsheet';
  if (normalized === 'md') return 'markdown';
  // Everything else in the text family reads as text, including code and
  // config: the card and the preview both treat it as a plain-text file.
  if (normalized === 'txt' || TEXT_ATTACHMENT_EXTENSIONS.has(normalized)) return 'text';
  return 'document';
}

export function buildAttachmentRoutes(
  sessionId: string,
  attachmentId: string
): {
  rawUrl: string;
  previewUrl: string;
  thumbnailUrl: string;
} {
  const encodedId = encodeURIComponent(attachmentId);
  return {
    rawUrl: `/api/sessions/${sessionId}/attachments/${encodedId}/raw`,
    previewUrl: `/api/sessions/${sessionId}/attachments/${encodedId}/preview`,
    thumbnailUrl: `/api/sessions/${sessionId}/attachments/${encodedId}/thumbnail`,
  };
}

export function buildFileThumbnailRoute(sessionId: string, relativePath: string): string {
  return `/api/sessions/${sessionId}/file-thumbnail?path=${encodeURIComponent(relativePath)}`;
}

export function attachmentRecordToEvent(record: AttachmentRecord): AttachmentRegistrationResult {
  const routes = buildAttachmentRoutes(record.sessionId, record.attachmentId);
  return {
    sessionId: record.sessionId,
    filePath: record.fileName,
    relativePath: '',
    fileName: record.fileName,
    extension: record.extension,
    attachmentType: record.attachmentType,
    timestamp: record.timestamp,
    size: record.size,
    attachmentId: record.attachmentId,
    source: record.source,
    ...routes,
  };
}

/** Options for {@link registerExternalAttachment}. */
export interface RegisterExternalAttachmentOptions {
  /**
   * The registering session's working directory. Required to enforce workspace
   * confinement — either when the global mode is enabled
   * (`attachmentConfineToWorkspace` / `CODEMAN_ATTACHMENT_CONFINE`) or when
   * {@link forceWorkspaceConfinement} is set for this call.
   */
  sessionWorkingDir?: string;
  /**
   * Force workspace confinement for THIS registration regardless of the global
   * setting. Used by the terminal-output `codeman://attach` magic-link scanner:
   * terminal output is attacker-influenceable (a prompt-injected session can
   * print an arbitrary path), so passive magic links may only reference files
   * inside the session workspace. Deliberate cross-workspace attachment still
   * works through the explicit, Origin-guarded `POST /attachments` route and the
   * `codeman attach` CLI (which POSTs directly when a session id is known).
   */
  forceWorkspaceConfinement?: boolean;
  /**
   * Remote (SSH) case: the path exists on the REMOTE host, so it is resolved and
   * stat'ed there (`remoteProbePaths`) instead of with local `realpathSync`/`fs.stat`,
   * which cannot see it at all (#415). A file outside the case directory is
   * unreachable exactly like a file inside it.
   *
   * `sessionWorkingDir` must then be the REMOTE path too, and the workspace
   * confinement check (when active) compares against the remotely canonicalized root,
   * so a symlinked `remotePath` does not refuse every registration.
   */
  remote?: SessionRemote;
  /**
   * Remote only: `[file, workspaceRoot]` probes a caller already resolved in a BATCHED
   * `remoteProbePaths` call (the attachment-history list does one round trip for the
   * whole history). Skips this registration's own ssh probe; every guard below still
   * runs on the same resolved path it would have produced itself.
   */
  remoteProbes?: readonly [RemoteProbe | null, RemoteProbe | null];
}

/**
 * A path an attachment request resolved to, on whichever host it lives — the local
 * filesystem or the remote host of a remote-SSH case. The rest of
 * {@link registerExternalAttachment} (guards, extension allowlist, registry) is then
 * host-agnostic: it only ever sees canonical absolute paths and numbers.
 */
interface ResolvedAttachmentFile {
  resolvedPath: string;
  size: number;
  mtimeMs: number;
  isFile: boolean;
  extension: string;
  /** Remote only: the workspace root, with symlinks resolved on the remote host. */
  workspaceRoot?: string;
}

/** `extension` the way the attachment registry defines it (no dot, lowercased). */
function attachmentExtensionOf(path: string): string {
  return extname(path).toLowerCase().replace(/^\./, '');
}

/** Local resolution: the historical realpath + stat. */
async function resolveLocalAttachment(requestedPath: string): Promise<ResolvedAttachmentFile> {
  let resolvedPath: string;
  try {
    resolvedPath = realpathSync(requestedPath);
  } catch {
    throw new AttachmentRegistrationError('Attachment file not found', 404);
  }
  const stat = await fs.stat(resolvedPath);
  return {
    resolvedPath,
    size: stat.size,
    mtimeMs: stat.mtimeMs ?? 0,
    isFile: typeof stat.isFile === 'function' ? stat.isFile() : true,
    extension: attachmentExtensionOf(resolvedPath),
  };
}

/**
 * Remote resolution for a remote-SSH case: ONE ssh round trip returns the
 * symlink-resolved path, the size/mtime and the kind, for the file AND (when a
 * workspace is known) its root, which the confinement check compares against.
 */
async function resolveRemoteAttachment(
  requestedPath: string,
  remote: SessionRemote,
  sessionWorkingDir?: string,
  preResolved?: readonly [RemoteProbe | null, RemoteProbe | null]
): Promise<ResolvedAttachmentFile> {
  const paths = sessionWorkingDir ? [requestedPath, sessionWorkingDir] : [requestedPath];
  let probes: ReadonlyArray<RemoteProbe | null>;
  if (preResolved) {
    probes = preResolved;
  } else {
    try {
      probes = await remoteProbePaths(remote, paths);
    } catch (err) {
      // 502 marks the TRANSPORT as the failure, distinct from the file's own 404/403,
      // so a history listing can report the entry as unknown rather than missing.
      throw new AttachmentRegistrationError(
        err instanceof RemoteFileAccessError ? err.message : 'remote host unreachable',
        502
      );
    }
  }

  const [probe, rootProbe] = probes;
  if (!probe) {
    throw new AttachmentRegistrationError('Attachment file not found', 404);
  }

  return {
    resolvedPath: probe.realPath,
    size: probe.size,
    mtimeMs: probe.mtimeMs,
    isFile: probe.kind === 'file',
    extension: attachmentExtensionOf(probe.realPath),
    workspaceRoot: rootProbe?.realPath,
  };
}

export async function registerExternalAttachment(
  sessionId: string,
  requestedPath: string,
  options: RegisterExternalAttachmentOptions = {}
): Promise<AttachmentRegistrationResult> {
  if (!requestedPath || !isAbsolute(requestedPath)) {
    throw new AttachmentRegistrationError('Attachment path must be an absolute local path');
  }

  const resolved = await (options.remote
    ? resolveRemoteAttachment(requestedPath, options.remote, options.sessionWorkingDir, options.remoteProbes)
    : resolveLocalAttachment(requestedPath));

  // COD-53: enforce the active attachment-guard policy on the symlink-resolved
  // path before doing anything else.
  const guard = await loadAttachmentGuardConfig();

  if (guard.confineToWorkspace || options.forceWorkspaceConfinement) {
    // Workspace-confined: the file MUST resolve inside the session's workspace.
    // Applies when the global strict mode is on (opt-in, default OFF) OR when
    // the caller forces it for this registration (the magic-link scanner — see
    // forceWorkspaceConfinement). Strictly more restrictive than the blocklist.
    const workingDir = options.sessionWorkingDir;
    const confined = options.remote
      ? !!workingDir && isUnderTree(resolved.resolvedPath, resolved.workspaceRoot ?? workingDir)
      : !!workingDir && !!validateSessionFilePath(workingDir, resolved.resolvedPath);
    if (!confined) {
      throw new AttachmentRegistrationError('Access to this file is blocked', 403);
    }
  }

  // Blocklist (DEFAULT, also applied alongside confinement as defense in
  // depth): pre-populated secret locations + the /root and /etc trees + any
  // operator-configured extra trees. Symlinks are already resolved above.
  // Cross-workspace attachment of non-blocked files stays allowed, so
  // codeman-publish and the ~/.codeman review loop keep working.
  //
  // The list is a pattern list over ABSOLUTE paths, so it is host-agnostic and holds
  // for a remote path exactly as it does for a local one, with ONE exception worth
  // knowing: `isSensitivePath`'s three home-anchored members (`~/.claude.json`,
  // `~/.claude/settings.json`, `~/.claude/settings.local.json`) resolve against THIS
  // host's `homedir()`, so on a remote host with a different home they do not match.
  // Everything else in that list is depth-anchored (`/.ssh/`, `/.aws/credentials`,
  // `/.claude/.credentials.json`, ...) and applies unchanged.
  if (isBlockedAttachmentPath(resolved.resolvedPath, guard.blockedTrees)) {
    throw new AttachmentRegistrationError('Access to this file is blocked', 403);
  }

  const resolvedPath = resolved.resolvedPath;
  const extension = resolved.extension;
  if (!isSupportedAttachmentExtension(extension)) {
    throw new AttachmentRegistrationError('Unsupported attachment type');
  }

  if (!resolved.isFile) {
    throw new AttachmentRegistrationError('Attachment path is not a file');
  }

  const stat = { size: resolved.size, mtimeMs: resolved.mtimeMs };

  const existing = attachmentRegistry.findByFilePath(sessionId, resolvedPath);
  if (existing) {
    existing.size = stat.size;
    existing.mtimeMs = stat.mtimeMs ?? 0;
    existing.timestamp = Date.now();
    return attachmentRecordToEvent(existing);
  }

  const record: AttachmentRecord = {
    attachmentId: `att_${randomUUID()}`,
    sessionId,
    filePath: resolvedPath,
    fileName: basename(resolvedPath),
    extension,
    attachmentType: getAttachmentType(extension),
    size: stat.size,
    mtimeMs: stat.mtimeMs ?? 0,
    timestamp: Date.now(),
    source: 'external',
  };
  attachmentRegistry.register(record);
  return attachmentRecordToEvent(record);
}
