/**
 * @fileoverview CI-visible coverage for the manual mobile prompt composer.
 *
 * The Playwright mobile suite is excluded from the CI gate, so the behaviors
 * most likely to regress live here against the real browser module: native
 * textarea replacement, local-echo adoption, per-session drafts, bracketed
 * multiline delivery and image-path insertion.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { JSDOM } from 'jsdom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const accessorySource = readFileSync(resolve('src/web/public/keyboard-accessory.js'), 'utf8');
const appSource = readFileSync(resolve('src/web/public/app.js'), 'utf8');

type Timer = { callback: () => void; delay: number };

function loadComposer(sessionId = 'session-1') {
  const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', { url: 'https://localhost/' });
  const window = dom.window;
  const timers: Timer[] = [];
  const localEcho = {
    pendingText: '',
    clear: vi.fn(() => {
      localEcho.pendingText = '';
    }),
    suppressBufferDetection: vi.fn(),
  };
  const app = {
    activeSessionId: sessionId,
    sessions: new Map([
      ['session-1', { mode: 'claude' }],
      ['session-2', { mode: 'claude' }],
    ]),
    terminal: { paste: vi.fn(), focus: vi.fn(), modes: { bracketedPasteMode: true } },
    _localEchoEnabled: true,
    _localEchoOverlay: localEcho,
    _flushedOffsets: new Map<string, number>(),
    _flushedTexts: new Map<string, string>(),
    _echoPassthroughSessions: new Set<string>(),
    _predictiveEcho: { clearPredictions: vi.fn() },
    _sendInputAsync: vi.fn(),
    _uploadAndInsertImages: vi.fn(async () => ['/tmp/image-one.png']),
    showToast: vi.fn(),
  };
  const schedule = (callback: () => void, delay = 0) => {
    timers.push({ callback, delay });
    return timers.length;
  };
  const factory = new Function(
    'window',
    'document',
    'Event',
    'app',
    'MobileDetection',
    'URLSearchParams',
    'fetch',
    'setTimeout',
    'clearTimeout',
    'requestAnimationFrame',
    `${accessorySource}\nreturn KeyboardAccessoryBar;`
  );
  const bar = factory(
    window,
    window.document,
    window.Event,
    app,
    { isTouchDevice: () => true },
    window.URLSearchParams,
    vi.fn(),
    schedule,
    vi.fn(),
    (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    }
  );

  return {
    app,
    bar,
    document: window.document,
    localEcho,
    timers,
    runTimers() {
      for (const timer of timers.splice(0)) timer.callback();
    },
  };
}

function textarea(document: Document): HTMLTextAreaElement {
  return document.querySelector('.prompt-composer-textarea') as HTMLTextAreaElement;
}

function mountComposeButton(bar: any, document: Document): HTMLButtonElement {
  bar.element = document.createElement('div');
  bar.element.innerHTML = bar._simpleButtons;
  document.body.appendChild(bar.element);
  bar._syncComposerDraftIndicator();
  return bar.element.querySelector('[data-action="compose"]') as HTMLButtonElement;
}

describe('mobile prompt composer', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('replaces Paste with Compose on agent bars while shell keeps direct Paste', () => {
    const template = (name: string) => accessorySource.match(new RegExp(name + '\\s*:\\s*`([\\s\\S]*?)`'))?.[1] ?? '';

    expect(template('_simpleButtons')).toContain('data-action="compose"');
    expect(template('_simpleButtons')).not.toContain('data-action="paste"');
    expect(template('_extendedButtons')).toContain('data-action="compose"');
    expect(template('_extendedButtons')).not.toContain('data-action="paste"');
    expect(template('_shellButtons')).toContain('data-action="paste"');
    expect(template('_shellButtons')).not.toContain('data-action="compose"');
  });

  it('uses a compact accessible icon for Compose in both agent layouts', () => {
    const { bar, document } = loadComposer();

    for (const markup of [bar._simpleButtons, bar._extendedButtons]) {
      const wrapper = document.createElement('div');
      wrapper.innerHTML = markup;
      const button = wrapper.querySelector('[data-action="compose"]') as HTMLButtonElement;

      expect(button.getAttribute('aria-label')).toBe('Compose prompt');
      expect(button.getAttribute('title')).toBe('Compose prompt');
      expect(button.querySelector('svg[aria-hidden="true"]')).not.toBeNull();
      expect(button.textContent?.trim()).toBe('');
    }
  });

  it('uses a native autocorrect-aware textarea and stores replacement text exactly once', () => {
    const { app, bar, document } = loadComposer();
    bar.composePrompt();
    const input = textarea(document);

    expect(input.getAttribute('autocorrect')).toBe('on');
    expect(input.getAttribute('autocapitalize')).toBe('sentences');
    expect(input.getAttribute('spellcheck')).toBe('true');

    input.value = 'Please fix teh bug';
    input.dispatchEvent(new document.defaultView!.Event('input', { bubbles: true }));
    input.value = 'Please fix the bug';
    input.dispatchEvent(new document.defaultView!.Event('input', { bubbles: true }));
    (document.querySelector('.paste-cancel') as HTMLButtonElement).click();

    bar.composePrompt();
    expect(textarea(document).value).toBe('Please fix the bug');
    expect(app.terminal.paste).not.toHaveBeenCalled();
    expect(app._sendInputAsync).not.toHaveBeenCalled();
  });

  it('adopts and clears locally-buffered terminal input on open', () => {
    const { app, bar, document, localEcho } = loadComposer();
    localEcho.pendingText = '-written prompt';
    app._flushedOffsets.set('session-1', 4);
    app._flushedTexts.set('session-1', 'half');

    bar.composePrompt();

    expect(textarea(document).value).toBe('half-written prompt');
    expect(app._sendInputAsync).toHaveBeenCalledWith('session-1', '\x7f'.repeat(4), { useMux: true });
    expect(localEcho.clear).toHaveBeenCalledOnce();
    expect(localEcho.suppressBufferDetection).toHaveBeenCalledOnce();
    expect(app._flushedOffsets.has('session-1')).toBe(false);
    expect(app._flushedTexts.has('session-1')).toBe(false);
  });

  it('uses Unicode code points when erasing flushed text', () => {
    const { app, bar, document } = loadComposer();
    app._flushedOffsets.set('session-1', 3);
    app._flushedTexts.set('session-1', 'a😀');

    bar.composePrompt();

    expect(textarea(document).value).toBe('a😀');
    expect(app._sendInputAsync).toHaveBeenCalledWith('session-1', '\x7f'.repeat(2), { useMux: true });
  });

  it('closes on tab switch and keeps drafts isolated by session', () => {
    const { app, bar, document } = loadComposer();
    const composeButton = mountComposeButton(bar, document);
    bar.composePrompt();
    textarea(document).value = 'first session draft';
    textarea(document).dispatchEvent(new document.defaultView!.Event('input', { bubbles: true }));
    expect(composeButton.classList.contains('has-draft')).toBe(true);

    app.activeSessionId = 'session-2';
    bar.refreshForActiveSession();
    expect(document.querySelector('.prompt-composer-overlay')).toBeNull();
    expect(composeButton.classList.contains('has-draft')).toBe(false);
    expect(() => bar.refreshForActiveSession()).not.toThrow();
    bar.composePrompt();
    expect(textarea(document).value).toBe('');
    textarea(document).value = 'second session draft';
    textarea(document).dispatchEvent(new document.defaultView!.Event('input', { bubbles: true }));
    (document.querySelector('.paste-cancel') as HTMLButtonElement).click();

    app.activeSessionId = 'session-1';
    bar.refreshForActiveSession();
    expect(composeButton.classList.contains('has-draft')).toBe(true);
    expect(composeButton.getAttribute('aria-label')).toBe('Compose prompt, draft saved');
    bar.composePrompt();
    expect(textarea(document).value).toBe('first session draft');
  });

  it('drops a draft and closes its composer when the session is deleted', () => {
    const { bar, document } = loadComposer();
    const composeButton = mountComposeButton(bar, document);
    bar.composePrompt();
    textarea(document).value = 'temporary secret';
    textarea(document).dispatchEvent(new document.defaultView!.Event('input', { bubbles: true }));
    expect(composeButton.classList.contains('has-draft')).toBe(true);

    bar.discardComposerDraft('session-1');

    expect(document.querySelector('.prompt-composer-overlay')).toBeNull();
    expect(composeButton.classList.contains('has-draft')).toBe(false);
    bar.composePrompt();
    expect(textarea(document).value).toBe('');
  });

  it('wires session cleanup to composer draft cleanup', () => {
    const cleanupStart = appSource.indexOf('  _cleanupSessionData(sessionId) {');
    expect(cleanupStart, '_cleanupSessionData not found — renamed?').toBeGreaterThan(-1);
    // The whole method, not a fixed byte window. A 1200-character slice made
    // this assertion depend on how much OTHER code sat above the line it cares
    // about, so an unrelated addition near the top of the method failed it.
    const cleanup = appSource.slice(cleanupStart, appSource.indexOf('\n  }\n', cleanupStart));
    expect(cleanup.length, 'method body did not terminate').toBeGreaterThan(0);

    expect(cleanup).toContain('KeyboardAccessoryBar.discardComposerDraft?.(sessionId)');
  });

  it('keeps Enter as a newline and sends multiline text once via bracketed paste plus delayed Enter', () => {
    const { app, bar, document, timers, runTimers } = loadComposer();
    const composeButton = mountComposeButton(bar, document);
    bar.composePrompt();
    const input = textarea(document);
    input.value = 'first line\nsecond line';
    input.dispatchEvent(new document.defaultView!.Event('input', { bubbles: true }));
    input.dispatchEvent(new document.defaultView!.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));

    expect(app.terminal.paste).not.toHaveBeenCalled();
    expect(app._sendInputAsync).not.toHaveBeenCalled();
    (document.querySelector('.paste-send') as HTMLButtonElement).click();

    expect(app.terminal.paste).not.toHaveBeenCalled();
    expect(app._sendInputAsync).toHaveBeenCalledOnce();
    expect(app._sendInputAsync).toHaveBeenNthCalledWith(1, 'session-1', '\x1b[200~first line\rsecond line\x1b[201~');
    expect(composeButton.classList.contains('has-draft')).toBe(false);
    expect(timers).toContainEqual(expect.objectContaining({ delay: 120 }));
    runTimers();
    expect(app._sendInputAsync).toHaveBeenNthCalledWith(2, 'session-1', '\r', { useMux: true });
    expect(document.querySelector('.prompt-composer-overlay')).toBeNull();

    bar.composePrompt();
    expect(textarea(document).value).toBe('');
  });

  it('sends after replay resets xterm’s mirrored bracketed-paste mode', () => {
    const { app, bar, document, runTimers } = loadComposer();
    app.terminal.modes.bracketedPasteMode = false;
    bar.composePrompt();
    textarea(document).value = 'still\nmultiline';
    textarea(document).dispatchEvent(new document.defaultView!.Event('input', { bubbles: true }));

    (document.querySelector('.paste-send') as HTMLButtonElement).click();

    expect(app.terminal.paste).not.toHaveBeenCalled();
    expect(app._sendInputAsync).toHaveBeenCalledWith('session-1', '\x1b[200~still\rmultiline\x1b[201~');
    expect(document.querySelector('.prompt-composer-overlay')).toBeNull();
    expect(app.showToast).not.toHaveBeenCalled();
    runTimers();
    expect(app._sendInputAsync).toHaveBeenLastCalledWith('session-1', '\r', { useMux: true });
  });

  it('releases echo passthrough after a composed prompt is queued', () => {
    const { app, bar, document } = loadComposer();
    app._echoPassthroughSessions.add('session-1');
    app._echoPassthroughSessions.add('session-2');
    bar.composePrompt();
    textarea(document).value = 'send from composer';

    (document.querySelector('.paste-send') as HTMLButtonElement).click();

    expect(app._echoPassthroughSessions.has('session-1')).toBe(false);
    expect(app._echoPassthroughSessions.has('session-2')).toBe(true);
  });

  it('keeps an oversized prompt as a draft instead of queueing a rejected frame', () => {
    const { app, bar, document } = loadComposer();
    bar.composePrompt();
    const input = textarea(document);
    input.value = 'x'.repeat(65525);
    input.dispatchEvent(new document.defaultView!.Event('input', { bubbles: true }));

    (document.querySelector('.paste-send') as HTMLButtonElement).click();

    expect(app._sendInputAsync).not.toHaveBeenCalled();
    expect(app.showToast).toHaveBeenCalledWith(expect.stringContaining('too long'), 'error');
    expect(document.querySelector('.prompt-composer-overlay')).not.toBeNull();
    expect(bar._composerDrafts.get('session-1')).toHaveLength(65525);
  });

  it('treats a whitespace-only draft as empty instead of submitting blank lines', () => {
    const { app, bar, document } = loadComposer();
    bar.composePrompt();
    textarea(document).value = ' \n\n ';

    (document.querySelector('.paste-send') as HTMLButtonElement).click();

    expect(app._sendInputAsync).not.toHaveBeenCalled();
    expect(document.querySelector('.prompt-composer-overlay')).not.toBeNull();
  });

  it('derives the prompt budget from the 64 KiB input frame minus both paste markers', () => {
    // ws-routes.ts drops a frame longer than MAX_INPUT_LENGTH without an ACK,
    // so a prompt of exactly the budget must produce a frame of exactly 64 KiB.
    const { app, bar, document } = loadComposer();
    expect(bar._composerMaxLength).toBe(64 * 1024 - '\x1b[200~\x1b[201~'.length);
    bar.composePrompt();
    textarea(document).value = 'y'.repeat(bar._composerMaxLength);

    (document.querySelector('.paste-send') as HTMLButtonElement).click();

    expect(app._sendInputAsync).toHaveBeenCalledOnce();
    expect((app._sendInputAsync.mock.calls[0][1] as string).length).toBe(64 * 1024);
    expect(app.showToast).not.toHaveBeenCalled();
  });

  it('preserves the draft and focuses xterm when Use terminal keyboard is chosen', () => {
    const { app, bar, document, localEcho, runTimers } = loadComposer();
    const composeButton = mountComposeButton(bar, document);
    bar.composePrompt();
    textarea(document).value = 'keep this';
    textarea(document).dispatchEvent(new document.defaultView!.Event('input', { bubbles: true }));
    (document.querySelector('.prompt-composer-terminal') as HTMLButtonElement).click();

    expect(app.terminal.focus).toHaveBeenCalledOnce();
    expect(composeButton.classList.contains('has-draft')).toBe(true);
    expect(composeButton.title).toBe('Resume saved prompt draft');
    runTimers();
    localEcho.pendingText = '; then continue';
    bar.composePrompt();
    expect(textarea(document).value).toBe('keep this; then continue');
  });

  it('uploads images without writing into the PTY and inserts their paths into the draft', async () => {
    const { app, bar, document } = loadComposer();
    let finishUpload!: (paths: string[]) => void;
    app._uploadAndInsertImages.mockImplementation(
      () => new Promise<string[]>((resolveUpload) => (finishUpload = resolveUpload))
    );
    bar.composePrompt();
    const input = textarea(document);
    input.value = 'review';
    input.selectionStart = input.selectionEnd = input.value.length;
    input.dispatchEvent(new document.defaultView!.Event('input', { bubbles: true }));
    const fileInput = document.querySelector('.paste-file-input') as HTMLInputElement;
    const image = new document.defaultView!.File(['image'], 'shot.png', { type: 'image/png' });
    Object.defineProperty(fileInput, 'files', { configurable: true, value: [image] });

    fileInput.dispatchEvent(new document.defaultView!.Event('change', { bubbles: true }));
    expect((document.querySelector('.paste-image') as HTMLButtonElement).disabled).toBe(true);
    expect((document.querySelector('.paste-send') as HTMLButtonElement).disabled).toBe(true);
    finishUpload(['/tmp/image-one.png']);
    await vi.waitFor(() => expect(input.value).toBe('review /tmp/image-one.png'));

    expect(app._uploadAndInsertImages).toHaveBeenCalledWith([image], { insert: false });
    expect((document.querySelector('.paste-send') as HTMLButtonElement).disabled).toBe(false);
    expect(app.terminal.paste).not.toHaveBeenCalled();
    expect(app._sendInputAsync).not.toHaveBeenCalled();
  });

  it('finishes an upload into a reopened composer without restoring a deleted session draft', async () => {
    const { app, bar, document } = loadComposer();
    let finishUpload!: (paths: string[]) => void;
    app._uploadAndInsertImages.mockImplementation(
      () => new Promise<string[]>((resolveUpload) => (finishUpload = resolveUpload))
    );
    bar.composePrompt();
    const fileInput = document.querySelector('.paste-file-input') as HTMLInputElement;
    const image = new document.defaultView!.File(['image'], 'shot.png', { type: 'image/png' });
    Object.defineProperty(fileInput, 'files', { configurable: true, value: [image] });
    fileInput.dispatchEvent(new document.defaultView!.Event('change', { bubbles: true }));
    (document.querySelector('.paste-cancel') as HTMLButtonElement).click();
    bar.composePrompt();
    expect((document.querySelector('.paste-send') as HTMLButtonElement).disabled).toBe(true);

    finishUpload(['/tmp/late-image.png']);
    await vi.waitFor(() => expect(textarea(document).value).toBe('/tmp/late-image.png'));
    expect((document.querySelector('.paste-send') as HTMLButtonElement).disabled).toBe(false);

    let finishDeletedUpload!: (paths: string[]) => void;
    app._uploadAndInsertImages.mockImplementation(
      () => new Promise<string[]>((resolveUpload) => (finishDeletedUpload = resolveUpload))
    );
    const reopenedInput = document.querySelector('.paste-file-input') as HTMLInputElement;
    Object.defineProperty(reopenedInput, 'files', { configurable: true, value: [image] });
    reopenedInput.dispatchEvent(new document.defaultView!.Event('change', { bubbles: true }));
    app.sessions.delete('session-1');
    bar.discardComposerDraft('session-1');
    finishDeletedUpload(['/tmp/deleted-session.png']);
    await Promise.resolve();
    await Promise.resolve();

    expect(bar._composerDrafts.has('session-1')).toBe(false);
  });

  it('keeps Send disabled until every concurrent image upload finishes', async () => {
    const { app, bar, document } = loadComposer();
    const finishUploads: Array<(paths: string[]) => void> = [];
    app._uploadAndInsertImages.mockImplementation(
      () => new Promise<string[]>((resolveUpload) => finishUploads.push(resolveUpload))
    );
    bar.composePrompt();
    const input = textarea(document);
    const image = new document.defaultView!.File(['image'], 'shot.png', { type: 'image/png' });
    const pasteImage = () => {
      const item = { type: 'image/png', getAsFile: () => image };
      const event = new document.defaultView!.Event('paste', { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'clipboardData', { value: { items: [item] } });
      input.dispatchEvent(event);
    };

    pasteImage();
    pasteImage();
    expect(finishUploads).toHaveLength(2);
    finishUploads[0](['/tmp/first.png']);
    await vi.waitFor(() => expect(input.value).toBe('/tmp/first.png'));
    expect((document.querySelector('.paste-send') as HTMLButtonElement).disabled).toBe(true);

    finishUploads[1](['/tmp/second.png']);
    await vi.waitFor(() => expect(input.value).toBe('/tmp/first.png /tmp/second.png'));
    expect((document.querySelector('.paste-send') as HTMLButtonElement).disabled).toBe(false);
  });
});
