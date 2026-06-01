'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { PageHeader } from '@/components/ui/PageHeader';
import { PageLoader } from '@/components/ui/LoadingSpinner';
import { EmptyState } from '@/components/ui/EmptyState';
import { useFamilyTree } from '@/hooks/use-relationships';
import { FamilyTreeView } from '@/components/family/FamilyTreeView';

/**
 * View-only family structure for an arbitrary person (Family Structure
 * on Profiles spec, Step 4). Reachable from both the student and the
 * parent/guardian profile via "View family structure". Renders the same
 * read-only tree for self, guardians, and school admins alike — no edit
 * affordances ever live here; editing happens on the profile's Account
 * tab, gated by the server's canEdit flag.
 */
export default function FamilyStructurePage() {
  const params = useParams<{ personId: string }>();
  const personId = params?.personId ?? null;
  const { data, isLoading, isError } = useFamilyTree(personId);

  // The graph payload has no top-level person; derive the root's name
  // from wherever they appear — as their own child (childless root) or as
  // the self-parent in the parent row.
  const subjectName = data
    ? (data.children.find((c) => c.personId === data.rootPersonId)?.displayName ??
      data.parents.find((p) => p.isSelf)?.displayName ??
      null)
    : null;

  return (
    <div className="mx-auto w-full max-w-3xl">
      <PageHeader
        title={subjectName ? `${subjectName} — Family Structure` : 'Family Structure'}
        description="Biological, legal, and step-family relationships, with custody summary. Read-only."
        actions={
          <Link
            href="/family"
            className="inline-flex items-center rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 shadow-sm hover:bg-gray-50"
          >
            ← My Family
          </Link>
        }
      />

      {isLoading && <PageLoader label="Loading family structure…" />}

      {!isLoading && (isError || !data) && (
        <EmptyState
          title="Couldn't load the family structure"
          description="You may not have access to this person, or there was a problem loading it."
        />
      )}

      {!isLoading && data && <FamilyTreeView tree={data} />}
    </div>
  );
}
