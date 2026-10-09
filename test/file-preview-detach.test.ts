/**
 * @fileoverview File viewer detach button: pop the previewed file into a browser tab.
 *
 * The header used to end in [copy ⎘] [close ×], and for a PDF/media preview the
 * copy button was completely dead: `filePreviewContent` stays empty for those
 * branches, the `if (content)` guard swallowed the click, and the ⎘ glyph reads
 * as a pop-out icon — so the visible symptom was "the detach button next to the
 * X does nothing". There is now a real detach button (`filePreviewDetachBtn`)
 * that opens the preview's own raw/preview route in a new tab, and the copy
 * button toasts instead of silently doing nothing.
 *
 * What is pinned here:
 *   1. opening a workspace PDF arms the detach URL (file-raw) and reveals the button,
 *   2. an attachment docx/pptx detaches through the converted-PDF /preview route,
 *      other attachments through /raw,
 *   3. detach opens the URL, severs opener, and closes the overlay,
 *   4. a blocked pop-up (window.open → null) keeps the overlay up and toasts,
 *   5. closing the preview disarms the button (no stale URL for the next file),
 *   6. copy with no text buffer toasts instead of the old dead-button silence.
 *
 * Loaded via `vm` against a stub app, same harness style as
 * file-preview-media.test.ts (no jsdom).
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const PUBLIC = resolve(import.meta.dirname, '../src/web/public');
const panelsJs = readFileSync(resolve(PUBLIC, 'panels-ui.js'), 'utf8');

function loadApp() {
  const CodemanApp = function CodemanApp(this: unknown) {} as unknown as new () => Record<string, unknown>;
  const windowStub: Record<string, unknown> = { addEventListener: vi.fn(), open: vi.fn() };
  const context = vm.createContext({
    CodemanApp,
    console: { ...console, warn: vi.fn(), error: vi.fn() },
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    escapeHtml: (s: string) => String(s),
    // Reverse-proxy route builder from constants.js (not loaded here); identity at root.
    CodemanBase: { base: '', url: (p: string) => p },
    document: { getElementById: () => null, addEventListener: vi.fn() },
    window: windowStub,
    setTimeout,
    clearTimeout,
    confirm: () => true,
    fetch: () => {
      throw new Error('fetch not stubbed');
    },
  });
  vm.runInContext(panelsJs, context, { filename: 'panels-ui.js' });

  const body = {
    innerHTML: '',
    querySelectorAll: () => [] as unknown[],
    querySelector: () => null,
  };
  const overlay = {
    classes: new Set<string>(['visible']),
    classList: {
      add: (c: string) => overlay.classes.add(c),
      remove: (c: string) => overlay.classes.delete(c),
      contains: (c: string) => overlay.classes.has(c),
    },
  };
  const detachBtn = { hidden: true };
  const elements: Record<string, unknown> = {
    filePreviewBody: body,
    filePreviewOverlay: overlay,
    filePreviewTitle: { textContent: '' },
    filePreviewFooter: { textContent: '' },
    filePreviewDetachBtn: detachBtn,
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const app = new CodemanApp() as Record<string, any>;
  app.$ = (id: string) => elements[id] ?? null;
  app._resetFilePreviewEdit = () => {};
  app._isExternalPreviewPath = () => false;
  app.showToast = vi.fn();
  app.filePreviewContent = '';
  return { app, body, overlay, detachBtn, windowStub };
}

describe('file viewer detach button', () => {
  it('arms the detach URL and reveals the button for a workspace PDF', async () => {
    const { app, detachBtn, body } = loadApp();

    await app.openFilePreview('/ws/report.pdf', 's1');

    expect(app.filePreviewDetachUrl).toBe('/api/sessions/s1/file-raw?path=%2Fws%2Freport.pdf');
    expect(detachBtn.hidden).toBe(false);
    expect(body.innerHTML).toContain('<iframe');
  });

  it('routes attachment office docs through /preview and other attachments through /raw', async () => {
    const { app } = loadApp();

    await app.openFilePreview('/tmp/deck.pptx', 's1', 'att-1');
    expect(app.filePreviewDetachUrl).toBe('/api/sessions/s1/attachments/att-1/preview');

    await app.openFilePreview('/tmp/scan.pdf', 's1', 'att-2');
    expect(app.filePreviewDetachUrl).toBe('/api/sessions/s1/attachments/att-2/raw');
  });

  it('opens the URL, severs opener, and closes the overlay on detach', () => {
    const { app, overlay, windowStub } = loadApp();
    const win: Record<string, unknown> = { opener: {} };
    (windowStub.open as ReturnType<typeof vi.fn>).mockReturnValue(win);
    app.filePreviewDetachUrl = '/api/sessions/s1/file-raw?path=doc.pdf';

    app.detachFilePreview();

    expect(windowStub.open).toHaveBeenCalledWith('/api/sessions/s1/file-raw?path=doc.pdf', '_blank');
    expect(win.opener).toBeNull();
    expect(overlay.classList.contains('visible')).toBe(false);
  });

  it('keeps the overlay and toasts when the pop-up is blocked', () => {
    const { app, overlay, windowStub } = loadApp();
    (windowStub.open as ReturnType<typeof vi.fn>).mockReturnValue(null);
    app.filePreviewDetachUrl = '/api/sessions/s1/file-raw?path=doc.pdf';

    app.detachFilePreview();

    expect(overlay.classList.contains('visible')).toBe(true);
    expect(app.showToast).toHaveBeenCalledWith(expect.stringContaining('Pop-up blocked'), 'error');
  });

  it('hands the URL to a host window opener instead of window.open', () => {
    const { app, overlay, windowStub } = loadApp();
    app.openInHostWindow = vi.fn().mockReturnValue(true);
    app.filePreviewDetachUrl = '/api/sessions/s1/file-raw?path=doc.pdf';

    app.detachFilePreview();

    expect(app.openInHostWindow).toHaveBeenCalledWith('/api/sessions/s1/file-raw?path=doc.pdf');
    expect(windowStub.open).not.toHaveBeenCalled();
    expect(overlay.classList.contains('visible')).toBe(false);
  });

  it('keeps the overlay and toasts when the host could not open a window', () => {
    const { app, overlay, windowStub } = loadApp();
    app.openInHostWindow = vi.fn().mockReturnValue(false);
    app.filePreviewDetachUrl = '/api/sessions/s1/file-raw?path=doc.pdf';

    app.detachFilePreview();

    expect(windowStub.open).not.toHaveBeenCalled();
    expect(overlay.classList.contains('visible')).toBe(true);
    expect(app.showToast).toHaveBeenCalledWith(expect.stringContaining('Could not open'), 'error');
  });

  it('does nothing when no preview is armed', () => {
    const { app, windowStub } = loadApp();
    app.filePreviewDetachUrl = '';

    app.detachFilePreview();

    expect(windowStub.open).not.toHaveBeenCalled();
  });

  it('disarms the button when the preview closes', () => {
    const { app, detachBtn } = loadApp();
    app.filePreviewDetachUrl = '/api/sessions/s1/file-raw?path=doc.pdf';
    detachBtn.hidden = false;

    app.closeFilePreview();

    expect(app.filePreviewDetachUrl).toBe('');
    expect(detachBtn.hidden).toBe(true);
  });

  it('copy with no text buffer toasts instead of staying silent', () => {
    const { app } = loadApp();
    app.filePreviewContent = '';

    app.copyFilePreviewContent();

    expect(app.showToast).toHaveBeenCalledWith('Nothing to copy in this preview', 'info');
  });
});
