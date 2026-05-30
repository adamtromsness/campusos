'use client';

import Link from 'next/link';
import { PageHeader } from '@/components/ui/PageHeader';
import { PageLoader } from '@/components/ui/LoadingSpinner';
import { EmptyState } from '@/components/ui/EmptyState';
import { useAuthStore } from '@/lib/auth-store';
import {
  CUSTODY_LABELS,
  personDisplayName,
  RELATIONSHIP_LABELS,
  SIBLING_LABELS,
  useFamilyTree,
  type DerivedSibling,
  type Relationship,
} from '@/hooks/use-relationships';

/**
 * Family Tree — MVP list view (Step 7). Read-only projection of the
 * current user's family structure, grouped into parents / children /
 * grandparents / spouse / siblings. The graphical SVG tree is deferred.
 */
export default function FamilyTreePage() {
  const personId = useAuthStore((s) => s.user?.personId ?? null);
  const { data, isLoading, isError } = useFamilyTree(personId);

  return (
    <div className="mx-auto w-full max-w-3xl">
      <PageHeader
        title="Family Tree"
        description="A read-only view of your biological, legal, and step-family relationships."
        actions={
          <Link
            href="/family"
            className="inline-flex items-center rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 shadow-sm hover:bg-gray-50"
          >
            ← My Family
          </Link>
        }
      />

      {isLoading && <PageLoader label="Loading family tree…" />}

      {!isLoading && (isError || !data) && (
        <EmptyState
          title="Couldn't load the family tree"
          description="Please try again in a moment."
        />
      )}

      {!isLoading && data && (
        <Content
          parents={data.parents}
          children={data.children}
          grandparents={data.grandparents}
          grandchildren={data.grandchildren}
          spouses={data.spouses}
          other={data.other}
          siblings={data.siblings}
        />
      )}
    </div>
  );
}

function Content(props: {
  parents: Relationship[];
  children: Relationship[];
  grandparents: Relationship[];
  grandchildren: Relationship[];
  spouses: Relationship[];
  other: Relationship[];
  siblings: DerivedSibling[];
}) {
  const empty =
    props.parents.length === 0 &&
    props.children.length === 0 &&
    props.grandparents.length === 0 &&
    props.grandchildren.length === 0 &&
    props.spouses.length === 0 &&
    props.other.length === 0 &&
    props.siblings.length === 0;

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
      <RelGroup title="Parents" rels={props.parents} />
      <RelGroup title="Spouse / Partner" rels={props.spouses} />
      <RelGroup title="Children" rels={props.children} />
      <SiblingGroup siblings={props.siblings} />
      <RelGroup title="Grandparents" rels={props.grandparents} />
      <RelGroup title="Grandchildren" rels={props.grandchildren} />
      <RelGroup title="Other" rels={props.other} />
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
