/**
 * Session lineage lines (tab → tab it spawned).
 *
 * Geometry: every decision about WHERE a route runs lives in computeLineageTree
 * (constants.js), so it is pinned here without a browser. The rules that matter:
 * a route never crosses a tab, siblings share one trunk, rows are joined through a
 * spine left of every tab, and families drawn together sit in separate lanes.
 *
 * Rendering: session-lineage.js is loaded for real in a vm sandbox with a tiny fake
 * DOM, to pin the focus rule (only the SELECTED tab's family is drawn), the
 * per-parent colours, and the reserved routing room.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

type Rect = { left: number; top: number; width: number; height: number };
type Point = [number, number];
type Route = { id: string; points: Point[]; d: string; endX: number; endY: number };
type TreeInput = {
  parent: Rect | null;
  children: Array<{ id: string; rect: Rect | null }>;
  strip?: Rect;
  tabs?: Rect[];
  spineLeft?: number;
  orientation?: 'horizontal' | 'vertical';
  lane?: number;
  laneCount?: number;
  radius?: number;
};
type LineageHelper = {
  computeTree: (input: TreeInput) => { routes: Route[] } | null;
  computeRows: (rects: Rect[]) => Array<{ top: number; bottom: number }>;
  CORNER_RADIUS_PX: number;
  LANE_STEP_PX: number;
  SPINE_INSET_PX: number;
  VERTICAL_TRACK_INSET_PX: number;
  COLORS: string[];
};

const PUBLIC = resolve(import.meta.dirname, '../src/web/public');
const read = (file: string) => readFileSync(resolve(PUBLIC, file), 'utf8');
const lineageJs = read('session-lineage.js');
const stylesCss = read('styles.css');
const appJs = read('app.js');

function loadLineageHelper(): LineageHelper {
  const context = vm.createContext({ window: {}, globalThis: {} });
  vm.runInContext(read('constants.js'), context, { filename: 'constants.js' });
  return (context.window as { CodemanLineage: LineageHelper }).CodemanLineage;
}

const tab = (left: number, top = 4, width = 120, height = 30): Rect => ({ left, top, width, height });

/**
 * A wrapped strip shaped like the owner's 2026-10-06 report: five rows, 12px row gap,
 * the 20px spine channel reserved on the left, 14px of bottom padding.
 */
function wrappedStrip() {
  const strip: Rect = { left: 100, top: 0, width: 1000, height: 0 };
  const widths = [
    [150, 120, 190, 140, 150, 170],
    [140, 140, 140, 140, 140, 90, 90],
    [130, 110, 100, 100, 110, 120, 140],
    [180, 140, 80, 140, 170, 120, 100],
    [150, 120, 110, 90, 110, 100, 120],
  ];
  const rows: Rect[][] = [];
  let top = 4;
  for (const row of widths) {
    let left = strip.left + 20;
    const cells: Rect[] = [];
    for (const w of row) {
      cells.push(tab(left, top, w));
      left += w + 2;
    }
    rows.push(cells);
    top += 30 + 12;
  }
  strip.height = top - 12 + 14;
  return { strip, rows, all: rows.flat() };
}

/**
 * The header strip grouped by state (tabArrangement 'state', the default): a label
 * column 85px wide at the strip's left edge, then the 20px spine channel, then the
 * tabs; rows 42px apart. The first row starts beside the brand (83px) with its own
 * label, so its first tab sits at `leadLeft` from the strip's edge.
 */
function stateRowsStrip({ leadLeft = 160 } = {}) {
  const strip: Rect = { left: 12, top: 6, width: 1300, height: 0 };
  const gutter = 85;
  const channel = 20;
  const labels: Rect[] = [];
  const rows: Rect[][] = [];
  let top = 8;
  for (const [i, widths] of [
    [120, 110, 130],
    [150, 120, 140, 110],
    [140, 120, 200],
    [130, 120],
  ].entries()) {
    let left = i === 0 ? strip.left + leadLeft : strip.left + gutter + channel;
    // A label is a line of text inside its row: lead after the brand, the rest in
    // the column, each narrower than the column (its widest label + 10px).
    labels.push({ left: i === 0 ? strip.left + 83 : strip.left, top: top + 10, width: i === 0 ? 70 : 60, height: 10 });
    const cells: Rect[] = [];
    for (const w of widths) {
      cells.push(tab(left, top, w));
      left += w + 2;
    }
    rows.push(cells);
    top += 30 + 12;
  }
  strip.height = top - 6 + 2;
  return { strip, gutter, channel, labels, rows, all: rows.flat() };
}

/** Does an axis-aligned segment pass through the INSIDE of a rect (touching an edge is fine)? */
function crossesRect([x1, y1]: Point, [x2, y2]: Point, r: Rect): boolean {
  const eps = 0.5;
  const left = r.left + eps;
  const right = r.left + r.width - eps;
  const top = r.top + eps;
  const bottom = r.top + r.height - eps;
  if (x1 === x2) return x1 > left && x1 < right && Math.max(y1, y2) > top && Math.min(y1, y2) < bottom;
  return y1 > top && y1 < bottom && Math.max(x1, x2) > left && Math.min(x1, x2) < right;
}

const center = (r: Rect) => r.left + r.width / 2;
const bottom = (r: Rect) => r.top + r.height;

describe('lineage tree geometry: header strip', () => {
  it('routes each child from the parent bottom-center to the child bottom-center', () => {
    const helper = loadLineageHelper();
    const strip: Rect = { left: 0, top: 0, width: 1200, height: 50 };
    const parent = tab(0);
    const geom = helper.computeTree({
      parent,
      children: [
        { id: 'a', rect: tab(400) },
        { id: 'b', rect: tab(800) },
      ],
      strip,
    })!;

    expect(geom.routes.map((r) => r.id)).toEqual(['a', 'b']);
    for (const route of geom.routes) {
      expect(route.points[0]).toEqual([60, 34]);
      expect(route.d.startsWith('M 60 34')).toBe(true);
      expect(route.d).not.toContain('NaN');
    }
    expect([geom.routes[0].endX, geom.routes[0].endY]).toEqual([460, 34]);
    expect([geom.routes[1].endX, geom.routes[1].endY]).toEqual([860, 34]);
  });

  it('keeps a one-row family in the gap under the row, never over the terminal', () => {
    const helper = loadLineageHelper();
    // Tabs end at 34, the strip (with its reserved bottom padding) at 50.
    const strip: Rect = { left: 0, top: 0, width: 1200, height: 50 };
    const geom = helper.computeTree({ parent: tab(0), children: [{ id: 'a', rect: tab(400) }], strip })!;
    const [route] = geom.routes;

    expect(route.points).toEqual([
      [60, 34],
      [60, 42],
      [460, 42],
      [460, 34],
    ]);
    for (const [, y] of route.points) {
      expect(y).toBeGreaterThanOrEqual(34);
      expect(y).toBeLessThanOrEqual(50);
    }
  });

  it('never crosses a tab in a wrapped strip, wherever parent and children sit', () => {
    // The reported bug: a parent on row 3 with children on rows 3-5 drew curves
    // straight through every lower row's labels and into the terminal.
    const helper = loadLineageHelper();
    const { strip, rows, all } = wrappedStrip();
    const parent = rows[2][1];
    const children = [rows[0][3], rows[2][2], rows[2][5], rows[3][0], rows[3][6], rows[4][1], rows[4][6]].map(
      (rect, i) => ({ id: `c${i}`, rect })
    );
    const geom = helper.computeTree({ parent, children, strip, tabs: all })!;

    expect(geom.routes).toHaveLength(children.length);
    for (const route of geom.routes) {
      for (let i = 1; i < route.points.length; i++) {
        for (const r of all) {
          expect(crossesRect(route.points[i - 1], route.points[i], r), `${route.id} segment ${i} vs tab`).toBe(false);
        }
      }
      // Nothing hangs below the strip into the terminal.
      for (const [, y] of route.points) expect(y).toBeLessThanOrEqual(strip.top + strip.height);
    }
  });

  it('joins rows through one spine, left of every tab and inside the strip', () => {
    const helper = loadLineageHelper();
    const { strip, rows, all } = wrappedStrip();
    const geom = helper.computeTree({
      parent: rows[2][1],
      children: [
        { id: 'below', rect: rows[4][3] },
        { id: 'above', rect: rows[0][2] },
      ],
      strip,
      tabs: all,
    })!;
    const minTabLeft = Math.min(...all.map((r) => r.left));

    const spines = geom.routes.map((r) => r.points[2][0]);
    expect(new Set(spines).size).toBe(1);
    expect(spines[0]).toBeGreaterThan(strip.left);
    expect(spines[0]).toBeLessThan(minTabLeft);
    expect(spines[0]).toBe(strip.left + helper.SPINE_INSET_PX);
  });

  it('shares one trunk: sibling routes start identically and branch at their own row', () => {
    const helper = loadLineageHelper();
    const { strip, rows, all } = wrappedStrip();
    const geom = helper.computeTree({
      parent: rows[1][2],
      children: [
        { id: 'r3a', rect: rows[3][1] },
        { id: 'r3b', rect: rows[3][4] },
        { id: 'r4', rect: rows[4][2] },
      ],
      strip,
      tabs: all,
    })!;
    const [a, b, c] = geom.routes;

    // Parent stem, the run along the parent's gap, and the spine are common to all.
    expect(a.points.slice(0, 3)).toEqual(b.points.slice(0, 3));
    expect(a.points.slice(0, 3)).toEqual(c.points.slice(0, 3));
    // The two row-3 children also share that row's gap line until they branch.
    expect(a.points[3]).toEqual(b.points[3]);
    expect(a.points[4][1]).toBe(b.points[4][1]);
    expect(c.points[3][1]).toBeGreaterThan(a.points[3][1]);
  });

  it("hangs a row's gap under its TALLEST tab, so siblings in one row share a bus", () => {
    const helper = loadLineageHelper();
    const strip: Rect = { left: 0, top: 0, width: 1200, height: 52 };
    // The active tab is 2px taller than its neighbours.
    const tabs = [tab(0), tab(140, 4, 120, 32), tab(280), tab(420)];
    const rows = helper.computeRows(tabs);
    expect(rows).toEqual([{ top: 4, bottom: 36 }]);

    const geom = helper.computeTree({
      parent: tabs[0],
      children: [
        { id: 'tall', rect: tabs[1] },
        { id: 'short', rect: tabs[3] },
      ],
      strip,
      tabs,
    })!;
    expect(geom.routes[0].points[2][1]).toBe(geom.routes[1].points[2][1]);
    expect(geom.routes[0].points[2][1]).toBe(44);
  });

  it('puts two families drawn together in separate lanes', () => {
    const helper = loadLineageHelper();
    const { strip, rows, all } = wrappedStrip();
    const input = { parent: rows[2][1], children: [{ id: 'x', rect: rows[3][2] }], strip, tabs: all, laneCount: 2 };
    const first = helper.computeTree({ ...input, lane: 0 })!.routes[0];
    const second = helper.computeTree({ ...input, lane: 1 })!.routes[0];

    expect(second.points[1][1] - first.points[1][1]).toBeCloseTo(helper.LANE_STEP_PX, 1);
    expect(second.points[2][0]).toBeGreaterThan(first.points[2][0]);
    expect([second.endX, second.endY]).toEqual([first.endX, first.endY]);
  });

  it('rounds corners, and draws them square with radius 0', () => {
    const helper = loadLineageHelper();
    const { strip, rows, all } = wrappedStrip();
    const input = { parent: rows[2][1], children: [{ id: 'x', rect: rows[4][4] }], strip, tabs: all };

    expect(helper.computeTree(input)!.routes[0].d).toContain(' Q ');
    expect(helper.computeTree({ ...input, radius: 0 })!.routes[0].d).not.toContain(' Q ');
    expect(helper.CORNER_RADIUS_PX).toBeGreaterThan(0);
  });

  it('leaves out a child scrolled out of the strip, and draws nothing for a scrolled-out parent', () => {
    const helper = loadLineageHelper();
    // `.session-tabs` scrolls, so a scrolled-out tab still HAS a rect, one lying
    // over the logo or the header buttons. It must not be drawn to.
    const strip: Rect = { left: 200, top: 0, width: 600, height: 50 };

    const partial = helper.computeTree({
      parent: tab(300),
      children: [
        { id: 'in', rect: tab(600) },
        { id: 'out', rect: tab(1400) },
      ],
      strip,
    })!;
    expect(partial.routes.map((r) => r.id)).toEqual(['in']);
    expect(helper.computeTree({ parent: tab(-300), children: [{ id: 'a', rect: tab(400) }], strip })).toBeNull();
  });

  it('returns null for a missing or degenerate parent, and drops a degenerate child', () => {
    const helper = loadLineageHelper();
    const strip: Rect = { left: 0, top: 0, width: 1200, height: 50 };

    expect(helper.computeTree({ parent: null, children: [{ id: 'a', rect: tab(0) }], strip })).toBeNull();
    expect(helper.computeTree({ parent: { left: 0, top: 0, width: 0, height: 0 }, children: [], strip })).toBeNull();
    const geom = helper.computeTree({
      parent: tab(0),
      children: [
        { id: 'zero', rect: { left: 400, top: 4, width: 0, height: 30 } },
        { id: 'none', rect: null },
        { id: 'ok', rect: tab(400) },
      ],
      strip,
    })!;
    expect(geom.routes.map((r) => r.id)).toEqual(['ok']);
  });

  it('runs the spine between the state labels and the tabs, never through a label', () => {
    // tabArrangement 'state': a label column at the strip's left edge, the spine
    // channel after it, the tabs after that. The first row starts beside the
    // brand with a label of its own width. The spine used to sit at the strip's
    // edge, which grouped by state is the label column.
    const helper = loadLineageHelper();
    const { strip, gutter, channel, labels, rows, all } = stateRowsStrip();
    const parent = rows[2][2];
    const children = [rows[0][1], rows[1][0], rows[1][2], rows[3][0], rows[3][1]].map((rect, i) => ({
      id: `c${i}`,
      rect,
    }));
    const geom = helper.computeTree({ parent, children, strip, tabs: all, spineLeft: strip.left + gutter })!;

    expect(geom.routes).toHaveLength(children.length);
    const spineX = geom.routes.find((r) => r.id === 'c3')!.points[2][0];
    expect(spineX).toBe(strip.left + gutter + helper.SPINE_INSET_PX);
    // Right of the label column (the first row's label, beside the brand, is never
    // passed: the spine only runs beside the rows under it), left of the tabs.
    expect(spineX).toBeGreaterThan(Math.max(...labels.slice(1).map((r) => r.left + r.width)));
    expect(spineX).toBeLessThan(strip.left + gutter + channel);
    for (const route of geom.routes) {
      for (let i = 1; i < route.points.length; i++) {
        for (const r of [...all, ...labels]) {
          expect(crossesRect(route.points[i - 1], route.points[i], r), `${route.id} segment ${i}`).toBe(false);
        }
      }
    }
  });

  it('keeps the spine in its channel when the first row starts left of it', () => {
    // A quiet first group (idle, no label) puts the first row's first tab just
    // after the brand, left of the channel. The spine never runs beside the first
    // row, so that tab must not drag it back over the label column.
    const helper = loadLineageHelper();
    const { strip, gutter, labels, rows, all } = stateRowsStrip({ leadLeft: 80 });
    expect(rows[0][0].left).toBeLessThan(strip.left + gutter + helper.SPINE_INSET_PX);
    const geom = helper.computeTree({
      parent: rows[0][1],
      children: [{ id: 'low', rect: rows[3][1] }],
      strip,
      tabs: all,
      spineLeft: strip.left + gutter,
    })!;
    const spineX = geom.routes[0].points[2][0];

    expect(spineX).toBe(strip.left + gutter + helper.SPINE_INSET_PX);
    expect(spineX).toBeGreaterThan(Math.max(...labels.slice(1).map((r) => r.left + r.width)));
  });

  it('still draws when no strip rect is supplied (clipping is opt-in)', () => {
    const helper = loadLineageHelper();
    const geom = helper.computeTree({ parent: tab(0), children: [{ id: 'far', rect: tab(9000, 46) }] })!;

    expect(geom.routes).toHaveLength(1);
    expect(geom.routes[0].d).not.toContain('NaN');
  });
});

describe('lineage tree geometry: never through a tab, in any arrangement', () => {
  // Measured live (1440x900, tabArrangement 'case', nine tabs in four cases) before
  // the case boxes kept their width: every box squeezed and wrapped inside itself,
  // so tabs sat at tops 10, 20, 42 and 43 with spans that overlap. The old rows
  // (grouped by top alone) put the "gap" under the first row at y 30, inside the
  // tabs, and the routes ran through them.
  const strip: Rect = { left: 94, top: 6, width: 980, height: 85 };
  const squeezed: Record<string, Rect> = {
    'w1-webshop': { left: 201, top: 10, width: 99, height: 30 },
    'w2-webshop': { left: 109, top: 42, width: 101, height: 30 },
    'w3-webshop': { left: 212, top: 42, width: 101, height: 30 },
    'w1-api-gateway': { left: 518, top: 10, width: 99, height: 30 },
    'w2-api-gateway': { left: 407, top: 42, width: 143, height: 32 },
    'w3-api-gateway': { left: 552, top: 43, width: 101, height: 30 },
    'w1-notes': { left: 744, top: 20, width: 136, height: 30 },
    'w1-docs-site': { left: 968, top: 10, width: 99, height: 30 },
    'w2-docs-site': { left: 870, top: 42, width: 101, height: 30 },
  };
  const all = Object.values(squeezed);

  it('makes overlapping spans one row, so no gap is ever inside a tab', () => {
    const helper = loadLineageHelper();
    // 10-40 and 20-50 overlap, and 42-74 overlaps 20-50: one row, no gap inside.
    expect(helper.computeRows(all)).toEqual([{ top: 10, bottom: 74 }]);
    // Rows that only share a top (the active tab is taller) stay one row, and rows
    // with a real gap between them stay apart.
    expect(helper.computeRows([tab(0, 4), tab(130, 4, 120, 32), tab(0, 46)])).toEqual([
      { top: 4, bottom: 36 },
      { top: 46, bottom: 76 },
    ]);
  });

  it('draws no segment inside a tab, whichever tab is the parent or the child', () => {
    const helper = loadLineageHelper();
    const names = Object.keys(squeezed);
    let drawn = 0;
    for (const parentName of names) {
      for (const lane of [0, 1, 2]) {
        const children = names.filter((n) => n !== parentName).map((n) => ({ id: n, rect: squeezed[n] }));
        const geom = helper.computeTree({
          parent: squeezed[parentName],
          children,
          strip,
          tabs: all,
          lane,
          laneCount: 3,
        });
        for (const route of geom?.routes ?? []) {
          drawn++;
          for (let i = 1; i < route.points.length; i++) {
            for (const r of all) {
              expect(crossesRect(route.points[i - 1], route.points[i], r), `${parentName} -> ${route.id}`).toBe(false);
            }
          }
        }
      }
    }
    // Some routes still have a clean way (a tab with nothing under it), so the
    // check above is not vacuous.
    expect(drawn).toBeGreaterThan(0);
  });

  it('draws nothing into rows with no gap between them', () => {
    const helper = loadLineageHelper();
    // Two rows touching (no row gap at all): the only place a route could run is
    // through the tabs of the other row.
    const upper = [tab(0, 4), tab(130, 4)];
    const lower = [tab(0, 34), tab(130, 34)];
    const geom = helper.computeTree({
      parent: upper[0],
      children: [
        { id: 'below', rect: lower[1] },
        { id: 'beside', rect: upper[1] },
      ],
      strip: { left: 0, top: 0, width: 600, height: 80 },
      tabs: [...upper, ...lower],
    })!;
    expect(geom.routes).toEqual([]);
  });
});

describe('lineage tree geometry: vertical rail', () => {
  const strip: Rect = { left: 100, top: 20, width: 320, height: 320 };
  const parent: Rect = { left: 132, top: 40, width: 260, height: 40 };

  it('routes every sibling down ONE track in the empty left gutter', () => {
    const helper = loadLineageHelper();
    const geom = helper.computeTree({
      parent,
      children: [
        { id: 'a', rect: { ...parent, top: 120 } },
        { id: 'b', rect: { ...parent, top: 200 } },
      ],
      strip,
      orientation: 'vertical',
    })!;

    const tracks = geom.routes.map((r) => r.points[1][0]);
    expect(new Set(tracks).size).toBe(1);
    expect(tracks[0]).toBe(strip.left + helper.VERTICAL_TRACK_INSET_PX);
    expect(tracks[0]).toBeLessThan(parent.left);
    for (const route of geom.routes) {
      expect(route.points[0]).toEqual([parent.left, 60]);
      expect(route.endX).toBe(parent.left);
    }
    expect(geom.routes.map((r) => r.endY)).toEqual([140, 220]);
  });

  it('keeps the same shape when the child sits above its parent', () => {
    const helper = loadLineageHelper();
    const low = { ...parent, top: 220 };
    const geom = helper.computeTree({
      parent: low,
      children: [{ id: 'up', rect: { ...parent, top: 60 } }],
      strip,
      orientation: 'vertical',
    })!;
    const [route] = geom.routes;

    expect(route.points[0]).toEqual([low.left, 240]);
    expect([route.endX, route.endY]).toEqual([low.left, 80]);
  });

  it('clips by the visible Y range after the rail scrolls', () => {
    const helper = loadLineageHelper();
    const scrolled: Rect = { left: 100, top: 100, width: 320, height: 300 };
    const visible: Rect = { left: 132, top: 160, width: 260, height: 40 };
    const above: Rect = { left: 132, top: 20, width: 260, height: 40 };
    const below: Rect = { left: 132, top: 460, width: 260, height: 40 };

    expect(
      helper.computeTree({
        parent: above,
        children: [{ id: 'v', rect: visible }],
        strip: scrolled,
        orientation: 'vertical',
      })
    ).toBeNull();
    expect(
      helper.computeTree({
        parent: visible,
        children: [{ id: 'b', rect: below }],
        strip: scrolled,
        orientation: 'vertical',
      })!.routes
    ).toEqual([]);
  });
});

describe('lineage wiring', () => {
  it('passes the resolved DOM orientation into geometry and reserves a vertical gutter', () => {
    expect(lineageJs).toContain("getAttribute('data-tab-orientation')");
    expect(lineageJs).toMatch(/computeTree\(\{[\s\S]{0,260}orientation/);
    const selector = "html[data-tab-orientation='vertical'] .tab-rail .session-tabs {";
    const verticalRailBlock = stylesCss.slice(stylesCss.indexOf(selector), stylesCss.indexOf(selector) + 600);
    expect(verticalRailBlock).toContain('--lineage-vertical-gutter');
    expect(verticalRailBlock).toContain('padding-left');
  });

  it('reserves the header strip routing room in CSS', () => {
    const block = (selector: string) => {
      const start = stylesCss.indexOf(selector);
      expect(start, `${selector} not found`).toBeGreaterThan(-1);
      return stylesCss.slice(start, stylesCss.indexOf('}', start));
    };
    expect(block('.session-tabs.lineage-tree {')).toContain('padding-bottom');
    const wrapped = block('.session-tabs.lineage-tree.tabs-auto-wrap {');
    expect(wrapped).toContain('row-gap');
    expect(wrapped).toContain('padding-left');
  });

  it('keeps the routing row gap in every tab arrangement through one variable', () => {
    // The ledger grid and the case clusters set their own `gap` at a specificity
    // that beat the lineage rule, packing the lanes onto the cell borders. Every
    // arrangement now reads the one variable, which only the lineage rule sets.
    expect(stylesCss.match(/--lineage-row-gap:/g)).toHaveLength(1);
    const wrapped = stylesCss.slice(stylesCss.indexOf('.session-tabs.lineage-tree.tabs-auto-wrap {'));
    expect(wrapped.slice(0, wrapped.indexOf('}'))).toMatch(
      /--lineage-row-gap: 12px;\s[^}]*row-gap: var\(--lineage-row-gap\);/
    );
    expect(stylesCss).toMatch(
      /\.session-tabs-host > \.session-tabs\.tabs-ledger \{[^}]*gap: var\(--lineage-row-gap, 4px\) 6px;/
    );
    expect(stylesCss).toMatch(
      /\.session-tabs-host > \.session-tabs\.tabs-clusters \{\s*gap: var\(--lineage-row-gap, 6px\) 6px;/
    );
    expect(stylesCss).toMatch(
      /\.session-tabs-host > \.session-tabs\.tabs-clusters > \.tab-cluster \{[^}]*gap: var\(--lineage-row-gap, 2px\) 2px;/
    );
    // No arrangement may hard-code a gap the lineage rows depend on.
    expect(stylesCss).not.toMatch(/\.session-tabs\.tabs-(ledger|clusters) \{[^}]*\bgap: \d+px( \d+px)?;/);
  });

  it('syncs the routing room before the wrap is measured, and redraws on selection', () => {
    const overflow = appJs.slice(appJs.indexOf('  updateTabOverflowMode() {'));
    expect(overflow.indexOf('_syncLineageGutter')).toBeGreaterThan(-1);
    expect(overflow.indexOf('_syncLineageGutter')).toBeLessThan(overflow.indexOf('shouldAutoWrapTabs'));
    const activeTab = appJs.slice(
      appJs.indexOf('  _updateActiveTabImmediate(sessionId) {'),
      appJs.indexOf('  _scrollActiveTabIntoView(sessionId')
    );
    expect(activeTab).toMatch(/_lineageTotalEdges > 0\) this\.updateConnectionLines\(\)/);
  });

  it('exposes a colour palette whose first entry defers to the skin blue', () => {
    const colors = loadLineageHelper().COLORS;
    // '' = no override: session-lineage.js sets no inline --lineage-color and the
    // CSS falls back to the skin-tuned --session-blue, so a lone family stays blue.
    expect(colors[0]).toBe('');
    expect(colors.length).toBeGreaterThanOrEqual(6);
    expect(new Set(colors).size).toBe(colors.length);
    for (const c of colors.slice(1)) expect(c).toMatch(/^#[0-9a-f]{6}$/i);
  });
});

// ─── Rendering through the real session-lineage.js ────────────────────────────

type FakeNode = {
  tag: string;
  attrs: Record<string, string>;
  style: Record<string, string> & { setProperty: (k: string, v: string) => void };
  children: FakeNode[];
  setAttribute: (k: string, v: string) => void;
  appendChild: (n: FakeNode) => void;
};
type LineageApp = Record<string, Function> & {
  sessions: Map<string, { parentSessionId: string | null; status: string }>;
  sessionOrder: string[];
  activeSessionId: string | null;
  activeWebviewId: string | null;
  _lineageEdgeCount: number;
  _lineageTotalEdges: number;
};

function fakeNode(tag: string): FakeNode {
  const style = {} as FakeNode['style'];
  style.setProperty = (k, v) => void (style[k] = v);
  const node: FakeNode = {
    tag,
    attrs: {},
    style,
    children: [],
    setAttribute: (k, v) => void (node.attrs[k] = v),
    appendChild: (n) => void node.children.push(n),
  };
  return node;
}

/**
 * Load session-lineage.js for real, on a one-row strip where every session is a
 * 120px tab, 140px apart. The colour memo is plain state on the app instance.
 */
function loadLineageApp(
  sessions: Record<string, string | null>,
  status: Record<string, string> = {},
  layout: { rect?: (i: number) => Rect; style?: Record<string, string> } = {}
) {
  function CodemanApp(this: unknown) {}
  const ids = Object.keys(sessions);
  const rect = (i: number) => {
    const r = layout.rect ? layout.rect(i) : { left: i * 140, top: 4, width: 120, height: 30 };
    return { ...r, right: r.left + r.width, bottom: r.top + r.height };
  };
  const stripClasses = new Set<string>();
  const listeners: Record<string, (e: { propertyName: string }) => void> = {};
  const strip = {
    addEventListener: (type: string, fn: (e: { propertyName: string }) => void) => void (listeners[type] = fn),
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 4000, height: 50, right: 4000, bottom: 50 }),
    querySelector: (sel: string) => {
      const id = /data-id="([^"]+)"/.exec(sel)?.[1];
      const i = id ? ids.indexOf(id) : -1;
      return i < 0 ? null : { getBoundingClientRect: () => rect(i) };
    },
    querySelectorAll: () => ids.map((id, i) => ({ getAttribute: () => id, getBoundingClientRect: () => rect(i) })),
    classList: {
      contains: (c: string) => stripClasses.has(c),
      toggle: (c: string, on: boolean) => void (on ? stripClasses.add(c) : stripClasses.delete(c)),
    },
  };
  const sandbox: Record<string, unknown> = {
    window: {},
    globalThis: {},
    CodemanApp,
    MobileDetection: { getDeviceType: () => 'desktop' },
    CSS: { escape: (v: string) => v },
    // The strip's computed style, when a test lays one out (the spine channel).
    ...(layout.style
      ? {
          getComputedStyle: () => ({
            ...layout.style,
            getPropertyValue: (name: string) => layout.style![name] ?? '',
          }),
        }
      : {}),
    document: {
      documentElement: { getAttribute: () => 'horizontal' },
      getElementById: (id: string) => (id === 'sessionTabs' ? strip : null),
      createElementNS: (_ns: string, tag: string) => fakeNode(tag),
    },
  };
  const context = vm.createContext(sandbox);
  for (const file of ['constants.js', 'session-lineage.js']) {
    vm.runInContext(read(file), context, { filename: file });
  }
  const app = new (CodemanApp as unknown as new () => LineageApp)();
  app.sessions = new Map(ids.map((id) => [id, { parentSessionId: sessions[id], status: status[id] ?? 'idle' }]));
  app.sessionOrder = ids;
  app.activeSessionId = null;
  app.activeWebviewId = null;
  app._lineageLinesEnabled = () => true;
  app.isSessionSidebarActive = () => false;
  app._isVerticalTabList = () => false;
  return { app, stripClasses, listeners };
}

/** Draw with `active` selected; report each family group and its routes. */
function draw(app: LineageApp, active: string | null) {
  app.activeSessionId = active;
  const svg = fakeNode('svg');
  app._appendLineageConnectionLines(svg, new Map());
  return svg.children.map((group) => ({
    parent: group.attrs['data-parent-tab'],
    focus: group.attrs.class.split(' ').includes('lineage-family--focus'),
    paths: group.children.filter((n) => n.tag === 'path'),
    dots: group.children.filter((n) => n.tag === 'circle'),
  }));
}

const family = (families: ReturnType<typeof draw>, parent: string) => families.find((f) => f.parent === parent)!;

const childIds = (families: ReturnType<typeof draw>) =>
  families.flatMap((f) => f.paths.map((p) => p.attrs['data-child-tab']));

describe('lineage focus: every family is drawn, the selected one emphasized', () => {
  const fleet = { w1: null, a: 'w1', b: 'w1', w2: null, c: 'w2', w3: null };
  const focused = (families: ReturnType<typeof draw>) => families.filter((f) => f.focus).map((f) => f.parent);

  it('draws every family whichever tab is selected, the selected one last and emphasized', () => {
    const { app } = loadLineageApp(fleet);
    const families = draw(app, 'w1');

    // Drawn last, so no other family's line covers it.
    expect(families.map((f) => f.parent)).toEqual(['w2', 'w1']);
    expect(focused(families)).toEqual(['w1']);
    expect(childIds(families).sort()).toEqual(['a', 'b', 'c']);
    expect(app._lineageEdgeCount).toBe(3);
    expect(app._lineageTotalEdges).toBe(3);
  });

  it('emphasizes the parent and siblings of a selected child', () => {
    const { app } = loadLineageApp(fleet);
    expect(focused(draw(app, 'a'))).toEqual(['w1']);
    expect(focused(draw(app, 'c'))).toEqual(['w2']);
  });

  it('emphasizes both families of a tab that is a child AND a parent', () => {
    const { app } = loadLineageApp({ w1: null, a: 'w1', x: 'a', y: 'a', w2: null, c: 'w2' });
    const families = draw(app, 'a');

    expect(focused(families)).toEqual(['w1', 'a']);
    expect(families.map((f) => f.parent)).toEqual(['w2', 'w1', 'a']);
  });

  it('still draws everything, emphasizing nothing, for a tab without lineage or a web tab', () => {
    const { app } = loadLineageApp(fleet);
    const plain = draw(app, 'w3');
    expect(plain.map((f) => f.parent)).toEqual(['w1', 'w2']);
    expect(focused(plain)).toEqual([]);
    app.activeWebviewId = 'dash';
    const web = draw(app, 'w1');
    expect(web).toHaveLength(2);
    expect(focused(web)).toEqual([]);
  });

  it('keeps every family in its lane when the selection moves', () => {
    // Lanes follow strip order, so selecting another tab changes only the emphasis
    // and the draw order, never where a family's lines run.
    const { app } = loadLineageApp(fleet);
    const before = family(draw(app, 'w1'), 'w2').paths.map((p) => p.attrs.d);
    const after = family(draw(app, 'w2'), 'w2').paths.map((p) => p.attrs.d);
    expect(after).toEqual(before);
  });

  it('keeps the data-agent-id the entrance animation looks for, and a dot per child', () => {
    const { app } = loadLineageApp(fleet);
    const w1 = family(draw(app, 'w1'), 'w1');

    expect(w1.paths.map((p) => p.attrs['data-agent-id'])).toEqual(['lineage:a', 'lineage:b']);
    expect(w1.dots.map((d) => d.attrs['data-child-tab'])).toEqual(['a', 'b']);
  });

  it('puts working routes first, so an idle sibling draws the shared trunk solid', () => {
    const { app } = loadLineageApp(fleet, { b: 'working' });
    const w1 = family(draw(app, 'w1'), 'w1');

    expect(w1.paths.map((p) => p.attrs['data-child-tab'])).toEqual(['b', 'a']);
    expect(w1.paths[0].attrs.class).toContain('lineage-line--working');
    expect(w1.paths[1].attrs.class).not.toContain('lineage-line--working');
  });

  it('makes the emphasized family thicker in CSS, after the base rule', () => {
    const base = stylesCss.indexOf('.connection-line.lineage-line {');
    const focus = stylesCss.indexOf('.lineage-family--focus .connection-line.lineage-line {');
    expect(base).toBeGreaterThan(-1);
    expect(focus).toBeGreaterThan(base);
    const width = (at: number) => Number(/stroke-width:\s*([\d.]+)/.exec(stylesCss.slice(at))![1]);
    expect(width(focus)).toBeGreaterThan(width(base));
  });
});

describe('lineage routing room', () => {
  it('is reserved while any family exists, whatever is selected', () => {
    const { app, stripClasses } = loadLineageApp({ w1: null, a: 'w1', w2: null });
    app.activeSessionId = 'w2';
    app._syncLineageGutter();
    expect(stripClasses.has('lineage-tree')).toBe(true);
    expect(app._lineageTotalEdges).toBe(1);
  });

  it('is released with no lineage, with the setting off, and in a vertical list', () => {
    const none = loadLineageApp({ w1: null, w2: null });
    none.app._syncLineageGutter();
    expect(none.stripClasses.has('lineage-tree')).toBe(false);

    const off = loadLineageApp({ w1: null, a: 'w1' });
    off.app._syncLineageGutter();
    expect(off.stripClasses.has('lineage-tree')).toBe(true);
    off.app._lineageLinesEnabled = () => false;
    off.app._syncLineageGutter();
    expect(off.stripClasses.has('lineage-tree')).toBe(false);
    expect(off.app._lineageTotalEdges).toBe(0);

    const rail = loadLineageApp({ w1: null, a: 'w1' });
    rail.app._isVerticalTabList = () => true;
    rail.app._syncLineageGutter();
    expect(rail.stripClasses.has('lineage-tree')).toBe(false);
  });
});

describe('lineage spine channel, read back from the laid-out strip', () => {
  // Two rows inside the fake 50px strip: w1 and a on the first, b on the second,
  // so b's route takes the spine.
  const rows = (i: number): Rect => (i < 2 ? tab(200 + i * 140, 2, 120, 14) : tab(125, 28, 120, 14));
  const spineOf = (style?: Record<string, string>) => {
    const { app } = loadLineageApp({ w1: null, a: 'w1', b: 'w1' }, {}, { rect: rows, style });
    const families = draw(app, 'w1');
    const d = family(families, 'w1').paths.find((p) => p.attrs['data-child-tab'] === 'b')!.attrs.d;
    // The spine is the one x the route visits left of every tab.
    return Math.min(...[...d.matchAll(/[MLQ] (-?[\d.]+)/g)].map((m) => Number(m[1])));
  };

  it('opens the channel just left of the content edge the CSS laid out', () => {
    // Grouped by state: an 85px label column, then the 20px channel.
    const spine = spineOf({ '--lineage-spine-channel': ' 20px', paddingLeft: '105px', borderLeftWidth: '0px' });
    expect(spine).toBe(85 + 6);
  });

  it('keeps the strip edge when the channel is the padding itself, or not reserved', () => {
    expect(spineOf({ '--lineage-spine-channel': '20px', paddingLeft: '20px', borderLeftWidth: '0px' })).toBe(6);
    expect(spineOf({ '--lineage-spine-channel': '', paddingLeft: '4px', borderLeftWidth: '0px' })).toBe(6);
    expect(spineOf()).toBe(6);
  });
});

describe('lineage redraw after a selection resizes tabs', () => {
  it('redraws when a size transition in the strip ends, and only for size properties', () => {
    // The active tab reveals its icons by transitioning padding, so it keeps
    // widening after the selection redraw; without this the trunk hung under the
    // tab's old position.
    const { app, listeners } = loadLineageApp({ w1: null, a: 'w1' });
    let redraws = 0;
    app.updateConnectionLines = () => void redraws++;
    app._lineageTotalEdges = 1;
    app._installLineageStripScrollListener();

    listeners.transitionend({ propertyName: 'padding-left' });
    listeners.transitionend({ propertyName: 'width' });
    expect(redraws).toBe(2);
    listeners.transitionend({ propertyName: 'opacity' });
    listeners.transitionend({ propertyName: 'transform' });
    expect(redraws).toBe(2);
    app._lineageTotalEdges = 0;
    listeners.transitionend({ propertyName: 'padding-left' });
    expect(redraws).toBe(2);
  });
});

describe('lineage colours', () => {
  /** Colour of each drawn child's path, after selecting each tab in `selections` in turn. */
  function colorsAfter(sessions: Record<string, string | null>, selections: string[]) {
    const { app } = loadLineageApp(sessions);
    const out: Record<string, string> = {};
    for (const active of selections) {
      for (const family of draw(app, active)) {
        for (const path of family.paths) {
          // The path and its end dot carry the child id; they must agree on the colour.
          const child = path.attrs['data-child-tab'];
          const dot = family.dots.find((d) => d.attrs['data-child-tab'] === child)!;
          expect(dot.style['--lineage-color'] ?? '').toBe(path.style['--lineage-color'] ?? '');
          out[child] = path.style['--lineage-color'] ?? '';
        }
      }
    }
    return { app, colors: out };
  }

  it('paints every line out of one tab the same colour', () => {
    const { colors } = colorsAfter({ w1: null, a: 'w1', b: 'w1', c: 'w1' }, ['w1']);
    expect(Object.keys(colors).sort()).toEqual(['a', 'b', 'c']);
    expect(new Set(Object.values(colors)).size).toBe(1);
  });

  it('paints two spawning tabs in different colours', () => {
    const { colors } = colorsAfter({ w1: null, w2: null, a: 'w1', b: 'w1', c: 'w2', d: 'w2' }, ['w1', 'w2']);
    expect(colors.a).toBe(colors.b);
    expect(colors.c).toBe(colors.d);
    expect(colors.a).not.toBe(colors.c);
  });

  it('assigns colours in strip order, not in the order families get selected', () => {
    // Selecting w2's family first must not hand w2 the first (blue) colour.
    const { colors } = colorsAfter({ w1: null, a: 'w1', w2: null, c: 'w2' }, ['c', 'a']);
    expect(colors.a).toBe('');
    expect(colors.c).not.toBe('');
  });

  it('changes colour at each generation of a chain', () => {
    const { colors } = colorsAfter({ w1: null, w2: 'w1', w3: 'w2' }, ['w2']);
    expect(colors.w2).not.toBe(colors.w3);
  });

  it('keeps a tab on its colour across re-renders and interleaved siblings', () => {
    const { app } = loadLineageApp({});
    const first = app._lineageColorFor('w1');
    app._lineageColorFor('w2');
    app._lineageColorFor('w3');
    expect(app._lineageColorFor('w1')).toBe(first);
  });

  it('cycles the palette once every tab in it has spawned', () => {
    const { app } = loadLineageApp({});
    const palette = loadLineageHelper().COLORS;
    const seen = Array.from({ length: palette.length }, (_, i) => app._lineageColorFor(`p${i}`));
    expect(new Set(seen).size).toBe(palette.length);
    expect(app._lineageColorFor(`p${palette.length}`)).toBe(seen[0]);
  });
});
