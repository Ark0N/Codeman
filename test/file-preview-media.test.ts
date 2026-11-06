/**
 * @fileoverview File viewer media teardown: closing the preview must stop the video.
 *
 * `closeFilePreview()` used to do nothing but drop the overlay's `visible`
 * class. That hides the overlay (`display: none`) and hides it ONLY: the
 * `<video>` inside carried on playing, so the audio kept going after the user
 * pressed X, with no visible player to pause. Detaching the element is not a fix
 * either — a detached HTMLMediaElement plays until it is garbage collected —
 * which is why the teardown has to pause() and unload the element explicitly.
 *
 * What is pinned here:
 *   1. close pauses AND unloads every media element (not just the first),
 *   2. close still works with no media in the body (the common text case),
 *   3. opening a NEW preview stops what the previous one was playing, since
 *      overwriting innerHTML only detaches it,
 *   4. a dirty edit buffer still wins: cancelling the discard prompt must not
 *      tear the buffer down.
 *
 * Loaded via `vm` against a stub app, same harness style as
 * file-browser-hidden.test.ts (no jsdom).
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const PUBLIC = resolve(import.meta.dirname, '../src/web/public');
const panelsJs = readFileSync(resolve(PUBLIC, 'panels-ui.js'), 'utf8');

interface FakeMedia {
  tag: 'video' | 'audio';
  paused: boolean;
  src: string | null;
  loadCalls: number;
  pause: () => void;
  removeAttribute: (name: string) => void;
  load: () => void;
}

function fakeMedia(tag: 'video' | 'audio'): FakeMedia {
  const el: FakeMedia = {
    tag,
    paused: false,
    src: 'https://example.test/clip.mp4',
    loadCalls: 0,
    pause() {
      el.paused = true;
    },
    removeAttribute(name: string) {
      if (name === 'src') el.src = null;
    },
    load() {
      el.loadCalls += 1;
    },
  };
  return el;
}

function loadApp(media: FakeMedia[]) {
  const CodemanApp = function CodemanApp(this: unknown) {} as unknown as new () => Record<string, unknown>;
  const context = vm.createContext({
    CodemanApp,
    console: { ...console, warn: vi.fn() },
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    escapeHtml: (s: string) => String(s),
    // Reverse-proxy route builder from constants.js (not loaded here); identity at root.
    CodemanBase: { base: '', url: (p: string) => p },
    // Also from constants.js: no file in this suite renders as an HTML page.
    rendersAsPage: () => false,
    document: { getElementById: () => null, addEventListener: vi.fn() },
    window: { addEventListener: vi.fn() },
    setTimeout,
    clearTimeout,
    confirm: () => true,
    fetch: () => {
      throw new Error('fetch not stubbed');
    },
  });
  vm.runInContext(panelsJs, context, { filename: 'panels-ui.js' });

  const body = {
    innerHTML: '<video src="/api/sessions/s1/file-raw?path=clip.mp4" controls></video>',
    querySelectorAll: (sel: string) => {
      expect(sel).toBe('video, audio');
      return media;
    },
  };
  const overlay = {
    classes: new Set<string>(['visible']),
    classList: {
      add: (c: string) => overlay.classes.add(c),
      remove: (c: string) => overlay.classes.delete(c),
      contains: (c: string) => overlay.classes.has(c),
    },
  };
  const elements: Record<string, unknown> = { filePreviewBody: body, filePreviewOverlay: overlay };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const app = new CodemanApp() as Record<string, any>;
  app.$ = (id: string) => elements[id] ?? null;
  app.filePreviewContent = 'previous content';
  app.context = context;
  return { app, body, overlay, context };
}

describe('file viewer media teardown', () => {
  let media: FakeMedia[];

  beforeEach(() => {
    media = [fakeMedia('video')];
  });

  it('pauses and unloads the video when the preview is closed', () => {
    const { app, overlay, body } = loadApp(media);

    app.closeFilePreview();

    expect(overlay.classList.contains('visible')).toBe(false);
    expect(media[0].paused).toBe(true);
    // src dropped + load() is what aborts the in-flight fetch; pause() alone
    // leaves the browser downloading the rest of the file.
    expect(media[0].src).toBeNull();
    expect(media[0].loadCalls).toBe(1);
    expect(body.innerHTML).toBe('');
  });

  it('stops every media element, not just the first', () => {
    media = [fakeMedia('video'), fakeMedia('audio')];
    const { app } = loadApp(media);

    app.closeFilePreview();

    expect(media.every((m) => m.paused && m.src === null)).toBe(true);
  });

  it('closes cleanly when the preview holds no media (the text case)', () => {
    const { app, overlay } = loadApp([]);

    expect(() => app.closeFilePreview()).not.toThrow();
    expect(overlay.classList.contains('visible')).toBe(false);
    expect(app.filePreviewContent).toBe('');
  });

  it('survives a media element that throws on teardown', () => {
    const hostile = fakeMedia('video');
    hostile.pause = () => {
      throw new Error('detached');
    };
    const { app, overlay } = loadApp([hostile]);

    expect(() => app.closeFilePreview()).not.toThrow();
    expect(overlay.classList.contains('visible')).toBe(false);
  });

  it('stops the previous video when another file is previewed', async () => {
    const { app, context } = loadApp(media);
    // openFilePreview bails right after the teardown: the fetch stub rejects and
    // the handler swallows it, which is enough to pin the teardown ordering.
    context.fetch = async () => ({ ok: false, json: async () => ({ success: false }) });
    app._resetFilePreviewEdit = () => {};
    app.$ = ((orig) => (id: string) => (id === 'filePreviewTitle' || id === 'filePreviewFooter' ? {} : orig(id)))(
      app.$
    );

    await app.openFilePreview('other.txt', 's1');

    expect(media[0].paused).toBe(true);
    expect(media[0].src).toBeNull();
  });

  it('keeps the editor buffer when the discard prompt is declined', () => {
    const { app, overlay, context } = loadApp(media);
    context.confirm = () => false;
    app.filePreviewEdit = { dirty: true };

    app.closeFilePreview();

    expect(overlay.classList.contains('visible')).toBe(true);
    expect(media[0].paused).toBe(false);
  });
});
