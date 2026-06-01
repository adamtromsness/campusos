'use client';

import { EmptyState } from '@/components/ui/EmptyState';
import {
  CUSTODY_LABELS,
  RELATIONSHIP_LABELS,
  type FamilyTree,
  type FamilyTreeChild,
  type FamilyTreeParent,
} from '@/hooks/use-relationships';

/**
 * Blended-family tree diagram — a single-generation, read-only SVG: a
 * parent row on top, a child row below, and an edge from each child to
 * each of its own parents. Blended families mean parents differ per
 * child, so we draw a graph (per-child parent links) rather than a nested
 * tree. No edit affordances ever — editing lives in the profile Family
 * Structure section. Shared by /family/tree and /family/[personId]/structure.
 *
 * Layout is fixed-width (viewBox 0 0 680 H); height is computed from the
 * row contents so nothing clips. Parent ordering uses a barycenter
 * heuristic (Step 2) to minimise — not eliminate — edge crossings; a real
 * graph-layout lib (dagre/elk) is deliberately avoided to keep the bundle
 * lean. Deferred (see spec): per-parent edge colour for dense blends, and
 * edge hover tooltips for per-link type/custody.
 */

const VIEW_W = 680;
const PAD_X = 16;
const PARENT_BOX_W = 150;
const PARENT_BOX_H = 52;
const CHILD_BOX_W = 196;
const CHILD_BOX_H = 78;
const ROW_GAP = 96; // vertical gap between parent-row bottom and child-row top
const TOP = 16;

export function FamilyTreeView({ tree }: { tree: FamilyTree }) {
  if (tree.children.length === 0) {
    return (
      <EmptyState
        title="No family relationships recorded yet"
        description="Set biological parents, guardians, or a spouse from a profile's Account tab to build the tree."
      />
    );
  }

  const layout = computeLayout(tree);

  return (
    <div className="overflow-x-auto rounded-card border border-gray-200 bg-white p-2 shadow-sm">
      <svg
        viewBox={`0 0 ${VIEW_W} ${layout.height}`}
        width="100%"
        height={layout.height}
        role="img"
        aria-labelledby="family-tree-title family-tree-desc"
        className="min-w-[520px]"
      >
        <title id="family-tree-title">Family tree diagram</title>
        <desc id="family-tree-desc">
          {layout.parents.length} parent{layout.parents.length === 1 ? '' : 's'} and{' '}
          {layout.children.length} child{layout.children.length === 1 ? '' : 'ren'}, with lines
          connecting each child to its parents.
        </desc>

        {/* Edges first so boxes paint over the line ends. */}
        <g>
          {layout.edges.map((e) => (
            <line
              key={e.key}
              x1={e.x1}
              y1={e.y1}
              x2={e.x2}
              y2={e.y2}
              stroke="#9ca3af"
              strokeWidth={1.5}
              strokeDasharray={e.placeholder ? '4 3' : undefined}
            />
          ))}
        </g>

        {/* Parent row */}
        <g>
          {layout.parents.map((p) => (
            <ParentBox key={p.key} node={p} />
          ))}
        </g>

        {/* Child row */}
        <g>
          {layout.children.map((c) => (
            <ChildBox key={c.key} node={c} />
          ))}
        </g>
      </svg>
    </div>
  );
}

// ─── Layout ────────────────────────────────────────────────

interface PositionedParent {
  key: string;
  x: number; // box left
  centerX: number;
  displayName: string;
  isSelf: boolean;
  placeholder: boolean; // dashed slot (name-only is NOT placeholder)
  roleLine: string | null;
}

interface PositionedChild {
  key: string;
  x: number;
  centerX: number;
  displayName: string;
  relationshipSummary: string;
  custodySummary: string | null;
}

interface Edge {
  key: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  placeholder: boolean;
}

interface Layout {
  height: number;
  parents: PositionedParent[];
  children: PositionedChild[];
  edges: Edge[];
}

/**
 * A stable slot id for a parent box. Real people key by personId,
 * name-only parents by their name, and each child's unset slot gets a
 * per-child unique placeholder id (so two children's empty slots are two
 * distinct dashed boxes, not one shared box).
 */
function slotKey(link: { parentPersonId: string | null; parentName: string | null }, childId: string, idx: number): string {
  if (link.parentPersonId) return `p:${link.parentPersonId}`;
  if (link.parentName) return `n:${link.parentName}`;
  return `slot:${childId}:${idx}`;
}

function computeLayout(tree: FamilyTree): Layout {
  const children = tree.children;

  // Collect every distinct parent slot across all children, plus the
  // barycenter (mean child index) of the children linking to it.
  const slots = new Map<
    string,
    { key: string; displayName: string; isSelf: boolean; placeholder: boolean; sumIdx: number; n: number }
  >();
  const realParentByKey = new Map<string, FamilyTreeParent>();
  for (const p of tree.parents) {
    realParentByKey.set(p.personId ? `p:${p.personId}` : `n:${p.displayName}`, p);
  }

  children.forEach((child, ci) => {
    child.parentLinks.forEach((link, li) => {
      const key = slotKey(link, child.personId, li);
      const existing = slots.get(key);
      if (existing) {
        existing.sumIdx += ci;
        existing.n += 1;
        return;
      }
      const real = realParentByKey.get(key);
      const placeholder = !link.parentPersonId && !link.parentName;
      slots.set(key, {
        key,
        displayName: real?.displayName ?? link.parentName ?? 'Other parent',
        isSelf: real?.isSelf ?? false,
        placeholder,
        sumIdx: ci,
        n: 1,
      });
    });
  });

  // Step 2 — barycenter ordering: parents sort by mean x-position of the
  // children they link to. Stable; tie-break by displayName.
  const ordered = Array.from(slots.values())
    .map((s) => ({ ...s, bary: s.sumIdx / s.n }))
    .sort((a, b) => a.bary - b.bary || a.displayName.localeCompare(b.displayName));

  // Position parent boxes: evenly spaced across the available width,
  // centered as a group.
  const parentRowW = ordered.length * PARENT_BOX_W + (ordered.length - 1) * gap(ordered.length, PARENT_BOX_W);
  const parentStart = Math.max(PAD_X, (VIEW_W - parentRowW) / 2);
  const parentY = TOP;
  const parents: PositionedParent[] = ordered.map((s, i) => {
    const step = PARENT_BOX_W + gap(ordered.length, PARENT_BOX_W);
    const x = parentStart + i * step;
    return {
      key: s.key,
      x,
      centerX: x + PARENT_BOX_W / 2,
      displayName: s.displayName,
      isSelf: s.isSelf,
      placeholder: s.placeholder,
      roleLine: s.isSelf ? 'You · parent' : s.placeholder ? 'Not specified' : 'Parent',
    };
  });
  const parentCenterByKey = new Map(parents.map((p) => [p.key, p.centerX]));

  // Position child boxes: evenly spaced, centered.
  const childRowW = children.length * CHILD_BOX_W + (children.length - 1) * gap(children.length, CHILD_BOX_W);
  const childStart = Math.max(PAD_X, (VIEW_W - childRowW) / 2);
  const childY = parentY + PARENT_BOX_H + ROW_GAP;
  const positionedChildren: PositionedChild[] = children.map((c, i) => {
    const step = CHILD_BOX_W + gap(children.length, CHILD_BOX_W);
    const x = childStart + i * step;
    return {
      key: `c:${c.personId}`,
      x,
      centerX: x + CHILD_BOX_W / 2,
      displayName: c.age != null ? `${c.displayName} · ${c.age}` : c.displayName,
      relationshipSummary: relationshipSummary(c),
      custodySummary: custodySummary(c),
    };
  });
  const childCenterByPersonId = new Map(
    children.map((c, i) => [c.personId, positionedChildren[i]!.centerX]),
  );

  // Edges: child top-center → parent bottom-center.
  const edges: Edge[] = [];
  children.forEach((child) => {
    const x1 = childCenterByPersonId.get(child.personId)!;
    const y1 = childY; // top of child box
    child.parentLinks.forEach((link, li) => {
      const key = slotKey(link, child.personId, li);
      const px = parentCenterByKey.get(key);
      if (px == null) return;
      edges.push({
        key: `${child.personId}-${key}`,
        x1,
        y1,
        x2: px,
        y2: parentY + PARENT_BOX_H, // bottom of parent box
        placeholder: !link.parentPersonId && !link.parentName,
      });
    });
  });

  const height = childY + CHILD_BOX_H + TOP;
  return { height, parents, children: positionedChildren, edges };
}

// Spacing between boxes so a row of N fills the width without overflowing.
function gap(n: number, boxW: number): number {
  if (n <= 1) return 0;
  const free = VIEW_W - 2 * PAD_X - n * boxW;
  return Math.max(16, free / (n - 1));
}

function relationshipSummary(c: FamilyTreeChild): string {
  const named = c.parentLinks
    .filter((l) => l.relationshipType)
    .map((l) => RELATIONSHIP_LABELS[l.relationshipType!]);
  return named.length > 0 ? named.join(' · ') : 'Parents not specified';
}

function custodySummary(c: FamilyTreeChild): string | null {
  const bits: string[] = [];
  for (const l of c.parentLinks) {
    if (l.custodyArrangement) bits.push(CUSTODY_LABELS[l.custodyArrangement]);
  }
  if (c.parentLinks.some((l) => l.primaryResidence)) bits.push('Primary residence');
  return bits.length > 0 ? Array.from(new Set(bits)).join(' · ') : null;
}

// ─── Box renderers ─────────────────────────────────────────

function ParentBox({ node }: { node: PositionedParent }) {
  return (
    <g>
      <rect
        x={node.x}
        y={TOP}
        width={PARENT_BOX_W}
        height={PARENT_BOX_H}
        rx={8}
        fill={node.placeholder ? '#f9fafb' : '#ffffff'}
        stroke={node.placeholder ? '#d1d5db' : node.isSelf ? '#0e7490' : '#9ca3af'}
        strokeWidth={node.isSelf ? 1.75 : 1}
        strokeDasharray={node.placeholder ? '4 3' : undefined}
      />
      <text
        x={node.x + PARENT_BOX_W / 2}
        y={TOP + 22}
        textAnchor="middle"
        className="fill-gray-900"
        style={{ fontSize: 13, fontWeight: 500 }}
      >
        {truncate(node.displayName, 20)}
      </text>
      {node.roleLine && (
        <text
          x={node.x + PARENT_BOX_W / 2}
          y={TOP + 39}
          textAnchor="middle"
          className="fill-gray-500"
          style={{ fontSize: 11 }}
        >
          {node.roleLine}
        </text>
      )}
    </g>
  );
}

function ChildBox({ node }: { node: PositionedChild }) {
  const y = TOP + PARENT_BOX_H + ROW_GAP;
  return (
    <g>
      <rect
        x={node.x}
        y={y}
        width={CHILD_BOX_W}
        height={CHILD_BOX_H}
        rx={8}
        fill="#ffffff"
        stroke="#9ca3af"
        strokeWidth={1}
      />
      <text
        x={node.x + CHILD_BOX_W / 2}
        y={y + 22}
        textAnchor="middle"
        className="fill-gray-900"
        style={{ fontSize: 13, fontWeight: 500 }}
      >
        {truncate(node.displayName, 26)}
      </text>
      <text
        x={node.x + CHILD_BOX_W / 2}
        y={y + 42}
        textAnchor="middle"
        className="fill-gray-600"
        style={{ fontSize: 11 }}
      >
        {truncate(node.relationshipSummary, 30)}
      </text>
      {node.custodySummary && (
        <text
          x={node.x + CHILD_BOX_W / 2}
          y={y + 60}
          textAnchor="middle"
          className="fill-gray-500"
          style={{ fontSize: 11 }}
        >
          {truncate(node.custodySummary, 30)}
        </text>
      )}
    </g>
  );
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}
