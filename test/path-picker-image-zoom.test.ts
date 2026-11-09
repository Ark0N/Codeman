/**
 * @fileoverview Zoom in the path picker's image preview (salvaged from #608): pinch, one-finger pan,
 * double-click, wheel and the out / fit / in buttons. Same jsdom harness as
 * path-picker-hidden.test.ts (see its header for why the window is built by hand).
 *
 * These drive the real listeners and read the zoom state back, because what can go wrong is
 * geometric, not textual:
 *
 *   1. the point under the cursor or between the fingers drifting while the scale changes,
 *   2. a pan that carries the image out of view (a small image is drawn at its own size with
 *      `object-fit: scale-down`, so the image box is not the image),
 *   3. a trackpad's stream of small wheel deltas jumping to the maximum, as 20% per event did,
 *   4. controls left on screen for an image that failed to load,
 *   5. listeners or zoom state outliving the preview, or a late `load`/`error` from a replaced
 *      preview acting on the current one.
 *
 * jsdom lays nothing out and loads no images, so the viewport's rect and the image's natural size
 * are stubbed per test and `load`/`error` are dispatched by hand.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const PUBLIC = resolve(import.meta.dirname, '../src/web/public');
const accessoryJs = readFileSync(resolve(PUBLIC, 'keyboard-accessory.js'), 'utf8');
const stylesCss = readFileSync(resolve(PUBLIC, 'styles.css'), 'utf8');

const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', { url: 'https://localhost/' });
const jsdomWindow = dom.window as unknown as Window & typeof globalThis;
const doc = jsdomWindow.document;

/** The preview body's box: 400x300 at the page origin, so its centre is (200, 150). */
const BOX = { left: 0, top: 0, width: 400, height: 300 };
const CENTRE = { x: BOX.left + BOX.width / 2, y: BOX.top + BOX.height / 2 };

type Point = { x: number; y: number };
type ZoomState = { scale: number; x: number; y: number };

function loadPathPicker(): any {
  const factory = new Function(
    'window',
    'document',
    'localStorage',
    'fetch',
    'MobileDetection',
    `${accessoryJs}\nreturn PathPicker;`
  );
  return factory(jsdomWindow, doc, jsdomWindow.localStorage, vi.fn(), { isTouchDevice: () => false });
}

describe('PathPicker image preview zoom', () => {
  let PathPicker: any;

  beforeEach(() => {
    doc.body.replaceChildren();
    PathPicker = loadPathPicker();
  });

  afterEach(() => {
    PathPicker?.closePreview?.(false);
    doc.body.replaceChildren();
  });

  /** Open an image preview whose image has the given natural size (800x600 fills the box exactly). */
  const openImage = (natural = { width: 800, height: 600 }, name = 'shot.png') => {
    PathPicker.openPreview({ name, path: `/home/dev/${name}`, previewKind: 'image' });
    const overlay = PathPicker._previewOverlay as HTMLElement;
    const body = overlay.querySelector('.path-preview-body') as HTMLElement;
    body.getBoundingClientRect = () =>
      ({
        ...BOX,
        x: BOX.left,
        y: BOX.top,
        right: BOX.left + BOX.width,
        bottom: BOX.top + BOX.height,
        toJSON: () => ({}),
      }) as DOMRect;
    const image = body.querySelector('img.path-preview-image') as HTMLImageElement;
    Object.defineProperty(image, 'naturalWidth', { value: natural.width, configurable: true });
    Object.defineProperty(image, 'naturalHeight', { value: natural.height, configurable: true });
    const controls = overlay.querySelector('.path-preview-zoom') as HTMLElement;
    const button = (zoom: string) => controls.querySelector(`[data-zoom="${zoom}"]`) as HTMLButtonElement;
    return { overlay, body, image, controls, button };
  };

  const fire = (target: EventTarget, type: string) => target.dispatchEvent(new jsdomWindow.Event(type));
  const state = (): ZoomState => PathPicker._previewImageZoom;

  /** Where, in the unzoomed image, the given screen point lands under the current transform. */
  const imagePointUnder = (p: Point, s: ZoomState = state()): Point => ({
    x: (p.x - CENTRE.x - s.x) / s.scale,
    y: (p.y - CENTRE.y - s.y) / s.scale,
  });

  const wheel = (target: EventTarget, init: Record<string, unknown>) => {
    const event = new jsdomWindow.WheelEvent('wheel', { bubbles: true, cancelable: true, ...init });
    target.dispatchEvent(event);
    return event;
  };

  /** jsdom has no PointerEvent: a MouseEvent of the pointer type with a pointerId behaves the same. */
  const pointer = (target: EventTarget, type: string, id: number, p: Point) => {
    const event = new jsdomWindow.MouseEvent(type, { bubbles: true, cancelable: true, clientX: p.x, clientY: p.y });
    Object.defineProperty(event, 'pointerId', { value: id });
    target.dispatchEvent(event);
  };

  const dblclick = (target: EventTarget, p: Point) =>
    target.dispatchEvent(
      new jsdomWindow.MouseEvent('dblclick', { bubbles: true, cancelable: true, clientX: p.x, clientY: p.y })
    );

  it('shows the controls only once the image has loaded, and the buttons step the zoom', () => {
    const { image, controls, button } = openImage();
    expect(controls.hidden).toBe(true);

    fire(image, 'load');
    expect(controls.hidden).toBe(false);
    expect(button('fit').textContent).toBe('100%');

    button('in').click();
    expect(state().scale).toBeCloseTo(1.5);
    expect(button('fit').textContent).toBe('150%');
    expect(image.classList.contains('is-zoomed')).toBe(true);

    button('fit').click();
    expect(state()).toMatchObject({ scale: 1 });
    expect(Math.abs(state().x) + Math.abs(state().y)).toBe(0);
    expect(button('fit').textContent).toBe('100%');
    expect(image.classList.contains('is-zoomed')).toBe(false);

    button('out').click();
    expect(state().scale).toBe(1);
  });

  it('wheel zoom keeps the image point under the cursor where it was', () => {
    const { body, image } = openImage();
    fire(image, 'load');

    for (const cursor of [
      { x: 300, y: 100 },
      { x: 120, y: 220 },
      { x: 390, y: 290 },
    ]) {
      const before = imagePointUnder(cursor);
      const scaleBefore = state().scale;
      wheel(body, { deltaY: -100, clientX: cursor.x, clientY: cursor.y });
      expect(state().scale).toBeCloseTo(scaleBefore * 2 ** 0.2);
      const after = imagePointUnder(cursor);
      expect(after.x).toBeCloseTo(before.x);
      expect(after.y).toBeCloseTo(before.y);
    }
    expect(image.style.transform).toContain(`scale(${state().scale})`);
  });

  it('pinch zooms by the finger distance around the pinch centre', () => {
    const { image } = openImage();
    fire(image, 'load');
    const centre = { x: 150, y: 150 };
    const before = imagePointUnder(centre);

    pointer(image, 'pointerdown', 1, { x: 100, y: 150 });
    pointer(image, 'pointerdown', 2, { x: 200, y: 150 });
    pointer(image, 'pointermove', 2, { x: 300, y: 150 });

    expect(state().scale).toBeCloseTo(2);
    const after = imagePointUnder(centre);
    expect(after.x).toBeCloseTo(before.x);
    expect(after.y).toBeCloseTo(before.y);

    pointer(image, 'pointerup', 2, { x: 300, y: 150 });
    pointer(image, 'pointerup', 1, { x: 100, y: 150 });
    expect(state().pointers.size).toBe(0);
  });

  it('pans a zoomed image only until its edge meets the viewport edge', () => {
    const { image } = openImage();
    fire(image, 'load');
    dblclick(image, CENTRE);
    expect(state().scale).toBe(2);

    pointer(image, 'pointerdown', 1, CENTRE);
    pointer(image, 'pointermove', 1, { x: 5000, y: 5000 });
    // 800x600 drawn at 400x300, zoomed 2x to 800x600 in a 400x300 box: 200 and 150 of slack.
    expect(state()).toMatchObject({ x: 200, y: 150 });
    pointer(image, 'pointermove', 1, { x: -5000, y: -5000 });
    expect(state()).toMatchObject({ x: -200, y: -150 });
    pointer(image, 'pointerup', 1, { x: -5000, y: -5000 });

    // Without zoom there is nothing to pan.
    dblclick(image, CENTRE);
    pointer(image, 'pointerdown', 1, CENTRE);
    pointer(image, 'pointermove', 1, { x: 300, y: 250 });
    expect(state()).toMatchObject({ scale: 1 });
    expect(Math.abs(state().x) + Math.abs(state().y)).toBe(0);
  });

  it('keeps a small image in view: centred while it is smaller than the viewport, clamped to its own edges after', () => {
    // 100x50 is drawn at its own size (scale-down), not stretched to the 400x300 box.
    const { image } = openImage({ width: 100, height: 50 });
    fire(image, 'load');

    dblclick(image, { x: 380, y: 280 });
    expect(state().scale).toBe(2);
    pointer(image, 'pointerdown', 1, CENTRE);
    pointer(image, 'pointermove', 1, { x: 5000, y: 5000 });
    // 200x100 still fits inside 400x300 on both axes: it stays centred.
    expect(Math.abs(state().x) + Math.abs(state().y)).toBe(0);
    pointer(image, 'pointerup', 1, { x: 5000, y: 5000 });

    PathPicker._setPreviewImageZoom(6);
    pointer(image, 'pointerdown', 1, CENTRE);
    pointer(image, 'pointermove', 1, { x: 5000, y: 5000 });
    // 600x300 at 6x: 100 of horizontal slack, none vertically. The image box (400x300 at 6x) would
    // have allowed 1000 and 750, carrying the image entirely out of the viewport.
    expect(state().x).toBe(100);
    expect(Math.abs(state().y)).toBe(0);
  });

  it('scales wheel zoom by deltaY, ignores a delta of 0 and caps one event', () => {
    const factor = (init: Record<string, unknown>) => PathPicker._previewWheelZoomFactor(init);
    expect(factor({ deltaY: 0, deltaX: 40 })).toBe(1);
    expect(factor({ deltaY: -4 })).toBeCloseTo(2 ** 0.008);
    expect(factor({ deltaY: -100 })).toBeCloseTo(2 ** 0.2);
    expect(factor({ deltaY: 100 })).toBeCloseTo(2 ** -0.2);
    // Lines (Firefox's mouse wheel) and ctrl+wheel (a trackpad pinch) are scaled up, not ignored.
    expect(factor({ deltaY: -3, deltaMode: 1 })).toBeCloseTo(2 ** 0.15);
    expect(factor({ deltaY: -10, ctrlKey: true })).toBeCloseTo(2 ** 0.2);
    expect(factor({ deltaY: -100000 })).toBeCloseTo(Math.SQRT2);
    expect(factor({ deltaY: 100000 })).toBeCloseTo(Math.SQRT1_2);

    const { body, image } = openImage();
    fire(image, 'load');
    const zoom = vi.spyOn(PathPicker, '_setPreviewImageZoom');
    const sideways = wheel(body, { deltaY: 0, deltaX: 40, clientX: 300, clientY: 100 });
    expect(sideways.defaultPrevented).toBe(true);
    expect(zoom).not.toHaveBeenCalled();
    expect(state().scale).toBe(1);

    // A trackpad scroll arrives as many small deltas; at 20% per event these 30 hit the 600% cap.
    for (let i = 0; i < 30; i++) wheel(body, { deltaY: -4, clientX: 300, clientY: 100 });
    expect(state().scale).toBeCloseTo(2 ** 0.24);
    expect(state().scale).toBeLessThan(1.25);
  });

  it('hides the controls and stops zooming when the image fails to load', () => {
    const { body, image, controls } = openImage();
    fire(image, 'error');

    expect(controls.hidden).toBe(true);
    expect(body.querySelector('.path-preview-error')?.textContent).toBe('Image preview failed to load');
    expect(PathPicker._previewImageZoom).toBeNull();

    const zoom = vi.spyOn(PathPicker, '_setPreviewImageZoom');
    wheel(body, { deltaY: -100, clientX: 200, clientY: 150 });
    expect(zoom).not.toHaveBeenCalled();
  });

  it('closing drops the zoom state and every listener, and the next image starts at 100%', () => {
    const first = openImage();
    fire(first.image, 'load');
    dblclick(first.image, { x: 300, y: 100 });
    expect(state().scale).toBe(2);
    const transformAtClose = first.image.style.transform;

    PathPicker.closePreview(false);
    expect(PathPicker._previewImageZoom).toBeNull();
    expect(PathPicker._previewImageCleanup).toBeNull();
    expect(first.overlay.isConnected).toBe(false);

    const zoom = vi.spyOn(PathPicker, '_setPreviewImageZoom');
    wheel(first.body, { deltaY: -100, clientX: 200, clientY: 150 });
    dblclick(first.image, CENTRE);
    first.button('in').click();
    expect(zoom).not.toHaveBeenCalled();
    expect(first.image.style.transform).toBe(transformAtClose);
    zoom.mockRestore();

    const second = openImage({ width: 800, height: 600 }, 'next.png');
    fire(second.image, 'load');
    expect(state()).toMatchObject({ scale: 1 });
    expect(second.button('fit').textContent).toBe('100%');
    expect(second.image.classList.contains('is-zoomed')).toBe(false);
  });

  it('a late load or error from a replaced preview leaves the current one alone', () => {
    const stale = openImage({ width: 800, height: 600 }, 'old.png');
    const current = openImage({ width: 800, height: 600 }, 'new.png');
    fire(current.image, 'load');
    dblclick(current.image, { x: 300, y: 100 });
    const zoomed = { ...state() };

    fire(stale.image, 'load');
    expect(state()).toMatchObject({ scale: zoomed.scale, x: zoomed.x, y: zoomed.y });

    fire(stale.image, 'error');
    expect(current.body.querySelector('.path-preview-error')).toBeNull();
    expect(current.image.isConnected).toBe(true);
    expect(current.controls.hidden).toBe(false);
    expect(PathPicker._previewImageZoom).not.toBeNull();
  });

  it('draws a small image at its own size rather than stretching it (scale-down)', () => {
    const rule = stylesCss.match(/\n\.path-preview-image \{([^}]*)\}/);
    expect(rule?.[1]).toMatch(/object-fit:\s*scale-down;/);
    expect(rule?.[1]).not.toMatch(/object-fit:\s*contain;/);
  });
});
