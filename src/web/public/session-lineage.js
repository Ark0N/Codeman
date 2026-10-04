/**
 * @fileoverview Session lineage lines — the arcs joining a tab to the tabs it spawned.
 *
 * A session that starts another session (the `codeman` agent skill spawning a worker,
 * which passes its own `$CODEMAN_SESSION_ID`) gets `parentSessionId` stamped on its
 * state server-side. This module turns that field into the same kind of glowing
 * connection line the subagent windows use, but tab → tab, so the strip shows at a
 * glance which tab spawned which.
 *
 * It is an ADDITIONAL LAYER on the existing SVG pass, not a second pass: the core
 * `_updateConnectionLinesImmediate()` (subagent-windows.js) calls
 * `_appendLineageConnectionLines(svg, rects)` at its tail, exactly like ultracode does,
 * so every layer shares ONE batched read → write reflow and one tab-rect cache.
 *
 * Two constraints that are not obvious from the code:
 * - DESKTOP ONLY. The overlay is `z-index: 999`; the desktop header is 100 (arcs paint
 *   over it, which is what lets them touch tab bottoms), but under 1024px mobile.css
 *   makes the header `position: fixed; z-index: 1200` and would bury them. The phone
 *   strip is also a scroller where both endpoints are rarely on screen at once.
 * - Paths carry `data-agent-id="lineage:<childId>"` because that is the attribute
 *   `_applyLineEntrances()` queries, so the draw-in animation and its
 *   negative-`animation-delay` resume across `svg.innerHTML = ''` come for free.
 *
 * @mixin Extends CodemanApp.prototype via Object.assign
 * @dependency subagent-windows.js (_updateConnectionLinesImmediate, #connectionLines)
 * @dependency constants.js (window.CodemanLineage.computePath + .COLORS)
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
    if (prev !== next) this.updateConnectionLines();
  },

  /**
   * Every parent → child pair worth drawing, with the child's index among its siblings
   * (that index is what nests sibling arcs instead of overprinting them).
   *
   * Walks `sessionOrder` rather than the sessions Map so sibling depth follows the
   * strip's own left-to-right order, which is what the user sees.
   */
  _collectLineageEdges() {
    const edges = [];
    if (!this.sessions || this.sessions.size < 2) return edges;
    const order = this.sessionOrder && this.sessionOrder.length ? this.sessionOrder : [...this.sessions.keys()];
    const seenPerParent = new Map();
    for (const id of order) {
      const session = this.sessions.get(id);
      const parentId = session && session.parentSessionId;
      // A parent that is gone (closed, or never came back after a restart) draws
      // nothing: the field is decoration, so a dangling one is simply not rendered.
      if (!parentId || parentId === id || !this.sessions.has(parentId)) continue;
      const depth = seenPerParent.get(parentId) || 0;
      seenPerParent.set(parentId, depth + 1);
      edges.push({ parentId, childId: id, depth, status: session.status || 'idle' });
    }
    return edges;
  },

  /**
   * Colour for one arc, from CodemanLineage.COLORS, keyed on the SPAWNING tab.
   *
   * ⚠️ Per PARENT, not per child: every arc leaving one tab is the same colour, no
   * matter how many workers it spawns, so the strip reads as "these five came from
   * w1, those two came from w2". Keying it per child instead gave one tab's own
   * children a different colour each, which is the thing the colours exist to tell
   * apart. A child that goes on to spawn its own workers is a parent in its turn and
   * gets its own colour for the arcs BELOW it, so a chain changes colour at each
   * generation while each generation's fan-out stays uniform.
   *
   * Assigned in FIRST-SEEN order and remembered per parent id. First-seen rather than
   * draw-index keeps a colour stable across re-renders, tab reorders and sibling
   * closes (the SVG is wiped and rebuilt constantly, so an index-based colour would
   * flicker). An empty string means "no override": the CSS falls back to
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
    // Sidebar layout: computeLineagePath()'s whole geometry — the U-bridge hung
    // from the STRIP's bottom edge, the 64px dip corridor — assumes a horizontal
    // tab row. Against a vertical list the "strip bottom" is the bottom of the
    // sidebar, so every arc would draw a giant loop to the foot of the list.
    // Parent/child adjacency reads fine in a vertical list without arcs; a
    // sideways lineage shape is a follow-up with its own visual tuning, not a
    // by-product of a layout port.
    if (this.isSessionSidebarActive?.()) return;
    const compute = window.CodemanLineage && window.CodemanLineage.computePath;
    if (!compute) return;

    const edges = this._collectLineageEdges();
    if (edges.length === 0) return;
    if (!rects) rects = new Map();

    // PHASE 1 — reads.
    const strip = document.getElementById('sessionTabs');
    if (!strip) return;
    const stripRect = strip.getBoundingClientRect();
    const orientation =
      document.documentElement.getAttribute('data-tab-orientation') === 'vertical' ? 'vertical' : 'horizontal';
    // A session hidden inside a collapsed group of the grouped rail has no row
    // to anchor to, so its end of the arc moves to that group's header (a
    // "proxied" endpoint, drawn quieter). Two endpoints proxied to the SAME
    // header would be an arc from a row to itself: skipped.
    const resolveEndpoint = (id) => {
      const tab = strip.querySelector(`.session-tab[data-id="${CSS.escape(id)}"]`);
      if (tab) return { key: 'tab:' + id, element: tab, proxied: false };
      const groupId = this._hiddenTabGroupByRef?.get('session:' + id);
      if (!groupId) return { key: 'tab:' + id, element: null, proxied: false };
      const header = strip.querySelector(`[data-tab-group-header="${CSS.escape(groupId)}"]`);
      return { key: 'group:' + groupId, element: header, proxied: !!header };
    };
    const resolvedEdges = [];
    for (const edge of edges) {
      const parentEndpoint = resolveEndpoint(edge.parentId);
      const childEndpoint = resolveEndpoint(edge.childId);
      if (parentEndpoint.key === childEndpoint.key) continue;
      resolvedEdges.push({ edge, parentEndpoint, childEndpoint });
      for (const endpoint of [parentEndpoint, childEndpoint]) {
        if (rects.has(endpoint.key)) continue;
        rects.set(endpoint.key, endpoint.element ? endpoint.element.getBoundingClientRect() : null);
      }
    }
    this._lineageEdgeCount = resolvedEdges.length;

    // PHASE 2 — writes, from the cache only.
    for (const { edge, parentEndpoint, childEndpoint } of resolvedEdges) {
      const parentRect = rects.get(parentEndpoint.key);
      const childRect = rects.get(childEndpoint.key);
      if (!parentRect || !childRect) continue;

      const geom = compute({
        parent: parentRect,
        child: childRect,
        strip: stripRect,
        depth: edge.depth,
        orientation,
      });
      if (!geom) continue; // scrolled out of the strip, or a degenerate rect

      const line = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      line.setAttribute('d', geom.d);
      // The working class marches the dashes, so an active worker is visible along
      // the line itself. `status` is the CHILD's, which is the interesting end.
      const working = edge.status === 'working' ? ' lineage-line--working' : '';
      const proxied = parentEndpoint.proxied || childEndpoint.proxied;
      line.setAttribute('class', 'connection-line lineage-line' + working + (proxied ? ' lineage-line--proxied' : ''));
      // The PARENT's colour rides a CSS custom property so the stylesheet keeps owning
      // opacity, glow and dash; an empty colour leaves the --session-blue fallback.
      // Every arc out of one tab shares it — see _lineageColorFor().
      const color = this._lineageColorFor(edge.parentId);
      if (color) line.style.setProperty('--lineage-color', color);
      // `data-agent-id` is what _applyLineEntrances() queries — see the file header.
      line.setAttribute('data-agent-id', 'lineage:' + edge.childId);
      line.setAttribute('data-parent-tab', edge.parentId);
      line.setAttribute('data-child-tab', edge.childId);
      svg.appendChild(line);

      // Direction marker at the CHILD end. A circle rather than an SVG <marker>:
      // markers need a <defs> block and fight the dash pattern.
      const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      dot.setAttribute('cx', String(geom.endX));
      dot.setAttribute('cy', String(geom.endY));
      // Resting radius; `lineage-dot-pulse` breathes it 3.5 → 4.5 while the child
      // works, so the two have to be changed together.
      dot.setAttribute('r', '3.5');
      dot.setAttribute('class', 'lineage-line-dot' + working + (proxied ? ' lineage-line-dot--proxied' : ''));
      dot.setAttribute('data-child-tab', edge.childId);
      if (color) dot.style.setProperty('--lineage-color', color);
      svg.appendChild(dot);
    }
  },

  /**
   * The strip scrolls (desktop `overflow-x: auto` and every wrapped layout), and a
   * scroll moves both endpoints without firing any render, so the arcs would slide off
   * their tabs. Passive listener, and the redraw is the normal coalesced one.
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
      // rects too (the sidebar skips lineage arcs entirely, and the rail can
      // show connectors with zero lineage edges, so _lineageEdgeCount alone
      // would never redraw them).
      if (this._lineageEdgeCount > 0 || this._isVerticalTabList?.()) this.updateConnectionLines();
    };
    strip.addEventListener('scroll', this._lineageScrollHandler, { passive: true });
  },
});
