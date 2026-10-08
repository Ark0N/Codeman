/**
 * @fileoverview Browser projection and editing of the owner tab layout.
 *
 * `GET /api/tab-layout` returns the owner's named tab GROUPS (`src/tab-layout.ts`
 * is the server model). Browser assets cannot import that TypeScript, so this
 * module is a small, dependency-free mirror that owns four things:
 *
 *  1. Projection: which live sessions and open web tabs land in which group,
 *     and which rows a collapsed group hides.
 *  2. Rendering: the grouped markup for the vertical tab rail. Rows themselves
 *     are rendered by the caller (app.js, webview-tabs.js), so a grouped row is
 *     byte-identical to the flat rail's row.
 *  3. Load sequencing: concurrent layout reads settle newest-wins, and a failed
 *     read degrades to the flat rail with a capped, backed-off retry.
 *  4. Editing: named operations (create/rename/delete/reorder a group, move a
 *     row) applied optimistically and saved through ONE serialized
 *     `PUT /api/tab-layout` at a time, rebased onto the server's layout on a
 *     version conflict.
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
  // `placement: 'manual'` must survive the round trip: the browser writes whole
  // layouts back, and dropping it would re-attach a hand-placed child session to
  // its parent's subtree on the next save.
  const copyRef = (r) =>
    r.placement === 'manual' ? { kind: r.kind, id: r.id, placement: 'manual' } : { kind: r.kind, id: r.id };
  const copyRefs = (value) => (Array.isArray(value) ? value.filter(validRef).map(copyRef) : []);

  /** Server limits (src/tab-layout.ts), mirrored so a bad edit fails before the PUT. */
  const MAX_GROUPS = 32;
  const MAX_NAME_LENGTH = 60;

  /**
   * Defensive copy of a server layout. Unknown fields are dropped, so a newer
   * server adding model fields cannot leak half-understood state into the view.
   */
  function normalizeLayout(value) {
    if (!value || typeof value !== 'object') throw new Error('Invalid tab layout');
    const groups = Array.isArray(value.groups) ? value.groups : [];
    return {
      version: Number.isSafeInteger(value.version) && value.version >= 0 ? value.version : 0,
      updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : '',
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
          `<div class="tab-layout-group-header tab-layout-group-toggle" role="treeitem" tabindex="-1" data-tab-group-header="${id}"${expandedAttr}${expanded ? ` aria-owns="${refsId}"` : ''} onclick="app.toggleTabGroupCollapsed(this.dataset.tabGroupHeader)" oncontextmenu="event.preventDefault(); app.openTabGroupMenu(event, this.dataset.tabGroupHeader)">` +
          '<span class="tab-layout-group-chevron" aria-hidden="true"></span>' +
          `<span class="tab-layout-group-name" id="${nameId}" data-i18n-skip>${escapeHtml(section.name)}</span>` +
          `<span class="tab-layout-group-count">${section.count}</span>` +
          // Pointer path to the group menu (right-click on the header works too).
          // Deliberately NOT a button and not focusable: a treeitem holds no
          // interactive children, and the keyboard path is Shift+F10 /
          // ContextMenu on the header itself. aria-hidden keeps the glyph out of
          // the header's accessible name.
          '<span class="tab-layout-group-menu" aria-hidden="true" title="Group actions" ' +
          'onclick="event.stopPropagation(); app.openTabGroupMenu(event, this.closest(\'[data-tab-group-header]\').dataset.tabGroupHeader)">&#x22EF;</span></div>' +
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

  // ─── Editing ────────────────────────────────────────────────────────────
  //
  // The browser edits through NAMED operations, not by diffing arrays: a write
  // that loses a version race (409) is rebased by replaying the same operations
  // on the layout the server returned, so a concurrent edit elsewhere survives.
  // The server stays the authority: it re-validates and normalizes every PUT.

  function editError(message) {
    throw new Error(`Tab layout edit failed: ${message}`);
  }

  const clampIndex = (value, length) => (Number.isInteger(value) ? Math.max(0, Math.min(value, length)) : length);

  function groupName(value) {
    const name = typeof value === 'string' ? value.trim() : '';
    if (!name || name.length > MAX_NAME_LENGTH) editError(`group name must be 1-${MAX_NAME_LENGTH} characters`);
    return name;
  }

  function refLocations(layout) {
    return [
      ...layout.groups.flatMap((group) => group.refs.map((ref) => ({ groupId: group.id, ref }))),
      ...layout.ungrouped.map((ref) => ({ groupId: null, ref })),
    ];
  }

  function containerRefs(layout, groupId) {
    if (groupId === null) return layout.ungrouped;
    const group = layout.groups.find((candidate) => candidate.id === groupId);
    if (!group) editError('unknown group');
    return group.refs;
  }

  /**
   * The rows that move together with `ref`: the session plus every descendant
   * that still follows its parent (non-manual, parent stored). Mirrors the
   * server's moveRef block so the optimistic rail matches what it will store.
   * `parents` maps a session id to its parent session id.
   */
  function lineageBlock(layout, ref, parents) {
    const stored = new Map(refLocations(layout).map((item) => [refKey(item.ref), item.ref]));
    const children = new Map();
    for (const [childId, parentId] of Object.entries(parents || {})) {
      const child = stored.get(`session:${childId}`);
      if (!child || child.placement === 'manual' || !stored.has(`session:${parentId}`)) continue;
      if (!children.has(parentId)) children.set(parentId, []);
      children.get(parentId).push(childId);
    }
    const keys = new Set();
    const visit = (key) => {
      if (keys.has(key)) return;
      keys.add(key);
      if (key.startsWith('session:')) for (const id of children.get(key.slice(8)) || []) visit(`session:${id}`);
    };
    visit(refKey(ref));
    return keys;
  }

  /**
   * Where a moved row lands, as the server's `index` (counted AFTER the moved
   * block is taken out): before or after `anchor` in that container, or at its
   * end when there is no anchor.
   */
  function moveDestination(layoutInput, ref, groupId, anchor, placement, parents) {
    const layout = normalizeLayout(layoutInput);
    const block = lineageBlock(layout, ref, parents);
    const remaining = containerRefs(layout, groupId).filter((candidate) => !block.has(refKey(candidate)));
    // No anchor means "at the end", and an operation with no index keeps
    // meaning that when it is replayed onto a layout that has changed since.
    if (!anchor) return { groupId };
    const at = remaining.findIndex((candidate) => refKey(candidate) === refKey(anchor));
    if (at < 0) return { groupId };
    return { groupId, index: placement === 'after' ? at + 1 : at };
  }

  /**
   * Map a finished drag to ONE operation (or null for a drop that changes
   * nothing). Pure, so the drop -> PUT mapping is testable without a pointer.
   *
   * source: { type: 'ref', ref } | { type: 'group', groupId }
   * target: { type: 'ref', ref, groupId, placement: 'before' | 'after' }
   *       | { type: 'group', groupId }   (a named group's header or empty body)
   *       | { type: 'ungrouped' }
   *
   * A group dropped on another group (or any row in it) takes that group's slot;
   * dropped on the Ungrouped section it goes last. A row dropped on a row lands
   * before/after it, on a header it is appended to that group.
   */
  function dropOperation(layoutInput, source, target, parents) {
    const layout = normalizeLayout(layoutInput);
    if (!source || !target) return null;
    if (source.type === 'group') {
      const from = layout.groups.findIndex((group) => group.id === source.groupId);
      if (from < 0) return null;
      const targetId = target.type === 'ungrouped' ? null : (target.groupId ?? null);
      const to = targetId === null ? layout.groups.length - 1 : layout.groups.findIndex((g) => g.id === targetId);
      if (to < 0 || to === from) return null;
      return { type: 'reorderGroup', groupId: source.groupId, index: to };
    }
    if (source.type !== 'ref' || !validRef(source.ref)) return null;
    const location = refLocations(layout).find((item) => refKey(item.ref) === refKey(source.ref));
    if (!location) return null;
    let groupId;
    let anchor = null;
    let placement = 'before';
    if (target.type === 'ref' && validRef(target.ref)) {
      // Onto itself or onto a row that moves with it: nowhere to go.
      if (lineageBlock(layout, source.ref, parents).has(refKey(target.ref))) return null;
      groupId = target.groupId ?? null;
      anchor = target.ref;
      placement = target.placement === 'after' ? 'after' : 'before';
    } else if (target.type === 'group') {
      groupId = target.groupId ?? null;
      if (groupId === location.groupId) return null;
    } else if (target.type === 'ungrouped') {
      groupId = null;
      if (location.groupId === null) return null;
    } else return null;
    if (groupId !== null && !layout.groups.some((group) => group.id === groupId)) return null;
    const destination = moveDestination(layout, source.ref, groupId, anchor, placement, parents);
    const operation = {
      type: 'moveRef',
      ref: { kind: source.ref.kind, id: source.ref.id },
      groupId: destination.groupId,
      ...(destination.index === undefined ? {} : { index: destination.index }),
      parents: parents || {},
    };
    return contentKey(applyOperation(layout, operation)) === contentKey(layout) ? null : operation;
  }

  /**
   * Apply one operation to a copy of the layout. Throws when the operation no
   * longer makes sense (an unknown group or row); a rebase drops that one
   * operation and keeps the rest. Replays are idempotent where it matters for
   * recovery: creating a group that already exists is a no-op.
   */
  function applyOperation(layoutInput, operation) {
    const layout = normalizeLayout(layoutInput);
    const op = operation || {};
    const groupIndex = layout.groups.findIndex((group) => group.id === op.groupId);
    switch (op.type) {
      case 'createGroup': {
        if (typeof op.id !== 'string' || !op.id) editError('invalid group id');
        const name = groupName(op.name);
        if (layout.groups.some((group) => group.id === op.id)) return layout;
        if (layout.groups.length >= MAX_GROUPS) editError('group limit reached');
        layout.groups.splice(clampIndex(op.index, layout.groups.length), 0, { id: op.id, name, refs: [] });
        return layout;
      }
      case 'renameGroup':
        if (groupIndex < 0) editError('unknown group');
        layout.groups[groupIndex].name = groupName(op.name);
        return layout;
      case 'deleteGroup': {
        // Already gone (deleted elsewhere): nothing left to do.
        if (groupIndex < 0) return layout;
        const [removed] = layout.groups.splice(groupIndex, 1);
        layout.ungrouped.push(...removed.refs);
        return layout;
      }
      case 'reorderGroup': {
        if (groupIndex < 0) editError('unknown group');
        const [moved] = layout.groups.splice(groupIndex, 1);
        layout.groups.splice(clampIndex(op.index, layout.groups.length), 0, moved);
        return layout;
      }
      case 'moveRef': {
        if (!validRef(op.ref)) editError('invalid row');
        const targetKey = refKey(op.ref);
        if (!refLocations(layout).some((item) => refKey(item.ref) === targetKey)) editError('unknown row');
        const destinationId = op.groupId ?? null;
        containerRefs(layout, destinationId);
        const keys = lineageBlock(layout, op.ref, op.parents);
        const block = refLocations(layout)
          .filter((item) => keys.has(refKey(item.ref)))
          .map((item) => copyRef(item.ref));
        // A hand-moved child stops following its parent (server moveRef does the same).
        const head = block.find((item) => refKey(item) === targetKey);
        if (op.ref.kind === 'session' && op.parents?.[op.ref.id]) head.placement = 'manual';
        block.sort((a, b) => (a === head ? -1 : b === head ? 1 : 0));
        for (const group of layout.groups) group.refs = group.refs.filter((ref) => !keys.has(refKey(ref)));
        layout.ungrouped = layout.ungrouped.filter((ref) => !keys.has(refKey(ref)));
        const destination = containerRefs(layout, destinationId);
        destination.splice(clampIndex(op.index, destination.length), 0, ...block);
        return layout;
      }
      default:
        return editError(`unknown operation ${op.type}`);
    }
  }

  /** Layout content without version metadata: equal keys mean "nothing to save". */
  function contentKey(layoutInput) {
    const layout = normalizeLayout(layoutInput);
    return JSON.stringify([layout.groups, layout.ungrouped]);
  }

  /** Replay operations, dropping (and counting) the ones that no longer apply. */
  function replayOperations(base, operations) {
    let layout = normalizeLayout(base);
    const kept = [];
    let dropped = 0;
    for (const operation of operations) {
      try {
        layout = applyOperation(layout, operation);
        kept.push(operation);
      } catch (_error) {
        dropped++;
      }
    }
    return { layout, kept, dropped };
  }

  /**
   * Serialized, optimistic writer for `PUT /api/tab-layout`.
   *
   *  - enqueue() applies an operation at once (the rail repaints optimistically)
   *    and schedules a flush; operations enqueued in the same turn share a PUT.
   *  - Exactly ONE write is in flight. Operations enqueued meanwhile wait and are
   *    sent on top of the version that write returns.
   *  - A 409 carries the server's current layout: the in-flight operations are
   *    replayed onto it and re-sent with its version (bounded attempts). A 400
   *    (a row vanished between read and write) re-reads and rebases the same way.
   *  - Anything else, or attempts exhausted, drops the batch and reports it; the
   *    caller re-reads so the rail shows the server's truth.
   *
   * options: { initialLayout, put({ baseVersion, layout }) -> { ok, status,
   *   layout }, fetchLayout?(), applyLayout(layout, meta), reportError?(message),
   *   onSettled?(), onFailure?(), schedule?(fn), cancel?(handle), maxAttempts? }
   */
  function createEditCoordinator(options) {
    let authoritative = normalizeLayout(options.initialLayout);
    let optimistic = authoritative;
    let pending = [];
    let inFlight = [];
    let writing = false;
    let timer = null;
    let disposed = false;
    const schedule = options.schedule || ((fn) => setTimeout(fn, 0));
    const cancel = options.cancel || ((handle) => clearTimeout(handle));
    const maxAttempts = options.maxAttempts || 3;
    const report = (message) => options.reportError?.(message);
    const publish = (meta) => options.applyLayout(normalizeLayout(optimistic), meta);
    const queue = () => {
      if (timer === null) timer = schedule(flush);
    };

    async function flush() {
      timer = null;
      if (disposed || writing || pending.length === 0) return;
      writing = true;
      inFlight = pending;
      pending = [];
      let failed = false;
      let reportedDrop = false;
      let rereadFor400 = false;
      try {
        for (let attempt = 0; attempt < maxAttempts && inFlight.length; attempt++) {
          const desired = replayOperations(authoritative, inFlight);
          inFlight = desired.kept;
          if (desired.dropped && !reportedDrop) {
            reportedDrop = true;
            report('Tab groups changed elsewhere; part of your edit no longer applies.');
          }
          // Nothing left to change (dropped, or already true on the server).
          if (!inFlight.length || contentKey(desired.layout) === contentKey(authoritative)) {
            inFlight = [];
            break;
          }
          const response = await options.put({ baseVersion: authoritative.version, layout: desired.layout });
          if (disposed) return;
          if (response?.ok && response.layout) {
            authoritative = normalizeLayout(response.layout);
            inFlight = [];
          } else if (response?.status === 409 && response.layout) {
            authoritative = normalizeLayout(response.layout);
          } else if (response?.status === 400 && options.fetchLayout && !rereadFor400) {
            // Maybe our base was stale in a way the server reports as invalid:
            // re-read once. A 400 that survives that is a refusal, not a race.
            rereadFor400 = true;
            authoritative = normalizeLayout(await options.fetchLayout());
            if (disposed) return;
          } else {
            throw new Error('Tab layout save failed');
          }
        }
        if (inFlight.length) {
          failed = true;
          report('Tab groups kept changing elsewhere; your edit was not saved.');
        }
      } catch (_error) {
        failed = true;
        report('Could not save tab groups.');
      } finally {
        inFlight = [];
        writing = false;
        if (!disposed) {
          const rebased = replayOperations(authoritative, pending);
          // Edits made while the write was in flight are rebased here, so one the
          // conflict made inapplicable is dropped here too, and says so (once).
          if (rebased.dropped && !failed && !reportedDrop) {
            report('Tab groups changed elsewhere; part of your edit no longer applies.');
          }
          pending = rebased.kept;
          optimistic = rebased.layout;
          publish({ authoritative: true });
          if (failed) options.onFailure?.();
          if (pending.length) queue();
          else options.onSettled?.();
        }
      }
    }

    return {
      /** Apply now, save soon. Throws (and changes nothing) for an invalid edit. */
      enqueue(operation) {
        optimistic = applyOperation(optimistic, operation);
        pending.push(operation);
        publish({ optimistic: true });
        queue();
        return normalizeLayout(optimistic);
      },
      /**
       * Re-apply operations recovered after a reload. Returns false (and queues
       * nothing) when the layout already reflects them, e.g. the keepalive save
       * landed before the page went away.
       */
      restore(operations) {
        const replayed = replayOperations(optimistic, Array.isArray(operations) ? operations : []);
        if (!replayed.kept.length || contentKey(replayed.layout) === contentKey(optimistic)) return false;
        optimistic = replayed.layout;
        pending.push(...replayed.kept);
        publish({ optimistic: true });
        queue();
        return true;
      },
      /**
       * Adopt a layout read from the server (SSE reload). Pending operations are
       * rebased onto it. Refused while a write is in flight (its result decides)
       * and for a layout older than the one already held.
       */
      adoptExternal(layout) {
        if (disposed || writing) return false;
        const next = normalizeLayout(layout);
        if (next.version < authoritative.version) return false;
        authoritative = next;
        const rebased = replayOperations(next, pending);
        if (rebased.dropped) report('Tab groups changed elsewhere; part of your edit no longer applies.');
        pending = rebased.kept;
        optimistic = rebased.layout;
        publish({ authoritative: true, external: true });
        return true;
      },
      flush,
      isWriting: () => writing,
      hasPending: () => writing || pending.length > 0,
      /** Every operation not yet confirmed by the server, oldest first. */
      pendingOperations: () => JSON.parse(JSON.stringify([...inFlight, ...pending])),
      baseVersion: () => authoritative.version,
      getLayout: () => normalizeLayout(optimistic),
      dispose() {
        disposed = true;
        if (timer !== null) cancel(timer);
        timer = null;
        pending = [];
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
    applyOperation,
    moveDestination,
    movingRefKeys: (layout, ref, parents) => [...lineageBlock(normalizeLayout(layout), ref, parents)],
    dropOperation,
    contentKey,
    createEditCoordinator,
    createLoadCoordinator,
    loadCollapsedGroupIds,
    saveCollapsedGroupIds,
    MAX_GROUPS,
  };
})(typeof window !== 'undefined' ? window : globalThis);
