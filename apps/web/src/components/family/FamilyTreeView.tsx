'use client';

import { EmptyState } from '@/components/ui/EmptyState';
import {
  CUSTODY_LABELS,
  personDisplayName,
  RELATIONSHIP_LABELS,
  SIBLING_LABELS,
  type DerivedSibling,
  type FamilyTree,
  type Relationship,
} from '@/hooks/use-relationships';

/**
 * Read-only rendering of a person's family structure (parents → children,
 * derived siblings, step-relationships, grandparents) with a custody
 * summary per relationship. No edit affordances ever — this is the
 * view-only surface shared by /family/tree and
 * /family/[personId]/structure (self, guardians, and school admins).
 */
export function FamilyTreeView({ tree }: { tree: FamilyTree }) {
  const empty =
    tree.parents.length === 0 &&
    tree.children.length === 0 &&
    tree.grandparents.length === 0 &&
    tree.grandchildren.length === 0 &&
    tree.spouses.length === 0 &&
    tree.other.length === 0 &&
    tree.siblings.length === 0;

  if (empty) {
    return (
      <EmptyState
        title="No family structure yet"
        description="Set biological parents, guardians, or a spouse from a profile's Account tab to build the tree."
      />
    );
  }

  return (
    <div className="flex flex-col gap-5">
      <RelGroup title="Parents" rels={tree.parents} />
      <RelGroup title="Spouse / Partner" rels={tree.spouses} />
      <RelGroup title="Children" rels={tree.children} />
      <SiblingGroup siblings={tree.siblings} />
      <RelGroup title="Grandparents" rels={tree.grandparents} />
      <RelGroup title="Grandchildren" rels={tree.grandchildren} />
      <RelGroup title="Other" rels={tree.other} />
    </div>
  );
}

function relatedName(rel: Relationship): string {
  return rel.relatedPerson
    ? personDisplayName(rel.relatedPerson)
    : (rel.relatedPersonName ?? 'Unknown');
}

function RelGroup({ title, rels }: { title: string; rels: Relationship[] }) {
  if (rels.length === 0) return null;
  return (
    <section>
      <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500">{title}</h2>
      <div className="overflow-hidden rounded-card border border-gray-200 bg-white shadow-sm">
        {rels.map((r) => {
          const custodyBits = [
            r.custodyArrangement ? CUSTODY_LABELS[r.custodyArrangement] : null,
            r.isPrimaryResidence ? 'Primary residence' : null,
          ].filter(Boolean);
          return (
            <div key={r.id} className="border-b border-gray-100 px-4 py-3 last:border-b-0">
              <p className="text-sm font-medium text-gray-900">
                {relatedName(r)}
                {r.relatedPerson?.age != null && (
                  <span className="font-normal text-gray-500"> · age {r.relatedPerson.age}</span>
                )}
                <span className="font-normal text-gray-500"> · {RELATIONSHIP_LABELS[r.type]}</span>
                {r.verified && <span className="ml-1 text-xs text-emerald-600">✓ Verified</span>}
              </p>
              {custodyBits.length > 0 && (
                <p className="text-xs text-gray-600">{custodyBits.join(' · ')}</p>
              )}
              {r.custodyNotes && <p className="text-xs italic text-gray-500">“{r.custodyNotes}”</p>}
            </div>
          );
        })}
      </div>
    </section>
  );
}

function SiblingGroup({ siblings }: { siblings: DerivedSibling[] }) {
  if (siblings.length === 0) return null;
  return (
    <section>
      <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500">
        Siblings (derived)
      </h2>
      <div className="overflow-hidden rounded-card border border-gray-200 bg-white shadow-sm">
        {siblings.map((s) => (
          <div
            key={s.person.id}
            className="flex items-center justify-between border-b border-gray-100 px-4 py-3 text-sm last:border-b-0"
          >
            <span className="text-gray-900">
              {s.person.preferredName?.trim() || `${s.person.firstName} ${s.person.lastName}`}
              {s.person.age != null && <span className="text-gray-500"> · age {s.person.age}</span>}
            </span>
            <span className="text-xs text-gray-500">{SIBLING_LABELS[s.siblingType]}</span>
          </div>
        ))}
      </div>
    </section>
  );
}
