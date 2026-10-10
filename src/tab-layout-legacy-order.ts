/**
 * @fileoverview Pure compatibility translation between legacy session order and owner tab layouts.
 */

import { mergeSessionOrder, normalizeSessionOrder } from './session-order.js';
import {
  normalizeTabLayout,
  validateTabLayout,
  type TabLayout,
  type TabRef,
  type TabRefMetadata,
} from './tab-layout.js';

export interface OwnerOrderProjection {
  owner: string;
  ownedIds: readonly string[];
  order: readonly string[];
}

export function applyLegacySessionRank(
  input: TabLayout,
  requestedOrder: readonly string[],
  metadata: readonly TabRefMetadata[]
): TabLayout {
  const layout = validateTabLayout(input);
  const requestedRank = new Map(normalizeSessionOrder(requestedOrder).map((id, index) => [id, index]));
  const sessionMetadata = new Map<string, TabRefMetadata>();
  for (const item of metadata) {
    if (item.kind !== 'session' || !item.ownerValid || !item.visible || sessionMetadata.has(item.id)) continue;
    sessionMetadata.set(item.id, item);
  }

  const isRanked = (ref: TabRef): boolean =>
    ref.kind === 'session' && sessionMetadata.has(ref.id) && requestedRank.has(ref.id);
  const rankContainer = (refs: readonly TabRef[]): TabRef[] => {
    const ranked = refs.filter(isRanked).sort((a, b) => requestedRank.get(a.id)! - requestedRank.get(b.id)!);
    let rankedIndex = 0;
    return refs.map((ref) => ({ ...(isRanked(ref) ? ranked[rankedIndex++] : ref) }));
  };

  const ranked: TabLayout = {
    ...layout,
    groups: layout.groups.map((group) => ({ ...group, refs: rankContainer(group.refs) })),
    ungrouped: rankContainer(layout.ungrouped),
  };
  const manual = childrenSplitFromParent(ranked, sessionMetadata);
  const pin = (ref: TabRef): TabRef =>
    ref.kind === 'session' && manual.has(ref.id) ? { ...ref, placement: 'manual' } : ref;
  const transformed: TabLayout = {
    ...ranked,
    groups: ranked.groups.map((group) => ({ ...group, refs: group.refs.map(pin) })),
    ungrouped: ranked.ungrouped.map(pin),
  };
  return normalizeTabLayout(transformed, metadata);
}

/**
 * The following children (no `manual` placement, an owner-valid parent) that a
 * ranked layout separates from their parent's block. A parent's block is the
 * parent and, right after it in the same container, its following descendants;
 * sibling order inside the block is free, and a web tab the ranking left in a
 * slot between them does not split it (normalization closes the block again). Only these children become `manual`:
 * a PUT of the current order, or one that moves a family together, leaves every
 * stored placement alone. Pinning one child shrinks its parent's block, so the
 * check repeats until nothing more is pinned.
 */
function childrenSplitFromParent(ranked: TabLayout, sessionMetadata: ReadonlyMap<string, TabRefMetadata>): Set<string> {
  const containers = [...ranked.groups.map((group) => group.refs), ranked.ungrouped];
  const following = new Map<string, string>();
  for (const refs of containers) {
    for (const ref of refs) {
      if (ref.kind !== 'session' || ref.placement === 'manual') continue;
      const parentId = sessionMetadata.get(ref.id)?.parentSessionId;
      if (parentId && sessionMetadata.has(parentId)) following.set(ref.id, parentId);
    }
  }
  const descendsFrom = (id: string, ancestorId: string): boolean => {
    let current = following.get(id);
    for (let hops = 0; current !== undefined && hops <= following.size; hops++) {
      if (current === ancestorId) return true;
      current = following.get(current);
    }
    return false;
  };
  const manual = new Set<string>();
  for (let changed = true; changed; ) {
    changed = false;
    for (const refs of containers) {
      const index = new Map<string, number>();
      refs.forEach((ref, at) => {
        if (ref.kind === 'session') index.set(ref.id, at);
      });
      refs.forEach((ref, at) => {
        if (ref.kind !== 'session') return;
        const parentId = following.get(ref.id);
        if (parentId === undefined) return;
        const parentAt = index.get(parentId);
        const inBlock =
          parentAt !== undefined &&
          parentAt < at &&
          refs
            .slice(parentAt + 1, at)
            .every((between) => between.kind !== 'session' || descendsFrom(between.id, parentId));
        if (inBlock) return;
        following.delete(ref.id);
        manual.add(ref.id);
        changed = true;
      });
    }
  }
  return manual;
}

export function recomposeGlobalSessionOrder(
  current: readonly string[],
  projections: readonly OwnerOrderProjection[],
  preferred?: readonly string[]
): string[] {
  let result = mergeSessionOrder([...(preferred ?? current)], [...current]);
  for (const projection of projections) {
    const ownedIds = normalizeSessionOrder(projection.ownedIds);
    const owned = new Set(ownedIds);
    const canonical = normalizeSessionOrder(projection.order).filter((id) => owned.has(id));
    const canonicalSet = new Set(canonical);
    for (const id of ownedIds) {
      if (canonicalSet.has(id)) continue;
      canonicalSet.add(id);
      canonical.push(id);
    }

    let canonicalIndex = 0;
    const recomposed = result.map((id) => (owned.has(id) ? canonical[canonicalIndex++] : id));
    recomposed.push(...canonical.slice(canonicalIndex));
    result = normalizeSessionOrder(recomposed);
  }
  return result;
}
