/**
 * @fileoverview Prompt-upload document list parity: server ⇄ browser copies.
 *
 * The server admits a document upload by extension through
 * `ALLOWED_DOCUMENT_EXTS` (session-routes.ts). The browser cannot import it, so
 * the list is copied by hand into:
 *
 *  - `_promptAttachKind()` (image-input.js), the one classifier every pick,
 *    drop and paste reads: an extension missing there is dropped client-side
 *    with "Unsupported file type", an extra one uploads only to be refused.
 *  - the `accept=` of the toolbar Attach input (index.html `#attachFileInput`)
 *    and of the two Compose / paste-dialog pickers (keyboard-accessory.js
 *    `.paste-file-input`): an extension missing there is greyed out in the
 *    picker, so the user cannot pick the file at all.
 *  - the two file-path link patterns (constants.js): an uploaded document's
 *    path lands on the prompt and comes back in the agent's output, and an
 *    extension missing there leaves that path as plain text. tsv and zip were
 *    added there by hand once already.
 *
 * Same idea as test/media-extension-parity.test.ts: the server set is imported,
 * the browser copies are read from the shipped files. The classifier and the
 * link patterns are run, not just read. No port needed.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';
import { ALLOWED_DOCUMENT_EXTS } from '../src/web/routes/session-routes.js';

const PUBLIC = resolve(import.meta.dirname, '../src/web/public');
const read = (f: string) => readFileSync(resolve(PUBLIC, f), 'utf8');

/** Server extensions without the dot, e.g. `pdf`. */
const DOCUMENT_EXTS = [...ALLOWED_DOCUMENT_EXTS].map((e) => e.replace(/^\./, '')).sort();

/** The document extensions an `accept=` value lists (the `image/*` and `video/*` entries dropped). */
function acceptDocumentExts(accept: string): string[] {
  return accept
    .split(',')
    .map((t) => t.trim())
    .filter((t) => t.startsWith('.'))
    .map((t) => t.slice(1))
    .sort();
}

/** The non-extension tokens of an `accept=` value (MIME patterns such as `image/*`), sorted. */
function acceptOtherTokens(accept: string): string[] {
  return accept
    .split(',')
    .map((t) => t.trim())
    .filter((t) => t && !t.startsWith('.'))
    .sort();
}

/**
 * The only MIME patterns a prompt picker offers. A wildcard such as `text/*` here would
 * let the picker hand over files the extension list above never names, which the
 * extension check alone cannot see.
 */
const PICKER_MIME_TOKENS = ['image/*', 'video/*'];

type AttachKind = (file: { name: string; type: string }) => string | null;

function loadPromptAttachKind(): { kind: AttachKind; method: string } {
  const source = read('image-input.js');
  const context = vm.createContext({});
  vm.runInContext('class CodemanApp {}', context);
  vm.runInContext(source, context, { filename: 'image-input.js' });
  const app = new (vm.runInContext('CodemanApp', context) as new () => { _promptAttachKind: AttachKind })();
  // The live method's own text, comments stripped, so a stale copy elsewhere cannot stand in for it.
  const method = app._promptAttachKind.toString().replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
  return { kind: (file) => app._promptAttachKind(file), method };
}

describe('prompt-upload document list parity (ALLOWED_DOCUMENT_EXTS ⇄ browser copies)', () => {
  it('image-input.js _promptAttachKind classifies every server document extension as a document', () => {
    const { kind } = loadPromptAttachKind();
    // No MIME: the extension alone decides, as on the server.
    const missing = DOCUMENT_EXTS.filter((ext) => kind({ name: `report.${ext}`, type: '' }) !== 'document');
    expect(missing, `image-input.js _promptAttachKind() does not classify as document: ${missing.join(', ')}`).toEqual(
      []
    );
  });

  it('image-input.js _promptAttachKind lists no document extension the server refuses', () => {
    const { kind, method } = loadPromptAttachKind();
    const found = [...method.matchAll(/if \(\[([^\]]+)\]\.includes\(ext\)\) \{\s*return 'document';/g)];
    expect(found.length, 'expected one document extension list in image-input.js _promptAttachKind()').toBe(1);
    // A second document branch (`if (ext === 'rtf') return 'document';`) would slip past the
    // list check above, so the method may return 'document' from exactly one place.
    const returns = method.match(/return 'document'/g) ?? [];
    expect(returns.length, "image-input.js _promptAttachKind() must return 'document' from one place only").toBe(1);
    const clientExts = [...found[0][1].matchAll(/'([^']+)'/g)].map((q) => q[1]);
    // And it is the list that actually returns 'document'.
    for (const ext of clientExts) expect(kind({ name: `report.${ext}`, type: '' })).toBe('document');
    expect(clientExts.sort(), 'image-input.js _promptAttachKind() document list').toEqual(DOCUMENT_EXTS);
  });

  it('index.html #attachFileInput accept= lists exactly the server document extensions', () => {
    const input = new JSDOM(read('index.html')).window.document.getElementById('attachFileInput');
    expect(input, '#attachFileInput not found in index.html').not.toBeNull();
    const accept = input!.getAttribute('accept') ?? '';
    expect(acceptDocumentExts(accept), 'index.html #attachFileInput accept=').toEqual(DOCUMENT_EXTS);
    expect(acceptOtherTokens(accept), 'index.html #attachFileInput accept= MIME patterns').toEqual(PICKER_MIME_TOKENS);
  });

  it('keyboard-accessory.js: both .paste-file-input accept= list exactly the server document extensions', () => {
    const accepts = [...read('keyboard-accessory.js').matchAll(/class="paste-file-input" accept="([^"]*)"/g)].map(
      (m) => m[1]
    );
    // The Compose picker and the paste dialog's picker.
    expect(accepts.length, 'expected two .paste-file-input pickers in keyboard-accessory.js').toBe(2);
    accepts.forEach((accept, i) => {
      expect(acceptDocumentExts(accept), `keyboard-accessory.js .paste-file-input #${i + 1} accept=`).toEqual(
        DOCUMENT_EXTS
      );
      expect(
        acceptOtherTokens(accept),
        `keyboard-accessory.js .paste-file-input #${i + 1} accept= MIME patterns`
      ).toEqual(PICKER_MIME_TOKENS);
    });
  });

  describe('constants.js file-path link patterns link an uploaded document path', () => {
    const context = vm.createContext({});
    vm.runInContext(
      `${read('constants.js')}\nglobalThis.__p = { FILE_PATH_LINK_PATTERN, RELATIVE_FILE_PATH_LINK_PATTERN };`,
      context,
      { filename: 'constants.js' }
    );
    const { FILE_PATH_LINK_PATTERN, RELATIVE_FILE_PATH_LINK_PATTERN } = (
      context as unknown as { __p: Record<string, RegExp> }
    ).__p;

    it('FILE_PATH_LINK_PATTERN matches a rooted path for every document extension', () => {
      const missing = DOCUMENT_EXTS.filter((ext) => {
        const path = `/home/u/case/.codeman-uploads/paste-1-ab-report.${ext}`;
        return new RegExp(FILE_PATH_LINK_PATTERN.source, 'g').exec(path)?.[1] !== path;
      });
      expect(missing, `constants.js FILE_PATH_LINK_PATTERN does not link: ${missing.join(', ')}`).toEqual([]);
    });

    it('RELATIVE_FILE_PATH_LINK_PATTERN matches a relative path for every document extension', () => {
      const missing = DOCUMENT_EXTS.filter((ext) => {
        const path = `.codeman-uploads/paste-1-ab-report.${ext}`;
        return new RegExp(RELATIVE_FILE_PATH_LINK_PATTERN.source, 'g').exec(`saved ${path}`)?.[2] !== path;
      });
      expect(missing, `constants.js RELATIVE_FILE_PATH_LINK_PATTERN does not link: ${missing.join(', ')}`).toEqual([]);
    });
  });
});
