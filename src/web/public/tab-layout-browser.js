/**
 * @fileoverview Read-only browser projection of the owner tab layout.
 *
 * `GET /api/tab-layout` returns the owner's named tab GROUPS (`src/tab-layout.ts`
 * is the server model). Browser assets cannot import that TypeScript, so this
 * module is a small, dependency-free mirror that owns three things:
 *
 *  1. Projection: which live sessions and open web tabs land in which group,
 *     and which rows a collapsed group hides.
 *  2. Rendering: the grouped markup for the vertical tab rail. Rows themselves
 *     are rendered by the caller (app.js, webview-tabs.js), so a grouped row is
 *     byte-identical to the flat rail's row.
 *  3. Load sequencing: concurrent layout reads settle newest-wins, and a failed
 *     read degrades to the flat rail with a capped, backed-off retry.
 *
 * The server stays the only authority for layout content. Collapse is a
 * per-device view preference and lives in localStorage only.
 *
 * Grouped rendering is opt-in by construction: a layout with no groups (every
 * owner until they create one) projects to `null`, and the caller keeps the flat
 * rail exactly as it was.
 *
 * @dependency none
 * @loadorder 5.9 (before app.js, which reads window.CodemanTabLayout)
 */

(function initCodemanTabLayout(global) {
  'use strict';

  const COLLAPSED_STORAGE_KEY = 'codeman:tab-groups-collapsed';

  const refKey = (ref) => `${ref.kind}:${ref.id}`;
  const validRef = (ref) =>
    !!ref && (ref.kind === 'session' || ref.kind === 'webview') && typeof ref.id === 'string' && ref.id.length > 0;
  const asIds = (value) => (Array.isArray(value) ? value.filter((id) => typeof id === 'string' && id) : []);
  const stableIds = (value) => [...new Set(asIds(value))];
  const copyRefs = (value) =>
    Array.isArray(value) ? value.filter(validRef).map((r) => ({ kind: r.kind, id: r.id })) : [];

  /**
   * Defensive copy of a server layout. Unknown fields are dropped, so a newer
   * server adding model fields cannot leak half-understood state into the view.
   */
  function normalizeLayout(value) {
    if (!value || typeof value !== 'object') throw new Error('Invalid tab layout');
    const groups = Array.isArray(value.groups) ? value.groups : [];
    return {
      version: Number.isSafeInteger(value.version) && value.version >= 0 ? value.version : 0,
      groups: groups
        .filter((group) => group && typeof group.id === 'string' && group.id.length > 0)
        .map((group) => ({
          id: group.id,
          name: typeof group.name === 'string' ? group.name : '',
          refs: copyRefs(group.refs),
        })),
      ungrouped: copyRefs(value.ungrouped),
    };
  }

  function hasGroups(layout) {
    return !!layout && Array.isArray(layout.groups) && layout.groups.length > 0;
  }

  /** Stored collapse ids, or null when the stored value is not a JSON array. */
  function parseCollapsedIds(raw) {
    if (raw === null) return [];
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? stableIds(parsed) : null;
    } catch (_error) {
      return null;
    }
  }

  /**
   * Read the per-device collapse ids. `ok: false` means the STORE failed (a read
   * or write threw), and the caller then keeps every group expanded. A malformed
   * VALUE is not a store failure: it reads as "nothing collapsed" and is
   * rewritten, or a shape left behind by another build (a rollback) would leave
   * collapse disabled on this device for good.
   */
  function loadCollapsedGroupIds(storage, validGroupIds) {
    try {
      const parsed = parseCollapsedIds(storage.getItem(COLLAPSED_STORAGE_KEY));
      const loaded = parsed || [];
      if (validGroupIds === undefined) return { ids: loaded, ok: true };
      // Garbage-collect ids of groups that no longer exist, so a deleted group's
      // id cannot silently collapse a future group that reuses it.
      const valid = new Set(stableIds(validGroupIds));
      const kept = loaded.filter((id) => valid.has(id));
      if (!parsed || kept.length !== loaded.length) storage.setItem(COLLAPSED_STORAGE_KEY, JSON.stringify(kept));
      return { ids: kept, ok: true };
    } catch (_error) {
      return { ids: [], ok: false };
    }
  }

  function saveCollapsedGroupIds(storage, groupIds) {
    const ids = stableIds(groupIds);
    try {
      storage.setItem(COLLAPSED_STORAGE_KEY, JSON.stringify(ids));
      return { ids, ok: true };
    } catch (_error) {
      return { ids: [], ok: false };
    }
  }

  /**
   * Project a layout onto what is live in this browser.
   *
   * Every live session and open web tab appears exactly once: stored refs keep
   * their group and stored order; anything the layout has not caught up with yet
   * (a session created a moment ago, a web tab opened on this device only) is
   * appended to the ungrouped section in the caller's order. Saved web tabs that
   * are not open here are skipped, as are refs to sessions that are gone.
   *
   * A collapsed group hides its rows, EXCEPT the highlighted one (the active web
   * tab, else the active session), so selecting a hidden session by keyboard,
   * palette or Alt+N never leaves the user with no visible selection.
   *
   * @returns {null | { sections, visibleRefs, hiddenTabGroupByRef, sectionByRef }}
   *   null when the layout has no groups: the caller renders the flat rail
   *   unchanged. Each section lists the rows it shows (`refs`) and the rows its
   *   collapse hides (`hidden`); `sectionByRef` maps every placed row
   *   (`<kind>:<id>`) to its section id (null = Ungrouped), shown or hidden.
   */
  function project(layoutInput, options = {}) {
    if (!layoutInput) return null;
    const layout = normalizeLayout(layoutInput);
    if (!hasGroups(layout)) return null;
    const liveSessionIds = stableIds(options.liveSessionIds);
    const openWebviewIds = stableIds(options.openWebviewIds);
    const live = new Set(liveSessionIds);
    const open = new Set(openWebviewIds);
    const collapsed = new Set(asIds(options.collapsedGroupIds));
    const highlighted = options.activeWebviewId
      ? `webview:${options.activeWebviewId}`
      : options.activeSessionId
        ? `session:${options.activeSessionId}`
        : '';
    const renderable = (ref) => (ref.kind === 'session' ? live.has(ref.id) : open.has(ref.id));
    const placed = new Set();
    const visibleRefs = [];
    const hiddenTabGroupByRef = {};
    const sectionByRef = {};
    const sections = [];

    const place = (refs, sectionId, isCollapsed) => {
      const shown = [];
      const hidden = [];
      let count = 0;
      for (const ref of refs) {
        const key = refKey(ref);
        if (placed.has(key) || !renderable(ref)) continue;
        placed.add(key);
        sectionByRef[key] = sectionId;
        count++;
        const copy = { kind: ref.kind, id: ref.id };
        if (isCollapsed && key !== highlighted) {
          hiddenTabGroupByRef[key] = sectionId;
          hidden.push(copy);
          continue;
        }
        shown.push(copy);
        visibleRefs.push(copy);
      }
      return { shown, hidden, count };
    };

    for (const group of layout.groups) {
      const isCollapsed = collapsed.has(group.id);
      const { shown, hidden, count } = place(group.refs, group.id, isCollapsed);
      sections.push({ id: group.id, name: group.name, refs: shown, hidden, count, collapsed: isCollapsed });
    }
    const omissions = [
      ...liveSessionIds.map((id) => ({ kind: 'session', id })),
      ...openWebviewIds.map((id) => ({ kind: 'webview', id })),
    ];
    const ungrouped = place([...layout.ungrouped, ...omissions], null, false);
    if (ungrouped.count > 0) {
      sections.push({
        id: null,
        name: '',
        refs: ungrouped.shown,
        hidden: [],
        count: ungrouped.count,
        collapsed: false,
      });
    }
    return { sections, visibleRefs, hiddenTabGroupByRef, sectionByRef };
  }

  const ALERT_RANK = { action: 2, idle: 1 };

  /**
   * The most urgent alert behind each COLLAPSED header: `{ [groupId]: 'action' |
   * 'idle' }` over the session rows the collapse hides. A shown row (the kept
   * selection, any expanded group) draws its own alert, so it is not counted
   * here. `alertOf(sessionId)` is the caller's tab alert lookup.
   */
  function hiddenGroupAlerts(projection, alertOf) {
    const result = {};
    const sections = projection && Array.isArray(projection.sections) ? projection.sections : [];
    for (const section of sections) {
      if (section.id === null || !Array.isArray(section.hidden)) continue;
      let best = null;
      for (const ref of section.hidden) {
        if (ref.kind !== 'session') continue;
        const alert = alertOf(ref.id);
        if (ALERT_RANK[alert] && (!best || ALERT_RANK[alert] > ALERT_RANK[best])) best = alert;
      }
      if (best) result[section.id] = best;
    }
    return result;
  }

  /**
   * Everything that changes the grouped rail's STRUCTURE (which rows exist and
   * where, the headers' names, what a collapse hides), as opposed to a row's own
   * status/name/badges. The incremental render path only patches rows in place,
   * so a change here forces a full rebuild.
   *
   * Deliberately NOT the layout version: the server bumps it on every session
   * create/close and order PUT, and a bump that moves nothing visible must not
   * cost every client a full tab-strip rebuild. `layout` is accepted for
   * signature stability only.
   */
  function structureKey(_layout, projection, collapsedGroupIds) {
    if (!projection) return null;
    return JSON.stringify({
      collapsed: stableIds(collapsedGroupIds).sort(),
      sections: projection.sections.map((section) => [
        section.id,
        section.name,
        section.count,
        section.refs.map(refKey),
        (section.hidden || []).map(refKey),
      ]),
    });
  }

  /**
   * Grouped rail markup. `renderRef(ref)` returns one row's HTML ('' to skip it);
   * `escapeHtml` is the caller's escaper. Group names are user content, so they
   * are escaped and marked `data-i18n-skip`.
   *
   * The caller makes the list itself the `tree` and marks rows up as treeitems
   * (app.js `_applyTabTreeSemantics`); this markup supplies the structure:
   *  - a named group's header is a level-1 `treeitem` carrying `aria-expanded`.
   *    Its rows are a sibling `group`, so the header OWNS it via `aria-owns`
   *    (the rows sit below the header visually, not inside it).
   *  - a COLLAPSED group owns nothing: the one row it still shows (the
   *    selection) is a level-1 sibling, never the child of a closed node.
   *  - a group with NO open rows is a leaf: no `aria-expanded`, no owned group,
   *    so it is not announced as an expanded parent of an empty group.
   *  - Ungrouped rows are level-1 items. Their "Ungrouped" heading is a visual
   *    divider only, hidden from assistive tech, and its rows are not a group.
   */
  function renderProjection(projection, renderRef, escapeHtml) {
    const sections = projection && Array.isArray(projection.sections) ? projection.sections : [];
    return sections
      .map((section, index) => {
        const rows = section.refs.map((ref) => renderRef(ref)).join('');
        if (section.id === null) {
          return (
            '<section class="tab-layout-group tab-layout-ungrouped" role="presentation" data-tab-group-id="">' +
            `<div class="tab-layout-group-header tab-layout-ungrouped-header" aria-hidden="true"><span class="tab-layout-group-name">Ungrouped</span><span class="tab-layout-group-count">${section.count}</span></div>` +
            `<div class="tab-layout-group-refs" role="presentation">${rows}</div></section>`
          );
        }
        const id = escapeHtml(section.id);
        const refsId = `tab-layout-group-refs-${index}`;
        const nameId = `tab-layout-group-name-${index}`;
        const leaf = section.count === 0;
        const expanded = !section.collapsed && !leaf;
        const expandedAttr = leaf ? '' : ` aria-expanded="${expanded ? 'true' : 'false'}"`;
        return (
          `<section class="tab-layout-group${section.collapsed ? ' tab-layout-group--collapsed' : ''}" role="presentation" data-tab-group-id="${id}">` +
          `<div class="tab-layout-group-header tab-layout-group-toggle" role="treeitem" tabindex="-1" data-tab-group-header="${id}"${expandedAttr}${expanded ? ` aria-owns="${refsId}"` : ''} onclick="app.toggleTabGroupCollapsed(this.dataset.tabGroupHeader)">` +
          '<span class="tab-layout-group-chevron" aria-hidden="true"></span>' +
          `<span class="tab-layout-group-name" id="${nameId}" data-i18n-skip>${escapeHtml(section.name)}</span>` +
          `<span class="tab-layout-group-count">${section.count}</span></div>` +
          `<div class="tab-layout-group-refs" id="${refsId}" ${expanded ? `role="group" aria-labelledby="${nameId}"` : 'role="presentation"'}>${rows}</div></section>`
        );
      })
      .join('');
  }

  /**
   * Newest-wins layout loading. A response that was overtaken by a later load is
   * dropped; a failure applies the fallback (the flat rail) and schedules ONE
   * retry, replacing any retry already pending.
   *
   * Retries back off and stop: the delay doubles from `retryDelayMs` up to
   * `maxRetryDelayMs`, and after `maxRetries` consecutive failures nothing more
   * is scheduled (`scheduleRetry(fn, delayMs)`). The next outside load (an SSE
   * reconnect re-runs init, a `tab:layoutChanged` re-reads) tries again, and
   * any success resets the count.
   */
  function createLoadCoordinator(options) {
    const baseDelay = Number.isFinite(options.retryDelayMs) ? options.retryDelayMs : 5000;
    const maxDelay = Number.isFinite(options.maxRetryDelayMs) ? options.maxRetryDelayMs : 60000;
    const maxRetries = Number.isSafeInteger(options.maxRetries) ? options.maxRetries : 4;
    let generation = 0;
    let disposed = false;
    let retryHandle = null;
    let failures = 0;
    const clearRetry = () => {
      if (retryHandle !== null && options.cancelRetry) options.cancelRetry(retryHandle);
      retryHandle = null;
    };
    const load = async () => {
      if (disposed) return false;
      const requestGeneration = ++generation;
      clearRetry();
      try {
        const layout = await options.fetchLayout();
        if (disposed || requestGeneration !== generation) return false;
        failures = 0;
        options.applyLayout(layout);
        return true;
      } catch (_error) {
        if (disposed || requestGeneration !== generation) return false;
        failures++;
        options.applyFallback();
        if (failures <= maxRetries) {
          const delay = Math.min(maxDelay, baseDelay * 2 ** (failures - 1));
          retryHandle = options.scheduleRetry(() => load(), delay);
        }
        return false;
      }
    };
    return {
      load,
      dispose() {
        disposed = true;
        generation++;
        clearRetry();
      },
    };
  }

  global.CodemanTabLayout = {
    normalizeLayout,
    hasGroups,
    project,
    hiddenGroupAlerts,
    structureKey,
    renderProjection,
    createLoadCoordinator,
    loadCollapsedGroupIds,
    saveCollapsedGroupIds,
  };
})(typeof window !== 'undefined' ? window : globalThis);
