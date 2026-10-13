/**
 * Phone toolbar Attach button (image-input.js): the tap lands on the file input
 * that sits over the button, so the BROWSER opens the picker, and a selection
 * uploads then puts the paths on the prompt. The Compose dialog is not involved.
 *
 * The native tap is load-bearing, not a style choice: app.js's keyboard tap shim
 * turns every toolbar BUTTON tap into a scripted click while the keyboard is up,
 * and iOS refuses to open a file picker from an untrusted click.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';
import { describe, expect, it, vi } from 'vitest';

const imageInputSource = readFileSync(resolve(import.meta.dirname, '../src/web/public/image-input.js'), 'utf8');

function loadToolbar(sessionId: string | null = 'session-1', localEcho = true, keyboardUp = false) {
  const dom = new JSDOM(
    '<!DOCTYPE html><html><body><span class="btn-attach-mobile-wrap">' +
      '<button type="button" id="attachBtnMobile"></button>' +
      '<input type="file" id="attachFileInput" accept="image/*,video/*" multiple>' +
      '</span></body></html>'
  );
  const { window } = dom;
  // Stands in for the real bar: the production code reaches for an OPEN composer
  // before touching the terminal prompt, and only this shape of it matters here.
  const composerBar = {
    _composerOverlay: null as null | HTMLElement,
    _insertComposerText: vi.fn(),
  };
  const fetchMock = vi.fn(async () => ({
    ok: true,
    json: async () => ({ data: { path: '/case/.codeman-uploads/p' } }),
  }));
  const context = vm.createContext({
    window,
    document: window.document,
    setTimeout,
    clearTimeout,
    console,
    FormData: window.FormData,
    fetch: fetchMock,
    KeyboardAccessoryBar: composerBar,
  });
  vm.runInContext('class CodemanApp {}', context);
  vm.runInContext(imageInputSource, context, { filename: 'image-input.js' });
  const CodemanApp = vm.runInContext('CodemanApp', context) as new () => any;
  const app = new CodemanApp();
  app.activeSessionId = sessionId;
  app.showToast = vi.fn();
  app.sendInput = vi.fn(async () => {});
  app.terminal = { focus: vi.fn() };
  app._isMobileTerminalInputFocused = vi.fn(() => keyboardUp);
  app._blurMobileTerminalInput = vi.fn();
  app._sendInputAsync = vi.fn();
  app._echoPassthroughSessions = new Set<string>();
  app.sessions = new Map<string, unknown>([['session-1', { mode: 'claude' }]]);
  app._flushedTexts = new Map<string, string>();
  app._flushedOffsets = new Map<string, number>();
  app._localEchoEnabled = localEcho;
  app._localEchoOverlay = localEcho
    ? {
        appendText: vi.fn(),
        pendingText: '',
        getFlushed: vi.fn(() => ({ count: 0, text: '' })),
        detectBufferText: vi.fn(),
      }
    : null;
  app._uploadAndInsertImages = vi.fn(async () => [
    '/case/.codeman-uploads/paste-1-a.png',
    '/case/.codeman-uploads/paste-2-b.jpg',
  ]);
  app.initImageInput();
  const button = window.document.getElementById('attachBtnMobile') as HTMLButtonElement;
  const input = window.document.getElementById('attachFileInput') as HTMLInputElement;
  const inputClicks: number[] = [];
  input.addEventListener('click', () => inputClicks.push(1));
  // A real tap lands on the input, never on the button underneath it.
  const tap = () => {
    const event = new window.MouseEvent('click', { bubbles: true, cancelable: true });
    input.dispatchEvent(event);
    return event;
  };
  const select = (files: File[]) => {
    tap(); // captures the session, exactly as a real tap does
    Object.defineProperty(input, 'files', { configurable: true, value: files });
    input.dispatchEvent(new window.Event('change', { bubbles: true }));
  };
  return { app, window, button, input, inputClicks, tap, select, composerBar, fetchMock };
}

describe('phone toolbar Attach button', () => {
  it('lets a native tap on the input open the picker, with the session captured', () => {
    const { app, tap } = loadToolbar();
    const event = tap();
    expect(event.defaultPrevented).toBe(false); // the browser opens the picker
    expect(app._attachSessionId).toBe('session-1');
  });

  // Pins the MECHANISM, not the outcome: whether the keyboard actually stays up is
  // only observable on a device, so this locks the cancelled mousedown that stops
  // the input taking focus. Same kind of lock as the multi-line composer test.
  it('cancels mousedown on the input so focus never leaves the terminal', () => {
    const { window, input } = loadToolbar();
    const event = new window.MouseEvent('mousedown', { bubbles: true, cancelable: true });
    input.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });

  // The input is aria-hidden and not tabbable, so assistive tech and a hardware
  // keyboard reach the button instead. That click is trusted, so it may open the
  // picker from script.
  it('opens the input from the button for a keyboard or VoiceOver activation', () => {
    const { button, inputClicks } = loadToolbar();
    button.click();
    expect(inputClicks).toHaveLength(1);
  });

  it('refuses before the picker opens when no session is active', () => {
    const { app, tap } = loadToolbar(null);
    const event = tap();
    expect(event.defaultPrevented).toBe(true); // no picker, rather than a refused pick
    expect(app.showToast).toHaveBeenCalledWith('Open a session to attach a file', 'error');
  });

  it('puts the paths in the local-echo overlay, not the PTY, so Compose can adopt them', async () => {
    const { app, window, select } = loadToolbar();
    const a = new window.File(['a'], 'a.png', { type: 'image/png' });
    const b = new window.File(['b'], 'b.jpg', { type: 'image/jpeg' });
    select([a, b]);
    await vi.waitFor(() => expect(app._localEchoOverlay.appendText).toHaveBeenCalledTimes(1));
    expect(app._uploadAndInsertImages).toHaveBeenCalledWith([a, b], { insert: false, sessionId: 'session-1' });
    expect(app._localEchoOverlay.appendText).toHaveBeenCalledWith(
      '/case/.codeman-uploads/paste-1-a.png /case/.codeman-uploads/paste-2-b.jpg '
    );
    expect(app._sendInputAsync).not.toHaveBeenCalled();
  });

  it('falls back to the session-bound PTY write when there is no overlay to buffer into', async () => {
    const { app, window, select } = loadToolbar('session-1', false);
    select([new window.File(['a'], 'a.png', { type: 'image/png' })]);
    await vi.waitFor(() => expect(app._sendInputAsync).toHaveBeenCalledTimes(1));
    expect(app._sendInputAsync).toHaveBeenCalledWith(
      'session-1',
      ' /case/.codeman-uploads/paste-1-a.png /case/.codeman-uploads/paste-2-b.jpg '
    );
  });

  it('writes to the PTY, not the overlay, while the session is in echo passthrough', async () => {
    const { app, window, select } = loadToolbar();
    // A composer nav key hands the session back to plain PTY echo, and Enter then
    // skips the overlay flush entirely, so buffered text would never be submitted.
    app._echoPassthroughSessions.add('session-1');
    select([new window.File(['a'], 'a.png', { type: 'image/png' })]);
    await vi.waitFor(() => expect(app._sendInputAsync).toHaveBeenCalledTimes(1));
    expect(app._localEchoOverlay.appendText).not.toHaveBeenCalled();
  });

  it('writes to the PTY, not the overlay, while the tile grid owns the terminal', async () => {
    const { app, window, select } = loadToolbar();
    // Tiles park and hide the main terminal, and a tile's Enter never reaches its
    // overlay, so a path appended there would sit unseen and never be submitted.
    app._tilesOwnTerminal = () => true;
    select([new window.File(['a'], 'a.png', { type: 'image/png' })]);
    await vi.waitFor(() => expect(app._sendInputAsync).toHaveBeenCalledTimes(1));
    expect(app._sendInputAsync).toHaveBeenCalledWith(
      'session-1',
      ' /case/.codeman-uploads/paste-1-a.png /case/.codeman-uploads/paste-2-b.jpg '
    );
    expect(app._localEchoOverlay.appendText).not.toHaveBeenCalled();
  });

  it('separates the path from a half-typed word already on the prompt', async () => {
    const { app, window, select } = loadToolbar();
    app._localEchoOverlay.pendingText = 'describe';
    select([new window.File(['a'], 'a.png', { type: 'image/png' })]);
    await vi.waitFor(() => expect(app._localEchoOverlay.appendText).toHaveBeenCalledTimes(1));
    expect(app._localEchoOverlay.appendText.mock.calls[0][0]).toBe(
      ' /case/.codeman-uploads/paste-1-a.png /case/.codeman-uploads/paste-2-b.jpg '
    );
  });

  it('separates the path from flushed prompt text when pending is empty', async () => {
    const { app, window, select } = loadToolbar();
    // After a tab completion or a tab-switch restore the words live in the flushed
    // half of the prompt and pending is empty.
    app._localEchoOverlay.getFlushed = vi.fn(() => ({ count: 8, text: 'describe' }));
    select([new window.File(['a'], 'a.png', { type: 'image/png' })]);
    await vi.waitFor(() => expect(app._localEchoOverlay.appendText).toHaveBeenCalledTimes(1));
    expect(app._localEchoOverlay.appendText.mock.calls[0][0].startsWith(' /case/')).toBe(true);
  });

  it('adds no separator when the prompt already ends in whitespace', async () => {
    const { app, window, select } = loadToolbar();
    app._localEchoOverlay.pendingText = 'describe ';
    select([new window.File(['a'], 'a.png', { type: 'image/png' })]);
    await vi.waitFor(() => expect(app._localEchoOverlay.appendText).toHaveBeenCalledTimes(1));
    expect(app._localEchoOverlay.appendText.mock.calls[0][0].startsWith('/case/')).toBe(true);
  });

  it('sends the path to the session the attach started on after a tab switch', async () => {
    const { app, window, select } = loadToolbar('session-1', true, true);
    app._uploadAndInsertImages.mockImplementation(async () => {
      // The user switches tabs while the upload is in flight.
      app.activeSessionId = 'session-2';
      return ['/case/.codeman-uploads/paste-1-a.png'];
    });
    select([new window.File(['a'], 'a.png', { type: 'image/png' })]);
    await vi.waitFor(() => expect(app._sendInputAsync).toHaveBeenCalledTimes(1));
    expect(app._sendInputAsync).toHaveBeenCalledWith('session-1', ' /case/.codeman-uploads/paste-1-a.png ');
    // A background session's prompt is tracked, or a later composer open erases the wrong tail.
    expect(app._flushedTexts.get('session-1')).toBe(' /case/.codeman-uploads/paste-1-a.png ');
    expect(app._localEchoOverlay.appendText).not.toHaveBeenCalled();
    // The keyboard belongs to whatever the user is looking at now, not to us.
    expect(app.terminal.focus).not.toHaveBeenCalled();
  });

  // Nothing in the attach path may move focus. Focus stays on the terminal through
  // the whole pick, so the keyboard is never dismissed and never has to be restored
  // (a programmatic focus does not raise it on iOS without user activation).
  it('never touches the keyboard, with it up or down', async () => {
    for (const keyboardUp of [true, false]) {
      const { app, window, select } = loadToolbar('session-1', true, keyboardUp);
      select([new window.File(['a'], 'a.png', { type: 'image/png' })]);
      await vi.waitFor(() => expect(app._localEchoOverlay.appendText).toHaveBeenCalledTimes(1));
      expect(app._blurMobileTerminalInput).not.toHaveBeenCalled();
      expect(app.terminal.focus).not.toHaveBeenCalled();
    }
  });

  it('refuses to upload for a session deleted while the picker was open', async () => {
    const { app, window, tap, input, fetchMock } = loadToolbar();
    // The production upload path, spied: the refusal under test is its own.
    app._uploadAndInsertImages = vi.fn(Object.getPrototypeOf(app)._uploadAndInsertImages);
    tap();
    app.sessions.delete('session-1');
    app.activeSessionId = 'session-2';
    Object.defineProperty(input, 'files', {
      configurable: true,
      value: [new window.File(['a'], 'a.png', { type: 'image/png' })],
    });
    input.dispatchEvent(new window.Event('change', { bubbles: true }));
    await vi.waitFor(() => expect(app._uploadAndInsertImages).toHaveBeenCalledTimes(1));
    expect(app._uploadAndInsertImages.mock.calls[0][1]).toEqual({ insert: false, sessionId: 'session-1' });
    await expect(app._uploadAndInsertImages.mock.results[0].value).resolves.toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(app.showToast).not.toHaveBeenCalled();
    expect(app._sendInputAsync).not.toHaveBeenCalled();
    expect(app._localEchoOverlay.appendText).not.toHaveBeenCalled();
  });

  it('records nothing in the flushed maps for a background session in echo passthrough', async () => {
    const { app, window, select } = loadToolbar('session-1', true, true);
    app._echoPassthroughSessions.add('session-1');
    app._uploadAndInsertImages.mockImplementation(async () => {
      app.activeSessionId = 'session-2';
      return ['/case/.codeman-uploads/paste-1-a.png'];
    });
    select([new window.File(['a'], 'a.png', { type: 'image/png' })]);
    await vi.waitFor(() => expect(app._sendInputAsync).toHaveBeenCalledTimes(1));
    expect(app._sendInputAsync).toHaveBeenCalledWith('session-1', ' /case/.codeman-uploads/paste-1-a.png ');
    // Nothing tracks a passthrough composer and Enter there never clears the maps,
    // so a record would offset the overlay for that session's next prompt.
    expect(app._flushedTexts.has('session-1')).toBe(false);
    expect(app._flushedOffsets.has('session-1')).toBe(false);
  });

  it('passes a .gif with no MIME through untouched, on the same extension fallback as the kind check', async () => {
    const { app, window } = loadToolbar();
    const gif = new window.File(['GIF89a'], 'anim.gif', { type: '' });
    await expect(app._normalizeImageForUpload(gif)).resolves.toBe(gif);
  });

  it('drops the paths when the session was deleted while the upload ran', async () => {
    const { app, window, select } = loadToolbar('session-1', true, true);
    app._uploadAndInsertImages.mockImplementation(async () => {
      app.sessions.delete('session-1');
      app.activeSessionId = 'session-2';
      return ['/case/.codeman-uploads/paste-1-a.png'];
    });
    select([new window.File(['a'], 'a.png', { type: 'image/png' })]);
    await vi.waitFor(() => expect(app._uploadAndInsertImages).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 0));
    expect(app._sendInputAsync).not.toHaveBeenCalled();
    expect(app._localEchoOverlay.appendText).not.toHaveBeenCalled();
    // No bookkeeping for a session whose cleanup already ran.
    expect(app._flushedTexts.has('session-1')).toBe(false);
  });

  it('detects undetected prompt text before measuring the separator', async () => {
    const { app, window, select } = loadToolbar();
    // Tab completion put text on the prompt the overlay has not adopted yet.
    app._localEchoOverlay.detectBufferText = vi.fn(() => {
      app._localEchoOverlay.getFlushed = vi.fn(() => ({ count: 8, text: 'describe' }));
      return 'describe';
    });
    select([new window.File(['a'], 'a.png', { type: 'image/png' })]);
    await vi.waitFor(() => expect(app._localEchoOverlay.appendText).toHaveBeenCalledTimes(1));
    expect(app._localEchoOverlay.appendText.mock.calls[0][0].startsWith(' /case/')).toBe(true);
  });

  it('puts the paths into an open composer rather than behind it', async () => {
    const { app, window, select, composerBar } = loadToolbar();
    const overlay = window.document.createElement('div');
    overlay.dataset.sessionId = 'session-1';
    const area = window.document.createElement('textarea');
    area.className = 'prompt-composer-textarea';
    overlay.appendChild(area);
    window.document.body.appendChild(overlay);
    composerBar._composerOverlay = overlay;

    select([new window.File(['a'], 'a.png', { type: 'image/png' })]);
    await vi.waitFor(() => expect(composerBar._insertComposerText).toHaveBeenCalledTimes(1));
    expect(composerBar._insertComposerText.mock.calls[0][0]).toBe(area);
    // Not behind it: the composer already took the terminal's pending text.
    expect(app._localEchoOverlay.appendText).not.toHaveBeenCalled();
    expect(app._sendInputAsync).not.toHaveBeenCalled();
  });

  it('ignores a composer open for a different session', async () => {
    const { app, window, select, composerBar } = loadToolbar();
    const overlay = window.document.createElement('div');
    overlay.dataset.sessionId = 'session-2';
    const area = window.document.createElement('textarea');
    area.className = 'prompt-composer-textarea';
    overlay.appendChild(area);
    window.document.body.appendChild(overlay);
    composerBar._composerOverlay = overlay;

    select([new window.File(['a'], 'a.png', { type: 'image/png' })]);
    await vi.waitFor(() => expect(app._localEchoOverlay.appendText).toHaveBeenCalledTimes(1));
    expect(composerBar._insertComposerText).not.toHaveBeenCalled();
  });

  it('rejects a selection with neither image nor video with a toast and no upload', async () => {
    const { app, window, select } = loadToolbar();
    select([new window.File(['%PDF-'], 'doc.pdf', { type: 'application/pdf' })]);
    await Promise.resolve();
    expect(app._uploadAndInsertImages).not.toHaveBeenCalled();
    expect(app._sendInputAsync).not.toHaveBeenCalled();
    expect(app.showToast).toHaveBeenCalledWith('Only image or video files are supported', 'error');
  });

  it('classifies a pick by its name when the file manager supplied no MIME type', () => {
    const { app, window } = loadToolbar();
    const kind = (name: string, type: string) => app._promptAttachKind(new window.File(['x'], name, { type }));
    expect(kind('clip.ogv', '')).toBe('video');
    expect(kind('IMG_0001.MOV', '')).toBe('video');
    expect(kind('shot.heic', '')).toBe('image');
    expect(kind('notes.pdf', '')).toBeNull();
    expect(kind('clip.ogv', 'image/jpeg')).toBe('image'); // the MIME type wins when present
  });

  it('flags the upload as a video by name as well as by MIME type', async () => {
    const { app, window, fetchMock } = loadToolbar();
    await app._uploadPasteImage('session-1', new window.File(['v'], 'clip.ogv', { type: '' }));
    await app._uploadPasteImage('session-1', new window.File(['v'], 'IMG_0001.MOV', { type: 'video/quicktime' }));
    await app._uploadPasteImage('session-1', new window.File(['a'], 'a.png', { type: 'image/png' }));
    const urls = fetchMock.mock.calls.map((c: unknown[]) => c[0]);
    expect(urls).toEqual([
      '/api/sessions/session-1/paste-image?kind=video',
      '/api/sessions/session-1/paste-image?kind=video',
      '/api/sessions/session-1/paste-image',
    ]);
  });

  it('uploads a camera-roll video alongside photos', async () => {
    const { app, window, select } = loadToolbar();
    const mov = new window.File(['v'], 'IMG_0001.MOV', { type: 'video/quicktime' });
    const jpg = new window.File(['a'], 'a.jpg', { type: 'image/jpeg' });
    select([mov, jpg]);
    await vi.waitFor(() => expect(app._uploadAndInsertImages).toHaveBeenCalledTimes(1));
    expect(app._uploadAndInsertImages.mock.calls[0][0]).toEqual([mov, jpg]);
  });

  it('types nothing when every upload failed', async () => {
    const { app, window, select } = loadToolbar();
    app._uploadAndInsertImages.mockResolvedValueOnce([]);
    select([new window.File(['a'], 'a.png', { type: 'image/png' })]);
    await vi.waitFor(() => expect(app._uploadAndInsertImages).toHaveBeenCalledTimes(1));
    await Promise.resolve();
    expect(app._sendInputAsync).not.toHaveBeenCalled();
    expect(app._localEchoOverlay.appendText).not.toHaveBeenCalled();
  });
});
