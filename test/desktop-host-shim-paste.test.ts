/**
 * @fileoverview The Mac app's host shim refuses `document.execCommand('paste')`.
 *
 * Codeman's Cmd+V handler (`_handleImagePaste`, src/web/public/image-input.js)
 * calls `document.execCommand('paste')` on its hidden paste trap. In a
 * WKWebView WebKit answers that call with its "Paste" access menu and holds the
 * page until it is picked, so the key's own paste, which carries a copied
 * image, never reached the trap. The shim the app injects into every server
 * page (`HOST_SHIM`, packages/desktop/src/assets.rs) answers the command with
 * false, as Chromium does, and leaves every other command to WebKit.
 *
 * Runs the shim's real text, cut out of assets.rs, in a vm with a stub
 * Document, so a change to the Rust string is what these tests see.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const assetsRs = readFileSync(resolve(import.meta.dirname, '../packages/desktop/src/assets.rs'), 'utf8');
const shim = /pub const HOST_SHIM: &str = r#"([\s\S]*?)"#;/.exec(assetsRs)?.[1];

function load(protocol = 'https:') {
  if (!shim) throw new Error('HOST_SHIM not found in assets.rs');
  const nativeExec = vi.fn(function (this: unknown) {
    return true;
  });
  function Document() {}
  Document.prototype.execCommand = nativeExec;
  const document = Object.create(Document.prototype) as { execCommand: (...args: unknown[]) => boolean };
  const sandbox: Record<string, unknown> = {
    Document,
    document,
    URL,
    location: { protocol, href: `${protocol}//atlas.example/`, origin: `${protocol}//atlas.example` },
    addEventListener: vi.fn(),
    open: vi.fn(),
    fetch: vi.fn(),
    ipc: { postMessage: vi.fn() },
  };
  sandbox.window = sandbox;
  vm.runInNewContext(shim, sandbox);
  return { document, nativeExec, sandbox };
}

describe('desktop host shim: execCommand paste', () => {
  it('answers paste with false and never asks WebKit', () => {
    const { document, nativeExec } = load();
    expect(document.execCommand('paste')).toBe(false);
    expect(document.execCommand('Paste')).toBe(false);
    expect(nativeExec).not.toHaveBeenCalled();
  });

  it('hands every other command to WebKit with its arguments and document', () => {
    const { document, nativeExec } = load();
    expect(document.execCommand('copy')).toBe(true);
    expect(document.execCommand('insertText', false, 'hi')).toBe(true);
    expect(nativeExec).toHaveBeenNthCalledWith(1, 'copy');
    expect(nativeExec).toHaveBeenNthCalledWith(2, 'insertText', false, 'hi');
    expect(nativeExec.mock.contexts[0]).toBe(document);
  });

  it('leaves a page that is not http(s) alone', () => {
    const { document, nativeExec } = load('file:');
    expect(document.execCommand('paste')).toBe(true);
    expect(nativeExec).toHaveBeenCalledWith('paste');
  });
});
