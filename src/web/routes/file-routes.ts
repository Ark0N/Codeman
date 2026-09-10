/**
 * @fileoverview File browser and streaming routes.
 * Provides directory listing, file content preview, raw file serving, tail
 * streaming, and the File Viewer edit-mode write path (edit=1 read +
 * PUT /api/sessions/:id/file-content; policy in src/config/file-editing.ts,
 * design in docs/file-viewer-edit-plan.md).
 */

import { FastifyInstance, type FastifyReply } from 'fastify';
import { basename as pathBasename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createReadStream, realpathSync, type ReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import type {
  ApiResponse,
  FilesystemBrowseData,
  FilesystemBrowseEntry,
  FilesystemBrowseRoot,
  FilesystemPreviewKind,
  FileWriteData,
} from '../../types.js';
import { ApiErrorCode, createErrorResponse, getErrorMessage } from '../../types.js';
import { compileFileQuery } from '../../utils/file-query.js';
import { fileStreamManager } from '../../file-stream-manager.js';
import {
  AUDIO_ATTACHMENT_EXTENSIONS,
  AttachmentRegistrationError,
  attachmentRecordToEvent,
  attachmentRegistry,
  buildFileThumbnailRoute,
  isSupportedAttachmentExtension,
  registerExternalAttachment,
  TEXT_ATTACHMENT_EXTENSIONS,
  VIDEO_ATTACHMENT_EXTENSIONS,
  type AttachmentRecord,
} from '../../attachment-registry.js';
import { generateFirstPageThumbnail } from '../../document-thumbnailer.js';
import { getOfficePreviewPdfPath, getPreviewPdfDownloadName } from '../../document-preview-cache.js';
import { sanitizeAttachmentHistoryItem } from '../../session-attachment-history.js';
import { isBlockedAttachmentPath, isUnderTree, loadAttachmentGuardConfig } from '../../config/attachment-guard.js';
import { isMultiUserMode, userSpacePath } from '../../config/multiuser.js';
import {
  CASES_DIR,
  canAccessOwned,
  findSessionOrFail,
  getAuthUser,
  parseBody,
  validateSessionFilePath,
} from '../route-helpers.js';
import type { FastifyRequest } from 'fastify';
import type { SessionAttachmentHistoryItem, SessionState } from '../../types/session.js';
import { downloadTooLargeMessage, exceedsDownloadLimit } from '../../config/buffer-limits.js';
import { parseByteRange } from '../http-range.js';
import { isSensitivePath } from '../sensitive-path.js';
import { SseEvent } from '../sse-events.js';
import type { ConfigPort, EventPort, SessionPort } from '../ports/index.js';
import { FilesystemBrowseQuerySchema, FilesystemPreviewQuerySchema, FileWriteSchema } from '../schemas.js';
import {
  MAX_EDITABLE_BYTES,
  applyEol,
  detectEol,
  isDeniedEditRelativePath,
  isEditableFileName,
} from '../../config/file-editing.js';

const MIME_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  ico: 'image/x-icon',
  bmp: 'image/bmp',
  // Media needs a real type, not the octet-stream fallback: a <video>/<audio>
  // element refuses to decode an unknown type, so a missing entry here presents
  // as a player that renders and then does nothing.
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  m4v: 'video/x-m4v',
  ogv: 'video/ogg',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  flac: 'audio/flac',
  opus: 'audio/opus',
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  json: 'application/json',
  md: 'text/markdown',
  txt: 'text/plain',
};

function buildContentDisposition(disposition: 'inline' | 'attachment', fileName: string): string {
  const cleaned = fileName.replace(/["\\\r\n]/g, '_');
  const fallback = cleaned.replace(/[^\x20-\x7e]/g, '_') || 'file';
  const encoded = encodeURIComponent(cleaned).replace(
    /['()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`
  );
  return `${disposition}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

function sendRawStream(reply: FastifyReply, content: ReadStream): void {
  const headers = reply.getHeaders();
  // hijack() answers on reply.raw, which keeps Fastify's own status handling out
  // of the picture — so a 206 set with reply.code() has to be carried across by
  // hand or a partial body would go out labelled 200 and the browser would treat
  // it as the whole file.
  const statusCode = reply.statusCode;
  reply.hijack();
  reply.raw.statusCode = statusCode;

  for (const [name, value] of Object.entries(headers)) {
    if (value !== undefined) {
      reply.raw.setHeader(name, value);
    }
  }

  content.on('error', (err) => {
    if (reply.raw.headersSent) {
      reply.raw.destroy(err);
      return;
    }

    reply.raw.statusCode = 500;
    reply.raw.end('Failed to read file');
  });
  content.pipe(reply.raw);
}

/**
 * Stream a file body, honoring a `Range` request header.
 *
 * Callers set Content-Type/Content-Disposition first; this adds the
 * range-related headers and the body. Range support is what makes the file
 * viewer's `<video>`/`<audio>` seekable: with a plain 200 and no
 * `Accept-Ranges`, Chrome reports `video.seekable` as `[0, 0]`, the scrub bar
 * does nothing and `currentTime = x` is silently reverted (measured against an
 * 18MB mp4 before this existed). It also stops each seek from re-reading the
 * whole file into memory.
 */
function sendFileBody(
  reply: FastifyReply,
  resolvedPath: string,
  size: number,
  rangeHeader: string | string[] | undefined
): void {
  reply.header('Accept-Ranges', 'bytes');
  const range = parseByteRange(rangeHeader, size);

  if (range.kind === 'unsatisfiable') {
    reply
      .code(416)
      .header('Content-Range', `bytes */${size}`)
      .type('application/json; charset=utf-8')
      .send(createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Requested range not satisfiable'));
    return;
  }

  if (range.kind === 'partial') {
    reply.code(206);
    reply.header('Content-Range', `bytes ${range.start}-${range.end}/${size}`);
    reply.header('Content-Length', range.end - range.start + 1);
    sendRawStream(reply, createReadStream(resolvedPath, { start: range.start, end: range.end }));
    return;
  }

  reply.header('Content-Length', size);
  sendRawStream(reply, createReadStream(resolvedPath));
}

async function serveRawFile(
  reply: FastifyReply,
  resolvedPath: string,
  fileName: string,
  extension: string,
  download?: boolean,
  rangeHeader?: string | string[]
): Promise<void> {
  const stat = await fs.stat(resolvedPath);
  if (exceedsDownloadLimit(stat.size)) {
    reply.code(413).send(createErrorResponse(ApiErrorCode.INVALID_INPUT, downloadTooLargeMessage(stat.size)));
    return;
  }
  // Markup is download-only: served with a renderable type on our own origin it
  // would be stored XSS. SVG was always here; HTML/HTM join it now that the text
  // family is servable, so widening what can be READ never widened what can RUN.
  // The preview overlay reads these through `fetch()`, which ignores the
  // disposition, so a clicked .html still shows its source.
  const markupOnly = extension === 'svg' || extension === 'html' || extension === 'htm';
  if (download || markupOnly) {
    reply.header(
      'Content-Type',
      markupOnly ? 'application/octet-stream' : MIME_TYPES[extension] || 'application/octet-stream'
    );
    reply.header('Content-Disposition', buildContentDisposition('attachment', fileName));
    reply.header('X-Content-Type-Options', 'nosniff');
    sendFileBody(reply, resolvedPath, stat.size, rangeHeader);
    return;
  }

  // Plain text with no dedicated MIME entry (code, config, logs, csv, xml) goes
  // out as inert text/plain rather than the octet-stream fallback, matching what
  // the path picker already does. Never a type the browser would execute.
  if (!MIME_TYPES[extension] && TEXT_ATTACHMENT_EXTENSIONS.has(extension)) {
    reply.header('Content-Type', 'text/plain; charset=utf-8');
    reply.header('Content-Disposition', buildContentDisposition('inline', fileName));
    reply.header('X-Content-Type-Options', 'nosniff');
    sendFileBody(reply, resolvedPath, stat.size, rangeHeader);
    return;
  }

  reply.header('Content-Type', MIME_TYPES[extension] || 'application/octet-stream');
  reply.header('Content-Disposition', buildContentDisposition('inline', fileName));
  reply.header('X-Content-Type-Options', 'nosniff');
  sendFileBody(reply, resolvedPath, stat.size, rangeHeader);
}

function getAttachmentOr404(
  reply: FastifyReply,
  sessionId: string,
  attachmentId: string
): AttachmentRecord | undefined {
  const record = attachmentRegistry.get(sessionId, attachmentId);
  if (!record) {
    reply.code(404).send(createErrorResponse(ApiErrorCode.NOT_FOUND, 'Attachment not found'));
    return undefined;
  }
  return record;
}

/**
 * COD-53 defense-in-depth: refuse to stream a record whose underlying path is
 * blocked by the active attachment-guard policy, even though registration
 * already blocks them. Guards against records that predate the guard or were
 * crafted to point at a sensitive file. Resolves symlinks before the check so a
 * record pointing at a symlink that now resolves to a sensitive target is also
 * caught; if the path can't be resolved (deleted/unreadable) the check still
 * runs on the stored path. When workspace confinement is enabled it additionally
 * rejects any record outside the session workspace. Returns true (and sends a
 * 403) when blocked.
 */
async function resolveServableAttachmentPath(
  reply: FastifyReply,
  record: AttachmentRecord,
  sessionWorkingDir?: string
): Promise<string | null> {
  let pathToCheck = record.filePath;
  let resolved = false;
  try {
    pathToCheck = realpathSync(record.filePath);
    resolved = true;
  } catch {
    // Fall back to the stored (already realpath-resolved at registration) path.
  }

  const guard = await loadAttachmentGuardConfig();

  const blocked =
    isBlockedAttachmentPath(pathToCheck, guard.blockedTrees) ||
    isBlockedAttachmentPath(record.filePath, guard.blockedTrees) ||
    (guard.confineToWorkspace && (!sessionWorkingDir || !validateSessionFilePath(sessionWorkingDir, pathToCheck)));

  if (blocked) {
    reply.code(403).send(createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Access to this file is blocked'));
    return null;
  }
  // Serve the freshly-resolved path, not the stored one: if a path component
  // became a symlink after registration, the guard checked the resolved target
  // but streaming record.filePath would follow the symlink to a swapped file.
  return resolved ? pathToCheck : record.filePath;
}

/**
 * Convert a DOCX/PPTX to a single-PDF preview (LibreOffice when available) and
 * stream it inline. PDF/PNG and text formats don't need conversion — callers
 * redirect those to the raw route instead.
 */
async function serveConvertedPreview(
  reply: FastifyReply,
  resolvedPath: string,
  fileName: string,
  extension: string
): Promise<void> {
  if (extension !== 'docx' && extension !== 'pptx') {
    reply
      .code(400)
      .send(createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Preview is not supported for this file type'));
    return;
  }

  try {
    const previewPath = await getOfficePreviewPdfPath(resolvedPath, extension);
    if (!previewPath) {
      reply.code(500).send(createErrorResponse(ApiErrorCode.OPERATION_FAILED, 'Document preview conversion failed'));
      return;
    }

    const content = await fs.readFile(previewPath);
    reply.header('Content-Type', 'application/pdf');
    reply.header(
      'Content-Disposition',
      buildContentDisposition('inline', getPreviewPdfDownloadName(fileName, extension))
    );
    reply.header('Cache-Control', 'no-cache');
    reply.header('Content-Length', content.length);
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.send(content);
  } catch (err) {
    reply
      .code(500)
      .send(createErrorResponse(ApiErrorCode.OPERATION_FAILED, `Failed to generate preview: ${getErrorMessage(err)}`));
  }
}

/** Generate and stream a first-page thumbnail (PNG) for a supported attachment. */
async function serveThumbnail(reply: FastifyReply, resolvedPath: string, extension: string): Promise<void> {
  const thumbnail = await generateFirstPageThumbnail(resolvedPath, extension);
  if (!thumbnail) {
    reply.code(204).send();
    return;
  }

  reply.header('Content-Type', thumbnail.contentType);
  reply.header('Cache-Control', 'no-cache');
  reply.header('X-Content-Type-Options', 'nosniff');
  reply.send(thumbnail.content);
}

/**
 * Resolve a session's working dir from the live session, falling back to the
 * persisted record so preview/thumbnail requests keep working for a session
 * that has since detached. Sends a 404 and returns undefined when unknown.
 */
function getKnownSessionWorkingDir(
  ctx: SessionPort & ConfigPort,
  sessionId: string,
  reply: FastifyReply,
  req: FastifyRequest
): string | undefined {
  // Multi-user: a non-admin may only reach their OWN session's files. A foreign
  // (or missing) session is reported identically as 404 so existence isn't leaked.
  const user = getAuthUser(req);
  const liveSession = ctx.sessions.get(sessionId);
  if (liveSession && canAccessOwned(user, liveSession.owner)) return liveSession.workingDir;

  const stored = ctx.store.getSession(sessionId);
  if (stored && canAccessOwned(user, (stored as { owner?: string }).owner)) return stored.workingDir;

  reply.code(404).send(createErrorResponse(ApiErrorCode.NOT_FOUND, `Session ${sessionId} not found`));
  return undefined;
}

// Persisted sessions carry the private (externalPath-bearing) history under a
// `__attachmentHistory` key so the list route can re-register external files.
type StoredSessionWithPrivateAttachmentHistory = SessionState & {
  __attachmentHistory?: SessionAttachmentHistoryItem[];
};

type AttachmentHistoryRouteItem = Omit<SessionAttachmentHistoryItem, 'externalPath'> & {
  missing: boolean;
  rawUrl?: string;
  url?: string;
  previewUrl?: string;
  thumbnailUrl?: string;
  downloadUrl?: string;
  attachmentId?: string;
};

const FILESYSTEM_PICKER_ENTRY_LIMIT = 500;
const FILESYSTEM_TEXT_PREVIEW_LIMIT = 2 * 1024 * 1024;
const FILESYSTEM_BINARY_PREVIEW_LIMIT = 50 * 1024 * 1024;
const FILESYSTEM_IMAGE_PREVIEW_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp']);
const FILESYSTEM_TEXT_PREVIEW_EXTENSIONS = new Set(['md', 'txt', 'json']);
const FILESYSTEM_DOCUMENT_PREVIEW_EXTENSIONS = new Set(['pdf', 'docx', 'pptx']);

function isPathWithinRoot(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
}

function findMatchingPickerRoot(roots: FilesystemBrowseRoot[], candidate: string): FilesystemBrowseRoot | undefined {
  return roots
    .filter((root) => isPathWithinRoot(root.path, candidate))
    .sort((a, b) => b.path.length - a.path.length)[0];
}

/**
 * Whether a path has a dot-prefixed segment anywhere below its browse root.
 *
 * Checked against the REALPATH, so a plainly-named symlink pointing into a
 * hidden tree is caught too. Callers skip it when the request opts into hidden
 * entries (`showHidden`), which is why the sensitive-path blocklist and the
 * blocked-tree checks must stand on their own: with the toggle on, this is no
 * longer the thing keeping `~/.config/gh/hosts.yml` out of reach.
 */
function containsHiddenPickerSegment(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel !== '' && rel.split(sep).some((segment) => segment.startsWith('.'));
}

/** Parses the picker's opt-in `showHidden` query flag (absent means off). */
function wantsHiddenPickerEntries(showHidden?: string): boolean {
  return showHidden === 'true';
}

function getFilesystemPreviewKind(fileName: string): FilesystemPreviewKind | undefined {
  const extension = extname(fileName).slice(1).toLowerCase();
  if (FILESYSTEM_IMAGE_PREVIEW_EXTENSIONS.has(extension)) return 'image';
  if (FILESYSTEM_TEXT_PREVIEW_EXTENSIONS.has(extension)) return 'text';
  if (FILESYSTEM_DOCUMENT_PREVIEW_EXTENSIONS.has(extension)) return 'document';
  return undefined;
}

/**
 * Blocked trees, minus any tree that would swallow a configured picker root
 * whole.
 *
 * `/root` is a default blocked tree, and Codeman running as root (containers,
 * plenty of servers) makes `homedir()` exactly `/root` — so the picker's own
 * allowlisted Home root was blocked by the attachment guard, every other
 * candidate lives under it or does not exist, and the endpoint answered 403
 * "No filesystem browse roots are available" with no root the user could reach.
 *
 * Dropping the tree does NOT expose secrets: `isSensitivePath` independently
 * matches `.ssh/`, `.env`, `credentials*` and friends at any depth, and it is
 * what the directory probe below asks about. Trees with no configured root
 * beneath them (`/etc`) are untouched.
 */
function pickerBlockedTrees(blockedTrees: readonly string[], roots: readonly string[]): readonly string[] {
  if (roots.length === 0) return blockedTrees;
  return blockedTrees.filter((tree) => !roots.some((root) => isUnderTree(root, tree)));
}

/** Resolve candidate roots to realpaths, dropping the ones that do not exist. */
function resolveCandidateRootPaths(candidates: ReadonlyArray<{ path: string }>): string[] {
  const out: string[] = [];
  for (const candidate of candidates) {
    if (!isAbsolute(candidate.path)) continue;
    try {
      out.push(realpathSync(candidate.path));
    } catch {
      // Optional roots (for example /mnt/d on non-WSL hosts) are omitted.
    }
  }
  return out;
}

function isBlockedPickerPath(path: string, blockedTrees: readonly string[], directory = false): boolean {
  if (isBlockedAttachmentPath(path, blockedTrees)) return true;
  // The shared sensitive-path matcher describes file locations such as
  // ~/.ssh/<key>. Probe a child path as well so the directory itself cannot be
  // opened and used to enumerate those filenames.
  return directory && isBlockedAttachmentPath(join(path, '__codeman_path_picker_probe__'), blockedTrees);
}

function extraConfiguredPickerRoots(): Array<{ label: string; path: string }> {
  const extraRoots = process.env.CODEMAN_FILE_PICKER_ROOTS;
  if (!extraRoots) return [];
  return extraRoots
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
    .map((path, index) => ({ label: `Configured ${index + 1}`, path }));
}

/**
 * Browse roots for the requesting identity.
 *
 * Single-user mode (and multi-user admins) get the host-wide set. ⚠️ A regular
 * multi-user user must NOT: per-user spaces live at `<USER_SPACES_DIR>/<name>`,
 * which is *inside* `homedir()`, so handing out a `Home` root would let any
 * authenticated user browse and preview every other user's workspace. The
 * shared `CASES_DIR` leaks the same way, and `/mnt/d` is a broad host mount
 * that a multi-user deployment should not expose by default. Operators who
 * genuinely want a shared area can still name it in `CODEMAN_FILE_PICKER_ROOTS`,
 * which stays an explicit opt-in in both modes.
 */
function configuredFilesystemPickerRoots(req: FastifyRequest): Array<{ label: string; path: string }> {
  const user = getAuthUser(req);
  if (isMultiUserMode() && user.role !== 'admin') {
    return [{ label: 'My Space', path: userSpacePath(user.username) }, ...extraConfiguredPickerRoots()];
  }
  return [
    { label: 'Home', path: homedir() },
    { label: 'Codeman Cases', path: CASES_DIR },
    { label: 'WSL D:', path: '/mnt/d' },
    ...extraConfiguredPickerRoots(),
  ];
}

async function resolveFilesystemPickerRoots(
  ctx: SessionPort & ConfigPort,
  req: FastifyRequest,
  sessionId?: string
): Promise<FilesystemBrowseRoot[]> {
  const candidates = configuredFilesystemPickerRoots(req);
  if (sessionId) {
    const session = ctx.sessions.get(sessionId) ?? ctx.store.getSession(sessionId);
    // ⚠️ Ownership must be checked here, exactly as `findSessionOrFail` does for
    // the other session-scoped handlers in this file. Without it a multi-user
    // caller could pin ANOTHER user's `workingDir` as a browse root just by
    // passing their sessionId. Report not-found rather than forbidden so the
    // endpoint does not confirm that a session id exists.
    if (!session || !canAccessOwned(getAuthUser(req), (session as { owner?: string }).owner)) {
      throw Object.assign(new Error(`Session ${sessionId} not found`), {
        statusCode: 404,
        body: createErrorResponse(ApiErrorCode.NOT_FOUND, `Session ${sessionId} not found`),
      });
    }
    candidates.unshift({ label: 'Current Folder', path: session.workingDir });
  }

  const guard = await loadAttachmentGuardConfig();
  const trees = pickerBlockedTrees(guard.blockedTrees, resolveCandidateRootPaths(candidates));
  const roots: FilesystemBrowseRoot[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (!isAbsolute(candidate.path)) continue;
    try {
      const resolved = realpathSync(candidate.path);
      if (seen.has(resolved) || isBlockedPickerPath(resolved, trees, true)) continue;
      const stat = await fs.stat(resolved);
      if (!stat.isDirectory()) continue;
      seen.add(resolved);
      roots.push({ label: candidate.label, path: resolved });
    } catch {
      // Optional roots (for example /mnt/d on non-WSL hosts) are omitted.
    }
  }
  return roots;
}

type ResolvedFilesystemPickerPath = {
  candidatePath: string;
  resolvedPath: string;
  roots: FilesystemBrowseRoot[];
  matchingRoot: FilesystemBrowseRoot;
  blockedTrees: readonly string[];
};

function throwFilesystemPickerError(statusCode: number, code: ApiErrorCode, message: string): never {
  throw Object.assign(new Error(message), {
    statusCode,
    body: createErrorResponse(code, message),
  });
}

async function resolveFilesystemPickerPath(
  ctx: SessionPort & ConfigPort,
  req: FastifyRequest,
  requestedPath: string | undefined,
  sessionId?: string,
  showHidden = false
): Promise<ResolvedFilesystemPickerPath> {
  const roots = await resolveFilesystemPickerRoots(ctx, req, sessionId);
  if (roots.length === 0) {
    throwFilesystemPickerError(403, ApiErrorCode.INVALID_INPUT, 'No filesystem browse roots are available');
  }

  // With no explicit path (the "Link Existing" case picker, which passes no
  // sessionId and an empty initialPath until the user has typed something),
  // land on the shared cases root rather than falling through to whichever
  // root happens to be first. `Codeman Cases` sits inside `Home` only on the
  // native default (~/codeman-cases); a Docker deployment binds them at
  // unrelated host paths (CODEMAN_APPDATA_PATH vs CODEMAN_CASES_PATH), so a
  // Home-first fallback opened the picker somewhere with no cases in sight —
  // and, worse, made an OLD case folder left behind by a since-changed
  // CODEMAN_CASES_PATH look like a normal thing to stumble across while
  // browsing for one to link.
  const fallbackRoot =
    roots.find((root) => root.label === 'Current Folder') ??
    roots.find((root) => root.label === 'Codeman Cases') ??
    roots.find((root) => root.path === '/mnt/d') ??
    roots[0];
  const candidatePath = resolve(requestedPath ?? fallbackRoot.path);

  let resolvedPath: string;
  try {
    resolvedPath = realpathSync(candidatePath);
  } catch {
    throwFilesystemPickerError(404, ApiErrorCode.NOT_FOUND, `Path not found: ${candidatePath}`);
  }

  const matchingRoot = findMatchingPickerRoot(roots, resolvedPath);
  if (!matchingRoot) {
    throwFilesystemPickerError(403, ApiErrorCode.INVALID_INPUT, 'Path is outside the allowed browse roots');
  }
  if (!showHidden && containsHiddenPickerSegment(matchingRoot.path, resolvedPath)) {
    throwFilesystemPickerError(403, ApiErrorCode.INVALID_INPUT, 'Hidden paths are not available in the file picker');
  }

  const guard = await loadAttachmentGuardConfig();
  // Navigation must use the SAME narrowed list the roots were selected with.
  // Handing the raw trees down here would admit a root and then refuse every
  // path inside it, which reads as a picker that opens and then does nothing.
  return {
    candidatePath,
    resolvedPath,
    roots,
    matchingRoot,
    blockedTrees: pickerBlockedTrees(
      guard.blockedTrees,
      roots.map((root) => root.path)
    ),
  };
}

function appendDownloadFlag(url: string): string {
  return `${url}${url.includes('?') ? '&' : '?'}download=true`;
}

// ===== File Viewer edit mode (issue #212) =====
// Policy lives in src/config/file-editing.ts; design in docs/file-viewer-edit-plan.md.

function sha256Hex(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

/** NUL byte in the first 8KB — same binary signal the plain read path uses. */
function sniffsBinary(buf: Buffer): boolean {
  const sniffLength = Math.min(buf.length, 8192);
  for (let i = 0; i < sniffLength; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

/**
 * Structured-throw variant for the edit read/write paths. Identical mechanics to
 * throwFilesystemPickerError (rendered by the central route error handler both
 * in prod and in the app.inject() test harness); a separate name only so edit
 * failures grep distinctly.
 */
function throwFileEditError(statusCode: number, code: ApiErrorCode, message: string): never {
  throw Object.assign(new Error(message), {
    statusCode,
    body: createErrorResponse(code, message),
  });
}

/**
 * Gate a resolved workspace file for edit-mode read/write. Throws a structured
 * error when the file may not be edited; returns void when it may. Order
 * matters for the message a user sees: confinement (the caller's 404) →
 * sensitive/blocked (403) → .git (403) → extension allowlist (400).
 */
function assertEditableTarget(resolvedPath: string, relativePath: string, blockedTrees: readonly string[]): void {
  if (isSensitivePath(resolvedPath) || isBlockedAttachmentPath(resolvedPath, blockedTrees)) {
    throwFileEditError(403, ApiErrorCode.FORBIDDEN, 'Editing this file is blocked');
  }
  if (isDeniedEditRelativePath(relativePath)) {
    throwFileEditError(403, ApiErrorCode.FORBIDDEN, 'Files under .git cannot be edited');
  }
  if (!isEditableFileName(pathBasename(resolvedPath))) {
    throwFileEditError(400, ApiErrorCode.INVALID_INPUT, 'This file type is not editable');
  }
}

/**
 * Decode a candidate edit buffer, refusing binary and non-UTF-8 content. The
 * round-trip compare is what protects against silent corruption: decoding
 * latin-1 (or any non-UTF-8) bytes yields U+FFFD replacements, and writing
 * those back would destroy the original bytes. A UTF-8 BOM round-trips and is
 * deliberately preserved.
 */
function decodeEditableText(buf: Buffer): string {
  if (sniffsBinary(buf)) {
    throwFileEditError(400, ApiErrorCode.INVALID_INPUT, 'Binary files cannot be edited');
  }
  const text = buf.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(buf)) {
    throwFileEditError(400, ApiErrorCode.INVALID_INPUT, 'Only UTF-8 text files can be edited');
  }
  return text;
}

function getSessionAttachmentHistory(
  ctx: SessionPort & ConfigPort,
  sessionId: string,
  req: FastifyRequest
): { workingDir: string; history: SessionAttachmentHistoryItem[] } | undefined {
  const user = getAuthUser(req);
  const liveSession = ctx.sessions.get(sessionId);
  if (liveSession) {
    if (!canAccessOwned(user, liveSession.owner)) return undefined;
    return {
      workingDir: liveSession.workingDir,
      history: liveSession.getAttachmentHistoryForPersist() ?? liveSession.attachmentHistory ?? [],
    };
  }

  const stored = ctx.store.getSession(sessionId) as StoredSessionWithPrivateAttachmentHistory | undefined;
  if (!stored || !canAccessOwned(user, (stored as { owner?: string }).owner)) return undefined;

  return {
    workingDir: stored.workingDir,
    history: stored.__attachmentHistory ?? stored.attachmentHistory ?? [],
  };
}

// History item for a file detected inside the workspace: re-stat for live
// size/mtime and resolve preview/thumbnail/raw routes off the relative path.
async function buildDetectedAttachmentRouteItem(
  sessionId: string,
  workingDir: string,
  item: SessionAttachmentHistoryItem
): Promise<AttachmentHistoryRouteItem> {
  const safe = sanitizeAttachmentHistoryItem(item);
  if (!item.relativePath) {
    return { ...safe, missing: true };
  }

  const validated = validateSessionFilePath(workingDir, item.relativePath);
  if (!validated) {
    return { ...safe, missing: true };
  }

  let size = item.size;
  let mtimeMs = item.mtimeMs;
  try {
    const stat = await fs.stat(validated.resolvedPath);
    size = stat.size;
    mtimeMs = stat.mtimeMs ?? mtimeMs;
  } catch {
    return { ...safe, missing: true };
  }

  const encodedPath = encodeURIComponent(item.relativePath);
  const rawUrl = `/api/sessions/${sessionId}/file-raw?path=${encodedPath}`;
  const previewUrl =
    item.extension === 'docx' || item.extension === 'pptx'
      ? `/api/sessions/${sessionId}/file-preview?path=${encodedPath}`
      : rawUrl;
  const thumbnailUrl = isSupportedAttachmentExtension(item.extension)
    ? buildFileThumbnailRoute(sessionId, item.relativePath)
    : undefined;

  return {
    ...safe,
    size,
    mtimeMs,
    missing: false,
    rawUrl,
    url: rawUrl,
    previewUrl,
    thumbnailUrl,
    downloadUrl: appendDownloadFlag(rawUrl),
  };
}

// History item for an explicitly published external file: re-register it to mint
// a fresh id + by-id routes (the guard runs again), or mark it missing.
async function buildExternalAttachmentRouteItem(
  sessionId: string,
  item: SessionAttachmentHistoryItem,
  sessionWorkingDir?: string
): Promise<AttachmentHistoryRouteItem> {
  const safe = sanitizeAttachmentHistoryItem(item);
  if (!item.externalPath) {
    return { ...safe, missing: true };
  }

  try {
    const event = await registerExternalAttachment(sessionId, item.externalPath, { sessionWorkingDir });
    return {
      ...safe,
      fileName: event.fileName,
      extension: event.extension,
      attachmentType: event.attachmentType,
      size: event.size,
      missing: false,
      attachmentId: event.attachmentId,
      rawUrl: event.rawUrl,
      url: event.rawUrl,
      previewUrl: event.previewUrl,
      thumbnailUrl: event.thumbnailUrl,
      downloadUrl: appendDownloadFlag(event.rawUrl),
    };
  } catch (err) {
    if (err instanceof AttachmentRegistrationError) {
      return { ...safe, missing: true };
    }
    throw err;
  }
}

/**
 * Headers Fastify already put on the reply, in a shape `writeHead` accepts.
 *
 * `reply.raw.writeHead()` writes straight to the Node response and bypasses
 * Fastify's header store, so anything the security `onRequest` hook granted — CORS
 * for localhost origins, nosniff, frame-options, CSP — is silently dropped on every
 * route that answers this way. Spread this first and let the route's own headers
 * win over it.
 */
function inheritedHeaders(reply: {
  getHeaders(): NodeJS.Dict<number | string | string[]>;
}): Record<string, number | string | string[]> {
  const out: Record<string, number | string | string[]> = {};
  for (const [name, value] of Object.entries(reply.getHeaders())) {
    if (value !== undefined) out[name] = value;
  }
  return out;
}

export function registerFileRoutes(app: FastifyInstance, ctx: SessionPort & EventPort & ConfigPort): void {
  // Lazy filesystem listing for the Link Existing and mobile input path pickers.
  app.get('/api/filesystem/browse', async (req, reply): Promise<ApiResponse<FilesystemBrowseData>> => {
    const { path: requestedPath, sessionId, showHidden } = parseBody(FilesystemBrowseQuerySchema, req.query);
    const includeHidden = wantsHiddenPickerEntries(showHidden);
    const { candidatePath, resolvedPath, roots, matchingRoot, blockedTrees } = await resolveFilesystemPickerPath(
      ctx,
      req,
      requestedPath,
      sessionId,
      includeHidden
    );

    if (isBlockedPickerPath(resolvedPath, blockedTrees, true)) {
      reply.code(403);
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Access to this folder is blocked');
    }

    try {
      const stat = await fs.stat(resolvedPath);
      if (!stat.isDirectory()) {
        reply.code(400);
        return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'The browse path must be a directory');
      }
    } catch {
      reply.code(404);
      return createErrorResponse(ApiErrorCode.NOT_FOUND, `Folder not found: ${candidatePath}`);
    }

    let dirEntries;
    try {
      dirEntries = await fs.readdir(resolvedPath, { withFileTypes: true });
    } catch {
      reply.code(403);
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'This folder cannot be read');
    }

    dirEntries.sort((a, b) => {
      if (a.isDirectory() && !b.isDirectory()) return -1;
      if (!a.isDirectory() && b.isDirectory()) return 1;
      return a.name.localeCompare(b.name);
    });

    const entries: FilesystemBrowseEntry[] = [];
    let truncated = false;
    for (const entry of dirEntries) {
      if (!includeHidden && entry.name.startsWith('.')) continue;
      if (entries.length >= FILESYSTEM_PICKER_ENTRY_LIMIT) {
        truncated = true;
        break;
      }

      const visiblePath = join(candidatePath, entry.name);
      let targetPath: string;
      try {
        targetPath = realpathSync(visiblePath);
      } catch {
        continue;
      }

      const targetRoot = findMatchingPickerRoot(roots, targetPath);
      if (!targetRoot) continue;
      if (!includeHidden && containsHiddenPickerSegment(targetRoot.path, targetPath)) continue;

      let type: FilesystemBrowseEntry['type'];
      let size: number | undefined;
      const symlink = entry.isSymbolicLink();
      if (entry.isDirectory()) {
        type = 'directory';
      } else if (entry.isFile()) {
        type = 'file';
      } else if (symlink) {
        try {
          const targetStat = await fs.stat(targetPath);
          type = targetStat.isDirectory() ? 'directory' : 'file';
          if (type === 'file') size = targetStat.size;
        } catch {
          continue;
        }
      } else {
        continue;
      }

      if (isBlockedPickerPath(targetPath, blockedTrees, type === 'directory')) continue;
      if (type === 'file' && size === undefined) {
        try {
          size = (await fs.stat(targetPath)).size;
        } catch {
          // The path is still selectable even when a size lookup races a change.
        }
      }
      entries.push({
        name: entry.name,
        path: visiblePath,
        type,
        size,
        symlink: symlink || undefined,
        previewKind: type === 'file' ? getFilesystemPreviewKind(entry.name) : undefined,
      });
    }

    const parentCandidate = resolve(candidatePath, '..');
    let parent: string | null = null;
    if (candidatePath !== matchingRoot.path) {
      try {
        const resolvedParent = realpathSync(parentCandidate);
        if (isPathWithinRoot(matchingRoot.path, resolvedParent)) parent = parentCandidate;
      } catch {
        // A concurrently removed parent simply disables upward navigation.
      }
    }

    return {
      success: true,
      data: {
        path: candidatePath,
        parent,
        root: matchingRoot.path,
        roots,
        entries,
        truncated,
      },
    };
  });

  // Inline preview for files selected through the root-confined filesystem picker.
  app.get('/api/filesystem/preview', { compress: false }, async (req, reply): Promise<void> => {
    const { path: requestedPath, sessionId, showHidden } = parseBody(FilesystemPreviewQuerySchema, req.query);
    const { candidatePath, resolvedPath, blockedTrees } = await resolveFilesystemPickerPath(
      ctx,
      req,
      requestedPath,
      sessionId,
      wantsHiddenPickerEntries(showHidden)
    );
    if (isBlockedPickerPath(resolvedPath, blockedTrees)) {
      throwFilesystemPickerError(403, ApiErrorCode.INVALID_INPUT, 'Access to this file is blocked');
    }

    let stat;
    try {
      stat = await fs.stat(resolvedPath);
    } catch {
      throwFilesystemPickerError(404, ApiErrorCode.NOT_FOUND, `File not found: ${candidatePath}`);
    }
    if (!stat.isFile()) {
      throwFilesystemPickerError(400, ApiErrorCode.INVALID_INPUT, 'The preview path must be a file');
    }

    const fileName = pathBasename(candidatePath);
    const extension = extname(fileName).slice(1).toLowerCase();
    const previewKind = getFilesystemPreviewKind(fileName);
    if (!previewKind) {
      throwFilesystemPickerError(400, ApiErrorCode.INVALID_INPUT, 'This file type cannot be previewed');
    }
    const sizeLimit = previewKind === 'text' ? FILESYSTEM_TEXT_PREVIEW_LIMIT : FILESYSTEM_BINARY_PREVIEW_LIMIT;
    if (stat.size > sizeLimit) {
      throwFilesystemPickerError(
        413,
        ApiErrorCode.INVALID_INPUT,
        `File too large to preview (${Math.ceil(stat.size / 1024 / 1024)}MB limit: ${sizeLimit / 1024 / 1024}MB)`
      );
    }

    reply.header('Cache-Control', 'no-cache');
    reply.header('X-Content-Type-Options', 'nosniff');
    if (previewKind === 'text') {
      const content = await fs.readFile(resolvedPath, 'utf8');
      reply.type('text/plain; charset=utf-8').send(content);
      return;
    }
    if (extension === 'docx' || extension === 'pptx') {
      await serveConvertedPreview(reply, resolvedPath, fileName, extension);
      return;
    }
    await serveRawFile(reply, resolvedPath, fileName, extension, false, req.headers.range);
  });

  // File tree listing
  app.get('/api/sessions/:id/files', async (req) => {
    const { id } = req.params as { id: string };
    const { depth, showHidden, q } = req.query as { depth?: string; showHidden?: string; q?: string };
    const session = findSessionOrFail(ctx, id, req);

    const maxDepth = Math.min(parseInt(depth || '5', 10), 10);
    const includeHidden = showHidden === 'true';
    const workingDir = session.workingDir;
    // null for an empty/whitespace query, which is what keeps the default
    // tree response byte-identical when no search is requested.
    const matcher = compileFileQuery(q ?? '');

    // Default excludes - large/generated directories
    const excludeDirs = new Set([
      '.git',
      'node_modules',
      'dist',
      'build',
      '__pycache__',
      '.cache',
      '.next',
      '.nuxt',
      'coverage',
      '.venv',
      'venv',
      '.tox',
      'target',
      'vendor',
    ]);

    interface FileTreeNode {
      name: string;
      path: string;
      type: 'file' | 'directory';
      size?: number;
      extension?: string;
      children?: FileTreeNode[];
    }

    let totalFiles = 0;
    let totalDirectories = 0;
    let truncated = false;
    const maxFiles = 5000;

    // ===== Search mode =====
    // A query turns this endpoint into a FLAT match list rather than a nested
    // tree. It recurses past non-matching directories on purpose — the whole
    // point of searching is to reach a file whose ancestors do not match — so
    // it is bounded independently by maxMatches on top of the shared maxFiles
    // and maxDepth caps, and reports `truncated` when it stops early.
    if (matcher) {
      const matches: FileTreeNode[] = [];
      const maxMatches = 1000;

      const searchDirectory = async (dirPath: string, currentDepth: number): Promise<void> => {
        if (currentDepth > maxDepth || totalFiles + totalDirectories > maxFiles || matches.length >= maxMatches) {
          truncated = true;
          return;
        }

        let entries: import('node:fs').Dirent[];
        try {
          entries = await fs.readdir(dirPath, { withFileTypes: true });
        } catch {
          // Can't read directory (permission denied, etc.)
          return;
        }
        entries.sort((a, b) => {
          if (a.isDirectory() && !b.isDirectory()) return -1;
          if (!a.isDirectory() && b.isDirectory()) return 1;
          return a.name.localeCompare(b.name);
        });

        for (const entry of entries) {
          if (totalFiles + totalDirectories > maxFiles || matches.length >= maxMatches) {
            truncated = true;
            break;
          }
          if (!includeHidden && entry.name.startsWith('.')) continue;
          if (entry.isDirectory() && excludeDirs.has(entry.name)) continue;

          const fullPath = join(dirPath, entry.name);
          const relativePath = relative(workingDir, fullPath);

          if (entry.isDirectory()) {
            totalDirectories++;
            if (matcher(entry.name, relativePath)) {
              matches.push({ name: entry.name, path: relativePath, type: 'directory' });
            }
            // Always recurse, even when this directory does not match.
            await searchDirectory(fullPath, currentDepth + 1);
          } else {
            totalFiles++;
            if (matcher(entry.name, relativePath)) {
              let size: number | undefined;
              try {
                size = (await fs.stat(fullPath)).size;
              } catch {
                // Skip size if we can't stat the match.
              }
              matches.push({
                name: entry.name,
                path: relativePath,
                type: 'file',
                size,
                extension: entry.name.includes('.') ? entry.name.split('.').pop()?.toLowerCase() : undefined,
              });
            }
          }
        }
      };

      await searchDirectory(workingDir, 1);

      return {
        success: true,
        data: {
          root: workingDir,
          tree: [],
          matches,
          totalFiles,
          totalDirectories,
          truncated,
          matchCount: matches.length,
          query: (q ?? '').trim(),
          mode: 'search' as const,
        },
      };
    }

    const scanDirectory = async (dirPath: string, currentDepth: number): Promise<FileTreeNode[]> => {
      if (currentDepth > maxDepth || totalFiles + totalDirectories > maxFiles) {
        truncated = true;
        return [];
      }

      try {
        const entries = await fs.readdir(dirPath, { withFileTypes: true });
        const nodes: FileTreeNode[] = [];

        // Sort: directories first, then alphabetically
        entries.sort((a, b) => {
          if (a.isDirectory() && !b.isDirectory()) return -1;
          if (!a.isDirectory() && b.isDirectory()) return 1;
          return a.name.localeCompare(b.name);
        });

        for (const entry of entries) {
          if (totalFiles + totalDirectories > maxFiles) {
            truncated = true;
            break;
          }

          // Skip hidden files unless requested
          if (!includeHidden && entry.name.startsWith('.')) continue;

          // Skip excluded directories
          if (entry.isDirectory() && excludeDirs.has(entry.name)) continue;

          const fullPath = join(dirPath, entry.name);
          const relativePath = fullPath.slice(workingDir.length + 1);

          if (entry.isDirectory()) {
            totalDirectories++;
            const children = await scanDirectory(fullPath, currentDepth + 1);
            nodes.push({
              name: entry.name,
              path: relativePath,
              type: 'directory',
              children,
            });
          } else {
            totalFiles++;
            const ext = entry.name.includes('.') ? entry.name.split('.').pop()?.toLowerCase() : undefined;
            let size: number | undefined;
            try {
              const stat = await fs.stat(fullPath);
              size = stat.size;
            } catch {
              // Skip if can't stat
            }
            nodes.push({
              name: entry.name,
              path: relativePath,
              type: 'file',
              size,
              extension: ext,
            });
          }
        }

        return nodes;
      } catch {
        // Can't read directory (permission denied, etc.)
        return [];
      }
    };

    const tree = await scanDirectory(workingDir, 1);

    return {
      success: true,
      data: {
        root: workingDir,
        tree,
        totalFiles,
        totalDirectories,
        truncated,
      },
    };
  });

  // Get file content for preview (File Browser)
  app.get('/api/sessions/:id/file-content', async (req) => {
    const { id } = req.params as { id: string };
    const {
      path: filePath,
      lines,
      raw,
      edit,
    } = req.query as { path?: string; lines?: string; raw?: string; edit?: string };
    const session = findSessionOrFail(ctx, id, req);

    if (!filePath) {
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Missing path parameter');
    }

    // Validate path is within working directory (security: resolve symlinks to prevent traversal)
    const validated = validateSessionFilePath(session.workingDir, filePath);
    if (!validated) {
      return createErrorResponse(ApiErrorCode.NOT_FOUND, 'File not found');
    }
    const { resolvedPath, relativePath } = validated;

    // Read-for-edit: never truncated (a truncated buffer must never become an
    // edit buffer), tighter size cap, full editability gate, and the hash/eol
    // the client must echo back on PUT. Outside the shared try/catch below so
    // its structured errors keep their status codes instead of collapsing into
    // OPERATION_FAILED.
    if (edit === '1' || edit === 'true') {
      const guard = await loadAttachmentGuardConfig();
      assertEditableTarget(resolvedPath, relativePath, guard.blockedTrees);

      let editStat;
      try {
        editStat = await fs.stat(resolvedPath);
      } catch {
        throwFileEditError(404, ApiErrorCode.NOT_FOUND, 'File not found');
      }
      if (!editStat.isFile()) {
        throwFileEditError(400, ApiErrorCode.INVALID_INPUT, 'Only regular files can be edited');
      }
      if (editStat.size > MAX_EDITABLE_BYTES) {
        throwFileEditError(
          413,
          ApiErrorCode.INVALID_INPUT,
          `File too large to edit here (${Math.ceil(editStat.size / 1024)}KB > ${MAX_EDITABLE_BYTES / 1024}KB limit)`
        );
      }

      const editBuf = await fs.readFile(resolvedPath);
      const editText = decodeEditableText(editBuf);
      return {
        success: true,
        data: {
          path: filePath,
          content: editText,
          size: editBuf.length,
          mtimeMs: editStat.mtimeMs,
          totalLines: editText.split('\n').length,
          truncated: false,
          extension: filePath.split('.').pop()?.toLowerCase() || '',
          editable: true,
          hash: sha256Hex(editBuf),
          eol: detectEol(editText),
        },
      };
    }

    try {
      const stat = await fs.stat(resolvedPath);

      // Classify by extension. Known media types render with a dedicated player;
      // other known-binary types are flagged so the client offers a download
      // affordance instead of trying to decode the bytes as text. Matches the
      // breadth of formats the attachments viewer renders (image/audio/video/pdf)
      // so the file viewer can open the same files.
      const ext = filePath.split('.').pop()?.toLowerCase() || '';
      const imageExts = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico']);
      // Shared with the attachment registry so a video plays the same whether it
      // sits in the workspace or is reached by id from outside it.
      const videoExts = VIDEO_ATTACHMENT_EXTENSIONS;
      const audioExts = AUDIO_ATTACHMENT_EXTENSIONS;
      const otherBinaryExts = new Set([
        'pdf',
        'zip',
        'tar',
        'gz',
        'bz2',
        'xz',
        '7z',
        'rar',
        'exe',
        'dll',
        'so',
        'dylib',
        'bin',
        'wasm',
        'class',
        'o',
        'a',
        'woff',
        'woff2',
        'ttf',
        'eot',
        'otf',
        'xlsx',
        'xls',
        'doc',
        'docx',
        'ppt',
        'pptx',
        'odt',
        'ods',
        'odp',
        'avi',
        'mkv',
        'wmv',
        'flv',
      ]);

      const mediaType = imageExts.has(ext)
        ? 'image'
        : videoExts.has(ext)
          ? 'video'
          : audioExts.has(ext)
            ? 'audio'
            : null;

      const fileRawUrl = `/api/sessions/${id}/file-raw?path=${encodeURIComponent(filePath)}`;

      if (raw === 'true' || mediaType || otherBinaryExts.has(ext)) {
        // Return metadata for media/binary files (no text body)
        return {
          success: true,
          data: {
            path: filePath,
            size: stat.size,
            type: mediaType ?? 'binary',
            extension: ext,
            url: fileRawUrl,
          },
        };
      }

      // Validate file size before reading (DoS protection - prevent memory exhaustion)
      const MAX_TEXT_FILE_SIZE = 10 * 1024 * 1024; // 10MB
      if (stat.size > MAX_TEXT_FILE_SIZE) {
        return createErrorResponse(
          ApiErrorCode.INVALID_INPUT,
          `File too large (${Math.round(stat.size / 1024 / 1024)}MB > ${MAX_TEXT_FILE_SIZE / 1024 / 1024}MB limit)`
        );
      }

      // Read as raw bytes so we can sniff for binary content before decoding. An
      // unrecognized extension (none at all, or a format not listed above) that
      // is actually binary would otherwise be dumped to the viewer as UTF-8
      // mojibake; a NUL byte in the first 8KB is a reliable binary signal that
      // (unlike a static extension list) catches arbitrary binary formats.
      const fileBuffer = await fs.readFile(resolvedPath);
      const buf = Buffer.isBuffer(fileBuffer) ? fileBuffer : Buffer.from(String(fileBuffer));
      const sniffLength = Math.min(buf.length, 8192);
      let looksBinary = false;
      for (let i = 0; i < sniffLength; i++) {
        if (buf[i] === 0) {
          looksBinary = true;
          break;
        }
      }

      if (looksBinary) {
        return {
          success: true,
          data: {
            path: filePath,
            size: stat.size,
            type: 'binary',
            extension: ext,
            url: fileRawUrl,
          },
        };
      }

      // Read text file with line limit (bounded to prevent DoS)
      const MAX_LINES_LIMIT = 10000;
      const maxLines = Math.min(parseInt(lines || '500', 10) || 500, MAX_LINES_LIMIT);
      const content = buf.toString('utf-8');
      const allLines = content.split('\n');
      const truncatedContent = allLines.length > maxLines;
      const displayContent = truncatedContent ? allLines.slice(0, maxLines).join('\n') : content;

      // Additive edit-mode advertisement: whether an edit=1 re-fetch would
      // succeed. The UTF-8 round-trip compare is a cheap memcmp and mirrors
      // decodeEditableText; no hash here — the Edit action re-fetches with
      // edit=1, which is where the baseHash comes from.
      const guard = await loadAttachmentGuardConfig();
      const editable =
        isEditableFileName(pathBasename(resolvedPath)) &&
        !isDeniedEditRelativePath(relativePath) &&
        !isSensitivePath(resolvedPath) &&
        !isBlockedAttachmentPath(resolvedPath, guard.blockedTrees) &&
        stat.size <= MAX_EDITABLE_BYTES &&
        Buffer.from(content, 'utf8').equals(buf);

      return {
        success: true,
        data: {
          path: filePath,
          content: displayContent,
          size: stat.size,
          totalLines: allLines.length,
          truncated: truncatedContent,
          extension: ext,
          editable,
        },
      };
    } catch (err) {
      return createErrorResponse(ApiErrorCode.OPERATION_FAILED, `Failed to read file: ${getErrorMessage(err)}`);
    }
  });

  // File Viewer edit mode: save a text file back into the session workspace.
  // Edit-in-place ONLY — there is deliberately no O_CREAT path in this handler,
  // so it can never create, and it never deletes. Confinement is identical to
  // the read path (realpath + workspace boundary + ownership via
  // findSessionOrFail), plus the sensitive-path/attachment-guard blocklists and
  // the extension allowlist. Concurrency is optimistic: the client echoes the
  // sha256 it loaded (baseHash) and a mismatch is a 409 unless force is set.
  // bodyLimit: JSON escaping can expand content up to ~6x (each control char
  // becomes \uXXXX), so the 512KB content cap needs headroom over Fastify's
  // 1MB default.
  app.put(
    '/api/sessions/:id/file-content',
    { bodyLimit: 4 * 1024 * 1024 },
    async (req): Promise<ApiResponse<FileWriteData>> => {
      const { id } = req.params as { id: string };
      const session = findSessionOrFail(ctx, id, req);
      const body = parseBody(FileWriteSchema, req.body);

      // Exact byte cap — the schema's .max() counts UTF-16 code units and is
      // only a coarse pre-filter.
      if (Buffer.byteLength(body.content, 'utf8') > MAX_EDITABLE_BYTES) {
        throwFileEditError(413, ApiErrorCode.INVALID_INPUT, `Content too large (${MAX_EDITABLE_BYTES / 1024}KB limit)`);
      }

      const validated = validateSessionFilePath(session.workingDir, body.path);
      if (!validated) {
        // Covers missing files, traversal, and symlink escapes alike — a write
        // target that fails confinement is reported identically to a missing
        // one, matching the read route.
        throwFileEditError(404, ApiErrorCode.NOT_FOUND, 'File not found');
      }
      const { resolvedPath, relativePath } = validated;

      const guard = await loadAttachmentGuardConfig();
      assertEditableTarget(resolvedPath, relativePath, guard.blockedTrees);

      let stat;
      try {
        stat = await fs.stat(resolvedPath);
      } catch {
        throwFileEditError(404, ApiErrorCode.NOT_FOUND, 'File not found');
      }
      if (!stat.isFile()) {
        throwFileEditError(400, ApiErrorCode.INVALID_INPUT, 'Only regular files can be edited');
      }
      if (stat.size > MAX_EDITABLE_BYTES) {
        throwFileEditError(
          413,
          ApiErrorCode.INVALID_INPUT,
          `File too large to edit here (${MAX_EDITABLE_BYTES / 1024}KB limit)`
        );
      }

      const currentBuf = await fs.readFile(resolvedPath);
      const currentText = decodeEditableText(currentBuf);
      const currentHash = sha256Hex(currentBuf);
      if (currentHash !== body.baseHash && !body.force) {
        throwFileEditError(
          409,
          ApiErrorCode.CONFLICT,
          'File changed on disk since it was loaded — reload it or overwrite'
        );
      }

      // Re-apply the file's original line endings (a <textarea> normalizes to
      // LF; without this a two-line edit of a CRLF file rewrites every line).
      const eol = body.eol ?? detectEol(currentText);
      const outText = applyEol(body.content, eol);
      const outBuf = Buffer.from(outText, 'utf8');
      if (outBuf.length > MAX_EDITABLE_BYTES) {
        throwFileEditError(413, ApiErrorCode.INVALID_INPUT, `Content too large (${MAX_EDITABLE_BYTES / 1024}KB limit)`);
      }

      // Atomic replace: O_EXCL temp in the same directory, then rename.
      // 'wx' cannot follow a pre-existing symlink and rename() replaces (not
      // follows) a symlink in the final component, which closes the
      // validate-then-write TOCTOU window. fchmod because open()'s mode is
      // masked by the process umask; fsync so the rename never publishes a
      // partially-durable file. Trade-off (same as vim's default): the inode
      // changes, so hardlinks keep the old content.
      const fileMode = stat.mode & 0o777;
      const tmpPath = join(
        dirname(resolvedPath),
        `.${pathBasename(resolvedPath)}.codeman-tmp-${randomBytes(6).toString('hex')}`
      );
      let handle;
      try {
        handle = await fs.open(tmpPath, 'wx', fileMode);
        await handle.chmod(fileMode);
        await handle.writeFile(outBuf);
        await handle.sync();
        await handle.close();
        handle = undefined;
        await fs.rename(tmpPath, resolvedPath);
      } catch (err) {
        if (handle) await handle.close().catch(() => {});
        await fs.unlink(tmpPath).catch(() => {});
        throwFileEditError(500, ApiErrorCode.OPERATION_FAILED, `Failed to save file: ${getErrorMessage(err)}`);
      }

      const newStat = await fs.stat(resolvedPath).catch(() => undefined);
      return {
        success: true,
        data: {
          path: body.path,
          size: outBuf.length,
          mtimeMs: newStat?.mtimeMs ?? Date.now(),
          hash: sha256Hex(outBuf),
          totalLines: outText.split('\n').length,
          eol,
        },
      };
    }
  );

  // Serve raw file content (for images/binary files)
  app.get('/api/sessions/:id/file-raw', async (req, reply) => {
    const { id } = req.params as { id: string };
    const { path: filePath, download } = req.query as { path?: string; download?: string };
    const session = findSessionOrFail(ctx, id, req);

    if (!filePath) {
      reply.code(400).send(createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Missing path parameter'));
      return;
    }

    // Validate path is within working directory (security: resolve symlinks to prevent traversal)
    const validated = validateSessionFilePath(session.workingDir, filePath);
    if (!validated) {
      reply.code(404).send(createErrorResponse(ApiErrorCode.NOT_FOUND, 'File not found'));
      return;
    }
    const { resolvedPath } = validated;

    try {
      // Sanity bound only: the body below is streamed and Range-aware, so size
      // does not translate into resident memory. Configurable, 0 = unlimited.
      const stat = await fs.stat(resolvedPath);
      if (exceedsDownloadLimit(stat.size)) {
        reply.code(413).send(createErrorResponse(ApiErrorCode.INVALID_INPUT, downloadTooLargeMessage(stat.size)));
        return;
      }

      const ext = filePath.split('.').pop()?.toLowerCase() || '';
      const mimeTypes: Record<string, string> = {
        png: 'image/png',
        jpg: 'image/jpeg',
        jpeg: 'image/jpeg',
        gif: 'image/gif',
        webp: 'image/webp',
        ico: 'image/x-icon',
        bmp: 'image/bmp',
        mp4: 'video/mp4',
        webm: 'video/webm',
        mov: 'video/quicktime',
        m4v: 'video/mp4',
        ogv: 'video/ogg',
        mp3: 'audio/mpeg',
        wav: 'audio/wav',
        ogg: 'audio/ogg',
        oga: 'audio/ogg',
        opus: 'audio/ogg',
        m4a: 'audio/mp4',
        aac: 'audio/aac',
        flac: 'audio/flac',
        pdf: 'application/pdf',
        json: 'application/json',
      };

      const rawBasename = filePath!.split('/').pop() || 'download';
      // Sanitize filename for Content-Disposition header (prevent header injection)
      const basename = rawBasename.replace(/["\\\r\n]/g, '_');
      if (download === 'true' || ext === 'svg') {
        reply.header(
          'Content-Type',
          ext === 'svg' ? 'application/octet-stream' : mimeTypes[ext] || 'application/octet-stream'
        );
        reply.header('Content-Disposition', `attachment; filename="${basename}"`);
        reply.header('X-Content-Type-Options', 'nosniff');
        sendFileBody(reply, resolvedPath, stat.size, req.headers.range);
        return;
      }
      reply.header('Content-Type', mimeTypes[ext] || 'application/octet-stream');
      reply.header('X-Content-Type-Options', 'nosniff');
      // Streamed, range-aware: this is the <video>/<audio> source the file
      // viewer points at, and a 200-only response makes the media unseekable.
      sendFileBody(reply, resolvedPath, stat.size, req.headers.range);
    } catch (err) {
      reply
        .code(500)
        .send(createErrorResponse(ApiErrorCode.OPERATION_FAILED, `Failed to read file: ${getErrorMessage(err)}`));
    }
  });

  // ===== Live external attachments =====
  // Register an explicit, live external file (absolute host path) as an
  // attachment with a stable id so browser requests never carry arbitrary
  // paths. Registration enforces the COD-53 attachment-guard policy. Serving is
  // by id via the /raw route below; document previews/thumbnails and the
  // attachment-history list are layered on separately.
  app.post('/api/sessions/:id/attachments', async (req, reply) => {
    const { id } = req.params as { id: string };
    const session = findSessionOrFail(ctx, id, req);
    const body = (req.body || {}) as { path?: string; notify?: boolean };

    if (!body.path || typeof body.path !== 'string') {
      reply.code(400).send(createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Missing attachment path'));
      return;
    }

    try {
      const event = await registerExternalAttachment(id, body.path, { sessionWorkingDir: session.workingDir });
      // `notify: false` registers QUIETLY. The file-preview overlay uses it to
      // mint an id for a path the user just clicked (a terminal or response-viewer
      // link pointing outside the workspace): it is already opening the file, so
      // the attachment card + unread badge would be noise announcing what is
      // filling the screen. Default stays true — every other caller (the
      // `codeman attach` CLI, codeman-publish) wants the card.
      if (body.notify !== false) {
        ctx.broadcast(SseEvent.AttachmentDetected, event);
      }
      return { success: true, data: event };
    } catch (err) {
      if (err instanceof AttachmentRegistrationError) {
        reply.code(err.statusCode).send(createErrorResponse(ApiErrorCode.INVALID_INPUT, err.message));
        return;
      }
      return reply
        .code(500)
        .send(
          createErrorResponse(ApiErrorCode.OPERATION_FAILED, `Failed to register attachment: ${getErrorMessage(err)}`)
        );
    }
  });

  // List a session's attachment history (live session or persisted), resolving
  // each entry to current metadata + routes. External entries are re-registered.
  app.get('/api/sessions/:id/attachments', async (req, reply) => {
    const { id } = req.params as { id: string };
    const sessionHistory = getSessionAttachmentHistory(ctx, id, req);
    if (!sessionHistory) {
      reply.code(404).send(createErrorResponse(ApiErrorCode.NOT_FOUND, `Session ${id} not found`));
      return;
    }

    const items = await Promise.all(
      sessionHistory.history.map((item) =>
        (item.source === 'external'
          ? buildExternalAttachmentRouteItem(id, item, sessionHistory.workingDir)
          : buildDetectedAttachmentRouteItem(id, sessionHistory.workingDir, item)
        ).catch(() => ({ ...sanitizeAttachmentHistoryItem(item), missing: true }))
      )
    );

    return {
      success: true,
      data: {
        items,
        count: items.length,
      },
    };
  });

  // Metadata poll for a single registered attachment (re-stats for live
  // size/mtime as the underlying file is rewritten).
  app.get('/api/sessions/:id/attachments/:attachmentId', async (req, reply) => {
    const { id, attachmentId } = req.params as { id: string; attachmentId: string };
    const workingDir = getKnownSessionWorkingDir(ctx, id, reply, req);
    if (!workingDir) return;
    const record = getAttachmentOr404(reply, id, attachmentId);
    if (!record) return;
    if (!(await resolveServableAttachmentPath(reply, record, workingDir))) return;
    const event = attachmentRecordToEvent(record);
    let size = record.size;
    let mtimeMs = record.mtimeMs;
    try {
      const stat = await fs.stat(record.filePath);
      size = stat.size;
      mtimeMs = stat.mtimeMs ?? mtimeMs;
    } catch {
      // File temporarily unavailable mid-write — keep cached values.
    }
    return {
      success: true,
      data: {
        path: record.fileName,
        size,
        mtimeMs,
        type: record.attachmentType,
        extension: record.extension,
        url: event.rawUrl,
        previewUrl: event.previewUrl,
        thumbnailUrl: event.thumbnailUrl,
        attachmentId: record.attachmentId,
        fileName: record.fileName,
      },
    };
  });

  // Serve the raw bytes of a registered attachment by id. Re-checks the
  // attachment-guard policy on every request (defense-in-depth) before streaming.
  app.get('/api/sessions/:id/attachments/:attachmentId/raw', async (req, reply) => {
    const { id, attachmentId } = req.params as { id: string; attachmentId: string };
    const { download } = req.query as { download?: string };
    const session = findSessionOrFail(ctx, id, req);
    const record = getAttachmentOr404(reply, id, attachmentId);
    if (!record) return;
    const servePath = await resolveServableAttachmentPath(reply, record, session.workingDir);
    if (!servePath) return;

    try {
      await serveRawFile(reply, servePath, record.fileName, record.extension, download === 'true', req.headers.range);
    } catch (err) {
      reply
        .code(500)
        .send(createErrorResponse(ApiErrorCode.OPERATION_FAILED, `Failed to read file: ${getErrorMessage(err)}`));
    }
  });

  // Serve a converted PDF preview of a registered attachment by id. Office docs
  // convert server-side; PDF/PNG/text redirect to the raw route.
  app.get('/api/sessions/:id/attachments/:attachmentId/preview', async (req, reply) => {
    const { id, attachmentId } = req.params as { id: string; attachmentId: string };
    const workingDir = getKnownSessionWorkingDir(ctx, id, reply, req);
    if (!workingDir) return;
    const record = getAttachmentOr404(reply, id, attachmentId);
    if (!record) return;
    const servePath = await resolveServableAttachmentPath(reply, record, workingDir);
    if (!servePath) return;

    // Only Office formats need server-side conversion; PDF/PNG and text formats
    // (md/txt) preview directly from their raw bytes.
    if (record.extension !== 'docx' && record.extension !== 'pptx') {
      reply.redirect(`/api/sessions/${id}/attachments/${encodeURIComponent(attachmentId)}/raw`);
      return;
    }

    await serveConvertedPreview(reply, servePath, record.fileName, record.extension);
  });

  // Serve a first-page thumbnail of a registered attachment by id.
  app.get('/api/sessions/:id/attachments/:attachmentId/thumbnail', async (req, reply) => {
    const { id, attachmentId } = req.params as { id: string; attachmentId: string };
    const workingDir = getKnownSessionWorkingDir(ctx, id, reply, req);
    if (!workingDir) return;
    const record = getAttachmentOr404(reply, id, attachmentId);
    if (!record) return;
    const servePath = await resolveServableAttachmentPath(reply, record, workingDir);
    if (!servePath) return;
    await serveThumbnail(reply, servePath, record.extension);
  });

  // Serve converted document previews for a workspace-relative path. DOCX/PPTX
  // are converted to PDF via LibreOffice; PDF/PNG/text preview through file-raw.
  app.get('/api/sessions/:id/file-preview', async (req, reply) => {
    const { id } = req.params as { id: string };
    const { path: filePath } = req.query as { path?: string };
    const workingDir = getKnownSessionWorkingDir(ctx, id, reply, req);
    if (!workingDir) return;

    if (!filePath) {
      reply.code(400).send(createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Missing path parameter'));
      return;
    }

    const validated = validateSessionFilePath(workingDir, filePath);
    if (!validated) {
      reply.code(404).send(createErrorResponse(ApiErrorCode.NOT_FOUND, 'File not found'));
      return;
    }
    const { resolvedPath } = validated;
    const ext = filePath.split('.').pop()?.toLowerCase() || '';

    if (ext !== 'docx' && ext !== 'pptx') {
      reply.redirect(`/api/sessions/${id}/file-raw?path=${encodeURIComponent(filePath)}`);
      return;
    }

    await serveConvertedPreview(reply, resolvedPath, filePath, ext);
  });

  // Serve a first-page thumbnail for a workspace-relative path.
  app.get('/api/sessions/:id/file-thumbnail', async (req, reply) => {
    const { id } = req.params as { id: string };
    const { path: filePath } = req.query as { path?: string };
    const workingDir = getKnownSessionWorkingDir(ctx, id, reply, req);
    if (!workingDir) return;

    if (!filePath) {
      reply.code(400).send(createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Missing path parameter'));
      return;
    }

    const validated = validateSessionFilePath(workingDir, filePath);
    if (!validated) {
      reply.code(404).send(createErrorResponse(ApiErrorCode.NOT_FOUND, 'File not found'));
      return;
    }

    const ext = filePath.split('.').pop()?.toLowerCase() || '';
    if (!isSupportedAttachmentExtension(ext)) {
      reply
        .code(400)
        .send(createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Thumbnail is not supported for this file type'));
      return;
    }

    await serveThumbnail(reply, validated.resolvedPath, ext);
  });

  // Stream file content via tail -f (SSE endpoint)
  app.get('/api/sessions/:id/tail-file', async (req, reply) => {
    const { id } = req.params as { id: string };
    const { path: filePath, lines } = req.query as { path?: string; lines?: string };
    const session = findSessionOrFail(ctx, id, req);

    if (!filePath) {
      reply.code(400).send(createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Missing path parameter'));
      return;
    }

    // Set up SSE headers
    reply.raw.writeHead(200, {
      ...inheritedHeaders(reply),
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    // Track stream for cleanup
    const streamRef: { id?: string } = {};

    // Create the file stream
    const result = await fileStreamManager.createStream({
      sessionId: id,
      filePath,
      workingDir: session.workingDir,
      lines: lines ? parseInt(lines, 10) : undefined,
      onData: (data) => {
        // Send data as SSE event
        reply.raw.write(`data: ${JSON.stringify({ type: 'data', content: data })}\n\n`);
      },
      onEnd: () => {
        reply.raw.write(`data: ${JSON.stringify({ type: 'end' })}\n\n`);
        reply.raw.end();
      },
      onError: (error) => {
        reply.raw.write(`data: ${JSON.stringify({ type: 'error', error })}\n\n`);
      },
    });

    if (!result.success) {
      reply.raw.write(`data: ${JSON.stringify({ type: 'error', error: result.error })}\n\n`);
      reply.raw.end();
      return;
    }

    streamRef.id = result.streamId;

    // Notify client of successful connection
    reply.raw.write(`data: ${JSON.stringify({ type: 'connected', streamId: result.streamId, filePath })}\n\n`);

    // Handle client disconnect
    req.raw.on('close', () => {
      if (streamRef.id) {
        fileStreamManager.closeStream(streamRef.id);
      }
    });
  });

  // Close a file stream. Returns { closed } rather than { success: closed } —
  // a top-level `success` key would collide with the envelope discriminator
  // (the preSerialization hook would pass `{success:false}` through as a
  // malformed error envelope instead of wrapping it).
  app.delete('/api/sessions/:id/tail-file/:streamId', async (req) => {
    const { id, streamId } = req.params as { id: string; streamId: string };
    findSessionOrFail(ctx, id, req); // Validates session exists
    const closed = fileStreamManager.closeStream(streamId);
    return { closed };
  });
  // Session-scoped file download.
  // Uses the same realpath-based workspace boundary as file preview/raw routes;
  // the shared sensitive-path blocklist (../sensitive-path.js, also used by the
  // attachment guard) remains defense-in-depth, not the primary boundary.
  app.get('/api/download', async (req, reply) => {
    const { path: filePath, sessionId } = req.query as { path?: string; sessionId?: string };

    if (!filePath) {
      reply.code(400).send(createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Missing path parameter'));
      return;
    }

    if (!sessionId) {
      reply.code(400).send(createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Missing sessionId parameter'));
      return;
    }

    const session = findSessionOrFail(ctx, sessionId, req);
    const validated = validateSessionFilePath(session.workingDir, filePath);
    if (!validated) {
      reply.code(404).send(createErrorResponse(ApiErrorCode.NOT_FOUND, 'File not found'));
      return;
    }
    const { resolvedPath } = validated;

    // Check sensitive path blocklist
    if (isSensitivePath(resolvedPath)) {
      reply.code(403).send(createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Access to this file is blocked'));
      return;
    }

    try {
      const stat = await fs.stat(resolvedPath);

      if (!stat.isFile()) {
        reply.code(400).send(createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Path is not a file'));
        return;
      }

      if (exceedsDownloadLimit(stat.size)) {
        reply.code(413).send(createErrorResponse(ApiErrorCode.INVALID_INPUT, downloadTooLargeMessage(stat.size)));
        return;
      }

      const ext = filePath.split('.').pop()?.toLowerCase() || '';
      const mimeTypes: Record<string, string> = {
        png: 'image/png',
        jpg: 'image/jpeg',
        jpeg: 'image/jpeg',
        gif: 'image/gif',
        webp: 'image/webp',
        svg: 'image/svg+xml',
        pdf: 'application/pdf',
        json: 'application/json',
        txt: 'text/plain',
        md: 'text/markdown',
        csv: 'text/csv',
        xml: 'application/xml',
        zip: 'application/zip',
        gz: 'application/gzip',
        tar: 'application/x-tar',
      };

      const filename = pathBasename(resolvedPath);
      // Streamed rather than read into memory, and Range-aware, so a multi-GB
      // artifact costs one read stream and can be resumed. sendFileBody()
      // hijacks the reply, which also keeps Fastify's compression out of it.
      reply.header('Content-Type', mimeTypes[ext] || 'application/octet-stream');
      reply.header('Content-Disposition', buildContentDisposition('attachment', filename));
      reply.header('X-Content-Type-Options', 'nosniff');
      sendFileBody(reply, resolvedPath, stat.size, req.headers.range);
      return;
    } catch (err) {
      reply
        .code(500)
        .send(createErrorResponse(ApiErrorCode.OPERATION_FAILED, `Failed to read file: ${getErrorMessage(err)}`));
    }
  });
}
