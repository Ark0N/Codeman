/**
 * @fileoverview Pure compatibility translation between legacy session order and owner tab layouts.
 */

import { describe, expect, it } from 'vitest';
import {
  applyLegacySessionRank,
  recomposeGlobalSessionOrder,
  type OwnerOrderProjection,
} from '../src/tab-layout-legacy-order.js';
import { normalizeTabLayout, validateTabLayout, type TabLayout, type TabRefMetadata } from '../src/tab-layout.js';

const session = (id: string, placement?: 'manual') =>
  placement ? { kind: 'session' as const, id, placement } : { kind: 'session' as const, id };
const webview = (id: string) => ({ kind: 'webview' as const, id });
const metadata = (id: string, overrides: Partial<TabRefMetadata> = {}): TabRefMetadata => ({
  kind: 'session',
  id,
  ownerValid: true,
  visible: true,
  order: 0,
  ...overrides,
});
const layout = (overrides: Partial<TabLayout> = {}): TabLayout => ({
  version: 1,
  groups: [],
  ungrouped: [],
  updatedAt: '2026-08-23T12:00:00.000Z',
  ...overrides,
});

describe('applyLegacySessionRank', () => {
  it('ranks only authoritative sessions while anchoring webviews and refs absent from metadata', () => {
    const input = layout({
      ungrouped: [session('a'), webview('w1'), session('unknown'), session('b')],
    });

    expect(applyLegacySessionRank(input, ['b', 'a'], [metadata('a'), metadata('b')])).toEqual(
      layout({
        ungrouped: [session('b'), webview('w1'), session('unknown'), session('a')],
      })
    );
  });

  it('ranks sessions only inside their current containers without changing groups or webview slots', () => {
    const input = layout({
      groups: [
        { id: 'first', name: 'First', refs: [session('a'), webview('w1'), session('d')] },
        { id: 'second', name: 'Second', refs: [session('b'), webview('w2'), session('c')] },
      ],
      ungrouped: [session('e'), webview('w3'), session('f')],
    });
    const facts = ['a', 'b', 'c', 'd', 'e', 'f'].map((id, order) => metadata(id, { order }));

    const result = applyLegacySessionRank(input, ['f', 'c', 'd', 'e', 'b', 'a'], facts);

    expect(result.groups).toEqual([
      { id: 'first', name: 'First', refs: [session('d'), webview('w1'), session('a')] },
      { id: 'second', name: 'Second', refs: [session('c'), webview('w2'), session('b')] },
    ]);
    expect(result.ungrouped).toEqual([session('f'), webview('w3'), session('e')]);
  });

  it('materializes ranked children with represented owner-valid parents before normalization', () => {
    const input = layout({
      groups: [
        {
          id: 'family',
          name: 'Family',
          refs: [session('parent'), session('child'), session('other')],
        },
      ],
    });
    const facts = [
      metadata('parent', { order: 0 }),
      metadata('child', { order: 1, parentSessionId: 'parent' }),
      metadata('other', { order: 2 }),
    ];

    const result = applyLegacySessionRank(input, ['child', 'other', 'parent'], facts);

    expect(result.groups[0].refs).toEqual([session('child', 'manual'), session('other'), session('parent')]);
    expect(normalizeTabLayout(result, facts)).toEqual(result);
  });

  it('leaves every placement alone when the requested order is the current order', () => {
    const input = layout({
      groups: [
        {
          id: 'family',
          name: 'Family',
          refs: [session('parent'), session('child'), session('grandchild'), session('other')],
        },
      ],
      ungrouped: [session('loose', 'manual')],
    });
    const facts = [
      metadata('parent', { order: 0 }),
      metadata('child', { order: 1, parentSessionId: 'parent' }),
      metadata('grandchild', { order: 2, parentSessionId: 'child' }),
      metadata('other', { order: 3 }),
      metadata('loose', { order: 4, parentSessionId: 'parent' }),
    ];

    const result = applyLegacySessionRank(input, ['parent', 'child', 'grandchild', 'other', 'loose'], facts);

    expect(result.groups[0].refs).toEqual(input.groups[0].refs);
    expect(result.ungrouped).toEqual([session('loose', 'manual')]);
  });

  it('keeps a child following when the reorder keeps it in its parent block', () => {
    const input = layout({
      ungrouped: [session('x'), session('parent'), session('c1'), session('c2'), webview('w'), session('y')],
    });
    const facts = [
      metadata('x', { order: 0 }),
      metadata('parent', { order: 1 }),
      metadata('c1', { order: 2, parentSessionId: 'parent' }),
      metadata('c2', { order: 3, parentSessionId: 'parent' }),
      metadata('y', { order: 4 }),
    ];

    // The whole family moves ahead of x, and its two children swap places.
    const result = applyLegacySessionRank(input, ['parent', 'c2', 'c1', 'x', 'y'], facts);

    expect(result.ungrouped).toEqual([
      session('parent'),
      session('c2'),
      session('c1'),
      session('x'),
      webview('w'),
      session('y'),
    ]);
  });

  it('does not read a web tab left between a parent and its child as a split', () => {
    const input = layout({ ungrouped: [session('x'), webview('w'), session('parent'), session('child')] });
    const facts = [
      metadata('x', { order: 0 }),
      metadata('parent', { order: 1 }),
      metadata('child', { order: 2, parentSessionId: 'parent' }),
    ];

    const result = applyLegacySessionRank(input, ['parent', 'child', 'x'], facts);

    expect(result.ungrouped).toEqual([session('parent'), session('child'), webview('w'), session('x')]);
  });

  it('pins only the child the requested order splits from its parent block', () => {
    const input = layout({
      ungrouped: [session('parent'), session('c1'), session('c2'), session('x')],
    });
    const facts = [
      metadata('parent', { order: 0 }),
      metadata('c1', { order: 1, parentSessionId: 'parent' }),
      metadata('c2', { order: 2, parentSessionId: 'parent' }),
      metadata('x', { order: 3 }),
    ];

    const result = applyLegacySessionRank(input, ['parent', 'c1', 'x', 'c2'], facts);

    expect(result.ungrouped).toEqual([session('parent'), session('c1'), session('x'), session('c2', 'manual')]);
    expect(normalizeTabLayout(result, facts)).toEqual(result);
  });

  it('keeps a ranked child manual in its group when normalization materializes its missing parent', () => {
    const input = layout({
      groups: [{ id: 'child-group', name: 'Child', refs: [session('child')] }],
    });
    const facts = [metadata('parent', { order: 0 }), metadata('child', { order: 1, parentSessionId: 'parent' })];

    const result = applyLegacySessionRank(input, ['child', 'parent'], facts);

    expect(result.groups[0].refs).toEqual([session('child', 'manual')]);
    expect(result.ungrouped).toEqual([session('parent')]);
    expect(normalizeTabLayout(result, facts)).toEqual(result);
  });

  it('does not mutate inputs and returns a validated canonical deep clone', () => {
    const input = layout({
      groups: [{ id: 'g', name: '  Work  ', refs: [session('a'), webview('w')] }],
      ungrouped: [session('b')],
    });
    const requested = ['b', 'a'];
    const facts = [metadata('a', { order: 0 }), metadata('b', { order: 1 })];
    const beforeInput = structuredClone(input);
    const beforeRequested = [...requested];
    const beforeFacts = structuredClone(facts);

    const result = applyLegacySessionRank(input, requested, facts);

    expect(input).toEqual(beforeInput);
    expect(requested).toEqual(beforeRequested);
    expect(facts).toEqual(beforeFacts);
    expect(result.groups[0].name).toBe('Work');
    expect(validateTabLayout(result)).toEqual(result);
    expect(result).not.toBe(input);
    expect(result.groups[0]).not.toBe(input.groups[0]);
    expect(result.groups[0].refs[0]).not.toBe(input.groups[0].refs[0]);
  });
});

describe('recomposeGlobalSessionOrder', () => {
  it('replaces only owner slots, preserves interleaving, appends new IDs once, and deduplicates', () => {
    const current = ['a1', 'foreign', 'b1', 'a2', 'unmapped', 'a1'];
    const projections: OwnerOrderProjection[] = [
      {
        owner: 'alice',
        ownedIds: ['a1', 'a2', 'a3', 'a3'],
        order: ['a3', 'a2', 'a2', 'a1', 'foreign'],
      },
    ];
    const beforeCurrent = [...current];
    const beforeProjections = structuredClone(projections);

    const result = recomposeGlobalSessionOrder(current, projections);

    expect(result).toEqual(['a3', 'foreign', 'b1', 'a2', 'unmapped', 'a1']);
    expect(current).toEqual(beforeCurrent);
    expect(projections).toEqual(beforeProjections);
  });

  it('starts from merged preferred order when preserving admin cross-owner intent', () => {
    expect(
      recomposeGlobalSessionOrder(
        ['a1', 'b1', 'a2', 'server-only'],
        [{ owner: 'alice', ownedIds: ['a1', 'a2'], order: ['a2', 'a1'] }],
        ['b1', 'a1', 'a2']
      )
    ).toEqual(['b1', 'a2', 'a1', 'server-only']);
  });

  it('derives sequential owner projections from the latest order without a lost update', () => {
    const initial = ['a1', 'b1', 'a2', 'b2'];
    const afterAlice = recomposeGlobalSessionOrder(initial, [
      { owner: 'alice', ownedIds: ['a1', 'a2'], order: ['a2', 'a1'] },
    ]);
    const afterBob = recomposeGlobalSessionOrder(afterAlice, [
      { owner: 'bob', ownedIds: ['b1', 'b2'], order: ['b2', 'b1'] },
    ]);

    expect(afterAlice).toEqual(['a2', 'b1', 'a1', 'b2']);
    expect(afterBob).toEqual(['a2', 'b2', 'a1', 'b1']);
  });

  it('handles prototype-like owner names and IDs without corrupting membership', () => {
    expect(
      recomposeGlobalSessionOrder(
        ['__proto__', 'foreign', 'constructor'],
        [
          {
            owner: 'constructor',
            ownedIds: ['__proto__', 'constructor', 'toString'],
            order: ['toString', 'constructor', '__proto__'],
          },
        ]
      )
    ).toEqual(['toString', 'foreign', 'constructor', '__proto__']);
  });
});
