/**
 * @fileoverview Framework-independent tab layout model.
 *
 * Callers provide owner-scoped session/webview metadata. This module deliberately
 * has no dependency on session runtime, persistence, routes, or browser state.
 */

export const MAX_TAB_GROUPS = 32;
export const MAX_TAB_GROUP_NAME_LENGTH = 60;
export const MAX_TAB_REFS = 512;

export type TabRefKind = 'session' | 'webview';

export interface TabRef {
  kind: TabRefKind;
  id: string;
  placement?: 'manual';
  /**
   * Pinned to the vertical rail's Focus section. The browser draws a SHORTCUT to
   * the ref there; the ref itself stays in its group, so the flag never moves
   * anything and nothing that moves a ref may drop it. Only `true` is stored:
   * an unfocused ref carries no key at all.
   */
  focus?: true;
}

export interface TabGroup {
  id: string;
  name: string;
  refs: TabRef[];
}

export interface TabLayout {
  version: number;
  groups: TabGroup[];
  ungrouped: TabRef[];
  updatedAt: string;
}

/** Owner and lineage facts supplied by the server or browser integration. */
export interface TabRefMetadata {
  kind: TabRefKind;
  id: string;
  /** False for missing, foreign-owned, or otherwise invalid refs. */
  ownerValid: boolean;
  /** False when the owner is not permitted to see/store this ref. */
  visible: boolean;
  /** Stable creation/sibling order. Ties fall back to kind and id. */
  order: number;
  /** Session-only lineage hint. Ignored for webviews. */
  parentSessionId?: string;
}

export interface TabMoveTarget {
  /** Null denotes the real ungrouped container. */
  groupId: string | null;
  /** Zero-based insertion index after removing the moved block. */
  index: number;
}

export interface CreateTabGroupInput {
  id: string;
  name: string;
  index?: number;
}

export interface VisibleTabProjectionOptions {
  liveSessionIds: ReadonlySet<string>;
  openWebviewIds: ReadonlySet<string>;
  collapsedGroupIds?: ReadonlySet<string>;
  highlighted?: TabRef;
}

export class TabLayoutValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TabLayoutValidationError';
  }
}

const keyOf = (ref: Pick<TabRef, 'kind' | 'id'>): string => `${ref.kind}\u0000${ref.id}`;

function assertRecord(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TabLayoutValidationError(`${label} must be an object`);
  }
}

function parseNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TabLayoutValidationError(`${label} must be a non-empty string`);
  }
  return value;
}

function parseName(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new TabLayoutValidationError(`${label} must be a string`);
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_TAB_GROUP_NAME_LENGTH) {
    throw new TabLayoutValidationError(`${label} must be 1-${MAX_TAB_GROUP_NAME_LENGTH} trimmed characters`);
  }
  return trimmed;
}

function parseRef(value: unknown, label: string): TabRef {
  assertRecord(value, label);
  if (value.kind !== 'session' && value.kind !== 'webview') {
    throw new TabLayoutValidationError(`${label}.kind must be session or webview`);
  }
  const id = parseNonEmptyString(value.id, `${label}.id`);
  if (value.placement !== undefined && value.placement !== 'manual') {
    throw new TabLayoutValidationError(`${label}.placement must be manual when present`);
  }
  if (value.focus !== undefined && value.focus !== true) {
    throw new TabLayoutValidationError(`${label}.focus must be true when present`);
  }
  const ref: TabRef = { kind: value.kind, id };
  if (value.placement === 'manual') ref.placement = 'manual';
  if (value.focus === true) ref.focus = true;
  return ref;
}

function parseTabLayout(input: unknown, repairDuplicates: boolean): TabLayout {
  assertRecord(input, 'layout');
  if (!Number.isSafeInteger(input.version) || (input.version as number) < 0) {
    throw new TabLayoutValidationError('layout.version must be a non-negative safe integer');
  }
  if (!Array.isArray(input.groups)) throw new TabLayoutValidationError('layout.groups must be an array');
  if (input.groups.length > MAX_TAB_GROUPS) {
    throw new TabLayoutValidationError(`layout.groups cannot exceed ${MAX_TAB_GROUPS}`);
  }
  if (!Array.isArray(input.ungrouped)) throw new TabLayoutValidationError('layout.ungrouped must be an array');
  const updatedAt = parseNonEmptyString(input.updatedAt, 'layout.updatedAt');
  const groupIds = new Set<string>();
  const refKeys = new Set<string>();
  let refCount = input.ungrouped.length;
  const parseStoredRef = (entry: unknown, label: string): TabRef => {
    const ref = parseRef(entry, label);
    const key = keyOf(ref);
    if (!repairDuplicates && refKeys.has(key)) {
      throw new TabLayoutValidationError(`duplicate ref: ${ref.kind}:${ref.id}`);
    }
    refKeys.add(key);
    return ref;
  };
  const groups = input.groups.map((rawGroup, groupIndex): TabGroup => {
    const label = `layout.groups[${groupIndex}]`;
    assertRecord(rawGroup, label);
    const id = parseNonEmptyString(rawGroup.id, `${label}.id`);
    if (groupIds.has(id)) throw new TabLayoutValidationError(`duplicate group id: ${id}`);
    groupIds.add(id);
    if (!Array.isArray(rawGroup.refs)) throw new TabLayoutValidationError(`${label}.refs must be an array`);
    refCount += rawGroup.refs.length;
    return {
      id,
      name: parseName(rawGroup.name, `${label}.name`),
      refs: rawGroup.refs.map((entry, refIndex) => parseStoredRef(entry, `${label}.refs[${refIndex}]`)),
    };
  });
  if (refCount > MAX_TAB_REFS) {
    throw new TabLayoutValidationError(`layout cannot contain more than ${MAX_TAB_REFS} refs`);
  }
  return {
    version: input.version as number,
    groups,
    ungrouped: input.ungrouped.map((entry, index) => parseStoredRef(entry, `layout.ungrouped[${index}]`)),
    updatedAt,
  };
}

/** Validate and defensively clone a layout. Group names are normalized by trimming. */
export function validateTabLayout(input: unknown): TabLayout {
  return parseTabLayout(input, false);
}

function validMetadata(metadata: readonly TabRefMetadata[]): TabRefMetadata[] {
  const byKey = new Map<string, TabRefMetadata>();
  for (const item of metadata) {
    if ((item.kind !== 'session' && item.kind !== 'webview') || typeof item.id !== 'string' || item.id.length === 0) {
      throw new TabLayoutValidationError('metadata contains an invalid ref identity');
    }
    if (!Number.isFinite(item.order)) throw new TabLayoutValidationError(`metadata order is invalid for ${item.id}`);
    if (!item.ownerValid || !item.visible) continue;
    const key = keyOf(item);
    if (!byKey.has(key)) byKey.set(key, { ...item });
  }
  const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
  const result = [...byKey.values()].sort(
    (a, b) => a.order - b.order || compareText(a.kind, b.kind) || compareText(a.id, b.id)
  );
  if (result.length > MAX_TAB_REFS) {
    throw new TabLayoutValidationError(`owner layout cannot exceed ${MAX_TAB_REFS} refs`);
  }
  return result;
}

interface LocatedRef {
  ref: TabRef;
  container: string | null;
  position: number;
}

function locations(layout: TabLayout): LocatedRef[] {
  const result: LocatedRef[] = [];
  let position = 0;
  for (const group of layout.groups) {
    for (const ref of group.refs) result.push({ ref, container: group.id, position: position++ });
  }
  for (const ref of layout.ungrouped) result.push({ ref, container: null, position: position++ });
  return result;
}

function withContainers(layout: TabLayout, refsByContainer: ReadonlyMap<string | null, TabRef[]>): TabLayout {
  return {
    ...layout,
    groups: layout.groups.map((group) => ({ ...group, refs: [...(refsByContainer.get(group.id) ?? [])] })),
    ungrouped: [...(refsByContainer.get(null) ?? [])],
  };
}

/**
 * Reconcile a layout against owner-valid metadata and session lineage.
 * First stored occurrence wins; missing valid refs append to ungrouped.
 */
export function normalizeTabLayout(input: TabLayout, metadata: readonly TabRefMetadata[]): TabLayout {
  const layout = parseTabLayout(input, true);
  const valid = validMetadata(metadata);
  const metadataByKey = new Map(valid.map((item) => [keyOf(item), item]));
  const knownMetadataKeys = new Set(metadata.map((item) => keyOf(item)));
  const seen = new Set<string>();
  const dedupedByContainer = new Map<string | null, TabRef[]>();
  for (const group of layout.groups) dedupedByContainer.set(group.id, []);
  dedupedByContainer.set(null, []);

  for (const located of locations(layout)) {
    const key = keyOf(located.ref);
    // Missing metadata is unknown rather than invalid (for example, during
    // restoration). Preserve it until an explicit invalid/deletion fact arrives.
    if ((knownMetadataKeys.has(key) && !metadataByKey.has(key)) || seen.has(key)) continue;
    seen.add(key);
    dedupedByContainer.get(located.container)!.push({ ...located.ref });
  }
  for (const item of valid) {
    const key = keyOf(item);
    if (seen.has(key)) continue;
    seen.add(key);
    dedupedByContainer.get(null)!.push({ kind: item.kind, id: item.id });
  }
  if (seen.size > MAX_TAB_REFS) {
    throw new TabLayoutValidationError(`normalized layout cannot exceed ${MAX_TAB_REFS} refs`);
  }

  let working = withContainers(layout, dedupedByContainer);
  const located = locations(working);
  const refByKey = new Map(located.map((item) => [keyOf(item.ref), item.ref]));
  const sessionById = new Map(valid.filter((item) => item.kind === 'session').map((item) => [item.id, item]));
  const manualCycleEdges = new Set<string>();
  const state = new Map<string, 'visiting' | 'done'>();

  const visit = (id: string): void => {
    if (state.get(id) === 'done') return;
    state.set(id, 'visiting');
    const item = sessionById.get(id);
    const stored = refByKey.get(keyOf({ kind: 'session', id }));
    if (item?.parentSessionId && stored?.placement !== 'manual') {
      const parent = sessionById.get(item.parentSessionId);
      const parentStored = refByKey.get(keyOf({ kind: 'session', id: item.parentSessionId }));
      if (parent && parentStored) {
        if (state.get(parent.id) === 'visiting') manualCycleEdges.add(id);
        else visit(parent.id);
      }
    }
    state.set(id, 'done');
  };
  for (const item of located)
    if (item.ref.kind === 'session' && state.get(item.ref.id) === undefined) visit(item.ref.id);

  if (manualCycleEdges.size > 0) {
    working = {
      ...working,
      groups: working.groups.map((group) => ({
        ...group,
        refs: group.refs.map((ref) =>
          ref.kind === 'session' && manualCycleEdges.has(ref.id) ? { ...ref, placement: 'manual' } : ref
        ),
      })),
      ungrouped: working.ungrouped.map((ref) =>
        ref.kind === 'session' && manualCycleEdges.has(ref.id) ? { ...ref, placement: 'manual' } : ref
      ),
    };
  }

  const ordered = locations(working);
  const updatedRefByKey = new Map(ordered.map((item) => [keyOf(item.ref), item.ref]));
  const parentOf = new Map<string, string>();
  const children = new Map<string, string[]>();
  for (const item of ordered) {
    if (item.ref.kind !== 'session' || item.ref.placement === 'manual') continue;
    const info = sessionById.get(item.ref.id);
    const parentId = info?.parentSessionId;
    if (!parentId || !sessionById.has(parentId) || !updatedRefByKey.has(keyOf({ kind: 'session', id: parentId })))
      continue;
    parentOf.set(item.ref.id, parentId);
    const siblings = children.get(parentId) ?? [];
    siblings.push(item.ref.id);
    children.set(parentId, siblings);
  }

  const emitted = new Set<string>();
  const output = new Map<string | null, TabRef[]>();
  for (const group of working.groups) output.set(group.id, []);
  output.set(null, []);
  const emitSubtree = (root: TabRef, container: string | null): void => {
    const rootKey = keyOf(root);
    if (emitted.has(rootKey)) return;
    emitted.add(rootKey);
    output.get(container)!.push({ ...root });
    if (root.kind !== 'session') return;
    for (const childId of children.get(root.id) ?? []) {
      const child = updatedRefByKey.get(keyOf({ kind: 'session', id: childId }));
      if (child) emitSubtree(child, container);
    }
  };
  for (const item of ordered) {
    if (item.ref.kind === 'session' && parentOf.has(item.ref.id)) continue;
    emitSubtree(item.ref, item.container);
  }
  return withContainers(working, output);
}

function cloneForEdit(input: TabLayout): TabLayout {
  return validateTabLayout(input);
}

function boundedIndex(index: number, length: number, label: string): number {
  if (!Number.isSafeInteger(index) || index < 0 || index > length) {
    throw new TabLayoutValidationError(`${label} index must be between 0 and ${length}`);
  }
  return index;
}

export function createGroup(input: TabLayout, group: CreateTabGroupInput): TabLayout {
  const layout = cloneForEdit(input);
  if (layout.groups.length >= MAX_TAB_GROUPS)
    throw new TabLayoutValidationError(`cannot exceed ${MAX_TAB_GROUPS} groups`);
  const id = parseNonEmptyString(group.id, 'group.id');
  if (layout.groups.some((entry) => entry.id === id)) throw new TabLayoutValidationError(`duplicate group id: ${id}`);
  const index = boundedIndex(group.index ?? layout.groups.length, layout.groups.length, 'group');
  const groups = [...layout.groups];
  groups.splice(index, 0, { id, name: parseName(group.name, 'group.name'), refs: [] });
  return { ...layout, groups };
}

export function renameGroup(input: TabLayout, groupId: string, name: string): TabLayout {
  const layout = cloneForEdit(input);
  if (!layout.groups.some((group) => group.id === groupId))
    throw new TabLayoutValidationError(`unknown group: ${groupId}`);
  return {
    ...layout,
    groups: layout.groups.map((group) =>
      group.id === groupId ? { ...group, name: parseName(name, 'group.name') } : group
    ),
  };
}

export function deleteGroup(input: TabLayout, groupId: string): TabLayout {
  const layout = cloneForEdit(input);
  const group = layout.groups.find((entry) => entry.id === groupId);
  if (!group) throw new TabLayoutValidationError(`unknown group: ${groupId}`);
  return {
    ...layout,
    groups: layout.groups.filter((entry) => entry.id !== groupId),
    ungrouped: [...layout.ungrouped, ...group.refs.map((ref) => ({ ...ref }))],
  };
}

export function reorderGroup(input: TabLayout, groupId: string, index: number): TabLayout {
  const layout = cloneForEdit(input);
  const from = layout.groups.findIndex((group) => group.id === groupId);
  if (from < 0) throw new TabLayoutValidationError(`unknown group: ${groupId}`);
  const groups = [...layout.groups];
  const [group] = groups.splice(from, 1);
  groups.splice(boundedIndex(index, groups.length, 'group'), 0, group);
  return { ...layout, groups };
}

function mapRef(input: TabLayout, target: TabRef, transform: (ref: TabRef) => TabRef): TabLayout {
  const layout = cloneForEdit(input);
  let found = false;
  const apply = (ref: TabRef): TabRef => {
    if (keyOf(ref) !== keyOf(target)) return ref;
    found = true;
    return transform(ref);
  };
  const result = {
    ...layout,
    groups: layout.groups.map((group) => ({ ...group, refs: group.refs.map(apply) })),
    ungrouped: layout.ungrouped.map(apply),
  };
  if (!found) throw new TabLayoutValidationError(`unknown ref: ${target.kind}:${target.id}`);
  return result;
}

export function setManualPlacement(input: TabLayout, target: TabRef, manual: boolean): TabLayout {
  if (!manual) {
    throw new TabLayoutValidationError('manual placement can only be cleared through followParent');
  }
  return mapRef(input, target, (ref) => ({ ...ref, placement: 'manual' }));
}

/** Pin `target` to the Focus section, or unpin it. Moves nothing; idempotent both ways. */
export function setTabFocus(input: TabLayout, target: TabRef, focused: boolean): TabLayout {
  return mapRef(input, target, ({ focus: _focus, ...ref }) => (focused ? { ...ref, focus: true } : ref));
}

export function followParent(input: TabLayout, target: TabRef, metadata: readonly TabRefMetadata[]): TabLayout {
  const normalized = normalizeTabLayout(input, metadata);
  if (target.kind !== 'session') {
    throw new TabLayoutValidationError('only a session ref can follow a parent');
  }

  const valid = validMetadata(metadata);
  const targetMetadata = valid.find((item) => item.kind === 'session' && item.id === target.id);
  if (!targetMetadata?.parentSessionId) {
    throw new TabLayoutValidationError(`session has no owner-valid parent: ${target.id}`);
  }
  const parentMetadata = valid.find((item) => item.kind === 'session' && item.id === targetMetadata.parentSessionId);
  if (!parentMetadata) {
    throw new TabLayoutValidationError(`session parent is not owner-valid: ${targetMetadata.parentSessionId}`);
  }

  const storedKeys = new Set(locations(normalized).map((item) => keyOf(item.ref)));
  if (!storedKeys.has(keyOf(target))) {
    throw new TabLayoutValidationError(`unknown ref: ${target.kind}:${target.id}`);
  }
  const parentRef: TabRef = { kind: 'session', id: targetMetadata.parentSessionId };
  if (!storedKeys.has(keyOf(parentRef))) {
    throw new TabLayoutValidationError(`session parent is not represented: ${targetMetadata.parentSessionId}`);
  }

  // Clear the manual placement only: a focused ref stays focused.
  const cleared = mapRef(normalized, target, ({ placement: _placement, ...ref }) => ref);
  return normalizeTabLayout(cleared, metadata);
}

function descendantKeys(root: TabRef, layout: TabLayout, metadata: readonly TabRefMetadata[]): Set<string> {
  const valid = validMetadata(metadata);
  const stored = new Map(locations(layout).map((item) => [keyOf(item.ref), item.ref]));
  const children = new Map<string, string[]>();
  for (const item of valid) {
    if (item.kind !== 'session' || !item.parentSessionId) continue;
    const child = stored.get(keyOf(item));
    if (!child || child.placement === 'manual' || !stored.has(keyOf({ kind: 'session', id: item.parentSessionId })))
      continue;
    const siblings = children.get(item.parentSessionId) ?? [];
    siblings.push(item.id);
    children.set(item.parentSessionId, siblings);
  }
  const result = new Set<string>();
  const add = (ref: TabRef): void => {
    const key = keyOf(ref);
    if (result.has(key)) return;
    result.add(key);
    if (ref.kind !== 'session') return;
    for (const childId of children.get(ref.id) ?? []) add({ kind: 'session', id: childId });
  };
  add(root);
  return result;
}

export function moveRef(
  input: TabLayout,
  target: TabRef,
  destination: TabMoveTarget,
  metadata: readonly TabRefMetadata[]
): TabLayout {
  let layout = normalizeTabLayout(input, metadata);
  const targetKey = keyOf(target);
  if (!locations(layout).some((item) => keyOf(item.ref) === targetKey)) {
    throw new TabLayoutValidationError(`unknown ref: ${target.kind}:${target.id}`);
  }
  if (destination.groupId !== null && !layout.groups.some((group) => group.id === destination.groupId)) {
    throw new TabLayoutValidationError(`unknown group: ${destination.groupId}`);
  }

  const blockKeys = descendantKeys(target, layout, metadata);
  const block = locations(layout)
    .filter((item) => blockKeys.has(keyOf(item.ref)))
    .map((item) => ({ ...item.ref }));
  const metadataItem = validMetadata(metadata).find((item) => keyOf(item) === targetKey);
  if (target.kind === 'session' && metadataItem?.parentSessionId) block[0] = { ...block[0], placement: 'manual' };

  const remaining = new Map<string | null, TabRef[]>();
  for (const group of layout.groups)
    remaining.set(
      group.id,
      group.refs.filter((ref) => !blockKeys.has(keyOf(ref)))
    );
  remaining.set(
    null,
    layout.ungrouped.filter((ref) => !blockKeys.has(keyOf(ref)))
  );
  const destinationRefs = remaining.get(destination.groupId)!;
  const index = boundedIndex(destination.index, destinationRefs.length, 'destination');
  destinationRefs.splice(index, 0, ...block);
  layout = withContainers(layout, remaining);
  return normalizeTabLayout(layout, metadata);
}

/**
 * Remove explicitly deleted session parents and pin their direct inherited
 * children at their current stored positions so a later reused ID cannot adopt them.
 */
export function materializeOrphans(
  input: TabLayout,
  removedParentIds: readonly string[],
  metadata: readonly TabRefMetadata[]
): TabLayout {
  const layout = cloneForEdit(input);
  const removed = new Set(removedParentIds);
  const directChildren = new Set(
    validMetadata(metadata)
      .filter((item) => item.kind === 'session' && item.parentSessionId && removed.has(item.parentSessionId))
      .map((item) => item.id)
  );
  const transform = (refs: readonly TabRef[]): TabRef[] =>
    refs
      .filter((ref) => ref.kind !== 'session' || !removed.has(ref.id))
      .map((ref) =>
        ref.kind === 'session' && directChildren.has(ref.id) && ref.placement !== 'manual'
          ? { ...ref, placement: 'manual' }
          : { ...ref }
      );
  return {
    ...layout,
    groups: layout.groups.map((group) => ({ ...group, refs: transform(group.refs) })),
    ungrouped: transform(layout.ungrouped),
  };
}

/** Session-only compatibility order; collapse and webviews do not affect it. */
export function flattenOwnerSessionOrder(input: TabLayout): string[] {
  return locations(validateTabLayout(input))
    .map((item) => item.ref)
    .filter((ref): ref is TabRef & { kind: 'session' } => ref.kind === 'session')
    .map((ref) => ref.id);
}

/** Locally renderable order used by tab painting and Alt-number consumers. */
export function flattenVisibleRefs(input: TabLayout, options: VisibleTabProjectionOptions): TabRef[] {
  const layout = validateTabLayout(input);
  const collapsed = options.collapsedGroupIds ?? new Set<string>();
  const renderable = (ref: TabRef): boolean =>
    ref.kind === 'session' ? options.liveSessionIds.has(ref.id) : options.openWebviewIds.has(ref.id);
  const highlightedKey = options.highlighted ? keyOf(options.highlighted) : undefined;
  const result: TabRef[] = [];
  for (const group of layout.groups) {
    for (const ref of group.refs) {
      if (!renderable(ref)) continue;
      if (collapsed.has(group.id) && keyOf(ref) !== highlightedKey) continue;
      result.push({ ...ref });
    }
  }
  for (const ref of layout.ungrouped) if (renderable(ref)) result.push({ ...ref });
  return result;
}
