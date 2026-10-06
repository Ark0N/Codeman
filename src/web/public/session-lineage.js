/**
 * @fileoverview Session lineage lines: the tree joining a tab to the tabs it spawned.
 *
 * A session that starts another session (the `codeman` agent skill spawning a worker,
 * which passes its own `$CODEMAN_SESSION_ID`) gets `parentSessionId` stamped on its
 * state server-side. This module turns that field into a quiet orthogonal tree, one per
 * spawning tab, routed through the gaps between tab rows so it never crosses a label or
 * the terminal (geometry: `CodemanLineage.computeTree` in constants.js).
 *
 * EVERY FAMILY IS ALWAYS DRAWN, AND THE SELECTED TAB'S IS EMPHASIZED: the family the
 * active tab spawned, and the family it belongs to as a child, get the
 * `lineage-family--focus` group (thicker, full opacity, drawn last so nothing covers
 * it). Drawing ONLY the selected family was tried first and rejected by the owner
 * (2026-10-07: "I wanna see all the connections always"). Selection still has to
 * redraw to move the emphasis, which `_updateActiveTabImmediate()` does whenever any
 * lineage exists (`_lineageTotalEdges`).
 *
 * It is an ADDITIONAL LAYER on the existing SVG pass, not a second pass: the core
 * `_updateConnectionLinesImmediate()` (subagent-windows.js) calls
 * `_appendLineageConnectionLines(svg, rects)` at its tail, exactly like ultracode does,
 * so every layer shares ONE batched read → write reflow and one tab-rect cache.
 *
 * Constraints that are not obvious from the code:
 * - DESKTOP ONLY. The overlay is `z-index: 999`; the desktop header is 100 (lines paint
 *   over it, which is what lets them touch tab bottoms), but under 1024px mobile.css
 *   makes the header `position: fixed; z-index: 1200` and would bury them. The phone
 *   strip is also a scroller where both endpoints are rarely on screen at once.
 * - The routing room is RESERVED in CSS (`.session-tabs.lineage-tree`), toggled by
 *   `_syncLineageGutter()` from `updateTabOverflowMode()`. It keys on whether ANY
 *   family exists, never on the selection, so switching tabs never resizes the header
 *   (and with it the terminal and the PTY).
 * - Paths carry `data-agent-id="lineage:<childId>"` because that is the attribute
 *   `_applyLineEntrances()` queries, so the draw-in animation and its
 *   negative-`animation-delay` resume across `svg.innerHTML = ''` come for free.
 *
 * @mixin Extends CodemanApp.prototype via Object.assign
 * @dependency subagent-windows.js (_updateConnectionLinesImmediate, #connectionLines)
 * @dependency constants.js (window.CodemanLineage.computeTree + .COLORS)
 * @dependency settings-ui.js (loadAppSettingsFromStorage, getDefaultSettings)
 * @loadorder 15.6 (after ultracode-windows.js — appended to the same SVG pass)
 */
/* global CodemanApp, MobileDetection */

Object.assign(CodemanApp.prototype, {
  /**
   * Per-device opt-out (App Settings → Appearance), cached because the draw path runs
   * on every tab render, scroll and resize. `applyLineageLineSettings()` refreshes it.
   *
   * Desktop-only for the z-index reason in the file header, and gated on device type
   * rather than on the settings namespace: this is a layout decision, like the phone
   * overview's `shouldUseMobileOverview()`.
   */
  _lineageLinesEnabled() {
    if (this._lineageLinesOn === undefined) this._syncLineageLinesEnabled();
    return this._lineageLinesOn;
  },

  _syncLineageLinesEnabled() {
    let on = false;
    try {
      if (MobileDetection.getDeviceType() === 'desktop') {
        const settings = this.loadAppSettingsFromStorage ? this.loadAppSettingsFromStorage() : {};
        const defaults = this.getDefaultSettings ? this.getDefaultSettings() : {};
        on = settings.sessionLineageLines ?? defaults.sessionLineageLines ?? true;
      }
    } catch (_e) {
      on = false;
    }
    this._lineageLinesOn = !!on;
    return this._lineageLinesOn;
  },

  /** Re-read the setting and redraw. Called from the settings apply pass and on resize. */
  applyLineageLineSettings() {
    const prev = this._lineageLinesOn;
    const next = this._syncLineageLinesEnabled();
    if (prev !== next) {
      // The reserved routing room follows the setting; updateTabOverflowMode()
      // re-syncs it and re-measures the wrap with the new padding.
      this.updateTabOverflowMode?.();
      this.updateConnectionLines();
    }
  },

  /**
   * Reserve (or release) the strip's routing room: `.lineage-tree` on #sessionTabs
   * widens the row gap, pads the bottom for the last row's gap, and opens the spine
   * channel on the left of a wrapped strip (styles.css). Called at the top of
   * `updateTabOverflowMode()`, so it runs on every tab render, BEFORE the wrap is
   * measured.
   *
   * Keyed on whether any family exists at all, never on which one is selected: a
   * class that followed the selection would grow and shrink the header on every tab
   * switch, and the header's height is the terminal's height.
   *
   * Only the header strip routes through reserved gaps. The vertical rail keeps its
   * own `--lineage-vertical-gutter`, and the sidebar draws no lineage.
   */
  _syncLineageGutter() {
    const edges = this._lineageLinesEnabled() ? this._collectLineageEdges() : [];
    this._lineageTotalEdges = edges.length;
    const strip = document.getElementById('sessionTabs');
    if (!strip) return;
    const want = edges.length > 0 && !this._isVerticalTabList?.();
    if (strip.classList.contains('lineage-tree') !== want) strip.classList.toggle('lineage-tree', want);
  },

  /**
   * Every parent → child pair, in strip order. Walks `sessionOrder` rather than the
   * sessions Map so sibling order follows the strip's own left-to-right order, which
   * is what the user sees.
   */
  _collectLineageEdges() {
    const edges = [];
    if (!this.sessions || this.sessions.size < 2) return edges;
    const order = this.sessionOrder && this.sessionOrder.length ? this.sessionOrder : [...this.sessions.keys()];
    for (const id of order) {
      const session = this.sessions.get(id);
      const parentId = session && session.parentSessionId;
      // A parent that is gone (closed, or never came back after a restart) draws
      // nothing: the field is decoration, so a dangling one is simply not rendered.
      if (!parentId || parentId === id || !this.sessions.has(parentId)) continue;
      edges.push({ parentId, childId: id, status: session.status || 'idle' });
    }
    return edges;
  },

  /** Every family as `{ parentId, edges }`, in strip order of first appearance. */
  _lineageFamilies(edges) {
    const families = new Map();
    for (const edge of edges) {
      if (!families.has(edge.parentId)) families.set(edge.parentId, []);
      families.get(edge.parentId).push(edge);
    }
    return [...families].map(([parentId, familyEdges]) => ({ parentId, edges: familyEdges }));
  },

  /**
   * Parent ids of the families the selection emphasizes: the family the selected tab
   * spawned, and the family it was spawned into (its parent plus its siblings). Empty
   * when a web tab holds the stage, or the selected tab has no lineage at all.
   */
  _lineageFocusParents(edges) {
    const parents = new Set();
    const focus = this.activeWebviewId ? null : this.activeSessionId;
    if (!focus) return parents;
    for (const edge of edges) {
      if (edge.parentId === focus || edge.childId === focus) parents.add(edge.parentId);
    }
    return parents;
  },

  /**
   * Colour for one family, from CodemanLineage.COLORS, keyed on the SPAWNING tab.
   *
   * ⚠ Per PARENT, not per child: every line leaving one tab is the same colour, no
   * matter how many workers it spawns, so the strip reads as "these five came from
   * w1, those two came from w2". Keying it per child instead gave one tab's own
   * children a different colour each, which is the thing the colours exist to tell
   * apart. A child that goes on to spawn its own workers is a parent in its turn and
   * gets its own colour for the lines BELOW it, so a chain changes colour at each
   * generation while each generation's fan-out stays uniform.
   *
   * Assigned in FIRST-SEEN order and remembered per parent id. First-seen rather than
   * draw-index keeps a colour stable across re-renders, tab reorders and sibling
   * closes (the SVG is wiped and rebuilt constantly, so an index-based colour would
   * flicker). The draw pass claims a colour for EVERY family in strip order before it
   * draws anything, so neither the draw order (the selected family goes last) nor
   * which family was selected first ever decides who gets which colour. An empty string means "no override": the CSS falls back to
   * --session-blue, so the first spawning tab keeps the skin-aware blue.
   */
  _lineageColorFor(parentId) {
    const palette = (window.CodemanLineage && window.CodemanLineage.COLORS) || [];
    if (palette.length === 0) return '';
    if (!this._lineageColorByParent) {
      this._lineageColorByParent = new Map();
      this._lineageColorNext = 0;
    }
    let idx = this._lineageColorByParent.get(parentId);
    if (idx === undefined) {
      idx = this._lineageColorNext++ % palette.length;
      this._lineageColorByParent.set(parentId, idx);
      // Bounded: entries for long-gone sessions are pruned once the map is clearly
      // stale, so a day-long dashboard cannot grow it without limit.
      if (this._lineageColorByParent.size > 200 && this.sessions) {
        for (const key of this._lineageColorByParent.keys()) {
          if (!this.sessions.has(key)) this._lineageColorByParent.delete(key);
        }
      }
    }
    return palette[idx] || '';
  },

  /**
   * Append the lineage layer to the shared SVG pass.
   *
   * Contract with the caller: `rects` is the batched read cache keyed `tab:<id>`, and
   * everything read here goes through it so a tab another layer already measured is
   * never measured twice. All reads happen before any append, keeping the caller's
   * read → write split intact.
   */
  _appendLineageConnectionLines(svg, rects) {
    this._lineageEdgeCount = 0;
    if (!svg || !this._lineageLinesEnabled()) return;
    // Sidebar layout: the tree is routed for a horizontal strip or the vertical
    // rail. The sidebar is a vertical list with its own scroller and no reserved
    // channel; parent/child adjacency reads fine there without lines.
    if (this.isSessionSidebarActive?.()) return;
    const computeTree = window.CodemanLineage && window.CodemanLineage.computeTree;
    if (!computeTree) return;

    const edges = this._collectLineageEdges();
    this._lineageTotalEdges = edges.length;
    if (edges.length === 0) return;
    // Claim colours in strip order for every family before drawing (_lineageColorFor).
    for (const edge of edges) this._lineageColorFor(edge.parentId);
    const families = this._lineageFamilies(edges);
    const focusParents = this._lineageFocusParents(edges);
    if (!rects) rects = new Map();

    // PHASE 1 — reads.
    const strip = document.getElementById('sessionTabs');
    if (!strip) return;
    const stripRect = strip.getBoundingClientRect();
    const orientation =
      document.documentElement.getAttribute('data-tab-orientation') === 'vertical' ? 'vertical' : 'horizontal';
    // A session hidden inside a collapsed group of the grouped rail has no row
    // to anchor to, so its end of the line moves to that group's header (a
    // "proxied" endpoint, drawn quieter). A child proxied to the same header as
    // its parent would be a line from a row to itself: skipped.
    const resolveEndpoint = (id) => {
      const tab = strip.querySelector(`.session-tab[data-id="${CSS.escape(id)}"]`);
      if (tab) return { key: 'tab:' + id, element: tab, proxied: false };
      const groupId = this._hiddenTabGroupByRef?.get('session:' + id);
      if (!groupId) return { key: 'tab:' + id, element: null, proxied: false };
      const header = strip.querySelector(`[data-tab-group-header="${CSS.escape(groupId)}"]`);
      return { key: 'group:' + groupId, element: header, proxied: !!header };
    };
    const measure = (endpoint) => {
      if (!rects.has(endpoint.key)) {
        rects.set(endpoint.key, endpoint.element ? endpoint.element.getBoundingClientRect() : null);
      }
      return rects.get(endpoint.key);
    };
    const resolvedFamilies = [];
    for (const family of families) {
      const parentEndpoint = resolveEndpoint(family.parentId);
      const parentRect = measure(parentEndpoint);
      if (!parentRect) continue;
      const children = [];
      for (const edge of family.edges) {
        const childEndpoint = resolveEndpoint(edge.childId);
        if (childEndpoint.key === parentEndpoint.key) continue;
        const rect = measure(childEndpoint);
        if (rect) children.push({ edge, endpoint: childEndpoint, rect });
      }
      if (children.length > 0) resolvedFamilies.push({ family, parentEndpoint, parentRect, children });
    }
    if (resolvedFamilies.length === 0) return;
    // The header strip's rows come from EVERY tab in it (computeTree hangs a row's
    // gap under its tallest tab), web tabs included. The rail needs none.
    const tabRects = [];
    if (orientation === 'horizontal') {
      for (const tab of strip.querySelectorAll('.session-tab')) {
        const id = tab.getAttribute('data-id');
        const key = id ? 'tab:' + id : null;
        if (key && rects.has(key)) tabRects.push(rects.get(key));
        else {
          const rect = tab.getBoundingClientRect();
          if (key) rects.set(key, rect);
          tabRects.push(rect);
        }
      }
    }

    // PHASE 2 — writes, from the cache only.
    // Lanes follow STRIP order, so a family keeps its lane when the selection moves;
    // only the DRAW order changes (the emphasized families last, on top). A row gap
    // fits a few lanes, so they cycle: families that share one are told apart by colour.
    const laneLimit = Math.max(1, (window.CodemanLineage && window.CodemanLineage.MAX_LANES) || 3);
    const laneCount = Math.min(laneLimit, resolvedFamilies.length);
    const drawOrder = resolvedFamilies
      .map((resolved, index) => ({
        ...resolved,
        lane: index % laneCount,
        focus: focusParents.has(resolved.family.parentId),
      }))
      .sort((a, b) => a.focus - b.focus);
    for (const { family, parentEndpoint, parentRect, children, lane, focus } of drawOrder) {
      const geom = computeTree({
        parent: parentRect,
        children: children.map((c) => ({ id: c.edge.childId, rect: c.rect })),
        strip: stripRect,
        tabs: tabRects,
        orientation,
        lane,
        laneCount,
      });
      if (!geom || geom.routes.length === 0) continue;
      const byId = new Map(children.map((c) => [c.edge.childId, c]));
      const color = this._lineageColorFor(family.parentId);
      // One group per family: it carries the translucency, so the stretches its
      // routes share (the trunk) do not stack into a brighter line than the branches,
      // and the emphasis for the selected tab's families (styles.css).
      const group = document.createElementNS('http://www.w3.org/2000/svg', 'g');
      group.setAttribute('class', 'lineage-family' + (focus ? ' lineage-family--focus' : ''));
      group.setAttribute('data-parent-tab', family.parentId);
      // Working routes go in FIRST, so an idle sibling's solid stroke covers the
      // shared trunk and only the working child's own branch shows its dashes.
      const routes = geom.routes
        .map((route) => ({ route, child: byId.get(route.id) }))
        .filter((r) => r.child)
        .sort((a, b) => (b.child.edge.status === 'working') - (a.child.edge.status === 'working'));
      for (const { route, child } of routes) {
        const line = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        line.setAttribute('d', route.d);
        // `status` is the CHILD's, which is the interesting end: a working child's
        // route is dashed (and marches, motion permitting).
        const working = child.edge.status === 'working' ? ' lineage-line--working' : '';
        const proxied = parentEndpoint.proxied || child.endpoint.proxied;
        line.setAttribute(
          'class',
          'connection-line lineage-line' + working + (proxied ? ' lineage-line--proxied' : '')
        );
        // The PARENT's colour rides a CSS custom property so the stylesheet keeps
        // owning weight and dash; an empty colour leaves the --session-blue fallback.
        if (color) line.style.setProperty('--lineage-color', color);
        // `data-agent-id` is what _applyLineEntrances() queries — see the file header.
        line.setAttribute('data-agent-id', 'lineage:' + child.edge.childId);
        line.setAttribute('data-parent-tab', family.parentId);
        line.setAttribute('data-child-tab', child.edge.childId);
        group.appendChild(line);
      }
      // Direction marker at each CHILD end, after every path so no stroke covers it.
      for (const { route, child } of routes) {
        const working = child.edge.status === 'working' ? ' lineage-line--working' : '';
        const proxied = parentEndpoint.proxied || child.endpoint.proxied;
        const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        dot.setAttribute('cx', String(route.endX));
        dot.setAttribute('cy', String(route.endY));
        // Fallback radius only: styles.css sizes the dot through `--lineage-dot-r`
        // (larger in an emphasized family), and `lineage-dot-pulse` breathes from it.
        dot.setAttribute('r', '2.5');
        dot.setAttribute('class', 'lineage-line-dot' + working + (proxied ? ' lineage-line-dot--proxied' : ''));
        dot.setAttribute('data-child-tab', child.edge.childId);
        if (color) dot.style.setProperty('--lineage-color', color);
        group.appendChild(dot);
      }
      svg.appendChild(group);
      this._lineageEdgeCount += routes.length;
    }
  },

  /**
   * The strip scrolls (desktop `overflow-x: auto` and every wrapped layout), and a
   * scroll moves both endpoints without firing any render, so the lines would slide
   * off their tabs. Passive listener, and the redraw is the normal coalesced one.
   *
   * Installed once; the guard also keeps a re-init from stacking listeners.
   */
  _installLineageStripScrollListener() {
    if (this._lineageScrollHandler) return;
    const strip = document.getElementById('sessionTabs');
    if (!strip) return;
    this._lineageScrollHandler = () => {
      // Sidebar layout and the vertical rail scroll the SAME element
      // vertically, and there the subagent/ultracode connectors anchor to tab
      // rects too (the sidebar skips lineage entirely, and the rail can show
      // connectors with zero lineage edges, so _lineageEdgeCount alone would
      // never redraw them).
      if (this._lineageEdgeCount > 0 || this._isVerticalTabList?.()) this.updateConnectionLines();
    };
    strip.addEventListener('scroll', this._lineageScrollHandler, { passive: true });

    // ⚠ A SELECTION RESIZES TABS AFTER THE REDRAW. The active tab reveals its gear
    // and close icons by transitioning their padding (styles.css), so it keeps
    // widening for ~150ms after `_updateActiveTabImmediate()` has already redrawn,
    // and the tab it was selected from shrinks. That can move tabs or re-wrap a row,
    // which left a family's trunk hanging under the tab's OLD position. Redraw once
    // a size transition inside the strip ends (coalesced, like every other redraw).
    this._lineageTransitionHandler = (event) => {
      const prop = event.propertyName || '';
      if (!(prop === 'width' || prop === 'max-width' || prop.startsWith('padding'))) return;
      if (this._lineageTotalEdges > 0) this.updateConnectionLines();
    };
    strip.addEventListener('transitionend', this._lineageTransitionHandler);
  },
});
