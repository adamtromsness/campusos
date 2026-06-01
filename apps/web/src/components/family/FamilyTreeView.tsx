'use client';

import { EmptyState } from '@/components/ui/EmptyState';
import {
  type FamilyTree,
  type FamilyTreeChild,
  type FamilyTreeParent,
  type FamilyTreeParentLink,
  type RelationshipType,
} from '@/hooks/use-relationships';

/**
 * Blended-family tree diagram — a single-generation, read-only SVG drawn as a
 * standard genealogy tree: a parent row on top, a child row below, and a
 * UNION JUNCTION per distinct parent-set.
 *
 * Children are grouped by the (unordered) SET of their real parents. Each group
 * renders one union — the group's parents joined by a short horizontal line,
 * a single drop to a horizontal SIBLING BAR, and one short drop per child — so
 * the common intact family (all kids share two parents) has ZERO crossing
 * lines. Blended families produce multiple unions; a parent shared across
 * groups (e.g. one father in two unions) appears ONCE in the parent row and is
 * the only place a crossing can remain. We minimise that with barycenter
 * ordering and accept the rest — no graph-layout library; the grouping does the
 * heavy lifting.
 *
 * The canvas is sized to the wider of the two rows so nothing clips; for large
 * families it switches to a horizontally scrollable container at a fixed box
 * size rather than shrinking text below legibility. Box content is kept short
 * (name · age + a one-word relationship subtitle) so nothing truncates;
 * per-link custody / type detail lives on the profile, not on the box.
 *
 * No edit affordances ever — editing lives in the profile Family Structure
 * section. Shared by /family/tree and /family/[personId]/structure.
 */

// ─── Geometry constants ────────────────────────────────────
const PAD_X = 24; // horizontal margin inside the canvas
const TOP = 16;
const GAP = 28; // gap between boxes in a row
const PARENT_BOX_H = 50;
const CHILD_BOX_H = 54;
const ROW_GAP = 88; // parent-row bottom → child-row top (room for union + sibling bar)
const STUB = 16; // vertical stub below the union before the horizontal connector

const MIN_PARENT_W = 124;
const MAX_PARENT_W = 220;
const MIN_CHILD_W = 120;
const MAX_CHILD_W = 240;

// Beyond this many children, prefer horizontal scroll over shrinking the SVG
// (keeps text legible instead of scaling everything down).
const SCROLL_AFTER = 4;

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
        viewBox={`0 0 ${layout.width} ${layout.height}`}
        width={layout.width}
        style={{
          maxWidth: '100%',
          height: 'auto',
          minWidth: layout.scroll ? layout.width : undefined,
        }}
        role="img"
        aria-labelledby="family-tree-title family-tree-desc"
      >
        <title id="family-tree-title">Family tree diagram</title>
        <desc id="family-tree-desc">
          {layout.parentCount} parent{layout.parentCount === 1 ? '' : 's'} and{' '}
          {layout.children.length} child{layout.children.length === 1 ? '' : 'ren'}, grouped into{' '}
          {layout.unionCount} family union{layout.unionCount === 1 ? '' : 's'}.
        </desc>

        {/* Junction lines first so boxes paint over the line ends. */}
        <g>
          {layout.segments.map((s) => (
            <line
              key={s.key}
              x1={s.x1}
              y1={s.y1}
              x2={s.x2}
              y2={s.y2}
              stroke="#9ca3af"
              strokeWidth={1.5}
              strokeLinecap="round"
            />
          ))}
        </g>

        {/* Parent row */}
        <g>
          {layout.parents.map((p) => (
            <ParentBox key={p.key} node={p} width={layout.parentBoxW} />
          ))}
        </g>

        {/* Child row */}
        <g>
          {layout.children.map((c) => (
            <ChildBox key={c.key} node={c} width={layout.childBoxW} y={layout.childY} />
          ))}
        </g>
      </svg>
    </div>
  );
}

// ─── Layout types ──────────────────────────────────────────

interface PositionedParent {
  key: string;
  x: number;
  centerX: number;
  displayName: string;
  isSelf: boolean;
  placeholder: boolean;
  roleLine: string;
}

interface PositionedChild {
  key: string;
  x: number;
  centerX: number;
  title: string;
  subtitle: string;
}

interface Segment {
  key: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

interface Layout {
  width: number;
  height: number;
  childY: number;
  parentBoxW: number;
  childBoxW: number;
  parents: PositionedParent[];
  children: PositionedChild[];
  segments: Segment[];
  parentCount: number;
  unionCount: number;
  scroll: boolean;
}

// A stable key for a REAL parent slot (CampusOS person or name-only).
function realParentKey(link: FamilyTreeParentLink): string | null {
  if (link.parentPersonId) return `p:${link.parentPersonId}`;
  if (link.parentName) return `n:${link.parentName}`;
  return null; // unset slot — handled as a placeholder, not a group key
}

function parentRecordKey(p: FamilyTreeParent): string {
  return p.personId ? `p:${p.personId}` : `n:${p.displayName}`;
}

interface Group {
  key: string; // sorted real-parent keys joined; '' = no known parents
  realKeys: string[];
  childIdx: number[]; // indices into the positioned children array
  placeholderCount: number; // dashed slots to pad toward 2
  bary: number; // mean child index — drives parent-row ordering
}

function computeLayout(tree: FamilyTree): Layout {
  const children = tree.children;

  const realParentByKey = new Map<string, FamilyTreeParent>();
  for (const p of tree.parents) realParentByKey.set(parentRecordKey(p), p);

  // ── STEP 1: group children by their SET of real parents ──
  const groupByKey = new Map<string, Group>();
  children.forEach((child, ci) => {
    const realKeys = child.parentLinks.map(realParentKey).filter((k): k is string => k != null);
    const uniqueReal = Array.from(new Set(realKeys)).sort();
    const placeholderLinks = child.parentLinks.filter((l) => realParentKey(l) == null).length;
    const groupKey = uniqueReal.join('|');
    const existing = groupByKey.get(groupKey);
    if (existing) {
      existing.childIdx.push(ci);
      existing.placeholderCount = Math.max(existing.placeholderCount, placeholderLinks);
    } else {
      groupByKey.set(groupKey, {
        key: groupKey,
        realKeys: uniqueReal,
        childIdx: [ci],
        placeholderCount: placeholderLinks,
        bary: 0,
      });
    }
  });

  const groups = Array.from(groupByKey.values());
  // Pad each group toward two visible parent slots (the meaningful empty slot is
  // never omitted), but never invent more real-less slots than the payload.
  for (const g of groups) {
    const want = Math.max(0, 2 - g.realKeys.length);
    g.placeholderCount = Math.min(Math.max(g.placeholderCount, g.realKeys.length < 2 ? want : 0), 2);
    g.bary = g.childIdx.reduce((a, i) => a + i, 0) / g.childIdx.length;
  }
  groups.sort((a, b) => a.bary - b.bary || a.key.localeCompare(b.key));

  // ── STEP 3: build the parent row, clustering each group's parents and
  // emitting a shared parent only once (at its first group). Placeholder slots
  // follow their group's real parents. ──
  type Cell =
    | { type: 'real'; key: string; rec: FamilyTreeParent }
    | { type: 'placeholder'; key: string };
  const cells: Cell[] = [];
  const emitted = new Set<string>();
  groups.forEach((g, gi) => {
    for (const rk of g.realKeys) {
      if (emitted.has(rk)) continue;
      emitted.add(rk);
      const rec =
        realParentByKey.get(rk) ??
        ({ personId: null, displayName: rk.replace(/^n:/, ''), isSelf: false, isPlaceholder: false } as FamilyTreeParent);
      cells.push({ type: 'real', key: rk, rec });
    }
    for (let i = 0; i < g.placeholderCount; i++) {
      cells.push({ type: 'placeholder', key: `ph:${gi}:${i}` });
    }
  });

  // ── STEP 4: box content (kept short so nothing truncates) ──
  // Child title is "FirstName · age" — first name only keeps the row narrow so
  // a 4-child family stays at legible size without scrolling.
  const childContent = children.map((c) => {
    const firstName = c.displayName.split(/\s+/)[0] || c.displayName;
    return {
      title: c.age != null ? `${firstName} · ${c.age}` : firstName,
      subtitle: childRelationLabel(c),
    };
  });

  const parentContent = cells.map((cell) =>
    cell.type === 'real'
      ? {
          displayName: cell.rec.displayName,
          roleLine: cell.rec.isSelf ? 'You · parent' : 'Parent',
          isSelf: cell.rec.isSelf,
          placeholder: false,
        }
      : { displayName: 'Unknown parent', roleLine: 'Not specified', isSelf: false, placeholder: true },
  );

  // Size boxes to the longest label so labels never clip. Approximate text
  // width from character count (no DOM measurement available at render time).
  const childBoxW = clamp(
    Math.max(
      ...childContent.map((c) => Math.max(approx(c.title, 13, 600), approx(c.subtitle, 11, 400))),
    ) + 28,
    MIN_CHILD_W,
    MAX_CHILD_W,
  );
  const parentBoxW = clamp(
    Math.max(
      ...parentContent.map((p) => Math.max(approx(p.displayName, 13, 500), approx(p.roleLine, 11, 400))),
    ) + 28,
    MIN_PARENT_W,
    MAX_PARENT_W,
  );

  // ── STEP 2: size the canvas to the wider row so nothing clips ──
  const childInnerW = rowWidth(children.length, childBoxW);
  const parentInnerW = rowWidth(cells.length, parentBoxW);
  const width = Math.max(childInnerW, parentInnerW) + 2 * PAD_X;

  // Position the parent row (centered).
  const parentY = TOP;
  const parentBottom = parentY + PARENT_BOX_H;
  const parentStart = (width - parentInnerW) / 2;
  const parents: PositionedParent[] = cells.map((cell, i) => {
    const x = parentStart + i * (parentBoxW + GAP);
    const c = parentContent[i]!;
    return {
      key: cell.key,
      x,
      centerX: x + parentBoxW / 2,
      displayName: c.displayName,
      isSelf: c.isSelf,
      placeholder: c.placeholder,
      roleLine: c.roleLine,
    };
  });
  const realCenterByKey = new Map<string, number>();
  parents.forEach((p, i) => {
    const cell = cells[i]!;
    if (cell.type === 'real') realCenterByKey.set(cell.key, p.centerX);
  });

  // Position the child row (centered), preserving payload order left→right.
  const childY = parentBottom + ROW_GAP;
  const childStart = (width - childInnerW) / 2;
  const positionedChildren: PositionedChild[] = children.map((c, i) => {
    const x = childStart + i * (childBoxW + GAP);
    return {
      key: `c:${c.personId}`,
      x,
      centerX: x + childBoxW / 2,
      title: childContent[i]!.title,
      subtitle: childContent[i]!.subtitle,
    };
  });

  // ── Union junctions: one clean drop per group, zero in-group crossings ──
  const siblingBarY = childY - 26;
  const segments: Segment[] = [];
  groups.forEach((g) => {
    const realCenters = g.realKeys
      .map((k) => realCenterByKey.get(k))
      .filter((v): v is number => v != null)
      .sort((a, b) => a - b);
    const childCenters = g.childIdx.map((i) => positionedChildren[i]!.centerX).sort((a, b) => a - b);
    const childMin = childCenters[0]!;
    const childMax = childCenters[childCenters.length - 1]!;
    const childMidX = (childMin + childMax) / 2;

    // A group with no real parents (e.g. a childless root whose own parents are
    // unset) has nothing to connect to — render its children with the dashed
    // parent boxes above but no dangling lines.
    if (realCenters.length === 0) return;

    // Sibling bar + one short drop to each child top-center.
    if (childCenters.length > 1) {
      segments.push({ key: `${g.key}-sib`, x1: childMin, y1: siblingBarY, x2: childMax, y2: siblingBarY });
    }
    g.childIdx.forEach((i) => {
      const cx = positionedChildren[i]!.centerX;
      segments.push({ key: `${g.key}-drop-${i}`, x1: cx, y1: siblingBarY, x2: cx, y2: childY });
    });

    // Upward connection to the parents — a single-parent group drops from that
    // parent (no phantom line to the empty slot).
    const unionMidX =
      realCenters.length >= 2
        ? (realCenters[0]! + realCenters[realCenters.length - 1]!) / 2
        : realCenters[0]!;
    if (realCenters.length >= 2) {
      // Horizontal union line joining the group's parents.
      segments.push({
        key: `${g.key}-union`,
        x1: realCenters[0]!,
        y1: parentBottom,
        x2: realCenters[realCenters.length - 1]!,
        y2: parentBottom,
      });
    }
    // Vertical stub from the union midpoint, an elbow across to the children's
    // midpoint (≈0 length in the common centered case), then down to the bar.
    const elbowY = parentBottom + STUB;
    segments.push({ key: `${g.key}-stub`, x1: unionMidX, y1: parentBottom, x2: unionMidX, y2: elbowY });
    if (Math.abs(unionMidX - childMidX) > 0.5) {
      segments.push({ key: `${g.key}-elbow`, x1: unionMidX, y1: elbowY, x2: childMidX, y2: elbowY });
    }
    segments.push({ key: `${g.key}-feed`, x1: childMidX, y1: elbowY, x2: childMidX, y2: siblingBarY });
  });

  const height = childY + CHILD_BOX_H + TOP;
  return {
    width,
    height,
    childY,
    parentBoxW,
    childBoxW,
    parents,
    children: positionedChildren,
    segments,
    parentCount: cells.filter((c) => c.type === 'real').length,
    unionCount: groups.length,
    scroll: children.length > SCROLL_AFTER,
  };
}

// ─── Helpers ───────────────────────────────────────────────

function rowWidth(n: number, boxW: number): number {
  if (n <= 0) return 0;
  return n * boxW + (n - 1) * GAP;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

// Rough text width: charCount × fontSize × ratio (no DOM measurement here).
function approx(text: string, fontSize: number, ratioThousandths: number): number {
  return text.length * fontSize * (ratioThousandths / 1000);
}

/**
 * One-word-ish relationship subtitle for a child box. Collapses the per-link
 * parent-side relationship types into the child's own category. The common
 * all-biological case reads "Biological child"; the step-to-one-parent nuance
 * surfaces as a combined label (e.g. "Biological / step child") rather than
 * dumping both parents' full relationship strings on the box.
 */
function childRelationLabel(c: FamilyTreeChild): string {
  const cats = new Set<string>();
  for (const l of c.parentLinks) {
    const cat = relationshipCategory(l.relationshipType);
    if (cat) cats.add(cat);
  }
  if (cats.size === 0) return 'Child';
  if (cats.size === 1) {
    const only = [...cats][0]!;
    return SINGLE_CATEGORY_LABEL[only] ?? 'Child';
  }
  // Mixed (the blended nuance) — list the distinct categories.
  return `${[...cats].join(' / ')} child`;
}

function relationshipCategory(type: RelationshipType | null): string | null {
  if (!type) return null;
  if (type.includes('BIOLOGICAL')) return 'Biological';
  if (type.includes('ADOPTIVE')) return 'Adoptive';
  if (type.includes('STEP')) return 'Step';
  if (type === 'LEGAL_GUARDIAN') return 'Legal';
  return null;
}

const SINGLE_CATEGORY_LABEL: Record<string, string> = {
  Biological: 'Biological child',
  Adoptive: 'Adopted child',
  Step: 'Step-child',
  Legal: 'Legal ward',
};

// ─── Box renderers ─────────────────────────────────────────

function ParentBox({ node, width }: { node: PositionedParent; width: number }) {
  return (
    <g>
      <rect
        x={node.x}
        y={TOP}
        width={width}
        height={PARENT_BOX_H}
        rx={8}
        fill={node.placeholder ? '#f9fafb' : '#ffffff'}
        stroke={node.placeholder ? '#d1d5db' : node.isSelf ? '#0e7490' : '#9ca3af'}
        strokeWidth={node.isSelf ? 1.75 : 1}
        strokeDasharray={node.placeholder ? '4 3' : undefined}
      />
      <text
        x={node.x + width / 2}
        y={TOP + 21}
        textAnchor="middle"
        className={node.placeholder ? 'fill-gray-400' : 'fill-gray-900'}
        style={{ fontSize: 13, fontWeight: 500 }}
      >
        {node.displayName}
      </text>
      <text
        x={node.x + width / 2}
        y={TOP + 38}
        textAnchor="middle"
        className="fill-gray-500"
        style={{ fontSize: 11 }}
      >
        {node.roleLine}
      </text>
    </g>
  );
}

function ChildBox({ node, width, y }: { node: PositionedChild; width: number; y: number }) {
  return (
    <g>
      <rect
        x={node.x}
        y={y}
        width={width}
        height={CHILD_BOX_H}
        rx={8}
        fill="#ffffff"
        stroke="#9ca3af"
        strokeWidth={1}
      />
      <text
        x={node.x + width / 2}
        y={y + 22}
        textAnchor="middle"
        className="fill-gray-900"
        style={{ fontSize: 13, fontWeight: 500 }}
      >
        {node.title}
      </text>
      <text
        x={node.x + width / 2}
        y={y + 40}
        textAnchor="middle"
        className="fill-gray-600"
        style={{ fontSize: 11 }}
      >
        {node.subtitle}
      </text>
    </g>
  );
}
