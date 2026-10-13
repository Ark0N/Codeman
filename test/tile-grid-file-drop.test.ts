/**
 * @fileoverview A file dragged onto the tile grid.
 *
 * The single view's file drop (image-input.js) listens on #terminalContainer,
 * which is hidden while tiles are open. Nothing else cancelled a file drag,
 * so dropping a screenshot on a tile made the browser open the file in place
 * of Codeman. Now the grid section itself takes every file drag (bubble
 * phase): anywhere over it (a tile, an empty cell, a divider, its padding)
 * dragover and drop are cancelled, so the page never navigates, and a drop on
 * a tile uploads its files to THAT tile's session, through the same classifier
 * (_promptAttachKind: images, videos and documents) and the same "Unsupported
 * file type" toast as the single view. Tab and tile drags are the targets' own
 * (_acceptTabDrops, capture phase) and stay untouched.
 *
 * Real code via the shared vm harness (test/mocks/tile-grid-vm.ts). Port: N/A.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeEl, makeGridApp, resetGridHarness, section, tileEl, type GridApp } from './mocks/tile-grid-vm.js';

const IDS = ['s-a', 's-b', 's-c'];

function fileEvent(target: FakeEl, files: Array<{ type: string; name?: string }>, types = ['Files']) {
  return {
    target,
    dataTransfer: { types, files, dropEffect: 'none' },
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
  };
}

/** A grid on `ids`, s-a focused, uploads stubbed. Five tiles make a 3x2 with one empty cell. */
function gridApp(ids = IDS): GridApp {
  const app = makeGridApp(ids);
  app._uploadAndInsertImages = vi.fn();
  // The single view's classifier, by MIME then by the name's extension (image-input.js).
  (app as unknown as { _promptAttachKind: (f: { type: string; name?: string }) => string | null })._promptAttachKind = (
    f
  ) => (/^(image|video)\//.test(f.type) ? 'image' : /\.(pdf|docx|md)$/i.test(f.name || '') ? 'document' : null);
  app.openTileGrid(ids, { focusedId: 's-a' });
  return app;
}

const slot = () => section.children.find((el) => el.classList.contains('tile-slot'))!;
const PNG = { type: 'image/png', name: 'shot.png' };

beforeEach(() => {
  resetGridHarness();
});

describe('a file dropped on a tile', () => {
  it("uploads its images to that tile's session (not the focused one), the page staying put", () => {
    const app = gridApp();
    // Deep inside the tile, as on xterm's rows or its helper textarea.
    const inner = tileEl('s-b').querySelector('.tile-body')!;
    const over = fileEvent(inner, [PNG]);
    section.dispatch('dragover', over);
    expect(over.preventDefault).toHaveBeenCalled();
    expect(over.dataTransfer.dropEffect).toBe('copy');

    const drop = fileEvent(inner, [PNG, { type: 'image/jpeg' }]);
    section.dispatch('drop', drop);
    expect(drop.preventDefault).toHaveBeenCalled();
    expect(app._uploadAndInsertImages).toHaveBeenCalledTimes(1);
    expect(app._uploadAndInsertImages).toHaveBeenCalledWith([PNG, { type: 'image/jpeg' }], { sessionId: 's-b' });
    // A drop is not a selection: focus stays where it was.
    expect(app.activeSessionId).toBe('s-a');
  });

  it('only the files the classifier admits are uploaded: a document and a video count, an unnamed text part does not', () => {
    const app = gridApp();
    const pdf = { type: 'application/pdf', name: 'Q3 report.pdf' };
    const mov = { type: 'video/quicktime', name: 'IMG_0001.MOV' };
    section.dispatch('drop', fileEvent(tileEl('s-c'), [{ type: 'text/plain' }, PNG, pdf, mov]));
    expect(app._uploadAndInsertImages).toHaveBeenCalledWith([PNG, pdf, mov], { sessionId: 's-c' });
  });

  it('a drop with nothing the classifier admits says so, as the single view does, and uploads nothing', () => {
    const app = gridApp();
    const drop = fileEvent(tileEl('s-b'), [{ type: 'application/x-sh', name: 'run.sh' }]);
    section.dispatch('drop', drop);
    expect(drop.preventDefault).toHaveBeenCalled();
    expect(app._uploadAndInsertImages).not.toHaveBeenCalled();
    expect(app.showToast).toHaveBeenCalledWith('Unsupported file type', 'error');
  });
});

describe('a file dragged anywhere else over the grid', () => {
  it('an empty cell, a divider or the padding: cancelled (no navigation), nothing uploaded', () => {
    const app = gridApp([...IDS, 's-d', 's-e']);
    for (const target of [slot(), section]) {
      expect(target).toBeTruthy();
      const over = fileEvent(target, [PNG]);
      section.dispatch('dragover', over);
      expect(over.preventDefault).toHaveBeenCalled();
      const drop = fileEvent(target, [PNG]);
      section.dispatch('drop', drop);
      expect(drop.preventDefault).toHaveBeenCalled();
    }
    expect(app._uploadAndInsertImages).not.toHaveBeenCalled();
    expect(app.showToast).not.toHaveBeenCalled();
  });
});

describe('tab and tile drags are left to their targets', () => {
  it('a drag that carries no files is not touched by the grid section', () => {
    const app = gridApp();
    app.draggedTabId = 's-other';
    const over = fileEvent(section, [], ['text/plain']);
    section.dispatch('dragover', over);
    section.dispatch('drop', over);
    expect(over.preventDefault).not.toHaveBeenCalled();
    expect(app._uploadAndInsertImages).not.toHaveBeenCalled();
  });

  it("a tab dropped on a tile still replaces it through the tile's own handler", () => {
    const app = gridApp();
    app.draggedTabId = 's-other';
    const drop = fileEvent(tileEl('s-b'), [], ['text/plain']);
    tileEl('s-b').dispatch('drop', drop);
    expect(app._tileGrid.ids).toContain('s-other');
    expect(app._tileGrid.ids).not.toContain('s-b');
    expect(app._uploadAndInsertImages).not.toHaveBeenCalled();
  });
});

describe('the guard is installed once', () => {
  it('opening and closing the grid again never stacks listeners', () => {
    const app = gridApp();
    app.closeTileGrid({ reselect: false });
    app.openTileGrid(IDS);
    app.closeTileGrid({ reselect: false });
    app.openTileGrid(IDS);
    expect(section.listeners.dragover).toHaveLength(1);
    expect(section.listeners.drop).toHaveLength(1);
    // Bubble phase: the tab and tile drop targets stop their own drags in capture.
    expect(section.captureFlags.drop).toEqual([false]);
  });
});
