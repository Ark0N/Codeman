/**
 * @fileoverview File Viewer edit-mode policy (issue #212).
 *
 * Pure, IO-free policy for which workspace files the in-viewer editor may read
 * for editing and write back. Consumed by the `edit=1` branch of
 * `GET /api/sessions/:id/file-content` and by `PUT /api/sessions/:id/file-content`
 * in `src/web/routes/file-routes.ts`.
 *
 * Design (docs/file-viewer-edit-plan.md):
 * - ALLOWLIST of text extensions/basenames, not a blocklist — matching the
 *   attachment-guard precedent. `svg` and `env` are deliberately absent from
 *   the extension list: svg is treated as untrusted on the read side, and the
 *   list doubles as the attachment list, which must not gain `*.env`. Dotenv
 *   files (`.env`, `.env.*`, `*.env`) are editable by NAME in
 *   isEditableFileName instead: the plain preview already shows them, and the
 *   routes pass `allowDotenv` to the sensitive-path check, which keeps every
 *   other credential pattern.
 * - The `.git/` subtree is denied outright: `.git/hooks/*` is code execution and
 *   a corrupted index looks unrecoverable to a user who wanted to fix a typo.
 * - EOL helpers exist because a browser <textarea> normalizes to LF; the server
 *   re-applies the file's original ending so a two-line edit of a CRLF file does
 *   not become a whole-file diff. Mixed-EOL files normalize to the dominant
 *   style (documented lossy edge).
 */

/** Hard cap for edit-mode reads AND writes (bytes of file content). */
export const MAX_EDITABLE_BYTES = 512 * 1024;

/** Lowercase extensions (no dot) the editor will open and save. */
export const EDITABLE_EXTENSIONS: ReadonlySet<string> = new Set([
  // JS/TS ecosystem
  'ts',
  'tsx',
  'js',
  'jsx',
  'mjs',
  'cjs',
  'json',
  'jsonc',
  // Docs / plain text
  'md',
  'mdx',
  'txt',
  'rst',
  'adoc',
  // Web
  'css',
  'scss',
  'less',
  'html',
  'htm',
  'xml',
  // Config
  'yml',
  'yaml',
  'toml',
  'ini',
  'cfg',
  'conf',
  'properties',
  // Shell
  'sh',
  'bash',
  'zsh',
  'fish',
  // Languages
  'py',
  'rb',
  'go',
  'rs',
  'java',
  'kt',
  'swift',
  'c',
  'h',
  'cpp',
  'hpp',
  'cc',
  'cs',
  'php',
  'sql',
  'graphql',
  'proto',
  'lua',
  'pl',
  'r',
  'jl',
  'tf',
  'gradle',
  // Data / misc text
  'csv',
  'tsv',
  'log',
  'diff',
  'patch',
]);

/** Extensionless (or dot-led) file names that are still editable text. */
export const EDITABLE_BASENAMES: ReadonlySet<string> = new Set([
  'dockerfile',
  'makefile',
  'license',
  'readme',
  'changelog',
  'authors',
  'codeowners',
  'procfile',
  '.gitignore',
  '.gitattributes',
  '.dockerignore',
  '.prettierignore',
  '.prettierrc',
  '.editorconfig',
  '.nvmrc',
  '.npmrc',
  '.eslintignore',
]);

/** Whether a file name (basename only) is eligible for in-viewer editing. */
export function isEditableFileName(fileName: string): boolean {
  const lower = fileName.toLowerCase();
  if (EDITABLE_BASENAMES.has(lower)) return true;
  // Dotenv in every spelling, by name: `.env.local`'s extension is `local`, and
  // `env` must stay off EDITABLE_EXTENSIONS, which is also the cross-workspace
  // attachment list (TEXT_ATTACHMENT_EXTENSIONS) that never accepted `*.env`.
  if (lower.endsWith('.env') || lower.startsWith('.env.')) return true;
  const dot = lower.lastIndexOf('.');
  // No extension (or a bare dotfile like `.bashrc`): only the basename list applies.
  if (dot <= 0) return false;
  return EDITABLE_EXTENSIONS.has(lower.slice(dot + 1));
}

/**
 * Whether a workspace-relative path is denied for editing regardless of its
 * extension. Currently: anything inside a `.git` directory at any depth.
 */
export function isDeniedEditRelativePath(relativePath: string): boolean {
  return relativePath.split('/').some((segment) => segment === '.git');
}

export type FileEol = 'lf' | 'crlf';

/** Dominant line-ending style of a text buffer (LF when tied or single-line). */
export function detectEol(text: string): FileEol {
  let crlf = 0;
  let lf = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) {
      if (i > 0 && text.charCodeAt(i - 1) === 13) crlf++;
      else lf++;
    }
  }
  return crlf > lf ? 'crlf' : 'lf';
}

/** Normalize every line ending in `text` to the requested style. */
export function applyEol(text: string, eol: FileEol): string {
  const normalized = text.replace(/\r\n/g, '\n');
  return eol === 'crlf' ? normalized.replace(/\n/g, '\r\n') : normalized;
}
