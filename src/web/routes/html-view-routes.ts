/**
 * @fileoverview Render a local HTML file (an agent's report, a generated page) as a
 * page instead of as source text.
 *
 * Routes:
 * - `POST /api/sessions/:id/html-view` (authenticated) — `{ path }` of an `.html` file;
 *   returns `{ url }`, an `/html-view/<cap>/<file>` URL for that file.
 * - `GET /html-view/:cap/*` (capability) — the HTML file and its sibling assets.
 *
 * ⚠️ Every response carries `Content-Security-Policy: sandbox ...` WITHOUT
 * `allow-same-origin`, so the page runs in an opaque origin whether it is framed or
 * opened as a top-level tab: it can run its own scripts but cannot read the Codeman
 * document, its cookies or its API. That is what makes rendering safe at all; see
 * html-view-capabilities.ts for why the route authenticates on a capability.
 * Network access is deliberately OPEN (owner decision, see {@link HTML_VIEW_CSP}).
 *
 * Path policy: the HTML file itself is admitted like the file preview admits a file
 * (inside the session workspace, or outside it under the attachment guard), and the
 * capability then serves ONLY the files in that file's own directory tree, filtered
 * by the same blocklist plus an asset-extension allowlist and a no-dotfile rule, so
 * a page cannot use its own directory to pull a `.env` out through the browser.
 * Because that tree is served recursively, minting is refused for an HTML file in a
 * hidden directory or directly in a broad root (`/`, home, `/tmp`, `/var/tmp` and
 * `$TMPDIR`, the cases and user-space roots, a drive's mount point) or in a
 * directory above one, see {@link isBroadHtmlViewRoot}.
 */

import type { FastifyInstance } from 'fastify';
import { realpathSync } from 'node:fs';
import fs from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { ApiErrorCode, createErrorResponse } from '../../types.js';
import { isBlockedAttachmentPath, isUnderTree, loadAttachmentGuardConfig } from '../../config/attachment-guard.js';
import { HTML_VIEW_PREFIX, htmlViewCapabilities } from '../../html-view-capabilities.js';
import { CASES_DIR, findSessionOrFail, ownerFor, parseBody, validateSessionFilePath } from '../route-helpers.js';
import { HtmlViewOpenSchema } from '../schemas.js';
import { DOCKER_HOME_PATH_ERROR, localFileSource, sendFileBody } from './file-routes.js';
import { getUserSpacesDir } from '../../config/multiuser.js';
import { exceedsDownloadLimit } from '../../config/buffer-limits.js';
import type { SessionPort } from '../ports/index.js';

/** Extensions that open as a rendered page. */
export const HTML_VIEW_EXTENSIONS: ReadonlySet<string> = new Set(['html', 'htm']);

/** What a rendered page may load from its own directory, with the type it is served as. */
const ASSET_TYPES: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  htm: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  json: 'application/json; charset=utf-8',
  map: 'application/json; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
  csv: 'text/csv; charset=utf-8',
  md: 'text/plain; charset=utf-8',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  ico: 'image/x-icon',
  bmp: 'image/bmp',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
  wasm: 'application/wasm',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  pdf: 'application/pdf',
};

/**
 * The whole Content-Security-Policy every response is served under: the `sandbox`
 * directive and nothing else. It REPLACES Codeman's own policy (`default-src 'self'`
 * and the rest, set earlier by registerSecurityHeaders). No `allow-same-origin`:
 * that one token is the difference between "a page" and "a page that can drive
 * Codeman".
 *
 * ⚠️ Network access is OPEN, by the owner's decision (2026-10-13, #547): a rendered
 * page behaves like a file opened from disk in a browser, so there is deliberately
 * no fetch directive (`default-src`, `script-src`, `connect-src`, ...). It loads
 * scripts, styles, fonts, images and media from anywhere (an agent's dashboard
 * pulling Chart.js from a CDN) and may fetch, XHR, open WebSockets, send beacons and
 * post forms anywhere. What confines it is the opaque origin (no Codeman cookies, no
 * Codeman API) and the capability serving only its own folder. Do not add a fetch
 * directive, or `allow-same-origin`, without the owner. test/routes/html-view-routes.test.ts
 * pins the exact value.
 */
export const HTML_VIEW_CSP = 'sandbox allow-scripts allow-forms allow-popups allow-modals allow-downloads';

function extensionOf(path: string): string {
  return extname(path).toLowerCase().replace(/^\./, '');
}

/** realpath when the path exists, else the plain resolved path. */
function canonical(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/**
 * The shared temp dirs, named literally: `os.tmpdir()` is `$TMPDIR` whenever that
 * is set, and macOS sets it in every terminal session (`/var/folders/.../T`), so
 * a server started from one would otherwise never see `/tmp` as broad.
 */
const SHARED_TEMP_DIRS = ['/tmp', '/var/tmp'];

/**
 * Where drives are mounted. A page at a drive's root (WSL's `/mnt/d/report.html`)
 * would be handed the whole drive, so the mount parent and each mount point in it
 * count as broad.
 */
const MOUNT_PARENTS = ['/mnt', '/media', '/Volumes'];

/**
 * Whether a directory is too broad to hand to a page as its asset root. The
 * capability serves the HTML file's directory RECURSIVELY to the page's own
 * scripts, so `/tmp/report.html` would expose every other session's scratch
 * output under `/tmp`, and `~/report.html` the home tree. Refuse those roots
 * (and the cases / user-space roots, which hold every workspace) outright, and
 * any directory ABOVE one of them (`/home`, `/Users`, macOS's `/private`), since
 * serving it recursively serves the root below it too.
 */
export function isBroadHtmlViewRoot(dir: string): boolean {
  const target = canonical(dir);
  const userSpaces = canonical(getUserSpacesDir());
  // canonical() also maps the literal temp dirs to macOS's `/private/tmp` and `/private/var/tmp`.
  const broad = [sep, homedir(), tmpdir(), ...SHARED_TEMP_DIRS, CASES_DIR, userSpaces].map(canonical);
  if (broad.some((root) => isUnderTree(root, target))) return true;
  for (const parent of MOUNT_PARENTS.map(canonical)) {
    if (target === parent || dirname(target) === parent) return true;
  }
  // A user's own space (`<spaces>/<user>`) and its cases dir hold every workspace of that user.
  if (dirname(target) === userSpaces) return true;
  return basename(target) === 'cases' && dirname(dirname(target)) === userSpaces;
}

export function registerHtmlViewRoutes(app: FastifyInstance, ctx: SessionPort): void {
  app.post('/api/sessions/:id/html-view', async (req, reply) => {
    const { id } = req.params as { id: string };
    const session = findSessionOrFail(ctx, id, req);
    const body = parseBody(HtmlViewOpenSchema, req.body ?? {});
    if (session.remote) {
      reply
        .code(400)
        .send(createErrorResponse(ApiErrorCode.INVALID_INPUT, 'HTML pages in a remote (SSH) case cannot be rendered'));
      return;
    }
    if (!HTML_VIEW_EXTENSIONS.has(extensionOf(body.path))) {
      reply.code(400).send(createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Not an HTML file'));
      return;
    }
    // A `~/` link (the terminal passes a home-relative path through, since only
    // the server knows the home) is this host's home, as the attachment route
    // expands it. A Docker case's `~` is the container's, so it is refused there.
    let requestedPath = body.path;
    if (requestedPath.startsWith('~/')) {
      if (session.docker) {
        reply.code(400).send(createErrorResponse(ApiErrorCode.INVALID_INPUT, DOCKER_HOME_PATH_ERROR));
        return;
      }
      requestedPath = join(homedir(), requestedPath.slice(2));
    }

    // Inside the workspace: the same check every file route uses. Outside it: the
    // attachment guard, exactly as an external file preview is admitted.
    let resolvedPath: string;
    const inWorkspace = validateSessionFilePath(session.workingDir, requestedPath);
    if (inWorkspace) {
      resolvedPath = inWorkspace.resolvedPath;
    } else {
      if (!isAbsolute(requestedPath)) {
        reply.code(404).send(createErrorResponse(ApiErrorCode.NOT_FOUND, 'File not found'));
        return;
      }
      try {
        resolvedPath = await fs.realpath(requestedPath);
      } catch {
        reply.code(404).send(createErrorResponse(ApiErrorCode.NOT_FOUND, 'File not found'));
        return;
      }
      const guard = await loadAttachmentGuardConfig();
      if (guard.confineToWorkspace || isBlockedAttachmentPath(resolvedPath, guard.blockedTrees)) {
        reply.code(403).send(createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Access to this file is blocked'));
        return;
      }
    }

    const stat = await fs.stat(resolvedPath).catch(() => null);
    if (!stat?.isFile()) {
      reply.code(404).send(createErrorResponse(ApiErrorCode.NOT_FOUND, 'File not found'));
      return;
    }
    // The page URL names the RESOLVED file, so it has to be HTML too: a
    // `report.html -> notes.txt` link would otherwise mint a page for a text file.
    if (!HTML_VIEW_EXTENSIONS.has(extensionOf(resolvedPath))) {
      reply.code(400).send(createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Not an HTML file'));
      return;
    }

    // The serving route never descends into a dot segment below the capability
    // root; the HTML file's own path gets the same rule, or `.cache/r.html` would
    // mint a capability over a hidden directory and serve its `token.json`. Inside
    // the workspace the rule covers the part below the workspace root, which is
    // all the page's tree can reach, so a workspace that itself lives under a
    // hidden folder (`~/.local/src/app`) can still render its pages.
    const checkedPath = inWorkspace ? inWorkspace.relativePath : resolvedPath;
    if (checkedPath.split(sep).some((segment) => segment.startsWith('.'))) {
      reply
        .code(403)
        .send(createErrorResponse(ApiErrorCode.INVALID_INPUT, 'HTML files in hidden directories cannot be rendered'));
      return;
    }
    if (isBroadHtmlViewRoot(dirname(resolvedPath))) {
      reply
        .code(403)
        .send(
          createErrorResponse(
            ApiErrorCode.INVALID_INPUT,
            'This folder is too broad to render a page from; move the HTML file into its own folder'
          )
        );
      return;
    }

    const cap = htmlViewCapabilities.mint(dirname(resolvedPath), ownerFor(req), !inWorkspace);
    return {
      success: true,
      data: { url: `${HTML_VIEW_PREFIX}/${cap}/${encodeURIComponent(basename(resolvedPath))}` },
    };
  });

  app.get(`${HTML_VIEW_PREFIX}/:cap/*`, async (req, reply) => {
    const { cap, '*': rest } = req.params as { cap: string; '*': string };
    const record = htmlViewCapabilities.resolve(cap);
    const notFound = () => reply.code(404).header('Content-Type', 'text/plain; charset=utf-8').send('Not found');
    if (!record) return notFound();

    // Fastify has already percent-decoded the wildcard. Hidden files and
    // directories are never served, whatever their extension. This is the cheap
    // reject on the requested name; the same two rules run again on the resolved
    // path below.
    const segments = (rest || '').split('/').filter(Boolean);
    if (segments.length === 0 || segments.some((s) => s.startsWith('.'))) return notFound();
    if (!ASSET_TYPES[extensionOf(segments[segments.length - 1])]) return notFound();

    let resolvedPath: string;
    try {
      resolvedPath = await fs.realpath(resolve(record.rootDir, segments.join(sep)));
    } catch {
      return notFound();
    }
    // Symlinks are resolved above, so this is the real containment check, and the
    // dot and extension rules have to hold for where a link LANDS as well: a
    // `cfg.json -> .git/config` inside the page's folder passes both on its own name.
    if (!isUnderTree(resolvedPath, record.rootDir)) return notFound();
    const landed = relative(record.rootDir, resolvedPath).split(sep);
    if (landed.some((s) => s.startsWith('.'))) return notFound();
    // Typed by what the bytes are, the resolved name.
    const contentType = ASSET_TYPES[extensionOf(resolvedPath)];
    if (!contentType) return notFound();
    const guard = await loadAttachmentGuardConfig();
    if (isBlockedAttachmentPath(resolvedPath, guard.blockedTrees)) return notFound();
    // Re-checked per request, like the attachment serve path (file-routes.ts): a
    // page minted from outside the workspace before an admin switched confinement
    // on stops serving once it is on, instead of living out its capability.
    if (record.outsideWorkspace && guard.confineToWorkspace) return notFound();

    const stat = await fs.stat(resolvedPath).catch(() => null);
    if (!stat?.isFile() || exceedsDownloadLimit(stat.size)) return notFound();

    reply.header('Content-Security-Policy', HTML_VIEW_CSP);
    reply.header('Content-Type', contentType);
    reply.header('Cache-Control', 'no-store');
    reply.header('Referrer-Policy', 'no-referrer');
    // The sandboxed page is opaque-origin, so even its fetch() of a sibling
    // `data.json` is CORS-checked with `Origin: null`. `*` without credentials is
    // enough, and widens nothing: these bytes are already readable by anyone
    // holding the capability URL.
    reply.header('Access-Control-Allow-Origin', '*');
    // The file routes' body sender: Content-Length, and `Range` answered with 206
    // (or 416), so a page's own <video>/<audio> can seek. It hijacks the reply, and
    // carries every header set above across to it.
    sendFileBody(reply, stat.size, req.headers.range, localFileSource(resolvedPath));
    return reply;
  });
}
